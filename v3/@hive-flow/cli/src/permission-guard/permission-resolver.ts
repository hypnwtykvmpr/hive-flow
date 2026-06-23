import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHiveHome, sessionKeyFor } from '../shared/index.js';
import { DEFAULT_PERMISSION_CONFIG } from './default-config.js';
import { resolveProjectRoot as resolveProtectedProjectRoot } from './protected-paths.js';
import type {
  BashPatternEntry,
  NotificationConfig,
  PermissionConfig,
} from './types.js';

type Env = Record<string, string | undefined>;
type ArrayConfigKey =
  | 'always_allow_tools'
  | 'always_allow_tool_prefixes'
  | 'mcp_deny_tool_prefixes'
  | 'mcp_escalate_tool_prefixes'
  | 'always_allow_bash_patterns'
  | 'always_deny_bash_patterns'
  | 'jury_escalation_bash_patterns'
  | 'allowed_write_paths';

const ARRAY_CONFIG_KEYS: readonly ArrayConfigKey[] = [
  'always_allow_tools',
  'always_allow_tool_prefixes',
  'mcp_deny_tool_prefixes',
  'mcp_escalate_tool_prefixes',
  'always_allow_bash_patterns',
  'always_deny_bash_patterns',
  'jury_escalation_bash_patterns',
  'allowed_write_paths',
];

export interface PermissionLayerPaths {
  hiveHome: string;
  projectRoot: string;
  sessionKey: string;
  globalConfigPath: string;
  learnedRulesPath: string;
  projectConfigPath: string;
  sessionGrantsPath: string;
}

export interface PermissionResolverOptions {
  env?: Env;
  cwd?: string;
  sessionInput?: unknown;
  globalConfigPath?: string;
  homeDir?: string;
}

interface CacheEntry {
  signature: string;
  config: PermissionConfig;
}

let cache: CacheEntry | null = null;

function stableEntryKey(value: unknown): string {
  return JSON.stringify(value);
}

function appendUnique<T>(base: T[], additions: T[]): T[] {
  const result = [...base];
  const seen = new Set(result.map(stableEntryKey));
  for (const entry of additions) {
    const key = stableEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
    ? [...value]
    : undefined;
}

function bashPatternArray(value: unknown): BashPatternEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: BashPatternEntry[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      result.push(entry);
      continue;
    }
    if (!isObject(entry)) return undefined;
    if (typeof entry.pattern === 'string') {
      result.push({
        pattern: entry.pattern,
        feedback: typeof entry.feedback === 'string' ? entry.feedback : '',
      });
      continue;
    }
    if (typeof entry._comment === 'string') {
      result.push({ _comment: entry._comment });
      continue;
    }
    return undefined;
  }
  return result;
}

function notifications(value: unknown): Partial<NotificationConfig> | undefined {
  if (!isObject(value)) return undefined;
  const patch: Partial<NotificationConfig> = {};
  if (typeof value.enabled === 'boolean') patch.enabled = value.enabled;
  if (typeof value.on_escalation === 'boolean') patch.on_escalation = value.on_escalation;
  if (typeof value.on_deny === 'boolean') patch.on_deny = value.on_deny;
  return Object.keys(patch).length ? patch : undefined;
}

function permissionPatch(value: unknown): Partial<PermissionConfig> {
  if (!isObject(value)) return {};
  const input = isObject(value.config) ? value.config : value;
  const patch: Partial<PermissionConfig> = {};

  for (const key of ARRAY_CONFIG_KEYS) {
    const raw = input[key];
    if (key === 'always_allow_bash_patterns' ||
        key === 'always_deny_bash_patterns' ||
        key === 'jury_escalation_bash_patterns') {
      const patterns = bashPatternArray(raw);
      if (patterns) patch[key] = patterns;
    } else {
      const strings = stringArray(raw);
      if (strings) patch[key] = strings;
    }
  }

  if (input.mcp_default_policy === 'allow' ||
      input.mcp_default_policy === 'deny' ||
      input.mcp_default_policy === 'escalate') {
    patch.mcp_default_policy = input.mcp_default_policy;
  }
  if (typeof input.allow_paths_outside_working_directory === 'boolean') {
    patch.allow_paths_outside_working_directory = input.allow_paths_outside_working_directory;
  }
  if (typeof input.log_file === 'string') {
    patch.log_file = input.log_file;
  }
  if (typeof input.llm_jury_budget_max_calls === 'number') {
    patch.llm_jury_budget_max_calls = input.llm_jury_budget_max_calls;
  }
  if (typeof input.llm_jury_budget_window_ms === 'number') {
    patch.llm_jury_budget_window_ms = input.llm_jury_budget_window_ms;
  }
  if (typeof input.llm_jury_budget_dir === 'string') {
    patch.llm_jury_budget_dir = input.llm_jury_budget_dir;
  }
  if (typeof input.disable_vote_learner === 'boolean') {
    patch.disable_vote_learner = input.disable_vote_learner;
  }
  const notify = notifications(input.notifications);
  if (notify) patch.notifications = notify as NotificationConfig;

  return patch;
}

function readJsonPatch(path: string): Partial<PermissionConfig> {
  try {
    if (!existsSync(path)) return {};
    return permissionPatch(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return {};
  }
}

function readLearnedPatches(path: string): Partial<PermissionConfig>[] {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        try {
          return permissionPatch(JSON.parse(line));
        } catch {
          return {};
        }
      })
      .filter(patch => Object.keys(patch).length > 0);
  } catch {
    return [];
  }
}

function fileSignature(path: string): string {
  try {
    const stat = statSync(path);
    return `${path}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${path}:missing`;
  }
}

export function resolvePermissionLayerPaths(options: PermissionResolverOptions = {}): PermissionLayerPaths {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const hiveHome = resolveHiveHome(env as NodeJS.ProcessEnv, { homeDir: options.homeDir }).home;
  const projectRoot = resolveProtectedProjectRoot({ env, cwd });
  const sessionKey = sessionKeyFor(options.sessionInput, env as NodeJS.ProcessEnv);
  return {
    hiveHome,
    projectRoot,
    sessionKey,
    globalConfigPath: options.globalConfigPath ?? join(hiveHome, 'permission-guard', 'config.json'),
    learnedRulesPath: join(hiveHome, 'permission-guard', 'learned-rules.jsonl'),
    projectConfigPath: join(projectRoot, '.hive-flow', 'permissions.json'),
    sessionGrantsPath: join(hiveHome, 'permission-guard', 'sessions', sessionKey, 'grants.json'),
  };
}

export function mergePermissionConfigLayers(layers: readonly Partial<PermissionConfig>[]): PermissionConfig {
  let config: PermissionConfig = {
    ...DEFAULT_PERMISSION_CONFIG,
    notifications: { ...DEFAULT_PERMISSION_CONFIG.notifications },
    always_allow_tools: [...DEFAULT_PERMISSION_CONFIG.always_allow_tools],
    always_allow_tool_prefixes: [...DEFAULT_PERMISSION_CONFIG.always_allow_tool_prefixes],
    mcp_deny_tool_prefixes: [...DEFAULT_PERMISSION_CONFIG.mcp_deny_tool_prefixes],
    mcp_escalate_tool_prefixes: [...DEFAULT_PERMISSION_CONFIG.mcp_escalate_tool_prefixes],
    always_allow_bash_patterns: [...DEFAULT_PERMISSION_CONFIG.always_allow_bash_patterns],
    always_deny_bash_patterns: [...DEFAULT_PERMISSION_CONFIG.always_deny_bash_patterns],
    jury_escalation_bash_patterns: [...DEFAULT_PERMISSION_CONFIG.jury_escalation_bash_patterns],
    allowed_write_paths: [...DEFAULT_PERMISSION_CONFIG.allowed_write_paths],
  };

  for (const rawLayer of layers) {
    const layer = permissionPatch(rawLayer);
    config = {
      ...config,
      ...(layer.mcp_default_policy !== undefined ? { mcp_default_policy: layer.mcp_default_policy } : {}),
      ...(layer.allow_paths_outside_working_directory !== undefined
        ? { allow_paths_outside_working_directory: layer.allow_paths_outside_working_directory }
        : {}),
      ...(layer.log_file !== undefined ? { log_file: layer.log_file } : {}),
      ...(layer.llm_jury_budget_max_calls !== undefined ? { llm_jury_budget_max_calls: layer.llm_jury_budget_max_calls } : {}),
      ...(layer.llm_jury_budget_window_ms !== undefined ? { llm_jury_budget_window_ms: layer.llm_jury_budget_window_ms } : {}),
      ...(layer.llm_jury_budget_dir !== undefined ? { llm_jury_budget_dir: layer.llm_jury_budget_dir } : {}),
      ...(layer.disable_vote_learner !== undefined ? { disable_vote_learner: layer.disable_vote_learner } : {}),
      notifications: {
        ...config.notifications,
        ...(layer.notifications ?? {}),
      },
    };

    for (const key of ARRAY_CONFIG_KEYS) {
      const additions = layer[key];
      if (Array.isArray(additions)) {
        config[key] = appendUnique(config[key] as never[], additions as never[]) as never;
      }
    }
  }

  return config;
}

export function loadLayeredPermissionConfig(options: PermissionResolverOptions = {}): PermissionConfig {
  const paths = resolvePermissionLayerPaths(options);
  const signature = [
    paths.projectRoot,
    paths.sessionKey,
    paths.globalConfigPath,
    paths.learnedRulesPath,
    paths.projectConfigPath,
    paths.sessionGrantsPath,
    fileSignature(paths.globalConfigPath),
    fileSignature(paths.learnedRulesPath),
    fileSignature(paths.projectConfigPath),
    fileSignature(paths.sessionGrantsPath),
  ].join('\0');

  if (cache && cache.signature === signature) return cache.config;

  const layers: Partial<PermissionConfig>[] = [
    readJsonPatch(paths.globalConfigPath),
    ...readLearnedPatches(paths.learnedRulesPath),
    readJsonPatch(paths.projectConfigPath),
    readJsonPatch(paths.sessionGrantsPath),
  ];
  const config = mergePermissionConfigLayers(layers);
  cache = { signature, config };
  return config;
}

export function resetPermissionResolverCache(): void {
  cache = null;
}
