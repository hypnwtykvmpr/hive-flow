import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../../..');

const TARGET_ROOTS = [
  'v3/@hive-flow/neural/src',
  'v3/@hive-flow/neural/dist',
  'v3/@hive-flow/cli/src/services/hivector-training.ts',
  'v3/@hive-flow/cli/dist/src/services/hivector-training.js',
  'v3/@hive-flow/cli/dist/src/services/hivector-training.d.ts',
  'v3/@hive-flow/cli/src/memory/intelligence.ts',
  'v3/@hive-flow/cli/dist/src/memory/intelligence.js',
  'v3/@hive-flow/cli/dist/src/memory/intelligence.d.ts',
  'v3/@hive-flow/cli/src/mcp-tools/neural-tools.ts',
  'v3/@hive-flow/cli/dist/src/mcp-tools/neural-tools.js',
  'v3/@hive-flow/cli/dist/src/mcp-tools/neural-tools.d.ts',
  'v3/@hive-flow/cli/src/mcp-tools/hooks-tools.ts',
  'v3/@hive-flow/cli/dist/src/mcp-tools/hooks-tools.js',
  'v3/@hive-flow/cli/dist/src/mcp-tools/hooks-tools.d.ts',
  'v3/@hive-flow/memory/src/learning-bridge.ts',
  'v3/@hive-flow/memory/dist/learning-bridge.js',
  'v3/@hive-flow/memory/dist/learning-bridge.d.ts',
  'v3/@hive-flow/performance/src',
  'v3/@hive-flow/performance/dist',
  'v3/@hive-flow/integration/src/token-optimizer.ts',
  'v3/@hive-flow/integration/dist/token-optimizer.js',
  'v3/@hive-flow/integration/dist/token-optimizer.d.ts',
] as const;

const TEXT_EXTENSIONS = new Set(['.ts', '.js', '.d.ts']);

const PROHIBITED = [
  { label: 'fake SONA manager surface', pattern: /\b(?:SONAManager|createSONAManager|LocalSonaEngine|SONALearningEngine|createSONALearningEngine)\b/ },
  { label: 'fake SONA mode implementation surface', pattern: /\b(?:RealTimeMode|BalancedMode|ResearchMode|EdgeMode|BatchMode|BaseModeImplementation)\b/ },
  { label: 'fake local SONA coordinator surface', pattern: /\b(?:LocalSonaCoordinator|LocalReasoningBank|LocalMicroLoRA|LocalScopedLoRA|MicroLoRA|applyMicroLora)\b/ },
  { label: 'unsupported quality claim', pattern: /\+(?:25|55)% quality/i },
  { label: 'unsupported low-latency claim', pattern: /\blow-latency\b/i },
  { label: 'unsupported timing claim', pattern: /(?:<\s*(?:1|10)\s*ms|~0\.01ms|1\.6μs|16\.7μs|0\.13μs)/i },
  { label: 'unsupported memory claim', pattern: /<\s*5\s*MB/i },
  { label: 'unsupported throughput claim', pattern: /\b(?:2200 ops\/sec|624k ops\/s|60k searches\/s|7\.5M ticks\/s)\b/i },
  { label: 'unsupported multiplier claim', pattern: /\b(?:(?:2\.49|7\.47)x?|352x)\b/i },
  { label: 'unsupported success claim', pattern: /\b100% success\b/i },
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
    .some((segment) => segment === '__tests__' || segment === 'tests' || segment.startsWith('DELETE_')) &&
    TEXT_EXTENSIONS.has(extname(relativePath));
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
