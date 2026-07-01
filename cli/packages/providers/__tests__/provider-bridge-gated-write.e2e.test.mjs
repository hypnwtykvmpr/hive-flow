import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import {
  chmodSync,
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
import {
  checkMCPEnforcement,
  checkModelEnforcement,
  classifyTool,
  ToolRisk,
} from '../../../src/mcp-tools/mcp-enforcement-gate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = resolve(here, '../scripts/provider-agent-bridge.mjs');
const providersDistPath = resolve(here, '../dist/index.js');

const previousEnv = {
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
  HIVE_FLOW_HOME: process.env.HIVE_FLOW_HOME,
  HIVE_FLOW_PROJECT_ROOT: process.env.HIVE_FLOW_PROJECT_ROOT,
  HIVE_FLOW_AGENT_ID: process.env.HIVE_FLOW_AGENT_ID,
  CLAUDE_AGENT_ID: process.env.CLAUDE_AGENT_ID,
  HIVE_FLOW_HIVE_ID: process.env.HIVE_FLOW_HIVE_ID,
  CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
  HIVE_FLOW_SESSION_ID: process.env.HIVE_FLOW_SESSION_ID,
  HIVE_FLOW_SESSION_ID: process.env.HIVE_FLOW_SESSION_ID,
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

function makeProjectRoot(prefix = 'phb3-') {
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
  try { chmodSync(keyPath, 0o600); } catch { /* chmod is best-effort in tests */ }
  return key;
}

function signState(key, state) {
  return {
    state,
    hmac: createHmac('sha256', key).update(JSON.stringify(state)).digest('hex'),
  };
}

function writeEnvelope(root, key, level, options = {}) {
  const state = {
    level,
    ts: '2026-06-06T00:00:00.000Z',
    violations: 0,
    restrictedGroups: [],
    history: [],
    integrityCompromised: false,
    ...(options.state ?? {}),
  };
  const envelope = signState(options.signingKey ?? key, state);
  if (options.tamperHmac) {
    envelope.hmac = `${envelope.hmac.slice(0, -1)}${envelope.hmac.endsWith('0') ? '1' : '0'}`;
  }
  const statePath = options.statePath ?? join(root, '.hive-flow', 'enforcement', 'state.json');
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(envelope, null, 2), 'utf8');
  return envelope;
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

async function startFixtureServer(toolName, toolArgs) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'openrouter-fixture', context_length: 128000 }] }));
        return;
      }

      if (req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      const body = raw ? JSON.parse(raw) : {};
      requests.push(body);
      const toolMessage = [...(body.messages ?? [])].reverse().find((msg) => msg.role === 'tool');

      res.writeHead(200, { 'content-type': 'application/json' });
      if (!toolMessage) {
        res.end(JSON.stringify({
          id: 'phb3-tool-call',
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: 'call_phb3',
                type: 'function',
                function: {
                  name: toolName,
                  arguments: JSON.stringify(toolArgs),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
        return;
      }

      res.end(JSON.stringify({
        id: 'phb3-final',
        choices: [{
          message: {
            content: `tool-result:${toolMessage.content}`,
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
      }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

async function startCredentialHolderFixture(holderOwnedApiUrl) {
  const holderRoot = mkdtempSync(join(tmpdir(), 'hf-holder-'));
  const socketPath = join(holderRoot, 'holder.sock');
  const commands = [];
  const apiUrl = String(holderOwnedApiUrl || '').replace(/\/+$/, '');
  const server = createNetServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', async (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      try {
        const command = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
        commands.push(command);
        const payload = command.request?.payload ?? {};
        if (Object.prototype.hasOwnProperty.call(payload, 'apiUrl')) {
          throw new Error('holder fixture rejected caller-supplied apiUrl');
        }
        const apiResponse = await fetch(`${apiUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer holder-fixture-key',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: payload.model,
            messages: payload.messages,
            tools: payload.tools,
          }),
        });
        const data = await apiResponse.json();
        const choice = data.choices?.[0] ?? {};
        socket.end(`${JSON.stringify({
          ok: true,
          response: {
            content: choice.message?.content ?? '',
            model: data.model,
            toolCalls: choice.message?.tool_calls,
            finishReason: choice.finish_reason,
            usage: data.usage ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
            } : undefined,
          },
        })}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({ ok: false, error: error.message || String(error) })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  return {
    socketPath,
    commands,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      rmSync(holderRoot, { recursive: true, force: true });
    },
  };
}

function childEnv(root, extra = {}) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    HIVE_FLOW_HOME: join(root, '.hive-flow'),
    HIVE_FLOW_PROJECT_ROOT: root,
    CLAUDE_PROJECT_DIR: root,
    HIVE_FLOW_AGENT_ID: '',
    CLAUDE_AGENT_ID: '',
    HIVE_FLOW_HIVE_ID: '',
    CLAUDE_SESSION_ID: '',
    HIVE_FLOW_SESSION_ID: '',
    HIVE_FLOW_SESSION_ID: '',
    ...extra,
  };
}

function runDirectBridgeFilesystemTool(root, toolName, toolArgs, env = {}) {
  const script = `
    const bridge = await import(${JSON.stringify(pathToFileURL(bridgePath).href)});
    const result = await bridge.executeBridgeFilesystemTool(${JSON.stringify(toolName)}, ${JSON.stringify(toolArgs)});
    process.stdout.write(JSON.stringify(result));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    env: childEnv(root, env),
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

function makeStore(root, agentId) {
  const storeDir = join(root, '.hive-flow', 'agents');
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, 'store.json'), JSON.stringify({
    agents: {
      [agentId]: {
        id: agentId,
        name: agentId,
        type: 'coder',
        status: 'busy',
        provider: 'deepseek',
        model: 'sonnet',
        resolvedModel: 'deepseek-v4-flash',
        systemPrompt: 'Use tools exactly as requested by the fixture.',
        conversationHistory: [],
        taskCount: 0,
        config: {},
      },
    },
  }, null, 2), 'utf8');
  return storeDir;
}

async function runDetachedBridge({ root, level, toolName, toolArgs, agentId = 'phb3-agent' }) {
  const key = writeKey(root);
  writeEnvelope(root, key, level);
  const fixture = await startFixtureServer(toolName, toolArgs);
  const holder = await startCredentialHolderFixture(fixture.baseUrl);
  const storeDir = makeStore(root, agentId);
  const tasksDir = join(root, '.hive-flow', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const taskFile = join(tasksDir, 'phb3.task');
  const resultFile = join(tasksDir, 'phb3.result.json');
  writeFileSync(taskFile, 'Drive the scripted tool call.', 'utf8');

  const child = spawn(process.execPath, [
    bridgePath,
    '--agent-id', agentId,
    '--task-file', taskFile,
    '--result-file', resultFile,
    '--store-dir', storeDir,
    '--timeout', '10000',
  ], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    env: {
      ...childEnv(root),
      HIVE_FLOW_CREDENTIAL_HOLDER_SOCKET: holder.socketPath,
      DEEPSEEK_API_URL: fixture.baseUrl,
    },
  });

  try {
    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('provider bridge fixture timed out'));
      }, 20000);
      child.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    if (exitCode !== 0) {
      const detail = existsSync(resultFile) ? readFileSync(resultFile, 'utf8') : '<no result file>';
      throw new Error(`provider bridge exited ${exitCode}: ${detail}`);
    }
    expect(existsSync(resultFile)).toBe(true);
    const result = JSON.parse(readFileSync(resultFile, 'utf8'));
    return { result, requests: fixture.requests };
  } finally {
    await fixture.close();
    await holder.close();
  }
}

describe('PH-B3 provider bridge gated-write milestone', () => {
  let harnessRoot;

  beforeAll(async () => {
    expect(existsSync(providersDistPath), 'providers dist must exist; run pnpm --dir v3 --filter @hive-flow/providers build before PH-B3').toBe(true);
    harnessRoot = makeProjectRoot('phb3-a-');
  });

  afterEach(() => {
    restoreEnv();
  });

  afterAll(() => {
    restoreEnv();
    if (harnessRoot) rmSync(harnessRoot, { recursive: true, force: true });
  });

  describe('Harness A: exported filesystem handler gate', () => {
    it('allows a normal unprotected write and blocks protected writes without over-blocking siblings', async () => {
      const key = writeKey(harnessRoot);
      writeEnvelope(harnessRoot, key, 0);

      const target = join(harnessRoot, 'src', 'feature.ts');
      const result = runDirectBridgeFilesystemTool(harnessRoot, 'write_file', {
        path: target,
        content: 'export const x = 1;\n',
      });
      expect(result).toBe(`File written: ${target}`);
      expect(readText(target)).toBe('export const x = 1;\n');

      const protectedTargets = [
        join(harnessRoot, '.claude', 'settings.json'),
        join(harnessRoot, '.hive-flow', 'enforcement', 'state.json'),
        join(harnessRoot, '.env'),
      ];
      for (const protectedTarget of protectedTargets) {
        const before = existsSync(protectedTarget) ? readText(protectedTarget) : null;
        const denied = runDirectBridgeFilesystemTool(harnessRoot, 'write_file', {
          path: protectedTarget,
          content: 'mutated',
        });
        expect(denied).toMatchObject({ status: 'error' });
        expect(denied.error).toMatch(/protected path/);
        if (before === null) {
          expect(existsSync(protectedTarget)).toBe(false);
        } else {
          expect(readText(protectedTarget)).toBe(before);
        }
      }

      const sibling = join(harnessRoot, '.claude', 'notes.md');
      const siblingResult = runDirectBridgeFilesystemTool(harnessRoot, 'write_file', {
        path: sibling,
        content: 'allowed sibling\n',
      });
      expect(siblingResult).toBe(`File written: ${sibling}`);
      expect(readText(sibling)).toBe('allowed sibling\n');
    });

    it('blocks unprotected writes and edits at RESTRICTED and HALTED', async () => {
      const key = writeKey(harnessRoot);
      const target = join(harnessRoot, 'src', 'restricted.ts');

      writeEnvelope(harnessRoot, key, 2);
      const restrictedWrite = runDirectBridgeFilesystemTool(harnessRoot, 'write_file', {
        path: target,
        content: 'blocked',
      });
      expect(restrictedWrite).toMatchObject({ status: 'error' });
      expect(restrictedWrite.error).toMatch(/RESTRICTED\+/);
      expect(existsSync(target)).toBe(false);

      const editTarget = join(harnessRoot, 'src', 'edit.ts');
      writeFileSync(editTarget, 'before', 'utf8');
      const restrictedEdit = runDirectBridgeFilesystemTool(harnessRoot, 'edit_file', {
        path: editTarget,
        old_string: 'before',
        new_string: 'after',
      });
      expect(restrictedEdit).toMatchObject({ status: 'error' });
      expect(restrictedEdit.error).toMatch(/RESTRICTED\+/);
      expect(readText(editTarget)).toBe('before');

      writeEnvelope(harnessRoot, key, 3);
      const haltedWrite = runDirectBridgeFilesystemTool(harnessRoot, 'write_file', {
        path: join(harnessRoot, 'src', 'halted.ts'),
        content: 'blocked',
      });
      expect(haltedWrite).toMatchObject({ status: 'error' });
      expect(haltedWrite.error).toMatch(/RESTRICTED\+/);
    });

    it('fails closed for missing keys, tampered HMACs, forged keys, and per-agent RESTRICTED state', async () => {
      const key = writeKey(harnessRoot);
      const target = join(harnessRoot, 'src', 'fail-closed.ts');

      rmSync(join(harnessRoot, '.hive-flow', 'enforcement', '.hmac-key'), { force: true });
      writeEnvelope(harnessRoot, 'unused-key', 0);
      const noKey = runDirectBridgeFilesystemTool(harnessRoot, 'write_file', { path: target, content: 'no-key' });
      expect(noKey).toMatchObject({ status: 'error' });
      expect(noKey.error).toMatch(/RESTRICTED\+/);

      writeKey(harnessRoot, key);
      writeEnvelope(harnessRoot, key, 0, { tamperHmac: true });
      const tampered = runDirectBridgeFilesystemTool(harnessRoot, 'write_file', { path: target, content: 'tampered' });
      expect(tampered).toMatchObject({ status: 'error' });
      expect(tampered.error).toMatch(/RESTRICTED\+/);

      writeEnvelope(harnessRoot, key, 0, { signingKey: 'attacker-key' });
      const forged = runDirectBridgeFilesystemTool(harnessRoot, 'write_file', { path: target, content: 'forged' });
      expect(forged).toMatchObject({ status: 'error' });
      expect(forged.error).toMatch(/RESTRICTED\+/);

      writeEnvelope(harnessRoot, key, 0);
      writeEnvelope(harnessRoot, key, 2, {
        statePath: join(harnessRoot, '.hive-flow', 'enforcement', 'agents', 'agent-a', 'state.json'),
      });
      const perAgent = runDirectBridgeFilesystemTool(
        harnessRoot,
        'write_file',
        { path: target, content: 'agent' },
        { HIVE_FLOW_AGENT_ID: 'agent-a', CLAUDE_AGENT_ID: 'agent-a' },
      );
      expect(perAgent).toMatchObject({ status: 'error' });
      expect(perAgent.error).toMatch(/RESTRICTED\+/);
      expect(existsSync(target)).toBe(false);
    });
  });

  describe('Harness B: detached bridge child reaches the same gate', () => {
    it('lands a normal provider-requested write through the detached bridge', async () => {
      const root = makeProjectRoot('phb3-b-normal-');
      try {
        const target = join(root, 'src', 'detached.ts');
        const { result, requests } = await runDetachedBridge({
          root,
          level: 0,
          toolName: 'write_file',
          toolArgs: { path: target, content: 'detached ok\n' },
        });

        expect(requests.length).toBeGreaterThanOrEqual(2);
        expect(result.success).toBe(true);
        expect(readText(target)).toBe('detached ok\n');
        expect(result.content).toContain('File written');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 30000);

    it('blocks protected and RESTRICTED writes through the detached bridge', async () => {
      const protectedRoot = makeProjectRoot('phb3-b-protected-');
      const restrictedRoot = makeProjectRoot('phb3-b-restricted-');
      try {
        const protectedTarget = join(protectedRoot, '.claude', 'settings.json');
        writeFileSync(protectedTarget, '{"hooks":[]}\n', 'utf8');
        const protectedRun = await runDetachedBridge({
          root: protectedRoot,
          level: 0,
          toolName: 'write_file',
          toolArgs: { path: protectedTarget, content: '{"hooks":["disabled"]}\n' },
        });

        expect(protectedRun.result.success).toBe(true);
        expect(protectedRun.result.content).toMatch(/protected path/);
        expect(readText(protectedTarget)).toBe('{"hooks":[]}\n');

        const restrictedTarget = join(restrictedRoot, 'src', 'blocked.ts');
        const restrictedRun = await runDetachedBridge({
          root: restrictedRoot,
          level: 2,
          toolName: 'write_file',
          toolArgs: { path: restrictedTarget, content: 'blocked\n' },
        });

        expect(restrictedRun.result.success).toBe(true);
        expect(restrictedRun.result.content).toMatch(/RESTRICTED\+/);
        expect(existsSync(restrictedTarget)).toBe(false);
      } finally {
        rmSync(protectedRoot, { recursive: true, force: true });
        rmSync(restrictedRoot, { recursive: true, force: true });
      }
    }, 30000);
  });

  describe('Dispatch gate: HALTED/WARNED blocks spawn surfaces', () => {
    it('blocks agent_spawn and agent_task with post-G2 parity', () => {
      const root = makeProjectRoot('phb3-dispatch-');
      const key = writeKey(root);
      try {
        process.env.HIVE_FLOW_HOME = join(root, '.hive-flow');
        process.env.HIVE_FLOW_PROJECT_ROOT = root;
        process.env.CLAUDE_PROJECT_DIR = root;
        process.env.HIVE_FLOW_AGENT_ID = '';
        process.env.CLAUDE_AGENT_ID = '';
        process.env.HIVE_FLOW_HIVE_ID = '';
        process.env.CLAUDE_SESSION_ID = '';
        process.env.HIVE_FLOW_SESSION_ID = '';
        process.env.HIVE_FLOW_SESSION_ID = '';

        writeEnvelope(root, key, 1);
        for (const toolName of ['agent_spawn', 'agent_task']) {
          const warned = checkMCPEnforcement(`mcp__hive-flow__${toolName}`);
          expect(warned.allowed, `${toolName} should be blocked at WARNED`).toBe(false);
          expect(warned.risk).toBe(ToolRisk.CRITICAL);
          expect(classifyTool(toolName)).toBe(ToolRisk.CRITICAL);
          expect(checkModelEnforcement(toolName, { provider: 'anthropic-cli', model: 'haiku' }).allowed).toBe(false);
        }

        writeEnvelope(root, key, 3);
        for (const toolName of ['agent_spawn', 'agent_task']) {
          const halted = checkMCPEnforcement(`mcp__hive-flow__${toolName}`);
          expect(halted.allowed, `${toolName} should be blocked at HALTED`).toBe(false);
          expect(halted.reason).toContain('CRITICAL risk');
        }
      } finally {
        restoreEnv();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
