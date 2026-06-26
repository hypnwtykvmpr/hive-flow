import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = resolve(here, '../scripts/provider-agent-bridge.mjs');

function makeProjectRoot(prefix = 'hfmode-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, '.hive-flow', 'agents'), { recursive: true });
  return realpathSync.native(root);
}

function writeStore(root, agents) {
  const storeDir = join(root, '.hive-flow', 'agents');
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, 'store.json'), JSON.stringify({
    version: '3.0.0',
    agents,
  }, null, 2), 'utf8');
}

function runReader(root, { agentId = 'mode-agent', extraEnv = {} } = {}) {
  const script = `
    const bridge = await import(${JSON.stringify(pathToFileURL(bridgePath).href)});
    process.stdout.write(JSON.stringify(bridge.bridgeReadAgentMode()));
  `;
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    HIVE_FLOW_HOME: join(root, '.hive-flow'),
    HIVE_FLOW_PROJECT_ROOT: root,
    CLAUDE_PROJECT_DIR: root,
    HIVE_FLOW_AGENT_ID: agentId,
    CLAUDE_AGENT_ID: agentId,
    HIVE_FLOW_MODE: 'full',
    ...extraEnv,
  };
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

describe('provider bridge persisted agent mode reader', () => {
  const roots = [];

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('treats legacy records without mode as full', () => {
    const root = makeProjectRoot('hfmode-legacy-');
    roots.push(root);
    writeStore(root, {
      'mode-agent': {
        agentId: 'mode-agent',
        agentType: 'tester',
        status: 'busy',
        config: {},
      },
    });

    expect(runReader(root)).toEqual({ mode: 'full' });
  });

  it('reads persisted read-only and ignores ambient env mode', () => {
    const root = makeProjectRoot('hfmode-ro-');
    roots.push(root);
    writeStore(root, {
      'mode-agent': {
        agentId: 'mode-agent',
        agentType: 'tester',
        status: 'busy',
        config: { mode: 'full' },
        mode: 'read-only',
      },
    });

    expect(runReader(root, { extraEnv: { HIVE_FLOW_MODE: 'full' } })).toEqual({ mode: 'read-only' });
  });

  it('reads and canonicalizes a valid artifact mode directory', () => {
    const root = makeProjectRoot('hfmode-artifact-');
    roots.push(root);
    const artifactDir = join(root, '.tmp-audit', 'agent-artifacts');
    mkdirSync(artifactDir, { recursive: true });
    writeStore(root, {
      'mode-agent': {
        agentId: 'mode-agent',
        agentType: 'tester',
        status: 'busy',
        config: {},
        mode: 'read-only-with-artifacts',
        artifactDir,
      },
    });

    expect(runReader(root)).toEqual({
      mode: 'read-only-with-artifacts',
      artifactDir: realpathSync.native(artifactDir),
    });
  });

  it.each([
    ['missing agent id', {}, { HIVE_FLOW_AGENT_ID: '', CLAUDE_AGENT_ID: '' }, 'missing-agent-id'],
    ['missing store', null, {}, 'missing-agent-store'],
    ['missing record', {}, { HIVE_FLOW_AGENT_ID: 'missing', CLAUDE_AGENT_ID: 'missing' }, 'missing-agent-record'],
  ])('treats legacy/non-agent state %s as full because read-only is explicit opt-in', (_label, agents, extraEnv, reason) => {
    const root = makeProjectRoot('hfmode-legacy-default-');
    roots.push(root);
    if (agents === null) {
      rmSync(join(root, '.hive-flow', 'agents', 'store.json'), { force: true });
    } else if (agents) {
      writeStore(root, agents);
    } else if (!existsSync(join(root, '.hive-flow', 'agents', 'store.json'))) {
      writeStore(root, {});
    }

    expect(runReader(root, { extraEnv })).toEqual({ mode: 'full', reason });
  });

  it.each([
    ['malformed mode', { 'mode-agent': { agentId: 'mode-agent', mode: 'admin', config: {} } }, {}, undefined],
    ['artifact mode without valid dir', { 'mode-agent': { agentId: 'mode-agent', mode: 'read-only-with-artifacts', artifactDir: join(tmpdir(), 'outside') } }, {}, 'invalid-artifact-dir'],
  ])('fails closed for malformed known records: %s', (_label, agents, extraEnv, reason) => {
    const root = makeProjectRoot('hfmode-closed-');
    roots.push(root);
    writeStore(root, agents);

    const result = runReader(root, { extraEnv });
    expect(result.mode).toBe('read-only');
    if (reason) expect(result.reason).toBe(reason);
  });

  it('fails closed when the store JSON is unreadable', () => {
    const root = makeProjectRoot('hfmode-badjson-');
    roots.push(root);
    writeFileSync(join(root, '.hive-flow', 'agents', 'store.json'), '{not-json', 'utf8');

    expect(runReader(root)).toEqual({
      mode: 'read-only',
      reason: 'agent-mode-read-failed',
    });
  });
});
