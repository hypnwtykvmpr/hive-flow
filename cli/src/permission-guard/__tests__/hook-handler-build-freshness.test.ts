import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const hookHandlerSource = join(repoRoot, '.claude', 'helpers', 'hook-handler.cjs');
const layoutPathsSource = join(repoRoot, '.claude', 'helpers', 'layout-paths.cjs');
const clientKindSource = join(repoRoot, '.claude', 'helpers', 'client-kind.cjs');
const sessionIdSource = join(repoRoot, '.claude', 'helpers', 'session-id.cjs');
const protectedPathsSource = join(repoRoot, 'cli', 'src', 'permission-guard', 'protected-paths.cjs');
const protectedPathsPolicySource = join(repoRoot, 'cli', 'src', 'permission-guard', 'protected-paths.policy.json');
const secretPathsPolicySource = join(repoRoot, 'cli', 'src', 'permission-guard', 'secret-paths.policy.json');

const credentialProtectedEntries = [
  '${HOME}/.hive-flow/credential-vault*',
  '${HOME}/.hive-flow/credentials*',
  '${HOME}/.hive-flow/run/credential-holder.sock',
];

function makeHookProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'hf-hook-freshness-'));
  const helperDir = join(root, '.claude', 'helpers');
  const sourceDir = join(root, 'cli', 'src', 'permission-guard');
  mkdirSync(helperDir, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  copyFileSync(hookHandlerSource, join(helperDir, 'hook-handler.cjs'));
  copyFileSync(layoutPathsSource, join(helperDir, 'layout-paths.cjs'));
  copyFileSync(clientKindSource, join(helperDir, 'client-kind.cjs'));
  copyFileSync(sessionIdSource, join(helperDir, 'session-id.cjs'));
  copyFileSync(protectedPathsSource, join(helperDir, 'protected-paths.cjs'));
  copyFileSync(protectedPathsPolicySource, join(helperDir, 'protected-paths.policy.json'));
  copyFileSync(secretPathsPolicySource, join(helperDir, 'secret-paths.policy.json'));
  writeFileSync(join(helperDir, 'provider-tracker.cjs'), 'module.exports = { track() {} };\n', 'utf8');
  return root;
}

function makeRelocatedHookBinWithoutPolicy(): string {
  const root = mkdtempSync(join(tmpdir(), 'hf-hook-relocated-no-policy-'));
  const helperDir = join(root, '.hive-flow', 'enforcement', 'bin');
  mkdirSync(helperDir, { recursive: true });
  copyFileSync(hookHandlerSource, join(helperDir, 'hook-handler.cjs'));
  copyFileSync(layoutPathsSource, join(helperDir, 'layout-paths.cjs'));
  copyFileSync(clientKindSource, join(helperDir, 'client-kind.cjs'));
  copyFileSync(sessionIdSource, join(helperDir, 'session-id.cjs'));
  return root;
}

function forcePermissionGuardAsyncRejection(root: string): void {
  const handlerPath = join(root, '.claude', 'helpers', 'hook-handler.cjs');
  const source = readFileSync(handlerPath, 'utf8');
  const replacement = source.replace(
    /  'permission-guard': async \(\) => \{[\s\S]*?\n  \},\n\n  'bug-hunter-check':/,
    [
      "  'permission-guard': async () => {",
      "    throw new Error('forced async permission-guard rejection');",
      '  },',
      '',
      "  'bug-hunter-check':",
    ].join('\n'),
  );
  if (replacement === source) throw new Error('failed to force permission-guard async rejection');
  writeFileSync(handlerPath, replacement, 'utf8');
}

function writeSourceStamp(root: string, stamp: string): void {
  writeFileSync(
    join(root, 'cli', 'src', 'permission-guard', 'gate.ts'),
    `export const PERMISSION_GUARD_BUILD_STAMP = '${stamp}';\n`,
    'utf8',
  );
}

function writeDistGate(root: string, body: string): void {
  const distDir = join(root, 'cli', 'dist', 'src', 'permission-guard');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'gate.js'), body, 'utf8');
}

function runPermissionGuard(
  root: string,
  input: Record<string, unknown> = { tool_name: 'Bash', tool_input: { command: 'echo ok' }, cwd: root },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, '.claude', 'helpers', 'hook-handler.cjs'), 'permission-guard'], {
    cwd: root,
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function parseDecision(stdout: string): { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } {
  return JSON.parse(stdout || '{}');
}

describe('hook-handler permission-guard build freshness', () => {
  it('copies credential vault guard policy entries into relocated helper fixtures', () => {
    const root = makeHookProject();
    try {
      const protectedPolicy = JSON.parse(readFileSync(join(root, '.claude', 'helpers', 'protected-paths.policy.json'), 'utf8'));
      const secretPolicy = JSON.parse(readFileSync(join(root, '.claude', 'helpers', 'secret-paths.policy.json'), 'utf8'));

      for (const entry of credentialProtectedEntries) {
        expect(protectedPolicy.protectedWrite).toContain(entry);
        expect(protectedPolicy.protectedWriteGlobal).toContain(entry);
        expect(protectedPolicy.protectedRead).toContain(entry);
      }
      expect(secretPolicy.secretPathGlobs).toContain('${HOME}/.hive-flow/credential-vault*');
      expect(secretPolicy.secretPathGlobs).toContain('${HOME}/.hive-flow/credentials*');
      expect(secretPolicy.secretPathGlobs).toContain('${HOME}/.hive-flow/run/credential-holder.sock');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps never-built permission guard fail-open', () => {
    const root = makeHookProject();
    try {
      writeSourceStamp(root, 'source-stamp');

      const result = runPermissionGuard(root);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(parseDecision(result.stdout).hookSpecificOutput?.permissionDecision).toBe('allow');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed with valid JSON when compiled gate stamp is stale', () => {
    const root = makeHookProject();
    try {
      writeSourceStamp(root, 'source-stamp');
      writeDistGate(root, [
        "export const PERMISSION_GUARD_BUILD_STAMP = 'old-stamp';",
        "export async function evaluateHookInput() { return { decision: 'allow' }; }",
      ].join('\n'));

      const result = runPermissionGuard(root);
      const parsed = parseDecision(result.stdout);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput?.permissionDecisionReason).toMatch(/stale|freshness|compiled/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows exactly the project-local rebuild command when compiled gate stamp is stale', () => {
    const root = makeHookProject();
    try {
      writeSourceStamp(root, 'source-stamp');
      writeDistGate(root, [
        "export const PERMISSION_GUARD_BUILD_STAMP = 'old-stamp';",
        "export async function evaluateHookInput() { return { decision: 'allow' }; }",
      ].join('\n'));

      const result = runPermissionGuard(root, {
        tool_name: 'Bash',
        tool_input: { command: 'corepack pnpm --dir cli build' },
        cwd: root,
      });
      const parsed = parseDecision(result.stdout);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(parsed.hookSpecificOutput?.permissionDecision).toBe('allow');
      expect(parsed.hookSpecificOutput?.permissionDecisionReason).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps stale-gate rebuild escape hatch closed for shell composition and wrong targets', () => {
    const root = makeHookProject();
    try {
      writeSourceStamp(root, 'source-stamp');
      writeDistGate(root, [
        "export const PERMISSION_GUARD_BUILD_STAMP = 'old-stamp';",
        "export async function evaluateHookInput() { return { decision: 'allow' }; }",
      ].join('\n'));

      const commands = [
        'corepack pnpm --dir cli build | tail -20',
        'corepack pnpm --dir cli build 2>&1',
        'corepack pnpm --dir . build',
        'echo ok',
      ];

      for (const command of commands) {
        const result = runPermissionGuard(root, {
          tool_name: 'Bash',
          tool_input: { command },
          cwd: root,
        });
        const parsed = parseDecision(result.stdout);
        expect(result.status, command).toBe(0);
        expect(result.stderr, command).toBe('');
        expect(parsed.hookSpecificOutput?.permissionDecision, command).toBe('deny');
        expect(parsed.hookSpecificOutput?.permissionDecisionReason, command).toMatch(/stale|compiled|safety|blocked/i);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed with valid JSON when compiled gate exists but throws on load', () => {
    const root = makeHookProject();
    try {
      writeSourceStamp(root, 'source-stamp');
      writeDistGate(root, "throw new Error('compiled gate boom');\n");

      const result = runPermissionGuard(root);
      const parsed = parseDecision(result.stdout);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput?.permissionDecisionReason).toMatch(/permission guard|compiled|failed/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows npm run build from the CLI directory when compiled gate throws on load', () => {
    const root = makeHookProject();
    try {
      writeSourceStamp(root, 'source-stamp');
      writeDistGate(root, "throw new Error('compiled gate boom');\n");
      const cliDir = join(root, 'cli');

      const result = runPermissionGuard(root, {
        tool_name: 'Bash',
        tool_input: { command: 'npm run build' },
        cwd: cliDir,
      });
      const parsed = parseDecision(result.stdout);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(parsed.hookSpecificOutput?.permissionDecision).toBe('allow');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows normal in-repo compiled permission guard subprocess execution', () => {
    const root = makeHookProject();
    try {
      writeSourceStamp(root, 'source-stamp');
      writeDistGate(root, [
        "export const PERMISSION_GUARD_BUILD_STAMP = 'source-stamp';",
        "export async function evaluateHookInput() { return { decision: 'allow', reason: 'NORMAL-ALLOW' }; }",
      ].join('\n'));

      const result = runPermissionGuard(root);
      const parsed = parseDecision(result.stdout);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(parsed.hookSpecificOutput?.permissionDecision).toBe('allow');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when compiled gate has no evaluator export', () => {
    const root = makeHookProject();
    try {
      writeSourceStamp(root, 'source-stamp');
      writeDistGate(root, "export const PERMISSION_GUARD_BUILD_STAMP = 'source-stamp';\n");

      const result = runPermissionGuard(root);
      const parsed = parseDecision(result.stdout);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput?.permissionDecisionReason).toMatch(/permission guard|evaluateHookInput|safety/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed with valid JSON when permission-guard rejects at the async handler boundary', () => {
    const root = makeHookProject();
    try {
      forcePermissionGuardAsyncRejection(root);

      const result = runPermissionGuard(root);
      const parsed = parseDecision(result.stdout);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput?.permissionDecisionReason).toMatch(/permission guard|failed|safety/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when relocated module initialization cannot load protected path policy', () => {
    const root = makeRelocatedHookBinWithoutPolicy();
    try {
      const result = spawnSync(process.execPath, [join(root, '.hive-flow', 'enforcement', 'bin', 'hook-handler.cjs'), 'permission-guard'], {
        cwd: root,
        env: {
          ...process.env,
          HIVE_FLOW_PROJECT_ROOT: root,
          CLAUDE_PROJECT_DIR: root,
        },
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo ok' }, cwd: root }),
        encoding: 'utf8',
      });

      const parsed = parseDecision(result.stdout.trim());
      expect(result.status).toBe(0);
      expect(result.stderr.trim()).toBe('');
      expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput?.permissionDecisionReason).toMatch(/permission guard|policy|safety/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
