import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import doctorCommand, { checkEnforcementEngine } from '../doctor.js';
import type { CommandContext } from '../../types.js';

function makeCtx(cwd: string, flags: Record<string, string | number | boolean>): CommandContext {
  return {
    cwd,
    args: [],
    flags: { _: [], ...flags },
    interactive: false,
  };
}

function installMarkers(homeDir: string): void {
  const binDir = join(homeDir, '.hive-flow', 'enforcement', 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, '.version'), '{}\n', 'utf8');
  writeFileSync(join(binDir, 'enforcement.cjs'), 'module.exports = {};\n', 'utf8');
}

describe('doctor enforcement engine check', () => {
  let projectRoot: string;
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'hf-doctor-p3-project-'));
    homeDir = mkdtempSync(join(tmpdir(), 'hf-doctor-p3-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('fails loudly with install remediation when the relocated engine marker is missing', async () => {
    await expect(checkEnforcementEngine({ homeDir })).resolves.toMatchObject({
      name: 'Enforcement Engine',
      status: 'fail',
      message: expect.stringContaining('ENFORCEMENT NOT INSTALLED'),
      fix: 'hive-flow install --global',
    });

    const result = await doctorCommand.action!(
      makeCtx(projectRoot, { component: 'enforcement', fix: true }),
    );

    expect(result).toMatchObject({ success: false, exitCode: 1 });
    expect(result?.data).toMatchObject({ failed: 1 });
  });

  it('passes when both relocated engine markers exist', async () => {
    installMarkers(homeDir);

    await expect(checkEnforcementEngine({ homeDir })).resolves.toMatchObject({
      name: 'Enforcement Engine',
      status: 'pass',
    });

    const result = await doctorCommand.action!(
      makeCtx(projectRoot, { component: 'enforcement' }),
    );

    expect(result).toMatchObject({ success: true });
    expect(result?.data).toMatchObject({ failed: 0 });
  });
});
