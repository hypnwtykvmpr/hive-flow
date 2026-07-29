// cli/src/statusline/claude-meters.ts
//
// hive-flow-f16a — context + quota meters ported from the verified portable
// Windows statusline (`statusline-portable/src/statusline.mjs`).
//
// PURE MODULE. No filesystem, network, credential, child-process, or cache
// access of any kind. Quota values arrive exclusively on the Claude Code stdin
// payload (`rate_limits`); this module only shapes and colors them. Do not add
// a probe, refresher, or quota cache here — stdin is the single source.
//
// Colors flow through the Hive Flow palette object (never literal CSI bodies),
// satisfying the renderer's no-control-bytes constraint.

import type { PaletteCodes } from './types.js';

/** Quota window lengths, in seconds. */
export const WINDOW = { fiveHour: 5 * 3600, week: 7 * 86400 } as const;

/**
 * The first 60 elapsed seconds of a window are an inclusive green fallback:
 * a single early call must not read as "behind pace". Measured exhaustion and
 * an applicable weekly ceiling still outrank it.
 */
export const MIN_SAMPLE_SEC = 60;

/** Severity ordering, used for weekly-ceiling composition and monotonicity. */
export const SEVERITY = { reserve: 0, onpace: 1, deficit: 2, crit: 3 } as const;

export type Disposition = keyof typeof SEVERITY;

/**
 * 13 cells x 8 eighths = 104 steps. This is the SMALLEST width at which every
 * distinct 1% renders differently: the step for percentage p is
 * floor(p * width * 8 / 100), so adjacent percentages collide unless
 * width * 8 / 100 > 1, i.e. width >= 12.5. Narrower silently merges values the
 * API can distinguish; wider is invented precision.
 */
export const METER_WIDTH = 13;

const BAR = '█';
const RAIL = '│';
const DOT = '·';
/** Eighth blocks give sub-cell meter resolution. Single-cell in target terminals. */
const EIGHTHS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const;

/**
 * Draw the bar itself from a 0..1 fraction. Shared by the quota meters and the
 * context meter so there is exactly one implementation of the eighth-block
 * arithmetic and the never-full-unless-100% rule.
 *
 * A completely full bar means exactly 100%: because `frac` is clamped to [0,1],
 * `floor(frac * width)` reaches `width` only when frac is 1, so lower values
 * always leave room for at most one partial eighth-block cell.
 */
export function drawBar(
  frac: number,
  color: string,
  p: PaletteCodes,
  width: number = METER_WIDTH,
): string {
  const safeFrac = Number.isFinite(frac) ? frac : 0;
  const f = Math.max(0, Math.min(1, safeFrac));
  const exact = f * width;
  const whole = Math.floor(exact);
  const eighth = Math.floor((exact - whole) * 8);

  let fill = BAR.repeat(whole);
  let used = whole;
  if (eighth > 0 && whole < width) {
    fill += EIGHTHS[eighth - 1];
    used++;
  }

  // The empty region is plain spaces, not a shade glyph: a dotted texture
  // butting against a solid partial block reads as a seam. Rails mark extent.
  return (
    `${p.dim}${RAIL}${p.reset}` +
    `${color}${fill}${p.reset}` +
    ' '.repeat(Math.max(0, width - used)) +
    `${p.dim}${RAIL}${p.reset}`
  );
}

// ---------------------------------------------------------------------------
// Context meter
// ---------------------------------------------------------------------------

/**
 * Context bands are explicit policy (NOT derived from auto-compact constants).
 * The validated percentage is rounded and clamped to 0..100 before these exact
 * integer boundaries apply:
 *   [0,70) green | [70,85) orange | [85,98) red | [98,100] deep red
 */
export const CTX_BANDS: ReadonlyArray<{ below: number; key: keyof PaletteCodes }> = [
  { below: 70, key: 'safe' },
  { below: 85, key: 'warn' },
  { below: 98, key: 'fail' },
];

export function ctxColor(pct: number, p: PaletteCodes): string {
  const band = CTX_BANDS.find((b) => pct < b.below);
  return band ? p[band.key] : p.critical;
}

/**
 * Render the context meter for an already-merged context reading.
 *
 *   - `undefined` percentage but a present context object -> empty rails. The
 *     context exists, there is simply no measurement yet (Claude Code reports
 *     null token usage before the first API response of a session). Rendering
 *     zero would be a claim; empty rails show the extent without asserting.
 *   - a finite percentage -> rounded and clamped to 0..100, then banded.
 *
 * Absent/malformed context is the CALLER's omit decision (it passes
 * `undefined`), preserving the renderer's omit-on-absence contract.
 */
export function renderContextMeter(
  percentage: number | undefined,
  p: PaletteCodes,
): string {
  if (percentage === undefined || !Number.isFinite(percentage)) {
    return `${p.gray}ctx${p.reset} ${drawBar(0, p.dim, p)}`;
  }
  const pct = Math.max(0, Math.min(100, Math.round(percentage)));
  // Context renders only the bar: fill communicates utilization and color
  // communicates severity. Unlike quota it has no pace or reset clock.
  return `${p.gray}ctx${p.reset} ${drawBar(pct / 100, ctxColor(pct, p), p)}`;
}

// ---------------------------------------------------------------------------
// Pace model
// ---------------------------------------------------------------------------

export interface QuotaWindow {
  /** 0..1 utilization. */
  readonly utilization: number;
  /** Epoch seconds at which the window resets. */
  readonly reset: number;
  readonly status?: string | null;
}

export interface PaceAnalysis {
  readonly actual: number;
  readonly displayed: number | null;
  readonly remaining: number;
  readonly elapsed: number;
  readonly avgRunoutSec: number;
  readonly runsOutBeforeReset: boolean;
  readonly blocked: boolean;
  readonly disposition: Disposition;
  readonly fresh: boolean;
  readonly capped: boolean;
  readonly effectiveRunoutSec: number;
  readonly exhausted: boolean;
  readonly untrusted?: boolean;
}

export interface CeilingOpts {
  readonly ceilingRunoutSec?: number;
  readonly ceilingSeverity?: Disposition;
}

/**
 * Normalized pace model. With e = elapsed/window and a = utilization:
 *   ahead  = (e-a)/(1-a)
 *   behind = (a-e)/(a*(1-e))
 * The unsigned truncated percentage is both displayed and classified:
 * ahead 0-4 onpace / 5+ reserve; behind 0 onpace / 1-49 deficit / 50+ crit.
 * Stateless — recomputed from the current payload on every render.
 */
export function analyze(
  win: QuotaWindow | null | undefined,
  windowSeconds: number,
  nowSec: number,
  opts: CeilingOpts = {},
): PaceAnalysis | null {
  if (!win || !Number.isFinite(windowSeconds) || windowSeconds <= 0) return null;
  if (!Number.isFinite(win.utilization) || win.utilization < 0) return null;
  if (!Number.isFinite(win.reset) || win.reset <= 0) return null;

  const actual = Math.min(1, win.utilization);
  const blocked = win.status != null && win.status !== 'allowed';

  // An expired non-exhausted reading is unusable. Measured zero headroom is a
  // fact independent of reset arithmetic and therefore remains critical.
  if (nowSec >= win.reset) {
    if (actual < 1) return null;
    return {
      actual: 1,
      displayed: null,
      remaining: 0,
      elapsed: windowSeconds,
      avgRunoutSec: 0,
      runsOutBeforeReset: true,
      blocked,
      disposition: 'crit',
      fresh: false,
      capped: false,
      effectiveRunoutSec: 0,
      exhausted: true,
      untrusted: true,
    };
  }

  const remaining = Math.min(windowSeconds, Math.max(0, win.reset - nowSec));
  const elapsed = Math.max(0, windowSeconds - remaining);
  const expected = elapsed / windowSeconds;
  const fresh = elapsed <= MIN_SAMPLE_SEC;
  const avgRunoutSec = actual > 0 ? (elapsed * (1 - actual)) / actual : Infinity;
  const runsOutBeforeReset = actual >= 1 || actual > expected;

  let displayed: number | null = null;
  let disposition: Disposition;

  if (actual >= 1) {
    disposition = 'crit';
  } else if (fresh) {
    disposition = 'onpace';
  } else if (actual <= expected) {
    displayed = Math.trunc((100 * (expected - actual)) / (1 - actual));
    disposition = displayed >= 5 ? 'reserve' : 'onpace';
  } else {
    displayed = Math.trunc((100 * (actual - expected)) / (actual * (1 - expected)));
    disposition = displayed === 0 ? 'onpace' : displayed < 50 ? 'deficit' : 'crit';
  }

  // The weekly window is analyzed independently; only its availability and
  // severity feed the five-hour analysis. At or below five hours that ceiling
  // may WORSEN, never improve, the five-hour reading — and it outranks the
  // opening freshness fallback.
  const ceilingAvailability = opts.ceilingRunoutSec;
  const ceilingBinds =
    typeof ceilingAvailability === 'number' &&
    Number.isFinite(ceilingAvailability) &&
    ceilingAvailability <= windowSeconds;
  let capped = false;
  const ceilingSeverity = opts.ceilingSeverity;
  if (
    ceilingBinds &&
    ceilingSeverity !== undefined &&
    SEVERITY[ceilingSeverity] > SEVERITY[disposition]
  ) {
    disposition = ceilingSeverity;
    capped = true;
  }

  const ownProjection = runsOutBeforeReset ? avgRunoutSec : Infinity;
  const effectiveRunoutSec = Math.min(
    ownProjection,
    ceilingBinds && typeof ceilingAvailability === 'number' ? ceilingAvailability : Infinity,
  );

  return {
    actual,
    displayed,
    remaining,
    elapsed,
    avgRunoutSec,
    runsOutBeforeReset,
    blocked,
    disposition,
    fresh,
    capped,
    effectiveRunoutSec,
    exhausted: actual >= 1,
  };
}

/**
 * Convert Claude Code's stdin `rate_limits` block into the shape `analyze`
 * expects. The payload reports `used_percentage` on a 0-100 scale; the pace
 * model works in 0..1. Performs no external I/O.
 */
export function fromPayload(rateLimits: unknown): {
  fiveHour: QuotaWindow | null;
  week: QuotaWindow | null;
} {
  const win = (raw: unknown): QuotaWindow | null => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    const pct = rec.used_percentage;
    const reset = rec.resets_at;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0) return null;
    if (typeof reset !== 'number' || !Number.isFinite(reset) || reset <= 0) return null;
    return {
      utilization: Math.min(1, pct / 100),
      reset,
      // The stdin payload exposes no confirmed block cause. A block remains an
      // orthogonal marker rather than quota color.
      status: 'allowed',
    };
  };
  if (!rateLimits || typeof rateLimits !== 'object' || Array.isArray(rateLimits)) {
    return { fiveHour: null, week: null };
  }
  const rec = rateLimits as Record<string, unknown>;
  return { fiveHour: win(rec.five_hour), week: win(rec.seven_day) };
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return 'now';
  const m = Math.floor(sec / 60);
  // Sub-minute must not floor to "0m": a projected runout of 55 seconds shown
  // as "out 0m" reads like a rounding artefact rather than an emergency.
  if (m < 1) return '<1m';
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${mm}m`;
  return `${mm}m`;
}

function dispositionColor(d: Disposition, p: PaletteCodes): string {
  if (d === 'reserve') return p.memory; // teal — burning slower than the clock
  if (d === 'onpace') return p.safe;
  if (d === 'deficit') return p.warn;
  return p.critical;
}

/**
 * The bar already conveys how much quota is spent, so repeating that number
 * beside it wastes space. The number instead reports HOW FAR FROM PACE you are,
 * in percentage points of the window — the one quantity the bar cannot show.
 * Sign is carried by color, so the value prints as an absolute number.
 */
function meter(a: PaceAnalysis, color: string, p: PaletteCodes): string {
  const bar = drawBar(a.actual, color, p);
  if (a.actual >= 1) return `${bar}     `;
  if (a.displayed == null) return `${bar} ${p.dim}  --${p.reset}`;
  return `${bar} ${color}${String(a.displayed).padStart(3)}%${p.reset}`;
}

/**
 * Render the usage row from the stdin-derived windows. Returns `undefined`
 * only when the caller should omit the row entirely; a present-but-empty
 * `rate_limits` still renders the honest "no usage data" form.
 */
export function renderUsageLine(
  windows: { fiveHour: QuotaWindow | null; week: QuotaWindow | null },
  p: PaletteCodes,
  nowSecOverride?: number,
): string {
  const gap = `${p.separator}   ${DOT}   ${p.reset}`;
  const { fiveHour, week } = windows;

  if (!fiveHour && !week) {
    return `${p.gray}5h${p.reset} ${p.dim}no usage data${p.reset}`;
  }

  // Align sub-second precision to the payload reset's phase so back-to-back
  // renders differing only by a millisecond cannot cross a displayed-percent
  // boundary. Retains no state between renders.
  const wallSec = nowSecOverride ?? Date.now() / 1000;
  const anchorReset = [fiveHour?.reset, week?.reset].find(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  let nowSec = wallSec;
  if (anchorReset !== undefined) {
    const phase = anchorReset - Math.floor(anchorReset);
    const aligned = Math.floor(wallSec) + phase;
    nowSec = aligned > wallSec ? aligned - 1 : aligned;
  }

  const blockMark = (raw: QuotaWindow | null): string =>
    raw && raw.status != null && raw.status !== 'allowed'
      ? `${p.critical} ${DOT} blocked${p.reset}`
      : '';

  // Snap sub-second presentation jitter so adding a block or context segment
  // cannot change otherwise identical quota text.
  const displayDuration = (seconds: number): string => {
    const minute = Math.round(seconds / 60) * 60;
    const stable = Math.abs(seconds - minute) < 0.25 ? minute : seconds;
    return fmtDuration(stable);
  };

  const projectedExhaustion = (a: PaceAnalysis | null): number => {
    if (!a) return Infinity;
    if (a.actual >= 1) return 0;
    if (a.fresh || !a.runsOutBeforeReset) return Infinity;
    return Number.isFinite(a.avgRunoutSec) ? a.avgRunoutSec : Infinity;
  };

  // Week is always independent. Its literal reset and valid projected
  // exhaustion jointly define how long the five-hour window is usable.
  const weekAnalysis = analyze(week, WINDOW.week, nowSec);
  const weekProjection = projectedExhaustion(weekAnalysis);
  const weekAvailable = weekAnalysis
    ? Math.min(weekAnalysis.remaining, weekProjection)
    : Infinity;

  const ceiling: CeilingOpts = weekAnalysis
    ? { ceilingRunoutSec: weekAvailable, ceilingSeverity: weekAnalysis.disposition }
    : {};
  const fiveAnalysis = analyze(fiveHour, WINDOW.fiveHour, nowSec, ceiling);

  const segment = (
    label: string,
    a: PaceAnalysis | null,
    headline: number,
    projection: number,
    raw: QuotaWindow | null,
  ): string => {
    if (!a) return `${p.gray}${label}${p.reset} ${p.dim}n/a${p.reset}${blockMark(raw)}`;
    const color = dispositionColor(a.disposition, p);
    let out = `${p.gray}${label}${p.reset} ${meter(a, color, p)}`;
    const available = Math.max(0, headline);
    const shortened = available < a.remaining;
    out += `${shortened ? color : p.dim} ${DOT} ${displayDuration(available).padStart(6)}${p.reset}`;
    out += blockMark(raw);
    // A projection is useful only when it precedes the composed headline.
    // Comparing formatted values also suppresses duplicates at a rounding
    // boundary (for example "5m · out 5m").
    if (
      Number.isFinite(projection) &&
      projection < available &&
      displayDuration(projection) !== displayDuration(available)
    ) {
      out += `${color} ${DOT} out ${displayDuration(projection)}${p.reset}`;
    }
    return out;
  };

  const fiveHeadline = fiveAnalysis ? Math.min(fiveAnalysis.remaining, weekAvailable) : Infinity;
  const fiveProjection = Math.min(projectedExhaustion(fiveAnalysis), weekProjection);

  return [
    segment('5h', fiveAnalysis, fiveHeadline, fiveProjection, fiveHour),
    // The weekly headline stays its literal reset; its own projection is a
    // separate earlier warning when it adds information.
    segment('week', weekAnalysis, weekAnalysis?.remaining ?? Infinity, weekProjection, week),
  ].join(gap);
}
