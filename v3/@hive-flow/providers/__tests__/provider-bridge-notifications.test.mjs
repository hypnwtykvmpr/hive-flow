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
  CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
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
    delete process.env.CODEX_THREAD_ID;
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

  it('uses CODEX_THREAD_ID for Codex ownership when CODEX_SESSION_ID is absent', () => {
    const projectRoot = tempDir('hf-bridge-codex-thread-project-');
    const hiveHome = tempDir('hf-bridge-codex-thread-home-');
    const taskId = 'task-codex-thread-owner';
    const resultFile = join(projectRoot, '.hive-flow', 'tasks', `${taskId}.result.json`);
    mkdirSync(dirname(resultFile), { recursive: true });
    writeFileSync(resultFile, JSON.stringify({
      success: true,
      result: {
        success: true,
        agentId: 'agent-codex-thread-owner',
        content: 'finished',
      },
    }), 'utf8');

    process.env.HIVE_FLOW_HOME = hiveHome;
    process.env.CODEX_THREAD_ID = 'codex-thread-env-owner';
    process.env.CLAUDE_SESSION_ID = 'claude-session-wrong';
    delete process.env.CODEX_SESSION_ID;
    delete process.env.HIVE_FLOW_CLIENT_KIND;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;

    expect(bridge.notifyTaskCompletionFromResultFile(resultFile)).toBe(true);

    const codexSessionPending = join(
      hiveHome,
      'wake',
      'sessions',
      sessionKeyFor('codex', 'codex-thread-env-owner'),
      'pending-notifications.jsonl',
    );
    const wrongClaudeSessionPending = join(
      hiveHome,
      'wake',
      'sessions',
      sessionKeyFor('claude-code', 'claude-session-wrong'),
      'pending-notifications.jsonl',
    );

    expect(readFileSync(codexSessionPending, 'utf8')).toContain('"targetAgent":"codex"');
    expect(existsSync(wrongClaudeSessionPending)).toBe(false);
  });

  it('routes completion notifications from persisted task ownership before ambient bridge env', () => {
    const projectRoot = tempDir('hf-bridge-persisted-owner-project-');
    const hiveHome = tempDir('hf-bridge-persisted-owner-home-');
    const taskId = 'task-persisted-codex-owner';
    const taskDir = join(projectRoot, '.hive-flow', 'tasks');
    const resultFile = join(taskDir, `${taskId}.result.json`);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, `${taskId}.json`), JSON.stringify({
      taskId,
      agentId: 'agent-persisted-owner',
      ownerSessionId: 'codex-persisted-owner',
      ownerClientKind: 'codex',
    }), 'utf8');
    writeFileSync(resultFile, JSON.stringify({
      success: true,
      result: {
        success: true,
        agentId: 'agent-persisted-owner',
        content: 'finished',
      },
    }), 'utf8');

    process.env.HIVE_FLOW_HOME = hiveHome;
    process.env.HIVE_FLOW_SESSION_ID = 'ambient-hive-session';
    process.env.HIVE_FLOW_CLIENT_KIND = 'claude-code';
    process.env.CLAUDE_SESSION_ID = 'ambient-claude-session';
    delete process.env.CODEX_SESSION_ID;

    expect(bridge.notifyTaskCompletionFromResultFile(resultFile)).toBe(true);

    const localPending = readFileSync(join(projectRoot, '.hive-flow', 'data', 'pending-notifications.jsonl'), 'utf8');
    const codexSessionPending = join(
      hiveHome,
      'wake',
      'sessions',
      sessionKeyFor('codex', 'codex-persisted-owner'),
      'pending-notifications.jsonl',
    );
    const wrongClaudePending = join(
      hiveHome,
      'wake',
      'sessions',
      sessionKeyFor('claude-code', 'ambient-claude-session'),
      'pending-notifications.jsonl',
    );

    expect(localPending).toContain('"targetAgent":"codex"');
    expect(localPending).toContain('"ownerSessionId":"codex-persisted-owner"');
    expect(readFileSync(codexSessionPending, 'utf8')).toContain(taskId);
    expect(existsSync(wrongClaudePending)).toBe(false);
  });

  it('routes completion notifications from durable result ownership after tracking is consumed', () => {
    const projectRoot = tempDir('hf-bridge-result-owner-project-');
    const hiveHome = tempDir('hf-bridge-result-owner-home-');
    const taskId = 'task-result-owned-codex';
    const resultFile = join(projectRoot, '.hive-flow', 'tasks', `${taskId}.result.json`);
    mkdirSync(dirname(resultFile), { recursive: true });
    writeFileSync(resultFile, JSON.stringify({
      success: true,
      agentId: 'codex-result-owner-agent',
      ownerSessionId: 'codex-result-owner',
      ownerClientKind: 'codex',
      targetAgent: 'codex',
      content: 'finished',
    }), 'utf8');

    process.env.HIVE_FLOW_HOME = hiveHome;
    process.env.HIVE_FLOW_SESSION_ID = 'ambient-hive-session';
    process.env.HIVE_FLOW_CLIENT_KIND = 'claude-code';
    process.env.CLAUDE_SESSION_ID = 'ambient-claude-session';
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;

    expect(bridge.notifyTaskCompletionFromResultFile(resultFile)).toBe(true);

    const localPending = readFileSync(join(projectRoot, '.hive-flow', 'data', 'pending-notifications.jsonl'), 'utf8');
    const codexSessionPending = join(
      hiveHome,
      'wake',
      'sessions',
      sessionKeyFor('codex', 'codex-result-owner'),
      'pending-notifications.jsonl',
    );
    const wrongClaudePending = join(
      hiveHome,
      'wake',
      'sessions',
      sessionKeyFor('claude-code', 'ambient-claude-session'),
      'pending-notifications.jsonl',
    );

    expect(localPending).toContain('"targetAgent":"codex"');
    expect(localPending).toContain('"ownerSessionId":"codex-result-owner"');
    expect(readFileSync(codexSessionPending, 'utf8')).toContain(taskId);
    expect(existsSync(wrongClaudePending)).toBe(false);
  });

  it('uses a codex-prefixed result agent id as a target fallback for legacy result files', () => {
    const projectRoot = tempDir('hf-bridge-agentid-owner-project-');
    const hiveHome = tempDir('hf-bridge-agentid-owner-home-');
    const taskId = 'task-agentid-owned-codex';
    const resultFile = join(projectRoot, '.hive-flow', 'tasks', `${taskId}.result.json`);
    mkdirSync(dirname(resultFile), { recursive: true });
    writeFileSync(resultFile, JSON.stringify({
      success: true,
      agentId: 'codex-dedupe-root-scripts-openrouter',
      content: 'finished',
    }), 'utf8');

    process.env.HIVE_FLOW_HOME = hiveHome;
    delete process.env.HIVE_FLOW_SESSION_ID;
    delete process.env.HIVE_FLOW_CLIENT_KIND;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;

    expect(bridge.notifyTaskCompletionFromResultFile(resultFile)).toBe(true);

    const localPending = readFileSync(join(projectRoot, '.hive-flow', 'data', 'pending-notifications.jsonl'), 'utf8');
    expect(localPending).toContain('"targetAgent":"codex"');
    expect(localPending).toContain('agent=codex-dedupe-root-scripts-openrouter');
    expect(existsSync(join(hiveHome, 'wake'))).toBe(false);
  });

  it('uses a codex-prefixed result agent id over stale ambient Claude ownership', () => {
    const projectRoot = tempDir('hf-bridge-agentid-conflict-project-');
    const hiveHome = tempDir('hf-bridge-agentid-conflict-home-');
    const taskId = 'task-agentid-conflict-codex';
    const resultFile = join(projectRoot, '.hive-flow', 'tasks', `${taskId}.result.json`);
    mkdirSync(dirname(resultFile), { recursive: true });
    writeFileSync(resultFile, JSON.stringify({
      success: true,
      agentId: 'codex-notif-canary-deepseek',
      targetAgent: 'claude',
      ownerClientKind: 'claude-code',
      content: 'finished',
    }), 'utf8');

    process.env.HIVE_FLOW_HOME = hiveHome;
    process.env.HIVE_FLOW_SESSION_ID = 'ambient-hive-session';
    process.env.HIVE_FLOW_CLIENT_KIND = 'claude-code';
    process.env.CLAUDE_SESSION_ID = 'ambient-claude-session';
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;

    expect(bridge.notifyTaskCompletionFromResultFile(resultFile)).toBe(true);

    const localPending = readFileSync(join(projectRoot, '.hive-flow', 'data', 'pending-notifications.jsonl'), 'utf8');
    expect(localPending).toContain('"targetAgent":"codex"');
    expect(localPending).toContain('agent=codex-notif-canary-deepseek');
    expect(existsSync(join(hiveHome, 'wake'))).toBe(false);
  });

  it('records denied provider tool attempts for queen review without waking the operator', async () => {
    const projectRoot = tempDir('hf-bridge-permission-project-');
    const hiveHome = tempDir('hf-bridge-permission-home-');
    const taskId = 'task-permission-queen-review';
    const hiveId = 'hive-permission-review';
    const resultFile = join(projectRoot, '.hive-flow', 'tasks', `${taskId}.result.json`);
    mkdirSync(dirname(resultFile), { recursive: true });
    mkdirSync(join(projectRoot, '.hive-flow', 'agents'), { recursive: true });
    writeFileSync(join(projectRoot, '.hive-flow', 'agents', 'store.json'), JSON.stringify({
      agents: {
        'agent-needs-permission': {
          id: 'agent-needs-permission',
          provider: 'deepseek',
          ownerSessionId: 'permission-owner-session',
          ownerClientKind: 'codex',
          config: {
            hiveId,
            queenId: 'queen-permission-review',
          },
        },
      },
    }, null, 2), 'utf8');

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
      permissionRequest: {
        status: 'pending',
        routedTo: 'queen',
        action: 'queen-review-required',
        workerAction: 'continue-with-available-tools',
        agentId: 'agent-needs-permission',
        hiveId: 'hive-permission-review',
        queenId: 'queen-permission-review',
        tool: 'run_command',
      },
    });
    expect(denied.permissionRequest.requestId).toMatch(/^permission-[0-9a-f]{16}$/);

    const hivePermissionFile = join(projectRoot, '.hive-flow', 'hives', hiveId, 'permission-requests.jsonl');
    const hivePermissionText = readFileSync(hivePermissionFile, 'utf8');

    expect(existsSync(join(projectRoot, '.hive-flow', 'data', 'pending-notifications.jsonl'))).toBe(false);
    expect(existsSync(join(
      hiveHome,
      'wake',
      'sessions',
      sessionKeyFor('codex', 'permission-owner-session'),
      'pending-notifications.jsonl',
    ))).toBe(false);

    expect(hivePermissionText).toContain('"kind":"worker-permission-denial"');
    expect(hivePermissionText).toContain(`"requestId":"${denied.permissionRequest.requestId}"`);
    expect(hivePermissionText).toContain('"agentId":"agent-needs-permission"');
    expect(hivePermissionText).toContain('"hiveId":"hive-permission-review"');
    expect(hivePermissionText).toContain('"queenId":"queen-permission-review"');
    expect(hivePermissionText).toContain('"tool":"run_command"');
    expect(hivePermissionText).toContain('"denyCode":"read-only-command-denied"');
    expect(hivePermissionText).toContain("git subcommand 'mv'");
    expect(hivePermissionText).toContain('Queen should redirect the worker');
    expect(hivePermissionText).not.toContain('Owning operator');

    const deniedAgain = JSON.parse(await bridge.executeBridgeTool('run_command', {
      argv: ['git', 'mv', 'old-name', 'new-name'],
    }, {
      agentId: 'agent-needs-permission',
      resultFile,
      source: 'test',
    }));
    expect(deniedAgain.status).toBe('denied');
    expect(deniedAgain.permissionRequest.requestId).toBe(denied.permissionRequest.requestId);
    expect(readFileSync(hivePermissionFile, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('routes queenless denied provider tools to the owning parent wake queue', async () => {
    const projectRoot = tempDir('hf-bridge-permission-fallback-project-');
    const hiveHome = tempDir('hf-bridge-permission-fallback-home-');
    const taskId = 'task-permission-local-audit';
    const resultFile = join(projectRoot, '.hive-flow', 'tasks', `${taskId}.result.json`);
    mkdirSync(dirname(resultFile), { recursive: true });

    process.env.HIVE_FLOW_HOME = hiveHome;
    process.env.HIVE_FLOW_SESSION_ID = 'permission-owner-session';
    process.env.HIVE_FLOW_CLIENT_KIND = 'codex';

    const denied = JSON.parse(await bridge.executeBridgeTool('run_shell', {
      command: 'pwd',
    }, {
      agentId: 'standalone-provider-agent',
      resultFile,
      source: 'test',
    }));

    expect(denied.status).toBe('denied');
    expect(denied.permissionRequest).toMatchObject({
      status: 'pending',
      routedTo: 'parent',
      action: 'parent-review-required',
      workerAction: 'continue-with-available-tools',
      agentId: 'standalone-provider-agent',
      tool: 'run_shell',
      notifiedParent: true,
    });

    const localPending = readFileSync(join(projectRoot, '.hive-flow', 'data', 'pending-notifications.jsonl'), 'utf8');
    const sessionPending = readFileSync(join(
      hiveHome,
      'wake',
      'sessions',
      sessionKeyFor('codex', 'permission-owner-session'),
      'pending-notifications.jsonl',
    ), 'utf8');
    const auditText = readFileSync(join(projectRoot, '.hive-flow', 'data', 'provider-permission-denials.jsonl'), 'utf8');

    expect(localPending).toContain('"kind":"worker-permission-denial"');
    expect(localPending).toContain('"targetAgent":"codex"');
    expect(localPending).toContain('Owning parent should redirect the worker');
    expect(sessionPending).toContain('"kind":"worker-permission-denial"');
    expect(sessionPending).toContain('"targetAgent":"codex"');
    expect(existsSync(join(
      hiveHome,
      'wake',
      'sessions',
      sessionKeyFor('codex', 'permission-owner-session'),
      `task-${taskId}.${denied.permissionRequest.requestId}.permission-denial`,
    ))).toBe(true);
    expect(auditText).toContain('"kind":"worker-permission-denial"');
    expect(auditText).toContain('"agentId":"standalone-provider-agent"');
    expect(auditText).toContain('"tool":"run_shell"');
    expect(auditText).toContain('Owning parent should redirect the worker');
  });
});
