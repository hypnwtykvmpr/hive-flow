import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HNSWIndex } from './hnsw-index.js';
import { HybridBackend, LocalVectorBackend, UnifiedMemoryService } from './index.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const MEMORY_ROOT = resolve(REPO_ROOT, '@hive-flow/memory');
const SRC_ROOT = resolve(MEMORY_ROOT, 'src');
const V3_ROOT = REPO_ROOT;

const TEXT_EXTENSIONS = new Set(['.ts', '.js', '.d.ts']);

function walkSource(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = resolve(dir, entry.name);
    const relativePath = relative(REPO_ROOT, absolutePath).split(sep).join('/');

    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') {
        return [];
      }
      return walkSource(absolutePath);
    }

    if (!entry.isFile()) return [];
    if (entry.name.startsWith('DELETE_')) return [];
    if (entry.name.endsWith('.test.ts')) return [];
    if (!TEXT_EXTENSIONS.has(extname(entry.name))) return [];
    return [relativePath];
  });
}

describe('AgentDB rip-out contract', () => {
  it('removes AgentDB and RuVector dependencies, patches, and lockfile entries', () => {
    const memoryPackage = JSON.parse(readFileSync(resolve(MEMORY_ROOT, 'package.json'), 'utf8'));
    const rootPackage = JSON.parse(readFileSync(resolve(V3_ROOT, 'package.json'), 'utf8'));
    const lockfile = readFileSync(resolve(V3_ROOT, 'pnpm-lock.yaml'), 'utf8');

    expect(memoryPackage.dependencies ?? {}).not.toHaveProperty('agentdb');
    expect(JSON.stringify(rootPackage.pnpm?.patchedDependencies ?? {})).not.toMatch(/agentdb/i);
    expect(existsSync(resolve(V3_ROOT, 'patches/agentdb@3.0.0-alpha.9.patch'))).toBe(false);
    expect(lockfile).not.toMatch(/\bagentdb\b/i);
    expect(lockfile).not.toContain('@ruvector/');
    expect(lockfile).not.toMatch(/\bruvector\b/i);
  });

  it('has no active shipped source importing or exporting AgentDB surfaces', () => {
    const hits = walkSource(SRC_ROOT).flatMap((relativePath) => {
      const content = readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
      const offenders = [
        /import\s*\(\s*['"]agentdb['"]\s*\)/i,
        /from\s+['"].*agentdb/i,
        /\bAgentDB(?:Backend|VectorIndex|Adapter|AdapterConfig|BackendConfig)\b/,
        /\bgetAgentDB(?:Backend)?\b/,
      ].filter((pattern) => pattern.test(content));
      return offenders.map((pattern) => `${relativePath}: ${pattern}`);
    });

    expect(hits).toEqual([]);
  });

  it('uses the local JS HNSW bootstrap for the public backend seams', () => {
    expect(new HNSWIndex()).toBeInstanceOf(HNSWIndex);
    expect(new LocalVectorBackend({ dimensions: 3 })).toBeInstanceOf(LocalVectorBackend);
    expect(new UnifiedMemoryService({ dimensions: 3 }).getAdapter()).toBeInstanceOf(LocalVectorBackend);
    expect(new HybridBackend({ localVector: { dimensions: 3 } }).getLocalVectorBackend()).toBeInstanceOf(LocalVectorBackend);
  });
});
