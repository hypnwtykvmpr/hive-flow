// v3/@hive-flow/cli/src/statusline/__tests__/property-contracts.test.ts
//
// Property-based tests for pure statusline contracts. Keep this file focused
// on deterministic, side-effect-free invariants; filesystem and process probes
// belong in the targeted integration suites.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STATUSLINE_CONFIG,
  normalizeStatuslineConfig,
  readPositiveIntEnv,
} from '../config.js';
import {
  normalizeAgentStatus,
  parseAutopilotPercentage,
  type NormalizedAgentStatus,
  type StatuslineSource,
} from '../types.js';

const PROPERTY_RUNS = 100;

const finiteNumber = fc.double({ noNaN: true, noDefaultInfinity: true });

describe('statusline property contracts', () => {
  describe('parseAutopilotPercentage', () => {
    it('always returns undefined or a finite percentage in the closed 0..100 range', () => {
      fc.assert(
        fc.property(fc.oneof(fc.anything(), finiteNumber.map(String)), (raw) => {
          const parsed = parseAutopilotPercentage(raw);
          expect(parsed === undefined || (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100)).toBe(true);
        }),
        { numRuns: PROPERTY_RUNS, seed: 12_051 },
      );
    });

    it('normalizes finite numeric inputs with the ADR-051 fraction-or-percent rule', () => {
      fc.assert(
        fc.property(
          finiteNumber.filter((n) => Number.isFinite(n <= 1 ? n * 100 : n)),
          (raw) => {
          const parsed = parseAutopilotPercentage(raw);
          const expected = raw <= 1 ? raw * 100 : raw;
          const clamped = Math.min(100, Math.max(0, expected));
          expect(parsed).toBe(clamped);
        }),
        { numRuns: PROPERTY_RUNS, seed: 12_052 },
      );
    });

    it('rejects booleans, nullish values, empty strings, and non-numeric strings', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.boolean(),
            fc.constant(null),
            fc.constant(undefined),
            fc.string().filter((value) => value.trim() === '' || Number.isNaN(Number(value))),
          ),
          (raw) => {
            expect(parseAutopilotPercentage(raw)).toBeUndefined();
          },
        ),
        { numRuns: PROPERTY_RUNS, seed: 12_053 },
      );
    });
  });

  describe('normalizeAgentStatus', () => {
    const busyAliases = ['busy', 'working', 'running', 'executing', 'delegating'];
    const idleAliases = ['idle', 'ready', 'available'];
    const queuedAliases = ['queued', 'spawning', 'pending'];
    const staleAliases = ['stale', 'unknown', 'degraded'];
    const terminalAliases = ['terminated', 'failed', 'complete', 'completed', 'cancelled', 'canceled'];

    it.each([
      ['busy', busyAliases],
      ['idle', idleAliases],
      ['queued', queuedAliases],
      ['stale', staleAliases],
    ] as const)('maps %s aliases case-insensitively', (expected, aliases) => {
      fc.assert(
        fc.property(fc.constantFrom(...aliases), fc.boolean(), (alias, upper) => {
          const input = upper ? alias.toUpperCase() : alias;
          expect(normalizeAgentStatus(input)).toBe(expected);
        }),
        { numRuns: PROPERTY_RUNS, seed: 12_060 + aliases.length },
      );
    });

    it('drops terminal aliases case-insensitively', () => {
      fc.assert(
        fc.property(fc.constantFrom(...terminalAliases), fc.boolean(), (alias, upper) => {
          const input = upper ? alias.toUpperCase() : alias;
          expect(normalizeAgentStatus(input)).toBeUndefined();
        }),
        { numRuns: PROPERTY_RUNS, seed: 12_070 },
      );
    });

    it('maps unknown non-terminal statuses to stale', () => {
      const known = new Set([...busyAliases, ...idleAliases, ...queuedAliases, ...staleAliases, ...terminalAliases]);
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }).filter((value) => !known.has(value.toLowerCase())),
          (status) => {
            expect(normalizeAgentStatus(status)).toBe('stale');
          },
        ),
        { numRuns: PROPERTY_RUNS, seed: 12_071 },
      );
    });
  });

  describe('readPositiveIntEnv', () => {
    it('returns fallback for missing, empty, non-finite, or negative env values', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant(undefined),
            fc.constant(''),
            fc.constant('NaN'),
            fc.constant('Infinity'),
            fc.constant('-Infinity'),
            finiteNumber.filter((n) => n < 0).map(String),
          ),
          fc.integer({ min: 0, max: 10_000 }),
          (raw, fallback) => {
            const env: NodeJS.ProcessEnv = {};
            if (raw !== undefined) env.HF_TEST = raw;
            expect(readPositiveIntEnv(env, 'HF_TEST', fallback)).toBe(fallback);
          },
        ),
        { numRuns: PROPERTY_RUNS, seed: 12_080 },
      );
    });

    it('floors finite non-negative values', () => {
      fc.assert(
        fc.property(
          finiteNumber.filter((n) => n >= 0).map(String),
          fc.integer({ min: 0, max: 10_000 }),
          (raw, fallback) => {
            expect(readPositiveIntEnv({ HF_TEST: raw }, 'HF_TEST', fallback)).toBe(Math.floor(Number(raw)));
          },
        ),
        { numRuns: PROPERTY_RUNS, seed: 12_081 },
      );
    });
  });

  describe('normalizeStatuslineConfig', () => {
    it('keeps numeric safety caps inside their configured bounds for arbitrary inputs', () => {
      fc.assert(
        fc.property(fc.dictionary(fc.string({ minLength: 1, maxLength: 32 }), fc.anything()), (input) => {
          const config = normalizeStatuslineConfig(input);
          expect(config.refreshDebounceMs).toBeGreaterThanOrEqual(250);
          expect(config.refreshDebounceMs).toBeLessThanOrEqual(1000);
          expect(config.renderBudgetMs).toBeGreaterThanOrEqual(50);
          expect(config.renderBudgetMs).toBeLessThanOrEqual(5000);
          expect(config.maxConfigBytes).toBeGreaterThanOrEqual(1024);
          expect(config.maxConfigBytes).toBeLessThanOrEqual(1024 * 1024);
          expect(config.maxInitBufferBytes).toBeGreaterThanOrEqual(1024);
          expect(config.maxInitBufferBytes).toBeLessThanOrEqual(1024 * 1024);
          expect(config.maxJsonlLineBytes).toBeGreaterThanOrEqual(256);
          expect(config.maxJsonlLineBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
          expect(config.maxSpoolEntries).toBeGreaterThanOrEqual(1);
          expect(config.maxSpoolEntries).toBeLessThanOrEqual(1_000_000);
        }),
        { numRuns: PROPERTY_RUNS, seed: 12_090 },
      );
    });

    it('preserves the exact statusline source key set when normalizing source TTLs', () => {
      const expectedSources = Object.keys(DEFAULT_STATUSLINE_CONFIG.sourceTtlsMs).sort() as StatuslineSource[];
      fc.assert(
        fc.property(fc.dictionary(fc.string({ minLength: 1, maxLength: 24 }), fc.anything()), (sourceTtlsMs) => {
          const config = normalizeStatuslineConfig({ sourceTtlsMs });
          expect(Object.keys(config.sourceTtlsMs).sort()).toEqual(expectedSources);
          for (const ttl of Object.values(config.sourceTtlsMs)) {
            expect(Number.isInteger(ttl)).toBe(true);
            expect(ttl).toBeGreaterThanOrEqual(0);
          }
        }),
        { numRuns: PROPERTY_RUNS, seed: 12_091 },
      );
    });

    it('only emits the normalized live status vocabulary or undefined', () => {
      const allowed = new Set<NormalizedAgentStatus | undefined>(['busy', 'idle', 'queued', 'stale', undefined]);
      fc.assert(
        fc.property(fc.string(), (status) => {
          expect(allowed.has(normalizeAgentStatus(status))).toBe(true);
        }),
        { numRuns: PROPERTY_RUNS, seed: 12_092 },
      );
    });
  });
});
