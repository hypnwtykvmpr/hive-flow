// cli/src/integrations/adapters/index.ts
import { join } from 'node:path';
import { readTextIfExists } from '../atomic-merge.js';
import { makeJsonAdapter, makeTomlAdapter, makeManualCommandAdapter } from './factories.js';
import { hiveFlowMcpEnv } from '../launcher.js';
import type { AdapterCtx, IntegrationAdapter } from '../adapter.js';

const stdJsonValue = (ctx: AdapterCtx) => ({
  command: ctx.launcherPath,
  args: [] as string[],
  env: hiveFlowMcpEnv(),
});

export const claudeCodeAdapter = makeJsonAdapter({
  id: 'claude-code',
  cli: { bin: 'claude', args: ['mcp', 'get', 'hive-flow'] },
  verifyMatch: /Connected/i,
  userPath: (h) => join(h, '.claude.json'),
  projectPath: (p) => join(p, '.mcp.json'),
  jsonPath: ['mcpServers', 'hive-flow'],
  parentPathForVariantScan: 'mcpServers',
  canonicalKey: 'hive-flow',
  buildValue: stdJsonValue,
});

export const cursorAdapter = makeJsonAdapter({
  id: 'cursor-cli',
  cli: { bin: 'cursor-agent', args: ['mcp', 'list'] },
  verifyMatch: /hive-flow/i,
  userPath: (h) => join(h, '.cursor', 'mcp.json'),
  projectPath: (p) => join(p, '.cursor', 'mcp.json'),
  jsonPath: ['mcpServers', 'hive-flow'],
  parentPathForVariantScan: 'mcpServers',
  canonicalKey: 'hive-flow',
  buildValue: stdJsonValue,
});

export const qwenAdapter = makeJsonAdapter({
  id: 'qwen',
  cli: { bin: 'qwen', args: ['mcp', 'list'] },
  verifyMatch: /hive-flow/i,
  userPath: (h) => join(h, '.qwen', 'settings.json'),
  projectPath: (p) => join(p, '.qwen', 'settings.json'),
  jsonPath: ['mcpServers', 'hive-flow'],
  parentPathForVariantScan: 'mcpServers',
  canonicalKey: 'hive-flow',
  buildValue: stdJsonValue,
});

export const geminiAdapter = makeJsonAdapter({
  id: 'gemini',
  cli: { bin: 'gemini', args: ['mcp', 'list'] },
  verifyMatch: /hive-flow/i,
  userPath: (h) => join(h, '.gemini', 'settings.json'),
  projectPath: (p) => join(p, '.gemini', 'settings.json'),
  jsonPath: ['mcpServers', 'hive-flow'],
  parentPathForVariantScan: 'mcpServers',
  canonicalKey: 'hive-flow',
  buildValue: stdJsonValue,
});

// OpenCode wraps the launcher inside a `command` *array* and uses `environment` (not `env`).
export const openCodeAdapter = makeJsonAdapter({
  id: 'opencode',
  cli: { bin: 'opencode', args: ['--print-logs', 'mcp', 'list'] },
  verifyMatch: /hive-flow/i,
  userPath: (h) => join(h, '.config', 'opencode', 'opencode.json'),
  projectPath: (p) => join(p, 'opencode.json'),
  jsonPath: ['mcp', 'hive-flow'],
  parentPathForVariantScan: 'mcp',
  canonicalKey: 'hive-flow',
  buildValue: (ctx) => ({
    type: 'local',
    command: [ctx.launcherPath] as string[],
    enabled: true,
    environment: hiveFlowMcpEnv(),
  }),
});

// Codex requires TOML with an env subtable per official docs (the launcher shim does not export env).
export const codexAdapter = makeTomlAdapter({
  id: 'codex',
  cli: { bin: 'codex', args: ['mcp', 'list'] },
  verifyMatch: /hive-flow/i,
  userPath: (h) => join(h, '.codex', 'config.toml'),
  projectPath: (p) => join(p, '.codex', 'config.toml'),
  mainTable: 'mcp_servers.hive-flow',
  envTable: 'mcp_servers.hive-flow.env',
  canonicalKey: 'hive-flow',
  buildMain: (ctx) => ({
    command: ctx.launcherPath, args: [] as string[],
    env_vars: ['CODEX_SESSION_ID', 'CODEX_THREAD_ID'],
    type: 'stdio', enabled: true,
    startup_timeout_sec: 30, tool_timeout_sec: 60,
  }),
  buildEnv: () => hiveFlowMcpEnv() as Record<string, unknown>,
});

// ForgeCode: user-scope is manual-command (Forge `mcp import` takes JSON as a *positional* arg, NOT --from).
// Project-scope writes the same `.mcp.json` shape as Claude Code's project scope.
const forgeProjectBase = makeJsonAdapter({
  id: 'forgecode',
  cli: { bin: 'forge', args: ['mcp', 'list', '--porcelain'] },
  verifyMatch: /hive-flow/i,
  userPath: () => null,                                 // user scope dispatches to manual-command below
  projectPath: (p) => join(p, '.mcp.json'),
  jsonPath: ['mcpServers', 'hive-flow'],
  parentPathForVariantScan: 'mcpServers',
  canonicalKey: 'hive-flow',
  buildValue: stdJsonValue,
});

export const forgeCodeAdapter = makeManualCommandAdapter({
  id: 'forgecode',
  manualScopes: ['user'],
  cli: { bin: 'forge', args: ['mcp', 'list', '--porcelain'] },
  verifyMatch: /hive-flow/i,
  buildCommand: (ctx) => {
    const json = JSON.stringify({
      mcpServers: { 'hive-flow': { command: ctx.launcherPath, args: [], env: hiveFlowMcpEnv() } },
    });
    // Single-quote-wrap JSON for shell; escape embedded single quotes via the standard '\'' trick.
    return `forge mcp import --scope user '${json.replace(/'/g, `'\\''`)}'`;
  },
  uninstallCommand: () => `forge mcp remove hive-flow --scope user`,
  // Idempotency probe: forge user-scope `mcp import` writes to ~/.forge/.mcp.json.
  // If our entry is already there with our launcher path, plan/apply report
  // already-registered instead of re-printing the manual command.
  isAlreadyRegistered: async (ctx) => {
    const forgeMcpPath = join(ctx.homeDir, '.forge', '.mcp.json');
    const text = await readTextIfExists(forgeMcpPath);
    if (text === null) return false;
    try {
      const data = JSON.parse(text) as { mcpServers?: Record<string, { command?: string }> };
      const entry = data.mcpServers?.['hive-flow'];
      return !!entry && entry.command === ctx.launcherPath;
    } catch {
      return false;
    }
  },
}, forgeProjectBase);

export const ADAPTERS = {
  'claude-code': claudeCodeAdapter,
  codex:         codexAdapter,
  forgecode:     forgeCodeAdapter,
  opencode:      openCodeAdapter,
  'cursor-cli':  cursorAdapter,
  qwen:          qwenAdapter,
  gemini:        geminiAdapter,
} satisfies Record<string, IntegrationAdapter>;

export type AdapterId = keyof typeof ADAPTERS;

// The Claude Code *statusline* adapter is intentionally NOT in the ADAPTERS
// map above — that map is the MCP-style per-agent dispatch table. The
// statusline adapter is dispatched per-feature from `commands/setup.ts`, so
// we only need to re-export it here for setup.ts to consume.
export { claudeCodeStatuslineAdapter } from './claude-code-statusline.js';
