import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { initializeCodexProject } from '../../../../codex/src/initializer.js';
import { PACKAGE_INFO } from '../../../../codex/src/index.js';
import { generateBuiltInSkill } from '../../../../codex/src/generators/skill-md.js';
import { executeInit } from '../executor.js';
import { DEFAULT_INIT_OPTIONS, type InitOptions } from '../types.js';

interface ProhibitedPattern {
  readonly label: string;
  readonly pattern: RegExp;
}

const CORE_PROHIBITED: ProhibitedPattern[] = [
  { label: 'old GitHub org', pattern: /ruvnet\/hive-flow/i },
  { label: 'old container registry org', pattern: /ghcr\.io\/ruvnet\/hive-flow/i },
  { label: 'stale agentdb version', pattern: /2\.0\.0-alpha\.3\.4/ },
  { label: 'old RuVector brand', pattern: /\bRuVector\b/ },
];

const PERF_CLAIM_PROHIBITED: ProhibitedPattern[] = [
  { label: 'fictional HNSW speed multiplier', pattern: /\b(?:150\s*x|12,?500\s*x|150\s*x\s*(?:-|–|to|and)\s*12,?500\s*x)\b/i },
  { label: 'fictional Flash Attention speed range', pattern: /\b2\.49\s*x\s*(?:-|–|to)\s*7\.47\s*x\b/i },
  { label: 'fictional SWE-Bench solve rate', pattern: /\b84\.8\s*%/ },
  { label: 'fictional SONA adaptation latency', pattern: /(?:<\s*)?0\.05\s*ms/i },
  { label: 'old RuVector intelligence label', pattern: /RuVector Intelligence System/ },
];

const CODEX_GENERATOR_PROHIBITED: ProhibitedPattern[] = [
  ...CORE_PROHIBITED,
  ...PERF_CLAIM_PROHIBITED,
];

function fullInitOptions(targetDir: string): InitOptions {
  return {
    ...DEFAULT_INIT_OPTIONS,
    targetDir,
    force: true,
    interactive: false,
  };
}

function collectFiles(root: string, relativePaths: string[]): string {
  return relativePaths
    .map((relativePath) => {
      const absolutePath = join(root, relativePath);
      return `\n--- ${relativePath} ---\n${readFileSync(absolutePath, 'utf8')}`;
    })
    .join('\n');
}

function assertNoProhibitedStrings(label: string, text: string, patterns: ProhibitedPattern[]): void {
  const hits = patterns
    .filter(({ pattern }) => pattern.test(text))
    .map(({ label: patternLabel, pattern }) => `${patternLabel}: ${pattern}`);

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

describe('debrand generator output', () => {
  it('emits zero prohibited brand and stale-version strings from CLI init and Codex init outputs', async () => {
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
        'cli-init',
        collectFiles(cliRoot, ['CLAUDE.md', '.claude/settings.json', '.hive-flow/CAPABILITIES.md']),
        [...CORE_PROHIBITED, ...PERF_CLAIM_PROHIBITED],
      );
      const generatedMemorySkill = await generateBuiltInSkill('memory-management');
      assertNoProhibitedStrings(
        'codex-init',
        [
          collectFiles(codexRoot, [
            'AGENTS.md',
            '.agents/config.toml',
            '.agents/README.md',
            '.codex/AGENTS.override.md',
            '.codex/config.toml',
          ]),
          generatedMemorySkill.skillMd,
        ].join('\n'),
        CODEX_GENERATOR_PROHIBITED,
      );
      assertNoProhibitedStrings('codex-package-info', JSON.stringify(PACKAGE_INFO), CORE_PROHIBITED);
    } finally {
      rmSync(cliRoot, { recursive: true, force: true });
      rmSync(cliHome, { recursive: true, force: true });
      rmSync(codexRoot, { recursive: true, force: true });
    }
  });
});
