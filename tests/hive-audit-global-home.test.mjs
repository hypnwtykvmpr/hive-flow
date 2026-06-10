import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const HIVE_ENFORCEMENT = join(REPO_ROOT, '.claude', 'helpers', 'hive-enforcement.cjs');
const HIVE_WATCHER = join(REPO_ROOT, 'scripts', 'hive-watcher.cjs');
const HOOK_HANDLER = join(REPO_ROOT, '.claude', 'helpers', 'hook-handler.cjs');

const tempRoots = [];

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function readJsonl(filePath) {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function writeJsonl(filePath, rows) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
}

function runNode(args, { hiveHome, projectDir, timeout = 15_000 }) {
  return spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      HIVE_FLOW_HOME: hiveHome,
      CLAUDE_PROJECT_DIR: projectDir,
      HIVE_FLOW_PROJECT_ROOT: projectDir,
      CLAUDE_SESSION_ID: '',
    },
  });
}

function seedWaitingForHive(projectDir, hiveId) {
  const statePath = join(projectDir, '.hive-flow', 'data', 'advocate-state.json');
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({
    state: 'waiting-for-hive',
    updatedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    description: `Hive dispatched: ${hiveId}`,
  }, null, 2));
}

function runWakeTimer({ hiveHome, projectDir }) {
  const result = runNode([HOOK_HANDLER, 'wake-timer'], { hiveHome, projectDir });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim() || '{}');
}

describe('hive audit global home', () => {
  afterEach(() => {
    for (const dir of tempRoots.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hive-enforcement appendAuditLog writes hive audit under HIVE_FLOW_HOME, not project .hive-flow', () => {
    const hiveHome = makeTempDir('hf-hive-audit-home-');
    const projectDir = makeTempDir('hf-hive-audit-project-');

    const result = runNode(['-e',
      `require(${JSON.stringify(HIVE_ENFORCEMENT)}).appendAuditLog({ event: 'writer-test', hiveId: 'hive-a' })`,
    ], { hiveHome, projectDir });

    assert.equal(result.status, 0, result.stderr);

    const globalAudit = join(hiveHome, 'enforcement', 'hive-audit.jsonl');
    const legacyAudit = join(projectDir, '.hive-flow', 'enforcement', 'hive-audit.jsonl');

    assert.ok(existsSync(globalAudit), 'hive audit should be written under HIVE_FLOW_HOME');
    assert.ok(!existsSync(legacyAudit), 'hive audit must not be written to project-local enforcement');

    const last = readJsonl(globalAudit).at(-1);
    assert.equal(last.event, 'writer-test');
    assert.equal(last.hiveId, 'hive-a');
  });

  it('hive-watcher writes startup hive audit under HIVE_FLOW_HOME, not project .hive-flow', () => {
    const hiveHome = makeTempDir('hf-hive-audit-home-');
    const projectDir = makeTempDir('hf-hive-audit-project-');

    runNode([HIVE_WATCHER, 'hive-b', '--project-dir', projectDir], {
      hiveHome,
      projectDir,
      timeout: 3_000,
    });

    const globalAudit = join(hiveHome, 'enforcement', 'hive-audit.jsonl');
    const legacyAudit = join(projectDir, '.hive-flow', 'enforcement', 'hive-audit.jsonl');

    assert.ok(existsSync(globalAudit), 'watcher startup audit should be written under HIVE_FLOW_HOME');
    assert.ok(!existsSync(legacyAudit), 'watcher startup audit must not be written to project-local enforcement');

    const rows = readJsonl(globalAudit);
    assert.ok(rows.some(row => row.event === 'watcher-started' && row.hiveId === 'hive-b'));
  });

  it('hook-handler wake timer reads global audit and legacy audit during migration', () => {
    const hiveHome = makeTempDir('hf-hive-audit-home-');
    const globalProjectDir = makeTempDir('hf-hive-audit-project-');
    const globalAudit = join(hiveHome, 'enforcement', 'hive-audit.jsonl');

    seedWaitingForHive(globalProjectDir, 'hive-c');
    writeJsonl(globalAudit, [
      { timestamp: new Date().toISOString(), event: 'watcher-hive-complete', hiveId: 'hive-c' },
    ]);

    const globalResult = runWakeTimer({ hiveHome, projectDir: globalProjectDir });
    assert.match(
      globalResult.hookSpecificOutput?.additionalContext || '',
      /hive\(s\) completed/,
      'wake timer should detect global hive-audit completion',
    );

    const legacyHiveHome = makeTempDir('hf-hive-audit-home-');
    const legacyProjectDir = makeTempDir('hf-hive-audit-project-');
    const legacyAudit = join(legacyProjectDir, '.hive-flow', 'enforcement', 'hive-audit.jsonl');

    seedWaitingForHive(legacyProjectDir, 'hive-d');
    writeJsonl(legacyAudit, [
      { timestamp: new Date().toISOString(), event: 'watcher-hive-complete', hiveId: 'hive-d' },
    ]);

    const legacyResult = runWakeTimer({ hiveHome: legacyHiveHome, projectDir: legacyProjectDir });
    assert.match(
      legacyResult.hookSpecificOutput?.additionalContext || '',
      /hive\(s\) completed/,
      'wake timer should still detect legacy project-local hive-audit completion',
    );
  });
});
