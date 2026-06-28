#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const defaultConfigPath = resolve(process.cwd(), '.hive-flow/provider-concurrency.json');
const API_PROVIDERS = new Set(['deepseek', 'openrouter']);
const CLI_PROVIDERS = new Map([
  ['anthropic-cli', ['claude']],
  ['codex-cli', ['codex']],
  ['cursor-cli', ['agent', 'cursor-agent']],
  ['gemini-cli', ['gemini']],
]);
const PROVIDER_ENV = {
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};
const DEFAULT_TASK = 'Provider concurrency probe: reply exactly PROVIDER_CONCURRENCY_PROBE_OK and do not call tools.';

function usage() {
  return `Usage: node scripts/probe-provider-concurrency.mjs [options]

Options:
  --providers a,b       Providers to probe. Default: auto-detect configured providers.
  --max n               API provider first-pass cap, never above 150. Default: 150.
  --cli-max n           CLI provider cap, never above 10. Default: 10.
  --cooldown-ms n       Cooldown between narrowing probes. Default: 60000.
  --poll-ms n           Poll interval for task results. Default: 5000.
  --task-timeout-ms n   Per-agent task timeout. Default: 120000.
  --safety-margin n     Subtract this from largest safe batch. Default: 1.
  --model name          Model alias/native slug passed to agent_spawn. Default: mini.
  --write path          Settings file to update. Default: .hive-flow/provider-concurrency.json.
  --dry-run             Run probes but do not write settings.

The script uses real Hive Flow agent_spawn + agent_task + agent_task_result handlers from built dist.
Run npm run build first if dist is missing.`;
}

function parseNumber(raw, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseArgs(argv) {
  const out = {
    providers: undefined,
    max: 150,
    cliMax: 10,
    cooldownMs: 60_000,
    pollMs: 5_000,
    taskTimeoutMs: 120_000,
    safetyMargin: 1,
    model: 'mini',
    write: defaultConfigPath,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else if (arg === '--providers') {
      out.providers = String(next() ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    } else if (arg === '--max') {
      out.max = parseNumber(next(), out.max, { min: 1, max: 150 });
    } else if (arg === '--cli-max') {
      out.cliMax = parseNumber(next(), out.cliMax, { min: 1, max: 10 });
    } else if (arg === '--cooldown-ms') {
      out.cooldownMs = parseNumber(next(), out.cooldownMs, { min: 0 });
    } else if (arg === '--poll-ms') {
      out.pollMs = parseNumber(next(), out.pollMs, { min: 250 });
    } else if (arg === '--task-timeout-ms') {
      out.taskTimeoutMs = parseNumber(next(), out.taskTimeoutMs, { min: 10_000 });
    } else if (arg === '--safety-margin') {
      out.safetyMargin = parseNumber(next(), out.safetyMargin, { min: 0 });
    } else if (arg === '--model') {
      out.model = String(next() ?? '').trim() || out.model;
    } else if (arg === '--write') {
      out.write = resolve(String(next() ?? defaultConfigPath));
    } else if (arg === '--dry-run') {
      out.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function executableExists(command) {
  if (process.platform === 'win32') {
    return spawnSync('where', [command], { shell: false, stdio: 'ignore', timeout: 2_000 }).status === 0;
  }
  return spawnSync('sh', ['-c', 'command -v "$1"', 'sh', command], {
    shell: false,
    stdio: 'ignore',
    timeout: 2_000,
  }).status === 0;
}

function autoDetectProviders() {
  const providers = [];
  for (const [provider, envName] of Object.entries(PROVIDER_ENV)) {
    if (process.env[envName]) providers.push(provider);
  }
  for (const [provider, commands] of CLI_PROVIDERS.entries()) {
    if (commands.some(executableExists)) providers.push(provider);
  }
  return providers;
}

function providerKind(provider) {
  return CLI_PROVIDERS.has(provider) ? 'cli' : 'api';
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function loadAgentTools() {
  const toolsPath = resolve(packageRoot, 'dist/src/mcp-tools/agent-tools.js');
  if (!existsSync(toolsPath)) {
    throw new Error(`Built agent tools not found at ${toolsPath}; run npm run build first.`);
  }
  const imported = await import(pathToFileURL(toolsPath).href);
  const tools = imported.agentTools;
  if (!Array.isArray(tools)) throw new Error('Built agentTools export is missing or invalid.');
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const name of ['agent_spawn', 'agent_task', 'agent_task_result', 'agent_terminate']) {
    if (!byName.has(name)) throw new Error(`Built agent tool '${name}' is missing.`);
  }
  return byName;
}

function capEnvName(provider) {
  return `HIVE_FLOW_PROVIDER_MAX_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

async function terminateAgents(agentTerminate, agentIds) {
  await Promise.allSettled(agentIds.map((agentId) => agentTerminate.handler({ agentId, force: true })));
}

function isTerminalTaskResult(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.status === 'completed' || result.status === 'failed') return true;
  if (result.terminal === true) return true;
  return false;
}

function taskResultSucceeded(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.success === false) return false;
  if (result.status === 'failed') return false;
  const nested = result.result && typeof result.result === 'object' ? result.result : undefined;
  if (nested?.success === false || nested?.error) return false;
  return result.status === 'completed' || result.success === true;
}

async function runBatch(tools, provider, count, options, context) {
  const spawned = [];
  const tasks = [];
  const capEnv = capEnvName(provider);
  const previousCapEnv = process.env[capEnv];
  process.env[capEnv] = String(Math.max(count, 1));
  try {
    for (let i = 0; i < count; i++) {
      const agentId = `provider-probe-${provider}-${Date.now()}-${i}`;
      const spawnResult = await tools.get('agent_spawn').handler({
        agentType: 'researcher',
        agentId,
        provider,
        model: options.model,
        mode: 'read-only',
        task: 'Provider concurrency limit probe.',
      }, context);
      if (!spawnResult?.success) {
        return { ok: false, stage: 'spawn', count, reason: String(spawnResult?.error ?? 'agent_spawn failed'), spawned };
      }
      spawned.push(agentId);
    }

    for (const agentId of spawned) {
      const taskResult = await tools.get('agent_task').handler({
        agentId,
        task: DEFAULT_TASK,
        timeout: options.taskTimeoutMs,
      }, context);
      if (!taskResult?.success || typeof taskResult.taskId !== 'string') {
        return { ok: false, stage: 'dispatch', count, reason: String(taskResult?.error ?? 'agent_task failed'), spawned, tasks };
      }
      tasks.push(taskResult.taskId);
    }

    const deadline = Date.now() + options.taskTimeoutMs + 30_000;
    const pending = new Set(tasks);
    const failures = [];
    while (pending.size > 0 && Date.now() < deadline) {
      await sleep(options.pollMs);
      for (const taskId of [...pending]) {
        const result = await tools.get('agent_task_result').handler({ taskId }, context);
        if (!isTerminalTaskResult(result)) continue;
        pending.delete(taskId);
        if (!taskResultSucceeded(result)) failures.push({ taskId, result });
      }
    }
    if (pending.size > 0) {
      return { ok: false, stage: 'timeout', count, reason: `${pending.size} tasks did not complete before deadline`, spawned, tasks };
    }
    if (failures.length > 0) {
      return { ok: false, stage: 'result', count, reason: `${failures.length} tasks failed`, spawned, tasks, failures };
    }
    return { ok: true, count, spawned, tasks };
  } finally {
    if (previousCapEnv === undefined) delete process.env[capEnv];
    else process.env[capEnv] = previousCapEnv;
    await terminateAgents(tools.get('agent_terminate'), spawned);
  }
}

async function probeProvider(tools, provider, options) {
  const kind = providerKind(provider);
  const max = kind === 'cli' ? Math.min(options.cliMax, 10) : options.max;
  const context = {
    sessionId: `provider-probe-${provider}-${Date.now()}`,
    clientKind: 'codex',
    trustedClientKind: true,
  };
  const attempts = [];
  const first = await runBatch(tools, provider, max, options, context);
  attempts.push({ count: max, ok: first.ok, stage: first.stage, reason: first.reason });
  if (first.ok) {
    return {
      provider,
      kind,
      maxSafeConcurrentTasks: Math.max(1, max - options.safetyMargin),
      largestSuccessfulBatch: max,
      observedFailureAt: null,
      attempts,
    };
  }

  let low = 0;
  let high = max;
  while (high - low > 1) {
    await sleep(options.cooldownMs);
    const mid = Math.floor((low + high) / 2);
    const attempt = await runBatch(tools, provider, mid, options, context);
    attempts.push({ count: mid, ok: attempt.ok, stage: attempt.stage, reason: attempt.reason });
    if (attempt.ok) low = mid;
    else high = mid;
  }

  return {
    provider,
    kind,
    maxSafeConcurrentTasks: Math.max(1, low - options.safetyMargin),
    largestSuccessfulBatch: low,
    observedFailureAt: high,
    attempts,
  };
}

function readConfig(path) {
  if (!existsSync(path)) return { version: 1, providers: {}, defaults: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return parsed;
}

function writeProbeConfig(path, results, options) {
  const now = new Date().toISOString();
  const config = readConfig(path);
  config.version = Number.isInteger(config.version) ? config.version : 1;
  config.updatedAt = now;
  config.generatedBy = 'hive-flow provider concurrency probe';
  config.defaults = config.defaults && typeof config.defaults === 'object' && !Array.isArray(config.defaults)
    ? config.defaults
    : {};
  config.defaults.cli = {
    ...(config.defaults.cli && typeof config.defaults.cli === 'object' && !Array.isArray(config.defaults.cli) ? config.defaults.cli : {}),
    maxConcurrentTasks: Math.min(options.cliMax, 10),
    reason: 'CLI providers are subscription-backed; probe results are capped at 10 by policy.',
  };
  config.providers = config.providers && typeof config.providers === 'object' && !Array.isArray(config.providers)
    ? config.providers
    : {};

  for (const result of results) {
    config.providers[result.provider] = {
      ...(config.providers[result.provider] && typeof config.providers[result.provider] === 'object' && !Array.isArray(config.providers[result.provider])
        ? config.providers[result.provider]
        : {}),
      kind: result.kind,
      maxSafeConcurrentTasks: result.maxSafeConcurrentTasks,
      probedAt: now,
      evidence: {
        method: 'hive-flow-agent-ramp',
        model: options.model,
        firstPassAttempted: result.attempts[0]?.count ?? 0,
        largestSuccessfulBatch: result.largestSuccessfulBatch,
        observedFailureAt: result.observedFailureAt,
        safetyMargin: options.safetyMargin,
        cooldownMs: options.cooldownMs,
        taskTimeoutMs: options.taskTimeoutMs,
        attempts: result.attempts,
      },
    };
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return config;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const providers = options.providers?.length ? options.providers : autoDetectProviders();
  if (providers.length === 0) {
    throw new Error('No configured providers detected. Set provider API keys, install CLI providers, or pass --providers.');
  }
  const tools = await loadAgentTools();
  const results = [];
  for (const provider of providers) {
    if (!API_PROVIDERS.has(provider) && !CLI_PROVIDERS.has(provider)) {
      throw new Error(`Unsupported provider '${provider}' for concurrency probing.`);
    }
    console.error(`[probe] ${provider}: starting ${providerKind(provider)} provider probe`);
    const result = await probeProvider(tools, provider, options);
    results.push(result);
    console.error(`[probe] ${provider}: safe=${result.maxSafeConcurrentTasks} largestSuccess=${result.largestSuccessfulBatch} failureAt=${result.observedFailureAt ?? 'none'}`);
    if (provider !== providers[providers.length - 1]) await sleep(options.cooldownMs);
  }

  if (!options.dryRun) writeProbeConfig(options.write, results, options);
  console.log(JSON.stringify({ ok: true, dryRun: options.dryRun, write: options.write, results }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
