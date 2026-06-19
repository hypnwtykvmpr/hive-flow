#!/usr/bin/env node
/**
 * Live strict-provider bridge diagnostic.
 *
 * This is intentionally opt-in: ordinary tests and CI must not spend provider
 * quota. Run with --live only when validating the real OpenRouter/DeepSeek
 * agent harness path through the credential holder.
 */

import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STRICT_PROVIDERS = {
  openrouter: {
    provider: 'openrouter',
    model: 'minimax/minimax-m3',
    alias: 'opus',
  },
  deepseek: {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    alias: 'sonnet',
  },
};

const STRICT_TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'list_directory',
  'grep',
  'find_file',
  'run_command',
  'web_fetch',
  'web_search',
];

function usage() {
  return `Usage:
  node scripts/diagnose-strict-provider-tools.mjs --live [--provider openrouter] [--provider deepseek] [--tool all|read_file] [--project-root PATH] [--json]

Runs the strict API provider bridge with a real AgentRecord and the live credential holder.
This spends provider quota and is therefore blocked unless --live is present.

Options:
  --live              Required for provider calls.
  --provider <name>   openrouter or deepseek. Repeatable. Default: both.
  --tool <name|all>   Strict tool to exercise. Repeatable. Default: all.
                      Tools: ${STRICT_TOOLS.join(', ')}.
  --project-root PATH Run with CLAUDE_PROJECT_DIR/HIVE_FLOW_PROJECT_ROOT set to this root,
                      while keeping mutable fixtures under PATH/.tmp-audit.
                      Default: isolated external temporary project root.
  --timeout-ms <n>    Bridge timeout per tool. Default: 120000.
  --keep-temp         Keep the temporary project root for debugging.
  --json              Emit machine-readable JSON only.
  --help              Show this help.
`;
}

function parseArgs(argv) {
  const opts = {
    live: false,
    json: false,
    keepTemp: false,
    providers: [],
    tools: [],
    projectRoot: null,
    timeoutMs: 120_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { ...opts, help: true };
    if (arg === '--live') {
      opts.live = true;
      continue;
    }
    if (arg === '--json') {
      opts.json = true;
      continue;
    }
    if (arg === '--keep-temp') {
      opts.keepTemp = true;
      continue;
    }
    if (arg === '--provider') {
      opts.providers.push(String(argv[++i] || ''));
      continue;
    }
    if (arg === '--tool') {
      opts.tools.push(String(argv[++i] || ''));
      continue;
    }
    if (arg === '--project-root') {
      opts.projectRoot = String(argv[++i] || '').trim() || null;
      continue;
    }
    if (arg === '--timeout-ms') {
      opts.timeoutMs = Number(argv[++i] || 0);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (opts.providers.length === 0) opts.providers = Object.keys(STRICT_PROVIDERS);
  if (opts.tools.length === 0) opts.tools = ['all'];
  opts.providers = opts.providers.map((entry) => entry.trim()).filter(Boolean);
  opts.tools = opts.tools.flatMap((entry) => entry === 'all' ? STRICT_TOOLS : [entry]).map((entry) => entry.trim()).filter(Boolean);
  return opts;
}

function assertValidOptions(opts) {
  const badProviders = opts.providers.filter((entry) => !STRICT_PROVIDERS[entry]);
  if (badProviders.length > 0) throw new Error(`Unsupported provider(s): ${badProviders.join(', ')}`);
  const badTools = opts.tools.filter((entry) => !STRICT_TOOLS.includes(entry));
  if (badTools.length > 0) throw new Error(`Unsupported tool(s): ${badTools.join(', ')}`);
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 10_000 || opts.timeoutMs > 600_000) {
    throw new Error('--timeout-ms must be an integer between 10000 and 600000');
  }
  if (opts.projectRoot) {
    const resolved = resolve(opts.projectRoot);
    if (!existsSync(resolved)) throw new Error(`--project-root does not exist: ${resolved}`);
    const stat = statSync(resolved);
    if (!stat.isDirectory()) throw new Error(`--project-root is not a directory: ${resolved}`);
    opts.projectRoot = realpathSync(resolved);
  }
}

function defaultCredentialHolderSocketPath() {
  const explicit = String(process.env.HIVE_FLOW_CREDENTIAL_HOLDER_SOCKET || '').trim();
  if (explicit) return explicit;
  if (process.platform === 'win32') {
    const user = String(process.env.USERNAME || process.env.USER || 'user').replace(/[^A-Za-z0-9._-]+/g, '-');
    return `\\\\.\\pipe\\hive-flow-credential-holder-${user}`;
  }
  const runtimeDir = String(process.env.XDG_RUNTIME_DIR || '').trim()
    || join(String(process.env.HOME || process.cwd()), '.hive-flow', 'run');
  return join(runtimeDir, 'credential-holder.sock');
}

function assertCredentialHolderAvailable(socketPath) {
  if (process.platform === 'win32') return;
  if (!existsSync(socketPath)) {
    throw new Error(`credential holder socket missing: ${socketPath}`);
  }
  const stat = statSync(socketPath);
  if (!stat.isSocket()) throw new Error(`credential holder path is not a socket: ${socketPath}`);
}

function makeDiagnosticContext(projectRootOption) {
  if (!projectRootOption) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'hf-strict-provider-live-')));
    initializeFixtureRoot(root);
    return {
      projectRoot: root,
      fixtureRoot: root,
      cleanupRoot: root,
      rootMode: 'external-temp',
    };
  }

  const projectRoot = realpathSync(projectRootOption);
  const auditRoot = join(projectRoot, '.tmp-audit');
  mkdirSync(auditRoot, { recursive: true });
  const fixtureRoot = realpathSync(mkdtempSync(join(auditRoot, 'hf-strict-provider-live-')));
  initializeFixtureRoot(fixtureRoot);
  return {
    projectRoot,
    fixtureRoot,
    cleanupRoot: fixtureRoot,
    rootMode: 'project-root',
  };
}

function initializeFixtureRoot(fixtureRoot) {
  mkdirSync(join(fixtureRoot, '.hive-flow', 'agents'), { recursive: true });
  mkdirSync(join(fixtureRoot, '.hive-flow', 'enforcement', 'global'), { recursive: true });
  mkdirSync(join(fixtureRoot, '.hive-flow', 'tasks'), { recursive: true });
  mkdirSync(join(fixtureRoot, 'src'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'src', 'diagnostic.txt'), 'strict diagnostic needle\n', 'utf8');
  writeFileSync(join(fixtureRoot, 'src', 'editable.txt'), 'strict edit before\n', 'utf8');
  writeFileSync(join(fixtureRoot, 'src', 'secondary.log'), 'strict diagnostic needle in log\n', 'utf8');
}

function writeEnforcementEnvelope(fixtureRoot) {
  const key = randomBytes(32).toString('hex');
  const keyPath = join(fixtureRoot, '.hive-flow', 'enforcement', '.hmac-key');
  writeFileSync(keyPath, key, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch { /* best effort */ }
  const state = {
    level: 0,
    ts: new Date().toISOString(),
    violations: 0,
    restrictedGroups: [],
    history: [],
    integrityCompromised: false,
  };
  const envelope = {
    state,
    hmac: createHmac('sha256', key).update(JSON.stringify(state)).digest('hex'),
  };
  writeFileSync(join(fixtureRoot, '.hive-flow', 'enforcement', 'global', 'state.json'), JSON.stringify(envelope, null, 2), 'utf8');
}

function toolArgsFor(root, tool) {
  if (tool === 'read_file') return { path: join(root, 'src', 'diagnostic.txt') };
  if (tool === 'write_file') {
    return {
      path: join(root, 'src', 'strict-write-output.txt'),
      content: 'strict write output from live provider diagnostic\n',
    };
  }
  if (tool === 'edit_file') {
    return {
      path: join(root, 'src', 'editable.txt'),
      old_string: 'strict edit before',
      new_string: 'strict edit after',
    };
  }
  if (tool === 'list_directory') return { path: join(root, 'src') };
  if (tool === 'grep') return { pattern: 'strict diagnostic needle', path: join(root, 'src'), max_results: 5 };
  if (tool === 'find_file') return { pattern: 'diagnostic.txt', path: join(root, 'src') };
  if (tool === 'run_command') return { argv: ['pwd'] };
  if (tool === 'web_fetch') return { url: 'https://example.com/' };
  if (tool === 'web_search') return { query: 'current OpenRouter MiniMax M3 model slug' };
  throw new Error(`Unsupported tool: ${tool}`);
}

function taskFor(tool, args) {
  return [
    'Live Hive Flow strict-provider diagnostic.',
    `Your FIRST response MUST be a tool call to the bridge tool named ${JSON.stringify(tool)}.`,
    'Do not write any assistant text before the tool call.',
    `Use these exact arguments: ${JSON.stringify(args)}.`,
    'Do not change, infer, paraphrase, omit, or repair the arguments.',
    'If the tool is unsupported or denied, you must still call it and then summarize the denial result.',
    'Do not answer from memory or model priors.',
    'After the tool result is returned, summarize the result in one short sentence starting with TOOL_DIAGNOSTIC_DONE.',
  ].join('\n');
}

function writeStore(root, agentId, providerCase) {
  const storePath = join(root, '.hive-flow', 'agents', 'store.json');
  writeFileSync(storePath, JSON.stringify({
    agents: {
      [agentId]: {
        id: agentId,
        name: agentId,
        type: 'coder',
        status: 'busy',
        provider: providerCase.provider,
        model: providerCase.alias,
        resolvedModel: providerCase.model,
        systemPrompt: 'You are a Hive Flow bridge diagnostic agent. Tool use is mandatory for diagnostic tasks. Your first response must be exactly one call to the requested bridge tool with the exact supplied arguments, followed only after the tool result by final text.',
        conversationHistory: [],
        taskCount: 0,
        config: {},
      },
    },
  }, null, 2), 'utf8');
  return dirname(storePath);
}

function collectBridgeLog(root) {
  const logPath = join(root, '.hive-flow', 'logs', 'bridge.log');
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function readToolResult(storeDir, agentId, tool) {
  try {
    const store = JSON.parse(readFileSync(join(storeDir, 'store.json'), 'utf8'));
    const history = store?.agents?.[agentId]?.conversationHistory;
    if (!Array.isArray(history)) return { found: false, raw: null, parsed: null };
    const entry = [...history].reverse().find((item) => item?.role === 'tool' && item?.name === tool);
    if (!entry) return { found: false, raw: null, parsed: null };
    return { found: true, raw: String(entry.content ?? ''), parsed: parseMaybeJson(entry.content ?? '') };
  } catch {
    return { found: false, raw: null, parsed: null };
  }
}

function verifyToolResult(tool, toolResult, root) {
  if (!toolResult.found) return { ok: false, evidence: 'missing tool result message' };
  const raw = String(toolResult.raw || '');
  const parsed = toolResult.parsed;
  if (tool === 'read_file') {
    return {
      ok: raw.includes('strict diagnostic needle'),
      evidence: raw.slice(0, 160),
    };
  }
  if (tool === 'write_file') {
    const target = join(root, 'src', 'strict-write-output.txt');
    let content = '';
    try { content = readFileSync(target, 'utf8'); } catch { /* evidence below */ }
    return {
      ok: raw.includes('File written:') && content === 'strict write output from live provider diagnostic\n',
      evidence: JSON.stringify({ result: raw.slice(0, 120), content: content.slice(0, 120) }),
    };
  }
  if (tool === 'edit_file') {
    const target = join(root, 'src', 'editable.txt');
    let content = '';
    try { content = readFileSync(target, 'utf8'); } catch { /* evidence below */ }
    return {
      ok: raw.includes('File edited:') && content === 'strict edit after\n',
      evidence: JSON.stringify({ result: raw.slice(0, 120), content: content.slice(0, 120) }),
    };
  }
  if (tool === 'list_directory') {
    return {
      ok: raw.includes('diagnostic.txt') && raw.includes('secondary.log'),
      evidence: raw.slice(0, 160),
    };
  }
  if (tool === 'grep') {
    return {
      ok: raw.includes('strict diagnostic needle') && raw.includes('diagnostic.txt'),
      evidence: raw.slice(0, 160),
    };
  }
  if (tool === 'find_file') {
    return {
      ok: raw.includes('diagnostic.txt'),
      evidence: raw.slice(0, 160),
    };
  }
  if (tool === 'run_command') {
    return {
      ok: parsed && typeof parsed === 'object' && parsed.status === 'executed' && parsed.exitCode === 0,
      evidence: raw.slice(0, 160),
    };
  }
  if (tool === 'web_fetch') {
    return {
      ok: parsed && typeof parsed === 'object' && parsed.status === 'fetched' && parsed.httpStatus === 200 && parsed.bytes > 0,
      evidence: raw.slice(0, 200),
    };
  }
  if (tool === 'web_search') {
    return {
      ok: parsed && typeof parsed === 'object' && parsed.status === 'denied' && parsed.denyReason === 'web-search-unsupported',
      evidence: raw.slice(0, 200),
    };
  }
  return { ok: false, evidence: `unknown diagnostic expectation for ${tool}` };
}

async function runBridgeCase({ projectRoot, fixtureRoot, bridgePath, providerName, tool, timeoutMs, socketPath, keptTemp, rootMode }) {
  const providerCase = STRICT_PROVIDERS[providerName];
  const agentId = `diagnostic-${providerName}-${tool}-${Date.now()}`;
  const storeDir = writeStore(fixtureRoot, agentId, providerCase);
  const tasksDir = join(fixtureRoot, '.hive-flow', 'tasks');
  const taskPath = join(tasksDir, `${agentId}.task.txt`);
  const resultPath = join(tasksDir, `${agentId}.result.json`);
  const args = toolArgsFor(fixtureRoot, tool);
  writeFileSync(taskPath, taskFor(tool, args), 'utf8');

  const child = spawn(process.execPath, [
    bridgePath,
    '--agent-id', agentId,
    '--task-file', taskPath,
    '--result-file', resultPath,
    '--store-dir', storeDir,
    '--timeout', String(timeoutMs),
  ], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectRoot,
      HIVE_FLOW_PROJECT_ROOT: projectRoot,
      HIVE_FLOW_HOME: join(fixtureRoot, '.hive-flow'),
      HIVE_FLOW_CREDENTIAL_HOLDER_SOCKET: socketPath,
      HIVE_FLOW_PROVIDER_WEB_ALLOWLIST: [
        String(process.env.HIVE_FLOW_PROVIDER_WEB_ALLOWLIST || '').trim(),
        'example.com',
      ].filter(Boolean).join(','),
    },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const exitCode = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`bridge timed out after ${timeoutMs}ms`));
    }, timeoutMs + 30_000);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });

  let result = null;
  if (existsSync(resultPath)) {
    try {
      result = JSON.parse(readFileSync(resultPath, 'utf8'));
    } catch (error) {
      result = { success: false, error: `result JSON parse failed: ${error.message}` };
    }
  }
  const logs = [
    ...collectBridgeLog(fixtureRoot),
    ...(projectRoot === fixtureRoot ? [] : collectBridgeLog(projectRoot)),
  ];
  const toolLogCount = logs.filter((entry) =>
    entry.message === 'Bridge tool dispatch' &&
    entry.meta?.tool === tool &&
    entry.meta?.agentId === agentId
  ).length;
  const toolUse = Array.isArray(result?.toolUse?.tools) ? result.toolUse.tools : [];
  const toolResult = readToolResult(storeDir, agentId, tool);
  const toolExpectation = verifyToolResult(tool, toolResult, fixtureRoot);
  const ok = exitCode === 0 && result?.success === true && toolUse.includes(tool) && toolExpectation.ok;

  return {
    provider: providerName,
    model: providerCase.model,
    tool,
    rootMode,
    projectRoot,
    ...(keptTemp ? { tempRoot: fixtureRoot } : {}),
    ok,
    exitCode,
    toolUse,
    toolLogCount,
    toolResultFound: toolResult.found,
    toolResultEvidence: toolExpectation.evidence,
    contentExcerpt: String(result?.content || '').slice(0, 300),
    error: result?.error || null,
    code: result?.code || null,
    stdout: stdout.slice(0, 500),
    stderr: stderr.slice(0, 500),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(usage());
    return;
  }
  assertValidOptions(opts);
  if (!opts.live) {
    throw new Error('Refusing to run provider diagnostics without --live; this spends provider quota.');
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const bridgePath = resolve(scriptDir, 'provider-agent-bridge.mjs');
  const socketPath = defaultCredentialHolderSocketPath();
  assertCredentialHolderAvailable(socketPath);

  const rows = [];
  const keptRoots = [];
  try {
    for (const providerName of opts.providers) {
      for (const tool of opts.tools) {
        const context = makeDiagnosticContext(opts.projectRoot);
        writeEnforcementEnvelope(context.fixtureRoot);
        try {
          rows.push(await runBridgeCase({
            projectRoot: context.projectRoot,
            fixtureRoot: context.fixtureRoot,
            bridgePath,
            providerName,
            tool,
            timeoutMs: opts.timeoutMs,
            socketPath,
            keptTemp: opts.keepTemp,
            rootMode: context.rootMode,
          }));
          if (opts.keepTemp) keptRoots.push(context.fixtureRoot);
        } finally {
          if (!opts.keepTemp) rmSync(context.cleanupRoot, { recursive: true, force: true });
        }
      }
    }
  } finally { /* per-case cleanup happens above */ }

  const report = {
    ok: rows.every((row) => row.ok),
    roots: opts.keepTemp ? keptRoots : rows.map((row) => row.tempRoot || `cleaned:${row.provider}:${row.tool}`),
    socketPath,
    projectRoot: opts.projectRoot || null,
    providers: opts.providers,
    tools: opts.tools,
    rows,
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const row of rows) {
      process.stdout.write(`${row.ok ? 'PASS' : 'FAIL'} ${row.provider}/${row.model} ${row.tool} tools=${JSON.stringify(row.toolUse)}${row.error ? ` error=${row.error}` : ''}\n`);
    }
    process.stdout.write(`\n${report.ok ? 'ALL_PASS' : 'FAILURES'}\n`);
  }
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.message || String(error)}\n`);
  process.exitCode = 1;
});
