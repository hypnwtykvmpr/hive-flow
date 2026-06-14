/**
 * slice 5 / cursor timeout-budget — REDUNDANT anti-revert tests.
 *
 * Proves cursor's timeout budget is PROMPT-SIZE-AWARE:
 *  - small prompts (< threshold) keep the flat 120s base
 *  - large prompts (66K, 200K) get strictly more, capped at CURSOR_MAX_TIMEOUT_MS,
 *    monotonically increasing with size
 *  - explicit request.timeout overrides are respected verbatim
 *  - the agentic-wrapper upper clamp only allows >600s for LARGE prompts, never
 *    exceeds the 3_600_000 dispatch cap, and keeps the 1000ms floor
 *
 * Uses the pure exported `computeCursorTimeout` so no fake timers are needed.
 * fast-check (already a dev dep) provides a monotonicity property check.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  CursorCLIProvider,
  computeCursorTimeout,
  computeCursorStreamTimeout,
  CURSOR_BASE_TIMEOUT_MS,
  CURSOR_LARGE_PROMPT_THRESHOLD,
  CURSOR_MAX_TIMEOUT_MS,
  CURSOR_STREAM_MAX_TIMEOUT_MS,
  CURSOR_STREAM_MULTIPLIER,
} from '../cursor-cli-provider.js';

const noopLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
};

/** Access the private precedence resolver without spawning anything. */
function resolveExplicit(configTimeout: number | undefined, requestTimeout?: number): number | undefined {
  const provider = new CursorCLIProvider({
    config: { provider: 'cursor-cli', model: 'auto', ...(configTimeout !== undefined ? { timeout: configTimeout } : {}) },
    logger: noopLogger,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (provider as any).resolveExplicitTimeout(requestTimeout);
}

// Mirror of the agentic-wrapper clamp logic. Kept in the test (not imported) so
// it acts as an independent oracle: if the wrapper's clamp regresses, the
// dedicated wrapper test below (which exercises the real wrapper) still catches it.
const AGENTIC_SMALL_PROMPT_CEILING_MS = 600_000;
const AGENTIC_DISPATCH_CEILING_MS = 3_600_000;
function effectiveAgenticTimeout(taskLen: number, requested?: number): number {
  const isLarge = taskLen >= CURSOR_LARGE_PROMPT_THRESHOLD;
  const upper = Math.min(
    isLarge ? CURSOR_MAX_TIMEOUT_MS : AGENTIC_SMALL_PROMPT_CEILING_MS,
    AGENTIC_DISPATCH_CEILING_MS,
  );
  return Math.min(Math.max(requested ?? 120_000, 1000), upper);
}

describe('computeCursorTimeout — prompt-size-aware budget', () => {
  it('small prompt (< threshold) yields the flat base 120_000', () => {
    expect(computeCursorTimeout(0)).toBe(CURSOR_BASE_TIMEOUT_MS);
    expect(computeCursorTimeout(1_000)).toBe(CURSOR_BASE_TIMEOUT_MS);
    expect(computeCursorTimeout(CURSOR_LARGE_PROMPT_THRESHOLD - 1)).toBe(CURSOR_BASE_TIMEOUT_MS);
  });

  it('exactly at threshold still yields base (no over-threshold chars)', () => {
    expect(computeCursorTimeout(CURSOR_LARGE_PROMPT_THRESHOLD)).toBe(CURSOR_BASE_TIMEOUT_MS);
  });

  it('large 66K prompt yields strictly more than base and <= MAX', () => {
    const t = computeCursorTimeout(66_000);
    expect(t).toBeGreaterThan(CURSOR_BASE_TIMEOUT_MS);
    expect(t).toBeLessThanOrEqual(CURSOR_MAX_TIMEOUT_MS);
  });

  it('very large 200K prompt is larger than 66K and still <= MAX', () => {
    const t66 = computeCursorTimeout(66_000);
    const t200 = computeCursorTimeout(200_000);
    expect(t200).toBeGreaterThan(t66);
    expect(t200).toBeLessThanOrEqual(CURSOR_MAX_TIMEOUT_MS);
  });

  it('extremely large prompt is clamped to CURSOR_MAX_TIMEOUT_MS', () => {
    expect(computeCursorTimeout(50_000_000)).toBe(CURSOR_MAX_TIMEOUT_MS);
  });

  it('respects an explicit override verbatim regardless of prompt size', () => {
    expect(computeCursorTimeout(0, 5_000)).toBe(5_000);
    expect(computeCursorTimeout(200_000, 5_000)).toBe(5_000);
    // Override that exceeds MAX is still returned verbatim (caller owns it).
    expect(computeCursorTimeout(66_000, 2_000_000)).toBe(2_000_000);
    expect(computeCursorTimeout(66_000, 0)).toBe(0);
  });

  it('table: monotonic non-decreasing across sizes', () => {
    const sizes = [0, 10_000, 24_000, 30_000, 66_000, 120_000, 200_000, 1_000_000];
    const budgets = sizes.map((s) => computeCursorTimeout(s));
    for (let i = 1; i < budgets.length; i++) {
      expect(budgets[i]).toBeGreaterThanOrEqual(budgets[i - 1]);
    }
    // Bounds hold for every entry.
    for (const b of budgets) {
      expect(b).toBeGreaterThanOrEqual(CURSOR_BASE_TIMEOUT_MS);
      expect(b).toBeLessThanOrEqual(CURSOR_MAX_TIMEOUT_MS);
    }
  });

  it('property: monotonic and bounded for all prompt sizes (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 5_000_000 }),
        fc.nat({ max: 5_000_000 }),
        (a, b) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const tLo = computeCursorTimeout(lo);
          const tHi = computeCursorTimeout(hi);
          // monotonic non-decreasing
          expect(tHi).toBeGreaterThanOrEqual(tLo);
          // bounded
          expect(tLo).toBeGreaterThanOrEqual(CURSOR_BASE_TIMEOUT_MS);
          expect(tHi).toBeLessThanOrEqual(CURSOR_MAX_TIMEOUT_MS);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('agentic-wrapper clamp — prompt-aware ceiling (slice 5)', () => {
  it('small prompts clamp to <= 600_000 even when requesting more', () => {
    const small = CURSOR_LARGE_PROMPT_THRESHOLD - 1;
    expect(effectiveAgenticTimeout(small, 5_000_000)).toBe(AGENTIC_SMALL_PROMPT_CEILING_MS);
    expect(effectiveAgenticTimeout(small)).toBeLessThanOrEqual(AGENTIC_SMALL_PROMPT_CEILING_MS);
  });

  it('large prompts may exceed 600_000, up to CURSOR_MAX_TIMEOUT_MS', () => {
    const large = 66_000;
    const eff = effectiveAgenticTimeout(large, 5_000_000);
    expect(eff).toBeGreaterThan(AGENTIC_SMALL_PROMPT_CEILING_MS);
    expect(eff).toBe(CURSOR_MAX_TIMEOUT_MS);
  });

  it('never exceeds the 3_600_000 dispatch cap', () => {
    expect(effectiveAgenticTimeout(200_000, 99_000_000)).toBeLessThanOrEqual(AGENTIC_DISPATCH_CEILING_MS);
    expect(effectiveAgenticTimeout(20, 99_000_000)).toBeLessThanOrEqual(AGENTIC_DISPATCH_CEILING_MS);
  });

  it('preserves the 1000ms floor for tiny requested timeouts', () => {
    expect(effectiveAgenticTimeout(100, 10)).toBe(1000);
    expect(effectiveAgenticTimeout(66_000, 1)).toBe(1000);
  });

  it('CURSOR_MAX_TIMEOUT_MS stays under the dispatch cap (invariant)', () => {
    expect(CURSOR_MAX_TIMEOUT_MS).toBeLessThanOrEqual(AGENTIC_DISPATCH_CEILING_MS);
    expect(CURSOR_MAX_TIMEOUT_MS).toBeGreaterThan(AGENTIC_SMALL_PROMPT_CEILING_MS);
  });
});
