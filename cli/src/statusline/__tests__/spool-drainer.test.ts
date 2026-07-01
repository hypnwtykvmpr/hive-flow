// v3/@hive-flow/cli/src/statusline/__tests__/spool-drainer.test.ts
//
// Tests the Phase 5.7 spool drainer against the canonical runbook contract:
//   - empty spool -> empty report
//   - single spool entry drains to its ledger and the spool file is deleted
//   - re-drain on the same state is idempotent (dedupe path)
//   - all five canonical ledgers drain in one call
//   - scoreboard-calls compound dedupe preserves call-start + call-complete
//     pairs but rejects identical (eventId, event) replays
//   - symlinked spool dir surfaces the canonical StatuslineStoragePathError
//     (Wave 2.5A guards trigger before any FS write)
//   - invalid ledger names are structurally impossible: SPOOL_LEDGER_NAMES is
//     a closed frozen set and the drainer never composes ledger names from
//     caller input, so an invalid name cannot reach the drainer
//   - crash recovery: a `*.json.processing-*` file older than the threshold
//     is reclaimed and drained on the next pass
//   - refresher integration smoke: drainSpool is invocable BEFORE any
//     snapshot rebuild and its report can be consumed by a caller

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { drainSpool } from '../spool-drainer.js';
import { SPOOL_LEDGER_NAMES, statuslinePaths } from '../paths.js';
import type { SpoolLedgerName } from '../paths.js';
import { readJsonl, StatuslineStoragePathError } from '../storage.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Write a single spool entry under `<root>/.hive-flow/spool/<ledger>/<name>`.
 * The drainer claims and processes it on the next invocation.
 */
function spool(root: string, ledger: SpoolLedgerName, name: string, value: unknown): void {
  const dir = join(root, '.hive-flow', 'spool', ledger);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(value) + '\n');
}

/** Build a minimally-valid sessions event with a stable eventId. */
function sessionsEvent(root: string, eventId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    eventId,
    ts: '2026-05-21T00:00:00.000Z',
    repoRoot: root,
    projectKey: 'p',
    hostCli: 'codex',
    sessionId: 's1',
    event: 'session-start',
    sessionIdSource: 'wrapper',
    confidence: 'derived',
    producerKind: 'wrapper',
    producerId: 'test',
    ...extra,
  };
}

/** Build a minimally-valid scoreboard-presence event with a stable eventId. */
function presenceEvent(root: string, eventId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    eventId,
    ts: '2026-05-21T00:00:00.000Z',
    repoRoot: root,
    projectKey: 'p',
    hostCli: 'codex',
    provider: 'codex',
    producerKind: 'manual',
    producerId: 'test',
    presenceKey: 'p1',
    event: 'agent-spawn',
    ...extra,
  };
}

/** Build a minimally-valid scoreboard-calls event with a stable eventId+event. */
function callEvent(
  root: string,
  eventId: string,
  event: 'call-start' | 'call-complete' | 'call-failed',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    eventId,
    ts: '2026-05-21T00:00:00.000Z',
    repoRoot: root,
    projectKey: 'p',
    hostCli: 'codex',
    provider: 'codex',
    producerKind: 'manual',
    producerId: 'test',
    event,
    ...extra,
  };
}

/** Build a minimally-valid tests/last-run event (suite kind). */
function testsEvent(root: string, eventId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    eventId,
    ts: '2026-05-21T00:00:00.000Z',
    repoRoot: root,
    projectKey: 'p',
    runner: 'vitest',
    kind: 'suite',
    passed: 1,
    failed: 0,
    skipped: 0,
    total: 1,
    producerKind: 'manual',
    producerId: 'test',
    ...extra,
  };
}

/** Build a minimally-valid attention emit event. */
function attentionEvent(eventId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId,
    ts: '2026-05-21T00:00:00.000Z',
    event: 'emit',
    item: {
      id: 'attn-1',
      ts: '2026-05-21T00:00:00.000Z',
      severity: 'warn',
      source: 'test',
      message: 'review required',
      redacted: false,
    },
    ...extra,
  };
}

describe('statusline spool drainer', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hf-spool-drainer-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Empty + happy path
  // -------------------------------------------------------------------------

  it('returns an empty report when the spool tree does not exist', async () => {
    const report = await drainSpool({ projectRoot: root });
    expect(report.totals).toEqual({ drained: 0, deduped: 0, failed: 0, recovered: 0 });
    for (const name of SPOOL_LEDGER_NAMES) {
      expect(report.ledgers[name]).toEqual({
        drained: 0,
        deduped: 0,
        failed: 0,
        recovered: 0,
      });
    }
  });

  it('drains a single sessions entry to sessions.jsonl and deletes the spool file', async () => {
    spool(root, 'sessions', 'sess-1.json', sessionsEvent(root, 's-1'));
    const report = await drainSpool({ projectRoot: root });
    expect(report.ledgers.sessions.drained).toBe(1);
    expect(report.ledgers.sessions.deduped).toBe(0);
    expect(report.ledgers.sessions.failed).toBe(0);
    expect(report.totals.drained).toBe(1);

    // Ledger row landed.
    const ledger = await readJsonl<{ eventId: string }>(statuslinePaths(root).sessionsLedger);
    expect(ledger.events.map((e) => e.eventId)).toEqual(['s-1']);

    // Spool file removed (no leftover entries).
    const dir = join(root, '.hive-flow', 'spool', 'sessions');
    const leftover = readdirSync(dir).filter((n) => n.endsWith('.json'));
    expect(leftover).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Idempotency on re-drain
  // -------------------------------------------------------------------------

  it('is idempotent on re-drain: a fresh spool entry with the same eventId dedupes', async () => {
    // Initial drain writes the row.
    spool(root, 'sessions', 'sess-1.json', sessionsEvent(root, 's-1'));
    const first = await drainSpool({ projectRoot: root });
    expect(first.ledgers.sessions.drained).toBe(1);

    // Re-queue the same entry under a different filename. The drainer must
    // see it as a duplicate of the ledger row, count it as `deduped`, and
    // delete the spool copy (no second ledger row).
    spool(root, 'sessions', 'sess-1-replay.json', sessionsEvent(root, 's-1'));
    const second = await drainSpool({ projectRoot: root });
    expect(second.ledgers.sessions.drained).toBe(0);
    expect(second.ledgers.sessions.deduped).toBe(1);

    const ledger = await readJsonl<{ eventId: string }>(statuslinePaths(root).sessionsLedger);
    expect(ledger.events).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Multiple ledgers in one call
  // -------------------------------------------------------------------------

  it('drains across multiple ledgers in one call and reports per-ledger totals', async () => {
    spool(root, 'sessions', 'a.json', sessionsEvent(root, 's-1'));
    spool(root, 'scoreboard-presence', 'a.json', presenceEvent(root, 'p-1'));
    spool(root, 'scoreboard-calls', 'a.json', callEvent(root, 'c-1', 'call-complete'));
    spool(root, 'tests', 'a.json', testsEvent(root, 't-1'));
    spool(root, 'attention', 'a.json', attentionEvent('a-1'));

    const report = await drainSpool({ projectRoot: root });

    expect(report.ledgers.sessions.drained).toBe(1);
    expect(report.ledgers['scoreboard-presence'].drained).toBe(1);
    expect(report.ledgers['scoreboard-calls'].drained).toBe(1);
    expect(report.ledgers.tests.drained).toBe(1);
    expect(report.ledgers.attention.drained).toBe(1);

    expect(report.totals.drained).toBe(5);
    expect(report.totals.deduped).toBe(0);
    expect(report.totals.failed).toBe(0);

    // Each ledger has exactly one row.
    const paths = statuslinePaths(root);
    expect((await readJsonl(paths.sessionsLedger)).events).toHaveLength(1);
    expect((await readJsonl(paths.scoreboardPresenceLedger)).events).toHaveLength(1);
    expect((await readJsonl(paths.scoreboardCallsLedger)).events).toHaveLength(1);
    expect((await readJsonl(paths.testsLedger)).events).toHaveLength(1);
    expect((await readJsonl(paths.attentionLedger)).events).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Scoreboard-calls compound dedupe (Codex round-5 binding)
  // -------------------------------------------------------------------------

  it('preserves the call-start / call-complete pair when both share an eventId', async () => {
    spool(root, 'scoreboard-calls', 'a-start.json', callEvent(root, 'c-1', 'call-start'));
    spool(root, 'scoreboard-calls', 'b-complete.json', callEvent(root, 'c-1', 'call-complete'));

    const report = await drainSpool({ projectRoot: root });
    expect(report.ledgers['scoreboard-calls'].drained).toBe(2);
    expect(report.ledgers['scoreboard-calls'].deduped).toBe(0);

    const ledger = await readJsonl<{ eventId: string; event: string }>(
      statuslinePaths(root).scoreboardCallsLedger,
    );
    const pairs = ledger.events.map((e) => [e.eventId, e.event]);
    expect(pairs).toEqual([
      ['c-1', 'call-start'],
      ['c-1', 'call-complete'],
    ]);
  });

  it('dedupes a scoreboard-calls replay with identical (eventId, event)', async () => {
    spool(root, 'scoreboard-calls', 'a.json', callEvent(root, 'c-1', 'call-start'));
    const first = await drainSpool({ projectRoot: root });
    expect(first.ledgers['scoreboard-calls'].drained).toBe(1);

    spool(root, 'scoreboard-calls', 'a-replay.json', callEvent(root, 'c-1', 'call-start'));
    const second = await drainSpool({ projectRoot: root });
    expect(second.ledgers['scoreboard-calls'].drained).toBe(0);
    expect(second.ledgers['scoreboard-calls'].deduped).toBe(1);

    const ledger = await readJsonl<{ eventId: string; event: string }>(
      statuslinePaths(root).scoreboardCallsLedger,
    );
    expect(ledger.events).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Symlink-safe (Wave 2.5A guards must trigger)
  // -------------------------------------------------------------------------

  it('rejects a symlinked .hive-flow/spool root via the storage symlink guard', async () => {
    // Create an outside spool directory and symlink .hive-flow/spool at it.
    const outsideSpool = join(root, 'outside-spool');
    mkdirSync(join(outsideSpool, 'sessions'), { recursive: true });
    writeFileSync(
      join(outsideSpool, 'sessions', `${Date.now()}-1-aa.json`),
      JSON.stringify(sessionsEvent(root, 's-1')) + '\n',
    );
    const hf = join(root, '.hive-flow');
    mkdirSync(hf, { recursive: true });
    symlinkSync(outsideSpool, join(hf, 'spool'));

    // The Wave 2.5A guard (assertSafeStatuslineStoragePath) rejects the
    // symlinked .hive-flow/spool before any FS operation. The drainer surfaces
    // that as a thrown StatuslineStoragePathError to the caller.
    await expect(drainSpool({ projectRoot: root })).rejects.toBeInstanceOf(
      StatuslineStoragePathError,
    );
  });

  // -------------------------------------------------------------------------
  // Invalid ledger names are structurally impossible (defense-in-depth doc)
  // -------------------------------------------------------------------------

  it('only iterates the closed SPOOL_LEDGER_NAMES set (invalid names cannot reach the drainer)', async () => {
    // Defense-in-depth: the drainer's iteration set is the frozen
    // SPOOL_LEDGER_NAMES export. We cannot construct an "invalid" input that
    // reaches a path operation because drainSpool takes no ledger name from
    // the caller. Assert the contract:
    //   1. The exported set is frozen.
    //   2. Every iterated name maps to a defined ledger path.
    //   3. An unrelated junk directory beside the spool root is ignored.
    expect(Object.isFrozen(SPOOL_LEDGER_NAMES)).toBe(true);
    expect(SPOOL_LEDGER_NAMES).toContain('sessions');
    expect(SPOOL_LEDGER_NAMES).toContain('scoreboard-calls');

    // Junk directory the drainer must not traverse.
    const junkDir = join(root, '.hive-flow', 'spool', 'arbitrary-name');
    mkdirSync(junkDir, { recursive: true });
    writeFileSync(join(junkDir, 'leak.json'), JSON.stringify({ eventId: 'x', event: 'evil' }));

    const report = await drainSpool({ projectRoot: root });
    expect(report.totals.drained).toBe(0);

    // The junk file is still there — proves the drainer never touched it.
    expect(existsSync(join(junkDir, 'leak.json'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Crash recovery (stale processing files)
  // -------------------------------------------------------------------------

  it('recovers a stale *.json.processing-* file and drains it on the next pass', async () => {
    const dir = join(root, '.hive-flow', 'spool', 'tests');
    mkdirSync(dir, { recursive: true });
    const processing = join(dir, 'a.json.processing-9999-old');
    writeFileSync(processing, JSON.stringify(testsEvent(root, 't-recovered')));
    // Backdate the mtime past the stale threshold so the recovery branch fires.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(processing, old, old);

    const report = await drainSpool({ projectRoot: root });
    expect(report.ledgers.tests.recovered).toBe(1);
    expect(report.ledgers.tests.drained).toBe(1);

    const ledger = await readJsonl<{ eventId: string }>(statuslinePaths(root).testsLedger);
    expect(ledger.events.map((e) => e.eventId)).toEqual(['t-recovered']);
  });

  // -------------------------------------------------------------------------
  // Failure handling: malformed entries are not silently lost
  // -------------------------------------------------------------------------

  it('counts entries without a usable eventId as failed and preserves them', async () => {
    // The storage primitive guards against non-JSON files with a `.corrupt-`
    // quarantine, so we exercise the drainer's own check: a JSON object
    // that lacks a usable eventId. The drainer must restore the claim so
    // the entry is never silently lost.
    spool(root, 'sessions', 'no-id.json', { event: 'session-start' });
    const report = await drainSpool({ projectRoot: root });
    expect(report.ledgers.sessions.failed).toBe(1);
    expect(report.ledgers.sessions.drained).toBe(0);

    // Original file is restored (it's back under a .json name).
    const dir = join(root, '.hive-flow', 'spool', 'sessions');
    const remaining = readdirSync(dir).filter((n) => n.endsWith('.json'));
    expect(remaining).toHaveLength(1);
  });

  it('counts scoreboard-calls entries missing `event` as failed and preserves them', async () => {
    // hasUsableCallKey requires both eventId AND event for the compound key.
    spool(root, 'scoreboard-calls', 'no-event.json', { eventId: 'c-1' });
    const report = await drainSpool({ projectRoot: root });
    expect(report.ledgers['scoreboard-calls'].failed).toBe(1);
    expect(report.ledgers['scoreboard-calls'].drained).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  it('rejects an empty projectRoot synchronously', async () => {
    await expect(drainSpool({ projectRoot: '' })).rejects.toBeInstanceOf(TypeError);
  });

  // -------------------------------------------------------------------------
  // Refresher integration smoke
  // -------------------------------------------------------------------------
  //
  // The refresher contract (Phase 5.7 + Phase 11) says drainSpool MUST be
  // called BEFORE rebuilding any snapshot derived from a ledger. We simulate
  // that call site with a thin spy and assert ordering: drain runs first, the
  // simulated "rebuild" callback runs after, and the rebuild sees the drained
  // row in the ledger (proving the drain landed before the read).

  it('refresher integration: drainSpool runs BEFORE the snapshot rebuild', async () => {
    spool(root, 'sessions', 'sess-1.json', sessionsEvent(root, 's-1'));
    const calls: string[] = [];

    // Mock refresher: drain -> rebuild. The rebuild reads the canonical
    // ledger and expects the drained row to be visible.
    async function mockRefresh(): Promise<{ active: boolean; rows: number }> {
      calls.push('drain:start');
      const report = await drainSpool({ projectRoot: root });
      calls.push('drain:end');
      expect(report.totals.drained).toBe(1);

      // Snapshot rebuild reads the canonical ledger.
      calls.push('rebuild:start');
      const ledger = await readJsonl<{ eventId: string }>(statuslinePaths(root).sessionsLedger);
      calls.push('rebuild:end');
      return { active: ledger.events.length > 0, rows: ledger.events.length };
    }

    const summary = await mockRefresh();
    expect(summary).toEqual({ active: true, rows: 1 });
    expect(calls).toEqual(['drain:start', 'drain:end', 'rebuild:start', 'rebuild:end']);
  });
});
