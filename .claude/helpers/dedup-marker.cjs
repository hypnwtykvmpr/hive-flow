#!/usr/bin/env node
//
// Shared hive completion acknowledgement marker.
//
// Completion notifications can be delivered by several independent hooks and
// watcher processes. This helper gives them one atomic claim point so exactly
// one delivery path wins. Losing paths may leave duplicate pending JSONL lines;
// the drain collapses those by notification key, and duplicates are safer than
// silently dropping a completion wake.
//

'use strict';

const fs = require('fs');
const path = require('path');

const PENDING_FILE = 'pending-notifications.jsonl';
const LEGACY_MARKER_SUFFIXES = [
  'notified',
  ['rewake', 'notified'].join('-'),
  ['pending', 'notified'].join('-'),
];

function sanitizeHiveId(hiveId) {
  return String(hiveId || '').replace(/[/\\.]+/g, '_').replace(/^_+|_+$/g, '');
}

function ackedPath(dataDir, hiveId) {
  const sanitized = sanitizeHiveId(hiveId);
  if (!sanitized) return null;
  return path.join(dataDir, `hive-${sanitized}.acked`);
}

function legacyMarkerPaths(dataDir, hiveId) {
  const sanitized = sanitizeHiveId(hiveId);
  if (!sanitized) return [];
  return LEGACY_MARKER_SUFFIXES.map((suffix) => path.join(dataDir, `hive-${sanitized}.${suffix}`));
}

function writeAckMarker(markerPath, detail = {}) {
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fd = fs.openSync(markerPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({
      claimedAt: new Date().toISOString(),
      pid: process.pid,
      ...detail,
    }, null, 2) + '\n', 'utf8');
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function isAlreadyAcked(dataDir, hiveId) {
  const current = ackedPath(dataDir, hiveId);
  try {
    if (current && fs.existsSync(current)) return true;
    return false;
  } catch {
    return true;
  }
}

function claimAcked(dataDir, hiveId, detail = {}) {
  const markerPath = ackedPath(dataDir, hiveId);
  if (!markerPath) return false;
  if (isAlreadyAcked(dataDir, hiveId)) return false;

  return writeAckMarker(markerPath, detail);
}

function acquireLock(lockPath) {
  try {
    return fs.openSync(lockPath, 'wx', 0o600);
  } catch (err) {
    if (!err || err.code !== 'EEXIST') return null;
    try {
      const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (ageMs > 60_000) {
        fs.unlinkSync(lockPath);
        return fs.openSync(lockPath, 'wx', 0o600);
      }
    } catch {
      /* another process may own or remove it */
    }
    return null;
  }
}

function appendPendingWithAck(dataDir, hiveId, line, detail = {}) {
  const markerPath = ackedPath(dataDir, hiveId);
  if (!markerPath) return false;
  if (isAlreadyAcked(dataDir, hiveId)) return false;

  const lockPath = `${markerPath}.lock`;
  let lockFd = null;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    lockFd = acquireLock(lockPath);
    if (lockFd === null) return false;
    if (isAlreadyAcked(dataDir, hiveId)) return false;

    fs.appendFileSync(path.join(dataDir, PENDING_FILE), line + '\n');
    return claimAcked(dataDir, hiveId, detail);
  } catch {
    return false;
  } finally {
    if (lockFd !== null) {
      try { fs.closeSync(lockFd); } catch { /* ignore */ }
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

module.exports = {
  sanitizeHiveId,
  ackedPath,
  legacyMarkerPaths,
  isAlreadyAcked,
  claimAcked,
  appendPendingWithAck,
};
