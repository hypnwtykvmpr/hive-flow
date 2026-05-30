// v3/@hive-flow/cli/src/statusline/collectors/__tests__/sessions.test.ts
//
// Wave 5 regression tests for `collectSessions`. These tests run independently
// of the recorder: each scenario writes its own canonical JSONL into the
// canonical ledger path and asserts the collector's fold + freshness ladder
// behaves as the runbook requires.
//
// Coverage matrix:
//   - Empty ledger absent       -> freshness.state = 'unavailable'
//   - Empty file present        -> freshness.state = 'degraded' (no live)
//   - Single start              -> session 'active', freshness 'fresh'
//   - start + heartbeat         -> active retained, lastSeen advances
//   - start + end               -> not counted, all counts zero, degraded
//   - elapsed >15s, <=2m        -> degraded
//   - elapsed >2m               -> stale
//   - Corrupt line              -> skipped, freshness 'degraded'
//   - Out-of-order end + start  -> end wins, no resurrection
//   - Multi-host segregation    -> byHost correctly attributed
//   - deterministic nowMs       -> stable result across calls

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  collectSessions,
  SESSION_ACTIVE_THRESHOLD_MS,
  SESSION_DEGRADED_THRESHOLD_MS,
} from '../sessions.js';
import type { HostCli, SessionEventV1 } from '../../types.js';

// ---------------------------------------------------------------------------
// Test helpers (kept local so we do not depend on the recorder module).
// ---------------------------------------------------------------------------

interface MakeEventOptions {
  readonly sessionId?: string;
  readonly hostCli?: HostCli;
  readonly event?: SessionEventV1['event'];
  readonly eventId?: string;
  readonly repoRoot: string;
}

function makeEvent(ts: string, opts: MakeEventOptions): SessionEventV1 {
  const hostCli = opts.hostCli ?? 'codex';
  const sessionId = opts.sessionId ?? 's1';
  const kind = opts.event ?? 'session-heartbeat';
  return {
    version: 1,
    eventId: opts.eventId ?? `${hostCli}-${sessionId}-${kind}-${ts}`,
    ts,
    repoRoot: opts.repoRoot,
    projectKey: 'p',
    hostCli,
    sessionId,
    event: kind,
    sessionIdSource: 'wrapper',
    confidence: 'derived',
    producerKind: 'wrapper',
    producerId: 'test',
  };
}

/**
 * Write a canonical JSONL fixture to `<root>/.hive-flow/sessions/events.jsonl`.
 * Each entry is JSON-stringified on its own line, plus a trailing newline.
 * `extraRaw` lets a test inject literal lines (e.g. a corrupt fragment) without
 * forcing the caller to assemble the whole file by hand.
 */
function writeLedger(root: string, events: SessionEventV1[], extraRaw: string[] = []): string {
  const dir = join(root, '.hive-flow', 'sessions');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'events.jsonl');
  const body = events.map((event) => JSON.stringify(event)).concat(extraRaw).join('\n');
  // Trailing newline so `readJsonl` does not see a partial last record.
  writeFileSync(path, body.length === 0 ? '' : `${body}\n`, { encoding: 'utf8', mode: 0o600 });
  return path;
}

describe('collectSessions', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hf-sessions-collector-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Empty / absent ledger
  // -------------------------------------------------------------------------

  describe('absent ledger', () => {
    it('returns an empty summary tagged `unavailable` when no ledger exists', async () => {
      const summary = await collectSessions({ projectRoot: root, nowMs: Date.now() });
      expect(summary.active).toBe(0);
      expect(summary.degraded).toBe(0);
      expect(summary.stale).toBe(0);
      expect(summary.byHost).toEqual({});
      expect(summary.current).toEqual([]);
      expect(summary.freshness.source).toBe('sessions');
      expect(summary.freshness.state).toBe('unavailable');
      expect(summary.freshness.reason).toMatch(/not found/);
    });

    it('treats an empty ledger file as present but live-less (degraded)', async () => {
      writeLedger(root, []);
      const summary = await collectSessions({ projectRoot: root, nowMs: Date.now() });
      expect(summary.active).toBe(0);
      expect(summary.degraded).toBe(0);
      expect(summary.stale).toBe(0);
      expect(summary.freshness.state).toBe('degraded');
      expect(summary.freshness.reason).toMatch(/no live sessions/);
    });
  });

  // -------------------------------------------------------------------------
  // Single events
  // -------------------------------------------------------------------------

  describe('single events', () => {
    it('marks a session active on `session-start` within the active window', async () => {
      const now = Date.UTC(2026, 4, 21, 12, 0, 0);
      const ts = new Date(now - 5_000).toISOString();
      writeLedger(root, [
        makeEvent(ts, { repoRoot: root, event: 'session-start', sessionId: 's1' }),
      ]);
      const summary = await collectSessions({ projectRoot: root, nowMs: now });
      expect(summary.active).toBe(1);
      expect(summary.degraded).toBe(0);
      expect(summary.stale).toBe(0);
      expect(summary.byHost.codex).toEqual({
        active: 1,
        degraded: 0,
        stale: 0,
        lastSeenAt: ts,
      });
      expect(summary.current).toEqual([
        {
          hostCli: 'codex',
          sessionId: 's1',
          state: 'active',
          lastSeenAt: ts,
          producerKind: 'wrapper',
          confidence: 'derived',
        },
      ]);
      expect(summary.freshness.state).toBe('fresh');
      expect(summary.freshness.reason).toBeUndefined();
    });

    it('keeps the session active and advances lastSeenAt on a later heartbeat', async () => {
      const now = Date.UTC(2026, 4, 21, 12, 0, 0);
      const startTs = new Date(now - 10_000).toISOString();
      const beatTs = new Date(now - 2_000).toISOString();
      writeLedger(root, [
        makeEvent(startTs, { repoRoot: root, event: 'session-start', sessionId: 's1' }),
        makeEvent(beatTs, { repoRoot: root, event: 'session-heartbeat', sessionId: 's1' }),
      ]);
      const summary = await collectSessions({ projectRoot: root, nowMs: now });
      expect(summary.active).toBe(1);
      expect(summary.byHost.codex?.lastSeenAt).toBe(beatTs);
      expect(summary.current).toEqual([
        expect.objectContaining({ sessionId: 's1', state: 'active', lastSeenAt: beatTs }),
      ]);
      expect(summary.freshness.state).toBe('fresh');
    });

    it('marks the session inactive (not counted) after a `session-end`', async () => {
      const now = Date.UTC(2026, 4, 21, 12, 0, 0);
      const startTs = new Date(now - 10_000).toISOString();
      const endTs = new Date(now - 1_000).toISOString();
      writeLedger(root, [
        makeEvent(startTs, { repoRoot: root, event: 'session-start', sessionId: 's1' }),
        makeEvent(endTs, { repoRoot: root, event: 'session-end', sessionId: 's1' }),
      ]);
      const summary = await collectSessions({ projectRoot: root, nowMs: now });
      expect(summary.active).toBe(0);
      expect(summary.degraded).toBe(0);
      expect(summary.stale).toBe(0);
      expect(summary.byHost).toEqual({});
      expect(summary.current).toEqual([]);
      expect(summary.freshness.state).toBe('degraded');
      expect(summary.freshness.reason).toMatch(/no live sessions/);
    });
  });

  // -------------------------------------------------------------------------
  // Threshold ladder
  // -------------------------------------------------------------------------

  describe('age thresholds', () => {
    it('degrades a session whose newest event is older than the active window but within the stale window', async () => {
      const now = Date.UTC(2026, 4, 21, 12, 0, 0);
      // Comfortably outside the 15s window, well inside the 2m window.
      const ts = new Date(now - (SESSION_ACTIVE_THRESHOLD_MS + 5_000)).toISOString();
      writeLedger(root, [makeEvent(ts, { repoRoot: root, event: 'session-heartbeat' })]);
      const summary = await collectSessions({ projectRoot: root, nowMs: now });
      expect(summary.active).toBe(0);
      expect(summary.degraded).toBe(1);
      expect(summary.stale).toBe(0);
      expect(summary.byHost.codex?.degraded).toBe(1);
      expect(summary.current[0]?.state).toBe('degraded');
      expect(summary.freshness.state).toBe('degraded');
      expect(summary.freshness.reason).toMatch(/1 degraded session/);
    });

    it('marks a session stale once the newest event passes the 2-minute window', async () => {
      const now = Date.UTC(2026, 4, 21, 12, 0, 0);
      const ts = new Date(now - (SESSION_DEGRADED_THRESHOLD_MS + 1_000)).toISOString();
      writeLedger(root, [makeEvent(ts, { repoRoot: root, event: 'session-heartbeat' })]);
      const summary = await collectSessions({ projectRoot: root, nowMs: now });
      expect(summary.active).toBe(0);
      expect(summary.degraded).toBe(0);
      expect(summary.stale).toBe(1);
      expect(summary.byHost.codex?.stale).toBe(1);
      expect(summary.current[0]?.state).toBe('stale');
      expect(summary.freshness.state).toBe('stale');
      expect(summary.freshness.reason).toMatch(/1 stale session/);
    });

    it('escalates the freshness tag to the worst session state in the summary', async () => {
      const now = Date.UTC(2026, 4, 21, 12, 0, 0);
      const activeTs = new Date(now - 5_000).toISOString();
      const degradedTs = new Date(now - (SESSION_ACTIVE_THRESHOLD_MS + 10_000)).toISOString();
      const staleTs = new Date(now - (SESSION_DEGRADED_THRESHOLD_MS + 60_000)).toISOString();
      writeLedger(root, [
        makeEvent(activeTs, { repoRoot: root, event: 'session-heartbeat', sessionId: 's1' }),
        makeEvent(degradedTs, { repoRoot: root, event: 'session-heartbeat', sessionId: 's2' }),
        makeEvent(staleTs, { repoRoot: root, event: 'session-heartbeat', sessionId: 's3' }),
      ]);
      const summary = await collectSessions({ projectRoot: root, nowMs: now });
      expect(summary.active).toBe(1);
      expect(summary.degraded).toBe(1);
      expect(summary.stale).toBe(1);
      expect(summary.freshness.state).toBe('stale');
    });
  });

  // -------------------------------------------------------------------------
  // Corrupt-line tolerance
  // -------------------------------------------------------------------------

  describe('corrupt-line tolerance', () => {
    it('skips a malformed JSONL line and surfaces the count via freshness', async () => {
      const now = Date.UTC(2026, 4, 21, 12, 0, 0);
      const ts = new Date(now - 5_000).toISOString();
      // Live session is healthy, but the ledger has one parse-failure row in
      // the middle and one fully-formed-but-not-V1 row at the tail. The
      // collector must skip both and surface a single freshness downgrade.
      const malformed = '{ this is not json';
      const wrongShape = JSON.stringify({ version: 2, hello: 'world' });
      writeLedger(
        root,
        [makeEvent(ts, { repoRoot: root, event: 'session-heartbeat' })],
        [malformed, wrongShape],
      );
      const summary = await collectSessions({ projectRoot: root, nowMs: now });
      expect(summary.active).toBe(1);
      expect(summary.freshness.state).toBe('degraded');
      expect(summary.freshness.reason).toMatch(/skipped 2 corrupt session rows/);
    });

    it('reports the singular form when exactly one corrupt row is skipped', async () => {
      const now = Date.UTC(2026, 4, 21, 12, 0, 0);
      const ts = new Date(now - 1_000).toISOString();
      writeLedger(
        root,
        [makeEvent(ts, { repoRoot: root, event: 'session-heartbeat' })],
        ['{not json}'],
      );
      const summary = await collectSessions({ projectRoot: root, nowMs: now });
      expect(summary.active).toBe(1);
      expect(summary.freshness.state).toBe('degraded');
      expect(summary.freshness.reason).toBe('skipped 1 corrupt session row');
    });

    it('keeps freshness degraded when corrupt rows accompany an empty live set', async () => {
      const now = Date.UTC(2026, 4, 21, 12, 0, 0);
      writeLedger(root, [], ['{ not json }', '{ also not json }']);
      const summary = await collectSessions({ projectRoot: root, nowMs: now });
      expect(summary.active).toBe(0);
      expect(summary.degraded).toBe(0);
      expect(summary.stale).toBe(0);
      expect(summary.freshness.state).toBe('degraded');
      expect(summary.freshness.reason).toMatch(/skipped 2 corrupt session rows; no live sessions/);
    });
  });

  // -------------------------------------------------------------------------
  // Replay safety
  // -------------------------------------------------------------------------

  describe('replay safety', () => {
    it('does not resurrect an ended session when an older heartbeat arrives later in the file', async () => {
      // `session-end` is at `now`, a heartbeat earlier. The `end` must win
      // because its timestamp is strictly newer; this mirrors the recorder's
      // `sessionEventRank` semantics for ties as well.
      const now = Date.UTC(2026, 4, 21, 12, 0, 0);
      const endTs = new Date(now).toISOString();
      const beatTs = new Date(now - 5_000).toISOString();
      writeLedger(root, [
        makeEvent(endTs, { repoRoot: root, event: 'session-end' }),
        makeEvent(beatTs, { repoRoot: root, event: 'session-heartbeat' }),
      ]);
      const summary = await collectSessions({ projectRoot: root, nowMs: now + 1 });
      expect(summary.current).toEqual([]);
      expect(summary.active).toBe(0);
      expect(summary.degraded).toBe(0);
      expect(summary.stale).toBe(0);
    });

    it('prefers terminal events on identical timestamps', async () => {
      // Same `ts` on both events; `end` outranks `heartbeat` so the session
      // is treated as ended even when the heartbeat is appended last.
      const now = Date.UTC(2026, 4, 21, 12, 0, 0);
      const ts = new Date(now - 1_000).toISOString();
      writeLedger(root, [
        makeEvent(ts, { repoRoot: root, event: 'session-heartbeat', eventId: 'beat' }),
        makeEvent(ts, { repoRoot: root, event: 'session-end', eventId: 'end' }),
      ]);
      const summary = await collectSessions({ projectRoot: root, nowMs: now });
      expect(summary.current).toEqual([]);
      expect(summary.active).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Multi-host segregation
  // -------------------------------------------------------------------------

  describe('multi-host segregation', () => {
    it('attributes sessions to the correct host bucket', async () => {
      const now = Date.UTC(2026, 4, 21, 12, 0, 0);
      const codexTs = new Date(now - 3_000).toISOString();
      const geminiTs = new Date(now - (SESSION_ACTIVE_THRESHOLD_MS + 2_000)).toISOString();
      writeLedger(root, [
        makeEvent(codexTs, {
          repoRoot: root,
          hostCli: 'codex',
          sessionId: 's-codex',
          event: 'session-heartbeat',
        }),
        makeEvent(geminiTs, {
          repoRoot: root,
          hostCli: 'gemini',
          sessionId: 's-gemini',
          event: 'session-heartbeat',
        }),
      ]);
      const summary = await collectSessions({ projectRoot: root, nowMs: now });
      expect(summary.active).toBe(1);
      expect(summary.degraded).toBe(1);
      expect(summary.byHost.codex).toEqual({
        active: 1,
        degraded: 0,
        stale: 0,
        lastSeenAt: codexTs,
      });
      expect(summary.byHost.gemini).toEqual({
        active: 0,
        degraded: 1,
        stale: 0,
        lastSeenAt: geminiTs,
      });
      expect(summary.freshness.state).toBe('degraded');
    });
  });

  // -------------------------------------------------------------------------
  // Determinism
  // -------------------------------------------------------------------------

  describe('determinism', () => {
    it('returns the same summary when called twice with the same `nowMs`', async () => {
      const now = Date.UTC(2026, 4, 21, 12, 0, 0);
      const ts = new Date(now - 7_500).toISOString();
      writeLedger(root, [makeEvent(ts, { repoRoot: root, event: 'session-heartbeat' })]);
      const a = await collectSessions({ projectRoot: root, nowMs: now });
      const b = await collectSessions({ projectRoot: root, nowMs: now });
      expect(a).toEqual(b);
    });

    it('uses Date.now() when `nowMs` is omitted', async () => {
      const ts = new Date().toISOString();
      writeLedger(root, [makeEvent(ts, { repoRoot: root, event: 'session-heartbeat' })]);
      // The active-window threshold tolerates any clock jitter between writing
      // the fixture and the implicit `Date.now()` read inside the collector.
      const summary = await collectSessions({ projectRoot: root });
      expect(summary.active + summary.degraded).toBeGreaterThanOrEqual(1);
      expect(summary.stale).toBe(0);
    });
  });
});
