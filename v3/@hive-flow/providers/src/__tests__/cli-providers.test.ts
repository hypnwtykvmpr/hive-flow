import { describe, it, expect, vi, beforeEach, afterEach, type MockedFunction } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';

// Mock child_process before importing providers
vi.mock('child_process', () => {
  return {
    spawn: vi.fn(),
    execFile: vi.fn(),
  };
});

import { spawn, execFile } from 'child_process';
import { GeminiCLIProvider } from '../gemini-cli-provider.js';
import { CodexCLIProvider } from '../codex-cli-provider.js';
import { CursorCLIProvider } from '../cursor-cli-provider.js';
import type { LLMModel, LLMStreamEvent } from '../types.js';

// Typed mock aliases — eliminates `as any` on mock method access
// SAFETY: spawn/execFile are vi.mock'd above; the mock returns our mock child, not real ChildProcess
const mockSpawn = spawn as unknown as MockedFunction<(...args: Parameters<typeof spawn>) => MockChildProcess | MockPassThroughChild>;
const mockExecFile = execFile as MockedFunction<typeof execFile>;

/**
 * Helper to access private members of CLI providers in tests.
 * SAFETY: Tests need to exercise private methods (formatMessages, spawnCursor, etc.)
 * that are not exposed on the public API.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrivateAccess = any;

/** Mock stdout shape needed by readline.createInterface */
interface MockStdout extends EventEmitter {
  resume: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  pipe: ReturnType<typeof vi.fn>;
  setEncoding: ReturnType<typeof vi.fn>;
  isPaused: ReturnType<typeof vi.fn>;
  unpipe: ReturnType<typeof vi.fn>;
}

/** Mock stderr shape */
interface MockStderr extends EventEmitter {
  resume: ReturnType<typeof vi.fn>;
}

/** Mock child process shape used throughout the tests */
interface MockChildProcess extends EventEmitter {
  stdout: MockStdout;
  stderr: MockStderr;
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
}

/** Mock child process with PassThrough stdout (needed for readline-based streaming) */
interface MockPassThroughChild extends EventEmitter {
  stdout: PassThrough;
  stderr: MockStderr;
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
}

/** Create a mock child with PassThrough stdout for readline streaming tests */
function createPassThroughMockChild(): MockPassThroughChild {
  const child = Object.assign(new EventEmitter(), {
    killed: false,
    pid: 12345,
  }) as unknown as MockPassThroughChild;
  child.stdout = new PassThrough();
  const stderr = Object.assign(new EventEmitter(), { resume: vi.fn() }) as MockStderr;
  child.stderr = stderr;
  const stdinEmitter = new EventEmitter();
  child.stdin = Object.assign(stdinEmitter, { write: vi.fn(), end: vi.fn() });
  child.stdin.on('error', () => {}); // Prevent EPIPE unhandled errors
  child.kill = vi.fn((_signal?: string) => { child.killed = true; return true; });
  return child;
}

// Helper: create a mock child process
function createMockChild(): MockChildProcess {
  const child = Object.assign(new EventEmitter(), {
    killed: false,
    pid: 12345,
  }) as unknown as MockChildProcess;

  // stdout needs Readable-stream methods because readline.createInterface calls them
  const stdout = Object.assign(new EventEmitter(), {
    resume: vi.fn(),
    pause: vi.fn(),
    pipe: vi.fn(),
    setEncoding: vi.fn(),
    isPaused: vi.fn(() => false),
    unpipe: vi.fn(),
  }) as MockStdout;
  child.stdout = stdout;

  const stderr = Object.assign(new EventEmitter(), {
    resume: vi.fn(),
  }) as MockStderr;
  child.stderr = stderr;

  const stdinEmitter = new EventEmitter();
  child.stdin = Object.assign(stdinEmitter, { write: vi.fn(), end: vi.fn() });
  child.kill = vi.fn((_signal?: string) => {
    child.killed = true;
    return true;
  });
  return child;
}

/**
 * Mock execFile to simulate binary found.
 *
 * findBinary calls: execFile(cmd, ['gemini'/'codex'/'cursor'], callback)  — 3 args
 * runVersion/healthCheck calls: execFile(path, ['--version'], { timeout }, callback) — 4 args
 *
 * We detect the two patterns by argument count.
 */
function mockBinaryFound(binaryName: string, version: string = '1.0.0') {
  mockExecFile.mockImplementation(
    (cmd: string, args: string[], optOrCb: any, cb?: any) => {
      if (typeof optOrCb === 'function') {
        // 3-arg call: execFile(cmd, args, callback) — this is the which/where call
        const callback = optOrCb;
        if (args[0] === binaryName) {
          callback(null, `/usr/local/bin/${binaryName}\n`, '');
        } else {
          callback(new Error('not found'), '', '');
        }
      } else {
        // 4-arg call: execFile(path, args, options, callback) — this is the --version call
        const callback = cb!;
        callback(null, version, '');
      }
    },
  );
}

/**
 * Mock execFile to simulate binary NOT found (both call patterns return an error).
 */
function mockBinaryNotFound() {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], optOrCb: any, cb?: any) => {
      const callback = typeof optOrCb === 'function' ? optOrCb : cb!;
      callback(new Error('not found'), '', '');
    },
  );
}

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ============================================================
// GeminiCLIProvider
// ============================================================

describe('GeminiCLIProvider', () => {
  let provider: GeminiCLIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GeminiCLIProvider({
      config: { provider: 'gemini-cli', model: 'gemini-3.5-flash' },
      logger: noopLogger,
    });
  });

  afterEach(() => {
    provider.destroy();
  });

  it('initializes with binary found', async () => {
    // DO-NOT-REVERT (2026-06): binary is ANTIGRAVITY `agy`, not dead `gemini`.
    mockBinaryFound('agy', 'agy version 1.0.7');
    await provider.initialize();
    // Should not throw
  });

  it('initializes with binary not found (warns but does not throw)', async () => {
    mockBinaryNotFound();
    await provider.initialize();
    // Should not throw — just warns
  });

  it('completes with valid JSON output', async () => {
    mockBinaryFound('agy');
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    // Simulate successful Gemini JSON output
    const output = JSON.stringify({
      response: 'Hello! How can I help?',
      stats: {
        models: {
          'gemini-3.5-flash': {
            tokens: { prompt: 10, candidates: 20, total: 30 },
          },
        },
      },
    });
    mockChild.stdout.emit('data', Buffer.from(output));
    mockChild.emit('close', 0);

    const result = await completePromise;
    expect(result.content).toBe('Hello! How can I help?');
    expect(result.provider).toBe('gemini-cli');
    expect(result.usage.promptTokens).toBe(10);
    expect(result.usage.completionTokens).toBe(20);
  });

  it('omits --sandbox by default (opt-in, requires Docker)', async () => {
    mockBinaryFound('agy');
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    // --sandbox is opt-in — not present by default
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--sandbox');

    // Clean up
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ response: 'ok' })));
    mockChild.emit('close', 0);
    await completePromise;
  });

  it('passes --sandbox when sandbox=true in config', async () => {
    mockBinaryFound('agy');
    const sandboxProvider = new GeminiCLIProvider({
      config: { provider: 'gemini-cli', model: 'gemini-2.5-pro', sandbox: true },
      logger: noopLogger,
    });
    await sandboxProvider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = sandboxProvider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['--sandbox']),
      expect.any(Object),
    );

    // Clean up
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ response: 'ok' })));
    mockChild.emit('close', 0);
    await completePromise;
    sandboxProvider.destroy();
  });

  it('passes request-scoped env vars to the spawned CLI process', async () => {
    mockBinaryFound('agy');
    provider = new GeminiCLIProvider({
      config: {
        provider: 'gemini-cli',
        model: 'gemini-3.5-flash',
        env: { HIVE_FLOW_AGENT_TOKEN: 'agent-token-123' },
      },
      logger: noopLogger,
    });
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    const spawnEnv = mockSpawn.mock.calls[0][2].env;
    expect(spawnEnv.HIVE_FLOW_AGENT_TOKEN).toBe('agent-token-123');

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ response: 'ok' })));
    mockChild.emit('close', 0);
    await completePromise;
  });

  it('passes small prompts through --prompt for headless execution', async () => {
    mockBinaryFound('agy');
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    provider.complete({ messages: [{ role: 'user', content: 'test' }] });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const spawnOptions = mockSpawn.mock.calls[0][2];
    expect(spawnArgs).toContain('--prompt');
    // DO-NOT-REVERT (2026-06): Antigravity `agy` uses --dangerously-skip-permissions,
    // NOT the dead gemini's --skip-trust, and has NO --output-format flag.
    expect(spawnArgs).toContain('--dangerously-skip-permissions');
    expect(spawnArgs).not.toContain('--skip-trust');
    expect(spawnArgs).not.toContain('--output-format');
    expect(spawnArgs[spawnArgs.indexOf('--prompt') + 1]).toContain('test');
    expect(spawnOptions.detached).toBe(process.platform !== 'win32');
    expect(mockChild.stdin.write).not.toHaveBeenCalled();
    expect(mockChild.stdin.end).toHaveBeenCalled();

    // Clean up
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ response: 'ok' })));
    mockChild.emit('close', 0);
  });

  it('uses --prompt empty plus stdin for large prompts to avoid argv limits', async () => {
    mockBinaryFound('agy');
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const largePrompt = 'x'.repeat(32_000);
    const completePromise = provider.complete({ messages: [{ role: 'user', content: largePrompt }] });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain('--prompt');
    expect(spawnArgs[spawnArgs.indexOf('--prompt') + 1]).toBe('');
    expect(mockChild.stdin.write).toHaveBeenCalledWith(expect.stringContaining(largePrompt));
    expect(mockChild.stdin.end).toHaveBeenCalled();

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ response: 'ok' })));
    mockChild.emit('close', 0);
    await completePromise;
  });

  it('rejects immediately on interactive authentication output', async () => {
    mockBinaryFound('agy');
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
      timeout: 60_000,
    });

    mockChild.stderr.emit('data', Buffer.from('Opening authentication page. Continue? [Y/n]'));

    await expect(completePromise).rejects.toMatchObject({
      code: 'AUTHENTICATION',
      retryable: false,
    });
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not treat cached OAuth credential notices as authentication failure', async () => {
    mockBinaryFound('agy');
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.stderr.emit('data', Buffer.from('Loaded cached credentials from OAuth store\n'));
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ response: 'ok' })));
    mockChild.emit('close', 0);

    await expect(completePromise).resolves.toMatchObject({ content: 'ok' });
  });

  it('rejects on non-zero exit code', async () => {
    mockBinaryFound('agy');
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.stderr.emit('data', Buffer.from('Auth failed'));
    mockChild.emit('close', 41); // Auth exit code

    await expect(completePromise).rejects.toThrow(/auth/i);
  });

  it('rejects with specific message on exit code 42 (empty prompt)', async () => {
    mockBinaryFound('agy');
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: '' }],
    });

    mockChild.emit('close', 42);

    await expect(completePromise).rejects.toThrow(/empty or invalid prompt/i);
  });

  it('streams with stream-json events', async () => {
    mockBinaryFound('agy');
    await provider.initialize();

    // Gemini doStreamComplete uses `for await (const line of rl)` on readline,
    // which requires a real Readable stream (not just an EventEmitter mock).
    const child = createPassThroughMockChild();

    mockSpawn.mockReturnValue(child);

    const events: LLMStreamEvent[] = [];
    const streamPromise = (async () => {
      for await (const event of provider.streamComplete({
        messages: [{ role: 'user', content: 'Hello' }],
      })) {
        events.push(event);
      }
    })();

    // Give the async iterator time to set up the readline listener
    await new Promise(r => setTimeout(r, 10));

    // Gemini stream-json emits newline-delimited JSON with response or content fields
    child.stdout.write(JSON.stringify({ response: 'Hello ' }) + '\n');
    child.stdout.write(JSON.stringify({ response: 'world!' }) + '\n');
    child.stdout.end();
    child.emit('close', 0);

    await streamPromise;

    const contentEvents = events.filter(e => e.type === 'content');
    expect(contentEvents.length).toBeGreaterThan(0);
    // Tool-call buffering accumulates content until a <tool_call> is found or
    // the stream ends — without tool calls, all content is emitted in one event.
    const combinedContent = contentEvents.map(e => e.delta.content).join('');
    expect(combinedContent).toBe('Hello world!');

    const doneEvents = events.filter(e => e.type === 'done');
    expect(doneEvents.length).toBe(1);
  });
});

// ============================================================
// CodexCLIProvider
// ============================================================

describe('CodexCLIProvider', () => {
  let provider: CodexCLIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CodexCLIProvider({
      config: { provider: 'codex-cli', model: undefined as unknown as LLMModel /* SAFETY: testing undefined model edge case */ },
      logger: noopLogger,
    });
  });

  afterEach(() => {
    provider.destroy();
  });

  it('initializes with binary found', async () => {
    mockBinaryFound('codex', '0.106.0');
    await provider.initialize();
  });

  it('omits --model flag when model is auto', async () => {
    mockBinaryFound('codex');
    provider = new CodexCLIProvider({
      config: { provider: 'codex-cli', model: 'auto' },
      logger: noopLogger,
    });
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    provider.complete({ messages: [{ role: 'user', content: 'test' }] });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--model');

    // Clean up — must emit item.completed with text before turn.completed,
    // otherwise the empty-response guard rejects the promise
    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }) + '\n',
    ));
    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 10 } }) + '\n',
    ));
    mockChild.emit('close', 0);
  });

  it('includes --model flag when model is explicitly set', async () => {
    mockBinaryFound('codex');
    provider = new CodexCLIProvider({
      config: { provider: 'codex-cli', model: 'gpt-5.3-codex' },
      logger: noopLogger,
    });
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    provider.complete({ messages: [{ role: 'user', content: 'test' }] });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain('--model');
    expect(spawnArgs).toContain('gpt-5.3-codex');

    // Clean up — must emit item.completed with text before turn.completed
    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }) + '\n',
    ));
    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'turn.completed' }) + '\n',
    ));
    mockChild.emit('close', 0);
  });

  it('calls stdin.end() after spawn', async () => {
    mockBinaryFound('codex');
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    provider.complete({ messages: [{ role: 'user', content: 'test' }] });

    expect(mockChild.stdin.end).toHaveBeenCalled();

    // Clean up — must emit item.completed with text before turn.completed
    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }) + '\n',
    ));
    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'turn.completed' }) + '\n',
    ));
    mockChild.emit('close', 0);
  });

  it('spawns Codex CLI detached on non-Windows so descendants share a process group', async () => {
    mockBinaryFound('codex');
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({ messages: [{ role: 'user', content: 'test' }] });

    expect(mockSpawn.mock.calls[0][2]).toMatchObject({
      detached: process.platform !== 'win32',
    });

    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }) + '\n',
    ));
    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'turn.completed' }) + '\n',
    ));
    mockChild.emit('close', 0);
    await completePromise;
  });

  it('kills the Codex process group on complete timeout', async () => {
    mockBinaryFound('codex');
    provider = new CodexCLIProvider({
      config: { provider: 'codex-cli', model: 'gpt-5.3-codex', timeout: 5000 },
      logger: noopLogger,
    });
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.useFakeTimers();

    const completePromise = provider.complete({ messages: [{ role: 'user', content: 'slow task' }] });
    vi.advanceTimersByTime(5001);

    await expect(completePromise).rejects.toThrow(/timed out/i);
    if (process.platform !== 'win32') {
      expect(killSpy).toHaveBeenCalledWith(-mockChild.pid, 'SIGKILL');
    }
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

    vi.useRealTimers();
    killSpy.mockRestore();
  });

  it('passes request-scoped env vars to the spawned CLI process', async () => {
    mockBinaryFound('codex');
    provider = new CodexCLIProvider({
      config: {
        provider: 'codex-cli',
        model: 'gpt-5.3-codex',
        env: { HIVE_FLOW_AGENT_TOKEN: 'agent-token-123' },
      },
      logger: noopLogger,
    });
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    provider.complete({ messages: [{ role: 'user', content: 'test' }] });

    const spawnEnv = mockSpawn.mock.calls[0][2].env;
    expect(spawnEnv.HIVE_FLOW_AGENT_TOKEN).toBe('agent-token-123');

    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }) + '\n',
    ));
    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'turn.completed' }) + '\n',
    ));
    mockChild.emit('close', 0);
  });

  it('completes with item.completed and turn.completed events', async () => {
    mockBinaryFound('codex');
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    // Simulate JSONL events
    mockChild.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Response text' },
        }) + '\n',
      ),
    );
    mockChild.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 15, output_tokens: 25 },
        }) + '\n',
      ),
    );
    mockChild.emit('close', 0);

    const result = await completePromise;
    expect(result.content).toBe('Response text');
    expect(result.usage.promptTokens).toBe(15);
    expect(result.usage.completionTokens).toBe(25);
  });

  it('handles turn.failed without codexErrorInfo.type', async () => {
    mockBinaryFound('codex');
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    // turn.failed without codexErrorInfo
    mockChild.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'turn.failed',
          error: { message: 'Something went wrong' },
        }) + '\n',
      ),
    );

    await expect(completePromise).rejects.toThrow(/Something went wrong/);
  });

  it('streams with JSONL events', async () => {
    mockBinaryFound('codex');
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const events: any[] = [];
    const streamPromise = (async () => {
      for await (const event of provider.streamComplete({
        messages: [{ role: 'user', content: 'Hello' }],
      })) {
        events.push(event);
      }
    })();

    await new Promise(r => setTimeout(r, 10));

    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Streamed response' } }) + '\n'
    ));
    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } }) + '\n'
    ));
    mockChild.emit('close', 0);

    await streamPromise;

    const contentEvents = events.filter(e => e.type === 'content');
    expect(contentEvents.length).toBeGreaterThan(0);
    expect(contentEvents[0].delta.content).toBe('Streamed response');

    const doneEvents = events.filter(e => e.type === 'done');
    expect(doneEvents.length).toBe(1);
    expect(doneEvents[0].usage.promptTokens).toBe(10);
    expect(doneEvents[0].usage.completionTokens).toBe(20);
  });
});

// ============================================================
// CursorCLIProvider
// ============================================================

describe('CursorCLIProvider', () => {
  let provider: CursorCLIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
  });

  afterEach(() => {
    provider.destroy();
  });

  it('initializes with binary found', async () => {
    mockBinaryFound('cursor-agent', 'v2026.02.27');
    await provider.initialize();
  });

  it('passes --trust and --force flags in args', async () => {
    mockBinaryFound('cursor-agent');
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    provider.complete({ messages: [{ role: 'user', content: 'test' }] });

    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['--trust', '--force']),
      expect.any(Object),
    );

    // Clean up
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'ok' })));
    mockChild.emit('close', 0);
  });

  it('passes API key via env var, not CLI args', async () => {
    mockBinaryFound('cursor-agent');
    provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto', apiKey: 'test-key-123' },
      logger: noopLogger,
    });
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    provider.complete({ messages: [{ role: 'user', content: 'test' }] });

    // Verify API key is NOT in args
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--api-key');
    expect(spawnArgs).not.toContain('test-key-123');

    // Verify API key IS in env
    const spawnEnv = mockSpawn.mock.calls[0][2].env;
    expect(spawnEnv.CURSOR_API_KEY).toBe('test-key-123');

    // Clean up
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'ok' })));
    mockChild.emit('close', 0);
  });

  it('passes request-scoped env vars to the spawned CLI process', async () => {
    mockBinaryFound('cursor-agent');
    provider = new CursorCLIProvider({
      config: {
        provider: 'cursor-cli',
        model: 'auto',
        env: { HIVE_FLOW_AGENT_TOKEN: 'agent-token-123' },
      },
      logger: noopLogger,
    });
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    provider.complete({ messages: [{ role: 'user', content: 'test' }] });

    const spawnEnv = mockSpawn.mock.calls[0][2].env;
    expect(spawnEnv.HIVE_FLOW_AGENT_TOKEN).toBe('agent-token-123');

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'ok' })));
    mockChild.emit('close', 0);
  });

  it('completes with JSON output', async () => {
    mockBinaryFound('cursor-agent');
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    mockChild.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          result: 'Hello from Cursor!',
          usage: { input_tokens: 10, output_tokens: 15 },
        }),
      ),
    );
    mockChild.emit('close', 0);

    const result = await completePromise;
    expect(result.content).toBe('Hello from Cursor!');
    expect(result.provider).toBe('cursor-cli');
  });

  it('calls stdin.end() immediately', async () => {
    mockBinaryFound('cursor-agent');
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    provider.complete({ messages: [{ role: 'user', content: 'test' }] });

    expect(mockChild.stdin.end).toHaveBeenCalled();

    // Clean up
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'ok' })));
    mockChild.emit('close', 0);
  });

  it('streams with stream-json events', async () => {
    mockBinaryFound('cursor-agent');
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const events: any[] = [];
    const streamPromise = (async () => {
      for await (const event of provider.streamComplete({
        messages: [{ role: 'user', content: 'Hello' }],
      })) {
        events.push(event);
      }
    })();

    await new Promise(r => setTimeout(r, 10));

    // Cursor stream-json: content string field yields content delta
    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ content: 'Streamed from Cursor' }) + '\n'
    ));
    // Cursor stream-json: type=result event carries usage
    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'result', usage: { input_tokens: 5, output_tokens: 15 } }) + '\n'
    ));
    mockChild.emit('close', 0);

    await streamPromise;

    const contentEvents = events.filter(e => e.type === 'content');
    expect(contentEvents.length).toBeGreaterThan(0);
    expect(contentEvents[0].delta.content).toBe('Streamed from Cursor');

    const doneEvents = events.filter(e => e.type === 'done');
    expect(doneEvents.length).toBe(1);
    expect(doneEvents[0].usage.promptTokens).toBe(5);
    expect(doneEvents[0].usage.completionTokens).toBe(15);
  });
});

// ============================================================
// Tool-Calling Tests — All 3 Providers
// ============================================================

const sampleTools = [
  {
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description: 'Get weather for a city',
      parameters: { type: 'object' as const, properties: { city: { type: 'string' } }, required: ['city'] },
    },
  },
];

const toolCallOutput = 'Here is the result:\n<tool_call>{"name":"get_weather","arguments":{"city":"London"}}</tool_call>';

describe('GeminiCLIProvider — tool calling', () => {
  let provider: GeminiCLIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GeminiCLIProvider({
      config: { provider: 'gemini-cli', model: 'gemini-3.5-flash' },
      logger: noopLogger,
    });
  });

  afterEach(() => { provider.destroy(); });

  it('formatMessages() includes available_tools XML when tools provided', () => {
    const formatMessages = (provider as PrivateAccess).formatMessages.bind(provider);
    const result = formatMessages(
      [{ role: 'user', content: 'What is the weather?' }],
      sampleTools,
    );
    expect(result).toContain('<available_tools>');
    expect(result).toContain('get_weather');
    expect(result).toContain('<tool_call>');
  });

  it('doComplete() extracts tool_call from response', async () => {
    mockBinaryFound('agy');
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'Weather?' }],
    });

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ response: toolCallOutput })));
    mockChild.emit('close', 0);

    const result = await completePromise;
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBe(1);
    expect(result.toolCalls![0].function.name).toBe('get_weather');
    expect(JSON.parse(result.toolCalls![0].function.arguments)).toEqual({ city: 'London' });
    expect(result.content).not.toContain('<tool_call>');
    expect(result.finishReason).toBe('tool_calls');
  });
});

describe('CodexCLIProvider — tool calling', () => {
  let provider: CodexCLIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CodexCLIProvider({
      config: { provider: 'codex-cli', model: 'gpt-5.3-codex' },
      logger: noopLogger,
    });
  });

  afterEach(() => { provider.destroy(); });

  it('formatMessages() includes available_tools XML when tools provided', () => {
    const formatMessages = (provider as PrivateAccess).formatMessages.bind(provider);
    const result = formatMessages(
      [{ role: 'user', content: 'What is the weather?' }],
      sampleTools,
    );
    expect(result).toContain('<available_tools>');
    expect(result).toContain('get_weather');
  });

  it('doComplete() extracts tool_call from response', async () => {
    mockBinaryFound('codex');
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'Weather?' }],
    });

    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: toolCallOutput } }) + '\n',
    ));
    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } }) + '\n',
    ));
    mockChild.emit('close', 0);

    const result = await completePromise;
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBe(1);
    expect(result.toolCalls![0].function.name).toBe('get_weather');
    expect(result.content).not.toContain('<tool_call>');
    expect(result.finishReason).toBe('tool_calls');
  });
});

describe('CursorCLIProvider — tool calling', () => {
  let provider: CursorCLIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
  });

  afterEach(() => { provider.destroy(); });

  it('formatMessages() includes available_tools XML when tools provided', () => {
    const formatMessages = (provider as PrivateAccess).formatMessages.bind(provider);
    const result = formatMessages(
      [{ role: 'user', content: 'What is the weather?' }],
      sampleTools,
    );
    expect(result).toContain('<available_tools>');
    expect(result).toContain('get_weather');
  });

  it('doComplete() extracts tool_call from response', async () => {
    mockBinaryFound('cursor-agent');
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'Weather?' }],
    });

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ result: toolCallOutput })));
    mockChild.emit('close', 0);

    const result = await completePromise;
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBe(1);
    expect(result.toolCalls![0].function.name).toBe('get_weather');
    expect(result.content).not.toContain('<tool_call>');
    expect(result.finishReason).toBe('tool_calls');
  });
});

// ============================================================
// CursorCLIProvider — spawnCursor binary detection & usage parsing
// ============================================================

describe('CursorCLIProvider — spawnCursor binary detection', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('includes "agent" subcommand when binary is cursor (launcher)', () => {
    const provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    (provider as PrivateAccess).binaryPath = '/usr/local/bin/cursor';

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    // Call spawnCursor directly to test args construction
    (provider as PrivateAccess).spawnCursor('test prompt', 'auto', false);

    expect(spawn).toHaveBeenCalledWith(
      '/usr/local/bin/cursor',
      expect.arrayContaining(['agent', '--print']),
      expect.any(Object),
    );
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs[0]).toBe('agent');

    provider.destroy();
  });

  it('omits "agent" subcommand when binary is cursor-agent', () => {
    const provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    (provider as PrivateAccess).binaryPath = '/home/user/.local/bin/cursor-agent';

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    (provider as PrivateAccess).spawnCursor('test prompt', 'auto', false);

    expect(spawn).toHaveBeenCalledWith(
      '/home/user/.local/bin/cursor-agent',
      expect.not.arrayContaining(['agent']),
      expect.any(Object),
    );
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs[0]).toBe('--print');

    provider.destroy();
  });
});

// ============================================================
// DO-NOT-REVERT GUARD: headless cursor-agent CLI, never the IDE / Background Agents.
//
// These tests are intentionally REDUNDANT with the binary-detection tests above.
// They exist to fail loudly if anyone regresses the cursor provider toward the
// Cursor IDE / "Background Agents" path (which hangs headless and surfaces as the
// 300s timeout the human reported). They assert the headless CLI invariant directly
// on the argv the provider builds via spawnCursor().
// ============================================================

describe('CursorCLIProvider — headless CLI argv guard (DO-NOT-REVERT)', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  function spawnArgvFor(binaryPath: string, stream = false): string[] {
    const provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    (provider as PrivateAccess).binaryPath = binaryPath;
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);
    (provider as PrivateAccess).spawnCursor('guard prompt', 'auto', stream);
    const argv = mockSpawn.mock.calls[0][1] as string[];
    provider.destroy();
    return argv;
  }

  it('cursor-agent binary: argv begins with --print and includes --force (headless)', () => {
    const argv = spawnArgvFor('/home/user/.local/bin/cursor-agent');
    expect(argv[0]).toBe('--print');
    expect(argv).toContain('--print');
    expect(argv).toContain('--force');
    // headless cursor-agent never uses the 'agent' subcommand
    expect(argv).not.toContain('agent');
  });

  it('cursor launcher fallback: uses the "agent" headless subcommand with --print/--force', () => {
    const argv = spawnArgvFor('/usr/local/bin/cursor');
    // The launcher reaches the SAME headless CLI via its 'agent' subcommand.
    expect(argv[0]).toBe('agent');
    expect(argv).toContain('--print');
    expect(argv).toContain('--force');
  });

  it('NEVER emits a Cursor IDE / Background Agents invocation', () => {
    for (const bin of ['/home/user/.local/bin/cursor-agent', '/usr/local/bin/cursor']) {
      const argv = spawnArgvFor(bin);
      const joined = argv.join(' ').toLowerCase();
      expect(joined).not.toContain('background-agent');
      expect(joined).not.toContain('background_agent');
      expect(joined).not.toContain('--background');
      expect(joined).not.toContain('--ide');
      expect(joined).not.toContain('--gui');
      expect(joined).not.toContain('--editor');
    }
  });

  it('streaming mode keeps the headless --print/--force flags', () => {
    const argv = spawnArgvFor('/home/user/.local/bin/cursor-agent', true);
    expect(argv).toContain('--print');
    expect(argv).toContain('--force');
    expect(argv).toContain('--stream-partial-output');
    expect(argv).toContain('stream-json');
    expect(argv).not.toContain('agent');
  });
});

describe('CursorCLIProvider — parseJsonOutput usage parsing', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('captures tokens from camelCase usage fields', async () => {
    mockBinaryFound('cursor-agent');
    const provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      result: 'Hello',
      usage: { inputTokens: 100, outputTokens: 50 },
    })));
    mockChild.emit('close', 0);

    const result = await completePromise;
    expect(result.usage.promptTokens).toBe(100);
    expect(result.usage.completionTokens).toBe(50);
    provider.destroy();
  });

  it('captures tokens from snake_case usage fields', async () => {
    mockBinaryFound('cursor-agent');
    const provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      result: 'Hello',
      usage: { input_tokens: 100, output_tokens: 50 },
    })));
    mockChild.emit('close', 0);

    const result = await completePromise;
    expect(result.usage.promptTokens).toBe(100);
    expect(result.usage.completionTokens).toBe(50);
    provider.destroy();
  });
});

// ============================================================
// Error Handling & Edge Cases — Coverage Boosters
// ============================================================

describe('GeminiCLIProvider — error handling', () => {
  let provider: GeminiCLIProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockBinaryFound('agy');
    provider = new GeminiCLIProvider({
      config: { provider: 'gemini-cli', model: 'gemini-3.5-flash' },
      logger: noopLogger,
    });
    await provider.initialize();
  });

  afterEach(() => { provider.destroy(); });

  it('rejects with error message on exit code 1 (generic)', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.stderr.emit('data', Buffer.from('Not authenticated'));
    mockChild.emit('close', 1);

    await expect(promise).rejects.toThrow(/auth/i);
  });

  it('rejects with input error on exit code 42', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.emit('close', 42);

    await expect(promise).rejects.toThrow(/empty or invalid prompt/i);
  });

  it('rejects with error message on exit code 2 (unmapped)', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.stderr.emit('data', Buffer.from('Bad config'));
    mockChild.emit('close', 2);

    await expect(promise).rejects.toThrow(/config/i);
  });

  it('rejects with cancel error on exit code 130', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.emit('close', 130);

    await expect(promise).rejects.toThrow(/cancel/i);
  });

  it('rejects with generic CLI error on unknown exit code', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.stderr.emit('data', Buffer.from('Something weird happened'));
    mockChild.emit('close', 99);

    await expect(promise).rejects.toThrow(/weird/i);
  });

  it('rejects on child process error event', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.emit('error', new Error('spawn ENOENT'));

    await expect(promise).rejects.toThrow(/ENOENT/i);
  });

  it('rejects with empty response when content is empty', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ response: '' })));
    mockChild.emit('close', 0);

    await expect(promise).rejects.toThrow(/empty/i);
  });

  it('destroy() kills active children', async () => {
    const mockChild = createMockChild();
    mockChild.killed = false;
    mockChild.kill = vi.fn();
    mockSpawn.mockReturnValue(mockChild);

    // Start a request without resolving it
    provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    }).catch(() => {});

    // Now destroy — should kill the child
    provider.destroy();
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('formatMessages handles system messages and multi-part content', () => {
    const formatMessages = (provider as PrivateAccess).formatMessages.bind(provider);
    const result = formatMessages([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'World' }] },
      { role: 'assistant', content: 'Hi there' },
    ]);
    expect(result).toContain('System: You are helpful.');
    expect(result).toContain('Hello');
    expect(result).toContain('World');
    expect(result).toContain('Assistant: Hi there');
  });
});

describe('CodexCLIProvider — error handling', () => {
  let provider: CodexCLIProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockBinaryFound('codex');
    provider = new CodexCLIProvider({
      config: { provider: 'codex-cli', model: 'gpt-5.3-codex' },
      logger: noopLogger,
    });
    await provider.initialize();
  });

  afterEach(() => { provider.destroy(); });

  it('rejects on non-zero exit code', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.stderr.emit('data', Buffer.from('Permission denied'));
    mockChild.emit('close', 1);

    await expect(promise).rejects.toThrow();
  });

  it('rejects on child process error event', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.emit('error', new Error('spawn ENOENT'));

    await expect(promise).rejects.toThrow(/ENOENT/i);
  });

  it('destroy() kills active children', async () => {
    const mockChild = createMockChild();
    mockChild.killed = false;
    mockChild.kill = vi.fn();
    mockSpawn.mockReturnValue(mockChild);

    provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    }).catch(() => {});

    provider.destroy();
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('formatMessages handles system messages and multi-part content', () => {
    const formatMessages = (provider as PrivateAccess).formatMessages.bind(provider);
    const result = formatMessages([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: 'Hi there' },
    ]);
    expect(result).toContain('System: You are helpful.');
    expect(result).toContain('Hello');
    expect(result).toContain('Assistant: Hi there');
  });

  it('handles turn.failed with codexErrorInfo.type Unauthorized', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({
        type: 'turn.failed',
        error: { message: 'Auth failed', codexErrorInfo: { type: 'Unauthorized' } },
      }) + '\n',
    ));

    await expect(promise).rejects.toThrow(/Auth failed/);
  });

  it('handles turn.failed with codexErrorInfo.type UsageLimitExceeded', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({
        type: 'turn.failed',
        error: { message: 'Rate limited', codexErrorInfo: { type: 'UsageLimitExceeded' } },
      }) + '\n',
    ));

    await expect(promise).rejects.toThrow(/Rate limited/);
  });

  it('handles turn.failed with codexErrorInfo.type HttpConnectionFailed', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({
        type: 'turn.failed',
        error: { message: 'Connection lost', codexErrorInfo: { type: 'HttpConnectionFailed' } },
      }) + '\n',
    ));

    await expect(promise).rejects.toThrow(/Connection lost/);
  });

  it('handles turn.failed with codexErrorInfo.type ContextWindowExceeded', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({
        type: 'turn.failed',
        error: { message: 'Too long', codexErrorInfo: { type: 'ContextWindowExceeded' } },
      }) + '\n',
    ));

    await expect(promise).rejects.toThrow(/Too long/);
  });

  it('parseNestedErrorMessage extracts detail from nested JSON', async () => {
    const parseNested = (provider as PrivateAccess).parseNestedErrorMessage.bind(provider);
    const result = parseNested(JSON.stringify({ detail: 'inner detail' }));
    expect(result).toBe('inner detail');
  });

  it('parseNestedErrorMessage returns original string for non-JSON', async () => {
    const parseNested = (provider as PrivateAccess).parseNestedErrorMessage.bind(provider);
    const result = parseNested('plain error');
    expect(result).toBe('plain error');
  });

  it('parseNestedErrorMessage handles JSON primitive', async () => {
    const parseNested = (provider as PrivateAccess).parseNestedErrorMessage.bind(provider);
    const result = parseNested('"just a string"');
    expect(result).toBe('just a string');
  });

  it('parseLine returns null for empty string', () => {
    const parseLine = (provider as PrivateAccess).parseLine.bind(provider);
    expect(parseLine('')).toBeNull();
    expect(parseLine('  ')).toBeNull();
  });

  it('parseLine returns null for non-JSON', () => {
    const parseLine = (provider as PrivateAccess).parseLine.bind(provider);
    expect(parseLine('not json at all')).toBeNull();
  });

  it('parseLine parses valid JSON', () => {
    const parseLine = (provider as PrivateAccess).parseLine.bind(provider);
    const result = parseLine('{"type":"test"}');
    expect(result).toEqual({ type: 'test' });
  });

  it('rejects with empty response when no text and exit code 0', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    // turn.completed without any item.completed preceding it
    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'turn.completed' }) + '\n',
    ));
    mockChild.emit('close', 0);

    await expect(promise).rejects.toThrow(/empty/i);
  });

  it('spawnCodex accepts prompts exceeding 200KB (no client-side size limit)', () => {
    (provider as PrivateAccess).binaryPath = '/usr/local/bin/codex';
    const bigPrompt = 'x'.repeat(250_000);
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);
    // Should not throw — size validation is delegated to the Codex binary
    expect(() => {
      (provider as PrivateAccess).spawnCodex(bigPrompt, 'gpt-5.3-codex');
    }).not.toThrow();
  });
});

describe('CodexCLIProvider — health check', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('doHealthCheck returns healthy when binary found and version ok', async () => {
    mockBinaryFound('codex', '0.106.0');
    const provider = new CodexCLIProvider({
      config: { provider: 'codex-cli', model: 'gpt-5.3-codex' },
      logger: noopLogger,
    });
    await provider.initialize();

    // Re-mock execFile for the health check --version call
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], optOrCb: any, cb?: any) => {
        if (typeof optOrCb === 'function') {
          optOrCb(null, '/usr/local/bin/codex\n', '');
        } else {
          cb!(null, '0.106.0', '');
        }
      },
    );

    const result = await (provider as PrivateAccess).doHealthCheck();
    expect(result.healthy).toBe(true);
    expect(result.details.version).toBe('0.106.0');
    provider.destroy();
  });

  it('doHealthCheck returns unhealthy when binary not found', async () => {
    mockBinaryNotFound();
    const provider = new CodexCLIProvider({
      config: { provider: 'codex-cli', model: 'gpt-5.3-codex' },
      logger: noopLogger,
    });
    await provider.initialize();

    // Keep binary not found for health check too
    mockBinaryNotFound();

    const result = await (provider as PrivateAccess).doHealthCheck();
    expect(result.healthy).toBe(false);
    expect(result.error).toContain('not found');
    provider.destroy();
  });

  it('doHealthCheck returns unhealthy when --version fails', async () => {
    mockBinaryFound('codex', '0.106.0');
    const provider = new CodexCLIProvider({
      config: { provider: 'codex-cli', model: 'gpt-5.3-codex' },
      logger: noopLogger,
    });
    await provider.initialize();

    // Make --version fail for health check
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], optOrCb: any, cb?: any) => {
        if (typeof optOrCb === 'function') {
          optOrCb(null, '/usr/local/bin/codex\n', '');
        } else {
          cb!(new Error('exec failed'), '', '');
        }
      },
    );

    const result = await (provider as PrivateAccess).doHealthCheck();
    expect(result.healthy).toBe(false);
    expect(result.error).toContain('failed');
    provider.destroy();
  });
});

describe('CodexCLIProvider — findBinary', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('findBinary returns null when which fails', async () => {
    mockBinaryNotFound();
    const provider = new CodexCLIProvider({
      config: { provider: 'codex-cli', model: 'gpt-5.3-codex' },
      logger: noopLogger,
    });
    const result = await (provider as PrivateAccess).findBinary();
    expect(result).toBeNull();
    provider.destroy();
  });

  it('findBinary returns path when which succeeds', async () => {
    mockBinaryFound('codex');
    const provider = new CodexCLIProvider({
      config: { provider: 'codex-cli', model: 'gpt-5.3-codex' },
      logger: noopLogger,
    });
    const result = await (provider as PrivateAccess).findBinary();
    expect(result).toBe('/usr/local/bin/codex');
    provider.destroy();
  });
});

describe('CodexCLIProvider — ensureBinary', () => {
  it('throws ProviderUnavailableError when binaryPath is null', () => {
    const provider = new CodexCLIProvider({
      config: { provider: 'codex-cli', model: 'gpt-5.3-codex' },
      logger: noopLogger,
    });
    // Don't initialize, so binaryPath stays null
    expect(() => (provider as PrivateAccess).ensureBinary()).toThrow(/unavailable|not found/i);
    provider.destroy();
  });
});

describe('CodexCLIProvider — streaming edge cases', () => {
  let provider: CodexCLIProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockBinaryFound('codex');
    provider = new CodexCLIProvider({
      config: { provider: 'codex-cli', model: 'gpt-5.3-codex' },
      logger: noopLogger,
    });
    await provider.initialize();
  });

  afterEach(() => { provider.destroy(); });

  it('stream emits error event on turn.failed', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const events: any[] = [];
    const streamPromise = (async () => {
      for await (const event of provider.streamComplete({
        messages: [{ role: 'user', content: 'Hello' }],
      })) {
        events.push(event);
      }
    })().catch(() => {});

    await new Promise(r => setTimeout(r, 10));

    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'turn.failed', error: { message: 'Stream fail' } }) + '\n'
    ));
    mockChild.emit('close', 1);

    await streamPromise;

    const errorEvents = events.filter(e => e.type === 'error');
    expect(errorEvents.length).toBeGreaterThan(0);
  });

  it('stream emits content from item.completed with tool calls', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const events: any[] = [];
    const streamPromise = (async () => {
      for await (const event of provider.streamComplete({
        messages: [{ role: 'user', content: 'Hello' }],
      })) {
        events.push(event);
      }
    })().catch(() => {});

    await new Promise(r => setTimeout(r, 10));

    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'result\n<tool_call>{"name":"get_weather","arguments":{"city":"NYC"}}</tool_call>' },
      }) + '\n'
    ));
    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 10 } }) + '\n'
    ));
    mockChild.emit('close', 0);

    await streamPromise;

    const contentEvents = events.filter(e => e.type === 'content');
    expect(contentEvents.length).toBeGreaterThan(0);
    const doneEvents = events.filter(e => e.type === 'done');
    expect(doneEvents.length).toBe(1);
  });

  it('stream surfaces spawn error', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const events: any[] = [];
    const streamPromise = (async () => {
      for await (const event of provider.streamComplete({
        messages: [{ role: 'user', content: 'Hello' }],
      })) {
        events.push(event);
      }
    })().catch(() => {});

    await new Promise(r => setTimeout(r, 10));

    mockChild.emit('error', new Error('spawn ENOENT'));

    await streamPromise;

    const errorEvents = events.filter(e => e.type === 'error');
    expect(errorEvents.length).toBeGreaterThan(0);
  });

});

describe('CursorCLIProvider — error handling', () => {
  let provider: CursorCLIProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockBinaryFound('cursor-agent');
    provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    await provider.initialize();
  });

  afterEach(() => { provider.destroy(); });

  it('rejects on non-zero exit code', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.stderr.emit('data', Buffer.from('Auth failed'));
    mockChild.emit('close', 1);

    await expect(promise).rejects.toThrow();
  });

  it('rejects on child process error event', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.emit('error', new Error('spawn ENOENT'));

    await expect(promise).rejects.toThrow(/ENOENT/i);
  });

  it('throws on empty prompt', () => {
    expect(() => {
      (provider as PrivateAccess).spawnCursor('   ', 'auto', false);
    }).toThrow(/empty/i);
  });

  it('destroy() kills active children', async () => {
    const mockChild = createMockChild();
    mockChild.killed = false;
    mockChild.kill = vi.fn();
    mockSpawn.mockReturnValue(mockChild);

    provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    }).catch(() => {});

    provider.destroy();
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('formatMessages handles system messages and multi-part content', () => {
    const formatMessages = (provider as PrivateAccess).formatMessages.bind(provider);
    const result = formatMessages([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: 'Hi there' },
    ]);
    expect(result).toContain('System: You are helpful.');
    expect(result).toContain('Hello');
    expect(result).toContain('Assistant: Hi there');
  });

  it('spawnCursor accepts prompts exceeding 200KB (no client-side size limit)', () => {
    const bigPrompt = 'x'.repeat(250_000);
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);
    // Should not throw — size validation is delegated to the Cursor binary
    expect(() => {
      (provider as PrivateAccess).spawnCursor(bigPrompt, 'auto', false);
    }).not.toThrow();
  });

  it('spawnCursor passes CURSOR_API_KEY via env', () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    process.env.CURSOR_API_KEY = 'test-key-123';
    (provider as PrivateAccess).spawnCursor('hello', 'auto', false);
    delete process.env.CURSOR_API_KEY;

    const spawnEnv = mockSpawn.mock.calls[0][2].env;
    expect(spawnEnv.CURSOR_API_KEY).toBe('test-key-123');
  });
});

describe('CursorCLIProvider — health check', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('doHealthCheck returns healthy when binary found and version ok', async () => {
    mockBinaryFound('cursor-agent', '1.0.0');
    const provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    await provider.initialize();

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], optOrCb: any, cb?: any) => {
        if (typeof optOrCb === 'function') {
          optOrCb(null, '/usr/local/bin/cursor-agent\n', '');
        } else {
          cb!(null, '1.0.0', '');
        }
      },
    );

    const result = await (provider as PrivateAccess).doHealthCheck();
    expect(result.healthy).toBe(true);
    provider.destroy();
  });

  it('doHealthCheck returns unhealthy when binary not found', async () => {
    mockBinaryNotFound();
    const provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    await provider.initialize();

    mockBinaryNotFound();
    const result = await (provider as PrivateAccess).doHealthCheck();
    expect(result.healthy).toBe(false);
    provider.destroy();
  });

  it('doHealthCheck returns unhealthy when --version fails', async () => {
    mockBinaryFound('cursor-agent');
    const provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    await provider.initialize();

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], optOrCb: any, cb?: any) => {
        if (typeof optOrCb === 'function') {
          optOrCb(null, '/usr/local/bin/cursor-agent\n', '');
        } else {
          cb!(new Error('exec failed'), '', '');
        }
      },
    );

    const result = await (provider as PrivateAccess).doHealthCheck();
    expect(result.healthy).toBe(false);
    provider.destroy();
  });
});

describe('CursorCLIProvider — findBinary & ensureBinary', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('findBinary returns null when which fails', async () => {
    mockBinaryNotFound();
    const provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    const result = await (provider as PrivateAccess).findBinary();
    expect(result).toBeNull();
    provider.destroy();
  });

  it('findBinary returns path when which succeeds', async () => {
    mockBinaryFound('cursor-agent');
    const provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    const result = await (provider as PrivateAccess).findBinary();
    expect(result).toBe('/usr/local/bin/cursor-agent');
    provider.destroy();
  });

  it('ensureBinary throws when binaryPath is null', () => {
    const provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    expect(() => (provider as PrivateAccess).ensureBinary()).toThrow(/unavailable/i);
    provider.destroy();
  });
});

describe('CursorCLIProvider — streaming edge cases', () => {
  let provider: CursorCLIProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockBinaryFound('cursor-agent');
    provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    await provider.initialize();
  });

  afterEach(() => { provider.destroy(); });

  it('stream surfaces spawn error', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const events: any[] = [];
    const streamPromise = (async () => {
      for await (const event of provider.streamComplete({
        messages: [{ role: 'user', content: 'Hello' }],
      })) {
        events.push(event);
      }
    })().catch(() => {});

    await new Promise(r => setTimeout(r, 10));
    mockChild.emit('error', new Error('spawn ENOENT'));

    await streamPromise;

    const errorEvents = events.filter(e => e.type === 'error');
    expect(errorEvents.length).toBeGreaterThan(0);
  });
});

describe('GeminiCLIProvider — health check', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('doHealthCheck returns healthy when binary and version ok', async () => {
    mockBinaryFound('agy', '1.5.0');
    const provider = new GeminiCLIProvider({
      config: { provider: 'gemini-cli', model: 'gemini-3.5-flash' },
      logger: noopLogger,
    });
    await provider.initialize();

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], optOrCb: any, cb?: any) => {
        if (typeof optOrCb === 'function') {
          optOrCb(null, '/opt/homebrew/bin/gemini\n', '');
        } else {
          cb!(null, '1.5.0', '');
        }
      },
    );

    const result = await (provider as PrivateAccess).doHealthCheck();
    expect(result.healthy).toBe(true);
    expect(result.details.version).toBe('1.5.0');
    provider.destroy();
  });

  it('doHealthCheck returns unhealthy when --version fails', async () => {
    mockBinaryFound('agy');
    const provider = new GeminiCLIProvider({
      config: { provider: 'gemini-cli', model: 'gemini-3.5-flash' },
      logger: noopLogger,
    });
    await provider.initialize();

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], optOrCb: any, cb?: any) => {
        if (typeof optOrCb === 'function') {
          optOrCb(null, '/opt/homebrew/bin/gemini\n', '');
        } else {
          cb!(new Error('exec failed'), '', '');
        }
      },
    );

    const result = await (provider as PrivateAccess).doHealthCheck();
    expect(result.healthy).toBe(false);
    provider.destroy();
  });
});

describe('GeminiCLIProvider — findBinary & ensureBinary', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('findBinary returns null when which fails', async () => {
    mockBinaryNotFound();
    const provider = new GeminiCLIProvider({
      config: { provider: 'gemini-cli', model: 'gemini-3.5-flash' },
      logger: noopLogger,
    });
    const result = await (provider as PrivateAccess).findBinary();
    expect(result).toBeNull();
    provider.destroy();
  });

  it('ensureBinary throws when binaryPath is null', () => {
    const provider = new GeminiCLIProvider({
      config: { provider: 'gemini-cli', model: 'gemini-3.5-flash' },
      logger: noopLogger,
    });
    expect(() => (provider as PrivateAccess).ensureBinary()).toThrow(/unavailable/i);
    provider.destroy();
  });
});

describe('GeminiCLIProvider — streaming edge cases (PassThrough)', () => {
  let provider: GeminiCLIProvider;

  // Uses the top-level createPassThroughMockChild helper
  const createPassThroughChild = createPassThroughMockChild;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockBinaryFound('agy');
    provider = new GeminiCLIProvider({
      config: { provider: 'gemini-cli', model: 'gemini-3.5-flash' },
      logger: noopLogger,
    });
    await provider.initialize();
  });

  afterEach(() => { provider.destroy(); });

  it('stream emits content and done events', async () => {
    const child = createPassThroughChild();
    mockSpawn.mockReturnValue(child);

    const events: any[] = [];
    const streamPromise = (async () => {
      for await (const event of provider.streamComplete({
        messages: [{ role: 'user', content: 'Hello' }],
      })) {
        events.push(event);
      }
    })().catch(() => {});

    await new Promise(r => setTimeout(r, 10));

    child.stdout.write(JSON.stringify({ response: 'Hello world' }) + '\n');
    child.stdout.end();
    child.emit('close', 0);

    await streamPromise;

    const contentEvents = events.filter(e => e.type === 'content');
    expect(contentEvents.length).toBeGreaterThan(0);
    const doneEvents = events.filter(e => e.type === 'done');
    expect(doneEvents.length).toBe(1);
  });

  it('stream surfaces non-zero exit code as error', async () => {
    const child = createPassThroughChild();
    mockSpawn.mockReturnValue(child);

    const events: any[] = [];
    const streamPromise = (async () => {
      for await (const event of provider.streamComplete({
        messages: [{ role: 'user', content: 'Hello' }],
      })) {
        events.push(event);
      }
    })().catch(() => {});

    await new Promise(r => setTimeout(r, 10));

    child.stderr.emit('data', Buffer.from('Auth error'));
    child.stdout.end();
    child.emit('close', 1);

    await streamPromise;

    const errorEvents = events.filter(e => e.type === 'error');
    expect(errorEvents.length).toBeGreaterThan(0);
  });

  it('stream emits a non-retryable auth error on interactive authentication output', async () => {
    const child = createPassThroughChild();
    mockSpawn.mockReturnValue(child);

    const events: any[] = [];
    const streamPromise = (async () => {
      for await (const event of provider.streamComplete({
        messages: [{ role: 'user', content: 'Hello' }],
      })) {
        events.push(event);
      }
    })().catch(() => {});

    await new Promise(r => setTimeout(r, 10));

    child.stderr.emit('data', Buffer.from('Opening authentication page. Continue? [Y/n]'));
    child.stdout.end();
    child.emit('close', 1);

    await streamPromise;

    const authEvent = events.find(e => e.type === 'error');
    expect(authEvent?.error).toMatchObject({
      code: 'AUTHENTICATION',
      retryable: false,
    });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('stream handles message type events with content', async () => {
    const child = createPassThroughChild();
    mockSpawn.mockReturnValue(child);

    const events: any[] = [];
    const streamPromise = (async () => {
      for await (const event of provider.streamComplete({
        messages: [{ role: 'user', content: 'Hello' }],
      })) {
        events.push(event);
      }
    })();

    await new Promise(r => setTimeout(r, 10));

    child.stdout.write(JSON.stringify({ type: 'message', message: { content: 'msg content' } }) + '\n');
    child.stdout.end();
    child.emit('close', 0);

    await streamPromise;

    const contentEvents = events.filter(e => e.type === 'content');
    expect(contentEvents.length).toBeGreaterThan(0);
    const combined = contentEvents.map(e => e.delta.content).join('');
    expect(combined).toContain('msg content');
  });
});

// ============================================================
// Additional coverage: listModels / getModelInfo
// ============================================================

describe('CodexCLIProvider — listModels & getModelInfo', () => {
  it('listModels returns supported models', async () => {
    const provider = new CodexCLIProvider({
      config: { provider: 'codex-cli', model: 'gpt-5.3-codex' },
      logger: noopLogger,
    });
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models).toContain('gpt-5.3-codex');
    provider.destroy();
  });

  it('getModelInfo returns info for known model', async () => {
    const provider = new CodexCLIProvider({
      config: { provider: 'codex-cli', model: 'gpt-5.3-codex' },
      logger: noopLogger,
    });
    const info = await provider.getModelInfo('gpt-5.3-codex');
    expect(info.model).toBe('gpt-5.3-codex');
    expect(info.contextLength).toBeGreaterThan(0);
    expect(info.supportedFeatures).toContain('subscription-included');
    provider.destroy();
  });

  it('getModelInfo includes pricing for paid model', async () => {
    const provider = new CodexCLIProvider({
      config: { provider: 'codex-cli', model: 'gpt-5-codex-mini' },
      logger: noopLogger,
    });
    const info = await provider.getModelInfo('gpt-5-codex-mini');
    expect(info.pricing).toBeDefined();
    expect(info.pricing!.promptCostPer1k).toBeGreaterThan(0);
    expect(info.supportedFeatures).not.toContain('subscription-included');
    provider.destroy();
  });
});

describe('CursorCLIProvider — listModels & getModelInfo', () => {
  it('listModels returns supported models', async () => {
    const provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models).toContain('auto');
    provider.destroy();
  });

  it('getModelInfo returns info for known model', async () => {
    const provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    const info = await provider.getModelInfo('auto');
    expect(info.model).toBe('auto');
    expect(info.contextLength).toBeGreaterThan(0);
    provider.destroy();
  });
});

// ============================================================
// Additional coverage: Cursor doComplete edge cases
// ============================================================

describe('CursorCLIProvider — doComplete edge cases', () => {
  let provider: CursorCLIProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockBinaryFound('cursor-agent');
    provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    await provider.initialize();
  });

  afterEach(() => { provider.destroy(); });

  it('rejects with empty response on empty stdout', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.stdout.emit('data', Buffer.from(''));
    mockChild.emit('close', 0);

    await expect(promise).rejects.toThrow(/empty/i);
  });

  it('parseJsonOutput handles prompt_tokens usage field', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      result: 'Hello',
      usage: { prompt_tokens: 50, completion_tokens: 25 },
    })));
    mockChild.emit('close', 0);

    const result = await promise;
    expect(result.usage.promptTokens).toBe(50);
    expect(result.usage.completionTokens).toBe(25);
  });
});

// ============================================================
// Additional Cursor streaming: assistant message with string content
// ============================================================

describe('CursorCLIProvider — streaming assistant message', () => {
  let provider: CursorCLIProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockBinaryFound('cursor-agent');
    provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    await provider.initialize();
  });

  afterEach(() => { provider.destroy(); });

  it('stream handles assistant event with string content', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const events: any[] = [];
    const streamPromise = (async () => {
      for await (const event of provider.streamComplete({
        messages: [{ role: 'user', content: 'Hello' }],
      })) {
        events.push(event);
      }
    })().catch(() => {});

    await new Promise(r => setTimeout(r, 10));

    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({
        type: 'assistant',
        message: { content: 'string content' },
      }) + '\n'
    ));
    mockChild.emit('close', 0);

    await streamPromise;

    const contentEvents = events.filter(e => e.type === 'content');
    expect(contentEvents.length).toBeGreaterThan(0);
  });

  it('stream flushes remaining content buffer on close', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const events: any[] = [];
    const streamPromise = (async () => {
      for await (const event of provider.streamComplete({
        messages: [{ role: 'user', content: 'Hello' }],
      })) {
        events.push(event);
      }
    })().catch(() => {});

    await new Promise(r => setTimeout(r, 10));

    // Emit content without a result event -- content stays in buffer until close
    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ content: 'buffered content' }) + '\n'
    ));
    mockChild.emit('close', 0);

    await streamPromise;

    const contentEvents = events.filter(e => e.type === 'content');
    expect(contentEvents.length).toBeGreaterThan(0);
    const combined = contentEvents.map(e => e.delta.content).join('');
    expect(combined).toContain('buffered content');
  });
});

// ============================================================
// CursorCLIProvider — doComplete timeout with fake timers
// ============================================================

describe('CursorCLIProvider — timeout (fake timers)', () => {
  let provider: CursorCLIProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockBinaryFound('cursor-agent');
    provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    await provider.initialize();
  });

  afterEach(() => {
    provider.destroy();
    vi.useRealTimers();
  });

  it('rejects with timeout error when child does not respond', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
      timeout: 5000,
    });

    vi.advanceTimersByTime(6000);

    await expect(completePromise).rejects.toThrow(/timed out/i);
  });
});

// ============================================================
// CursorCLIProvider — validateConfig
// ============================================================

describe('CursorCLIProvider — validateConfig', () => {
  it('sets model to auto when model is not provided', async () => {
    vi.clearAllMocks();
    mockBinaryFound('cursor-agent');
    const provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: undefined as unknown as LLMModel /* SAFETY: testing undefined model edge case */ },
      logger: noopLogger,
    });
    await provider.initialize();
    expect(provider.config.model).toBe('auto');
    provider.destroy();
  });

  it('warns on unsupported model but does not throw', async () => {
    vi.clearAllMocks();
    mockBinaryFound('cursor-agent');
    const warnLogger = { ...noopLogger, warn: vi.fn() };
    const provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'unsupported-model' },
      logger: warnLogger,
    });
    await provider.initialize();
    expect(warnLogger.warn).toHaveBeenCalledWith(expect.stringContaining('unsupported-model'));
    provider.destroy();
  });
});

// ============================================================
// CursorCLIProvider — doStreamComplete with result/usage event
// ============================================================

describe('CursorCLIProvider — streaming result event', () => {
  let provider: CursorCLIProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockBinaryFound('cursor-agent');
    provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    await provider.initialize();
  });

  afterEach(() => { provider.destroy(); });

  it('stream handles result event with prompt_tokens field', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const events: any[] = [];
    const streamPromise = (async () => {
      for await (const event of provider.streamComplete({
        messages: [{ role: 'user', content: 'Hello' }],
      })) {
        events.push(event);
      }
    })().catch(() => {});

    await new Promise(r => setTimeout(r, 10));

    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ content: 'Hello' }) + '\n'
    ));
    mockChild.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'result', usage: { prompt_tokens: 30, completion_tokens: 15 } }) + '\n'
    ));
    mockChild.emit('close', 0);

    await streamPromise;

    const doneEvents = events.filter(e => e.type === 'done');
    expect(doneEvents.length).toBe(1);
    expect(doneEvents[0].usage.promptTokens).toBe(30);
    expect(doneEvents[0].usage.completionTokens).toBe(15);
  });
});

// ============================================================
// CursorCLIProvider — parseJsonOutput tool calls in non-JSON
// ============================================================

describe('CursorCLIProvider — parseJsonOutput tool call in raw text', () => {
  let provider: CursorCLIProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockBinaryFound('cursor-agent');
    provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    await provider.initialize();
  });

  afterEach(() => { provider.destroy(); });

  it('extracts tool calls from non-JSON raw text', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    const rawOutput = 'Here is the answer:\n<tool_call>{"name":"get_weather","arguments":{"city":"NYC"}}</tool_call>';
    mockChild.stdout.emit('data', Buffer.from(rawOutput));
    mockChild.emit('close', 0);

    const result = await completePromise;
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBe(1);
    expect(result.finishReason).toBe('tool_calls');
  });

  it('rejects when parseJsonOutput returns empty content and no tool calls', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    // JSON with content that becomes empty after tool call extraction
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      result: '<tool_call>{"name":"test","arguments":{}}</tool_call>',
    })));
    mockChild.emit('close', 0);

    const result = await completePromise;
    // Should have tool calls, not throw
    expect(result.toolCalls).toBeDefined();
    expect(result.finishReason).toBe('tool_calls');
  });
});

// ============================================================
// CursorCLIProvider — getModelInfo for unknown model
// ============================================================

describe('CursorCLIProvider — getModelInfo unknown', () => {
  it('returns default info for unknown model', async () => {
    const provider = new CursorCLIProvider({
      config: { provider: 'cursor-cli', model: 'auto' },
      logger: noopLogger,
    });
    const info = await provider.getModelInfo('unknown-model');
    expect(info.model).toBe('unknown-model');
    expect(info.description).toBe('Cursor Agent model');
    provider.destroy();
  });
});

// ============================================================
// GeminiCLIProvider — listModels & getModelInfo
// ============================================================

describe('GeminiCLIProvider — listModels & getModelInfo', () => {
  it('listModels returns supported models', async () => {
    const provider = new GeminiCLIProvider({
      config: { provider: 'gemini-cli', model: 'gemini-3.5-flash' },
      logger: noopLogger,
    });
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    provider.destroy();
  });

  it('getModelInfo returns info for known model', async () => {
    const provider = new GeminiCLIProvider({
      config: { provider: 'gemini-cli', model: 'gemini-3.5-flash' },
      logger: noopLogger,
    });
    const info = await provider.getModelInfo('gemini-3.5-flash');
    expect(info.model).toBe('gemini-3.5-flash');
    expect(info.contextLength).toBeGreaterThan(0);
    expect(info.supportedFeatures).toContain('tool_calling');
    provider.destroy();
  });

  it('getModelInfo returns fallback for unknown model', async () => {
    const provider = new GeminiCLIProvider({
      config: { provider: 'gemini-cli', model: 'gemini-3.5-flash' },
      logger: noopLogger,
    });
    const info = await provider.getModelInfo('unknown-model');
    expect(info.model).toBe('unknown-model');
    expect(info.description).toBe('Gemini CLI model');
    provider.destroy();
  });
});

// ============================================================
// GeminiCLIProvider — validateConfig
// ============================================================

describe('GeminiCLIProvider — validateConfig', () => {
  it('sets model to gemini-3.5-flash when model is not provided', async () => {
    vi.clearAllMocks();
    mockBinaryFound('agy');
    const provider = new GeminiCLIProvider({
      config: { provider: 'gemini-cli', model: undefined as unknown as LLMModel /* SAFETY: testing undefined model edge case */ },
      logger: noopLogger,
    });
    await provider.initialize();
    expect(provider.config.model).toBe('gemini-3.5-flash');
    provider.destroy();
  });

  it('warns on unsupported model', async () => {
    vi.clearAllMocks();
    mockBinaryFound('agy');
    const warnLogger = { ...noopLogger, warn: vi.fn() };
    const provider = new GeminiCLIProvider({
      config: { provider: 'gemini-cli', model: 'unsupported-model' },
      logger: warnLogger,
    });
    await provider.initialize();
    expect(warnLogger.warn).toHaveBeenCalledWith(expect.stringContaining('unsupported-model'));
    provider.destroy();
  });

  it('throws on invalid temperature', () => {
    expect(() => {
      const provider = new GeminiCLIProvider({
        config: { provider: 'gemini-cli', model: 'gemini-3.5-flash', temperature: 3 },
        logger: noopLogger,
      });
      (provider as PrivateAccess).validateConfig();
    }).toThrow(/temperature/i);
  });
});

// ============================================================
// GeminiCLIProvider — doComplete timeout (fake timers)
// ============================================================

describe('GeminiCLIProvider — doComplete timeout (fake timers)', () => {
  let provider: GeminiCLIProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockBinaryFound('agy');
    provider = new GeminiCLIProvider({
      config: { provider: 'gemini-cli', model: 'gemini-3.5-flash' },
      logger: noopLogger,
    });
    await provider.initialize();
  });

  afterEach(() => {
    provider.destroy();
    vi.useRealTimers();
  });

  it('rejects without retry when headless Gemini produces no output before timeout', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
      timeout: 5000,
    });

    vi.advanceTimersByTime(6000);

    await expect(completePromise).rejects.toMatchObject({
      code: 'AUTHENTICATION',
      retryable: false,
    });
    if (process.platform !== 'win32') {
      expect(killSpy).toHaveBeenCalledWith(-mockChild.pid, 'SIGKILL');
    }
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
    killSpy.mockRestore();
  });
});

// ============================================================
// GeminiCLIProvider — doComplete parseJsonOutput with tool calls in malformed JSON
// ============================================================

describe('GeminiCLIProvider — parseJsonOutput malformed JSON with tool calls', () => {
  let provider: GeminiCLIProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockBinaryFound('agy');
    provider = new GeminiCLIProvider({
      config: { provider: 'gemini-cli', model: 'gemini-3.5-flash' },
      logger: noopLogger,
    });
    await provider.initialize();
  });

  afterEach(() => { provider.destroy(); });

  it('extracts tool calls from malformed JSON fallback text', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    // Send non-JSON output that contains a tool call
    const rawOutput = 'Here:\n<tool_call>{"name":"get_weather","arguments":{"city":"NYC"}}</tool_call>';
    mockChild.stdout.emit('data', Buffer.from(rawOutput));
    mockChild.emit('close', 0);

    const result = await completePromise;
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBe(1);
    expect(result.finishReason).toBe('tool_calls');
  });
});

// ============================================================
// GeminiCLIProvider — doComplete EPIPE on stdin
// ============================================================

describe('GeminiCLIProvider — stdin EPIPE handling', () => {
  let provider: GeminiCLIProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockBinaryFound('agy');
    provider = new GeminiCLIProvider({
      config: { provider: 'gemini-cli', model: 'gemini-3.5-flash' },
      logger: noopLogger,
    });
    await provider.initialize();
  });

  afterEach(() => { provider.destroy(); });

  it('ignores EPIPE error on stdin', async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    // Trigger EPIPE on stdin
    const epipeErr = new Error('EPIPE') as NodeJS.ErrnoException;
    epipeErr.code = 'EPIPE';
    mockChild.stdin.emit('error', epipeErr);

    // Complete normally
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ response: 'ok' })));
    mockChild.emit('close', 0);

    const result = await completePromise;
    expect(result.content).toBe('ok');
  });

  it('logs non-EPIPE stdin errors', async () => {
    const warnLogger = { ...noopLogger, warn: vi.fn() };
    const provider2 = new GeminiCLIProvider({
      config: { provider: 'gemini-cli', model: 'gemini-3.5-flash' },
      logger: warnLogger,
    });
    vi.clearAllMocks();
    mockBinaryFound('agy');
    await provider2.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider2.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    // Non-EPIPE error
    const otherErr = new Error('some error') as NodeJS.ErrnoException;
    otherErr.code = 'OTHER';
    mockChild.stdin.emit('error', otherErr);

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ response: 'ok' })));
    mockChild.emit('close', 0);

    const result = await completePromise;
    expect(result.content).toBe('ok');
    expect(warnLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('stdin write error'),
      expect.any(Object)
    );
    provider2.destroy();
  });
});
