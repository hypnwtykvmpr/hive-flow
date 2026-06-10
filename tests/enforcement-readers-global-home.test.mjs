import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const HIVE_ENFORCEMENT = join(REPO_ROOT, '.claude', 'helpers', 'hive-enforcement.cjs');
const ENFORCER_SPAWN = join(REPO_ROOT, '.claude', 'helpers', 'enforcer-spawn.cjs');
const STOP_GUARD = join(REPO_ROOT, '.claude', 'helpers', 'stop-guard.cjs');
const STATUSLINE = join(REPO_ROOT, '.claude', 'helpers', 'statusline.cjs');

const tempRoots = [];

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function signState(state, key) {
  return {
    state,
    hmac: crypto.createHmac('sha256', key).update(JSON.stringify(state)).digest('hex'),
  };
}

function writeSignedState(stateFile, keyFile, state, key = 'slice4-test-key') {
  mkdirSync(dirname(stateFile), { recursive: true });
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, key);
  writeFileSync(stateFile, JSON.stringify(signState(state, key), null, 2));
}

function runNode(args, { hiveHome, projectDir, cwd = REPO_ROOT, input = '', timeout = 15_000 }) {
  return spawnSync(process.execPath, args, {
    cwd,
    input,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      HIVE_FLOW_HOME: hiveHome,
      CLAUDE_PROJECT_DIR: projectDir,
      HIVE_FLOW_PROJECT_ROOT: projectDir,
      CLAUDE_SESSION_ID: '',
      AGENTIC_FLOW_AGENT_ID: '',
      CLAUDE_AGENT_ID: '',
      HIVE_FLOW_HIVE_ID: '',
    },
  });
}

function runReadEnforcementLevel(modulePath, { hiveHome, projectDir }) {
  const result = runNode(['-e',
    `const mod = require(${JSON.stringify(modulePath)}); if (typeof mod.readEnforcementLevel !== 'function') throw new Error('missing readEnforcementLevel export'); process.stdout.write(String(mod.readEnforcementLevel()));`,
  ], { hiveHome, projectDir });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return Number(result.stdout.trim());
}

function copyHelperToProject(source, projectDir) {
  const dest = join(projectDir, '.claude', 'helpers', source.split('/').at(-1));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(source, dest);
  return dest;
}

function writeTranscript(projectDir, text) {
  const transcriptPath = join(projectDir, 'transcript.jsonl');
  writeFileSync(transcriptPath, `${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  })}\n`);
  return transcriptPath;
}

describe('enforcement readers global home', () => {
  afterEach(() => {
    for (const dir of tempRoots.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hive-enforcement reads HALTED from global state and legacy fallback', () => {
    const hiveHome = makeTempDir('hf-reader-home-');
    const projectDir = makeTempDir('hf-reader-project-');
    const halted = { level: 3, authorized: true };

    writeSignedState(
      join(hiveHome, 'enforcement', 'global', 'state.json'),
      join(hiveHome, 'enforcement', '.hmac-key'),
      halted,
    );
    assert.equal(runReadEnforcementLevel(HIVE_ENFORCEMENT, { hiveHome, projectDir }), 3);

    const legacyHiveHome = makeTempDir('hf-reader-home-');
    const legacyProjectDir = makeTempDir('hf-reader-project-');
    writeSignedState(
      join(legacyProjectDir, '.hive-flow', 'enforcement', 'state.json'),
      join(legacyProjectDir, '.hive-flow', 'enforcement', '.hmac-key'),
      halted,
    );
    assert.equal(runReadEnforcementLevel(HIVE_ENFORCEMENT, { hiveHome: legacyHiveHome, projectDir: legacyProjectDir }), 3);
  });

  it('enforcer-spawn reads HALTED from global state and legacy fallback', () => {
    const hiveHome = makeTempDir('hf-reader-home-');
    const projectDir = makeTempDir('hf-reader-project-');
    const copiedSpawn = copyHelperToProject(ENFORCER_SPAWN, projectDir);
    const halted = { level: 3, authorized: true };

    writeSignedState(
      join(hiveHome, 'enforcement', 'global', 'state.json'),
      join(hiveHome, 'enforcement', '.hmac-key'),
      halted,
    );
    assert.equal(runReadEnforcementLevel(copiedSpawn, { hiveHome, projectDir }), 3);

    const legacyHiveHome = makeTempDir('hf-reader-home-');
    const legacyProjectDir = makeTempDir('hf-reader-project-');
    const legacyCopiedSpawn = copyHelperToProject(ENFORCER_SPAWN, legacyProjectDir);
    writeSignedState(
      join(legacyProjectDir, '.hive-flow', 'enforcement', 'state.json'),
      join(legacyProjectDir, '.hive-flow', 'enforcement', '.hmac-key'),
      halted,
    );
    assert.equal(runReadEnforcementLevel(legacyCopiedSpawn, { hiveHome: legacyHiveHome, projectDir: legacyProjectDir }), 3);
  });

  it('stop-guard treats globally authorized plan state as active', () => {
    const hiveHome = makeTempDir('hf-reader-home-');
    const projectDir = makeTempDir('hf-reader-project-');
    const copiedStopGuard = copyHelperToProject(STOP_GUARD, projectDir);
    const transcriptPath = writeTranscript(projectDir, 'Should I continue?');

    writeSignedState(
      join(hiveHome, 'enforcement', 'global', 'state.json'),
      join(hiveHome, 'enforcement', '.hmac-key'),
      { level: 1, authorized: true },
    );

    const result = runNode([copiedStopGuard], {
      hiveHome,
      projectDir,
      input: JSON.stringify({ transcript_path: transcriptPath }),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /STOP-GUARD INTERCEPT/);
    assert.ok(
      !existsSync(join(projectDir, '.hive-flow', 'enforcement', 'state.json')),
      'test should not rely on project-local stop-guard state',
    );
  });

  it('statusline reports global scoped enforcement level from any cwd', () => {
    const hiveHome = makeTempDir('hf-reader-home-');
    const foreignCwd = makeTempDir('hf-reader-foreign-cwd-');

    writeSignedState(
      join(hiveHome, 'enforcement', 'global', 'state.json'),
      join(hiveHome, 'enforcement', '.hmac-key'),
      { level: 1 },
    );
    writeSignedState(
      join(hiveHome, 'enforcement', 'sessions', 'session-a', 'state.json'),
      join(hiveHome, 'enforcement', '.hmac-key'),
      { level: 2 },
    );

    const result = runNode([STATUSLINE, '--json'], {
      hiveHome,
      projectDir: foreignCwd,
      cwd: foreignCwd,
      input: JSON.stringify({ session_id: 'session-a' }),
    });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.enforcement.level, 2);
    assert.equal(parsed.enforcement.label, 'Restricted');
  });
});
