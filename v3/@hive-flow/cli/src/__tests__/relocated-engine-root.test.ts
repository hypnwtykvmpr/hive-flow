import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const enforcementSource = resolve(here, '../../../../../.claude/helpers/enforcement.cjs');
const roleSource = resolve(here, '../../../../../.claude/helpers/role-enforcement.cjs');
const policySource = resolve(here, '../permission-guard/protected-paths.cjs');
const policyJsonSource = resolve(here, '../permission-guard/protected-paths.policy.json');

const previousEnv = {
  HIVE_FLOW_PROJECT_ROOT: process.env.HIVE_FLOW_PROJECT_ROOT,
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
  HIVE_FLOW_HOME: process.env.HIVE_FLOW_HOME,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function makeProject(): { root: string; bin: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-flow-relocated-root-project-')));
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'hive-flow-relocated-root-bin-')));

  mkdirSync(join(root, 'v3', '@hive-flow', 'cli', 'src', 'permission-guard'), { recursive: true });
  copyFileSync(policySource, join(root, 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'));
  copyFileSync(policyJsonSource, join(root, 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.policy.json'));

  copyFileSync(enforcementSource, join(bin, 'enforcement.cjs'));
  copyFileSync(roleSource, join(bin, 'role-enforcement.cjs'));

  return { root, bin };
}

function requireFresh(modulePath: string): unknown {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

describe('relocated enforcement engine root resolution', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('loads enforcement.cjs from a relocated bin while resolving global state under HIVE_FLOW_HOME', () => {
    const { root, bin } = makeProject();
    const hiveHome = realpathSync(mkdtempSync(join(tmpdir(), 'hive-flow-relocated-root-home-')));
    try {
      delete process.env.HIVE_FLOW_PROJECT_ROOT;
      process.env.CLAUDE_PROJECT_DIR = root;
      process.env.HIVE_FLOW_HOME = hiveHome;

      const enforcement = requireFresh(join(bin, 'enforcement.cjs')) as {
        getStateFile(): string;
        getProjectScopeId(): string;
      };

      expect(enforcement.getStateFile()).toBe(join(hiveHome, 'enforcement', 'global', 'state.json'));
      expect(enforcement.getProjectScopeId()).toMatch(/^project-[a-f0-9]{16}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
      rmSync(hiveHome, { recursive: true, force: true });
    }
  });

  it('loads role-enforcement.cjs from a relocated bin while resolving roles under HIVE_FLOW_HOME', () => {
    const { root, bin } = makeProject();
    const hiveHome = realpathSync(mkdtempSync(join(tmpdir(), 'hive-flow-relocated-role-home-')));
    try {
      process.env.HIVE_FLOW_PROJECT_ROOT = root;
      process.env.HIVE_FLOW_HOME = hiveHome;
      delete process.env.CLAUDE_PROJECT_DIR;

      const roleEnforcement = requireFresh(join(bin, 'role-enforcement.cjs')) as {
        getRoleFilePath(agentId: string): string | null;
      };

      expect(roleEnforcement.getRoleFilePath('agent-a')).toBe(
        join(hiveHome, 'enforcement', 'agents', 'agent-a', 'role.json'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
      rmSync(hiveHome, { recursive: true, force: true });
    }
  });
});
