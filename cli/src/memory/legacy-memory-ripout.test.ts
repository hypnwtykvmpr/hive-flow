import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HNSWIndex } from './hnsw-index.js';
import { HybridBackend, LocalVectorBackend, UnifiedMemoryService } from './index.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const CLI_ROOT = resolve(REPO_ROOT, 'cli');
const SRC_ROOT = resolve(CLI_ROOT, 'src/memory');
const V3_ROOT = resolve(REPO_ROOT, 'v3');

const TEXT_EXTENSIONS = new Set(['.ts', '.js', '.d.ts']);
const removedDbPackage = ['a', 'g', 'e', 'n', 't', 'd', 'b'].join('');
const removedVectorPackage = ['r', 'u', 'v', 'e', 'c', 't', 'o', 'r'].join('');
const removedDbClassPrefix = ['A', 'g', 'e', 'n', 't', 'D', 'B'].join('');
const removedVectorClassPrefix = ['R', 'u', 'V', 'e', 'c', 't', 'o', 'r'].join('');

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
    if (entry.name.endsWith('.test.ts')) return [];
    if (!TEXT_EXTENSIONS.has(extname(entry.name))) return [];
    return [relativePath];
  });
}

describe('legacy memory backend rip-out contract', () => {
  it('removes legacy memory and vector dependencies, patches, and lockfile entries', () => {
    const cliPackage = JSON.parse(readFileSync(resolve(CLI_ROOT, 'package.json'), 'utf8'));
    const rootPackage = JSON.parse(readFileSync(resolve(V3_ROOT, 'package.json'), 'utf8'));
    const lockfile = readFileSync(resolve(V3_ROOT, 'pnpm-lock.yaml'), 'utf8');

    expect(cliPackage.dependencies ?? {}).not.toHaveProperty(removedDbPackage);
    expect(cliPackage.optionalDependencies ?? {}).not.toHaveProperty(removedDbPackage);
    expect(JSON.stringify(rootPackage.pnpm?.patchedDependencies ?? {})).not.toMatch(new RegExp(removedDbPackage, 'i'));
    expect(existsSync(resolve(V3_ROOT, `patches/${removedDbPackage}@3.0.0-alpha.9.patch`))).toBe(false);
    expect(lockfile).not.toMatch(new RegExp(`\\b${removedDbPackage}\\b`, 'i'));
    expect(lockfile).not.toContain(`@${removedVectorPackage}/`);
    expect(lockfile).not.toMatch(new RegExp(`\\b${removedVectorPackage}\\b`, 'i'));
  });

  it('has no active shipped source importing or exporting legacy memory surfaces', () => {
    const hits = walkSource(SRC_ROOT).flatMap((relativePath) => {
      const content = readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
      const offenders = [
        new RegExp(`import\\s*\\(\\s*['"]${removedDbPackage}['"]\\s*\\)`, 'i'),
        new RegExp(`from\\s+['"].*${removedDbPackage}`, 'i'),
        new RegExp(`\\b${removedDbClassPrefix}(?:Backend|VectorIndex|Adapter|AdapterConfig|BackendConfig)\\b`),
        new RegExp(`\\bget${removedDbClassPrefix}(?:Backend)?\\b`),
        new RegExp(`\\b${removedVectorClassPrefix}\\b`),
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
