import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HELPER_BINARIES,
  installedHelperPath,
} from '../helper-paths.js';
import {
  createPeerCredentialResolver,
  parsePeerCredentialJson,
} from '../peer-credentials.js';

function commandExists(command: string): boolean {
  try {
    execFileSync('/usr/bin/which', [command], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

describe('peer credential resolver fail-closed behavior', () => {
  it('fails closed when the native helper is missing or ambiguous', async () => {
    const resolver = createPeerCredentialResolver({
      platform: 'darwin',
      helperCommand: '/missing/hive-flow-peer-cred-helper',
      execFileSync: () => {
        throw new Error('missing helper');
      },
    });
    await expect(resolver.lookup({ pid: process.pid })).rejects.toThrow(/native peer credential helper|missing/i);
  });

  it('uses inherited fd mode for Unix socket peer credential checks', async () => {
    const calls: Array<{ file: string; args: readonly string[]; stdio?: unknown }> = [];
    const resolver = createPeerCredentialResolver({
      platform: 'darwin',
      helperCommand: '/usr/local/bin/hive-flow-peer-cred-helper',
      execFileSync: (file, args, options) => {
        calls.push({ file, args, stdio: options?.stdio });
        return '{"pid":123,"uid":501,"gid":20,"startTime":"42"}';
      },
    });

    await expect(resolver.lookup({ socketFd: 77 })).resolves.toEqual({
      pid: 123,
      uid: 501,
      gid: 20,
      startTime: '42',
    });
    expect(calls).toEqual([{
      file: '/usr/local/bin/hive-flow-peer-cred-helper',
      args: ['fd', '3'],
      stdio: ['ignore', 'pipe', 'pipe', 77],
    }]);
  });

  it('fails closed without invoking forgeable PID lookup mode', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const resolver = createPeerCredentialResolver({
      platform: 'linux',
      helperCommand: '/usr/local/bin/hive-flow-peer-cred-helper',
      execFileSync: (file, args) => {
        calls.push({ file, args });
        return '{"pid":123,"uid":501,"gid":20,"startTime":"42"}';
      },
    });

    await expect(resolver.lookup({ pid: process.pid })).rejects.toThrow(/socket fd|required/i);
    expect(calls).toEqual([]);
  });

  it('parses valid native helper JSON and rejects ambiguous output', () => {
    expect(parsePeerCredentialJson('{"pid":123,"uid":501,"gid":20,"startTime":"42"}')).toEqual({
      pid: 123,
      uid: 501,
      gid: 20,
      startTime: '42',
    });
    expect(() => parsePeerCredentialJson('{}')).toThrow(/ambiguous|pid|uid/i);
    expect(() => parsePeerCredentialJson('not json')).toThrow(/native peer credential helper/i);
  });
});

describe('native peer credential helpers', () => {
  it.skipIf(process.platform !== 'darwin' || !commandExists('cc'))(
    'compiles and runs the macOS LOCAL_PEERPID/getpeereid self-test helper',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'hive-flow-peer-helper-'));
      try {
        const source = resolve(__dirname, '..', 'helpers', 'peer-cred-helper.c');
        const out = join(root, 'peer-cred-helper');
        execFileSync('/usr/bin/cc', [source, '-o', out], { stdio: 'pipe' });
        const result = JSON.parse(execFileSync(out, ['selftest'], { encoding: 'utf8' }));
        expect(result).toMatchObject({
          platform: 'darwin',
          uid: process.getuid?.(),
        });
        expect(result.pid).toBeGreaterThan(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== 'linux' || process.env.HIVE_FLOW_RUN_NATIVE_LINUX_PEER_CRED_TESTS !== '1')(
    'compiles and runs the Linux SO_PEERCRED self-test helper in CI',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'hive-flow-peer-helper-'));
      try {
        const source = resolve(__dirname, '..', 'helpers', 'peer-cred-helper.c');
        const out = join(root, 'peer-cred-helper');
        execFileSync('cc', [source, '-o', out], { stdio: 'pipe' });
        const result = JSON.parse(execFileSync(out, ['selftest'], { encoding: 'utf8' }));
        expect(result).toMatchObject({
          platform: 'linux',
          uid: process.getuid?.(),
        });
        expect(result.pid).toBeGreaterThan(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== 'win32' || process.env.HIVE_FLOW_RUN_NATIVE_WINDOWS_PEER_CRED_TESTS !== '1')(
    'runs the Windows named-pipe GetNamedPipeClientProcessId self-test helper in CI',
    () => {
      const helper = installedHelperPath(HELPER_BINARIES.winPeerCred) ?? HELPER_BINARIES.winPeerCred;
      const result = JSON.parse(execFileSync(helper, ['selftest'], { encoding: 'utf8' }));
      expect(result.platform).toBe('win32');
      expect(result.pid).toBeGreaterThan(0);
      expect(String(result.sid)).toMatch(/^S-/);
    },
  );
});
