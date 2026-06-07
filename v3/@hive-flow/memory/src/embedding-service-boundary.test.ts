import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MEMORY_PACKAGE = new URL('../package.json', import.meta.url);
const MEMORY_INDEX = new URL('./index.ts', import.meta.url);
const V3_ROOT = new URL('../../../', import.meta.url);

function readJson(path: URL): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function sourceFiles(root: string): string[] {
  const entries: string[] = [];

  for (const name of readdirSync(root)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;

    const path = join(root, name);
    const stat = statSync(path);

    if (stat.isDirectory()) {
      entries.push(...sourceFiles(path));
    } else if (/\.(ts|tsx|mts|cts)$/.test(name)) {
      entries.push(path);
    }
  }

  return entries;
}

describe('embedding service factory boundary', () => {
  it('keeps createEmbeddingService owned by the embeddings package only', () => {
    const factoryDefinitions = sourceFiles(V3_ROOT.pathname)
      .filter((path) => !path.endsWith('embedding-service-boundary.test.ts'))
      .flatMap((path) => {
        const source = readFileSync(path, 'utf8');
        return source.includes('export function createEmbeddingService(') ? [path] : [];
      });

    expect(factoryDefinitions.map((path) => path.replace(V3_ROOT.pathname, ''))).toEqual([
      '@hive-flow/embeddings/src/embedding-service.ts',
    ]);
  });

  it('declares the embeddings workspace dependency for the canonical factory', () => {
    const memoryPackage = readJson(MEMORY_PACKAGE);
    const dependencies = memoryPackage.dependencies as Record<string, string>;

    expect(dependencies['@hive-flow/embeddings']).toBe('workspace:*');
  });

  it('does not export the unused createHybridService helper', () => {
    const indexSource = readFileSync(MEMORY_INDEX, 'utf8');

    expect(indexSource).not.toContain('export function createHybridService(');
  });
});
