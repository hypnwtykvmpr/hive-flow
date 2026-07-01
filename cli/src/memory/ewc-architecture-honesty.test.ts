import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

function collectSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;

    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path));
      continue;
    }

    if (!/\.(?:ts|js)$/.test(entry.name)) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    if (entry.name.startsWith('DELETE_')) continue;
    files.push(path);
  }
  return files;
}

function shippedSourceFiles(): string[] {
  return [
    resolve(repoRoot, 'cli/src/memory'),
    resolve(repoRoot, 'cli/src/neural'),
  ].flatMap(collectSourceFiles);
}

function matchingFiles(pattern: RegExp): string[] {
  return shippedSourceFiles()
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(repoRoot, file))
    .sort();
}

function matchingFilesExcept(pattern: RegExp, allowedFiles: string[]): string[] {
  return matchingFiles(pattern).filter((file) => !allowedFiles.includes(file));
}

describe('CA-3 EWC architecture honesty', () => {
  it('keeps the Fisher-matrix EWC consolidator as the only EWC consolidation implementation', () => {
    expect(matchingFiles(/\bclass\s+EWCConsolidator\b/)).toEqual([
      'cli/src/memory/ewc-consolidation.ts',
    ]);

    expect(matchingFiles(/\bcomputeFisherMatrix\b|\bglobalFisher\b/)).toEqual([
      'cli/src/memory/ewc-consolidation.ts',
    ]);
  });

  it('has no active imports or exports of the deleted binary/SONA persistence stubs', () => {
    const retiredPrefix = ['R', 'v', 'f'].join('');
    const retiredFilePrefix = ['r', 'v', 'f'].join('');
    expect(
      matchingFiles(
        new RegExp(`\\b${retiredPrefix}LearningStore\\b|\\b${retiredPrefix}LearningStoreConfig\\b|\\bPersistentSonaCoordinator\\b|${retiredFilePrefix}-learning-store\\.js|persistent-sona\\.js`)
      )
    ).toEqual([]);
  });

  it('removes the neural counter-only EWC surface while leaving mode-level EWCState hooks to CA-4', () => {
    expect(
      matchingFilesExcept(
        /\bconsolidateEWC\b|\bgetEWCConfig\b|\bEWCConfig\b|\btaskCount\b|\blastConsolidation\b/,
        ['cli/src/memory/ewc-consolidation.ts']
      )
    ).toEqual([]);
  });
});
