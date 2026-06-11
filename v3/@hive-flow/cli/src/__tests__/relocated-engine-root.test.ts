import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const enforcementSource = resolve(here, '../../../../../.claude/helpers/enforcement.cjs');
const roleSource = resolve(here, '../../../../../.claude/helpers/role-enforcement.cjs');
const hookHandlerSource = resolve(here, '../../../../../.claude/helpers/hook-handler.cjs');
const providerTrackerSource = resolve(here, '../../../../../.claude/helpers/provider-tracker.cjs');
const sessionIdSource = resolve(here, '../../../../../.claude/helpers/session-id.cjs');
const policySource = resolve(here, '../permission-guard/protected-paths.cjs');
const policyJsonSource = resolve(here, '../permission-guard/protected-paths.policy.json');
const gateSource = resolve(here, '../permission-guard/gate.ts');

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
  copyFileSync(gateSource, join(root, 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'gate.ts'));

  copyFileSync(enforcementSource, join(bin, 'enforcement.cjs'));
  copyFileSync(roleSource, join(bin, 'role-enforcement.cjs'));
  copyFileSync(hookHandlerSource, join(bin, 'hook-handler.cjs'));
  copyFileSync(providerTrackerSource, join(bin, 'provider-tracker.cjs'));
  copyFileSync(sessionIdSource, join(bin, 'session-id.cjs'));

  return { root, bin };
}

function makeInstalledProject(): { root: string; bin: string } {
  const project = makeProject();
  rmSync(join(project.root, 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'gate.ts'), { force: true });
  return project;
}

function writeGateStub(root: string): void {
  const source = readFileSync(join(root, 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'gate.ts'), 'utf8');
  const stamp = source.match(/PERMISSION_GUARD_BUILD_STAMP\s*=\s*['"]([^'"]+)['"]/)?.[1];
  if (!stamp) throw new Error('gate.ts fixture is missing PERMISSION_GUARD_BUILD_STAMP');

  const distDir = join(root, 'v3', '@hive-flow', 'cli', 'dist', 'src', 'permission-guard');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(distDir, 'gate.js'),
    [
      `export const PERMISSION_GUARD_BUILD_STAMP = ${JSON.stringify(stamp)};`,
      'export async function evaluateHookInput(input) {',
      '  const filePath = input?.tool_input?.file_path || "";',
      '  if (filePath.includes("STUB-DENY-MARK")) return { decision: "deny", reason: "STUB-DENY" };',
      '  if (filePath.includes("/.hive-flow/enforcement/")) return { decision: "deny", reason: "PROTECTED-STUB-DENY" };',
      '  return { decision: "allow" };',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
}

function writeWorkflowEnforcerStub(root: string): void {
  const distDir = join(root, 'v3', '@hive-flow', 'cli', 'dist', 'src', 'mcp-tools');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(distDir, 'workflow-enforcer.js'),
    [
      'export function loadEnforcementState() {',
      '  return { assessment: { level: "COMPLEX", score: 99 }, planRequired: true, planCreated: false };',
      '}',
      'export function saveEnforcementState() {}',
      'export function appendAuditEntry() {}',
      '',
    ].join('\n'),
    'utf8',
  );
}

function runRelocatedCommand(root: string, bin: string, command: string, input: string) {
  const result = spawnSync(process.execPath, [join(bin, 'hook-handler.cjs'), command], {
    input,
    env: {
      ...process.env,
      HIVE_FLOW_PROJECT_ROOT: root,
      CLAUDE_PROJECT_DIR: root,
      HIVE_FLOW_HOME: join(root, '.hive-flow'),
      HOME: root,
    },
    encoding: 'utf8',
    timeout: 20_000,
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines.at(-1) ?? '{}') as {
    hookSpecificOutput?: {
      permissionDecision?: string;
      permissionDecisionReason?: string;
      additionalContext?: string;
    };
  };
}

function runRelocatedHook(root: string, bin: string, payload: unknown) {
  return runRelocatedCommand(root, bin, 'permission-guard', JSON.stringify(payload));
}

function writePayload(root: string, fileName: string) {
  return {
    tool_name: 'Write',
    tool_input: {
      file_path: join(root, 'src', fileName),
      content: 'x',
    },
    cwd: root,
  };
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

  it('loads the permission guard gate from CLAUDE_PROJECT_DIR when hook-handler.cjs runs from a relocated bin', () => {
    const { root, bin } = makeProject();
    try {
      writeGateStub(root);

      const output = runRelocatedHook(root, bin, writePayload(root, 'STUB-DENY-MARK.ts'));

      expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toBe('STUB-DENY');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('loads workflow-enforcer from the env project root when hook-handler.cjs runs from a relocated bin', () => {
    const { root, bin } = makeProject();
    try {
      writeWorkflowEnforcerStub(root);

      const output = runRelocatedCommand(root, bin, 'enforce-plan', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo ok' }, cwd: root }));

      expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/Complex task.*requires planning subflow/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('denies a protected write after loading the permission guard from a relocated bin', () => {
    const { root, bin } = makeProject();
    try {
      writeGateStub(root);

      const output = runRelocatedHook(root, bin, {
        tool_name: 'Write',
        tool_input: {
          file_path: join(root, '.hive-flow', 'enforcement', 'state.json'),
          content: 'x',
        },
        cwd: root,
      });

      expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toBe('PROTECTED-STUB-DENY');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('loads the permission guard gate when provider-tracker.cjs is absent from the relocated bin', () => {
    const { root, bin } = makeProject();
    try {
      writeGateStub(root);
      rmSync(join(bin, 'provider-tracker.cjs'), { force: true });

      const output = runRelocatedHook(root, bin, writePayload(root, 'STUB-DENY-MARK.ts'));

      expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toBe('STUB-DENY');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('writes permission-guard context tracking under the env project root from a relocated bin', () => {
    const { root, bin } = makeProject();
    try {
      writeGateStub(root);

      runRelocatedHook(root, bin, writePayload(root, 'benign.ts'));

      expect(existsSync(join(root, '.claude', '.context-tracker.json'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('fails closed when a relocated installed hook-handler.cjs has no compiled permission guard gate', () => {
    const { root, bin } = makeInstalledProject();
    try {
      const output = runRelocatedHook(root, bin, writePayload(root, 'benign.ts'));

      expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/Compiled gate not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('allows loudly when an in-repo source checkout has not built the permission guard gate yet', () => {
    const { root, bin } = makeProject();
    try {
      const output = runRelocatedHook(root, bin, writePayload(root, 'benign.ts'));

      expect(output.hookSpecificOutput?.permissionDecision).toBe('allow');
      expect(output.hookSpecificOutput?.additionalContext).toMatch(/npm run build/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
