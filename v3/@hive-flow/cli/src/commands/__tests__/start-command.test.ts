import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const cliPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const v3Root = resolve(cliPackageRoot, '../..');
const cliBin = join(cliPackageRoot, 'bin', 'cli.js');
const TEST_HMAC_KEY = 'start-command-test-hmac-key';

function writeNormalEnforcementState(projectRoot: string): void {
  const enforcementDir = join(projectRoot, '.hive-flow', 'enforcement');
  mkdirSync(enforcementDir, { recursive: true });
  const state = {
    level: 0,
    violations: 0,
    consecutiveDenials: 0,
    lastActivity: new Date(0).toISOString(),
    restrictedGroups: [],
    history: [],
    resetAt: null,
    integrityCompromised: false,
  };
  const hmac = createHmac('sha256', TEST_HMAC_KEY).update(JSON.stringify(state)).digest('hex');
  writeFileSync(join(enforcementDir, '.hmac-key'), TEST_HMAC_KEY, 'utf8');
  writeFileSync(join(enforcementDir, 'state.json'), JSON.stringify({ state, hmac }), 'utf8');
}

function writeConfig(path: string, overrides = ''): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      'swarm:',
      '  topology: mesh',
      '  maxAgents: 3',
      '  autoScale: false',
      'mcp:',
      '  autoStart: false',
      ...overrides.split('\n').filter(Boolean),
    ].join('\n'),
  );
}

describe('hive-flow start CLI entry point', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'hive-flow-start-e2e-'));
    writeNormalEnforcementState(cwd);
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('starts from the built CLI with a valid explicit config', () => {
    execFileSync('pnpm', ['--filter', '@hive-flow/cli', 'build'], {
      cwd: v3Root,
      stdio: 'pipe',
    });

    const configPath = join(cwd, 'configs', 'valid.yaml');
    writeConfig(configPath);

    const result = spawnSync(
      process.execPath,
      [cliBin, 'start', '--config', configPath, '--skip-mcp', '--no-color', '--no-update'],
      {
        cwd,
        env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Starting Hive Flow V3');
    expect(result.stdout).toContain('Hive Flow V3 is running!');
    expect(result.stdout).toContain('Topology:  mesh');
    expect(result.stdout).toContain('Max Agents: 3');
  });

  it('exits non-zero with actionable stderr for a missing explicit config', () => {
    const missingPath = join(cwd, 'configs', 'missing.yaml');

    const result = spawnSync(
      process.execPath,
      [cliBin, 'start', '--config', missingPath, '--skip-mcp', '--no-color', '--no-update'],
      {
        cwd,
        env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
        encoding: 'utf8',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Hive Flow config not found: ${missingPath}`);
    expect(result.stderr).toContain('Run "hive-flow init" first');
  });

  it('exits non-zero with actionable stderr for a malformed explicit config', () => {
    const configPath = join(cwd, 'configs', 'corrupt.yaml');
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, 'swarm:\n  topology: "mesh\n');

    const result = spawnSync(
      process.execPath,
      [cliBin, 'start', '--config', configPath, '--skip-mcp', '--no-color', '--no-update'],
      {
        cwd,
        env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
        encoding: 'utf8',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Invalid Hive Flow config ${configPath}`);
    expect(result.stderr).toContain('unterminated quoted string');
  });
});
