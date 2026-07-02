'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// hiveflow-task-liveness — SHARED SOURCE OF TRUTH for Hive Flow task liveness
// classification (hive-flow-8b69, Option B, Slice 3).
//
// Dependency-free CommonJS so it can be consumed two ways from ONE implementation:
//   1. `progress-authority-classifier.ts` (ESM) re-exports `classifyHiveFlowTaskLiveness`
//      and its types for MCP/CLI consumers (built to `cli/dist/src/progress/`, where the
//      CLI build copies this `.cjs` so the compiled re-export resolves at runtime).
//   2. The standalone `scripts/flow-watchdog.cjs` `require()`s this module directly from
//      source (synchronous, no build dependency).
//
// Behavior is byte-faithful to the prior `progress-authority-classifier.ts`
// implementation. The default stall-review threshold stays at the tracked 30-minute
// `DEFAULT_TASK_STALL_REVIEW_MS`; callers that want a different threshold (e.g. the
// watchdog's 8-minute window) pass `idleStallMs` explicitly.
// ─────────────────────────────────────────────────────────────────────────────

const { join } = require('node:path');
const { existsSync, readFileSync, statSync } = require('node:fs');

const TASKS_DIR = ['.hive-flow', 'tasks'];
const MAX_NOTE_BYTES = 64 * 1024;
const DEFAULT_TASK_STALL_REVIEW_MS = 30 * 60 * 1000;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readBoundedText(path, maxBytes) {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > maxBytes) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function parseTaskEventLine(line) {
  try {
    const parsed = JSON.parse(line);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readTaskEvents(eventsFile) {
  const text = readBoundedText(eventsFile, MAX_NOTE_BYTES * 4);
  if (text === undefined) return [];
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseTaskEventLine)
    .filter((event) => event !== undefined);
}

function taskEventName(event) {
  return typeof event?.event === 'string' ? event.event : '';
}

function taskEventTs(event) {
  return typeof event?.ts === 'string' ? event.ts : '';
}

function taskEventTimestampMs(event) {
  const parsed = Date.parse(taskEventTs(event));
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasProviderRequestInFlight(events) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = taskEventName(events[index]);
    if (event === 'provider_request_start') return true;
    if (event === 'provider_request_end' || event === 'provider_error') return false;
  }
  return false;
}

/**
 * Classify the liveness of a Hive Flow task from its tracking artifacts and a prior
 * observation. Never terminates on elapsed time alone: a completed result wins over a
 * stale/absent PID, progress signals reset the stall counter, an in-flight provider
 * request is not "stuck", and repeated no-progress observations escalate to a manual
 * review rather than a kill.
 *
 * @param {object} [options]
 * @returns {object} liveness result including status, reason, signals, and nextPrior.
 */
function classifyHiveFlowTaskLiveness(options = {}) {
  const taskId = String(options.taskId ?? '').trim();
  const tasksDir = options.tasksDir ?? join(process.cwd(), ...TASKS_DIR);
  const nowMs = options.nowMs ?? Date.now();
  const prior = options.prior ?? null;
  const processSnapshot = options.processSnapshot ?? null;
  const idleStallMs = options.idleStallMs ?? DEFAULT_TASK_STALL_REVIEW_MS;
  const minStableObservations = options.minStableObservations ?? 3;
  const resultFile = join(tasksDir, `${taskId}.result.json`);
  const eventsFile = join(tasksDir, `${taskId}.events.jsonl`);
  const resultPresent = taskId.length > 0 && existsSync(resultFile);
  let eventSize = 0;
  let eventMtimeMs = 0;
  try {
    const stat = statSync(eventsFile);
    if (stat.isFile()) {
      eventSize = stat.size;
      eventMtimeMs = stat.mtimeMs;
    }
  } catch {
    // Absence of an event file is missing evidence, not hung evidence.
  }

  const events = taskId.length > 0 ? readTaskEvents(eventsFile) : [];
  const lastEvent = events[events.length - 1];
  const lastEventTs = taskEventTs(lastEvent);
  const lastEventMs = taskEventTimestampMs(lastEvent);
  const priorEventTsMs = Date.parse(String(prior?.lastEventTs ?? ''));
  const eventAdvanced = Boolean(prior)
    && (eventSize > Number(prior?.eventSize ?? 0)
      || (lastEventMs > 0 && Number.isFinite(priorEventTsMs) && lastEventMs > priorEventTsMs));
  const currentCpu = Number(processSnapshot?.cpuTimeMs);
  const priorCpu = Number(prior?.processSnapshot?.cpuTimeMs);
  const processCpuAdvanced = Boolean(prior)
    && Number.isFinite(currentCpu)
    && Number.isFinite(priorCpu)
    && currentCpu > priorCpu;
  const providerRequestInFlight = hasProviderRequestInFlight(events);
  const processAlive = processSnapshot?.alive === true;
  const processDead = processSnapshot?.alive === false;
  const lastProgressMs = lastEventMs || eventMtimeMs || 0;
  const silentForMs = lastProgressMs > 0 ? Math.max(0, nowMs - lastProgressMs) : null;
  const noProgressThisObservation = Boolean(prior) && !eventAdvanced && !processCpuAdvanced && !resultPresent;
  const stableObservationCount = noProgressThisObservation
    ? Number(prior?.stableObservationCount ?? 0) + 1
    : 0;

  const signals = {
    resultPresent,
    eventFilePresent: eventSize > 0,
    eventAdvanced,
    providerRequestInFlight,
    processAlive,
    processDead,
    processCpuAdvanced,
    silentForMs,
    stableObservationCount,
  };
  const nextPrior = {
    observedAtMs: nowMs,
    eventSize,
    lastEventTs,
    processSnapshot,
    stableObservationCount,
  };

  function verdict(status, reason) {
    return {
      status,
      reason,
      hung: false,
      shouldTerminate: false,
      taskId,
      signals,
      nextPrior,
    };
  }

  if (!taskId) return verdict('unknown', 'No task id was supplied; liveness cannot be classified.');
  if (resultPresent) return verdict('completed', 'Result file is present; task completed.');
  if (eventAdvanced || processCpuAdvanced) {
    return verdict('progressing', 'Event log or process CPU advanced since the previous observation.');
  }
  if (providerRequestInFlight) {
    return verdict('in_flight', 'A provider request is in flight; elapsed time alone is not hung evidence.');
  }
  if (processDead) {
    return verdict('orphaned', 'Process is not alive and no result file exists; recovery/reconciliation is needed.');
  }
  if (!prior) {
    return verdict('observing', 'First observation only; repeated no-progress evidence is required.');
  }
  if (stableObservationCount >= minStableObservations
    && typeof silentForMs === 'number'
    && silentForMs >= idleStallMs) {
    return verdict('stalled_review', 'Repeated no-progress observations with no result file require manual review, not elapsed-time termination.');
  }
  return verdict('observing', 'No conclusive stall evidence yet; keep observing.');
}

module.exports = {
  classifyHiveFlowTaskLiveness,
  DEFAULT_TASK_STALL_REVIEW_MS,
};
