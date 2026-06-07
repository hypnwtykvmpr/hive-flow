#!/usr/bin/env node
//
// Hive Sentinel Notify — TeammateIdle + Stop hook
//
// Scans .hive-flow/data/ for hive-*.done marker files and notifies the
// advocate about completed hives that haven't been acknowledged yet.
//
// Entry points via argv[2]:
//   'teammate-idle' — injects additionalContext when unnotified .done markers exist
//   'stop-notify'   — non-blocking summary only (never emits permissionDecision: deny)
//
// .done file format (JSON): { hiveId, completedAt, summary }
// .acked marker: .hive-flow/data/hive-{id}.acked (shared atomic sentinel file)
//
// Safety:
//   - Fail-open: all errors produce {} (never blocks)
//   - Atomic O_EXCL writes for .acked markers
//   - Handles missing files, corrupt JSON, multiple hives
//

'use strict';

const fs = require('fs');
const path = require('path');
const { isAlreadyAcked, claimAcked } = require('./dedup-marker.cjs');
const { resolveSessionId } = require('./session-id.cjs');

function loadProtectedPathPolicyModule() {
  const envProjectRoot = process.env.HIVE_FLOW_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || '';
  const candidates = [
    envProjectRoot && path.join(path.resolve(envProjectRoot), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'),
    path.join(path.resolve(process.cwd()), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'),
    path.join(path.resolve(__dirname, '..', '..'), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'),
    path.join(__dirname, 'protected-paths.cjs'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return require(candidate);
    } catch {
      // Try the next candidate.
    }
  }

  return require(path.join(path.resolve(__dirname, '..', '..'), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'));
}

const protectedPathPolicy = loadProtectedPathPolicyModule();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_DIR = protectedPathPolicy.resolveProjectRoot({
  env: process.env,
  cwd: path.resolve(__dirname, '..', '..'),
  fallbackRoot: process.cwd(),
});
const DATA_DIR = path.join(PROJECT_DIR, '.hive-flow', 'data');
const OWNER_ACK_GRACE_MS = 15_000; // Align with hive-watcher's normal poll cadence.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Scan DATA_DIR for hive-*.done files that do NOT have a corresponding
 * hive-*.acked marker. Returns array of { hiveId, filePath, data, sanitized }.
 */
function findUnnotifiedDoneFiles() {
  const results = [];
  if (!fs.existsSync(DATA_DIR)) return results;

  let entries;
  try {
    entries = fs.readdirSync(DATA_DIR);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.startsWith('hive-') || !entry.endsWith('.done')) continue;

    // Extract base: hive-{uuid}.done -> hive-{uuid}
    const base = entry.slice(0, -5); // strip '.done'
    const sanitized = base.slice('hive-'.length);
    if (!sanitized) continue;

    // Already notified by any delivery path — skip
    if (isAlreadyAcked(DATA_DIR, sanitized)) continue;

    const filePath = path.join(DATA_DIR, entry);
    let data = null;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      data = JSON.parse(raw);
    } catch {
      // Corrupt or unreadable — still report with minimal info
      data = { hiveId: base, error: 'unreadable' };
    }

    const hiveId = (data && data.hiveId) || base;
    results.push({ hiveId, filePath, data, sanitized });
  }

  return results;
}

/**
 * Build a human-readable summary line for a completed hive.
 */
function buildSummaryLine(item) {
  const d = item.data || {};
  const parts = [`hive=${item.hiveId}`];
  if (d.completedAt) parts.push(`at=${d.completedAt}`);
  if (d.summary) parts.push(d.summary);
  if (typeof d.completedCount === 'number') parts.push(`completed=${d.completedCount}`);
  if (typeof d.failedCount === 'number') parts.push(`failed=${d.failedCount}`);
  if (d.error) parts.push(`(${d.error})`);
  return parts.join(' ');
}

function resolveDoneOwnerSessionId(item) {
  return resolveSessionId({ session_id: item?.data?.ownerSessionId }, {});
}

function parseCompletedAtMs(item) {
  const value = item && item.data && item.data.completedAt;
  if (typeof value !== 'string' || !value.trim()) return NaN;
  return Date.parse(value);
}

function shouldDeferToOwner(item, currentSessionId, nowMs = Date.now()) {
  const ownerSessionId = resolveDoneOwnerSessionId(item);
  if (!ownerSessionId) return false;
  if (ownerSessionId === currentSessionId) return false;

  const completedAtMs = parseCompletedAtMs(item);
  if (!Number.isFinite(completedAtMs)) return false;

  return nowMs - completedAtMs < OWNER_ACK_GRACE_MS;
}

function claimOwnOrFallback(item, mode, currentSessionId, nowMs = Date.now()) {
  if (shouldDeferToOwner(item, currentSessionId, nowMs)) return false;
  return claimAcked(DATA_DIR, item.sanitized, {
    source: 'hive-sentinel-notify',
    mode,
    ownerSessionId: resolveDoneOwnerSessionId(item) || null,
    claimantSessionId: currentSessionId || null,
  });
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function handleTeammateIdle() {
  const unnotified = findUnnotifiedDoneFiles();
  if (unnotified.length === 0) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const currentSessionId = resolveSessionId(null, process.env);
  const nowMs = Date.now();
  const claimed = unnotified.filter(item => claimOwnOrFallback(item, 'teammate-idle', currentSessionId, nowMs));
  if (claimed.length === 0) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Build notification context
  const lines = claimed.map(item => buildSummaryLine(item));
  const hiveIds = claimed.map(item => item.hiveId);

  const context = claimed.length === 1
    ? `[HIVE COMPLETE: ${hiveIds[0]}] ${lines[0]}. Run hive_poll_workers or queen_collect_results to review.`
    : `[${claimed.length} HIVES COMPLETE] ${hiveIds.join(', ')}.\n${lines.join('\n')}\nRun hive_poll_workers or queen_collect_results for each.`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'TeammateIdle',
      additionalContext: context,
    },
  }));
}

function handleStopNotify() {
  const unnotified = findUnnotifiedDoneFiles();
  if (unnotified.length === 0) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const currentSessionId = resolveSessionId(null, process.env);
  const nowMs = Date.now();
  const claimed = unnotified.filter(item => claimOwnOrFallback(item, 'stop-notify', currentSessionId, nowMs));
  if (claimed.length === 0) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Non-blocking summary — no permissionDecision, just context
  const lines = claimed.map(item => buildSummaryLine(item));
  const hiveIds = claimed.map(item => item.hiveId);

  const context = claimed.length === 1
    ? `[HIVE DONE — STOP SUMMARY: ${hiveIds[0]}] ${lines[0]}.`
    : `[${claimed.length} HIVES DONE — STOP SUMMARY] ${hiveIds.join(', ')}.\n${lines.join('\n')}`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: context,
    },
  }));
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

function main() {
  const command = process.argv[2];

  switch (command) {
    case 'teammate-idle':
      handleTeammateIdle();
      break;
    case 'stop-notify':
      handleStopNotify();
      break;
    default:
      // Unknown command — emit nothing
      process.stdout.write(JSON.stringify({}));
      break;
  }
}

try {
  main();
} catch {
  // Fail-open: never block on internal errors
  process.stdout.write(JSON.stringify({}));
}
