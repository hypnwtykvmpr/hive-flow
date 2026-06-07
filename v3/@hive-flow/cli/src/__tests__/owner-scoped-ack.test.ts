import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../../');
const notifyScript = resolve(root, '.claude/helpers/hive-sentinel-notify.cjs');
const hookHandlerScript = resolve(root, '.claude/helpers/hook-handler.cjs');

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), 'hive-flow-owner-ack-'));
}

function dataDir(project: string): string {
  return join(project, '.hive-flow', 'data');
}

function writeDone(project: string, hiveId: string, data: Record<string, unknown>): void {
  const dir = dataDir(project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `hive-${hiveId}.done`),
    JSON.stringify({ hiveId, completedAt: new Date().toISOString(), summary: 'done', ...data }, null, 2),
    'utf8',
  );
}

function runNotify(project: string, sessionId: string | null, command = 'teammate-idle') {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: project,
    HIVE_FLOW_PROJECT_ROOT: project,
  };
  if (sessionId === null) {
    delete env.CLAUDE_SESSION_ID;
  } else {
    env.CLAUDE_SESSION_ID = sessionId;
  }

  const result = spawnSync(process.execPath, [notifyScript, command], {
    cwd: project,
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout || '{}') as Record<string, unknown>;
}

function runHookHandlerHiveCheck(project: string, sessionId: string | null) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: project,
    HIVE_FLOW_PROJECT_ROOT: project,
  };
  if (sessionId === null) {
    delete env.CLAUDE_SESSION_ID;
  } else {
    env.CLAUDE_SESSION_ID = sessionId;
  }

  const result = spawnSync(process.execPath, [hookHandlerScript, 'hive-check-complete'], {
    cwd: project,
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout || '{}') as Record<string, unknown>;
}

function ackPath(project: string, hiveId: string): string {
  return join(dataDir(project), `hive-${hiveId}.acked`);
}

function readAck(project: string, hiveId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(ackPath(project, hiveId), 'utf8')) as Record<string, unknown>;
}

function expectEmptyHookOutput(output: Record<string, unknown>): void {
  expect(output).toEqual({});
}

function expectCompletionHookOutput(output: Record<string, unknown>, hiveId: string): void {
  const hook = output.hookSpecificOutput as { additionalContext?: string } | undefined;
  expect(hook?.additionalContext).toContain(`[HIVE COMPLETE: ${hiveId}]`);
}

function runNotifyAsync(project: string, sessionId: string): Promise<{ claimed: boolean; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [notifyScript, 'teammate-idle'], {
      cwd: project,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: project,
        HIVE_FLOW_PROJECT_ROOT: project,
        CLAUDE_SESSION_ID: sessionId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0 || stderr) {
        reject(new Error(`notify failed for ${sessionId}: code=${code} stderr=${stderr}`));
        return;
      }
      const parsed = JSON.parse(stdout || '{}') as Record<string, unknown>;
      resolvePromise({
        claimed: Boolean(parsed.hookSpecificOutput),
        output: stdout,
      });
    });
  });
}

describe('R2 owner-scoped hive completion ack', () => {
  it('lets the owner session claim its own completion immediately', () => {
    const project = makeProject();
    try {
      writeDone(project, 'hive-owner', { ownerSessionId: 'sid-owner' });

      const output = runNotify(project, 'sid-owner');

      expectCompletionHookOutput(output, 'hive-owner');
      expect(readAck(project, 'hive-owner')).toMatchObject({
        source: 'hive-sentinel-notify',
        mode: 'teammate-idle',
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('defers a foreign session inside the grace window so the owner can claim next', () => {
    const project = makeProject();
    try {
      writeDone(project, 'hive-owned', {
        ownerSessionId: 'sid-owner',
        completedAt: new Date().toISOString(),
      });

      expectEmptyHookOutput(runNotify(project, 'sid-foreign'));
      expect(existsSync(ackPath(project, 'hive-owned'))).toBe(false);

      const owner = runNotify(project, 'sid-owner');
      expectCompletionHookOutput(owner, 'hive-owned');
      expect(readAck(project, 'hive-owned')).toMatchObject({
        source: 'hive-sentinel-notify',
        mode: 'teammate-idle',
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('falls back to repo-wide first-come after owner grace elapses', () => {
    const project = makeProject();
    try {
      writeDone(project, 'hive-dead-owner', {
        ownerSessionId: 'sid-owner',
        completedAt: new Date(Date.now() - 60_000).toISOString(),
      });

      const output = runNotify(project, 'sid-foreign');

      expectCompletionHookOutput(output, 'hive-dead-owner');
      expect(existsSync(ackPath(project, 'hive-dead-owner'))).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('falls back immediately when completedAt is unparseable', () => {
    const project = makeProject();
    try {
      writeDone(project, 'hive-bad-time', {
        ownerSessionId: 'sid-owner',
        completedAt: 'not-a-date',
      });

      const output = runNotify(project, 'sid-foreign');

      expectCompletionHookOutput(output, 'hive-bad-time');
      expect(existsSync(ackPath(project, 'hive-bad-time'))).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('applies owner preference to stop notify as well as teammate idle', () => {
    const project = makeProject();
    try {
      writeDone(project, 'hive-stop-owned', {
        ownerSessionId: 'sid-owner',
        completedAt: new Date().toISOString(),
      });

      expectEmptyHookOutput(runNotify(project, 'sid-foreign', 'stop-notify'));
      expect(existsSync(ackPath(project, 'hive-stop-owned'))).toBe(false);

      const owner = runNotify(project, 'sid-owner', 'stop-notify');
      const hook = owner.hookSpecificOutput as { additionalContext?: string } | undefined;
      expect(hook?.additionalContext).toContain('[HIVE DONE — STOP SUMMARY: hive-stop-owned]');
      expect(existsSync(ackPath(project, 'hive-stop-owned'))).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('applies owner preference to the PostToolUse hive-check-complete path', () => {
    const project = makeProject();
    try {
      writeDone(project, 'hive-post-tool-owned', {
        ownerSessionId: 'sid-owner',
        completedAt: new Date().toISOString(),
      });

      expectEmptyHookOutput(runHookHandlerHiveCheck(project, 'sid-foreign'));
      expect(existsSync(ackPath(project, 'hive-post-tool-owned'))).toBe(false);

      const owner = runHookHandlerHiveCheck(project, 'sid-owner');
      const hook = owner.hookSpecificOutput as { additionalContext?: string } | undefined;
      expect(hook?.additionalContext).toContain('[HIVE_COMPLETE] hive=hive-post-tool-owned');
      expect(existsSync(ackPath(project, 'hive-post-tool-owned'))).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('keeps legacy done files first-come without requiring an owner', () => {
    const project = makeProject();
    try {
      writeDone(project, 'hive-legacy', { ownerSessionId: undefined });

      const output = runNotify(project, 'sid-any');

      expectCompletionHookOutput(output, 'hive-legacy');
      expect(existsSync(ackPath(project, 'hive-legacy'))).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('preserves a single ack winner under concurrent owner claim attempts', async () => {
    const project = makeProject();
    try {
      writeDone(project, 'hive-race', { ownerSessionId: 'sid-owner' });

      const results = await Promise.all([
        runNotifyAsync(project, 'sid-owner'),
        runNotifyAsync(project, 'sid-owner'),
      ]);

      expect(results.filter(result => result.claimed)).toHaveLength(1);
      expect(existsSync(ackPath(project, 'hive-race'))).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
