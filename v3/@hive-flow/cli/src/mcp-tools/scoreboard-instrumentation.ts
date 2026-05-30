// v3/@hive-flow/cli/src/mcp-tools/scoreboard-instrumentation.ts
//
// Phase 11.1 — MCP scoreboard instrumentation.
//
// Thin, best-effort bridge from the provider-backed MCP agent tools
// (`agent_spawn`, `agent_task`, `agent_task_result`) to the statusline
// scoreboard recorders. Every export here is non-throwing: a recorder failure
// must never make the underlying MCP operation fail after the provider
// operation itself succeeded (Phase 11 acceptance gate "MCP instrumentation").
//
// Provider mapping: the MCP agent layer uses `AgentProvider` values
// ('anthropic', 'anthropic-cli', 'gemini-cli', 'codex-cli', 'cursor-cli',
// 'deepseek', 'openrouter'). The scoreboard uses `ScoreProvider` / `HostCli`.
// `toScoreProvider` in collectors/scoreboard.ts only accepts exact
// `ScoreProvider` values, so the '-cli' forms need their own mapping here.

import { resolveProjectScope } from '../statusline/project-scope.js';
import {
  recordPresenceEvent,
  recordProviderCall,
} from '../statusline/recorders/scoreboard.js';
import type { HostCli, ScoreProvider } from '../statusline/types.js';

/** AgentProvider -> ScoreProvider. Unknown inputs collapse to 'unknown'. */
const AGENT_PROVIDER_TO_SCORE: Record<string, ScoreProvider> = {
  anthropic: 'claude',
  'anthropic-cli': 'claude',
  'gemini-cli': 'gemini',
  'codex-cli': 'codex',
  'cursor-cli': 'cursor',
  deepseek: 'deepseek',
  openrouter: 'openrouter',
};

/**
 * AgentProvider -> HostCli. API-only providers (deepseek, openrouter) have no
 * interactive host CLI, so they record under 'hive-flow-daemon'.
 */
const AGENT_PROVIDER_TO_HOST_CLI: Record<string, HostCli> = {
  anthropic: 'claude-code',
  'anthropic-cli': 'claude-code',
  'gemini-cli': 'gemini',
  'codex-cli': 'codex',
  'cursor-cli': 'cursor-cli',
  deepseek: 'hive-flow-daemon',
  openrouter: 'hive-flow-daemon',
};

export function agentProviderToScore(provider: string | undefined): ScoreProvider {
  if (!provider) return 'unknown';
  return AGENT_PROVIDER_TO_SCORE[provider] ?? 'unknown';
}

export function agentProviderToHostCli(provider: string | undefined): HostCli {
  if (!provider) return 'hive-flow-daemon';
  return AGENT_PROVIDER_TO_HOST_CLI[provider] ?? 'hive-flow-daemon';
}

/** Resolve `{ repoRoot, projectKey }` for the current working directory. */
function resolveScope(): { repoRoot: string; projectKey: string } {
  const scope = resolveProjectScope({ cwd: process.cwd() });
  return { repoRoot: scope.worktreeRoot, projectKey: scope.projectKey };
}

/**
 * Record an `agent-spawn` presence event after a successful `agent_spawn`.
 * `presenceKey` is stable per `(hostCli, agentId)`; the fold collapses to the
 * latest event per key, so a timestamped `eventId` never double-counts.
 */
export async function recordMcpAgentSpawn(input: {
  agentId: string;
  provider: string | undefined;
  model?: string;
  nowMs?: number;
}): Promise<void> {
  try {
    const { repoRoot, projectKey } = resolveScope();
    const hostCli = agentProviderToHostCli(input.provider);
    const provider = agentProviderToScore(input.provider);
    const stamp = input.nowMs ?? Date.now();
    await recordPresenceEvent({
      version: 1,
      eventId: `mcp-presence:${hostCli}:${input.agentId}:${stamp}`,
      ts: new Date(stamp).toISOString(),
      repoRoot,
      projectKey,
      hostCli,
      provider,
      producerKind: 'mcp-tool',
      producerId: 'hive-flow:mcp-server',
      presenceKey: `${hostCli}:${input.agentId}`,
      agentId: input.agentId,
      model: input.model,
      event: 'agent-spawn',
    });
  } catch {
    // best-effort: a recorder failure must never fail the MCP tool.
  }
}

/**
 * Record a `call-start` after a successful `agent_task` dispatch. `eventId` is
 * the task ID so the later `call-complete` / `call-failed` correlates with it.
 */
export async function recordMcpCallStart(input: {
  taskId: string;
  agentId: string;
  provider: string | undefined;
  model?: string;
}): Promise<void> {
  try {
    const { repoRoot, projectKey } = resolveScope();
    await recordProviderCall({
      version: 1,
      eventId: input.taskId,
      ts: new Date().toISOString(),
      repoRoot,
      projectKey,
      hostCli: agentProviderToHostCli(input.provider),
      provider: agentProviderToScore(input.provider),
      producerKind: 'mcp-tool',
      producerId: 'hive-flow:mcp-server',
      sessionId: input.agentId,
      model: input.model,
      event: 'call-start',
    });
  } catch {
    // best-effort.
  }
}

/** Record a terminal `call-complete` for a task ID (correlates with start). */
export async function recordMcpCallComplete(input: {
  taskId: string;
  agentId: string;
  provider: string | undefined;
  model?: string;
}): Promise<void> {
  try {
    const { repoRoot, projectKey } = resolveScope();
    await recordProviderCall({
      version: 1,
      eventId: input.taskId,
      ts: new Date().toISOString(),
      repoRoot,
      projectKey,
      hostCli: agentProviderToHostCli(input.provider),
      provider: agentProviderToScore(input.provider),
      producerKind: 'mcp-tool',
      producerId: 'hive-flow:mcp-server',
      sessionId: input.agentId,
      model: input.model,
      event: 'call-complete',
      countWeight: 1,
    });
  } catch {
    // best-effort.
  }
}

/** Record a terminal `call-failed` for a task ID (correlates with start). */
export async function recordMcpCallFailed(input: {
  taskId: string;
  agentId: string;
  provider: string | undefined;
  model?: string;
}): Promise<void> {
  try {
    const { repoRoot, projectKey } = resolveScope();
    await recordProviderCall({
      version: 1,
      eventId: input.taskId,
      ts: new Date().toISOString(),
      repoRoot,
      projectKey,
      hostCli: agentProviderToHostCli(input.provider),
      provider: agentProviderToScore(input.provider),
      producerKind: 'mcp-tool',
      producerId: 'hive-flow:mcp-server',
      sessionId: input.agentId,
      model: input.model,
      event: 'call-failed',
    });
  } catch {
    // best-effort.
  }
}
