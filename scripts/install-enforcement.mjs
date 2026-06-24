#!/usr/bin/env node
/**
 * Hive Flow Enforcement Installer
 *
 * Installs the relocated user-level enforcement engine:
 *   engine:  ~/.hive-flow/enforcement/bin/
 *   trigger: ~/.claude/settings.json
 *
 * The installer is add-only: it does not remove project hooks. Removal must be
 * a separate verified migration step after the user-level hook is observed live.
 */

import { createReadStream, createWriteStream, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline';

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

const ENGINE_FILES = [
  ['.claude/helpers/hive-composition-gate.cjs', 'hive-composition-gate.cjs'],
  ['.claude/helpers/role-enforcement.cjs', 'role-enforcement.cjs'],
  ['.claude/helpers/enforcement.cjs', 'enforcement.cjs'],
  ['.claude/helpers/hook-handler.cjs', 'hook-handler.cjs'],
  ['.claude/helpers/settings-reconciler.cjs', 'settings-reconciler.cjs'],
  ['.claude/helpers/provider-tracker.cjs', 'provider-tracker.cjs'],
  ['.claude/helpers/client-kind.cjs', 'client-kind.cjs'],
  ['.claude/helpers/session-id.cjs', 'session-id.cjs'],
  ['v3/@hive-flow/cli/src/permission-guard/protected-paths.cjs', 'protected-paths.cjs'],
  ['v3/@hive-flow/cli/src/permission-guard/protected-paths.policy.json', 'protected-paths.policy.json'],
];

function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function relocatedEnforcementBin(homeDir = homedir()) {
  return join(homeDir, '.hive-flow', 'enforcement', 'bin');
}

function relocatedCommand(helper, args = '', homeDir = homedir()) {
  return `node "${join(relocatedEnforcementBin(homeDir), helper)}"${args ? ` ${args}` : ''}`;
}

function installerOptions(value = {}) {
  if (typeof value === 'number') return { timeout: value };
  return value && typeof value === 'object' ? value : {};
}

export function relocatedPreToolUseHooks(options = {}) {
  const opts = installerOptions(options);
  const timeout = Number.isFinite(opts.timeout) ? Number(opts.timeout) : 5000;
  const homeDir = opts.homeDir || homedir();
  return [
    {
      matcher: 'Task',
      hooks: [
        { type: 'command', command: relocatedCommand('hive-composition-gate.cjs', '', homeDir), timeout: 5000 },
      ],
    },
    {
      matcher: 'mcp__hive-flow__agent_spawn|mcp__hive-flow__queen_spawn_worker',
      hooks: [
        { type: 'command', command: relocatedCommand('role-enforcement.cjs', '', homeDir), timeout: 3000 },
        { type: 'command', command: relocatedCommand('enforcement.cjs', '', homeDir), timeout: 5000 },
      ],
    },
    {
      matcher: GUARDED_TOOL_MATCHER,
      hooks: [
        { type: 'command', command: relocatedCommand('role-enforcement.cjs', '', homeDir), timeout: 3000 },
        { type: 'command', command: relocatedCommand('enforcement.cjs', '', homeDir), timeout: 5000 },
        { type: 'command', command: relocatedCommand('hook-handler.cjs', 'permission-guard', homeDir), timeout: 15000 },
        { type: 'command', command: relocatedCommand('hook-handler.cjs', 'enforce-plan', homeDir), timeout: 5000 },
        { type: 'command', command: relocatedCommand('hook-handler.cjs', 'pre-bash', homeDir), timeout },
      ],
    },
  ];
}

function settingsReconcilerHook(options = {}) {
  const opts = installerOptions(options);
  return { type: 'command', command: relocatedCommand('settings-reconciler.cjs', '', opts.homeDir || homedir()), timeout: 5000 };
}

function isGeneratedEnforcementGroup(group) {
  return Boolean(group?.hooks?.some((hook) => {
    const command = String(hook?.command || '');
    return command.includes('hive-composition-gate.cjs') ||
      command.includes('role-enforcement.cjs') ||
      command.includes('enforcement.cjs') ||
      command.includes('settings-reconciler.cjs') ||
      (command.includes('hook-handler.cjs') && /\b(permission-guard|enforce-plan|pre-bash)\b/.test(command));
  }));
}

function hasHookCommand(group, command) {
  return Boolean(group?.hooks?.some((hook) => hook?.type === 'command' && hook.command === command));
}

function ensureCommandInFirstGroup(hooks, event, hook) {
  const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
  if (groups.some((group) => hasHookCommand(group, hook.command))) {
    hooks[event] = groups;
    return;
  }
  if (groups.length === 0) {
    hooks[event] = [{ hooks: [hook] }];
    return;
  }
  const [first, ...rest] = groups;
  first.hooks = Array.isArray(first.hooks) ? first.hooks : [];
  first.hooks.push(hook);
  hooks[event] = [first, ...rest];
}

export function mergeUserSettings(settings, options = {}) {
  const opts = installerOptions(options);
  const timeout = Number.isFinite(opts.timeout) ? Number(opts.timeout) : 5000;
  const homeDir = opts.homeDir || homedir();
  const next = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? structuredClone(settings)
    : {};
  if (next.disableAllHooks === true) delete next.disableAllHooks;
  next.hooks = next.hooks && typeof next.hooks === 'object' && !Array.isArray(next.hooks)
    ? next.hooks
    : {};

  const existingPre = Array.isArray(next.hooks.PreToolUse) ? next.hooks.PreToolUse : [];
  next.hooks.PreToolUse = [
    ...relocatedPreToolUseHooks({ timeout, homeDir }),
    ...existingPre.filter((group) => !isGeneratedEnforcementGroup(group)),
  ];

  const reconciler = settingsReconcilerHook({ homeDir });
  const postMatcher = 'Write|Edit|MultiEdit|mcp__filesystem__write_file|mcp__filesystem__edit_file';
  const postGroups = Array.isArray(next.hooks.PostToolUse) ? next.hooks.PostToolUse : [];
  if (!postGroups.some((group) => hasHookCommand(group, reconciler.command))) {
    next.hooks.PostToolUse = [{ matcher: postMatcher, hooks: [reconciler] }, ...postGroups];
  } else {
    next.hooks.PostToolUse = postGroups;
  }
  ensureCommandInFirstGroup(next.hooks, 'SessionStart', reconciler);
  ensureCommandInFirstGroup(next.hooks, 'Stop', reconciler);
  return next;
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeJsonAtomic(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, filePath);
}

export async function copyEngineFiles(projectRoot, binDir, options = {}) {
  const platform = options.platform || process.platform;
  const chmodFile = options.chmodFile || chmod;
  mkdirSync(binDir, { recursive: true });
  for (const [sourceRel, targetName] of ENGINE_FILES) {
    const source = join(projectRoot, sourceRel);
    if (!existsSync(source)) throw new Error(`Missing engine source: ${sourceRel}`);
    const target = join(binDir, targetName);
    copyFileSync(source, target);
    if (platform !== 'win32') {
      await chmodFile(target, targetName.endsWith('.json') ? 0o600 : 0o700);
    }
  }
  const versionPath = join(binDir, '.version');
  writeFileSync(versionPath, JSON.stringify({
    installedAt: new Date().toISOString(),
    source: projectRoot,
    files: ENGINE_FILES.map(([, target]) => target),
  }, null, 2) + '\n', { mode: 0o600 });
  if (platform !== 'win32') await chmodFile(versionPath, 0o600);
}

async function askReadline(question, source) {
  if (source === 'tty') {
    const ttyIn = createReadStream('/dev/tty');
    const ttyOut = createWriteStream('/dev/tty');
    const rl = readline.createInterface({ input: ttyIn, output: ttyOut });
    return new Promise((resolveAnswer) => {
      const finish = (answer = '') => {
        rl.close();
        ttyIn.destroy();
        ttyOut.destroy();
        resolveAnswer(answer);
      };
      ttyIn.on('error', () => finish(''));
      ttyOut.on('error', () => finish(''));
      rl.question(question, finish);
    });
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveAnswer) => {
    rl.question(question, (answer) => {
      rl.close();
      resolveAnswer(answer);
    });
  });
}

export async function portableConfirm(question, options = {}) {
  if (options.yes === true) return true;
  const platform = options.platform || process.platform;
  const ttyAvailable = options.ttyAvailable ?? (platform !== 'win32' && existsSync('/dev/tty'));
  const stdinIsTTY = options.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const ask = options.ask || askReadline;
  const confirmText = options.confirmText || /^(y|yes)$/i;

  if (platform !== 'win32' && ttyAvailable) {
    const answer = (await ask(question, 'tty')).trim();
    return confirmText instanceof RegExp ? confirmText.test(answer) : answer === confirmText;
  }

  if (stdinIsTTY) {
    const answer = (await ask(question, 'stdin')).trim();
    return confirmText instanceof RegExp ? confirmText.test(answer) : answer === confirmText;
  }

  process.stderr.write('[hive-flow] No interactive TTY available — rerun with --yes for non-interactive install.\n');
  return false;
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function installRelocatedEnforcement(options = {}) {
  const projectRoot = resolve(options.projectRoot || process.env.HIVE_FLOW_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || repoRoot());
  const homeDir = resolve(options.homeDir || homedir());
  const binDir = resolve(options.binDir || join(homeDir, '.hive-flow', 'enforcement', 'bin'));
  const userSettingsPath = resolve(options.userSettingsPath || join(homeDir, '.claude', 'settings.json'));
  const timeout = Number.isFinite(options.timeout) ? Number(options.timeout) : 5000;
  const shouldCopyEngine = options.hooksOnly !== true;
  const shouldWriteHooks = options.engineOnly !== true;

  if (shouldCopyEngine) await copyEngineFiles(projectRoot, binDir, options);
  if (shouldWriteHooks) {
    const current = readJson(userSettingsPath);
    const merged = mergeUserSettings(current, { timeout, homeDir });
    writeJsonAtomic(userSettingsPath, merged);
  }
  return { projectRoot, binDir, userSettingsPath };
}

async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const yes = argv.includes('--yes');
  const engineOnly = argv.includes('--engine-only');
  const hooksOnly = argv.includes('--hooks-only');
  const keypairOnly = argv.includes('--keypair-only');
  const projectRoot = argValue(argv, '--project-root') || process.env.HIVE_FLOW_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || repoRoot();
  const homeDir = argValue(argv, '--home') || homedir();
  const userSettingsPath = argValue(argv, '--user-settings') || join(homeDir, '.claude', 'settings.json');
  const binDir = argValue(argv, '--bin') || join(homeDir, '.hive-flow', 'enforcement', 'bin');

  if (dryRun) {
    const current = readJson(userSettingsPath);
    process.stdout.write(JSON.stringify(mergeUserSettings(current, { homeDir }), null, 2) + '\n');
    return;
  }

  const confirmed = await portableConfirm(`Type INSTALL HIVE FLOW ENFORCEMENT to install user-level hooks for ${resolve(projectRoot)}: `, {
    yes,
    confirmText: 'INSTALL HIVE FLOW ENFORCEMENT',
  });
  if (!confirmed) {
    process.stderr.write('[hive-flow] Enforcement install cancelled.\n');
    process.exitCode = 1;
    return;
  }

  if (keypairOnly) {
    process.stdout.write('[hive-flow] Keypair enrollment is handled by the compiled Permission Guard setup. Run: hive-flow setup permission-guard setup\n');
    return;
  }

  if (yes) {
    process.stdout.write('[hive-flow] Override keypair not enrolled in --yes mode. Run: hive-flow install --keypair-only\n');
  }

  const result = await installRelocatedEnforcement({ projectRoot, homeDir, userSettingsPath, binDir, engineOnly, hooksOnly });
  process.stdout.write(`[hive-flow] Installed enforcement engine: ${result.binDir}\n`);
  process.stdout.write(`[hive-flow] Updated user trigger: ${result.userSettingsPath}\n`);
  process.stdout.write('[hive-flow] Project hooks were not removed; verify user-level enforcement before cleanup.\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
