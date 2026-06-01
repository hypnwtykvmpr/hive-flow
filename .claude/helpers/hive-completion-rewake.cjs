#!/usr/bin/env node
//
// Hive Completion Rewake - asyncRewake PostToolUse hook on queen_mission_assign.
//
// The detached hive watcher writes `.hive-flow/data/hive-<id>.done` when all
// workers settle. This hook stays alive after queen_mission_assign or
// hive_poll_workers returns, waits for that marker, writes the guaranteed drain
// fallback, and exits 2 so Claude Code's asyncRewake channel can wake an idle
// session. On timeout it wakes Claude to poll workers; the hive_poll_workers
// PostToolUse hook then restarts this bounded monitor if the hive is still
// running.

'use strict';

const fs = require('fs');
const path = require('path');

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

function extractHiveId(raw) {
  if (!raw) return null;
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
    for (const candidate of candidates) {
      const text = typeof candidate === 'string'
        ? candidate
        : candidate
          ? JSON.stringify(candidate)
          : '';
      const found = extractHiveIdFromText(text);
      if (found) return found;
    }
  } catch {
    /* fall through to raw regex */
  }
  return extractHiveIdFromText(raw);
}

function extractCompletion(raw) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    const candidates = [
      obj?.tool_response,
      obj?.toolResponse,
      obj?.tool_result,
      obj?.response,
      raw,
    ];
    for (const candidate of candidates) {
      const parsed = parseCompletionFromText(
        typeof candidate === 'string' ? candidate : candidate ? JSON.stringify(candidate) : '',
      );
      if (parsed) return parsed;
    }
  } catch {
    return parseCompletionFromText(raw);
  }
  return null;
}

function parseCompletionFromText(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item?.type === 'text' && typeof item.text === 'string') {
          const nested = parseCompletionFromText(item.text);
          if (nested) return nested;
        }
      }
      return null;
    }
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.content)) {
        for (const item of parsed.content) {
          if (item?.type === 'text' && typeof item.text === 'string') {
            const nested = parseCompletionFromText(item.text);
            if (nested) return nested;
          }
        }
      }
      const complete = parsed.allComplete === true
        || parsed.allComplete === 'true'
        || parsed.allWorkersSettled === true
        || parsed.allWorkersSettled === 'true'
        || parsed.readyForReport === true
        || parsed.readyForReport === 'true';
      if (!complete) return null;
      return {
        completedCount: parsed.completedCount,
        failedCount: parsed.failedCount,
        idleCount: parsed.idleCount,
        terminatedCount: parsed.terminatedCount,
      };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function extractHiveIdFromText(text) {
  if (!text) return null;
  const direct = text.match(/"hiveId"\s*:\s*"(hive-[A-Za-z0-9_-]+)"/);
  if (direct) return direct[1];

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.hiveId === 'string') return parsed.hiveId;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item?.type === 'text' && typeof item.text === 'string') {
            const nested = extractHiveIdFromText(item.text);
            if (nested) return nested;
          }
        }
      }
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function sanitizeHiveId(hiveId) {
  const sanitized = String(hiveId || '').replace(/[/\\.]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized || null;
}

function summarizeDone(donePath, hiveId) {
  try {
    const data = JSON.parse(fs.readFileSync(donePath, 'utf8'));
    const parts = [];
    if (typeof data.completedCount === 'number') parts.push(`completed=${data.completedCount}`);
    if (typeof data.failedCount === 'number') parts.push(`failed=${data.failedCount}`);
    if (typeof data.idleCount === 'number') parts.push(`idle=${data.idleCount}`);
    if (typeof data.terminatedCount === 'number') parts.push(`terminated=${data.terminatedCount}`);
    if (data.summary) parts.push(String(data.summary).slice(0, 180));
    const detail = parts.length ? parts.join(' ') : 'done marker present';
    return `[HIVE COMPLETE: ${hiveId}] ${detail}. Run hive_poll_workers or queen_collect_results to review.`;
  } catch {
    return `[HIVE COMPLETE: ${hiveId}] done marker present. Run hive_poll_workers or queen_collect_results to review.`;
  }
}

function summarizeStatus(status, hiveId) {
  const parts = [];
  if (typeof status.completedCount === 'number') parts.push(`completed=${status.completedCount}`);
  if (typeof status.failedCount === 'number') parts.push(`failed=${status.failedCount}`);
  if (typeof status.idleCount === 'number') parts.push(`idle=${status.idleCount}`);
  if (typeof status.terminatedCount === 'number') parts.push(`terminated=${status.terminatedCount}`);
  const detail = parts.length ? parts.join(' ') : 'all workers settled';
  return `[HIVE COMPLETE: ${hiveId}] ${detail}. Run hive_poll_workers or queen_collect_results to review.`;
}

function summarizeHiveRecord(dir, sanitizedHiveId, hiveId) {
  try {
    const hivePath = path.join(dir, '.hive-flow', 'hives', sanitizedHiveId, 'hive.json');
    if (!fs.existsSync(hivePath)) return null;
    const hive = JSON.parse(fs.readFileSync(hivePath, 'utf8'));
    if (hive?.status !== 'completed' && hive?.status !== 'failed') return null;
    return `[HIVE COMPLETE: ${hiveId}] hive status=${hive.status}. Run hive_poll_workers or queen_collect_results to review.`;
  } catch {
    return null;
  }
}

function appendPendingOnce(dataDir, sanitizedHiveId, line) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const marker = path.join(dataDir, `hive-${sanitizedHiveId}.pending-notified`);
    if (fs.existsSync(marker)) return;
    fs.appendFileSync(path.join(dataDir, 'pending-notifications.jsonl'), line + '\n');
    const tmp = `${marker}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, new Date().toISOString() + '\n', 'utf8');
    fs.renameSync(tmp, marker);
  } catch {
    /* fail-open */
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

function timeoutSummary(hiveId) {
  return `[HIVE CHECK DUE: ${hiveId}] Hive workers are still pending after ${Math.round(MAX_WAIT_MS / 60000)} minute(s). Call hive_poll_workers({hiveId:"${hiveId}"}). If workers are still running, continue waiting; the PostToolUse hook will restart this monitor.`;
}

async function main() {
  const raw = readStdin();
  const hiveId = extractHiveId(raw);
  const sanitized = sanitizeHiveId(hiveId);
  if (!hiveId || !sanitized) process.exit(0);

  const dir = projectDir();
  const dataDir = path.join(dir, '.hive-flow', 'data');
  const donePath = path.join(dataDir, `hive-${sanitized}.done`);
  const rewakeMarker = path.join(dataDir, `hive-${sanitized}.rewake-notified`);

  try {
    if (fs.existsSync(rewakeMarker)) process.exit(0);
  } catch {
    process.exit(0);
  }

  const immediateCompletion = extractCompletion(raw);
  if (immediateCompletion) {
    const summary = summarizeStatus(immediateCompletion, hiveId);
    appendPendingOnce(
      dataDir,
      sanitized,
      JSON.stringify({ kind: 'hive', hiveId, ts: new Date().toISOString(), summary }),
    );
    try {
      const tmp = `${rewakeMarker}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, new Date().toISOString() + '\n', 'utf8');
      fs.renameSync(tmp, rewakeMarker);
    } catch {
      /* fail-open */
    }
    process.stderr.write(summary + '\n');
    process.exit(2);
  }

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    let done = false;
    try {
      done = fs.existsSync(donePath);
    } catch {
      done = false;
    }
    if (done) {
      const summary = summarizeDone(donePath, hiveId);
      appendPendingOnce(
        dataDir,
        sanitized,
        JSON.stringify({ kind: 'hive', hiveId, ts: new Date().toISOString(), summary }),
      );
      try {
        const tmp = `${rewakeMarker}.tmp.${process.pid}`;
        fs.writeFileSync(tmp, new Date().toISOString() + '\n', 'utf8');
        fs.renameSync(tmp, rewakeMarker);
      } catch {
        /* fail-open */
      }
      process.stderr.write(summary + '\n');
      process.exit(2);
    }
    const recordSummary = summarizeHiveRecord(dir, sanitized, hiveId);
    if (recordSummary) {
      appendPendingOnce(
        dataDir,
        sanitized,
        JSON.stringify({ kind: 'hive', hiveId, ts: new Date().toISOString(), summary: recordSummary }),
      );
      try {
        const tmp = `${rewakeMarker}.tmp.${process.pid}`;
        fs.writeFileSync(tmp, new Date().toISOString() + '\n', 'utf8');
        fs.renameSync(tmp, rewakeMarker);
      } catch {
        /* fail-open */
      }
      process.stderr.write(recordSummary + '\n');
      process.exit(2);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  const summary = timeoutSummary(hiveId);
  appendPending(
    dataDir,
    JSON.stringify({ kind: 'hive-check', hiveId, ts: new Date().toISOString(), summary }),
  );
  process.stderr.write(summary + '\n');
  process.exit(2);
}

main().catch(() => process.exit(0));
