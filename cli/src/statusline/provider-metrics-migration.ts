// cli/src/statusline/provider-metrics-migration.ts
//
// Phase 11 — Provider metrics migration.
//
// Reads a legacy `provider-usage.json` (flat `{ openai: {...} }` or nested
// `{ providers: {...} }` shape), backs it up, and folds each provider's
// aggregate call count into the canonical scoreboard ledger as one
// deterministic `call-complete` event per provider. The summary is then
// materialized to `outputPath`.
//
// Idempotency is structural: `recordProviderCall` dedupes on
// `[eventId, event]`, and we derive `eventId` deterministically from the
// migrated values, so re-running the migration appends nothing new. This also
// survives `statusline repair --target scoreboard`, which rebuilds the summary
// from the ledger (not from `current.json`), because the events live in the
// ledger.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { copyBackupOnce } from '../integrations/atomic-merge.js';
import {
  recordProviderCall,
  computeScoreboardSummary,
} from './recorders/scoreboard.js';
import { writeJsonFile } from './storage.js';
import type { HostCli, ScoreProvider } from './types.js';

/** Per-provider entry in a legacy provider-usage file. */
interface LegacyProviderEntry {
  calls?: number;
  tokens?: number;
  ttfb_avg_ms?: number;
  last_used?: string;
}

type FlatMetrics = Record<string, LegacyProviderEntry>;

export interface MigrateProviderUsageResult {
  readonly migrated: boolean;
  readonly providers: string[];
  readonly backupPath?: string;
  readonly skippedReason?: string;
}

export interface MigrateProviderUsageOptions {
  readonly projectRoot: string;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly projectKey: string;
}

/** Coerce an unknown numeric field to a non-negative finite number (else 0). */
function finiteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Narrow an unknown value to a non-array plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Unwrap the nested `{ providers: {...} }` shape to the flat metrics map.
 * Returns `undefined` when the input is not an object (the caller reports a
 * skip reason). A nested `providers` object wins; otherwise the top-level
 * object is treated as the flat metrics map.
 */
function normalizeProviderMetrics(data: unknown): FlatMetrics | undefined {
  if (!isPlainObject(data)) return undefined;
  const nested = (data as { providers?: unknown }).providers;
  if (isPlainObject(nested)) return nested as FlatMetrics;
  return data as FlatMetrics;
}

/** Map an arbitrary legacy provider label to a known `ScoreProvider`. */
function normalizeProviderName(name: string): ScoreProvider {
  const key = name.toLowerCase();
  if (key.includes('claude') || key.includes('anthropic')) return 'claude';
  if (key.includes('codex') || key.includes('openai')) return 'codex';
  if (key.includes('gemini') || key.includes('google')) return 'gemini';
  if (key.includes('forge')) return 'forge';
  if (key.includes('cursor')) return 'cursor';
  if (key.includes('deepseek')) return 'deepseek';
  if (key.includes('openrouter')) return 'openrouter';
  if (key.includes('qwen')) return 'qwen';
  if (key.includes('opencode')) return 'opencode';
  return 'unknown';
}

/**
 * Exhaustive `ScoreProvider -> HostCli` map. API-only providers (deepseek,
 * openrouter) and `unknown` have no interactive host CLI, so they record
 * under `hive-flow-daemon`. Every branch returns a valid `HostCli` — the
 * `satisfies` clause on the record pins exhaustiveness at compile time.
 */
const PROVIDER_TO_HOST_CLI = {
  claude: 'claude-code',
  codex: 'codex',
  gemini: 'gemini',
  forge: 'forgecode',
  cursor: 'cursor-cli',
  qwen: 'qwen',
  opencode: 'opencode',
  deepseek: 'hive-flow-daemon',
  openrouter: 'hive-flow-daemon',
  unknown: 'hive-flow-daemon',
} satisfies Record<ScoreProvider, HostCli>;

function migrationEventId(
  rawName: string,
  provider: ScoreProvider,
  calls: number,
  tokens: number,
  lastUsed: string | undefined,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ rawName, provider, calls, tokens, lastUsed: lastUsed ?? null }))
    .digest('hex')
    .slice(0, 32);
  return `provider-migration:${provider}:${digest}`;
}

/**
 * Migrate a legacy provider-usage JSON file into the canonical scoreboard
 * ledger. Returns `{ migrated: false }` on a missing file (no throw),
 * `{ skippedReason }` on corrupt/invalid input, and otherwise records one
 * deterministic `call-complete` event per provider with a positive call count.
 */
export async function migrateProviderUsageJson(
  opts: MigrateProviderUsageOptions,
): Promise<MigrateProviderUsageResult> {
  if (!existsSync(opts.inputPath)) {
    return { migrated: false, providers: [] };
  }

  const raw = await readFile(opts.inputPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      migrated: false,
      providers: [],
      skippedReason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const metrics = normalizeProviderMetrics(parsed);
  if (!metrics) {
    return {
      migrated: false,
      providers: [],
      skippedReason: 'provider usage file did not contain an object',
    };
  }

  // Back up the legacy file before folding anything into the ledger.
  let backupPath: string | undefined;
  try {
    backupPath = await copyBackupOnce(opts.inputPath);
    if (!backupPath) {
      return { migrated: false, providers: [], skippedReason: 'backup did not produce a path' };
    }
  } catch (error) {
    return {
      migrated: false,
      providers: [],
      skippedReason: `backup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const migratedProviders: string[] = [];
  for (const [rawName, entry] of Object.entries(metrics)) {
    if (!entry || typeof entry !== 'object') continue;
    const provider = normalizeProviderName(rawName);
    const calls = finiteNumber(entry.calls);
    if (calls <= 0) continue;
    const tokens = finiteNumber(entry.tokens);
    const lastUsed = typeof entry.last_used === 'string' ? entry.last_used : undefined;
    const ttfb = Number(entry.ttfb_avg_ms);

    await recordProviderCall({
      version: 1,
      eventId: migrationEventId(rawName, provider, calls, tokens, lastUsed),
      ts: lastUsed ?? new Date().toISOString(),
      repoRoot: opts.projectRoot,
      projectKey: opts.projectKey,
      hostCli: PROVIDER_TO_HOST_CLI[provider],
      provider,
      producerKind: 'manual',
      producerId: 'provider-metrics-migration',
      event: 'call-complete',
      countWeight: calls,
      tokensTotal: tokens,
      ttfbMs: Number.isFinite(ttfb) && ttfb >= 0 ? ttfb : undefined,
    });
    migratedProviders.push(rawName);
  }

  // Materialize the summary the caller asked for. `recordProviderCall` already
  // rewrote the canonical `scoreboard/current.json` from the ledger; this final
  // write honors an explicit `outputPath` (which may equal that canonical path).
  const summary = await computeScoreboardSummary(opts.projectRoot);
  await writeJsonFile(opts.outputPath, summary);

  return {
    migrated: migratedProviders.length > 0,
    providers: migratedProviders,
    backupPath,
  };
}
