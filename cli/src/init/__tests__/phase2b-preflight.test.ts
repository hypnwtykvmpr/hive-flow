import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateAutoMemoryHook } from '../helpers-generator.js';

function findRepoRoot(start = __dirname): string {
  let current = resolve(start);
  for (;;) {
    if (
      existsSync(join(current, 'package.json')) &&
      existsSync(join(current, 'cli', 'package.json')) &&
      existsSync(join(current, 'v3'))
    ) {
      return current;
    }
    const parent = resolve(current, '..');
    if (parent === current) throw new Error('Unable to locate hive-flow repo root');
    current = parent;
  }
}

const REPO_ROOT = findRepoRoot();

function currentCliRoot(): string {
  const promoted = resolve(REPO_ROOT, 'cli');
  if (existsSync(resolve(promoted, 'package.json'))) return promoted;
  throw new Error('Promoted cli/package.json not found');
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walkRuntimeSource(root: string): string[] {
  const files: string[] = [];
  function walk(current: string) {
    const stat = statSync(current);
    if (stat.isDirectory()) {
      if (current.includes(`${join('src', '__tests__')}`) || current.endsWith('__tests__')) return;
      for (const entry of readdirSync(current)) walk(join(current, entry));
      return;
    }
    if (!/\.(ts|js|mjs|cjs)$/.test(current)) return;
    if (/(\.test|\.spec)\.(ts|js|mjs|cjs)$/.test(current)) return;
    files.push(current);
  }
  walk(root);
  return files;
}

function hasCanonicalDualAccept(source: string, index: number): boolean {
  const window = source.slice(Math.max(0, index - 180), index + 180);
  return /name\s*={2,3}\s*['"]hive-flow['"]/.test(window);
}

const GENERATED_IMPORT_TEXT_ALLOWLIST = new Set([
  'src/plugin-sdk/examples/plugin-creator/index.ts',
  'src/testing/v2-compat/report-generator.ts',
  'src/testing/v2-compat/compatibility-validator.ts',
]);

const RUNTIME_SHIM_PATTERNS = [
  { label: 'dynamic import', pattern: /\bimport\s*\(\s*['"]@hive-flow\/cli(?:\/|['"])/g },
  { label: 'require', pattern: /\brequire\s*\(\s*['"]@hive-flow\/cli(?:\/|['"])/g },
  { label: 'require.resolve', pattern: /\brequire\.resolve\s*\(\s*['"]@hive-flow\/cli(?:\/|['"])/g },
  { label: 'resolver', pattern: /\b[\w$.]+\.resolve\s*\(\s*['"]@hive-flow\/cli(?:\/|['"])/g },
];

const STATIC_SHIM_PATTERNS = [
  {
    label: 'static import',
    pattern: /\bimport\s+(?:type\s+)?[^'";()]+?\bfrom\s*['"]@hive-flow\/cli(?:\/|['"])/g,
  },
  {
    label: 'static re-export',
    pattern: /\bexport\s+(?:type\s+)?[^'";()]+?\bfrom\s*['"]@hive-flow\/cli(?:\/|['"])/g,
  },
  {
    label: 'bare import',
    pattern: /\bimport\s*['"]@hive-flow\/cli(?:\/|['"])/g,
  },
];

function collectRuntimeShimViolations(rel: string, rawSource: string): string[] {
  const source = stripComments(rawSource);
  const violations: string[] = [];

  for (const { label, pattern } of RUNTIME_SHIM_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      violations.push(`${rel}: ${label} shim resolution ${match[0]}`);
    }
  }

  // These files intentionally generate legacy example import text. They are
  // documentation/scaffold output and will be retargeted in the Phase 2C sweep.
  if (!GENERATED_IMPORT_TEXT_ALLOWLIST.has(rel)) {
    for (const { label, pattern } of STATIC_SHIM_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        violations.push(`${rel}: ${label} shim resolution ${match[0]}`);
      }
    }
  }

  const nameCheckPattern = /\bname\s*={2,3}\s*['"]@hive-flow\/cli['"]/g;
  for (const match of source.matchAll(nameCheckPattern)) {
    if (!hasCanonicalDualAccept(source, match.index ?? 0)) {
      violations.push(`${rel}: sole package-name check ${match[0]}`);
    }
  }

  return violations;
}

describe('Phase 2B preflight invariants', () => {
  it('generates auto-memory fallback imports through the promoted hive-flow package name', () => {
    const hook = generateAutoMemoryHook();

    expect(hook).toContain("import('hive-flow/memory')");
    expect(hook).not.toContain("import('@hive-flow/cli/memory')");
  });

  it('keeps Vitest out of runtime dependencies', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(currentCliRoot(), 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies ?? {}).not.toHaveProperty('vitest');
    expect(packageJson.devDependencies?.vitest).toBe('^4.0.16');
  });

  it('keeps canonical runtime code independent of the @hive-flow/cli shim', () => {
    const cliRoot = currentCliRoot();
    const violations: string[] = [];

    for (const file of walkRuntimeSource(resolve(cliRoot, 'src'))) {
      const rel = relative(cliRoot, file).replace(/\\/g, '/');
      violations.push(...collectRuntimeShimViolations(rel, readFileSync(file, 'utf8')));
    }

    expect(violations).toEqual([]);
  });

  it('flags planted static @hive-flow/cli imports through the same matcher', () => {
    expect(collectRuntimeShimViolations(
      'src/planted-static-import.ts',
      "import { LocalVectorBackend } from '@hive-flow/cli/memory';\n",
    )).toEqual([
      expect.stringContaining('static import shim resolution'),
    ]);
    expect(collectRuntimeShimViolations(
      'src/planted-re-export.ts',
      "export { UnifiedMemoryService } from '@hive-flow/cli/memory';\n",
    )).toEqual([
      expect.stringContaining('static re-export shim resolution'),
    ]);
    expect(collectRuntimeShimViolations(
      'src/planted-bare-import.ts',
      "import '@hive-flow/cli/hooks';\n",
    )).toEqual([
      expect.stringContaining('bare import shim resolution'),
    ]);
  });
});
