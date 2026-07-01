// v3/@hive-flow/cli/src/statusline/recorders/__tests__/scoreboard.test.ts
//
// Phase 6 regression tests for the scoreboard recorder.
//
// Required coverage (task brief 2026-05-21):
//   - call-start increments the in-flight count for a known provider
//   - agent-spawn increments the active-agent count for a known provider
//   - duplicate event (same eventId + event) is dropped (compound dedupe)
//   - replaying the same event after a simulated crash is idempotent
//   - unknown provider is rejected with the typed ScoreboardProviderError
//   - concurrent appends from two providers do not corrupt the ledger
//
// Plus defensive coverage to lock the contract:
//   - call-complete promotes the in-flight call to a completed call
//   - wrapper producer is rejected for provider calls
//   - malformed event (bad ts, bad version) is rejected with ScoreboardEventError
//   - agent-end suppresses the presence row from the live summary

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  computeScoreboardSummary,
  recordPresenceEvent,
  recordProviderCall,
  recordScoreboardEvent,
  readScoreboardSummary,
  ScoreboardEventError,
  ScoreboardProviderError,
} from '../scoreboard.js';
import type {
  ProviderCallEventV1,
  ScoreboardPresenceEventV1,
} from '../../types.js';

describe('scoreboard recorder', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hf-scoreboard-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Builders (no `as any`; we use typed literals)
  // -------------------------------------------------------------------------

  function callBase(): Omit<ProviderCallEventV1, 'event' | 'ts'> {
    return {
      version: 1,
      eventId: 'call-1',
      repoRoot: root,
      projectKey: 'p',
      hostCli: 'codex',
      provider: 'codex',
      producerKind: 'manual',
      producerId: 'test',
    };
  }

  function presenceBase(): Omit<ScoreboardPresenceEventV1, 'event' | 'eventId' | 'ts'> {
    return {
      version: 1,
      repoRoot: root,
      projectKey: 'p',
      hostCli: 'codex',
      provider: 'codex',
      producerKind: 'wrapper',
      producerId: 'test',
      presenceKey: 'codex:s1',
      sessionId: 's1',
    };
  }

  // -------------------------------------------------------------------------
  // Required: call-start increments the in-flight count
  // -------------------------------------------------------------------------

  describe('recordProviderCall', () => {
    it('call-start increments the in-flight count for a known provider', async () => {
      const result = await recordProviderCall({
        ...callBase(),
        eventId: 'call-1',
        ts: '2026-05-21T00:00:00.000Z',
        event: 'call-start',
      });
      expect(result).toEqual({ ok: true, written: true, spooled: false, duplicate: false });
      const summary = await computeScoreboardSummary(root);
      expect(summary.callsByProvider.codex?.inFlightCalls).toBe(1);
      expect(summary.callsByProvider.codex?.calls).toBe(0);
    });

    it('call-complete promotes the in-flight call to a completed call', async () => {
      const base = callBase();
      await recordProviderCall({ ...base, ts: '2026-05-21T00:00:00.000Z', event: 'call-start' });
      await recordProviderCall({
        ...base,
        ts: '2026-05-21T00:00:02.000Z',
        event: 'call-complete',
        tokensTotal: 42,
        costUsd: 0.1,
      });
      const summary = await computeScoreboardSummary(root);
      expect(summary.callsByProvider.codex?.calls).toBe(1);
      expect(summary.callsByProvider.codex?.inFlightCalls ?? 0).toBe(0);
      expect(summary.callsByProvider.codex?.tokensTotal).toBe(42);
      expect(summary.callsByProvider.codex?.costUsd).toBe(0.1);
    });

    it('duplicate event (same eventId + event) is dropped via compound dedupe', async () => {
      const base = callBase();
      const start: ProviderCallEventV1 = {
        ...base,
        ts: '2026-05-21T00:00:00.000Z',
        event: 'call-start',
      };
      const a = await recordProviderCall(start);
      const b = await recordProviderCall(start); // exact replay
      expect(a.written).toBe(true);
      expect(a.duplicate).toBe(false);
      expect(b.written).toBe(false);
      expect(b.duplicate).toBe(true);

      const ledgerPath = join(root, '.hive-flow/scoreboard/calls.jsonl');
      const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);

      // Compound dedupe must NOT block a different `event` on the same `eventId`.
      const complete: ProviderCallEventV1 = {
        ...base,
        ts: '2026-05-21T00:00:02.000Z',
        event: 'call-complete',
      };
      const c = await recordProviderCall(complete);
      expect(c.written).toBe(true);
      expect(c.duplicate).toBe(false);
    });

    it('replaying the same event after a crash is idempotent (spool-replay safety)', async () => {
      // Simulate the drainer-replay path: the same call-start event flows
      // through the recorder twice (once as the original, once as a spool
      // replay). The compound key on the canonical ledger must drop the
      // second one without producing a second ledger row or double-counting
      // in the reader summary.
      const base = callBase();
      const event: ProviderCallEventV1 = {
        ...base,
        eventId: 'call-replay-1',
        ts: '2026-05-21T00:00:00.000Z',
        event: 'call-start',
      };
      const a = await recordProviderCall(event);
      const b = await recordProviderCall(event);
      const c = await recordProviderCall(event);
      expect(a.written).toBe(true);
      expect(b.duplicate).toBe(true);
      expect(c.duplicate).toBe(true);

      const summary = await computeScoreboardSummary(root);
      // After three replays we still see exactly ONE in-flight call.
      expect(summary.callsByProvider.codex?.inFlightCalls).toBe(1);
      expect(summary.callsByProvider.codex?.calls).toBe(0);

      // And the on-disk ledger has exactly one row.
      const ledgerPath = join(root, '.hive-flow/scoreboard/calls.jsonl');
      const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
    });

    it('rejects an unknown provider with a typed ScoreboardProviderError', async () => {
      // We intentionally cast through `unknown` to a structural shape so the
      // runtime path is exercised without any explicit `as any`.
      const malformed = {
        ...callBase(),
        provider: 'not-a-real-provider',
        ts: '2026-05-21T00:00:00.000Z',
        event: 'call-start',
      } as unknown as ProviderCallEventV1;
      await expect(recordProviderCall(malformed)).rejects.toBeInstanceOf(ScoreboardProviderError);
    });

    it('rejects a wrapper producer for provider calls', async () => {
      const malformed = {
        ...callBase(),
        producerKind: 'wrapper',
        ts: '2026-05-21T00:00:00.000Z',
        event: 'call-start',
      } as unknown as ProviderCallEventV1;
      await expect(recordProviderCall(malformed)).rejects.toBeInstanceOf(ScoreboardEventError);
    });

    it('rejects a malformed timestamp with a typed ScoreboardEventError', async () => {
      const malformed = {
        ...callBase(),
        ts: 'not-a-real-timestamp',
        event: 'call-start',
      } as unknown as ProviderCallEventV1;
      await expect(recordProviderCall(malformed)).rejects.toBeInstanceOf(ScoreboardEventError);
    });

    it('rejects a non-version-1 envelope with a typed ScoreboardEventError', async () => {
      const malformed = {
        ...callBase(),
        version: 2,
        ts: '2026-05-21T00:00:00.000Z',
        event: 'call-start',
      } as unknown as ProviderCallEventV1;
      await expect(recordProviderCall(malformed)).rejects.toBeInstanceOf(ScoreboardEventError);
    });

    it('rejects a non-positive countWeight with a typed ScoreboardEventError', async () => {
      const malformed = {
        ...callBase(),
        ts: '2026-05-21T00:00:00.000Z',
        event: 'call-complete',
        countWeight: 0,
      } as unknown as ProviderCallEventV1;
      await expect(recordProviderCall(malformed)).rejects.toBeInstanceOf(ScoreboardEventError);
    });
  });

  // -------------------------------------------------------------------------
  // Required: agent-spawn increments count
  // -------------------------------------------------------------------------

  describe('recordPresenceEvent', () => {
    it('agent-spawn increments the active-agent count for a known provider', async () => {
      const event: ScoreboardPresenceEventV1 = {
        ...presenceBase(),
        eventId: 'p1',
        ts: '2026-05-21T00:00:00.000Z',
        event: 'agent-spawn',
      };
      const result = await recordPresenceEvent(event);
      expect(result.written).toBe(true);
      const summary = await computeScoreboardSummary(root, Date.parse('2026-05-21T00:00:00.001Z'));
      expect(summary.agentsByProvider.codex?.activeAgents).toBe(1);
      expect(summary.agentsByProvider.codex?.idleAgents).toBe(0);
      expect(summary.agentsByProvider.codex?.staleAgents).toBe(0);
    });

    it('agent-end suppresses the presence row from the live summary', async () => {
      const base = presenceBase();
      await recordPresenceEvent({
        ...base,
        eventId: 'p1',
        ts: '2026-05-21T00:00:00.000Z',
        event: 'agent-spawn',
      });
      await recordPresenceEvent({
        ...base,
        eventId: 'p2',
        ts: '2026-05-21T00:00:01.000Z',
        event: 'agent-end',
      });
      const summary = await computeScoreboardSummary(root, Date.parse('2026-05-21T00:00:01.500Z'));
      expect(summary.agentsByProvider.codex?.activeAgents ?? 0).toBe(0);
      expect(summary.agentsByProvider.codex?.idleAgents ?? 0).toBe(0);
    });

    it('agent-spawn rejects an unknown provider with a typed error', async () => {
      const malformed = {
        ...presenceBase(),
        provider: 'not-a-real-provider',
        eventId: 'p1',
        ts: '2026-05-21T00:00:00.000Z',
        event: 'agent-spawn',
      } as unknown as ScoreboardPresenceEventV1;
      await expect(recordPresenceEvent(malformed)).rejects.toBeInstanceOf(ScoreboardProviderError);
    });

    it('duplicate presence event with same eventId is dropped', async () => {
      const event: ScoreboardPresenceEventV1 = {
        ...presenceBase(),
        eventId: 'p-dup',
        ts: '2026-05-21T00:00:00.000Z',
        event: 'agent-spawn',
      };
      const a = await recordPresenceEvent(event);
      const b = await recordPresenceEvent(event);
      expect(a.written).toBe(true);
      expect(b.duplicate).toBe(true);
      const ledgerPath = join(root, '.hive-flow/scoreboard/presence.jsonl');
      const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Required: concurrent appends from two providers don't corrupt
  // -------------------------------------------------------------------------

  describe('concurrency', () => {
    it('concurrent appends from two providers do not corrupt the call ledger', async () => {
      const codexEvent: ProviderCallEventV1 = {
        version: 1,
        eventId: 'codex-1',
        ts: '2026-05-21T00:00:00.000Z',
        repoRoot: root,
        projectKey: 'p',
        hostCli: 'codex',
        provider: 'codex',
        producerKind: 'manual',
        producerId: 'test-codex',
        event: 'call-complete',
        tokensTotal: 100,
        costUsd: 0.5,
      };
      const claudeEvent: ProviderCallEventV1 = {
        version: 1,
        eventId: 'claude-1',
        ts: '2026-05-21T00:00:00.500Z',
        repoRoot: root,
        projectKey: 'p',
        hostCli: 'claude-code',
        provider: 'claude',
        producerKind: 'manual',
        producerId: 'test-claude',
        event: 'call-complete',
        tokensTotal: 200,
        costUsd: 1.0,
      };

      // Fire both concurrently; the lock + spool fallback in the Wave 2
      // storage layer must guarantee both events reach durable storage
      // exactly once (one wins the lock and writes the canonical ledger;
      // the loser spools; or both win serially — either way exactly one
      // canonical row per eventId).
      const [codexResult, claudeResult] = await Promise.all([
        recordProviderCall(codexEvent),
        recordProviderCall(claudeEvent),
      ]);

      // Both calls must succeed: either both written, or one written + one
      // spooled — but no corruption, no thrown errors, no duplicate flags.
      expect(codexResult.ok).toBe(true);
      expect(claudeResult.ok).toBe(true);
      expect(codexResult.duplicate).toBe(false);
      expect(claudeResult.duplicate).toBe(false);
      // Exactly one of {written, spooled} is true per call result.
      expect(codexResult.written !== codexResult.spooled).toBe(true);
      expect(claudeResult.written !== claudeResult.spooled).toBe(true);

      // If anything spooled, drain it back through the recorder so the final
      // canonical ledger contains both events. The compound dedupe key on the
      // ledger guarantees idempotency of the drain.
      const drained = await import('../../storage.js');
      const entries = await drained.readSpoolEntries<ProviderCallEventV1>(
        join(root, '.hive-flow/spool'),
        'scoreboard-calls',
      );
      for (const entry of entries) {
        const replay = await recordProviderCall(entry.event);
        // Replay always either writes (lock free) or marks duplicate (already
        // present); it must never spool again (lock now uncontended).
        expect(replay.spooled).toBe(false);
        if (replay.written || replay.duplicate) {
          await drained.deleteSpoolEntry(entry.path);
        } else {
          await drained.restoreSpoolEntry(entry.path, entry.originalPath);
        }
      }

      const summary = await computeScoreboardSummary(root);
      expect(summary.callsByProvider.codex?.calls).toBe(1);
      expect(summary.callsByProvider.claude?.calls).toBe(1);
      expect(summary.callsByProvider.codex?.tokensTotal).toBe(100);
      expect(summary.callsByProvider.claude?.tokensTotal).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Materialized snapshot + unified recorder
  // -------------------------------------------------------------------------

  describe('materialized snapshot', () => {
    it('writes scoreboard/current.json on successful append', async () => {
      await recordProviderCall({
        ...callBase(),
        ts: '2026-05-21T00:00:00.000Z',
        event: 'call-complete',
        tokensTotal: 7,
      });
      const summary = await readScoreboardSummary(root);
      expect(summary).toBeDefined();
      expect(summary?.callsByProvider.codex?.calls).toBe(1);
      expect(summary?.callsByProvider.codex?.tokensTotal).toBe(7);
    });

    it('recordScoreboardEvent dispatches presence and call events correctly', async () => {
      const presence: ScoreboardPresenceEventV1 = {
        ...presenceBase(),
        eventId: 'unified-p1',
        ts: '2026-05-21T00:00:00.000Z',
        event: 'agent-spawn',
      };
      const call: ProviderCallEventV1 = {
        ...callBase(),
        eventId: 'unified-c1',
        ts: '2026-05-21T00:00:01.000Z',
        event: 'call-complete',
      };
      const a = await recordScoreboardEvent(presence);
      const b = await recordScoreboardEvent(call);
      expect(a.written).toBe(true);
      expect(b.written).toBe(true);
      const summary = await computeScoreboardSummary(root, Date.parse('2026-05-21T00:00:01.500Z'));
      expect(summary.agentsByProvider.codex?.activeAgents).toBe(1);
      expect(summary.callsByProvider.codex?.calls).toBe(1);
    });
  });
});
