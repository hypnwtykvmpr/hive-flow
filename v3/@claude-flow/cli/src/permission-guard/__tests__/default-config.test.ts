import { describe, it, expect } from 'vitest';
import { DEFAULT_PERMISSION_CONFIG, mergeWithDefaults } from '../default-config.js';

describe('DEFAULT_PERMISSION_CONFIG', () => {
  it('has non-empty allow patterns', () => {
    expect(DEFAULT_PERMISSION_CONFIG.always_allow_bash_patterns.length).toBeGreaterThan(30);
  });
  it('has non-empty deny patterns', () => {
    expect(DEFAULT_PERMISSION_CONFIG.always_deny_bash_patterns.length).toBeGreaterThan(10);
  });
  it('has non-empty escalation patterns', () => {
    // v2.1: 8 patterns moved to always_deny (FORBIDDEN), 4 remain as jury-assessable
    expect(DEFAULT_PERMISSION_CONFIG.jury_escalation_bash_patterns.length).toBeGreaterThanOrEqual(4);
  });
  it('has always-allow tools', () => {
    expect(DEFAULT_PERMISSION_CONFIG.always_allow_tools).toContain('Read');
    expect(DEFAULT_PERMISSION_CONFIG.always_allow_tools).toContain('Glob');
    expect(DEFAULT_PERMISSION_CONFIG.always_allow_tools).toContain('Grep');
  });
  it('has mcp allow prefix', () => {
    expect(DEFAULT_PERMISSION_CONFIG.always_allow_tool_prefixes).toContain('mcp__claude-flow__');
  });
  it('sets mcp_default_policy to allow', () => {
    expect(DEFAULT_PERMISSION_CONFIG.mcp_default_policy).toBe('allow');
  });
});

describe('mergeWithDefaults', () => {
  it('returns full config from empty input', () => {
    const result = mergeWithDefaults({});
    expect(result.always_allow_tools.length).toBeGreaterThan(0);
    expect(result.always_deny_bash_patterns.length).toBeGreaterThan(0);
  });
  it('user overrides win', () => {
    const result = mergeWithDefaults({ mcp_default_policy: 'deny' });
    expect(result.mcp_default_policy).toBe('deny');
  });
  it('preserves user allow_tools when provided', () => {
    const result = mergeWithDefaults({ always_allow_tools: ['CustomTool'] });
    expect(result.always_allow_tools).toEqual(['CustomTool']);
  });
  it('keeps defaults for unspecified fields', () => {
    const result = mergeWithDefaults({ log_file: '/tmp/test.log' });
    expect(result.always_allow_tools.length).toBeGreaterThan(0);
    expect(result.log_file).toBe('/tmp/test.log');
  });
});
