import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, '.claude', 'helpers', 'agent-task-rewake.cjs');
const requireHelper = createRequire(import.meta.url);
const rewake = requireHelper(SCRIPT);

const cleanupPaths = [];
const cleanupChildren = [];

afterEach(async () => {
  while (cleanupChildren.length) {
    const child = cleanupChildren.pop();
    if (!child || child.exitCode !== null || child.signalCode !== null) continue;
    try { child.kill('SIGKILL'); } catch { /* best effort */ }
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(resolve, 500);
    });
  }
  while (cleanupPaths.length) {
    rmSync(cleanupPaths.pop(), { recursive: true, force: true });
  }
});

function makeProjectDir() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agent-task-rewake-'));
  cleanupPaths.push(projectRoot);
  return projectRoot;
}

function writeTaskTracking(projectRoot, taskId, tracking) {
  const tasksDir = join(projectRoot, '.hive-flow', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, `${taskId}.json`), JSON.stringify({
    taskId,
    ...tracking,
  }, null, 2));
}

function pendingNotifications(projectRoot) {
  const file = join(projectRoot, '.hive-flow', 'data', 'pending-notifications.jsonl');
  return existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean)
    : [];
}

function checkDueMarker(projectRoot, taskId) {
  return join(projectRoot, '.hive-flow', 'data', `task-${taskId}.check-due`);
}

function hookInput(taskId) {
  return JSON.stringify({
    tool_name: 'mcp__hive-flow__agent_task',
    tool_response: JSON.stringify({ success: true, taskId, status: 'running' }),
    session_id: 'session-test',
    client_kind: 'claude-code',
  });
}

function runHook(projectRoot, taskId, env = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectRoot,
        HIVE_FLOW_CLIENT_KIND: 'claude',
        HIVE_FLOW_REWAKE_MAX_WAIT_MS: '50',
        HIVE_FLOW_REWAKE_POLL_MS: '5',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr, durationMs: Date.now() - startedAt });
    });
    child.stdin.end(hookInput(taskId));
  });
}

function spawnShortChild() {
  return spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
}

async function deadPid() {
  const child = spawnShortChild();
  await new Promise((resolve) => child.once('exit', resolve));
  if (rewake.pidLiveness(child.pid) === 'dead') return child.pid;

  for (const candidate of [999_999_999, 2_147_483_647]) {
    if (rewake.pidLiveness(candidate) === 'dead') return candidate;
  }
  throw new Error('could not find a demonstrably dead pid for this platform');
}

function spawnLiveChild() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    stdio: 'ignore',
  });
  cleanupChildren.push(child);
  return child;
}

describe('agent-task-rewake pending task classification', () => {
  it('treats terminal persisted task status as done even when no result file exists', async () => {
    const projectRoot = makeProjectDir();
    const taskId = 'task-terminal';
    writeTaskTracking(projectRoot, taskId, {
      status: 'failed',
      agentId: 'agent-terminal',
      pid: await deadPid(),
    });

    const result = await runHook(projectRoot, taskId, {
      HIVE_FLOW_REWAKE_MAX_WAIT_MS: '500',
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(pendingNotifications(projectRoot), []);
    assert.equal(existsSync(checkDueMarker(projectRoot, taskId)), false);
  });

  it('wakes immediately for a dead child pid instead of waiting for the full timeout', async () => {
    const projectRoot = makeProjectDir();
    const taskId = 'task-deadpid';
    const pid = await deadPid();
    writeTaskTracking(projectRoot, taskId, {
      status: 'running',
      agentId: 'agent-deadpid',
      pid,
    });

    const result = await runHook(projectRoot, taskId, {
      HIVE_FLOW_REWAKE_MAX_WAIT_MS: '30000',
      HIVE_FLOW_REWAKE_POLL_MS: '1000',
    });

    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /\[TASK CHECK DUE: task-deadpid\]/);
    assert.match(result.stderr, /no longer alive/);
    assert.ok(result.durationMs < 3000, `expected immediate dead-pid wake, took ${result.durationMs}ms`);
    const pending = pendingNotifications(projectRoot);
    assert.equal(pending.length, 1);
    assert.match(pending[0], /"reason":"dead-pid"/);
    assert.equal(existsSync(checkDueMarker(projectRoot, taskId)), true);
  });

  it('does not classify a live slow child as dead or waiting before its deadline', () => {
    const projectRoot = makeProjectDir();
    const taskId = 'task-live';
    const child = spawnLiveChild();
    writeTaskTracking(projectRoot, taskId, {
      status: 'running',
      agentId: 'agent-live',
      pid: child.pid,
    });

    assert.deepEqual(rewake.classifyPendingTaskState(projectRoot, taskId), { kind: 'pending' });
  });

  it('suppresses timeout nags for explicit permission and queen waiting states', async () => {
    for (const [taskId, status] of [
      ['task-permission', 'permission-waiting'],
      ['task-queen', 'waiting-for-queen'],
    ]) {
      const projectRoot = makeProjectDir();
      writeTaskTracking(projectRoot, taskId, {
        status,
        agentId: `agent-${taskId}`,
        pid: await deadPid(),
      });

      const result = await runHook(projectRoot, taskId);

      assert.equal(result.code, 0, `${taskId}: ${result.stderr}`);
      assert.equal(result.stderr, '');
      assert.deepEqual(pendingNotifications(projectRoot), []);
      assert.equal(existsSync(checkDueMarker(projectRoot, taskId)), false);
    }
  });

  it('deduplicates the dead-pid recovery nudge across repeated hook runs', async () => {
    const projectRoot = makeProjectDir();
    const taskId = 'task-dedup';
    writeTaskTracking(projectRoot, taskId, {
      status: 'running',
      agentId: 'agent-dedup',
      pid: await deadPid(),
    });

    const first = await runHook(projectRoot, taskId);
    const second = await runHook(projectRoot, taskId);

    assert.equal(first.code, 2, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.stderr, '');
    const pending = pendingNotifications(projectRoot);
    assert.equal(pending.length, 1);
    assert.match(pending[0], /"taskId":"task-dedup"/);
  });
});
