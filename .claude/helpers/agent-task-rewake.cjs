#!/usr/bin/env node
//
// Agent Task Rewake — PostToolUse(async) hook on mcp__hive-flow__agent_task
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
//      stderr — the documented async-rewake path that wakes Claude immediately
//      on platforms that support it. Where it isn't supported, layer 2 still
//      delivers, so this is never worse than the prior manual-poll-only state.
//
// SAFETY
//   - Fail-open: every error path exits 0 with no output (never blocks/breaks).
//   - Idempotent: a `.hive-flow/data/task-<id>.notified` sentinel prevents
//     double-notifying the same task.
//   - Bounded: gives up after MAX_WAIT_MS so a never-finishing task can't leak
//     a hung hook process.
//   - tmux-free: no tmux dependency anywhere in this path.

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_WAIT_MS = 30 * 60 * 1000; // 30 min cap; abandon quietly after this
const POLL_MS = 1500;

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
  } catch {
    /* fail-open */
  }
}

async function main() {
  const raw = readStdin();
  const taskId = extractTaskId(raw);
  if (!taskId) process.exit(0); // not an agent_task dispatch we can track

  const dir = projectDir();
  const dataDir = path.join(dir, '.hive-flow', 'data');
  const resultPath = path.join(dir, '.hive-flow', 'tasks', `${taskId}.result.json`);
  const notifiedMarker = path.join(dataDir, `task-${taskId}.notified`);

  // Idempotency: never notify the same task twice.
  try {
    if (fs.existsSync(notifiedMarker)) process.exit(0);
  } catch {
    process.exit(0);
  }

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    let done = false;
    try {
      done = fs.existsSync(resultPath);
    } catch {
      done = false;
    }
    if (done) {
      const summary = summarizeResult(resultPath, taskId);
      // Layer 2: guaranteed-delivery marker (drained on next user prompt).
      appendPending(
        dataDir,
        JSON.stringify({ taskId, ts: new Date().toISOString(), summary }),
      );
      // Mark notified (atomic-ish: write tmp + rename).
      try {
        const tmp = notifiedMarker + '.tmp';
        fs.writeFileSync(tmp, String(Date.now()));
        fs.renameSync(tmp, notifiedMarker);
      } catch {
        /* fail-open */
      }
      // Layer 3: async-rewake attempt — stderr summary + exit 2.
      process.stderr.write(summary + '\n');
      process.exit(2);
    }
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
  // Timed out waiting; give up quietly (fail-open).
  process.exit(0);
}

main().catch(() => process.exit(0));
