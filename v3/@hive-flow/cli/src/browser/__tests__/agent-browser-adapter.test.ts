/**
 * @hive-flow/cli/browser - Agent Browser Adapter Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AgentBrowserAdapter } from '../infrastructure/agent-browser-adapter.js';
import { execFile } from 'child_process';

const childProcessMocks = vi.hoisted(() => {
  const execFile = vi.fn();
  const execFileAsync = vi.fn(
    (...args: unknown[]) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile(...args, (error: Error | null, stdout = '', stderr = '') => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
      }),
  );

  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: execFileAsync,
  });

  return {
    execFile,
    spawn: vi.fn(),
  };
});

// Mock execFile
vi.mock('child_process', () => childProcessMocks);

const mockExecFile = vi.mocked(execFile);

function mockExecFileSuccess(output: unknown): void {
  const stdout = typeof output === 'string' ? output : JSON.stringify(output);
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(null, stdout, '');
    return undefined as never;
  });
}

function lastExecArgs(): string[] {
  const call = mockExecFile.mock.calls.at(-1);
  return (call?.[1] ?? []) as string[];
}

describe('AgentBrowserAdapter', () => {
  let adapter: AgentBrowserAdapter;

  beforeEach(() => {
    adapter = new AgentBrowserAdapter({
      session: 'test-session',
      timeout: 5000,
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create adapter with default options', () => {
      const defaultAdapter = new AgentBrowserAdapter();
      expect(defaultAdapter).toBeInstanceOf(AgentBrowserAdapter);
    });

    it('should create adapter with custom options', () => {
      const customAdapter = new AgentBrowserAdapter({
        session: 'custom',
        timeout: 10000,
        headless: false,
        debug: true,
      });
      expect(customAdapter).toBeInstanceOf(AgentBrowserAdapter);
    });
  });

  describe('navigation', () => {
    it('should open a URL', async () => {
      mockExecFileSuccess(JSON.stringify({
        success: true,
        data: { url: 'https://example.com' },
      }));

      const result = await adapter.open({ url: 'https://example.com' });

      expect(result.success).toBe(true);
      expect(mockExecFile).toHaveBeenCalled();
      const callArgs = lastExecArgs();
      expect(callArgs).toContain('open');
      expect(callArgs).toContain('https://example.com');
    });

    it('should go back', async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }));

      const result = await adapter.back();

      expect(result.success).toBe(true);
      expect(mockExecFile).toHaveBeenCalled();
    });

    it('should go forward', async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }));

      const result = await adapter.forward();

      expect(result.success).toBe(true);
    });

    it('should reload', async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }));

      const result = await adapter.reload();

      expect(result.success).toBe(true);
    });

    it('should close', async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }));

      const result = await adapter.close();

      expect(result.success).toBe(true);
    });
  });

  describe('interaction', () => {
    it('should click an element', async () => {
      mockExecFileSuccess(JSON.stringify({
        success: true,
        data: { clicked: true },
      }));

      const result = await adapter.click({ target: '@e1' });

      expect(result.success).toBe(true);
      const callArgs = lastExecArgs();
      expect(callArgs).toContain('click');
      expect(callArgs).toContain('@e1');
    });

    it('should fill an input', async () => {
      mockExecFileSuccess(JSON.stringify({
        success: true,
        data: { filled: true },
      }));

      const result = await adapter.fill({ target: '@e1', value: 'test' });

      expect(result.success).toBe(true);
      const callArgs = lastExecArgs();
      expect(callArgs).toContain('fill');
    });

    it('should type text', async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }));

      const result = await adapter.type({ target: '@e1', text: 'hello' });

      expect(result.success).toBe(true);
      const callArgs = lastExecArgs();
      expect(callArgs).toContain('type');
    });

    it('should press a key', async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }));

      const result = await adapter.press('Enter');

      expect(result.success).toBe(true);
      const callArgs = lastExecArgs();
      expect(callArgs).toContain('press');
      expect(callArgs).toContain('Enter');
    });

    it('should hover an element', async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }));

      const result = await adapter.hover('@e1');

      expect(result.success).toBe(true);
    });

    it('should scroll', async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }));

      const result = await adapter.scroll('down', 500);

      expect(result.success).toBe(true);
    });
  });

  describe('information retrieval', () => {
    it('should get text', async () => {
      mockExecFileSuccess(JSON.stringify({
        success: true,
        data: 'Element text',
      }));

      const result = await adapter.getText('@e1');

      expect(result.success).toBe(true);
      expect(result.data).toBe('Element text');
    });

    it('should get title', async () => {
      mockExecFileSuccess(JSON.stringify({
        success: true,
        data: 'Page Title',
      }));

      const result = await adapter.getTitle();

      expect(result.success).toBe(true);
    });

    it('should get URL', async () => {
      mockExecFileSuccess(JSON.stringify({
        success: true,
        data: 'https://example.com',
      }));

      const result = await adapter.getUrl();

      expect(result.success).toBe(true);
    });
  });

  describe('state checks', () => {
    it('should check visibility', async () => {
      mockExecFileSuccess(JSON.stringify({
        success: true,
        data: true,
      }));

      const result = await adapter.isVisible('@e1');

      expect(result.success).toBe(true);
      expect(result.data).toBe(true);
    });

    it('should check if enabled', async () => {
      mockExecFileSuccess(JSON.stringify({
        success: true,
        data: true,
      }));

      const result = await adapter.isEnabled('@e1');

      expect(result.success).toBe(true);
    });
  });

  describe('snapshot', () => {
    it('should take a snapshot', async () => {
      mockExecFileSuccess(JSON.stringify({
        success: true,
        data: {
          tree: { role: 'document', children: [] },
          refs: {},
          url: 'https://example.com',
          title: 'Test',
        },
      }));

      const result = await adapter.snapshot();

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('should take interactive snapshot', async () => {
      mockExecFileSuccess(JSON.stringify({
        success: true,
        data: { tree: { role: 'document' } },
      }));

      const result = await adapter.snapshot({ interactive: true });

      expect(result.success).toBe(true);
      const callArgs = lastExecArgs();
      expect(callArgs).toContain('-i');
    });

    it('should take compact snapshot', async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }));

      const result = await adapter.snapshot({ compact: true });

      const callArgs = lastExecArgs();
      expect(callArgs).toContain('-c');
    });
  });

  describe('screenshot', () => {
    it('should take a screenshot', async () => {
      mockExecFileSuccess(JSON.stringify({
        success: true,
        data: 'base64encodedimage',
      }));

      const result = await adapter.screenshot();

      expect(result.success).toBe(true);
    });

    it('should take full page screenshot', async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }));

      const result = await adapter.screenshot({ fullPage: true });

      const callArgs = lastExecArgs();
      expect(callArgs).toContain('--full');
    });
  });

  describe('wait', () => {
    it('should wait for selector', async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }));

      const result = await adapter.wait({ selector: '#element' });

      expect(result.success).toBe(true);
    });

    it('should wait for timeout', async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }));

      const result = await adapter.wait({ timeout: 1000 });

      expect(result.success).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle command failure', async () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const callback = args.at(-1) as (error: Error) => void;
        callback(new Error('Command failed'));
        return undefined as never;
      });

      const result = await adapter.open({ url: 'https://example.com' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Command failed');
    });

    it('should handle invalid JSON response', async () => {
      mockExecFileSuccess('invalid json');

      const result = await adapter.open({ url: 'https://example.com' });

      // Should fall back to raw string
      expect(result.success).toBe(true);
    });
  });
});
