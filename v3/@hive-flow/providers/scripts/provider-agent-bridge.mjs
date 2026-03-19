#!/usr/bin/env node
/**
 * Provider Agent Bridge
 *
 * Core runtime bridge between agent_task MCP tool and CLI providers.
 * Manages provider lifecycle, conversation context, and state persistence.
 *
 * Called by agent_task handler when a provider-backed agent receives a task.
 *
 * Input (argv):
 *   --agent-id <id>     Agent identifier
 *   --task <text>        Task prompt (CLI arg — legacy, may break on special chars)
 *   --task-stdin         Read task prompt from stdin (preferred — safe for all content)
 *   --store-dir <path>  Agent store directory
 *   --timeout <ms>       Provider timeout in milliseconds
 *
 * When --task-stdin is set, the task text is read from stdin instead of --task.
 * This avoids shell parsing issues with special characters and ARG_MAX limits.
 * If neither --task nor --task-stdin is provided, stdin is read as a fallback.
 *
 * Output (stdout): JSON response
 * Errors (stderr): Log messages
 *
 * @module @hive-flow/providers/scripts/provider-agent-bridge
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, existsSync, rmdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// ===== Bridge File Logger (append-only, mirrors hook-handler.cjs patterns) =====

function getBridgeLogPath() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join(projectDir, '.hive-flow', 'logs', 'bridge.log');
}

function ensureLogDir() {
  const logPath = getBridgeLogPath();
  const logDir = dirname(logPath);
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
}

function bridgeLog(level, message, meta) {
  try {
    ensureLogDir();
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(meta ? { meta } : {}),
    };
    appendFileSync(getBridgeLogPath(), JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* logging must never break the bridge */ }
}

/**
 * Classify an error into one of: shell_parsing, provider_api, timeout, or other.
 */
function classifyError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('etimedout') || msg.includes('sigkill')) {
    return 'timeout';
  }
  if (msg.includes('enoent') || msg.includes('spawn') || msg.includes('not found') || msg.includes('arg_max') || msg.includes('e2big')) {
    return 'shell_parsing';
  }
  if (msg.includes('api') || msg.includes('401') || msg.includes('403') || msg.includes('429') || msg.includes('500')
      || msg.includes('authentication') || msg.includes('unauthorized') || msg.includes('rate limit')
      || msg.includes('circuit breaker') || msg.includes('invalid api key')) {
    return 'provider_api';
  }
  return 'other';
}

// ===== Stderr Logger (prevents provider logs from corrupting stdout JSON) =====

const stderrLogger = {
  info:  (msg, meta) => process.stderr.write(`[INFO] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`),
  warn:  (msg, meta) => process.stderr.write(`[WARN] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`),
  error: (msg, err)  => process.stderr.write(`[ERROR] ${msg} ${err || ''}\n`),
  debug: (msg, meta) => process.stderr.write(`[DEBUG] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`),
};

// ===== Constants =====

const DEFAULT_MAX_HISTORY_ENTRIES = 50;
const DEFAULT_MAX_PROMPT_BYTES = 180 * 1024; // 180KB

// Per-provider context limits (deepseek has smallest context at 128K)
const PROVIDER_LIMITS = {
  'anthropic-cli': { maxBytes: 180 * 1024, maxEntries: 50 },
  'gemini-cli':    { maxBytes: 180 * 1024, maxEntries: 50 },
  'codex-cli':     { maxBytes: 180 * 1024, maxEntries: 50 },
  'cursor-cli':    { maxBytes: 180 * 1024, maxEntries: 50 },
  'deepseek':      { maxBytes: 100 * 1024, maxEntries: 30 },
};

function getProviderLimits(providerName) {
  return PROVIDER_LIMITS[providerName] || {
    maxBytes: DEFAULT_MAX_PROMPT_BYTES,
    maxEntries: DEFAULT_MAX_HISTORY_ENTRIES
  };
}
const LOCK_ACQUIRE_TIMEOUT = 10000; // 10 seconds — aligned with agent-tools.ts withStoreLock
const LOCK_STALE_THRESHOLD = 30000; // 30 seconds — aligned with agent-tools.ts stale detection

// ===== File Locking (Phase 7A) =====

async function withFileLock(lockPath, fn) {
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT;
  let acquired = false;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath);
      acquired = true;
      break;
    } catch {
      // Check if lock is stale (older than 30s — likely from a crashed process)
      try {
        const lockStat = statSync(lockPath);
        if (Date.now() - lockStat.mtimeMs > LOCK_STALE_THRESHOLD) {
          try { rmdirSync(lockPath); } catch { /* race with another cleaner */ }
          continue; // Retry immediately after removing stale lock
        }
      } catch { /* lock dir gone between checks — retry will succeed */ }
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    }
  }
  if (!acquired) {
    throw new Error(`Failed to acquire lock: ${lockPath} (timeout after ${LOCK_ACQUIRE_TIMEOUT}ms)`);
  }
  try {
    return await fn();
  } finally {
    try { rmdirSync(lockPath); } catch { /* ignore */ }
  }
}

// ===== Agent State =====

function loadAgentState(storeDir, agentId) {
  const storePath = join(storeDir, 'store.json');
  if (!existsSync(storePath)) {
    throw new Error(`Agent store not found: ${storePath}`);
  }

  let store;
  try {
    store = JSON.parse(readFileSync(storePath, 'utf-8'));
  } catch (parseErr) {
    if (parseErr instanceof SyntaxError) {
      throw new Error(`Agent store file is corrupted (invalid JSON): ${storePath}`);
    }
    throw parseErr;
  }
  const agents = store.agents || {};
  const agent = agents[agentId];

  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  if (!agent.provider) {
    throw new Error(`Agent ${agentId} is not a provider-backed agent`);
  }

  return { store, agent, storePath };
}

function saveAgentState(storePath, store) {
  const tmpPath = storePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(store, null, 2));
  renameSync(tmpPath, storePath);
}

// ===== Context Building =====

function buildMessages(agent, newTask) {
  const messages = [];

  // System prompt
  if (agent.systemPrompt) {
    messages.push({ role: 'system', content: agent.systemPrompt });
  }

  // Conversation history
  const history = agent.conversationHistory || [];
  for (const entry of history) {
    const content = entry.content ?? '';
    messages.push({
      role: entry.role,
      content: typeof content === 'string' ? content : JSON.stringify(content),
      ...(entry.toolCalls ? { toolCalls: entry.toolCalls } : {}),
      ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
      ...(entry.name ? { name: entry.name } : {}),
    });
  }

  // New task
  messages.push({ role: 'user', content: newTask });

  return messages;
}

function messageByteLength(msg) {
  const c = msg.content;
  if (typeof c !== 'string') return 0;
  return Buffer.byteLength(c, 'utf8');
}

function trimMessages(messages, limits = getProviderLimits()) {
  let totalBytes = 0;
  for (const msg of messages) {
    totalBytes += messageByteLength(msg);
  }

  if (totalBytes <= limits.maxBytes && messages.length <= limits.maxEntries + 2) {
    return messages;
  }

  const system = messages[0]?.role === 'system' ? [messages[0]] : [];
  const newTask = messages[messages.length - 1];
  let middle = system.length > 0 ? messages.slice(1, -1) : messages.slice(0, -1);

  while (middle.length > 0) {
    let bytes = 0;
    for (const msg of [...system, ...middle, newTask]) {
      bytes += messageByteLength(msg);
    }
    if (bytes <= limits.maxBytes && middle.length + system.length + 1 <= limits.maxEntries + 2) {
      break;
    }
    middle.shift();
  }

  return [...system, ...middle, newTask];
}

// ===== Provider Default Models (loaded from model-alias-resolver if available) =====

let _providerDefaults = null;

async function getProviderDefaults() {
  if (_providerDefaults) return _providerDefaults;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const resolverPath = join(__dirname, '..', 'dist', 'model-alias-resolver.js');

  try {
    if (existsSync(resolverPath)) {
      const mod = await import(pathToFileURL(resolverPath).href);
      if (mod.PROVIDER_DEFAULTS) {
        _providerDefaults = mod.PROVIDER_DEFAULTS;
        return _providerDefaults;
      }
    }
  } catch { /* fallback below */ }

  // Fallback — only used if providers package isn't built
  _providerDefaults = {
    'anthropic-cli': 'claude-sonnet-4-6',
    'gemini-cli': 'gemini-3.1-pro-preview',
    'codex-cli': undefined,
    'cursor-cli': 'auto',
    'deepseek': 'deepseek-reasoner',
  };
  return _providerDefaults;
}

// ===== Provider Resolution =====

async function loadProviderModule() {
  // Try relative import from this script's location to the dist directory
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const distPath = join(__dirname, '..', 'dist', 'index.js');

  if (existsSync(distPath)) {
    return await import(pathToFileURL(distPath).href);
  }

  // Fallback: try package import
  try {
    return await import('@hive-flow/providers');
  } catch {
    throw new Error(
      '@hive-flow/providers not built or installed. Run: cd v3/@hive-flow/providers && npm run build'
    );
  }
}

function isRetryableError(error) {
  if (error && typeof error.retryable === 'boolean') return error.retryable;
  const msg = String(error?.message || error || '').toLowerCase();
  if (msg.includes('circuit breaker') || msg.includes('circuit is open')) return false;
  if (msg.includes('not found') || msg.includes('binary not found')) return false;
  if (msg.includes('authentication') || msg.includes('invalid api key')) return false;
  return true;
}

async function retryWithBackoff(fn, opts = {}) {
  const { maxAttempts = 3, initialDelay = 1000, isRetryable = () => true } = opts;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isRetryable(error)) throw error;
      const retryAfter = error.retryAfter || 0;
      const backoffDelay = initialDelay * Math.pow(2, attempt - 1);
      const jitter = Math.random() * initialDelay * 0.3;
      const delay = Math.max(retryAfter * 1000, backoffDelay) + jitter;
      stderrLogger.warn(`Retry ${attempt}/${maxAttempts - 1} after ${Math.round(delay)}ms: ${error.message || error}`);
      bridgeLog('warn', `Retry ${attempt}/${maxAttempts - 1}`, {
        error: (error.message || String(error)).slice(0, 300),
        classification: classifyError(error),
        delayMs: Math.round(delay),
      });
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

async function createProviderConfig(providerName, model, timeoutMs) {
  const defaults = await getProviderDefaults();
  return {
    provider: providerName,
    model: model || defaults[providerName] || 'auto',
    timeout: timeoutMs || 120000,
    retryAttempts: 2,
    retryDelay: 1000,
  };
}

// ===== MCP Tool Execution =====

let _mcpClient = null;

async function loadMCPClient() {
  if (_mcpClient) return _mcpClient;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Relative path: providers/scripts/ -> cli/dist/src/mcp-client.js
  const mcpClientPath = join(__dirname, '..', '..', 'cli', 'dist', 'src', 'mcp-client.js');

  if (existsSync(mcpClientPath)) {
    _mcpClient = await import(pathToFileURL(mcpClientPath).href);
    return _mcpClient;
  }

  // Fallback: try package import
  try {
    _mcpClient = await import('@hive-flow/cli/mcp-client');
    return _mcpClient;
  } catch {
    // Final fallback
    try {
      _mcpClient = await import('@hive-flow/cli');
      return _mcpClient;
    } catch {
      return null;
    }
  }
}

async function executeMCPTool(toolName, toolArgs) {
  const mcpClient = await loadMCPClient();

  if (!mcpClient || !mcpClient.callMCPTool) {
    stderrLogger.warn(`MCP client unavailable — cannot execute tool: ${toolName}`);
    return {
      status: 'error',
      error: `MCP client not available. Tool '${toolName}' was not executed.`,
    };
  }

  let parsedArgs;
  if (typeof toolArgs === 'string') {
    try {
      parsedArgs = JSON.parse(toolArgs);
    } catch {
      parsedArgs = {};
    }
  } else {
    parsedArgs = toolArgs || {};
  }

  try {
    const result = await mcpClient.callMCPTool(toolName, parsedArgs);
    return result;
  } catch (err) {
    stderrLogger.error(`Tool execution failed: ${toolName}`, err.message || err);
    return {
      status: 'error',
      error: err.message || String(err),
      tool: toolName,
    };
  }
}

// ===== Argument Parsing =====

/**
 * Read all data from stdin (non-TTY only).
 * Returns the full stdin content as a string, or empty string if stdin is a TTY.
 */
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', () => resolve(''));
    // Safety: if nothing arrives within 5s, treat as empty
    setTimeout(() => {
      process.stdin.removeAllListeners();
      resolve(chunks.join(''));
    }, 5000);
  });
}

async function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { agentId: '', task: '', storeDir: '', timeout: 0, taskStdin: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--agent-id':
        parsed.agentId = args[++i] || '';
        break;
      case '--task':
        parsed.task = args[++i] || '';
        break;
      case '--task-stdin':
        parsed.taskStdin = true;
        break;
      case '--store-dir':
        parsed.storeDir = args[++i] || '';
        break;
      case '--timeout':
        parsed.timeout = parseInt(args[++i], 10) || 0;
        break;
    }
  }

  // When --task-stdin is set (or --task is missing), read task from stdin.
  // This avoids shell parsing issues with special characters in task text
  // and bypasses ARG_MAX limits for very long prompts.
  if (parsed.taskStdin || !parsed.task) {
    const stdinTask = await readStdin();
    if (stdinTask.trim()) {
      parsed.task = stdinTask.trim();
    }
  }

  if (!parsed.agentId) throw new Error('Missing required argument: --agent-id');
  if (!parsed.task) throw new Error('Missing required argument: --task (provide via --task <text> or --task-stdin with piped input)');
  if (!parsed.storeDir) {
    const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
    parsed.storeDir = join(home, '.hive-flow', 'agents');
  }

  return parsed;
}

// ===== Provider Usage Tracking =====

function trackProviderUsage(providerName, usage, startTime) {
  try {
    const providerMap = { 'anthropic-cli': 'anthropic', 'gemini-cli': 'gemini', 'codex-cli': 'codex', 'cursor-cli': 'cursor' };
    const mappedName = providerMap[providerName] || providerName;
    const ttfb_ms = Date.now() - startTime;
    const metricsDir = join(process.cwd(), '.hive-flow', 'metrics');
    const metricsPath = join(metricsDir, 'provider-usage.json');

    if (!existsSync(metricsDir)) mkdirSync(metricsDir, { recursive: true });

    let data = { sessionId: `session-${Date.now()}`, startedAt: new Date().toISOString(), providers: {} };
    try {
      if (existsSync(metricsPath)) {
        data = JSON.parse(readFileSync(metricsPath, 'utf8'));
      }
    } catch { /* ignore read error */ }

    if (!data.providers) data.providers = {};
    if (!data.providers[mappedName]) {
      data.providers[mappedName] = { calls: 0, tokens: 0, ttfb_avg_ms: 0, last_used: null };
    }

    const p = data.providers[mappedName];
    const totalTokens = usage?.totalTokens || 0;
    p.ttfb_avg_ms = Math.round(((p.ttfb_avg_ms || 0) * p.calls + ttfb_ms) / (p.calls + 1));
    p.calls += 1;
    p.tokens += totalTokens;
    p.last_used = new Date().toISOString();

    writeFileSync(metricsPath, JSON.stringify(data, null, 2));
  } catch (e) {
    process.stderr.write(`[bridge] Provider usage tracking failed: ${e.message}\n`);
  }
}

// ===== Main =====

async function main() {
  const { agentId, task, storeDir, timeout: parsedTimeout } = await parseArgs();
  const lockPath = join(storeDir, '.store.lock');

  // ── Phase 1: Lock → read state → unlock ──
  const { store, agent, storePath, messages, providerName } = await withFileLock(lockPath, async () => {
    const { store, agent, storePath } = loadAgentState(storeDir, agentId);
    const rawMessages = buildMessages(agent, task);
    const messages = trimMessages(rawMessages, getProviderLimits(agent.provider));
    const providerName = agent.provider;
    return { store, agent, storePath, messages, providerName };
  });

  // ── Phase 2: Provider call (no lock held) ──
  const providerModule = await loadProviderModule();

  const defaults = await getProviderDefaults();
  const config = await createProviderConfig(
    providerName,
    agent.providerModel || defaults[providerName],
    parsedTimeout
  );

  const providerClasses = {
    'anthropic-cli': providerModule.AnthropicCLIProvider,
    'gemini-cli': providerModule.GeminiCLIProvider,
    'codex-cli': providerModule.CodexCLIProvider,
    'cursor-cli': providerModule.CursorCLIProvider,
    'deepseek': providerModule.DeepSeekProvider,
  };

  const ProviderClass = providerClasses[providerName];
  if (!ProviderClass) {
    throw new Error(`Unknown provider: ${providerName}. Supported: ${Object.keys(providerClasses).join(', ')}`);
  }

  const provider = new ProviderClass({ config, logger: stderrLogger });

  try {
    await provider.initialize();
  } catch (initError) {
    try { provider.destroy(); } catch { /* best-effort */ }

    // Log provider initialization failure with classification
    bridgeLog('error', 'Provider initialization failed', {
      agentId,
      provider: providerName,
      error: initError.message || String(initError),
      classification: classifyError(initError),
    });

    const msg = initError.message || String(initError);
    if (msg.includes('not found') || msg.includes('ENOENT')) {
      if (['anthropic-cli', 'gemini-cli', 'codex-cli', 'cursor-cli'].includes(providerName)) {
        throw new Error(`Provider binary for ${providerName} not found. Install it first.`);
      }
      throw new Error(`Provider ${providerName} initialization failed: ${msg}`);
    }
    if (msg.includes('auth') || msg.includes('401') || msg.includes('Unauthorized')) {
      throw new Error(
        `Authentication failed for ${providerName}. Check credentials.`
      );
    }
    throw initError;
  }

  let result;
  try {
    const request = {
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
        ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
        ...(m.name ? { name: m.name } : {}),
      })),
      model: agent.providerModel || defaults[providerName],
      timeout: parsedTimeout || undefined,
    };

    if (agent.config?.tools && Array.isArray(agent.config.tools)) {
      request.tools = agent.config.tools;
    }

    // Log the constructed CLI command / request
    bridgeLog('info', 'Provider request constructed', {
      agentId,
      provider: providerName,
      model: request.model,
      messageCount: request.messages.length,
      taskSummary: task.slice(0, 100),
      timeout: request.timeout || config.timeout,
    });

    let response;
    let iterations = 0;
    const MAX_TOOL_ITERATIONS = 10;
    const providerStartTime = Date.now();

    // Tool-calling loop (no lock held — provider calls can take up to 120s)
    // Note: MCP tool execution requires the CLI MCP client, which is typically
    // unavailable when bridge runs as a subprocess. When unavailable, tool calls
    // are reported in the response but not executed — the provider's text response
    // is used as-is. This is sufficient for prompt-response hive workers.
    const mcpAvailable = !!(await loadMCPClient());

    while (iterations < MAX_TOOL_ITERATIONS) {
      response = await retryWithBackoff(
        () => provider.complete(request),
        {
          maxAttempts: (config.retryAttempts || 0) + 1,
          initialDelay: config.retryDelay || 1000,
          isRetryable: isRetryableError
        }
      );
      iterations++;

      // Log provider response (stdout equivalent)
      bridgeLog('info', 'Provider response received', {
        agentId,
        provider: providerName,
        iteration: iterations,
        model: response.model || request.model,
        contentLength: (response.content || '').length,
        hasToolCalls: !!(response.toolCalls && response.toolCalls.length > 0),
        finishReason: response.finishReason || null,
        usage: response.usage || null,
      });

      if (response.toolCalls && response.toolCalls.length > 0) {
        if (!mcpAvailable) {
          // MCP unavailable — log tool calls for diagnostics, use text response as-is
          for (const toolCall of response.toolCalls) {
            stderrLogger.warn(`Tool call requested but MCP unavailable: ${toolCall.function.name}`, {
              args: (toolCall.function.arguments || '').slice(0, 200),
            });
          }
          // Append tool call info to response content so caller knows what was requested
          const toolSummary = response.toolCalls
            .map((tc) => `[tool_call: ${tc.function.name}]`)
            .join(', ');
          if (!response.content) {
            response.content = `Provider requested tools but MCP is unavailable in bridge subprocess: ${toolSummary}`;
          }
          break;
        }

        for (const toolCall of response.toolCalls) {
          stderrLogger.debug(`Tool call: ${toolCall.function.name}`, {
            args: (toolCall.function.arguments || '').slice(0, 200),
          });
        }

        request.messages.push({
          role: 'assistant',
          content: response.content || '',
          toolCalls: response.toolCalls
        });

        const toolResults = await Promise.all(
          response.toolCalls.map((tc) =>
            executeMCPTool(tc.function.name, tc.function.arguments)
              .then((result) => ({ id: tc.id, name: tc.function.name, result }))
              .catch((err) => ({
                id: tc.id,
                name: tc.function.name,
                result: { status: 'error', error: err.message || String(err) },
              }))
          )
        );

        for (const tr of toolResults) {
          request.messages.push({
            role: 'tool',
            toolCallId: tr.id,
            name: tr.name,
            content: JSON.stringify(tr.result),
          });
        }

        if (response.finishReason !== 'tool_calls') {
          break;
        }
      } else {
        break;
      }
    }

    trackProviderUsage(providerName, response.usage, providerStartTime);

    // Build state updates (computed outside lock, applied inside lock)
    const history = agent.conversationHistory || [];
    history.push({ role: 'user', content: task, timestamp: new Date().toISOString() });

    const initialMessageCount = messages.length;
    const newTurns = request.messages.slice(initialMessageCount);
    for (const turn of newTurns) {
      history.push({ ...turn, timestamp: new Date().toISOString() });
    }

    history.push({ role: 'assistant', content: response.content, timestamp: new Date().toISOString() });

    const limits = getProviderLimits(providerName);
    while (history.length > limits.maxEntries) {
      history.shift();
    }

    agent.conversationHistory = history;
    agent.taskCount = (agent.taskCount || 0) + 1;
    agent.lastTaskAt = new Date().toISOString();
    agent.lastResult = {
      content: (response.content ?? '').slice(0, 10240),
      summary: (response.content ?? '').slice(0, 200),
      model: response.model || request.model,
      usage: response.usage,
      cost: response.cost,
      completedAt: new Date().toISOString(),
    };

    // ── Phase 3: Lock → write state → unlock ──
    await withFileLock(lockPath, async () => {
      // Re-read store to avoid clobbering changes from other agents
      const freshStore = JSON.parse(readFileSync(storePath, 'utf-8'));
      freshStore.agents[agentId] = agent;
      saveAgentState(storePath, freshStore);
    });

    result = {
      success: true,
      agentId,
      content: response.content,
      model: response.model,
      usage: response.usage,
      cost: response.cost,
      historyLength: history.length,
      taskCount: agent.taskCount,
    };
  } finally {
    try { provider.destroy(); } catch { /* ignore */ }
  }

  // Log success
  bridgeLog('info', 'Bridge task completed successfully', {
    agentId,
    provider: providerName,
    taskSummary: task.slice(0, 100),
    model: result.model,
    taskCount: result.taskCount,
    historyLength: result.historyLength,
  });

  // Output result as JSON
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch((err) => {
  // Log failure with error classification
  const classification = classifyError(err);
  // Attempt to extract agentId from argv for the log entry
  const argvAgentIdx = process.argv.indexOf('--agent-id');
  const logAgentId = argvAgentIdx !== -1 ? (process.argv[argvAgentIdx + 1] || 'unknown') : 'unknown';
  bridgeLog('error', 'Bridge task failed', {
    agentId: logAgentId,
    error: err.message || String(err),
    classification,
    code: err.code || 'BRIDGE_ERROR',
  });

  const errorResponse = {
    success: false,
    error: err.message || String(err),
    code: err.code || 'BRIDGE_ERROR',
  };
  process.stdout.write(JSON.stringify(errorResponse, null, 2) + '\n');
  process.exit(1);
});
