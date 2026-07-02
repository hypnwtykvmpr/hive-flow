import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const sentinelRecoveryPath = resolve(repoRoot, '.claude/helpers/sentinel-recovery.cjs');
const watcherScript = resolve(repoRoot, 'scripts/hive-watcher.cjs');

const fs = require('node:fs');
const childProcess = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const originalEnv = {
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
  HIVE_FLOW_PROJECT_ROOT: process.env.HIVE_FLOW_PROJECT_ROOT,
};
let tempDirs: string[] = [];

function loadSentinelRecovery(): any {
  delete require.cache[require.resolve(sentinelRecoveryPath)];
  return require(sentinelRecoveryPath);
}

function existsError(): NodeJS.ErrnoException {
  const err = new Error('lock exists') as NodeJS.ErrnoException;
  err.code = 'EEXIST';
  return err;
}

function mockSpawn(pid = 12_345) {
  const unref = vi.fn();
  const spawn = vi.spyOn(childProcess, 'spawn').mockReturnValue({ pid, unref } as any);
  return { spawn, unref };
}

function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-recovery-'));
  tempDirs.push(dir);
  return dir;
}

function useProjectRoot(projectRoot: string) {
  process.env.CLAUDE_PROJECT_DIR = projectRoot;
  delete process.env.HIVE_FLOW_PROJECT_ROOT;
  return loadSentinelRecovery();
}

function writeWatcherScript(projectRoot: string) {
  const scriptDir = path.join(projectRoot, 'scripts');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(path.join(scriptDir, 'hive-watcher.cjs'), '#!/usr/bin/env node\n', 'utf8');
}

function writeActiveHive(projectRoot: string, hiveId: string, ownerSessionId = 'owner-session') {
  const hiveDir = path.join(projectRoot, '.hive-flow', 'hives', hiveId);
  fs.mkdirSync(hiveDir, { recursive: true });
  fs.writeFileSync(path.join(hiveDir, 'hive.json'), JSON.stringify({
    hiveId,
    status: 'active',
    ownerSessionId,
  }, null, 2), 'utf8');
}

function writeWatcher(projectRoot: string, hiveId: string, data: Record<string, unknown>) {
  const dataDir = path.join(projectRoot, '.hive-flow', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const watcherPath = path.join(dataDir, `watcher-${hiveId}.json`);
  fs.writeFileSync(watcherPath, JSON.stringify({
    hiveId,
    updatedAt: new Date().toISOString(),
    ...data,
  }, null, 2), 'utf8');
  return watcherPath;
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalEnv.CLAUDE_PROJECT_DIR === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = originalEnv.CLAUDE_PROJECT_DIR;
  if (originalEnv.HIVE_FLOW_PROJECT_ROOT === undefined) delete process.env.HIVE_FLOW_PROJECT_ROOT;
  else process.env.HIVE_FLOW_PROJECT_ROOT = originalEnv.HIVE_FLOW_PROJECT_ROOT;
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('sentinel watcher singleton spawn guard', () => {
  it('does not spawn when a fresh watcher lock already exists', () => {
    const sentinel = loadSentinelRecovery();
    expect(typeof sentinel.spawnDetachedWatcher).toBe('function');
    expect(fs.existsSync(watcherScript)).toBe(true);

    vi.spyOn(fs, 'mkdirSync').mockImplementation((target: any) => {
      if (String(target).endsWith('watcher-hive-test-001.lock')) throw existsError();
      return undefined as any;
    });
    vi.spyOn(fs, 'statSync').mockReturnValue({ mtimeMs: Date.now() } as any);
    const { spawn } = mockSpawn();

    expect(sentinel.spawnDetachedWatcher('hive-test-001', null)).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns and unrefs when no watcher lock exists', () => {
    const sentinel = loadSentinelRecovery();
    expect(fs.existsSync(watcherScript)).toBe(true);

    const mkdir = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined as any);
    const rmdir = vi.spyOn(fs, 'rmdirSync').mockReturnValue(undefined as any);
    const { spawn, unref } = mockSpawn(12_345);

    expect(sentinel.spawnDetachedWatcher('hive-test-001', '%3', 'owner-session')).toBe(12_345);
    expect(mkdir).toHaveBeenCalledWith(expect.stringMatching(/watcher-hive-test-001\.lock$/));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).toEqual([
      watcherScript,
      'hive-test-001',
      '--project-dir',
      repoRoot,
      '--sessionId',
      'owner-session',
    ]);
    expect(spawn.mock.calls[0][1]).not.toContain('--tmux-pane');
    expect(spawn.mock.calls[0][2]).toMatchObject({
      detached: true,
      stdio: 'ignore',
      cwd: repoRoot,
    });
    expect(spawn.mock.calls[0][2].env.CLAUDE_PROJECT_DIR).toBe(repoRoot);
    expect(unref).toHaveBeenCalledTimes(1);
    expect(rmdir).toHaveBeenCalledWith(expect.stringMatching(/watcher-hive-test-001\.lock$/));
  });

  it('clears a stale watcher lock and then spawns', () => {
    const sentinel = loadSentinelRecovery();
    expect(fs.existsSync(watcherScript)).toBe(true);

    let mkdirCalls = 0;
    vi.spyOn(fs, 'mkdirSync').mockImplementation((target: any) => {
      if (String(target).endsWith('watcher-hive-test-001.lock')) {
        mkdirCalls += 1;
        if (mkdirCalls === 1) throw existsError();
      }
      return undefined as any;
    });
    vi.spyOn(fs, 'statSync').mockReturnValue({ mtimeMs: Date.now() - 60_000 } as any);
    const rmdir = vi.spyOn(fs, 'rmdirSync').mockReturnValue(undefined as any);
    const { spawn, unref } = mockSpawn(54_321);

    expect(sentinel.spawnDetachedWatcher('hive-test-001', null)).toBe(54_321);
    expect(mkdirCalls).toBe(2);
    expect(rmdir).toHaveBeenCalledWith(expect.stringMatching(/watcher-hive-test-001\.lock$/));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('does not respawn a stale-heartbeat watcher while its PID is alive', () => {
    const projectRoot = makeTempProject();
    writeWatcherScript(projectRoot);
    writeActiveHive(projectRoot, 'hive-live');
    const watcherPath = writeWatcher(projectRoot, 'hive-live', {
      watcherPid: process.pid,
      updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const sentinel = useProjectRoot(projectRoot);
    const { spawn } = mockSpawn(22_222);

    expect(sentinel.recoverSentinelWatchers()).toEqual({});
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(watcherPath)).toBe(true);
  });

  it('respawns a stale-heartbeat watcher when its PID is ESRCH-dead', () => {
    const projectRoot = makeTempProject();
    const deadPid = 33_333;
    writeWatcherScript(projectRoot);
    writeActiveHive(projectRoot, 'hive-dead');
    const watcherPath = writeWatcher(projectRoot, 'hive-dead', {
      watcherPid: deadPid,
      updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    vi.spyOn(process, 'kill').mockImplementation(((pid: any, signal?: any) => {
      if (Number(pid) === deadPid && signal === 0) {
        const err = new Error('dead process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    }) as any);
    const sentinel = useProjectRoot(projectRoot);
    const { spawn } = mockSpawn(44_444);

    const output = sentinel.recoverSentinelWatchers();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(watcherPath)).toBe(false);
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(output.hookSpecificOutput.additionalContext).toContain('watcher died (pid-dead), auto-respawned (pid=44444)');
  });

  it('preserves no-PID legacy recovery behavior for stale watcher records', () => {
    const projectRoot = makeTempProject();
    writeWatcherScript(projectRoot);
    writeActiveHive(projectRoot, 'hive-no-pid');
    writeWatcher(projectRoot, 'hive-no-pid', {
      updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const sentinel = useProjectRoot(projectRoot);
    const { spawn } = mockSpawn(55_555);

    const output = sentinel.recoverSentinelWatchers();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(output.hookSpecificOutput.additionalContext).toContain('hive-no-pid: watcher died (pid-dead), auto-respawned (pid=55555)');
  });

  it('keeps normal recovery notification text when respawn is unavailable', () => {
    const projectRoot = makeTempProject();
    writeActiveHive(projectRoot, 'hive-manual');
    writeWatcher(projectRoot, 'hive-manual', {
      updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const sentinel = useProjectRoot(projectRoot);
    const { spawn } = mockSpawn(66_666);

    const output = sentinel.recoverSentinelWatchers();

    expect(spawn).not.toHaveBeenCalled();
    expect(output.hookSpecificOutput.additionalContext).toContain('hive-manual: watcher died (pid-dead), NEEDS MANUAL RESPAWN');
    expect(output.hookSpecificOutput.additionalContext).toContain('Manual respawn needed for: hive-manual');
  });
});
