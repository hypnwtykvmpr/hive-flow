import { describe, it, expect, vi, beforeEach, afterEach, type MockedFunction } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'child_process';

// Mock child_process before importing provider
vi.mock('child_process', () => {
  return {
    spawn: vi.fn(),
    execFile: vi.fn(),
  };
});

// Mock fs.existsSync for binary path resolution
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  };
});

import { spawn, execFile } from 'child_process';
import { existsSync } from 'fs';
import { AnthropicCLIProvider } from '../anthropic-cli-provider.js';

// Typed mock aliases
const mockSpawn = spawn as unknown as MockedFunction<(...args: Parameters<typeof spawn>) => MockChildProcess>;
const mockExecFile = execFile as MockedFunction<typeof execFile>;
const mockExistsSync = existsSync as MockedFunction<typeof existsSync>;

/** Mock stdout shape needed by provider */
interface MockStdout extends EventEmitter {
  resume: ReturnType<typeof vi.fn>;
}

/** Mock stderr shape */
interface MockStderr extends EventEmitter {
  resume: ReturnType<typeof vi.fn>;
}

/** Mock child process shape */
interface MockChildProcess extends EventEmitter {
  stdout: MockStdout;
  stderr: MockStderr;
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
}

// Helper: create a mock child process
function createMockChild(): MockChildProcess {
  const child = Object.assign(new EventEmitter(), {
    killed: false,
    pid: 12345,
  }) as unknown as MockChildProcess;

  const stdout = Object.assign(new EventEmitter(), {
    resume: vi.fn(),
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
 * Mock execFile for "which claude" and "--version" calls.
 *
 * findBinary uses whichBinary which calls: execFile(cmd, ['claude'], callback)  — 3 args
 * runVersion calls: execFile(path, ['--version'], { timeout }, callback) — 4 args
 */
function mockBinaryFoundViaWhich(version: string = '1.0.0') {
  // existsSync returns false for CLAUDE_PATH, ~/.claude/local/claude, etc.
  mockExistsSync.mockReturnValue(false);

  mockExecFile.mockImplementation(
    (cmd: string, args: string[], optOrCb: any, cb?: any) => {
      if (typeof optOrCb === 'function') {
        // 3-arg call: which/where
        const callback = optOrCb;
        if (args[0] === 'claude') {
          callback(null, '/usr/local/bin/claude\n', '');
        } else {
          callback(new Error('not found'), '', '');
        }
      } else {
        // 4-arg call: --version
        const callback = cb!;
        callback(null, version, '');
      }
    },
  );
}

function mockBinaryFoundViaCLAUDE_PATH(path: string) {
  mockExistsSync.mockImplementation((p: any) => p === path);

  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], optOrCb: any, cb?: any) => {
      const callback = typeof optOrCb === 'function' ? optOrCb : cb!;
      callback(null, '1.0.0', '');
    },
  );
}

function mockBinaryNotFound() {
  mockExistsSync.mockReturnValue(false);

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
// AnthropicCLIProvider
// ============================================================

describe('AnthropicCLIProvider', () => {
  let provider: AnthropicCLIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CLAUDE_PATH;
    provider = new AnthropicCLIProvider({
      config: { provider: 'anthropic-cli', model: 'claude-3-5-sonnet-latest' },
      logger: noopLogger,
    });
  });

  afterEach(() => {
    provider.destroy();
  });

  // ── Binary discovery ──

  it('finds binary via CLAUDE_PATH env var', async () => {
    const customPath = '/custom/path/to/claude';
    process.env.CLAUDE_PATH = customPath;
    mockBinaryFoundViaCLAUDE_PATH(customPath);

    await provider.initialize();
    // Should not throw — binary found via env
  });

  it('finds binary via which claude', async () => {
    mockBinaryFoundViaWhich('Claude 1.2.3');
    await provider.initialize();
    // Should not throw
  });

  it('warns but does not throw when binary not found', async () => {
    mockBinaryNotFound();
    await provider.initialize();
    // Should not throw — just warns
  });

  // ── Completion ──

  it('completes with valid JSON response', async () => {
    mockBinaryFoundViaWhich();
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Hello! How can I help you?',
      cost_usd: 0.002,
      input_tokens: 15,
      output_tokens: 8,
    });
    mockChild.stdout.emit('data', Buffer.from(output));
    mockChild.emit('close', 0);

    const result = await completePromise;
    expect(result.content).toBe('Hello! How can I help you?');
    expect(result.provider).toBe('anthropic-cli');
    expect(result.usage.promptTokens).toBe(15);
    expect(result.usage.completionTokens).toBe(8);
    expect(result.cost?.totalCost).toBeCloseTo(0.002);
  });

  it('delivers prompt via stdin (not command arg)', async () => {
    mockBinaryFoundViaWhich();
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    provider.complete({ messages: [{ role: 'user', content: 'test prompt' }] });

    expect(mockChild.stdin.write).toHaveBeenCalledWith(expect.stringContaining('test prompt'));
    expect(mockChild.stdin.end).toHaveBeenCalled();

    // Clean up
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'ok' })));
    mockChild.emit('close', 0);
  });

  it('passes --print and --output-format json', async () => {
    mockBinaryFoundViaWhich();
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    provider.complete({ messages: [{ role: 'user', content: 'test' }] });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain('--print');
    expect(spawnArgs).toContain('--output-format');
    expect(spawnArgs).toContain('json');

    // Clean up
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'ok' })));
    mockChild.emit('close', 0);
  });

  it('passes request-scoped env vars to the spawned CLI process', async () => {
    mockBinaryFoundViaWhich();
    provider = new AnthropicCLIProvider({
      config: {
        provider: 'anthropic-cli',
        model: 'claude-3-5-sonnet-latest',
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

  // ── Timeout ──

  it('rejects on timeout (default 120s)', async () => {
    mockBinaryFoundViaWhich();
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    vi.useFakeTimers();

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'slow task' }],
    });

    // Advance past 120s timeout
    vi.advanceTimersByTime(120001);

    await expect(completePromise).rejects.toThrow(/timed out/i);
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

    vi.useRealTimers();
  });

  // ── Non-zero exit code ──

  it('rejects on non-zero exit code', async () => {
    mockBinaryFoundViaWhich();
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.stderr.emit('data', Buffer.from('Something went wrong'));
    mockChild.emit('close', 1);

    await expect(completePromise).rejects.toThrow(/Something went wrong/);
  });

  // ── is_error in JSON response ──

  it('maps is_error: true to provider error', async () => {
    mockBinaryFoundViaWhich();
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    const output = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'Rate limit exceeded',
    });
    mockChild.stdout.emit('data', Buffer.from(output));
    mockChild.emit('close', 0);

    await expect(completePromise).rejects.toThrow(/Rate limit exceeded/);
  });

  // ── Malformed JSON fallback ──

  it('falls back to raw text on malformed JSON', async () => {
    mockBinaryFoundViaWhich();
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    // Send non-JSON output
    mockChild.stdout.emit('data', Buffer.from('This is raw text output'));
    mockChild.emit('close', 0);

    const result = await completePromise;
    expect(result.content).toBe('This is raw text output');
    expect(result.provider).toBe('anthropic-cli');
  });

  // ── Budget argument ──

  it('includes --max-budget-usd when budgetAllocation is set', async () => {
    mockBinaryFoundViaWhich();
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    provider.complete({
      messages: [{ role: 'user', content: 'test' }],
      metadata: { budgetAllocation: 0.50 },
    });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain('--max-budget-usd');
    expect(spawnArgs).toContain('0.5');

    // Clean up
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'ok' })));
    mockChild.emit('close', 0);
  });

  it('omits --max-budget-usd when budgetAllocation is not set', async () => {
    mockBinaryFoundViaWhich();
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--max-budget-usd');

    // Clean up
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'ok' })));
    mockChild.emit('close', 0);
  });

  // ── Destroy ──

  it('kills active children on destroy', async () => {
    mockBinaryFoundViaWhich();
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    // Start a request (won't resolve — we destroy before it completes)
    provider.complete({ messages: [{ role: 'user', content: 'test' }] }).catch(() => {});

    provider.destroy();

    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
  });

  // ── Empty stdout ──

  it('rejects with EMPTY_RESPONSE on empty stdout', async () => {
    mockBinaryFoundViaWhich();
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    // Send empty output (malformed JSON path → empty content)
    mockChild.stdout.emit('data', Buffer.from(''));
    mockChild.emit('close', 0);

    await expect(completePromise).rejects.toThrow(/empty/i);
  });

  // ── Spawn error event ──

  it('rejects on spawn error event', async () => {
    mockBinaryFoundViaWhich();
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    mockChild.emit('error', new Error('ENOENT: binary not found'));

    await expect(completePromise).rejects.toThrow(/ENOENT/);
  });

  // ── Binary not found throws on complete ──

  it('throws ProviderUnavailableError when completing without binary', async () => {
    mockBinaryNotFound();
    await provider.initialize();

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'test' }] })
    ).rejects.toThrow(/not found/i);
  });

  // ── JSON with empty result field ──

  it('rejects when JSON result field is empty string', async () => {
    mockBinaryFoundViaWhich();
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    const output = JSON.stringify({
      type: 'result',
      is_error: false,
      result: '',
    });
    mockChild.stdout.emit('data', Buffer.from(output));
    mockChild.emit('close', 0);

    await expect(completePromise).rejects.toThrow(/empty/i);
  });

  // ── System message formatting ──

  it('formats system messages with System: prefix', async () => {
    mockBinaryFoundViaWhich();
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    provider.complete({
      messages: [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' },
      ],
    });

    const writtenPrompt = mockChild.stdin.write.mock.calls[0][0] as string;
    expect(writtenPrompt).toContain('System:');
    expect(writtenPrompt).toContain('You are a helpful assistant');
    expect(writtenPrompt).toContain('User: Hello');

    // Clean up
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'ok' })));
    mockChild.emit('close', 0);
  });

  // ── listModels ──

  it('returns list of supported models', async () => {
    const models = await provider.listModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    expect(models).toContain('claude-sonnet-4-6');
  });

  // ── getModelInfo ──

  it('returns model info with pricing', async () => {
    const info = await provider.getModelInfo('claude-sonnet-4-6');
    expect(info.model).toBe('claude-sonnet-4-6');
    expect(info.contextLength).toBe(200000);
    expect(info.supportedFeatures).toContain('cli-subprocess');
    expect(info.pricing).toBeDefined();
    expect(info.pricing!.promptCostPer1k).toBeGreaterThan(0);
  });

  // ── Custom timeout ──

  it('uses custom timeout from request', async () => {
    mockBinaryFoundViaWhich();
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    vi.useFakeTimers();

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'fast task' }],
      timeout: 5000,
    });

    // Advance past the custom 5s timeout
    vi.advanceTimersByTime(5001);

    await expect(completePromise).rejects.toThrow(/timed out/i);

    vi.useRealTimers();
  });

  // ── Cost splitting with reported cost ──

  it('splits reported cost proportionally between prompt and completion tokens', async () => {
    mockBinaryFoundViaWhich();
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    const output = JSON.stringify({
      type: 'result',
      result: 'response',
      cost_usd: 0.01,
      input_tokens: 80,
      output_tokens: 20,
    });
    mockChild.stdout.emit('data', Buffer.from(output));
    mockChild.emit('close', 0);

    const result = await completePromise;
    // 80/(80+20) = 0.8 * 0.01 = 0.008 for prompt
    expect(result.cost?.promptCost).toBeCloseTo(0.008);
    // 20/(80+20) = 0.2 * 0.01 = 0.002 for completion
    expect(result.cost?.completionCost).toBeCloseTo(0.002);
    expect(result.cost?.totalCost).toBeCloseTo(0.01);
  });

  // ── Non-zero exit code with empty stderr uses default message ──

  it('uses default message when exit code non-zero but stderr empty', async () => {
    mockBinaryFoundViaWhich();
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });

    // No stderr, just close with code 2
    mockChild.emit('close', 2);

    await expect(completePromise).rejects.toThrow(/exited with code 2/);
  });

  // ── Health check when binary not found ──

  it('returns unhealthy when binary not found during health check', async () => {
    mockBinaryNotFound();
    // Create a fresh provider and initialize (binary won't be found)
    const freshProvider = new AnthropicCLIProvider({
      config: { provider: 'anthropic-cli', model: 'claude-3-5-sonnet-latest' },
      logger: noopLogger,
    });
    await freshProvider.initialize();

    // Access healthCheck through the public method on base class
    const health = await freshProvider.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.error).toContain('not found');

    freshProvider.destroy();
  });

  // ── stdin EPIPE suppression ──

  it('suppresses EPIPE errors on stdin', async () => {
    mockBinaryFoundViaWhich();
    await provider.initialize();

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    }).catch(() => {});

    // Emit EPIPE error on stdin — should not throw
    const epipeError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(() => {
      mockChild.stdin.emit('error', epipeError);
    }).not.toThrow();

    // Clean up
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'ok' })));
    mockChild.emit('close', 0);
  });
});
