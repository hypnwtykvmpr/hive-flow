// hive-flow-f16a — context/usage meter regressions (acceptance rows A4-A11).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyze,
  CTX_BANDS,
  ctxColor,
  drawBar,
  fmtDuration,
  fromPayload,
  METER_WIDTH,
  renderContextMeter,
  renderUsageLine,
  WINDOW,
} from '../claude-meters.js';
import { makePalette } from '../palette.js';

const p = makePalette({ colorDepth: 256 });
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
/** Count of occupied cells (full blocks + any partial eighth). */
const filled = (bar: string): number =>
  [...plain(bar)].filter((ch) => ch === '█' || '▏▎▍▌▋▊▉'.includes(ch)).length;
/** Count of SOLID cells only. A bar is "completely full" when every cell is solid. */
const fullBlocks = (bar: string): number => [...plain(bar)].filter((ch) => ch === '█').length;

describe('drawBar (A4)', () => {
  it('is 13 cells wide between rails at every fill level', () => {
    for (const frac of [0, 0.01, 0.25, 0.5, 0.999, 1]) {
      const inner = plain(drawBar(frac, p.safe, p)).replace(/^│|│$/g, '');
      expect(inner).toHaveLength(METER_WIDTH);
    }
  });

  it('is completely full ONLY at exactly 100%', () => {
    // The never-full-unless-100% rule: at 99.9% the last cell is a PARTIAL
    // eighth, so the bar is occupied end-to-end but not solid — only an exact
    // 100% may render every cell as a full block.
    expect(fullBlocks(drawBar(1, p.safe, p))).toBe(METER_WIDTH);
    expect(fullBlocks(drawBar(0.999, p.safe, p))).toBeLessThan(METER_WIDTH);
    expect(plain(drawBar(0.999, p.safe, p))).toContain('▉');
    expect(plain(drawBar(1, p.safe, p))).toBe(`│${'█'.repeat(METER_WIDTH)}│`);
  });

  it('renders a partial eighth block rather than rounding away small values', () => {
    // 1% of 13 cells = 0.13 cells -> one partial eighth, never empty.
    expect(filled(drawBar(0.01, p.safe, p))).toBe(1);
    expect(plain(drawBar(0.01, p.safe, p))).toContain('▏');
  });

  it('clamps out-of-range and non-finite fractions', () => {
    expect(filled(drawBar(-5, p.safe, p))).toBe(0);
    expect(filled(drawBar(42, p.safe, p))).toBe(METER_WIDTH);
    expect(filled(drawBar(Number.NaN, p.safe, p))).toBe(0);
  });

  it('gives every whole percent a distinct rendering (13 cells x 8 eighths)', () => {
    const seen = new Set<string>();
    for (let pct = 0; pct <= 100; pct++) seen.add(plain(drawBar(pct / 100, p.safe, p)));
    expect(seen.size).toBe(101);
  });
});

describe('context bands (A5, A6)', () => {
  it('uses the exact policy boundaries', () => {
    expect(CTX_BANDS.map((b) => b.below)).toEqual([70, 85, 98]);
    expect(ctxColor(0, p)).toBe(p.safe);
    expect(ctxColor(69, p)).toBe(p.safe);
    expect(ctxColor(70, p)).toBe(p.warn);
    expect(ctxColor(84, p)).toBe(p.warn);
    expect(ctxColor(85, p)).toBe(p.fail);
    expect(ctxColor(97, p)).toBe(p.fail);
    expect(ctxColor(98, p)).toBe(p.critical);
    expect(ctxColor(100, p)).toBe(p.critical);
  });

  it('rounds and clamps the reported percentage (A6)', () => {
    // 69.6 rounds to 70 and therefore crosses into the orange band.
    expect(renderContextMeter(69.6, p)).toContain(p.warn);
    expect(renderContextMeter(69.4, p)).toContain(p.safe);
    // Out-of-range input cannot escape the 0..100 clamp.
    expect(filled(renderContextMeter(-10, p))).toBe(0);
    expect(filled(renderContextMeter(250, p))).toBe(METER_WIDTH);
  });
});

describe('context absence (A7)', () => {
  it('renders EMPTY RAILS for present-but-unmeasured context, never zero-as-fact', () => {
    const rendered = renderContextMeter(undefined, p);
    expect(filled(rendered)).toBe(0);
    expect(plain(rendered)).toContain('│');
    // Dim rails signal "no reading yet" rather than asserting 0% utilization.
    expect(rendered).toContain(p.dim);
  });

  it('treats non-finite percentages as unmeasured rather than 0%', () => {
    expect(filled(renderContextMeter(Number.NaN, p))).toBe(0);
  });
});

describe('pace model (A9)', () => {
  const now = 1_000_000;
  const win = (pct: number, resetIn: number) => ({
    utilization: pct / 100,
    reset: now + resetIn,
    status: 'allowed',
  });

  it('classifies burning slower than the clock as reserve', () => {
    // Half the window elapsed, only 10% used -> well ahead.
    const a = analyze(win(10, WINDOW.fiveHour / 2), WINDOW.fiveHour, now);
    expect(a?.disposition).toBe('reserve');
    expect(a?.displayed).toBeGreaterThanOrEqual(5);
  });

  it('classifies burning faster than the clock as deficit or crit', () => {
    const a = analyze(win(60, WINDOW.fiveHour / 2), WINDOW.fiveHour, now);
    expect(['deficit', 'crit']).toContain(a?.disposition);
    expect(a?.runsOutBeforeReset).toBe(true);
  });

  it('treats the opening sample as on-pace rather than wildly behind', () => {
    const a = analyze(win(1, WINDOW.fiveHour - 5), WINDOW.fiveHour, now);
    expect(a?.fresh).toBe(true);
    expect(a?.disposition).toBe('onpace');
  });

  it('reports measured exhaustion as crit', () => {
    const a = analyze(win(100, WINDOW.fiveHour / 2), WINDOW.fiveHour, now);
    expect(a?.disposition).toBe('crit');
    expect(a?.exhausted).toBe(true);
  });

  it('rejects an expired non-exhausted reading as unusable', () => {
    expect(analyze(win(50, -1), WINDOW.fiveHour, now)).toBeNull();
  });

  it('keeps expired-but-exhausted as crit (measured zero headroom is a fact)', () => {
    const a = analyze(win(100, -1), WINDOW.fiveHour, now);
    expect(a?.disposition).toBe('crit');
    expect(a?.untrusted).toBe(true);
  });

  it('lets a binding weekly ceiling WORSEN but never improve the hourly reading', () => {
    const base = analyze(win(1, WINDOW.fiveHour / 2), WINDOW.fiveHour, now);
    expect(base?.disposition).toBe('reserve');
    const capped = analyze(win(1, WINDOW.fiveHour / 2), WINDOW.fiveHour, now, {
      ceilingRunoutSec: 60,
      ceilingSeverity: 'crit',
    });
    expect(capped?.disposition).toBe('crit');
    expect(capped?.capped).toBe(true);
    // A gentler ceiling must not upgrade a worse local disposition.
    const notImproved = analyze(win(100, WINDOW.fiveHour / 2), WINDOW.fiveHour, now, {
      ceilingRunoutSec: 60,
      ceilingSeverity: 'onpace',
    });
    expect(notImproved?.disposition).toBe('crit');
  });

  it('rejects malformed windows', () => {
    expect(analyze(null, WINDOW.fiveHour, now)).toBeNull();
    expect(analyze({ utilization: Number.NaN, reset: now + 10 }, WINDOW.fiveHour, now)).toBeNull();
    expect(analyze({ utilization: 0.5, reset: 0 }, WINDOW.fiveHour, now)).toBeNull();
  });
});

describe('fromPayload (A8)', () => {
  it('reads five_hour and seven_day only, converting 0-100 to 0..1', () => {
    const w = fromPayload({
      five_hour: { used_percentage: 50, resets_at: 123 },
      seven_day: { used_percentage: 10, resets_at: 456 },
      // An unrelated window must be ignored entirely.
      one_hour: { used_percentage: 99, resets_at: 789 },
    });
    expect(w.fiveHour?.utilization).toBeCloseTo(0.5);
    expect(w.week?.utilization).toBeCloseTo(0.1);
  });

  it('rejects malformed or missing windows without throwing', () => {
    expect(fromPayload(undefined)).toEqual({ fiveHour: null, week: null });
    expect(fromPayload({ five_hour: { used_percentage: -1, resets_at: 1 } }).fiveHour).toBeNull();
    expect(fromPayload({ five_hour: { used_percentage: 5 } }).fiveHour).toBeNull();
    expect(fromPayload({ five_hour: 'nope' }).fiveHour).toBeNull();
  });
});

describe('usage line (A8, A10)', () => {
  it('NEVER omits: absent usage data renders the truthful fallback', () => {
    const line = renderUsageLine(fromPayload(undefined), p);
    expect(plain(line)).toContain('5h');
    expect(plain(line)).toContain('no usage data');
  });

  it('labels the hourly window 5h and includes the weekly window', () => {
    const now = 2_000_000;
    const line = renderUsageLine(
      fromPayload({
        five_hour: { used_percentage: 20, resets_at: now + 3600 },
        seven_day: { used_percentage: 30, resets_at: now + 86_400 },
      }),
      p,
      now,
    );
    expect(plain(line)).toContain('5h');
    expect(plain(line)).toContain('week');
  });

  it('renders n/a for a window that is present but unusable', () => {
    const now = 2_000_000;
    const line = renderUsageLine(
      { fiveHour: null, week: { utilization: 0.2, reset: now + 86_400, status: 'allowed' } },
      p,
      now,
    );
    expect(plain(line)).toContain('5h n/a');
  });
});

describe('fmtDuration', () => {
  it('never floors a sub-minute value to a misleading 0m', () => {
    expect(fmtDuration(55)).toBe('<1m');
    expect(fmtDuration(0)).toBe('now');
    expect(fmtDuration(-5)).toBe('now');
    expect(fmtDuration(Number.NaN)).toBe('now');
  });

  it('formats minutes, hours, and days', () => {
    expect(fmtDuration(120)).toBe('2m');
    expect(fmtDuration(3600 + 120)).toBe('1h2m');
    expect(fmtDuration(2 * 86_400 + 3 * 3600)).toBe('2d3h');
  });
});

describe('usage purity (A11)', () => {
  it('has no runtime imports at all — no network, credential, probe, or cache path', () => {
    const source = readFileSync(join(__dirname, '..', 'claude-meters.ts'), 'utf8');
    // The only permitted import is type-only (erased at compile time).
    const imports = source.match(/^import .*$/gm) ?? [];
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatch(/^import type /);
    expect(source).not.toMatch(/require\(/);
    for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:child_process', 'fetch(']) {
      expect(source).not.toContain(forbidden);
    }
  });
});
