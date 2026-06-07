import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { portableConfirm } from './portable-prompt.js';
import { setupOverride } from '../permission-guard/biometric-override.js';

export const ENGINE_SOURCE_FILES = [
  ['.claude/helpers/hive-composition-gate.cjs', 'hive-composition-gate.cjs'],
  ['.claude/helpers/role-enforcement.cjs', 'role-enforcement.cjs'],
  ['.claude/helpers/enforcement.cjs', 'enforcement.cjs'],
  ['.claude/helpers/hook-handler.cjs', 'hook-handler.cjs'],
  ['.claude/helpers/settings-reconciler.cjs', 'settings-reconciler.cjs'],
  ['.claude/helpers/provider-tracker.cjs', 'provider-tracker.cjs'],
  ['.claude/helpers/session-id.cjs', 'session-id.cjs'],
  ['v3/@hive-flow/cli/src/permission-guard/protected-paths.cjs', 'protected-paths.cjs'],
  ['v3/@hive-flow/cli/src/permission-guard/protected-paths.policy.json', 'protected-paths.policy.json'],
] as const;

export const ENGINE_TARGET_FILES = ENGINE_SOURCE_FILES.map(([, target]) => target);

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

interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookCommand[];
}

export interface InstallerSettingsOptions {
  homeDir?: string;
  timeout?: number;
}

export interface CopyEngineOptions {
  platform?: NodeJS.Platform;
  chmodFile?: (target: string, mode: number) => Promise<void>;
}

export interface InstallRelocatedOptions extends InstallerSettingsOptions, CopyEngineOptions {
  projectRoot?: string;
  binDir?: string;
  userSettingsPath?: string;
  yes?: boolean;
  engineOnly?: boolean;
  hooksOnly?: boolean;
  setupKeypair?: boolean;
  confirmText?: string;
}

export function resolveEnforcementBinDir(homeDir = homedir()): string {
  return path.join(homeDir, '.hive-flow', 'enforcement', 'bin');
}

export function buildRelocatedCommand(helper: string, options: InstallerSettingsOptions & { args?: string } = {}): string {
  const binDir = resolve(options.homeDir ? resolveEnforcementBinDir(options.homeDir) : resolveEnforcementBinDir());
  return `node "${path.join(binDir, helper)}"${options.args ? ` ${options.args}` : ''}`;
}

function commandHook(command: string, timeout: number): HookCommand {
  return { type: 'command', command, timeout };
}

export function relocatedPreToolUseHooks(options: InstallerSettingsOptions = {}): HookGroup[] {
  const timeout = Number.isFinite(options.timeout) ? Number(options.timeout) : 5000;
  return [
    {
      matcher: 'Task',
      hooks: [
        commandHook(buildRelocatedCommand('hive-composition-gate.cjs', options), 5000),
      ],
    },
    {
      matcher: 'mcp__hive-flow__agent_spawn|mcp__hive-flow__queen_spawn_worker',
      hooks: [
        commandHook(buildRelocatedCommand('role-enforcement.cjs', options), 3000),
        commandHook(buildRelocatedCommand('enforcement.cjs', options), 5000),
      ],
    },
    {
      matcher: GUARDED_TOOL_MATCHER,
      hooks: [
        commandHook(buildRelocatedCommand('role-enforcement.cjs', options), 3000),
        commandHook(buildRelocatedCommand('enforcement.cjs', options), 5000),
        commandHook(buildRelocatedCommand('hook-handler.cjs', { ...options, args: 'permission-guard' }), 15000),
        commandHook(buildRelocatedCommand('hook-handler.cjs', { ...options, args: 'enforce-plan' }), 5000),
        commandHook(buildRelocatedCommand('hook-handler.cjs', { ...options, args: 'pre-bash' }), timeout),
      ],
    },
  ];
}

function settingsReconcilerHook(options: InstallerSettingsOptions = {}): HookCommand {
  return commandHook(buildRelocatedCommand('settings-reconciler.cjs', options), 5000);
}

function isGeneratedEnforcementGroup(group: HookGroup): boolean {
  return Boolean(group?.hooks?.some((hook) => {
    const command = String(hook?.command || '');
    return command.includes('hive-composition-gate.cjs') ||
      command.includes('role-enforcement.cjs') ||
      command.includes('enforcement.cjs') ||
      command.includes('settings-reconciler.cjs') ||
      (command.includes('hook-handler.cjs') && /\b(permission-guard|enforce-plan|pre-bash)\b/.test(command));
  }));
}

function hasHookCommand(group: HookGroup, command: string): boolean {
  return Boolean(group?.hooks?.some((hook) => hook?.type === 'command' && hook.command === command));
}

function ensureCommandInFirstGroup(hooks: Record<string, HookGroup[]>, event: string, hook: HookCommand): void {
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

export function mergeUserSettings(settings: unknown, options: InstallerSettingsOptions = {}): Record<string, any> {
  const next: Record<string, any> = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? structuredClone(settings)
    : {};
  if (next.disableAllHooks === true) delete next.disableAllHooks;
  next.hooks = next.hooks && typeof next.hooks === 'object' && !Array.isArray(next.hooks)
    ? next.hooks
    : {};

  const existingPre = Array.isArray(next.hooks.PreToolUse) ? next.hooks.PreToolUse : [];
  next.hooks.PreToolUse = [
    ...relocatedPreToolUseHooks(options),
    ...existingPre.filter((group: HookGroup) => !isGeneratedEnforcementGroup(group)),
  ];

  const reconciler = settingsReconcilerHook(options);
  const postMatcher = 'Write|Edit|MultiEdit|mcp__filesystem__write_file|mcp__filesystem__edit_file';
  const postGroups = Array.isArray(next.hooks.PostToolUse) ? next.hooks.PostToolUse : [];
  if (!postGroups.some((group: HookGroup) => hasHookCommand(group, reconciler.command))) {
    next.hooks.PostToolUse = [{ matcher: postMatcher, hooks: [reconciler] }, ...postGroups];
  } else {
    next.hooks.PostToolUse = postGroups;
  }
  ensureCommandInFirstGroup(next.hooks, 'SessionStart', reconciler);
  ensureCommandInFirstGroup(next.hooks, 'Stop', reconciler);
  return next;
}

function readJson(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, filePath);
}

export async function copyEngineFiles(projectRoot: string, binDir: string, options: CopyEngineOptions = {}): Promise<void> {
  const platform = options.platform || process.platform;
  const chmodFile = options.chmodFile || chmod;
  mkdirSync(binDir, { recursive: true });
  for (const [sourceRel, targetName] of ENGINE_SOURCE_FILES) {
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
    files: ENGINE_TARGET_FILES,
  }, null, 2) + '\n', { mode: 0o600 });
  if (platform !== 'win32') await chmodFile(versionPath, 0o600);
}

export async function installRelocatedEnforcement(options: InstallRelocatedOptions = {}) {
  const projectRoot = resolve(options.projectRoot || process.env.HIVE_FLOW_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const homeDir = resolve(options.homeDir || homedir());
  const binDir = resolve(options.binDir || resolveEnforcementBinDir(homeDir));
  const userSettingsPath = resolve(options.userSettingsPath || join(homeDir, '.claude', 'settings.json'));
  const shouldCopyEngine = options.hooksOnly !== true;
  const shouldWriteHooks = options.engineOnly !== true;

  const confirmed = await portableConfirm(
    `Type INSTALL HIVE FLOW ENFORCEMENT to install user-level hooks for ${projectRoot}: `,
    {
      yes: options.yes,
      platform: options.platform,
      confirmText: options.confirmText || 'INSTALL HIVE FLOW ENFORCEMENT',
    }
  );
  if (!confirmed) {
    throw new Error('[hive-flow] Enforcement install denied or cancelled.');
  }

  if (shouldCopyEngine) {
    await copyEngineFiles(projectRoot, binDir, options);
  }
  if (shouldWriteHooks) {
    const merged = mergeUserSettings(readJson(userSettingsPath), { homeDir, timeout: options.timeout });
    writeJsonAtomic(userSettingsPath, merged);
  }

  const messages: string[] = [];
  if (options.setupKeypair === true) {
    if (options.yes === true) {
      messages.push('[hive-flow] Override keypair not enrolled in --yes mode. Run: hive-flow install --keypair-only');
    } else {
      await setupOverride();
    }
  }

  return { projectRoot, binDir, userSettingsPath, messages };
}
