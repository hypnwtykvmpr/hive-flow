// cli/src/commands/__tests__/statusline-wrapper-host.test.ts
//
// Behavioural tests for `hive-flow statusline wrapper-host` (Wave 11A.2).
// Covers:
//   - argv parsing (happy path, invalid hostCli, missing `--`, missing
//     realCliBin, NaN heartbeat, --heartbeat-default=N form)
//   - heartbeat env-var validation (Wave 7.5 round-5 fork-bomb defence)
//   - happy-path: child exits 0 -> wrapper returns 0; session-start +
//     session-end emitted
//   - non-zero exit propagation (child exits 42 -> wrapper returns 42;
//     session-end has exit-code 42)
//   - heartbeat interval fires under fake timers
//   - SIGINT / SIGTERM trap forwards to the child and session-end has
//     reason='signal'
//   - recorder failures do NOT crash the wrapper (best-effort emission)
//   - static-audit: source file contains no `shell: true`
//   - dispatcher registration: wrapper-host is a hidden subcommand of
//     statusline; the top-level statusline command remains usable.

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseHeartbeatSeconds,
  parseWrapperHostArgv,
  runWrapperHost,
  statuslineCommand,
  wrapperHostSubcommand,
  WrapperHostArgvError,
  type RunWrapperHostDeps,
  type SessionRecorder,
} from '../statusline.js';
import type { SessionEventV1 } from '../../statusline/types.js';

function expectedSessionKey(clientKind: string, sessionId: string): string {
  return `s_${createHash('sha256').update(`${clientKind}\0${sessionId}`).digest('hex').slice(0, 32)}`;
}

function expectedProjectKey(root: string): string {
  return createHash('sha256').update(root).digest('hex');
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Tiny fake child-process. Inherits EventEmitter so consumers can call
 * `.once('exit', ...)` / `.once('error', ...)` exactly like a real
 * ChildProcess. `kill` records the signal so signal-forwarding tests can
 * assert on it without involving the real Node process.
 */
class FakeChild extends EventEmitter {
  public readonly killCalls: NodeJS.Signals[] = [];
  // `as any` is forbidden in source per the bug-hunt rule; in tests we lean
  // on the spawn fn returning `unknown` and accept the local cast inside
  // helpers, but we type-erase via casts only at the test boundary.
  kill(signal?: NodeJS.Signals | number): boolean {
    if (typeof signal === 'string') this.killCalls.push(signal);
    return true;
  }
  /** Simulate the real CLI exiting with `code`. */
  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
  /** Simulate spawn-time error (e.g. ENOENT). */
  emitError(err: Error): void {
    this.emit('error', err);
  }
}

interface SpawnRecord {
  command: string;
  args: readonly string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any;
}

/**
 * Build a stub `spawnFn` that records its arguments and returns a FakeChild.
 * The returned object exposes the `child` so the test can drive its lifecycle.
 */
function makeSpawnStub(opts: { throwOn?: string } = {}): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spawnFn: any;
  calls: SpawnRecord[];
  child: FakeChild;
} {
  const child = new FakeChild();
  const calls: SpawnRecord[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spawnFn: any = (command: string, args: readonly string[], options: any) => {
    calls.push({ command, args, options });
    if (opts.throwOn && command === opts.throwOn) {
      throw new Error(`spawn ENOENT for ${command}`);
    }
    return child;
  };
  return { spawnFn, calls, child };
}

/** Recorder stub that captures every event for assertion. */
function makeRecorder(): {
  recorder: SessionRecorder;
  events: SessionEventV1[];
} {
  const events: SessionEventV1[] = [];
  const recorder: SessionRecorder = async (event) => {
    events.push(event);
    return { ok: true, spooled: false, duplicate: false };
  };
  return { recorder, events };
}

interface CapturedSignalTrap {
  signals: readonly NodeJS.Signals[];
  fire: (sig: NodeJS.Signals) => void;
  released: boolean;
}

function makeSignalCapture(): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onSignal: any;
  captured: CapturedSignalTrap[];
} {
  const captured: CapturedSignalTrap[] = [];
  const onSignal = (
    signals: readonly NodeJS.Signals[],
    handler: (sig: NodeJS.Signals) => void,
  ): (() => void) => {
    const trap: CapturedSignalTrap = {
      signals,
      fire: (sig) => handler(sig),
      released: false,
    };
    captured.push(trap);
    return () => {
      trap.released = true;
    };
  };
  return { onSignal, captured };
}

interface CapturedInterval {
  cb: () => void;
  ms: number;
  cleared: boolean;
  handle: NodeJS.Timeout;
}

function makeIntervalCapture(): {
  setIntervalFn: RunWrapperHostDeps['setIntervalFn'];
  clearIntervalFn: RunWrapperHostDeps['clearIntervalFn'];
  captured: CapturedInterval[];
} {
  const captured: CapturedInterval[] = [];
  let nextId = 1;
  const setIntervalFn: RunWrapperHostDeps['setIntervalFn'] = (cb, ms) => {
    const handle = nextId++ as unknown as NodeJS.Timeout;
    captured.push({ cb, ms, cleared: false, handle });
    return handle;
  };
  const clearIntervalFn: RunWrapperHostDeps['clearIntervalFn'] = (handle) => {
    const entry = captured.find((c) => c.handle === handle);
    if (entry) entry.cleared = true;
  };
  return { setIntervalFn, clearIntervalFn, captured };
}

/**
 * Flush N microtasks. Each `await Promise.resolve()` lets pending continuations
 * run. `runWrapperHost` chains a few awaits (session-start recorder, spawn,
 * `new Promise` constructor) before its `.once('error'/'exit')` listeners are
 * attached, so we need a small bounded number of flushes to drain those
 * boundaries deterministically.
 */
async function flushMicrotasks(n: number = 5): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

/** Collect stderr writes for assertion. */
function makeStderr(): { stream: NodeJS.WritableStream; buffer: string[] } {
  const buffer: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream: any = {
    write(chunk: string | Uint8Array): boolean {
      buffer.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    },
  };
  return { stream, buffer };
}

interface BuildDepsOptions {
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  spawn?: ReturnType<typeof makeSpawnStub>;
  recorder?: ReturnType<typeof makeRecorder>;
  signal?: ReturnType<typeof makeSignalCapture>;
  interval?: ReturnType<typeof makeIntervalCapture>;
  stderr?: ReturnType<typeof makeStderr>;
}

function buildDeps(opts: BuildDepsOptions): {
  deps: RunWrapperHostDeps;
  spawn: ReturnType<typeof makeSpawnStub>;
  recorder: ReturnType<typeof makeRecorder>;
  signal: ReturnType<typeof makeSignalCapture>;
  interval: ReturnType<typeof makeIntervalCapture>;
  stderr: ReturnType<typeof makeStderr>;
} {
  const spawn = opts.spawn ?? makeSpawnStub();
  const recorder = opts.recorder ?? makeRecorder();
  const signal = opts.signal ?? makeSignalCapture();
  const interval = opts.interval ?? makeIntervalCapture();
  const stderr = opts.stderr ?? makeStderr();
  const deps: RunWrapperHostDeps = {
    argv: opts.argv,
    env: opts.env ?? {},
    cwd: '/tmp/test-root',
    pid: 12345,
    spawnFn: spawn.spawnFn,
    recorder: recorder.recorder,
    setIntervalFn: interval.setIntervalFn,
    clearIntervalFn: interval.clearIntervalFn,
    onSignal: signal.onSignal,
    stderr: stderr.stream,
  };
  return { deps, spawn, recorder, signal, interval, stderr };
}

// ---------------------------------------------------------------------------
// parseHeartbeatSeconds
// ---------------------------------------------------------------------------

describe('parseHeartbeatSeconds (Wave 7.5 round-5 fork-bomb defence)', () => {
  it('accepts a positive integer string', () => {
    expect(parseHeartbeatSeconds('10', 5)).toBe(10);
  });

  it('floors fractional values to a positive integer', () => {
    expect(parseHeartbeatSeconds('2.9', 5)).toBe(2);
  });

  it('falls back when value is NaN', () => {
    expect(parseHeartbeatSeconds('not a number', 5)).toBe(5);
  });

  it('falls back when value is zero', () => {
    expect(parseHeartbeatSeconds('0', 5)).toBe(5);
  });

  it('falls back when value is negative', () => {
    expect(parseHeartbeatSeconds('-1', 5)).toBe(5);
  });

  it('falls back when value is infinity', () => {
    expect(parseHeartbeatSeconds('Infinity', 5)).toBe(5);
  });

  it('falls back when value is an empty string', () => {
    expect(parseHeartbeatSeconds('', 7)).toBe(7);
  });

  it('falls back when value is undefined', () => {
    expect(parseHeartbeatSeconds(undefined, 5)).toBe(5);
  });

  it('falls back when value is fractional below 1', () => {
    expect(parseHeartbeatSeconds('0.5', 5)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// parseWrapperHostArgv
// ---------------------------------------------------------------------------

describe('parseWrapperHostArgv', () => {
  it('parses a happy-path argv', () => {
    const parsed = parseWrapperHostArgv([
      'codex',
      '--heartbeat-default',
      '7',
      '--',
      '/opt/codex/bin/codex',
      'chat',
      '--turn-limit',
      '3',
    ]);
    expect(parsed.hostCli).toBe('codex');
    expect(parsed.heartbeatDefault).toBe(7);
    expect(parsed.realCliBin).toBe('/opt/codex/bin/codex');
    expect(parsed.realCliArgs).toEqual(['chat', '--turn-limit', '3']);
  });

  it('parses --heartbeat-default=N form', () => {
    const parsed = parseWrapperHostArgv([
      'gemini',
      '--heartbeat-default=12',
      '--',
      '/bin/gemini',
    ]);
    expect(parsed.heartbeatDefault).toBe(12);
  });

  it('defaults heartbeat-default to 5 when flag is absent', () => {
    const parsed = parseWrapperHostArgv(['cursor-cli', '--', '/bin/cursor']);
    expect(parsed.heartbeatDefault).toBe(5);
  });

  it('rejects an invalid hostCli', () => {
    expect(() =>
      parseWrapperHostArgv(['rogue-cli', '--', '/bin/r']),
    ).toThrow(WrapperHostArgvError);
    expect(() =>
      parseWrapperHostArgv(['rogue-cli', '--', '/bin/r']),
    ).toThrow(/invalid hostCli/);
  });

  it('rejects a missing "--" separator', () => {
    expect(() => parseWrapperHostArgv(['codex', '/opt/codex'])).toThrow(
      /unexpected token "\/opt\/codex" before "--"/,
    );
  });

  it('rejects missing realCliBin after "--"', () => {
    expect(() => parseWrapperHostArgv(['codex', '--'])).toThrow(
      /missing <realCliBin> after "--"/,
    );
  });

  it('rejects --heartbeat-default with NaN value', () => {
    expect(() =>
      parseWrapperHostArgv(['codex', '--heartbeat-default', 'banana', '--', '/bin/c']),
    ).toThrow(/--heartbeat-default must be a positive integer/);
  });

  it('rejects --heartbeat-default with zero', () => {
    expect(() =>
      parseWrapperHostArgv(['codex', '--heartbeat-default', '0', '--', '/bin/c']),
    ).toThrow(/--heartbeat-default must be a positive integer/);
  });

  it('rejects --heartbeat-default with negative value', () => {
    expect(() =>
      parseWrapperHostArgv(['codex', '--heartbeat-default', '-3', '--', '/bin/c']),
    ).toThrow(/--heartbeat-default must be a positive integer/);
  });

  it('rejects --heartbeat-default with no value', () => {
    expect(() =>
      parseWrapperHostArgv(['codex', '--heartbeat-default']),
    ).toThrow(/--heartbeat-default requires a value/);
  });

  it('rejects an empty argv', () => {
    expect(() => parseWrapperHostArgv([])).toThrow(/missing <hostCli>/);
  });

  it('preserves flag-shaped tokens in the real CLI args (after "--")', () => {
    const parsed = parseWrapperHostArgv([
      'codex',
      '--',
      '/bin/codex',
      '--look',
      '-x',
      '--like-flags',
    ]);
    expect(parsed.realCliArgs).toEqual(['--look', '-x', '--like-flags']);
  });
});

// ---------------------------------------------------------------------------
// runWrapperHost — happy path & exit-code propagation
// ---------------------------------------------------------------------------

describe('runWrapperHost — happy path', () => {
  it('child exit 0 → wrapper exit 0; session-start + session-end emitted', async () => {
    const { deps, spawn, recorder, interval } = buildDeps({
      argv: ['codex', '--heartbeat-default', '5', '--', '/opt/codex/bin/codex', 'chat'],
    });

    const promise = runWrapperHost(deps);
    // Wait a microtask so session-start has emitted before we exit the child.
    await flushMicrotasks(5);
    spawn.child.emitExit(0);
    const result = await promise;

    expect(result.exitCode).toBe(0);

    // Spawn was called with argv array, NO shell, stdio inherited.
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0]?.command).toBe('/opt/codex/bin/codex');
    expect(spawn.calls[0]?.args).toEqual(['chat']);
    expect(spawn.calls[0]?.options).toMatchObject({ stdio: 'inherit' });
    expect(spawn.calls[0]?.options).not.toHaveProperty('shell');

    // Sessions: a session-start, then a session-end with exitCode 0.
    const startEvent = recorder.events.find((e) => e.event === 'session-start');
    const endEvent = recorder.events.find((e) => e.event === 'session-end');
    expect(startEvent).toBeDefined();
    expect(startEvent?.hostCli).toBe('codex');
    expect(startEvent?.producerKind).toBe('wrapper');
    expect(startEvent?.sessionIdSource).toBe('wrapper');
    expect(startEvent?.confidence).toBe('direct');
    expect(startEvent?.pid).toBe(12345);
    expect(endEvent).toBeDefined();
    expect(endEvent?.exitCode).toBe(0);
    expect(endEvent?.reason).toBe('normal-exit');
    // Both events share the same sessionId.
    expect(endEvent?.sessionId).toBe(startEvent?.sessionId);

    // Interval was created and cleared.
    expect(interval.captured).toHaveLength(1);
    expect(interval.captured[0]?.cleared).toBe(true);
  });

  it('uses explicit project root and shared session key instead of launch cwd', async () => {
    const explicitProjectRoot = '/Users/test/work/project-one';
    const launchCwd = '/private/tmp/outside-project';
    const env = {
      HIVE_FLOW_PROJECT_ROOT: explicitProjectRoot,
      HIVE_FLOW_SESSION_ID: 'interactive-session-1',
      HIVE_FLOW_CLIENT_KIND: 'codex',
    };
    const { deps, spawn, recorder } = buildDeps({
      argv: ['codex', '--', '/opt/codex/bin/codex'],
      env,
    });
    const scopedDeps: RunWrapperHostDeps = {
      ...deps,
      cwd: launchCwd,
    };

    const promise = runWrapperHost(scopedDeps);
    await flushMicrotasks(5);
    spawn.child.emitExit(0);
    await promise;

    const startEvent = recorder.events.find((e) => e.event === 'session-start');
    expect(startEvent).toBeDefined();
    expect(startEvent?.repoRoot).toBe(explicitProjectRoot);
    expect(startEvent?.projectKey).toBe(expectedProjectKey(explicitProjectRoot));
    expect(startEvent?.sessionId).toBe(expectedSessionKey('codex', 'interactive-session-1'));
  });

  it('does not derive wrapper session identity from TMUX_PANE', async () => {
    const env = {
      TMUX_PANE: '%7',
    };
    const { deps, spawn, recorder } = buildDeps({
      argv: ['codex', '--', '/opt/codex/bin/codex'],
      env,
    });

    const promise = runWrapperHost(deps);
    await flushMicrotasks(5);
    spawn.child.emitExit(0);
    await promise;

    const startEvent = recorder.events.find((e) => e.event === 'session-start');
    expect(startEvent).toBeDefined();
    expect(startEvent?.sessionId).toBe(expectedSessionKey('codex', 'pid:12345'));
  });

  it('child exit 42 → wrapper exit 42; session-end carries exitCode 42', async () => {
    const { deps, spawn, recorder } = buildDeps({
      argv: ['gemini', '--', '/bin/gemini'],
    });

    const promise = runWrapperHost(deps);
    await flushMicrotasks(5);
    spawn.child.emitExit(42);
    const result = await promise;

    expect(result.exitCode).toBe(42);
    const endEvent = recorder.events.find((e) => e.event === 'session-end');
    expect(endEvent?.exitCode).toBe(42);
    expect(endEvent?.reason).toBe('normal-exit');
  });

  it('child error event → wrapper exit 1', async () => {
    const { deps, spawn, recorder, stderr } = buildDeps({
      argv: ['codex', '--', '/bin/codex'],
    });
    const promise = runWrapperHost(deps);
    // Flush enough microtasks so session-start has emitted, spawn has been
    // called, and the `.once('error', ...)` listener is attached before we
    // fire the synthetic error event on the FakeChild.
    await flushMicrotasks(5);
    spawn.child.emitError(new Error('child crashed'));
    const result = await promise;
    expect(result.exitCode).toBe(1);
    // stderr should mention the child runtime error.
    expect(stderr.buffer.join('')).toContain('child runtime error');
    // session-end should still be emitted.
    expect(recorder.events.some((e) => e.event === 'session-end')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runWrapperHost — argv errors
// ---------------------------------------------------------------------------

describe('runWrapperHost — argv errors', () => {
  it('invalid hostCli → exit 2, no spawn, no session events', async () => {
    const { deps, spawn, recorder, stderr } = buildDeps({
      argv: ['rogue-cli', '--', '/bin/r'],
    });
    const result = await runWrapperHost(deps);
    expect(result.exitCode).toBe(2);
    expect(spawn.calls).toHaveLength(0);
    expect(recorder.events).toHaveLength(0);
    expect(stderr.buffer.join('')).toMatch(/invalid hostCli/);
  });

  it('missing "--" → exit 2', async () => {
    const { deps } = buildDeps({ argv: ['codex', '/opt/codex'] });
    const result = await runWrapperHost(deps);
    expect(result.exitCode).toBe(2);
  });

  it('NaN heartbeat-default CLI flag → exit 2 (fork-bomb defence)', async () => {
    const { deps } = buildDeps({
      argv: ['codex', '--heartbeat-default', 'NaN', '--', '/bin/c'],
    });
    const result = await runWrapperHost(deps);
    expect(result.exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// runWrapperHost — heartbeat
// ---------------------------------------------------------------------------

describe('runWrapperHost — heartbeat', () => {
  it('emits session-heartbeat each time the interval fires', async () => {
    const { deps, spawn, recorder, interval } = buildDeps({
      argv: ['codex', '--heartbeat-default', '5', '--', '/bin/c'],
    });

    const promise = runWrapperHost(deps);
    // Let session-start emit.
    await flushMicrotasks(5);

    // Manually fire the captured interval callback twice.
    expect(interval.captured).toHaveLength(1);
    interval.captured[0]?.cb();
    interval.captured[0]?.cb();
    // Microtask flush so the fire-and-forget recorder calls run.
    await flushMicrotasks(5);

    spawn.child.emitExit(0);
    const result = await promise;

    expect(result.heartbeatsFired).toBe(2);
    const heartbeats = recorder.events.filter((e) => e.event === 'session-heartbeat');
    expect(heartbeats).toHaveLength(2);
    for (const beat of heartbeats) {
      expect(beat.hostCli).toBe('codex');
      expect(beat.producerKind).toBe('wrapper');
    }
  });

  it('honors HIVE_FLOW_HEARTBEAT_SECONDS env over --heartbeat-default', async () => {
    const { deps, spawn, interval } = buildDeps({
      argv: ['codex', '--heartbeat-default', '5', '--', '/bin/c'],
      env: { HIVE_FLOW_HEARTBEAT_SECONDS: '20' },
    });
    const promise = runWrapperHost(deps);
    await flushMicrotasks(5);
    spawn.child.emitExit(0);
    await promise;
    // 20s * 1000ms = 20000ms.
    expect(interval.captured[0]?.ms).toBe(20_000);
  });

  it('falls back when HIVE_FLOW_HEARTBEAT_SECONDS is invalid (no fork-bomb)', async () => {
    const { deps, spawn, interval } = buildDeps({
      argv: ['codex', '--heartbeat-default', '5', '--', '/bin/c'],
      env: { HIVE_FLOW_HEARTBEAT_SECONDS: 'not a number' },
    });
    const promise = runWrapperHost(deps);
    await flushMicrotasks(5);
    spawn.child.emitExit(0);
    await promise;
    // Falls back to --heartbeat-default (5s = 5000ms). NEVER 0ms or <1000ms.
    expect(interval.captured[0]?.ms).toBe(5_000);
    expect(interval.captured[0]?.ms).toBeGreaterThanOrEqual(1_000);
  });

  it('falls back when HIVE_FLOW_HEARTBEAT_SECONDS is zero', async () => {
    const { deps, spawn, interval } = buildDeps({
      argv: ['codex', '--heartbeat-default', '5', '--', '/bin/c'],
      env: { HIVE_FLOW_HEARTBEAT_SECONDS: '0' },
    });
    const promise = runWrapperHost(deps);
    await flushMicrotasks(5);
    spawn.child.emitExit(0);
    await promise;
    expect(interval.captured[0]?.ms).toBe(5_000);
  });

  it('clears the interval before resolving (no leak)', async () => {
    const { deps, spawn, interval } = buildDeps({
      argv: ['codex', '--', '/bin/c'],
    });
    const promise = runWrapperHost(deps);
    await flushMicrotasks(5);
    spawn.child.emitExit(0);
    await promise;
    expect(interval.captured[0]?.cleared).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runWrapperHost — signal forwarding
// ---------------------------------------------------------------------------

describe('runWrapperHost — signal trap', () => {
  it('SIGINT forwards to child and session-end carries reason="signal"', async () => {
    const { deps, spawn, recorder, signal } = buildDeps({
      argv: ['codex', '--', '/bin/c'],
    });
    const promise = runWrapperHost(deps);
    await flushMicrotasks(5);

    // Fire SIGINT through the captured trap (simulates Ctrl-C).
    expect(signal.captured).toHaveLength(1);
    expect(signal.captured[0]?.signals).toEqual(['SIGINT', 'SIGTERM']);
    signal.captured[0]?.fire('SIGINT');

    // Child received the kill.
    expect(spawn.child.killCalls).toContain('SIGINT');
    // Now simulate the child terminating in response.
    spawn.child.emitExit(null, 'SIGINT');

    const result = await promise;
    // Conventional shell exit code: 128 + 2 = 130 for SIGINT.
    expect(result.exitCode).toBe(130);

    const endEvent = recorder.events.find((e) => e.event === 'session-end');
    expect(endEvent?.reason).toBe('signal');
    expect(endEvent?.exitCode).toBe(130);
    // Signal trap was released.
    expect(signal.captured[0]?.released).toBe(true);
  });

  it('SIGTERM forwards to child and session-end emitted', async () => {
    const { deps, spawn, recorder, signal } = buildDeps({
      argv: ['codex', '--', '/bin/c'],
    });
    const promise = runWrapperHost(deps);
    await flushMicrotasks(5);

    signal.captured[0]?.fire('SIGTERM');
    expect(spawn.child.killCalls).toContain('SIGTERM');
    spawn.child.emitExit(null, 'SIGTERM');

    const result = await promise;
    expect(result.exitCode).toBe(143);

    const endEvent = recorder.events.find((e) => e.event === 'session-end');
    expect(endEvent?.reason).toBe('signal');
    expect(endEvent?.exitCode).toBe(143);
  });

  it('external SIGKILL (untrapped) → reason="signal", session-end still emitted', async () => {
    const { deps, spawn, recorder } = buildDeps({
      argv: ['codex', '--', '/bin/c'],
    });
    const promise = runWrapperHost(deps);
    await flushMicrotasks(5);

    // Simulate external kill: child exits with signal but no handler fired.
    spawn.child.emitExit(null, 'SIGKILL');
    const result = await promise;
    expect(result.exitCode).toBe(1);
    const endEvent = recorder.events.find((e) => e.event === 'session-end');
    expect(endEvent?.reason).toBe('signal');
  });
});

// ---------------------------------------------------------------------------
// runWrapperHost — recorder resilience
// ---------------------------------------------------------------------------

describe('runWrapperHost — recorder failures are non-fatal', () => {
  it('throwing recorder does not crash the wrapper; logs to stderr', async () => {
    const recorder: SessionRecorder = async () => {
      throw new Error('disk full');
    };
    const { deps, spawn, stderr } = buildDeps({
      argv: ['codex', '--', '/bin/c'],
      recorder: { recorder, events: [] },
    });
    const promise = runWrapperHost(deps);
    await flushMicrotasks(5);
    spawn.child.emitExit(0);
    const result = await promise;
    // Wrapper still returns the child's exit code (0), telemetry failures are
    // diagnostic only.
    expect(result.exitCode).toBe(0);
    const joined = stderr.buffer.join('');
    expect(joined).toContain('session-event emission failed');
    expect(joined).toContain('disk full');
  });
});

// ---------------------------------------------------------------------------
// runWrapperHost — spawn failures
// ---------------------------------------------------------------------------

describe('runWrapperHost — spawn failures', () => {
  it('spawn throwing → exit 127; session-end emitted with reason="unknown"', async () => {
    const spawn = makeSpawnStub({ throwOn: '/missing/bin' });
    const { deps, recorder, stderr } = buildDeps({
      argv: ['codex', '--', '/missing/bin'],
      spawn,
    });
    const result = await runWrapperHost(deps);
    expect(result.exitCode).toBe(127);
    const endEvent = recorder.events.find((e) => e.event === 'session-end');
    expect(endEvent).toBeDefined();
    expect(endEvent?.exitCode).toBe(127);
    expect(endEvent?.reason).toBe('unknown');
    expect(stderr.buffer.join('')).toMatch(/failed to spawn/);
  });
});

// ---------------------------------------------------------------------------
// Static audit: source contains no `shell: true`
// ---------------------------------------------------------------------------

describe('source-level safety audit', () => {
  it('statusline.ts does not call spawn with shell: true (code lines only)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // From `src/commands/__tests__/`, the source lives at
    // `src/commands/statusline.ts`.
    const src = readFileSync(join(here, '..', 'statusline.ts'), 'utf8');

    // Strip line comments and block comments so the audit only inspects
    // executable code. The runbook permits `NO shell: true` text in source
    // comments (in fact requires it for the bug-hunt audit trail), but bans
    // it in actual spawn call sites.
    const stripped = src
      // Remove block comments first (greedy is fine — we don't nest).
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // Then remove line comments. `//` may legitimately appear inside
      // strings, but our source uses only single-quoted strings, so this
      // line-comment strip is safe for this audit.
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

    expect(stripped).not.toMatch(/shell\s*:\s*true/);
    // Also forbid spawnSync (we need async lifecycle handling).
    expect(stripped).not.toContain('spawnSync');
    // No literal control bytes in the source (bug-hunt rule).
    // eslint-disable-next-line no-control-regex
    expect(src).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
    // No TODO/FIXME/HACK/XXX comments left behind.
    expect(src).not.toMatch(/\bTODO\b|\bFIXME\b|\bHACK\b|\bXXX\b/);
    // No `as any` casts.
    expect(stripped).not.toMatch(/\bas\s+any\b/);
  });

  it('statusline.ts contains no `as HostCli` casts (VALID_HOST_CLIS widened to ReadonlySet<string>)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'statusline.ts'), 'utf8');
    // Strip block comments and line comments so docstring mentions of the
    // design decision do not trigger the audit. Mirrors the exclude-comments
    // approach in `wrapper-driver source audit` (wrapper-driver.test.ts).
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(stripped).not.toMatch(/\bas\s+HostCli\b/);
  });
});

// ---------------------------------------------------------------------------
// Dispatcher registration
// ---------------------------------------------------------------------------

describe('command registration', () => {
  it('wrapper-host is registered as a hidden subcommand of statusline', () => {
    expect(statuslineCommand.subcommands?.map((s) => s.name)).toContain('wrapper-host');
    const sub = statuslineCommand.subcommands?.find((s) => s.name === 'wrapper-host');
    expect(sub).toBe(wrapperHostSubcommand);
    expect(sub?.hidden).toBe(true);
  });

  it('the subcommand exposes the --heartbeat-default option', () => {
    const opt = wrapperHostSubcommand.options?.find((o) => o.name === 'heartbeat-default');
    expect(opt).toBeDefined();
    expect(opt?.type).toBe('number');
    expect(opt?.default).toBe(5);
  });

  it('the top-level statusline command still has its action and base options', () => {
    expect(statuslineCommand.name).toBe('statusline');
    expect(statuslineCommand.action).toBeDefined();
    expect(statuslineCommand.options?.map((o) => o.name)).toEqual(
      expect.arrayContaining(['agent', 'json']),
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: ensure stderr & stdout aren't polluted in CI test runs.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});
