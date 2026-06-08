import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..', '..');
const hookHandlerSource = join(repoRoot, '.claude', 'helpers', 'hook-handler.cjs');
const sessionIdSource = join(repoRoot, '.claude', 'helpers', 'session-id.cjs');
const protectedPathsSource = join(repoRoot, 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs');
const protectedPathsPolicySource = join(repoRoot, 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.policy.json');
const secretPathsPolicySource = join(repoRoot, 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'secret-paths.policy.json');

const credentialProtectedEntries = [
  '${HOME}/.hive-flow/credential-vault*',
  '${HOME}/.hive-flow/credentials*',
  '${HOME}/.hive-flow/run/credential-agent.sock',
];

function makeHookProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'hf-hook-freshness-'));
  const helperDir = join(root, '.claude', 'helpers');
  const sourceDir = join(root, 'v3', '@hive-flow', 'cli', 'src', 'permission-guard');
  mkdirSync(helperDir, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  copyFileSync(hookHandlerSource, join(helperDir, 'hook-handler.cjs'));
  copyFileSync(sessionIdSource, join(helperDir, 'session-id.cjs'));
  copyFileSync(protectedPathsSource, join(helperDir, 'protected-paths.cjs'));
  copyFileSync(protectedPathsPolicySource, join(helperDir, 'protected-paths.policy.json'));
  copyFileSync(secretPathsPolicySource, join(helperDir, 'secret-paths.policy.json'));
  writeFileSync(join(helperDir, 'provider-tracker.cjs'), 'module.exports = { track() {} };\n', 'utf8');
  return root;
}

function writeSourceStamp(root: string, stamp: string): void {
  writeFileSync(
    join(root, 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'gate.ts'),
    `export const PERMISSION_GUARD_BUILD_STAMP = '${stamp}';\n`,
    'utf8',
  );
}

function writeDistGate(root: string, body: string): void {
  const distDir = join(root, 'v3', '@hive-flow', 'cli', 'dist', 'src', 'permission-guard');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'gate.js'), body, 'utf8');
}

function runPermissionGuard(root: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, '.claude', 'helpers', 'hook-handler.cjs'), 'permission-guard'], {
    cwd: root,
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo ok' }, cwd: root }),
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
      expect(secretPolicy.secretPathGlobs).toContain('${HOME}/.hive-flow/run/credential-agent.sock');
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
});
