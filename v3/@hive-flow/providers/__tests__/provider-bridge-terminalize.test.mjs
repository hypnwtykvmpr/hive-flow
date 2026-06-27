/**
 * HF-13 Slice D1 — bridge terminalization + credential-holder timeout.
 *
 * Verifies the idempotent terminal-failure contract used by SIGTERM /
 * uncaughtException / unhandledRejection, plus the bounded credential-holder
 * call:
 *   - terminalizeBridgeFailure writes one failed result file and only idles the
 *     agent when the persisted currentTaskId still matches that result task.
 *   - callWithTimeout rejects with a timeout error when the inner promise hangs,
 *     and resolves normally otherwise.
 *   - resolveCredentialHolderTimeoutMs is bounded and grace-padded.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = resolve(here, '../scripts/provider-agent-bridge.mjs');

let terminalizeBridgeFailure;
let callWithTimeout;
let resolveCredentialHolderTimeoutMs;

// The bridge registers SIGTERM/uncaughtException/unhandledRejection listeners on
// import — capture the pre-import set so we can detach the bridge's listeners and
// not perturb the vitest runner.
function restoreListeners(event, preserved) {
  const keep = new Set(preserved);
  for (const listener of process.listeners(event)) {
    if (!keep.has(listener)) process.off(event, listener);
  }
}

let preSig, preUncaught, preRejection;

beforeAll(async () => {
  preSig = process.listeners('SIGTERM');
  preUncaught = process.listeners('uncaughtException');
  preRejection = process.listeners('unhandledRejection');
  ({ terminalizeBridgeFailure, callWithTimeout, resolveCredentialHolderTimeoutMs } =
    await import(`${pathToFileURL(bridgePath).href}?terminalize=${Date.now()}`));
});

afterAll(() => {
  restoreListeners('SIGTERM', preSig);
  restoreListeners('uncaughtException', preUncaught);
  restoreListeners('unhandledRejection', preRejection);
});

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'hf-terminalize-'));
  const storeDir = join(root, '.hive-flow', 'agents');
  const tasksDir = join(root, '.hive-flow', 'tasks');
  mkdirSync(storeDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  return { root, storeDir, tasksDir, storePath: join(storeDir, 'store.json') };
}

describe('terminalizeBridgeFailure', () => {
  it('writes a failed result and idles the agent, clearing currentTaskPid + currentTaskId', () => {
    const { root, storeDir, tasksDir, storePath } = makeProject();
    try {
      writeFileSync(storePath, JSON.stringify({
        agents: {
          'agent-x': {
            agentId: 'agent-x',
            provider: 'openrouter',
            status: 'busy',
            currentTaskPid: 999999,
            currentTaskId: 'task-x',
            taskId: 'task-x',
          },
        },
        version: '3.0.0',
      }), 'utf-8');
      const resultFile = join(tasksDir, 'task-x.result.json');

      const wrote = terminalizeBridgeFailure({
        error: 'boom',
        code: 'UNCAUGHT_EXCEPTION',
        paths: { agentId: 'agent-x', storeDir, resultFile },
      });

      expect(wrote).toBe(true);
      expect(existsSync(resultFile)).toBe(true);
      const result = JSON.parse(readFileSync(resultFile, 'utf-8'));
      expect(result.success).toBe(false);
      expect(result.code).toBe('UNCAUGHT_EXCEPTION');
      expect(result.agentId).toBe('agent-x');

      const agent = JSON.parse(readFileSync(storePath, 'utf-8')).agents['agent-x'];
      expect(agent.status).toBe('idle');
      expect(agent.currentTaskPid).toBeUndefined();
      expect(agent.currentTaskId).toBeUndefined();
      expect(agent.taskId).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent — a second call preserves the original terminal result', () => {
    const { root, storeDir, tasksDir, storePath } = makeProject();
    try {
      writeFileSync(storePath, JSON.stringify({
        agents: { 'agent-y': { agentId: 'agent-y', provider: 'deepseek', status: 'busy', currentTaskId: 'task-y' } },
        version: '3.0.0',
      }), 'utf-8');
      const resultFile = join(tasksDir, 'task-y.result.json');
      const paths = { agentId: 'agent-y', storeDir, resultFile };

      terminalizeBridgeFailure({ error: 'first', code: 'SIGTERM', paths });
      const wrote2 = terminalizeBridgeFailure({ error: 'second', code: 'SIGTERM', paths });

      expect(wrote2).toBe(false);
      const result = JSON.parse(readFileSync(resultFile, 'utf-8'));
      expect(result.error).toBe('first');
      const agent = JSON.parse(readFileSync(storePath, 'utf-8')).agents['agent-y'];
      expect(agent.status).toBe('idle');
      expect(agent.currentTaskId).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not overwrite or restamp state when the result file already exists', () => {
    const { root, storeDir, tasksDir, storePath } = makeProject();
    try {
      writeFileSync(storePath, JSON.stringify({
        agents: {
          'agent-existing': {
            agentId: 'agent-existing',
            provider: 'openrouter',
            status: 'busy',
            currentTaskPid: 222333,
            currentTaskId: 'task-existing',
          },
        },
        version: '3.0.0',
      }), 'utf-8');
      const resultFile = join(tasksDir, 'task-existing.result.json');
      writeFileSync(resultFile, JSON.stringify({ success: true, response: 'already terminal' }), 'utf-8');

      const wrote = terminalizeBridgeFailure({
        error: 'late error',
        code: 'UNHANDLED_REJECTION',
        paths: { agentId: 'agent-existing', storeDir, resultFile },
      });

      expect(wrote).toBe(false);
      const result = JSON.parse(readFileSync(resultFile, 'utf-8'));
      expect(result.response).toBe('already terminal');
      const agent = JSON.parse(readFileSync(storePath, 'utf-8')).agents['agent-existing'];
      expect(agent.status).toBe('busy');
      expect(agent.currentTaskPid).toBe(222333);
      expect(agent.currentTaskId).toBe('task-existing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not idle a newer task when a stale result task terminalizes late', () => {
    const { root, storeDir, tasksDir, storePath } = makeProject();
    try {
      writeFileSync(storePath, JSON.stringify({
        agents: {
          'agent-z': {
            agentId: 'agent-z',
            provider: 'deepseek',
            status: 'busy',
            currentTaskPid: 123456,
            currentTaskId: 'task-new',
            taskId: 'task-old',
          },
        },
        version: '3.0.0',
      }), 'utf-8');
      const resultFile = join(tasksDir, 'task-old.result.json');

      const wrote = terminalizeBridgeFailure({
        error: 'late failure',
        code: 'UNHANDLED_REJECTION',
        paths: { agentId: 'agent-z', storeDir, resultFile },
      });

      expect(wrote).toBe(true);
      const agent = JSON.parse(readFileSync(storePath, 'utf-8')).agents['agent-z'];
      expect(agent.status).toBe('busy');
      expect(agent.currentTaskPid).toBe(123456);
      expect(agent.currentTaskId).toBe('task-new');
      expect(agent.taskId).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('callWithTimeout (credential-holder bound)', () => {
  it('rejects with a timeout error when the inner promise never settles', async () => {
    const hang = new Promise(() => {}); // never resolves
    await expect(callWithTimeout(hang, 25, 'credential holder provider_call (openrouter)'))
      .rejects.toThrow(/timed out/i);
  });

  it('resolves with the inner value on the normal path', async () => {
    const ok = Promise.resolve({ ok: true, response: { content: 'hi' } });
    await expect(callWithTimeout(ok, 1000, 'holder')).resolves.toEqual({ ok: true, response: { content: 'hi' } });
  });
});

describe('resolveCredentialHolderTimeoutMs', () => {
  it('adds grace to the request timeout and stays bounded', () => {
    const t = resolveCredentialHolderTimeoutMs(60000, 30000);
    expect(t).toBeGreaterThan(60000);
    expect(t).toBeLessThanOrEqual(10 * 60000);
  });

  it('caps absurd timeouts at the 10 minute ceiling', () => {
    expect(resolveCredentialHolderTimeoutMs(99_999_999, undefined)).toBe(10 * 60000);
  });

  it('falls back to a default when no positive timeout is provided', () => {
    expect(resolveCredentialHolderTimeoutMs(undefined, undefined)).toBeGreaterThan(0);
  });
});
