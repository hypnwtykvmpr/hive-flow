import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const require = createRequire(import.meta.url);
const drain = require(join(REPO_ROOT, '.claude', 'helpers', 'drain-notifications.cjs'));

const tempDirs = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sessionKey(rawSession, clientKind = 'claude-code') {
  return `s_${createHash('sha256').update(`${clientKind}\0${rawSession}`).digest('hex').slice(0, 32)}`;
}

function pendingFile(home, rawSession) {
  return join(home, 'wake', 'sessions', sessionKey(rawSession), 'pending-notifications.jsonl');
}

function withEnv(updates, fn) {
  const previous = {};
  for (const key of Object.keys(updates)) {
    previous[key] = process.env[key];
    if (updates[key] === undefined) delete process.env[key];
    else process.env[key] = updates[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('drain-notifications global wake queues', () => {
  it('drains only the requested global wake session and leaves sibling sessions queued', () => {
    const projectRoot = tempDir('hf-drain-project-');
    const home = tempDir('hf-drain-home-');
    const origHome = process.env.HIVE_FLOW_HOME;
    const origKind = process.env.HIVE_FLOW_CLIENT_KIND;
    process.env.HIVE_FLOW_HOME = home;
    process.env.HIVE_FLOW_CLIENT_KIND = 'claude-code';

    try {
      const sessionAFile = pendingFile(home, 'claude-session-a');
      const sessionBFile = pendingFile(home, 'claude-session-b');
      mkdirSync(dirname(sessionAFile), { recursive: true });
      mkdirSync(dirname(sessionBFile), { recursive: true });
      writeFileSync(
        sessionAFile,
        JSON.stringify({
          kind: 'hive',
          hiveId: 'hive-a',
          summary: '[HIVE COMPLETE: hive-a] session A done',
        }) + '\n',
        'utf8',
      );
      writeFileSync(
        sessionBFile,
        JSON.stringify({
          kind: 'hive',
          hiveId: 'hive-b',
          summary: '[HIVE COMPLETE: hive-b] session B done',
        }) + '\n',
        'utf8',
      );

      const output = drain.drainNotifications(projectRoot, {
        session_id: 'claude-session-a',
        client_kind: 'claude-code',
      });

      const context = output.hookSpecificOutput?.additionalContext ?? '';
      assert.match(context, /session A done/);
      assert.doesNotMatch(context, /session B done/);
      assert.equal(existsSync(sessionAFile), false);
      assert.equal(existsSync(sessionBFile), true);
      assert.match(readFileSync(sessionBFile, 'utf8'), /session B done/);
    } finally {
      if (origHome !== undefined) process.env.HIVE_FLOW_HOME = origHome;
      else delete process.env.HIVE_FLOW_HOME;
      if (origKind !== undefined) process.env.HIVE_FLOW_CLIENT_KIND = origKind;
      else delete process.env.HIVE_FLOW_CLIENT_KIND;
    }
  });

  it('does not let a Claude drain consume a Codex-owned project-local completion', () => {
    const projectRoot = tempDir('hf-drain-project-codex-owned-');
    const pending = join(projectRoot, '.hive-flow', 'data', 'pending-notifications.jsonl');
    mkdirSync(dirname(pending), { recursive: true });
    writeFileSync(
      pending,
      JSON.stringify({
        kind: 'task',
        taskId: 'task-codex-owned-shared-line',
        summary: '[TASK COMPLETE: task-codex-owned-shared-line] agent=codex-dedupe-root-scripts-openrouter status=completed.',
      }) + '\n',
      'utf8',
    );

    const claudeOutput = withEnv({ HIVE_FLOW_CLIENT_KIND: 'claude-code' }, () => drain.drainNotifications(projectRoot, {
      session_id: 'claude-session',
      client_kind: 'claude-code',
    }));

    assert.deepEqual(claudeOutput, {});
    assert.equal(existsSync(pending), true);
    assert.match(readFileSync(pending, 'utf8'), /codex-dedupe-root-scripts-openrouter/);

    const codexOutput = withEnv({ HIVE_FLOW_CLIENT_KIND: 'codex' }, () => drain.drainNotifications(projectRoot, {
      session_id: 'codex-session',
      client_kind: 'codex',
    }));

    const context = codexOutput.hookSpecificOutput?.additionalContext ?? '';
    assert.match(context, /codex-owned-shared-line/);
    assert.equal(existsSync(pending), false);
  });

  it('drains queenless worker permission denials to the parent and drops hive-scoped permission noise', () => {
    const projectRoot = tempDir('hf-drain-project-permission-parent-');
    const home = tempDir('hf-drain-home-permission-parent-');
    const origHome = process.env.HIVE_FLOW_HOME;
    const origKind = process.env.HIVE_FLOW_CLIENT_KIND;
    process.env.HIVE_FLOW_HOME = home;
    process.env.HIVE_FLOW_CLIENT_KIND = 'claude-code';

    try {
      const sessionFile = pendingFile(home, 'claude-session-permission-parent');
      mkdirSync(dirname(sessionFile), { recursive: true });
      writeFileSync(
        sessionFile,
        [
          JSON.stringify({
            kind: 'worker-permission-denial',
            taskId: 'task-queenless-denied',
            targetAgent: 'claude',
            ownerClientKind: 'claude-code',
            summary: '[WORKER PERMISSION DENIAL: task-queenless-denied] parent should redirect.',
          }),
          JSON.stringify({
            kind: 'worker-permission-denial',
            taskId: 'task-hive-denied',
            hiveId: 'hive-queen-owned',
            targetAgent: 'claude',
            ownerClientKind: 'claude-code',
            summary: '[WORKER PERMISSION DENIAL: task-hive-denied] queen should handle.',
          }),
          JSON.stringify({
            kind: 'provider-permission-denial',
            taskId: 'task-provider-denied',
            targetAgent: 'claude',
            ownerClientKind: 'claude-code',
            summary: '[PROVIDER PERMISSION DENIAL: task-provider-denied] legacy audit noise.',
          }),
        ].join('\n') + '\n',
        'utf8',
      );

      const output = drain.drainNotifications(projectRoot, {
        session_id: 'claude-session-permission-parent',
        client_kind: 'claude-code',
      });
      const context = output.hookSpecificOutput?.additionalContext ?? '';
      assert.match(context, /task-queenless-denied/);
      assert.doesNotMatch(context, /task-hive-denied/);
      assert.doesNotMatch(context, /task-provider-denied/);
      assert.equal(existsSync(sessionFile), false);
    } finally {
      if (origHome !== undefined) process.env.HIVE_FLOW_HOME = origHome;
      else delete process.env.HIVE_FLOW_HOME;
      if (origKind !== undefined) process.env.HIVE_FLOW_CLIENT_KIND = origKind;
      else delete process.env.HIVE_FLOW_CLIENT_KIND;
    }
  });

  it('uses durable result owner after task tracking has been consumed', () => {
    const projectRoot = tempDir('hf-drain-project-result-owned-');
    const pending = join(projectRoot, '.hive-flow', 'data', 'pending-notifications.jsonl');
    const tasksDir = join(projectRoot, '.hive-flow', 'tasks');
    mkdirSync(dirname(pending), { recursive: true });
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      join(tasksDir, 'task-result-owned-codex.result.json'),
      JSON.stringify({
        success: true,
        agentId: 'codex-result-owned-agent',
        ownerSessionId: 'codex-session',
        ownerClientKind: 'codex',
        targetAgent: 'codex',
        content: 'done',
      }),
      'utf8',
    );
    writeFileSync(
      pending,
      JSON.stringify({
        kind: 'task',
        taskId: 'task-result-owned-codex',
        targetAgent: 'claude',
        summary: '[TASK COMPLETE: task-result-owned-codex] agent=codex-result-owned-agent status=completed.',
      }) + '\n',
      'utf8',
    );

    const claudeOutput = withEnv({ HIVE_FLOW_CLIENT_KIND: 'claude-code' }, () => drain.drainNotifications(projectRoot, {
      session_id: 'claude-session',
      client_kind: 'claude-code',
    }));

    assert.deepEqual(claudeOutput, {});
    assert.equal(existsSync(pending), true);

    const codexOutput = withEnv({ HIVE_FLOW_CLIENT_KIND: 'codex' }, () => drain.drainNotifications(projectRoot, {
      session_id: 'codex-session',
      client_kind: 'codex',
    }));

    const context = codexOutput.hookSpecificOutput?.additionalContext ?? '';
    assert.match(context, /task-result-owned-codex/);
    assert.equal(existsSync(pending), false);
  });
});
