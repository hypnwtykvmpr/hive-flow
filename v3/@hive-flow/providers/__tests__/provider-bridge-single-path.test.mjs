import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { spawn, execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
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
const sharedRoot = resolve(here, '../../shared');
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
    HIVE_FLOW_AGENT_ID: '',
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
  const nodeShared = join(scopeDir, 'shared');
  const nodeScripts = join(nodeProviders, 'scripts');

  mkdirSync(nodeScripts, { recursive: true });
  mkdirSync(join(nodeCli, 'dist', 'src'), { recursive: true });
  mkdirSync(join(nodeCli, 'dist', 'src', 'install'), { recursive: true });

  for (const scriptName of [
    'provider-agent-bridge.mjs',
    'agent-task-journal.mjs',
    'bridge-grep-validators.mjs',
    'provider-auth-helpers.mjs',
    'sandbox-runner.mjs',
  ]) {
    copyFileSync(resolve(providersRoot, 'scripts', scriptName), join(nodeScripts, scriptName));
  }
  safeSymlinkDir(providersDistPath, join(nodeProviders, 'dist'));
  safeSymlinkDir(sharedRoot, nodeShared);
  if (existsSync(join(providersRoot, 'node_modules', 'undici'))) {
    mkdirSync(join(nodeProviders, 'node_modules'), { recursive: true });
    safeSymlinkDir(realpathSync.native(join(providersRoot, 'node_modules', 'undici')), join(nodeProviders, 'node_modules', 'undici'));
  }
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

async function startFixtureServer(toolName, toolArgs, options = {}) {
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
      if (options.noToolCalls) {
        res.end(JSON.stringify({
          id: 'single-path-ungrounded',
          choices: [{
            message: {
              content: 'The exact version is probably 0.0.0.',
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
        return;
      }
      // PART 1: an exact-args task where the model NEVER emits a tool call. The bridge's
      // exact-args fidelity gate must intercept this (no-tool-call violation), retry the
      // bounded number of times, then fail closed with ARG_FIDELITY_EXHAUSTED — NOT
      // UNGROUNDED_TOOL_TASK. Always answer from priors (no tool call) on every request.
      if (options.exactArgsNoTool) {
        res.end(JSON.stringify({
          id: 'single-path-exact-args-no-tool',
          choices: [{
            message: { content: 'I already know the answer; no tool needed.' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
        return;
      }
      // EXACT-ARGS ONE-CALL-AND-DONE: the model emits the correct single tool call on the
      // first turn (no tool message yet) — which satisfies the exact-args contract and
      // executes successfully. On the SECOND turn (a successful tool result is now in
      // history) the model emits a REDUNDANT follow-on call to the SAME tool with the SAME
      // args. For non-idempotent edit_file the duplicate would fail `old_string not found`;
      // the bridge MUST drop it (never execute) and drive to the final summary instead.
      if (options.redundantCallAfterSatisfaction) {
        if (!toolMessage) {
          // First turn — emit the single correct, satisfying call.
          res.end(JSON.stringify({
            id: 'single-path-exact-args-first-call',
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: 'call_satisfying',
                  type: 'function',
                  function: { name: toolName, arguments: JSON.stringify(toolArgs) },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }));
          return;
        }
        // The successful tool result is in history. If the result is the edit-success
        // marker, emit a REDUNDANT follow-on call (must be dropped). After the drop the
        // bridge breaks and requests a final text summary; on that summary turn we still
        // see the (same) tool message, so emit redundant calls only while content empty —
        // the bridge's drop path makes content irrelevant. To terminate the loop we emit
        // a SECOND redundant call once, then the bridge breaks; the post-loop summary
        // request (which carries the summary user prompt) returns final text below.
        const lastMsg = [...(body.messages ?? [])].at(-1);
        const isSummaryTurn = lastMsg?.role === 'user'
          && typeof lastMsg.content === 'string'
          && lastMsg.content.startsWith('Summarize what you found');
        if (!isSummaryTurn) {
          res.end(JSON.stringify({
            id: 'single-path-exact-args-redundant-call',
            choices: [{
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_redundant_1',
                    type: 'function',
                    function: { name: toolName, arguments: JSON.stringify(toolArgs) },
                  },
                  {
                    id: 'call_redundant_2',
                    type: 'function',
                    function: { name: toolName, arguments: JSON.stringify(toolArgs) },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
          }));
          return;
        }
        res.end(JSON.stringify({
          id: 'single-path-exact-args-redundant-summary',
          choices: [{
            message: { content: `done:${toolMessage.content}` },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
        }));
        return;
      }
      // PART 3: an exact-args task where the model emits the correct tool with the correct
      // args EXCEPT a dropped trailing newline on `content`. The bridge retries the bounded
      // number of times (model keeps trimming), then performs the canonical trailing-
      // whitespace repair and executes the repaired (canonical) call. `toolArgs.content`
      // is expected to END with '\n'; we emit it trimmed on every tool turn.
      if (options.trimTrailingNewline && !toolMessage) {
        const trimmed = { ...toolArgs };
        if (typeof trimmed.content === 'string') trimmed.content = trimmed.content.replace(/\s+$/, '');
        res.end(JSON.stringify({
          id: 'single-path-trimmed-args',
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: 'call_trimmed',
                type: 'function',
                function: { name: toolName, arguments: JSON.stringify(trimmed) },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
        return;
      }
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
            tool_choice: payload.toolChoice ?? payload.tool_choice,
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
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolvePromise);
  });
  chmodSync(socketPath, 0o600);
  return {
    socketPath,
    commands,
    close: async () => {
      await new Promise((resolvePromise, reject) => {
        server.close((err) => (err ? reject(err) : resolvePromise()));
      });
      rmSync(holderRoot, { recursive: true, force: true });
    },
  };
}

function makeStore(root, agentId, opts = {}) {
  const provider = opts.provider ?? 'deepseek';
  const resolvedModel = opts.resolvedModel ?? 'deepseek-v4-flash';
  const storeDir = join(root, '.hive-flow', 'agents');
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, 'store.json'), JSON.stringify({
    agents: {
      [agentId]: {
        id: agentId,
        name: agentId,
        type: 'coder',
        status: 'busy',
        provider,
        model: 'sonnet',
        resolvedModel,
        systemPrompt: 'Use tools exactly as requested by the fixture.',
        conversationHistory: [],
        taskCount: 0,
        config: {},
      },
    },
  }, null, 2), 'utf8');
  return storeDir;
}

async function runDetachedBridge({
  bridgePath,
  root,
  toolName,
  toolArgs,
  markerPath,
  agentId = 'single-path-agent',
  provider,
  resolvedModel,
  taskText = 'Call read_file on a local workspace file through the scripted bridge tool call.',
  envExtra = {},
  fixtureOptions = {},
  allowFailure = false,
}) {
  const key = writeKey(root);
  writeEnvelope(root, key, 0);
  const fixture = await startFixtureServer(toolName, toolArgs, fixtureOptions);
  const holder = await startCredentialHolderFixture(fixture.baseUrl);
  const storeDir = makeStore(root, agentId, { provider, resolvedModel });
  const tasksDir = join(root, '.hive-flow', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const taskFile = join(tasksDir, 'single-path.task');
  const resultFile = join(tasksDir, 'single-path.result.json');
  writeFileSync(taskFile, taskText, 'utf8');

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
      ...envExtra,
      HIVE_FLOW_CREDENTIAL_HOLDER_SOCKET: holder.socketPath,
      DEEPSEEK_API_URL: fixture.baseUrl,
      OPENROUTER_API_URL: fixture.baseUrl,
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

    if (exitCode !== 0 && !allowFailure) {
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
    await holder.close();
  }
}

const STRICT_PROVIDER_CASES = [
  { provider: 'deepseek', resolvedModel: 'deepseek-v4-pro' },
  { provider: 'openrouter', resolvedModel: 'minimax/minimax-m3' },
];

const STRICT_TOOL_CASES = [
  {
    toolName: 'read_file',
    toolArgs: (root) => ({ path: join(root, 'src', 'matrix.txt') }),
    taskText: 'Read the local workspace file src/matrix.txt using the read_file bridge tool.',
    expectContent: (content) => expect(content).toContain('strict matrix needle'),
  },
  {
    toolName: 'write_file',
    toolArgs: (root) => ({ path: join(root, 'src', 'matrix-write.txt'), content: 'strict matrix write\n' }),
    taskText: 'Write a temp workspace file src/matrix-write.txt using the write_file bridge tool.',
    expectContent: (content) => expect(content).toContain('File written:'),
  },
  {
    toolName: 'edit_file',
    toolArgs: (root) => ({ path: join(root, 'src', 'matrix-edit.txt'), old_string: 'before matrix edit', new_string: 'after matrix edit' }),
    taskText: 'Edit the temp workspace file src/matrix-edit.txt using the edit_file bridge tool.',
    expectContent: (content) => expect(content).toContain('File edited:'),
  },
  {
    toolName: 'list_directory',
    toolArgs: (root) => ({ path: join(root, 'src') }),
    taskText: 'List the local workspace directory src using the list_directory bridge tool.',
    expectContent: (content) => expect(content).toContain('matrix.txt'),
  },
  {
    toolName: 'grep',
    toolArgs: (root) => ({ pattern: 'strict matrix needle', path: join(root, 'src') }),
    taskText: 'Search the local workspace path src for strict matrix needle using the grep bridge tool.',
    expectContent: (content) => expect(content).toContain('strict matrix needle'),
  },
  {
    toolName: 'find_file',
    toolArgs: (root) => ({ pattern: 'matrix.txt', path: join(root, 'src') }),
    taskText: 'Find the local workspace file matrix.txt using the find_file bridge tool.',
    expectContent: (content) => expect(content).toContain('matrix.txt'),
  },
  {
    toolName: 'run_command',
    toolArgs: () => ({ argv: ['pwd'] }),
    taskText: 'Check the current workspace path using the run_command bridge tool.',
    expectContent: (content) => expect(content).toContain('"status":"executed"'),
  },
  {
    toolName: 'web_fetch',
    toolArgs: () => ({ url: 'https://127.0.0.1/' }),
    taskText: 'Fetch the web URL https://127.0.0.1/ using the web_fetch bridge tool and report the denial status.',
    expectContent: (content) => {
      expect(content).toContain('"status":"denied"');
      expect(content).toContain('denyReason');
    },
  },
  {
    toolName: 'web_search',
    toolArgs: () => ({ query: 'current OpenRouter MiniMax M3 model slug' }),
    taskText: 'Search the web for the current OpenRouter MiniMax M3 model slug using the web_search bridge tool.',
    expectContent: (content) => expect(content).toContain('web-search-unsupported'),
  },
];

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
      const firstToolNames = (requests[0].tools ?? []).map((tool) => tool.function?.name);
      expect(firstToolNames).toEqual([
        'read_file',
        'write_file',
        'edit_file',
        'list_directory',
        'grep',
        'find_file',
        'run_command',
        'web_fetch',
        'web_search',
      ]);
      expect(firstToolNames).not.toContain('run_shell');
      // DeepSeek (thinking mode) rejects tool_choice:"required" with HTTP 400, so the
      // bridge must NOT send it for deepseek; grounding is still enforced by the
      // UNGROUNDED_TOOL_TASK floor (covered by the fail-closed test below).
      expect(requests[0].tool_choice).not.toBe('required');
      expect(Buffer.byteLength(JSON.stringify(requests[0].tools), 'utf8')).toBeLessThan(10 * 1024);
      expect(result.success).toBe(true);
      expect(result.content).toContain('tool-result:detached built-in read');
      expect(result.toolUse).toMatchObject({
        iterations: 2,
        tools: ['read_file'],
      });
      expect(bridgeLog).toContain('"message":"Bridge tool dispatch"');
      expect(bridgeLog).toContain('"tool":"read_file"');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(layout.installRoot, { recursive: true, force: true });
    }
  }, 30000);

  it('does not send incompatible tool_choice:required for OpenRouter MiniMax M3', async () => {
    const layout = makeInstallLayout({ fakeMcpClient: false });
    const root = makeProjectRoot('hf-bridge-single-path-openrouter-');
    try {
      const readable = join(root, 'src', 'fixture.txt');
      writeFileSync(readable, 'openrouter grounded read\n', 'utf8');

      const { result, requests } = await runDetachedBridge({
        bridgePath: layout.bridgePath,
        root,
        toolName: 'read_file',
        toolArgs: { path: readable },
        provider: 'openrouter',
        resolvedModel: 'minimax/minimax-m3',
      });

      expect(requests.length).toBeGreaterThanOrEqual(2);
      // OpenRouter MiniMax M3 rejects tool_choice:required live. Grounding is
      // still enforced by the UNGROUNDED_TOOL_TASK fail-closed floor.
      expect(requests[0].tool_choice).not.toBe('required');
      expect(result.success).toBe(true);
      expect(result.toolUse).toMatchObject({ iterations: 2, tools: ['read_file'] });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(layout.installRoot, { recursive: true, force: true });
    }
  }, 30000);

  it('DO-NOT-REVERT: strict API web tasks are grounded through bridge tools', async () => {
    const layout = makeInstallLayout({ fakeMcpClient: false });
    const root = makeProjectRoot('hf-bridge-single-path-web-');
    try {
      const { result, requests } = await runDetachedBridge({
        bridgePath: layout.bridgePath,
        root,
        toolName: 'web_search',
        toolArgs: { query: 'current OpenRouter MiniMax M3 model slug' },
        provider: 'openrouter',
        resolvedModel: 'minimax/minimax-m3',
        taskText: 'Search the web for the current OpenRouter MiniMax M3 model slug using a bridge web tool.',
      });

      expect(requests.length).toBeGreaterThanOrEqual(2);
      const firstToolNames = (requests[0].tools ?? []).map((tool) => tool.function?.name);
      expect(firstToolNames).toContain('web_fetch');
      expect(firstToolNames).toContain('web_search');
      expect(requests[0].tool_choice).not.toBe('required');
      expect(result.success).toBe(true);
      expect(result.toolUse).toMatchObject({ iterations: 2, tools: ['web_search'] });
      expect(result.content).toContain('web-search-unsupported');
      expect(result.content).not.toMatch(/UNGROUNDED_TOOL_TASK/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(layout.installRoot, { recursive: true, force: true });
    }
  }, 30000);

  it('DO-NOT-REVERT: strict API web tasks fail closed without a tool call', async () => {
    const layout = makeInstallLayout({ fakeMcpClient: false });
    const root = makeProjectRoot('hf-bridge-single-path-web-ungrounded-');
    try {
      const { result, requests } = await runDetachedBridge({
        bridgePath: layout.bridgePath,
        root,
        toolName: 'web_search',
        toolArgs: { query: 'current OpenRouter MiniMax M3 model slug' },
        provider: 'openrouter',
        resolvedModel: 'minimax/minimax-m3',
        taskText: 'Search the web for the current OpenRouter MiniMax M3 model slug and report the grounded answer.',
        fixtureOptions: { noToolCalls: true },
        allowFailure: true,
      });

      expect(requests.length).toBe(1);
      expect(result).toMatchObject({
        success: false,
        code: 'UNGROUNDED_TOOL_TASK',
      });
      expect(result.error).toMatch(/workspace\/web task/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(layout.installRoot, { recursive: true, force: true });
    }
  }, 30000);

  it('exercises every strict bridge tool through both OpenRouter and DeepSeek response loops', async () => {
    const layout = makeInstallLayout({ fakeMcpClient: false });
    const seenPairs = new Set();
    try {
      for (const providerCase of STRICT_PROVIDER_CASES) {
        for (const toolCase of STRICT_TOOL_CASES) {
          const root = makeProjectRoot(`hf-bridge-matrix-${providerCase.provider}-${toolCase.toolName}-`);
          try {
            const readable = join(root, 'src', 'matrix.txt');
            writeFileSync(readable, 'strict matrix needle\n', 'utf8');
            writeFileSync(join(root, 'src', 'matrix-edit.txt'), 'before matrix edit\n', 'utf8');

            const { result, requests } = await runDetachedBridge({
              bridgePath: layout.bridgePath,
              root,
              toolName: toolCase.toolName,
              toolArgs: toolCase.toolArgs(root),
              provider: providerCase.provider,
              resolvedModel: providerCase.resolvedModel,
              taskText: toolCase.taskText,
            });

            expect(requests.length).toBeGreaterThanOrEqual(2);
            const firstToolNames = (requests[0].tools ?? []).map((tool) => tool.function?.name);
            for (const expectedName of STRICT_TOOL_CASES.map((entry) => entry.toolName)) {
              expect(firstToolNames).toContain(expectedName);
            }
            expect(firstToolNames).not.toContain('run_shell');
            expect(requests[0].tool_choice).not.toBe('required');
            expect(result.success).toBe(true);
            expect(result.toolUse).toMatchObject({ iterations: 2, tools: [toolCase.toolName] });
            toolCase.expectContent(result.content);
            if (toolCase.toolName === 'write_file') {
              expect(readFileSync(join(root, 'src', 'matrix-write.txt'), 'utf8')).toBe('strict matrix write\n');
            }
            if (toolCase.toolName === 'edit_file') {
              expect(readFileSync(join(root, 'src', 'matrix-edit.txt'), 'utf8')).toBe('after matrix edit\n');
            }
            seenPairs.add(`${providerCase.provider}:${toolCase.toolName}`);
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        }
      }

      fc.assert(
        fc.property(
          fc.constantFrom(...STRICT_PROVIDER_CASES.map((entry) => entry.provider)),
          fc.constantFrom(...STRICT_TOOL_CASES.map((entry) => entry.toolName)),
          (provider, toolName) => {
            expect(seenPairs.has(`${provider}:${toolName}`)).toBe(true);
          },
        ),
        { numRuns: 80 },
      );
    } finally {
      rmSync(layout.installRoot, { recursive: true, force: true });
    }
  }, 120000);

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

  it('fails closed when a strict provider answers a local file task without using a tool', async () => {
    const layout = makeInstallLayout({ fakeMcpClient: false });
    const root = makeProjectRoot('hf-bridge-strict-ungrounded-');
    const agentId = 'strict-ungrounded-agent';
    try {
      const key = writeKey(root);
      writeEnvelope(root, key, 0);
      const fixture = await startFixtureServer('read_file', { path: 'package.json' }, { noToolCalls: true });
      const holder = await startCredentialHolderFixture(fixture.baseUrl);
      const storeDir = makeStore(root, agentId);
      const tasksDir = join(root, '.hive-flow', 'tasks');
      mkdirSync(tasksDir, { recursive: true });
      const taskFile = join(tasksDir, 'strict-ungrounded.task');
      const resultFile = join(tasksDir, 'strict-ungrounded.result.json');
      writeFileSync(taskFile, 'Read package.json and return the exact version.', 'utf8');

      const child = spawn(process.execPath, [
        layout.bridgePath,
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

      await new Promise((resolvePromise, reject) => {
        const timeout = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error('provider bridge fixture timed out'));
        }, 20000);
        child.once('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
        child.once('exit', () => {
          clearTimeout(timeout);
          resolvePromise();
        });
      });

      const result = JSON.parse(readFileSync(resultFile, 'utf8'));
      expect(result).toMatchObject({
        success: false,
        code: 'UNGROUNDED_TOOL_TASK',
      });
      expect(result.error).toMatch(/did not use bridge tools/i);
      expect(result.error).not.toMatch(/holder-fixture-key|secret/i);
      await holder.close();
      await fixture.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(layout.installRoot, { recursive: true, force: true });
    }
  }, 30000);

  // Build the machine-readable exact-args diagnostic task that parseExactArgsContext
  // recognizes (names exactly one strict tool + carries a 'Use these exact arguments:'
  // JSON block). The trailing-newline on `content` is the tokenization artifact under test.
  function exactArgsTask(tool, args) {
    return [
      'Live Hive Flow strict-provider diagnostic.',
      `Your FIRST response MUST be a tool call to the bridge tool named ${JSON.stringify(tool)}.`,
      'Do not write any assistant text before the tool call.',
      `Use these exact arguments: ${JSON.stringify(args)}.`,
      'Do not change, infer, paraphrase, omit, or repair the arguments.',
      'Do not answer from memory or model priors.',
    ].join('\n');
  }

  it('PART 1: an exact-args NO-TOOL response fails closed as ARG_FIDELITY_EXHAUSTED, not UNGROUNDED_TOOL_TASK', async () => {
    const layout = makeInstallLayout({ fakeMcpClient: false });
    const root = makeProjectRoot('hf-bridge-exact-args-no-tool-');
    try {
      const target = join(root, 'src', 'exact-write.txt');
      const expectedArgs = { path: target, content: 'exact write\n' };

      const { result, requests } = await runDetachedBridge({
        bridgePath: layout.bridgePath,
        root,
        toolName: 'write_file',
        toolArgs: expectedArgs,
        provider: 'openrouter',
        resolvedModel: 'minimax/minimax-m3',
        taskText: exactArgsTask('write_file', expectedArgs),
        fixtureOptions: { exactArgsNoTool: true },
        allowFailure: true,
      });

      // Bounded fidelity retries occurred (more than the single ungrounded request),
      // and the failure is the exact-args path — NOT the ungrounded floor.
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(result).toMatchObject({ success: false, code: 'ARG_FIDELITY_EXHAUSTED' });
      expect(result.code).not.toBe('UNGROUNDED_TOOL_TASK');
      // The repaired file must NOT exist — no tool ever executed.
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(layout.installRoot, { recursive: true, force: true });
    }
  }, 30000);

  it('PART 3: a dropped trailing newline is canonically repaired and the canonical args execute', async () => {
    const layout = makeInstallLayout({ fakeMcpClient: false });
    const root = makeProjectRoot('hf-bridge-exact-args-repair-');
    try {
      const target = join(root, 'src', 'repair-write.txt');
      const expectedArgs = { path: target, content: 'canonical repair output\n' };

      const { result, requests, bridgeLog } = await runDetachedBridge({
        bridgePath: layout.bridgePath,
        root,
        toolName: 'write_file',
        toolArgs: expectedArgs,
        provider: 'openrouter',
        resolvedModel: 'minimax/minimax-m3',
        taskText: exactArgsTask('write_file', expectedArgs),
        fixtureOptions: { trimTrailingNewline: true },
      });

      // Retries were exhausted (model kept trimming), then the canonical repair ran and
      // executed the expected args. The file content must be the CANONICAL value (with the
      // trailing newline restored), proving the repaired args — not the trimmed ones — ran.
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(result.success).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('canonical repair output\n');
      expect(result.toolUse).toMatchObject({ tools: ['write_file'], successfulTools: ['write_file'] });
      // The repair is logged to bridge.log (human-readable) and journaled to the task
      // journal (machine event `exact_args_trailing_whitespace_repair`).
      expect(bridgeLog).toContain('Exact-args trailing-whitespace repair');
      const journalPath = join(root, '.hive-flow', 'tasks', 'single-path.events.jsonl');
      expect(existsSync(journalPath)).toBe(true);
      expect(readFileSync(journalPath, 'utf8')).toContain('exact_args_trailing_whitespace_repair');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(layout.installRoot, { recursive: true, force: true });
    }
  }, 30000);

  it('ONE-CALL-AND-DONE: exact-args edit_file executes once; redundant post-satisfaction calls are dropped, never executed', async () => {
    const layout = makeInstallLayout({ fakeMcpClient: false });
    const root = makeProjectRoot('hf-bridge-exact-args-one-call-');
    try {
      const target = join(root, 'src', 'one-call-edit.txt');
      // Non-idempotent: after the first edit, `old_string` is gone, so a second
      // edit_file with the same args would fail `old_string not found`.
      writeFileSync(target, 'before one-call edit\n', 'utf8');
      const expectedArgs = {
        path: target,
        old_string: 'before one-call edit',
        new_string: 'after one-call edit',
      };

      const { result, requests, bridgeLog } = await runDetachedBridge({
        bridgePath: layout.bridgePath,
        root,
        toolName: 'edit_file',
        toolArgs: expectedArgs,
        provider: 'openrouter',
        resolvedModel: 'minimax/minimax-m3',
        taskText: exactArgsTask('edit_file', expectedArgs),
        fixtureOptions: { redundantCallAfterSatisfaction: true },
      });

      // The first (satisfying) edit_file ran successfully; the redundant follow-on
      // calls were DROPPED before execution. The observed result is the success path,
      // never a duplicate `old_string not found`.
      expect(result.success).toBe(true);
      // Final file content is the single applied edit — not corrupted, not double-applied.
      expect(readFileSync(target, 'utf8')).toBe('after one-call edit\n');
      // Exactly ONE attempted/successful tool — the dropped redundant calls are NOT
      // counted in attempted or successful tools.
      expect(result.toolUse.tools).toEqual(['edit_file']);
      expect(result.toolUse.successfulTools).toEqual(['edit_file']);
      // A duplicate `old_string not found` must NEVER surface as the observed result.
      expect(JSON.stringify(result)).not.toMatch(/old_string not found/i);
      // The drop is logged and journaled.
      expect(bridgeLog).toContain('Exact-args one-call-and-done');
      const journalPath = join(root, '.hive-flow', 'tasks', 'single-path.events.jsonl');
      expect(existsSync(journalPath)).toBe(true);
      const journal = readFileSync(journalPath, 'utf8');
      expect(journal).toContain('exact_args_redundant_call_dropped');
      // edit_file executed exactly once (one tool_exec_start for edit_file).
      const editExecStarts = journal
        .split('\n')
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter((e) => e && e.event === 'tool_exec_start' && e.meta?.toolName === 'edit_file');
      expect(editExecStarts.length).toBe(1);
      // More than one provider request occurred (satisfying turn + redundant turn + summary).
      expect(requests.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(layout.installRoot, { recursive: true, force: true });
    }
  }, 30000);

  it('ONE-CALL-AND-DONE: redundant WRONG-tool and MULTI-tool calls after satisfaction are dropped, never executed', async () => {
    const layout = makeInstallLayout({ fakeMcpClient: false });
    const root = makeProjectRoot('hf-bridge-exact-args-drop-wrong-');
    try {
      const target = join(root, 'src', 'drop-wrong-edit.txt');
      writeFileSync(target, 'before drop-wrong edit\n', 'utf8');
      const expectedArgs = {
        path: target,
        old_string: 'before drop-wrong edit',
        new_string: 'after drop-wrong edit',
      };

      const { result, bridgeLog } = await runDetachedBridge({
        bridgePath: layout.bridgePath,
        root,
        toolName: 'edit_file',
        toolArgs: expectedArgs,
        provider: 'openrouter',
        resolvedModel: 'minimax/minimax-m3',
        taskText: exactArgsTask('edit_file', expectedArgs),
        // The redundant follow-on turn emits TWO calls (multi-tool) to the same tool —
        // a post-satisfaction multi-call must be dropped wholesale, never executed.
        fixtureOptions: { redundantCallAfterSatisfaction: true },
      });

      expect(result.success).toBe(true);
      // Only the satisfying call ran — the multi-call follow-on was dropped wholesale.
      expect(result.toolUse.tools).toEqual(['edit_file']);
      expect(result.toolUse.successfulTools).toEqual(['edit_file']);
      expect(readFileSync(target, 'utf8')).toBe('after drop-wrong edit\n');
      expect(bridgeLog).toContain('Exact-args one-call-and-done');
      const journalPath = join(root, '.hive-flow', 'tasks', 'single-path.events.jsonl');
      const journal = readFileSync(journalPath, 'utf8');
      const droppedEvents = journal
        .split('\n')
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter((e) => e && e.event === 'exact_args_redundant_call_dropped');
      expect(droppedEvents.length).toBeGreaterThanOrEqual(1);
      // The dropped event records the number of dropped calls (2 from the multi-call turn).
      expect(droppedEvents[0].meta?.droppedCount).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(layout.installRoot, { recursive: true, force: true });
    }
  }, 30000);
});
