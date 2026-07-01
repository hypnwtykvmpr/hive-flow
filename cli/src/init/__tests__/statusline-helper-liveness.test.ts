import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { generateStatuslineScript } from '../statusline-generator.js';
import { DEFAULT_INIT_OPTIONS } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
function findRepoRoot(start = here): string {
  let current = resolve(start);
  for (;;) {
    if (
      existsSync(resolve(current, 'package.json')) &&
      existsSync(resolve(current, 'cli', 'package.json'))
    ) {
      return current;
    }
    const parent = resolve(current, '..');
    if (parent === current) throw new Error('Unable to locate hive-flow repo root');
    current = parent;
  }
}

const repoRoot = findRepoRoot();
const rootHelper = resolve(repoRoot, '.claude/helpers/statusline.cjs');
const packagedHelper = resolve(repoRoot, 'cli/.claude/helpers/statusline.cjs');
const hooksStatuslineBin = resolve(repoRoot, 'cli/bin/hooks-statusline.js');

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function runStatusline(scriptPath: string, cwd: string): string {
  return stripAnsi(execFileSync(process.execPath, [scriptPath], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  }));
}

function expectDelegatingHelper(source: string): void {
  expect(source).toContain('bin/statusline.js');
  expect(source).toContain('canonical hive-flow');
  expect(source).not.toContain('function getGitInfo');
  expect(source).not.toContain('v3-progress.json');
  expect(source).not.toContain('dbSizeKB');
  expect(source).not.toContain('ADRs');
  expect(source).not.toContain('ps aux');
}

describe('generated statusline helper liveness', () => {
  let projectRoot: string;

  afterEach(() => {
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  });

  function setupProject(): string {
    projectRoot = mkdtempSync(join(tmpdir(), 'hf-statusline-helper-'));
    mkdirSync(join(projectRoot, '.claude', 'helpers'), { recursive: true });
    const scriptPath = join(projectRoot, '.claude', 'helpers', 'statusline.cjs');
    writeFileSync(scriptPath, generateStatuslineScript(DEFAULT_INIT_OPTIONS), { mode: 0o755 });
    return scriptPath;
  }

  it('generated helper delegates instead of carrying stale collectors', () => {
    expectDelegatingHelper(generateStatuslineScript(DEFAULT_INIT_OPTIONS));
  });

  it('legacy hooks-statusline binary delegates to the canonical renderer', () => {
    const source = readFileSync(hooksStatuslineBin, 'utf8');

    expect(source).toContain('../dist/src/statusline/claude-code-renderer.js');
    expect(source).not.toContain('../dist/src/hooks/statusline/index.js');
    expect(source).not.toContain('new StatuslineGenerator');
  });

  function writeNoLiveStore(): void {
    writeJson(join(projectRoot, '.hive-flow', 'agents', 'store.json'), {
      version: '1.0',
      agents: {
        ownerless: {
          agentId: 'ownerless',
          agentType: 'tester',
          status: 'busy',
          currentTaskPid: process.pid,
        },
        noPid: {
          agentId: 'no-pid',
          agentType: 'tester',
          status: 'busy',
          ownerSessionId: 'session-a',
        },
      },
    });
  }

  function writeFreshSwarmMetrics(): void {
    const now = new Date().toISOString();
    writeJson(join(projectRoot, '.hive-flow', 'metrics', 'swarm-activity.json'), {
      lastUpdated: now,
      swarm: {
        agent_count: 2,
        coordination_active: true,
      },
    });
    writeJson(join(projectRoot, '.hive-flow', 'metrics', 'v3-progress.json'), {
      lastUpdated: now,
      swarm: {
        activeAgents: 2,
        totalAgents: 150,
        active: true,
      },
    });
  }

  it('generated helper shows Swarm only for owned records with live pid evidence', () => {
    const scriptPath = setupProject();
    writeJson(join(projectRoot, '.hive-flow', 'agents', 'store.json'), {
      version: '1.0',
      agents: {
        liveOwned: {
          agentId: 'live-owned',
          agentType: 'tester',
          status: 'busy',
          ownerSessionId: 'session-a',
          currentTaskPid: process.pid,
        },
        ownerless: {
          agentId: 'ownerless',
          agentType: 'tester',
          status: 'busy',
          currentTaskPid: process.pid,
        },
        noPid: {
          agentId: 'no-pid',
          agentType: 'tester',
          status: 'busy',
          ownerSessionId: 'session-a',
        },
      },
    });

    const output = runStatusline(scriptPath, projectRoot);

    expect(output).toContain('Swarm');
    expect(output).toMatch(/\[\s*1\/150\]/);
  });

  it('generated helper omits Swarm when store has no owned live pid records', () => {
    const scriptPath = setupProject();
    writeNoLiveStore();

    const output = runStatusline(scriptPath, projectRoot);

    expect(output).not.toContain('Swarm');
  });

  it('generated helper ignores fresh aggregate metrics when no owned live pid exists', () => {
    const scriptPath = setupProject();
    writeNoLiveStore();
    writeFreshSwarmMetrics();

    const output = runStatusline(scriptPath, projectRoot);

    expect(output).not.toContain('Swarm');
  });

  it('checked-in helper omits Swarm when store has no owned live pid records', () => {
    setupProject();
    writeNoLiveStore();
    writeFreshSwarmMetrics();

    expectDelegatingHelper(readFileSync(rootHelper, 'utf8'));
    const output = runStatusline(rootHelper, projectRoot);

    expect(output).not.toContain('Swarm');
  });

  it('packaged helper omits Swarm when store has no owned live pid records', () => {
    setupProject();
    writeNoLiveStore();
    writeFreshSwarmMetrics();

    expectDelegatingHelper(readFileSync(packagedHelper, 'utf8'));
    const output = runStatusline(packagedHelper, projectRoot);

    expect(output).not.toContain('Swarm');
  });
});
