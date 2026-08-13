import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ANTHROPIC_CLI_DEFAULT_MODEL,
  ANTHROPIC_SONNET_MODEL,
  CODEX_CLI_DEFAULT_MODEL,
  GEMINI_CLI_DEFAULT_MODEL,
} from '../model-alias-resolver.js';

const PROVIDERS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_ROOT = join(PROVIDERS_ROOT, '..', '..');
const REPO_ROOT = join(CLI_ROOT, '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readRepoFile(relativePath)) as Record<string, unknown>;
}

describe('operator-facing model documentation follows canonical provider defaults', () => {
  const currentSurfaces = [
    'CLAUDE.md',
    'README.md',
    'cli/README.md',
    '.claude/settings.json',
    'cli/.claude/settings.json',
    '.claude/skills/ask-provider/SKILL.md',
    '.claude/skills/provider-agents/SKILL.md',
    '.claude/skills/providers/SKILL.md',
    'cli/src/statusline/model-display.ts',
  ];

  it('keeps the enforcement guide and provider capability table current', () => {
    const guide = readRepoFile('CLAUDE.md');

    expect(guide).toContain(
      `Top-tier enforcement**: gemini-cli requires \`${GEMINI_CLI_DEFAULT_MODEL}\`, codex-cli requires \`${CODEX_CLI_DEFAULT_MODEL}\``,
    );
    expect(guide).toContain(
      `| \`gemini-cli\` | Yes | Yes | Yes | ${GEMINI_CLI_DEFAULT_MODEL} |`,
    );
    expect(guide).toContain(
      `| \`codex-cli\` | Yes | Yes | Yes | ${CODEX_CLI_DEFAULT_MODEL} |`,
    );
  });

  it.each(['README.md', 'cli/README.md'])(
    'keeps %s current-model tables and configuration examples aligned',
    (relativePath) => {
      const readme = readRepoFile(relativePath);

      expect(readme).toContain(
        `| Default Model | ${ANTHROPIC_CLI_DEFAULT_MODEL} | ${CODEX_CLI_DEFAULT_MODEL} |`,
      );
      expect(readme).toContain(
        `| \`codex-cli\` | ${CODEX_CLI_DEFAULT_MODEL} | OpenAI Codex headless agent |`,
      );
      expect(readme).toContain(
        `| \`gemini-cli\` | ${GEMINI_CLI_DEFAULT_MODEL} | Google Gemini headless agent |`,
      );
      expect(readme).toContain(
        `| \`anthropic-cli\` | ${ANTHROPIC_CLI_DEFAULT_MODEL} | Claude headless agent |`,
      );
      expect(readme).toContain(`"model": "${ANTHROPIC_CLI_DEFAULT_MODEL}"`);
      expect(readme).toContain(`"model": "${CODEX_CLI_DEFAULT_MODEL}"`);
    },
  );

  it.each(['.claude/settings.json', 'cli/.claude/settings.json'])(
    'keeps the operational model preferences in %s aligned',
    (relativePath) => {
      const settings = readJson(relativePath) as {
        hiveFlow?: { modelPreferences?: { default?: string; routing?: string } };
      };

      expect(settings.hiveFlow?.modelPreferences).toEqual({
        default: ANTHROPIC_CLI_DEFAULT_MODEL,
        routing: ANTHROPIC_SONNET_MODEL,
      });
    },
  );

  it('keeps provider skills aligned with canonical CLI defaults', () => {
    const askProvider = readRepoFile('.claude/skills/ask-provider/SKILL.md');
    const providerAgents = readRepoFile('.claude/skills/provider-agents/SKILL.md');
    const providers = readRepoFile('.claude/skills/providers/SKILL.md');

    for (const source of [askProvider, providerAgents, providers]) {
      expect(source).toContain(GEMINI_CLI_DEFAULT_MODEL);
      expect(source).toContain(CODEX_CLI_DEFAULT_MODEL);
    }
    expect(providerAgents).toContain(ANTHROPIC_CLI_DEFAULT_MODEL);
    expect(providers).toContain(ANTHROPIC_CLI_DEFAULT_MODEL);
    expect(providers).toContain('| `gemini-cli` | `agy` |');
  });

  it('keeps the statusline model-format example current', () => {
    const source = readRepoFile('cli/src/statusline/model-display.ts');

    expect(source).toContain('e.g. "Opus 5" or "Opus 5 1M"');
  });

  it('does not retain previous defaults in current operator surfaces', () => {
    // Historical/negative fixtures are intentionally outside this list. For
    // example, the statusline golden fixture still proves rendering of an old
    // display label without presenting that label as a current default.
    const previousDefaults = [
      'claude-opus-4-8',
      'Opus 4.8',
      'gpt-5.5',
      'gpt-5.4',
      'gemini-3.5-flash',
      'gemini-3.1-pro-preview',
    ];

    for (const relativePath of currentSurfaces) {
      const source = readRepoFile(relativePath);
      for (const previousDefault of previousDefaults) {
        expect(source, `${relativePath} retains ${previousDefault}`).not.toContain(previousDefault);
      }
    }
  });
});
