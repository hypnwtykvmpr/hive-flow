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
// .notified marker: .hive-flow/data/hive-{id}.notified (empty sentinel file)
//
// Safety:
//   - Fail-open: all errors produce {} (never blocks)
//   - Atomic writes for .notified markers (tmp + rename)
//   - Handles missing files, corrupt JSON, multiple hives
//

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_DIR, '.hive-flow', 'data');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Scan DATA_DIR for hive-*.done files that do NOT have a corresponding
 * hive-*.notified marker. Returns array of { hiveId, filePath, data }.
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
    const notifiedPath = path.join(DATA_DIR, base + '.notified');

    // Already notified — skip
    if (fs.existsSync(notifiedPath)) continue;

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
    results.push({ hiveId, filePath, data });
  }

  return results;
}

/**
 * Write .notified marker atomically. Best-effort — failure does not block.
 */
function writeNotifiedMarker(hiveBase) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const markerPath = path.join(DATA_DIR, hiveBase + '.notified');
    const tmpPath = markerPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, new Date().toISOString() + '\n', 'utf8');
    fs.renameSync(tmpPath, markerPath);
  } catch {
    // Best-effort — next run will retry
  }
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

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function handleTeammateIdle() {
  const unnotified = findUnnotifiedDoneFiles();
  if (unnotified.length === 0) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Build notification context
  const lines = unnotified.map(item => buildSummaryLine(item));
  const hiveIds = unnotified.map(item => item.hiveId);

  // Mark as notified (before output — atomic writes are best-effort)
  for (const item of unnotified) {
    const base = path.basename(item.filePath, '.done');
    writeNotifiedMarker(base);
  }

  const context = unnotified.length === 1
    ? `[HIVE COMPLETE: ${hiveIds[0]}] ${lines[0]}. Run hive_poll_workers or queen_collect_results to review.`
    : `[${unnotified.length} HIVES COMPLETE] ${hiveIds.join(', ')}.\n${lines.join('\n')}\nRun hive_poll_workers or queen_collect_results for each.`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
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

  // Non-blocking summary — no permissionDecision, just context
  const lines = unnotified.map(item => buildSummaryLine(item));
  const hiveIds = unnotified.map(item => item.hiveId);

  // Mark as notified
  for (const item of unnotified) {
    const base = path.basename(item.filePath, '.done');
    writeNotifiedMarker(base);
  }

  const context = unnotified.length === 1
    ? `[HIVE DONE — STOP SUMMARY: ${hiveIds[0]}] ${lines[0]}.`
    : `[${unnotified.length} HIVES DONE — STOP SUMMARY] ${hiveIds.join(', ')}.\n${lines.join('\n')}`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
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
