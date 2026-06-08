import { describe, expect, it, afterEach } from 'vitest';
import fc from 'fast-check';
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
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
const gatePath = resolve(here, '../../cli/dist/src/permission-guard/gate.js');

const previousEnv = {
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
  AGENTIC_FLOW_AGENT_ID: process.env.AGENTIC_FLOW_AGENT_ID,
  CLAUDE_AGENT_ID: process.env.CLAUDE_AGENT_ID,
  HIVE_FLOW_HIVE_ID: process.env.HIVE_FLOW_HIVE_ID,
  HIVE_FLOW_DEV_OVERRIDE_TOKEN: process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN,
  HIVE_FLOW_DEV_OVERRIDE: process.env.HIVE_FLOW_DEV_OVERRIDE,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreProcessListeners(event, preserved) {
  const keep = new Set(preserved);
  for (const listener of process.listeners(event)) {
    if (!keep.has(listener)) {
      process.off(event, listener);
    }
  }
}

function makeProjectRoot(prefix = 'hf-run-shell-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, '.hive-flow', 'enforcement'), { recursive: true });
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  return realpathSync.native(root);
}

function writeKey(root, key = randomBytes(32).toString('hex')) {
  const keyPath = join(root, '.hive-flow', 'enforcement', '.hmac-key');
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, key, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch { /* best-effort in tmp fixtures */ }
  return key;
}

function writeEnvelope(root, key, level, restrictedGroups = []) {
  const state = {
    level,
    ts: '2026-06-08T00:00:00.000Z',
    violations: 0,
    restrictedGroups,
    history: [],
    integrityCompromised: false,
  };
  const envelope = {
    state,
    hmac: createHmac('sha256', key).update(JSON.stringify(state)).digest('hex'),
  };
  const statePath = join(root, '.hive-flow', 'enforcement', 'state.json');
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(envelope, null, 2), 'utf8');
}

async function importBridgeForRoot(root) {
  const previousCwd = process.cwd();
  const sigtermListeners = process.listeners('SIGTERM');
  const uncaughtExceptionListeners = process.listeners('uncaughtException');
  process.chdir(root);
  process.env.CLAUDE_PROJECT_DIR = root;
  process.env.AGENTIC_FLOW_AGENT_ID = '';
  process.env.CLAUDE_AGENT_ID = '';
  process.env.HIVE_FLOW_HIVE_ID = '';
  delete process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN;
  delete process.env.HIVE_FLOW_DEV_OVERRIDE;
  try {
    return await import(`${pathToFileURL(bridgePath).href}?run_shell=${Date.now()}-${Math.random()}`);
  } finally {
    process.chdir(previousCwd);
    restoreProcessListeners('SIGTERM', sigtermListeners);
    restoreProcessListeners('uncaughtException', uncaughtExceptionListeners);
  }
}

function decodeToolResult(result) {
  if (typeof result !== 'string') return result;
  return JSON.parse(result);
}

async function makeBridge(level = 0, restrictedGroups = []) {
  const root = makeProjectRoot();
  const key = writeKey(root);
  writeEnvelope(root, key, level, restrictedGroups);
  const bridge = await importBridgeForRoot(root);
  return { root, bridge };
}

function evaluateRunShellInChild(root, toolArgs, ctx = {}) {
  const script = `
    const bridge = await import(${JSON.stringify(pathToFileURL(bridgePath).href + `?child=${Date.now()}-${Math.random()}`)});
    const result = await bridge.evaluateToolCall('run_shell', ${JSON.stringify(toolArgs)}, ${JSON.stringify(ctx)});
    process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result));
  `;
  const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? tmpdir(),
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      CLAUDE_PROJECT_DIR: root,
      AGENTIC_FLOW_AGENT_ID: '',
      CLAUDE_AGENT_ID: '',
      HIVE_FLOW_HIVE_ID: '',
    },
    encoding: 'utf8',
  });
  return JSON.parse(raw);
}

describe('provider bridge run_shell contract', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('executes a simple argv command inside the sandbox and returns the PR2.7 result contract', async () => {
    const { root, bridge } = await makeBridge(0);
    try {
      const result = decodeToolResult(await bridge.evaluateToolCall('run_shell', {
        argv: ['node', '--version'],
      }));

      expect(result).toMatchObject({
        status: 'executed',
        exitCode: 0,
        timedOut: false,
        truncated: false,
      });
      expect(result).not.toHaveProperty('denyReason');
      expect(result.stdout).toMatch(/^v\d+\./);
      expect(result.stderr).toBe('');
      expect(result.sandboxBackend).toMatch(/^(sandbox-exec|bwrap|container)$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('denies at RESTRICTED when either exec or write is restricted, before sandbox execution', async () => {
    for (const restrictedGroups of [['exec'], ['write']]) {
      const { root, bridge } = await makeBridge(0, restrictedGroups);
      try {
        const result = decodeToolResult(await bridge.evaluateToolCall('run_shell', {
          argv: ['node', '--version'],
        }, { sandboxOptions: { backendOrder: [] } }));

        expect(result).toMatchObject({
          status: 'denied',
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          truncated: false,
          sandboxBackend: null,
        });
        expect(result.denyReason).toMatch(/restricted (exec|write)|RESTRICTED/i);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('fails closed as denied when no sandbox backend verifies', async () => {
    const { root, bridge } = await makeBridge(0);
    try {
      const result = decodeToolResult(await bridge.evaluateToolCall('run_shell', {
        argv: ['node', '--version'],
      }, { sandboxOptions: { backendOrder: [] } }));

      expect(result).toMatchObject({
        status: 'denied',
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        sandboxBackend: null,
        denyReason: 'sandbox-unavailable:no-verified-backend',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('denies the shell-guard attack corpus through run_shell, not unknown-tool fallback', async () => {
    const { root, bridge } = await makeBridge(0);
    const attacks = [
      'bash -c "printf unsafe"',
      'sh -c "printf unsafe"',
      'printf safe; printf unsafe',
      'printf safe | cat',
      'FOO=bar printf unsafe',
      'node -e "console.log(1)"',
      'python -c "print(1)"',
      'git push origin main',
      'codex --version',
      'claude --version',
      'cat <<EOF\nunsafe\nEOF',
      'cat <(printf unsafe)',
      'env bash -c "printf unsafe"',
    ];
    try {
      for (const command of attacks) {
        const result = decodeToolResult(await bridge.evaluateToolCall('run_shell', { command }));
        expect(result.status, command).toBe('denied');
        expect(result.denyReason, command).not.toBe('unknown-tool');
        expect(result.exitCode, command).toBe(null);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is no less strict than the live dist Bash gate over the attack corpus', async () => {
    const { root, bridge } = await makeBridge(0);
    const gate = await import(pathToFileURL(gatePath).href);
    const attacks = [
      'bash -c "printf unsafe"',
      'sh -c "printf unsafe"',
      'printf safe; printf unsafe',
      'printf safe | cat',
      'FOO=bar printf unsafe',
      'node -e "console.log(1)"',
      'python -c "print(1)"',
      'git push origin main',
      'codex --version',
      'claude --version',
      'cat <<EOF\nunsafe\nEOF',
      'cat <(printf unsafe)',
      'env bash -c "printf unsafe"',
    ];
    try {
      for (const command of attacks) {
        const gateResult = await gate.evaluateHookInput({
          tool_name: 'Bash',
          tool_input: { command },
          cwd: root,
          session_id: 'run-shell-parity',
        });
        const result = decodeToolResult(await bridge.evaluateToolCall('run_shell', { command }));

        if (gateResult.decision === 'deny') {
          expect(result.status, command).toBe('denied');
        }
        expect(result.status, `${command} gate=${gateResult.decision}`).toBe('denied');
        expect(result.denyReason, command).not.toBe('unknown-tool');
        if (command.startsWith('node -e')) {
          expect(result.error, command).toMatch(/Inline code execution is blocked/);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('property-denies generated shell metacharacter commands without execution', async () => {
    const { root, bridge } = await makeBridge(0);
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(';', '|', '&&', '||', '>', '>>', '<', '<<', '$(', '`'),
          fc.string({ minLength: 1, maxLength: 20 }),
          async (operator, suffix) => {
            const command = `printf safe ${operator} ${suffix.replace(/\u0000/g, '') || 'x'}`;
            const result = decodeToolResult(await bridge.evaluateToolCall('run_shell', { command }));
            expect(result.status).toBe('denied');
            expect(result.denyReason).not.toBe('unknown-tool');
          },
        ),
        { numRuns: 60, seed: 260810 },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('contains command execution inside the sandbox', () => {
    const root = makeProjectRoot('hf-run-shell-containment-');
    const outside = join(tmpdir(), `hf-run-shell-outside-${process.pid}-${Date.now()}.txt`);
    const inside = join(root, 'src', 'inside.txt');
    const scriptPath = join(root, 'src', 'containment.mjs');
    const key = writeKey(root);
    writeEnvelope(root, key, 0);
    writeFileSync(scriptPath, `
      import { writeFileSync } from 'node:fs';
      const [inside, outside] = process.argv.slice(2);
      writeFileSync(inside, 'inside', 'utf8');
      try {
        writeFileSync(outside, 'outside', 'utf8');
        console.log('outside allowed');
      } catch (err) {
        console.log('outside blocked:' + (err.code || err.name));
      }
    `, 'utf8');
    try {
      const result = evaluateRunShellInChild(root, {
        argv: [
          'node',
          scriptPath,
          inside,
          outside,
        ],
      });

      expect(result.status).toBe('executed');
      expect(result.stdout).toContain('outside blocked:');
      expect(existsSync(inside)).toBe(true);
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  });
});
