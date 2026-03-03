import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
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

// Helper: create a mock child process
function createMockChild(): ChildProcess & {
  stdout: EventEmitter & { resume: ReturnType<typeof vi.fn>; pipe: ReturnType<typeof vi.fn> };
  stderr: EventEmitter & { resume: ReturnType<typeof vi.fn> };
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
} {
  const child = new EventEmitter() as any;

  // stdout needs Readable-stream methods because readline.createInterface calls them
  const stdout = new EventEmitter() as any;
  stdout.resume = vi.fn();
  stdout.pause = vi.fn();
  stdout.pipe = vi.fn();
  stdout.setEncoding = vi.fn();
  stdout.isPaused = vi.fn(() => false);
  stdout.unpipe = vi.fn();
  child.stdout = stdout;

  const stderr = new EventEmitter() as any;
  stderr.resume = vi.fn();
  child.stderr = stderr;

  const stdinEmitter = new EventEmitter();
  child.stdin = Object.assign(stdinEmitter, { write: vi.fn(), end: vi.fn() });
  child.killed = false;
  child.kill = vi.fn((_signal?: string) => {
    child.killed = true;
    return true;
  });
  child.pid = 12345;
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
  (execFile as any).mockImplementation(
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
  (execFile as any).mockImplementation(
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
      config: { provider: 'gemini-cli', model: 'gemini-3.1-pro-preview' },
      logger: noopLogger,
    });
  });

  afterEach(() => {
    provider.destroy();
  });

  it('initializes with binary found', async () => {
    mockBinaryFound('gemini', 'Gemini CLI 0.30.0');
    await provider.initialize();
    // Should not throw
  });

  it('initializes with binary not found (warns but does not throw)', async () => {
    mockBinaryNotFound();
    await provider.initialize();
    // Should not throw — just warns
  });

  it('completes with valid JSON output', async () => {
    mockBinaryFound('gemini');
    await provider.initialize();

    const mockChild = createMockChild();
    (spawn as any).mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    // Simulate successful Gemini JSON output
    const output = JSON.stringify({
      response: 'Hello! How can I help?',
      stats: {
        models: {
          'gemini-3.1-pro-preview': {
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
    mockBinaryFound('gemini');
    await provider.initialize();

    const mockChild = createMockChild();
    (spawn as any).mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    // --sandbox is opt-in — not present by default
    const spawnArgs = (spawn as any).mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--sandbox');

    // Clean up
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ response: 'ok' })));
    mockChild.emit('close', 0);
    await completePromise;
  });

  it('passes --sandbox when sandbox=true in config', async () => {
    mockBinaryFound('gemini');
    const sandboxProvider = new GeminiCLIProvider({
      config: { provider: 'gemini-cli', model: 'gemini-2.5-pro', sandbox: true },
      logger: noopLogger,
    });
    await sandboxProvider.initialize();

    const mockChild = createMockChild();
    (spawn as any).mockReturnValue(mockChild);

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

  it('writes prompt to stdin and closes it', async () => {
    mockBinaryFound('gemini');
    await provider.initialize();

    const mockChild = createMockChild();
    (spawn as any).mockReturnValue(mockChild);

    provider.complete({ messages: [{ role: 'user', content: 'test' }] });

    expect(mockChild.stdin.write).toHaveBeenCalledWith(expect.stringContaining('test'));
    expect(mockChild.stdin.end).toHaveBeenCalled();

    // Clean up
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ response: 'ok' })));
    mockChild.emit('close', 0);
  });

  it('rejects on non-zero exit code', async () => {
    mockBinaryFound('gemini');
    await provider.initialize();

    const mockChild = createMockChild();
    (spawn as any).mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.stderr.emit('data', Buffer.from('Auth failed'));
    mockChild.emit('close', 41); // Auth exit code

    await expect(completePromise).rejects.toThrow(/auth/i);
  });

  it('rejects with specific message on exit code 42 (empty prompt)', async () => {
    mockBinaryFound('gemini');
    await provider.initialize();

    const mockChild = createMockChild();
    (spawn as any).mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: '' }],
    });

    mockChild.emit('close', 42);

    await expect(completePromise).rejects.toThrow(/empty or invalid prompt/i);
  });

  it('streams with stream-json events', async () => {
    mockBinaryFound('gemini');
    await provider.initialize();

    // Gemini doStreamComplete uses `for await (const line of rl)` on readline,
    // which requires a real Readable stream (not just an EventEmitter mock).
    // Create a custom mock child with PassThrough stdout for proper readline support.
    const child = new EventEmitter() as any;
    const stdout = new PassThrough();
    child.stdout = stdout;
    const stderr = new EventEmitter() as any;
    stderr.resume = vi.fn();
    child.stderr = stderr;
    const stdinEmitter = new EventEmitter();
    child.stdin = Object.assign(stdinEmitter, { write: vi.fn(), end: vi.fn() });
    child.stdin.on('error', () => {}); // Prevent EPIPE unhandled errors
    child.killed = false;
    child.kill = vi.fn((_signal?: string) => { child.killed = true; return true; });
    child.pid = 12345;

    (spawn as any).mockReturnValue(child);

    const events: any[] = [];
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
    stdout.write(JSON.stringify({ response: 'Hello ' }) + '\n');
    stdout.write(JSON.stringify({ response: 'world!' }) + '\n');
    stdout.end();
    child.emit('close', 0);

    await streamPromise;

    const contentEvents = events.filter(e => e.type === 'content');
    expect(contentEvents.length).toBeGreaterThan(0);
    expect(contentEvents[0].delta.content).toBe('Hello ');
    expect(contentEvents[1].delta.content).toBe('world!');

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
      config: { provider: 'codex-cli', model: undefined as any },
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
      config: { provider: 'codex-cli', model: 'auto' as any },
      logger: noopLogger,
    });
    await provider.initialize();

    const mockChild = createMockChild();
    (spawn as any).mockReturnValue(mockChild);

    provider.complete({ messages: [{ role: 'user', content: 'test' }] });

    const spawnArgs = (spawn as any).mock.calls[0][1] as string[];
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
    (spawn as any).mockReturnValue(mockChild);

    provider.complete({ messages: [{ role: 'user', content: 'test' }] });

    const spawnArgs = (spawn as any).mock.calls[0][1] as string[];
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
    (spawn as any).mockReturnValue(mockChild);

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

  it('completes with item.completed and turn.completed events', async () => {
    mockBinaryFound('codex');
    await provider.initialize();

    const mockChild = createMockChild();
    (spawn as any).mockReturnValue(mockChild);

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
    (spawn as any).mockReturnValue(mockChild);

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
    (spawn as any).mockReturnValue(mockChild);

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
    (spawn as any).mockReturnValue(mockChild);

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
    (spawn as any).mockReturnValue(mockChild);

    provider.complete({ messages: [{ role: 'user', content: 'test' }] });

    // Verify API key is NOT in args
    const spawnArgs = (spawn as any).mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--api-key');
    expect(spawnArgs).not.toContain('test-key-123');

    // Verify API key IS in env
    const spawnEnv = (spawn as any).mock.calls[0][2].env;
    expect(spawnEnv.CURSOR_API_KEY).toBe('test-key-123');

    // Clean up
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'ok' })));
    mockChild.emit('close', 0);
  });

  it('completes with JSON output', async () => {
    mockBinaryFound('cursor-agent');
    await provider.initialize();

    const mockChild = createMockChild();
    (spawn as any).mockReturnValue(mockChild);

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
    (spawn as any).mockReturnValue(mockChild);

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
    (spawn as any).mockReturnValue(mockChild);

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
