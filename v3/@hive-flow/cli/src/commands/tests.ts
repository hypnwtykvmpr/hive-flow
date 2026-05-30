// v3/@hive-flow/cli/src/commands/tests.ts
//
// Phase 9 of the statusline rewrite. Top-level `hive-flow tests` command.
//
// This is a thin shim over the existing Wave 4 tests recorder and Wave 6
// JUnit importer. It owns argv parsing and exit-code semantics; all
// recording, validation, and ledger I/O live in the underlying modules.
//
// Subcommands (per Phase 9 of the canonical runbook):
//
//   - `hive-flow tests record --suite|--partial ...`
//       Append one canonical `TestRunEventV1` to the tests JSONL ledger.
//       Exactly one of `--suite` or `--partial` is required. `--partial`
//       also requires `--scope`. Counts must sum to `--total`.
//   - `hive-flow tests import-junit --path <file-or-dir>`
//       Walk a JUnit XML file or directory and append one event per
//       `<testsuite>`. Delegates to `importJunitTree` which handles both
//       a single XML file and a directory tree.
//
// Exit codes:
//   - 0  success
//   - 1  runtime error (from underlying recorder/importer)
//   - 2  argv error (missing required flag, mutual-exclusion violation,
//        non-numeric numeric flag, etc.)
//
// Output:
//   - text (default) goes to stdout, one line per subcommand
//   - `--json` switches to a pretty-printed JSON payload on stdout
//   - errors go to stderr via `output.printError`
//
// Scope: this file MUST NOT re-implement recorder, importer, repair, or
// compact logic. It only parses argv and forwards to the existing modules.

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { importJunitTree, type JunitImportSummary } from '../statusline/junit-import.js';
import {
  recordTestRun,
  type PartialTestRunRecorderInput,
  type RecordTestRunOutcome,
  type SuiteTestRunRecorderInput,
} from '../statusline/recorders/tests.js';
import { resolveProjectScope } from '../statusline/project-scope.js';
import { computeSourceFingerprint } from '../statusline/test-fingerprint.js';
import type { ProducerKind } from '../statusline/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRODUCER_KINDS: readonly ProducerKind[] = Object.freeze([
  'interactive-host',
  'provider-subprocess',
  'daemon',
  'wrapper',
  'native-plugin',
  'mcp-tool',
  'manual',
]);

// ---------------------------------------------------------------------------
// Argv helpers
// ---------------------------------------------------------------------------

/**
 * Pull a flag value off the parsed context. The parser normalizes
 * kebab-case to camelCase, but accept both shapes defensively so callers
 * (tests, scripts) that pass either form continue to work.
 */
function flag(ctx: CommandContext, name: string): unknown {
  const camel = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  if (ctx.flags[camel] !== undefined) return ctx.flags[camel];
  return ctx.flags[name];
}

/** Read a string flag with a default fallback. */
function strFlag(ctx: CommandContext, name: string, fallback: string): string {
  const value = flag(ctx, name);
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return fallback;
}

/** Read an optional string flag; returns undefined when absent or empty. */
function optionalStrFlag(ctx: CommandContext, name: string): string | undefined {
  const value = flag(ctx, name);
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** Read a boolean flag (the parser surfaces booleans as `true`/`false`). */
function boolFlag(ctx: CommandContext, name: string): boolean {
  const value = flag(ctx, name);
  return value === true || value === 'true';
}

/**
 * Argv-validation error used internally by the action handlers. Thrown
 * synchronously when a numeric flag is missing or non-finite/negative so
 * the top-level handler can convert it to an exit-code-2 CommandResult.
 */
class TestsArgvError extends Error {
  readonly code = 'HIVE_FLOW_TESTS_ARGV';
  constructor(message: string) {
    super(message);
    this.name = 'TestsArgvError';
  }
}

/**
 * Read a required numeric flag and validate it is a finite, non-negative
 * integer. JS will happily accept `NaN`, `Infinity`, or fractional values
 * from `Number()`, so we validate explicitly.
 */
function requiredCountFlag(ctx: CommandContext, name: string): number {
  const raw = flag(ctx, name);
  if (raw === undefined || raw === null || raw === '') {
    throw new TestsArgvError(`--${name} is required`);
  }
  // Numbers come through the parser already coerced; strings (e.g. from
  // tests that bypass the parser) must round-trip through `Number`.
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new TestsArgvError(
      `--${name} must be a non-negative integer (received ${String(raw)})`,
    );
  }
  return n;
}

/** Optional numeric flag — undefined when absent, validated when present. */
function optionalNumberFlag(ctx: CommandContext, name: string): number | undefined {
  const raw = flag(ctx, name);
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new TestsArgvError(
      `--${name} must be a non-negative integer (received ${String(raw)})`,
    );
  }
  return n;
}

/**
 * Narrow an arbitrary string onto a closed union of allowed values. Used
 * to validate `--producer-kind`. The fallback is applied when the flag is
 * absent or empty; an unknown non-empty value throws a typed argv error.
 */
function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  flagName: string,
  fallback: T,
): T {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') {
    throw new TestsArgvError(`--${flagName} must be a string`);
  }
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new TestsArgvError(
    `--${flagName} must be one of: ${allowed.join(', ')} (received ${value})`,
  );
}

/**
 * Redact common secret patterns from the `--command` value before storing
 * it in the canonical event. The recorder will also accept it as-is, but
 * the command surface is the natural place to scrub since the producer's
 * shell may have substituted environment variables into the command line.
 */
function redactCommand(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value
    .replace(/(api[_-]?key|token|password|secret|credential)=\S+/gi, '$1=[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[REDACTED]');
}

/**
 * Convert a thrown `TestsArgvError` into the canonical exit-2 result, or
 * surface anything else as a runtime exit-1 error. Centralized here so
 * every subcommand action has identical failure-mode handling.
 */
function toErrorResult(err: unknown): CommandResult {
  if (err instanceof TestsArgvError) {
    output.printError(err.message);
    return { success: false, message: err.message, exitCode: 2 };
  }
  const message = err instanceof Error ? err.message : String(err);
  output.printError(message);
  return { success: false, message, exitCode: 1 };
}

// ---------------------------------------------------------------------------
// Subcommand: record
// ---------------------------------------------------------------------------

async function recordAction(ctx: CommandContext): Promise<CommandResult> {
  let isSuite: boolean;
  let isPartial: boolean;
  /**
   * Scope label.
   *   - `undefined` for whole-suite runs (recorder omits the field).
   *   - A non-empty string for partial runs (guaranteed by the argv check
   *     in the validation block: `--scope` is required when `--partial`).
   */
  let scopeLabel: string | undefined;
  let runner: string;
  let passed: number;
  let failed: number;
  let skipped: number;
  let total: number;
  let durationMs: number | undefined;
  let producerKind: ProducerKind;
  let producerId: string;
  let command: string | undefined;
  let suppliedSourceFingerprint: string | undefined;
  let suppliedEventId: string | undefined;
  let suppliedTs: string | undefined;

  // Argv-only validation happens BEFORE we touch the filesystem so a
  // malformed call cannot leave half-written state behind. Failures here
  // turn into exit-code-2 CommandResults.
  try {
    isSuite = boolFlag(ctx, 'suite');
    isPartial = boolFlag(ctx, 'partial');
    if (isSuite === isPartial) {
      throw new TestsArgvError(
        'tests record requires exactly one of --suite or --partial',
      );
    }
    scopeLabel = optionalStrFlag(ctx, 'scope');
    if (isPartial && (scopeLabel === undefined || scopeLabel.length === 0)) {
      throw new TestsArgvError('--scope is required for --partial test records');
    }
    runner = strFlag(ctx, 'runner', 'unknown');
    passed = requiredCountFlag(ctx, 'passed');
    failed = requiredCountFlag(ctx, 'failed');
    skipped = requiredCountFlag(ctx, 'skipped');
    total = requiredCountFlag(ctx, 'total');
    durationMs = optionalNumberFlag(ctx, 'duration-ms');
    producerKind = oneOf(
      flag(ctx, 'producer-kind'),
      PRODUCER_KINDS,
      'producer-kind',
      'manual',
    );
    producerId = strFlag(ctx, 'producer-id', `manual:${process.pid}`);
    command = redactCommand(optionalStrFlag(ctx, 'command'));
    suppliedSourceFingerprint = optionalStrFlag(ctx, 'source-fingerprint');
    suppliedEventId = optionalStrFlag(ctx, 'event-id');
    suppliedTs = optionalStrFlag(ctx, 'ts');
  } catch (err) {
    return toErrorResult(err);
  }

  // Per-subcommand arithmetic pre-check. The recorder also enforces this
  // invariant (and throws a typed error if it lands there), but we surface
  // a friendlier message here so users see the human-readable form first.
  if (passed + failed + skipped !== total) {
    throw new Error(
      `--passed + --failed + --skipped must equal --total (received ${passed} + ${failed} + ${skipped} = ${passed + failed + skipped} vs total ${total})`,
    );
  }

  // Resolve project scope and (for suite runs) compute a source fingerprint
  // unless the caller supplied one.
  let projectRoot: string;
  let projectKey: string;
  try {
    const scope = await resolveProjectScope(ctx.cwd);
    projectRoot = scope.projectRoot;
    projectKey = scope.projectKey;
  } catch (err) {
    return toErrorResult(err);
  }

  let sourceFingerprint: string | undefined = suppliedSourceFingerprint;
  if (isSuite && sourceFingerprint === undefined) {
    try {
      const fp = await computeSourceFingerprint({ projectRoot });
      sourceFingerprint = fp.sha256;
    } catch {
      // Fingerprint computation is best-effort. If the walk fails (no test
      // files, IO error, etc.) we still record the run without a
      // fingerprint — the recorder will simply omit the field.
      sourceFingerprint = undefined;
    }
  }

  // The recorder accepts `startedAt`/`finishedAt` ISO strings and derives
  // `durationMs` from them. Map the CLI's `--ts` and `--duration-ms` flags
  // onto that shape so the recorder needs no special-case handling:
  //   - `--ts` + `--duration-ms` -> startedAt = ts - durationMs, finishedAt = ts
  //   - `--ts` only              -> finishedAt = ts (point-in-time, no duration)
  //   - `--duration-ms` only     -> finishedAt = now, startedAt = now - durationMs
  //   - neither                  -> recorder stamps both to `now` (durationMs = 0)
  let startedAt: string | undefined;
  let finishedAt: string | undefined = suppliedTs;
  if (durationMs !== undefined) {
    if (suppliedTs !== undefined) {
      const finishMs = Date.parse(suppliedTs);
      if (Number.isFinite(finishMs)) {
        startedAt = new Date(finishMs - durationMs).toISOString();
      }
    } else {
      finishedAt = new Date().toISOString();
      startedAt = new Date(Date.parse(finishedAt) - durationMs).toISOString();
    }
  }

  // Build the discriminated recorder input. The shape mirrors the recorder's
  // exported `SuiteTestRunRecorderInput`/`PartialTestRunRecorderInput`
  // unions so misuse is a compile error.
  const baseInput = {
    framework: runner,
    projectKey,
    repoRoot: projectRoot,
    producerKind,
    producerId,
    passed,
    failed,
    skipped,
    total,
    ...(command !== undefined ? { command } : {}),
    ...(sourceFingerprint !== undefined ? { sourceFingerprint } : {}),
    ...(suppliedEventId !== undefined ? { eventId: suppliedEventId } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
  } as const;

  let input: SuiteTestRunRecorderInput | PartialTestRunRecorderInput;
  if (isSuite) {
    input = { kind: 'suite', ...baseInput };
  } else {
    // The argv block above rejected `partial` without a non-empty `--scope`,
    // so `scopeLabel` is guaranteed defined here. Use a runtime guard
    // (cheap, defensive) rather than a type cast so a future refactor of
    // the argv block cannot silently drop the invariant.
    if (scopeLabel === undefined) {
      return toErrorResult(
        new TestsArgvError('--scope is required for --partial test records'),
      );
    }
    input = { kind: 'partial', ...baseInput, scope: scopeLabel };
  }

  // Delegate to the recorder. Runtime errors (filesystem, lock contention)
  // bubble up to the top-level error handler as exit-code-1.
  let outcome: RecordTestRunOutcome;
  try {
    outcome = await recordTestRun({ projectRoot, input });
  } catch (err) {
    return toErrorResult(err);
  }

  const data = {
    ok: true,
    kind: outcome.event.kind,
    eventId: outcome.event.eventId,
    ts: outcome.event.ts,
    passed: outcome.event.passed,
    failed: outcome.event.failed,
    skipped: outcome.event.skipped,
    total: outcome.event.total,
    written: outcome.result.written,
    spooled: outcome.result.spooled,
    duplicate: outcome.result.duplicate,
  };

  if (wantsJson(ctx)) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    process.stdout.write(
      `recorded ${outcome.event.kind} test run: ${outcome.event.passed}/${outcome.event.total} (eventId=${outcome.event.eventId})\n`,
    );
  }
  return { success: true, data };
}

// ---------------------------------------------------------------------------
// Subcommand: import-junit
// ---------------------------------------------------------------------------

async function importJunitAction(ctx: CommandContext): Promise<CommandResult> {
  let pathArg: string;
  let framework: string | undefined;
  let producerId: string;
  try {
    const rawPath = optionalStrFlag(ctx, 'path');
    if (rawPath === undefined) {
      throw new TestsArgvError('--path is required');
    }
    pathArg = rawPath;
    framework = optionalStrFlag(ctx, 'framework');
    producerId = strFlag(ctx, 'producer-id', `manual:${process.pid}`);
  } catch (err) {
    return toErrorResult(err);
  }

  let projectRoot: string;
  let projectKey: string;
  try {
    const scope = await resolveProjectScope(ctx.cwd);
    projectRoot = scope.projectRoot;
    projectKey = scope.projectKey;
  } catch (err) {
    return toErrorResult(err);
  }

  let summaries: ReadonlyArray<JunitImportSummary>;
  try {
    summaries = await importJunitTree({
      projectRoot,
      rootDir: pathArg,
      projectKey,
      producerId,
      ...(framework !== undefined ? { framework } : {}),
    });
  } catch (err) {
    return toErrorResult(err);
  }

  // Aggregate the per-file summaries into a top-line report. The runbook
  // calls this `imported junit: files=… suites=… skipped=…` in text mode.
  let files = 0;
  let suites = 0;
  let events = 0;
  let skipped = 0;
  for (const summary of summaries) {
    files++;
    suites += summary.suites;
    events += summary.events;
    skipped += summary.skipped;
  }
  const data = {
    ok: true,
    files,
    suites,
    events,
    skipped,
    summaries: summaries.map((s) => ({
      filePath: s.filePath,
      suites: s.suites,
      events: s.events,
      skipped: s.skipped,
      ...(s.reason !== undefined ? { reason: s.reason } : {}),
    })),
  };

  if (wantsJson(ctx)) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    process.stdout.write(
      `imported junit: files=${files}, suites=${suites}, events=${events}, skipped=${skipped}\n`,
    );
  }
  return { success: true, data };
}

/**
 * Honor either the per-subcommand `--json` flag (set in the command's
 * own `options`) or the global `--format json` flag. Mirrors the
 * convention used by `statusline.ts`.
 */
function wantsJson(ctx: CommandContext): boolean {
  if (boolFlag(ctx, 'json')) return true;
  const fmt = ctx.flags.format;
  return typeof fmt === 'string' && fmt === 'json';
}

// ---------------------------------------------------------------------------
// Public command surface
// ---------------------------------------------------------------------------

export const testsCommand: Command = {
  name: 'tests',
  description: 'Record test results for Hive Flow statusline',
  subcommands: [
    {
      name: 'record',
      description: 'Record a whole-suite or partial test run',
      action: recordAction,
      options: [
        {
          name: 'suite',
          description:
            'This is a whole-suite run and updates the statusline Tests cell',
          type: 'boolean',
          default: false,
        },
        {
          name: 'partial',
          description: 'This is a partial run and is diagnostic only',
          type: 'boolean',
          default: false,
        },
        { name: 'scope', description: 'Scope label for partial runs', type: 'string' },
        {
          name: 'runner',
          description: 'Test runner name (vitest, jest, pytest, gotest, ...)',
          type: 'string',
          default: 'unknown',
        },
        // Count flags are required by `requiredCountFlag` in the action
        // handler (exit code 2) rather than via parser `required: true`
        // (exit code 1). The description marks them as required for help
        // output. Same pattern as `--path` on `import-junit`.
        { name: 'passed', description: 'Passed count (required)', type: 'number' },
        { name: 'failed', description: 'Failed count (required)', type: 'number' },
        { name: 'skipped', description: 'Skipped count (required)', type: 'number' },
        { name: 'total', description: 'Total count (required)', type: 'number' },
        { name: 'duration-ms', description: 'Duration in milliseconds', type: 'number' },
        {
          name: 'command',
          description: 'Command that produced this result (secrets are redacted)',
          type: 'string',
        },
        {
          name: 'producer-kind',
          description: `Producer kind (one of: ${PRODUCER_KINDS.join(', ')})`,
          type: 'string',
          default: 'manual',
        },
        { name: 'producer-id', description: 'Producer ID', type: 'string' },
        {
          name: 'source-fingerprint',
          description: 'Source fingerprint at test time (auto-computed for --suite)',
          type: 'string',
        },
        {
          name: 'event-id',
          description: 'Stable event id for replay/idempotency imports',
          type: 'string',
        },
        {
          name: 'ts',
          description: 'ISO timestamp for replayed results (mapped to finishedAt)',
          type: 'string',
        },
        {
          name: 'json',
          description: 'Emit JSON result',
          type: 'boolean',
          default: false,
        },
      ],
    },
    {
      name: 'import-junit',
      description: 'Import JUnit XML file or directory as whole-suite test data',
      action: importJunitAction,
      options: [
        {
          // Not declared `required: true` on the option metadata: the
          // parser's required-flag check would exit with code 1, but
          // argv errors in this command surface as exit code 2 via the
          // in-action validator. The option metadata still documents it
          // for `--help`, and the description below makes the requirement
          // explicit.
          name: 'path',
          description: 'JUnit XML file or directory (required)',
          type: 'string',
        },
        {
          name: 'framework',
          description: 'Optional framework override (defaults to junit-xml)',
          type: 'string',
        },
        { name: 'producer-id', description: 'Producer ID', type: 'string' },
        {
          name: 'json',
          description: 'Emit JSON result',
          type: 'boolean',
          default: false,
        },
      ],
    },
  ],
  examples: [
    {
      command:
        'hive-flow tests record --suite --runner vitest --passed 142 --failed 0 --skipped 0 --total 142',
      description: 'Record whole-suite test success',
    },
    {
      command:
        'hive-flow tests record --partial --scope src/statusline --runner vitest --passed 12 --failed 0 --skipped 0 --total 12',
      description: 'Record partial test run',
    },
    {
      command: 'hive-flow tests import-junit --path ./reports',
      description: 'Import every JUnit XML file under ./reports',
    },
  ],
};

export default testsCommand;
