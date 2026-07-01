import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const sentinelRecoverySource = join(repoRoot, '.claude', 'helpers', 'sentinel-recovery.cjs');
const hookHandlerSource = join(repoRoot, '.claude', 'helpers', 'hook-handler.cjs');
const clientKindSource = join(repoRoot, '.claude', 'helpers', 'client-kind.cjs');
const sessionIdSource = join(repoRoot, '.claude', 'helpers', 'session-id.cjs');
const layoutPathsSource = join(repoRoot, '.claude', 'helpers', 'layout-paths.cjs');
const protectedPathsSource = join(repoRoot, 'cli', 'src', 'permission-guard', 'protected-paths.cjs');

function makeTempProject(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function installHelper(projectRoot: string, fileName: string, sourcePath: string): string {
  const helperDir = join(projectRoot, '.claude', 'helpers');
  mkdirSync(helperDir, { recursive: true });
  writeFileSync(join(helperDir, fileName), readFileSync(sourcePath, 'utf8'), 'utf8');
  writeFileSync(join(helperDir, 'client-kind.cjs'), readFileSync(clientKindSource, 'utf8'), 'utf8');
  writeFileSync(join(helperDir, 'session-id.cjs'), readFileSync(sessionIdSource, 'utf8'), 'utf8');
  writeFileSync(join(helperDir, 'layout-paths.cjs'), readFileSync(layoutPathsSource, 'utf8'), 'utf8');
  writeFileSync(join(helperDir, 'protected-paths.cjs'), readFileSync(protectedPathsSource, 'utf8'), 'utf8');
  return join(helperDir, fileName);
}

function writeHive(projectRoot: string, hiveId: string, status = 'active'): void {
  const hiveDir = join(projectRoot, '.hive-flow', 'hives', hiveId);
  mkdirSync(hiveDir, { recursive: true });
  writeFileSync(join(hiveDir, 'hive.json'), JSON.stringify({ hiveId, status }, null, 2), 'utf8');
}

function writeWatcher(projectRoot: string, hiveId: string): string {
  const dataDir = join(projectRoot, '.hive-flow', 'data');
  mkdirSync(dataDir, { recursive: true });
  const watcherPath = join(dataDir, `watcher-${hiveId}.json`);
  writeFileSync(watcherPath, JSON.stringify({
    hiveId,
    watcherPid: 999_999_999,
    updatedAt: '2020-01-01T00:00:00.000Z',
  }, null, 2), 'utf8');
  return watcherPath;
}

function writeForbiddenStop(projectRoot: string): string {
  const dataDir = join(projectRoot, '.hive-flow', 'data');
  mkdirSync(dataDir, { recursive: true });
  const markerPath = join(dataDir, 'forbidden-stop.json');
  writeFileSync(markerPath, JSON.stringify({ at: '2026-06-06T00:00:00.000Z' }, null, 2), 'utf8');
  return markerPath;
}

function parseHookJson(stdout: string): any {
  return JSON.parse(stdout.trim() || '{}');
}

function withoutRootEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.HIVE_FLOW_PROJECT_ROOT;
  delete next.CLAUDE_PROJECT_DIR;
  return next;
}

describe('hook project-root resolver parity', () => {
  it('uses CLAUDE_PROJECT_DIR for sentinel recovery instead of the helper dirname tree', () => {
    const treeA = makeTempProject('hf-root-parity-env-');
    const treeB = makeTempProject('hf-root-parity-helper-');
    try {
      const sentinel = installHelper(treeB, 'sentinel-recovery.cjs', sentinelRecoverySource);
      writeHive(treeA, 'env-hive');
      writeWatcher(treeA, 'env-hive');
      const treeBWatcher = writeWatcher(treeB, 'dirname-hive');

      const result = spawnSync(process.execPath, [sentinel], {
        cwd: treeB,
        env: {
          ...withoutRootEnv(process.env),
          CLAUDE_PROJECT_DIR: treeA,
        },
        encoding: 'utf8',
        timeout: 5000,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const output = parseHookJson(result.stdout);
      expect(output.hookSpecificOutput.additionalContext).toContain('env-hive');
      expect(existsSync(treeBWatcher)).toBe(true);
    } finally {
      rmSync(treeA, { recursive: true, force: true });
      rmSync(treeB, { recursive: true, force: true });
    }
  });

  it('keeps the sentinel no-env fallback anchored to the helper dirname tree', () => {
    const treeB = makeTempProject('hf-root-parity-no-env-');
    try {
      const sentinel = installHelper(treeB, 'sentinel-recovery.cjs', sentinelRecoverySource);
      writeHive(treeB, 'dirname-hive');
      writeWatcher(treeB, 'dirname-hive');

      const result = spawnSync(process.execPath, [sentinel], {
        cwd: tmpdir(),
        env: withoutRootEnv(process.env),
        encoding: 'utf8',
        timeout: 5000,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const output = parseHookJson(result.stdout);
      expect(output.hookSpecificOutput.additionalContext).toContain('dirname-hive');
    } finally {
      rmSync(treeB, { recursive: true, force: true });
    }
  });

  it('uses CLAUDE_PROJECT_DIR for hook-handler session restore markers', () => {
    const treeA = makeTempProject('hf-root-parity-hook-env-');
    const treeB = makeTempProject('hf-root-parity-hook-helper-');
    try {
      const hookHandler = installHelper(treeB, 'hook-handler.cjs', hookHandlerSource);
      const envMarker = writeForbiddenStop(treeA);

      const result = spawnSync(process.execPath, [hookHandler, 'session-restore'], {
        cwd: treeB,
        env: {
          ...withoutRootEnv(process.env),
          CLAUDE_PROJECT_DIR: treeA,
        },
        encoding: 'utf8',
        timeout: 5000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('[FORBIDDEN-STOP-VIOLATION]');
      expect(existsSync(envMarker)).toBe(false);
    } finally {
      rmSync(treeA, { recursive: true, force: true });
      rmSync(treeB, { recursive: true, force: true });
    }
  });

  it('keeps hook-handler no-env fallback anchored to the helper dirname tree', () => {
    const treeB = makeTempProject('hf-root-parity-hook-no-env-');
    try {
      const hookHandler = installHelper(treeB, 'hook-handler.cjs', hookHandlerSource);
      const dirnameMarker = writeForbiddenStop(treeB);

      const result = spawnSync(process.execPath, [hookHandler, 'session-restore'], {
        cwd: tmpdir(),
        env: withoutRootEnv(process.env),
        encoding: 'utf8',
        timeout: 5000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('[FORBIDDEN-STOP-VIOLATION]');
      expect(existsSync(dirnameMarker)).toBe(false);
    } finally {
      rmSync(treeB, { recursive: true, force: true });
    }
  });
});
