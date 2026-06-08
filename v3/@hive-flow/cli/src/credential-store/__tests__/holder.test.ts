import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CapabilityTokenIssuer,
  CredentialHolderService,
  sendCredentialHolderCommand,
  assertFullRestartRequiresUnlock,
  sameRuntimeRestartCanRecover,
} from '../holder.js';
import type { PeerCredential } from '../peer-credentials.js';
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
  it('keeps PR3 and PR4 credential boundary gates green', () => {
    expect(getCredentialBoundaryGate('credential-use-not-know')).toMatchObject({
      targetSlice: 'PR3',
      status: 'green',
    });
    expect(getCredentialBoundaryGate('strict-api-no-env-no-config-serialization')).toMatchObject({
      targetSlice: 'PR4',
      status: 'green',
    });
    expect(CREDENTIAL_BOUNDARY_GATES.filter(gate => gate.status === 'xfail').map(gate => gate.id)).toEqual([]);
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

  it('client refuses to send commands to a non-socket holder path', async () => {
    const socketPath = tempSocketPath();
    mkdirSync(join(socketPath, '..'), { recursive: true });
    writeFileSync(socketPath, 'attacker');

    await expect(sendCredentialHolderCommand(socketPath, {
      action: 'grant',
      taskId: 'task-1',
      provider: 'openrouter',
    })).rejects.toThrow(/holder identity|not a socket/i);
  });
});

describe('credential holder same-user USE grants', () => {
  it('accepts holder-owned provider_call commands without issuing reusable tokens', async () => {
    const invocations: unknown[] = [];
    const holder = new CredentialHolderService({
      socketPath: tempSocketPath(),
      uid: 501,
      peerCredentialResolver: async ({ socketFd }) => {
        expect(socketFd).toBeGreaterThan(2);
        return { pid: 42, uid: 501, startTime: 'pid-start-1' };
      },
      providerInvoker: async (input) => {
        invocations.push({
          provider: input.provider,
          taskId: input.taskId,
          peer: input.peer,
          secret: input.secret.toString('utf8'),
          request: input.request,
        });
        return { content: 'holder-owned response' };
      },
    });
    await holder.start();
    holder.setProviderSecret('openrouter', Buffer.from('or-raw-secret'));

    const response = await sendCredentialHolderCommand(holder.socketPath, {
      action: 'provider_call',
      taskId: 'task-1',
      provider: 'openrouter',
      request: {
        action: 'complete',
        payload: { messages: [{ role: 'user', content: 'ping' }] },
      },
    });

    expect(response).toEqual({ ok: true, response: { content: 'holder-owned response' } });
    expect(JSON.stringify(response)).not.toContain('or-raw-secret');
    expect(invocations).toEqual([
      {
        provider: 'openrouter',
        taskId: 'task-1',
        peer: { pid: 42, uid: 501, startTime: 'pid-start-1' },
        secret: 'or-raw-secret',
        request: {
          action: 'complete',
          payload: { messages: [{ role: 'user', content: 'ping' }] },
        },
      },
    ]);
    await holder.stop();
  });

  it('grants and redeems same-user USE over the socket without returning raw key material', async () => {
    let resolverCall = 0;
    const holder = new CredentialHolderService({
      socketPath: tempSocketPath(),
      uid: 501,
      peerCredentialResolver: async ({ socketFd }) => {
        expect(socketFd).toBeGreaterThan(2);
        resolverCall += 1;
        return { pid: 42, uid: 501, startTime: 'pid-start-1' };
      },
      now: () => 1_000,
      randomToken: () => 'cap-1',
      holderSecret: Buffer.from('holder-secret'),
      providerInvoker: async ({ secret }) => {
        expect(secret).toEqual(Buffer.from('or-raw-secret'));
        return { ok: true, body: 'provider response' };
      },
    });
    await holder.start();
    holder.setProviderSecret('openrouter', Buffer.from('or-raw-secret'));
    const grantResponse = await sendCredentialHolderCommand(holder.socketPath, {
      action: 'grant',
      taskId: 'task-1',
      provider: 'openrouter',
    });
    expect(grantResponse.ok).toBe(true);
    const grant = grantResponse.grant!;
    expect(grant).toMatchObject({
      capability: 'provider-use',
      provider: 'openrouter',
      taskId: 'task-1',
      expiresAt: 61_000,
    });
    expect(grant.token).toMatch(/^cap-1\./);
    expect(JSON.stringify(grant)).not.toContain('or-raw-secret');

    const redeemResponse = await sendCredentialHolderCommand(holder.socketPath, {
      action: 'redeem',
      token: grant.token,
      taskId: 'task-1',
      provider: 'openrouter',
    });
    expect(redeemResponse).toEqual({ ok: true, response: { ok: true, body: 'provider response' } });
    expect(JSON.stringify(redeemResponse)).not.toContain('or-raw-secret');
    expect(resolverCall).toBe(2);
    await holder.stop();
  });

  it('rejects a stolen token redeemed over a different socket identity', async () => {
    const identities: PeerCredential[] = [
      { pid: 42, uid: 501, startTime: 'pid-start-1' },
      { pid: 43, uid: 501, startTime: 'pid-start-2' },
    ];
    const holder = new CredentialHolderService({
      socketPath: tempSocketPath(),
      uid: 501,
      peerCredentialResolver: async () => identities.shift()!,
      now: () => 1_000,
      randomToken: () => 'cap-stolen',
      holderSecret: Buffer.from('holder-secret'),
      providerInvoker: async () => ({ ok: true }),
    });
    await holder.start();
    holder.setProviderSecret('openrouter', Buffer.from('or-raw-secret'));
    const grantResponse = await sendCredentialHolderCommand(holder.socketPath, {
      action: 'grant',
      taskId: 'task-1',
      provider: 'openrouter',
    });
    expect(grantResponse.ok).toBe(true);

    const redeemResponse = await sendCredentialHolderCommand(holder.socketPath, {
      action: 'redeem',
      token: grantResponse.grant!.token,
      taskId: 'task-1',
      provider: 'openrouter',
    });
    expect(redeemResponse.ok).toBe(false);
    expect(redeemResponse.error).toMatch(/identity|PID|start-time|signature/i);
    await holder.stop();
  });

  it('does not expose a caller-supplied provider handler redeem path', () => {
    const holder = new CredentialHolderService({
      socketPath: tempSocketPath(),
      uid: 501,
      peerCredentialResolver: async () => ({ pid: 42, uid: 501, startTime: 'pid-start-1' }),
    });
    expect((holder as unknown as { useProviderGrant?: unknown }).useProviderGrant).toBeUndefined();
  });

  it('derives sub-agent/provider-worker denial from peer PID registry instead of self-asserted role', async () => {
    const holder = new CredentialHolderService({
      socketPath: tempSocketPath(),
      uid: 501,
      peerCredentialResolver: async () => ({ pid: 77, uid: 501, startTime: 'sub-agent-start' }),
      peerRoleResolver: async peer => peer.pid === 77 ? 'sub-agent' : 'coordinator',
    });
    await holder.start();
    holder.setProviderSecret('openrouter', Buffer.from('or-raw-secret'));

    const response = await sendCredentialHolderCommand(holder.socketPath, {
      action: 'grant',
      taskId: 't',
      provider: 'openrouter',
    });
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/sub-agent|provider-worker|reusable/i);
    await holder.stop();
  });

  it('denies ambiguous and different-user socket peers', async () => {
    const responses: Array<PeerCredential | null> = [
      null,
      { pid: 2, uid: 999, startTime: 'foreign' },
    ];
    const holder = new CredentialHolderService({
      socketPath: tempSocketPath(),
      uid: 501,
      peerCredentialResolver: async () => responses.shift() ?? null,
    });
    await holder.start();
    holder.setProviderSecret('openrouter', Buffer.from('or-raw-secret'));

    const ambiguous = await sendCredentialHolderCommand(holder.socketPath, {
      action: 'grant',
      taskId: 't',
      provider: 'openrouter',
    });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.error).toMatch(/ambiguous|peer credential/i);

    const foreign = await sendCredentialHolderCommand(holder.socketPath, {
      action: 'grant',
      taskId: 't',
      provider: 'openrouter',
    });
    expect(foreign.ok).toBe(false);
    expect(foreign.error).toMatch(/same-user|uid/i);
    await holder.stop();
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
