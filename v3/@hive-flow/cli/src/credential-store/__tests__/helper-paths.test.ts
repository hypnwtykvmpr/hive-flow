import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HELPER_BINARIES,
  helperBinDir,
  installedHelperPath,
} from '../helper-paths.js';

const roots: string[] = [];

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'hf-helper-paths-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('credential helper paths', () => {
  it('resolves the shared user helper bin dir under ~/.hive-flow/bin', () => {
    const homeDir = tempHome();

    expect(helperBinDir(homeDir)).toBe(join(homeDir, '.hive-flow', 'bin'));
  });

  it('returns an installed helper path only when the fixed-dir binary exists', () => {
    const homeDir = tempHome();
    const binDir = helperBinDir(homeDir);
    const helperPath = join(binDir, HELPER_BINARIES.macosKeychain);
    mkdirSync(binDir, { recursive: true });
    writeFileSync(helperPath, '#!/bin/sh\nexit 0\n');

    expect(installedHelperPath(HELPER_BINARIES.macosKeychain, homeDir)).toBe(helperPath);
    expect(installedHelperPath(HELPER_BINARIES.peerCred, homeDir)).toBeUndefined();
    expect(existsSync(helperPath)).toBe(true);
  });
});
