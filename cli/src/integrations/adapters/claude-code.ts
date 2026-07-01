/**
 * @file adapters/claude-code.ts
 *
 * Standalone, explanatory Claude Code MCP adapter.
 *
 * **Explanatory only — non-canonical.**
 * The canonical Claude Code adapter is the factory-built `claudeCodeAdapter`
 * exported from `./index.js`. This standalone version exists for educational
 * purposes and to back the §12.3 state-flow regression test, which imports
 * `applyClaudeCodeMcp` from `'../adapters/claude-code.js'`.
 *
 * Do NOT use this file as the implementation path for `hive-flow setup`.
 * See §6.3–§6.4 of the runbook for the factory-based canonical adapters.
 */

import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { upsertJsonPath } from '../atomic-merge.js';
import { readState, writeState, checksumEntry, entryId } from '../state.js';
import { hiveFlowMcpEnv } from '../launcher.js';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ClaudeCodeAdapterCtx {
  projectRoot: string;
  homeDir: string;
  scope: 'project' | 'user';
  launcherPath: string;
  dryRun: boolean;
  forceAdopt: boolean;
  createConfig: boolean;
  statePath: string;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applyClaudeCodeMcp(ctx: ClaudeCodeAdapterCtx) {
  const filePath = ctx.scope === 'user'
    ? join(ctx.homeDir, '.claude.json')
    : join(ctx.projectRoot, '.mcp.json');

  const value = { command: ctx.launcherPath, args: [] as string[], env: hiveFlowMcpEnv() };
  const state = await readState(ctx.statePath);

  const result = await upsertJsonPath({
    filePath,
    ownership: 'agent',
    jsonPath: ['mcpServers', 'hive-flow'],
    value,
    dryRun: ctx.dryRun,
    createIfMissing: ctx.createConfig,
    forceAdopt: ctx.forceAdopt,
    isManaged: async (existing) => {
      const id = entryId({
        agent: 'claude-code',
        kind: 'mcp',
        scope: ctx.scope,
        targetPath: filePath,
        jsonPath: 'mcpServers.hive-flow',
      });
      const record = state.entries[id];
      if (!record) return false;
      // Considered managed if existing entry matches the last-known checksum we wrote
      return record.checksum === checksumEntry(existing);
    },
  });

  // Write ownership state after successful apply so reconcile/uninstall can
  // recognise Hive Flow's entry.
  if (result.outcome === 'applied') {
    const state2 = await readState(ctx.statePath);
    const id = entryId({
      agent: 'claude-code',
      kind: 'mcp',
      scope: ctx.scope,
      targetPath: filePath,
      jsonPath: 'mcpServers.hive-flow',
    });
    state2.entries[id] = {
      agent: 'claude-code',
      kind: 'mcp',
      scope: ctx.scope,
      targetPath: filePath,
      jsonPath: 'mcpServers.hive-flow',
      checksum: checksumEntry(value),
      launcherPath: ctx.launcherPath,
      installedAt: new Date().toISOString(),
      version: 1,
    };
    await writeState(ctx.statePath, state2);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verifies the Claude Code MCP registration by executing `claude mcp get hive-flow`.
 * This is NOT a stub — it actually invokes the binary.
 */
export async function verifyClaudeCodeMcp(
  ctx: ClaudeCodeAdapterCtx,
): Promise<{ ok: boolean; output: string }> {
  const r = spawnSync('claude', ['mcp', 'get', 'hive-flow'], {
    cwd: ctx.projectRoot,
    encoding: 'utf8',
    timeout: 10_000,
  });
  const output = (r.stdout ?? '') + (r.stderr ?? '');
  return { ok: r.status === 0 && /Connected/i.test(output), output: output.slice(0, 2000) };
}
