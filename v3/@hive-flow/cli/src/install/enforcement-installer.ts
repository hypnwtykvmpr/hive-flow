import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portableConfirm } from './portable-prompt.js';
import { setupOverride } from '../permission-guard/biometric-override.js';

export const ENGINE_SOURCE_FILES = [
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
] as const;

export const ENGINE_TARGET_FILES = ENGINE_SOURCE_FILES.map(([, target]) => target);
export const ENGINE_MANIFEST_FILE = '.engine-manifest.json';

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

function isDeadModifyHookCommand(command: string): boolean {
  return /\bhive-flow\s+hooks\s+modify-(?:bash|file)\b/.test(command) ||
    /\bcli\.js\s+hooks\s+modify-(?:bash|file)\b/.test(command);
}

function isSessionEndCommand(command: string): boolean {
  return /\bhooks\s+session-end\b/.test(command) ||
    /\bhook-handler\.cjs\s+session-end\b/.test(command);
}

function isSettingsReconcilerCommand(command: string): boolean {
  return command.includes('settings-reconciler.cjs');
}

function removeHookCommands(
  groups: HookGroup[],
  predicate: (command: string) => boolean,
): { groups: HookGroup[]; removed: HookCommand[] } {
  const removed: HookCommand[] = [];
  const nextGroups: HookGroup[] = [];
  for (const group of groups) {
    const keptHooks: HookCommand[] = [];
    for (const hook of group.hooks || []) {
      const command = typeof hook.command === 'string' ? hook.command : '';
      if (command && predicate(command)) {
        removed.push(hook);
      } else {
        keptHooks.push(hook);
      }
    }
    if (keptHooks.length > 0) {
      nextGroups.push({ ...group, hooks: keptHooks });
    }
  }
  return { groups: nextGroups, removed };
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

function ensureHooksInFirstGroup(hooks: Record<string, HookGroup[]>, event: string, hookList: HookCommand[]): void {
  for (const hook of hookList) {
    ensureCommandInFirstGroup(hooks, event, hook);
  }
}

function cleanupGlobalHookCruft(hooks: Record<string, HookGroup[]>): void {
  for (const event of Object.keys(hooks)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = removeHookCommands(groups, isDeadModifyHookCommand).groups;
  }

  const stopGroups = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  const stopCleanup = removeHookCommands(stopGroups, isSessionEndCommand);
  hooks.Stop = stopCleanup.groups;
  ensureHooksInFirstGroup(hooks, 'SessionEnd', stopCleanup.removed);
}

export function mergeUserSettings(settings: unknown, options: InstallerSettingsOptions = {}): Record<string, any> {
  const next: Record<string, any> = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? structuredClone(settings)
    : {};
  if (next.disableAllHooks === true) delete next.disableAllHooks;
  next.hooks = next.hooks && typeof next.hooks === 'object' && !Array.isArray(next.hooks)
    ? next.hooks
    : {};

  cleanupGlobalHookCruft(next.hooks);

  const existingPre = Array.isArray(next.hooks.PreToolUse) ? next.hooks.PreToolUse : [];
  next.hooks.PreToolUse = [
    ...relocatedPreToolUseHooks(options),
    ...existingPre.filter((group: HookGroup) => !isGeneratedEnforcementGroup(group)),
  ];

  const reconciler = settingsReconcilerHook(options);
  const postMatcher = 'Write|Edit|MultiEdit|mcp__filesystem__write_file|mcp__filesystem__edit_file';
  const postGroups = Array.isArray(next.hooks.PostToolUse) ? next.hooks.PostToolUse : [];
  next.hooks.PostToolUse = [
    { matcher: postMatcher, hooks: [reconciler] },
    ...removeHookCommands(postGroups, isSettingsReconcilerCommand).groups,
  ];

  next.hooks.SessionStart = removeHookCommands(
    Array.isArray(next.hooks.SessionStart) ? next.hooks.SessionStart : [],
    isSettingsReconcilerCommand,
  ).groups;
  next.hooks.Stop = removeHookCommands(
    Array.isArray(next.hooks.Stop) ? next.hooks.Stop : [],
    isSettingsReconcilerCommand,
  ).groups;
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

function backupTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function writeJsonAtomicIfChanged(filePath: string, data: unknown): void {
  const nextContent = `${JSON.stringify(data, null, 2)}\n`;
  let previousContent: string | null = null;
  try {
    previousContent = readFileSync(filePath, 'utf8');
  } catch {
    previousContent = null;
  }
  if (previousContent === nextContent) return;
  if (previousContent !== null) {
    writeFileSync(`${filePath}.hive-flow-backup-${backupTimestamp()}`, previousContent, { mode: 0o600 });
  }
  writeJsonAtomic(filePath, data);
}

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function walkAncestorDirs(start: string): string[] {
  const dirs: string[] = [];
  let current = resolve(start);
  for (let i = 0; i < 12; i++) {
    dirs.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

function sourceCandidates(projectRoot: string, sourceRel: string): string[] {
  const baseName = path.basename(sourceRel);
  const candidates = [join(projectRoot, sourceRel)];
  if (sourceRel.startsWith('v3/@hive-flow/cli/src/permission-guard/')) {
    candidates.push(
      join(projectRoot, 'src', 'permission-guard', baseName),
      join(projectRoot, 'dist', 'src', 'permission-guard', baseName),
      join(projectRoot, 'v3', '@hive-flow', 'cli', 'dist', 'src', 'permission-guard', baseName),
    );
  }
  if (sourceRel.startsWith('.claude/helpers/')) {
    candidates.push(join(projectRoot, '.claude', 'helpers', baseName));
  }
  return [...new Set(candidates.map((candidate) => resolve(candidate)))];
}

function resolveEngineSourcePath(projectRoot: string, sourceRel: string): string | null {
  for (const candidate of sourceCandidates(projectRoot, sourceRel)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function writeInstalledEngineManifest(projectRoot: string, binDir: string): void {
  writeFileSync(join(binDir, ENGINE_MANIFEST_FILE), JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: projectRoot,
    files: ENGINE_TARGET_FILES.map((name) => ({
      name,
      sha256: sha256(join(binDir, name)),
    })),
  }, null, 2) + '\n', { mode: 0o600 });
}

function hasEngineSources(projectRoot: string): boolean {
  return ENGINE_SOURCE_FILES.every(([sourceRel]) => resolveEngineSourcePath(projectRoot, sourceRel));
}

export function resolveEngineSourceRoot(candidateRoot?: string): string {
  const candidates = [
    candidateRoot,
    process.env.HIVE_FLOW_PROJECT_ROOT,
    process.env.CLAUDE_PROJECT_DIR,
    process.cwd(),
    ...walkAncestorDirs(moduleDir()),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);

  for (const candidate of candidates) {
    const root = resolve(candidate);
    if (hasEngineSources(root)) return root;
  }

  throw new Error('Missing enforcement engine sources: could not resolve Hive Flow package/project root');
}

export async function copyEngineFiles(projectRoot: string, binDir: string, options: CopyEngineOptions = {}): Promise<void> {
  const platform = options.platform || process.platform;
  const chmodFile = options.chmodFile || chmod;
  mkdirSync(binDir, { recursive: true });
  for (const [sourceRel, targetName] of ENGINE_SOURCE_FILES) {
    const source = resolveEngineSourcePath(projectRoot, sourceRel);
    if (!source) throw new Error(`Missing engine source: ${sourceRel}`);
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
  writeInstalledEngineManifest(projectRoot, binDir);
  if (platform !== 'win32') await chmodFile(versionPath, 0o600);
  if (platform !== 'win32') await chmodFile(join(binDir, ENGINE_MANIFEST_FILE), 0o600);
}

export async function installRelocatedEnforcement(options: InstallRelocatedOptions = {}) {
  const projectRoot = resolveEngineSourceRoot(options.projectRoot);
  const homeDir = resolve(options.homeDir || homedir());
  const binDir = resolve(options.binDir || resolveEnforcementBinDir(homeDir));
  const userSettingsPath = resolve(options.userSettingsPath || join(homeDir, '.claude', 'settings.json'));
  const shouldCopyEngine = options.hooksOnly !== true;
  const shouldWriteHooks = options.engineOnly !== true;

  const confirmed = await portableConfirm(
    `Type INSTALL HIVE FLOW ENFORCEMENT to install user-level hooks for ${projectRoot}: `,
    {
      yes: options.yes,
      headlessDefault: true,
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
    writeJsonAtomicIfChanged(userSettingsPath, merged);
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
