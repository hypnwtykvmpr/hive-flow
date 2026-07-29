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
//   generation.json                          (authoritative marker)
//   generation.claim                         (create-once; RETAINED until SessionEnd)
//   g/<generation>/activity.json
//   g/<generation>/agents/{start,stop}/<sha256(identity)>.json
//   g/<generation>/shells/{start,stop}/<sha256(identity)>.json
//   g/<generation>/tasks/{ack,snapshot}.json
//
// GENERATION-SCOPED RECORDS. Every generation-bound record lives under
// `g/<generation>/`, and the reader selects that directory from the
// authoritative marker. This is the ownership guarantee: a writer holding a
// stale generation A writes into `g/A/...`, which is never read, so it cannot
// clobber the current generation's state. Shared record pathnames could not
// provide this — an authoritative SessionStart could publish B between a
// stale writer's check and its replace.
//
// LATE-ATTACH (f16a amendment). The portable tracker initializes only on
// SessionStart, so a session already running when hooks are installed would
// never initialize and activity would be absent forever. A validated,
// session-scoped event may therefore create a missing generation — but only via
// the create-once protocol below, and it fabricates nothing: no historical
// tools, background identities, tasks, or permission state.
//
// CLAIM PROTOCOL (create-once winner). The claim is RETAINED until SessionEnd
// and becomes inert as soon as a valid generation exists (it is consulted only
// when no valid generation is present). It is NEVER the authoritative record:
//   1. Stage the COMPLETE claim record in a unique staging file.
//   2. Publish it to the canonical claim path with an atomic, no-clobber
//      `linkSync`. Publishing an already-complete inode means a crash can never
//      leave a malformed canonical claim (a direct `writeFileSync(...,'wx')`
//      can, and that would wedge the session permanently).
//   3. Remove the staging file on every success/failure path.
// Losers re-read the winner's generation under a bounded retry (a LIVE owner
// gets a longer wait, because a healthy-but-slow winner is not a fault). A dead
// owner is recovered WITHOUT touching the claim at all: the late-attach
// generation is derived deterministically from the complete claim record, so a
// recoverer republishes the identical marker via a no-clobber link. No writer
// ever removes or renames the claim — that was a pathname TOCTOU, and the claim
// is inert once a valid generation exists. Any ambiguity fails closed: write
// nothing and let a later event retry.
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
import { readdir, readFile, stat } from 'node:fs/promises';
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

/**
 * Directory holding every GENERATION-BOUND record.
 *
 * All of activity, task ack/snapshot, and identity records live under
 * `g/<generation>/`. This is the ownership guarantee, not a convention: a writer
 * that adopted a stale generation A writes into `g/A/...`, which the renderer —
 * which selects its directory from the authoritative marker — never reads. A
 * check-then-replace of a shared pathname could not provide this, because an
 * authoritative SessionStart could publish generation B between the check and
 * the replace and then have its `activity.json` clobbered by the stale writer.
 */
function genDir(dir: string, generation: string): string {
  return join(dir, 'g', generation);
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

interface ClaimRecord {
  readonly owner: string;
  readonly pid: number;
  readonly ts: number;
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
function tryAcquireClaim(dir: string): ClaimRecord | null {
  mkdirSync(dir, { recursive: true });
  const claim: ClaimRecord = {
    owner: randomBytes(16).toString('hex'),
    pid: process.pid,
    ts: Date.now(),
  };
  const staging = join(dir, `.generation.claim.${process.pid}.${randomBytes(8).toString('hex')}.stage`);
  const record = JSON.stringify({ schema: 1, ...claim });
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
    // republishes that claim's DETERMINISTIC generation without mutating it.
    testFault('after-claim');
    return claim;
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

/**
 * Read and validate the canonical claim record.
 *
 * The claim is NEVER mutated by a recoverer — see {@link ensureGeneration}. An
 * earlier design renamed it away, which was a pathname TOCTOU: between reading
 * a dead claim and renaming that path, another process could publish a fresh
 * LIVE claim there, and the rename would move the live one.
 */
function readClaim(dir: string): ClaimRecord | null {
  const value = asRecord(readJson(claimPath(dir)));
  if (!value || value.schema !== 1) return null;
  if (typeof value.owner !== 'string' || !OWNER_TOKEN.test(value.owner)) return null;
  if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0) return null;
  if (typeof value.ts !== 'number' || !Number.isFinite(value.ts)) return null;
  return { owner: value.owner, pid: value.pid, ts: value.ts };
}

/**
 * Derive the late-attach generation DETERMINISTICALLY from the complete claim
 * record. Any process that reads the same claim computes the same value, so a
 * dead-owner recoverer and the original claimant converge on one generation
 * without either deleting or replacing the canonical claim.
 */
function generationFromClaim(claim: ClaimRecord): string {
  // NUL is an unambiguous field delimiter (it cannot appear in any field),
  // but it must NEVER be embedded literally in tracked source: a raw NUL makes
  // git, `file`, and ripgrep treat this TypeScript as a binary blob. Build it.
  const NUL = String.fromCharCode(0);
  return createHash('sha256')
    .update(`${claim.owner}${NUL}${claim.pid}${NUL}${claim.ts}`)
    .digest('hex')
    .slice(0, 32);
}

/** The late-attach marker is a pure function of the claim, so it is byte-identical
 *  no matter which process publishes it. */
function lateAttachMarker(claim: ClaimRecord): Record<string, unknown> {
  return {
    schema: 1,
    generation: generationFromClaim(claim),
    source: LATE_ATTACH_SOURCE,
    createdAt: claim.ts,
  };
}

/**
 * Publish `generation.json` with a staged, atomic, NO-CLOBBER link.
 *
 * No-clobber is what keeps an authoritative SessionStart safe: if SessionStart
 * has already published, a late-attach writer's link fails and it adopts the
 * authoritative record instead of overwriting it.
 */
/**
 * Publish a COMPLETE record only if the destination does not exist, via a
 * staged atomic no-clobber link. Never overwrites an existing record, and can
 * never expose a partial one.
 */
function publishIfAbsent(file: string, value: Record<string, unknown>): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const staging = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}.stage`);
  try {
    writeFileSync(staging, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
    try {
      linkSync(staging, file);
    } catch {
      /* EEXIST: another writer (or SessionStart) already published. Adopt it. */
    }
  } catch {
    /* staging failure: the caller re-reads and fails closed if nothing exists */
  } finally {
    try {
      rmSync(staging, { force: true });
    } catch {
      /* best effort on every path */
    }
  }
}

function publishGenerationNoClobber(dir: string, marker: Record<string, unknown>): void {
  publishIfAbsent(join(dir, 'generation.json'), marker);
}

// NOTE (B2): there is deliberately NO releaseClaim(). Reading the claim,
// checking its owner, and then removing the pathname is a TOCTOU — the path can
// be removed and recreated by a newer claimant in between, so an old writer
// could delete a newer claimant's record after a SessionEnd/new-event race.
// Removal is also unnecessary: once a valid `generation.json` exists the claim
// is inert (it is consulted ONLY when no valid generation is present), and
// SessionEnd removes the whole session directory. Lifecycle cleanup belongs to
// session teardown, not to individual event writers.

/** Bounded wait for a winner's generation publication. */
function awaitGeneration(dir: string, attempts = 5, delayMs = 2): string | null {
  for (let i = 0; i < attempts; i++) {
    const marker = loadGeneration(dir);
    if (marker) return marker.generation;
    sleepMs(delayMs);
  }
  return loadGeneration(dir)?.generation ?? null;
}

/**
 * How long a loser waits for a LIVE claim owner to publish before giving up.
 *
 * Failing closed is the response to an ambiguous or dead owner, not to a
 * healthy-but-slow one. A ~10ms wait was too short under load: the winner had
 * not published yet, the loser saw a live owner, wrote nothing, and a truthful
 * `thinking`/`working` update was silently dropped until a later event repaired
 * it. This budget stays far inside Claude Code's hook timeout.
 */
const LIVE_OWNER_WAIT_ATTEMPTS = 50;
const LIVE_OWNER_WAIT_DELAY_MS = 5;

/**
 * Resolve the generation for a validated session, creating one via late-attach
 * when absent. Returns null when the caller must fail closed and write nothing.
 */
function ensureGeneration(dir: string, sessionId: string): string | null {
  const existing = loadGeneration(dir);
  if (existing) return existing.generation;

  // 1) Try to become the claimant.
  const mine = tryAcquireClaim(dir);
  let claim: ClaimRecord | null = mine;

  if (!claim) {
    // 2) Someone else holds the claim: give them a bounded chance to publish.
    const adopted = awaitGeneration(dir);
    if (adopted) return adopted;

    // 3) Still nothing. Inspect the claim, failing closed on ANY ambiguity.
    const existingClaim = readClaim(dir);
    if (!existingClaim) return null; // malformed/missing -> write nothing
    if (pidAlive(existingClaim.pid) !== false) {
      // A LIVE owner is mid-publication, not a fault. Give it a longer bounded
      // wait before giving up, otherwise a healthy-but-slow winner causes this
      // event's truthful state to be dropped. Only then fail closed.
      const adoptedFromLiveOwner = awaitGeneration(
        dir,
        LIVE_OWNER_WAIT_ATTEMPTS,
        LIVE_OWNER_WAIT_DELAY_MS,
      );
      return adoptedFromLiveOwner; // null -> still nothing published, write nothing
    }
    // Dead owner. We do NOT delete or rename the claim (that was a pathname
    // TOCTOU); we simply publish the generation that claim deterministically
    // implies. A concurrent recoverer computes the identical marker.
    claim = existingClaim;
  }

  publishGenerationNoClobber(dir, lateAttachMarker(claim));

  // Adopt whatever is authoritative now. A concurrent SessionStart wins here,
  // because our publication is no-clobber and its is an authoritative replace.
  const published = loadGeneration(dir);
  if (!published) return null;

  // The claim is intentionally left in place — see the B2 note above.

  // Baseline only, published CREATE-ONLY so a racer's truthful `thinking` /
  // `working` record can never be overwritten by this fallback `idle`. The
  // triggering event writes the truthful state next; no historical tools,
  // identities, or permission state are invented.
  writeActivityIfAbsent(dir, published.generation, 'idle');
  if (!hasTaskAck(dir, published.generation)) {
    // Acknowledge — never replay — pre-existing tasks, so late-attach cannot
    // resurrect task history this session never observed.
    acknowledgeTasks(dir, published.generation, sessionId);
  }
  return published.generation;
}

// ---------------------------------------------------------------------------
// Activity + identity records
// ---------------------------------------------------------------------------

function loadActivity(dir: string, generation: string): Record<string, unknown> | null {
  return validateActivity(asRecord(readJson(join(genDir(dir, generation), 'activity.json'))), generation);
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

function activityRecord(generation: string, state: ActivityState, tool: unknown): Record<string, unknown> {
  return {
    schema: 1,
    generation,
    state,
    tool: typeof tool === 'string' && tool.length > 0 ? tool : null,
    ts: Date.now(),
  };
}

function writeActivity(
  dir: string,
  generation: string,
  state: ActivityState,
  tool: unknown = null,
): void {
  atomicWrite(join(genDir(dir, generation), 'activity.json'), activityRecord(generation, state, tool));
}

/**
 * Write the initialization baseline WITHOUT clobbering a truthful concurrent
 * update. Events that do not themselves publish activity (subagent-start /
 * subagent-stop) still initialize a generation, and their fallback `idle` must
 * never overwrite a `thinking`/`working` record another racer just wrote.
 * Create-only publication makes that structurally impossible.
 */
function writeActivityIfAbsent(dir: string, generation: string, state: ActivityState): void {
  publishIfAbsent(join(genDir(dir, generation), 'activity.json'), activityRecord(generation, state, null));
}

function identityFile(dir: string, generation: string, family: string, phase: string, id: string): string {
  return join(genDir(dir, generation), family, phase, `${createHash('sha256').update(id).digest('hex')}.json`);
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
  atomicWrite(identityFile(dir, generation, family, phase, id), { schema: 1, generation, id, ts: Date.now() });
}

function identityRecords(dir: string, family: string, phase: string, generation: string): string[] {
  const recordDir = join(genDir(dir, generation), family, phase);
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
  return validateSnapshot(
    asRecord(readJson(join(genDir(dir, generation), 'tasks', 'snapshot.json'))),
    generation,
  );
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

/** True when this generation already has a task acknowledgement. */
function hasTaskAck(dir: string, generation: string): boolean {
  const value = asRecord(readJson(join(genDir(dir, generation), 'tasks', 'ack.json')));
  return !!value && value.schema === 1 && value.generation === generation;
}

function acknowledgeTasks(dir: string, generation: string, sessionId: string): void {
  const snapshot = readSnapshot(dir, generation);
  const inventory = taskInventory(sessionId);
  atomicWrite(join(genDir(dir, generation), 'tasks', 'ack.json'), {
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
  atomicWrite(join(genDir(dir, generation), 'tasks', 'snapshot.json'), {
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

/**
 * Hard bounds for the RENDER read path. The statusline has a sub-200ms
 * end-to-end contract, so a pathological state directory must never be able to
 * stall the line: over-count, over-size, non-regular, or over-budget state
 * fails closed (activity omitted) instead of being read to completion.
 */
const MAX_IDENTITY_FILES = 256;
const MAX_TASK_FILES = 512;
const MAX_RECORD_BYTES = 64 * 1024;
/**
 * Default slice of the render budget this projection may consume. 25ms proved
 * too tight: on a loaded machine a legitimate ~50-task session lost its
 * activity cell. 50ms still leaves the sub-200ms end-to-end contract intact
 * while tolerating normal scheduler noise.
 */
const DEFAULT_PROJECTION_BUDGET_MS = 50;

class Budget {
  private readonly deadline: number;
  constructor(ms: number) {
    this.deadline = Date.now() + Math.max(0, ms);
  }
  expired(): boolean {
    return Date.now() >= this.deadline;
  }
}

/** Read one bounded JSON record: non-regular or oversized files are refused. */
async function readJsonBounded(file: string, budget: Budget): Promise<unknown> {
  if (budget.expired()) return null;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_RECORD_BYTES) return null;
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

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
  budget: Budget,
): Promise<string[] | null> {
  const recordDir = join(genDir(dir, generation), family, phase);
  let names: string[] = [];
  try {
    names = (await readdir(recordDir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  // Fail closed rather than read an unbounded directory on the render path.
  if (names.length > MAX_IDENTITY_FILES) return null;
  const out: string[] = [];
  for (const name of names) {
    if (budget.expired()) return null;
    const value = asRecord(await readJsonBounded(join(recordDir, name), budget));
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
  budget: Budget,
): Promise<string[] | null> {
  const starts = await identityRecordsAsync(dir, family, 'start', generation, budget);
  if (starts === null) return null;
  const stops = await identityRecordsAsync(dir, family, 'stop', generation, budget);
  if (stops === null) return null;
  const stopped = new Set(stops);
  return [...new Set(starts.filter((id) => !stopped.has(id)))].sort();
}

async function taskInventoryAtAsync(dir: string, budget: Budget): Promise<TaskInventory | null> {
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    /* no task dir yet */
  }
  // Fail closed rather than read an unbounded task directory on the render path.
  if (names.length > MAX_TASK_FILES) return null;
  const tasks: Array<{ name: string; value: Record<string, unknown> }> = [];
  for (const name of names) {
    if (budget.expired()) return null;
    const value = asRecord(await readJsonBounded(join(dir, name), budget));
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
  options: { budgetMs?: number } = {},
): Promise<SessionProjection | null> {
  const sessionId = validSessionId(rawSessionId);
  if (!sessionId) return null;
  const dir = sessionDir(sessionId);
  const budget = new Budget(options.budgetMs ?? DEFAULT_PROJECTION_BUDGET_MS);

  const markerValue = asRecord(await readJsonBounded(join(dir, 'generation.json'), budget));
  const marker = validateGeneration(markerValue);
  if (!marker) return null;
  const activity = validateActivity(
    asRecord(await readJsonBounded(join(genDir(dir, marker.generation), 'activity.json'), budget)),
    marker.generation,
  );
  if (!activity) return null;

  // Any bound breach (count, size, non-regular file, or elapsed budget) omits
  // activity entirely rather than delaying the statusline.
  const agents = await activeIdentityIdsAsync(dir, 'agents', marker.generation, budget);
  if (agents === null) return null;
  const shells = await activeIdentityIdsAsync(dir, 'shells', marker.generation, budget);
  if (shells === null) return null;

  const ackValue = asRecord(
    await readJsonBounded(join(genDir(dir, marker.generation), 'tasks', 'ack.json'), budget),
  );
  const ack =
    ackValue &&
    ackValue.schema === 1 &&
    ackValue.generation === marker.generation &&
    typeof ackValue.fingerprint === 'string'
      ? ackValue
      : null;
  const snapshot = validateSnapshot(
    asRecord(await readJsonBounded(join(genDir(dir, marker.generation), 'tasks', 'snapshot.json'), budget)),
    marker.generation,
  );
  const inventory = await taskInventoryAtAsync(join(tasksDir(), sessionId), budget);
  if (inventory === null) return null;

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
  //
  // The claim is deliberately NOT removed here (B2): removing a pathname whose
  // contents may have been replaced by a newer claimant is the same TOCTOU.
  // It is inert anyway once a valid generation exists.
  const marker = newGeneration(source);
  const generation = String(marker.generation);

  // Populate this generation's records BEFORE publishing its marker. Publishing
  // last means the marker only ever becomes authoritative once the state it
  // points at already exists, so a reader can never observe a fresh marker with
  // no activity. Because every record is generation-scoped, no stale writer can
  // reach into this directory.
  writeActivity(dir, generation, 'idle');
  acknowledgeTasks(dir, generation, sessionId);
  atomicWrite(join(dir, 'generation.json'), marker);
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
