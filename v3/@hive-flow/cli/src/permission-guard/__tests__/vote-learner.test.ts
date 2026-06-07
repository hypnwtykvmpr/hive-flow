import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

let tempHome = '';
let learner: typeof import('../vote-learner.js');

beforeEach(async () => {
  tempHome = mkdtempSync(join(tmpdir(), 'vote-learner-home-'));
  vi.stubEnv('HOME', tempHome);
  vi.resetModules();
  learner = await import('../vote-learner.js');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = '';
  }
});

describe('normalizeCommand', () => {
  it('keeps base command', () => {
    expect(learner.normalizeCommand('git status')).toBe('git status');
  });
  it('keeps flags', () => {
    expect(learner.normalizeCommand('git commit -m "test"')).toBe('git commit -m');
  });
  it('strips positional args', () => {
    expect(learner.normalizeCommand('cat /path/to/file')).toBe('cat');
  });
  it('handles empty input', () => {
    expect(learner.normalizeCommand('')).toBe('');
  });
  it('keeps subcommands before flags', () => {
    expect(learner.normalizeCommand('npm run build')).toBe('npm run build');
  });
});

describe('checkLearnedPattern', () => {
  it('returns null for unknown patterns', () => {
    expect(learner.checkLearnedPattern('Bash', 'some_random_cmd_xyz')).toBeNull();
  });
  it('returns null for chained commands', () => {
    expect(learner.checkLearnedPattern('Bash', 'ls && rm -rf /')).toBeNull();
  });
  it('returns null for pipe commands', () => {
    expect(learner.checkLearnedPattern('Bash', 'echo test | bash')).toBeNull();
  });
  it('returns null for subshell commands', () => {
    expect(learner.checkLearnedPattern('Bash', '$(rm -rf /)')).toBeNull();
  });
});

describe('recordVerdict', () => {
  it('does not throw on valid input', () => {
    expect(() => learner.recordVerdict('Bash', 'echo test_unique_12345', 'allow')).not.toThrow();
    const patternFile = join(tempHome, '.claude', 'hooks', 'escalation_context', 'learned_patterns.json');
    expect(existsSync(patternFile)).toBe(true);
    const signedStore = JSON.parse(readFileSync(patternFile, 'utf8'));
    expect(signedStore.patterns['Bash::echo']).toMatchObject({
      approvals: 1,
      pattern: 'echo',
      tool: 'Bash',
    });
  });
  it('does not throw on empty pattern', () => {
    expect(() => learner.recordVerdict('Bash', '', 'allow')).not.toThrow();
  });
});
