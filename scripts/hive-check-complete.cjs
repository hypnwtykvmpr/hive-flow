#!/usr/bin/env node
//
// Hive Check Complete — PostToolUse supplementary mechanism
//
// Scans .hive-flow/data/ for hive-*.done marker files and notifies the
// advocate about completed hives that haven't been acknowledged yet.
//
// This is a SUPPLEMENTARY mechanism that runs on PostToolUse events,
// working alongside the PRIMARY run_in_background mechanism.
//
// Entry point via argv[2]:
//   'post-tool-use' — injects additionalContext when unnotified .done markers exist
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
const { isAlreadyAcked, claimAcked } = require('../.claude/helpers/dedup-marker.cjs');
const { resolveSessionId } = require('../.claude/helpers/session-id.cjs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_DIR, '.hive-flow', 'data');
const OWNER_ACK_GRACE_MS = 15_000;

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

function parseDoneCompletedAtMs(item) {
  const value = item && item.data && item.data.completedAt;
  if (typeof value !== 'string' || !value.trim()) return NaN;
  return Date.parse(value);
}

function shouldDeferToOwner(item, currentSessionId, nowMs = Date.now()) {
  const ownerSessionId = resolveDoneOwnerSessionId(item);
  if (!ownerSessionId) return false;
  if (ownerSessionId === currentSessionId) return false;

  const completedAtMs = parseDoneCompletedAtMs(item);
  if (!Number.isFinite(completedAtMs)) return false;

  return nowMs - completedAtMs < OWNER_ACK_GRACE_MS;
}

function claimOwnOrFallback(item, currentSessionId, nowMs = Date.now()) {
  if (shouldDeferToOwner(item, currentSessionId, nowMs)) return false;
  return claimAcked(DATA_DIR, item.sanitized, {
    source: 'hive-check-complete',
    ownerSessionId: resolveDoneOwnerSessionId(item) || null,
    claimantSessionId: currentSessionId || null,
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function handlePostToolUse() {
  const unnotified = findUnnotifiedDoneFiles();
  if (unnotified.length === 0) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const currentSessionId = resolveSessionId(null, process.env);
  const nowMs = Date.now();
  const claimed = unnotified.filter(item => claimOwnOrFallback(item, currentSessionId, nowMs));
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
      hookEventName: 'PostToolUse',
      additionalContext: context,
    },
  }));
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

function main() {
  const command = process.argv[2];

  // Only handle post-tool-use command
  if (command === 'post-tool-use') {
    handlePostToolUse();
  } else {
    // Unknown command — emit nothing
    process.stdout.write(JSON.stringify({}));
  }
}

try {
  main();
} catch {
  // Fail-open: never block on internal errors
  process.stdout.write(JSON.stringify({}));
}
