import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeClientKind, operatorSessionEnvKeys } from '../mcp-tools/session-id.js';
import { propertyRunsFromEnv } from './property-runs.js';

const PROPERTY_RUNS = propertyRunsFromEnv(200);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../..');
const requireFromHere = createRequire(import.meta.url);
const cjsClientKind = requireFromHere(resolve(repoRoot, '.claude/helpers/client-kind.cjs')) as {
  normalizeClientKind: (value: unknown) => string | null;
  operatorSessionEnvKeys: (kind?: string | null) => string[];
};

const ALIASES: Array<{ alias: string; kind: string }> = [
  { alias: 'claude', kind: 'claude' },
  { alias: 'claude-code', kind: 'claude' },
  { alias: 'anthropic-cli', kind: 'claude' },
  { alias: 'codex', kind: 'codex' },
  { alias: 'codex-cli', kind: 'codex' },
  { alias: 'gemini', kind: 'gemini' },
  { alias: 'gemini-cli', kind: 'gemini' },
  { alias: 'cursor', kind: 'cursor' },
  { alias: 'cursor-cli', kind: 'cursor' },
  { alias: 'cursor-agent', kind: 'cursor' },
  { alias: 'agent', kind: 'cursor' },
  { alias: 'antigravity', kind: 'antigravity' },
  { alias: 'antigravity-cli', kind: 'antigravity' },
  { alias: 'agy', kind: 'antigravity' },
  { alias: 'opencode', kind: 'opencode' },
  { alias: 'open-code', kind: 'opencode' },
  { alias: 'forgecode', kind: 'forgecode' },
  { alias: 'forge-code', kind: 'forgecode' },
  { alias: 'forge', kind: 'forgecode' },
];

function randomizeCase(value: string, mask: boolean[]): string {
  return value
    .split('')
    .map((char, index) => (mask[index % mask.length] ? char.toUpperCase() : char.toLowerCase()))
    .join('');
}

describe('operator parent client kind aliases', () => {
  it('normalizes every supported parent alias with TypeScript/CJS parity', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALIASES),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 0, maxLength: 4 }).filter((value) => value.trim().length === 0),
        (entry, mask, padding) => {
          const candidate = `${padding}${randomizeCase(entry.alias, mask)}${padding}`;
          expect(normalizeClientKind(candidate)).toBe(entry.kind);
          expect(cjsClientKind.normalizeClientKind(candidate)).toBe(entry.kind);
        },
      ),
      { seed: 20_624, numRuns: PROPERTY_RUNS },
    );
  });

  it('keeps CJS and TypeScript session-env keys in parity for every canonical parent kind', () => {
    for (const kind of ['claude', 'codex', 'gemini', 'cursor', 'antigravity', 'opencode', 'forgecode']) {
      expect(cjsClientKind.operatorSessionEnvKeys(kind)).toEqual(operatorSessionEnvKeys(kind as never));
    }
    expect(cjsClientKind.operatorSessionEnvKeys()).toEqual(operatorSessionEnvKeys());
  });
});
