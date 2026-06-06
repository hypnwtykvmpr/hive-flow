import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../../');
const sentinelRecoveryPath = resolve(repoRoot, '.claude/helpers/sentinel-recovery.cjs');
const watcherScript = resolve(repoRoot, 'scripts/hive-watcher.cjs');

const fs = require('node:fs');
const childProcess = require('node:child_process');

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

afterEach(() => {
  vi.restoreAllMocks();
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

    expect(sentinel.spawnDetachedWatcher('hive-test-001', '%3')).toBe(12_345);
    expect(mkdir).toHaveBeenCalledWith(expect.stringMatching(/watcher-hive-test-001\.lock$/));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).toEqual([watcherScript, 'hive-test-001', '--project-dir', repoRoot, '--tmux-pane', '%3']);
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
});
