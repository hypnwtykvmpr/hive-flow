/**
 * Hive Flow appliance distribution and hot-patch module.
 *
 * IPFS publishing of Hive Flow appliances via Pinata and HFPP binary patches
 * for section-level hot updates with atomic rollback.
 *
 * HFPP layout: [4B "HFPP"] [4B version u32LE] [4B header_len u32LE]
 *              [header JSON] [new section data] [32B SHA256 footer]
 */

import { createHash, randomBytes, sign, verify as edVerify } from 'node:crypto';
import { readFile, writeFile, rename, unlink, copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { gzipSync, gunzipSync } from 'node:zlib';
import { ApplianceReader, ApplianceWriter } from './appliance-format.js';

// ── Constants ────────────────────────────────────────────────
const APPLIANCE_PATCH_VERSION = 1;
const PATCH_MAGIC = 'HFPP';
const LEGACY_PATCH_MAGIC = String.fromCharCode(0x52, 0x56, 0x46, 0x50);
const ACCEPTED_PATCH_MAGICS: ReadonlySet<string> = new Set([PATCH_MAGIC, LEGACY_PATCH_MAGIC]);
const PRE = 12; // preamble: 4 magic + 4 version + 4 header_len
const SHA_LEN = 32;
const DEFAULT_GW = 'https://gateway.pinata.cloud';
const DEFAULT_API = 'https://api.pinata.cloud';

// ── Types ────────────────────────────────────────────────────
export interface AppliancePatchHeader {
  magic: string; version: number;
  targetApplianceName: string; targetApplianceVersion: string;
  targetSection: string; patchVersion: string; created: string;
  newSectionSize: number; newSectionSha256: string;
  compression: 'none' | 'gzip'; signature?: string; signedBy?: string;
}
export interface CreatePatchOptions {
  targetName: string; targetVersion: string; sectionId: string;
  sectionData: Buffer; patchVersion: string;
  compression?: 'none' | 'gzip'; privateKey?: Buffer; signedBy?: string;
}
export interface ApplyOptions { backup?: boolean; verify?: boolean; publicKey?: Buffer }
export interface ApplyResult {
  success: boolean; backupPath?: string; newSize: number;
  patchedSection: string; errors: string[];
}
export interface PatchVerifyResult { valid: boolean; header: AppliancePatchHeader; errors: string[] }
export interface PublishConfig { pinataJwt?: string; gatewayUrl?: string; apiUrl?: string }
export interface PublishMetadata { name?: string; description?: string; version?: string; profile?: string }
export interface PublishResult { cid: string; size: number; gatewayUrl: string; pinataUrl: string }
export interface PublishedItem { cid: string; name: string; size: number; date: string }

// ── Crypto helpers ───────────────────────────────────────────
function sha256(d: Buffer): string { return createHash('sha256').update(d).digest('hex'); }
function sha256B(d: Buffer): Buffer { return createHash('sha256').update(d).digest(); }

function detectKeyFormat(key: Buffer): { format: 'pem' | 'der'; type: string } {
  const str = key.toString('utf-8');
  if (str.includes('BEGIN PRIVATE KEY')) return { format: 'pem', type: 'pkcs8' };
  if (str.includes('BEGIN PUBLIC KEY')) return { format: 'pem', type: 'spki' };
  // Heuristic: DER-encoded keys are raw binary, never valid UTF-8 "BEGIN"
  return { format: 'der', type: 'pkcs8' }; // caller must override type for public keys
}

function edSign(data: Buffer, key: Buffer): string {
  const det = detectKeyFormat(key);
  // SAFETY: Node.js crypto.sign accepts these key options but the overload types are narrow
  return sign(null, data, { key, format: det.format, type: det.type } as unknown as Parameters<typeof sign>[2]).toString('hex');
}
function edCheck(data: Buffer, sig: string, key: Buffer): boolean {
  try {
    const det = detectKeyFormat(key);
    const type = det.format === 'pem' ? det.type : 'spki'; // public key for verify
    // SAFETY: Node.js crypto.verify accepts these key options but the overload types are narrow
    return edVerify(null, data, { key, format: det.format, type } as unknown as Parameters<typeof edVerify>[2], Buffer.from(sig, 'hex'));
  } catch { return false; }
}

// ── HTTP helpers ─────────────────────────────────────────────
function pinataReq(
  method: string, path: string, jwt: string, body?: Buffer, ct?: string,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path);
    const h: Record<string, string> = { Authorization: `Bearer ${jwt}` };
    if (ct) h['Content-Type'] = ct;
    if (body) h['Content-Length'] = String(body.length);
    const req = httpsRequest(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers: h },
      (res) => {
        const ch: Buffer[] = [];
        res.on('data', (c: Buffer) => ch.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(ch);
          let data: unknown;
          try { data = JSON.parse(raw.toString('utf-8')); } catch { data = raw; }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.setTimeout(30_000, () => { req.destroy(new Error('Request timed out after 30s')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpGet(url: string, maxRedirects = 5): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    const u = new URL(url);
    const req = httpsRequest({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET' }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return void httpGet(res.headers.location, maxRedirects - 1).then(resolve, reject);
      }
      const ch: Buffer[] = [];
      res.on('data', (c: Buffer) => ch.push(c));
      res.on('end', () => resolve(Buffer.concat(ch)));
    });
    req.setTimeout(30_000, () => { req.destroy(new Error('Request timed out after 30s')); });
    req.on('error', reject);
    req.end();
  });
}

function multipart(
  name: string, file: string, data: Buffer, meta?: string,
): { body: Buffer; ct: string } {
  const b = `----Appliance${Date.now()}${randomBytes(8).toString('hex')}`;
  const parts: Buffer[] = [];
  if (meta) {
    parts.push(Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="pinataMetadata"\r\n` +
      `Content-Type: application/json\r\n\r\n${meta}\r\n`,
    ));
  }
  parts.push(Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="${name}"; filename="${file}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`,
  ));
  parts.push(data, Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), ct: `multipart/form-data; boundary=${b}` };
}

/** Extract patch section data and bounds from a parsed patch buffer. */
function patchData(buf: Buffer): { start: number; end: number; section: Buffer } {
  const hLen = buf.readUInt32LE(8);
  const start = PRE + hLen;
  const end = buf.length - SHA_LEN;
  return { start, end, section: buf.subarray(start, end) };
}

/** Canonical JSON: recursive key-sorting for deterministic serialization. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val) && !Buffer.isBuffer(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

/** Build a failed ApplyResult. */
function failResult(sec: string, errs: string[], extra?: Partial<ApplyResult>): ApplyResult {
  return { success: false, newSize: 0, patchedSection: sec, errors: errs, ...extra };
}

// ── AppliancePatcher ──────────────────────────────────────────────
export class AppliancePatcher {
  static async createPatch(opts: CreatePatchOptions): Promise<Buffer> {
    const comp = opts.compression ?? 'none';
    const payload = comp === 'gzip' ? gzipSync(opts.sectionData) : opts.sectionData;
    const header: AppliancePatchHeader = {
      magic: PATCH_MAGIC, version: APPLIANCE_PATCH_VERSION,
      targetApplianceName: opts.targetName, targetApplianceVersion: opts.targetVersion,
      targetSection: opts.sectionId, patchVersion: opts.patchVersion,
      created: new Date().toISOString(), newSectionSize: payload.length,
      newSectionSha256: sha256(payload), compression: comp,
    };
    if (opts.privateKey && opts.signedBy) {
      const signable = Buffer.concat([Buffer.from(canonicalJson(header), 'utf-8'), payload]);
      header.signature = edSign(signable, opts.privateKey);
      header.signedBy = opts.signedBy;
    }
    const hJson = Buffer.from(JSON.stringify(header), 'utf-8');
    const magic = Buffer.from(PATCH_MAGIC);
    const ver = Buffer.alloc(4); ver.writeUInt32LE(APPLIANCE_PATCH_VERSION, 0);
    const hLen = Buffer.alloc(4); hLen.writeUInt32LE(hJson.length, 0);
    return Buffer.concat([magic, ver, hLen, hJson, payload, sha256B(payload)]);
  }

  static parsePatchHeader(buf: Buffer): AppliancePatchHeader {
    if (buf.length < PRE) throw new Error('Buffer too small for appliance patch preamble');
    const magic = buf.subarray(0, 4).toString('ascii');
    if (!ACCEPTED_PATCH_MAGICS.has(magic)) throw new Error(`Invalid appliance patch magic: "${magic}"`);
    const ver = buf.readUInt32LE(4);
    if (ver !== APPLIANCE_PATCH_VERSION) throw new Error(`Unsupported appliance patch version: ${ver}`);
    const hLen = buf.readUInt32LE(8);
    if (PRE + hLen > buf.length) throw new Error('Buffer too small for declared header');
    const h = JSON.parse(buf.subarray(PRE, PRE + hLen).toString('utf-8')) as AppliancePatchHeader;
    if (!ACCEPTED_PATCH_MAGICS.has(h.magic)) throw new Error('Appliance patch header magic mismatch');
    // Preamble magic must match header.magic before any integrity/signature
    // trust. The patch signature covers header.magic but not the raw preamble.
    if (h.magic !== magic) {
      throw new Error(`Appliance patch magic mismatch: preamble "${magic}" != header "${h.magic}"`);
    }
    return h;
  }

  static async verifyPatch(buf: Buffer): Promise<PatchVerifyResult> {
    const errors: string[] = [];
    let header: AppliancePatchHeader;
    try { header = AppliancePatcher.parsePatchHeader(buf); } catch (e) {
      const empty: AppliancePatchHeader = {
        magic: PATCH_MAGIC, version: 0, targetApplianceName: '', targetApplianceVersion: '',
        targetSection: '', patchVersion: '', created: '', newSectionSize: 0,
        newSectionSha256: '', compression: 'none',
      };
      return { valid: false, header: empty, errors: [(e as Error).message] };
    }
    const { start, end, section } = patchData(buf);
    if (end < start) {
      errors.push('Patch too small: no room for section data and footer');
      return { valid: false, header, errors };
    }
    if (section.length !== header.newSectionSize)
      errors.push(`Size mismatch: header=${header.newSectionSize}, actual=${section.length}`);
    if (sha256(section) !== header.newSectionSha256)
      errors.push('Section SHA256 mismatch');
    if (!sha256B(section).equals(buf.subarray(buf.length - SHA_LEN)))
      errors.push('Footer SHA256 mismatch');
    return { valid: errors.length === 0, header, errors };
  }

  static async applyPatch(
    appliancePath: string, patchBuf: Buffer, opts?: ApplyOptions,
  ): Promise<ApplyResult> {
    const doBackup = opts?.backup ?? true;
    const doVerify = opts?.verify ?? true;

    // Parse & verify patch
    let header: AppliancePatchHeader;
    try { header = AppliancePatcher.parsePatchHeader(patchBuf); } catch (e) {
      return failResult('', [(e as Error).message]);
    }
    const sec = header.targetSection;

    // Verify signature
    if (opts?.publicKey && header.signature) {
      const { section } = patchData(patchBuf);
      const unsigned = { ...header } as Record<string, unknown>;
      delete unsigned.signature; delete unsigned.signedBy;
      const signable = Buffer.concat([Buffer.from(canonicalJson(unsigned), 'utf-8'), section]);
      if (!edCheck(signable, header.signature, opts.publicKey))
        return failResult(sec, ['Patch signature verification failed']);
    }

    // Verify patch integrity
    const check = await AppliancePatcher.verifyPatch(patchBuf);
    if (!check.valid) return failResult(sec, check.errors);

    // Read target appliance
    let reader: ApplianceReader;
    try { reader = await ApplianceReader.fromFile(appliancePath); } catch (e) {
      return failResult(sec, [`Failed to read appliance: ${(e as Error).message}`]);
    }
    const rh = reader.getHeader();

    // Verify target matches
    const errs: string[] = [];
    if (rh.name !== header.targetApplianceName)
      errs.push(`Name mismatch: patch="${header.targetApplianceName}", file="${rh.name}"`);
    if (rh.appVersion !== header.targetApplianceVersion)
      errs.push(`Version mismatch: patch="${header.targetApplianceVersion}", file="${rh.appVersion}"`);
    if (errs.length) return failResult(sec, errs);
    if (!rh.sections.find((s) => s.id === sec))
      return failResult(sec, [`Section "${sec}" not found in appliance`]);

    // Backup
    let backupPath: string | undefined;
    if (doBackup) { backupPath = appliancePath + '.bak'; await copyFile(appliancePath, backupPath); }

    // Extract new section data from patch (decompress if needed)
    let newData = patchData(patchBuf).section;
    if (header.compression === 'gzip') newData = gunzipSync(newData);

    // Rebuild appliance with replaced section
    const writer = new ApplianceWriter({ ...rh, sections: [] });
    for (const s of rh.sections) {
      const comp = s.compression === 'zstd' ? 'gzip' : s.compression;
      if (s.id === sec) {
        writer.addSection(s.id, newData, { compression: comp, type: s.type });
      } else {
        writer.addSection(s.id, reader.extractSection(s.id), { compression: comp, type: s.type });
      }
    }
    const newAppliance = writer.build();

    // Atomic write (tmp + rename)
    const tmpPath = appliancePath + `.tmp.${Date.now()}`;
    try {
      await writeFile(tmpPath, newAppliance);
      await rename(tmpPath, appliancePath);
    } catch (e) {
      await unlink(tmpPath).catch(() => {}); // intentional: fire-and-forget cleanup
      if (backupPath) await copyFile(backupPath, appliancePath).catch(() => {}); // intentional: fire-and-forget rollback
      return failResult(sec, [`Atomic write failed: ${(e as Error).message}`], { backupPath });
    }

    // Post-patch verification with rollback
    if (doVerify) {
      try {
        const vr = await ApplianceReader.fromFile(appliancePath);
        const vResult = vr.verify();
        if (!vResult.valid) {
          if (backupPath) await copyFile(backupPath, appliancePath).catch(() => {}); // intentional: fire-and-forget rollback
          return failResult(sec, [`Post-patch verification failed: ${vResult.errors.join('; ')}`],
            { backupPath, newSize: newAppliance.length });
        }
      } catch (e) {
        if (backupPath) await copyFile(backupPath, appliancePath).catch(() => {}); // intentional: fire-and-forget rollback
        return failResult(sec, [`Post-patch verify error: ${(e as Error).message}`],
          { backupPath, newSize: newAppliance.length });
      }
    }

    return { success: true, backupPath, newSize: newAppliance.length, patchedSection: sec, errors: [] };
  }
}

// ── AppliancePublisher ────────────────────────────────────────────
export class AppliancePublisher {
  private jwt: string;
  private gw: string;
  private api: string;

  constructor(config: PublishConfig) {
    this.jwt = config.pinataJwt || process.env.PINATA_API_JWT || '';
    this.gw = (config.gatewayUrl || DEFAULT_GW).replace(/\/+$/, '');
    this.api = (config.apiUrl || DEFAULT_API).replace(/\/+$/, '');
    if (!this.jwt) throw new Error('Pinata JWT required (config.pinataJwt or PINATA_API_JWT)');
  }

  private async upload(
    fileName: string, data: Buffer, kv: Record<string, string>,
  ): Promise<PublishResult> {
    const meta = JSON.stringify({ name: fileName, keyvalues: kv });
    const { body, ct } = multipart('file', fileName, data, meta);
    const res = await pinataReq('POST', `${this.api}/pinning/pinFileToIPFS`, this.jwt, body, ct);
    if (res.status !== 200)
      throw new Error(`Pinata upload failed (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
    const r = res.data as { IpfsHash: string; PinSize: number };
    return {
      cid: r.IpfsHash, size: r.PinSize,
      gatewayUrl: `${this.gw}/ipfs/${r.IpfsHash}`, pinataUrl: `${this.api}/pinning/pins/${r.IpfsHash}`,
    };
  }

  async publish(appliancePath: string, meta?: PublishMetadata): Promise<PublishResult> {
    const data = await readFile(appliancePath);
    const name = meta?.name || appliancePath.split('/').pop() || 'appliance.hfap';
    return this.upload(name, data, {
      type: 'hive-flow-appliance', version: meta?.version || '',
      profile: meta?.profile || '', description: meta?.description || '',
    });
  }

  async publishPatch(patchBuf: Buffer, meta?: PublishMetadata): Promise<PublishResult> {
    const name = meta?.name || `patch-${Date.now()}.hfpp`;
    return this.upload(name, patchBuf, {
      type: 'hive-flow-patch', version: meta?.version || '', description: meta?.description || '',
    });
  }

  async fetch(cid: string, outputPath: string): Promise<void> {
    const data = await httpGet(`${this.gw}/ipfs/${cid}`);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, data);
  }

  async list(): Promise<PublishedItem[]> {
    const res = await pinataReq('GET', `${this.api}/data/pinList?status=pinned&pageLimit=100`, this.jwt);
    if (res.status !== 200)
      throw new Error(`Pinata list failed (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
    const d = res.data as { rows: Array<{
      ipfs_pin_hash: string; metadata?: { name?: string }; size: number; date_pinned: string;
    }> };
    return (d.rows || []).map((r) => ({
      cid: r.ipfs_pin_hash, name: r.metadata?.name || r.ipfs_pin_hash,
      size: r.size, date: r.date_pinned,
    }));
  }

  async pin(cid: string, name?: string): Promise<void> {
    const body = Buffer.from(JSON.stringify({ hashToPin: cid, pinataMetadata: { name: name || cid } }));
    const res = await pinataReq('POST', `${this.api}/pinning/pinByHash`, this.jwt, body, 'application/json');
    if (res.status !== 200)
      throw new Error(`Pinata pin failed (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
  }
}

// ── Convenience exports ──────────────────────────────────────
export function createPublisher(config?: Partial<PublishConfig>): AppliancePublisher {
  return new AppliancePublisher({ pinataJwt: config?.pinataJwt, gatewayUrl: config?.gatewayUrl, apiUrl: config?.apiUrl });
}

export async function createAndVerifyPatch(
  options: CreatePatchOptions,
): Promise<{ patch: Buffer; verification: PatchVerifyResult }> {
  const patch = await AppliancePatcher.createPatch(options);
  const verification = await AppliancePatcher.verifyPatch(patch);
  return { patch, verification };
}
