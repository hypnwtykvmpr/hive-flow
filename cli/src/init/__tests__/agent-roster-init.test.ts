import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { getCanonicalAgentTypes } from '../../agents/roster.js';
import { executeInit } from '../executor.js';
import { DEFAULT_INIT_OPTIONS, type InitOptions } from '../types.js';

const GOVERNANCE_IDENTITIES = new Set(['advocate', 'queen', 'enforcer']);

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function workspaceRoot(): string {
  return resolve(packageRoot(), '..', '..', '..');
}

const DUPLICATE_ROSTER_ROOTS = [
  'cli/.claude/agents',
  'agents',
  'v3/agents',
  'v3/@hive-flow/agents',
  'cli/packages/embeddings/agents',
  'cli/src/memory/agents',
  'v3/plugins/agentic-qe/agents',
  'cli/packages/plugin-gastown-bridge/agents',
] as const;

function agentOnlyOptions(targetDir: string): InitOptions {
  return {
    ...DEFAULT_INIT_OPTIONS,
    targetDir,
    force: true,
    interactive: false,
    components: {
      ...DEFAULT_INIT_OPTIONS.components,
      settings: false,
      skills: false,
      commands: false,
      agents: true,
      helpers: false,
      statusline: false,
      mcp: false,
      runtime: false,
      claudeMd: false,
    },
    agents: {
      ...DEFAULT_INIT_OPTIONS.agents,
      all: true,
    },
  };
}

describe('init canonical agent roster generation', () => {
  it('generates exactly the canonical 18 agent files and no governance identities', async () => {
    const targetDir = mkdtempSync(join(tmpdir(), 'hf-init-agents-'));
    try {
      const result = await executeInit(agentOnlyOptions(targetDir));

      expect(result.errors, result.errors.join('\n')).toEqual([]);
      expect(result.success).toBe(true);

      const generatedAgentsDir = join(targetDir, '.claude', 'agents');
      const generatedFiles = readdirSync(generatedAgentsDir)
        .filter((entry) => statSync(join(generatedAgentsDir, entry)).isFile())
        .sort();
      const generatedTypes = generatedFiles.map((file) => file.replace(/\.yaml$/, ''));
      const canonicalTypes = [...getCanonicalAgentTypes()].sort();

      expect(generatedFiles.every((file) => file.endsWith('.yaml'))).toBe(true);
      expect(generatedTypes).toEqual(canonicalTypes);
      expect(generatedTypes.filter((type) => GOVERNANCE_IDENTITIES.has(type))).toEqual([]);
      expect(result.summary.agentsCount).toBe(18);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('does not leave duplicate live roster roots beside the canonical package roster', () => {
    const root = workspaceRoot();
    const duplicateRoots = DUPLICATE_ROSTER_ROOTS
      .map((relativePath) => join(root, relativePath))
      .filter((candidate) => candidate !== join(packageRoot(), 'agents'));

    expect(duplicateRoots.filter((candidate) => existsSync(candidate))).toEqual([]);
  });
});
