// v3/@hive-flow/cli/src/statusline/__tests__/repair.test.ts
//
// Wave 6/7 regression tests for `repairLedger` and `repairAllLedgers`. These
// tests are deliberately decoupled from the recorders: each scenario writes
// its own canonical JSONL into the canonical ledger paths and asserts the
// repair fold-and-rewrite path produces the same shape as the collector.
//
// Coverage matrix (from the task brief + canonical runbook Phase 13.1):
//   - rebuild sessions.current.json from a valid sessions.jsonl
//   - rebuild scoreboard.current.json from valid presence + calls ledgers
//   - rebuild tests/current.json (+ current-suite, latest-partial sidecars)
//   - rebuild attention/current.json from emit + resolve events
//   - tolerate corrupt JSONL lines (counted on RepairResult, not thrown)
//   - missing ledger produces an empty current.json + freshness.state='absent'
//   - concurrent repair of two different targets does not race
//   - repairAllLedgers returns one result per target in declaration order
//   - shape of the written current.json equals the corresponding collector's
//     output (key contract for the renderer)
//   - rejects invalid options (empty projectRoot / unknown target)

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  REPAIR_TARGETS,
  repairAllLedgers,
  repairLedger,
  type RepairResult,
  type RepairTarget,
} from '../repair.js';
import { collectAttention } from '../collectors/attention.js';
import { collectScoreboard } from '../collectors/scoreboard.js';
import { collectSessions } from '../collectors/sessions.js';
import { collectTests } from '../collectors/tests.js';
import { SPOOL_LEDGER_NAMES, statuslinePaths } from '../paths.js';
import type { SpoolLedgerName } from '../paths.js';
import type {
  AttentionEventV1,
  AttentionItem,
  AttentionResolvedV1,
  ProviderCallEventV1,
  ScoreboardPresenceEventV1,
  SessionEventV1,
  TestRunEventV1,
} from '../types.js';

// ---------------------------------------------------------------------------
// Fixture helpers (canned JSONL only — no recorder dependency)
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.parse('2026-05-21T12:00:00.000Z');

function writeJsonlLedger(filePath: string, lines: ReadonlyArray<string>): void {
  mkdirSync(filePath.replace(/[/][^/]+$/, ''), { recursive: true });
  const body = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  writeFileSync(filePath, body, { encoding: 'utf8', mode: 0o600 });
}

function readJsonFile(filePath: string): unknown {
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function makeSessionEvent(
  ts: string,
  overrides: Partial<SessionEventV1> & { repoRoot: string },
): SessionEventV1 {
  const hostCli = overrides.hostCli ?? 'codex';
  const sessionId = overrides.sessionId ?? 's1';
  const kind = overrides.event ?? 'session-heartbeat';
  return {
    version: 1,
    eventId: overrides.eventId ?? `${hostCli}-${sessionId}-${kind}-${ts}`,
    ts,
    repoRoot: overrides.repoRoot,
    projectKey: overrides.projectKey ?? 'p',
    hostCli,
    sessionId,
    event: kind,
    sessionIdSource: overrides.sessionIdSource ?? 'wrapper',
    confidence: overrides.confidence ?? 'derived',
    producerKind: overrides.producerKind ?? 'wrapper',
    producerId: overrides.producerId ?? 'test',
  };
}

function makePresenceEvent(
  overrides: Partial<ScoreboardPresenceEventV1> & {
    eventId: string;
    event: ScoreboardPresenceEventV1['event'];
    provider: ScoreboardPresenceEventV1['provider'];
    presenceKey: string;
  },
): ScoreboardPresenceEventV1 {
  return {
    version: 1,
    eventId: overrides.eventId,
    ts: overrides.ts ?? new Date(FIXED_NOW - 1_000).toISOString(),
    repoRoot: overrides.repoRoot ?? '/repo',
    projectKey: overrides.projectKey ?? 'project-key',
    hostCli: overrides.hostCli ?? 'claude-code',
    provider: overrides.provider,
    producerKind: overrides.producerKind ?? 'interactive-host',
    producerId: overrides.producerId ?? 'test-host',
    presenceKey: overrides.presenceKey,
    event: overrides.event,
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
  };
}

function makeCallEvent(
  overrides: Partial<ProviderCallEventV1> & {
    eventId: string;
    event: ProviderCallEventV1['event'];
    provider: ProviderCallEventV1['provider'];
  },
): ProviderCallEventV1 {
  return {
    version: 1,
    eventId: overrides.eventId,
    ts: overrides.ts ?? new Date(FIXED_NOW - 1_000).toISOString(),
    repoRoot: overrides.repoRoot ?? '/repo',
    projectKey: overrides.projectKey ?? 'project-key',
    hostCli: overrides.hostCli ?? 'claude-code',
    provider: overrides.provider,
    producerKind: overrides.producerKind ?? 'interactive-host',
    producerId: overrides.producerId ?? 'test-host',
    event: overrides.event,
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.countWeight !== undefined ? { countWeight: overrides.countWeight } : {}),
    ...(overrides.tokensTotal !== undefined ? { tokensTotal: overrides.tokensTotal } : {}),
    ...(overrides.costUsd !== undefined ? { costUsd: overrides.costUsd } : {}),
    ...(overrides.ttfbMs !== undefined ? { ttfbMs: overrides.ttfbMs } : {}),
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
  };
}

function makeTestSuite(
  ts: string,
  overrides: Partial<TestRunEventV1> = {},
): TestRunEventV1 {
  return {
    version: 1,
    eventId: overrides.eventId ?? `suite-${ts}`,
    ts,
    repoRoot: overrides.repoRoot ?? '/repo',
    projectKey: overrides.projectKey ?? 'p',
    runner: overrides.runner ?? 'vitest',
    kind: 'suite',
    passed: overrides.passed ?? 10,
    failed: overrides.failed ?? 0,
    skipped: overrides.skipped ?? 0,
    total: overrides.total ?? 10,
    producerKind: overrides.producerKind ?? 'manual',
    producerId: overrides.producerId ?? 'test',
    ...(overrides.scope !== undefined ? { scope: overrides.scope } : {}),
    ...(overrides.durationMs !== undefined ? { durationMs: overrides.durationMs } : {}),
    ...(overrides.command !== undefined ? { command: overrides.command } : {}),
    ...(overrides.sourceFingerprint !== undefined
      ? { sourceFingerprint: overrides.sourceFingerprint }
      : {}),
  };
}

function makeAttentionItem(
  overrides: Partial<AttentionItem> & { id: string; ts: string; severity: AttentionItem['severity'] },
): AttentionItem {
  return {
    id: overrides.id,
    ts: overrides.ts,
    severity: overrides.severity,
    source: overrides.source ?? 'test',
    message: overrides.message ?? `message for ${overrides.id}`,
    redacted: overrides.redacted ?? false,
    ...(overrides.action !== undefined ? { action: overrides.action } : {}),
  };
}

function emitAttention(item: AttentionItem): AttentionEventV1 {
  return {
    eventId: `attn-emit-${item.id}`,
    ts: item.ts,
    event: 'emit',
    item,
  };
}

function resolveAttention(id: string, ts: string): AttentionResolvedV1 {
  return {
    eventId: `attn-resolve-${id}`,
    ts,
    event: 'resolve',
    id,
    reason: 'done',
    redacted: false,
  };
}

/**
 * Write a single spool entry under `<root>/.hive-flow/spool/<ledger>/<name>`.
 * Mirrors the format the recorders use when `appendJsonlLocked` loses the
 * ledger lock: an unsuffixed `.json` file containing a serialized event.
 * The repair path's pre-rebuild `drainSpool` must claim, write, and delete
 * each such file before the rebuild reads the canonical ledger.
 *
 * Deliberately bypasses the recorders so this test file is not coupled to
 * the parallel recorder patches landing in the same band.
 */
function spoolEntry(
  root: string,
  ledger: SpoolLedgerName,
  name: string,
  value: unknown,
): void {
  const dir = join(root, '.hive-flow', 'spool', ledger);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('repairLedger', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hf-repair-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  describe('sessions', () => {
    it('rebuilds sessions.current.json from a valid ledger', async () => {
      const paths = statuslinePaths(root);
      const startTs = new Date(FIXED_NOW - 5_000).toISOString();
      const beatTs = new Date(FIXED_NOW - 1_000).toISOString();
      writeJsonlLedger(paths.sessionsLedger, [
        JSON.stringify(makeSessionEvent(startTs, { repoRoot: root, event: 'session-start' })),
        JSON.stringify(makeSessionEvent(beatTs, { repoRoot: root, event: 'session-heartbeat' })),
      ]);

      const result = await repairLedger({ projectRoot: root, target: 'sessions', nowMs: FIXED_NOW });
      expect(result.target).toBe('sessions');
      expect(result.wroteCurrent).toBe(true);
      expect(result.ledgerPresent).toBe(true);
      expect(result.read).toBe(2);
      expect(result.corrupt).toBe(0);
      expect(result.freshness.state).toBe('fresh');

      const current = readJsonFile(paths.sessionsCurrent) as { active: number; current: unknown[]; freshness: { state: string } };
      expect(current.active).toBe(1);
      expect(current.current).toHaveLength(1);
      expect(current.freshness.state).toBe('fresh');
    });

    it('produces an empty current.json with freshness.state="absent" when the ledger is missing', async () => {
      const paths = statuslinePaths(root);
      const result = await repairLedger({ projectRoot: root, target: 'sessions', nowMs: FIXED_NOW });
      expect(result.ledgerPresent).toBe(false);
      expect(result.read).toBe(0);
      expect(result.corrupt).toBe(0);
      expect(result.freshness.state).toBe('absent');
      expect(result.freshness.reason).toMatch(/not found/);

      const current = readJsonFile(paths.sessionsCurrent) as { active: number; degraded: number; stale: number; current: unknown[] };
      expect(current.active).toBe(0);
      expect(current.degraded).toBe(0);
      expect(current.stale).toBe(0);
      expect(current.current).toEqual([]);
    });

    it('tolerates corrupted JSONL lines (logged in result, not thrown)', async () => {
      const paths = statuslinePaths(root);
      const ts = new Date(FIXED_NOW - 5_000).toISOString();
      writeJsonlLedger(paths.sessionsLedger, [
        JSON.stringify(makeSessionEvent(ts, { repoRoot: root, event: 'session-start' })),
        '{not valid json',
        '"a string not an object"',
      ]);

      const result = await repairLedger({ projectRoot: root, target: 'sessions', nowMs: FIXED_NOW });
      expect(result.corrupt).toBeGreaterThanOrEqual(1);
      expect(result.wroteCurrent).toBe(true);
      // The fold helper escalates fresh -> degraded when corrupt > 0.
      expect(result.freshness.state).toBe('degraded');
    });

    it('matches the shape returned by collectSessions for the same ledger', async () => {
      const paths = statuslinePaths(root);
      const ts = new Date(FIXED_NOW - 5_000).toISOString();
      writeJsonlLedger(paths.sessionsLedger, [
        JSON.stringify(makeSessionEvent(ts, { repoRoot: root, event: 'session-start' })),
      ]);

      await repairLedger({ projectRoot: root, target: 'sessions', nowMs: FIXED_NOW });
      const fromFile = readJsonFile(paths.sessionsCurrent);
      const fromCollector = await collectSessions({ projectRoot: root, nowMs: FIXED_NOW });
      expect(fromFile).toEqual(fromCollector);
    });
  });

  // -------------------------------------------------------------------------
  // Scoreboard
  // -------------------------------------------------------------------------

  describe('scoreboard', () => {
    it('rebuilds scoreboard.current.json from valid presence + calls ledgers', async () => {
      const paths = statuslinePaths(root);
      writeJsonlLedger(paths.scoreboardPresenceLedger, [
        JSON.stringify(
          makePresenceEvent({
            eventId: 'p1',
            event: 'agent-spawn',
            provider: 'codex',
            presenceKey: 'codex-1',
          }),
        ),
      ]);
      writeJsonlLedger(paths.scoreboardCallsLedger, [
        JSON.stringify(
          makeCallEvent({
            eventId: 'c1',
            event: 'call-start',
            provider: 'codex',
          }),
        ),
        JSON.stringify(
          makeCallEvent({
            eventId: 'c1',
            event: 'call-complete',
            provider: 'codex',
            tokensTotal: 1000,
          }),
        ),
      ]);

      const result = await repairLedger({
        projectRoot: root,
        target: 'scoreboard',
        nowMs: FIXED_NOW,
      });
      expect(result.target).toBe('scoreboard');
      expect(result.wroteCurrent).toBe(true);
      expect(result.ledgerPresent).toBe(true);
      expect(result.read).toBe(3);
      expect(result.corrupt).toBe(0);
      const current = readJsonFile(paths.scoreboardCurrent) as {
        agentsByProvider: Record<string, { activeAgents: number }>;
        callsByProvider: Record<string, { calls: number }>;
      };
      expect(current.agentsByProvider.codex?.activeAgents).toBe(1);
      expect(current.callsByProvider.codex?.calls).toBe(1);
    });

    it('produces an empty current.json with freshness.state="absent" when both ledgers are missing', async () => {
      const paths = statuslinePaths(root);
      const result = await repairLedger({
        projectRoot: root,
        target: 'scoreboard',
        nowMs: FIXED_NOW,
      });
      expect(result.ledgerPresent).toBe(false);
      expect(result.freshness.state).toBe('absent');
      const current = readJsonFile(paths.scoreboardCurrent) as {
        agentsByProvider: Record<string, unknown>;
        callsByProvider: Record<string, unknown>;
        stale: boolean;
      };
      expect(current.agentsByProvider).toEqual({});
      expect(current.callsByProvider).toEqual({});
      expect(current.stale).toBe(false);
    });

    it('does NOT apply the legacy provider-usage.json migration during repair', async () => {
      const paths = statuslinePaths(root);
      // Write a legacy migration file that, if applied, would inject `claude` calls.
      const legacyDir = join(root, '.hive-flow', 'metrics');
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(
        join(legacyDir, 'provider-usage.json'),
        JSON.stringify({
          providers: { claude: { calls: 99, tokens: 12345 } },
        }),
        { encoding: 'utf8', mode: 0o600 },
      );
      // No ledger events at all — only the legacy file.
      writeJsonlLedger(paths.scoreboardPresenceLedger, []);
      writeJsonlLedger(paths.scoreboardCallsLedger, []);

      await repairLedger({ projectRoot: root, target: 'scoreboard', nowMs: FIXED_NOW });
      const current = readJsonFile(paths.scoreboardCurrent) as {
        callsByProvider: Record<string, unknown>;
      };
      // The migration would have populated `claude`. Repair must NOT inject it.
      expect(current.callsByProvider).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // Tests
  // -------------------------------------------------------------------------

  describe('tests', () => {
    it('rebuilds tests/current.json from a valid ledger (and sidecars)', async () => {
      const paths = statuslinePaths(root);
      const suiteTs = new Date(FIXED_NOW - 30_000).toISOString();
      const partialTs = new Date(FIXED_NOW - 10_000).toISOString();
      writeJsonlLedger(paths.testsLedger, [
        JSON.stringify(makeTestSuite(suiteTs, { eventId: 'suite-1', passed: 5, total: 5 })),
        JSON.stringify({
          ...makeTestSuite(partialTs, { eventId: 'partial-1', passed: 2, total: 2 }),
          kind: 'partial',
          scope: 'unit',
        } as TestRunEventV1),
      ]);

      const result = await repairLedger({ projectRoot: root, target: 'tests', nowMs: FIXED_NOW });
      expect(result.target).toBe('tests');
      expect(result.read).toBe(2);
      expect(result.corrupt).toBe(0);
      expect(result.wroteCurrent).toBe(true);
      expect(result.freshness.state).toBe('fresh');

      const current = readJsonFile(paths.testsCurrent) as { suite?: { eventId: string }; latestPartial?: { eventId: string } };
      expect(current.suite?.eventId).toBe('suite-1');
      expect(current.latestPartial?.eventId).toBe('partial-1');

      const suiteSidecar = readJsonFile(paths.testsCurrentSuite) as { eventId: string };
      expect(suiteSidecar.eventId).toBe('suite-1');
      const partialSidecar = readJsonFile(paths.testsLatestPartial) as { eventId: string };
      expect(partialSidecar.eventId).toBe('partial-1');
    });

    it('produces an empty current.json with freshness.state="absent" when the ledger is missing', async () => {
      const paths = statuslinePaths(root);
      const result = await repairLedger({ projectRoot: root, target: 'tests', nowMs: FIXED_NOW });
      expect(result.ledgerPresent).toBe(false);
      expect(result.freshness.state).toBe('absent');
      const current = readJsonFile(paths.testsCurrent);
      expect(current).toEqual({});
    });

    it('matches the shape returned by collectTests for the same ledger', async () => {
      const paths = statuslinePaths(root);
      const ts = new Date(FIXED_NOW - 10_000).toISOString();
      writeJsonlLedger(paths.testsLedger, [
        JSON.stringify(makeTestSuite(ts, { eventId: 'suite-1', passed: 7, total: 7 })),
      ]);
      await repairLedger({ projectRoot: root, target: 'tests', nowMs: FIXED_NOW });
      const fromFile = readJsonFile(paths.testsCurrent);
      const fromCollector = await collectTests({ projectRoot: root });
      expect(fromFile).toEqual(fromCollector);
    });
  });

  // -------------------------------------------------------------------------
  // Attention
  // -------------------------------------------------------------------------

  describe('attention', () => {
    it('rebuilds attention/current.json from a valid ledger', async () => {
      const paths = statuslinePaths(root);
      const emitTs = new Date(FIXED_NOW - 60_000).toISOString();
      const resolveTs = new Date(FIXED_NOW - 30_000).toISOString();
      writeJsonlLedger(paths.attentionLedger, [
        JSON.stringify(
          emitAttention(makeAttentionItem({ id: 'a1', ts: emitTs, severity: 'critical' })),
        ),
        JSON.stringify(
          emitAttention(makeAttentionItem({ id: 'a2', ts: emitTs, severity: 'warn' })),
        ),
        JSON.stringify(resolveAttention('a2', resolveTs)),
      ]);

      const result = await repairLedger({
        projectRoot: root,
        target: 'attention',
        nowMs: FIXED_NOW,
      });
      expect(result.target).toBe('attention');
      expect(result.read).toBe(3);
      expect(result.corrupt).toBe(0);
      expect(result.wroteCurrent).toBe(true);
      expect(result.freshness.state).toBe('fresh');

      const current = readJsonFile(paths.attentionCurrent) as { unresolved: Array<{ id: string }> };
      expect(current.unresolved).toHaveLength(1);
      expect(current.unresolved[0]?.id).toBe('a1');
    });

    it('produces an empty current.json with freshness.state="absent" when the ledger is missing', async () => {
      const paths = statuslinePaths(root);
      const result = await repairLedger({
        projectRoot: root,
        target: 'attention',
        nowMs: FIXED_NOW,
      });
      expect(result.ledgerPresent).toBe(false);
      expect(result.freshness.state).toBe('absent');
      const current = readJsonFile(paths.attentionCurrent);
      expect(current).toEqual({ unresolved: [] });
    });

    it('matches the shape returned by collectAttention for the same ledger', async () => {
      const paths = statuslinePaths(root);
      // Include `action` so the JSON round-trip preserves every collector field
      // — `JSON.stringify` drops `undefined` values, so an item without an
      // action would have a different key set after a file round-trip than
      // the in-memory collector output. The collector copies `action` verbatim.
      const ts = new Date(FIXED_NOW - 60_000).toISOString();
      writeJsonlLedger(paths.attentionLedger, [
        JSON.stringify(
          emitAttention(
            makeAttentionItem({ id: 'a1', ts, severity: 'warn', action: 'restart' }),
          ),
        ),
      ]);
      await repairLedger({ projectRoot: root, target: 'attention', nowMs: FIXED_NOW });
      const fromFile = readJsonFile(paths.attentionCurrent);
      const fromCollector = await collectAttention({ projectRoot: root });
      // `collectAttention` doesn't accept nowMs (uses Date.now()), so ageSeconds
      // can drift between the file write and the collector read. Compare the
      // structural key set only (after JSON round-trip on the collector side so
      // both sides have undefined keys dropped).
      const fromCollectorRoundTripped: unknown = JSON.parse(JSON.stringify(fromCollector));
      const fileShape = (fromFile as { unresolved: Array<Record<string, unknown>> }).unresolved.map(
        (row) => Object.keys(row).sort(),
      );
      const collectorShape = (
        fromCollectorRoundTripped as { unresolved: Array<Record<string, unknown>> }
      ).unresolved.map((row) => Object.keys(row).sort());
      expect(fileShape).toEqual(collectorShape);
    });

    it('tolerates a malformed attention emit row (does not throw)', async () => {
      const paths = statuslinePaths(root);
      writeJsonlLedger(paths.attentionLedger, [
        // Missing required `item.severity` — the collector's guard rejects it.
        JSON.stringify({
          eventId: 'malformed',
          ts: new Date(FIXED_NOW).toISOString(),
          event: 'emit',
          item: { id: 'x', ts: 'now', message: 'hi', source: 's', redacted: false },
        }),
        '{not json}',
      ]);
      const result = await repairLedger({
        projectRoot: root,
        target: 'attention',
        nowMs: FIXED_NOW,
      });
      // One JSON.parse failure + one malformed-but-parseable emit. The collector
      // silently drops the malformed emit so RepairResult.corrupt reflects only
      // the JSON.parse failure.
      expect(result.corrupt).toBeGreaterThanOrEqual(1);
      const current = readJsonFile(paths.attentionCurrent) as { unresolved: unknown[] };
      expect(current.unresolved).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------

  describe('concurrency', () => {
    it('does not race when repairing two different targets in parallel', async () => {
      const paths = statuslinePaths(root);
      const sessionsTs = new Date(FIXED_NOW - 5_000).toISOString();
      const attnTs = new Date(FIXED_NOW - 1_000).toISOString();
      writeJsonlLedger(paths.sessionsLedger, [
        JSON.stringify(makeSessionEvent(sessionsTs, { repoRoot: root, event: 'session-start' })),
      ]);
      writeJsonlLedger(paths.attentionLedger, [
        JSON.stringify(
          emitAttention(makeAttentionItem({ id: 'a1', ts: attnTs, severity: 'critical' })),
        ),
      ]);

      const [r1, r2] = await Promise.all([
        repairLedger({ projectRoot: root, target: 'sessions', nowMs: FIXED_NOW }),
        repairLedger({ projectRoot: root, target: 'attention', nowMs: FIXED_NOW }),
      ]);

      expect(r1.wroteCurrent).toBe(true);
      expect(r2.wroteCurrent).toBe(true);
      expect(r1.freshness.state).toBe('fresh');
      expect(r2.freshness.state).toBe('fresh');

      const sessionsCurrent = readJsonFile(paths.sessionsCurrent) as { active: number };
      const attnCurrent = readJsonFile(paths.attentionCurrent) as { unresolved: unknown[] };
      expect(sessionsCurrent.active).toBe(1);
      expect(attnCurrent.unresolved).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Spool drain (Phase 3 binding: drain spool BEFORE rebuild)
  // -------------------------------------------------------------------------
  //
  // The runbook's Phase 3 says repair MUST drain the spool before reading the
  // ledger so a spooled event (recorder lost the lock at write time) is
  // folded into the rebuilt `*.current.json`. These tests write directly into
  // `.hive-flow/spool/<ledger>/<name>.json` (bypassing the recorders so this
  // suite is not coupled to the parallel recorder patches) and then call
  // `repairLedger`. After the call:
  //   - the spool file must be deleted (drained, not left behind)
  //   - the canonical ledger must contain the event (so it's never lost)
  //   - the rebuilt `*.current.json` must reflect the spooled event
  //   - the per-target `RepairResult` must carry a `spoolReport` whose
  //     `totals.drained` covers what we wrote
  //
  // A second `repairLedger` call must be idempotent: no double-count, no
  // change to the rebuilt current file.

  describe('spool drain before rebuild', () => {
    it('drains a spooled session-start so the session appears in sessions.current.json', async () => {
      const paths = statuslinePaths(root);
      const startTs = new Date(FIXED_NOW - 5_000).toISOString();
      const event = makeSessionEvent(startTs, {
        repoRoot: root,
        event: 'session-start',
      });
      spoolEntry(root, 'sessions', `${Date.now()}-1-sess.json`, event);

      const result = await repairLedger({
        projectRoot: root,
        target: 'sessions',
        nowMs: FIXED_NOW,
      });

      // Drain attached and reports the row we wrote.
      expect(result.spoolReport).toBeDefined();
      expect(result.spoolReport?.ledgers.sessions.drained).toBe(1);
      expect(result.spoolReport?.ledgers.sessions.deduped).toBe(0);
      expect(result.spoolReport?.totals.drained).toBe(1);

      // Spool file removed.
      const spoolDir = join(root, '.hive-flow', 'spool', 'sessions');
      expect(readdirSync(spoolDir).filter((n) => n.endsWith('.json'))).toEqual([]);

      // Ledger now contains the spooled row.
      expect(result.ledgerPresent).toBe(true);
      expect(result.read).toBe(1);

      // Rebuilt summary reflects the spooled session-start (active=1).
      const current = readJsonFile(paths.sessionsCurrent) as {
        active: number;
        current: Array<{ sessionId: string; hostCli: string }>;
      };
      expect(current.active).toBe(1);
      expect(current.current).toHaveLength(1);
      expect(current.current[0]?.sessionId).toBe(event.sessionId);
    });

    it('drains a spooled scoreboard call-start + call-complete pair (calls=1, inFlightCalls=0)', async () => {
      const paths = statuslinePaths(root);
      spoolEntry(
        root,
        'scoreboard-calls',
        `${Date.now()}-1-start.json`,
        makeCallEvent({
          eventId: 'c1',
          event: 'call-start',
          provider: 'codex',
        }),
      );
      spoolEntry(
        root,
        'scoreboard-calls',
        `${Date.now()}-2-complete.json`,
        makeCallEvent({
          eventId: 'c1',
          event: 'call-complete',
          provider: 'codex',
          tokensTotal: 1000,
        }),
      );

      const result = await repairLedger({
        projectRoot: root,
        target: 'scoreboard',
        nowMs: FIXED_NOW,
      });

      // Both events drained (compound (eventId, event) dedupe preserves the
      // start/complete pair as separate rows).
      expect(result.spoolReport?.ledgers['scoreboard-calls'].drained).toBe(2);
      expect(result.spoolReport?.totals.drained).toBe(2);
      expect(result.spoolReport?.totals.deduped).toBe(0);

      // Spool dir for calls is empty.
      const callsSpool = join(root, '.hive-flow', 'spool', 'scoreboard-calls');
      expect(readdirSync(callsSpool).filter((n) => n.endsWith('.json'))).toEqual([]);

      // Rebuilt summary reflects exactly one completed call (calls=1, no in-flight).
      // The collector treats `calls`, `failedCalls`, and `inFlightCalls` as
      // mutually exclusive — a completed call increments only `calls`, and
      // `inFlightCalls` is left unset (JSON.stringify drops the undefined key).
      const current = readJsonFile(paths.scoreboardCurrent) as {
        callsByProvider: Record<string, { calls: number; inFlightCalls?: number }>;
      };
      expect(current.callsByProvider.codex?.calls).toBe(1);
      expect(current.callsByProvider.codex?.inFlightCalls ?? 0).toBe(0);
    });

    it('drains a spooled tests suite so it appears in tests/current.json', async () => {
      const paths = statuslinePaths(root);
      const suiteTs = new Date(FIXED_NOW - 30_000).toISOString();
      spoolEntry(
        root,
        'tests',
        `${Date.now()}-1-suite.json`,
        makeTestSuite(suiteTs, {
          eventId: 'spooled-suite',
          passed: 7,
          total: 7,
        }),
      );

      const result = await repairLedger({
        projectRoot: root,
        target: 'tests',
        nowMs: FIXED_NOW,
      });

      expect(result.spoolReport?.ledgers.tests.drained).toBe(1);
      expect(result.spoolReport?.totals.drained).toBe(1);

      // Spool removed.
      const spoolDir = join(root, '.hive-flow', 'spool', 'tests');
      expect(readdirSync(spoolDir).filter((n) => n.endsWith('.json'))).toEqual([]);

      // Rebuilt summary reflects the spooled suite.
      const current = readJsonFile(paths.testsCurrent) as {
        suite?: { eventId: string; passed: number; total: number };
      };
      expect(current.suite?.eventId).toBe('spooled-suite');
      expect(current.suite?.passed).toBe(7);
      expect(current.suite?.total).toBe(7);
    });

    it('drains a spooled attention emit + resolve pair so the item is no longer unresolved', async () => {
      const paths = statuslinePaths(root);
      const emitTs = new Date(FIXED_NOW - 60_000).toISOString();
      const resolveTs = new Date(FIXED_NOW - 30_000).toISOString();
      spoolEntry(
        root,
        'attention',
        `${Date.now()}-1-emit.json`,
        emitAttention(
          makeAttentionItem({ id: 'spooled-a1', ts: emitTs, severity: 'warn' }),
        ),
      );
      spoolEntry(
        root,
        'attention',
        `${Date.now()}-2-resolve.json`,
        resolveAttention('spooled-a1', resolveTs),
      );

      const result = await repairLedger({
        projectRoot: root,
        target: 'attention',
        nowMs: FIXED_NOW,
      });

      expect(result.spoolReport?.ledgers.attention.drained).toBe(2);
      expect(result.spoolReport?.totals.drained).toBe(2);

      // The emit is resolved, so the item is NOT present in the rebuilt
      // summary (the collector keeps only unresolved items).
      const current = readJsonFile(paths.attentionCurrent) as {
        unresolved: Array<{ id: string }>;
      };
      expect(current.unresolved).toEqual([]);
    });

    it('repairAllLedgers drains every spool ledger and every current.json reflects it', async () => {
      const paths = statuslinePaths(root);
      const startTs = new Date(FIXED_NOW - 5_000).toISOString();
      const suiteTs = new Date(FIXED_NOW - 30_000).toISOString();
      const attnTs = new Date(FIXED_NOW - 60_000).toISOString();

      spoolEntry(
        root,
        'sessions',
        `${Date.now()}-1-sess.json`,
        makeSessionEvent(startTs, { repoRoot: root, event: 'session-start' }),
      );
      spoolEntry(
        root,
        'scoreboard-presence',
        `${Date.now()}-2-pres.json`,
        makePresenceEvent({
          eventId: 'p1',
          event: 'agent-spawn',
          provider: 'codex',
          presenceKey: 'codex-1',
        }),
      );
      spoolEntry(
        root,
        'scoreboard-calls',
        `${Date.now()}-3-call.json`,
        makeCallEvent({ eventId: 'c1', event: 'call-complete', provider: 'codex' }),
      );
      spoolEntry(
        root,
        'tests',
        `${Date.now()}-4-suite.json`,
        makeTestSuite(suiteTs, { eventId: 'all-suite', passed: 3, total: 3 }),
      );
      spoolEntry(
        root,
        'attention',
        `${Date.now()}-5-emit.json`,
        emitAttention(makeAttentionItem({ id: 'all-a1', ts: attnTs, severity: 'critical' })),
      );

      const results = await repairAllLedgers(root, { nowMs: FIXED_NOW });

      // Every result carries the same drain report and the totals cover all 5 ledgers.
      const reports = results.map((r) => r.spoolReport);
      expect(reports.every((r) => r !== undefined)).toBe(true);
      expect(reports.every((r) => r === reports[0])).toBe(true);
      expect(reports[0]?.totals.drained).toBe(5);
      expect(reports[0]?.totals.failed).toBe(0);
      expect(reports[0]?.ledgers.sessions.drained).toBe(1);
      expect(reports[0]?.ledgers['scoreboard-presence'].drained).toBe(1);
      expect(reports[0]?.ledgers['scoreboard-calls'].drained).toBe(1);
      expect(reports[0]?.ledgers.tests.drained).toBe(1);
      expect(reports[0]?.ledgers.attention.drained).toBe(1);

      // Every spool directory is empty after the drain.
      for (const name of SPOOL_LEDGER_NAMES) {
        const dir = join(root, '.hive-flow', 'spool', name);
        expect(readdirSync(dir).filter((n) => n.endsWith('.json'))).toEqual([]);
      }

      // Every rebuilt current.json reflects its spooled event.
      const sessionsCurrent = readJsonFile(paths.sessionsCurrent) as { active: number };
      expect(sessionsCurrent.active).toBe(1);

      const scoreboardCurrent = readJsonFile(paths.scoreboardCurrent) as {
        agentsByProvider: Record<string, { activeAgents: number }>;
        callsByProvider: Record<string, { calls: number }>;
      };
      expect(scoreboardCurrent.agentsByProvider.codex?.activeAgents).toBe(1);
      expect(scoreboardCurrent.callsByProvider.codex?.calls).toBe(1);

      const testsCurrent = readJsonFile(paths.testsCurrent) as {
        suite?: { eventId: string };
      };
      expect(testsCurrent.suite?.eventId).toBe('all-suite');

      const attnCurrent = readJsonFile(paths.attentionCurrent) as {
        unresolved: Array<{ id: string }>;
      };
      expect(attnCurrent.unresolved.map((r) => r.id)).toEqual(['all-a1']);
    });

    it('is idempotent: a second repairLedger immediately after sees the drain already done', async () => {
      const paths = statuslinePaths(root);
      const startTs = new Date(FIXED_NOW - 5_000).toISOString();
      spoolEntry(
        root,
        'sessions',
        `${Date.now()}-1-sess.json`,
        makeSessionEvent(startTs, { repoRoot: root, event: 'session-start' }),
      );

      const first = await repairLedger({
        projectRoot: root,
        target: 'sessions',
        nowMs: FIXED_NOW,
      });
      expect(first.spoolReport?.ledgers.sessions.drained).toBe(1);
      const firstCurrent = readJsonFile(paths.sessionsCurrent);

      // Re-run. The drain has nothing to do, the ledger is unchanged, and the
      // rebuild produces the same `current.json`.
      const second = await repairLedger({
        projectRoot: root,
        target: 'sessions',
        nowMs: FIXED_NOW,
      });
      expect(second.spoolReport?.ledgers.sessions.drained).toBe(0);
      expect(second.spoolReport?.ledgers.sessions.deduped).toBe(0);
      expect(second.spoolReport?.totals.drained).toBe(0);
      // Ledger row count unchanged (no double-count).
      expect(second.read).toBe(1);
      const secondCurrent = readJsonFile(paths.sessionsCurrent);
      expect(secondCurrent).toEqual(firstCurrent);
    });
  });

  // -------------------------------------------------------------------------
  // Argument validation
  // -------------------------------------------------------------------------

  describe('argument validation', () => {
    it('rejects an empty projectRoot', async () => {
      await expect(
        repairLedger({ projectRoot: '', target: 'tests' }),
      ).rejects.toThrow(/projectRoot/);
    });

    it('rejects an unknown target', async () => {
      await expect(
        repairLedger({ projectRoot: root, target: 'unknown' as RepairTarget }),
      ).rejects.toThrow(/target/);
    });
  });
});

// ---------------------------------------------------------------------------
// repairAllLedgers
// ---------------------------------------------------------------------------

describe('repairAllLedgers', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hf-repair-all-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns one RepairResult per canonical target in declaration order', async () => {
    const results: ReadonlyArray<RepairResult> = await repairAllLedgers(root, { nowMs: FIXED_NOW });
    expect(results.map((r) => r.target)).toEqual([...REPAIR_TARGETS]);
    expect(results.every((r) => r.wroteCurrent)).toBe(true);
    expect(results.every((r) => r.ledgerPresent === false)).toBe(true);
    expect(results.every((r) => r.freshness.state === 'absent')).toBe(true);
  });

  it('writes every canonical *.current.json on a cold project', async () => {
    const paths = statuslinePaths(root);
    await repairAllLedgers(root, { nowMs: FIXED_NOW });
    // Each target's `current.json` must exist and parse to an object.
    const sessionsCurrent = readJsonFile(paths.sessionsCurrent);
    const scoreboardCurrent = readJsonFile(paths.scoreboardCurrent);
    const testsCurrent = readJsonFile(paths.testsCurrent);
    const attentionCurrent = readJsonFile(paths.attentionCurrent);
    expect(sessionsCurrent).toMatchObject({ active: 0, degraded: 0, stale: 0 });
    expect(scoreboardCurrent).toMatchObject({ agentsByProvider: {}, callsByProvider: {} });
    expect(testsCurrent).toEqual({});
    expect(attentionCurrent).toEqual({ unresolved: [] });
  });

  it('rejects an empty projectRoot', async () => {
    await expect(repairAllLedgers('')).rejects.toThrow(/projectRoot/);
  });
});
