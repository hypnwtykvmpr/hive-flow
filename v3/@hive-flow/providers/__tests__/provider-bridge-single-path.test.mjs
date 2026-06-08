import { describe, expect, it } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const providersRoot = resolve(here, '..');
const cliRoot = resolve(here, '../../cli');
const providersDistPath = resolve(providersRoot, 'dist');
const cliPermissionGuardDistPath = resolve(cliRoot, 'dist/src/permission-guard');

function makeProjectRoot(prefix = 'hf-bridge-single-path-') {
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

function writeEnvelope(root, key, level) {
  const state = {
    level,
    ts: '2026-06-08T00:00:00.000Z',
    violations: 0,
    restrictedGroups: [],
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

function childEnv(root, extra = {}) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    CLAUDE_PROJECT_DIR: root,
    AGENTIC_FLOW_AGENT_ID: '',
    CLAUDE_AGENT_ID: '',
    HIVE_FLOW_HIVE_ID: '',
    ...extra,
  };
}

function safeSymlinkDir(target, linkPath) {
  try {
    symlinkSync(target, linkPath, 'dir');
  } catch {
    cpSync(target, linkPath, { recursive: true });
  }
}

function makeInstallLayout({ fakeMcpClient = false } = {}) {
  if (!existsSync(providersDistPath)) {
    throw new Error('providers dist must exist; run provider build before this test');
  }
  if (!existsSync(cliPermissionGuardDistPath)) {
    throw new Error('CLI permission-guard dist must exist; run CLI build before this test');
  }

  const installRoot = mkdtempSync(join(tmpdir(), 'hf-provider-single-path-install-'));
  const scopeDir = join(installRoot, 'node_modules', '@hive-flow');
  const nodeProviders = join(scopeDir, 'providers');
  const nodeCli = join(scopeDir, 'cli');
  const nodeScripts = join(nodeProviders, 'scripts');

  mkdirSync(nodeScripts, { recursive: true });
  mkdirSync(join(nodeCli, 'dist', 'src'), { recursive: true });
  mkdirSync(join(nodeCli, 'dist', 'src', 'install'), { recursive: true });

  for (const scriptName of [
    'provider-agent-bridge.mjs',
    'bridge-grep-validators.mjs',
    'provider-auth-helpers.mjs',
  ]) {
    copyFileSync(resolve(providersRoot, 'scripts', scriptName), join(nodeScripts, scriptName));
  }
  safeSymlinkDir(providersDistPath, join(nodeProviders, 'dist'));
  cpSync(cliPermissionGuardDistPath, join(nodeCli, 'dist', 'src', 'permission-guard'), { recursive: true });
  copyFileSync(
    resolve(cliRoot, 'dist/src/install/portable-prompt.js'),
    join(nodeCli, 'dist', 'src', 'install', 'portable-prompt.js'),
  );

  const fakeMarker = join(installRoot, 'fake-mcp-imported.txt');
  if (fakeMcpClient) {
    writeFileSync(join(nodeCli, 'package.json'), JSON.stringify({
      name: '@hive-flow/cli',
      type: 'module',
      exports: {
        '.': './index.js',
        './mcp-client': './mcp-client.js',
      },
    }, null, 2));
    const fakeModule = `
      import { writeFileSync } from 'node:fs';
      function mark(value) {
        if (process.env.HF_FAKE_MCP_MARKER) writeFileSync(process.env.HF_FAKE_MCP_MARKER, value);
      }
      mark('imported');
      export async function callMCPTool(toolName) {
        mark('called:' + toolName);
        return 'FAKE_MCP_CALLED:' + toolName;
      }
      export default { callMCPTool };
    `;
    writeFileSync(join(nodeCli, 'mcp-client.js'), fakeModule, 'utf8');
    writeFileSync(join(nodeCli, 'index.js'), fakeModule, 'utf8');
  }

  return {
    installRoot,
    bridgePath: realpathSync.native(join(nodeScripts, 'provider-agent-bridge.mjs')),
    fakeMarker,
  };
}

function runBridgeTool({ bridgePath, root, toolName, toolArgs, markerPath }) {
  const script = `
    const bridge = await import(${JSON.stringify(pathToFileURL(bridgePath).href)});
    const result = await bridge.executeBridgeTool(${JSON.stringify(toolName)}, ${JSON.stringify(toolArgs)});
    process.stdout.write(JSON.stringify(result));
  `;
  const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    env: childEnv(root, markerPath ? { HF_FAKE_MCP_MARKER: markerPath } : {}),
    encoding: 'utf8',
  });
  return JSON.parse(raw);
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
          id: 'single-path-tool-call',
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: 'call_single_path',
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
        id: 'single-path-final',
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

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });

  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolvePromise, reject) => {
      server.close((err) => (err ? reject(err) : resolvePromise()));
    }),
  };
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

async function runDetachedBridge({ bridgePath, root, toolName, toolArgs, markerPath, agentId = 'single-path-agent' }) {
  const key = writeKey(root);
  writeEnvelope(root, key, 0);
  const fixture = await startFixtureServer(toolName, toolArgs);
  const storeDir = makeStore(root, agentId);
  const tasksDir = join(root, '.hive-flow', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const taskFile = join(tasksDir, 'single-path.task');
  const resultFile = join(tasksDir, 'single-path.result.json');
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
      ...childEnv(root, markerPath ? { HF_FAKE_MCP_MARKER: markerPath } : {}),
      DEEPSEEK_API_KEY: 'test-deepseek-key',
      DEEPSEEK_API_URL: fixture.baseUrl,
    },
  });

  try {
    const exitCode = await new Promise((resolvePromise, reject) => {
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
        resolvePromise(code);
      });
    });

    if (exitCode !== 0) {
      const detail = existsSync(resultFile) ? readFileSync(resultFile, 'utf8') : '<no result file>';
      throw new Error(`provider bridge exited ${exitCode}: ${detail}`);
    }
    expect(existsSync(resultFile)).toBe(true);
    const result = JSON.parse(readFileSync(resultFile, 'utf8'));
    const logPath = join(root, '.hive-flow', 'logs', 'bridge.log');
    const bridgeLog = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    return { result, requests: fixture.requests, bridgeLog };
  } finally {
    await fixture.close();
  }
}

describe('provider bridge single tool execution path', () => {
  it('exposes one bridge-owned seam for filesystem tools and explicit denials', () => {
    const layout = makeInstallLayout({ fakeMcpClient: true });
    const root = makeProjectRoot('hf-bridge-single-path-direct-');
    try {
      const readable = join(root, 'src', 'readable.txt');
      writeFileSync(readable, 'direct seam read\n', 'utf8');

      expect(runBridgeTool({
        bridgePath: layout.bridgePath,
        root,
        toolName: 'read_file',
        toolArgs: { path: readable },
        markerPath: layout.fakeMarker,
      })).toBe('direct seam read\n');

      const unknown = runBridgeTool({
        bridgePath: layout.bridgePath,
        root,
        toolName: 'unknown_runtime_tool',
        toolArgs: {},
        markerPath: layout.fakeMarker,
      });
      expect(unknown).toMatchObject({
        status: 'denied',
        denyReason: 'unknown-tool',
        tool: 'unknown_runtime_tool',
      });

      const alias = runBridgeTool({
        bridgePath: layout.bridgePath,
        root,
        toolName: 'mcp__filesystem__read_file',
        toolArgs: { path: readable },
        markerPath: layout.fakeMarker,
      });
      expect(alias).toMatchObject({
        status: 'denied',
        denyReason: 'blocked-tool',
        tool: 'mcp__filesystem__read_file',
      });
      expect(existsSync(layout.fakeMarker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(layout.installRoot, { recursive: true, force: true });
    }
  });

  it('executes modeled built-ins in the response loop when no MCP client exists', async () => {
    const layout = makeInstallLayout({ fakeMcpClient: false });
    const root = makeProjectRoot('hf-bridge-single-path-no-mcp-');
    try {
      const readable = join(root, 'src', 'fixture.txt');
      writeFileSync(readable, 'detached built-in read\n', 'utf8');

      const { result, requests, bridgeLog } = await runDetachedBridge({
        bridgePath: layout.bridgePath,
        root,
        toolName: 'read_file',
        toolArgs: { path: readable },
      });

      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(result.success).toBe(true);
      expect(result.content).toContain('tool-result:detached built-in read');
      expect(bridgeLog).toContain('"message":"Bridge tool dispatch"');
      expect(bridgeLog).toContain('"tool":"read_file"');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(layout.installRoot, { recursive: true, force: true });
    }
  }, 30000);

  it('denies unknown response-loop tools even when a fake MCP client is loadable', async () => {
    const layout = makeInstallLayout({ fakeMcpClient: true });
    const root = makeProjectRoot('hf-bridge-single-path-fake-mcp-');
    try {
      const { result, requests, bridgeLog } = await runDetachedBridge({
        bridgePath: layout.bridgePath,
        root,
        toolName: 'unknown_runtime_tool',
        toolArgs: { unsafe: true },
        markerPath: layout.fakeMarker,
      });

      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(result.success).toBe(true);
      expect(result.content).toContain('"status":"denied"');
      expect(result.content).toContain('"denyReason":"unknown-tool"');
      expect(result.content).toContain('"tool":"unknown_runtime_tool"');
      expect(bridgeLog).toContain('"message":"Bridge tool dispatch"');
      expect(bridgeLog).toContain('"tool":"unknown_runtime_tool"');
      expect(existsSync(layout.fakeMarker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(layout.installRoot, { recursive: true, force: true });
    }
  }, 30000);

  it('denies MCP filesystem aliases in the response loop without touching a fake MCP client', async () => {
    const layout = makeInstallLayout({ fakeMcpClient: true });
    const root = makeProjectRoot('hf-bridge-single-path-mcp-alias-');
    try {
      const readable = join(root, 'src', 'fixture.txt');
      writeFileSync(readable, 'alias must not read this through MCP\n', 'utf8');

      const { result } = await runDetachedBridge({
        bridgePath: layout.bridgePath,
        root,
        toolName: 'mcp__filesystem__read_file',
        toolArgs: { path: readable },
        markerPath: layout.fakeMarker,
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain('"status":"denied"');
      expect(result.content).toContain('"denyReason":"blocked-tool"');
      expect(result.content).toContain('"tool":"mcp__filesystem__read_file"');
      expect(result.content).not.toContain('alias must not read this through MCP');
      expect(existsSync(layout.fakeMarker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(layout.installRoot, { recursive: true, force: true });
    }
  }, 30000);
});
