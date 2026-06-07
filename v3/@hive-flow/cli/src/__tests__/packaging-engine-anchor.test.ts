import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..');
const cliRoot = join(repoRoot, 'v3', '@hive-flow', 'cli');
const anchorDir = join(cliRoot, '.claude', 'helpers');
const packageJsonPath = join(cliRoot, 'package.json');

const ENGINE_FILES = [
  { name: 'enforcement.cjs', source: join(repoRoot, '.claude', 'helpers', 'enforcement.cjs') },
  { name: 'role-enforcement.cjs', source: join(repoRoot, '.claude', 'helpers', 'role-enforcement.cjs') },
  { name: 'hive-composition-gate.cjs', source: join(repoRoot, '.claude', 'helpers', 'hive-composition-gate.cjs') },
  { name: 'hook-handler.cjs', source: join(repoRoot, '.claude', 'helpers', 'hook-handler.cjs') },
  { name: 'settings-reconciler.cjs', source: join(repoRoot, '.claude', 'helpers', 'settings-reconciler.cjs') },
  { name: 'provider-tracker.cjs', source: join(repoRoot, '.claude', 'helpers', 'provider-tracker.cjs') },
  { name: 'session-id.cjs', source: join(repoRoot, '.claude', 'helpers', 'session-id.cjs') },
  { name: 'protected-paths.cjs', source: join(cliRoot, 'src', 'permission-guard', 'protected-paths.cjs') },
  { name: 'protected-paths.policy.json', source: join(cliRoot, 'src', 'permission-guard', 'protected-paths.policy.json') },
] as const;

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function manifestPath(): string {
  return join(anchorDir, '.engine-manifest.json');
}

function packFileList(): string[] {
  const npmCache = mkdtempSync(join(tmpdir(), 'hf-p1-npm-cache-'));
  try {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: cliRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_cache: npmCache,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>;
    return parsed[0].files.map((file) => file.path);
  } finally {
    rmSync(npmCache, { recursive: true, force: true });
  }
}

function copyAnchorToBin(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  for (const { name } of ENGINE_FILES) {
    copyFileSync(join(anchorDir, name), join(binDir, name));
  }
}

function writeStubPermissionGate(projectRoot: string): void {
  const sourceDir = join(projectRoot, 'v3', '@hive-flow', 'cli', 'src', 'permission-guard');
  const distDir = join(projectRoot, 'v3', '@hive-flow', 'cli', 'dist', 'src', 'permission-guard');
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(projectRoot, 'v3', '@hive-flow', 'cli', 'package.json'),
    JSON.stringify({ type: 'module' }),
  );
  writeFileSync(
    join(sourceDir, 'gate.ts'),
    "export const PERMISSION_GUARD_BUILD_STAMP = 'p1-stub';\n",
  );
  writeFileSync(
    join(distDir, 'gate.js'),
    [
      "export const PERMISSION_GUARD_BUILD_STAMP = 'p1-stub';",
      "export async function evaluateHookInput() { return { decision: 'deny', reason: 'STUB-DENY' }; }",
    ].join('\n'),
  );
}

describe('P1 engine packaging anchor', () => {
  it('packs the complete 9-file engine anchor and manifest', () => {
    const files = packFileList();

    for (const { name } of ENGINE_FILES) {
      expect(files).toContain(`.claude/helpers/${name}`);
    }
    expect(files).toContain('.claude/helpers/.engine-manifest.json');
  });

  it('writes a manifest whose sha256 values match the anchor and canonical sources', () => {
    const manifest = JSON.parse(readFileSync(manifestPath(), 'utf8')) as {
      syncedAt: string;
      version: string;
      files: Array<{ name: string; sha256: string }>;
    };
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string };

    expect(typeof manifest.syncedAt).toBe('string');
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.files.map((file) => file.name).sort()).toEqual(ENGINE_FILES.map((file) => file.name).sort());

    for (const { name, source } of ENGINE_FILES) {
      const entry = manifest.files.find((file) => file.name === name);
      expect(entry, name).toBeDefined();
      expect(entry?.sha256).toBe(sha256(join(anchorDir, name)));
      expect(entry?.sha256).toBe(sha256(source));
    }
  });

  it('resolves @hive-flow/cli/package.json to an anchor containing all 9 files', () => {
    const requireFromCli = createRequire(join(cliRoot, 'dist', 'src', 'index.js'));
    const resolvedPackageJson = requireFromCli.resolve('@hive-flow/cli/package.json');
    expect(resolvedPackageJson).toBe(packageJsonPath);

    const resolvedAnchor = join(dirname(resolvedPackageJson), '.claude', 'helpers');
    for (const { name } of ENGINE_FILES) {
      expect(existsSync(join(resolvedAnchor, name)), name).toBe(true);
    }
  });

  it('syncs the relocation-safe hook-handler marker into the anchor', () => {
    const source = readFileSync(join(anchorDir, 'hook-handler.cjs'), 'utf8');

    expect(source).toContain('const protectedPathPolicy = loadProtectedPathPolicyModule();');
    expect(source).toContain('protectedPathPolicy.resolveProjectRoot({');
    expect(source).toContain("cwd: path.resolve(helpersDir, '..', '..')");
    expect(source).toContain('[ENFORCEMENT ERROR] Hook crashed. Tool blocked for safety.');
    expect(source).not.toMatch(/const\s+PROJECT_DIR\s*=\s*path\.resolve\(__dirname,\s*['"]\.\.['"],\s*['"]\.\.['"]\)/);
    expect(source).not.toContain('function resolveProjectRoot');
    expect(source).not.toContain("const tracker = require('./provider-tracker.cjs');");
  });

  it('relocated synced hook-handler uses env-first root and denies through the compiled gate', () => {
    const root = mkdtempSync(join(tmpdir(), 'hf-p1-relocated-root-'));
    const home = mkdtempSync(join(tmpdir(), 'hf-p1-relocated-home-'));
    try {
      const binDir = join(home, '.hive-flow', 'enforcement', 'bin');
      copyAnchorToBin(binDir);
      writeStubPermissionGate(root);

      const result = spawnSync(process.execPath, [join(binDir, 'hook-handler.cjs'), 'permission-guard'], {
        cwd: root,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: root,
          HIVE_FLOW_PROJECT_ROOT: root,
        },
        input: JSON.stringify({
          tool_name: 'Write',
          tool_input: { file_path: join(root, '.claude', 'settings.json') },
          cwd: root,
        }),
        encoding: 'utf8',
      });
      const parsed = JSON.parse(result.stdout.trim() || '{}') as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };

      expect(result.status).toBe(0);
      expect(result.stderr.trim()).toBe('');
      expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput?.permissionDecisionReason).toBe('STUB-DENY');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('relocated synced hook-handler denies when the compiled gate is missing from an install root', () => {
    const root = mkdtempSync(join(tmpdir(), 'hf-p1-missing-gate-root-'));
    const home = mkdtempSync(join(tmpdir(), 'hf-p1-missing-gate-home-'));
    try {
      const binDir = join(home, '.hive-flow', 'enforcement', 'bin');
      copyAnchorToBin(binDir);

      const result = spawnSync(process.execPath, [join(binDir, 'hook-handler.cjs'), 'permission-guard'], {
        cwd: root,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: root,
          HIVE_FLOW_PROJECT_ROOT: root,
        },
        input: JSON.stringify({
          tool_name: 'Write',
          tool_input: { file_path: join(root, '.claude', 'settings.json') },
          cwd: root,
        }),
        encoding: 'utf8',
      });
      const parsed = JSON.parse(result.stdout.trim() || '{}') as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };

      expect(result.status).toBe(0);
      expect(result.stderr.trim()).toBe('');
      expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput?.permissionDecisionReason).toContain('Compiled gate not found');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
