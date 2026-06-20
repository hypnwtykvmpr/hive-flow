// Cluster-1 regression: the provider bridge must read its enforcement state
// from the canonical HIVE_FLOW_HOME layout
// (`<HIVE_FLOW_HOME>/enforcement/global/state.json` + `<HIVE_FLOW_HOME>/enforcement/.hmac-key`),
// matching what `.claude/helpers/enforcement.cjs` and the live strict-provider
// diagnostic actually write. The pre-fix bridge only read the legacy
// project-local layout (`PROJECT_ROOT/.hive-flow/enforcement/state.json`), so in
// external-temp mode — where PROJECT_ROOT (cwd) and HIVE_FLOW_HOME differ — every
// write fail-closed to RESTRICTED+ even though a signed level-0 state existed.
//
// These tests run the bridge as a detached child so the module-level PROJECT_ROOT
// (process.cwd()) and HIVE_FLOW_HOME are captured at import — exactly as in the
// live diagnostic. Writes target the cwd PROJECT_ROOT (bridge path sandbox),
// while the enforcement state lives under a SEPARATE HIVE_FLOW_HOME.

import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = resolve(here, '../scripts/provider-agent-bridge.mjs');

const createdRoots = [];

// realpath the temp dir: on macOS /var/folders is a symlink to /private/var,
// and the bridge resolves PROJECT_ROOT via process.cwd() (realpath). Without
// this, write targets would be flagged as outside the project root.
function makeDir(prefix) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  createdRoots.push(dir);
  return dir;
}

function signState(key, state) {
  return {
    state,
    hmac: createHmac('sha256', key).update(JSON.stringify(state)).digest('hex'),
  };
}

function baseState(level, restrictedGroups = []) {
  return {
    level,
    ts: '2026-06-19T00:00:00.000Z',
    violations: 0,
    restrictedGroups,
    history: [],
    integrityCompromised: false,
  };
}

// Lay out the CANONICAL HIVE_FLOW_HOME enforcement tree:
//   <hiveHome>/enforcement/.hmac-key
//   <hiveHome>/enforcement/global/state.json
function writeCanonicalEnforcement(hiveHome, level, options = {}) {
  const enforcementDir = join(hiveHome, 'enforcement');
  mkdirSync(join(enforcementDir, 'global'), { recursive: true });
  const key = options.key ?? randomBytes(32).toString('hex');
  const keyPath = join(enforcementDir, '.hmac-key');
  writeFileSync(keyPath, key, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch { /* best-effort in tmp fixtures */ }

  const envelope = signState(options.signingKey ?? key, baseState(level, options.restrictedGroups ?? []));
  if (options.tamperHmac) {
    envelope.hmac = `${envelope.hmac.slice(0, -1)}${envelope.hmac.endsWith('0') ? '1' : '0'}`;
  }
  writeFileSync(
    join(enforcementDir, 'global', 'state.json'),
    JSON.stringify(envelope, null, 2),
    'utf8',
  );
  return key;
}

// Run a bridge filesystem tool in a detached child with a chosen
// PROJECT_ROOT (cwd) and HIVE_FLOW_HOME, so module-level consts capture them.
function runBridgeTool({ projectRoot, hiveHome, toolName, toolArgs }) {
  const script = `
    const bridge = await import(${JSON.stringify(pathToFileURL(bridgePath).href)});
    const result = await bridge.executeBridgeFilesystemTool(${JSON.stringify(toolName)}, ${JSON.stringify(toolArgs)});
    process.stdout.write(JSON.stringify(result));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? tmpdir(),
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      HIVE_FLOW_HOME: hiveHome,
      // Intentionally leave PROJECT_ROOT-only context: no legacy enforcement tree
      // under projectRoot. The bridge must honor HIVE_FLOW_HOME instead.
      CLAUDE_PROJECT_DIR: projectRoot,
      HIVE_FLOW_PROJECT_ROOT: projectRoot,
      AGENTIC_FLOW_AGENT_ID: '',
      CLAUDE_AGENT_ID: '',
      HIVE_FLOW_HIVE_ID: '',
    },
  });
  return JSON.parse(output);
}

describe('provider bridge reads enforcement state from HIVE_FLOW_HOME (external-temp parity)', () => {
  afterEach(() => {
    while (createdRoots.length) {
      const dir = createdRoots.pop();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('ALLOWS a write when the signed level-0 state lives in the canonical HIVE_FLOW_HOME layout and PROJECT_ROOT has no legacy state', () => {
    const projectRoot = makeDir('hf-enf-home-proj-');
    const hiveHome = makeDir('hf-enf-home-home-');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeCanonicalEnforcement(hiveHome, 0);

    const target = join(projectRoot, 'src', 'canonical-allowed.txt');
    const result = runBridgeTool({
      projectRoot,
      hiveHome,
      toolName: 'write_file',
      toolArgs: { path: target, content: 'allowed via canonical home\n' },
    });

    // Pre-fix this fail-closed with "Writes blocked at enforcement level RESTRICTED+".
    expect(result).toBe(`File written: ${target}`);
  });

  it('BLOCKS a write when the canonical HIVE_FLOW_HOME state is RESTRICTED (level 2)', () => {
    const projectRoot = makeDir('hf-enf-home-proj-');
    const hiveHome = makeDir('hf-enf-home-home-');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeCanonicalEnforcement(hiveHome, 2);

    const target = join(projectRoot, 'src', 'canonical-restricted.txt');
    const result = runBridgeTool({
      projectRoot,
      hiveHome,
      toolName: 'write_file',
      toolArgs: { path: target, content: 'should be blocked\n' },
    });

    expect(result).toMatchObject({ status: 'error' });
    expect(result.error).toMatch(/RESTRICTED\+/);
  });

  it('FAILS CLOSED when the canonical HIVE_FLOW_HOME state envelope is tampered', () => {
    const projectRoot = makeDir('hf-enf-home-proj-');
    const hiveHome = makeDir('hf-enf-home-home-');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeCanonicalEnforcement(hiveHome, 0, { tamperHmac: true });

    const target = join(projectRoot, 'src', 'canonical-tampered.txt');
    const result = runBridgeTool({
      projectRoot,
      hiveHome,
      toolName: 'write_file',
      toolArgs: { path: target, content: 'must be denied\n' },
    });

    expect(result).toMatchObject({ status: 'error' });
    expect(result.error).toMatch(/RESTRICTED\+/);
  });

  it('FAILS CLOSED when the canonical HIVE_FLOW_HOME state is signed with a forged key', () => {
    const projectRoot = makeDir('hf-enf-home-proj-');
    const hiveHome = makeDir('hf-enf-home-home-');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeCanonicalEnforcement(hiveHome, 0, { signingKey: 'attacker-key' });

    const target = join(projectRoot, 'src', 'canonical-forged.txt');
    const result = runBridgeTool({
      projectRoot,
      hiveHome,
      toolName: 'write_file',
      toolArgs: { path: target, content: 'must be denied\n' },
    });

    expect(result).toMatchObject({ status: 'error' });
    expect(result.error).toMatch(/RESTRICTED\+/);
  });

  // SAME-ROOT regression (Codex no-live probe): HIVE_FLOW_HOME ===
  // PROJECT_ROOT/.hive-flow. Canonical and legacy share the same enforcement
  // `dir`, but the global state filenames differ (canonical `global/state.json`
  // vs legacy `state.json`). The pre-fix `if (canonical.dir === legacy.dir)
  // return [legacy]` collapse skipped the canonical state and fail-closed every
  // write. Only the canonical `global/state.json` exists here (NO legacy
  // `state.json`).
  describe('same-root (HIVE_FLOW_HOME === PROJECT_ROOT/.hive-flow)', () => {
    it('ALLOWS a level-0 write when only the canonical global/state.json exists (no legacy state.json)', () => {
      const projectRoot = makeDir('hf-enf-same-proj-');
      const hiveHome = join(projectRoot, '.hive-flow');
      mkdirSync(join(projectRoot, 'src'), { recursive: true });
      writeCanonicalEnforcement(hiveHome, 0);

      const target = join(projectRoot, 'src', 'same-root-allowed.txt');
      const result = runBridgeTool({
        projectRoot,
        hiveHome,
        toolName: 'write_file',
        toolArgs: { path: target, content: 'allowed same-root canonical\n' },
      });

      // Pre-fix this fail-closed with "Writes blocked at enforcement level RESTRICTED+".
      expect(result).toBe(`File written: ${target}`);
    });

    it('FAILS CLOSED on tamper even when canonical and legacy share the same dir', () => {
      const projectRoot = makeDir('hf-enf-same-proj-');
      const hiveHome = join(projectRoot, '.hive-flow');
      mkdirSync(join(projectRoot, 'src'), { recursive: true });
      writeCanonicalEnforcement(hiveHome, 0, { tamperHmac: true });

      const target = join(projectRoot, 'src', 'same-root-tampered.txt');
      const result = runBridgeTool({
        projectRoot,
        hiveHome,
        toolName: 'write_file',
        toolArgs: { path: target, content: 'must be denied\n' },
      });

      expect(result).toMatchObject({ status: 'error' });
      expect(result.error).toMatch(/RESTRICTED\+/);
    });

    it('FAILS CLOSED on a forged key even when canonical and legacy share the same dir', () => {
      const projectRoot = makeDir('hf-enf-same-proj-');
      const hiveHome = join(projectRoot, '.hive-flow');
      mkdirSync(join(projectRoot, 'src'), { recursive: true });
      writeCanonicalEnforcement(hiveHome, 0, { signingKey: 'attacker-key' });

      const target = join(projectRoot, 'src', 'same-root-forged.txt');
      const result = runBridgeTool({
        projectRoot,
        hiveHome,
        toolName: 'write_file',
        toolArgs: { path: target, content: 'must be denied\n' },
      });

      expect(result).toMatchObject({ status: 'error' });
      expect(result.error).toMatch(/RESTRICTED\+/);
    });
  });

  it('honors per-agent RESTRICTED state under the canonical HIVE_FLOW_HOME layout', () => {
    const projectRoot = makeDir('hf-enf-home-proj-');
    const hiveHome = makeDir('hf-enf-home-home-');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    const key = writeCanonicalEnforcement(hiveHome, 0);

    // Per-agent RESTRICTED state under <hiveHome>/enforcement/agents/<id>/state.json
    const agentDir = join(hiveHome, 'enforcement', 'agents', 'agent-x');
    mkdirSync(agentDir, { recursive: true });
    const agentEnvelope = signState(key, baseState(2, []));
    writeFileSync(join(agentDir, 'state.json'), JSON.stringify(agentEnvelope, null, 2), 'utf8');

    const target = join(projectRoot, 'src', 'canonical-agent.txt');
    const script = `
      const bridge = await import(${JSON.stringify(pathToFileURL(bridgePath).href)});
      const result = await bridge.executeBridgeFilesystemTool('write_file', ${JSON.stringify({ path: target, content: 'agent-blocked\n' })});
      process.stdout.write(JSON.stringify(result));
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? tmpdir(),
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        HIVE_FLOW_HOME: hiveHome,
        CLAUDE_PROJECT_DIR: projectRoot,
        HIVE_FLOW_PROJECT_ROOT: projectRoot,
        AGENTIC_FLOW_AGENT_ID: 'agent-x',
        CLAUDE_AGENT_ID: 'agent-x',
        HIVE_FLOW_HIVE_ID: '',
      },
    });
    const result = JSON.parse(output);
    expect(result).toMatchObject({ status: 'error' });
    expect(result.error).toMatch(/RESTRICTED\+/);
  });
});
