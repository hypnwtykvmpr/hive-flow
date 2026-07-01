import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
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
const sourceHook = resolve(here, '../../../.claude/helpers/hive-enforcement.cjs');
const layoutPathsSource = resolve(here, '../../../.claude/helpers/layout-paths.cjs');
const protectedPathsSource = resolve(here, '../permission-guard/protected-paths.cjs');
const protectedPathsPolicySource = resolve(here, '../permission-guard/protected-paths.policy.json');

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
  const policyDir = join(root, 'cli', 'src', 'permission-guard');
  const scriptsDir = join(root, 'scripts');
  mkdirSync(helperDir, { recursive: true });
  mkdirSync(policyDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(helperDir, 'hive-enforcement.cjs'), readFileSync(sourceHook, 'utf8'), 'utf8');
  writeFileSync(join(helperDir, 'layout-paths.cjs'), readFileSync(layoutPathsSource, 'utf8'), 'utf8');
  copyFileSync(protectedPathsSource, join(policyDir, 'protected-paths.cjs'));
  copyFileSync(protectedPathsPolicySource, join(policyDir, 'protected-paths.policy.json'));
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

function writeHiveRecord(
  root: string,
  hiveId: string,
  workerCount = 5,
  owner: { ownerSessionId?: string; ownerClientKind?: string; ownerTmuxPane?: string } = {},
): void {
  const hiveDir = join(root, '.hive-flow', 'hives', hiveId);
  mkdirSync(hiveDir, { recursive: true });
  writeFileSync(
    join(hiveDir, 'hive.json'),
    JSON.stringify(
      {
        hiveId,
        queenId: 'queen-1',
        ...owner,
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

function writeHiveRecordWithWorkers(
  root: string,
  hiveId: string,
  workers: Array<{ workerId: string; agentId: string; status: string }>,
  workersAllocated = workers.length,
  owner: { ownerSessionId?: string; ownerClientKind?: string } = {},
): void {
  const hiveDir = join(root, '.hive-flow', 'hives', hiveId);
  mkdirSync(hiveDir, { recursive: true });
  writeFileSync(
    join(hiveDir, 'hive.json'),
    JSON.stringify(
      {
        hiveId,
        queenId: 'queen-1',
        ...owner,
        budget: { workersAllocated },
        workers,
      },
      null,
      2,
    ),
    'utf8',
  );
}

function invokeHookWithToolResponse(root: string, toolResponse: unknown, hiveHome: string): string {
  const payload = {
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__hive-flow__queen_mission_assign',
    tool_response: typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse),
  };
  return execFileSync(process.execPath, [join(root, '.claude', 'helpers', 'hive-enforcement.cjs')], {
    cwd: root,
    env: { ...process.env, HIVE_FLOW_HOME: hiveHome },
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 5000,
  });
}

function invokeHook(root: string, hiveId: string, hiveHome: string): string {
  return invokeHookWithToolResponse(root, { hiveId }, hiveHome);
}

function invokeSourceHookWithToolResponse(
  root: string,
  toolResponse: unknown,
  hiveHome: string,
  extraEnv: Record<string, string> = {},
): string {
  const payload = {
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__hive-flow__queen_mission_assign',
    tool_response: typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse),
  };
  const minimalEnv = {
    PATH: process.env.PATH || '',
    HOME: hiveHome,
    HIVE_FLOW_HOME: hiveHome,
    CLAUDE_PROJECT_DIR: root,
    ...extraEnv,
  };
  return execFileSync(process.execPath, [sourceHook], {
    cwd: root,
    env: minimalEnv,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 5000,
  });
}

function readAgentStore(root: string): Record<string, unknown> {
  const storePath = join(root, '.hive-flow', 'agents', 'store.json');
  if (!existsSync(storePath)) return { agents: {} };
  return JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, unknown>;
}

function readAuditRecords(hiveHome: string): Array<Record<string, unknown>> {
  const auditPath = join(hiveHome, 'enforcement', 'hive-audit.jsonl');
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readAuditEvents(hiveHome: string): string[] {
  return readAuditRecords(hiveHome).map((record) => record.event as string);
}

describe('hive enforcement watcher launch', () => {
  it('launches the watcher outside the hive record lock', () => {
    const source = readFileSync(sourceHook, 'utf8');
    expect(source).not.toContain('queenId = record.queenId;\n\n    ensureHiveWatcherLaunched(toolName, sanitizedId);');
    expect(source).toContain('releaseLock(lockPath);\n      if (shouldLaunchWatcher) ensureHiveWatcherLaunched(toolName, sanitizedId);');
    expect(source).toContain('releaseLock(lockPath);\n  if (shouldLaunchWatcher) ensureHiveWatcherLaunched(toolName, sanitizedId);');
  });

  it('launches the completion watcher before the fully staffed early return', () => {
    const root = makeTempProject();
    try {
      const hiveHome = join(root, 'global-home');
      const hiveId = 'hive-ready';
      installHookAndWatcher(root);
      writeHiveRecord(root, hiveId, 5, { ownerSessionId: 'owner-session', ownerTmuxPane: '%55' });

      expect(invokeHook(root, hiveId, hiveHome)).toBe('{}');

      const spawnedPath = join(root, '.hive-flow', 'data', 'watcher-spawned.json');
      expect(waitForFile(spawnedPath)).toBe(true);
      const spawned = JSON.parse(readFileSync(spawnedPath, 'utf8'));
      expect(spawned.args).toEqual([hiveId, '--project-dir', root, '--sessionId', 'owner-session']);
      expect(spawned.args).not.toContain('--tmux-pane');
      expect(spawned.cwd).toBe(root);
      expect(spawned.projectDirEnv).toBe(root);
      expect(readAuditEvents(hiveHome)).toEqual(['watcher-launched', 'hive-enforcement-ok']);
      expect(existsSync(join(root, '.hive-flow', 'enforcement', 'hive-audit.jsonl'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not launch a duplicate watcher when a fresh heartbeat exists', () => {
    const root = makeTempProject();
    try {
      const hiveHome = join(root, 'global-home');
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

      expect(invokeHook(root, hiveId, hiveHome)).toBe('{}');

      expect(waitForFile(join(dataDir, 'watcher-spawned.json'), 250)).toBe(false);
      expect(readAuditEvents(hiveHome)).toEqual(['hive-enforcement-ok']);
      expect(existsSync(join(root, '.hive-flow', 'enforcement', 'hive-audit.jsonl'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('extracts hiveId from the MCP object content wrapper shape', () => {
    const root = makeTempProject();
    try {
      const hiveHome = join(root, 'global-home');
      const hiveId = 'hive-wrapper';
      installHookAndWatcher(root);
      writeHiveRecord(root, hiveId, 5);

      expect(invokeHookWithToolResponse(root, {
        content: [
          { type: 'text', text: JSON.stringify({ hiveId }) },
        ],
      }, hiveHome)).toBe('{}');

      expect(readAuditEvents(hiveHome)).toEqual(['watcher-launched', 'hive-enforcement-ok']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats errored workers as non-live so a 4/5 hive enters the deficit refill path', () => {
    const root = makeTempProject();
    try {
      const hiveHome = join(root, 'global-home');
      const hiveId = 'hive-deficit';
      installHookAndWatcher(root);
      writeHiveRecordWithWorkers(root, hiveId, [
        { workerId: 'worker-1', agentId: 'agent-1', status: 'idle' },
        { workerId: 'worker-2', agentId: 'agent-2', status: 'idle' },
        { workerId: 'worker-3', agentId: 'agent-3', status: 'idle' },
        { workerId: 'worker-4', agentId: 'agent-4', status: 'idle' },
        { workerId: 'worker-5', agentId: 'agent-5', status: 'error' },
      ], 4, { ownerSessionId: 'owner-session', ownerClientKind: 'opencode' });

      expect(invokeHook(root, hiveId, hiveHome)).toBe('{}');

      const records = readAuditRecords(hiveHome);
      expect(records.map((record) => record.event)).toEqual(['watcher-launched', 'hive-enforcement-skipped']);
      expect(records.at(-1)).toMatchObject({
        event: 'hive-enforcement-skipped',
        reason: 'agent-tools-not-available',
        deficit: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates a top-up worker from the persisted hive owner without matching parent env', () => {
    const root = makeTempProject();
    try {
      const hiveHome = join(root, 'global-home');
      const hiveId = 'hive-owner-env-independent';
      writeHiveRecord(root, hiveId, 4, { ownerSessionId: 'owner-session', ownerClientKind: 'opencode' });

      expect(invokeSourceHookWithToolResponse(root, { hiveId }, hiveHome)).toContain('Auto-spawned 1 worker');

      const store = readAgentStore(root) as { agents?: Record<string, Record<string, unknown>> };
      const agents = Object.values(store.agents ?? {});
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        ownerSessionId: 'owner-session',
        ownerClientKind: 'opencode',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not create a top-up worker for legacy hives with a missing owner client kind', () => {
    const root = makeTempProject();
    try {
      const hiveHome = join(root, 'global-home');
      const hiveId = 'hive-missing-owner-kind';
      writeHiveRecord(root, hiveId, 4, { ownerSessionId: 'owner-session' });

      expect(invokeSourceHookWithToolResponse(root, { hiveId }, hiveHome, {
        OPENCODE_SESSION_ID: 'owner-session',
      })).toBe('{}');

      const store = readAgentStore(root) as { agents?: Record<string, unknown> };
      expect(Object.keys(store.agents ?? {})).toHaveLength(0);
      expect(readAuditRecords(hiveHome).at(-1)).toMatchObject({
        event: 'hive-enforcement-skipped',
        reason: 'missing-owner-client-kind',
        hiveId,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not create a top-up worker for legacy hives with an empty owner session', () => {
    const root = makeTempProject();
    try {
      const hiveHome = join(root, 'global-home');
      const hiveId = 'hive-empty-owner';
      writeHiveRecord(root, hiveId, 4, { ownerClientKind: 'opencode' });

      expect(invokeSourceHookWithToolResponse(root, { hiveId }, hiveHome, {
        OPENCODE_SESSION_ID: 'ambient-hook-session',
      })).toBe('{}');

      const store = readAgentStore(root) as { agents?: Record<string, unknown> };
      expect(Object.keys(store.agents ?? {})).toHaveLength(0);
      expect(readAuditRecords(hiveHome).at(-1)).toMatchObject({
        event: 'hive-enforcement-skipped',
        reason: 'missing-owner-session',
        hiveId,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates a top-up worker through the real agent_spawn handler when parent env matches the hive owner', () => {
    const root = makeTempProject();
    try {
      const hiveHome = join(root, 'global-home');
      const hiveId = 'hive-owned-top-up';
      writeHiveRecord(root, hiveId, 4, { ownerSessionId: 'owner-session', ownerClientKind: 'opencode' });

      expect(invokeSourceHookWithToolResponse(root, { hiveId }, hiveHome, {
        OPENCODE_SESSION_ID: 'owner-session',
      })).toContain('Auto-spawned 1 worker');

      const store = readAgentStore(root) as { agents?: Record<string, Record<string, unknown>> };
      const agents = Object.values(store.agents ?? {});
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        ownerSessionId: 'owner-session',
        ownerClientKind: 'opencode',
        config: {
          autoSpawnedBy: 'hive-enforcement',
          hiveId,
          queenId: 'queen-1',
        },
      });
      const hive = JSON.parse(readFileSync(join(root, '.hive-flow', 'hives', hiveId, 'hive.json'), 'utf8'));
      expect(hive.workers.at(-1)).toMatchObject({
        ownerSessionId: 'owner-session',
        ownerClientKind: 'opencode',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
