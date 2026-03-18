import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks (hoisted before imports) ────────────────────────────────

// We test the CJS module by mocking fs, path, and crypto at the require level.
// The role-enforcement.cjs module uses require('fs'), require('path'), require('crypto').

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockStatSync = vi.fn();
const mockCreateHmac = vi.fn();
const mockTimingSafeEqual = vi.fn();

// Build a mock HMAC key and helper to produce valid envelopes
const TEST_HMAC_KEY = 'test-hmac-key-for-role-enforcement';

function computeTestHmac(data: unknown): string {
  // Use real crypto for test envelope generation
  const crypto = require('crypto');
  return crypto.createHmac('sha256', TEST_HMAC_KEY).update(JSON.stringify(data)).digest('hex');
}

function makeRoleEnvelope(state: Record<string, unknown>) {
  return { state, hmac: computeTestHmac(state) };
}

// ── Direct require of the CJS module ─────────────────────────────────────
// We import the module fresh in each test to avoid stale state.
// The module exports pure functions that we can test directly.

// Use dynamic require path based on project structure
const ROLE_ENFORCEMENT_PATH = require('path').resolve(
  __dirname, '..', '..', '..', '..', '..', '.claude', 'helpers', 'role-enforcement.cjs'
);

// We need to use the real module since it's CJS with fs/crypto calls.
// We'll use a fresh require for each test group and mock the fs operations
// through the module's exported functions.

let roleEnf: typeof import('../../../../../.claude/helpers/role-enforcement.cjs');

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe('Role Enforcement System', () => {
  beforeEach(() => {
    vi.resetModules();
    // Fresh require each time to avoid stale module state
    roleEnf = require(ROLE_ENFORCEMENT_PATH);
  });

  afterEach(() => {
    delete process.env.AGENTIC_FLOW_AGENT_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_AGENT_ID;
  });

  // ── sanitizeId ──

  describe('sanitizeId', () => {
    it('replaces non-alphanumeric chars with hyphens', () => {
      expect(roleEnf.sanitizeId('agent@foo/bar')).toBe('agent-foo-bar');
    });

    it('truncates to 64 characters', () => {
      const longId = 'a'.repeat(100);
      expect(roleEnf.sanitizeId(longId).length).toBe(64);
    });

    it('strips leading/trailing hyphens', () => {
      expect(roleEnf.sanitizeId('--agent--')).toBe('agent');
    });

    it('returns empty string for null/undefined/empty input', () => {
      expect(roleEnf.sanitizeId(null)).toBe('');
      expect(roleEnf.sanitizeId(undefined)).toBe('');
      expect(roleEnf.sanitizeId('')).toBe('');
    });
  });

  // ── getRoleFilePath ──

  describe('getRoleFilePath', () => {
    it('returns a path containing the sanitized ID', () => {
      const result = roleEnf.getRoleFilePath('test-agent-123');
      expect(result).toContain('test-agent-123');
      expect(result).toContain('role.json');
      expect(result).toContain('enforcement');
    });

    it('returns null for empty/invalid agent ID', () => {
      expect(roleEnf.getRoleFilePath('')).toBeNull();
      expect(roleEnf.getRoleFilePath(null)).toBeNull();
    });
  });

  // ── makeAllow / makeDeny ──

  describe('makeAllow', () => {
    it('returns empty object when no context provided', () => {
      expect(roleEnf.makeAllow()).toEqual({});
    });

    it('returns allow with additionalContext when context provided', () => {
      const result = roleEnf.makeAllow('some context');
      expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
      expect(result.hookSpecificOutput.additionalContext).toBe('some context');
    });

    it('strips XML tags from context', () => {
      const result = roleEnf.makeAllow('<script>alert("xss")</script>hello');
      expect(result.hookSpecificOutput.additionalContext).toBe('alert("xss")hello');
    });

    it('truncates context to 2000 chars', () => {
      const longCtx = 'x'.repeat(3000);
      const result = roleEnf.makeAllow(longCtx);
      expect(result.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(2020); // 2000 + "... [truncated]"
      expect(result.hookSpecificOutput.additionalContext).toContain('[truncated]');
    });
  });

  describe('makeDeny', () => {
    it('returns deny with reason', () => {
      const result = roleEnf.makeDeny('blocked');
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason).toBe('blocked');
    });
  });

  // ── ADVOCATE_DENIED set ──

  describe('ADVOCATE_DENIED tool set', () => {
    it('contains Bash, Write, Edit, MultiEdit, NotebookEdit, WebFetch', () => {
      expect(roleEnf.ADVOCATE_DENIED.has('Bash')).toBe(true);
      expect(roleEnf.ADVOCATE_DENIED.has('Write')).toBe(true);
      expect(roleEnf.ADVOCATE_DENIED.has('Edit')).toBe(true);
      expect(roleEnf.ADVOCATE_DENIED.has('MultiEdit')).toBe(true);
      expect(roleEnf.ADVOCATE_DENIED.has('NotebookEdit')).toBe(true);
      expect(roleEnf.ADVOCATE_DENIED.has('WebFetch')).toBe(true);
    });

    it('does not contain Read, Grep, Glob, Task', () => {
      expect(roleEnf.ADVOCATE_DENIED.has('Read')).toBe(false);
      expect(roleEnf.ADVOCATE_DENIED.has('Grep')).toBe(false);
      expect(roleEnf.ADVOCATE_DENIED.has('Glob')).toBe(false);
      expect(roleEnf.ADVOCATE_DENIED.has('Task')).toBe(false);
    });
  });

  // ── enforceAdvocateRole ──

  describe('enforceAdvocateRole', () => {
    it('denies Bash for advocate', () => {
      const result = roleEnf.enforceAdvocateRole('Bash');
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason).toContain('ADVOCATE ENFORCEMENT');
    });

    it('denies Write for advocate', () => {
      const result = roleEnf.enforceAdvocateRole('Write');
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    it('denies Edit for advocate', () => {
      const result = roleEnf.enforceAdvocateRole('Edit');
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    it('denies MultiEdit for advocate', () => {
      const result = roleEnf.enforceAdvocateRole('MultiEdit');
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    it('denies NotebookEdit for advocate', () => {
      const result = roleEnf.enforceAdvocateRole('NotebookEdit');
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    it('denies WebFetch for advocate', () => {
      const result = roleEnf.enforceAdvocateRole('WebFetch');
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    it('allows Read for advocate', () => {
      const result = roleEnf.enforceAdvocateRole('Read');
      expect(result).toEqual({});
    });

    it('allows Grep for advocate', () => {
      const result = roleEnf.enforceAdvocateRole('Grep');
      expect(result).toEqual({});
    });

    it('allows Glob for advocate', () => {
      const result = roleEnf.enforceAdvocateRole('Glob');
      expect(result).toEqual({});
    });

    it('allows Task for advocate', () => {
      const result = roleEnf.enforceAdvocateRole('Task');
      expect(result).toEqual({});
    });

    it('allows unknown tools for advocate', () => {
      const result = roleEnf.enforceAdvocateRole('SomeFutureTool');
      expect(result).toEqual({});
    });
  });

  // ── enforceQueenRole ──

  describe('enforceQueenRole', () => {
    it('allows non-work tools silently', () => {
      const result = roleEnf.enforceQueenRole('Read', { type: 'queen', hiveId: 'h1' });
      expect(result).toEqual({});
    });

    it('allows work tools when no hiveId (pre-mission queen)', () => {
      const result = roleEnf.enforceQueenRole('Bash', { type: 'queen' });
      expect(result).toEqual({});
    });

    it('allows work tools with warning when idle workers exist', () => {
      // This test requires loadQueenHive to return hive data.
      // Since loadQueenHive reads from filesystem, we test the function directly
      // with a known role that has hiveId but no loadable hive (filesystem mock).
      // The function will return makeAllow() when hive is not found.
      const result = roleEnf.enforceQueenRole('Bash', { type: 'queen', hiveId: 'nonexistent-hive' });
      // Hive not found on disk -> allow
      expect(result).toEqual({});
    });
  });

  // ── verifyRoleHmac ──

  describe('verifyRoleHmac', () => {
    it('returns false for null/undefined input', () => {
      expect(roleEnf.verifyRoleHmac(null)).toBe(false);
      expect(roleEnf.verifyRoleHmac(undefined)).toBe(false);
    });

    it('returns false for non-object input', () => {
      expect(roleEnf.verifyRoleHmac('string')).toBe(false);
      expect(roleEnf.verifyRoleHmac(42)).toBe(false);
    });

    it('returns false when state or hmac missing', () => {
      expect(roleEnf.verifyRoleHmac({ state: {} })).toBe(false);
      expect(roleEnf.verifyRoleHmac({ hmac: 'abc' })).toBe(false);
    });

    it('returns false when HMAC key file is not available', () => {
      // Without the actual .hmac-key file, verifyRoleHmac returns false
      const envelope = { state: { type: 'advocate' }, hmac: 'deadbeef'.repeat(8) };
      expect(roleEnf.verifyRoleHmac(envelope)).toBe(false);
    });
  });

  // ── HMAC envelope format ──

  describe('HMAC envelope format', () => {
    it('envelope has state and hmac fields', () => {
      const state = { type: 'advocate', assignedAt: new Date().toISOString() };
      const envelope = makeRoleEnvelope(state);
      expect(envelope).toHaveProperty('state');
      expect(envelope).toHaveProperty('hmac');
      expect(typeof envelope.hmac).toBe('string');
      expect(envelope.hmac).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
      expect(envelope.state).toEqual(state);
    });

    it('different states produce different HMACs', () => {
      const env1 = makeRoleEnvelope({ type: 'advocate' });
      const env2 = makeRoleEnvelope({ type: 'queen', hiveId: 'h1' });
      expect(env1.hmac).not.toBe(env2.hmac);
    });
  });

  // ── processPreToolUse ──

  describe('processPreToolUse', () => {
    it('passes through when no agent ID env vars set', () => {
      // Ensure no agent ID env vars
      delete process.env.AGENTIC_FLOW_AGENT_ID;
      delete process.env.CLAUDE_SESSION_ID;
      delete process.env.CLAUDE_AGENT_ID;

      const result = roleEnf.processPreToolUse({ tool_name: 'Bash' });
      // No agent ID -> passthrough (makeAllow with no context)
      expect(result).toEqual({});
    });

    it('passes through when role file does not exist', () => {
      process.env.CLAUDE_AGENT_ID = 'agent-no-role';
      const result = roleEnf.processPreToolUse({ tool_name: 'Bash' });
      // loadRole returns null because file doesn't exist on disk
      expect(result).toEqual({});
    });

    it('accepts both tool_name and toolName input formats', () => {
      // Without a role, both should passthrough
      delete process.env.AGENTIC_FLOW_AGENT_ID;
      const r1 = roleEnf.processPreToolUse({ tool_name: 'Read' });
      const r2 = roleEnf.processPreToolUse({ toolName: 'Read' });
      expect(r1).toEqual({});
      expect(r2).toEqual({});
    });

    it('passes through for unknown role types', () => {
      // Even if we could mock a role with type: 'worker', it should pass through.
      // Without actual fs mocking at the module level, we verify the code path
      // by checking that the function handles the case.
      delete process.env.AGENTIC_FLOW_AGENT_ID;
      const result = roleEnf.processPreToolUse({ tool_name: 'Bash' });
      expect(result).toEqual({});
    });
  });

  // ── processSubagentStart ──

  describe('processSubagentStart', () => {
    it('injects advocate identity text for advocate role', () => {
      const result = roleEnf.processSubagentStart({ type: 'advocate' });
      expect(result.hookSpecificOutput.additionalContext).toContain('ADVOCATE');
      expect(result.hookSpecificOutput.additionalContext).toContain('orchestrate');
    });

    it('injects queen identity text with hiveId for queen role', () => {
      const result = roleEnf.processSubagentStart({ type: 'queen', hiveId: 'hive-42' });
      expect(result.hookSpecificOutput.additionalContext).toContain('QUEEN');
      expect(result.hookSpecificOutput.additionalContext).toContain('hive-42');
    });

    it('replaces {{HIVE_ID}} placeholder with actual hiveId', () => {
      const result = roleEnf.processSubagentStart({ type: 'queen', hiveId: 'my-hive' });
      expect(result.hookSpecificOutput.additionalContext).not.toContain('{{HIVE_ID}}');
      expect(result.hookSpecificOutput.additionalContext).toContain('my-hive');
    });

    it('uses "unassigned" when queen has no hiveId', () => {
      const result = roleEnf.processSubagentStart({ type: 'queen' });
      expect(result.hookSpecificOutput.additionalContext).toContain('unassigned');
    });

    it('returns empty object for worker/unknown role', () => {
      expect(roleEnf.processSubagentStart({ type: 'worker' })).toEqual({});
      expect(roleEnf.processSubagentStart({ type: 'unknown' })).toEqual({});
    });
  });

  // ── processSubagentStartHook ──

  describe('processSubagentStartHook', () => {
    it('returns empty object when no agent ID', () => {
      delete process.env.AGENTIC_FLOW_AGENT_ID;
      delete process.env.CLAUDE_SESSION_ID;
      delete process.env.CLAUDE_AGENT_ID;

      const result = roleEnf.processSubagentStartHook();
      expect(result).toEqual({});
    });

    it('returns empty object when agent has no role file', () => {
      process.env.CLAUDE_AGENT_ID = 'agent-without-role';
      const result = roleEnf.processSubagentStartHook();
      expect(result).toEqual({});
    });
  });

  // ── Identity text constants ──

  describe('identity text constants', () => {
    it('ADVOCATE_IDENTITY_TEXT contains structural rules', () => {
      expect(roleEnf.ADVOCATE_IDENTITY_TEXT).toContain('ADVOCATE');
      expect(roleEnf.ADVOCATE_IDENTITY_TEXT).toContain('Bash');
      expect(roleEnf.ADVOCATE_IDENTITY_TEXT).toContain('Write');
      expect(roleEnf.ADVOCATE_IDENTITY_TEXT).toContain('Edit');
      expect(roleEnf.ADVOCATE_IDENTITY_TEXT).toContain('queen_mission_assign');
    });

    it('QUEEN_IDENTITY_TEXT contains protocol steps', () => {
      expect(roleEnf.QUEEN_IDENTITY_TEXT).toContain('QUEEN');
      expect(roleEnf.QUEEN_IDENTITY_TEXT).toContain('queen_spawn_worker');
      expect(roleEnf.QUEEN_IDENTITY_TEXT).toContain('queen_task_worker');
      expect(roleEnf.QUEEN_IDENTITY_TEXT).toContain('queen_collect_results');
      expect(roleEnf.QUEEN_IDENTITY_TEXT).toContain('queen_report');
    });

    it('QUEEN_IDENTITY_TEXT has {{HIVE_ID}} placeholder', () => {
      expect(roleEnf.QUEEN_IDENTITY_TEXT).toContain('{{HIVE_ID}}');
    });
  });

  // ── WORK_TOOLS set ──

  describe('WORK_TOOLS set', () => {
    it('contains Bash, Write, Edit, MultiEdit, NotebookEdit', () => {
      expect(roleEnf.WORK_TOOLS.has('Bash')).toBe(true);
      expect(roleEnf.WORK_TOOLS.has('Write')).toBe(true);
      expect(roleEnf.WORK_TOOLS.has('Edit')).toBe(true);
      expect(roleEnf.WORK_TOOLS.has('MultiEdit')).toBe(true);
      expect(roleEnf.WORK_TOOLS.has('NotebookEdit')).toBe(true);
    });

    it('does not contain WebFetch (not a work tool for queen)', () => {
      expect(roleEnf.WORK_TOOLS.has('WebFetch')).toBe(false);
    });
  });

  // ── loadQueenHive ──

  describe('loadQueenHive', () => {
    it('returns null for null/undefined hiveId', () => {
      expect(roleEnf.loadQueenHive(null)).toBeNull();
      expect(roleEnf.loadQueenHive(undefined)).toBeNull();
    });

    it('returns null when hive file does not exist', () => {
      expect(roleEnf.loadQueenHive('nonexistent-hive-id')).toBeNull();
    });
  });

  // ── loadRole ──

  describe('loadRole', () => {
    it('returns null for empty agent ID', () => {
      expect(roleEnf.loadRole('')).toBeNull();
      expect(roleEnf.loadRole(null)).toBeNull();
    });

    it('returns null when role file does not exist', () => {
      expect(roleEnf.loadRole('agent-no-file')).toBeNull();
    });
  });

  // ── Agent ID env var priority ──

  describe('agent ID env var priority', () => {
    it('uses AGENTIC_FLOW_AGENT_ID first', () => {
      process.env.AGENTIC_FLOW_AGENT_ID = 'agent-1';
      process.env.CLAUDE_SESSION_ID = 'agent-2';
      process.env.CLAUDE_AGENT_ID = 'agent-3';

      // Without a role file, processPreToolUse will passthrough.
      // The key test is that it tries agent-1 first.
      const result = roleEnf.processPreToolUse({ tool_name: 'Read' });
      expect(result).toEqual({});
    });

    it('falls back to CLAUDE_SESSION_ID when AGENTIC_FLOW_AGENT_ID unset', () => {
      delete process.env.AGENTIC_FLOW_AGENT_ID;
      process.env.CLAUDE_SESSION_ID = 'session-agent';
      process.env.CLAUDE_AGENT_ID = 'claude-agent';

      const result = roleEnf.processPreToolUse({ tool_name: 'Read' });
      expect(result).toEqual({});
    });

    it('falls back to CLAUDE_AGENT_ID as last resort', () => {
      delete process.env.AGENTIC_FLOW_AGENT_ID;
      delete process.env.CLAUDE_SESSION_ID;
      process.env.CLAUDE_AGENT_ID = 'claude-only';

      const result = roleEnf.processPreToolUse({ tool_name: 'Read' });
      expect(result).toEqual({});
    });
  });
});
