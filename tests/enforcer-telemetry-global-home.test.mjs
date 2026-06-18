import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const AGENT_ACTIVITY_LOGGER = join(REPO_ROOT, '.claude', 'helpers', 'agent-activity-logger.cjs');
const ACTIVITY_LOGGER = join(REPO_ROOT, '.claude', 'helpers', 'enforcer-activity-logger.cjs');
const MONITOR = join(REPO_ROOT, '.claude', 'helpers', 'enforcer-monitor.cjs');
const ROLE_ENFORCEMENT = join(REPO_ROOT, '.claude', 'helpers', 'role-enforcement.cjs');
const PROTECTED_PATHS = join(REPO_ROOT, 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs');
const PROTECTED_PATHS_POLICY = join(REPO_ROOT, 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.policy.json');

const tempRoots = [];

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function runHook(script, input, { hiveHome, projectDir, agentId = 'queen-1' }) {
  const result = spawnSync(process.execPath, [script], {
    cwd: REPO_ROOT,
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      HIVE_FLOW_HOME: hiveHome,
      CLAUDE_PROJECT_DIR: projectDir,
      HIVE_FLOW_PROJECT_ROOT: projectDir,
      AGENTIC_FLOW_AGENT_ID: agentId,
      CLAUDE_AGENT_ID: '',
      CLAUDE_SESSION_ID: '',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim() || '{}');
}

function installAgentActivityHook(projectDir) {
  const helperDir = join(projectDir, '.claude', 'helpers');
  const policyDir = join(projectDir, 'v3', '@hive-flow', 'cli', 'src', 'permission-guard');
  mkdirSync(helperDir, { recursive: true });
  mkdirSync(policyDir, { recursive: true });
  copyFileSync(AGENT_ACTIVITY_LOGGER, join(helperDir, 'agent-activity-logger.cjs'));
  copyFileSync(ROLE_ENFORCEMENT, join(helperDir, 'role-enforcement.cjs'));
  copyFileSync(PROTECTED_PATHS, join(policyDir, 'protected-paths.cjs'));
  copyFileSync(PROTECTED_PATHS_POLICY, join(policyDir, 'protected-paths.policy.json'));
  return join(helperDir, 'agent-activity-logger.cjs');
}

function writeJsonl(filePath, rows) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
}

function writeSignedRole(hiveHome, agentId, state) {
  const key = 'enforcer-telemetry-test-key';
  const keyPath = join(hiveHome, 'enforcement', '.hmac-key');
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, key, { mode: 0o600 });
  const roleFile = join(hiveHome, 'enforcement', 'agents', agentId, 'role.json');
  mkdirSync(dirname(roleFile), { recursive: true });
  writeFileSync(roleFile, JSON.stringify({
    state,
    hmac: createHmac('sha256', key).update(JSON.stringify(state)).digest('hex'),
  }, null, 2));
}

describe('enforcer telemetry global home', () => {
  afterEach(() => {
    for (const dir of tempRoots.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('activity logger writes enforcer activity under HIVE_FLOW_HOME, not project .hive-flow', () => {
    const hiveHome = makeTempDir('hf-enforcer-telemetry-home-');
    const projectDir = makeTempDir('hf-enforcer-telemetry-project-');
    const agentId = 'queen-logger';

    writeSignedRole(hiveHome, agentId, { type: 'queen', hiveId: 'hive-a' });

    runHook(ACTIVITY_LOGGER, { tool_name: 'Bash' }, { hiveHome, projectDir, agentId });

    const globalActivity = join(hiveHome, 'enforcement', 'enforcer-activity.jsonl');
    const legacyActivity = join(projectDir, '.hive-flow', 'enforcement', 'enforcer-activity.jsonl');

    assert.ok(existsSync(globalActivity), 'activity should be written under HIVE_FLOW_HOME');
    assert.ok(!existsSync(legacyActivity), 'activity must not be written to project-local enforcement');

    const row = JSON.parse(readFileSync(globalActivity, 'utf8').trim());
    assert.equal(row.event, 'direct-work');
    assert.equal(row.agentId, agentId);
    assert.equal(row.hiveId, 'hive-a');
  });

  it('activity logger ignores tampered role envelopes instead of trusting fast-peek metadata', () => {
    const hiveHome = makeTempDir('hf-enforcer-telemetry-home-');
    const projectDir = makeTempDir('hf-enforcer-telemetry-project-');
    const agentId = 'queen-tampered';

    const globalRole = join(hiveHome, 'enforcement', 'agents', agentId, 'role.json');
    mkdirSync(dirname(globalRole), { recursive: true });
    writeFileSync(globalRole, JSON.stringify({
      state: { type: 'queen', hiveId: 'forged-hive' },
      hmac: '0'.repeat(64),
    }, null, 2));

    runHook(ACTIVITY_LOGGER, { tool_name: 'mcp__hive-flow__queen_task_worker' }, { hiveHome, projectDir, agentId });

    const row = JSON.parse(readFileSync(join(hiveHome, 'enforcement', 'enforcer-activity.jsonl'), 'utf8').trim());
    assert.equal(row.event, 'delegation');
    assert.equal(row.agentId, agentId);
    assert.equal(row.hiveId, null);
  });

  it('agent activity logger reads role metadata only through the HMAC-verified loader', () => {
    const hiveHome = makeTempDir('hf-agent-activity-home-');
    const projectDir = makeTempDir('hf-agent-activity-project-');
    const script = installAgentActivityHook(projectDir);
    const agentId = 'agent-activity-tampered';
    const roleFile = join(hiveHome, 'enforcement', 'agents', agentId, 'role.json');
    mkdirSync(dirname(roleFile), { recursive: true });
    writeFileSync(roleFile, JSON.stringify({
      state: { type: 'queen', hiveId: 'forged-agent-hive' },
      hmac: '0'.repeat(64),
    }, null, 2));

    runHook(script, { tool_name: 'Bash', tool_input: { command: 'echo ok' } }, { hiveHome, projectDir, agentId });

    const row = JSON.parse(readFileSync(join(projectDir, '.hive-flow', 'logs', 'activity.jsonl'), 'utf8').trim());
    assert.equal(row.agentId, agentId);
    assert.equal(row.hiveId, null);
    assert.equal(row.role, null);
  });

  it('monitor reads global activity and writes reports under HIVE_FLOW_HOME, not project .hive-flow', () => {
    const hiveHome = makeTempDir('hf-enforcer-telemetry-home-');
    const projectDir = makeTempDir('hf-enforcer-telemetry-project-');
    const agentId = 'queen-monitor';
    const now = new Date().toISOString();

    writeJsonl(join(hiveHome, 'enforcement', 'enforcer-activity.jsonl'), [
      { ts: now, timestamp: now, event: 'delegation', agentId },
    ]);

    const report = runHook(MONITOR, { hours: 1 }, { hiveHome, projectDir, agentId });

    const globalReports = join(hiveHome, 'enforcement', 'enforcer-reports.jsonl');
    const legacyReports = join(projectDir, '.hive-flow', 'enforcement', 'enforcer-reports.jsonl');

    assert.ok(existsSync(globalReports), 'reports should be written under HIVE_FLOW_HOME');
    assert.ok(!existsSync(legacyReports), 'reports must not be written to project-local enforcement');
    assert.equal(report.perQueen[0].queenId, agentId);
    assert.equal(report.perQueen[0].delegation, 1);
  });

  it('monitor merges recent global and legacy activity during migration', () => {
    const hiveHome = makeTempDir('hf-enforcer-telemetry-home-');
    const projectDir = makeTempDir('hf-enforcer-telemetry-project-');
    const copiedMonitor = join(projectDir, '.claude', 'helpers', 'enforcer-monitor.cjs');
    const agentId = 'queen-merge';
    const now = new Date().toISOString();

    mkdirSync(dirname(copiedMonitor), { recursive: true });
    copyFileSync(MONITOR, copiedMonitor);
    writeJsonl(join(hiveHome, 'enforcement', 'enforcer-activity.jsonl'), [
      { ts: now, timestamp: now, event: 'delegation', agentId },
    ]);
    writeJsonl(join(projectDir, '.hive-flow', 'enforcement', 'enforcer-activity.jsonl'), [
      { ts: now, timestamp: now, event: 'direct-work', agentId },
    ]);

    const report = runHook(copiedMonitor, { hours: 1 }, { hiveHome, projectDir, agentId });
    const queen = report.perQueen.find(entry => entry.queenId === agentId);

    assert.ok(queen, 'expected merged queen report entry');
    assert.equal(queen.delegation, 1);
    assert.equal(queen.direct, 1);
  });

  it('monitor deduplicates the same activity replayed through global and legacy stores', () => {
    const hiveHome = makeTempDir('hf-enforcer-telemetry-home-');
    const projectDir = makeTempDir('hf-enforcer-telemetry-project-');
    const copiedMonitor = join(projectDir, '.claude', 'helpers', 'enforcer-monitor.cjs');
    const agentId = 'queen-dedupe';
    const now = new Date().toISOString();
    const row = { ts: now, timestamp: now, event: 'delegation', agentId };

    mkdirSync(dirname(copiedMonitor), { recursive: true });
    copyFileSync(MONITOR, copiedMonitor);
    writeJsonl(join(hiveHome, 'enforcement', 'enforcer-activity.jsonl'), [row]);
    writeJsonl(join(projectDir, '.hive-flow', 'enforcement', 'enforcer-activity.jsonl'), [row]);

    const report = runHook(copiedMonitor, { hours: 1 }, { hiveHome, projectDir, agentId });
    const queen = report.perQueen.find(entry => entry.queenId === agentId);

    assert.ok(queen, 'expected deduped queen report entry');
    assert.equal(queen.delegation, 1);
    assert.equal(queen.direct, 0);
  });
});
