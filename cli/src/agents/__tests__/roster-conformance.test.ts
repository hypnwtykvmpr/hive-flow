import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_CLI_DEFAULT_MODEL,
  ANTHROPIC_SONNET_MODEL,
  CODEX_CLI_DEFAULT_MODEL,
  GEMINI_CLI_DEFAULT_MODEL,
  PROVIDER_DEFAULTS,
} from '@hive-flow/providers';
import {
  CANONICAL_AGENT_TYPES,
  getCanonicalAgentTypes,
  loadCanonicalRoster,
  resolveCanonicalAgentsDir,
} from '../roster.js';

const EXPECTED_TYPES = [
  'investigator',
  'researcher',
  'verifier',
  'architect',
  'planner',
  'implementer',
  'tester',
  'auditor',
  'bug-hunter',
  'debugger',
  'security-architect',
  'security-reviewer',
  'red-team',
  'blue-team',
  'performance-engineer',
  'memory-specialist',
  'documenter',
  'coordinator',
] as const;

const GOVERNANCE_TYPES = ['advocate', 'queen', 'enforcer'];
const SOLO_TYPES = new Set(['bug-hunter', 'debugger']);

describe('canonical agent roster', () => {
  it('exposes exactly the confirmed 18 agent types', () => {
    expect(CANONICAL_AGENT_TYPES).toEqual(EXPECTED_TYPES);
    expect(getCanonicalAgentTypes()).toEqual(EXPECTED_TYPES);

    const agentsDir = resolveCanonicalAgentsDir();
    const files = readdirSync(agentsDir)
      .filter(file => file.endsWith('.yaml'))
      .sort();

    expect(files).toHaveLength(18);
    expect(files.map(file => basename(file, '.yaml'))).toEqual([...EXPECTED_TYPES].sort());
  });

  it('loads every roster file with the required schema', () => {
    const roster = loadCanonicalRoster();

    expect(roster).toHaveLength(18);
    for (const record of roster) {
      expect(record.name).toBe(record.type);
      expect(EXPECTED_TYPES).toContain(record.type as typeof EXPECTED_TYPES[number]);
      expect(typeof record.description).toBe('string');
      expect(record.description.length).toBeGreaterThan(20);
      expect(typeof record.soloExempt).toBe('boolean');
      expect(typeof record.defaultProvider).toBe('string');
      expect(record.defaultProvider.length).toBeGreaterThan(0);
      expect(typeof record.defaultModel).toBe('string');
      expect(record.defaultModel.length).toBeGreaterThan(0);
      expect(Array.isArray(record.phases)).toBe(true);
      expect(record.phases.length).toBeGreaterThan(0);
      expect(Array.isArray(record.capabilities)).toBe(true);
      expect(record.capabilities.length).toBeGreaterThan(0);
      expect(typeof record.systemPrompt).toBe('string');
      expect(record.systemPrompt.length).toBeGreaterThan(80);
    }
  });

  it('marks only bug-hunter and debugger as solo-exempt', () => {
    const roster = loadCanonicalRoster();

    for (const record of roster) {
      expect(record.soloExempt).toBe(SOLO_TYPES.has(record.type));
    }
  });

  it('keeps governance identities out of the spawn roster', () => {
    const types = new Set(getCanonicalAgentTypes());

    for (const governanceType of GOVERNANCE_TYPES) {
      expect(types.has(governanceType)).toBe(false);
    }
  });

  it('uses current canonical defaults for every provider-backed role', () => {
    const expectedByProvider: Record<string, string> = {
      'anthropic-cli': ANTHROPIC_CLI_DEFAULT_MODEL,
      'codex-cli': CODEX_CLI_DEFAULT_MODEL,
      'gemini-cli': GEMINI_CLI_DEFAULT_MODEL,
      'gemini': GEMINI_CLI_DEFAULT_MODEL,
      'openrouter': PROVIDER_DEFAULTS.openrouter!,
      'deepseek': PROVIDER_DEFAULTS.deepseek!,
    };

    for (const record of loadCanonicalRoster()) {
      if (record.defaultProvider === 'claude-code') {
        expect(
          [ANTHROPIC_CLI_DEFAULT_MODEL, ANTHROPIC_SONNET_MODEL],
          `${record.type} model`,
        ).toContain(record.defaultModel);
        continue;
      }
      expect(record.defaultModel, `${record.type} model`).toBe(expectedByProvider[record.defaultProvider]);
    }
  });

  it('is de-branded pure data', () => {
    const agentsDir = resolveCanonicalAgentsDir();
    expect(existsSync(agentsDir)).toBe(true);

    const combined = readdirSync(agentsDir)
      .filter(file => file.endsWith('.yaml'))
      .map(file => readFileSync(join(agentsDir, file), 'utf8'))
      .join('\n');

    expect(combined).not.toMatch(/npx hive-flow@v3alpha/i);
    expect(combined).not.toMatch(/claude-flow/i);
    expect(combined).not.toMatch(/\bruv\b/i);
    expect(combined).not.toMatch(/\bru-/i);
  });
});
