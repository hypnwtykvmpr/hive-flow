/**
 * Biometric Override — Ed25519 cryptographic override system for Permission Guard.
 *
 * Replaces the oath-based mechanism with asymmetric Ed25519 signatures backed
 * by a platform-specific locked credential store. The private key is stored in
 * a SEPARATE locked keychain (not the default login keychain) and retrieval
 * requires human authentication via a system dialog or /dev/tty prompt.
 *
 * An LLM cannot forge overrides because:
 *   - The private key lives in a locked store the LLM cannot authenticate to
 *   - Ed25519 signatures are asymmetric: public key (disk) != private key (locked store)
 *   - Password entry uses /dev/tty which bypasses LLM-controlled stdin/stdout
 *   - Override files contain a nonce + expiry covered by the signature
 *   - machineId check prevents stolen override file reuse
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { createReadStream, createWriteStream } from 'node:fs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUARD_DIR = join(homedir(), '.claude-flow', 'permission-guard');
const PUBKEY_PATH = join(GUARD_DIR, 'override-pubkey.pem');
const OVERRIDE_PATH = join(GUARD_DIR, 'active-override.json');
const PRIVKEY_ENC_PATH = join(GUARD_DIR, 'privkey.enc');

const DARWIN_KEYCHAIN_PATH = join(homedir(), 'Library', 'Keychains', 'claude-guard.keychain-db');
const DARWIN_SERVICE_NAME = 'claude-pg-privkey';
const DARWIN_ACCOUNT_NAME = process.env['USER'] || 'user';

const OVERRIDE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OverridePayload {
  nonce: string;
  expiresAt: number;
  machineId: string;
  grantedAt: number;
}

interface OverrideFile {
  payload: string; // JSON-stringified OverridePayload
  signature: string; // base64-encoded Ed25519 signature
}

/**
 * Platform-specific credential store provider interface.
 * Each implementation stores and retrieves the Ed25519 private key PEM
 * in a locked, hardware-backed or password-protected store.
 */
interface PlatformAuthProvider {
  name: string;
  isAvailable(): boolean;
  storePrivateKey(privPem: string, password: string): void;
  retrievePrivateKey(): string | null;
}

// ---------------------------------------------------------------------------
// /dev/tty prompt — the unforgeable human verification channel
//
// Opens /dev/tty DIRECTLY — bypasses stdin/stdout that LLM tools use.
// An LLM's Bash tool has stdin piped from Claude Code, NOT connected to /dev/tty.
// ---------------------------------------------------------------------------

async function promptViaTTY(question: string): Promise<string> {
  // Fail-closed: if /dev/tty is unavailable (headless CI), return empty string
  if (!existsSync('/dev/tty')) {
    process.stderr.write('[permission-guard] /dev/tty not available (headless) — override denied\n');
    return '';
  }

  const ttyIn = createReadStream('/dev/tty');
  const ttyOut = createWriteStream('/dev/tty');

  const rl = readline.createInterface({ input: ttyIn, output: ttyOut });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      ttyIn.destroy();
      ttyOut.destroy();
      resolve(answer);
    });
  });
}

// ---------------------------------------------------------------------------
// Platform providers
// ---------------------------------------------------------------------------

/**
 * macOS: Separate locked keychain at ~/Library/Keychains/claude-guard.keychain-db
 *
 * Uses the `security` CLI (via execFileSync, not shell) to manage a separate
 * keychain (NOT the login keychain). The keychain is locked by default;
 * `security unlock-keychain` without -p triggers the macOS password dialog —
 * the LLM cannot interact with this dialog.
 */
class DarwinAuthProvider implements PlatformAuthProvider {
  name = 'macOS Keychain (claude-guard)';

  isAvailable(): boolean {
    try {
      execFileSync('which', ['security'], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  storePrivateKey(privPem: string, password: string): void {
    const SERVICE = DARWIN_SERVICE_NAME;
    const ACCOUNT = DARWIN_ACCOUNT_NAME;
    const KEYCHAIN_PATH = DARWIN_KEYCHAIN_PATH;

    // Create a separate locked keychain (not login keychain)
    // Arguments passed as array to execFileSync — no shell injection possible
    try {
      execFileSync('security', [
        'create-keychain',
        '-p', password,
        KEYCHAIN_PATH,
      ], { stdio: 'pipe' });
    } catch {
      // Keychain may already exist — try to proceed
    }

    // Delete any existing entry before adding (supports re-enrollment)
    try {
      execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT, KEYCHAIN_PATH], { stdio: 'pipe' });
    } catch { /* no existing entry — fine */ }

    // base64-encode the PEM to prevent newline stripping by macOS keychain
    const encoded = Buffer.from(privPem).toString('base64');

    // Store private key in the separate keychain
    // The encoded key is passed as a direct argument (no shell interpolation)
    // Keychain path is the last positional argument (no -k flag)
    execFileSync('security', [
      'add-generic-password',
      '-s', SERVICE,
      '-a', ACCOUNT,
      '-w', encoded,
      KEYCHAIN_PATH,
    ], { stdio: 'pipe' });

    // Lock the keychain so future access requires the password
    execFileSync('security', ['lock-keychain', KEYCHAIN_PATH], { stdio: 'pipe' });
  }

  retrievePrivateKey(): string | null {
    const SERVICE = DARWIN_SERVICE_NAME;
    const ACCOUNT = DARWIN_ACCOUNT_NAME;
    const KEYCHAIN_PATH = DARWIN_KEYCHAIN_PATH;

    const decodeRaw = (raw: string): string | null => {
      if (!raw) return null;

      // Migration guard: detect pre-fix data (raw PEM stored without base64 encoding)
      if (raw.startsWith('-----BEGIN')) {
        const pemMatch = raw.match(/^(-----BEGIN [A-Z ]+-----)(.+)(-----END [A-Z ]+-----)$/);
        if (pemMatch) {
          const reconstructed = `${pemMatch[1]}\n${pemMatch[2]}\n${pemMatch[3]}\n`;
          try {
            crypto.createPrivateKey(reconstructed);
            process.stderr.write('[permission-guard] Migrated pre-fix keychain entry. Consider running: reset + setup\n');
            return reconstructed;
          } catch {
            process.stderr.write('[permission-guard] Corrupted pre-fix PEM in keychain. Re-enroll required.\n');
            return null;
          }
        }
        return null;
      }

      // Normal path: base64-decode back to PEM
      return Buffer.from(raw, 'base64').toString('utf8');
    };

    try {
      // Unlock triggers OS-level password dialog (not stdin/stdout)
      // No -p flag: macOS shows a system-level dialog the LLM cannot interact with
      execFileSync('security', ['unlock-keychain', KEYCHAIN_PATH], { stdio: 'pipe' });

      // Keychain path is the last positional argument (no -k flag)
      const raw = execFileSync('security', [
        'find-generic-password',
        '-s', SERVICE,
        '-a', ACCOUNT,
        '-w',
        KEYCHAIN_PATH,
      ], { stdio: 'pipe' }).toString().trim();

      // Re-lock after retrieval
      execFileSync('security', ['lock-keychain', KEYCHAIN_PATH], { stdio: 'pipe' });

      const result = decodeRaw(raw);
      if (result) return result;

      // Try login keychain as fallback for pre-fix enrollments
      try {
        const loginRaw = execFileSync('security', [
          'find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w',
        ], { stdio: 'pipe' }).toString().trim();
        if (loginRaw) {
          process.stderr.write('[permission-guard] Found key in login keychain (pre-fix). Consider re-enrolling.\n');
          return decodeRaw(loginRaw);
        }
      } catch { /* not in login keychain either */ }

      return null;
    } catch (err) {
      process.stderr.write(`[permission-guard] Keychain unlock failed: ${err}\n`);
      return null;
    }
  }
}

/**
 * Linux: AES-256-CBC encrypted file using Node.js built-in crypto.
 *
 * The encrypted file lives at ~/.claude-flow/permission-guard/privkey.enc.
 * Password is entered via /dev/tty (never stored). Encryption is done entirely
 * in Node.js — no external openssl binary dependency.
 */
class LinuxAuthProvider implements PlatformAuthProvider {
  name = 'Linux AES-256-CBC encrypted file (Node.js crypto)';

  isAvailable(): boolean {
    // Always available — uses only Node.js built-in crypto
    return true;
  }

  storePrivateKey(privPem: string, password: string): void {
    // Derive key from password via PBKDF2
    const salt = crypto.randomBytes(32);
    const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(privPem, 'utf8'), cipher.final()]);

    const stored = {
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      data: encrypted.toString('base64'),
    };

    writeFileSync(PRIVKEY_ENC_PATH, JSON.stringify(stored), { mode: 0o600 });
  }

  retrievePrivateKey(): string | null {
    if (!existsSync(PRIVKEY_ENC_PATH)) return null;

    // Get password via /dev/tty — LLM cannot interact with this
    // We must use the async promptViaTTY but need sync here;
    // fall back to reading from /dev/tty synchronously via execFileSync
    try {
      // Use bash to read password from /dev/tty without echo
      // execFileSync with /bin/bash and no shell-injectable args
      const password = execFileSync('/bin/bash', [
        '-c',
        'read -rs -p "Permission Guard keychain password: " PW </dev/tty && echo "$PW"',
      ], { stdio: ['pipe', 'pipe', 'inherit'] }).toString().trim();

      if (!password) return null;

      const stored = JSON.parse(readFileSync(PRIVKEY_ENC_PATH, 'utf8'));
      const salt = Buffer.from(stored.salt as string, 'base64');
      const iv = Buffer.from(stored.iv as string, 'base64');
      const data = Buffer.from(stored.data as string, 'base64');

      const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      const privPem = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');

      return privPem || null;
    } catch {
      return null;
    }
  }
}

/**
 * Windows: PBKDF2 + AES-256-CBC encrypted file, password via CON device.
 *
 * Password is entered via PowerShell Read-Host (Windows equivalent of /dev/tty).
 * Key derivation and encryption are done in Node.js built-in crypto — no external deps.
 */
class WindowsAuthProvider implements PlatformAuthProvider {
  name = 'Windows PBKDF2 + AES-256-CBC encrypted file';

  isAvailable(): boolean {
    return process.platform === 'win32';
  }

  storePrivateKey(privPem: string, password: string): void {
    const salt = crypto.randomBytes(32);
    const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(privPem, 'utf8'), cipher.final()]);

    const stored = {
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      data: encrypted.toString('base64'),
    };

    writeFileSync(PRIVKEY_ENC_PATH, JSON.stringify(stored), { mode: 0o600 });
  }

  retrievePrivateKey(): string | null {
    if (!existsSync(PRIVKEY_ENC_PATH)) return null;

    try {
      // Prompt for password via PowerShell (uses CON device, not stdin)
      // The script is a fixed literal string — no user data interpolated
      const password = execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        '[Console]::Error.WriteLine("Permission Guard password required"); ' +
        '$p = Read-Host -AsSecureString -Prompt "Password"; ' +
        '[Runtime.InteropServices.Marshal]::PtrToStringAuto(' +
        '[Runtime.InteropServices.Marshal]::SecureStringToBSTR($p))',
      ], { stdio: 'pipe' }).toString().trim();

      if (!password) return null;

      const stored = JSON.parse(readFileSync(PRIVKEY_ENC_PATH, 'utf8'));
      const salt = Buffer.from(stored.salt as string, 'base64');
      const iv = Buffer.from(stored.iv as string, 'base64');
      const data = Buffer.from(stored.data as string, 'base64');

      const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      const privPem = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');

      return privPem || null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

function getPlatformProvider(): PlatformAuthProvider {
  switch (process.platform) {
    case 'darwin': return new DarwinAuthProvider();
    case 'win32': return new WindowsAuthProvider();
    default: return new LinuxAuthProvider(); // linux and any other platform
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * One-time setup: generate Ed25519 keypair and store private key in locked store.
 * The public key is saved to disk (safe to read, cannot forge signatures).
 * The private key goes into the platform-specific locked credential store.
 *
 * Must be run by the human, not the LLM.
 */
export async function setupOverride(): Promise<void> {
  mkdirSync(GUARD_DIR, { recursive: true });

  if (existsSync(PUBKEY_PATH)) {
    process.stderr.write('\nEnrollment already exists.\n');
    process.stderr.write('To re-enroll, first run: node scripts/permission-guard-setup.mjs reset\n\n');
    return;
  }

  const provider = getPlatformProvider();
  if (!provider.isAvailable()) {
    throw new Error(`Platform provider '${provider.name}' is not available on this system`);
  }

  // Generate Ed25519 keypair (Node.js 15.7+ built-in, zero external deps)
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  // Store public key on disk (mode 0o444 — world-readable, safe: cannot forge sigs)
  writeFileSync(PUBKEY_PATH, pubPem, { mode: 0o444 });

  // Prompt user for keychain password via /dev/tty
  const password = await promptViaTTY(
    'Create a password for the Permission Guard credential store: '
  );

  if (!password) {
    unlinkSync(PUBKEY_PATH);
    throw new Error('No password provided — setup aborted');
  }

  // Store private key in platform-specific locked credential store
  provider.storePrivateKey(privPem, password);

  process.stdout.write('[permission-guard] Setup complete. Override keypair generated and stored.\n');
  process.stdout.write(`  Public key: ${PUBKEY_PATH}\n`);
  process.stdout.write(`  Provider: ${provider.name}\n`);
}

/**
 * Request a 5-minute override window. Retrieves the private key from the
 * locked credential store (triggers human authentication), signs a payload,
 * and writes the signed override file.
 *
 * @returns Whether the override was successfully granted and when it expires.
 */
export async function requestOverride(): Promise<{ granted: boolean; expiresAt: number }> {
  if (!existsSync(PUBKEY_PATH)) {
    process.stderr.write('[permission-guard] Override not set up. Run: claude-flow permission-guard setup\n');
    return { granted: false, expiresAt: 0 };
  }

  const provider = getPlatformProvider();

  // Retrieve private key — triggers system auth dialog or /dev/tty prompt
  const privPem = provider.retrievePrivateKey();
  if (!privPem) {
    process.stderr.write('[permission-guard] Failed to retrieve private key — authentication failed or cancelled\n');
    return { granted: false, expiresAt: 0 };
  }

  // Create override payload
  const expiresAt = Date.now() + OVERRIDE_TTL_MS;
  const payload: OverridePayload = {
    nonce: crypto.randomBytes(32).toString('hex'),
    expiresAt,
    machineId: hostname(),
    grantedAt: Date.now(),
  };
  const payloadStr = JSON.stringify(payload);

  // Sign with Ed25519 private key
  const privateKey = crypto.createPrivateKey(privPem);
  const signature = crypto.sign(null, Buffer.from(payloadStr), privateKey).toString('base64');

  // Zero out private key buffer (best-effort — V8 GC may retain copies in JS strings)
  const privPemBuf = Buffer.from(privPem);
  privPemBuf.fill(0);

  // Write signed override file (mode 0o600 — owner-only read/write)
  const overrideFile: OverrideFile = { payload: payloadStr, signature };
  writeFileSync(OVERRIDE_PATH, JSON.stringify(overrideFile), { mode: 0o600 });

  const expiresIn = Math.round(OVERRIDE_TTL_MS / 1000 / 60);
  process.stdout.write(`[permission-guard] Override granted for ${expiresIn} minutes.\n`);
  process.stdout.write(`  Expires at: ${new Date(expiresAt).toLocaleTimeString()}\n`);

  return { granted: true, expiresAt };
}

/**
 * Check whether a valid, non-expired, cryptographically verified override is active.
 *
 * Uses ONLY the public key for verification — the LLM can read the public key
 * but cannot forge signatures without the private key.
 *
 * Fails closed on any error (missing file, parse error, expired, bad signature,
 * machineId mismatch) — returns false in all error cases.
 */
export function hasActiveOverride(): boolean {
  try {
    if (!existsSync(OVERRIDE_PATH) || !existsSync(PUBKEY_PATH)) return false;

    const raw = readFileSync(OVERRIDE_PATH, 'utf-8');
    const { payload, signature }: OverrideFile = JSON.parse(raw);

    // Parse payload and check expiry first (fast path)
    const data: OverridePayload = JSON.parse(payload);
    if (data.expiresAt <= Date.now()) {
      // Clean up expired override file
      try { unlinkSync(OVERRIDE_PATH); } catch { /* ignore cleanup failure */ }
      return false;
    }

    // Verify machineId matches (prevents stolen override file reuse)
    if (data.machineId !== hostname()) return false;

    // Verify Ed25519 signature using PUBLIC key only
    // The LLM can read the public key — it cannot forge signatures without the private key
    const pubPem = readFileSync(PUBKEY_PATH, 'utf-8');
    const publicKey = crypto.createPublicKey(pubPem);
    const isValid = crypto.verify(
      null,
      Buffer.from(payload),
      publicKey,
      Buffer.from(signature, 'base64')
    );

    if (!isValid) {
      // Tampered override file — delete it
      try { unlinkSync(OVERRIDE_PATH); } catch { /* ignore cleanup failure */ }
      return false;
    }

    return true;
  } catch {
    // No file, parse error, missing pubkey, bad crypto — all deny (fail-closed)
    return false;
  }
}

/**
 * Revoke any active override immediately by deleting the override file.
 */
export function revokeOverride(): void {
  try {
    if (existsSync(OVERRIDE_PATH)) {
      unlinkSync(OVERRIDE_PATH);
      process.stdout.write('[permission-guard] Override revoked.\n');
    } else {
      process.stdout.write('[permission-guard] No active override to revoke.\n');
    }
  } catch (err) {
    process.stderr.write(`[permission-guard] Failed to revoke override: ${err}\n`);
  }
}

/**
 * Get the current override status: active/expired/none with time remaining.
 * Uses the public override file for expiry info; does NOT require private key access.
 */
export function overrideStatus(): { active: boolean; expiresAt?: number; secondsRemaining?: number } {
  try {
    if (!existsSync(OVERRIDE_PATH)) return { active: false };

    const raw = readFileSync(OVERRIDE_PATH, 'utf-8');
    const { payload }: OverrideFile = JSON.parse(raw);
    const data: OverridePayload = JSON.parse(payload);

    if (data.expiresAt <= Date.now()) {
      return { active: false };
    }

    // Use hasActiveOverride for the full cryptographic check
    const active = hasActiveOverride();
    if (!active) return { active: false };

    const secondsRemaining = Math.max(0, Math.ceil((data.expiresAt - Date.now()) / 1000));
    return { active: true, expiresAt: data.expiresAt, secondsRemaining };
  } catch {
    return { active: false };
  }
}
