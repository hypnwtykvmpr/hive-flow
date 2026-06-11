/**
 * V3 CLI Setup Command
 * Global environment setup for Hive Flow
 *
 * Created by Hive Flow
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  setupOverride,
  requestOverride,
  revokeOverride,
  overrideStatus,
} from '../permission-guard/biometric-override.js';

// ---------------------------------------------------------------------------
// §7 Agent-integration setup surface (runbook §7)
// ---------------------------------------------------------------------------
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { withSetupLock } from '../integrations/lockfile.js';
import {
  writeStableLauncher,
  resolveLauncherPath,
  resolveStatuslineLauncherPath,
  resolveStatuslineRuntimeEntrypoint,
  writeStableStatuslineLauncher,
} from '../integrations/launcher.js';
import { statePathFor } from '../integrations/state.js';
import { ADAPTERS, type AdapterId, claudeCodeStatuslineAdapter } from '../integrations/adapters/index.js';
import { previousStatusLineCommandForLauncher } from '../integrations/adapters/claude-code-statusline.js';
import { loadAdapter, isKnownTarget } from '../integrations/adapter-registry.js';
import { diagnoseConnectors } from '../integrations/diagnose.js';
import {
  probeCredentialHolderStatus,
  type CredentialHolderProbeStatus,
} from '../credential-store/strict-api-provider.js';
import { initializeCredentialVault } from '../credential-store/holder-runtime.js';
import {
  buildAndInstallNativeHelpers,
  ensureHelperBinOnPath,
} from '../install/native-helper-installer.js';
import { DEFAULT_MAX_AGENTS } from '@hive-flow/shared/core/config/defaults';

async function importConnectorAdapters(): Promise<void> {
  await Promise.all([
    import('../integrations/adapters/claude-code-connector.js'),
    import('../integrations/adapters/codex-connector.js'),
    import('../integrations/adapters/gemini-connector.js'),
    import('../integrations/adapters/forgecode-connector.js'),
    import('../integrations/adapters/cursor-cli-connector.js'),
    import('../integrations/adapters/qwen-connector.js'),
    import('../integrations/adapters/opencode-connector.js'),
  ]);
}

// ---------------------------------------------------------------------------
// Feature plumbing (§10 — Phase 7)
// ---------------------------------------------------------------------------

/** Setup features that can be selected via --features. */
type SetupFeature = 'mcp' | 'statusline' | 'connector';

/**
 * Parse the `--features` flag into a Set of valid features.
 * Behavior:
 *  - When `raw` is undefined: defaults to {'mcp', 'statusline'} (both features).
 *  - When `raw` is a comma-separated string: includes each valid token ('mcp' | 'statusline').
 *  - When all tokens are unrecognized (empty result set): falls back to {'mcp'} for safety.
 */
function parseFeatures(raw: unknown): Set<SetupFeature> {
  const value = String(raw ?? 'mcp,statusline');
  const out = new Set<SetupFeature>();
  for (const part of value.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (part === 'mcp' || part === 'statusline' || part === 'connector') out.add(part);
  }
  if (out.size === 0) out.add('mcp');
  return out;
}

interface ProviderSetupStatus {
  provider: 'openrouter' | 'gemini-cli';
  configured: boolean;
  checks: Record<string, boolean | string | undefined>;
  action?: string;
}

interface ProviderSetupReport {
  providers: {
    openrouter: ProviderSetupStatus;
    gemini: ProviderSetupStatus;
  };
}

type VersionRunner = (bin: string) => { ok: boolean; version?: string };

function defaultVersionRunner(bin: string): { ok: boolean; version?: string } {
  const result = spawnSync('/usr/bin/env', [bin, '--version'], {
    encoding: 'utf8',
    timeout: 5000,
    env: process.env,
  });
  const version = String(result.stdout || result.stderr || '').trim() || undefined;
  return { ok: result.status === 0, version };
}

function readProjectConfig(projectRoot: string): Record<string, unknown> {
  try {
    const path = join(projectRoot, '.hive-flow', 'config.json');
    if (!existsSync(path)) return { values: {}, scopes: {}, version: '3.0.0' };
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, unknown>
      : { values: {}, scopes: {}, version: '3.0.0' };
  } catch {
    return { values: {}, scopes: {}, version: '3.0.0' };
  }
}

function getObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasOpenRouterHolderConfigReference(projectRoot: string): boolean {
  const config = readProjectConfig(projectRoot);
  const values = getObject(config.values);
  const openrouter = getObject(values?.openrouter) ?? getObject(config.openrouter);
  if (!openrouter) return false;
  const source = typeof openrouter.credentialSource === 'string'
    ? openrouter.credentialSource.trim().toLowerCase()
    : '';
  return source === 'holder:openrouter'
    || source === 'credential-holder:openrouter'
    || source === 'credential-holder';
}

export function inspectProviderSetup(opts: {
  cwd: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  versionRunner?: VersionRunner;
  holderStatus?: CredentialHolderProbeStatus;
}): ProviderSetupReport {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();
  const versionRunner = opts.versionRunner ?? defaultVersionRunner;
  const openrouterEnv = typeof env.OPENROUTER_API_KEY === 'string' && env.OPENROUTER_API_KEY.length > 0;
  const openrouterConfig = hasOpenRouterHolderConfigReference(opts.cwd);
  const openrouterHolder = opts.holderStatus ?? probeCredentialHolderStatus(env);
  const geminiCli = versionRunner('gemini');
  const geminiOauth = existsSync(join(homeDir, '.gemini', 'oauth_creds.json'));
  const geminiApiKey = Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
  const geminiApiKeyEnvName = env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : env.GOOGLE_API_KEY ? 'GOOGLE_API_KEY' : undefined;

  return {
    providers: {
      openrouter: {
        provider: 'openrouter',
        configured: openrouterHolder.available || openrouterConfig,
        checks: {
          credentialHolderAvailable: openrouterHolder.available,
          credentialHolderSocket: openrouterHolder.socketPath,
          configReferencePresent: openrouterConfig,
          legacyEnvPresentIgnored: openrouterEnv,
        },
        action: openrouterHolder.available || openrouterConfig
          ? undefined
          : 'Unlock/start the Hive Flow credential holder and store the OpenRouter key there; OPENROUTER_API_KEY is ignored for strict API providers.',
      },
      gemini: {
        provider: 'gemini-cli',
        configured: geminiCli.ok && (geminiOauth || geminiApiKey),
        checks: {
          cliPresent: geminiCli.ok,
          version: geminiCli.version,
          oauthPresent: geminiOauth,
          apiKeyEnvPresent: geminiApiKey,
          apiKeyEnvName: geminiApiKeyEnvName,
        },
        action: geminiCli.ok && (geminiOauth || geminiApiKey)
          ? undefined
          : 'Run gemini in a terminal and complete Google OAuth, or set GEMINI_API_KEY/GOOGLE_API_KEY.',
      },
    },
  };
}

export function writeProviderCredentialReferences(projectRoot: string, report: ProviderSetupReport): string {
  const dir = join(projectRoot, '.hive-flow');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.json');
  const config = readProjectConfig(projectRoot);
  const values = getObject(config.values) ?? {};

  if (report.providers.openrouter.checks.credentialHolderAvailable
    || report.providers.openrouter.checks.configReferencePresent) {
    values.openrouter = {
      ...(getObject(values.openrouter) ?? {}),
      credentialSource: 'holder:openrouter',
    };
  }

  if (report.providers.gemini.checks.oauthPresent) {
    values.gemini = {
      ...(getObject(values.gemini) ?? {}),
      credentialSource: 'oauth:~/.gemini/oauth_creds.json',
    };
  } else if (report.providers.gemini.checks.apiKeyEnvPresent) {
    const envName = typeof report.providers.gemini.checks.apiKeyEnvName === 'string'
      ? report.providers.gemini.checks.apiKeyEnvName
      : 'GEMINI_API_KEY';
    values.gemini = {
      ...(getObject(values.gemini) ?? {}),
      credentialSource: `env:${envName}`,
    };
  }

  const next = {
    ...config,
    values,
    scopes: getObject(config.scopes) ?? {},
    version: typeof config.version === 'string' ? config.version : '3.0.0',
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
  return path;
}

/** Default global config written to ~/.hive-flow/config.json */
function defaultGlobalConfig(): Record<string, unknown> {
  return {
    version: '3.0.0',
    mode: 'global',
    topology: 'hierarchical-mesh',
    maxAgents: DEFAULT_MAX_AGENTS,
    memory: {
      backend: 'hybrid',
      enableHNSW: true,
    },
    neural: { enabled: true },
    logging: { level: 'info' },
  };
}

/** Ensure a directory exists, return whether it was created. */
function ensureDir(dirPath: string): boolean {
  if (existsSync(dirPath)) return false;
  mkdirSync(dirPath, { recursive: true });
  return true;
}

const globalAction = async (ctx: CommandContext): Promise<CommandResult> => {
  const globalDir = join(homedir(), '.hive-flow');
  const force = ctx.flags.force as boolean;

  output.writeln();
  output.writeln(output.bold('Hive Flow Global Setup'));
  output.writeln(output.dim('Configuring ~/.hive-flow/ for global use'));
  output.writeln();

  // 1. Create directory structure
  const subdirs = ['config', 'data', 'memory', 'logs'];
  const created: string[] = [];
  const existing: string[] = [];

  for (const sub of subdirs) {
    const dirPath = join(globalDir, sub);
    if (ensureDir(dirPath)) {
      created.push(sub);
    } else {
      existing.push(sub);
    }
  }

  if (created.length > 0) {
    output.writeln(output.success(`Created directories: ${created.map(d => `~/.hive-flow/${d}`).join(', ')}`));
  }
  if (existing.length > 0) {
    output.writeln(output.dim(`Already exist: ${existing.map(d => `~/.hive-flow/${d}`).join(', ')}`));
  }

  // 2. Write default config
  const configPath = join(globalDir, 'config.json');
  const configExists = existsSync(configPath);

  if (!configExists || force) {
    writeFileSync(configPath, JSON.stringify(defaultGlobalConfig(), null, 2) + '\n', 'utf8');
    output.writeln(output.success(`${configExists ? 'Overwrote' : 'Created'} ~/.hive-flow/config.json`));
  } else {
    output.writeln(output.dim('Config already exists (use --force to overwrite)'));
  }

  // 3. Show status summary
  output.writeln();
  output.writeln(output.bold('Status'));
  output.writeln(output.dim('─'.repeat(45)));

  output.writeln(`  Global data dir:  ${globalDir}`);

  // Detect project-local vs global mode
  const localConfig = existsSync(join(ctx.cwd, '.hive-flow', 'config.yaml'))
    || existsSync(join(ctx.cwd, 'hive-flow.config.json'));
  output.writeln(`  Project-local:    ${localConfig ? output.success('detected') : output.dim('none')}`);
  output.writeln(`  Active mode:      ${localConfig ? 'project-local' : 'global'}`);

  // Available tools
  const tools: string[] = ['memory', 'hooks', 'swarm', 'agent', 'session', 'neural'];
  output.writeln(`  Global tools:     ${tools.join(', ')}`);

  // Read back config for display
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    output.writeln(`  Topology:         ${cfg.topology ?? 'hierarchical-mesh'}`);
    output.writeln(`  Max agents:       ${cfg.maxAgents ?? DEFAULT_MAX_AGENTS}`);
    output.writeln(`  Memory backend:   ${cfg.memory?.backend ?? 'hybrid'}`);
  } catch {
    // Config read failed — non-critical
  }

  // 4. Next steps
  output.writeln();
  output.writeln(output.bold('Next steps:'));
  output.printList([
    `Run ${output.highlight('hive-flow doctor')} to verify system health`,
    `Run ${output.highlight('hive-flow init')} inside a project for project-local setup`,
    `Run ${output.highlight('hive-flow daemon start')} to start background workers`,
  ]);

  return { success: true, data: { globalDir, created, existing, configExists } };
};

// ---------------------------------------------------------------------------
// Permission-guard subcommands
// ---------------------------------------------------------------------------

const permissionGuardSetupCommand: Command = {
  name: 'setup',
  description: 'One-time Ed25519 keypair generation for Permission Guard (run as human, not LLM)',
  options: [],
  action: async (_ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Permission Guard Setup'));
    output.writeln(output.dim('Generating Ed25519 keypair and storing private key in locked credential store'));
    output.writeln();
    try {
      await setupOverride();
      output.writeln();
      output.writeln(output.success('Permission Guard setup complete.'));
      output.writeln(output.dim('You can now use: hive-flow setup permission-guard override'));
      return { success: true };
    } catch (err) {
      output.writeln(output.error(`Setup failed: ${(err as Error).message}`));
      return { success: false, message: (err as Error).message };
    }
  },
};

const permissionGuardOverrideCommand: Command = {
  name: 'override',
  description: 'Request a 5-minute permission override window (triggers human authentication)',
  options: [],
  action: async (_ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Requesting Permission Override'));
    output.writeln(output.dim('This will trigger your platform credential store authentication...'));
    output.writeln();
    const result = await requestOverride();
    if (result.granted) {
      const expiresAt = new Date(result.expiresAt).toLocaleTimeString();
      output.writeln(output.success(`Override granted — active until ${expiresAt}`));
      return { success: true, data: result };
    } else {
      output.writeln(output.error('Override not granted — authentication failed or cancelled.'));
      return { success: false, message: 'Override not granted' };
    }
  },
};

const permissionGuardRevokeCommand: Command = {
  name: 'revoke',
  description: 'Immediately revoke any active permission override',
  options: [],
  action: async (_ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    revokeOverride();
    return { success: true };
  },
};

const permissionGuardStatusCommand: Command = {
  name: 'status',
  description: 'Show current permission override state (active/expired/none)',
  options: [],
  action: async (_ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Permission Guard Override Status'));
    output.writeln(output.dim('─'.repeat(45)));
    const status = overrideStatus();
    if (status.active && status.expiresAt !== undefined && status.secondsRemaining !== undefined) {
      const expiresAt = new Date(status.expiresAt).toLocaleTimeString();
      const mins = Math.floor(status.secondsRemaining / 60);
      const secs = status.secondsRemaining % 60;
      const remaining = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      output.writeln(`  State:     ${output.success('ACTIVE')}`);
      output.writeln(`  Expires:   ${expiresAt} (${remaining} remaining)`);
    } else if (existsSync(join(homedir(), '.hive-flow', 'permission-guard', 'active-override.json'))) {
      output.writeln(`  State:     ${output.dim('EXPIRED')}`);
    } else {
      output.writeln(`  State:     ${output.dim('NONE')}`);
    }
    output.writeln();
    return { success: true, data: status };
  },
};

const permissionGuardCommand: Command = {
  name: 'permission-guard',
  description: 'Manage cryptographic permission overrides (Ed25519-backed)',
  subcommands: [
    permissionGuardSetupCommand,
    permissionGuardOverrideCommand,
    permissionGuardRevokeCommand,
    permissionGuardStatusCommand,
  ],
  examples: [
    { command: 'hive-flow setup permission-guard setup', description: 'One-time keypair generation' },
    { command: 'hive-flow setup permission-guard override', description: 'Request 5-minute override window' },
    { command: 'hive-flow setup permission-guard revoke', description: 'Revoke active override immediately' },
    { command: 'hive-flow setup permission-guard status', description: 'Show override state' },
  ],
};

// Global subcommand
const globalCommand: Command = {
  name: 'global',
  description: 'Set up global ~/.hive-flow/ directory and default config',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Overwrite existing config',
      type: 'boolean',
      default: false,
    },
  ],
  action: globalAction,
};

const providersCommand: Command = {
  name: 'providers',
  description: 'Check provider credential setup without printing secrets',
  options: [
    {
      name: 'create-config',
      description: 'Persist non-secret credential references in .hive-flow/config.json',
      type: 'boolean',
      default: false,
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const report = inspectProviderSetup({ cwd: ctx.cwd });
    const wroteConfig = ctx.flags.createConfig || ctx.flags['create-config']
      ? writeProviderCredentialReferences(ctx.cwd, report)
      : undefined;
    const data = { ...report, wroteConfig };

    if (ctx.flags.format === 'json') {
      output.printJson(data);
      return { success: true, data };
    }

    output.writeln();
    output.writeln(output.bold('Provider Setup'));
    output.writeln(output.dim('Secrets are never printed or written by this command.'));
    output.writeln();
    for (const row of [report.providers.openrouter, report.providers.gemini]) {
      output.writeln(`${row.provider}: ${row.configured ? output.success('configured') : output.warning('action needed')}`);
      if (row.action) output.writeln(output.dim(`  ${row.action}`));
    }
    if (wroteConfig) {
      output.writeln(output.success(`Wrote non-secret provider references to ${wroteConfig}`));
    }

    return { success: true, data };
  },
};

const credentialsCommand: Command = {
  name: 'credentials',
  description: 'Create the per-machine KEK and empty encrypted credential vault',
  options: [
    {
      name: 'degraded',
      description: 'Allow degraded backend setup for explicit test/CI lanes',
      type: 'boolean',
      default: false,
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const nativeHelpers = await buildAndInstallNativeHelpers({
      projectRoot: ctx.cwd,
    });
    const helperPath = ensureHelperBinOnPath();
    const result = await initializeCredentialVault({
      allowDegraded: Boolean(ctx.flags.degraded),
    });
    const data = {
      backend: {
        available: result.backend.available,
        degraded: result.backend.degraded,
        reason: result.backend.reason,
      },
      vaultPath: result.vaultPath,
      createdVault: result.createdVault,
      decrypts: result.decrypts,
      nativeHelpers,
      helperPath,
    };
    if (ctx.flags.format === 'json') output.printJson(data);
    else {
      for (const helper of nativeHelpers) {
        output.printInfo(`helper ${helper.helper}: ${helper.status}${helper.remediation ? ` — ${helper.remediation}` : ''}`);
      }
      output.printInfo(`helper ${helperPath.helper}: ${helperPath.status}${helperPath.reason ? ` — ${helperPath.reason}` : ''}`);
      output.printSuccess(result.createdVault ? 'Created credential vault' : 'Credential vault already ready');
    }
    return { success: true, data };
  },
};

// Main setup command — also exposes the §7 agent-integration surface via
// top-level flags (--auto, --dry-run, --verify, --uninstall, --detect).
// Subcommands `global` and `permission-guard` retain their original behavior.
export const setupCommand: Command = {
  name: 'setup',
  description: 'Environment setup and configuration (top-level flags trigger §7 agent-integration)',
  subcommands: [globalCommand, providersCommand, credentialsCommand, permissionGuardCommand],
  options: [
    { name: 'auto', description: 'Apply selected integrations to detected/specified agent CLIs', type: 'boolean', default: false },
    { name: 'dry-run', description: 'Plan-only — no file writes', type: 'boolean', default: false },
    { name: 'verify', description: 'Verify-only mode', type: 'boolean', default: false },
    { name: 'uninstall', description: 'Remove selected Hive Flow integrations from agent CLIs', type: 'boolean', default: false },
    { name: 'detect', description: 'Detect installed agent CLIs without modifying anything', type: 'boolean', default: false },
    { name: 'scope', description: 'Config scope: user or project', type: 'string', default: 'user' },
    { name: 'agents', description: 'Agent IDs (comma-separated) or "detected"', type: 'string', default: 'detected' },
    { name: 'features', description: 'Integration features: mcp,statusline,connector', type: 'string', default: 'mcp,statusline' },
    { name: 'create-config', description: 'Create missing config files (opt-in)', type: 'boolean', default: false },
    { name: 'force-adopt', description: 'Force-adopt existing entries not owned by Hive Flow', type: 'boolean', default: false },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const flags = ctx.flags as Record<string, unknown>;
    const action: 'detect' | 'plan' | 'apply' | 'verify' | 'uninstall' | null =
      flags.auto || flags.apply ? 'apply'
      : flags.uninstall ? 'uninstall'
      : flags.verify ? 'verify'
      : flags.detect ? 'detect'
      : flags.dryRun || flags['dry-run'] ? 'plan'
      : null;
    if (action === null) {
      output.writeln();
      output.writeln(output.bold('Hive Flow Setup'));
      output.writeln(output.dim('Use one of: --auto, --dry-run, --verify, --uninstall, --detect'));
      output.writeln(output.dim('Or a subcommand: global, credentials, providers, permission-guard'));
      return { success: true };
    }
    const agentsRaw = (flags.agents as string | undefined) ?? 'detected';
    const agents: string[] | 'detected' =
      agentsRaw === 'detected' ? 'detected' : agentsRaw.split(',').map(s => s.trim()).filter(Boolean);
    const result = await runSetup({
      action,
      agents,
      scope: (flags.scope as SetupScope | undefined) ?? undefined,
      cwd: ctx.cwd,
      dryRun: action === 'plan' || !!(flags.dryRun || flags['dry-run']),
      createConfig: !!(flags.createConfig || flags['create-config']),
      forceAdopt: !!(flags.forceAdopt || flags['force-adopt']),
      features: String((flags.features ?? flags['features']) ?? 'mcp,statusline'),
    });
    output.writeln(JSON.stringify(result, null, 2));
    return { success: true, data: result };
  },
  examples: [
    { command: 'hive-flow setup --dry-run --agents detected', description: 'Plan MCP + statusline install for detected agent CLIs' },
    { command: 'hive-flow setup --auto', description: 'Apply MCP + statusline to detected agent CLIs (user scope)' },
    { command: 'hive-flow setup --auto --features statusline', description: 'Apply only the Claude Code statusline integration' },
    { command: 'hive-flow setup --auto --features mcp', description: 'Apply only the MCP integration (legacy behavior)' },
    { command: 'hive-flow setup --verify --features statusline', description: 'Verify Claude Code statusline state' },
    { command: 'hive-flow setup --uninstall --features statusline', description: 'Remove only the Claude Code statusline integration' },
    { command: 'hive-flow setup --dry-run --features connector --agents codex', description: 'Plan connector wrapper install for Codex CLI' },
    { command: 'hive-flow setup --auto --features connector', description: 'Install connector wrappers for all detected CLIs' },
    { command: 'hive-flow setup providers', description: 'Check OpenRouter and Gemini provider credential setup' },
    { command: 'hive-flow setup providers --create-config', description: 'Write non-secret provider credential references' },
    { command: 'hive-flow setup credentials', description: 'Create per-machine KEK and empty encrypted credential vault' },
    { command: 'hive-flow setup global', description: 'Create global ~/.hive-flow/ directory' },
    { command: 'hive-flow setup permission-guard setup', description: 'One-time Permission Guard keypair generation' },
  ],
};

export default setupCommand;

// ---------------------------------------------------------------------------
// §7 runSetup surface — agent-integration orchestration
// ---------------------------------------------------------------------------

export type SetupScope = 'project' | 'user';
export const DEFAULT_SETUP_SCOPE: SetupScope = 'user';
export function resolveSetupScope(scope?: SetupScope): SetupScope {
  return scope ?? DEFAULT_SETUP_SCOPE;
}

const AGENT_BINS: Record<AdapterId, string> = {
  'claude-code': 'claude',
  'codex': 'codex',
  'forgecode': 'forge',
  'opencode': 'opencode',
  'cursor-cli': 'cursor-agent',
  'qwen': 'qwen',
  'gemini': 'gemini',
};

function commandExists(bin: string): boolean {
  const r = spawnSync('/usr/bin/env', ['which', bin], { encoding: 'utf8', timeout: 2000 });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function chooseAgents(agents: string[] | 'detected'): AdapterId[] {
  if (agents === 'detected') {
    return (Object.entries(AGENT_BINS) as Array<[AdapterId, string]>)
      .filter(([, bin]) => commandExists(bin))
      .map(([id]) => id);
  }
  return agents.filter((id): id is AdapterId => id in ADAPTERS);
}

async function planAdapter(id: AdapterId, ctx: any) {
  const a = ADAPTERS[id];
  return a ? a.plan(ctx) : { outcome: 'failed' as const, message: `Unknown adapter: ${id}` };
}

async function applyAdapter(id: AdapterId, ctx: any) {
  const a = ADAPTERS[id];
  return a ? a.apply(ctx) : { outcome: 'failed' as const, message: `Unknown adapter: ${id}` };
}

async function verifyAdapter(id: AdapterId, ctx: any) {
  const a = ADAPTERS[id];
  return a ? a.verify(ctx) : { ok: false, output: `Unknown adapter: ${id}` };
}

async function uninstallAdapter(id: AdapterId, ctx: any) {
  const a = ADAPTERS[id];
  return a ? a.uninstall(ctx) : { outcome: 'failed' as const, message: `Unknown adapter: ${id}` };
}

export function resolveMcpServerEntry(projectRoot: string): string {
  // Candidate 1: running from workspace root (e.g., repo root → v3/@hive-flow/cli/bin/)
  const workspaceCandidate = resolve(projectRoot, 'v3', '@hive-flow', 'cli', 'bin', 'mcp-server.js');
  if (existsSync(workspaceCandidate)) return workspaceCandidate;

  // Candidate 2: relative to this source file. Walk upward looking for bin/mcp-server.js.
  // Handles both dist/src/commands/ (tsc default preserves src as a root) and dist/commands/
  // (flat) layouts plus npm-linked global installs.
  const selfUrl = import.meta.url;
  if (selfUrl.startsWith('file://')) {
    let dir = resolve(selfUrl.slice('file://'.length), '..');
    for (let i = 0; i < 6; i++) {
      const candidate = resolve(dir, 'bin', 'mcp-server.js');
      if (existsSync(candidate)) return candidate;
      const parent = resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
  }

  try {
    const req = createRequire(import.meta.url);
    return req.resolve('@hive-flow/cli/bin/mcp-server.js');
  } catch {
    throw new Error(
      `Cannot resolve @hive-flow/cli/bin/mcp-server.js. ` +
      `Run from the workspace root or install @hive-flow/cli into the current project.`,
    );
  }
}

async function runReadOnly(opts: any) {
  const projectRoot = resolve(opts.cwd);
  const homeDir = opts.homeDir ?? homedir();
  const launcherPath = resolveLauncherPath(opts.scope, homeDir, projectRoot);
  const statuslineLauncherPath = resolveStatuslineLauncherPath(opts.scope, homeDir, projectRoot);
  const features = parseFeatures(opts.features);
  const chosen = chooseAgents(opts.agents);
  const results: any[] = [];
  for (const id of chosen) {
    const ctx = {
      projectRoot, homeDir, scope: opts.scope, launcherPath, statuslineLauncherPath, dryRun: true,
      createConfig: opts.createConfig, forceAdopt: opts.forceAdopt,
      statePath: statePathFor(opts.scope, homeDir, projectRoot),
    };
    if (features.has('mcp')) {
      results.push({ agent: id as AdapterId, feature: 'mcp' as const, ...(await planAdapter(id, ctx)) });
    }
    if (id === 'claude-code' && features.has('statusline')) {
      results.push({
        agent: id as AdapterId,
        feature: 'statusline' as const,
        ...(await claudeCodeStatuslineAdapter.plan(ctx)),
      });
    }
    if (features.has('connector') && isKnownTarget(id)) {
      await importConnectorAdapters();
      const adapter = await loadAdapter(id);
      const r = await adapter.install({ projectRoot, cliBin: launcherPath, scope: opts.scope, dryRun: true });
      results.push({ agent: id as AdapterId, feature: 'connector' as const, outcome: 'planned', ...r });
    }
  }
  return { results };
}

async function runVerify(opts: any) {
  const projectRoot = resolve(opts.cwd);
  const homeDir = opts.homeDir ?? homedir();
  const launcherPath = resolveLauncherPath(opts.scope, homeDir, projectRoot);
  const statuslineLauncherPath = resolveStatuslineLauncherPath(opts.scope, homeDir, projectRoot);
  const statePath = statePathFor(opts.scope, homeDir, projectRoot);
  const features = parseFeatures(opts.features);
  const chosen = chooseAgents(opts.agents);
  const results: any[] = [];
  for (const id of chosen) {
    const ctx = {
      projectRoot, homeDir, scope: opts.scope, launcherPath, statuslineLauncherPath,
      dryRun: true, createConfig: opts.createConfig, forceAdopt: opts.forceAdopt, statePath,
    };
    if (features.has('mcp')) {
      results.push({ agent: id as AdapterId, feature: 'mcp' as const, ...(await verifyAdapter(id, ctx)) });
    }
    if (id === 'claude-code' && features.has('statusline')) {
      results.push({
        agent: id as AdapterId,
        feature: 'statusline' as const,
        ...(await claudeCodeStatuslineAdapter.verify(ctx)),
      });
    }
    if (features.has('connector') && isKnownTarget(id)) {
      await importConnectorAdapters();
      const diag = await diagnoseConnectors({ projectRoot });
      const row = diag.entries.find((d) => d.target === id);
      const ok = row ? row.installed && row.issues.length === 0 : false;
      results.push({ agent: id as AdapterId, feature: 'connector' as const, outcome: ok ? 'applied' : 'failed', diagnosis: row });
    }
  }
  return { results };
}

async function runMutating(opts: any) {
  const lockResult = await withSetupLock(async () => {
    const projectRoot = resolve(opts.cwd);
    const homeDir = opts.homeDir ?? homedir();
    const launcherPath = resolveLauncherPath(opts.scope, homeDir, projectRoot);
    const statuslineLauncherPath = resolveStatuslineLauncherPath(opts.scope, homeDir, projectRoot);
    const statePath = statePathFor(opts.scope, homeDir, projectRoot);
    const features = parseFeatures(opts.features);

    if (!opts.dryRun && opts.action !== 'uninstall' && features.has('mcp')) {
      const mcpServerEntry = resolveMcpServerEntry(projectRoot);
      await writeStableLauncher(launcherPath, mcpServerEntry);
    }
    if (!opts.dryRun && opts.action !== 'uninstall' && features.has('statusline')) {
      const statuslineEntrypoint = resolveStatuslineRuntimeEntrypoint(projectRoot);
      const previousCommand = await previousStatusLineCommandForLauncher({
        projectRoot,
        homeDir,
        scope: opts.scope,
        launcherPath,
        statuslineLauncherPath,
        dryRun: opts.dryRun,
        createConfig: opts.createConfig,
        forceAdopt: opts.forceAdopt,
        statePath,
      });
      await writeStableStatuslineLauncher(statuslineLauncherPath, statuslineEntrypoint, { previousCommand });
    }

    const chosen = chooseAgents(opts.agents);
    const results: any[] = [];
    for (const id of chosen) {
      const ctx = {
        projectRoot, homeDir, scope: opts.scope, launcherPath, statuslineLauncherPath,
        dryRun: opts.dryRun, createConfig: opts.createConfig, forceAdopt: opts.forceAdopt, statePath,
      };
      if (features.has('mcp')) {
        const r = opts.action === 'uninstall' ? await uninstallAdapter(id, ctx) : await applyAdapter(id, ctx);
        results.push({ agent: id as AdapterId, feature: 'mcp' as const, ...r });
      }
      if (id === 'claude-code' && features.has('statusline')) {
        const r = opts.action === 'uninstall'
          ? await claudeCodeStatuslineAdapter.uninstall(ctx)
          : await claudeCodeStatuslineAdapter.apply(ctx);
        results.push({ agent: id as AdapterId, feature: 'statusline' as const, ...r });
      }
      if (features.has('connector') && isKnownTarget(id)) {
        await importConnectorAdapters();
        const adapter = await loadAdapter(id);
        const connCtx = { projectRoot, cliBin: launcherPath, scope: opts.scope, dryRun: opts.dryRun };
        const r = opts.action === 'uninstall'
          ? await adapter.uninstall(connCtx)
          : await adapter.install(connCtx);
        results.push({ agent: id as AdapterId, feature: 'connector' as const, ...r });
      }
    }
    return { results };
  }, { lockPath: opts.lockPath });

  if (!lockResult.acquired) {
    return { results: [{ outcome: 'busy:locked', message: 'Another hive-flow setup is in progress. Try again later.' }] };
  }
  return lockResult.result;
}

export async function runSetup(_rawOpts: {
  action: 'detect' | 'plan' | 'apply' | 'verify' | 'reconcile' | 'uninstall';
  agents: string[] | 'detected';
  scope?: SetupScope;
  cwd: string;
  homeDir?: string;
  lockPath?: string;
  dryRun: boolean;
  createConfig: boolean;
  forceAdopt: boolean;
  features?: string;
}) {
  // Normalize scope ONCE at entry so every downstream helper sees a defined value.
  const opts = { ..._rawOpts, scope: resolveSetupScope(_rawOpts.scope) };

  switch (opts.action) {
    case 'detect': {
      const rows = Object.entries(AGENT_BINS).map(([id, bin]) => ({ id, bin, installed: commandExists(bin) }));
      return { results: rows };
    }
    case 'plan':
      return runReadOnly({ ...opts, dryRun: true });
    case 'verify':
      return runVerify(opts);
    case 'apply':
    case 'reconcile':
    case 'uninstall':
      return runMutating(opts);
    default:
      return { results: [{ outcome: 'failed', message: `Unknown action: ${(opts as any).action}` }] };
  }
}
