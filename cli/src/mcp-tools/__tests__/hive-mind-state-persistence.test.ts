import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hiveMindTools } from '../hive-mind-tools.js';

const ORIGINAL_CWD = process.cwd();
const initTool = hiveMindTools.find(tool => tool.name === 'hive-mind_init')!;

function hiveMindDir(root: string): string {
  return join(root, '.hive-flow', 'hive-mind');
}

function statePath(root: string): string {
  return join(hiveMindDir(root), 'state.json');
}

describe('hive-mind state persistence', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'hive-flow-hive-mind-state-'));
    process.chdir(tmpRoot);
  });

  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('writes valid hive state atomically without temp or lock residue', async () => {
    const result = await initTool.handler({ topology: 'mesh', queenId: 'queen-atomic' }) as Record<string, unknown>;

    expect(result).toMatchObject({ success: true, queenId: 'queen-atomic' });
    const state = JSON.parse(readFileSync(statePath(tmpRoot), 'utf8')) as Record<string, unknown>;
    expect(state).toMatchObject({ initialized: true, topology: 'mesh' });

    const entries = readdirSync(hiveMindDir(tmpRoot));
    expect(entries).not.toContain('.state.lock');
    expect(entries.filter(entry => entry.includes('.tmp.'))).toEqual([]);
  });

  it('reclaims stale hive-state locks before saving', async () => {
    const dir = hiveMindDir(tmpRoot);
    mkdirSync(join(dir, '.state.lock'), { recursive: true });
    const stale = new Date(Date.now() - 60_000);
    utimesSync(join(dir, '.state.lock'), stale, stale);

    const result = await initTool.handler({ topology: 'star', queenId: 'queen-stale-lock' }) as Record<string, unknown>;

    expect(result).toMatchObject({ success: true, queenId: 'queen-stale-lock' });
    expect(existsSync(join(dir, '.state.lock'))).toBe(false);
    const state = JSON.parse(readFileSync(statePath(tmpRoot), 'utf8')) as Record<string, unknown>;
    expect(state).toMatchObject({ initialized: true, topology: 'star' });
  });

  it('refuses symlinked hive state files instead of following them', async () => {
    const dir = hiveMindDir(tmpRoot);
    mkdirSync(dir, { recursive: true });
    const outside = join(tmpRoot, 'outside-state.json');
    writeFileSync(outside, JSON.stringify({ initialized: false, marker: 'outside' }), 'utf8');

    try {
      symlinkSync(outside, statePath(tmpRoot));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    await expect(initTool.handler({ topology: 'mesh' })).rejects.toThrow(/symlinked hive-mind state file/);
    expect(JSON.parse(readFileSync(outside, 'utf8'))).toMatchObject({ marker: 'outside' });
  });

  it('refuses symlinked hive-state lock paths immediately', async () => {
    const dir = hiveMindDir(tmpRoot);
    mkdirSync(dir, { recursive: true });
    const outside = join(tmpRoot, 'outside-lock-target');
    mkdirSync(outside);

    try {
      symlinkSync(outside, join(dir, '.state.lock'), 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    await expect(initTool.handler({ topology: 'mesh' })).rejects.toThrow(/symlinked hive-mind lock/);
  });
});
