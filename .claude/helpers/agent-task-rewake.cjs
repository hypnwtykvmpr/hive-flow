#!/usr/bin/env node
//
// Agent Task Rewake — PostToolUse(asyncRewake) hook on mcp__hive-flow__agent_task
//
// PURPOSE
//   Fixes the Sentinel Protocol gap where MCP `agent_task` completion never
//   reaches the main Claude Code screen (the bridge writes
//   `.hive-flow/tasks/<taskId>.result.json` on finish but fires no hook and
//   never calls agent_task_result, so a manual poll was the ONLY way to learn
//   a task finished).
//
// HOW IT WORKS (three layers, strictly-better-than-today, never worse)
//   1. As an ASYNC PostToolUse hook (does NOT block agent_task's immediate
//      return), this process reads the dispatched taskId from the tool
//      response, then polls for `<taskId>.result.json`.
//   2. On completion it appends a line to
//      `.hive-flow/data/pending-notifications.jsonl` (the GUARANTEED fallback —
//      drained into additionalContext by the UserPromptSubmit `drain-notifications`
//      hook on the human's next message).
//   3. It then exits with code 2 and a `[TASK COMPLETE: <taskId>]` summary on
//      stderr — the documented asyncRewake path that wakes Claude immediately
//      on platforms that support it. Where it isn't supported, layer 2 still
//      delivers, so this is never worse than the prior manual-poll-only state.
//
// SAFETY
//   - Fail-open: every error path exits 0 with no output (never blocks/breaks).
//   - Idempotent: a `.hive-flow/data/task-<id>.notified` sentinel prevents
//     double-notifying the same task.
//   - Bounded: wakes Claude at MAX_WAIT_MS to check progress, then relies on
//     agent_task_result PostToolUse to restart the monitor if still running.
//   - tmux-free: no tmux dependency anywhere in this path.

'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { wakeSessionPaths } = require('./wake-paths.cjs');

const DEFAULT_MAX_WAIT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_MS = 1500;

function positiveIntFromEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const MAX_WAIT_MS = positiveIntFromEnv('HIVE_FLOW_REWAKE_MAX_WAIT_MS', DEFAULT_MAX_WAIT_MS);
const POLL_MS = positiveIntFromEnv('HIVE_FLOW_REWAKE_POLL_MS', DEFAULT_POLL_MS);

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Extract the taskId from the PostToolUse payload. agent_task's response is a
// JSON string like {"success":true,"taskId":"task-...","status":"running"}.
// We search the raw payload defensively (shapes vary across CC versions).
function extractTaskId(raw) {
  if (!raw) return null;
  // Prefer a structured parse, but fall back to a regex over the raw text.
  try {
    const obj = JSON.parse(raw);
    const candidates = [
      obj?.tool_input,
      obj?.toolInput,
      obj?.tool_response,
      obj?.toolResponse,
      obj?.tool_result,
      obj?.response,
    ];
    for (const c of candidates) {
      const text = typeof c === 'string' ? c : c ? JSON.stringify(c) : '';
      const m = text.match(/"taskId"\s*:\s*"(task-[A-Za-z0-9-]+)"/);
      if (m) return m[1];
    }
  } catch {
    /* fall through to raw regex */
  }
  const m = raw.match(/"taskId"\s*:\s*"(task-[A-Za-z0-9-]+)"/);
  return m ? m[1] : null;
}

function summarizeResult(resultPath, taskId) {
  try {
    const r = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const inner = r?.result || r;
    const ok = inner?.success !== false && r?.success !== false;
    const status = ok ? 'completed' : 'failed';
    const agentId = inner?.agentId || r?.agentId || 'unknown';
    let detail = '';
    if (!ok) {
      const err = inner?.error || r?.error || '';
      detail = err ? ` error="${String(err).slice(0, 160)}"` : '';
    } else {
      const content = inner?.content || '';
      const len = typeof content === 'string' ? content.length : 0;
      detail = len ? ` resultChars=${len}` : '';
    }
    return `[TASK COMPLETE: ${taskId}] agent=${agentId} status=${status}${detail}. Call agent_task_result({taskId:"${taskId}"}) for the full payload.`;
  } catch {
    return `[TASK COMPLETE: ${taskId}] result file present. Call agent_task_result({taskId:"${taskId}"}) for the full payload.`;
  }
}

function appendPending(dataDir, line) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(path.join(dataDir, 'pending-notifications.jsonl'), line + '\n');
    return true;
  } catch {
    /* fail-open */
    return false;
  }
}

function targetAgentFromInputOrEnv(sessionInput = null, env = process.env) {
  const fromInput = sessionInput && typeof sessionInput === 'object' && !Array.isArray(sessionInput)
    ? (sessionInput.clientKind || sessionInput.client_kind)
    : null;
  const raw = String(
    fromInput ||
    env.HIVE_FLOW_CLIENT_KIND ||
    env.CLAUDE_CODE_ENTRYPOINT ||
    '',
  ).toLowerCase();
  if (raw.includes('codex')) return 'codex';
  if (raw.includes('claude')) return 'claude';
  return null;
}

function pendingDataDirs(projectRoot, sessionInput = null, env = process.env) {
  const localDataDir = path.join(projectRoot, '.hive-flow', 'data');
  const wake = wakeSessionPaths(sessionInput, env);
  return wake?.sessionDir ? [localDataDir, wake.sessionDir] : [localDataDir];
}

function timeoutSummary(taskId) {
  return `[TASK CHECK DUE: ${taskId}] Background agent task is still pending after ${Math.round(MAX_WAIT_MS / 60000)} minute(s). Call agent_task_result({taskId:"${taskId}"}). If status is running, continue waiting; the PostToolUse hook will restart this monitor.`;
}

function timeoutCheckPath(dataDir, taskId) {
  return path.join(dataDir, `task-${taskId}.check-due`);
}

function clearTimeoutCheck(dataDir, taskId) {
  try {
    fs.unlinkSync(timeoutCheckPath(dataDir, taskId));
  } catch {
    /* absent or already removed */
  }
}

function isAgentTaskResultPayload(raw) {
  try {
    const parsed = JSON.parse(raw);
    const toolName = parsed?.tool_name || parsed?.toolName || '';
    return toolName === 'agent_task_result' || toolName === 'mcp__hive-flow__agent_task_result';
  } catch {
    return false;
  }
}

function appendTimeoutCheckOnce(dataDir, taskId, line) {
  const markerPath = timeoutCheckPath(dataDir, taskId);
  const lockPath = `${markerPath}.lock`;
  let lockFd = null;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(markerPath)) return false;
    try {
      lockFd = fs.openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return false;
      return false;
    }
    if (fs.existsSync(markerPath)) return false;
    fs.appendFileSync(path.join(dataDir, 'pending-notifications.jsonl'), line + '\n');
    fs.writeFileSync(markerPath, JSON.stringify({
      claimedAt: new Date().toISOString(),
      pid: process.pid,
      source: 'agent-task-rewake:timeout',
    }, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  } finally {
    if (lockFd !== null) {
      try { fs.closeSync(lockFd); } catch { /* ignore */ }
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

function claimNotifiedMarker(notifiedMarker) {
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(notifiedMarker), { recursive: true });
    fd = fs.openSync(notifiedMarker, 'wx');
    fs.writeFileSync(fd, String(Date.now()));
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* noop */ }
    }
  }
}

function releaseNotifiedMarker(notifiedMarker) {
  try { fs.unlinkSync(notifiedMarker); } catch { /* noop */ }
}

function appendTaskCompletionPendingOnce(dataDir, taskId, line) {
  const notifiedMarker = path.join(dataDir, `task-${taskId}.notified`);
  if (!claimNotifiedMarker(notifiedMarker)) {
    return { appended: false, reason: 'already-notified' };
  }
  const appended = appendPending(dataDir, line);
  if (!appended) {
    releaseNotifiedMarker(notifiedMarker);
    return { appended: false, reason: 'append-failed' };
  }
  return { appended: true };
}

function extractSessionInput(raw) {
  try {
    const parsed = JSON.parse(raw);
    return {
      session_id: parsed?.session_id || parsed?.sessionId,
      transcript_path: parsed?.transcript_path || parsed?.transcriptPath,
      client_kind: parsed?.client_kind || parsed?.clientKind,
    };
  } catch {
    return null;
  }
}

function notifyCompletedTaskIfReady(projectRoot, taskId, options = {}) {
  const resultPath = path.join(projectRoot, '.hive-flow', 'tasks', `${taskId}.result.json`);
  const env = options.env || process.env;
  const sessionInput = options.sessionInput || null;

  let done = false;
  try {
    done = fs.existsSync(resultPath);
  } catch {
    done = false;
  }
  if (!done) return { notified: false, reason: 'pending' };

  const summary = summarizeResult(resultPath, taskId);
  const targetAgent = targetAgentFromInputOrEnv(sessionInput, env);
  const line = JSON.stringify({
    kind: 'task',
    taskId,
    ts: new Date().toISOString(),
    summary,
    ...(targetAgent ? { targetAgent } : {}),
  });
  let appendedAny = false;
  let appendFailed = false;
  for (const dataDir of pendingDataDirs(projectRoot, sessionInput, env)) {
    const result = appendTaskCompletionPendingOnce(dataDir, taskId, line);
    if (result.appended) appendedAny = true;
    if (result.reason === 'append-failed') appendFailed = true;
  }

  if (appendedAny) return { notified: true, summary };
  return { notified: false, reason: appendFailed ? 'append-failed' : 'already-notified' };
}

async function importJournalModule(projectRoot) {
  const sourcePath = path.join(projectRoot, 'v3', '@hive-flow', 'providers', 'scripts', 'agent-task-journal.mjs');
  try {
    if (fs.existsSync(sourcePath)) {
      return import(pathToFileURL(sourcePath).href);
    }
  } catch {
    /* fall through to package resolution */
  }
  try {
    const resolved = require.resolve('@hive-flow/providers/scripts/agent-task-journal.mjs', {
      paths: [projectRoot, process.cwd(), __dirname],
    });
    return import(pathToFileURL(resolved).href);
  } catch {
    return null;
  }
}

async function appendRewakeJournalEvent(projectRoot, taskId, meta) {
  try {
    const journal = await importJournalModule(projectRoot);
    if (!journal || typeof journal.appendTaskJournalEvent !== 'function') return false;
    return journal.appendTaskJournalEvent({
      tasksDir: path.join(projectRoot, '.hive-flow', 'tasks'),
      taskId,
      event: 'rewake_notified',
      meta,
    });
  } catch {
    return false;
  }
}

async function main() {
  const raw = readStdin();
  const taskId = extractTaskId(raw);
  if (!taskId) process.exit(0); // not an agent_task dispatch we can track

  const dir = projectDir();
  // Idempotency: never notify the same task twice.
  try {
    const notifiedMarker = path.join(dir, '.hive-flow', 'data', `task-${taskId}.notified`);
    if (fs.existsSync(notifiedMarker)) process.exit(0);
  } catch {
    process.exit(0);
  }
  const dataDir = path.join(dir, '.hive-flow', 'data');
  if (isAgentTaskResultPayload(raw)) {
    clearTimeoutCheck(dataDir, taskId);
  }
  const sessionInput = extractSessionInput(raw);

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const result = notifyCompletedTaskIfReady(dir, taskId, { sessionInput, env: process.env });
    if (result.notified) {
      await appendRewakeJournalEvent(dir, taskId, { reason: 'completed' });
      // Layer 3: async-rewake attempt — stderr summary + exit 2.
      process.stderr.write(result.summary + '\n');
      process.exit(2);
    }
    if (result.reason === 'already-notified') process.exit(0);
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
  const summary = timeoutSummary(taskId);
  const won = appendTimeoutCheckOnce(
    dataDir,
    taskId,
    JSON.stringify({ kind: 'task-check', taskId, ts: new Date().toISOString(), summary }),
  );
  if (!won) process.exit(0);
  await appendRewakeJournalEvent(dir, taskId, { reason: 'timeout' });
  process.stderr.write(summary + '\n');
  process.exit(2);
}

if (require.main === module) {
  main().catch(() => process.exit(0));
}

module.exports = {
  positiveIntFromEnv,
  projectDir,
  extractTaskId,
  summarizeResult,
  appendPending,
  targetAgentFromInputOrEnv,
  pendingDataDirs,
  timeoutSummary,
  timeoutCheckPath,
  clearTimeoutCheck,
  isAgentTaskResultPayload,
  appendTimeoutCheckOnce,
  claimNotifiedMarker,
  releaseNotifiedMarker,
  appendTaskCompletionPendingOnce,
  extractSessionInput,
  notifyCompletedTaskIfReady,
  importJournalModule,
  appendRewakeJournalEvent,
  main,
};
