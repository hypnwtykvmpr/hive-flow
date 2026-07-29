// cli/src/statusline/claude-activity-state.ts
//
// hive-flow-f16a — generation-scoped Claude activity/task tracker, ported from
// the verified portable tracker (`statusline-portable/src/statusline-state.cjs`)
// into canonical Hive Flow source.
//
// Hook processes never coordinate through shared arrays or locks. Activity is
// one replace-on-write record; every background identity gets independent
// start/stop records and a stop tombstone always wins. The renderer reads only
// records whose generation matches generation.json — missing, malformed, or
// generation-mismatched state is UNTRUSTED and yields no projection, so the
// statusline omits activity rather than fabricating "Idle".
//
// Files under <claude-data>/statusline-state/<validated-session-id>/:
//   generation.json                    (authoritative; atomic temp+rename only)
//   generation.claim                   (transient; published by hard link)
//   activity.json
//   agents/{start,stop}/<sha256(identity)>.json
//   shells/{start,stop}/<sha256(identity)>.json
//   tasks/{ack,snapshot}.json
//
// LATE-ATTACH (f16a amendment). The portable tracker initializes only on
// SessionStart, so a session already running when hooks are installed would
// never initialize and activity would be absent forever. A validated,
// session-scoped event may therefore create a missing generation — but only via
// the create-once protocol below, and it fabricates nothing: no historical
// tools, background identities, tasks, or permission state.
//
// CLAIM PROTOCOL (create-once winner). The claim is transient and is NEVER the
// authoritative record:
//   1. Stage the COMPLETE claim record in a unique staging file.
//   2. Publish it to the canonical claim path with an atomic, no-clobber
//      `linkSync`. Publishing an already-complete inode means a crash can never
//      leave a malformed canonical claim (a direct `writeFileSync(...,'wx')`
//      can, and that would wedge the session permanently).
//   3. Remove the staging file on every success/failure path.
// Losers re-read the winner's generation under a bounded retry. A dead owner is
// recovered through a rename-CAS so a live writer's claim can never be deleted.
// Any ambiguity fails closed: write nothing and let a later event retry.
//
// Every path is synchronous, bounded by Claude Code's hook timeout, tolerant of
// malformed/torn files, and the hook entrypoint always exits 0.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Roots + validation
// ---------------------------------------------------------------------------

/** Honored ONLY with NODE_ENV=test so tests can never touch real Claude data. */
function testRoot(): string | null {
  if (process.env.NODE_ENV !== 'test') return null;
  const raw = process.env.CLAUDE_STATUSLINE_TEST_ROOT;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function stateDir(): string {
  const root = testRoot();
  return root ? join(root, 'state') : join(homedir(), '.claude', 'statusline-state');
}

function tasksDir(): string {
  const root = testRoot();
  return root ? join(root, 'tasks') : join(homedir(), '.claude', 'tasks');
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const GENERATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const OWNER_TOKEN = /^[a-f0-9]{32}$/;

/** SessionStart sources that legitimately begin a fresh generation. */
const FRESH_SOURCES = new Set(['startup', 'resume', 'clear', 'fork']);
/** Distinct, auditable source recording that a generation began via late-attach. */
const LATE_ATTACH_SOURCE = 'late-attach';
const ALL_SOURCES = new Set([...FRESH_SOURCES, LATE_ATTACH_SOURCE]);

const VERIFIED_NOTIFICATIONS = new Set([
  'permission_prompt',
  'idle_prompt',
  'auth_success',
  'elicitation_dialog',
  'elicitation_complete',
  'elicitation_response',
  'agent_needs_input',
  'agent_completed',
]);
const NEEDS_HUMAN_NOTIFICATIONS = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'agent_needs_input',
]);

export type ActivityState = 'idle' | 'thinking' | 'working' | 'needs-human';
export type ProjectedState = ActivityState | 'waiting';

export interface TaskView {
  readonly source: 'live' | 'snapshot';
  readonly total: number;
  readonly completed: number;
}

export interface SessionProjection {
  readonly generation: string;
  readonly state: ProjectedState;
  readonly tool: string | null;
  readonly pendingAgents: number;
  readonly bgShells: number;
  readonly tasks: TaskView | null;
}

function validSessionId(value: unknown): string | null {
  return typeof value === 'string' && SESSION_ID.test(value) ? value : null;
}

function validIdentity(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 ? value : null;
}

function sessionDir(sessionId: string): string {
  return join(stateDir(), sessionId);
}

function claimPath(dir: string): string {
  return join(dir, 'generation.claim');
}

// ---------------------------------------------------------------------------
// Fault injection (tests only) + primitive I/O
// ---------------------------------------------------------------------------

/**
 * Test-only crash points. Used by the A25 crash-recovery regressions to
 * terminate a writer at an exact boundary. `process.exit` deliberately skips
 * `finally` blocks so an abandoned staging file is modelled realistically.
 */
function testFault(point: string): void {
  if (!testRoot()) return;
  if (process.env.CLAUDE_STATUSLINE_TEST_FAULT === point) process.exit(91);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Publish a COMPLETE record. Readers see either the previous state or the whole
 * new file — never a partial one.
 */
function atomicWrite(file: string, value: unknown): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
    testFault(`after-temp:${basename(file)}`);
    try {
      renameSync(tmp, file);
    } catch {
      // Windows may reject a replacing rename when the destination exists.
      // Removing then renaming can briefly omit a record but can never expose
      // partial JSON; a missing record is explicitly untrusted/omitted.
      try {
        rmSync(file, { force: true });
      } catch {
        /* omit on failure */
      }
      renameSync(tmp, file);
    }
    testFault(`after-publish:${basename(file)}`);
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* killed writers may leave temp files */
    }
  }
}

/** Bounded, non-spinning sleep so losers can await the winner's publish. */
function sleepMs(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* environments without SharedArrayBuffer simply re-read immediately */
  }
}

/**
 * Liveness of a claim owner.
 *   true      -> the process exists (EPERM also means "exists")
 *   false     -> definitively gone (ESRCH)
 *   undefined -> ambiguous; callers MUST fail closed
 */
function pidAlive(pid: unknown): boolean | undefined {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Generation + claim
// ---------------------------------------------------------------------------

interface GenerationMarker {
  readonly generation: string;
  readonly source: string;
}

/** Pure validator shared by the sync (write) and async (render) read paths. */
function validateGeneration(value: Record<string, unknown> | null): GenerationMarker | null {
  if (!value || value.schema !== 1) return null;
  const generation = value.generation;
  if (typeof generation !== 'string' || !GENERATION_ID.test(generation)) return null;
  if (typeof value.source !== 'string' || !ALL_SOURCES.has(value.source)) return null;
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return null;
  return { generation, source: value.source };
}

function loadGeneration(dir: string): GenerationMarker | null {
  return validateGeneration(asRecord(readJson(join(dir, 'generation.json'))));
}

function newGeneration(source: string): Record<string, unknown> {
  return {
    schema: 1,
    generation: randomUUID().replace(/-/g, ''),
    source,
    createdAt: Date.now(),
  };
}

/**
 * Stage a complete claim record, then publish it with an atomic no-clobber hard
 * link. Returns the owner token when this process won the claim, else null.
 *
 * The canonical claim path is NEVER written directly: a crash mid-write would
 * leave a permanently malformed claim, which the liveness check would treat as
 * ambiguous forever and wedge the session.
 */
function tryAcquireClaim(dir: string): string | null {
  mkdirSync(dir, { recursive: true });
  const owner = randomBytes(16).toString('hex');
  const staging = join(dir, `.generation.claim.${process.pid}.${randomBytes(8).toString('hex')}.stage`);
  const record = JSON.stringify({ schema: 1, owner, pid: process.pid, ts: Date.now() });
  try {
    writeFileSync(staging, record, { encoding: 'utf8', flag: 'wx' });
    // Boundary 1: crash here leaves NO canonical claim; a later event sees no
    // claim at all and initializes normally.
    testFault('after-stage');
    try {
      linkSync(staging, claimPath(dir));
    } catch {
      // EEXIST: another writer holds the claim. Any other link failure fails
      // closed for this attempt.
      return null;
    }
    // Boundary 2: crash here leaves a COMPLETE dead-owner claim; a later event
    // recovers it through the rename-CAS below.
    testFault('after-claim');
    return owner;
  } catch {
    return null;
  } finally {
    try {
      rmSync(staging, { force: true });
    } catch {
      /* best effort on every path */
    }
  }
}

function releaseClaim(dir: string, owner: string): void {
  const value = asRecord(readJson(claimPath(dir)));
  if (!value || value.owner !== owner) return; // never drop someone else's claim
  try {
    rmSync(claimPath(dir), { force: true });
  } catch {
    /* a leftover claim is harmless: consulted only when no generation exists */
  }
}

type ReclaimOutcome = 'reclaimed' | 'retry' | 'ambiguous';

/**
 * Recover an abandoned claim WITHOUT ever deleting a live writer's claim.
 * `renameSync` is the atomic arbiter: exactly one process can move a given
 * claim away and thereby earn the right to reclaim.
 */
function reclaimDeadClaim(dir: string): ReclaimOutcome {
  const value = asRecord(readJson(claimPath(dir)));
  if (!value || value.schema !== 1) return 'ambiguous';
  if (typeof value.owner !== 'string' || !OWNER_TOKEN.test(value.owner)) return 'ambiguous';
  if (pidAlive(value.pid) !== false) return 'ambiguous'; // alive or unknown -> fail closed

  const dead = `${claimPath(dir)}.${randomBytes(8).toString('hex')}.dead`;
  try {
    renameSync(claimPath(dir), dead);
  } catch {
    // ENOENT: someone else already moved it. Restart the protocol.
    return 'retry';
  }
  try {
    rmSync(dead, { force: true });
  } catch {
    /* orphaned dead file is inert */
  }
  return 'reclaimed';
}

/** Bounded wait for a winner's generation publication. */
function awaitGeneration(dir: string): string | null {
  for (let i = 0; i < 5; i++) {
    const marker = loadGeneration(dir);
    if (marker) return marker.generation;
    sleepMs(2);
  }
  return loadGeneration(dir)?.generation ?? null;
}

/**
 * Resolve the generation for a validated session, creating one via late-attach
 * when absent. Returns null when the caller must fail closed and write nothing.
 */
function ensureGeneration(dir: string, sessionId: string): string | null {
  const existing = loadGeneration(dir);
  if (existing) return existing.generation;

  for (let attempt = 0; attempt < 3; attempt++) {
    const owner = tryAcquireClaim(dir);
    if (owner) {
      const marker = newGeneration(LATE_ATTACH_SOURCE);
      atomicWrite(join(dir, 'generation.json'), marker);
      const generation = String(marker.generation);
      // Baseline only. The triggering event writes the truthful state next, and
      // no historical tools/identities/permission state are invented.
      writeActivity(dir, generation, 'idle');
      // Acknowledge — never replay — pre-existing tasks, so late-attach cannot
      // resurrect task history this session never observed.
      acknowledgeTasks(dir, generation, sessionId);
      releaseClaim(dir, owner);
      return generation;
    }

    const adopted = awaitGeneration(dir);
    if (adopted) return adopted;

    const outcome = reclaimDeadClaim(dir);
    if (outcome === 'ambiguous') return null;
    // 'reclaimed' | 'retry' -> loop and try again
  }
  return null;
}

// ---------------------------------------------------------------------------
// Activity + identity records
// ---------------------------------------------------------------------------

function loadActivity(dir: string, generation: string): Record<string, unknown> | null {
  return validateActivity(asRecord(readJson(join(dir, 'activity.json'))), generation);
}

/** Pure validator shared by the sync (write) and async (render) read paths. */
function validateActivity(
  value: Record<string, unknown> | null,
  generation: string,
): Record<string, unknown> | null {
  if (!value || value.schema !== 1 || value.generation !== generation) return null;
  if (typeof value.state !== 'string') return null;
  if (!['idle', 'thinking', 'working', 'needs-human'].includes(value.state)) return null;
  if (!(value.tool === null || typeof value.tool === 'string')) return null;
  if (typeof value.ts !== 'number' || !Number.isFinite(value.ts)) return null;
  return value;
}

function writeActivity(
  dir: string,
  generation: string,
  state: ActivityState,
  tool: unknown = null,
): void {
  atomicWrite(join(dir, 'activity.json'), {
    schema: 1,
    generation,
    state,
    tool: typeof tool === 'string' && tool.length > 0 ? tool : null,
    ts: Date.now(),
  });
}

function identityFile(dir: string, family: string, phase: string, id: string): string {
  return join(dir, family, phase, `${createHash('sha256').update(id).digest('hex')}.json`);
}

function writeIdentity(
  dir: string,
  generation: string,
  family: 'agents' | 'shells',
  phase: 'start' | 'stop',
  rawId: unknown,
): void {
  const id = validIdentity(rawId);
  if (!id) return; // unknowable identity: never guess or pop another record
  atomicWrite(identityFile(dir, family, phase, id), { schema: 1, generation, id, ts: Date.now() });
}

function identityRecords(dir: string, family: string, phase: string, generation: string): string[] {
  const recordDir = join(dir, family, phase);
  let names: string[] = [];
  try {
    names = readdirSync(recordDir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const value = asRecord(readJson(join(recordDir, name)));
    if (!value || value.schema !== 1 || value.generation !== generation) continue;
    const id = validIdentity(value.id);
    if (!id || typeof value.ts !== 'number' || !Number.isFinite(value.ts)) continue;
    // The filename must match the identity digest, so a record cannot be
    // renamed into place to impersonate a different identity.
    if (name !== `${createHash('sha256').update(id).digest('hex')}.json`) continue;
    out.push(id);
  }
  return out;
}

function activeIdentityIds(dir: string, family: string, generation: string): string[] {
  const starts = identityRecords(dir, family, 'start', generation);
  const stopped = new Set(identityRecords(dir, family, 'stop', generation));
  return [...new Set(starts.filter((id) => !stopped.has(id)))].sort();
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const rec = asRecord(value);
  if (rec) {
    return `{${Object.keys(rec)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(rec[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

interface TaskInventory {
  readonly fingerprint: string;
  readonly total: number;
  readonly completed: number;
}

function taskInventoryAt(dir: string): TaskInventory {
  let names: string[] = [];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    /* no task dir yet */
  }
  const tasks: Array<{ name: string; value: Record<string, unknown> }> = [];
  for (const name of names) {
    const value = asRecord(readJson(join(dir, name)));
    if (!value || typeof value.status !== 'string') continue;
    tasks.push({ name, value });
  }
  return {
    fingerprint: createHash('sha256').update(canonicalJson(tasks)).digest('hex'),
    total: tasks.length,
    completed: tasks.filter(({ value }) => value.status === 'completed').length,
  };
}

function taskInventory(sessionId: string): TaskInventory {
  return taskInventoryAt(join(tasksDir(), sessionId));
}

function readSnapshot(dir: string, generation: string): Record<string, unknown> | null {
  return validateSnapshot(asRecord(readJson(join(dir, 'tasks', 'snapshot.json'))), generation);
}

/** Pure validator shared by the sync (write) and async (render) read paths. */
function validateSnapshot(
  value: Record<string, unknown> | null,
  generation: string,
): Record<string, unknown> | null {
  if (!value || value.schema !== 1 || value.generation !== generation) return null;
  if (typeof value.snapshotId !== 'string' || !/^[a-f0-9]{32}$/.test(value.snapshotId)) return null;
  if (typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)) return null;
  if (!Number.isInteger(value.total) || (value.total as number) < 0) return null;
  const completed = value.completed;
  if (!Number.isInteger(completed) || (completed as number) < 0 || (completed as number) > (value.total as number)) {
    return null;
  }
  return value;
}

function acknowledgeTasks(dir: string, generation: string, sessionId: string): void {
  const snapshot = readSnapshot(dir, generation);
  const inventory = taskInventory(sessionId);
  atomicWrite(join(dir, 'tasks', 'ack.json'), {
    schema: 1,
    generation,
    fingerprint: inventory.fingerprint,
    total: inventory.total,
    consumedSnapshotId: typeof snapshot?.snapshotId === 'string' ? snapshot.snapshotId : null,
    ts: Date.now(),
  });
}

function writeTaskSnapshot(dir: string, generation: string, sessionId: string): void {
  const inventory = taskInventory(sessionId);
  atomicWrite(join(dir, 'tasks', 'snapshot.json'), {
    schema: 1,
    generation,
    snapshotId: randomUUID().replace(/-/g, ''),
    fingerprint: inventory.fingerprint,
    total: inventory.total,
    completed: inventory.completed,
    ts: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Projection (read side, used by the renderer)
// ---------------------------------------------------------------------------

// --- async read helpers -----------------------------------------------------
//
// The statusline renderer forbids synchronous I/O on its render path, so the
// PROJECTION (read) side is async. The hook WRITE side stays synchronous by
// design: hooks are short-lived processes whose atomicity and crash semantics
// depend on ordered synchronous publication.

async function readJsonAsync(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

async function identityRecordsAsync(
  dir: string,
  family: string,
  phase: string,
  generation: string,
): Promise<string[]> {
  const recordDir = join(dir, family, phase);
  let names: string[] = [];
  try {
    names = (await readdir(recordDir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const value = asRecord(await readJsonAsync(join(recordDir, name)));
    if (!value || value.schema !== 1 || value.generation !== generation) continue;
    const id = validIdentity(value.id);
    if (!id || typeof value.ts !== 'number' || !Number.isFinite(value.ts)) continue;
    if (name !== `${createHash('sha256').update(id).digest('hex')}.json`) continue;
    out.push(id);
  }
  return out;
}

async function activeIdentityIdsAsync(
  dir: string,
  family: string,
  generation: string,
): Promise<string[]> {
  const starts = await identityRecordsAsync(dir, family, 'start', generation);
  const stopped = new Set(await identityRecordsAsync(dir, family, 'stop', generation));
  return [...new Set(starts.filter((id) => !stopped.has(id)))].sort();
}

async function taskInventoryAtAsync(dir: string): Promise<TaskInventory> {
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    /* no task dir yet */
  }
  const tasks: Array<{ name: string; value: Record<string, unknown> }> = [];
  for (const name of names) {
    const value = asRecord(await readJsonAsync(join(dir, name)));
    if (!value || typeof value.status !== 'string') continue;
    tasks.push({ name, value });
  }
  return {
    fingerprint: createHash('sha256').update(canonicalJson(tasks)).digest('hex'),
    total: tasks.length,
    completed: tasks.filter(({ value }) => value.status === 'completed').length,
  };
}

/**
 * Project one validated session's state. Returns null for missing, malformed,
 * or generation-mismatched state so the renderer omits activity entirely rather
 * than fabricating "Idle".
 *
 * Async: the renderer's binding constraint forbids synchronous I/O on the
 * render path.
 */
export async function readSessionProjection(
  rawSessionId: unknown,
): Promise<SessionProjection | null> {
  const sessionId = validSessionId(rawSessionId);
  if (!sessionId) return null;
  const dir = sessionDir(sessionId);

  const markerValue = asRecord(await readJsonAsync(join(dir, 'generation.json')));
  const marker = validateGeneration(markerValue);
  if (!marker) return null;
  const activity = validateActivity(asRecord(await readJsonAsync(join(dir, 'activity.json'))), marker.generation);
  if (!activity) return null;

  const agents = await activeIdentityIdsAsync(dir, 'agents', marker.generation);
  const shells = await activeIdentityIdsAsync(dir, 'shells', marker.generation);

  const ackValue = asRecord(await readJsonAsync(join(dir, 'tasks', 'ack.json')));
  const ack =
    ackValue &&
    ackValue.schema === 1 &&
    ackValue.generation === marker.generation &&
    typeof ackValue.fingerprint === 'string'
      ? ackValue
      : null;
  const snapshot = validateSnapshot(
    asRecord(await readJsonAsync(join(dir, 'tasks', 'snapshot.json'))),
    marker.generation,
  );
  const inventory = await taskInventoryAtAsync(join(tasksDir(), sessionId));

  let tasks: TaskView | null = null;
  // A missing/malformed ack makes task history untrustworthy. Fail closed: do
  // not revive a snapshot or claim that live tasks are newly unacknowledged.
  if (ack) {
    if (snapshot && snapshot.snapshotId !== ack.consumedSnapshotId) {
      tasks = {
        source: 'snapshot',
        total: snapshot.total as number,
        completed: snapshot.completed as number,
      };
    } else if (inventory.total > 0 && inventory.fingerprint !== ack.fingerprint) {
      tasks = { source: 'live', total: inventory.total, completed: inventory.completed };
    }
  }

  const state = activity.state as ActivityState;
  const waiting = state === 'idle' && (agents.length > 0 || shells.length > 0);
  return {
    generation: marker.generation,
    state: waiting ? 'waiting' : state,
    tool: typeof activity.tool === 'string' ? activity.tool : null,
    pendingAgents: agents.length,
    bgShells: shells.length,
    tasks,
  };
}

// ---------------------------------------------------------------------------
// Write side (used by the hook entrypoint)
// ---------------------------------------------------------------------------

function startFreshSession(dir: string, sessionId: string, source: string): void {
  // A real SessionStart is authoritative and outranks any late-attach state.
  try {
    rmSync(claimPath(dir), { force: true });
  } catch {
    /* stale claim removal is best effort */
  }
  const marker = newGeneration(source);
  atomicWrite(join(dir, 'generation.json'), marker);
  const generation = String(marker.generation);
  writeActivity(dir, generation, 'idle');
  acknowledgeTasks(dir, generation, sessionId);
}

/**
 * Apply one Claude Code hook event. Never throws to the caller; the entrypoint
 * additionally exits 0 unconditionally so a hook can never block Claude Code.
 */
export function recordHookEvent(event: string, payload: unknown): void {
  const rec = asRecord(payload) ?? {};
  const sessionId = validSessionId(rec.session_id ?? rec.sessionId);
  if (!sessionId) return; // malformed/untrusted session id -> no state at all

  const dir = sessionDir(sessionId);

  if (event === 'session-end') {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* already absent/unavailable */
    }
    return;
  }

  if (event === 'session-start') {
    const source = rec.source;
    if (typeof source === 'string' && FRESH_SOURCES.has(source)) {
      startFreshSession(dir, sessionId, source);
    }
    // Compact is a preservation boundary: it must not rewrite generation,
    // activity, task acknowledgement/snapshot, or identity records.
    return;
  }

  // Late-attach: a validated session-scoped event may create a missing
  // generation through the create-once claim protocol. Null means fail closed.
  const generation = ensureGeneration(dir, sessionId);
  if (!generation) return;

  const toolName = rec.tool_name ?? rec.toolName ?? null;
  const toolInput = asRecord(rec.tool_input ?? rec.toolInput) ?? {};
  const toolUseId = rec.tool_use_id ?? rec.toolUseId ?? null;
  const agentId = rec.agent_id ?? rec.agentId ?? null;

  switch (event) {
    case 'prompt':
      // Task acknowledgement is independently knowable and must not be lost if
      // concurrent activity replacement briefly omits activity.json.
      acknowledgeTasks(dir, generation, sessionId);
      if (!loadActivity(dir, generation)) return;
      writeActivity(dir, generation, 'thinking');
      break;

    case 'pre-tool':
      // Identity records are independent of the last-writer-wins activity
      // record, so they are written first: a concurrent atomic replacement may
      // briefly omit activity but must never suppress an independently
      // knowable background lifecycle fact.
      if (toolName === 'Bash' && toolInput.run_in_background === true) {
        writeIdentity(dir, generation, 'shells', 'start', toolUseId);
      }
      if (!loadActivity(dir, generation)) return;
      writeActivity(dir, generation, 'working', toolName);
      break;

    case 'post-tool':
      if (toolName === 'TaskStop') {
        // Hooks see the canonical name; only the canonical task_id is accepted.
        writeIdentity(dir, generation, 'shells', 'stop', toolInput.task_id);
      }
      if (!loadActivity(dir, generation)) return;
      writeActivity(dir, generation, 'working');
      break;

    case 'tool-failed':
    case 'permission-denied':
      if (!loadActivity(dir, generation)) return;
      writeActivity(dir, generation, 'working');
      break;

    case 'subagent-start':
      writeIdentity(dir, generation, 'agents', 'start', agentId);
      break;

    case 'subagent-stop':
      // Missing identity is unknowable: never pop or guess another agent.
      writeIdentity(dir, generation, 'agents', 'stop', agentId);
      break;

    case 'stop':
    case 'stop-failed':
      writeTaskSnapshot(dir, generation, sessionId);
      if (!loadActivity(dir, generation)) return;
      writeActivity(dir, generation, 'idle');
      break;

    case 'permission-request':
      if (!loadActivity(dir, generation)) return;
      writeActivity(dir, generation, 'needs-human');
      break;

    case 'notify': {
      const type = rec.notification_type ?? rec.notificationType;
      if (typeof type !== 'string') return;
      if (!VERIFIED_NOTIFICATIONS.has(type) || !NEEDS_HUMAN_NOTIFICATIONS.has(type)) return;
      if (!loadActivity(dir, generation)) return;
      writeActivity(dir, generation, 'needs-human');
      break;
    }

    default:
      return;
  }
}

/** Hook event names this tracker understands (the portable event set). */
export const TRACKER_EVENTS = [
  'session-start',
  'session-end',
  'prompt',
  'pre-tool',
  'post-tool',
  'tool-failed',
  'permission-denied',
  'permission-request',
  'subagent-start',
  'subagent-stop',
  'stop',
  'stop-failed',
  'notify',
] as const;

export type TrackerEvent = (typeof TRACKER_EVENTS)[number];
