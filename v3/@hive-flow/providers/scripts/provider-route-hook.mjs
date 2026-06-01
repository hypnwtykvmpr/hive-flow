#!/usr/bin/env node
/**
 * Provider Route Hook — UserPromptSubmit
 *
 * Claude Code hook that detects provider keywords in user prompts
 * and suggests available CLI providers.
 *
 * Hook protocol:
 * - stdin: JSON with { message: { content: string } }
 * - stdout: user-visible output (suggestion tags)
 * - stderr: debug logs
 * - exit 0: continue (always)
 *
 * @module @hive-flow/providers/scripts/provider-route-hook
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// ===== Provider keyword patterns =====

const PROVIDER_PATTERNS = [
  {
    provider: 'gemini-cli',
    model: 'gemini-3.5-flash',
    patterns: [
      /\buse\s+gemini\b/i,
      /\bask\s+gemini\b/i,
      /\bgemini[\s-]cli\b/i,
      /\bgemini\s+agent\b/i,
      /\bgemini[\s-]researcher\b/i,
    ],
  },
  {
    provider: 'codex-cli',
    model: 'gpt-5.5',
    patterns: [
      /\buse\s+codex\b/i,
      /\bask\s+codex\b/i,
      /\bcodex[\s-]cli\b/i,
      /\bcodex\s+agent\b/i,
      /\bcodex[\s-]researcher\b/i,
    ],
  },
  {
    provider: 'cursor-cli',
    model: 'auto',
    patterns: [
      /\buse\s+cursor\b/i,
      /\bcursor\s+agent\b/i,
      /\bcursor[\s-]cli\b/i,
      /\bcursor[\s-]researcher\b/i,
    ],
  },
];

// ===== Cache reading =====

function getProviderVersion(provider) {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
    const cachePath = join(home, '.hive-flow', 'provider-status-cache.json');
    if (!existsSync(cachePath)) return null;

    const cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    const entry = cache.providers?.[provider];
    if (!entry || !entry.found) return null;

    // Check TTL (30 minutes)
    const age = Date.now() - (entry.timestamp || 0);
    if (age > 30 * 60 * 1000) return null;

    return entry.version || 'installed';
  } catch {
    return null;
  }
}

// ===== Main =====

async function main() {
  let input = '';
  try {
    input = readFileSync(0, 'utf-8');
  } catch {
    // No stdin available — exit silently
    process.exit(0);
  }

  if (!input.trim()) {
    process.exit(0);
  }

  let prompt = '';
  try {
    const data = JSON.parse(input);
    // Claude Code hook protocol: message.content or prompt field
    prompt = data?.message?.content || data?.prompt || '';
  } catch {
    // Not valid JSON — treat as raw text prompt
    prompt = input;
  }

  if (!prompt || typeof prompt !== 'string') {
    process.exit(0);
  }

  // Check each provider pattern
  for (const { provider, model, patterns } of PROVIDER_PATTERNS) {
    const matched = patterns.some((re) => re.test(prompt));
    if (!matched) continue;

    const version = getProviderVersion(provider);
    const versionStr = version ? ` (${version})` : '';

    process.stdout.write(
      `[PROVIDER_SUGGESTION] ${provider} available${versionStr}. ` +
      `Use: agent_spawn { provider: "${provider}", model: "${model}", task: "..." }\n`
    );
    // Only suggest the first match
    break;
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[provider-route-hook] Error: ${err.message}\n`);
  process.exit(0); // Always exit 0 — never block Claude Code
});
