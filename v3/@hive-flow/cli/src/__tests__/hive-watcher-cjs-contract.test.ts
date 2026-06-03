import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../../');
const watcherPath = resolve(root, 'scripts', 'hive-watcher.cjs');
const hiveCheckPath = resolve(root, 'scripts', 'hive-check-complete.cjs');
const dedupMarkerPath = resolve(root, '.claude', 'helpers', 'dedup-marker.cjs');

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), 'hive-flow-cjs-contract-'));
}

describe('hive watcher script module contract', () => {
  it('loads as CommonJS under the root type:module package', () => {
    expect(existsSync(watcherPath)).toBe(true);

    const result = spawnSync(process.execPath, [watcherPath], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('hive-watcher: missing hiveId argument');
    expect(result.stderr).not.toContain('require is not defined');
  });

  it('emits valid PostToolUse hook output and claims completion once', () => {
    const project = makeTempProject();
    try {
      const scriptsDir = join(project, 'scripts');
      const helperDir = join(project, '.claude', 'helpers');
      const dataDir = join(project, '.hive-flow', 'data');
      mkdirSync(scriptsDir, { recursive: true });
      mkdirSync(helperDir, { recursive: true });
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(scriptsDir, 'hive-check-complete.cjs'), readFileSync(hiveCheckPath, 'utf8'), 'utf8');
      writeFileSync(join(helperDir, 'dedup-marker.cjs'), readFileSync(dedupMarkerPath, 'utf8'), 'utf8');
      writeFileSync(
        join(dataDir, 'hive-demo.done'),
        JSON.stringify({ hiveId: 'demo', completedAt: '2026-06-02T00:00:00.000Z', completedCount: 2 }),
        'utf8',
      );

      const first = spawnSync(process.execPath, [join(scriptsDir, 'hive-check-complete.cjs'), 'post-tool-use'], {
        cwd: project,
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(first.status).toBe(0);
      const output = JSON.parse(first.stdout);
      expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
      expect(output.hookSpecificOutput.additionalContext).toContain('[HIVE COMPLETE: demo]');
      expect(existsSync(join(dataDir, 'hive-demo.acked'))).toBe(true);

      const second = spawnSync(process.execPath, [join(scriptsDir, 'hive-check-complete.cjs'), 'post-tool-use'], {
        cwd: project,
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(second.status).toBe(0);
      expect(JSON.parse(second.stdout)).toEqual({});
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
