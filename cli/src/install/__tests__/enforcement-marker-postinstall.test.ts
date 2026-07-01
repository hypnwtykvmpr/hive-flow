import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  enforcementMarkerPaths,
  isEnforcementEngineInstalled,
  type EnforcementMarkerFs,
} from '../enforcement-marker.js';
import { runPostinstallCheck } from '../postinstall-check.js';

function fakeFs(existing: ReadonlySet<string>, calls: string[]): EnforcementMarkerFs {
  return {
    existsSync(path: string): boolean {
      calls.push(path);
      return existing.has(path);
    },
  };
}

describe('enforcement install marker detector', () => {
  it('checks only the version marker and relocated enforcement helper', () => {
    const homeDir = '/tmp/hf-marker-home';
    const calls: string[] = [];
    const paths = enforcementMarkerPaths({ homeDir });
    const installed = isEnforcementEngineInstalled({
      homeDir,
      fs: fakeFs(new Set([paths.versionPath, paths.enforcementPath]), calls),
    });

    expect(installed).toBe(true);
    expect(calls).toEqual([paths.versionPath, paths.enforcementPath]);
    expect(calls.join('\n')).not.toMatch(/settings\.json|state\.json|\.hmac-key/);
  });

  it('requires both marker files', () => {
    const homeDir = '/tmp/hf-marker-home';
    const paths = enforcementMarkerPaths({ homeDir });

    expect(isEnforcementEngineInstalled({
      homeDir,
      fs: fakeFs(new Set([paths.versionPath, paths.enforcementPath]), []),
    })).toBe(true);
    expect(isEnforcementEngineInstalled({
      homeDir,
      fs: fakeFs(new Set([paths.versionPath]), []),
    })).toBe(false);
    expect(isEnforcementEngineInstalled({
      homeDir,
      fs: fakeFs(new Set([paths.enforcementPath]), []),
    })).toBe(false);
  });

  it('uses the same marker-only invariant for arbitrary home directories', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((value) => !value.includes('\0')),
        fc.boolean(),
        fc.boolean(),
        (homeDir, hasVersion, hasEnforcement) => {
          const calls: string[] = [];
          const paths = enforcementMarkerPaths({ homeDir });
          const existing = new Set<string>();
          if (hasVersion) existing.add(paths.versionPath);
          if (hasEnforcement) existing.add(paths.enforcementPath);

          const installed = isEnforcementEngineInstalled({
            homeDir,
            fs: fakeFs(existing, calls),
          });

          expect(installed).toBe(hasVersion && hasEnforcement);
          expect(calls).toEqual([paths.versionPath, paths.enforcementPath]);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('postinstall enforcement detector', () => {
  it('prints a loud remediation block to stderr and still exits 0 when markers are absent', () => {
    const homeDir = '/tmp/hf-postinstall-home';
    const stdout: string[] = [];
    const stderr: string[] = [];
    const calls: string[] = [];

    const exitCode = runPostinstallCheck({
      homeDir,
      fs: fakeFs(new Set(), calls),
      stdout: { write: (value) => { stdout.push(String(value)); } },
      stderr: { write: (value) => { stderr.push(String(value)); } },
    });

    expect(exitCode).toBe(0);
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toContain('ENFORCEMENT NOT INSTALLED');
    expect(stderr.join('')).toContain('hive-flow install --global');
    expect(calls).toEqual(Object.values(enforcementMarkerPaths({ homeDir })));
  });

  it('stays quiet and exits 0 when markers are present', () => {
    const homeDir = '/tmp/hf-postinstall-home';
    const paths = enforcementMarkerPaths({ homeDir });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = runPostinstallCheck({
      homeDir,
      fs: fakeFs(new Set([paths.versionPath, paths.enforcementPath]), []),
      stdout: { write: (value) => { stdout.push(String(value)); } },
      stderr: { write: (value) => { stderr.push(String(value)); } },
    });

    expect(exitCode).toBe(0);
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toBe('');
  });

  it('fails open for npm install when the marker probe itself errors', () => {
    const stderr: string[] = [];
    const exitCode = runPostinstallCheck({
      homeDir: '/tmp/hf-postinstall-home',
      fs: {
        existsSync(): boolean {
          throw new Error('permission denied');
        },
      },
      stderr: { write: (value) => { stderr.push(String(value)); } },
    });

    expect(exitCode).toBe(0);
    expect(stderr.join('')).toContain('ENFORCEMENT NOT INSTALLED');
  });
});
