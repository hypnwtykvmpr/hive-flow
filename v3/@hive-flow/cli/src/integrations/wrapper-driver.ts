// v3/@hive-flow/cli/src/integrations/wrapper-driver.ts
//
// Wave 11 wrapper-driver. Shared POSIX + Windows wrapper-script renderer used
// by every wrapper-mode connector adapter (Codex, Gemini, ForgeCode, OpenCode,
// Cursor CLI, Qwen — 6 of the 7 connector targets; Claude Code uses native
// integration). The wrapper relays argv to the underlying CLI and emits
// session events (`session-start`, `session-heartbeat`, `session-end`) to the
// hive-flow statusline recorder so the renderer can show "who's currently
// running" across host-CLI sessions.
//
// Binding constraints (Phase 5):
//   - Wrapper-only for non-Claude CLIs — this is the script generator they
//     all share.
//   - No `shell: true` anywhere. Argv arrays only.
//   - No `gh pr view`, `du -sh`, or network. Wrapper relays argv to the
//     underlying CLI and emits session events to the recorder.
//   - No literal control bytes in source (ANSI bytes are *data* in the
//     statusline recorder, not source code here).
//
// Wave 7.5 round-5 lesson — fork-bomb hardening:
//   The heartbeat interval is parsed from `HIVE_FLOW_HEARTBEAT_SECONDS`. If the
//   env var is invalid (NaN, negative, zero, non-numeric), a naive `sleep 0`
//   loop would spin without yielding — effectively a fork-bomb. Both the POSIX
//   bash template and the Node-based Windows fallback validate the value with
//   `Number.isFinite` + `>= 1` floor (bash uses a strict POSIX-extended regex
//   that admits only positive integers; Node uses `Number.isFinite` directly).
//
// Wave 8.4 lesson — user-cache safety:
//   `writeWrapper` routes the parent-directory creation through
//   `ensureSafeUserCacheDir`, which lstat-walks every segment from `baseDir`
//   to the destination and rejects any symlinked intermediate. Single-segment
//   mkdir prevents the kernel from following a freshly-created symlink mid
//   path. The wrapper body itself is written through `atomicWrite` (write to
//   `tmp` + rename) so partial writes never produce a half-written script.
//
// Public API:
//   - `renderPosixWrapper(opts)`: returns the bash script text.
//   - `renderWindowsWrapper(opts)`: returns the `.cmd` script text. The `.cmd`
//     dispatches to `node ${hiveFlowCli} statusline wrapper-host ...` so the
//     Node process handles the heartbeat (avoids CMD/PowerShell stdin races
//     observed in Wave 7.5 round-5).
//   - `writeWrapper({...opts, destPath, baseDir})`: writes the rendered
//     POSIX or Windows script to `destPath`, choosing the template based on
//     `process.platform`. Parent directory creation is symlink-safe.

import { chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWrite } from './atomic-merge.js';
import { ensureSafeUserCacheDir } from '../statusline/storage.js';
import type { HostCli } from '../statusline/types.js';

// ---------------------------------------------------------------------------
// HostCli validation. The `HostCli` union from `statusline/types.ts` is
// duplicated here as a runtime set so we can validate untrusted callers
// before letting them through to the rendered shell text.
//
// Wave 11 cleanup: the set is typed as `ReadonlySet<string>` (widened from
// `ReadonlySet<HostCli>`) so `Set#has(value)` accepts any `string` without
// needing a `value as HostCli` cast. The `is HostCli` type-predicate below
// performs the narrowing once, where it's documented and tested.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface WrapperRenderOptions {
  /** Absolute path to the real CLI binary (e.g., `/opt/codex/bin/codex`). */
  readonly realCliBin: string;
  /** Host-CLI tag emitted on every session event. */
  readonly hostCli: HostCli;
  /** Absolute path to the hive-flow CLI entrypoint (a node script). */
  readonly hiveFlowCli: string;
  /**
   * Optional process env snapshot. Currently only used to look up
   * `HIVE_FLOW_HEARTBEAT_SECONDS` at *render* time so deterministic tests can
   * pin the default — runtime parsing inside the script still re-reads the
   * env each invocation.
   */
  readonly env?: NodeJS.ProcessEnv;
}

export interface WriteWrapperOptions extends WrapperRenderOptions {
  /** Absolute destination path for the wrapper script. */
  readonly destPath: string;
  /**
   * Absolute path to the user-cache base directory used for the path-walk
   * symlink guard. Every segment of `destPath` (other than the leaf) must lie
   * inside `baseDir` after resolution.
   */
  readonly baseDir: string;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Reject any string containing a control character (0x00 - 0x1F). Same rule
 * as `launcher.ts`'s `shellQuote` — defence-in-depth so NUL / CR / LF cannot
 * smuggle a newline into the generated shim and inject a second command.
 *
 * The regex is written so the source file remains free of literal control
 * bytes (the bug-hunt rule). We construct the character class from the
 * `\x00` and `\x1f` escape sequences rather than embedding raw bytes.
 */
function containsControlByte(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1f]/.test(value);
}

function assertNoControlBytes(label: string, value: string): void {
  if (containsControlByte(value)) {
    throw new Error(
      `${label} contains control characters: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * POSIX single-quote escaping. Wraps `value` in single quotes and escapes
 * any embedded single quote with the standard close/escape/reopen pattern
 * (`'\''`). Refuses control characters up front so a malicious path cannot
 * inject newlines into the rendered shim.
 *
 * Example: `/opt/foo bar/cli` => `'/opt/foo bar/cli'`
 * Example: `/a/b'/c` => `'/a/b'\''/c'`
 * Adversarial test case: `/opt/x; rm -rf /` => `'/opt/x; rm -rf /'` — the
 * `;` and `rm` are literal characters inside the single-quoted string and
 * cannot be interpreted by the shell.
 */
function shellQuote(value: string): string {
  assertNoControlBytes('shellQuote: value', value);
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Windows `.cmd` quoting for `node` invocation. Wraps `value` in double
 * quotes and escapes any embedded double quote with `""` (CMD's documented
 * convention). Refuses control characters and percent signs — the latter
 * because `%` triggers variable expansion in CMD and we have no use for it
 * inside a quoted argument that's strictly a path. A path containing `%`
 * is rare enough that rejecting it is the safe default.
 */
function cmdQuote(value: string): string {
  assertNoControlBytes('cmdQuote: value', value);
  if (value.includes('%')) {
    throw new Error(
      `cmdQuote: value contains '%' which is unsafe in CMD: ${JSON.stringify(value)}`,
    );
  }
  return '"' + value.replace(/"/g, '""') + '"';
}

/**
 * Parse the heartbeat interval from `env.HIVE_FLOW_HEARTBEAT_SECONDS` (or the
 * caller-supplied fallback). The result is always a positive integer >= 1.
 *
 * Wave 7.5 round-5: an invalid value must not cause the wrapper to fork-bomb.
 * Validation rule: `Number.isFinite(n) && n >= 1`. Anything else collapses
 * to the default (5s). Non-integers round down (`Math.floor`) so a value of
 * `2.5` becomes `2` rather than triggering sub-second sleeps. Inside the
 * bash template the same validation runs at runtime via a POSIX-extended
 * regex that only admits `^[1-9][0-9]*$`.
 */
function resolveHeartbeatDefault(env?: NodeJS.ProcessEnv): number {
  const raw = env?.HIVE_FLOW_HEARTBEAT_SECONDS;
  if (raw === undefined || raw === null || raw === '') return 5;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 5;
  return Math.floor(n);
}

/**
 * Parse the kill-grace period from `env.HIVE_FLOW_KILL_GRACE_SECONDS`.
 * The result is always a positive integer >= 1.
 *
 * Wave 11A.7: the bounded-grace kill path needs a configurable grace period.
 * Follows the same fork-bomb defence pattern as `resolveHeartbeatDefault`:
 * NaN, zero, negative, empty, and non-numeric values collapse to the default
 * (1 second). Non-integers are floored so `1.9` becomes `1`.
 */
export function parseKillGraceSeconds(env?: NodeJS.ProcessEnv): number {
  const raw = env?.HIVE_FLOW_KILL_GRACE_SECONDS;
  if (raw === undefined || raw === null || raw === '') return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

function assertAbsolutePosix(label: string, path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (!path.startsWith('/')) {
    throw new TypeError(`${label} must be an absolute POSIX path: ${JSON.stringify(path)}`);
  }
}

function assertNonEmptyString(label: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function validateRenderOpts(opts: WrapperRenderOptions): void {
  assertNonEmptyString('realCliBin', opts.realCliBin);
  assertNonEmptyString('hiveFlowCli', opts.hiveFlowCli);
  if (!isValidHostCli(opts.hostCli)) {
    throw new TypeError(
      `hostCli must be one of the valid HostCli values: ${JSON.stringify(opts.hostCli)}`,
    );
  }
  assertNoControlBytes('realCliBin', opts.realCliBin);
  assertNoControlBytes('hiveFlowCli', opts.hiveFlowCli);
}

// ---------------------------------------------------------------------------
// POSIX wrapper template
// ---------------------------------------------------------------------------

/**
 * Render the POSIX bash wrapper. The script:
 *
 *   1. `set -uo pipefail` (NO `set -e` — session-event emission failures must
 *      not abort the wrapper; the user is here for the real CLI, not the
 *      telemetry).
 *   2. Validates `HIVE_FLOW_HEARTBEAT_SECONDS` via a strict regex
 *      (`^[1-9][0-9]*$`). Invalid -> falls back to the rendered default
 *      (5s by default; configurable via `opts.env`).
 *   3. Best-effort `hiveFlowCli statusline session-start --host-cli X --pid $$`.
 *      All session events are run with `2>/dev/null || true` so a missing or
 *      crashing hive-flow CLI cannot break the wrapper.
 *   4. Spawns a background heartbeat loop that sends `session-heartbeat`
 *      every `heartbeat_seconds`. The loop exits when the wrapper's PID is
 *      no longer alive (`kill -0 $HIVE_FLOW_PID` returns false).
 *   5. Starts the real CLI in the BACKGROUND (`&`), captures its PID as
 *      `HIVE_FLOW_CHILD_PID`, then `wait`s for it. Because the child is
 *      backgrounded, INT/TERM traps fire promptly when the wrapper PID is
 *      signalled — bash would otherwise defer the trap until a foreground
 *      child exits naturally, delaying `session-end` and leaving the real
 *      CLI running.
 *   6. Installs `INT`/`TERM` traps that forward the signal to the child,
 *      wait for the child to finish (so the PID is reaped), emit one
 *      idempotent `session-end`, and exit with `128+signal` (130 / 143).
 *
 * Wave 11 fix — child instead of `exec`:
 *   The previous template used `exec "$HIVE_FLOW_REAL_CLI" "$@"` which
 *   replaced the wrapper shell with the real CLI. That meant the trap
 *   installed in step 6 NEVER fired on normal exit — the trap belonged to
 *   the shell process that no longer existed. Running the real CLI as a
 *   child fixed session-end emission on normal exit.
 *
 * Wave 11A.6 fix — background child + wait (POSIX direct-signal forwarding):
 *   Running the real CLI as a foreground child still had a deferred-trap
 *   edge: bash holds off on delivering INT/TERM traps while a foreground
 *   child is executing, so `kill -TERM <wrapper-pid>` while the child is
 *   running left the child alive and `session-end` undelivered until the
 *   child exited naturally. Moving to a background child (`&`) plus `wait`
 *   means the `wait` builtin returns as soon as a trapped signal fires,
 *   letting `hf_forward_signal` kill the child promptly, emit
 *   `session-end`, and exit 130 / 143 within milliseconds of the signal.
 *
 * The template avoids `set -e` deliberately (see Phase 5 bug-hunt note in the
 * runbook): with `set -e` enabled, any `|| true` chain that's needed for
 * defensive telemetry can mask its own pipeline failure on certain bash
 * versions. `set -u` is fine because every variable is initialized via
 * `:=` or explicit assignment before use.
 *
 * The realCliBin and hiveFlowCli paths are emitted via `shellQuote` so any
 * path containing spaces, apostrophes, semicolons, or other shell
 * metacharacters survives intact. An adversarial path like
 * `/opt/x; rm -rf /` is rendered as `'/opt/x; rm -rf /'`, which the shell
 * treats as a literal string.
 */
export function renderPosixWrapper(opts: WrapperRenderOptions): string {
  validateRenderOpts(opts);
  assertAbsolutePosix('realCliBin', opts.realCliBin);
  assertAbsolutePosix('hiveFlowCli', opts.hiveFlowCli);

  const heartbeatDefault = resolveHeartbeatDefault(opts.env);
  const killGraceDefault = parseKillGraceSeconds(opts.env);
  const realCli = shellQuote(opts.realCliBin);
  const hiveFlow = shellQuote(opts.hiveFlowCli);
  const hostCli = shellQuote(opts.hostCli);
  const heartbeatStr = String(heartbeatDefault);
  const killGraceStr = String(killGraceDefault);

  // The heredoc-style template below is constructed via interpolation so we
  // can guarantee no literal control bytes are in the source. Every
  // user-supplied string is shellQuote'd above.
  //
  // Note on `printf '%s'` + grep: we extract the env value safely, then run
  // it through a POSIX-extended regex anchored to positive integers. Any
  // other value collapses to the rendered default. This is the bash-side
  // mirror of `resolveHeartbeatDefault`.
  return [
    '#!/usr/bin/env bash',
    `# AUTO-GENERATED by hive-flow wrapper-driver (Wave 11). Do not edit by hand.`,
    `# Host CLI: ${opts.hostCli}`,
    `# Regenerate with: hive-flow setup --auto`,
    'set -uo pipefail',
    '',
    `HIVE_FLOW_HOSTCLI=${hostCli}`,
    `HIVE_FLOW_BIN=${hiveFlow}`,
    `HIVE_FLOW_REAL_CLI=${realCli}`,
    `HIVE_FLOW_PID=$$`,
    '',
    '# Wave 7.5 round-5: validate heartbeat env. Reject NaN, zero, negative,',
    '# and non-integer values so an attacker-controlled env cannot force a',
    '# fork-bomb-style sleep 0 loop. The regex admits only positive integers.',
    `heartbeat_seconds=$(printf '%s' "\${HIVE_FLOW_HEARTBEAT_SECONDS:-${heartbeatStr}}" | grep -E '^[1-9][0-9]*$' || echo ${heartbeatStr})`,
    '',
    '# Wave 11A.7: validate kill-grace period env. Same fork-bomb defence as',
    '# heartbeat: only positive integers pass; everything else falls back to',
    '# the rendered default (1 second = 5 × 0.2s polls).',
    `kill_grace_seconds=$(printf '%s' "\${HIVE_FLOW_KILL_GRACE_SECONDS:-${killGraceStr}}" | grep -E '^[1-9][0-9]*$' || echo ${killGraceStr})`,
    '',
    '# session-start: best-effort. The wrapper never fails because of a',
    '# missing hive-flow CLI or a transient recorder error.',
    `"$HIVE_FLOW_BIN" statusline session-start --host-cli "$HIVE_FLOW_HOSTCLI" --pid "$HIVE_FLOW_PID" 2>/dev/null || true`,
    '',
    '# Heartbeat loop. Runs in the background and exits when the wrapper PID',
    '# is no longer alive. `kill -0` is a no-op signal that checks liveness.',
    '(',
    '  while kill -0 "$HIVE_FLOW_PID" 2>/dev/null; do',
    '    sleep "$heartbeat_seconds"',
    `    "$HIVE_FLOW_BIN" statusline session-heartbeat --host-cli "$HIVE_FLOW_HOSTCLI" --pid "$HIVE_FLOW_PID" 2>/dev/null || true`,
    '  done',
    ') &',
    'HIVE_FLOW_HB_PID=$!',
    '',
    '# Tracks whether session-end was already emitted so a signal-trap path',
    '# and the normal-exit path do not double-emit. Mutated only inside the',
    '# wrapper shell; never exported.',
    'HIVE_FLOW_END_EMITTED=0',
    '',
    '# Shared cleanup: stop the heartbeat subshell, emit session-end',
    '# (best-effort), and mark end-emission so we never duplicate.',
    'hf_emit_session_end() {',
    '  local code="$1"',
    '  if [ "$HIVE_FLOW_END_EMITTED" = "0" ]; then',
    '    HIVE_FLOW_END_EMITTED=1',
    '    kill "$HIVE_FLOW_HB_PID" 2>/dev/null || true',
    '    wait "$HIVE_FLOW_HB_PID" 2>/dev/null || true',
    `    "$HIVE_FLOW_BIN" statusline session-end --host-cli "$HIVE_FLOW_HOSTCLI" --pid "$HIVE_FLOW_PID" --exit-code "$code" 2>/dev/null || true`,
    '  fi',
    '}',
    '',
    '# INT/TERM trap: a signal-killed wrapper still emits session-end with',
    '# the conventional 128+signal exit code, then exits with that code so',
    '# callers observe the underlying signal semantics. The trap is the only',
    '# way to capture signal-induced termination because the foreground child',
    '# run below does not return control on signal delivery to the shell.',
    'hf_on_int() {',
    '  hf_emit_session_end 130',
    '  exit 130',
    '}',
    'hf_on_term() {',
    '  hf_emit_session_end 143',
    '  exit 143',
    '}',
    'trap hf_on_int INT',
    'trap hf_on_term TERM',
    '',
    '# Wave 11A.6: run the real CLI in the BACKGROUND so that INT/TERM signals',
    '# delivered to the wrapper PID are handled promptly. bash defers traps',
    '# while a foreground child is running; backgrounding the child and',
    '# waiting via `wait` lets the trap fire as soon as the signal arrives.',
    '#',
    '# Wave 11A.7: `set -m` enables job control so the backgrounded child',
    '# gets its own process group (PGID = its PID). This lets the signal',
    '# escalation path send SIGKILL to the entire group — child plus any',
    '# grandchildren — via `kill -- -$PID`. Without job control the child',
    '# inherits the wrapper PGID and cannot be targeted as a group.',
    '# `set +m` restores default after capture to avoid side effects.',
    'set -m',
    '"$HIVE_FLOW_REAL_CLI" "$@" &',
    'HIVE_FLOW_CHILD_PID=$!',
    'set +m',
    '',
    '# Signal-forwarding handler. Forwards INT or TERM to the child, waits for',
    '# it to exit within a bounded grace window, force-kills if still alive,',
    '# emits one idempotent session-end, then exits with the conventional',
    '# 128+signal code.',
    '#',
    '# Wave 11A.7: the previous unbounded `wait "$HIVE_FLOW_CHILD_PID"` blocked',
    '# indefinitely when the real CLI trapped TERM/INT and ran its own slow',
    '# cleanup (e.g., npm/node waiting on a grandchild). The bounded poll',
    '# (200ms granularity) plus SIGKILL fallback ensures the wrapper exits',
    '# within grace_total+1 seconds even when the child ignores the signal.',
    '#',
    '# `sleep 0.2` is supported by GNU coreutils, BSD/macOS sleep, and busybox.',
    'hf_forward_signal() {',
    '  local sig="$1"',
    '  local exitcode="$2"',
    '  local grace_total="$kill_grace_seconds"',
    '  kill -"$sig" -- -"$HIVE_FLOW_CHILD_PID" 2>/dev/null \\',
    '    || kill -"$sig" "$HIVE_FLOW_CHILD_PID" 2>/dev/null || true',
    '  local i=0',
    '  local steps=$((grace_total * 5))',
    '  while [ "$i" -lt "$steps" ]; do',
    '    if ! kill -0 "$HIVE_FLOW_CHILD_PID" 2>/dev/null; then',
    '      break',
    '    fi',
    '    sleep 0.2',
    '    i=$((i + 1))',
    '  done',
    '  if kill -0 "$HIVE_FLOW_CHILD_PID" 2>/dev/null; then',
    '    # SIGKILL the entire process group (child + grandchildren).',
    '    # `set -m` above gave the child its own PGID, so `-$PID` targets',
    '    # the group without affecting the wrapper. Fall back to direct-PID',
    '    # kill if the group signal fails (e.g., child already reaped).',
    '    kill -KILL -- -"$HIVE_FLOW_CHILD_PID" 2>/dev/null \\',
    '      || kill -KILL "$HIVE_FLOW_CHILD_PID" 2>/dev/null || true',
    '    wait "$HIVE_FLOW_CHILD_PID" 2>/dev/null || true',
    '  fi',
    '  hf_emit_session_end "$exitcode"',
    '  exit "$exitcode"',
    '}',
    '',
    'trap \'hf_forward_signal INT 130\' INT',
    'trap \'hf_forward_signal TERM 143\' TERM',
    '',
    '# Foreground wait. Because the child is backgrounded, `wait` returns when',
    '# either (a) the child exits naturally, or (b) a trapped signal interrupts',
    '# the wait builtin. In case (b) the trap handler above takes over and',
    '# never returns here.',
    'wait "$HIVE_FLOW_CHILD_PID"',
    'HIVE_FLOW_EXIT=$?',
    '',
    '# Normal exit path. Emit session-end with the captured code, then exit',
    '# with the same code so callers observe the underlying CLI exit',
    '# unchanged.',
    'hf_emit_session_end "$HIVE_FLOW_EXIT"',
    'exit "$HIVE_FLOW_EXIT"',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Windows .cmd wrapper template
// ---------------------------------------------------------------------------

/**
 * Render the Windows `.cmd` wrapper.
 *
 * Wave 7.5 round-5 lesson: a pure CMD batch heartbeat is brittle — CMD lacks
 * a clean `sleep`, PowerShell pipes stdin via the host, and writing an
 * in-process `setInterval` via Node sidesteps both issues. The `.cmd` here
 * simply launches:
 *
 *   node "<hiveFlowCli>" statusline wrapper-host <hostCli> -- "<realCliBin>" %*
 *
 * `%*` is CMD's "all arguments" expansion. The Node-based `wrapper-host`
 * subcommand (lives in the hive-flow CLI; spawning + heartbeat + session
 * event emission all happen inside Node) then runs the real CLI as a child
 * process, validates the heartbeat interval with `Number.isFinite` + `>= 1`
 * floor, and forwards the child exit code via `process.exit`.
 *
 * Why a Node entrypoint instead of inline CMD logic? CMD's `start /B` doesn't
 * propagate exit codes reliably, and PowerShell `-NoProfile -Command` is
 * slower to spawn and surfaces stdin race conditions documented in Wave 7.5.
 * Centralizing the logic in Node also means the same heartbeat code runs on
 * both platforms — only the script "shim" differs.
 *
 * The rendered `.cmd` does NOT do its own heartbeat — that's the Node
 * subcommand's responsibility. If you change the subcommand name, update
 * the bash template, this template, and the `statusline` command surface
 * together so they stay in sync.
 */
export function renderWindowsWrapper(opts: WrapperRenderOptions): string {
  validateRenderOpts(opts);
  // We intentionally do NOT require absolute POSIX paths on Windows because
  // a Windows path is `C:\...`. We DO require non-empty + no control bytes
  // (already checked by `validateRenderOpts`), and we additionally reject
  // `%` in the path because CMD would expand it.
  if (opts.realCliBin.includes('%') || opts.hiveFlowCli.includes('%')) {
    throw new Error('Windows wrapper: realCliBin / hiveFlowCli must not contain "%"');
  }

  const heartbeatDefault = resolveHeartbeatDefault(opts.env);
  const realCli = cmdQuote(opts.realCliBin);
  const hiveFlow = cmdQuote(opts.hiveFlowCli);
  const hostCli = cmdQuote(opts.hostCli);
  const heartbeatStr = String(heartbeatDefault);

  // The Node entrypoint reads HIVE_FLOW_HEARTBEAT_SECONDS from the
  // environment at runtime and applies the same Number.isFinite + >= 1
  // floor as `resolveHeartbeatDefault`. We bake the default in as a CLI
  // flag so the wrapper-host subcommand can fall back to it without
  // re-implementing the env probe.
  //
  // CRLF line endings are CMD's documented convention. Mixed LF can confuse
  // older CMD interpreters when the file is created on POSIX.
  return [
    '@ECHO OFF',
    `REM AUTO-GENERATED by hive-flow wrapper-driver (Wave 11). Do not edit by hand.`,
    `REM Host CLI: ${opts.hostCli}`,
    `REM Regenerate with: hive-flow setup --auto`,
    'SETLOCAL',
    '',
    'REM Wave 7.5 round-5: heartbeat is validated inside the Node entrypoint',
    'REM via Number.isFinite + >= 1 floor. The CLI flag below is the default',
    'REM if HIVE_FLOW_HEARTBEAT_SECONDS is unset or invalid.',
    `node ${hiveFlow} statusline wrapper-host ${hostCli} --heartbeat-default ${heartbeatStr} -- ${realCli} %*`,
    'SET EXITCODE=%ERRORLEVEL%',
    'ENDLOCAL & EXIT /B %EXITCODE%',
    '',
  ].join('\r\n');
}

// ---------------------------------------------------------------------------
// writeWrapper
// ---------------------------------------------------------------------------

/**
 * Resolve which wrapper template to use. Falls back to POSIX everywhere
 * except Windows. The decision is intentionally `process.platform`-driven
 * (not `path.sep`) so a test on POSIX can still render the Windows variant
 * via the dedicated `renderWindowsWrapper` function.
 */
function pickRenderer(): (opts: WrapperRenderOptions) => string {
  return process.platform === 'win32' ? renderWindowsWrapper : renderPosixWrapper;
}

/**
 * Write a wrapper script to `destPath`. The parent directory is created via
 * `ensureSafeUserCacheDir` (Wave 8.4) which walks every segment from
 * `baseDir` to `destPath` and rejects any symlinked intermediate. The body
 * is written atomically (`atomicWrite` -> tmp + rename) so a partial write
 * never produces a half-written script.
 *
 * On POSIX the file is chmod'd to `0o755` (rwxr-xr-x) so the host CLI can
 * actually exec it. On Windows file permissions are not relevant — the
 * file extension (`.cmd`) selects the interpreter.
 *
 * The function is idempotent: if the destination file already exists with
 * identical content, the body write is still performed (via atomicWrite's
 * tmp+rename, which is cheap) but no harm is done. We do not short-circuit
 * because the chmod step is the canonical permission fix and skipping it
 * could leave a non-executable file behind from a prior run.
 */
export async function writeWrapper(opts: WriteWrapperOptions): Promise<void> {
  validateRenderOpts(opts);
  assertNonEmptyString('destPath', opts.destPath);
  assertNonEmptyString('baseDir', opts.baseDir);

  const renderer = pickRenderer();
  const content = renderer(opts);

  // Symlink-rejecting parent walk. `ensureSafeUserCacheDir` requires the
  // destination's parent (not the file itself) to lie inside `baseDir`.
  await ensureSafeUserCacheDir(dirname(opts.destPath), opts.baseDir);

  // Atomic write. We pick mode 0o755 up front so a *newly* created file
  // lands at the right mode; chmod after rename covers the case where the
  // file already existed (with a different mode) and atomicWrite preserved
  // it.
  const mode = process.platform === 'win32' ? 0o644 : 0o755;
  await atomicWrite(opts.destPath, content, { mode });

  if (process.platform !== 'win32') {
    await chmod(opts.destPath, 0o755);
  }
}
