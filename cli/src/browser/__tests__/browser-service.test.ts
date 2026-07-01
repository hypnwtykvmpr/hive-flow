/**
 * @hive-flow/cli/browser - Browser Service Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { BrowserService, createBrowserService } from '../application/browser-service.js';

const childProcessMocks = vi.hoisted(() => {
  const execFile = vi.fn((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(null, JSON.stringify({ success: true, data: { test: 'value' } }), '');
    return undefined;
  });
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
    execSync: vi.fn(() => JSON.stringify({ success: true, data: { test: 'value' } })),
    spawn: vi.fn(),
  };
});

// Mock agent-browser CLI execution.
vi.mock('child_process', () => childProcessMocks);

describe('BrowserService', () => {
  let service: BrowserService;

  beforeEach(() => {
    service = createBrowserService({ sessionId: 'test-session' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createBrowserService', () => {
    it('should create a browser service with default options', () => {
      const svc = createBrowserService();
      expect(svc).toBeInstanceOf(BrowserService);
    });

    it('should create a browser service with custom session', () => {
      const svc = createBrowserService({ sessionId: 'custom-session' });
      expect(svc).toBeInstanceOf(BrowserService);
    });
  });

  describe('trajectory tracking', () => {
    it('should start a trajectory', () => {
      const id = service.startTrajectory('test task');
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(id.startsWith('traj-')).toBe(true);
    });

    it('should end a trajectory', async () => {
      service.startTrajectory('test task');
      const trajectory = await service.endTrajectory(true, 'success');

      expect(trajectory).toBeDefined();
      expect(trajectory?.goal).toBe('test task');
      expect(trajectory?.success).toBe(true);
      expect(trajectory?.verdict).toBe('success');
    });

    it('should return null if no trajectory is active', async () => {
      const trajectory = await service.endTrajectory(true);
      expect(trajectory).toBeNull();
    });
  });

  describe('navigation', () => {
    it('should navigate to a URL', async () => {
      const result = await service.open('https://example.com');
      expect(result).toBeDefined();
    });

    it('should close the browser', async () => {
      const result = await service.close();
      expect(result).toBeDefined();
    });
  });

  describe('snapshot', () => {
    it('should take a snapshot with default options', async () => {
      const result = await service.snapshot();
      expect(result).toBeDefined();
    });

    it('should take a snapshot with interactive option', async () => {
      const result = await service.snapshot({ interactive: true });
      expect(result).toBeDefined();
    });
  });

  describe('interaction', () => {
    it('should click an element', async () => {
      const result = await service.click('@e1');
      expect(result).toBeDefined();
    });

    it('should fill an input', async () => {
      const result = await service.fill('@e1', 'test value');
      expect(result).toBeDefined();
    });

    it('should type text', async () => {
      const result = await service.type('@e1', 'typed text');
      expect(result).toBeDefined();
    });

    it('should press a key', async () => {
      const result = await service.press('Enter');
      expect(result).toBeDefined();
    });
  });

  describe('wait', () => {
    it('should wait for an element', async () => {
      const result = await service.wait({ selector: '#element' });
      expect(result).toBeDefined();
    });
  });

  describe('data extraction', () => {
    it('should get text from element', async () => {
      const result = await service.getText('@e1');
      expect(result).toBeDefined();
    });

    it('should evaluate JavaScript', async () => {
      const result = await service.eval('document.title');
      expect(result).toBeDefined();
    });
  });

  describe('screenshot', () => {
    it('should take a screenshot', async () => {
      const result = await service.screenshot();
      expect(result).toBeDefined();
    });

    it('should take a screenshot with path', async () => {
      const result = await service.screenshot({ path: '/tmp/test.png' });
      expect(result).toBeDefined();
    });
  });
});
