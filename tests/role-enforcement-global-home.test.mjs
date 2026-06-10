import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SCRIPT = join(REPO_ROOT, '.claude', 'helpers', 'role-enforcement.cjs');

const tempRoots = [];

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function computeHmac(state, key) {
  return createHmac('sha256', key).update(JSON.stringify(state)).digest('hex');
}

function writeSignedRole(roleFile, state, key) {
  mkdirSync(dirname(roleFile), { recursive: true });
  writeFileSync(roleFile, JSON.stringify({ state, hmac: computeHmac(state, key) }, null, 2));
}

function runRoleHook(input, env) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      HIVE_FLOW_HOME: env.hiveHome,
      CLAUDE_PROJECT_DIR: env.projectDir,
      HIVE_FLOW_PROJECT_ROOT: env.projectDir,
      CLAUDE_AGENT_ID: env.agentId,
      AGENTIC_FLOW_AGENT_ID: '',
      CLAUDE_SESSION_ID: '',
      HIVE_FLOW_AGENT_TOKEN: '',
      HIVE_FLOW_DEV_OVERRIDE: '',
      HIVE_FLOW_DEV_OVERRIDE_TOKEN: '',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim() || '{}');
}

describe('role-enforcement global home storage', () => {
  afterEach(() => {
    for (const dir of tempRoots.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes native task role state and HMAC key under HIVE_FLOW_HOME, not project .hive-flow', () => {
    const hiveHome = makeTempDir('hf-role-global-');
    const projectDir = makeTempDir('hf-role-project-');
    const agentId = 'native-agent-1';

    runRoleHook(
      {
        hook_event_name: 'SubagentStart',
        agent_type: 'general-purpose',
        agent_id: agentId,
        session_id: 'session-1',
      },
      { hiveHome, projectDir, agentId },
    );

    const globalRole = join(hiveHome, 'enforcement', 'agents', agentId, 'role.json');
    const globalKey = join(hiveHome, 'enforcement', '.hmac-key');
    const legacyRole = join(projectDir, '.hive-flow', 'enforcement', 'agents', agentId, 'role.json');
    const legacyKey = join(projectDir, '.hive-flow', 'enforcement', '.hmac-key');

    assert.ok(existsSync(globalRole), 'role.json should be written to HIVE_FLOW_HOME');
    assert.ok(existsSync(globalKey), '.hmac-key should be written to HIVE_FLOW_HOME');
    assert.ok(!existsSync(legacyRole), 'role.json must not be written to project-local enforcement');
    assert.ok(!existsSync(legacyKey), '.hmac-key must not be written to project-local enforcement');

    const envelope = JSON.parse(readFileSync(globalRole, 'utf8'));
    assert.equal(envelope.state.type, 'native-task');
    assert.equal(envelope.state.agentType, 'general-purpose');
  });

  it('loads a legacy project-local advocate role signed by the global HMAC key', () => {
    const hiveHome = makeTempDir('hf-role-global-');
    const projectDir = makeTempDir('hf-role-project-');
    const agentId = 'legacy-advocate';
    const key = randomBytes(32).toString('hex');

    mkdirSync(join(hiveHome, 'enforcement'), { recursive: true });
    writeFileSync(join(hiveHome, 'enforcement', '.hmac-key'), key, { mode: 0o600 });

    writeSignedRole(
      join(projectDir, '.hive-flow', 'enforcement', 'agents', agentId, 'role.json'),
      { type: 'advocate', assignedAt: '2026-06-10T00:00:00.000Z' },
      key,
    );

    const output = runRoleHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'echo should-deny' },
        agent_id: agentId,
      },
      { hiveHome, projectDir, agentId },
    );

    assert.equal(output.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(output.hookSpecificOutput?.permissionDecisionReason || '', /ADVOCATE ENFORCEMENT/);
  });
});
