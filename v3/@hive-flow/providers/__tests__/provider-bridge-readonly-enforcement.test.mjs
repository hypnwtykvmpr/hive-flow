import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
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

function makeProjectRoot(prefix = 'hfmode-enforce-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, '.hive-flow', 'agents'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  return realpathSync.native(root);
}

function writeStore(root, agentId, extra = {}) {
  const storeDir = join(root, '.hive-flow', 'agents');
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, 'store.json'), JSON.stringify({
    version: '3.0.0',
    agents: {
      [agentId]: {
        agentId,
        agentType: 'tester',
        status: 'busy',
        provider: 'deepseek',
        config: {},
        ...extra,
      },
    },
  }, null, 2), 'utf8');
}

function writeLevelZeroEnforcement(root) {
  const enforcementDir = join(root, '.hive-flow', 'enforcement');
  mkdirSync(enforcementDir, { recursive: true });
  const key = randomBytes(32).toString('hex');
  const keyPath = join(enforcementDir, '.hmac-key');
  writeFileSync(keyPath, key, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch { /* best-effort */ }
  const state = {
    level: 0,
    ts: '2026-06-26T00:00:00.000Z',
    violations: 0,
    restrictedGroups: [],
    history: [],
    integrityCompromised: false,
  };
  const envelope = {
    state,
    hmac: createHmac('sha256', key).update(JSON.stringify(state)).digest('hex'),
  };
  writeFileSync(join(enforcementDir, 'state.json'), JSON.stringify(envelope, null, 2), 'utf8');
}

function runTool(root, toolName, toolArgs, { agentId = 'mode-agent' } = {}) {
  const script = `
    const bridge = await import(${JSON.stringify(pathToFileURL(bridgePath).href)});
    const result = await bridge.executeBridgeTool(${JSON.stringify(toolName)}, ${JSON.stringify(toolArgs)}, { source: 'readonly-test' });
    process.stdout.write(JSON.stringify(result));
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
  };
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

describe('provider bridge read-only mode enforcement', () => {
  const roots = [];

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['write_file', { path: 'src/out.txt', content: 'blocked' }],
    ['edit_file', { path: 'src/out.txt', old_string: 'a', new_string: 'b' }],
    ['run_shell', { command: 'pwd' }],
    ['run_command', { command: 'pwd' }],
  ])('denies %s for persisted read-only agents before handler execution', (toolName, toolArgs) => {
    const root = makeProjectRoot('hfmode-ro-deny-');
    roots.push(root);
    writeFileSync(join(root, 'src', 'out.txt'), 'safe', 'utf8');
    writeStore(root, 'mode-agent', { mode: 'read-only' });

    const result = runTool(root, toolName, toolArgs);

    expect(result).toMatchObject({
      status: 'denied',
      denyReason: 'agent-mode-read-only',
      tool: toolName,
    });
    expect(readFileSync(join(root, 'src', 'out.txt'), 'utf8')).toBe('safe');
  });

  it('ignores tool-argument attempts to override persisted read-only mode', () => {
    const root = makeProjectRoot('hfmode-ro-args-forgery-');
    roots.push(root);
    writeFileSync(join(root, 'src', 'out.txt'), 'safe', 'utf8');
    writeStore(root, 'mode-agent', { mode: 'read-only' });

    const result = runTool(root, 'write_file', {
      path: 'src/out.txt',
      content: 'blocked',
      mode: 'full',
      accessMode: 'full',
      agentMode: 'full',
      artifactDir: root,
    });

    expect(result).toMatchObject({
      status: 'denied',
      denyReason: 'agent-mode-read-only',
      tool: 'write_file',
    });
    expect(readFileSync(join(root, 'src', 'out.txt'), 'utf8')).toBe('safe');
  });

  it('leaves read-only safe read tools available', () => {
    const root = makeProjectRoot('hfmode-ro-read-');
    roots.push(root);
    const target = join(root, 'src', 'readme.md');
    writeFileSync(target, 'readable', 'utf8');
    writeStore(root, 'mode-agent', { mode: 'read-only' });

    expect(runTool(root, 'read_file', { path: target })).toBe('readable');
    const listed = runTool(root, 'list_directory', { path: 'src' });
    expect(String(listed)).toContain('readme.md');
  });

  it('leaves full-mode write_file behavior unchanged for untracked project files', () => {
    const root = makeProjectRoot('hfmode-full-');
    roots.push(root);
    writeStore(root, 'mode-agent', { mode: 'full' });
    writeLevelZeroEnforcement(root);
    const target = join(root, 'src', 'out.txt');

    const result = runTool(root, 'write_file', { path: target, content: 'allowed' });

    expect(result).toMatch(/File written:/);
    expect(readFileSync(target, 'utf8')).toBe('allowed');
  });

  it.each([
    ['write_file', { path: 'src/artifact.md', content: '# pending' }, 'agent-mode-artifact-write-pending'],
    ['edit_file', { path: 'src/artifact.md', old_string: 'x', new_string: 'y' }, 'agent-mode-artifact-write-pending'],
    ['run_shell', { command: 'pwd' }, 'agent-mode-artifact-exec-denied'],
    ['run_command', { command: 'pwd' }, 'agent-mode-artifact-exec-denied'],
  ])('fails safe for %s in artifact mode until R3 confinement is active', (toolName, toolArgs, denyReason) => {
    const root = makeProjectRoot('hfmode-artifact-deny-');
    roots.push(root);
    const artifactDir = join(root, '.tmp-audit', 'agent-artifacts');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(root, 'src', 'artifact.md'), 'x', 'utf8');
    writeStore(root, 'mode-agent', {
      mode: 'read-only-with-artifacts',
      artifactDir,
    });

    const result = runTool(root, toolName, toolArgs);

    expect(result).toMatchObject({
      status: 'denied',
      denyReason,
      tool: toolName,
    });
  });
});
