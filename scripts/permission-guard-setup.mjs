#!/usr/bin/env node
/**
 * Permission Guard Setup — Standalone Ed25519 keypair enrollment script.
 *
 * This script extracts the core biometric-override logic so it can run
 * WITHOUT building the monorepo. Uses only Node.js built-in modules.
 *
 * Usage:
 *   node scripts/permission-guard-setup.mjs setup    # One-time keypair generation
 *   node scripts/permission-guard-setup.mjs override  # Request 15-min override window
 *   node scripts/permission-guard-setup.mjs revoke    # Revoke active override
 *   node scripts/permission-guard-setup.mjs status    # Show override state
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync,
  createReadStream, createWriteStream,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUARD_DIR = join(homedir(), '.hive-flow', 'permission-guard');
const PUBKEY_PATH = join(GUARD_DIR, 'override-pubkey.pem');
const OVERRIDE_PATH = join(GUARD_DIR, 'active-override.json');
const PRIVKEY_ENC_PATH = join(GUARD_DIR, 'privkey.enc');

const DARWIN_KEYCHAIN_PATH = join(homedir(), 'Library', 'Keychains', 'claude-guard.keychain-db');
const DARWIN_SERVICE_NAME = 'claude-pg-privkey';
const DARWIN_ACCOUNT_NAME = process.env['USER'] || 'user';

const OVERRIDE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ---------------------------------------------------------------------------
// /dev/tty prompt — unforgeable human verification channel
// ---------------------------------------------------------------------------

async function promptViaTTY(question) {
  if (!existsSync('/dev/tty')) {
    process.stderr.write('[permission-guard] /dev/tty not available — override denied\n');
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

class DarwinAuthProvider {
  name = 'macOS Keychain (claude-guard)';

  isAvailable() {
    try {
      execFileSync('which', ['security'], { stdio: 'pipe' });
      return true;
    } catch { return false; }
  }

  storePrivateKey(privPem, password) {
    // Base64-encode the PEM before storing — keychain strips newlines from
    // multi-line strings, which corrupts PEM format. Base64 is single-line safe.
    const encoded = Buffer.from(privPem).toString('base64');

    try {
      execFileSync('security', [
        'create-keychain', '-p', password, DARWIN_KEYCHAIN_PATH,
      ], { stdio: 'pipe' });
    } catch { /* keychain may already exist */ }

    // Delete any existing entry first (re-enrollment)
    try {
      execFileSync('security', [
        'delete-generic-password',
        '-s', DARWIN_SERVICE_NAME,
        '-a', DARWIN_ACCOUNT_NAME,
        DARWIN_KEYCHAIN_PATH,
      ], { stdio: 'pipe' });
    } catch { /* no existing entry — fine */ }

    execFileSync('security', [
      'add-generic-password',
      '-s', DARWIN_SERVICE_NAME,
      '-a', DARWIN_ACCOUNT_NAME,
      '-w', encoded,
      DARWIN_KEYCHAIN_PATH,
    ], { stdio: 'pipe' });

    execFileSync('security', ['lock-keychain', DARWIN_KEYCHAIN_PATH], { stdio: 'pipe' });
  }

  retrievePrivateKey() {
    try {
      execFileSync('security', ['unlock-keychain', DARWIN_KEYCHAIN_PATH], { stdio: 'pipe' });
      const raw = execFileSync('security', [
        'find-generic-password',
        '-s', DARWIN_SERVICE_NAME,
        '-a', DARWIN_ACCOUNT_NAME,
        '-w',
        DARWIN_KEYCHAIN_PATH,
      ], { stdio: 'pipe' }).toString().trim();
      execFileSync('security', ['lock-keychain', DARWIN_KEYCHAIN_PATH], { stdio: 'pipe' });

      if (!raw) return null;

      // Migration guard: detect pre-fix data (raw PEM stored without base64 encoding).
      // The keychain strips newlines from multi-line strings, corrupting PEM format.
      // Pre-fix entries start with '-----BEGIN' instead of base64 characters.
      if (raw.startsWith('-----BEGIN')) {
        const pemMatch = raw.match(/^(-----BEGIN [A-Z ]+-----)(.+)(-----END [A-Z ]+-----)$/);
        if (pemMatch) {
          const reconstructed = `${pemMatch[1]}\n${pemMatch[2]}\n${pemMatch[3]}\n`;
          try {
            crypto.createPrivateKey(reconstructed); // Validate the reconstructed PEM
            process.stderr.write('[permission-guard] Migrated pre-fix keychain entry. Consider running: reset + setup to re-encode.\n');
            return reconstructed;
          } catch {
            process.stderr.write('[permission-guard] Keychain contains corrupted pre-fix PEM. Run: node scripts/permission-guard-setup.mjs reset\n');
            return null;
          }
        }
        process.stderr.write('[permission-guard] Unrecognized PEM format in keychain. Run: node scripts/permission-guard-setup.mjs reset\n');
        return null;
      }

      // Normal path: base64-decode back to PEM (restores newlines that keychain would strip)
      return Buffer.from(raw, 'base64').toString('utf8');
    } catch (err) {
      process.stderr.write(`[permission-guard] Keychain retrieval failed: ${err}\n`);
      return null;
    }
  }
}

class LinuxAuthProvider {
  name = 'Linux AES-256-CBC encrypted file';

  isAvailable() { return true; }

  storePrivateKey(privPem, password) {
    const salt = crypto.randomBytes(32);
    const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(privPem, 'utf8'), cipher.final()]);
    writeFileSync(PRIVKEY_ENC_PATH, JSON.stringify({
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      data: encrypted.toString('base64'),
    }), { mode: 0o600 });
  }

  retrievePrivateKey() {
    if (!existsSync(PRIVKEY_ENC_PATH)) return null;
    try {
      const password = execFileSync('/bin/bash', [
        '-c', 'read -rs -p "Permission Guard keychain password: " PW </dev/tty && echo "$PW"',
      ], { stdio: ['pipe', 'pipe', 'inherit'] }).toString().trim();
      if (!password) return null;

      const stored = JSON.parse(readFileSync(PRIVKEY_ENC_PATH, 'utf8'));
      const salt = Buffer.from(stored.salt, 'base64');
      const iv = Buffer.from(stored.iv, 'base64');
      const data = Buffer.from(stored.data, 'base64');
      const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8') || null;
    } catch { return null; }
  }
}

function getPlatformProvider() {
  return process.platform === 'darwin' ? new DarwinAuthProvider()
    : new LinuxAuthProvider();
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

async function setupOverride() {
  mkdirSync(GUARD_DIR, { recursive: true });

  // Pre-flight: block re-enrollment when an active key exists (0o444 makes this fail with EACCES otherwise)
  if (existsSync(PUBKEY_PATH)) {
    console.error('\n\x1b[33mEnrollment already exists.\x1b[0m');
    console.error(`  Public key: ${PUBKEY_PATH}`);
    console.error('\nTo re-enroll, first run:');
    console.error('  node scripts/permission-guard-setup.mjs reset\n');
    return;
  }

  const provider = getPlatformProvider();
  if (!provider.isAvailable()) {
    throw new Error(`Provider '${provider.name}' not available`);
  }

  console.log('\n\x1b[1mPermission Guard Setup\x1b[0m');
  console.log('\x1b[2mGenerating Ed25519 keypair and storing private key in locked credential store\x1b[0m\n');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  writeFileSync(PUBKEY_PATH, pubPem, { mode: 0o444 });

  const password = await promptViaTTY('Create a password for the Permission Guard credential store: ');
  if (!password) {
    unlinkSync(PUBKEY_PATH);
    throw new Error('No password provided — setup aborted');
  }

  provider.storePrivateKey(privPem, password);

  console.log('\n\x1b[32m✓ Setup complete\x1b[0m');
  console.log(`  Public key:  ${PUBKEY_PATH}`);
  console.log(`  Provider:    ${provider.name}`);
  console.log(`\nNext: Re-enable the hook matcher in .claude/settings.json`);
}

async function requestOverride() {
  if (!existsSync(PUBKEY_PATH)) {
    console.error('\x1b[31mNot set up. Run: node scripts/permission-guard-setup.mjs setup\x1b[0m');
    return;
  }

  console.log('\n\x1b[1mRequesting Permission Override\x1b[0m');
  console.log('\x1b[2mThis will trigger credential store authentication...\x1b[0m\n');

  const provider = getPlatformProvider();
  const privPem = provider.retrievePrivateKey();
  if (!privPem) {
    console.error('\x1b[31mAuthentication failed or cancelled\x1b[0m');
    return;
  }

  const expiresAt = Date.now() + OVERRIDE_TTL_MS;
  const payload = JSON.stringify({
    nonce: crypto.randomBytes(32).toString('hex'),
    expiresAt,
    machineId: hostname(),
    grantedAt: Date.now(),
  });

  const pk = crypto.createPrivateKey(privPem);
  const signature = crypto.sign(null, Buffer.from(payload), pk).toString('base64');

  writeFileSync(OVERRIDE_PATH, JSON.stringify({ payload, signature }), { mode: 0o600 });

  console.log(`\x1b[32m✓ Override granted\x1b[0m — active until ${new Date(expiresAt).toLocaleTimeString()}`);
}

function hasActiveOverride() {
  try {
    if (!existsSync(OVERRIDE_PATH) || !existsSync(PUBKEY_PATH)) return false;
    const { payload, signature } = JSON.parse(readFileSync(OVERRIDE_PATH, 'utf-8'));
    const data = JSON.parse(payload);
    if (data.expiresAt <= Date.now()) {
      try { unlinkSync(OVERRIDE_PATH); } catch {}
      return false;
    }
    if (data.machineId !== hostname()) return false;
    const pubPem = readFileSync(PUBKEY_PATH, 'utf-8');
    const publicKey = crypto.createPublicKey(pubPem);
    const isValid = crypto.verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, 'base64'));
    if (!isValid) {
      try { unlinkSync(OVERRIDE_PATH); } catch {}
      return false;
    }
    return true;
  } catch { return false; }
}

function revokeOverride() {
  if (existsSync(OVERRIDE_PATH)) {
    unlinkSync(OVERRIDE_PATH);
    console.log('\x1b[32m✓ Override revoked\x1b[0m');
  } else {
    console.log('\x1b[2mNo active override to revoke\x1b[0m');
  }
}

async function resetEnrollment() {
  console.log('\n\x1b[1mPermission Guard Reset\x1b[0m');
  console.log('\x1b[2mThis will delete all enrollment data. You will need to run setup again.\x1b[0m\n');

  const confirm = await promptViaTTY('Type YES to confirm reset: ');
  if (confirm !== 'YES') {
    console.log('\x1b[2mReset cancelled.\x1b[0m');
    return;
  }

  // 1. Delete override files
  for (const f of [OVERRIDE_PATH, join(GUARD_DIR, 'user_override.json')]) {
    try { unlinkSync(f); } catch { /* may not exist */ }
  }

  // 2. Make pubkey writable and delete
  if (existsSync(PUBKEY_PATH)) {
    try {
      const { chmodSync } = await import('node:fs');
      chmodSync(PUBKEY_PATH, 0o644);
      unlinkSync(PUBKEY_PATH);
    } catch (err) {
      console.error(`\x1b[31mFailed to remove pubkey: ${err.message}\x1b[0m`);
      console.error(`  Manually run: chmod u+w "${PUBKEY_PATH}" && rm "${PUBKEY_PATH}"`);
    }
  }

  // 3. Delete encrypted private key file (Linux provider)
  try { unlinkSync(PRIVKEY_ENC_PATH); } catch { /* may not exist */ }

  // 4. macOS: delete keychain entry
  if (process.platform === 'darwin') {
    try {
      execFileSync('security', [
        'delete-generic-password',
        '-s', DARWIN_SERVICE_NAME,
        '-a', DARWIN_ACCOUNT_NAME,
        DARWIN_KEYCHAIN_PATH,
      ], { stdio: 'pipe' });
    } catch { /* entry may not exist */ }
  }

  console.log('\n\x1b[32m✓ Reset complete.\x1b[0m');
  console.log('Run setup to re-enroll:');
  console.log('  node scripts/permission-guard-setup.mjs setup\n');
}

function showStatus() {
  console.log('\n\x1b[1mPermission Guard Status\x1b[0m');
  console.log('\x1b[2m' + '─'.repeat(45) + '\x1b[0m');

  const hasPubkey = existsSync(PUBKEY_PATH);
  console.log(`  Enrolled:    ${hasPubkey ? '\x1b[32mYES\x1b[0m' : '\x1b[31mNO\x1b[0m — run setup first'}`);

  if (!hasPubkey) return;

  const provider = getPlatformProvider();
  console.log(`  Provider:    ${provider.name}`);
  console.log(`  Public key:  ${PUBKEY_PATH}`);

  if (!existsSync(OVERRIDE_PATH)) {
    console.log(`  Override:    \x1b[2mNONE\x1b[0m`);
    return;
  }

  try {
    const { payload } = JSON.parse(readFileSync(OVERRIDE_PATH, 'utf-8'));
    const data = JSON.parse(payload);
    if (data.expiresAt <= Date.now()) {
      console.log(`  Override:    \x1b[33mEXPIRED\x1b[0m`);
      return;
    }
    const active = hasActiveOverride();
    if (active) {
      const secs = Math.max(0, Math.ceil((data.expiresAt - Date.now()) / 1000));
      const mins = Math.floor(secs / 60);
      const remaining = mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`;
      console.log(`  Override:    \x1b[32mACTIVE\x1b[0m — ${remaining} remaining (until ${new Date(data.expiresAt).toLocaleTimeString()})`);
    } else {
      console.log(`  Override:    \x1b[31mINVALID\x1b[0m (signature mismatch or wrong machine)`);
    }
  } catch {
    console.log(`  Override:    \x1b[31mCORRUPT\x1b[0m`);
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const command = process.argv[2];

switch (command) {
  case 'setup':
    await setupOverride();
    break;
  case 'override':
    await requestOverride();
    break;
  case 'revoke':
    revokeOverride();
    break;
  case 'reset':
    await resetEnrollment();
    break;
  case 'status':
    showStatus();
    break;
  default:
    console.log(`
\x1b[1mPermission Guard — Ed25519 Cryptographic Override\x1b[0m

Usage:
  node scripts/permission-guard-setup.mjs <command>

Commands:
  setup      One-time Ed25519 keypair generation (run as human, not LLM)
  override   Request a 15-minute permission override window
  revoke     Immediately revoke any active override
  reset      Delete all enrollment data (requires /dev/tty confirmation)
  status     Show current override state
`);
}
