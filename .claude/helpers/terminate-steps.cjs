#!/usr/bin/env node
/**
 * Post-Termination Steps
 * Spawns a Gemini sub-agent via MCP to update the auto-memory file
 * before context is cleared after /terminate-agent.
 *
 * Designed to run in a DETACHED child process forked from terminate-agent.cjs.
 * Uses execFileSync for sequential MCP CLI calls with retry + structured logs.
 *
 * Export: helper functions for deterministic testing.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 300_000; // 300 seconds
const DEFAULT_MAX_ATTEMPTS = 3; // 1 initial + 2 retries

function resolveRuntime(deps = {}) {
  const projectRoot = deps.projectRoot || process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
  return {
    projectRoot,
    cliPath: deps.cliPath || path.join(projectRoot, 'v3', '@hive-flow', 'cli', 'bin', 'cli.js'),
    timeoutMs: Number.isFinite(Number(deps.timeoutMs)) ? Number(deps.timeoutMs) : DEFAULT_TIMEOUT_MS,
    exec: deps.execFileSync || execFileSync,
    logPath: deps.logPath || path.join(projectRoot, '.hive-flow', 'sessions', 'terminate-steps.log.jsonl'),
  };
}

function appendStructuredLog(runtime, event, fields = {}) {
  try {
    fs.mkdirSync(path.dirname(runtime.logPath), { recursive: true });
    const payload = {
      ts: new Date().toISOString(),
      event,
      ...fields,
    };
    fs.appendFileSync(runtime.logPath, JSON.stringify(payload) + '\n', 'utf8');
  } catch {
    // Logging failures must never break flow.
  }
}

// Derive memory file path from project dir (matches Claude Code's convention)
function getMemoryFilePath(projectRoot) {
  const projectDir = projectRoot;
  const encoded = projectDir.replace(/\//g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded, 'memory', 'MEMORY.md');
}

/**
 * Run a CLI MCP tool call synchronously.
 * Returns parsed JSON result or `{ error }` on failure.
 */
function mcpExec(tool, params, deps = {}) {
  const runtime = resolveRuntime(deps);
  try {
    const stdout = runtime.exec('node', [
      runtime.cliPath,
      'mcp', 'exec',
      '--tool', tool,
      '--params', JSON.stringify(params),
    ], {
      timeout: runtime.timeoutMs,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: runtime.projectRoot,
    });
    // CLI output has [INFO]/[OK]/Result: prefixes — extract JSON
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]); } catch {}
    }
    return { raw: stdout.trim() };
  } catch (err) {
    return { error: err.message || 'mcpExec failed' };
  }
}

function mcpExecWithRetry(tool, params, options = {}, deps = {}) {
  const runtime = resolveRuntime(deps);
  const maxAttempts = Math.max(1, Number(options.maxAttempts || DEFAULT_MAX_ATTEMPTS));

  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = mcpExec(tool, params, deps);
    const ok = !result?.error;
    appendStructuredLog(runtime, 'mcp.exec', { tool, attempt, ok, error: result?.error || null });
    if (ok) {
      return { ...result, attempts: attempt };
    }
    last = result;
  }

  return {
    ...(last || {}),
    error: (last && last.error) || `mcpExecWithRetry failed for tool=${tool}`,
    attempts: maxAttempts,
  };
}

/**
 * Extract agent ID from spawn result.
 * Tries common response shapes.
 */
function extractAgentId(result) {
  if (!result || result.error) return null;
  if (result.agentId) return result.agentId;
  if (result.id) return result.id;
  if (result.result && result.result.agentId) return result.result.agentId;
  if (result.result && result.result.id) return result.result.id;
  if (result.raw && typeof result.raw === 'string') {
    // Try to extract an ID from raw output (e.g. "agent-abc123")
    const match = result.raw.match(/agent[_-][a-zA-Z0-9-]+/);
    if (match) return match[0];
  }
  return null;
}

/**
 * Attempt to stop/clean up a spawned agent. Best-effort, never throws.
 */
function cleanupAgent(agentId, deps = {}) {
  const runtime = resolveRuntime(deps);
  if (!agentId) return { cleaned: false, reason: 'no-agent-id' };
  try {
    runtime.exec('node', [
      runtime.cliPath,
      'agent', 'stop',
      '--id', agentId,
    ], {
      timeout: 30_000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: runtime.projectRoot,
    });
    appendStructuredLog(runtime, 'agent.cleanup', { agentId, cleaned: true });
    return { cleaned: true };
  } catch {
    appendStructuredLog(runtime, 'agent.cleanup', { agentId, cleaned: false });
    return { cleaned: false };
  }
}

/**
 * Run post-termination memory update steps.
 *
 * @param {object} marker - The termination marker from terminate-agent.cjs.
 * @param {object} deps - Optional dependency injection for tests.
 */
function runPostTerminationSteps(marker, deps = {}) {
  const runtime = resolveRuntime(deps);
  let agentId = null;
  const generation = marker?.generation || null;
  const preferredModel = process.env.HIVE_FLOW_TERMINATE_AGENT_MODEL || 'sonnet';
  const preferredProvider = process.env.HIVE_FLOW_TERMINATE_AGENT_PROVIDER || '';

  appendStructuredLog(runtime, 'terminate.steps.start', { generation });

  try {
    // Step 1: Spawn memory-specialist agent (prefer Sonnet + default provider routing).
    const spawnPayload = {
      agentType: 'memory-specialist',
      model: preferredModel,
      task: 'Update session memory',
    };
    if (preferredProvider) {
      spawnPayload.provider = preferredProvider;
    }

    let spawnResult = mcpExecWithRetry(
      'agent_spawn',
      spawnPayload,
      { maxAttempts: DEFAULT_MAX_ATTEMPTS },
      deps
    );

    // If an explicit provider was requested and failed, retry once with provider omitted.
    if (!agentId && spawnResult?.error && preferredProvider) {
      appendStructuredLog(runtime, 'terminate.steps.spawn.fallback', {
        generation,
        reason: 'explicit-provider-failed-retrying-default-routing',
        provider: preferredProvider,
      });
      const fallbackPayload = {
        agentType: 'memory-specialist',
        model: preferredModel,
        task: 'Update session memory',
      };
      spawnResult = mcpExecWithRetry(
        'agent_spawn',
        fallbackPayload,
        { maxAttempts: DEFAULT_MAX_ATTEMPTS },
        deps
      );
    }

    agentId = extractAgentId(spawnResult);
    if (!agentId) {
      const result = {
        success: false,
        reason: 'Failed to extract agent ID from spawn result',
        spawnResult,
        logPath: runtime.logPath,
      };
      appendStructuredLog(runtime, 'terminate.steps.fail', {
        generation,
        reason: result.reason,
        spawnAttempts: spawnResult.attempts || 0,
        spawnError: spawnResult.error || null,
      });
      return result;
    }

    // Step 2: Send memory update task
    const markerSummary = marker
      ? `Terminated at ${marker.at || 'unknown'}. Reason: ${marker.reason || 'unknown'}. Generation: ${marker.generation || 'unknown'}.`
      : 'No marker data available.';

    const taskResult = mcpExecWithRetry('agent_task', {
      agentId: agentId,
      task: `Read the file at ${getMemoryFilePath(runtime.projectRoot)} and add a concise summary of the current session state before termination. Context: ${markerSummary} Include: what was being worked on, key findings, and pending tasks. Keep total file under 200 lines.`,
    }, { maxAttempts: DEFAULT_MAX_ATTEMPTS }, deps);

    // Step 3: Clean up the agent
    const cleanup = cleanupAgent(agentId, deps);

    const success = !taskResult.error;
    const result = {
      success,
      agentId,
      spawnAttempts: spawnResult.attempts || 0,
      taskAttempts: taskResult.attempts || 0,
      taskResult,
      cleanup,
      logPath: runtime.logPath,
    };
    appendStructuredLog(runtime, 'terminate.steps.complete', {
      generation,
      success,
      agentId,
      spawnAttempts: result.spawnAttempts,
      taskAttempts: result.taskAttempts,
      cleaned: cleanup.cleaned,
    });
    return {
      ...result,
    };
  } catch (err) {
    // Timeout or unexpected error — clean up and continue
    const cleanup = cleanupAgent(agentId, deps);
    const result = {
      success: false,
      reason: err.message || 'Unexpected error in post-termination steps',
      agentId,
      cleanup,
      logPath: runtime.logPath,
    };
    appendStructuredLog(runtime, 'terminate.steps.error', {
      generation,
      reason: result.reason,
      agentId,
      cleaned: cleanup.cleaned,
    });
    return result;
  }
}

// Allow direct execution as a detached background process
if (require.main === module) {
  const markerPath = process.argv[2];
  let marker = null;
  if (markerPath) {
    try {
      marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    } catch {
      // Fall through with null marker
    }
  }
  const result = runPostTerminationSteps(marker);
  try {
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    // Silent on write failure
  }
  process.exit(result.success ? 0 : 1);
}

module.exports = {
  resolveRuntime,
  appendStructuredLog,
  getMemoryFilePath,
  mcpExec,
  mcpExecWithRetry,
  extractAgentId,
  cleanupAgent,
  runPostTerminationSteps,
};
