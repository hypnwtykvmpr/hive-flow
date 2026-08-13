import fc from 'fast-check';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { propertyRunsFromEnv } from '../../__tests__/property-runs.js';
import {
  MCP_ATTESTATION_PATH_ENV,
  MCP_ATTESTATION_TOKEN_ENV,
  OWNER_SENSITIVE_MCP_TOOLS,
  formatMCPAttestationFailure,
  isOwnerSensitiveMCPTool,
  mintInProcessMCPAttestation,
  mintMCPAttestation,
  validateMCPAttestation,
} from '../attestation.js';

const roots: string[] = [];
const PROPERTY_RUNS = propertyRunsFromEnv(100);

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hf-mcp-attestation-'));
  roots.push(root);
  return root;
}

function codexEnv(projectRoot: string, sessionId = 'codex-parent-session'): Record<string, string | undefined> {
  return {
    HIVE_FLOW_PROJECT_ROOT: projectRoot,
    HIVE_FLOW_CLIENT_KIND: 'codex',
    CODEX_SESSION_ID: sessionId,
  };
}

function validationEnv(env: Record<string, string | undefined>, minted: { envPatch: Record<string, string> }): Record<string, string | undefined> {
  return { ...env, ...minted.envPatch };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('MCP stdio attestation', () => {
  it('validates a launcher-spawned MCP server only under the recorded parent pid and entrypoint path', () => {
    const projectRoot = makeProjectRoot();
    const env = codexEnv(projectRoot);
    const entrypointPath = join(projectRoot, 'cli', 'bin', 'mcp-server.js');
    const minted = mintMCPAttestation({
      env,
      cwd: projectRoot,
      entrypoint: 'bin/mcp-server.js',
      pidMode: 'spawned-child',
      launcherPid: 4242,
      entrypointPath,
      now: () => new Date('2026-07-05T18:00:00.000Z'),
    });

    expect(minted.success).toBe(true);
    if (!minted.success) return;

    const valid = validateMCPAttestation({
      env: validationEnv(env, minted),
      cwd: projectRoot,
      ppid: 4242,
      entrypointPath,
      now: () => new Date('2026-07-05T18:01:00.000Z'),
    });

    expect(valid.success).toBe(true);
    if (!valid.success) return;
    expect(valid.context).toMatchObject({
      sessionId: 'codex-parent-session',
      clientKind: 'codex',
      attested: true,
      attestationEntryPoint: 'bin/mcp-server.js',
    });
    expect(valid.record.ownerSessionProvenance).toBe('environment');

    const wrongParent = validateMCPAttestation({
      env: validationEnv(env, minted),
      cwd: projectRoot,
      ppid: 9999,
      entrypointPath,
      now: () => new Date('2026-07-05T18:01:00.000Z'),
    });
    expect(wrongParent).toMatchObject({ success: false, code: 'invalid-pid' });
  });

  it('mints and validates the in-process hive-flow mcp start entrypoint', () => {
    const projectRoot = makeProjectRoot();
    const env = codexEnv(projectRoot);
    const minted = mintInProcessMCPAttestation({
      env,
      cwd: projectRoot,
      mcpPid: 777,
      now: () => new Date('2026-07-05T18:00:00.000Z'),
    });

    expect(minted.success).toBe(true);
    if (!minted.success) return;
    expect(env[MCP_ATTESTATION_PATH_ENV]).toBe(minted.attestationPath);
    expect(env[MCP_ATTESTATION_TOKEN_ENV]).toBe(minted.token);

    const valid = validateMCPAttestation({
      env,
      cwd: projectRoot,
      pid: 777,
      now: () => new Date('2026-07-05T18:01:00.000Z'),
    });
    expect(valid.success).toBe(true);
    if (!valid.success) return;
    expect(valid.context.attestationEntryPoint).toBe('cli/mcp-stdio-inprocess');

    const wrongPid = validateMCPAttestation({
      env,
      cwd: projectRoot,
      pid: 778,
      now: () => new Date('2026-07-05T18:01:00.000Z'),
    });
    expect(wrongPid).toMatchObject({ success: false, code: 'invalid-pid' });
  });

  it('rejects missing tokens, mismatched tokens, and stale epochs for owner-sensitive calls', () => {
    const projectRoot = makeProjectRoot();
    const env = codexEnv(projectRoot);
    const first = mintMCPAttestation({
      env,
      cwd: projectRoot,
      entrypoint: 'bin/mcp-server.js',
      pidMode: 'spawned-child',
      launcherPid: 1,
      entrypointPath: join(projectRoot, 'cli', 'bin', 'mcp-server.js'),
    });
    const second = mintMCPAttestation({
      env,
      cwd: projectRoot,
      entrypoint: 'bin/mcp-server.js',
      pidMode: 'spawned-child',
      launcherPid: 1,
      entrypointPath: join(projectRoot, 'cli', 'bin', 'mcp-server.js'),
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;

    expect(validateMCPAttestation({ env, cwd: projectRoot })).toMatchObject({ success: false, code: 'missing-env' });
    expect(validateMCPAttestation({
      env: { ...validationEnv(env, first), [MCP_ATTESTATION_TOKEN_ENV]: 'wrong' },
      cwd: projectRoot,
      ppid: 1,
      entrypointPath: join(projectRoot, 'cli', 'bin', 'mcp-server.js'),
    })).toMatchObject({ success: false, code: 'invalid-token' });
    expect(validateMCPAttestation({
      env: validationEnv(env, first),
      cwd: projectRoot,
      ppid: 1,
      entrypointPath: join(projectRoot, 'cli', 'bin', 'mcp-server.js'),
    })).toMatchObject({ success: false, code: 'stale-epoch' });

    const failure = validateMCPAttestation({ env, cwd: projectRoot });
    expect(isOwnerSensitiveMCPTool('agent_spawn')).toBe(true);
    expect(isOwnerSensitiveMCPTool('agent_message_escalate')).toBe(false);
    expect(formatMCPAttestationFailure('agent_spawn', failure)).toContain('requires an attested operator session');
  });

  it('accepts the explicit Codex parent provenance grammar and rejects incompatible provenance', () => {
    const projectRoot = makeProjectRoot();
    const env = codexEnv(projectRoot);
    const entrypointPath = join(projectRoot, 'cli', 'bin', 'mcp-server.js');
    const minted = mintMCPAttestation({
      env,
      cwd: projectRoot,
      entrypoint: 'bin/mcp-server.js',
      pidMode: 'spawned-child',
      launcherPid: 4242,
      entrypointPath,
      now: () => new Date('2026-07-05T18:00:00.000Z'),
    });
    expect(minted.success).toBe(true);
    if (!minted.success) return;

    const parentRecord = {
      ...minted.record,
      sessionEnvKey: 'CODEX_THREAD_ID',
      ownerSessionProvenance: 'codex-parent-rollout' as const,
    };
    writeFileSync(minted.attestationPath, `${JSON.stringify(parentRecord)}\n`);
    expect(validateMCPAttestation({
      env: validationEnv(env, minted),
      cwd: projectRoot,
      ppid: 4242,
      entrypointPath,
      now: () => new Date('2026-07-05T18:01:00.000Z'),
    })).toMatchObject({ success: true });

    writeFileSync(minted.attestationPath, `${JSON.stringify({
      ...parentRecord,
      ownerClientKind: 'claude',
    })}\n`);
    expect(validateMCPAttestation({
      env: validationEnv(env, minted),
      cwd: projectRoot,
      ppid: 4242,
      entrypointPath,
      now: () => new Date('2026-07-05T18:01:00.000Z'),
    })).toMatchObject({ success: false, code: 'invalid-owner' });
  });

  it('keeps the owner-sensitive stdio guard registry complete', () => {
    expect([...OWNER_SENSITIVE_MCP_TOOLS].sort()).toEqual([
      'agent_message_ack',
      'agent_message_inbox',
      'agent_message_send',
      'agent_pool',
      'agent_spawn',
      'daa_agent_create',
      'hive-mind_join',
      'hive-mind_spawn',
      'hive_poll_workers',
      'hive_terminate',
      'queen_collect_results',
      'queen_mission_assign',
      'queen_permission_decide',
      'queen_permission_requests',
      'queen_spawn_worker',
      'queen_task_worker',
    ]);
  });

  it('property: attested owner session ids come only from non-generated operator env markers', () => {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...chars), { minLength: 1, maxLength: 48 }).map((parts) => parts.join('')),
        (sessionId) => {
          const projectRoot = makeProjectRoot();
          const env = {
            HIVE_FLOW_PROJECT_ROOT: projectRoot,
            HIVE_FLOW_CLIENT_KIND: 'codex',
            HIVE_FLOW_SESSION_ID: sessionId,
          };
          const minted = mintInProcessMCPAttestation({
            env,
            cwd: projectRoot,
            mcpPid: 123,
          });

          expect(minted.success).toBe(!/^mcp-\d+-[a-z0-9]+$/i.test(sessionId));
          if (minted.success) {
            expect(minted.record.ownerSessionId).toBe(sessionId.slice(0, 64));
            expect(minted.record.ownerClientKind).toBe('codex');
            expect(minted.record.sessionEnvKey).toBe('HIVE_FLOW_SESSION_ID');
            expect(minted.record.ownerSessionProvenance).toBe('environment');
          }
        },
      ),
      { seed: 20_607_05, numRuns: PROPERTY_RUNS },
    );
  });
});
