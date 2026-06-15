import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const childProcessMock = vi.hoisted(() => {
  const state = {
    spawn: vi.fn(),
    execSync: vi.fn(() => 'claude 2.1.167\n'),
  };
  return state;
});

vi.mock('child_process', () => ({
  spawn: childProcessMock.spawn,
  execSync: childProcessMock.execSync,
}));

import { HeadlessWorkerExecutor } from '../headless-worker-executor.js';

const originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
const originalHiveFlowHome = process.env.HIVE_FLOW_HOME;
const originalHiveFlowProjectRoot = process.env.HIVE_FLOW_PROJECT_ROOT;
const testHmacKey = 'headless-worker-dispatch-gate-test-key';
let root: string;

function writeSignedState(level: number): void {
  const enforcementDir = join(root, 'hive-home', 'enforcement');
  const globalDir = join(enforcementDir, 'global');
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(enforcementDir, '.hmac-key'), `${testHmacKey}\n`);
  const state = {
    level,
    consecutiveDenials: 0,
    lastActivity: new Date(0).toISOString(),
    history: [],
    resetAt: null,
    integrityCompromised: false,
  };
  const hmac = createHmac('sha256', testHmacKey).update(JSON.stringify(state)).digest('hex');
  writeFileSync(join(globalDir, 'state.json'), JSON.stringify({ state, hmac }, null, 2));
}

function makeChildProcess(exitCode = 0, stdoutText = '{"ok":true}\n'): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });

  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(stdoutText));
    child.emit('close', exitCode);
  });

  return child;
}

function makeExecutor(): HeadlessWorkerExecutor {
  return new HeadlessWorkerExecutor(root, {
    maxConcurrent: 1,
    defaultTimeoutMs: 250,
    logDir: join(root, '.hive-flow', 'logs', 'headless'),
    cacheContext: false,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hive-flow-headless-dispatch-gate-'));
  process.env.CLAUDE_PROJECT_DIR = root;
  process.env.HIVE_FLOW_PROJECT_ROOT = root;
  process.env.HIVE_FLOW_HOME = join(root, 'hive-home');
  childProcessMock.spawn.mockReset();
  childProcessMock.execSync.mockReset();
  childProcessMock.execSync.mockReturnValue('claude 2.1.167\n');
  childProcessMock.spawn.mockImplementation(() => makeChildProcess());
  writeSignedState(0);
});

afterEach(() => {
  if (originalProjectDir === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  }
  if (originalHiveFlowHome === undefined) {
    delete process.env.HIVE_FLOW_HOME;
  } else {
    process.env.HIVE_FLOW_HOME = originalHiveFlowHome;
  }
  if (originalHiveFlowProjectRoot === undefined) {
    delete process.env.HIVE_FLOW_PROJECT_ROOT;
  } else {
    process.env.HIVE_FLOW_PROJECT_ROOT = originalHiveFlowProjectRoot;
  }
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe('HW-1: headless worker dispatch gate', () => {
  it('blocks headless claude spawn at HALTED before launching the process', async () => {
    writeSignedState(3);
    const result = await makeExecutor().execute('audit', { timeoutMs: 250 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('[MCP ENFORCEMENT]');
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
  });

  it('blocks headless claude spawn at RESTRICTED but allows WARNED', async () => {
    writeSignedState(2);
    const restricted = await makeExecutor().execute('audit', { timeoutMs: 250 });

    expect(restricted.success).toBe(false);
    expect(restricted.error).toContain('[MCP ENFORCEMENT]');
    expect(childProcessMock.spawn).not.toHaveBeenCalled();

    writeSignedState(1);
    childProcessMock.spawn.mockClear();
    const warned = await makeExecutor().execute('audit', { timeoutMs: 250 });

    expect(warned.success).toBe(true);
    expect(childProcessMock.spawn).toHaveBeenCalledTimes(1);
    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--print']),
      expect.objectContaining({ cwd: root })
    );
  });
});
