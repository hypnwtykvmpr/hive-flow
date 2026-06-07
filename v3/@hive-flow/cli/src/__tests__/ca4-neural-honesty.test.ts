import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../../..');

const TARGET_ROOTS = [
  'v3/@hive-flow',
] as const;

const TEXT_EXTENSIONS = new Set(['.ts', '.js', '.d.ts']);

// This gate scans shipped source/output broadly. Test fixtures and docs may
// quote historical claims, but shipped runtime files must not advertise them.
const ALLOWED_PATH_PATTERNS: RegExp[] = [];

const PROHIBITED = [
  { label: 'fake SONA manager surface', pattern: /\b(?:SONAManager|createSONAManager|LocalSonaEngine|SONALearningEngine|createSONALearningEngine)\b/ },
  { label: 'fake SONA mode implementation surface', pattern: /\b(?:RealTimeMode|BalancedMode|ResearchMode|EdgeMode|BatchMode|BaseModeImplementation)\b/ },
  { label: 'fake local SONA coordinator surface', pattern: /\b(?:LocalSonaCoordinator|LocalReasoningBank|LocalMicroLoRA|LocalScopedLoRA|MicroLoRA|applyMicroLora)\b/ },
  { label: 'unsupported quality claim', pattern: /\+[0-9]+% quality/i },
  { label: 'unsupported throughput claim', pattern: /\b(?:2200 ops\/sec|624k ops\/s|60k searches\/s|7\.5M ticks\/s)\b/i },
  { label: 'unsupported multiplier claim', pattern: /\b(?:2\.49x|7\.47x|352x)\b/i },
  { label: 'unsupported success-rate claim', pattern: /\b100% success rate\b/i },
  { label: 'unsupported 12,500x claim', pattern: /\b12,500x\b/i },
  { label: 'unsupported percentage claim', pattern: /\b84\.8%\b/i },
  { label: 'unsupported sub-ms claim', pattern: /\b0\.05ms\b/i },
] as const;

const PROHIBITED_BY_PATH = [
  {
    label: 'randomized neural MCP result',
    pathPattern: /(?:^|\/)neural-tools\.(?:ts|js)$/,
    pattern: /Math\.random\(\)/,
  },
] as const;

function shouldScan(relativePath: string): boolean {
  return !relativePath
    .split('/')
    .some((segment) => segment === '__tests__' || segment === 'tests' || segment === 'node_modules' || segment.startsWith('DELETE_')) &&
    TEXT_EXTENSIONS.has(extname(relativePath)) &&
    !relativePath.endsWith('.test.ts') &&
    !ALLOWED_PATH_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function walkTarget(absolutePath: string): string[] {
  const stats = statSync(absolutePath);
  if (stats.isFile()) {
    const relativePath = relative(REPO_ROOT, absolutePath).split(sep).join('/');
    return shouldScan(relativePath) ? [relativePath] : [];
  }
  if (!stats.isDirectory()) return [];

  return readdirSync(absolutePath)
    .flatMap((entry) => walkTarget(resolve(absolutePath, entry)));
}

function targetFiles(): string[] {
  return Array.from(new Set(
    TARGET_ROOTS
      .map((target) => resolve(REPO_ROOT, target))
      .filter((absolutePath) => existsSync(absolutePath))
      .flatMap((absolutePath) => walkTarget(absolutePath)),
  )).sort();
}

describe('CA-4 neural honesty', () => {
  it('has zero fake neural surfaces, unsupported perf claims, and randomized neural outcomes in shipped code', () => {
    const hits = targetFiles().flatMap((relativePath) => {
      const content = readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
      const normalized = relativePath.split(sep).join('/');
      const globalHits = PROHIBITED
        .filter(({ pattern }) => pattern.test(content))
        .map(({ label, pattern }) => `${normalized}: ${label}: ${pattern}`);
      const pathHits = PROHIBITED_BY_PATH
        .filter(({ pathPattern, pattern }) => pathPattern.test(normalized) && pattern.test(content))
        .map(({ label, pattern }) => `${normalized}: ${label}: ${pattern}`);
      return [...globalHits, ...pathHits];
    });

    expect(
      hits,
      '[CA-4 grep-zero] fake neural surfaces and unsupported neural/perf claims in shipped code',
    ).toEqual([]);
  });
});
