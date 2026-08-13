import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPERATOR_CLIENT_KINDS, normalizeClientKind, operatorSessionEnvKeys, resolveClientKindFromEnv } from '../mcp-tools/session-id.js';
import { propertyRunsFromEnv } from './property-runs.js';

const PROPERTY_RUNS = propertyRunsFromEnv(200);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const requireFromHere = createRequire(import.meta.url);
const cjsClientKindPath = resolve(repoRoot, '.claude/helpers/client-kind.cjs');
const cjsClientKind = requireFromHere(cjsClientKindPath) as {
  normalizeClientKind: (value: unknown) => string | null;
  operatorSessionEnvKeys: (kind?: string | null) => string[];
  clientKindFromEnv: (env?: Record<string, string | undefined>) => string | null;
};

function normalizedRelative(from: string, to: string): string {
  return relative(from, to).replaceAll('\\', '/');
}

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
  { alias: 'devin', kind: 'devin' },
  { alias: 'devin-cli', kind: 'devin' },
  { alias: 'chisel', kind: 'devin' },
];

const EXPECTED_SESSION_ENV_KEYS: Record<string, string[]> = {
  codex: ['CODEX_SESSION_ID', 'CODEX_THREAD_ID'],
  claude: ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID'],
  gemini: ['GEMINI_SESSION_ID', 'GEMINI_THREAD_ID'],
  cursor: ['CURSOR_SESSION_ID', 'CURSOR_THREAD_ID', 'AGENT_SESSION_ID'],
  antigravity: ['ANTIGRAVITY_SESSION_ID', 'ANTIGRAVITY_THREAD_ID', 'AGY_SESSION_ID', 'AGY_THREAD_ID'],
  opencode: ['OPENCODE_SESSION_ID', 'OPENCODE_THREAD_ID'],
  forgecode: ['FORGECODE_SESSION_ID', 'FORGECODE_THREAD_ID', 'FORGE_CODE_SESSION_ID', 'FORGE_SESSION_ID'],
  devin: ['DEVIN_SESSION_ID', 'TERM_SESSION_ID', 'WT_SESSION'],
};

function randomizeCase(value: string, mask: boolean[]): string {
  return value
    .split('')
    .map((char, index) => (mask[index % mask.length] ? char.toUpperCase() : char.toLowerCase()))
    .join('');
}

describe('operator parent client kind aliases', () => {
  it('loads the CJS helper from this repository root, not an ancestor', () => {
    expect(normalizedRelative(repoRoot, here)).toBe('cli/src/__tests__');
    expect(existsSync(resolve(repoRoot, 'cli/package.json'))).toBe(true);
    expect(normalizedRelative(repoRoot, cjsClientKindPath)).toBe('.claude/helpers/client-kind.cjs');
    expect(existsSync(cjsClientKindPath)).toBe(true);
  });

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
    for (const kind of OPERATOR_CLIENT_KINDS) {
      expect(cjsClientKind.operatorSessionEnvKeys(kind)).toEqual(operatorSessionEnvKeys(kind as never));
    }
    expect(cjsClientKind.operatorSessionEnvKeys()).toEqual(operatorSessionEnvKeys());
  });

  it('pins the explicit session-env key set for every canonical parent kind', () => {
    for (const kind of OPERATOR_CLIENT_KINDS) {
      expect(operatorSessionEnvKeys(kind)).toEqual(EXPECTED_SESSION_ENV_KEYS[kind]);
      expect(cjsClientKind.operatorSessionEnvKeys(kind)).toEqual(EXPECTED_SESSION_ENV_KEYS[kind]);
    }
    expect(operatorSessionEnvKeys()).toEqual([
      'CODEX_SESSION_ID',
      'CODEX_THREAD_ID',
      'OPENCODE_SESSION_ID',
      'OPENCODE_THREAD_ID',
      'FORGECODE_SESSION_ID',
      'FORGECODE_THREAD_ID',
      'FORGE_CODE_SESSION_ID',
      'FORGE_SESSION_ID',
      'DEVIN_SESSION_ID',
      'ANTIGRAVITY_SESSION_ID',
      'ANTIGRAVITY_THREAD_ID',
      'AGY_SESSION_ID',
      'AGY_THREAD_ID',
      'GEMINI_SESSION_ID',
      'GEMINI_THREAD_ID',
      'CURSOR_SESSION_ID',
      'CURSOR_THREAD_ID',
      'CLAUDE_SESSION_ID',
      'CLAUDE_CODE_SESSION_ID',
      'AGENT_SESSION_ID',
      'TERM_SESSION_ID',
      'WT_SESSION',
      'HIVE_FLOW_SESSION_ID',
    ]);
  });

  it('aligns explicit client kind with the session env that actually owns the agent', () => {
    const staleCodexInClaudeEnv = {
      HIVE_FLOW_CLIENT_KIND: 'codex',
      CLAUDE_SESSION_ID: 'claude-session',
    };
    expect(resolveClientKindFromEnv(staleCodexInClaudeEnv)).toBe('claude');
    expect(cjsClientKind.clientKindFromEnv(staleCodexInClaudeEnv)).toBe('claude');

    const realCodexEnv = {
      HIVE_FLOW_CLIENT_KIND: 'codex',
      CODEX_THREAD_ID: 'codex-session',
      CLAUDE_SESSION_ID: 'claude-session',
    };
    expect(resolveClientKindFromEnv(realCodexEnv)).toBe('codex');
    expect(cjsClientKind.clientKindFromEnv(realCodexEnv)).toBe('codex');

    const providerSessionEnv = {
      HIVE_FLOW_CLIENT_KIND: 'opencode',
      HIVE_FLOW_SESSION_ID: 'explicit-provider-session',
    };
    expect(resolveClientKindFromEnv(providerSessionEnv)).toBe('opencode');
    expect(cjsClientKind.clientKindFromEnv(providerSessionEnv)).toBe('opencode');

    const labelOnlyEnv = {
      HIVE_FLOW_CLIENT_KIND: 'codex',
    };
    expect(resolveClientKindFromEnv(labelOnlyEnv)).toBe('unknown');
    expect(cjsClientKind.clientKindFromEnv(labelOnlyEnv)).toBe(null);

    const codexReconnectInClaudeRuntimeEnv = {
      HIVE_FLOW_CLIENT_KIND: 'codex',
      CODEX_THREAD_ID: 'codex-thread-from-reconnect',
      CLAUDE_PROJECT_DIR: '/repo',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: 'claude-code-session',
    };
    expect(resolveClientKindFromEnv(codexReconnectInClaudeRuntimeEnv)).toBe('claude');
    expect(cjsClientKind.clientKindFromEnv(codexReconnectInClaudeRuntimeEnv)).toBe('claude');
  });

  it('recognizes a Devin MCP connection only with Chisel runtime and terminal-session evidence', () => {
    const macDevinEnv = {
      CHISEL_SESSION_DB: '/home/operator/.local/share/devin/cli/sessions.db',
      TERM_SESSION_ID: '904966B0-AC61-4EC1-A65A-24D71739BC3C',
    };
    expect(resolveClientKindFromEnv(macDevinEnv)).toBe('devin');
    expect(cjsClientKind.clientKindFromEnv(macDevinEnv)).toBe('devin');

    const windowsDevinEnv = {
      CHISEL_SESSION_DB: 'C:\\Users\\operator\\AppData\\Local\\devin\\sessions.db',
      WT_SESSION: 'windows-terminal-session',
    };
    expect(resolveClientKindFromEnv(windowsDevinEnv)).toBe('devin');
    expect(cjsClientKind.clientKindFromEnv(windowsDevinEnv)).toBe('devin');

    expect(resolveClientKindFromEnv({ TERM_SESSION_ID: 'ordinary-terminal' })).toBe('unknown');
    expect(cjsClientKind.clientKindFromEnv({ TERM_SESSION_ID: 'ordinary-terminal' })).toBe(null);
    expect(resolveClientKindFromEnv({ CHISEL_SESSION_DB: '/tmp/sessions.db' })).toBe('unknown');
    expect(cjsClientKind.clientKindFromEnv({ CHISEL_SESSION_DB: '/tmp/sessions.db' })).toBe(null);
  });
});
