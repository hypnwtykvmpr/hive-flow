/**
 * HF-17 — decodeHtmlEntities RangeError on invalid/surrogate code points
 * HF-22 — read_file UTF-8 boundary slicing (multi-byte seam mojibake)
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHmac } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = resolve(here, '../scripts/provider-agent-bridge.mjs');
const bridgeUrl = pathToFileURL(bridgePath).href;

// ===== Project-root fixture helpers (mirrored from realpath-jail harness) =====

const cleanups = [];
afterEach(() => {
  while (cleanups.length) {
    const p = cleanups.pop();
    try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function makeProjectRoot(prefix = 'hf-parser-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(root);
  mkdirSync(join(root, '.hive-flow', 'enforcement'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  const real = realpathSync.native(root);
  const key = randomBytes(32).toString('hex');
  const keyPath = join(real, '.hive-flow', 'enforcement', '.hmac-key');
  writeFileSync(keyPath, key, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch { /* best-effort */ }
  const state = {
    level: 0, ts: '2026-06-01T00:00:00.000Z', violations: 0,
    restrictedGroups: [], history: [], integrityCompromised: false,
  };
  const envelope = { state, hmac: createHmac('sha256', key).update(JSON.stringify(state)).digest('hex') };
  writeFileSync(join(real, '.hive-flow', 'enforcement', 'state.json'), JSON.stringify(envelope, null, 2), 'utf8');
  return real;
}

function makeStore(root, agentId, extra = {}) {
  const storeDir = join(root, '.hive-flow', 'agents');
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, 'store.json'), JSON.stringify({
    version: '3.0.0',
    agents: {
      [agentId]: {
        agentId, agentType: 'coder', status: 'busy',
        provider: 'deepseek', model: 'sonnet', resolvedModel: 'deepseek-v4-flash',
        taskCount: 0, config: {}, ...extra,
      },
    },
  }, null, 2), 'utf8');
}

/** Run a bridge tool in a child process with cwd=root. */
function runTool(root, toolName, toolArgs, { agentId = 'parser-agent' } = {}) {
  const script = `
    const bridge = await import(${JSON.stringify(bridgeUrl)});
    const result = await bridge.executeBridgeTool(${JSON.stringify(toolName)}, ${JSON.stringify(toolArgs)}, { source: 'test' });
    process.stdout.write(typeof result === 'string' ? JSON.stringify({ __string: result }) : JSON.stringify(result));
  `;
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    HIVE_FLOW_HOME: join(root, '.hive-flow'),
    HIVE_FLOW_PROJECT_ROOT: root,
    CLAUDE_PROJECT_DIR: root,
    HIVE_FLOW_AGENT_ID: agentId,
    CLAUDE_AGENT_ID: agentId,
    HIVE_FLOW_HIVE_ID: '',
    CLAUDE_SESSION_ID: '',
    HIVE_FLOW_SESSION_ID: '',
  };
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, env, encoding: 'utf8',
  });
  const parsed = JSON.parse(output);
  if (!Object.prototype.hasOwnProperty.call(parsed, '__string')) return parsed;
  const s = parsed.__string;
  if (typeof s === 'string' && s.trimStart().startsWith('{')) {
    try { return JSON.parse(s); } catch { /* plain string */ }
  }
  return s;
}

// ===== HF-17: decodeHtmlEntities — no throw on invalid/surrogate code points =====

describe('HF-17 decodeHtmlEntities — invalid/surrogate code points', () => {
  let decode;
  beforeAll(async () => {
    const mod = await import(bridgeUrl);
    decode = mod.decodeHtmlEntities;
  });

  // Out-of-range: > 0x10FFFF must return the literal entity unchanged
  it('decimal 2147483648 (2^31, > 0x10FFFF) → literal entity, no throw', () => {
    expect(decode('&#2147483648;')).toBe('&#2147483648;');
  });

  it('hex 0xFFFFFFFF → literal entity, no throw', () => {
    expect(decode('&#xFFFFFFFF;')).toBe('&#xFFFFFFFF;');
  });

  it('hex 0x110000 (one above max) → literal entity', () => {
    expect(decode('&#x110000;')).toBe('&#x110000;');
  });

  // Surrogates: 0xD800–0xDFFF must return literal (lone surrogates break JSON.stringify)
  it('surrogate 0xD800 (hex) → literal entity', () => {
    expect(decode('&#xD800;')).toBe('&#xD800;');
  });

  it('surrogate 0xDFFF (hex) → literal entity', () => {
    expect(decode('&#xDFFF;')).toBe('&#xDFFF;');
  });

  it('surrogate 55296 (0xD800 decimal) → literal entity', () => {
    expect(decode('&#55296;')).toBe('&#55296;');
  });

  // Negative controls: valid code points must still decode correctly
  it('&#65; → A (basic ASCII decimal)', () => {
    expect(decode('&#65;')).toBe('A');
  });

  it('&#x41; → A (basic ASCII hex)', () => {
    expect(decode('&#x41;')).toBe('A');
  });

  it('&#128512; → 😀 (valid astral decimal U+1F600)', () => {
    expect(decode('&#128512;')).toBe('😀');
  });

  it('&#x1F600; → 😀 (valid astral hex U+1F600)', () => {
    expect(decode('&#x1F600;')).toBe('😀');
  });

  it('&amp; → & (named entity unchanged)', () => {
    expect(decode('&amp;')).toBe('&');
  });

  it('&lt; → < (named entity unchanged)', () => {
    expect(decode('&lt;')).toBe('<');
  });

  // Mixed: invalid entities preserved, valid decoded, in same string
  it('mixed valid + invalid → only valid decoded', () => {
    expect(decode('&#65;&#2147483648;&#66;')).toBe('A&#2147483648;B');
  });
});

// ===== HF-22: read_file UTF-8 boundary-aware partial reads =====

describe('HF-22 read_file — UTF-8 boundary-aware partial reads', () => {
  const FFFD = '�'; // replacement character — must NOT appear at seams

  /**
   * Build a file dense with 3-byte CJK characters. The bridge headSize = 70%
   * of threshold; with 3-byte chars, any naive byte cut that lands mid-sequence
   * produces FFFD. 110KB > 100KB threshold → truncation path taken.
   */
  function writeCJKFile(filePath, targetBytes) {
    const chunk = '中文测试内容边界检查验证'; // 12 chars × 3 bytes = 36 bytes
    let content = '';
    while (Buffer.byteLength(content, 'utf8') < targetBytes) content += chunk;
    writeFileSync(filePath, content, 'utf8');
    return content;
  }

  /** 4-byte emoji sequences — maximally hostile to byte slicing. */
  function writeEmojiFile(filePath, targetBytes) {
    const chunk = '😀🎉🔥💡🌟🚀🎯✨🏆🎨'; // 10 chars × 4 bytes = 40 bytes
    let content = '';
    while (Buffer.byteLength(content, 'utf8') < targetBytes) content += chunk;
    writeFileSync(filePath, content, 'utf8');
    return content;
  }

  /** Split result at the truncation marker and return { head, tail }. */
  function splitAtMarker(result) {
    const MARKER_START = '\n\n[FILE TRUNCATED:';
    const MARKER_END = ']\n\n';
    const markerIdx = result.indexOf(MARKER_START);
    expect(markerIdx).toBeGreaterThan(0); // must be truncated
    const afterStart = result.indexOf(MARKER_END, markerIdx);
    return {
      head: result.slice(0, markerIdx),
      tail: result.slice(afterStart + MARKER_END.length),
    };
  }

  it('no U+FFFD at head-end or tail-start for CJK-dense file (3-byte seams)', () => {
    const root = makeProjectRoot('hf22-cjk-'); makeStore(root, 'a');
    const filePath = join(root, 'src', 'cjk-dense.txt');
    writeCJKFile(filePath, 110 * 1024);

    const result = runTool(root, 'read_file', { path: filePath }, { agentId: 'a' });
    expect(typeof result).toBe('string');
    const { head, tail } = splitAtMarker(result);

    expect(head.at(-1)).not.toBe(FFFD);
    expect(tail.at(0)).not.toBe(FFFD);
    // Boundary chars must be in CJK block (U+4E00–U+9FFF)
    expect(head.codePointAt(head.length - 1)).toBeGreaterThanOrEqual(0x4E00);
    expect(tail.codePointAt(0)).toBeGreaterThanOrEqual(0x4E00);
  });

  it('no U+FFFD at seams for emoji-dense file (4-byte sequences, hardest case)', () => {
    const root = makeProjectRoot('hf22-emoji-'); makeStore(root, 'a');
    const filePath = join(root, 'src', 'emoji-dense.txt');
    writeEmojiFile(filePath, 110 * 1024);

    const result = runTool(root, 'read_file', { path: filePath }, { agentId: 'a' });
    expect(typeof result).toBe('string');
    const { head, tail } = splitAtMarker(result);

    expect(head.at(-1)).not.toBe(FFFD);
    expect(tail.at(0)).not.toBe(FFFD);
    // Boundary chars must be emoji (U+1F300+)
    expect(head.codePointAt(head.length - 2)).toBeGreaterThanOrEqual(0x1F300); // -2 for surrogate pair
    expect(tail.codePointAt(0)).toBeGreaterThanOrEqual(0x1F300);
  });

  // Negative controls: small files must return full content unchanged

  it('small ASCII file below threshold → full content, no truncation marker', () => {
    const root = makeProjectRoot('hf22-ascii-'); makeStore(root, 'a');
    const filePath = join(root, 'src', 'small-ascii.txt');
    const content = 'hello world\nASCII only\n';
    writeFileSync(filePath, content, 'utf8');

    const result = runTool(root, 'read_file', { path: filePath }, { agentId: 'a' });
    expect(result).toBe(content);
    expect(result).not.toContain('[FILE TRUNCATED:');
  });

  it('small UTF-8 file below threshold → complete chars, byte-identical', () => {
    const root = makeProjectRoot('hf22-small-utf8-'); makeStore(root, 'a');
    const filePath = join(root, 'src', 'small-utf8.txt');
    const content = '中文内容\n日本語\n한국어\n';
    writeFileSync(filePath, content, 'utf8');

    const result = runTool(root, 'read_file', { path: filePath }, { agentId: 'a' });
    expect(result).toBe(content);
  });

  it('BOM-prefixed UTF-8 file truncated → BOM intact at start of result', () => {
    const root = makeProjectRoot('hf22-bom-'); makeStore(root, 'a');
    const filePath = join(root, 'src', 'bom-file.txt');
    const BOM = '﻿';
    // 110KB body of CJK so truncation is triggered
    const chunk = '中文边界测试内容检查验证';
    let body = '';
    while (Buffer.byteLength(body, 'utf8') < 110 * 1024) body += chunk;
    writeFileSync(filePath, BOM + body, 'utf8');

    const result = runTool(root, 'read_file', { path: filePath }, { agentId: 'a' });
    expect(typeof result).toBe('string');
    expect(result).toContain('[FILE TRUNCATED:');
    expect(result.startsWith(BOM)).toBe(true);
  });
});
