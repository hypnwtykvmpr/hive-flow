import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const sourceHook = resolve(here, '../../../../../.claude/helpers/hive-enforcement.cjs');

function makeTempProject(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'hive-flow-enforcement-')));
}

function waitForFile(filePath: string, timeoutMs = 2000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return existsSync(filePath);
}

function installHookAndWatcher(root: string): void {
  const helperDir = join(root, '.claude', 'helpers');
  const scriptsDir = join(root, 'scripts');
  mkdirSync(helperDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(helperDir, 'hive-enforcement.cjs'), readFileSync(sourceHook, 'utf8'), 'utf8');
  writeFileSync(
    join(scriptsDir, 'hive-watcher.cjs'),
    `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const projectDirArg = args.indexOf('--project-dir');
const projectDir = projectDirArg >= 0 ? args[projectDirArg + 1] : process.cwd();
const dataDir = path.join(projectDir, '.hive-flow', 'data');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'watcher-spawned.json'), JSON.stringify({
  args,
  cwd: process.cwd(),
  projectDirEnv: process.env.CLAUDE_PROJECT_DIR || null,
}));
`,
    'utf8',
  );
}

function writeHiveRecord(root: string, hiveId: string, workerCount = 5): void {
  const hiveDir = join(root, '.hive-flow', 'hives', hiveId);
  mkdirSync(hiveDir, { recursive: true });
  writeFileSync(
    join(hiveDir, 'hive.json'),
    JSON.stringify(
      {
        hiveId,
        queenId: 'queen-1',
        budget: { workersAllocated: workerCount },
        workers: Array.from({ length: workerCount }, (_, index) => ({
          workerId: `worker-${index + 1}`,
          agentId: `agent-${index + 1}`,
          status: 'idle',
        })),
      },
      null,
      2,
    ),
    'utf8',
  );
}

function invokeHook(root: string, hiveId: string): string {
  const payload = {
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__hive-flow__queen_mission_assign',
    tool_response: JSON.stringify({ hiveId }),
  };
  return execFileSync(process.execPath, [join(root, '.claude', 'helpers', 'hive-enforcement.cjs')], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 5000,
  });
}

function readAuditEvents(root: string): string[] {
  const auditPath = join(root, '.hive-flow', 'enforcement', 'hive-audit.jsonl');
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).event);
}

describe('hive enforcement watcher launch', () => {
  it('launches the completion watcher before the fully staffed early return', () => {
    const root = makeTempProject();
    try {
      const hiveId = 'hive-ready';
      installHookAndWatcher(root);
      writeHiveRecord(root, hiveId, 5);

      expect(invokeHook(root, hiveId)).toBe('{}');

      const spawnedPath = join(root, '.hive-flow', 'data', 'watcher-spawned.json');
      expect(waitForFile(spawnedPath)).toBe(true);
      const spawned = JSON.parse(readFileSync(spawnedPath, 'utf8'));
      expect(spawned.args).toEqual([hiveId, '--project-dir', root]);
      expect(spawned.cwd).toBe(root);
      expect(spawned.projectDirEnv).toBe(root);
      expect(readAuditEvents(root)).toEqual(['watcher-launched', 'hive-enforcement-ok']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not launch a duplicate watcher when a fresh heartbeat exists', () => {
    const root = makeTempProject();
    try {
      const hiveId = 'hive-ready';
      installHookAndWatcher(root);
      writeHiveRecord(root, hiveId, 5);
      const dataDir = join(root, '.hive-flow', 'data');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        join(dataDir, `watcher-${hiveId}.json`),
        JSON.stringify({ hiveId, watcherPid: process.pid, updatedAt: new Date().toISOString() }),
        'utf8',
      );

      expect(invokeHook(root, hiveId)).toBe('{}');

      expect(waitForFile(join(dataDir, 'watcher-spawned.json'), 250)).toBe(false);
      expect(readAuditEvents(root)).toEqual(['hive-enforcement-ok']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
