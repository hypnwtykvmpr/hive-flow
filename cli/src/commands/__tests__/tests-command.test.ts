// cli/src/commands/__tests__/tests-command.test.ts
//
// Behavioural tests for the `hive-flow tests` command (Phase 9 of the
// statusline rewrite). Covers:
//
//   - happy-path `tests record --suite` and `tests record --partial`
//   - happy-path `tests import-junit` against a tiny JUnit fixture
//   - argv-error surfaces (mutual exclusion, missing flags, non-numeric)
//   - secret redaction in --command
//   - replay event-id + ts honoured by the recorder
//   - source-fingerprint auto-computed for suite runs
//   - dispatcher registration: testsCommand is discoverable from
//     `getCommand('tests')` and exposed on the public commands array
//
// File name is deliberately `tests-command.test.ts` (NOT `tests.test.ts`)
// to avoid colliding with the recorder + collector test files.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import testsCommand from '../tests.js';
import type { Command, CommandContext } from '../../types.js';
import {
  commands,
  commandRegistry,
  getCommand,
  hasCommand,
  getCommandAsync,
} from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(
  cwd: string,
  flags: Record<string, string | number | boolean>,
): CommandContext {
  return {
    cwd,
    args: [],
    flags: { _: [], ...flags },
    interactive: false,
  };
}

function getSub(name: 'record' | 'import-junit'): Command {
  const sub = testsCommand.subcommands?.find((c) => c.name === name);
  if (!sub) throw new Error(`subcommand not found: ${name}`);
  return sub;
}

// Silence the command's stderr output (we assert on returned CommandResult
// for argv errors instead of capturing the printed `[ERROR]` lines).
beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  // Also silence stdout for tests that don't read it directly so the
  // vitest reporter stays clean.
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// record subcommand
// ---------------------------------------------------------------------------

describe('hive-flow tests record', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'hf-tests-cmd-record-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('appends a whole-suite event to the tests ledger', async () => {
    const action = getSub('record').action!;
    const result = await action(
      makeCtx(projectRoot, {
        suite: true,
        runner: 'vitest',
        passed: 5,
        failed: 0,
        skipped: 0,
        total: 5,
        'event-id': 'suite-happy-1',
        json: true,
      }),
    );
    expect(result).toMatchObject({ success: true });

    const ledger = readFileSync(
      join(projectRoot, '.hive-flow/tests/last-run.jsonl'),
      'utf8',
    );
    expect(ledger).toContain('"eventId":"suite-happy-1"');
    expect(ledger).toContain('"kind":"suite"');
    expect(ledger).toContain('"runner":"vitest"');
    expect(ledger).toContain('"passed":5');
    expect(ledger).toContain('"total":5');
  });

  it('appends a partial event with the required scope label', async () => {
    const action = getSub('record').action!;
    const result = await action(
      makeCtx(projectRoot, {
        partial: true,
        scope: 'src/statusline',
        runner: 'vitest',
        passed: 12,
        failed: 0,
        skipped: 0,
        total: 12,
        'event-id': 'partial-1',
        json: true,
      }),
    );
    expect(result).toMatchObject({ success: true });

    const ledger = readFileSync(
      join(projectRoot, '.hive-flow/tests/last-run.jsonl'),
      'utf8',
    );
    expect(ledger).toContain('"kind":"partial"');
    expect(ledger).toContain('"scope":"src/statusline"');
    expect(ledger).toContain('"eventId":"partial-1"');
  });

  it('rejects missing or conflicting suite/partial flags with exit code 2', async () => {
    const action = getSub('record').action!;

    // Neither --suite nor --partial.
    const neither = await action(
      makeCtx(projectRoot, {
        runner: 'vitest',
        passed: 1,
        failed: 0,
        skipped: 0,
        total: 1,
      }),
    );
    expect(neither).toMatchObject({ success: false, exitCode: 2 });

    // Both --suite and --partial.
    const both = await action(
      makeCtx(projectRoot, {
        suite: true,
        partial: true,
        runner: 'vitest',
        passed: 1,
        failed: 0,
        skipped: 0,
        total: 1,
      }),
    );
    expect(both).toMatchObject({ success: false, exitCode: 2 });
  });

  it('rejects --partial without --scope with exit code 2', async () => {
    const action = getSub('record').action!;
    const result = await action(
      makeCtx(projectRoot, {
        partial: true,
        runner: 'vitest',
        passed: 1,
        failed: 0,
        skipped: 0,
        total: 1,
      }),
    );
    expect(result).toMatchObject({ success: false, exitCode: 2 });
  });

  it('rejects a missing --total flag with exit code 2', async () => {
    const action = getSub('record').action!;
    const result = await action(
      makeCtx(projectRoot, {
        suite: true,
        runner: 'vitest',
        passed: 1,
        failed: 0,
        skipped: 0,
      }),
    );
    expect(result).toMatchObject({ success: false, exitCode: 2 });
  });

  it('rejects a non-numeric --total with exit code 2', async () => {
    const action = getSub('record').action!;
    // Pass a string that does NOT round-trip through Number. The real CLI
    // parser would coerce numeric-looking strings (`Number('12') === 12`)
    // but a stray non-numeric value must surface as exit code 2 rather
    // than crash inside the recorder.
    const result = await action(
      makeCtx(projectRoot, {
        suite: true,
        runner: 'vitest',
        passed: 1,
        failed: 0,
        skipped: 0,
        total: 'banana',
      }),
    );
    expect(result).toMatchObject({ success: false, exitCode: 2 });
  });

  it('throws when counts do not sum to total', async () => {
    const action = getSub('record').action!;
    await expect(
      action(
        makeCtx(projectRoot, {
          suite: true,
          runner: 'vitest',
          passed: 1,
          failed: 1,
          skipped: 0,
          total: 1,
        }),
      ),
    ).rejects.toThrow(/must equal/);
  });

  it('honors --event-id and --ts on replay', async () => {
    const action = getSub('record').action!;
    await action(
      makeCtx(projectRoot, {
        partial: true,
        scope: 'src/statusline',
        runner: 'vitest',
        passed: 1,
        failed: 0,
        skipped: 0,
        total: 1,
        'event-id': 'replay-1',
        ts: '2026-05-20T00:00:00.000Z',
        json: true,
      }),
    );
    const ledger = readFileSync(
      join(projectRoot, '.hive-flow/tests/last-run.jsonl'),
      'utf8',
    );
    expect(ledger).toContain('"eventId":"replay-1"');
    expect(ledger).toContain('"ts":"2026-05-20T00:00:00.000Z"');
  });

  it('redacts secrets in --command before storage', async () => {
    const action = getSub('record').action!;
    await action(
      makeCtx(projectRoot, {
        suite: true,
        runner: 'vitest',
        passed: 1,
        failed: 0,
        skipped: 0,
        total: 1,
        command: 'npm test -- API_KEY=sk-abcdef1234567890',
        'event-id': 'redact-1',
        json: true,
      }),
    );
    const ledger = readFileSync(
      join(projectRoot, '.hive-flow/tests/last-run.jsonl'),
      'utf8',
    );
    expect(ledger).toContain('REDACTED');
    expect(ledger).not.toContain('sk-abcdef1234567890');
    expect(ledger).not.toContain('API_KEY=sk-');
  });

  it('records source fingerprint for whole-suite runs by default', async () => {
    // Create at least one test-like file so computeSourceFingerprint has
    // something to hash. The fingerprint walk is best-effort — even with
    // no files we still write the recorder; with a file present we expect
    // a "sourceFingerprint" entry in the ledger row.
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'src/example.test.ts'),
      "import { test, expect } from 'vitest';\ntest('demo', () => { expect(1).toBe(1); });\n",
    );

    const action = getSub('record').action!;
    await action(
      makeCtx(projectRoot, {
        suite: true,
        runner: 'vitest',
        passed: 1,
        failed: 0,
        skipped: 0,
        total: 1,
        'event-id': 'fp-suite',
        json: true,
      }),
    );
    const ledger = readFileSync(
      join(projectRoot, '.hive-flow/tests/last-run.jsonl'),
      'utf8',
    );
    expect(ledger).toContain('"sourceFingerprint"');
  });

  it('preserves caller-supplied source fingerprint when provided', async () => {
    const action = getSub('record').action!;
    await action(
      makeCtx(projectRoot, {
        suite: true,
        runner: 'vitest',
        passed: 1,
        failed: 0,
        skipped: 0,
        total: 1,
        'source-fingerprint': 'caller-supplied-abc',
        'event-id': 'fp-caller',
        json: true,
      }),
    );
    const ledger = readFileSync(
      join(projectRoot, '.hive-flow/tests/last-run.jsonl'),
      'utf8',
    );
    expect(ledger).toContain('"sourceFingerprint":"caller-supplied-abc"');
  });
});

// ---------------------------------------------------------------------------
// import-junit subcommand
// ---------------------------------------------------------------------------

describe('hive-flow tests import-junit', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'hf-tests-cmd-junit-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('imports a single JUnit XML file and appends one event per suite', async () => {
    const junitDir = join(projectRoot, 'reports');
    mkdirSync(junitDir, { recursive: true });
    writeFileSync(
      join(junitDir, 'one.xml'),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<testsuite name="alpha" tests="2" failures="0" errors="0" skipped="0">',
        '  <testcase name="a" classname="alpha" />',
        '  <testcase name="b" classname="alpha" />',
        '</testsuite>',
      ].join('\n'),
    );

    const action = getSub('import-junit').action!;
    const result = await action(
      makeCtx(projectRoot, { path: junitDir, json: true }),
    );
    expect(result).toMatchObject({ success: true });
    expect(result?.data).toMatchObject({ files: 1, suites: 1, events: 1, skipped: 0 });

    const ledger = readFileSync(
      join(projectRoot, '.hive-flow/tests/last-run.jsonl'),
      'utf8',
    );
    expect(ledger).toContain('"kind":"suite"');
    expect(ledger).toContain('"total":2');
    expect(ledger).toContain('"runner":"junit-xml"');
  });

  it('accepts a single XML file (not a directory) as --path', async () => {
    const filePath = join(projectRoot, 'single.xml');
    writeFileSync(
      filePath,
      '<testsuite name="solo" tests="1" failures="0" errors="0" skipped="0"><testcase name="t" /></testsuite>',
    );
    const action = getSub('import-junit').action!;
    const result = await action(
      makeCtx(projectRoot, { path: filePath, json: true }),
    );
    expect(result).toMatchObject({ success: true });
    expect((result?.data as { events: number }).events).toBe(1);
  });

  it('rejects a missing --path flag with exit code 2', async () => {
    const action = getSub('import-junit').action!;
    const result = await action(makeCtx(projectRoot, {}));
    expect(result).toMatchObject({ success: false, exitCode: 2 });
  });

  it('honors --framework override on the recorded event', async () => {
    const filePath = join(projectRoot, 'override.xml');
    writeFileSync(
      filePath,
      '<testsuite name="o" tests="1" failures="0" errors="0" skipped="0"><testcase name="t" /></testsuite>',
    );
    const action = getSub('import-junit').action!;
    await action(
      makeCtx(projectRoot, {
        path: filePath,
        framework: 'custom-runner',
        json: true,
      }),
    );
    const ledger = readFileSync(
      join(projectRoot, '.hive-flow/tests/last-run.jsonl'),
      'utf8',
    );
    expect(ledger).toContain('"runner":"custom-runner"');
  });
});

// ---------------------------------------------------------------------------
// Dispatcher registration
// ---------------------------------------------------------------------------

describe('commands/index registration', () => {
  it('exposes the tests command on the public commands array', () => {
    expect(commands.find((c) => c.name === 'tests')).toBe(testsCommand);
  });

  it('exposes the tests command via the sync registry', () => {
    expect(commandRegistry.get('tests')).toBe(testsCommand);
    expect(getCommand('tests')).toBe(testsCommand);
    expect(hasCommand('tests')).toBe(true);
  });

  it('exposes the tests command via the async lazy-loader path', async () => {
    const loaded = await getCommandAsync('tests');
    // Either the cached sync entry or a re-loaded module export — both
    // resolve to a command with the canonical shape.
    expect(loaded?.name).toBe('tests');
    expect(loaded?.subcommands?.map((s) => s.name).sort()).toEqual([
      'import-junit',
      'record',
    ]);
  });

  it('the command exposes exactly the two subcommands from Phase 9', () => {
    const names = testsCommand.subcommands?.map((s) => s.name).sort();
    expect(names).toEqual(['import-junit', 'record']);
  });
});
