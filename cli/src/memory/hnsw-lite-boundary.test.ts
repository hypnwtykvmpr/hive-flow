import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = dirname(fileURLToPath(import.meta.url));

function readSource(fileName: string): string {
  return readFileSync(resolve(srcDir, fileName), 'utf8');
}

describe('HnswLite package boundary', () => {
  it('does not expose hnsw-lite implementation details from the public barrel', () => {
    const barrel = readSource('index.ts');

    expect(barrel).not.toMatch(/from ['"]\.\/hnsw-lite\.js['"]/);
    expect(barrel).not.toMatch(/\bHnswLite\b/);
    expect(barrel).not.toMatch(/\bHnswSearchResult\b/);
    expect(barrel).not.toMatch(/\bcosineSimilarity\b/);
  });

  it('keeps hnsw-lite available as BinaryBackend-internal implementation detail', () => {
    expect(existsSync(resolve(srcDir, 'hnsw-lite.ts'))).toBe(true);

    const hnswLite = readSource('hnsw-lite.ts');
    expect(hnswLite).toMatch(/\bexport\s+class\s+HnswLite\b/);
    expect(hnswLite).toMatch(/\bexport\s+function\s+cosineSimilarity\b/);

    const binaryBackend = readSource('binary-backend.ts');
    expect(binaryBackend).toMatch(/import\s+\{\s*HnswLite,\s*cosineSimilarity\s*\}\s+from ['"]\.\/hnsw-lite\.js['"]/);
    expect(binaryBackend).toMatch(/\bnew\s+HnswLite\s*\(/);
    expect(binaryBackend).toMatch(/\bcosineSimilarity\s*\(/);
  });
});
