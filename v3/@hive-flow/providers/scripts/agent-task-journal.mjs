import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { basename, join } from 'path';

export const TASK_JOURNAL_EVENTS = Object.freeze([
  'dispatch',
  'bridge_start',
  'provider_request_start',
  'provider_request_end',
  'provider_error',
  'tool_exec_start',
  'tool_exec_end',
  'result_written',
  'result_consumed',
  'rewake_notified',
  'terminate',
]);

export const TASK_JOURNAL_TERMINAL_EVENTS = Object.freeze([
  'result_written',
  'terminate',
]);

const EVENT_SET = new Set(TASK_JOURNAL_EVENTS);
const TERMINAL_EVENT_SET = new Set(TASK_JOURNAL_TERMINAL_EVENTS);
const REDACTED = '[REDACTED]';

const ALLOWED_META_KEYS = new Set([
  'alreadyConsumed',
  'classification',
  'contentLength',
  'durationMs',
  'errorClass',
  'finishReason',
  'historyLength',
  'httpStatus',
  'inputTokens',
  'iteration',
  'iterations',
  'messageCount',
  'model',
  'outputTokens',
  'reason',
  'resultBytes',
  'status',
  'statusCode',
  'success',
  'timeoutMs',
  'tool',
  'toolName',
  'truncated',
  'truncatedBytes',
  'originalBytes',
]);

const SECRET_KEY_PATTERN = /(?:api[_-]?key|authorization|bearer|cookie|credential|kek|password|secret|token)/i;
const SECRET_VALUE_PATTERNS = [
  /\b(?:sk|or)-[A-Za-z0-9._-]{12,}\b/g,
  /\b(?:ghp|github_pat|hf|xoxb)_[A-Za-z0-9_]{12,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi,
  /\b[A-Z][A-Z0-9_]{2,}\s*=\s*\S{6,}\b/g,
  /(?<![A-Za-z0-9+/_-])(?:[A-Za-z0-9+/]{40,}={0,2}|[A-Za-z0-9_-]{40,})(?![A-Za-z0-9+/_-])/g,
];

function isScalar(value) {
  return value == null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isValidTaskId(taskId) {
  return typeof taskId === 'string'
    && taskId.length > 0
    && taskId.length <= 128
    && basename(taskId) === taskId
    && /^[A-Za-z0-9._-]+$/.test(taskId);
}

function redactString(value) {
  let rendered = String(value);
  for (const pattern of SECRET_VALUE_PATTERNS) {
    rendered = rendered.replace(pattern, REDACTED);
  }
  return rendered.slice(0, 500);
}

function redactScalar(key, value) {
  if (SECRET_KEY_PATTERN.test(key)) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (value == null) return undefined;
  return undefined;
}

export function classifyJournalError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const code = String(err?.code || '').toLowerCase();
  const status = Number(err?.status || err?.statusCode || err?.response?.status || 0);
  if (status === 401 || status === 403 || code.includes('auth') || msg.includes('auth') || msg.includes('unauthorized')) {
    return 'auth';
  }
  if (status === 429 || code.includes('rate') || msg.includes('rate limit') || msg.includes('too many requests')) {
    return 'rate';
  }
  if (msg.includes('quota') || msg.includes('insufficient credits') || msg.includes('billing')) {
    return 'quota';
  }
  if (code.includes('overflow') || code.includes('e2big') || msg.includes('context') || msg.includes('token limit') || msg.includes('too large')) {
    return 'overflow';
  }
  return 'other';
}

export function redactEventMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const redacted = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!ALLOWED_META_KEYS.has(key)) continue;
    if (!isScalar(value)) continue;
    const safeValue = redactScalar(key, value);
    if (safeValue !== undefined) redacted[key] = safeValue;
  }
  return redacted;
}

function safeTopLevelString(value) {
  return typeof value === 'string' && value.length > 0 ? redactString(value) : undefined;
}

export function normalizeTaskJournalEvent(input) {
  if (!input || typeof input !== 'object') return null;
  const event = typeof input.event === 'string' ? input.event : '';
  const taskId = typeof input.taskId === 'string' ? input.taskId : '';
  if (!EVENT_SET.has(event) || !isValidTaskId(taskId)) return null;

  const normalized = {
    ts: new Date().toISOString(),
    event,
    taskId,
  };

  const agentId = safeTopLevelString(input.agentId);
  const provider = safeTopLevelString(input.provider);
  const model = safeTopLevelString(input.model);
  if (agentId) normalized.agentId = agentId;
  if (provider) normalized.provider = provider;
  if (model) normalized.model = model;
  if (Number.isInteger(input.pid) && input.pid > 0) normalized.pid = input.pid;

  const meta = redactEventMeta(input.meta);
  if (Object.keys(meta).length > 0) normalized.meta = meta;
  return normalized;
}

export function serializeTaskJournalEvent(input) {
  const event = normalizeTaskJournalEvent(input);
  return event ? JSON.stringify(event) : null;
}

export function taskJournalPath(tasksDir, taskId) {
  if (typeof tasksDir !== 'string' || tasksDir.length === 0 || !isValidTaskId(taskId)) {
    throw new Error('invalid task journal path input');
  }
  return join(tasksDir, `${taskId}.events.jsonl`);
}

function hasTerminalEvent(path) {
  try {
    if (!existsSync(path)) return false;
    const raw = readFileSync(path, 'utf8');
    return raw.split(/\r?\n/).some((line) => {
      if (!line.trim()) return false;
      try {
        const parsed = JSON.parse(line);
        return TERMINAL_EVENT_SET.has(parsed?.event);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function appendTaskJournalEvent(input) {
  try {
    const event = normalizeTaskJournalEvent(input);
    if (!event) return false;
    const path = taskJournalPath(input.tasksDir, event.taskId);
    if (TERMINAL_EVENT_SET.has(event.event) && hasTerminalEvent(path)) {
      return false;
    }
    mkdirSync(input.tasksDir, { recursive: true });
    appendFileSync(path, JSON.stringify(event) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function replayTaskJournalEvents(linesOrEvents) {
  const parseReplayEntry = (entry) => {
    try {
      const parsed = typeof entry === 'string' ? JSON.parse(entry) : entry;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const events = Array.isArray(linesOrEvents)
    ? linesOrEvents.map(parseReplayEntry).filter(Boolean)
    : String(linesOrEvents || '')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(parseReplayEntry)
      .filter(Boolean);

  let previousTs = '';
  let monotonic = true;
  let terminalCount = 0;
  for (const event of events) {
    const ts = String(event.ts || '');
    if (previousTs && ts < previousTs) monotonic = false;
    previousTs = ts;
    if (TERMINAL_EVENT_SET.has(event.event)) terminalCount += 1;
  }

  return {
    events,
    monotonic,
    terminalCount,
    valid: monotonic && terminalCount <= 1,
  };
}
