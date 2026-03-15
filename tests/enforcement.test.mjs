import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SCRIPT = join(REPO_ROOT, '.claude/helpers/enforcement.cjs');

function withTempRepo() {
  return mkdtempSync(join(tmpdir(), 'enforcement-test-'));
}

function runEnforcement(cwd, input) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    json: (() => { try { return JSON.parse(result.stdout); } catch { return null; } })(),
  };
}

function setState(cwd, state) {
  const dir = join(cwd, '.hive-flow', 'enforcement');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2));
}

function getState(cwd) {
  try {
    return JSON.parse(readFileSync(join(cwd, '.hive-flow', 'enforcement', 'state.json'), 'utf8'));
  } catch { return null; }
}

function getViolations(cwd) {
  try {
    return readFileSync(join(cwd, '.hive-flow', 'enforcement', 'violations.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

describe('enforcement system', () => {

  it('allows normal tool calls at level 0', () => {
    const cwd = withTempRepo();
    try {
      const r = runEnforcement(cwd, { tool_name: 'Read', tool_input: { file_path: '/tmp/test.ts' } });
      assert.equal(r.json?.decision, 'allow');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('allows Bash at level 0', () => {
    const cwd = withTempRepo();
    try {
      const r = runEnforcement(cwd, { tool_name: 'Bash', tool_input: { command: 'ls -la' } });
      assert.equal(r.json?.decision, 'allow');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('blocks writes to .claude/settings.json as circumvention', () => {
    const cwd = withTempRepo();
    try {
      const r = runEnforcement(cwd, { tool_name: 'Edit', tool_input: { file_path: join(cwd, '.claude/settings.json') } });
      assert.equal(r.json?.decision, 'block');
      assert.match(r.json?.reason, /CIRCUMVENTION/);
      const state = getState(cwd);
      assert.ok(state.level >= 2);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('blocks writes to .claude/helpers/ as circumvention', () => {
    const cwd = withTempRepo();
    try {
      const r = runEnforcement(cwd, { tool_name: 'Write', tool_input: { file_path: join(cwd, '.claude/helpers/enforcement.cjs') } });
      assert.equal(r.json?.decision, 'block');
      assert.match(r.json?.reason, /CIRCUMVENTION/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('blocks writes to .hive-flow/enforcement/ as circumvention', () => {
    const cwd = withTempRepo();
    try {
      const r = runEnforcement(cwd, { tool_name: 'Write', tool_input: { file_path: join(cwd, '.hive-flow/enforcement/state.json') } });
      assert.equal(r.json?.decision, 'block');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('detects obfuscated commands (hex escapes)', () => {
    const cwd = withTempRepo();
    try {
      const r = runEnforcement(cwd, { tool_name: 'Bash', tool_input: { command: 'echo \\x48\\x65\\x6c' } });
      assert.equal(r.json?.decision, 'block');
      assert.match(r.json?.reason, /CIRCUMVENTION/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('detects destructive rm -rf /', () => {
    const cwd = withTempRepo();
    try {
      const r = runEnforcement(cwd, { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
      assert.equal(r.json?.decision, 'block');
      assert.match(r.json?.reason, /destructive/i);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('detects DROP DATABASE', () => {
    const cwd = withTempRepo();
    try {
      const r = runEnforcement(cwd, { tool_name: 'Bash', tool_input: { command: 'psql -c "DROP DATABASE prod"' } });
      assert.equal(r.json?.decision, 'block');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('escalates Normal to Warned on first circumvention', () => {
    const cwd = withTempRepo();
    try {
      setState(cwd, { level: 0, violations: 0, consecutiveDenials: 0, restrictedGroups: [], history: [] });
      runEnforcement(cwd, { tool_name: 'Bash', tool_input: { command: 'echo \\x48' } });
      const state = getState(cwd);
      assert.equal(state.level, 1);
      assert.equal(state.violations, 1);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('escalates Warned to Restricted on second circumvention', () => {
    const cwd = withTempRepo();
    try {
      setState(cwd, { level: 1, violations: 1, consecutiveDenials: 0, restrictedGroups: [], history: [] });
      runEnforcement(cwd, { tool_name: 'Bash', tool_input: { command: 'echo \\x48' } });
      const state = getState(cwd);
      assert.equal(state.level, 2);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('escalates to Restricted immediately for critical violations', () => {
    const cwd = withTempRepo();
    try {
      setState(cwd, { level: 0, violations: 0, consecutiveDenials: 0, restrictedGroups: [], history: [] });
      runEnforcement(cwd, { tool_name: 'Edit', tool_input: { file_path: join(cwd, '.claude/settings.json') } });
      const state = getState(cwd);
      assert.ok(state.level >= 2);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('blocks Bash when exec group is restricted', () => {
    const cwd = withTempRepo();
    try {
      setState(cwd, { level: 2, violations: 2, consecutiveDenials: 0, restrictedGroups: ['exec'], history: [] });
      const r = runEnforcement(cwd, { tool_name: 'Bash', tool_input: { command: 'ls' } });
      assert.equal(r.json?.decision, 'block');
      assert.match(r.json?.reason, /RESTRICTED/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('blocks Write when write group is restricted', () => {
    const cwd = withTempRepo();
    try {
      setState(cwd, { level: 2, violations: 2, consecutiveDenials: 0, restrictedGroups: ['write'], history: [] });
      const r = runEnforcement(cwd, { tool_name: 'Write', tool_input: {} });
      assert.equal(r.json?.decision, 'block');
      assert.match(r.json?.reason, /RESTRICTED/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('always allows Read even at Level 2', () => {
    const cwd = withTempRepo();
    try {
      setState(cwd, { level: 2, violations: 5, consecutiveDenials: 0, restrictedGroups: ['exec', 'write', 'fetch'], history: [] });
      const r = runEnforcement(cwd, { tool_name: 'Read', tool_input: { file_path: '/tmp/test' } });
      assert.equal(r.json?.decision, 'allow');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('always allows Grep even at Level 2', () => {
    const cwd = withTempRepo();
    try {
      setState(cwd, { level: 2, violations: 5, consecutiveDenials: 0, restrictedGroups: ['exec', 'write', 'fetch'], history: [] });
      const r = runEnforcement(cwd, { tool_name: 'Grep', tool_input: { pattern: 'test' } });
      assert.equal(r.json?.decision, 'allow');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('blocks ALL non-read tools at Level 3 (Halted)', () => {
    const cwd = withTempRepo();
    try {
      setState(cwd, { level: 3, violations: 3, consecutiveDenials: 0, restrictedGroups: [], history: [] });
      for (const tool of ['Bash', 'Write', 'Edit', 'WebFetch', 'MultiEdit']) {
        const r = runEnforcement(cwd, { tool_name: tool, tool_input: {} });
        assert.equal(r.json?.decision, 'block', `${tool} should be blocked at level 3`);
        assert.match(r.json?.reason, /HALT/);
      }
      const readResult = runEnforcement(cwd, { tool_name: 'Read', tool_input: {} });
      assert.equal(readResult.json?.decision, 'allow');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('injects warning at Level 1 but allows tool', () => {
    const cwd = withTempRepo();
    try {
      setState(cwd, { level: 1, violations: 1, consecutiveDenials: 0, restrictedGroups: [], history: [] });
      const r = runEnforcement(cwd, { tool_name: 'Bash', tool_input: { command: 'echo hello' } });
      assert.equal(r.json?.decision, 'allow');
      assert.match(r.json?.additionalContext || '', /ENFORCEMENT WARNING/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('detects hung agent after 5 consecutive denials', () => {
    const cwd = withTempRepo();
    try {
      setState(cwd, { level: 2, violations: 2, consecutiveDenials: 4, restrictedGroups: ['exec'], history: [] });
      const r = runEnforcement(cwd, { tool_name: 'Bash', tool_input: { command: 'ls' } });
      assert.equal(r.json?.decision, 'block');
      assert.match(r.json?.reason, /hung/i);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('resets consecutive denials on successful call', () => {
    const cwd = withTempRepo();
    try {
      setState(cwd, { level: 0, violations: 0, consecutiveDenials: 3, restrictedGroups: [], history: [] });
      runEnforcement(cwd, { tool_name: 'Read', tool_input: {} });
      const state = getState(cwd);
      assert.equal(state.consecutiveDenials, 0);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('logs violations to JSONL file', () => {
    const cwd = withTempRepo();
    try {
      runEnforcement(cwd, { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
      const violations = getViolations(cwd);
      assert.ok(violations.length >= 1);
      assert.equal(violations[0].type, 'escalation');
      assert.ok(violations[0].ts);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('allows git commit when no swarm directory exists', () => {
    const cwd = withTempRepo();
    try {
      const r = runEnforcement(cwd, { tool_name: 'Bash', tool_input: { command: 'git commit -m "test"' } });
      assert.equal(r.json?.decision, 'allow');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('blocks git commit when swarm exists but no verification gate', () => {
    const cwd = withTempRepo();
    try {
      mkdirSync(join(cwd, '.hive-flow', 'swarm'), { recursive: true });
      const r = runEnforcement(cwd, { tool_name: 'Bash', tool_input: { command: 'git commit -m "test"' } });
      assert.equal(r.json?.decision, 'block');
      assert.match(r.json?.reason, /VERIFICATION REQUIRED/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('allows git commit when verification gate passes', () => {
    const cwd = withTempRepo();
    try {
      mkdirSync(join(cwd, '.hive-flow', 'swarm'), { recursive: true });
      const enfDir = join(cwd, '.hive-flow', 'enforcement');
      mkdirSync(enfDir, { recursive: true });
      writeFileSync(join(enfDir, 'verification-gate.json'), JSON.stringify({ status: 'pass', timestamp: new Date().toISOString() }));
      const r = runEnforcement(cwd, { tool_name: 'Bash', tool_input: { command: 'git commit -m "verified"' } });
      assert.equal(r.json?.decision, 'allow');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('allows non-git Bash in swarm mode', () => {
    const cwd = withTempRepo();
    try {
      mkdirSync(join(cwd, '.hive-flow', 'swarm'), { recursive: true });
      const r = runEnforcement(cwd, { tool_name: 'Bash', tool_input: { command: 'npm test' } });
      assert.equal(r.json?.decision, 'allow');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('handles empty input gracefully', () => {
    const cwd = withTempRepo();
    try {
      const r = runEnforcement(cwd, {});
      assert.equal(r.json?.decision, 'allow');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('allows rm -rf on non-root paths', () => {
    const cwd = withTempRepo();
    try {
      const r = runEnforcement(cwd, { tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/test-dir' } });
      assert.equal(r.json?.decision, 'allow');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
