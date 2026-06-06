#!/usr/bin/env node
/**
 * Settings Reconciler — CP-B7 backstop.
 *
 * Repairs settings drift after writes and at session boundaries:
 * - strips disableAllHooks
 * - re-injects the canonical enforcement PreToolUse chain
 *
 * It does not grant permissions or remove human deny rules.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadProtectedPathPolicyModule() {
  const envProjectRoot = process.env.HIVE_FLOW_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || '';
  const candidates = [
    envProjectRoot && path.join(path.resolve(envProjectRoot), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'),
    path.join(path.resolve(process.cwd()), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'),
    path.join(path.resolve(__dirname, '..', '..'), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'),
    path.join(__dirname, 'protected-paths.cjs'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return require(candidate);
    } catch {
      // Try the next candidate.
    }
  }

  return require(path.join(path.resolve(__dirname, '..', '..'), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'));
}

const protectedPathPolicy = loadProtectedPathPolicyModule();
const PROJECT_DIR = protectedPathPolicy.resolveProjectRoot({
  env: process.env,
  cwd: path.resolve(__dirname, '..', '..'),
  fallbackRoot: process.cwd(),
});
const ENFORCEMENT_DIR = path.join(PROJECT_DIR, '.hive-flow', 'enforcement');
const HMAC_KEY_FILE = path.join(ENFORCEMENT_DIR, '.hmac-key');
const SETTINGS_PRESETS_FILE = path.join(ENFORCEMENT_DIR, 'settings-presets.json');
const VIOLATIONS_FILE = path.join(ENFORCEMENT_DIR, 'violations.jsonl');
const SETTINGS_PRESET_VERSION = 2;

const GUARDED_TOOL_MATCHER = [
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'Read',
  'NotebookRead',
  'WebFetch',
  'NotebookEdit',
  'mcp__filesystem__write_file',
  'mcp__filesystem__edit_file',
  'mcp__filesystem__move_file',
  'mcp__filesystem__rename_file',
  'mcp__filesystem__copy_file',
  'mcp__filesystem__create_directory',
  'mcp__filesystem__delete_file',
  'mcp__filesystem__read_file',
  'mcp__filesystem__read_text_file',
  'mcp__filesystem__read_media_file',
  'mcp__filesystem__read_multiple_files',
].join('|');

const RELOCATED_ENFORCEMENT_BIN = '$HOME/.hive-flow/enforcement/bin';

function helperCommand(helper, args = '') {
  return `node "${RELOCATED_ENFORCEMENT_BIN}/${helper}"${args ? ` ${args}` : ''}`;
}

const CANONICAL_PRESETS = [
  { event: 'PreToolUse', matcher: 'Task', command: helperCommand('hive-composition-gate.cjs'), timeout: 5000 },
  { event: 'PreToolUse', matcher: 'mcp__hive-flow__agent_spawn|mcp__hive-flow__queen_spawn_worker', command: helperCommand('role-enforcement.cjs'), timeout: 3000 },
  { event: 'PreToolUse', matcher: 'mcp__hive-flow__agent_spawn|mcp__hive-flow__queen_spawn_worker', command: helperCommand('enforcement.cjs'), timeout: 5000 },
  { event: 'PreToolUse', matcher: GUARDED_TOOL_MATCHER, command: helperCommand('role-enforcement.cjs'), timeout: 3000 },
  { event: 'PreToolUse', matcher: GUARDED_TOOL_MATCHER, command: helperCommand('enforcement.cjs'), timeout: 5000 },
  { event: 'PreToolUse', matcher: GUARDED_TOOL_MATCHER, command: helperCommand('hook-handler.cjs', 'permission-guard'), timeout: 15000 },
  { event: 'PreToolUse', matcher: GUARDED_TOOL_MATCHER, command: helperCommand('hook-handler.cjs', 'enforce-plan'), timeout: 5000 },
  { event: 'PreToolUse', matcher: GUARDED_TOOL_MATCHER, command: helperCommand('hook-handler.cjs', 'pre-bash'), timeout: 5000 },
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function getOrCreateHmacKey() {
  try {
    if (fs.existsSync(HMAC_KEY_FILE)) return fs.readFileSync(HMAC_KEY_FILE, 'utf8').trim();
  } catch {
    // Fall through to create.
  }
  ensureDir(ENFORCEMENT_DIR);
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(HMAC_KEY_FILE, key, { mode: 0o600 });
  return key;
}

function computeHmac(state) {
  return crypto.createHmac('sha256', getOrCreateHmacKey()).update(JSON.stringify(state)).digest('hex');
}

function signState(state) {
  return { state, hmac: computeHmac(state) };
}

function verifyState(envelope) {
  if (!envelope || typeof envelope !== 'object' || !envelope.state || !envelope.hmac) return { valid: false, state: null };
  const expected = computeHmac(envelope.state);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(String(envelope.hmac), 'hex');
  if (expectedBuf.length !== actualBuf.length) return { valid: false, state: null };
  return { valid: crypto.timingSafeEqual(expectedBuf, actualBuf), state: envelope.state };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

function normalizeCommand(command) {
  return String(command || '')
    .replace(/\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\}/g, PROJECT_DIR)
    .replace(/\s+/g, ' ')
    .trim();
}

function loadPresets(settings) {
  const existing = readJson(SETTINGS_PRESETS_FILE);
  const verified = verifyState(existing);
  if (
    verified.valid &&
    verified.state &&
    verified.state.version === SETTINGS_PRESET_VERSION &&
    Array.isArray(verified.state.entries) &&
    verified.state.entries.length > 0
  ) {
    return verified.state;
  }

  const baselineAllow = Array.isArray(settings?.permissions?.allow)
    ? settings.permissions.allow.map(entry => String(entry))
    : [];
  const state = { version: SETTINGS_PRESET_VERSION, entries: CANONICAL_PRESETS, baselineAllow };
  writeJsonAtomic(SETTINGS_PRESETS_FILE, signState(state));
  return state;
}

function appendViolation(file, actions) {
  try {
    ensureDir(ENFORCEMENT_DIR);
    fs.appendFileSync(VIOLATIONS_FILE, JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'settings-reconciled',
      file,
      actions,
    }) + '\n');
  } catch {
    // Reconciliation should not fail the hook because logging failed.
  }
}

function ensureHookEntry(settings, entry) {
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const groups = Array.isArray(settings.hooks[entry.event]) ? settings.hooks[entry.event] : [];
  settings.hooks[entry.event] = groups;
  let group = groups.find(candidate => String(candidate?.matcher || '') === String(entry.matcher || ''));
  if (!group) {
    group = { matcher: entry.matcher, hooks: [] };
    groups.unshift(group);
  }
  group.hooks = Array.isArray(group.hooks) ? group.hooks : [];
  const exists = group.hooks.some(hook => hook?.type === 'command' && normalizeCommand(hook.command) === normalizeCommand(entry.command));
  if (exists) return false;
  group.hooks.push({ type: 'command', command: entry.command, timeout: entry.timeout });
  return true;
}

function reconcileSettingsFile(filePath, presets, required) {
  if (!fs.existsSync(filePath)) {
    if (!required) return false;
    writeJsonAtomic(filePath, { hooks: {} });
  }
  const settings = readJson(filePath);
  if (!settings || typeof settings !== 'object') return false;

  const actions = [];
  if (settings.disableAllHooks === true) {
    delete settings.disableAllHooks;
    actions.push('strip-disableAllHooks');
  }

  for (const entry of presets.entries || []) {
    if (ensureHookEntry(settings, entry)) actions.push('reinject');
  }

  if (actions.length === 0) return false;
  writeJsonAtomic(filePath, settings);
  appendViolation(filePath, [...new Set(actions)]);
  return true;
}

function main() {
  const settingsPath = path.join(PROJECT_DIR, '.claude', 'settings.json');
  const localSettingsPath = path.join(PROJECT_DIR, '.claude', 'settings.local.json');
  const settings = readJson(settingsPath) || {};
  const presets = loadPresets(settings);
  reconcileSettingsFile(settingsPath, presets, true);
  reconcileSettingsFile(localSettingsPath, presets, false);
}

if (require.main === module) {
  try {
    main();
  } catch {
    // Repair hook is best-effort; PreToolUse content guard is fail-closed.
  }
}

module.exports = {
  CANONICAL_PRESETS,
  reconcileSettingsFile,
  loadPresets,
  normalizeCommand,
};
