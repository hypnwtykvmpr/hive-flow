// cli/src/statusline/config.ts
//
// Wave 1 of the statusline rewrite. Defines `StatuslineConfig`, the canonical
// `DEFAULT_STATUSLINE_CONFIG`, a defensive normalizer, and a bounded parser
// for user/project overrides under `.hive-flow/statusline.config.json` or
// `hive-flow.statusline.json`.
//
// Notes:
//   - The default refresh-debounce is 500 ms and is clamped to `[250, 1000]`.
//   - Numeric overrides MUST pass `Number.isFinite` (strict-TS narrowing).
//   - Config files larger than {@link MAX_INIT_BUFFER_BYTES} are rejected; the
//     normalizer returns defaults rather than throwing.
//   - The canonical visual-policy key is `allow16ColorYellowFallback`. There
//     is intentionally no separate `strictNoYellow` toggle; the default is
//     strict no-yellow.

import { lstatSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  MAX_INIT_BUFFER_BYTES,
  RENDER_BUDGET_MS,
  type ActiveAgentDetailMode,
  type OpenRouterBreakdownMode,
  type StatuslineSource,
} from './types.js';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface StatuslineConfig {
  allow16ColorYellowFallback: boolean;
  activeAgentDetail: ActiveAgentDetailMode;
  useRoleIcons: boolean;
  openRouterBreakdown: OpenRouterBreakdownMode;
  adrPaths: string[];
  adrPatterns: string[];
  adrExcludePatterns: string[];
  sourceTtlsMs: Record<StatuslineSource, number>;
  refreshDebounceMs: number;
  /** Renderer deadline in ms; informational here, enforced at the renderer. */
  renderBudgetMs: number;
  /** Max bytes accepted by the bounded config parser. */
  maxConfigBytes: number;
  /** Max bytes accepted by autopilot-state and other bounded JSON readers. */
  maxInitBufferBytes: number;
  /** JSONL ledger size caps. */
  maxJsonlBytes: number;
  maxJsonlLineBytes: number;
  /** Spool caps. */
  maxSpoolBytes: number;
  maxSpoolEntries: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REFRESH_DEBOUNCE_FLOOR_MS = 250;
const REFRESH_DEBOUNCE_CEILING_MS = 1000;
const DEFAULT_REFRESH_DEBOUNCE_MS = 500;

const MAX_JSONL_BYTES_DEFAULT = 10 * 1024 * 1024;
const MAX_JSONL_LINE_BYTES_DEFAULT = 256 * 1024;
const MAX_SPOOL_BYTES_DEFAULT = 256 * 1024;
const MAX_SPOOL_ENTRIES_DEFAULT = 1000;

/**
 * Source-specific TTL defaults. `0` means "no TTL — freshness governed by
 * the recorder/collector itself" (typically event-driven sources).
 */
const DEFAULT_SOURCE_TTLS: Record<StatuslineSource, number> = Object.freeze({
  stdin: 0,
  context: 5 * 60_000,
  git: 2_000,
  swarm: 0,
  scoreboard: 0,
  agents: 0,
  hives: 0,
  hooks: 60_000,
  memory: 0,
  tests: 0,
  mcp: 30_000,
  attention: 0,
  adrs: 60_000,
  sessions: 5_000,
  daemon: 5_000,
}) as Record<StatuslineSource, number>;

/**
 * The canonical default config. Matches the Settled Decisions in
 * `phase3-implementation-design-2026-05-21.md` and the runbook.
 */
export const DEFAULT_STATUSLINE_CONFIG: StatuslineConfig = Object.freeze({
  allow16ColorYellowFallback: false,
  activeAgentDetail: 'off',
  useRoleIcons: false,
  openRouterBreakdown: 'aggregate',
  adrPaths: Object.freeze([
    'v3/implementation/adrs',
    'docs/adrs',
    '.hive-flow/adrs',
  ]) as unknown as string[],
  adrPatterns: Object.freeze([
    'ADR-*.md',
    'adr-*.md',
    '[0-9][0-9][0-9][0-9]-*.md',
  ]) as unknown as string[],
  adrExcludePatterns: Object.freeze([
    '*SUMMARY.md',
    '*summary.md',
    'README.md',
    '*implementation-summary.md',
    'v3-adrs.md',
  ]) as unknown as string[],
  sourceTtlsMs: DEFAULT_SOURCE_TTLS,
  refreshDebounceMs: DEFAULT_REFRESH_DEBOUNCE_MS,
  renderBudgetMs: RENDER_BUDGET_MS,
  maxConfigBytes: MAX_INIT_BUFFER_BYTES,
  maxInitBufferBytes: MAX_INIT_BUFFER_BYTES,
  maxJsonlBytes: MAX_JSONL_BYTES_DEFAULT,
  maxJsonlLineBytes: MAX_JSONL_LINE_BYTES_DEFAULT,
  maxSpoolBytes: MAX_SPOOL_BYTES_DEFAULT,
  maxSpoolEntries: MAX_SPOOL_ENTRIES_DEFAULT,
}) as StatuslineConfig;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/**
 * Resolve a positive integer override. Returns `fallback` whenever the input
 * is not a finite non-negative number; clamps in-range inputs to `[lo, hi]`.
 * Negative numbers and `NaN` map to `fallback` rather than being silently
 * clamped — this prevents tampered configs from minimizing safety caps.
 */
function resolvePositiveIntegerOverride(
  value: unknown,
  fallback: number,
  lo: number,
  hi: number,
): number {
  let n: number;
  if (isFiniteNumber(value)) {
    n = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    n = parsed;
  } else if (value === undefined) {
    return fallback;
  } else {
    return fallback;
  }
  if (!Number.isFinite(n) || n < 0) return fallback;
  return clamp(Math.floor(n), lo, hi);
}

function normalizeStringArray(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') out.push(item);
  }
  return out.length > 0 ? out : [...fallback];
}

function normalizeActiveAgentDetail(value: unknown): ActiveAgentDetailMode {
  return value === 'off' || value === 'on' || value === 'auto' ? value : 'off';
}

function normalizeOpenRouterBreakdown(value: unknown): OpenRouterBreakdownMode {
  return value === 'model' ? 'model' : 'aggregate';
}

function normalizeSourceTtls(
  value: unknown,
): Record<StatuslineSource, number> {
  const out: Record<StatuslineSource, number> = { ...DEFAULT_SOURCE_TTLS };
  if (!isPlainObject(value)) return out;
  for (const key of Object.keys(DEFAULT_SOURCE_TTLS) as StatuslineSource[]) {
    const raw = value[key];
    if (isFiniteNumber(raw) && raw >= 0) {
      out[key] = Math.floor(raw);
    }
  }
  return out;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

export function normalizeStatuslineConfig(
  input?: Partial<StatuslineConfig> | unknown,
): StatuslineConfig {
  const partial = isPlainObject(input) ? (input as Partial<StatuslineConfig>) : {};
  return {
    allow16ColorYellowFallback: partial.allow16ColorYellowFallback === true,
    activeAgentDetail: normalizeActiveAgentDetail(partial.activeAgentDetail),
    useRoleIcons: partial.useRoleIcons === true,
    openRouterBreakdown: normalizeOpenRouterBreakdown(partial.openRouterBreakdown),
    adrPaths: normalizeStringArray(partial.adrPaths, DEFAULT_STATUSLINE_CONFIG.adrPaths),
    adrPatterns: normalizeStringArray(
      partial.adrPatterns,
      DEFAULT_STATUSLINE_CONFIG.adrPatterns,
    ),
    adrExcludePatterns: normalizeStringArray(
      partial.adrExcludePatterns,
      DEFAULT_STATUSLINE_CONFIG.adrExcludePatterns,
    ),
    sourceTtlsMs: normalizeSourceTtls(partial.sourceTtlsMs),
    refreshDebounceMs: resolvePositiveIntegerOverride(
      partial.refreshDebounceMs,
      DEFAULT_STATUSLINE_CONFIG.refreshDebounceMs,
      REFRESH_DEBOUNCE_FLOOR_MS,
      REFRESH_DEBOUNCE_CEILING_MS,
    ),
    renderBudgetMs: resolvePositiveIntegerOverride(
      partial.renderBudgetMs,
      DEFAULT_STATUSLINE_CONFIG.renderBudgetMs,
      50,
      5_000,
    ),
    maxConfigBytes: resolvePositiveIntegerOverride(
      partial.maxConfigBytes,
      DEFAULT_STATUSLINE_CONFIG.maxConfigBytes,
      1024,
      1024 * 1024,
    ),
    maxInitBufferBytes: resolvePositiveIntegerOverride(
      partial.maxInitBufferBytes,
      DEFAULT_STATUSLINE_CONFIG.maxInitBufferBytes,
      1024,
      1024 * 1024,
    ),
    maxJsonlBytes: resolvePositiveIntegerOverride(
      partial.maxJsonlBytes,
      DEFAULT_STATUSLINE_CONFIG.maxJsonlBytes,
      1024,
      1024 * 1024 * 1024,
    ),
    maxJsonlLineBytes: resolvePositiveIntegerOverride(
      partial.maxJsonlLineBytes,
      DEFAULT_STATUSLINE_CONFIG.maxJsonlLineBytes,
      256,
      16 * 1024 * 1024,
    ),
    maxSpoolBytes: resolvePositiveIntegerOverride(
      partial.maxSpoolBytes,
      DEFAULT_STATUSLINE_CONFIG.maxSpoolBytes,
      1024,
      16 * 1024 * 1024,
    ),
    maxSpoolEntries: resolvePositiveIntegerOverride(
      partial.maxSpoolEntries,
      DEFAULT_STATUSLINE_CONFIG.maxSpoolEntries,
      1,
      1_000_000,
    ),
  };
}

// ---------------------------------------------------------------------------
// Bounded file parser
// ---------------------------------------------------------------------------

/**
 * Result of parsing a single candidate config file. Tests pin the `source`
 * shape to assert defaults-on-malformed behavior without inspecting the file
 * system directly.
 */
export interface StatuslineConfigParseResult {
  readonly config: StatuslineConfig;
  readonly source: 'defaults' | 'file';
  readonly path?: string;
  readonly warning?: string;
}

type PathSafety = 'absent' | 'symlinked' | 'oversize' | 'not-regular' | 'safe';

/**
 * Walks the directory chain leading to `target` (relative to `root`) and
 * refuses any path component that resolves to a symlink. Mirrors the
 * autopilot-state collector's safety check.
 *
 * Returns a discriminated tag so the caller can surface oversize files with
 * an explicit warning rather than silently treating them as "absent".
 */
function classifyPath(root: string, target: string, maxBytes: number): PathSafety {
  const resolvedRoot = resolve(root);
  const resolvedFile = resolve(target);
  if (resolvedFile === resolvedRoot) return 'not-regular';
  if (!resolvedFile.startsWith(resolvedRoot + sep) && resolvedFile !== resolvedRoot) {
    return 'not-regular';
  }
  const relative = resolvedFile.slice(resolvedRoot.length + 1);
  const parts = relative.split(sep).filter(Boolean);
  if (parts.length === 0) return 'not-regular';
  let cur = resolvedRoot;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(cur);
    } catch (error: unknown) {
      return errorCode(error) === 'ENOENT' ? 'absent' : 'not-regular';
    }
    if (st.isSymbolicLink()) return 'symlinked';
    if (i === parts.length - 1) {
      let file: ReturnType<typeof statSync>;
      try {
        file = statSync(cur);
      } catch {
        return 'absent';
      }
      if (!file.isFile()) return 'not-regular';
      if (file.size > maxBytes) return 'oversize';
      return 'safe';
    }
    if (!st.isDirectory()) return 'not-regular';
  }
  return 'not-regular';
}

/**
 * Read `filePath` as JSON, returning defaults on any error condition
 * (missing, oversize, symlink, malformed). Never throws to the caller.
 *
 * Note: this is the boot-time config parser. It is the ONLY file read on
 * the statusline boot path that touches user-controlled JSON. The size
 * cap is enforced via lstat before `readFile` so we never load gigantic
 * files into memory.
 */
async function parseConfigFile(
  projectRoot: string,
  filePath: string,
  maxBytes: number,
): Promise<StatuslineConfigParseResult | undefined> {
  const safety = classifyPath(projectRoot, filePath, maxBytes);
  if (safety === 'absent') return undefined;
  if (safety === 'symlinked') {
    return {
      config: normalizeStatuslineConfig(),
      source: 'defaults',
      path: filePath,
      warning: 'Statusline config file is a symlink; refusing to follow.',
    };
  }
  if (safety === 'oversize') {
    return {
      config: normalizeStatuslineConfig(),
      source: 'defaults',
      path: filePath,
      warning: `Statusline config exceeds ${maxBytes} bytes; using defaults.`,
    };
  }
  if (safety === 'not-regular') {
    return {
      config: normalizeStatuslineConfig(),
      source: 'defaults',
      path: filePath,
      warning: 'Statusline config target is not a regular file.',
    };
  }

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return undefined;
    return {
      config: normalizeStatuslineConfig(),
      source: 'defaults',
      path: filePath,
      warning: `Unable to read statusline config: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // Double-check the in-memory byte length matches the on-disk lstat. A
  // file can race in size between lstat and read; defence-in-depth.
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    return {
      config: normalizeStatuslineConfig(),
      source: 'defaults',
      path: filePath,
      warning: `Statusline config exceeds ${maxBytes} bytes; using defaults.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    return {
      config: normalizeStatuslineConfig(),
      source: 'defaults',
      path: filePath,
      warning: `Statusline config JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    config: normalizeStatuslineConfig(parsed),
    source: 'file',
    path: filePath,
  };
}

/**
 * Load the statusline config for `projectRoot`. Checks
 * `.hive-flow/statusline.config.json` first, then `hive-flow.statusline.json`.
 * Returns {@link DEFAULT_STATUSLINE_CONFIG} (normalized) when neither file is
 * present, valid, and safely sized.
 *
 * This function is intended to be called once during the statusline boot
 * path. Downstream modules MUST receive the resolved config as an argument
 * rather than re-reading from disk.
 */
export async function loadStatuslineConfig(projectRoot: string): Promise<StatuslineConfig> {
  const result = await parseStatuslineConfig(projectRoot);
  return result.config;
}

/**
 * Same as {@link loadStatuslineConfig} but also exposes provenance/warning
 * information for tests and the `statusline doctor` subcommand.
 */
export async function parseStatuslineConfig(
  projectRoot: string,
): Promise<StatuslineConfigParseResult> {
  const candidates = [
    join(projectRoot, '.hive-flow', 'statusline.config.json'),
    join(projectRoot, 'hive-flow.statusline.json'),
  ];
  for (const candidate of candidates) {
    const outcome = await parseConfigFile(
      projectRoot,
      candidate,
      DEFAULT_STATUSLINE_CONFIG.maxConfigBytes,
    );
    if (outcome) return outcome;
  }
  return { config: normalizeStatuslineConfig(), source: 'defaults' };
}

// ---------------------------------------------------------------------------
// Env-var helper (strict-TS narrowing)
// ---------------------------------------------------------------------------

/**
 * Read a non-negative integer from an environment variable. Returns
 * `fallback` on missing, non-finite, or negative values. All call sites in
 * the statusline path MUST use this helper rather than calling `Number(...)`
 * directly so the strict-TS narrowing stays uniform.
 */
export function readPositiveIntEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return fallback;
  return Math.floor(n);
}
