import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderClaudeCodeStatusline } from '../claude-code-renderer.js';

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function installMarkers(homeDir: string): void {
  const binDir = join(homeDir, '.hive-flow', 'enforcement', 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, '.version'), '{}\n', 'utf8');
  writeFileSync(join(binDir, 'enforcement.cjs'), 'module.exports = {};\n', 'utf8');
}

describe('statusline enforcement-installed signal', () => {
  let projectRoot: string;
  let homeDir: string;
  let originalHome: string | undefined;
  let originalForceColor: string | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'hf-statusline-p3-project-'));
    homeDir = mkdtempSync(join(tmpdir(), 'hf-statusline-p3-home-'));
    originalHome = process.env.HOME;
    originalForceColor = process.env.FORCE_COLOR;
    process.env.HOME = homeDir;
    process.env.FORCE_COLOR = '0';
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalForceColor !== undefined) process.env.FORCE_COLOR = originalForceColor;
    else delete process.env.FORCE_COLOR;
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('renders a persistent loud OFF token when the enforcement engine is not installed', async () => {
    const rendered = stripAnsi(await renderClaudeCodeStatusline(undefined, projectRoot));

    expect(rendered).toContain('ENFORCEMENT OFF');
  });

  it('omits the OFF token when both relocated engine markers exist', async () => {
    installMarkers(homeDir);

    const rendered = stripAnsi(await renderClaudeCodeStatusline(undefined, projectRoot));

    expect(rendered).not.toContain('ENFORCEMENT OFF');
  });
});
