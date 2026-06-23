// v3/@hive-flow/cli/src/commands/statusline.ts
//
// Top-level `hive-flow statusline` command. Delegates to the canonical
// Claude Code statusline renderer in src/statusline/claude-code-renderer.ts.
//
// This command is intended for humans, tests, and scripted verification.
// The Claude Code `statusLine.command` setting itself should point at the
// stable launcher emitted by integrations/launcher.ts, NOT at this command
// directly (see runbook §6 and §7).
//
// Subcommands:
//   - `wrapper-host` (hidden): Node-based heartbeat host for Windows wrappers
//     (Wave 11A.2). Invoked by the rendered `.cmd` shim as
//     `node <hiveFlowCli> statusline wrapper-host <hostCli>
//        --heartbeat-default <N> -- <realCliBin> [args...]`.
//     Spawns the real CLI as a child (argv array, no shell), emits
//     session-start / session-heartbeat / session-end via the recorder, and
//     forwards the child exit code. Centralizing the heartbeat logic in Node
//     (instead of inline CMD/PowerShell) sidesteps the stdin races and exit
//     code propagation issues documented in Wave 7.5 round-5.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { projectKeyFor, sessionKeyFor } from '../shared/index.js';

import type { Command, CommandContext, CommandResult } from '../types.js';
import { readStatuslineStdin, renderClaudeCodeStatuslineWithMeta } from '../statusline/claude-code-renderer.js';
import { compactAllLedgers, compactLedger } from '../statusline/ledger-compact.js';
import { writeLastRender } from '../statusline/last-render.js';
import { resolveProjectScope } from '../statusline/project-scope.js';
import { repairAllLedgers, repairLedger, REPAIR_TARGETS, type RepairTarget } from '../statusline/repair.js';
import { recordSessionEvent } from '../statusline/recorders/session.js';
import { SPOOL_LEDGER_NAMES, type SpoolLedgerName } from '../statusline/paths.js';
import type {
  HostCli,
  SessionEventV1,
  SessionEventKind,
  SessionEndReason,
} from '../statusline/types.js';

// ---------------------------------------------------------------------------
// wrapper-host: shared with integrations/wrapper-driver.ts (Windows template)
// ---------------------------------------------------------------------------

/**
 * Runtime-validated HostCli set. Must stay in sync with the union in
 * statusline/types.ts and the renderer's whitelist in wrapper-driver.ts.
 */
const VALID_HOST_CLIS: ReadonlySet<string> = new Set<HostCli>([
  'claude-code',
  'codex',
  'gemini',
  'forgecode',
  'cursor-cli',
  'qwen',
  'opencode',
  'hive-flow-daemon',
  'wrapper',
]);

function isValidHostCli(value: unknown): value is HostCli {
  return typeof value === 'string' && VALID_HOST_CLIS.has(value);
}

/** Default heartbeat interval used when both env and `--heartbeat-default` are unset/invalid. */
const DEFAULT_HEARTBEAT_SECONDS = 5;

/**
 * Apply the Wave 7.5 round-5 fork-bomb defence: accept only positive integers
 * (>= 1). Anything else (NaN, negative, zero, fractional below 1, infinity,
 * non-numeric strings) falls back to the supplied default. Fractional values
 * are floored so `2.5` becomes `2` rather than producing sub-second sleeps.
 */
export function parseHeartbeatSeconds(
  raw: string | number | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === null) return fallback;
  const text = typeof raw === 'string' ? raw.trim() : String(raw);
  if (text === '') return fallback;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

/** Parsed shape of a `wrapper-host` invocation. */
export interface WrapperHostArgv {
  readonly hostCli: HostCli;
  readonly heartbeatDefault: number;
  readonly realCliBin: string;
  readonly realCliArgs: readonly string[];
}

/** Argv-parse error. `exitCode` is the conventional `2` for usage failures. */
export class WrapperHostArgvError extends Error {
  constructor(public readonly reason: string, public readonly exitCode: number = 2) {
    super(reason);
    this.name = 'WrapperHostArgvError';
  }
}

/**
 * Parse a `wrapper-host` argv slice. The input is the array AFTER the
 * `wrapper-host` token (i.e. everything after `hive-flow statusline
 * wrapper-host` in the original argv). The contract is:
 *
 *   <hostCli> [--heartbeat-default <N>] -- <realCliBin> [args...]
 *
 * The handler reads the original `process.argv` rather than the parser's
 * post-`--` positional collapse so the split between wrapper flags and
 * the real CLI argv is preserved exactly. Without the explicit `--`
 * separator we cannot tell where the real CLI argv begins.
 *
 * Validation:
 *   - hostCli must be a member of the canonical HostCli union.
 *   - `--heartbeat-default` (if present) must be a positive integer; invalid
 *     values surface as a usage error rather than silently falling back.
 *   - `--` is mandatory; missing `--` is a usage error.
 *   - At least one token after `--` is required (the realCliBin).
 */
export function parseWrapperHostArgv(rest: readonly string[]): WrapperHostArgv {
  if (rest.length === 0) {
    throw new WrapperHostArgvError('wrapper-host: missing <hostCli>');
  }
  const hostCli = rest[0];
  if (!isValidHostCli(hostCli)) {
    throw new WrapperHostArgvError(
      `wrapper-host: invalid hostCli "${hostCli}" (expected one of ${Array.from(VALID_HOST_CLIS).join(', ')})`,
    );
  }

  let heartbeatDefault: number = DEFAULT_HEARTBEAT_SECONDS;
  let i = 1;
  let sawSeparator = false;

  while (i < rest.length) {
    const token = rest[i];
    if (token === '--') {
      sawSeparator = true;
      i++;
      break;
    }
    if (token === '--heartbeat-default') {
      const value = rest[i + 1];
      if (value === undefined) {
        throw new WrapperHostArgvError('wrapper-host: --heartbeat-default requires a value');
      }
      const n = Number(value);
      if (!Number.isFinite(n) || n < 1) {
        throw new WrapperHostArgvError(
          `wrapper-host: --heartbeat-default must be a positive integer (got "${value}")`,
        );
      }
      heartbeatDefault = Math.floor(n);
      i += 2;
      continue;
    }
    if (token.startsWith('--heartbeat-default=')) {
      const value = token.slice('--heartbeat-default='.length);
      const n = Number(value);
      if (!Number.isFinite(n) || n < 1) {
        throw new WrapperHostArgvError(
          `wrapper-host: --heartbeat-default must be a positive integer (got "${value}")`,
        );
      }
      heartbeatDefault = Math.floor(n);
      i++;
      continue;
    }
    throw new WrapperHostArgvError(`wrapper-host: unexpected token "${token}" before "--"`);
  }

  if (!sawSeparator) {
    throw new WrapperHostArgvError('wrapper-host: missing "--" separator before <realCliBin>');
  }

  const realCliBin = rest[i];
  if (realCliBin === undefined || realCliBin === '') {
    throw new WrapperHostArgvError('wrapper-host: missing <realCliBin> after "--"');
  }
  const realCliArgs = rest.slice(i + 1);

  return { hostCli, heartbeatDefault, realCliBin, realCliArgs };
}

/**
 * Recover the slice of argv that follows `wrapper-host`. The CLI parser
 * flattens everything after `--` into `positional`, so the action cannot
 * distinguish the wrapper-host args from the real CLI args via `ctx.args`
 * alone. Reading `process.argv` directly is the only way to preserve the
 * exact split.
 *
 * Strategy: scan for the first occurrence of `wrapper-host` and return
 * everything after it. We accept any preceding tokens (the dispatcher may
 * route `statusline wrapper-host ...` via `bin/cli.js` so the wrapper
 * token is somewhere in the middle of process.argv).
 */
function extractWrapperHostArgv(argv: readonly string[]): string[] {
  const idx = argv.indexOf('wrapper-host');
  if (idx < 0) return [];
  return argv.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// Session-event emission helpers (best-effort)
// ---------------------------------------------------------------------------

/** Build the immutable fields of a SessionEventV1 for a wrapper-host session. */
interface SessionContext {
  readonly hostCli: HostCli;
  readonly sessionId: string;
  readonly repoRoot: string;
  readonly projectKey: string;
  readonly producerId: string;
  readonly pid: number;
}

function firstNonEmptyString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function firstAbsolutePath(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    if (!isAbsolute(trimmed) && !/^[A-Za-z]:[\\/]/.test(trimmed)) continue;
    return resolve(trimmed);
  }
  return undefined;
}

function makeSessionEvent(
  ctx: SessionContext,
  kind: SessionEventKind,
  extras: { exitCode?: number; reason?: SessionEndReason } = {},
): SessionEventV1 {
  const event: SessionEventV1 = {
    version: 1,
    eventId: `${kind}-${ctx.sessionId}-${randomUUID()}`,
    ts: new Date().toISOString(),
    repoRoot: ctx.repoRoot,
    projectKey: ctx.projectKey,
    hostCli: ctx.hostCli,
    sessionId: ctx.sessionId,
    event: kind,
    sessionIdSource: 'wrapper',
    confidence: 'direct',
    producerKind: 'wrapper',
    producerId: ctx.producerId,
    pid: ctx.pid,
    ...(extras.exitCode !== undefined ? { exitCode: extras.exitCode } : {}),
    ...(extras.reason !== undefined ? { reason: extras.reason } : {}),
  };
  return event;
}

/**
 * Emit a single session event, swallowing all errors. The wrapper-host's
 * primary job is to relay argv to the real CLI; recorder failures must NEVER
 * crash the wrapper. Errors are surfaced on stderr for diagnostic purposes.
 */
async function emitBestEffort(
  recorder: SessionRecorder,
  event: SessionEventV1,
  stderr: NodeJS.WritableStream,
): Promise<void> {
  try {
    await recorder(event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`[wrapper-host] session-event emission failed: ${msg}\n`);
  }
}

// ---------------------------------------------------------------------------
// runWrapperHost: the testable core
// ---------------------------------------------------------------------------

export type SpawnFn = typeof spawn;
export type SessionRecorder = (event: SessionEventV1) => Promise<unknown>;

export interface RunWrapperHostDeps {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly pid: number;
  readonly spawnFn: SpawnFn;
  readonly recorder: SessionRecorder;
  readonly setIntervalFn: (cb: () => void, ms: number) => NodeJS.Timeout;
  readonly clearIntervalFn: (handle: NodeJS.Timeout) => void;
  readonly onSignal: (signals: readonly NodeJS.Signals[], handler: (sig: NodeJS.Signals) => void) => () => void;
  readonly stderr: NodeJS.WritableStream;
}

export interface RunWrapperHostResult {
  readonly exitCode: number;
  /** Number of session-heartbeat events emitted via the interval. */
  readonly heartbeatsFired: number;
}

/**
 * Core runtime for the `wrapper-host` subcommand. Pure async: takes injected
 * argv / env / spawn / recorder / timers so unit tests can drive every code
 * path without touching real processes or wall-clock time.
 *
 * Lifecycle:
 *   1. Parse `argv` (everything after `wrapper-host`).
 *   2. Resolve the heartbeat interval: `HIVE_FLOW_HEARTBEAT_SECONDS` env
 *      first (validated with Number.isFinite + >= 1 floor), then the parsed
 *      `--heartbeat-default`, then the hardcoded default (5s).
 *   3. Emit `session-start` (best-effort).
 *   4. Spawn the real CLI as a child with `stdio: 'inherit'` and an argv
 *      array (NO `shell: true`, NO shell-string interpolation).
 *   5. Start a `setInterval` heartbeat that emits `session-heartbeat`.
 *   6. Trap SIGINT / SIGTERM and forward to the child; the child's exit
 *      handler does cleanup + session-end.
 *   7. On child exit: clearInterval, emit `session-end` with the exit code,
 *      release signal traps, return the exit code.
 *
 * On argv-parse errors the function returns exit code 2 (conventional usage
 * error) after writing the reason to stderr.
 */
export async function runWrapperHost(deps: RunWrapperHostDeps): Promise<RunWrapperHostResult> {
  // 1. Parse argv.
  let parsed: WrapperHostArgv;
  try {
    parsed = parseWrapperHostArgv(deps.argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof WrapperHostArgvError ? err.exitCode : 2;
    deps.stderr.write(`${message}\n`);
    return { exitCode: code, heartbeatsFired: 0 };
  }

  // 2. Heartbeat interval.
  const heartbeatSeconds = parseHeartbeatSeconds(
    deps.env.HIVE_FLOW_HEARTBEAT_SECONDS,
    parsed.heartbeatDefault,
  );
  const heartbeatMs = heartbeatSeconds * 1000;

  // 3. Build session context.
  const projectRoot = firstAbsolutePath(
    deps.env.HIVE_FLOW_PROJECT_ROOT,
    deps.env.CLAUDE_PROJECT_DIR,
  ) ?? resolve(deps.cwd);
  const rawSessionId = firstNonEmptyString(
    deps.env.HIVE_FLOW_SESSION_ID,
    deps.env.CLAUDE_SESSION_ID,
    deps.env.CODEX_SESSION_ID,
    deps.env.CODEX_THREAD_ID,
    `pid:${deps.pid}`,
  );
  const sessionId = sessionKeyFor({
    sessionId: rawSessionId,
    clientKind: parsed.hostCli,
  }, deps.env);
  const ctx: SessionContext = {
    hostCli: parsed.hostCli,
    sessionId,
    repoRoot: projectRoot,
    projectKey: projectKeyFor(projectRoot),
    producerId: `wrapper-host:${parsed.hostCli}:${deps.pid}`,
    pid: deps.pid,
  };

  // 4. session-start. Best-effort.
  await emitBestEffort(deps.recorder, makeSessionEvent(ctx, 'session-start'), deps.stderr);

  // 5. Spawn the real CLI. Argv array, stdio inherited, NO shell.
  let child: ChildProcess;
  try {
    child = deps.spawnFn(parsed.realCliBin, [...parsed.realCliArgs], {
      stdio: 'inherit',
      env: deps.env,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.stderr.write(`[wrapper-host] failed to spawn ${parsed.realCliBin}: ${msg}\n`);
    await emitBestEffort(
      deps.recorder,
      makeSessionEvent(ctx, 'session-end', { exitCode: 127, reason: 'unknown' }),
      deps.stderr,
    );
    return { exitCode: 127, heartbeatsFired: 0 };
  }

  // 6. Heartbeat loop. The interval callback emits events asynchronously but
  //    the count is incremented synchronously so tests can assert on it
  //    via fake timers.
  let heartbeatsFired = 0;
  const heartbeatHandle = deps.setIntervalFn(() => {
    heartbeatsFired++;
    // Fire-and-forget. The promise is intentionally not awaited inside the
    // tick callback so a slow recorder cannot delay subsequent heartbeats.
    void emitBestEffort(deps.recorder, makeSessionEvent(ctx, 'session-heartbeat'), deps.stderr);
  }, heartbeatMs);

  // 7. Signal forwarding. Trap SIGINT/SIGTERM, forward to the child, and
  //    rely on the child's exit handler for cleanup. The handler returned
  //    by `onSignal` removes the listeners so they don't leak across
  //    successive wrapper-host invocations inside the same process (unit
  //    tests).
  let signaledExitCode: number | undefined;
  let signaledReason: SessionEndReason | undefined;
  const releaseSignals = deps.onSignal(['SIGINT', 'SIGTERM'], (sig) => {
    // Conventional shell exit code: 128 + signal number. Node exposes the
    // signal name only, so we map the two we care about.
    if (sig === 'SIGINT') signaledExitCode = 130;
    else if (sig === 'SIGTERM') signaledExitCode = 143;
    else signaledExitCode = 1;
    signaledReason = 'signal';
    // Forward to the child. If the child is already dead, .kill returns
    // false and we ignore that — the exit handler will still fire.
    try {
      child.kill(sig);
    } catch {
      // Defence-in-depth: a kill on a dead PID can throw on some platforms.
      // Swallow — the exit handler will catch the actual termination.
    }
  });

  // 8. Wait for child exit, emit session-end, return.
  const exitCode = await new Promise<number>((resolveExit) => {
    let resolved = false;
    const settle = (code: number) => {
      if (resolved) return;
      resolved = true;
      resolveExit(code);
    };
    child.once('exit', (code, signal) => {
      if (signaledExitCode !== undefined) {
        settle(signaledExitCode);
        return;
      }
      if (signal) {
        // Child died from an external signal we didn't trap (e.g. SIGKILL).
        signaledReason = 'signal';
        settle(signal === 'SIGTERM' ? 143 : signal === 'SIGINT' ? 130 : 1);
        return;
      }
      settle(typeof code === 'number' ? code : 1);
    });
    child.once('error', (err) => {
      deps.stderr.write(
        `[wrapper-host] child runtime error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      settle(1);
    });
  });

  // 9. Cleanup. clearInterval and release the signal traps BEFORE emitting
  //    session-end so a slow recorder cannot cause the interval to fire
  //    again or signal traps to leak.
  deps.clearIntervalFn(heartbeatHandle);
  releaseSignals();

  // 10. session-end with the resolved exit code.
  const reason: SessionEndReason = signaledReason ?? 'normal-exit';
  await emitBestEffort(
    deps.recorder,
    makeSessionEvent(ctx, 'session-end', { exitCode, reason }),
    deps.stderr,
  );

  return { exitCode, heartbeatsFired };
}

// ---------------------------------------------------------------------------
// Subcommand surface
// ---------------------------------------------------------------------------

/**
 * Default `onSignal` implementation backed by `process.on`. Returns a
 * disposer that removes the listeners. Tests inject a stub.
 */
function defaultOnSignal(
  signals: readonly NodeJS.Signals[],
  handler: (sig: NodeJS.Signals) => void,
): () => void {
  const wrap = (sig: NodeJS.Signals) => () => handler(sig);
  const wrapped = signals.map((sig) => ({ sig, fn: wrap(sig) }));
  for (const { sig, fn } of wrapped) {
    process.on(sig, fn);
  }
  return () => {
    for (const { sig, fn } of wrapped) {
      process.off(sig, fn);
    }
  };
}

/**
 * `hive-flow statusline wrapper-host`. Hidden from `--help` output. Operators
 * should NEVER invoke this directly — it is part of the Wave 11A Windows
 * wrapper template and the generated `.cmd` script is the only legitimate
 * caller. The handler runs the real CLI as a child, emits session telemetry,
 * and exits with the child's exit code.
 */
export const wrapperHostSubcommand: Command = {
  name: 'wrapper-host',
  description: '(internal) Node-based heartbeat host for Windows wrappers',
  hidden: true,
  options: [
    {
      name: 'heartbeat-default',
      description: 'Default heartbeat interval in seconds (>= 1). Used if HIVE_FLOW_HEARTBEAT_SECONDS is unset/invalid.',
      type: 'number',
      default: DEFAULT_HEARTBEAT_SECONDS,
    },
  ],
  action: async (_ctx: CommandContext): Promise<CommandResult> => {
    const rest = extractWrapperHostArgv(process.argv);
    const result = await runWrapperHost({
      argv: rest,
      env: process.env,
      cwd: process.cwd(),
      pid: process.pid,
      spawnFn: spawn,
      recorder: recordSessionEvent,
      setIntervalFn: (cb, ms) => setInterval(cb, ms),
      clearIntervalFn: (handle) => clearInterval(handle),
      onSignal: defaultOnSignal,
      stderr: process.stderr,
    });
    // Forward the child's exit code via the CommandResult so the dispatcher
    // calls `process.exit(result.exitCode)`. The dispatcher in index.ts only
    // honors `exitCode` when `success` is false, so encode any non-zero exit
    // as a failure. Exit 0 returns success.
    if (result.exitCode === 0) {
      return { success: true, exitCode: 0 };
    }
    return { success: false, exitCode: result.exitCode };
  },
};

// ---------------------------------------------------------------------------
// Maintenance subcommands: repair / compact
// ---------------------------------------------------------------------------

class StatuslineArgvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatuslineArgvError';
  }
}

function flag(ctx: CommandContext, name: string): unknown {
  const camel = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  if (ctx.flags[camel] !== undefined) return ctx.flags[camel];
  return ctx.flags[name];
}

function boolFlag(ctx: CommandContext, name: string): boolean {
  const value = flag(ctx, name);
  return value === true || value === 'true';
}

function stringFlag(ctx: CommandContext, name: string): string | undefined {
  const value = flag(ctx, name);
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function wantsJson(ctx: CommandContext): boolean {
  if (boolFlag(ctx, 'json')) return true;
  const format = flag(ctx, 'format');
  return format === 'json';
}

function parsePositiveIntegerFlag(ctx: CommandContext, name: string): number {
  const raw = flag(ctx, name);
  if (raw === undefined || raw === null || raw === '') {
    throw new StatuslineArgvError(`--${name} is required`);
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new StatuslineArgvError(`--${name} must be a positive integer (received ${String(raw)})`);
  }
  return n;
}

function isRepairTarget(value: string): value is RepairTarget {
  return (REPAIR_TARGETS as ReadonlyArray<string>).includes(value);
}

function isSpoolLedgerName(value: string): value is SpoolLedgerName {
  return (SPOOL_LEDGER_NAMES as ReadonlyArray<string>).includes(value);
}

function parseRepairTarget(ctx: CommandContext): RepairTarget {
  const target = stringFlag(ctx, 'target');
  if (target === undefined) {
    throw new StatuslineArgvError('--target is required unless --all is set');
  }
  if (!isRepairTarget(target)) {
    throw new StatuslineArgvError(`--target must be one of: ${REPAIR_TARGETS.join(', ')} (received ${target})`);
  }
  return target;
}

function parseCompactTarget(ctx: CommandContext): SpoolLedgerName {
  const target = stringFlag(ctx, 'target') ?? stringFlag(ctx, 'ledger');
  if (target === undefined) {
    throw new StatuslineArgvError('--target or --ledger is required unless --all is set');
  }
  if (!isSpoolLedgerName(target)) {
    throw new StatuslineArgvError(`--target must be one of: ${SPOOL_LEDGER_NAMES.join(', ')} (received ${target})`);
  }
  return target;
}

function writeCommandOutput(ctx: CommandContext, data: unknown, text: string): void {
  if (wantsJson(ctx)) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    process.stdout.write(text + '\n');
  }
}

function toMaintenanceErrorResult(err: unknown): CommandResult {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  return {
    success: false,
    message,
    exitCode: err instanceof StatuslineArgvError ? 2 : 1,
  };
}

async function projectRootFromContext(ctx: CommandContext): Promise<string> {
  const scope = await resolveProjectScope(ctx.cwd);
  return scope.projectRoot;
}

async function repairAction(ctx: CommandContext): Promise<CommandResult> {
  try {
    const projectRoot = await projectRootFromContext(ctx);
    if (boolFlag(ctx, 'all')) {
      const results = await repairAllLedgers(projectRoot);
      const data = { ok: true, results };
      writeCommandOutput(ctx, data, `repaired all statusline ledgers: ${results.length} targets`);
      return { success: true, data };
    }
    const target = parseRepairTarget(ctx);
    const result = await repairLedger({ projectRoot, target });
    writeCommandOutput(
      ctx,
      result,
      `repaired ${result.target}: read=${result.read} corrupt=${result.corrupt} wroteCurrent=${result.wroteCurrent}`,
    );
    return { success: true, data: result };
  } catch (err) {
    return toMaintenanceErrorResult(err);
  }
}

async function compactAction(ctx: CommandContext): Promise<CommandResult> {
  try {
    const keep = parsePositiveIntegerFlag(ctx, 'keep');
    const projectRoot = await projectRootFromContext(ctx);
    if (boolFlag(ctx, 'all')) {
      const results = await compactAllLedgers(projectRoot, keep);
      const errors = results.filter((r) => r.error === true).length;
      const data = { ok: errors === 0, results, errors };
      writeCommandOutput(
        ctx,
        data,
        errors === 0
          ? `compacted all statusline ledgers: ${results.length} targets`
          : `compacted statusline ledgers with ${errors} error(s): ${results.length} targets`,
      );
      return { success: errors === 0, data, exitCode: errors === 0 ? 0 : 1 };
    }
    const target = parseCompactTarget(ctx);
    const result = await compactLedger({ projectRoot, target, keep });
    writeCommandOutput(
      ctx,
      result,
      `compacted ${result.target}: before=${result.before} after=${result.after} skipped=${result.skipped} wroteCurrent=${result.wroteCurrent}`,
    );
    return { success: true, data: result };
  } catch (err) {
    return toMaintenanceErrorResult(err);
  }
}

export const repairSubcommand: Command = {
  name: 'repair',
  description: 'Rebuild statusline current.json files from ledgers',
  options: [
    {
      name: 'target',
      description: `Ledger family to repair (${REPAIR_TARGETS.join(', ')})`,
      type: 'string',
    },
    {
      name: 'all',
      description: 'Repair every statusline ledger family',
      type: 'boolean',
      default: false,
    },
    {
      name: 'json',
      description: 'Emit JSON result',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    {
      command: 'hive-flow statusline repair --target tests',
      description: 'Rebuild the tests current.json files from the tests ledger',
    },
    {
      command: 'hive-flow statusline repair --all --json',
      description: 'Repair every statusline current.json file and emit JSON',
    },
  ],
  action: repairAction,
};

export const compactSubcommand: Command = {
  name: 'compact',
  description: 'Trim statusline JSONL ledgers to their most recent valid entries',
  options: [
    {
      name: 'target',
      description: `Canonical ledger to compact (${SPOOL_LEDGER_NAMES.join(', ')})`,
      type: 'string',
    },
    {
      name: 'ledger',
      description: 'Alias for --target',
      type: 'string',
    },
    {
      name: 'all',
      description: 'Compact every statusline ledger',
      type: 'boolean',
      default: false,
    },
    {
      name: 'keep',
      description: 'Number of most-recent valid rows to keep',
      type: 'number',
    },
    {
      name: 'json',
      description: 'Emit JSON result',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    {
      command: 'hive-flow statusline compact --target tests --keep 500',
      description: 'Compact the tests ledger to the most recent 500 valid events',
    },
    {
      command: 'hive-flow statusline compact --all --keep 1000 --json',
      description: 'Compact every statusline ledger and emit JSON',
    },
  ],
  action: compactAction,
};

// ---------------------------------------------------------------------------
// Top-level statusline command
// ---------------------------------------------------------------------------

export const statuslineCommand: Command = {
  name: 'statusline',
  description: 'Render Hive Flow statusline output for coding agent CLIs',
  options: [
    {
      name: 'agent',
      description: 'Agent CLI name (only "claude-code" is currently supported)',
      type: 'string',
      default: 'claude-code',
    },
    {
      name: 'json',
      description: 'Emit structured output containing the rendered text',
      type: 'boolean',
      default: false,
    },
  ],
  subcommands: [wrapperHostSubcommand, repairSubcommand, compactSubcommand],
  examples: [
    {
      command: 'hive-flow statusline --agent claude-code',
      description: 'Render Claude Code statusline from stdin',
    },
    {
      command: 'hive-flow statusline --agent claude-code --json',
      description: 'Emit structured JSON containing the rendered text',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const agent = String(ctx.flags.agent ?? 'claude-code');
    if (agent !== 'claude-code') {
      return {
        success: false,
        message: `Unsupported statusline agent: ${agent}`,
        exitCode: 2,
      };
    }

    const stdinData = await readStatuslineStdin();
    const meta = await renderClaudeCodeStatuslineWithMeta(stdinData, process.cwd());
    const rendered = meta.rendered;

    if (meta.projectKey && meta.projectRoot) {
      await writeLastRender({
        rendered: meta.rendered,
        mode: meta.mode,
        projectRoot: meta.projectRoot,
        projectKey: meta.projectKey,
        ...(meta.snapshot !== undefined ? { snapshot: meta.snapshot } : {}),
      }).catch(() => undefined);
    }

    if (ctx.flags.json || ctx.flags.format === 'json') {
      const data = { text: rendered, agent };
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      return { success: true, data };
    }

    process.stdout.write(rendered + '\n');
    return { success: true, data: { text: rendered, agent } };
  },
};

export default statuslineCommand;
