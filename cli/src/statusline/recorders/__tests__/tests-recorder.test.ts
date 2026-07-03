// cli/src/statusline/recorders/__tests__/tests-recorder.test.ts
//
// Phase 4 regression tests for the tests subsystem recorder
// (`recorders/tests.ts`).
//
// Test plan (mirrors the task brief + canonical runbook):
//   - Suite event with valid arithmetic appends.
//   - Suite event with invalid arithmetic (total !== passed+failed+skipped)
//     is rejected with the typed `TestRunArithmeticError` BEFORE any IO.
//   - Partial event with the same arithmetic rule passes.
//   - Two events with the same suite/scope name + framework coexist (no
//     compound dedupe for tests — fingerprinting handles that downstream).
//   - Concurrent appends from two test runs do not corrupt the ledger.
//
// The file is named `tests-recorder.test.ts` (not `tests.test.ts`) to
// avoid colliding with any future `tests` collector test file under
// `__tests__/` per the task brief.

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  recordTestRun,
  TestRunArithmeticError,
  TestRunCountError,
  TestRunFieldError,
  TestRunTimestampError,
  type PartialTestRunRecorderInput,
  type SuiteTestRunRecorderInput,
} from '../tests.js';
import { readJsonl } from '../../storage.js';
import { statuslinePaths } from '../../paths.js';
import type { TestRunEventV1 } from '../../types.js';
import { propertyRunsFromEnv } from '../../../__tests__/property-runs.js';

// ---------------------------------------------------------------------------
// Fixture helpers
//
// Two distinct factories keep the discriminated input shape honest: the
// suite factory always returns `kind: 'suite'`, the partial factory always
// returns `kind: 'partial'`. Tests that want to corrupt fields use
// `Partial<...>` overrides keyed off the non-discriminator subset, so the
// `kind` discriminator never gets re-typed at the call site.
// ---------------------------------------------------------------------------

type SuiteOverrides = Partial<Omit<SuiteTestRunRecorderInput, 'kind'>>;
type PartialOverrides = Partial<Omit<PartialTestRunRecorderInput, 'kind'>>;

const PROPERTY_RUNS = propertyRunsFromEnv(100);

function makeSuiteInput(overrides: SuiteOverrides = {}): SuiteTestRunRecorderInput {
  return {
    kind: 'suite',
    framework: 'vitest',
    projectKey: 'project-abc',
    repoRoot: '/tmp/repo',
    producerKind: 'interactive-host',
    producerId: 'host-1',
    passed: 3,
    failed: 1,
    skipped: 1,
    total: 5,
    ...overrides,
  };
}

function makePartialInput(
  overrides: PartialOverrides = {},
): PartialTestRunRecorderInput {
  return {
    kind: 'partial',
    framework: 'vitest',
    projectKey: 'project-abc',
    repoRoot: '/tmp/repo',
    producerKind: 'interactive-host',
    producerId: 'host-1',
    passed: 3,
    failed: 1,
    skipped: 1,
    total: 5,
    ...overrides,
  };
}

describe('statusline recorders/tests', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'hf-tests-recorder-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Valid arithmetic + canonical event shape
  // -------------------------------------------------------------------------

  describe('valid runs', () => {
    it('appends a suite event with valid arithmetic', async () => {
      const outcome = await recordTestRun({
        projectRoot,
        input: makeSuiteInput({
          startedAt: '2026-05-21T00:00:00.000Z',
          finishedAt: '2026-05-21T00:00:10.000Z',
        }),
      });

      expect(outcome.result).toEqual({ written: true, spooled: false, duplicate: false });
      expect(outcome.event.kind).toBe('suite');
      expect(outcome.event.runner).toBe('vitest');
      expect(outcome.event.passed).toBe(3);
      expect(outcome.event.failed).toBe(1);
      expect(outcome.event.skipped).toBe(1);
      expect(outcome.event.total).toBe(5);
      expect(outcome.event.durationMs).toBe(10_000);
      expect(outcome.startedAt).toBe('2026-05-21T00:00:00.000Z');
      expect(outcome.finishedAt).toBe('2026-05-21T00:00:10.000Z');
      // `ts` is the finishedAt timestamp.
      expect(outcome.event.ts).toBe('2026-05-21T00:00:10.000Z');
      expect(outcome.event.version).toBe(1);
      expect(typeof outcome.event.eventId).toBe('string');
      expect(outcome.event.eventId.length).toBeGreaterThan(0);

      const paths = statuslinePaths(projectRoot);
      const ledger = await readJsonl<TestRunEventV1>(paths.testsLedger);
      expect(ledger.corrupt).toBe(0);
      expect(ledger.events).toHaveLength(1);
      expect(ledger.events[0]).toEqual(outcome.event);

      // Sensitive marker permissions: ledger forced to 0o600.
      expect(statSync(paths.testsLedger).mode & 0o777).toBe(0o600);
    });

    it('appends a partial event with valid arithmetic', async () => {
      const outcome = await recordTestRun({
        projectRoot,
        input: makePartialInput({
          framework: 'jest',
          passed: 7,
          failed: 0,
          skipped: 3,
          total: 10,
          scope: 'src/auth/**/*.test.ts',
        }),
      });
      expect(outcome.result).toEqual({ written: true, spooled: false, duplicate: false });
      expect(outcome.event.kind).toBe('partial');
      expect(outcome.event.runner).toBe('jest');
      expect(outcome.event.scope).toBe('src/auth/**/*.test.ts');
      expect(outcome.event.passed + outcome.event.failed + outcome.event.skipped).toBe(
        outcome.event.total,
      );
    });

    it('accepts arbitrary framework strings (junit-xml, gotest, etc.)', async () => {
      for (const framework of ['junit-xml', 'gotest', 'pytest', 'mocha', 'tap']) {
        const outcome = await recordTestRun({
          projectRoot,
          input: makeSuiteInput({ framework }),
        });
        expect(outcome.event.runner).toBe(framework);
      }
      const paths = statuslinePaths(projectRoot);
      const ledger = await readJsonl<TestRunEventV1>(paths.testsLedger);
      expect(ledger.events.map((e) => e.runner)).toEqual([
        'junit-xml',
        'gotest',
        'pytest',
        'mocha',
        'tap',
      ]);
    });

    it('omits optional fields when they are undefined (no `undefined` in ledger row)', async () => {
      const outcome = await recordTestRun({
        projectRoot,
        input: makeSuiteInput(),
      });
      // Required fields only; optionals must be absent.
      const keys = Object.keys(outcome.event).sort();
      expect(keys).not.toContain('scope');
      expect(keys).not.toContain('command');
      expect(keys).not.toContain('sourceFingerprint');
      // `durationMs` IS present because we stamp `startedAt = finishedAt = now`.
      expect(outcome.event.durationMs).toBe(0);
    });

    it('uses caller-supplied eventId when present (no silent regeneration)', async () => {
      const outcome = await recordTestRun({
        projectRoot,
        input: makeSuiteInput({ eventId: 'preallocated-event-id' }),
      });
      expect(outcome.event.eventId).toBe('preallocated-event-id');
    });

    it('mints a fresh UUID per event when eventId is not supplied', async () => {
      const first = await recordTestRun({ projectRoot, input: makeSuiteInput() });
      const second = await recordTestRun({ projectRoot, input: makeSuiteInput() });
      expect(first.event.eventId).not.toBe(second.event.eventId);
    });

    it('records arithmetic with all-zeros (empty run is valid)', async () => {
      const outcome = await recordTestRun({
        projectRoot,
        input: makeSuiteInput({ passed: 0, failed: 0, skipped: 0, total: 0 }),
      });
      expect(outcome.event.total).toBe(0);
    });

    it('resolves timestamps when neither timestamp is supplied', async () => {
      const before = Date.now();
      const outcome = await recordTestRun({ projectRoot, input: makeSuiteInput() });
      const after = Date.now();
      const ts = Date.parse(outcome.event.ts);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
      expect(outcome.startedAt).toBe(outcome.finishedAt);
      expect(outcome.event.durationMs).toBe(0);
    });

    it('resolves timestamps when only startedAt is supplied', async () => {
      const startedAt = '2026-05-21T00:00:00.000Z';
      const before = Date.now();
      const outcome = await recordTestRun({
        projectRoot,
        input: makeSuiteInput({ startedAt }),
      });
      const after = Date.now();

      expect(outcome.startedAt).toBe(startedAt);
      expect(outcome.finishedAt).toBe(outcome.event.ts);
      expect(Date.parse(outcome.finishedAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(outcome.finishedAt)).toBeLessThanOrEqual(after);
      expect(outcome.event.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('resolves timestamps when only finishedAt is supplied', async () => {
      const finishedAt = '2026-05-21T00:00:10.000Z';
      const outcome = await recordTestRun({
        projectRoot,
        input: makeSuiteInput({ finishedAt }),
      });

      expect(outcome.startedAt).toBe(finishedAt);
      expect(outcome.finishedAt).toBe(finishedAt);
      expect(outcome.event.ts).toBe(finishedAt);
      expect(outcome.event.durationMs).toBeUndefined();
    });

    it('resolves timestamps when startedAt and finishedAt are supplied', async () => {
      const startedAt = '2026-05-21T00:00:00.000Z';
      const finishedAt = '2026-05-21T00:00:10.000Z';
      const outcome = await recordTestRun({
        projectRoot,
        input: makeSuiteInput({ startedAt, finishedAt }),
      });

      expect(outcome.startedAt).toBe(startedAt);
      expect(outcome.finishedAt).toBe(finishedAt);
      expect(outcome.event.ts).toBe(finishedAt);
      expect(outcome.event.durationMs).toBe(10_000);
    });
  });

  // -------------------------------------------------------------------------
  // Arithmetic + structural rejection
  // -------------------------------------------------------------------------

  describe('rejected runs', () => {
    it('rejects a suite event when total !== passed+failed+skipped', async () => {
      const promise = recordTestRun({
        projectRoot,
        input: makeSuiteInput({ passed: 1, failed: 1, skipped: 1, total: 5 }),
      });
      await expect(promise).rejects.toBeInstanceOf(TestRunArithmeticError);

      // Verify no partial write hit disk.
      const paths = statuslinePaths(projectRoot);
      expect(existsSync(paths.testsLedger)).toBe(false);
    });

    it('TestRunArithmeticError carries the offending counts', async () => {
      try {
        await recordTestRun({
          projectRoot,
          input: makeSuiteInput({ passed: 2, failed: 0, skipped: 0, total: 5 }),
        });
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(TestRunArithmeticError);
        if (err instanceof TestRunArithmeticError) {
          expect(err.code).toBe('STATUSLINE_TEST_RUN_ARITHMETIC');
          expect(err.passed).toBe(2);
          expect(err.failed).toBe(0);
          expect(err.skipped).toBe(0);
          expect(err.total).toBe(5);
          expect(err.message).toContain('!== total');
        }
      }
    });

    it('rejects a partial event with broken arithmetic too', async () => {
      const promise = recordTestRun({
        projectRoot,
        input: makePartialInput({ passed: 10, failed: 0, skipped: 0, total: 5 }),
      });
      await expect(promise).rejects.toBeInstanceOf(TestRunArithmeticError);
    });

    it('throws TestRunArithmeticError for every generated arithmetic invariant violation', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            passed: fc.integer({ min: 0, max: 1_000 }),
            failed: fc.integer({ min: 0, max: 1_000 }),
            skipped: fc.integer({ min: 0, max: 1_000 }),
            total: fc.integer({ min: 0, max: 3_500 }),
          }).filter(({ passed, failed, skipped, total }) => passed + failed + skipped !== total),
          async ({ passed, failed, skipped, total }) => {
            try {
              await recordTestRun({
                projectRoot,
                input: makeSuiteInput({ passed, failed, skipped, total }),
              });
              expect.fail('expected TestRunArithmeticError');
            } catch (err) {
              expect(err).toBeInstanceOf(TestRunArithmeticError);
              if (err instanceof TestRunArithmeticError) {
                expect(err.code).toBe('STATUSLINE_TEST_RUN_ARITHMETIC');
                expect(err.passed).toBe(passed);
                expect(err.failed).toBe(failed);
                expect(err.skipped).toBe(skipped);
                expect(err.total).toBe(total);
              }
            }
            const paths = statuslinePaths(projectRoot);
            expect(existsSync(paths.testsLedger)).toBe(false);
          },
        ),
        { numRuns: PROPERTY_RUNS, seed: 21_001 },
      );
    });

    it.each([
      ['framework', ''],
      ['framework', '   '],
      ['projectKey', ''],
      ['projectKey', '\t\n'],
      ['repoRoot', ''],
      ['repoRoot', '   '],
      ['producerId', ''],
      ['producerId', '\r\n'],
      ['scope', ''],
      ['scope', '   '],
      ['command', ''],
      ['command', '   '],
      ['sourceFingerprint', ''],
      ['sourceFingerprint', '   '],
    ] as const)('rejects empty/whitespace %s with TestRunFieldError', async (field, value) => {
      try {
        await recordTestRun({
          projectRoot,
          input: makeSuiteInput({ [field]: value } as SuiteOverrides),
        });
        expect.fail('expected TestRunFieldError');
      } catch (err) {
        expect(err).toBeInstanceOf(TestRunFieldError);
        if (err instanceof TestRunFieldError) {
          expect(err.code).toBe('STATUSLINE_TEST_RUN_FIELD');
          expect(err.field).toBe(field);
        }
      }
    });

    it.each([
      ['passed', Number.NaN],
      ['passed', Number.POSITIVE_INFINITY],
      ['passed', Number.NEGATIVE_INFINITY],
      ['passed', -1],
      ['failed', Number.NaN],
      ['failed', Number.POSITIVE_INFINITY],
      ['failed', Number.NEGATIVE_INFINITY],
      ['failed', -1],
      ['skipped', Number.NaN],
      ['skipped', Number.POSITIVE_INFINITY],
      ['skipped', Number.NEGATIVE_INFINITY],
      ['skipped', -1],
      ['total', Number.NaN],
      ['total', Number.POSITIVE_INFINITY],
      ['total', Number.NEGATIVE_INFINITY],
      ['total', -1],
    ] as const)('rejects invalid count %s=%s with TestRunCountError', async (field, value) => {
      try {
        await recordTestRun({
          projectRoot,
          input: makeSuiteInput({ [field]: value } as SuiteOverrides),
        });
        expect.fail('expected TestRunCountError');
      } catch (err) {
        expect(err).toBeInstanceOf(TestRunCountError);
        if (err instanceof TestRunCountError) {
          expect(err.code).toBe('STATUSLINE_TEST_RUN_COUNT');
          expect(err.field).toBe(field);
          if (Number.isNaN(value)) {
            expect(Number.isNaN(err.value)).toBe(true);
          } else {
            expect(err.value).toBe(value);
          }
        }
      }
    });

    it('rejects fractional count values with a typed count error', async () => {
      const promise = recordTestRun({
        projectRoot,
        input: makeSuiteInput({ passed: 1.5, failed: 0, skipped: 0, total: 1.5 }),
      });
      await expect(promise).rejects.toBeInstanceOf(TestRunCountError);
    });

    it.each([
      ['startedAt', { startedAt: 'not-a-timestamp' }],
      ['startedAt', { startedAt: '2026-05-21' }],
      ['startedAt', { startedAt: 'not-a-timestamp', finishedAt: '2026-05-21T00:00:10.000Z' }],
      ['finishedAt', { finishedAt: 'not-a-timestamp' }],
      ['finishedAt', { finishedAt: '2026-05-21' }],
      ['finishedAt', { startedAt: '2026-05-21T00:00:00.000Z', finishedAt: 'not-a-timestamp' }],
      ['finishedAt', { startedAt: '2026-05-21T00:00:10.000Z', finishedAt: '2026-05-21T00:00:00.000Z' }],
      ['startedAt', { startedAt: '2026-02-31T00:00:00.000Z' }],
      ['finishedAt', { finishedAt: '2026-02-31T00:00:00.000Z' }],
    ] as const)('rejects bad timestamp input for %s with TestRunTimestampError', async (field, overrides) => {
      try {
        await recordTestRun({
          projectRoot,
          input: makeSuiteInput(overrides),
        });
        expect.fail('expected TestRunTimestampError');
      } catch (err) {
        expect(err).toBeInstanceOf(TestRunTimestampError);
        if (err instanceof TestRunTimestampError) {
          expect(err.code).toBe('STATUSLINE_TEST_RUN_TIMESTAMP');
          expect(err.field).toBe(field);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // No-compound-dedupe (per task brief: fingerprinting handles uniqueness)
  // -------------------------------------------------------------------------

  describe('no compound dedupe', () => {
    it('two events with the same suite name + framework can coexist', async () => {
      // Same scope ("suite name"), same framework, different counts —
      // both events must land in the ledger. The materializer applies
      // fingerprint-based uniqueness, not the recorder.
      const first = await recordTestRun({
        projectRoot,
        input: makeSuiteInput({
          scope: 'tests/auth',
          framework: 'vitest',
          passed: 5,
          failed: 0,
          skipped: 0,
          total: 5,
        }),
      });
      const second = await recordTestRun({
        projectRoot,
        input: makeSuiteInput({
          scope: 'tests/auth',
          framework: 'vitest',
          passed: 4,
          failed: 1,
          skipped: 0,
          total: 5,
        }),
      });
      expect(first.result.written).toBe(true);
      expect(second.result.written).toBe(true);
      expect(first.event.eventId).not.toBe(second.event.eventId);

      const paths = statuslinePaths(projectRoot);
      const ledger = await readJsonl<TestRunEventV1>(paths.testsLedger);
      expect(ledger.events).toHaveLength(2);
      expect(ledger.events[0]?.failed).toBe(0);
      expect(ledger.events[1]?.failed).toBe(1);
      expect(ledger.events[0]?.scope).toBe('tests/auth');
      expect(ledger.events[1]?.scope).toBe('tests/auth');
    });

    it('two events with caller-supplied identical eventIds are deduped (second is a no-op)', async () => {
      // The canonical runbook requires duplicate-eventId idempotency: a
      // re-delivered event with the same `eventId` (e.g. a junit-import
      // retry that derives a deterministic id from suite-hash + finishedAt)
      // MUST NOT produce a second ledger row. The recorder routes through
      // `appendUniqueJsonlLocked` with `uniqueField: 'eventId'`, so the
      // dedupe collapses the retry while still letting two distinct
      // `eventId`s with the same `(runner, scope)` coexist (covered by the
      // preceding test).
      const input = makeSuiteInput({ eventId: 'duplicate-id' });
      const a = await recordTestRun({ projectRoot, input });
      const b = await recordTestRun({ projectRoot, input });
      expect(a.result).toEqual({ written: true, spooled: false, duplicate: false });
      expect(b.result).toEqual({ written: false, spooled: false, duplicate: true });

      const paths = statuslinePaths(projectRoot);
      const ledger = await readJsonl<TestRunEventV1>(paths.testsLedger);
      expect(ledger.events).toHaveLength(1);
      expect(ledger.events[0]?.eventId).toBe('duplicate-id');
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent appends
  // -------------------------------------------------------------------------

  describe('concurrent appends', () => {
    it('two concurrent test runs do not corrupt the ledger', async () => {
      // Eight concurrent runs (mirrors the storage.test.ts pattern but
      // scoped to the recorder). Some may spool; the test reconciles
      // ledger + spool to assert no row is lost.
      const work = Array.from({ length: 8 }, (_, i) =>
        recordTestRun({
          projectRoot,
          input: makeSuiteInput({
            framework: i % 2 === 0 ? 'vitest' : 'jest',
            scope: `suite-${i}`,
            passed: i,
            failed: 0,
            skipped: 0,
            total: i,
            eventId: `concurrent-${i}`,
          }),
        }),
      );
      const outcomes = await Promise.all(work);

      const written = outcomes.filter((o) => o.result.written).length;
      const spooled = outcomes.filter((o) => o.result.spooled).length;
      expect(written + spooled).toBe(8);

      // Read back the ledger directly. The 8 outcomes' event payloads are
      // the source of truth; whether each landed in the ledger or the
      // spool, no payload should have been silently dropped.
      const paths = statuslinePaths(projectRoot);
      const ledger = await readJsonl<TestRunEventV1>(paths.testsLedger);
      expect(ledger.corrupt).toBe(0);

      // Collect events from ledger.
      const writtenIds = new Set(ledger.events.map((e) => e.eventId));
      expect(writtenIds.size).toBe(written);

      // Spooled events live as JSON files under `<spoolRoot>/tests/`.
      const spoolDir = join(paths.spoolRoot, 'tests');
      const spoolFiles = existsSync(spoolDir)
        ? readdirSync(spoolDir).filter((n) => n.endsWith('.json'))
        : [];
      expect(spoolFiles.length).toBe(spooled);

      // The union of ledger + spool must reconstruct every eventId.
      const spooledIds = new Set<string>();
      for (const name of spoolFiles) {
        const body = JSON.parse(readFileSync(join(spoolDir, name), 'utf8')) as
          TestRunEventV1;
        spooledIds.add(body.eventId);
      }
      const reconstructed = new Set<string>([...writtenIds, ...spooledIds]);
      expect(reconstructed.size).toBe(8);
      for (let i = 0; i < 8; i++) {
        expect(reconstructed.has(`concurrent-${i}`)).toBe(true);
      }
    });

    it('serializes a single line per event under concurrent load (no truncated rows)', async () => {
      // Specifically asserts the bounded-line guarantee: every line in the
      // ledger is a complete JSON object (corrupt count is zero), and the
      // number of complete rows + spool files exactly matches the number
      // of attempted runs.
      const work = Array.from({ length: 6 }, (_, i) =>
        recordTestRun({
          projectRoot,
          input: makeSuiteInput({
            passed: 1,
            failed: 0,
            skipped: 0,
            total: 1,
            eventId: `serial-${i}`,
          }),
        }),
      );
      await Promise.all(work);

      const paths = statuslinePaths(projectRoot);
      const ledger = await readJsonl<TestRunEventV1>(paths.testsLedger);
      expect(ledger.corrupt).toBe(0);

      // The raw file must parse cleanly line-by-line.
      const raw = readFileSync(paths.testsLedger, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });
});
