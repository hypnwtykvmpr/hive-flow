/**
 * Tests for statusline collision zone avoidance
 *
 * @see https://github.com/hypnwtykvmpr/hive-flow/issues/985
 *
 * The collision zone is columns 15-25 on the second-to-last line of output.
 * Claude Code writes its internal status (e.g., "7s • 1p") at these absolute
 * terminal coordinates, causing character bleeding if our statusline has
 * content there.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Strip ANSI escape codes from a string
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Get the character at a specific column (0-indexed)
 * Accounts for emoji width (2 columns)
 */
function getCharAtColumn(line: string, col: number): string {
  const stripped = stripAnsi(line);
  let visualCol = 0;

  for (let i = 0; i < stripped.length; i++) {
    if (visualCol === col) {
      return stripped[i];
    }

    // Emojis are typically 2 columns wide
    const charCode = stripped.charCodeAt(i);
    if (charCode > 0x1F000 || (charCode >= 0xD800 && charCode <= 0xDFFF)) {
      visualCol += 2;
    } else {
      visualCol += 1;
    }

    if (visualCol > col) {
      return stripped[i];
    }
  }

  return ' '; // Beyond line length
}

/**
 * Check if the collision zone (cols 15-25) contains only spaces
 */
function isCollisionZoneClear(line: string): boolean {
  const stripped = stripAnsi(line);

  // Simple check: get substring at cols 15-25
  // This is approximate since emojis take 2 columns
  let visualCol = 0;
  let zoneContent = '';

  for (let i = 0; i < stripped.length && visualCol < 26; i++) {
    const char = stripped[i];
    const charCode = char.charCodeAt(0);
    const charWidth = (charCode > 0x1F000 || (charCode >= 0xD800 && charCode <= 0xDFFF)) ? 2 : 1;

    if (visualCol >= 15 && visualCol < 26) {
      zoneContent += char;
    }

    visualCol += charWidth;
  }

  // The zone should be mostly spaces (allow for padding)
  const nonSpaceCount = zoneContent.replace(/\s/g, '').length;
  return nonSpaceCount === 0;
}

describe('Statusline Collision Zone Avoidance', () => {
  it('should have clear collision zone in safe multi-line output', async () => {
    // Import dynamically to avoid build issues
    const { StatuslineGenerator } = await import('../../statusline/index.js');

    const generator = new StatuslineGenerator();
    const output = generator.generateSafeStatusline();

    if (!output) {
      // Statusline disabled
      return;
    }

    const lines = output.split('\n');

    // The second-to-last line is the collision zone
    const collisionLineIndex = lines.length - 2;
    if (collisionLineIndex >= 0) {
      const collisionLine = lines[collisionLineIndex];
      expect(isCollisionZoneClear(collisionLine)).toBe(true);
    }
  });

  it('should produce single-line output when requested', async () => {
    const { StatuslineGenerator } = await import('../../statusline/index.js');

    const generator = new StatuslineGenerator();
    const output = generator.generateSingleLine();

    if (!output) {
      return;
    }

    // Single-line output should have no newlines
    expect(output.includes('\n')).toBe(false);
  });

  it('should have padding in the collision line', async () => {
    const { StatuslineGenerator } = await import('../../statusline/index.js');

    const generator = new StatuslineGenerator();
    const output = generator.generateSafeStatusline();

    if (!output) {
      return;
    }

    const lines = output.split('\n');
    const collisionLineIndex = lines.length - 2;

    if (collisionLineIndex >= 0) {
      const collisionLine = stripAnsi(lines[collisionLineIndex]);

      // The line should start with 🤖 followed by spaces for padding
      // After the emoji (2 cols), there should be at least 24 spaces
      // to push content past column 25 (collision zone is cols 15-25)
      const match = collisionLine.match(/^🤖(\s+)/);
      expect(match).not.toBeNull();

      if (match) {
        // At least 24 spaces after the emoji (emoji is 2 cols, 2+24=26 > 25)
        expect(match[1].length).toBeGreaterThanOrEqual(24);
      }
    }
  });
});

describe('Statusline Output Modes', () => {
  it('should support all output modes', async () => {
    const { StatuslineGenerator } = await import('../../statusline/index.js');

    const generator = new StatuslineGenerator();

    // Regular statusline
    const regular = generator.generateStatusline();
    expect(typeof regular).toBe('string');

    // Safe statusline
    const safe = generator.generateSafeStatusline();
    expect(typeof safe).toBe('string');

    // Single line
    const single = generator.generateSingleLine();
    expect(typeof single).toBe('string');

    // JSON
    const json = generator.generateJSON();
    expect(JSON.parse(json)).toBeDefined();

    // Compact JSON
    const compact = generator.generateCompactJSON();
    expect(JSON.parse(compact)).toBeDefined();
  });
});

describe('Statusline Truthful Defaults', () => {
  it('should not invent metrics when no source data exists', async () => {
    const { StatuslineGenerator } = await import('../../statusline/index.js');
    const projectRoot = mkdtempSync(join(tmpdir(), 'hooks-statusline-empty-'));
    mkdirSync(join(projectRoot, '.hive-flow', 'learning'), { recursive: true });
    writeFileSync(join(projectRoot, '.hive-flow', 'learning', 'patterns.db'), 'x'.repeat(50_000));

    try {
      const generator = new StatuslineGenerator(undefined, projectRoot);
      const data = JSON.parse(generator.generateJSON());

      expect(data.v3Progress.domainsCompleted).toBe(0);
      expect(data.v3Progress.totalDomains).toBe(0);
      expect(data.security.status).toBe('PENDING');
      expect(data.security.cvesFixed).toBe(0);
      expect(data.security.totalCves).toBe(0);
      expect(data.hooks.status).toBe('INACTIVE');
      expect(data.hooks.patternsLearned).toBe(0);
      expect(data.hooks.routingAccuracy).toBe(0);
      expect(data.hooks.totalOperations).toBe(0);
      expect(data.performance.flashAttentionTarget).toBe('No live performance data');
      expect(data.performance.searchImprovement).toBe('No live search metrics');
      expect(data.performance.memoryReduction).toBe('No live memory metrics');
      expect(data.system.intelligencePct).toBe(0);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
