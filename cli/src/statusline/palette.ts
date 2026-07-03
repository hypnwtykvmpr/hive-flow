// cli/src/statusline/palette.ts
//
// Wave 8 of the statusline rewrite. Implements the locked 256-color palette
// (and a strict 16-color fallback) for the Claude Code statusline renderer
// and all bounded inline-collector code paths.
//
// Design contract (see merged runbook 2026-05-20, locked visual design):
//   - 256-color palette is canonical. Byte-exact codes per the locked design:
//       project anchor   1;38;5;253   (bold light gray)
//       branch           1;34         (bright blue)
//       repo / warning   38;5;208     (orange — single warning owner)
//       DeepSeek         38;5;39      (DeepSeek blue)
//       OpenRouter       38;5;213     (orchid)
//   - 16-color fallback warning slot is **non-bright** red by default,
//     non-bright yellow only when `allow16ColorYellowFallback` is true.
//     Bright yellow (the FORBIDDEN_ANSI_BRIGHT_YELLOW sequence exported by
//     `./types.js`) is **structurally forbidden** in any combination of
//     opts — defence-in-depth via a runtime audit guard that fires before
//     any palette object is returned.
//   - No-color mode: every slot is the empty string. Tests cartesian-audit
//     every combination of (noColor, colorDepth, allow16ColorYellowFallback)
//     to prove no path can ever emit that forbidden sequence.
//   - `detectColorDepth(env)` is pure (parameter-only; never reads
//     `process.env` directly).
//
// This module owns the visual palette only. Renderer logic lives in
// `renderer/claude-code.ts`; bounded inline-collector fallbacks live in
// `renderer/inline-collectors.ts`. Both consume `PaletteCodes` from
// `./types.js`.

import {
  FORBIDDEN_ANSI_BRIGHT_YELLOW,
  type ColorDepth,
  type PaletteCodes,
} from './types.js';

// ---------------------------------------------------------------------------
// Re-exports — downstream modules import the palette public types directly
// from `./palette.js` per the runbook (Phase 7). The canonical definitions
// live in `./types.js` so wave 1 and wave 8 share a single source of truth.
// ---------------------------------------------------------------------------

export type { ColorDepth, PaletteCodes } from './types.js';
export { FORBIDDEN_ANSI_BRIGHT_YELLOW } from './types.js';

/** Alias kept for renderer code that imports `Palette` (Phase 7 example). */
export type Palette = PaletteCodes;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a CSI escape sequence from a numeric/semicolon parameter string. */
const esc = (code: string): string => `\x1b[${code}m`;

/**
 * Empty-codes table for `noColor: true` and `colorDepth: 0` (NO_COLOR / dumb
 * terminals). Frozen so accidental mutation in a downstream module surfaces
 * as a TypeError rather than silent corruption.
 */
const EMPTY_PALETTE: PaletteCodes = Object.freeze({
  reset: '',
  dim: '',
  project: '',
  branch: '',
  model: '',
  safe: '',
  warn: '',
  fail: '',
  critical: '',
  active: '',
  queen: '',
  queenIdle: '',
  memory: '',
  embeddings: '',
  claude: '',
  codex: '',
  gemini: '',
  forge: '',
  cursor: '',
  deepseek: '',
  openrouter: '',
  qwen: '',
  opencode: '',
  gray: '',
  number: '',
  separator: '',
}) as PaletteCodes;

// ---------------------------------------------------------------------------
// Color-depth detection (pure — env is a parameter)
// ---------------------------------------------------------------------------

/**
 * Decide a {@link ColorDepth} from the supplied environment record.
 *
 * Precedence (matches Node ecosystem and the runbook):
 *   1. `NO_COLOR` (any non-empty value) -> `0`
 *   2. `TERM === 'dumb'` -> `0`
 *   3. `FORCE_COLOR === '0'` -> `0`
 *   4. `FORCE_COLOR === '3'` -> `256`
 *   5. `COLORTERM === 'truecolor' | '24bit'` -> `256`
 *      (the statusline palette never emits 24-bit codes — truecolor signals
 *      are mapped to the 256-color table because that is the canonical
 *      palette in the locked visual design)
 *   6. `/256color/i.test(TERM)` -> `256`
 *   7. otherwise -> `16`
 *
 * This function is intentionally pure: callers in tests pass a synthetic
 * record, and the renderer passes `process.env` exactly once at boot. The
 * function never reads `process.env` itself.
 */
export function detectColorDepth(env: NodeJS.ProcessEnv): ColorDepth {
  // 1. NO_COLOR is a hard override — any non-empty value disables color.
  //    the NO_COLOR convention
  const noColor = env.NO_COLOR;
  if (typeof noColor === 'string' && noColor !== '') return 0;

  // 2. `dumb` terminals never support color.
  if (env.TERM === 'dumb') return 0;

  // 3. FORCE_COLOR=0 explicitly disables color even when a TTY is attached.
  const forceColor = env.FORCE_COLOR;
  if (forceColor === '0') return 0;

  // 4. FORCE_COLOR=3 requests 24-bit; we fold that into the canonical 256
  //    palette per design — the statusline never emits truecolor codes.
  if (forceColor === '3') return 256;

  // 5. COLORTERM=truecolor / 24bit signals 24-bit support. Same fold to 256.
  const colorTerm = (env.COLORTERM ?? '').toLowerCase();
  if (colorTerm === 'truecolor' || colorTerm === '24bit') return 256;

  // 6. TERM contains "256color" — modern xterm-256color, screen-256color, …
  const term = env.TERM ?? '';
  if (/256color/i.test(term)) return 256;

  // 7. Fall back to the 16-color table. The default is `16` (not `0`) so a
  //    bare `bash` invocation without `NO_COLOR` still receives styling.
  return 16;
}

// ---------------------------------------------------------------------------
// 256-color palette (canonical — locked visual design)
// ---------------------------------------------------------------------------
//
// Codes are inlined as string literals so a static audit (e.g. ripgrep for
// the forbidden bright-yellow CSI body) against this source file returns
// zero hits.

function build256ColorPalette(): PaletteCodes {
  return {
    reset: esc('0'),
    dim: esc('2'),
    // Project anchor: bold light gray  (`▊ <project>`)
    project: esc('1;38;5;253'),
    // Git branch: bright blue (single owner)
    branch: esc('1;34'),
    // Model name: magenta
    model: esc('0;35'),
    // Tri-state semantics
    safe: esc('1;32'),
    // Warning carrier: orange (38;5;208) — single owner for all warning slots
    warn: esc('38;5;208'),
    // Failure / unavailable: non-bright red
    fail: esc('0;31'),
    // Critical / >85% context / daemon stopped: bright red
    critical: esc('1;31'),
    // Active / busy / executing
    active: esc('1;32'),
    // Queen (executing or delegating): bright cyan
    queen: esc('1;36'),
    // Idle queens: violet (Codex's pick in the locked design)
    queenIdle: esc('38;5;141'),
    // Memory label: teal
    memory: esc('38;5;80'),
    // Embeddings count: violet
    embeddings: esc('38;5;141'),
    // Provider scoreboard tints
    claude: esc('1;35'),
    codex: esc('0;36'),
    gemini: esc('38;5;141'),
    forge: esc('38;5;80'),
    cursor: esc('38;5;111'),
    deepseek: esc('38;5;39'),
    openrouter: esc('38;5;213'),
    qwen: esc('38;5;117'),
    opencode: esc('38;5;244'),
    // Chrome
    gray: esc('0;90'),
    number: esc('1;37'),
    separator: esc('38;5;240'),
  };
}

// ---------------------------------------------------------------------------
// 16-color fallback palette
// ---------------------------------------------------------------------------
//
// Warning slot default: NON-BRIGHT red (`\x1b[31m`). Opt-in via
// `allow16ColorYellowFallback: true` swaps it to NON-BRIGHT yellow
// (`\x1b[33m`). The bright-yellow CSI body is structurally forbidden in
// every branch — the guard below verifies this defensively at runtime by
// comparing against the FORBIDDEN_ANSI_BRIGHT_YELLOW constant.

function build16ColorPalette(allow16ColorYellowFallback: boolean): PaletteCodes {
  // Warning carrier in the 16-color table. Task spec overrides the runbook:
  //   default              -> `\x1b[31m`  (NOT `\x1b[0;31m`)
  //   allow flag = true    -> `\x1b[33m`  (NOT `\x1b[0;33m`; NEVER the
  //   bright-yellow CSI body referenced via FORBIDDEN_ANSI_BRIGHT_YELLOW)
  const warnCode = allow16ColorYellowFallback ? esc('33') : esc('31');

  return {
    reset: esc('0'),
    dim: esc('2'),
    // 16-color projects can't address 256; approximate the bold-light-gray
    // anchor with bold white.
    project: esc('1;37'),
    branch: esc('1;34'),
    model: esc('0;35'),
    safe: esc('1;32'),
    warn: warnCode,
    fail: esc('0;31'),
    critical: esc('1;31'),
    active: esc('1;32'),
    queen: esc('1;36'),
    // 16-color: idle queen approximated as magenta (closest to violet 141)
    queenIdle: esc('0;35'),
    memory: esc('0;36'),
    embeddings: esc('0;35'),
    claude: esc('1;35'),
    codex: esc('0;36'),
    gemini: esc('0;35'),
    forge: esc('0;36'),
    cursor: esc('1;34'),
    deepseek: esc('0;34'),
    openrouter: esc('1;35'),
    qwen: esc('0;36'),
    opencode: esc('0;90'),
    gray: esc('0;90'),
    number: esc('1;37'),
    separator: esc('0;90'),
  };
}

// ---------------------------------------------------------------------------
// Forbidden-yellow runtime guard
// ---------------------------------------------------------------------------
//
// Defence-in-depth: we already construct the palette without the forbidden
// bright-yellow CSI body, but a future edit (or a subtle refactor) could
// regress. Every code path through `makePalette` runs the audit below
// before returning, so a regression throws at first call rather than
// silently emitting bright yellow.

/**
 * Throw if any palette slot contains the forbidden bright-yellow sequence.
 *
 * The constant {@link FORBIDDEN_ANSI_BRIGHT_YELLOW} is exported from
 * `./types.js` and is the single canonical reference for the byte sequence
 * `ESC [ 1 ; 3 3 m`. This audit closes the loop: if the constant ever
 * appears in a generated palette object, we fail loudly.
 */
function assertNoForbiddenYellow(p: PaletteCodes, context: string): void {
  for (const key of Object.keys(p) as Array<keyof PaletteCodes>) {
    const value = p[key];
    if (typeof value !== 'string') {
      // PaletteCodes is `Record<string, string>` so this branch is unreachable
      // under strict typing; we still check defensively because the renderer
      // could receive a manually-built palette from a downstream test.
      throw new TypeError(
        `palette slot "${String(key)}" must be a string (${context})`,
      );
    }
    if (value.includes(FORBIDDEN_ANSI_BRIGHT_YELLOW)) {
      throw new Error(
        `palette slot "${String(key)}" contains forbidden ANSI bright yellow (FORBIDDEN_ANSI_BRIGHT_YELLOW); ${context}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Module-load guard
// ---------------------------------------------------------------------------
//
// Audit the canonical 256-color and 16-color tables (both fallback variants)
// at module load. If a future edit accidentally introduces the forbidden
// bright-yellow CSI body anywhere, import of this module throws immediately
// — every consumer (renderer, tests, CLI) surfaces the regression before
// producing any user-visible output.

(function moduleLoadAudit(): void {
  assertNoForbiddenYellow(build256ColorPalette(), 'module-load audit: 256-color');
  assertNoForbiddenYellow(
    build16ColorPalette(false),
    'module-load audit: 16-color (allow16ColorYellowFallback=false)',
  );
  assertNoForbiddenYellow(
    build16ColorPalette(true),
    'module-load audit: 16-color (allow16ColorYellowFallback=true)',
  );
  assertNoForbiddenYellow(EMPTY_PALETTE, 'module-load audit: empty/no-color');
})();

// ---------------------------------------------------------------------------
// Public API: makePalette
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link makePalette}.
 *
 * The function is pure: every input flows through `opts` and never reads
 * `process.env`, `process.stdout`, or any global state. Callers either
 * pre-detect the color depth via {@link detectColorDepth} or pass an explicit
 * value (typical in tests).
 */
export interface MakePaletteOptions {
  /**
   * When `true`, every slot is the empty string regardless of `colorDepth`.
   * Used by the `--no-color` CLI flag and the plain-text inspect path.
   */
  noColor?: boolean;
  /**
   * Optional explicit color depth. When omitted, defaults to `256` — the
   * canonical palette. Tests always pass this explicitly; the renderer is
   * expected to call {@link detectColorDepth} once with `process.env` and
   * thread the result through here.
   */
  colorDepth?: ColorDepth;
  /**
   * Opt-in only for terminals known to render non-bright yellow as visible
   * but not "alarming" (matches the locked accessibility note). Even when
   * set to `true`, the result is `\x1b[33m` — **never** the bright-yellow
   * CSI body exported as `FORBIDDEN_ANSI_BRIGHT_YELLOW`.
   */
  allow16ColorYellowFallback?: boolean;
}

/**
 * Build a {@link PaletteCodes} table for the requested depth/options.
 *
 * Pure function. No side effects, no env reads, no I/O. Every output slot
 * is either the empty string (no-color) or a CSI escape sequence keyed by
 * the locked visual design.
 *
 * The returned object is intentionally a fresh instance per call so callers
 * may freeze it locally. The internal canonical tables are not exposed.
 */
export function makePalette(opts: MakePaletteOptions = {}): PaletteCodes {
  // No-color short-circuit. Returns a defensive copy of the frozen empty
  // table so downstream code can freeze/extend the result without mutating
  // module state.
  if (opts.noColor === true || opts.colorDepth === 0) {
    const palette: PaletteCodes = { ...EMPTY_PALETTE };
    assertNoForbiddenYellow(palette, 'makePalette: no-color path');
    return palette;
  }

  // 16-color fallback path.
  if (opts.colorDepth === 16) {
    const palette = build16ColorPalette(opts.allow16ColorYellowFallback === true);
    assertNoForbiddenYellow(palette, 'makePalette: 16-color path');
    return palette;
  }

  // Default and explicit-256 path. `colorDepth: undefined` defaults to the
  // canonical 256-color palette; this matches the runbook expectation that
  // callers either pre-detect via `detectColorDepth(env)` or accept the
  // canonical default in tests.
  const palette = build256ColorPalette();
  assertNoForbiddenYellow(palette, 'makePalette: 256-color path');
  return palette;
}
