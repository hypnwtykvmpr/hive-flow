import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { collectSwarm } from '../statusline/collectors/swarm.js';
import { resolveProjectScope } from '../statusline/project-scope.js';

export type ProgressAuthorityClassification =
  | 'progressing'
  | 'stalled'
  | 'waiting-for-human'
  | 'insufficient-evidence';

export type ProgressAuthorityConfidence = 'low' | 'medium' | 'high';

export interface RouterEvidence {
  available: boolean;
  notesScanned: number;
  latestPath?: string;
  latestMtimeMs?: number;
  humanGateMtimeMs?: number;
  addressedAgent?: string;
  concreteAction: boolean;
  humanGate: boolean;
  pushHeld: boolean;
  continuationAfterGate: boolean;
  excerpt?: string;
}

export interface GitEvidence {
  available: boolean;
  head?: string;
  branchLine?: string;
  dirtyFiles: number;
  ahead?: number;
  behind?: number;
  error?: string;
}

export interface KnotEvidence {
  available: boolean;
  statePath?: string;
  stateMtimeMs?: number;
  inProgress: number;
  open: number;
  closed: number;
  malformed: number;
  stale: boolean;
  error?: string;
}

export interface SwarmEvidence {
  available: boolean;
  alive: number;
  executing: number;
  freshness?: string;
  error?: string;
}

export interface TaskEvidence {
  available: boolean;
  runningLive: number;
  runningNoPid: number;
  runningDead: number;
  completedResults: number;
  failedResults: number;
  malformed: number;
}

export interface HiveFlowTaskProcessSnapshot {
  alive?: boolean;
  state?: string;
  cpuTimeMs?: number;
}

export interface HiveFlowTaskLivenessPrior {
  observedAtMs: number;
  eventSize: number;
  lastEventTs?: string;
  processSnapshot?: HiveFlowTaskProcessSnapshot | null;
  stableObservationCount?: number;
}

export interface HiveFlowTaskLivenessOptions {
  tasksDir?: string;
  taskId?: string;
  nowMs?: number;
  processSnapshot?: HiveFlowTaskProcessSnapshot | null;
  prior?: HiveFlowTaskLivenessPrior | null;
  idleStallMs?: number;
  minStableObservations?: number;
}

export interface HiveFlowTaskLivenessResult {
  status: 'unknown' | 'completed' | 'progressing' | 'in_flight' | 'orphaned' | 'observing' | 'stalled_review';
  reason: string;
  hung: boolean;
  shouldTerminate: boolean;
  taskId: string;
  signals: {
    resultPresent: boolean;
    eventFilePresent: boolean;
    eventAdvanced: boolean;
    providerRequestInFlight: boolean;
    processAlive: boolean;
    processDead: boolean;
    processCpuAdvanced: boolean;
    silentForMs: number | null;
    stableObservationCount: number;
  };
  nextPrior: HiveFlowTaskLivenessPrior;
}

export interface ProgressAuthoritySnapshot {
  nowMs: number;
  observedAt: string;
  cwd: string;
  projectRoot: string;
  agent?: string;
  sessionId?: string;
  router: RouterEvidence;
  git: GitEvidence;
  knots: KnotEvidence;
  swarm: SwarmEvidence;
  tasks: TaskEvidence;
}

export interface ProgressAuthorityResult {
  classification: ProgressAuthorityClassification;
  confidence: ProgressAuthorityConfidence;
  observedAt: string;
  projectRoot: string;
  authority: {
    present: boolean;
    sources: string[];
    missing: string[];
  };
  evidence: {
    router: RouterEvidence;
    git: GitEvidence;
    knots: KnotEvidence;
    swarm: SwarmEvidence;
    tasks: TaskEvidence;
  };
  reasons: string[];
}

export interface CollectProgressAuthorityOptions {
  cwd?: string;
  agent?: string;
  sessionId?: string;
  nowMs?: number;
}

const ROUTER_DIR = ['.hive-flow', 'data', 'tmux-router'] as const;
const TASKS_DIR = ['.hive-flow', 'tasks'] as const;
const KNOTS_STATE = ['.knots', 'cache', 'state.sqlite'] as const;
const MAX_ROUTER_NOTES = 40;
const MAX_NOTE_BYTES = 64 * 1024;
const MAX_EXCERPT_CHARS = 500;
const MAX_TASK_FILES = 1_000;
const KNOTS_STALE_MS = 60 * 60 * 1000;
const RECENT_ROUTER_MS = 15 * 60 * 1000;
const DEFAULT_TASK_STALL_REVIEW_MS = 30 * 60 * 1000;

const REDACTED = '[REDACTED]';
const SECRET_VALUE_PATTERNS = [
  /\b(?:sk|or)-[A-Za-z0-9._-]{12,}\b/g,
  /\b(?:ghp|github_pat|hf|xoxb)_[A-Za-z0-9_]{12,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi,
  /\b[A-Z][A-Z0-9_]{2,}\s*=\s*\S{6,}\b/g,
  /(?<![A-Za-z0-9+/_-])(?:[A-Za-z0-9+/]{40,}={0,2}|[A-Za-z0-9_-]{40,})(?![A-Za-z0-9+/_-])/g,
];

export function redactClassifierString(value: unknown): string {
  let rendered = String(value);
  for (const pattern of SECRET_VALUE_PATTERNS) {
    rendered = rendered.replace(pattern, REDACTED);
  }
  return rendered.slice(0, MAX_EXCERPT_CHARS);
}

function safeError(error: unknown): string {
  return redactClassifierString(error instanceof Error ? error.message : String(error));
}

function readBoundedText(path: string, maxBytes: number): string | undefined {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > maxBytes) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function isPidDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return Boolean(error
      && typeof error === 'object'
      && 'code' in error
      && String((error as { code?: unknown }).code) === 'ESRCH');
  }
}

function finitePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function hasConcreteAction(text: string, agent?: string): boolean {
  const lower = text.toLowerCase();
  const agentPattern = agent ? new RegExp(`to-${agent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : undefined;
  const agentPrompt = agent ? ` ${agent.toLowerCase()}:` : '';
  return /handoff ready|ready for .*verify|ready_for|implement|verify|review|execute|go\.|next slice|read .*to-/i.test(text)
    && (!agentPattern || agentPattern.test(text) || lower.includes(agentPrompt));
}

function hasResultOrContinuation(text: string, agent?: string): boolean {
  const lower = text.toLowerCase();
  const agentMention = agent ? lower.includes(`to-${agent.toLowerCase()}`) || lower.includes(`${agent.toLowerCase()} result`) : true;
  return agentMention
    && /result ready|verified|accepted|committed|closed|done|continue|proceed|next/i.test(text);
}

function hasHumanGate(text: string): boolean {
  return /waiting for human|human-only|true human gate|push awaits the human|no further action|queue complete|push held/i.test(text);
}

function hasPushHeld(text: string): boolean {
  return /push held|push awaits|no push|push is human-only/i.test(text);
}

function addressedAgentFromName(path: string): string | undefined {
  const name = basename(path).toLowerCase();
  const match = name.match(/to-([a-z0-9_-]+)\.md$/);
  return match?.[1];
}

function collectRouterEvidence(projectRoot: string, agent: string | undefined, nowMs: number): RouterEvidence {
  const dir = join(projectRoot, ...ROUTER_DIR);
  if (!existsSync(dir)) {
    return {
      available: false,
      notesScanned: 0,
      concreteAction: false,
      humanGate: false,
      pushHeld: false,
      continuationAfterGate: false,
    };
  }

  let notePaths: string[] = [];
  try {
    notePaths = readdirSync(dir)
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => join(dir, entry));
  } catch {
    return {
      available: false,
      notesScanned: 0,
      concreteAction: false,
      humanGate: false,
      pushHeld: false,
      continuationAfterGate: false,
    };
  }

  const notes = notePaths
    .map((path) => {
      try {
        return { path, mtimeMs: statSync(path).mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is { path: string; mtimeMs: number } => entry !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_ROUTER_NOTES);

  let latestPath: string | undefined;
  let latestMtimeMs: number | undefined;
  let latestExcerpt: string | undefined;
  let addressedAgent: string | undefined;
  let concreteAction = false;
  let concreteActionMtimeMs: number | undefined;
  let humanGate = false;
  let pushHeld = false;
  let gateMtimeMs: number | undefined;
  let continuationMtimeMs: number | undefined;

  for (const note of notes) {
    const text = readBoundedText(note.path, MAX_NOTE_BYTES);
    if (text === undefined) continue;
    if (latestPath === undefined) {
      latestPath = note.path;
      latestMtimeMs = note.mtimeMs;
      latestExcerpt = redactClassifierString(text.replace(/\s+/g, ' ').trim());
      addressedAgent = addressedAgentFromName(note.path);
    }
    if (hasConcreteAction(text, agent)) {
      concreteAction = true;
      concreteActionMtimeMs = concreteActionMtimeMs === undefined
        ? note.mtimeMs
        : Math.max(concreteActionMtimeMs, note.mtimeMs);
    }
    if (hasPushHeld(text)) pushHeld = true;
    if (hasHumanGate(text)) {
      humanGate = true;
      gateMtimeMs = gateMtimeMs === undefined ? note.mtimeMs : Math.max(gateMtimeMs, note.mtimeMs);
    } else if (hasResultOrContinuation(text, agent)) {
      continuationMtimeMs = continuationMtimeMs === undefined
        ? note.mtimeMs
        : Math.max(continuationMtimeMs, note.mtimeMs);
    }
  }

  const recentConcreteAction = concreteAction
    && concreteActionMtimeMs !== undefined
    && nowMs - concreteActionMtimeMs <= RECENT_ROUTER_MS;

  return {
    available: notes.length > 0,
    notesScanned: notes.length,
    latestPath,
    latestMtimeMs,
    humanGateMtimeMs: gateMtimeMs,
    addressedAgent,
    concreteAction: recentConcreteAction,
    humanGate,
    pushHeld,
    continuationAfterGate: gateMtimeMs !== undefined
      && continuationMtimeMs !== undefined
      && continuationMtimeMs > gateMtimeMs,
    excerpt: latestExcerpt,
  };
}

function collectGitEvidence(projectRoot: string): GitEvidence {
  const status = spawnSync('git', ['status', '--short', '--branch'], {
    cwd: projectRoot,
    shell: false,
    timeout: 500,
    encoding: 'utf8',
    maxBuffer: 256 * 1024,
  });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    shell: false,
    timeout: 500,
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
  });

  if (status.error || status.status !== 0) {
    return {
      available: false,
      dirtyFiles: 0,
      error: safeError(status.error ?? status.stderr ?? `git status exited ${status.status}`),
    };
  }

  const lines = String(status.stdout || '').split(/\r?\n/).filter(Boolean);
  const branchLine = lines[0] ?? '';
  const ahead = Number(branchLine.match(/ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(branchLine.match(/behind (\d+)/)?.[1] ?? 0);

  return {
    available: true,
    head: head.status === 0 ? String(head.stdout || '').trim() : undefined,
    branchLine,
    dirtyFiles: Math.max(0, lines.length - 1),
    ahead,
    behind,
  };
}

function collectKnotEvidence(projectRoot: string, nowMs: number): KnotEvidence {
  const statePath = join(projectRoot, ...KNOTS_STATE);
  if (!existsSync(statePath)) {
    return { available: false, inProgress: 0, open: 0, closed: 0, malformed: 0, stale: true };
  }
  let mtimeMs = 0;
  try {
    const st = statSync(statePath);
    if (!st.isFile()) {
      return { available: false, statePath, inProgress: 0, open: 0, closed: 0, malformed: 0, stale: true };
    }
    mtimeMs = st.mtimeMs;
  } catch (error) {
    return {
      available: false,
      statePath,
      inProgress: 0,
      open: 0,
      closed: 0,
      malformed: 0,
      stale: true,
      error: safeError(error),
    };
  }

  const listed = spawnSync('kno', ['ls', '--json'], {
    cwd: projectRoot,
    shell: false,
    timeout: 1_000,
    encoding: 'utf8',
    maxBuffer: 512 * 1024,
  });
  if (listed.error || listed.status !== 0) {
    return {
      available: false,
      statePath,
      stateMtimeMs: mtimeMs,
      inProgress: 0,
      open: 0,
      closed: 0,
      malformed: 0,
      stale: nowMs - mtimeMs > KNOTS_STALE_MS,
      error: safeError(listed.error ?? listed.stderr ?? `kno ls exited ${listed.status}`),
    };
  }

  let inProgress = 0;
  let open = 0;
  let closed = 0;
  let malformed = 0;

  try {
    const rows = JSON.parse(String(listed.stdout || '[]'));
    if (!Array.isArray(rows)) {
      malformed++;
    } else {
      for (const row of rows) {
        if (!isObject(row)) {
          malformed++;
          continue;
        }
        const status = typeof row.state === 'string'
          ? row.state.toLowerCase()
          : typeof row.status === 'string'
            ? row.status.toLowerCase()
            : '';
        if (status === 'claimed' || status === 'in_progress' || status === 'in-progress' || status === 'working') {
          inProgress++;
        } else if (status === 'shipped' || status === 'closed' || status === 'done' || status === 'abandoned') {
          closed++;
        } else if (status === 'open' || status === 'ready' || status === 'blocked' || status === 'planned' || status === 'new') {
          open++;
        }
      }
    }
  } catch {
    malformed++;
  }

  return {
    available: true,
    statePath,
    stateMtimeMs: mtimeMs,
    inProgress,
    open,
    closed,
    malformed,
    stale: nowMs - mtimeMs > KNOTS_STALE_MS,
  };
}

async function collectSwarmEvidence(projectRoot: string, sessionId?: string): Promise<SwarmEvidence> {
  try {
    const swarm = await collectSwarm({ projectRoot, sessionId });
    return {
      available: swarm.freshness.state !== 'absent' && swarm.freshness.state !== 'error',
      alive: swarm.workersAlive + swarm.queensAlive,
      executing: swarm.workersExecuting + swarm.queensExecuting,
      freshness: swarm.freshness.state,
    };
  } catch (error) {
    return {
      available: false,
      alive: 0,
      executing: 0,
      error: safeError(error),
    };
  }
}

function collectTaskEvidence(projectRoot: string): TaskEvidence {
  const tasksDir = join(projectRoot, ...TASKS_DIR);
  if (!existsSync(tasksDir)) {
    return {
      available: false,
      runningLive: 0,
      runningNoPid: 0,
      runningDead: 0,
      completedResults: 0,
      failedResults: 0,
      malformed: 0,
    };
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(tasksDir).slice(0, MAX_TASK_FILES);
  } catch {
    return {
      available: false,
      runningLive: 0,
      runningNoPid: 0,
      runningDead: 0,
      completedResults: 0,
      failedResults: 0,
      malformed: 0,
    };
  }

  let runningLive = 0;
  let runningNoPid = 0;
  let runningDead = 0;
  let completedResults = 0;
  let failedResults = 0;
  let malformed = 0;

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const path = join(tasksDir, entry);
    const text = readBoundedText(path, MAX_NOTE_BYTES);
    if (text === undefined) {
      malformed++;
      continue;
    }
    const parsed = parseJsonObject(text);
    if (!parsed) {
      malformed++;
      continue;
    }

    if (entry.endsWith('.result.json')) {
      const status = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : '';
      if (status === 'failed' || parsed.success === false || parsed.error !== undefined) failedResults++;
      else completedResults++;
      continue;
    }

    const status = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : '';
    if (status !== 'running') continue;
    if (finitePositiveInteger(parsed.pid)) {
      if (isPidDefinitelyDead(parsed.pid)) runningDead++;
      else runningLive++;
    } else {
      runningNoPid++;
    }
  }

  return {
    available: true,
    runningLive,
    runningNoPid,
    runningDead,
    completedResults,
    failedResults,
    malformed,
  };
}

function parseTaskEventLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readTaskEvents(eventsFile: string): Record<string, unknown>[] {
  const text = readBoundedText(eventsFile, MAX_NOTE_BYTES * 4);
  if (text === undefined) return [];
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseTaskEventLine)
    .filter((event): event is Record<string, unknown> => event !== undefined);
}

function taskEventName(event: Record<string, unknown> | undefined): string {
  return typeof event?.event === 'string' ? event.event : '';
}

function taskEventTs(event: Record<string, unknown> | undefined): string {
  return typeof event?.ts === 'string' ? event.ts : '';
}

function taskEventTimestampMs(event: Record<string, unknown> | undefined): number {
  const parsed = Date.parse(taskEventTs(event));
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasProviderRequestInFlight(events: Record<string, unknown>[]): boolean {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = taskEventName(events[index]);
    if (event === 'provider_request_start') return true;
    if (event === 'provider_request_end' || event === 'provider_error') return false;
  }
  return false;
}

export function classifyHiveFlowTaskLiveness(
  options: HiveFlowTaskLivenessOptions = {},
): HiveFlowTaskLivenessResult {
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
  const nextPrior: HiveFlowTaskLivenessPrior = {
    observedAtMs: nowMs,
    eventSize,
    lastEventTs,
    processSnapshot,
    stableObservationCount,
  };

  function verdict(status: HiveFlowTaskLivenessResult['status'], reason: string): HiveFlowTaskLivenessResult {
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

function liveContinuationAfterGate(snapshot: ProgressAuthoritySnapshot): boolean {
  if (!snapshot.router.humanGate || snapshot.router.humanGateMtimeMs === undefined) return false;
  return snapshot.nowMs >= snapshot.router.humanGateMtimeMs
    && (snapshot.swarm.executing > 0 || snapshot.tasks.runningLive > 0);
}

function authoritySources(snapshot: ProgressAuthoritySnapshot): string[] {
  const sources: string[] = [];
  if (snapshot.router.concreteAction) sources.push('router');
  if (snapshot.knots.available && !snapshot.knots.stale && snapshot.knots.inProgress > 0) sources.push('knots-state');
  if (snapshot.swarm.executing > 0) sources.push('swarm-live');
  if (snapshot.tasks.runningLive > 0 || snapshot.tasks.runningNoPid > 0) sources.push('task-tracking');
  if (snapshot.tasks.completedResults > 0 || snapshot.tasks.failedResults > 0) sources.push('task-result');
  return [...new Set(sources)];
}

function missingAuthority(snapshot: ProgressAuthoritySnapshot): string[] {
  const missing: string[] = [];
  if (!snapshot.router.available) missing.push('router');
  if (!snapshot.knots.available || snapshot.knots.stale) missing.push('knots-state');
  if (!snapshot.swarm.available) missing.push('swarm');
  if (!snapshot.tasks.available) missing.push('tasks');
  return missing;
}

function sanitizedRouterEvidence(router: RouterEvidence): RouterEvidence {
  return {
    ...router,
    excerpt: router.excerpt !== undefined ? redactClassifierString(router.excerpt) : undefined,
  };
}

function sanitizedGitEvidence(git: GitEvidence): GitEvidence {
  return {
    ...git,
    error: git.error !== undefined ? redactClassifierString(git.error) : undefined,
  };
}

function sanitizedSwarmEvidence(swarm: SwarmEvidence): SwarmEvidence {
  return {
    ...swarm,
    error: swarm.error !== undefined ? redactClassifierString(swarm.error) : undefined,
  };
}

export function classifyProgressAuthority(snapshot: ProgressAuthoritySnapshot): ProgressAuthorityResult {
  const sources = authoritySources(snapshot);
  const authorityPresent = sources.length > 0;
  const newerContinuation = snapshot.router.continuationAfterGate || liveContinuationAfterGate(snapshot);
  const reasons: string[] = [];
  let classification: ProgressAuthorityClassification;
  let confidence: ProgressAuthorityConfidence = 'medium';

  if (snapshot.router.humanGate && !newerContinuation) {
    classification = 'waiting-for-human';
    confidence = 'high';
    reasons.push('explicit human gate with no newer continuation evidence');
  } else if (!authorityPresent) {
    classification = 'insufficient-evidence';
    confidence = 'high';
    reasons.push('no positive authority source found');
  } else if (snapshot.swarm.executing > 0 || snapshot.tasks.runningLive > 0) {
    classification = 'progressing';
    confidence = 'high';
    reasons.push('live execution observed');
  } else if (snapshot.tasks.runningNoPid > 0 || snapshot.router.continuationAfterGate || snapshot.router.concreteAction) {
    classification = 'progressing';
    confidence = 'medium';
    reasons.push('active handoff or pid-less running task observed');
  } else {
    classification = 'stalled';
    confidence = snapshot.git.available ? 'medium' : 'low';
    reasons.push('authority exists but no live continuation is visible');
  }

  return {
    classification,
    confidence,
    observedAt: snapshot.observedAt,
    projectRoot: snapshot.projectRoot,
    authority: {
      present: authorityPresent,
      sources,
      missing: missingAuthority(snapshot),
    },
    evidence: {
      router: sanitizedRouterEvidence(snapshot.router),
      git: sanitizedGitEvidence(snapshot.git),
      knots: snapshot.knots,
      swarm: sanitizedSwarmEvidence(snapshot.swarm),
      tasks: snapshot.tasks,
    },
    reasons: reasons.map(redactClassifierString),
  };
}

export async function collectProgressAuthoritySnapshot(
  options: CollectProgressAuthorityOptions = {},
): Promise<ProgressAuthoritySnapshot> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const scope = resolveProjectScope({ cwd });
  const projectRoot = scope.projectRoot;
  const nowMs = options.nowMs ?? Date.now();
  const observedAt = new Date(nowMs).toISOString();

  const [router, git, knots, swarm, tasks] = await Promise.all([
    Promise.resolve(collectRouterEvidence(projectRoot, options.agent, nowMs)),
    Promise.resolve(collectGitEvidence(projectRoot)),
    Promise.resolve(collectKnotEvidence(projectRoot, nowMs)),
    collectSwarmEvidence(projectRoot, options.sessionId),
    Promise.resolve(collectTaskEvidence(projectRoot)),
  ]);

  return {
    nowMs,
    observedAt,
    cwd,
    projectRoot,
    agent: options.agent,
    sessionId: options.sessionId,
    router,
    git,
    knots,
    swarm,
    tasks,
  };
}

export async function classifyCurrentProgressAuthority(
  options: CollectProgressAuthorityOptions = {},
): Promise<ProgressAuthorityResult> {
  return classifyProgressAuthority(await collectProgressAuthoritySnapshot(options));
}
