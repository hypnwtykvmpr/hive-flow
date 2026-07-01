import { describe, expect, it, afterEach } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = resolve(here, '../scripts/provider-agent-bridge.mjs');
const goldenPath = resolve(here, 'fixtures/provider-bridge-contracts.golden.json');

const previousEnv = {
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
  HIVE_FLOW_AGENT_ID: process.env.HIVE_FLOW_AGENT_ID,
  CLAUDE_AGENT_ID: process.env.CLAUDE_AGENT_ID,
  HIVE_FLOW_HIVE_ID: process.env.HIVE_FLOW_HIVE_ID,
  HIVE_FLOW_DEV_OVERRIDE_TOKEN: process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN,
  HIVE_FLOW_DEV_OVERRIDE: process.env.HIVE_FLOW_DEV_OVERRIDE,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreProcessListeners(event, preserved) {
  const keep = new Set(preserved);
  for (const listener of process.listeners(event)) {
    if (!keep.has(listener)) process.off(event, listener);
  }
}

function makeProjectRoot(prefix = 'hf-bridge-golden-') {
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
  const statePath = join(root, '.hive-flow', 'enforcement', 'state.json');
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({
    state,
    hmac: createHmac('sha256', key).update(JSON.stringify(state)).digest('hex'),
  }, null, 2), 'utf8');
}

async function importBridgeForRoot(root) {
  const previousCwd = process.cwd();
  const sigtermListeners = process.listeners('SIGTERM');
  const uncaughtExceptionListeners = process.listeners('uncaughtException');
  process.chdir(root);
  process.env.CLAUDE_PROJECT_DIR = root;
  process.env.HIVE_FLOW_AGENT_ID = '';
  process.env.CLAUDE_AGENT_ID = '';
  process.env.HIVE_FLOW_HIVE_ID = '';
  delete process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN;
  delete process.env.HIVE_FLOW_DEV_OVERRIDE;
  try {
    return await import(`${pathToFileURL(bridgePath).href}?golden=${Date.now()}-${Math.random()}`);
  } finally {
    process.chdir(previousCwd);
    restoreProcessListeners('SIGTERM', sigtermListeners);
    restoreProcessListeners('uncaughtException', uncaughtExceptionListeners);
  }
}

function decode(result) {
  return typeof result === 'string' ? JSON.parse(result) : result;
}

function normalizeValue(value, root) {
  if (typeof value === 'string') {
    return value
      .replaceAll(root, '<project-root>')
      .replace(/^v\d+\.\d+\.\d+\n?$/u, '<node-version>\\n');
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry, root));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry, root)]),
    );
  }
  return value;
}

async function buildGoldenTranscript() {
  const root = makeProjectRoot();
  const key = writeKey(root);
  writeEnvelope(root, key, 0);
  const bridge = await importBridgeForRoot(root);
  try {
    const readable = join(root, 'src', 'readable.txt');
    const searchable = join(root, 'src', 'searchable.txt');
    writeFileSync(readable, 'golden read body\n', 'utf8');
    writeFileSync(searchable, 'needle golden\n', 'utf8');

    const writeTarget = join(root, 'src', 'written.txt');
    const entries = {
      read_file: await bridge.executeBridgeFilesystemTool('read_file', { path: readable }),
      write_file: await bridge.executeBridgeFilesystemTool('write_file', {
        path: writeTarget,
        content: 'golden write body\n',
      }),
      list_directory: String(await bridge.executeBridgeFilesystemTool('list_directory', { path: join(root, 'src') }))
        .split('\n')
        .filter(Boolean)
        .sort()
        .join('\n'),
      grep: await bridge.executeBridgeFilesystemTool('grep', {
        pattern: 'needle golden',
        path: join(root, 'src'),
      }),
      run_shell_sandbox_unavailable: decode(await bridge.evaluateToolCall('run_shell', {
        argv: ['node', '--version'],
      }, {
        sandboxOptions: { backendOrder: [] },
      })),
      run_shell_inline_denied: decode(await bridge.evaluateToolCall('run_shell', {
        command: 'node -e "console.log(1)"',
      })),
      web_fetch_allowlist_denied: decode(await bridge.evaluateToolCall('web_fetch', {
        url: 'https://example.invalid/provider-bridge-golden',
      }, {
        webOptions: { allowlist: ['https://fixture.test'] },
      })),
      web_search_allowlist_denied: decode(await bridge.evaluateToolCall('web_search', {
        query: 'provider bridge',
      }, {
        webOptions: {
          searchEndpoint: 'https://example.invalid/provider-bridge-golden-search',
          allowlist: ['https://fixture.test'],
        },
      })),
      unknown_tool_denied: await bridge.executeBridgeTool('unknown_runtime_tool', { unsafe: true }, {
        source: 'golden-test',
      }),
    };

    const responseLoopShapes = {
      assistant_tool_call: {
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: 'call_golden',
          type: 'function',
          function: {
            name: 'web_fetch',
            arguments: JSON.stringify({ url: 'https://example.invalid/provider-bridge-golden' }),
          },
        }],
      },
      tool_result_retry_message: {
        role: 'tool',
        toolCallId: 'call_golden',
        name: 'web_fetch',
        content: JSON.stringify(entries.web_fetch_allowlist_denied),
      },
      reroll_exhausted: {
        status: 'error',
        code: 'OPENROUTER_TIER_EXHAUSTED',
        retryable: false,
        message: 'OpenRouter opus tier exhausted after timeout rerolls; attempted models: model-a, model-b',
      },
      stuck_loop_break: {
        reason: 'repeated-tool-call-fingerprint',
        window: 4,
        threshold: 3,
        fingerprint: JSON.stringify([{ n: 'unknown_runtime_tool', a: '{"unsafe":true}' }]),
      },
    };

    return normalizeValue({
      toolResults: entries,
      responseLoopShapes,
      relativePaths: {
        readable: relative(root, readable),
        searchable: relative(root, searchable),
        written: relative(root, writeTarget),
      },
    }, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('provider bridge golden contract fixtures', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('matches the checked-in normalized bridge tool result transcript', async () => {
    const expected = JSON.parse(readFileSync(goldenPath, 'utf8'));
    expect(await buildGoldenTranscript()).toEqual(expected);
  });
});
