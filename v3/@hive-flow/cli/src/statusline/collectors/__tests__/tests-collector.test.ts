// v3/@hive-flow/cli/src/statusline/collectors/__tests__/tests-collector.test.ts
//
// Tests subsystem collector regression tests. These tests are intentionally
// independent of the Wave 2 recorder: every fixture is a canned JSONL ledger
// written directly to `.hive-flow/tests/last-run.jsonl`. That keeps the
// collector contract pinned even when the recorder's validation logic evolves
// in a sibling wave.
//
// Coverage (from the task brief + canonical runbook fold rules):
//   - Empty / missing ledger -> empty summary
//   - One suite event -> counts surfaced
//   - Two suite events -> latest wins, older dropped
//   - suite + later partial -> partial supplements, does NOT replace counts
//   - partial + later suite -> suite resets and the prior partial is dropped
//     (partials live between two adjacent suites only)
//   - partial-only ledger (no suite yet) -> partial surfaces in latestPartial
//   - Fingerprint mismatch -> stale: true BUT numeric counts still present
//   - Fingerprint match -> stale: false (fresh)
//   - Missing recorded fingerprint -> stale: true (cannot prove freshness)
//   - No fingerprint provided -> stale flag NOT set; counts pass through
//   - Malformed rows -> skipped silently
//
// Filename: deliberately `tests-collector.test.ts` to avoid name collision
// with any future `tests-recorder.test.ts` written by a sibling agent.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { collectTests } from '../tests.js';
import type {
  SourceFingerprintV1,
  TestRunEventV1,
  TestRunKind,
} from '../../types.js';

// ---------------------------------------------------------------------------
// Test fixture helpers (canned JSONL only -- no recorder import).
// ---------------------------------------------------------------------------

interface SuiteOverrides {
  eventId?: string;
  ts: string;
  passed?: number;
  failed?: number;
  skipped?: number;
  total?: number;
  sourceFingerprint?: string;
  scope?: string;
  runner?: string;
}

function makeEvent(kind: TestRunKind, overrides: SuiteOverrides): TestRunEventV1 {
  const passed = overrides.passed ?? 10;
  const failed = overrides.failed ?? 0;
  const skipped = overrides.skipped ?? 0;
  const total = overrides.total ?? passed + failed + skipped;
  return {
    version: 1,
    eventId: overrides.eventId ?? `${kind}-${overrides.ts}`,
    ts: overrides.ts,
    repoRoot: '/repo',
    projectKey: 'project-key',
    runner: overrides.runner ?? 'vitest',
    kind,
    scope: overrides.scope,
    passed,
    failed,
    skipped,
    total,
    producerKind: 'manual',
    producerId: 'test-fixture',
    sourceFingerprint: overrides.sourceFingerprint,
  };
}

function makeFingerprint(sha256: string): SourceFingerprintV1 {
  return {
    version: 1,
    observedAt: '2026-01-01T00:00:00.000Z',
    sha256,
    fileCount: 42,
    walkRoot: '/repo',
  };
}

function writeLedger(projectRoot: string, events: unknown[]): void {
  const dir = join(projectRoot, '.hive-flow', 'tests');
  mkdirSync(dir, { recursive: true });
  const body = events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
  writeFileSync(join(dir, 'last-run.jsonl'), body, { encoding: 'utf8', mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('collectTests', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hf-tests-collector-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns an empty summary when the ledger does not exist', async () => {
    const summary = await collectTests({ projectRoot: root });
    expect(summary).toEqual({});
  });

  it('returns an empty summary when the ledger is empty', async () => {
    writeLedger(root, []);
    const summary = await collectTests({ projectRoot: root });
    expect(summary).toEqual({});
  });

  it('surfaces counts for a single suite event', async () => {
    const suite = makeEvent('suite', {
      ts: '2026-01-01T00:00:00.000Z',
      passed: 47,
      failed: 0,
      skipped: 3,
      total: 50,
    });
    writeLedger(root, [suite]);

    const summary = await collectTests({ projectRoot: root });
    expect(summary.suite).toBeDefined();
    expect(summary.suite?.passed).toBe(47);
    expect(summary.suite?.failed).toBe(0);
    expect(summary.suite?.skipped).toBe(3);
    expect(summary.suite?.total).toBe(50);
    expect(summary.suite?.kind).toBe('suite');
    // No fingerprint provided -> stale flag not set on the summary.
    expect(summary.suite?.stale).toBeUndefined();
    expect(summary.latestPartial).toBeUndefined();
  });

  it('keeps the latest suite event when two suites are present (older dropped)', async () => {
    const older = makeEvent('suite', {
      eventId: 'older',
      ts: '2026-01-01T00:00:00.000Z',
      passed: 5,
      failed: 0,
      skipped: 0,
      total: 5,
    });
    const newer = makeEvent('suite', {
      eventId: 'newer',
      ts: '2026-01-01T01:00:00.000Z',
      passed: 12,
      failed: 1,
      skipped: 0,
      total: 13,
    });
    writeLedger(root, [older, newer]);

    const summary = await collectTests({ projectRoot: root });
    expect(summary.suite?.eventId).toBe('newer');
    expect(summary.suite?.passed).toBe(12);
    expect(summary.suite?.failed).toBe(1);
    expect(summary.suite?.total).toBe(13);
  });

  it('surfaces a later partial as a supplement without replacing suite counts', async () => {
    const suite = makeEvent('suite', {
      eventId: 'suite-1',
      ts: '2026-01-01T00:00:00.000Z',
      passed: 100,
      failed: 0,
      skipped: 0,
      total: 100,
    });
    const partial = makeEvent('partial', {
      eventId: 'partial-1',
      ts: '2026-01-01T00:30:00.000Z',
      passed: 14,
      failed: 0,
      skipped: 0,
      total: 14,
      scope: 'auth/*.test.ts',
    });
    writeLedger(root, [suite, partial]);

    const summary = await collectTests({ projectRoot: root });
    // Canonical suite counts MUST remain (not replaced by partial).
    expect(summary.suite?.passed).toBe(100);
    expect(summary.suite?.total).toBe(100);
    expect(summary.suite?.eventId).toBe('suite-1');
    // Partial surfaces as a supplement.
    expect(summary.latestPartial).toBeDefined();
    expect(summary.latestPartial?.passed).toBe(14);
    expect(summary.latestPartial?.total).toBe(14);
    expect(summary.latestPartial?.scope).toBe('auth/*.test.ts');
  });

  it('drops a prior partial when a later suite arrives (partials are between suites only)', async () => {
    const oldSuite = makeEvent('suite', {
      eventId: 'old-suite',
      ts: '2026-01-01T00:00:00.000Z',
      passed: 5,
      failed: 0,
      skipped: 0,
      total: 5,
    });
    const partial = makeEvent('partial', {
      eventId: 'partial-between',
      ts: '2026-01-01T00:30:00.000Z',
      passed: 3,
      failed: 0,
      skipped: 0,
      total: 3,
      scope: 'auth/*.test.ts',
    });
    const newSuite = makeEvent('suite', {
      eventId: 'new-suite',
      ts: '2026-01-01T01:00:00.000Z',
      passed: 50,
      failed: 0,
      skipped: 0,
      total: 50,
    });
    writeLedger(root, [oldSuite, partial, newSuite]);

    const summary = await collectTests({ projectRoot: root });
    expect(summary.suite?.eventId).toBe('new-suite');
    // The partial that ran between the two suites is dropped: it belongs
    // to the stale suite window, not the fresh one.
    expect(summary.latestPartial).toBeUndefined();
  });

  it('keeps a partial-only ledger as latestPartial when no suite has been observed', async () => {
    const partial = makeEvent('partial', {
      eventId: 'lonely-partial',
      ts: '2026-01-01T00:00:00.000Z',
      passed: 2,
      failed: 0,
      skipped: 0,
      total: 2,
      scope: 'lone-test',
    });
    writeLedger(root, [partial]);

    const summary = await collectTests({ projectRoot: root });
    expect(summary.suite).toBeUndefined();
    expect(summary.latestPartial?.eventId).toBe('lonely-partial');
  });

  it('marks the suite stale on fingerprint mismatch BUT preserves numeric counts', async () => {
    const suite = makeEvent('suite', {
      eventId: 'suite-fp',
      ts: '2026-01-01T00:00:00.000Z',
      passed: 95,
      failed: 1,
      skipped: 4,
      total: 100,
      sourceFingerprint: 'a'.repeat(64),
    });
    writeLedger(root, [suite]);

    const summary = await collectTests({
      projectRoot: root,
      fingerprint: makeFingerprint('b'.repeat(64)),
    });
    // Stale flag is set
    expect(summary.suite?.stale).toBe(true);
    expect(summary.suite?.staleReason).toBe(
      'source fingerprint changed since whole-suite test run',
    );
    // Counts MUST still be present (round-5 finding: render counts AND stale)
    expect(summary.suite?.passed).toBe(95);
    expect(summary.suite?.failed).toBe(1);
    expect(summary.suite?.skipped).toBe(4);
    expect(summary.suite?.total).toBe(100);
  });

  it('marks the suite fresh on fingerprint match', async () => {
    const fp = 'c'.repeat(64);
    const suite = makeEvent('suite', {
      eventId: 'suite-fresh',
      ts: '2026-01-01T00:00:00.000Z',
      passed: 10,
      failed: 0,
      skipped: 0,
      total: 10,
      sourceFingerprint: fp,
    });
    writeLedger(root, [suite]);

    const summary = await collectTests({
      projectRoot: root,
      fingerprint: makeFingerprint(fp),
    });
    expect(summary.suite?.stale).toBe(false);
    expect(summary.suite?.staleReason).toBeUndefined();
    expect(summary.suite?.total).toBe(10);
  });

  it('marks the suite stale when the recorded fingerprint is missing', async () => {
    const suite = makeEvent('suite', {
      eventId: 'no-fp',
      ts: '2026-01-01T00:00:00.000Z',
      passed: 7,
      failed: 0,
      skipped: 0,
      total: 7,
      sourceFingerprint: undefined,
    });
    writeLedger(root, [suite]);

    const summary = await collectTests({
      projectRoot: root,
      fingerprint: makeFingerprint('d'.repeat(64)),
    });
    // Cannot prove freshness without a recorded fingerprint -> stale.
    expect(summary.suite?.stale).toBe(true);
    expect(summary.suite?.staleReason).toBe(
      'source fingerprint changed since whole-suite test run',
    );
    // Counts still preserved.
    expect(summary.suite?.passed).toBe(7);
    expect(summary.suite?.total).toBe(7);
  });

  it('does not set a stale flag when no fingerprint is provided (counts pass through)', async () => {
    const suite = makeEvent('suite', {
      eventId: 'no-gate',
      ts: '2026-01-01T00:00:00.000Z',
      passed: 8,
      failed: 0,
      skipped: 0,
      total: 8,
      sourceFingerprint: 'e'.repeat(64),
    });
    writeLedger(root, [suite]);

    const summary = await collectTests({ projectRoot: root });
    // Stale flag is NOT set when caller did not request a freshness check.
    expect(summary.suite?.stale).toBeUndefined();
    expect(summary.suite?.staleReason).toBeUndefined();
    expect(summary.suite?.total).toBe(8);
  });

  it('skips malformed rows without throwing', async () => {
    const validSuite = makeEvent('suite', {
      eventId: 'valid',
      ts: '2026-01-01T00:00:00.000Z',
      passed: 3,
      failed: 0,
      skipped: 0,
      total: 3,
    });
    // Garbage row, wrong version, missing required fields, and wrong kind.
    const badRows: unknown[] = [
      { junk: true },
      { version: 2, eventId: 'wrong-version', ts: '2026-01-01T00:01:00.000Z', kind: 'suite' },
      { version: 1, eventId: 'missing-counts', ts: '2026-01-01T00:02:00.000Z', kind: 'suite' },
      { version: 1, kind: 'partial' },
    ];
    writeLedger(root, [...badRows, validSuite]);

    const summary = await collectTests({ projectRoot: root });
    expect(summary.suite?.eventId).toBe('valid');
    expect(summary.latestPartial).toBeUndefined();
  });

  it('preserves order: partial older than the latest suite is discarded even when it appears after in the ledger', async () => {
    // This guards against the rule being implemented as "last wins regardless".
    // Append order here is [suite-new, partial-stale-ts] but partial.ts is
    // BEFORE suite.ts so it should be discarded per the suite-resets rule.
    //
    // Note: under the literal "suite resets and clears partial" fold the
    // partial after the suite would only be kept if its ts >= suite.ts. We
    // assert the partial here is older and therefore dropped.
    const suite = makeEvent('suite', {
      eventId: 'fresh-suite',
      ts: '2026-01-01T01:00:00.000Z',
      passed: 10,
      failed: 0,
      skipped: 0,
      total: 10,
    });
    const stalePartial = makeEvent('partial', {
      eventId: 'older-partial',
      ts: '2026-01-01T00:30:00.000Z',
      passed: 1,
      failed: 0,
      skipped: 0,
      total: 1,
    });
    writeLedger(root, [suite, stalePartial]);

    const summary = await collectTests({ projectRoot: root });
    expect(summary.suite?.eventId).toBe('fresh-suite');
    expect(summary.latestPartial).toBeUndefined();
  });
});
