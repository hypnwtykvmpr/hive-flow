import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = resolve(here, '../scripts/provider-agent-bridge.mjs');
const tempRoots = [];

const previousEnv = {
  HIVE_FLOW_HOME: process.env.HIVE_FLOW_HOME,
  HIVE_FLOW_SESSION_ID: process.env.HIVE_FLOW_SESSION_ID,
  HIVE_FLOW_CLIENT_KIND: process.env.HIVE_FLOW_CLIENT_KIND,
  CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
  CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
  CODEX_SESSION_ID: process.env.CODEX_SESSION_ID,
  HIVE_FLOW_DEV_OVERRIDE_TOKEN: process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN,
  HIVE_FLOW_DEV_OVERRIDE: process.env.HIVE_FLOW_DEV_OVERRIDE,
};

let bridge;

function restoreEnv() {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreProcessListeners(event, preserved) {
  const keep = new Set(preserved);
  for (const listener of process.listeners(event)) {
    if (!keep.has(listener)) process.off(event, listener);
  }
}

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function sessionKeyFor(clientKind, sessionId) {
  return `s_${createHash('sha256').update(`${clientKind}\0${sessionId}`).digest('hex').slice(0, 32)}`;
}

beforeAll(async () => {
  const sigtermListeners = process.listeners('SIGTERM');
  const uncaughtExceptionListeners = process.listeners('uncaughtException');
  try {
    bridge = await import(`${pathToFileURL(bridgePath).href}?notifications=${Date.now()}-${Math.random()}`);
  } finally {
    restoreEnv();
    restoreProcessListeners('SIGTERM', sigtermListeners);
    restoreProcessListeners('uncaughtException', uncaughtExceptionListeners);
  }
});

afterEach(() => {
  restoreEnv();
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('provider bridge task completion notifications', () => {
  it('writes project-local and owning-session pending notifications from a result file exactly once', () => {
    const projectRoot = tempDir('hf-bridge-notify-project-');
    const hiveHome = tempDir('hf-bridge-notify-home-');
    const taskId = 'task-751e11dc-f54e-4a6f-a096-78a4dce0576d';
    const resultFile = join(projectRoot, '.hive-flow', 'tasks', `${taskId}.result.json`);
    mkdirSync(dirname(resultFile), { recursive: true });
    writeFileSync(resultFile, JSON.stringify({
      success: true,
      result: {
        success: true,
        agentId: 'agent-openrouter-1',
        content: 'finished diagnostic task',
      },
    }), 'utf8');

    process.env.HIVE_FLOW_HOME = hiveHome;
    process.env.HIVE_FLOW_SESSION_ID = 'codex-session-bridge-notify';
    process.env.HIVE_FLOW_CLIENT_KIND = 'codex';

    expect(bridge.notifyTaskCompletionFromResultFile(resultFile)).toBe(true);
    expect(bridge.notifyTaskCompletionFromResultFile(resultFile)).toBe(false);

    const localDataDir = join(projectRoot, '.hive-flow', 'data');
    const sessionDir = join(
      hiveHome,
      'wake',
      'sessions',
      sessionKeyFor('codex', 'codex-session-bridge-notify'),
    );
    const localPending = join(localDataDir, 'pending-notifications.jsonl');
    const sessionPending = join(sessionDir, 'pending-notifications.jsonl');

    const localPendingText = readFileSync(localPending, 'utf8');
    const sessionPendingText = readFileSync(sessionPending, 'utf8');
    expect(localPendingText).toContain(taskId);
    expect(sessionPendingText).toContain(taskId);
    expect(sessionPendingText).toContain('"targetAgent":"codex"');
    expect(sessionPendingText).not.toContain('[REDACTED]');
    expect(existsSync(join(localDataDir, `task-${taskId}.notified`))).toBe(true);
    expect(existsSync(join(sessionDir, `task-${taskId}.notified`))).toBe(true);
    expect(localPendingText.trim().split('\n')).toHaveLength(1);
    expect(sessionPendingText.trim().split('\n')).toHaveLength(1);
  });

  it('defaults ownerless provider bridge completions to Claude ownership', () => {
    const projectRoot = tempDir('hf-bridge-default-owner-project-');
    const hiveHome = tempDir('hf-bridge-default-owner-home-');
    const taskId = 'task-default-claude-owner';
    const resultFile = join(projectRoot, '.hive-flow', 'tasks', `${taskId}.result.json`);
    mkdirSync(dirname(resultFile), { recursive: true });
    writeFileSync(resultFile, JSON.stringify({
      success: true,
      result: {
        success: true,
        agentId: 'agent-default-owner',
        content: 'finished',
      },
    }), 'utf8');

    delete process.env.HIVE_FLOW_CLIENT_KIND;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.CODEX_SESSION_ID;
    process.env.HIVE_FLOW_HOME = hiveHome;
    process.env.HIVE_FLOW_SESSION_ID = 'default-owner-session';

    expect(bridge.notifyTaskCompletionFromResultFile(resultFile)).toBe(true);

    const localPending = readFileSync(join(projectRoot, '.hive-flow', 'data', 'pending-notifications.jsonl'), 'utf8');
    const sessionPending = readFileSync(join(
      hiveHome,
      'wake',
      'sessions',
      sessionKeyFor('claude-code', 'default-owner-session'),
      'pending-notifications.jsonl',
    ), 'utf8');
    expect(localPending).toContain('"targetAgent":"claude"');
    expect(sessionPending).toContain('"targetAgent":"claude"');
  });

  it('uses Codex session id before conflicting Claude/Hive session env values', () => {
    const projectRoot = tempDir('hf-bridge-codex-owner-project-');
    const hiveHome = tempDir('hf-bridge-codex-owner-home-');
    const taskId = 'task-codex-env-owner';
    const resultFile = join(projectRoot, '.hive-flow', 'tasks', `${taskId}.result.json`);
    mkdirSync(dirname(resultFile), { recursive: true });
    writeFileSync(resultFile, JSON.stringify({
      success: true,
      result: {
        success: true,
        agentId: 'agent-codex-owner',
        content: 'finished',
      },
    }), 'utf8');

    process.env.HIVE_FLOW_HOME = hiveHome;
    process.env.CODEX_SESSION_ID = 'codex-session-env-owner';
    process.env.CLAUDE_SESSION_ID = 'claude-session-wrong';
    process.env.HIVE_FLOW_SESSION_ID = 'hive-session-wrong';
    delete process.env.HIVE_FLOW_CLIENT_KIND;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;

    expect(bridge.notifyTaskCompletionFromResultFile(resultFile)).toBe(true);

    const codexSessionPending = join(
      hiveHome,
      'wake',
      'sessions',
      sessionKeyFor('codex', 'codex-session-env-owner'),
      'pending-notifications.jsonl',
    );
    const wrongHiveSessionPending = join(
      hiveHome,
      'wake',
      'sessions',
      sessionKeyFor('codex', 'hive-session-wrong'),
      'pending-notifications.jsonl',
    );

    expect(readFileSync(codexSessionPending, 'utf8')).toContain('"targetAgent":"codex"');
    expect(existsSync(wrongHiveSessionPending)).toBe(false);
  });

  it('escalates denied privileged run_command attempts to the owning operator', async () => {
    const projectRoot = tempDir('hf-bridge-permission-project-');
    const hiveHome = tempDir('hf-bridge-permission-home-');
    const taskId = 'task-permission-escalation';
    const resultFile = join(projectRoot, '.hive-flow', 'tasks', `${taskId}.result.json`);
    mkdirSync(dirname(resultFile), { recursive: true });

    process.env.HIVE_FLOW_HOME = hiveHome;
    process.env.HIVE_FLOW_SESSION_ID = 'permission-owner-session';
    process.env.HIVE_FLOW_CLIENT_KIND = 'codex';

    const denied = JSON.parse(await bridge.executeBridgeTool('run_command', {
      argv: ['git', 'mv', 'old-name', 'new-name'],
    }, {
      agentId: 'agent-needs-permission',
      resultFile,
      source: 'test',
    }));

    expect(denied).toMatchObject({
      status: 'denied',
      denyReason: 'read-only-command-denied',
    });

    const localPending = readFileSync(join(projectRoot, '.hive-flow', 'data', 'pending-notifications.jsonl'), 'utf8');
    const sessionPending = readFileSync(join(
      hiveHome,
      'wake',
      'sessions',
      sessionKeyFor('codex', 'permission-owner-session'),
      'pending-notifications.jsonl',
    ), 'utf8');

    expect(localPending).toContain('"kind":"permission-request"');
    expect(localPending).toContain('"targetAgent":"codex"');
    expect(localPending).toContain('git subcommand');
    expect(sessionPending).toContain('[PERMISSION REQUEST: task-permission-escalation]');
  });
});
