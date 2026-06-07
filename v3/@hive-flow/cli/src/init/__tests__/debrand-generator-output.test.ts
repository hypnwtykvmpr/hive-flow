import { Dirent, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { initializeCodexProject } from '../../../../codex/src/initializer.js';
import { PACKAGE_INFO } from '../../../../codex/src/index.js';
import { generateBuiltInSkill } from '../../../../codex/src/generators/skill-md.js';
import { executeInit } from '../executor.js';
import { DEFAULT_INIT_OPTIONS, type InitOptions } from '../types.js';
import { DEBRAND_ASSERT_ZERO_PROHIBITED, type ProhibitedPattern } from './debrand-prohibited-patterns.js';

const GENERATED_TEXT_EXTENSIONS = new Set([
  '',
  '.cjs',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.ps1',
  '.sh',
  '.toml',
  '.ts',
  '.yaml',
  '.yml',
]);

function fullInitOptions(targetDir: string): InitOptions {
  return {
    ...DEFAULT_INIT_OPTIONS,
    targetDir,
    force: true,
    interactive: false,
  };
}

function generatedTextArtifacts(root: string): string {
  const chunks: string[] = [];

  function visit(directory: string): void {
    const entries: Dirent[] = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!GENERATED_TEXT_EXTENSIONS.has(extname(entry.name))) continue;
      if (!statSync(absolutePath).isFile()) continue;
      const relativePath = relative(root, absolutePath);
      chunks.push(`\n--- ${relativePath} ---\n${readFileSync(absolutePath, 'utf8')}`);
    }
  }

  visit(root);
  return chunks.join('\n');
}

function assertNoProhibitedStrings(label: string, text: string, patterns: ProhibitedPattern[]): void {
  const hits: string[] = [];
  let artifact = '<inline>';
  text.split('\n').forEach((line, index) => {
    const section = line.match(/^---\s+(.+)\s+---$/);
    if (section) {
      artifact = section[1] ?? artifact;
      return;
    }
    for (const { label: patternLabel, pattern } of patterns) {
      if (pattern.test(line)) {
        hits.push(`${artifact}:${index + 1}: ${patternLabel}: ${pattern}: ${line.trim()}`);
      }
    }
  });

  expect(hits, `[debrand-assert-zero][${label}] prohibited generated output`).toEqual([]);
}

async function withCodexCliUnavailable<T>(fn: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin';
  try {
    return await fn();
  } finally {
    process.env.PATH = originalPath;
  }
}

describe('debrand-assert-zero generated output gate', () => {
  it('fails if either CLI init or Codex init generated output contains prohibited strings', async () => {
    const cliRoot = mkdtempSync(join(tmpdir(), 'hf-cli-debrand-'));
    const cliHome = mkdtempSync(join(tmpdir(), 'hf-cli-debrand-home-'));
    const codexRoot = mkdtempSync(join(tmpdir(), 'hf-codex-debrand-'));
    try {
      const cliResult = await executeInit({
        ...fullInitOptions(cliRoot),
        enforcementHomeDir: cliHome,
      } as InitOptions & { enforcementHomeDir: string });
      expect(cliResult.errors, cliResult.errors.join('\n')).toEqual([]);
      expect(cliResult.success).toBe(true);

      await withCodexCliUnavailable(async () => {
        const codexResult = await initializeCodexProject(codexRoot, {
          template: 'full',
          skills: ['memory-management'],
          force: true,
        });
        expect(codexResult.errors ?? [], (codexResult.errors ?? []).join('\n')).toEqual([]);
        expect(codexResult.success).toBe(true);
      });

      assertNoProhibitedStrings(
        'pass-a-cli-init-generated-artifacts',
        generatedTextArtifacts(cliRoot),
        DEBRAND_ASSERT_ZERO_PROHIBITED,
      );
      const generatedMemorySkill = await generateBuiltInSkill('memory-management');
      assertNoProhibitedStrings(
        'pass-b-codex-init-generated-artifacts',
        generatedTextArtifacts(codexRoot),
        DEBRAND_ASSERT_ZERO_PROHIBITED,
      );
      assertNoProhibitedStrings(
        'pass-b-codex-generated-memory-management-skill',
        [
          generatedMemorySkill.skillMd,
          ...Object.entries(generatedMemorySkill.scripts).map(([path, content]) => `\n--- ${path} ---\n${content}`),
          ...Object.entries(generatedMemorySkill.references).map(([path, content]) => `\n--- ${path} ---\n${content}`),
        ].join('\n'),
        DEBRAND_ASSERT_ZERO_PROHIBITED,
      );
      assertNoProhibitedStrings(
        'pass-b-codex-package-info',
        JSON.stringify(PACKAGE_INFO),
        DEBRAND_ASSERT_ZERO_PROHIBITED,
      );
    } finally {
      rmSync(cliRoot, { recursive: true, force: true });
      rmSync(cliHome, { recursive: true, force: true });
      rmSync(codexRoot, { recursive: true, force: true });
    }
  });
});
