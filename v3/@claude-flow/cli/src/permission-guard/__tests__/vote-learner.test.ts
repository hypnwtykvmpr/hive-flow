import { describe, it, expect } from 'vitest';
import { normalizeCommand, checkLearnedPattern, recordVerdict, getLearnedPatterns } from '../vote-learner.js';

describe('normalizeCommand', () => {
  it('keeps base command', () => {
    expect(normalizeCommand('git status')).toBe('git status');
  });
  it('keeps flags', () => {
    expect(normalizeCommand('git commit -m "test"')).toBe('git commit -m');
  });
  it('strips positional args', () => {
    expect(normalizeCommand('cat /path/to/file')).toBe('cat');
  });
  it('handles empty input', () => {
    expect(normalizeCommand('')).toBe('');
  });
  it('keeps subcommands before flags', () => {
    expect(normalizeCommand('npm run build')).toBe('npm run build');
  });
});

describe('checkLearnedPattern', () => {
  it('returns null for unknown patterns', () => {
    expect(checkLearnedPattern('Bash', 'some_random_cmd_xyz')).toBeNull();
  });
  it('returns null for chained commands', () => {
    expect(checkLearnedPattern('Bash', 'ls && rm -rf /')).toBeNull();
  });
  it('returns null for pipe commands', () => {
    expect(checkLearnedPattern('Bash', 'echo test | bash')).toBeNull();
  });
  it('returns null for subshell commands', () => {
    expect(checkLearnedPattern('Bash', '$(rm -rf /)')).toBeNull();
  });
});

describe('recordVerdict', () => {
  it('does not throw on valid input', () => {
    expect(() => recordVerdict('Bash', 'echo test_unique_12345', 'allow')).not.toThrow();
  });
  it('does not throw on empty pattern', () => {
    expect(() => recordVerdict('Bash', '', 'allow')).not.toThrow();
  });
});
