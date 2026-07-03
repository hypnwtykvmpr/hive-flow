// cli/src/statusline/__tests__/palette.test.ts
//
// Wave 8 tests for the statusline palette. Asserts:
//   - 256-color palette uses the locked visual-design codes byte-exactly
//   - `noColor: true` zeroes every slot
//   - 16-color fallback warning is non-bright red by default, opt-in
//     non-bright yellow only, NEVER bright yellow
//   - cartesian audit: no combination of (noColor, colorDepth,
//     allow16ColorYellowFallback) can ever emit `\x1b[1;33m`
//   - `detectColorDepth` is pure and honors NO_COLOR / FORCE_COLOR /
//     COLORTERM / TERM precedence
//   - the palette source file itself contains zero occurrences of the
//     literal forbidden bright-yellow sequence

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  detectColorDepth,
  FORBIDDEN_ANSI_BRIGHT_YELLOW,
  makePalette,
  type Palette,
  type PaletteCodes,
} from '../palette.js';
import type { ColorDepth } from '../types.js';

// ---------------------------------------------------------------------------
// 1. Locked 256-color codes (byte-exact)
// ---------------------------------------------------------------------------

describe('makePalette (256-color, canonical)', () => {
  it('emits byte-exact locked codes from the visual design', () => {
    const p = makePalette({ colorDepth: 256, allow16ColorYellowFallback: false });

    // Project anchor: bold light gray
    expect(p.project).toBe('\x1b[1;38;5;253m');
    // Git branch: bright blue (single owner)
    expect(p.branch).toBe('\x1b[1;34m');
    // Warning carrier (orange 208) — the "repo / warning" slot referenced
    // in the runbook header table
    expect(p.warn).toBe('\x1b[38;5;208m');
    // DeepSeek scoreboard tint
    expect(p.deepseek).toBe('\x1b[38;5;39m');
    // OpenRouter scoreboard tint
    expect(p.openrouter).toBe('\x1b[38;5;213m');

    // Spot-check a few additional locked slots so silent drift in the
    // canonical table fails this single test.
    expect(p.queen).toBe('\x1b[1;36m');
    expect(p.queenIdle).toBe('\x1b[38;5;141m');
    expect(p.memory).toBe('\x1b[38;5;80m');
    expect(p.cursor).toBe('\x1b[38;5;111m');
    expect(p.qwen).toBe('\x1b[38;5;117m');
    expect(p.opencode).toBe('\x1b[38;5;244m');
    expect(p.separator).toBe('\x1b[38;5;240m');
    expect(p.gray).toBe('\x1b[0;90m');
    expect(p.number).toBe('\x1b[1;37m');
    expect(p.reset).toBe('\x1b[0m');
  });

  it('Palette type alias matches PaletteCodes (renderer import shape)', () => {
    // Compile-time + runtime check that the `Palette` alias re-export is
    // structurally identical to PaletteCodes from types.ts.
    const p: Palette = makePalette({ colorDepth: 256 });
    const codes: PaletteCodes = p;
    expect(codes.reset).toBe('\x1b[0m');
  });

  it('defaults to the 256-color path when colorDepth is omitted', () => {
    const p = makePalette({});
    expect(p.project).toBe('\x1b[1;38;5;253m');
    expect(p.deepseek).toBe('\x1b[38;5;39m');
  });
});

// ---------------------------------------------------------------------------
// 2. No-color mode
// ---------------------------------------------------------------------------

describe('makePalette (no-color)', () => {
  it('returns an all-empty palette when noColor: true', () => {
    const p = makePalette({ noColor: true });
    for (const value of Object.values(p)) {
      expect(value).toBe('');
    }
  });

  it('returns an all-empty palette when colorDepth: 0', () => {
    const p = makePalette({ colorDepth: 0 });
    for (const value of Object.values(p)) {
      expect(value).toBe('');
    }
  });

  it('noColor wins over colorDepth (no escape leaks)', () => {
    const p = makePalette({ noColor: true, colorDepth: 256 });
    for (const value of Object.values(p)) {
      expect(value).toBe('');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 16-color fallback — warning slot rules
// ---------------------------------------------------------------------------

describe('makePalette (16-color fallback)', () => {
  it('warning = non-bright red when allow16ColorYellowFallback is false', () => {
    const p = makePalette({ colorDepth: 16, allow16ColorYellowFallback: false });
    // Task spec: NON-BRIGHT red by default — `\x1b[31m`, not `\x1b[0;31m`.
    expect(p.warn).toBe('\x1b[31m');
    expect(p.warn).not.toContain('1;33');
    expect(p.warn).not.toContain('33');
  });

  it('warning = non-bright yellow when allow16ColorYellowFallback is true', () => {
    const p = makePalette({ colorDepth: 16, allow16ColorYellowFallback: true });
    // Task spec: NON-BRIGHT yellow `\x1b[33m` — NEVER `\x1b[1;33m`.
    expect(p.warn).toBe('\x1b[33m');
    expect(p.warn).not.toBe('\x1b[1;33m');
    expect(p.warn).not.toBe('\x1b[0;33m');
    expect(p.warn).not.toContain('1;33');
  });

  it('keeps the locked branch color in the 16-color path', () => {
    const p = makePalette({ colorDepth: 16 });
    expect(p.branch).toBe('\x1b[1;34m');
  });
});

// ---------------------------------------------------------------------------
// 4. Cartesian audit — no combination ever emits bright yellow
// ---------------------------------------------------------------------------
//
// Locked types declare `ColorDepth = 0 | 16 | 256`. The task spec asks for
// `{noColor: T/F} × {colorDepth: none/16/256/truecolor} × {allow16ColorYellowFallback: T/F}`.
// We model "none" as `undefined` (default-detect/default-256), "16" as `16`,
// "256" as `256`, and "truecolor" as `256` (truecolor folds into the 256
// canonical palette per detectColorDepth precedence).

describe('makePalette (cartesian forbidden-yellow audit)', () => {
  const noColorValues: Array<boolean> = [false, true];
  const colorDepthValues: Array<ColorDepth | undefined> = [undefined, 0, 16, 256];
  const allowYellowValues: Array<boolean> = [false, true];

  it('no combination of options emits \\x1b[1;33m anywhere in any slot', () => {
    for (const noColor of noColorValues) {
      for (const colorDepth of colorDepthValues) {
        for (const allow16ColorYellowFallback of allowYellowValues) {
          const p = makePalette({ noColor, colorDepth, allow16ColorYellowFallback });
          const joined = Object.values(p).join('|');
          const label = JSON.stringify({ noColor, colorDepth, allow16ColorYellowFallback });
          expect(
            joined.includes(FORBIDDEN_ANSI_BRIGHT_YELLOW),
            `combination ${label} must not emit bright yellow`,
          ).toBe(false);
          // Defence-in-depth: check the literal byte form too, in case a
          // future refactor changes the constant.
          expect(
            joined.includes('\x1b[1;33m'),
            `combination ${label} must not emit \\x1b[1;33m literal`,
          ).toBe(false);
        }
      }
    }
  });

  it('FORBIDDEN_ANSI_BRIGHT_YELLOW constant is the expected byte sequence', () => {
    // Sanity check so the cartesian audit cannot be a false negative.
    expect(FORBIDDEN_ANSI_BRIGHT_YELLOW).toBe('\x1b[1;33m');
  });
});

// ---------------------------------------------------------------------------
// 5. detectColorDepth — precedence and purity
// ---------------------------------------------------------------------------

describe('detectColorDepth', () => {
  it('NO_COLOR=1 forces depth 0', () => {
    expect(detectColorDepth({ NO_COLOR: '1' })).toBe(0);
  });

  it('NO_COLOR wins over TERM=xterm-256color', () => {
    expect(detectColorDepth({ NO_COLOR: '1', TERM: 'xterm-256color' })).toBe(0);
  });

  it('TERM=dumb forces depth 0', () => {
    expect(detectColorDepth({ TERM: 'dumb' })).toBe(0);
  });

  it('FORCE_COLOR=0 forces depth 0', () => {
    expect(detectColorDepth({ FORCE_COLOR: '0' })).toBe(0);
  });

  it('FORCE_COLOR=3 forces depth 256', () => {
    expect(detectColorDepth({ FORCE_COLOR: '3' })).toBe(256);
  });

  it('COLORTERM=truecolor folds into the 256-color palette', () => {
    expect(detectColorDepth({ COLORTERM: 'truecolor' })).toBe(256);
    expect(detectColorDepth({ COLORTERM: '24bit' })).toBe(256);
  });

  it('TERM=xterm-256color resolves to 256', () => {
    expect(detectColorDepth({ TERM: 'xterm-256color' })).toBe(256);
    expect(detectColorDepth({ TERM: 'screen-256color' })).toBe(256);
  });

  it('TERM=xterm (no 256color suffix) resolves to 16', () => {
    expect(detectColorDepth({ TERM: 'xterm' })).toBe(16);
  });

  it('returns 16 when no color signal is set at all', () => {
    expect(detectColorDepth({})).toBe(16);
  });

  it('is pure — repeated calls with the same env return the same depth', () => {
    const env: NodeJS.ProcessEnv = { TERM: 'xterm-256color' };
    const first = detectColorDepth(env);
    const second = detectColorDepth(env);
    expect(first).toBe(second);
    expect(first).toBe(256);
  });
});

// ---------------------------------------------------------------------------
// 6. Static audit — source file contains no `1;33m`
// ---------------------------------------------------------------------------
//
// Last-line defence. Even if every prior test passes, a reviewer or LLM
// touching this file could later introduce `1;33m` as part of an unrelated
// edit. This test reads the palette source verbatim and asserts the literal
// byte sequence never appears.

describe('palette.ts static audit', () => {
  it('palette.ts source contains zero `1;33m` occurrences', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const paletteSource = readFileSync(join(here, '..', 'palette.ts'), 'utf8');
    // The forbidden bright-yellow CSI body is the 4-character substring
    // `1;33m`. We scan the raw source so any literal occurrence (escaped or
    // not, in code or comments) fails the test.
    expect(paletteSource.includes('1;33m')).toBe(false);
  });
});
