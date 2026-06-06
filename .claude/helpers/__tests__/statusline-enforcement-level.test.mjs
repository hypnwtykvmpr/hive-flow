import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const STATUSLINE = join(REPO_ROOT, '.claude', 'helpers', 'statusline.cjs');

const cleanupPaths = [];

afterEach(() => {
  while (cleanupPaths.length) {
    rmSync(cleanupPaths.pop(), { recursive: true, force: true });
  }
});

function makeProject() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'hf-statusline-enforcement-'));
  cleanupPaths.push(projectRoot);
  return projectRoot;
}

function projectScopeId(projectRoot) {
  return `project-${createHash('sha256').update(projectRoot).digest('hex').slice(0, 16)}`;
}

function writeStateFile(projectRoot, relativePath, payload) {
  const filePath = join(projectRoot, '.hive-flow', 'enforcement', ...relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function writeRawStateFile(projectRoot, relativePath, content) {
  const filePath = join(projectRoot, '.hive-flow', 'enforcement', ...relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function writeSignedEnvelope(projectRoot, relativePath, level) {
  writeStateFile(projectRoot, relativePath, {
    state: { level, violations: level > 0 ? 1 : 0 },
    hmac: `test-hmac-${level}`,
  });
}

function renderStatuslineJson(projectRoot, env = {}) {
  const result = spawnSync(process.execPath, [STATUSLINE, '--json'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      ...env,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

describe('statusline enforcement level display', () => {
  it('reads the global signed envelope level instead of falling back to Normal', () => {
    const projectRoot = makeProject();
    writeSignedEnvelope(projectRoot, ['state.json'], 2);

    const rendered = renderStatuslineJson(projectRoot);

    assert.deepEqual(rendered.enforcement, { level: 2, label: 'Restricted' });
  });

  it('maps Halted from a signed envelope and handles missing or garbled files as Normal', () => {
    const missingRoot = makeProject();
    assert.deepEqual(renderStatuslineJson(missingRoot).enforcement, { level: 0, label: 'Normal' });

    const garbledRoot = makeProject();
    writeRawStateFile(garbledRoot, ['state.json'], '{not-json');
    assert.deepEqual(renderStatuslineJson(garbledRoot).enforcement, { level: 0, label: 'Normal' });

    const haltedRoot = makeProject();
    writeSignedEnvelope(haltedRoot, ['state.json'], 3);
    assert.deepEqual(renderStatuslineJson(haltedRoot).enforcement, { level: 3, label: 'Halted' });
  });

  it('renders the maximum effective level across global, project, session, agent, and hive scopes', () => {
    const projectRoot = makeProject();
    writeSignedEnvelope(projectRoot, ['state.json'], 0);
    writeSignedEnvelope(projectRoot, ['projects', projectScopeId(projectRoot), 'state.json'], 1);
    writeSignedEnvelope(projectRoot, ['sessions', 'session-1', 'state.json'], 2);
    writeSignedEnvelope(projectRoot, ['agents', 'agent-1', 'state.json'], 3);
    writeSignedEnvelope(projectRoot, ['hives', 'hive-1', 'state.json'], 1);

    const rendered = renderStatuslineJson(projectRoot, {
      CLAUDE_SESSION_ID: 'session-1',
      CLAUDE_AGENT_ID: 'agent-1',
      HIVE_FLOW_HIVE_ID: 'hive-1',
    });

    assert.deepEqual(rendered.enforcement, { level: 3, label: 'Halted' });
  });
});
