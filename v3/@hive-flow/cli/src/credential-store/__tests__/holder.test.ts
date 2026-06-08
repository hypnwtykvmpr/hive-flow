import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CapabilityTokenIssuer,
  CredentialHolderService,
  assertFullRestartRequiresUnlock,
  sameRuntimeRestartCanRecover,
} from '../holder.js';
import { CREDENTIAL_BOUNDARY_GATES, getCredentialBoundaryGate } from '../boundary-gates.js';

let roots: string[] = [];

function tempSocketPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'hf-holder-'));
  roots.push(root);
  return join(root, '.hive-flow', 'run', 'credential-agent.sock');
}

afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('credential USE-not-KNOW boundary gate', () => {
  it('flips the PR3 gate green while PR4 strict API gate remains pending', () => {
    expect(getCredentialBoundaryGate('credential-use-not-know')).toMatchObject({
      targetSlice: 'PR3',
      status: 'green',
    });
    expect(getCredentialBoundaryGate('strict-api-no-env-no-config-serialization')).toMatchObject({
      targetSlice: 'PR4',
      status: 'xfail',
    });
    expect(CREDENTIAL_BOUNDARY_GATES.filter(gate => gate.status === 'xfail').map(gate => gate.id)).toEqual([
      'strict-api-no-env-no-config-serialization',
    ]);
  });
});

describe('credential holder socket lifecycle', () => {
  it('claims the per-user socket atomically with 0700 dir and 0600 socket permissions', async () => {
    const socketPath = tempSocketPath();
    const holder = new CredentialHolderService({
      socketPath,
      uid: 1234,
      peerCredentialResolver: async () => ({ pid: process.pid, uid: 1234, startTime: 'now' }),
      now: () => 1000,
      randomToken: () => 'token-1',
    });
    await holder.start();
    try {
      expect(existsSync(socketPath)).toBe(true);
      expect(lstatSync(socketPath).isSocket()).toBe(true);
      expect(statSync(join(socketPath, '..')).mode & 0o777).toBe(0o700);
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    } finally {
      await holder.stop();
    }
    expect(existsSync(socketPath)).toBe(false);
  });

  it('refuses socket squat attempts when the socket path pre-exists', async () => {
    const socketPath = tempSocketPath();
    mkdirSync(join(socketPath, '..'), { recursive: true });
    writeFileSync(socketPath, 'attacker');
    const holder = new CredentialHolderService({
      socketPath,
      uid: 1234,
      peerCredentialResolver: async () => ({ pid: process.pid, uid: 1234, startTime: 'now' }),
    });
    await expect(holder.start()).rejects.toThrow(/pre-existing|socket squat|not a socket/i);
  });
});

describe('credential holder same-user USE grants', () => {
  it('grants same-user USE without returning raw key material', async () => {
    const holder = new CredentialHolderService({
      socketPath: tempSocketPath(),
      uid: 501,
      peerCredentialResolver: async () => ({ pid: 42, uid: 501, startTime: 'pid-start-1' }),
      now: () => 1_000,
      randomToken: () => 'cap-1',
    });
    holder.setProviderSecret('openrouter', Buffer.from('or-raw-secret'));
    const grant = await holder.requestUseGrant({
      taskId: 'task-1',
      provider: 'openrouter',
      callerPid: 42,
    });
    expect(grant).toEqual({
      capability: 'provider-use',
      provider: 'openrouter',
      taskId: 'task-1',
      token: 'cap-1',
      expiresAt: 61_000,
    });
    expect(JSON.stringify(grant)).not.toContain('or-raw-secret');

    const response = await holder.useProviderGrant(grant.token, {
      taskId: 'task-1',
      provider: 'openrouter',
      callerPid: 42,
      callerStartTime: 'pid-start-1',
    }, async ({ secret }) => {
      expect(secret).toEqual(Buffer.from('or-raw-secret'));
      return { ok: true, body: 'provider response' };
    });
    expect(response).toEqual({ ok: true, body: 'provider response' });
    expect(JSON.stringify(response)).not.toContain('or-raw-secret');
  });

  it('refuses provider handler responses that contain raw key material', async () => {
    const holder = new CredentialHolderService({
      socketPath: tempSocketPath(),
      uid: 501,
      peerCredentialResolver: async () => ({ pid: 42, uid: 501, startTime: 'pid-start-1' }),
      now: () => 1_000,
      randomToken: () => 'cap-leak',
    });
    holder.setProviderSecret('openrouter', Buffer.from('or-raw-secret'));
    const grant = await holder.requestUseGrant({
      taskId: 'task-1',
      provider: 'openrouter',
      callerPid: 42,
    });

    await expect(holder.useProviderGrant(grant.token, {
      taskId: 'task-1',
      provider: 'openrouter',
      callerPid: 42,
      callerStartTime: 'pid-start-1',
    }, async () => ({ body: 'accidental leak: or-raw-secret' }))).rejects.toThrow(/raw key material/i);
  });

  it('denies ambiguous, different-user, and provider-worker reusable token requests', async () => {
    const holder = new CredentialHolderService({
      socketPath: tempSocketPath(),
      uid: 501,
      peerCredentialResolver: async ({ pid }) => {
        if (pid === 1) return null;
        if (pid === 2) return { pid, uid: 999, startTime: 'foreign' };
        return { pid, uid: 501, startTime: 'worker' };
      },
    });
    await expect(holder.requestUseGrant({ taskId: 't', provider: 'openrouter', callerPid: 1 })).rejects.toThrow(/ambiguous|peer credential/i);
    await expect(holder.requestUseGrant({ taskId: 't', provider: 'openrouter', callerPid: 2 })).rejects.toThrow(/same-user|uid/i);
    await expect(holder.requestUseGrant({
      taskId: 't',
      provider: 'openrouter',
      callerPid: 3,
      callerRole: 'provider-worker',
    })).rejects.toThrow(/reusable|provider-worker|sub-agent/i);
  });

  it('enforces single-use TTL and PID start-time binding', async () => {
    let now = 1_000;
    const issuer = new CapabilityTokenIssuer({
      ttlMs: 50,
      now: () => now,
      randomToken: () => `cap-${now}`,
    });
    const token = issuer.issue({
      taskId: 'task-1',
      provider: 'openrouter',
      callerPid: 42,
      callerStartTime: 'start-a',
    });
    expect(() => issuer.consume(token.token, {
      taskId: 'task-1',
      provider: 'openrouter',
      callerPid: 42,
      callerStartTime: 'start-b',
    })).toThrow(/PID start-time/i);
    expect(issuer.consume(token.token, {
      taskId: 'task-1',
      provider: 'openrouter',
      callerPid: 42,
      callerStartTime: 'start-a',
    })).toMatchObject({ taskId: 'task-1', provider: 'openrouter' });
    expect(() => issuer.consume(token.token, {
      taskId: 'task-1',
      provider: 'openrouter',
      callerPid: 42,
      callerStartTime: 'start-a',
    })).toThrow(/single-use|already used/i);

    const expired = issuer.issue({
      taskId: 'task-2',
      provider: 'openrouter',
      callerPid: 43,
      callerStartTime: 'start-c',
    });
    now = 2_000;
    expect(() => issuer.consume(expired.token, {
      taskId: 'task-2',
      provider: 'openrouter',
      callerPid: 43,
      callerStartTime: 'start-c',
    })).toThrow(/expired/i);
  });
});

describe('credential holder restart semantics', () => {
  it('allows same-runtime recovery only with a valid in-RAM session', () => {
    expect(sameRuntimeRestartCanRecover({ sameRuntime: true, rawKeyReleased: false, sessionValid: true })).toBe(true);
    expect(sameRuntimeRestartCanRecover({ sameRuntime: true, rawKeyReleased: true, sessionValid: true })).toBe(false);
    expect(sameRuntimeRestartCanRecover({ sameRuntime: false, rawKeyReleased: false, sessionValid: true })).toBe(false);
  });

  it('requires fresh OS unlock after full daemon or MCP runtime restart', () => {
    expect(() => assertFullRestartRequiresUnlock({ fullRuntimeRestart: true, osUnlockFresh: false, backendAvailable: true })).toThrow(/fresh OS unlock/i);
    expect(() => assertFullRestartRequiresUnlock({ fullRuntimeRestart: true, osUnlockFresh: true, backendAvailable: false })).toThrow(/backend/i);
    expect(() => assertFullRestartRequiresUnlock({ fullRuntimeRestart: true, osUnlockFresh: true, backendAvailable: true })).not.toThrow();
  });
});
