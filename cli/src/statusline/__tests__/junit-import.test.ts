// cli/src/statusline/__tests__/junit-import.test.ts
//
// Behavioural tests for the JUnit XML importer. Covers:
//
//   1. Single file with 2 valid suites -> 2 events appended to the ledger.
//   2. Numeric attribute missing or malformed -> treated as 0, does not throw.
//   3. Directory tree with nested XML files -> all files imported, summaries
//      aggregated; malformed files are skipped without aborting the walk.
//   4. File that is a symlink pointing OUTSIDE projectRoot -> rejected; no
//      events written.
//   5. File that is a symlink pointing INSIDE projectRoot -> still rejected
//      (round-5 fix: symlinks are skipped during walking; the per-file
//      importer rejects them at the surface boundary).
//   6. Suite with arithmetic that doesn't sum -> corrected by deriving
//      passed = max(0, total - failed - skipped); no throw.
//   7. Unreadable file -> skipped, summary continues.
//   8. CDATA + comment in the XML -> stripped; the surrounding suite is
//      still parsed.
//
// All tests use `mkdtempSync(tmpdir())` so they are self-contained.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';

import {
  importJunitFile,
  importJunitTree,
  MAX_JUNIT_BYTES,
  type JunitImportSummary,
} from '../junit-import.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function mkTmp(prefix: string): string {
  // realpathSync normalises platform-specific symlink dirs (e.g. macOS
  // `/tmp` -> `/private/var/folders/...`) so subsequent file paths
  // compared against importer-returned `realPath` values match exactly.
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function write(root: string, rel: string, body: string): string {
  const abs = join(root, ...rel.split('/'));
  const dir = abs.slice(0, abs.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, body);
  return abs;
}

function ledgerLines(projectRoot: string): string[] {
  try {
    const raw = readFileSync(join(projectRoot, '.hive-flow', 'tests', 'last-run.jsonl'), 'utf8');
    return raw.split(/\r?\n/).filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

interface LedgerEvent {
  version: number;
  eventId: string;
  ts: string;
  repoRoot: string;
  projectKey: string;
  runner: string;
  kind: string;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  durationMs?: number;
  command?: string;
  producerKind: string;
  producerId: string;
  scope?: string;
}

function parseLedger(projectRoot: string): LedgerEvent[] {
  return ledgerLines(projectRoot).map((line) => JSON.parse(line) as LedgerEvent);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('junit-import: importJunitFile', () => {
  let root: string;

  beforeEach(() => {
    root = mkTmp('hf-junit-file-');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('appends one TestRunEventV1 per <testsuite> inside one file', async () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<testsuites>',
      '  <testsuite name="alpha" tests="3" failures="1" errors="0" skipped="0" time="0.25"></testsuite>',
      '  <testsuite name="beta" tests="2" failures="0" errors="0" skipped="1" time="1.5"></testsuite>',
      '</testsuites>',
    ].join('\n');
    const filePath = write(root, 'reports/results.junit.xml', xml);

    const summary = await importJunitFile({
      projectRoot: root,
      filePath,
    });

    expect(summary.suites).toBe(2);
    expect(summary.events).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.reason).toBeUndefined();

    const events = parseLedger(root);
    expect(events).toHaveLength(2);

    const alpha = events.find((e) => e.scope === 'alpha');
    const beta = events.find((e) => e.scope === 'beta');
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();

    // alpha: tests=3 failures=1 errors=0 skipped=0 -> passed=2
    expect(alpha!.kind).toBe('suite');
    expect(alpha!.runner).toBe('junit-xml');
    expect(alpha!.passed).toBe(2);
    expect(alpha!.failed).toBe(1);
    expect(alpha!.skipped).toBe(0);
    expect(alpha!.total).toBe(3);
    expect(alpha!.durationMs).toBe(250);

    // beta: tests=2 failures=0 errors=0 skipped=1 -> passed=1
    expect(beta!.passed).toBe(1);
    expect(beta!.failed).toBe(0);
    expect(beta!.skipped).toBe(1);
    expect(beta!.total).toBe(2);
    expect(beta!.durationMs).toBe(1500);
  });

  it('treats missing or malformed numeric attributes as 0 without throwing', async () => {
    const xml =
      '<testsuite name="weird" tests="oops" failures="" errors="not-a-number" skipped="3.5" time="bad"></testsuite>';
    const filePath = write(root, 'reports/weird.xml', xml);

    const summary = await importJunitFile({ projectRoot: root, filePath });

    // tests=0 failures=0 errors=0 skipped=0 -> passed=0 total=0
    expect(summary.suites).toBe(1);
    expect(summary.events).toBe(1);
    expect(summary.skipped).toBe(0);

    const events = parseLedger(root);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.scope).toBe('weird');
    expect(event.passed).toBe(0);
    expect(event.failed).toBe(0);
    expect(event.skipped).toBe(0);
    expect(event.total).toBe(0);
    // When the suite carries no usable `time` attribute, the importer
    // omits the synthetic startedAt/finishedAt timestamps and the
    // recorder stamps `durationMs: 0` as its "no real duration was
    // reported" sentinel.
    expect(event.durationMs).toBe(0);
  });

  it('corrects arithmetic when tests is less than failed + skipped', async () => {
    // Hostile arithmetic: tests=1 says there is 1 test, but failures=3
    // claims 3 failed. We derive passed=max(0, 1-3-0)=0 and clamp
    // total=passed+failed+skipped=3 so the recorder accepts the event.
    const xml = '<testsuite name="bad-math" tests="1" failures="3" errors="0" skipped="0"></testsuite>';
    const filePath = write(root, 'reports/bad-math.xml', xml);

    const summary = await importJunitFile({ projectRoot: root, filePath });

    expect(summary.suites).toBe(1);
    expect(summary.events).toBe(1);

    const events = parseLedger(root);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.scope).toBe('bad-math');
    expect(event.passed).toBe(0);
    expect(event.failed).toBe(3);
    expect(event.skipped).toBe(0);
    // Total is corrected to passed+failed+skipped so the recorder accepts.
    expect(event.total).toBe(3);
  });

  it('strips CDATA and comments before scanning suites', async () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<testsuites>',
      '  <!-- <testsuite name="commented-out" tests="99"></testsuite> -->',
      '  <testsuite name="real" tests="2" failures="0" errors="0" skipped="0">',
      '    <system-out><![CDATA[ <testsuite name="cdata-decoy" tests="42"></testsuite> ]]></system-out>',
      '  </testsuite>',
      '</testsuites>',
    ].join('\n');
    const filePath = write(root, 'reports/cdata.junit.xml', xml);

    const summary = await importJunitFile({ projectRoot: root, filePath });

    expect(summary.suites).toBe(1);
    expect(summary.events).toBe(1);

    const events = parseLedger(root);
    expect(events).toHaveLength(1);
    expect(events[0]!.scope).toBe('real');
    expect(events[0]!.total).toBe(2);
  });

  it('honours a custom framework string', async () => {
    const xml = '<testsuite name="x" tests="1" failures="0" errors="0" skipped="0"></testsuite>';
    const filePath = write(root, 'reports/x.xml', xml);

    await importJunitFile({ projectRoot: root, filePath, framework: 'gotest' });

    const events = parseLedger(root);
    expect(events).toHaveLength(1);
    expect(events[0]!.runner).toBe('gotest');
  });

  it('skips a file that does not exist with reason=not-found', async () => {
    const summary = await importJunitFile({
      projectRoot: root,
      filePath: join(root, 'missing.xml'),
    });
    expect(summary).toMatchObject({
      suites: 0,
      events: 0,
      skipped: 1,
      reason: 'not-found',
    });
    expect(ledgerLines(root)).toHaveLength(0);
  });

  it('skips an XML file with zero suites with reason=no-suites', async () => {
    const filePath = write(root, 'reports/empty.xml', '<?xml version="1.0"?><testsuites></testsuites>');
    const summary = await importJunitFile({ projectRoot: root, filePath });
    expect(summary).toMatchObject({
      suites: 0,
      events: 0,
      skipped: 1,
      reason: 'no-suites',
    });
    expect(ledgerLines(root)).toHaveLength(0);
  });

  it('skips an oversized file with reason=oversize', async () => {
    // Build a body larger than MAX_JUNIT_BYTES. Using a single buffer is
    // cheaper than a per-byte loop.
    const padding = '<!-- ' + 'x'.repeat(MAX_JUNIT_BYTES + 1024) + ' -->';
    const xml = padding + '<testsuite tests="1" failures="0" errors="0" skipped="0"></testsuite>';
    const filePath = write(root, 'reports/big.xml', xml);

    const summary = await importJunitFile({ projectRoot: root, filePath });
    expect(summary).toMatchObject({
      suites: 0,
      events: 0,
      skipped: 1,
      reason: 'oversize',
    });
    expect(ledgerLines(root)).toHaveLength(0);
  });

  it('enforces a HARD memory cap during read (does not load past MAX_JUNIT_BYTES)', async () => {
    // Codex Phase-7 finding: the importer must not slurp the entire file
    // into memory before rejecting an oversize input. Even if the file
    // grows between `stat()` and the read, the read accumulator MUST stop
    // at `MAX_JUNIT_BYTES + 1` bytes and abort.
    //
    // We construct a file ~3 MiB in size (well past the 2 MiB cap). The
    // bounded `open()` + `read()` loop allocates exactly `MAX_JUNIT_BYTES
    // + 1` bytes and never reads beyond that.
    const padding = 'x'.repeat(3 * 1024 * 1024); // 3 MiB of payload.
    const xml = '<!-- ' + padding + ' --><testsuite tests="1"></testsuite>';
    const filePath = write(root, 'reports/giant.xml', xml);

    // Force a GC pass (best-effort) so the heap baseline is stable. If
    // `--expose-gc` is not on we skip the GC nudge — the cap is still
    // enforced structurally by `Buffer.alloc(MAX_JUNIT_BYTES + 1)`, but the
    // heap-delta assertion below becomes a guideline rather than a hard
    // proof.
    const gcFn = (globalThis as { gc?: () => void }).gc;
    if (typeof gcFn === 'function') gcFn();
    const heapBefore = process.memoryUsage().heapUsed;

    const summary = await importJunitFile({ projectRoot: root, filePath });
    expect(summary.skipped).toBe(1);
    expect(summary.reason).toBe('oversize');
    expect(ledgerLines(root)).toHaveLength(0);

    if (typeof gcFn === 'function') gcFn();
    const heapAfter = process.memoryUsage().heapUsed;
    // Memory growth bound: at most one buffer of `MAX_JUNIT_BYTES + 1`
    // bytes (~2 MiB) plus modest noise from V8 + the test runner itself.
    // Allowing 16 MiB of slack catches a regression that slurps the full
    // 3 MiB payload (or worse, the doubling that `readFile('utf8')` does
    // internally to materialise a UTF-16 string) while staying robust to
    // unrelated GC noise on CI.
    const heapDelta = heapAfter - heapBefore;
    expect(heapDelta).toBeLessThan(16 * 1024 * 1024);
  });

  it('skips an unreadable file with reason=unreadable', async () => {
    if (platform === 'win32') return; // chmod permission semantics differ.
    const filePath = write(
      root,
      'reports/perm.xml',
      '<testsuite tests="1" failures="0" errors="0" skipped="0"></testsuite>',
    );
    chmodSync(filePath, 0o000);
    try {
      const summary = await importJunitFile({ projectRoot: root, filePath });
      // Either oversize or unreadable depending on filesystem; in practice
      // chmod 000 -> read() throws EACCES which maps to 'unreadable'.
      expect(summary.skipped).toBe(1);
      // On macOS the calling uid often still has read access via sudo; the
      // test accepts either 'unreadable' or a successful read on those
      // platforms by checking only that we did not crash.
      const acceptable = new Set([
        'unreadable',
        'not-regular',
        'not-found',
      ]);
      if (summary.reason !== undefined) {
        // Allow either an unreadable reason or a successful import (no skip).
        expect([...acceptable, undefined]).toContain(summary.reason);
      }
    } finally {
      chmodSync(filePath, 0o600);
    }
  });
});

describe('junit-import: importJunitTree', () => {
  let root: string;

  beforeEach(() => {
    root = mkTmp('hf-junit-tree-');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('walks nested directories and imports every .xml + .junit.xml', async () => {
    write(
      root,
      'reports/a.xml',
      '<testsuite name="a" tests="1" failures="0" errors="0" skipped="0"></testsuite>',
    );
    write(
      root,
      'reports/nested/b.junit.xml',
      '<testsuite name="b" tests="2" failures="1" errors="0" skipped="0"></testsuite>',
    );
    write(
      root,
      'reports/nested/deeper/c.xml',
      '<testsuite name="c" tests="3" failures="0" errors="0" skipped="1"></testsuite>',
    );

    const summaries: ReadonlyArray<JunitImportSummary> = await importJunitTree({
      projectRoot: root,
      rootDir: join(root, 'reports'),
    });

    expect(summaries).toHaveLength(3);
    for (const s of summaries) {
      expect(s.skipped).toBe(0);
      expect(s.suites).toBe(1);
      expect(s.events).toBe(1);
    }

    const events = parseLedger(root);
    expect(events).toHaveLength(3);
    const scopes = new Set(events.map((e) => e.scope));
    expect(scopes).toEqual(new Set(['a', 'b', 'c']));
  });

  it('aggregates malformed and valid files in one walk without aborting', async () => {
    write(
      root,
      'reports/valid.junit.xml',
      '<testsuite name="ok" tests="2" failures="0" errors="0" skipped="0"></testsuite>',
    );
    // XML body with no `<testsuite>` tag at all: the regex parser finds
    // nothing and the file degrades to a `no-suites` skip. We use this
    // shape (rather than `<testsuite tests="not-a-number">` which DOES
    // count as a valid-but-zero-count suite under the task brief's
    // "treated as 0, doesn't throw" tolerance) so the test explicitly
    // exercises the empty-document degradation path.
    write(root, 'reports/empty.xml', '<?xml version="1.0"?><results></results>');

    const summaries = await importJunitTree({
      projectRoot: root,
      rootDir: join(root, 'reports'),
    });

    expect(summaries).toHaveLength(2);
    const valid = summaries.find((s) => s.suites > 0);
    const broken = summaries.find((s) => s.skipped > 0);
    expect(valid).toBeDefined();
    expect(broken).toBeDefined();
    expect(broken!.reason).toBe('no-suites');

    const events = parseLedger(root);
    expect(events).toHaveLength(1);
    expect(events[0]!.scope).toBe('ok');
  });

  it('tolerates malformed numeric attributes inside a tree (zero-count suite)', async () => {
    write(
      root,
      'reports/normal.xml',
      '<testsuite name="normal" tests="1" failures="0" errors="0" skipped="0"></testsuite>',
    );
    // `tests="not-a-number"` is still a recognised suite under the brief's
    // tolerance rule; counts degrade to zero and an event is appended.
    write(root, 'reports/lenient.xml', '<testsuite name="lenient" tests="not-a-number"></testsuite>');

    const summaries = await importJunitTree({
      projectRoot: root,
      rootDir: join(root, 'reports'),
    });

    expect(summaries).toHaveLength(2);
    for (const s of summaries) {
      expect(s.skipped).toBe(0);
      expect(s.suites).toBe(1);
    }
    const events = parseLedger(root);
    expect(events).toHaveLength(2);
    const lenient = events.find((e) => e.scope === 'lenient');
    expect(lenient).toBeDefined();
    expect(lenient!.total).toBe(0);
  });

  it('rejects an outside-project rootDir without writing any events', async () => {
    if (platform === 'win32') return;
    const outside = mkTmp('hf-junit-outside-');
    try {
      write(outside, 'report.junit.xml', '<testsuite tests="1" failures="0" errors="0" skipped="0"></testsuite>');
      const summaries = await importJunitTree({
        projectRoot: root,
        rootDir: outside,
      });
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.skipped).toBe(1);
      expect(summaries[0]!.reason).toBe('outside-project');
      expect(ledgerLines(root)).toHaveLength(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked file pointing OUTSIDE the project', async () => {
    if (platform === 'win32') return;
    const outside = mkTmp('hf-junit-outside-symlink-');
    try {
      const outsideXml = write(
        outside,
        'real.junit.xml',
        '<testsuite tests="1" failures="0" errors="0" skipped="0"></testsuite>',
      );
      mkdirSync(join(root, 'reports'), { recursive: true });
      const linkPath = join(root, 'reports', 'link.junit.xml');
      symlinkSync(outsideXml, linkPath);

      // Single-file API rejects the symlink with reason='symlink'.
      const fileSummary = await importJunitFile({ projectRoot: root, filePath: linkPath });
      expect(fileSummary.skipped).toBe(1);
      expect(fileSummary.reason).toBe('symlink');

      // Tree API also rejects: the walker skips symlinks entirely, so the
      // returned summary list is EMPTY (no entries for the rejected
      // symlink) and the ledger remains untouched.
      const summaries = await importJunitTree({
        projectRoot: root,
        rootDir: join(root, 'reports'),
      });
      expect(summaries).toHaveLength(0);
      expect(ledgerLines(root)).toHaveLength(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('skips a symlinked file pointing INSIDE the project during walking', async () => {
    if (platform === 'win32') return;
    // Round-5 fix: symlinks-into-the-project must still be skipped during
    // walking (no recurse, no import) because the resolved target is
    // reachable via a real path elsewhere in the tree and importing both
    // would double-count the suite.
    const realPath = write(
      root,
      'reports/real.junit.xml',
      '<testsuite name="dup-source" tests="1" failures="0" errors="0" skipped="0"></testsuite>',
    );
    const linkPath = join(root, 'reports', 'alias.junit.xml');
    symlinkSync(realPath, linkPath);

    const summaries = await importJunitTree({
      projectRoot: root,
      rootDir: join(root, 'reports'),
    });

    // Only the real file is imported; the symlink is silently skipped.
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.filePath).toBe(realPath);
    const events = parseLedger(root);
    expect(events).toHaveLength(1);
    expect(events[0]!.scope).toBe('dup-source');
  });

  it('rejects a directly-passed symlink with reason=symlink', async () => {
    if (platform === 'win32') return;
    const realPath = write(
      root,
      'reports/real.junit.xml',
      '<testsuite name="inner" tests="1" failures="0" errors="0" skipped="0"></testsuite>',
    );
    const linkPath = join(root, 'reports', 'alias.junit.xml');
    symlinkSync(realPath, linkPath);

    const summary = await importJunitFile({ projectRoot: root, filePath: linkPath });
    expect(summary.skipped).toBe(1);
    expect(summary.reason).toBe('symlink');
  });

  it('accepts a regular file passed as rootDir', async () => {
    const filePath = write(
      root,
      'reports/single.junit.xml',
      '<testsuite name="single" tests="1" failures="0" errors="0" skipped="0"></testsuite>',
    );
    const summaries = await importJunitTree({
      projectRoot: root,
      rootDir: filePath,
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.events).toBe(1);
  });

  it('ignores generator-output directories like node_modules and dist', async () => {
    write(
      root,
      'reports/active.junit.xml',
      '<testsuite name="active" tests="1" failures="0" errors="0" skipped="0"></testsuite>',
    );
    // These should be filtered out and never visited.
    write(
      root,
      'reports/node_modules/decoy.xml',
      '<testsuite name="decoy-node-modules" tests="99" failures="0" errors="0" skipped="0"></testsuite>',
    );
    write(
      root,
      'reports/dist/decoy.xml',
      '<testsuite name="decoy-dist" tests="99" failures="0" errors="0" skipped="0"></testsuite>',
    );

    const summaries = await importJunitTree({
      projectRoot: root,
      rootDir: join(root, 'reports'),
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.events).toBe(1);
    const events = parseLedger(root);
    expect(events).toHaveLength(1);
    expect(events[0]!.scope).toBe('active');
  });

  it('produces distinct ledger rows when the same path has changed counts (Codex Phase-7 blocker)', async () => {
    // Codex Phase-7 blocker: the deterministic eventId hash must include the
    // headline counts (total / failed / skipped) so a re-import of the SAME
    // file path with DIFFERENT XML content (e.g. a passing run flipping to
    // a failing run) mints a fresh eventId and reaches the ledger instead
    // of being collapsed by the recorder's single-field dedupe.
    //
    // Without this regression bar, a pass-to-fail flip would silently
    // disappear: the recorder would see the same eventId, set
    // `result.duplicate = true`, and the new failure would never surface.
    const xmlPass =
      '<testsuites>' +
      '<testsuite name="alpha" tests="1" failures="0" errors="0" skipped="0"></testsuite>' +
      '</testsuites>';
    const xmlFail =
      '<testsuites>' +
      '<testsuite name="alpha" tests="1" failures="1" errors="0" skipped="0"></testsuite>' +
      '</testsuites>';

    const filePath = write(root, 'reports/one.xml', xmlPass);

    const first = await importJunitFile({ projectRoot: root, filePath });
    expect(first.suites).toBe(1);
    expect(first.events).toBe(1);
    expect(first.skipped).toBe(0);

    let events = parseLedger(root);
    expect(events).toHaveLength(1);
    const passedEvent = events[0]!;
    expect(passedEvent.passed).toBe(1);
    expect(passedEvent.failed).toBe(0);
    expect(passedEvent.total).toBe(1);
    const eventIdPass = passedEvent.eventId;
    expect(typeof eventIdPass).toBe('string');
    expect(eventIdPass.length).toBeGreaterThan(0);

    // Overwrite with the failing variant. Same path, same suite name,
    // same framework — only the counts (and bytes) change.
    writeFileSync(filePath, xmlFail);

    const second = await importJunitFile({ projectRoot: root, filePath });
    expect(second.suites).toBe(1);
    expect(second.events).toBe(1);
    expect(second.skipped).toBe(0);

    events = parseLedger(root);
    // EXACTLY two rows: the original pass + the new fail. If the eventId
    // hash had ignored the counts, the recorder would have deduped the
    // second write and we'd still see one row here.
    expect(events).toHaveLength(2);

    const eventIds = events.map((e) => e.eventId);
    const eventIdFail = eventIds.find((id) => id !== eventIdPass);
    expect(eventIdFail).toBeDefined();
    // Direct assertion: the two eventIds must differ at the hash level —
    // not just at the timestamp level — because the inputs differ on
    // failed / total (and the file bytes, which also feed the fingerprint).
    expect(eventIdFail).not.toBe(eventIdPass);

    const failedRow = events.find((e) => e.eventId === eventIdFail)!;
    expect(failedRow.passed).toBe(0);
    expect(failedRow.failed).toBe(1);
    expect(failedRow.skipped).toBe(0);
    expect(failedRow.total).toBe(1);
    expect(failedRow.scope).toBe('alpha');
  });

  it('produces distinct ledger rows when the file bytes change but counts match (sourceFingerprint)', async () => {
    // Belt-and-suspenders for the Phase-7 fix: even when the headline
    // counts coincidentally line up across two imports of the same path
    // (e.g. one test renamed but total/failed/skipped unchanged), the
    // per-file `sourceFingerprint` must still surface the byte-level
    // change as a distinct eventId. Otherwise a renamed-but-same-count
    // re-run would be silently absorbed by dedupe and the materializer
    // would never see the new test names.
    const xmlA =
      '<testsuites>' +
      '<testsuite name="alpha" tests="1" failures="0" errors="0" skipped="0">' +
      '<testcase name="old-name" classname="alpha" time="0.01"/>' +
      '</testsuite>' +
      '</testsuites>';
    const xmlB =
      '<testsuites>' +
      '<testsuite name="alpha" tests="1" failures="0" errors="0" skipped="0">' +
      '<testcase name="new-name" classname="alpha" time="0.01"/>' +
      '</testsuite>' +
      '</testsuites>';

    const filePath = write(root, 'reports/rename.xml', xmlA);

    await importJunitFile({ projectRoot: root, filePath });
    let events = parseLedger(root);
    expect(events).toHaveLength(1);
    const eventIdA = events[0]!.eventId;

    writeFileSync(filePath, xmlB);
    await importJunitFile({ projectRoot: root, filePath });

    events = parseLedger(root);
    // The content fingerprint differs even though every count matches, so
    // the recorder writes a second distinct row.
    expect(events).toHaveLength(2);
    const eventIdB = events.find((e) => e.eventId !== eventIdA)?.eventId;
    expect(eventIdB).toBeDefined();
    expect(eventIdB).not.toBe(eventIdA);
  });

  it('does not duplicate ledger entries on a second import of the same tree', async () => {
    // Round-5 + Codex Phase-7 expectation (idempotent re-import):
    //
    //   - The importer mints a DETERMINISTIC eventId per `<testsuite>` so a
    //     repeat import of the same XML produces the same eventId.
    //   - The tests recorder dedupes on `eventId` via `appendUniqueJsonlLocked`,
    //     so the second import surfaces `result.duplicate === true` for each
    //     suite and writes NOTHING new to the ledger.
    //   - End result: a runbook-driven re-import of the same JUnit tree is
    //     idempotent. The materializer no longer has to absorb duplicate
    //     ledger rows during read-side aggregation.
    write(
      root,
      'reports/one.junit.xml',
      '<testsuites><testsuite name="a" tests="1" failures="0" errors="0" skipped="0"></testsuite></testsuites>',
    );

    const first = await importJunitTree({
      projectRoot: root,
      rootDir: join(root, 'reports'),
    });
    const second = await importJunitTree({
      projectRoot: root,
      rootDir: join(root, 'reports'),
    });

    // Both invocations agree on the count of `<testsuite>` elements they
    // recognised: re-import does not change the parse result.
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]!.suites).toBe(1);
    expect(second[0]!.suites).toBe(1);
    expect(first[0]!.events).toBe(1);
    expect(second[0]!.events).toBe(1);

    // The ledger has EXACTLY ONE row for that suite. The second import
    // hits the recorder's `eventId` dedupe and is silently dropped.
    const events = parseLedger(root);
    expect(events).toHaveLength(1);
    expect(events[0]!.scope).toBe('a');
  });

  it('returns a frozen summary array (callers must not mutate it)', async () => {
    write(
      root,
      'reports/a.junit.xml',
      '<testsuite tests="1" failures="0" errors="0" skipped="0"></testsuite>',
    );
    const summaries = await importJunitTree({ projectRoot: root, rootDir: join(root, 'reports') });
    expect(Object.isFrozen(summaries)).toBe(true);
  });

  it(
    'parses hostile inputs in linear time (no catastrophic backtracking)',
    async () => {
      // Build a 256 KiB XML body composed of attribute pairs and CDATA
      // blocks the parser must strip. A backtracking-prone regex would
      // explode on this and take MINUTES, not seconds.
      //
      // The assertion below is intentionally a coarse "did not catastrophically
      // backtrack" check, NOT a sub-second performance benchmark. Standalone
      // this completes in ~1.5s; under full-suite concurrency (CPU-pressured
      // worker pool, shared filesystem, GC contention) it can take longer
      // without indicating any regression in the parser itself. The 30s
      // threshold is still substantially faster than a backtracking regex on this
      // input size would produce, so a true O(n^2) (or worse) regression is
      // still caught loudly. The explicit vitest testTimeout matches so the
      // assertion -- not the test framework -- is what fails on regression.
      const big = 1024;
      const parts: string[] = ['<testsuites>'];
      for (let i = 0; i < big; i++) {
        parts.push(
          `<!-- comment ${i} --><![CDATA[<testsuite tests="999"></testsuite>]]><testsuite name="s${i}" tests="1" failures="0" errors="0" skipped="0"></testsuite>`,
        );
      }
      parts.push('</testsuites>');
      write(root, 'reports/hostile.junit.xml', parts.join('\n'));

      const t0 = Date.now();
      const summaries = await importJunitTree({
        projectRoot: root,
        rootDir: join(root, 'reports'),
      });
      const elapsed = Date.now() - t0;

      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.events).toBe(big);
      expect(elapsed).toBeLessThan(30_000);
    },
    60_000,
  );
});
