// v3/@hive-flow/cli/src/statusline/__tests__/ledger-compact.test.ts
//
// Phase 13.3 regression tests for `ledger-compact.ts`. Covers:
//   - keep last N of M (M > N) -- truncates to the most recent N
//   - keep last N where M < N -- no-op, wroteCurrent=false
//   - keep N where N === M and no corruption -- no-op
//   - drop corrupt lines, keep last N valid
//   - missing ledger file -- no-op, no throw
//   - keep < 1 (and non-integer) -- typed error before any FS op
//   - target not in SPOOL_LEDGER_NAMES -- typed error before any FS op
//   - symlinked ledger -- typed error from underlying storage primitive
//   - atomic semantics under simulated mid-rewrite crash -- ledger
//     remains consistent (one of the two states, never partial)
//   - concurrent compactions of different targets do not race
//   - live lock refusal (runbook contract -- compaction must not silently
//     fall through when another owner holds the ledger)
//
// We use the public `compactLedger` API for the canonical paths and
// `compactJsonl` for ad-hoc paths in the crash-simulation and lock-refusal
// tests. Both share the same internal routine so behavioural coverage is
// equivalent.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

import {
  StatuslineCompactKeepError,
  StatuslineCompactLockError,
  StatuslineSpoolLedgerNameError,
  compactAllLedgers,
  compactJsonl,
  compactLedger,
} from '../ledger-compact.js';
import { statuslinePaths } from '../paths.js';
import { StatuslineStoragePathError } from '../storage.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a temporary project root with `.hive-flow/<sub>/<leaf>` populated.
 * Returns the root and the canonical statusline paths.
 */
function makeProjectRoot(): { root: string; paths: ReturnType<typeof statuslinePaths> } {
  const root = mkdtempSync(join(tmpdir(), 'hf-ledger-compact-'));
  const paths = statuslinePaths(root);
  mkdirSync(paths.root, { recursive: true });
  return { root, paths };
}

/**
 * Write a JSONL ledger seeded with `events` (one canonical line per event)
 * plus the optional raw `extra` lines appended verbatim (used for injecting
 * malformed input).
 */
function seedLedger(filePath: string, events: ReadonlyArray<unknown>, extraRaw = ''): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  const body = events.map((event) => JSON.stringify(event)).join('\n');
  const trailer = events.length === 0 ? '' : '\n';
  writeFileSync(filePath, body + trailer + extraRaw);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ledger-compact', () => {
  let root: string;
  let paths: ReturnType<typeof statuslinePaths>;

  beforeEach(() => {
    const project = makeProjectRoot();
    root = project.root;
    paths = project.paths;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Truncation: keep last N of M (M > N)
  // -------------------------------------------------------------------------

  describe('truncation', () => {
    it('keeps only the most recent N events when M > N', async () => {
      const events = [
        { eventId: 'e1', n: 1 },
        { eventId: 'e2', n: 2 },
        { eventId: 'e3', n: 3 },
        { eventId: 'e4', n: 4 },
        { eventId: 'e5', n: 5 },
      ];
      seedLedger(paths.testsLedger, events);

      const result = await compactLedger({ projectRoot: root, target: 'tests', keep: 2 });

      expect(result).toEqual({
        target: 'tests',
        before: 5,
        after: 2,
        skipped: 0,
        wroteCurrent: true,
      });

      const content = readFileSync(paths.testsLedger, 'utf8');
      expect(content).toBe('{"eventId":"e4","n":4}\n{"eventId":"e5","n":5}\n');
    });

    it('writes 0o600 permissions on the rewritten ledger', async () => {
      const events = [
        { eventId: 'a', n: 1 },
        { eventId: 'b', n: 2 },
      ];
      seedLedger(paths.sessionsLedger, events);
      await compactLedger({ projectRoot: root, target: 'sessions', keep: 1 });
      const mode = statSync(paths.sessionsLedger).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  // -------------------------------------------------------------------------
  // No-op: M <= N and no corruption preserves mtime
  // -------------------------------------------------------------------------

  describe('no-op fast path', () => {
    it('is a no-op when M < N (all lines remain, mtime preserved)', async () => {
      const events = [
        { eventId: 'a', n: 1 },
        { eventId: 'b', n: 2 },
      ];
      seedLedger(paths.attentionLedger, events);
      const expectedContent = readFileSync(paths.attentionLedger, 'utf8');
      const mtimeBefore = statSync(paths.attentionLedger).mtimeMs;

      // Small delay so a wrongful rewrite would produce a detectable mtime
      // change even on coarse-resolution filesystems.
      await delay(20);

      const result = await compactLedger({ projectRoot: root, target: 'attention', keep: 10 });

      expect(result).toEqual({
        target: 'attention',
        before: 2,
        after: 2,
        skipped: 0,
        wroteCurrent: false,
      });
      expect(readFileSync(paths.attentionLedger, 'utf8')).toBe(expectedContent);
      const mtimeAfter = statSync(paths.attentionLedger).mtimeMs;
      expect(mtimeAfter).toBe(mtimeBefore);
    });

    it('is a no-op when M === N and no corruption', async () => {
      const events = [
        { eventId: 'a', n: 1 },
        { eventId: 'b', n: 2 },
        { eventId: 'c', n: 3 },
      ];
      seedLedger(paths.testsLedger, events);
      const expectedContent = readFileSync(paths.testsLedger, 'utf8');
      const mtimeBefore = statSync(paths.testsLedger).mtimeMs;

      await delay(20);

      const result = await compactLedger({ projectRoot: root, target: 'tests', keep: 3 });

      expect(result).toEqual({
        target: 'tests',
        before: 3,
        after: 3,
        skipped: 0,
        wroteCurrent: false,
      });
      expect(readFileSync(paths.testsLedger, 'utf8')).toBe(expectedContent);
      expect(statSync(paths.testsLedger).mtimeMs).toBe(mtimeBefore);
    });

    // Codex Phase 7 LOW finding: the privacy chmod that runs after
    // atomicWrite on the rewrite path did NOT run on the no-op path,
    // so a loose-mode ledger (e.g. 0o644 from a recorder that omitted
    // its post-append chmod, or from a manual `chmod` by the operator)
    // would keep its loose permissions whenever compaction had no
    // truncation to perform. The fix tightens the file to 0o600 even
    // on the no-op path. This test asserts: (1) the no-op return shape
    // is preserved (wroteCurrent === false, content unchanged); (2)
    // the mode is now 0o600 regardless of the original loose mode.
    it('tightens loose permissions to 0o600 on the no-op path', async () => {
      const events = [
        { eventId: 'x', n: 1 },
        { eventId: 'y', n: 2 },
      ];
      seedLedger(paths.testsLedger, events);
      // Force a loose mode that compaction must tighten. 0o644 mirrors
      // the most common umask default; an explicit chmodSync here is
      // independent of the host umask so the assertion is deterministic
      // across CI environments.
      chmodSync(paths.testsLedger, 0o644);
      const looseMode = statSync(paths.testsLedger).mode & 0o777;
      expect(looseMode).toBe(0o644);
      const expectedContent = readFileSync(paths.testsLedger, 'utf8');

      // keep: 100 >> before: 2, no corruption -> guaranteed no-op path.
      const result = await compactLedger({ projectRoot: root, target: 'tests', keep: 100 });

      // No-op contract preserved.
      expect(result).toEqual({
        target: 'tests',
        before: 2,
        after: 2,
        skipped: 0,
        wroteCurrent: false,
      });
      expect(readFileSync(paths.testsLedger, 'utf8')).toBe(expectedContent);

      // chmod fired: file is now 0o600.
      const tightenedMode = statSync(paths.testsLedger).mode & 0o777;
      expect(tightenedMode).toBe(0o600);
    });
  });

  // -------------------------------------------------------------------------
  // Missing ledger file
  // -------------------------------------------------------------------------

  describe('missing ledger', () => {
    it('returns the empty no-op result without throwing', async () => {
      const result = await compactLedger({ projectRoot: root, target: 'tests', keep: 100 });
      expect(result).toEqual({
        target: 'tests',
        before: 0,
        after: 0,
        skipped: 0,
        wroteCurrent: false,
      });
      // The compactor must not create the ledger as a side effect.
      expect(existsSync(paths.testsLedger)).toBe(false);
      // The compactor must not create a lock file beside a missing ledger.
      expect(existsSync(`${paths.testsLedger}.lock`)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Corruption: drop unparseable lines silently, count in skipped
  // -------------------------------------------------------------------------

  describe('corrupt lines', () => {
    it('drops malformed lines and keeps the last N valid', async () => {
      // Mixed file with two valid + one malformed + two more valid. We
      // deliberately interleave the bad line so the parser must skip it
      // mid-stream rather than at EOF.
      seedLedger(
        paths.scoreboardCallsLedger,
        [{ eventId: 'good-1', n: 1 }, { eventId: 'good-2', n: 2 }],
        'not-json-at-all\n{"eventId":"good-3","n":3}\n{"eventId":"good-4","n":4}\n',
      );

      const result = await compactLedger({
        projectRoot: root,
        target: 'scoreboard-calls',
        keep: 2,
      });

      expect(result).toEqual({
        target: 'scoreboard-calls',
        before: 4,
        after: 2,
        skipped: 1,
        wroteCurrent: true,
      });
      const content = readFileSync(paths.scoreboardCallsLedger, 'utf8');
      expect(content).toBe('{"eventId":"good-3","n":3}\n{"eventId":"good-4","n":4}\n');
    });

    it('rewrites the file even when M <= N if corrupt lines are present', async () => {
      // The runbook contract: skipped > 0 must rewrite, even at the no-op
      // count threshold, so the corruption is purged.
      seedLedger(
        paths.attentionLedger,
        [{ eventId: 'a' }, { eventId: 'b' }],
        'oops\n',
      );

      const result = await compactLedger({
        projectRoot: root,
        target: 'attention',
        keep: 10,
      });

      expect(result).toEqual({
        target: 'attention',
        before: 2,
        after: 2,
        skipped: 1,
        wroteCurrent: true,
      });
      const content = readFileSync(paths.attentionLedger, 'utf8');
      expect(content).toBe('{"eventId":"a"}\n{"eventId":"b"}\n');
    });
  });

  // -------------------------------------------------------------------------
  // Input validation: typed errors fire BEFORE any FS op
  // -------------------------------------------------------------------------

  describe('input validation', () => {
    it('rejects keep < 1 with a typed error before touching the filesystem', async () => {
      seedLedger(paths.testsLedger, [{ eventId: 'a' }]);
      const beforeContent = readFileSync(paths.testsLedger, 'utf8');

      await expect(
        compactLedger({ projectRoot: root, target: 'tests', keep: 0 }),
      ).rejects.toBeInstanceOf(StatuslineCompactKeepError);
      await expect(
        compactLedger({ projectRoot: root, target: 'tests', keep: -3 }),
      ).rejects.toBeInstanceOf(StatuslineCompactKeepError);
      await expect(
        compactLedger({ projectRoot: root, target: 'tests', keep: 1.5 }),
      ).rejects.toBeInstanceOf(StatuslineCompactKeepError);
      await expect(
        compactLedger({ projectRoot: root, target: 'tests', keep: Number.NaN }),
      ).rejects.toBeInstanceOf(StatuslineCompactKeepError);

      expect(readFileSync(paths.testsLedger, 'utf8')).toBe(beforeContent);
      expect(existsSync(`${paths.testsLedger}.lock`)).toBe(false);
    });

    it('rejects an unknown target with a typed error before touching the filesystem', async () => {
      seedLedger(paths.testsLedger, [{ eventId: 'a' }]);
      const beforeContent = readFileSync(paths.testsLedger, 'utf8');

      // Cast through `as never` only for the test harness -- the canonical
      // type forbids this value at compile time, so production callers
      // cannot reach this branch by accident.
      await expect(
        compactLedger({
          projectRoot: root,
          target: '../etc/passwd' as never,
          keep: 1,
        }),
      ).rejects.toBeInstanceOf(StatuslineSpoolLedgerNameError);
      await expect(
        compactLedger({ projectRoot: root, target: 'bogus' as never, keep: 1 }),
      ).rejects.toBeInstanceOf(StatuslineSpoolLedgerNameError);

      expect(readFileSync(paths.testsLedger, 'utf8')).toBe(beforeContent);
    });

    it('compactJsonl rejects an empty filePath', async () => {
      await expect(compactJsonl('', 1)).rejects.toBeInstanceOf(TypeError);
    });
  });

  // -------------------------------------------------------------------------
  // Symlink rejection (propagated from the storage primitive)
  // -------------------------------------------------------------------------

  describe('symlink guard', () => {
    it('refuses to compact a ledger that is itself a symlink under .hive-flow/', async () => {
      const target = join(root, 'outside.jsonl');
      writeFileSync(target, '{"eventId":"leak"}\n');
      mkdirSync(join(paths.root, 'tests'), { recursive: true });
      // Replace the canonical ledger location with a symlink pointing
      // outside the .hive-flow tree.
      symlinkSync(target, paths.testsLedger);

      await expect(
        compactLedger({ projectRoot: root, target: 'tests', keep: 5 }),
      ).rejects.toBeInstanceOf(StatuslineStoragePathError);

      // The symlink itself must remain untouched (no rewrite, no rename).
      // The link target also must not be the rewritten path.
      const linkContent = readFileSync(target, 'utf8');
      expect(linkContent).toBe('{"eventId":"leak"}\n');
    });
  });

  // -------------------------------------------------------------------------
  // Atomic semantics
  // -------------------------------------------------------------------------

  describe('atomic semantics', () => {
    it('leaves the ledger in a consistent state when a stray tmp file exists', async () => {
      // Simulates the crash-before-rename window: a prior writer left a
      // pre-staged tmp file beside the ledger. The current compaction
      // must not pick that file up as the canonical state, and must not
      // corrupt the ledger when it commits its own rewrite.
      const events = [
        { eventId: 'a', n: 1 },
        { eventId: 'b', n: 2 },
        { eventId: 'c', n: 3 },
      ];
      seedLedger(paths.testsLedger, events);
      const stray = `${paths.testsLedger}.tmp-fake`;
      writeFileSync(stray, '{"eventId":"poisoned"}\n');

      const result = await compactLedger({ projectRoot: root, target: 'tests', keep: 2 });

      expect(result.wroteCurrent).toBe(true);
      const content = readFileSync(paths.testsLedger, 'utf8');
      // The committed ledger reflects the requested truncation, not the
      // stray temp content.
      expect(content).toBe('{"eventId":"b","n":2}\n{"eventId":"c","n":3}\n');
      // The stray temp file was not adopted as the canonical ledger and,
      // because its name does not match the temp prefix this PID minted,
      // it is left in place for the operator to investigate.
      expect(existsSync(stray)).toBe(true);
    });

    it('compactJsonl rewrites atomically through tmp -> rename', async () => {
      // Direct exercise of the lower-level entry point. The same atomic
      // guarantees apply; the surface differs only in path resolution.
      const ledger = join(root, '.hive-flow/tests/last-run.jsonl');
      seedLedger(ledger, [
        { eventId: 'first' },
        { eventId: 'second' },
        { eventId: 'third' },
      ]);

      const result = await compactJsonl(ledger, 1);

      expect(result.before).toBe(3);
      expect(result.after).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.wroteCurrent).toBe(true);
      expect(readFileSync(ledger, 'utf8')).toBe('{"eventId":"third"}\n');
    });
  });

  // -------------------------------------------------------------------------
  // Lock contention
  // -------------------------------------------------------------------------

  describe('lock contention', () => {
    it('refuses to compact while another live owner holds the ledger lock', async () => {
      seedLedger(paths.testsLedger, [{ eventId: 'untouched' }]);
      // Stage a live-owner lock file using this PID -- isLockStale uses
      // `process.kill(pid, 0)` and will conclude the lock is live, so the
      // stale-steal branch declines to evict.
      writeFileSync(`${paths.testsLedger}.lock`, `pid=${process.pid}\nstartedAt=${new Date().toISOString()}\n`);

      await expect(
        compactLedger({ projectRoot: root, target: 'tests', keep: 1 }),
      ).rejects.toBeInstanceOf(StatuslineCompactLockError);

      // Lock remains in place; the ledger is unchanged.
      expect(existsSync(`${paths.testsLedger}.lock`)).toBe(true);
      expect(readFileSync(paths.testsLedger, 'utf8')).toBe('{"eventId":"untouched"}\n');
    });

    it('concurrent compactions of different targets do not race', async () => {
      // Each target has its own lock file, so two compactions against
      // different targets run independently. We seed three distinct
      // ledgers and trigger their compactions in parallel; each must
      // succeed and leave only its requested tail.
      seedLedger(paths.testsLedger, [
        { eventId: 't1' },
        { eventId: 't2' },
        { eventId: 't3' },
      ]);
      seedLedger(paths.sessionsLedger, [
        { eventId: 's1' },
        { eventId: 's2' },
        { eventId: 's3' },
      ]);
      seedLedger(paths.attentionLedger, [
        { eventId: 'a1' },
        { eventId: 'a2' },
        { eventId: 'a3' },
      ]);

      const [tests, sessions, attention] = await Promise.all([
        compactLedger({ projectRoot: root, target: 'tests', keep: 1 }),
        compactLedger({ projectRoot: root, target: 'sessions', keep: 1 }),
        compactLedger({ projectRoot: root, target: 'attention', keep: 1 }),
      ]);

      expect(tests.after).toBe(1);
      expect(sessions.after).toBe(1);
      expect(attention.after).toBe(1);
      expect(readFileSync(paths.testsLedger, 'utf8')).toBe('{"eventId":"t3"}\n');
      expect(readFileSync(paths.sessionsLedger, 'utf8')).toBe('{"eventId":"s3"}\n');
      expect(readFileSync(paths.attentionLedger, 'utf8')).toBe('{"eventId":"a3"}\n');
    });
  });

  // -------------------------------------------------------------------------
  // compactAllLedgers
  // -------------------------------------------------------------------------

  describe('compactAllLedgers', () => {
    it('compacts every canonical ledger and returns one result per target', async () => {
      // Seed two ledgers and leave the rest absent. The absent ledgers
      // must surface the no-op result rather than failing the run.
      seedLedger(paths.testsLedger, [
        { eventId: 't1' },
        { eventId: 't2' },
        { eventId: 't3' },
      ]);
      seedLedger(paths.attentionLedger, [
        { eventId: 'a1' },
        { eventId: 'a2' },
      ]);

      const results = await compactAllLedgers(root, 1);

      // One result per canonical ledger, declaration order preserved.
      expect(results.map((r) => r.target)).toEqual([
        'tests',
        'sessions',
        'scoreboard-calls',
        'scoreboard-presence',
        'attention',
      ]);
      const byTarget = new Map(results.map((r) => [r.target, r]));
      expect(byTarget.get('tests')?.wroteCurrent).toBe(true);
      expect(byTarget.get('tests')?.after).toBe(1);
      expect(byTarget.get('attention')?.wroteCurrent).toBe(true);
      expect(byTarget.get('attention')?.after).toBe(1);
      expect(byTarget.get('sessions')?.wroteCurrent).toBe(false);
      expect(byTarget.get('sessions')?.before).toBe(0);
      expect(byTarget.get('scoreboard-calls')?.wroteCurrent).toBe(false);
      expect(byTarget.get('scoreboard-presence')?.wroteCurrent).toBe(false);
    });

    it('reports a per-target error and continues when one ledger cannot compact', async () => {
      const outside = join(root, 'outside-tests.jsonl');
      writeFileSync(outside, '{"eventId":"outside"}\n');
      mkdirSync(join(paths.root, 'tests'), { recursive: true });
      symlinkSync(outside, paths.testsLedger);
      seedLedger(paths.sessionsLedger, [
        { eventId: 's1' },
        { eventId: 's2' },
      ]);

      const results = await compactAllLedgers(root, 1);
      const byTarget = new Map(results.map((r) => [r.target, r]));

      expect(byTarget.get('tests')).toMatchObject({
        target: 'tests',
        before: 0,
        after: 0,
        skipped: 0,
        wroteCurrent: false,
        error: true,
      });
      expect(byTarget.get('tests')?.message).toMatch(/symlink|safe storage path|StatuslineStoragePathError/i);
      expect(byTarget.get('sessions')).toMatchObject({
        target: 'sessions',
        before: 2,
        after: 1,
        skipped: 0,
        wroteCurrent: true,
      });
      expect(readFileSync(paths.sessionsLedger, 'utf8')).toBe('{"eventId":"s2"}\n');
      expect(readFileSync(outside, 'utf8')).toBe('{"eventId":"outside"}\n');
    });

    it('rejects keep < 1 before iterating', async () => {
      seedLedger(paths.testsLedger, [{ eventId: 'a' }]);
      const beforeContent = readFileSync(paths.testsLedger, 'utf8');
      await expect(compactAllLedgers(root, 0)).rejects.toBeInstanceOf(StatuslineCompactKeepError);
      expect(readFileSync(paths.testsLedger, 'utf8')).toBe(beforeContent);
    });
  });
});
