'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');

function stringValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function absoluteEnvPath(value) {
  const raw = stringValue(value);
  if (!raw || !path.isAbsolute(raw)) return null;
  return path.resolve(raw);
}

function resolveHiveHome(env = process.env) {
  return absoluteEnvPath(env.HIVE_FLOW_HOME) || path.join(os.homedir(), '.hive-flow');
}

function sessionInputValue(input) {
  if (typeof input === 'string') return { value: stringValue(input), clientKind: null };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { value: null, clientKind: null };
  }
  return {
    value:
      stringValue(input.sessionKey) ||
      stringValue(input.sessionId) ||
      stringValue(input.session_id) ||
      stringValue(input.transcriptPath) ||
      stringValue(input.transcript_path),
    clientKind: stringValue(input.clientKind) || stringValue(input.client_kind),
  };
}

function sessionValue(input, env = process.env) {
  const fromInput = sessionInputValue(input);
  return (
    fromInput.value ||
    stringValue(env.HIVE_FLOW_SESSION_ID) ||
    stringValue(env.CLAUDE_SESSION_ID) ||
    stringValue(env.CODEX_SESSION_ID)
  );
}

function sessionKeyFor(input, env = process.env) {
  const fromInput = sessionInputValue(input);
  const rawSession = sessionValue(input, env) || `pid:${process.pid}`;
  const clientKind =
    fromInput.clientKind ||
    stringValue(env.HIVE_FLOW_CLIENT_KIND) ||
    stringValue(env.CLAUDE_CODE_ENTRYPOINT) ||
    'unknown';
  return `s_${crypto.createHash('sha256').update(`${clientKind}\0${rawSession}`).digest('hex').slice(0, 32)}`;
}

function flatId(value, fallback) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[/\\.]+/g, '_')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

function wakeSessionPaths(input, env = process.env) {
  if (!sessionValue(input, env)) return null;
  const sessionKey = sessionKeyFor(input, env);
  const sessionDir = path.join(resolveHiveHome(env), 'wake', 'sessions', flatId(sessionKey, 'unknown-session'));
  return Object.freeze({
    sessionKey,
    sessionDir,
    pendingFile: path.join(sessionDir, 'pending-notifications.jsonl'),
    hivesDir: path.join(sessionDir, 'hives'),
    tasksDir: path.join(sessionDir, 'tasks'),
    hiveDoneFile: (hiveId) => path.join(sessionDir, 'hives', `${flatId(hiveId, 'unknown-hive')}.done`),
    taskDoneFile: (taskId) => path.join(sessionDir, 'tasks', `${flatId(taskId, 'unknown-task')}.done`),
  });
}

module.exports = {
  stringValue,
  resolveHiveHome,
  sessionValue,
  sessionKeyFor,
  flatId,
  wakeSessionPaths,
};
