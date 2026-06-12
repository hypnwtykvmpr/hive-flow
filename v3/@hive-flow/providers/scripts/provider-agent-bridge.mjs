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
 *   --agent-token <tok>  Agent spawn token for provider subprocess env only
 *   --task-file <path>   Read task prompt from this file (alternative to stdin)
 *   --result-file <path> Write result JSON to this file instead of stdout
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

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, existsSync, rmdirSync, statSync, lstatSync, unlinkSync, readdirSync, openSync, readSync, closeSync, realpathSync, readlinkSync } from 'fs';
import { join, dirname, basename, isAbsolute, resolve, relative, sep } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync } from 'child_process';
import { createHmac, timingSafeEqual } from 'crypto';
import { lookup as dnsLookup } from 'dns/promises';
import { createConnection, isIP } from 'net';
import {
  patternIsRejected,
  fileGlobIsRejected,
  buildRgArgs,
  buildGrepArgs,
} from './bridge-grep-validators.mjs';
import {
  buildProviderConfig,
  isProviderAuthError,
  notifyProviderAuthRequired,
} from './provider-auth-helpers.mjs';
import {
  sandboxExec,
} from './sandbox-runner.mjs';

async function importCliPermissionGuardDist(moduleName) {
  const modulePath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'dist', 'src', 'permission-guard', moduleName);
  if (!existsSync(modulePath)) {
    throw new Error(`CLI permission-guard dist artifact missing: ${modulePath}`);
  }
  return import(pathToFileURL(modulePath).href);
}

const protectedPathPolicy = await importCliPermissionGuardDist('protected-paths.js');
const permissionGuardGate = await importCliPermissionGuardDist('gate.js');

// The bridge runs provider-controlled tool loops. Root override tokens are only
// meaningful to the human's top-level session, never to detached providers.
delete process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN;
delete process.env.HIVE_FLOW_DEV_OVERRIDE;

const BRIDGE_REDACTED = '[REDACTED]';
const BRIDGE_SECRET_KEY_NAMES = /^(?:api[_-]?key|authorization|cookie|token|secret|password)$/i;
const BRIDGE_SECRET_ENV_KEY = /(?:API_KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|CURSOR|QWEN|DASHSCOPE)/i;
const BRIDGE_SECRET_VALUE_PATTERNS = [
  /\bor-[A-Za-z0-9._-]{16,}/g,
  /\bsk-ant-[A-Za-z0-9._-]+/g,
  /\bsk-[A-Za-z0-9._-]+/g,
  /\bBearer\s+[A-Za-z0-9._-]+/gi,
  /\bAIza[A-Za-z0-9._-]+/g,
  /\bCURSOR[A-Za-z0-9._-]*/g,
  /(?<![A-Za-z0-9+/_-])[A-Fa-f0-9]{48,}(?![A-Za-z0-9+/_-])/g,
  /(?<![A-Za-z0-9+/_-])(?:[A-Za-z0-9+/]{40,}={0,2}|[A-Za-z0-9_-]{40,})(?![A-Za-z0-9+/_-])/g,
];

function redactBridgeString(value) {
  let rendered = String(value);
  for (const pattern of BRIDGE_SECRET_VALUE_PATTERNS) {
    rendered = rendered.replace(pattern, BRIDGE_REDACTED);
  }
  return rendered;
}

function redactBridgeCredentialMaterial(value) {
  if (typeof value === 'string') return redactBridgeString(value);
  if (Array.isArray(value)) return value.map(entry => redactBridgeCredentialMaterial(entry));
  if (!value || typeof value !== 'object') return value;

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (BRIDGE_SECRET_KEY_NAMES.test(key)) {
      result[key] = BRIDGE_REDACTED;
      continue;
    }
    if (key === 'env' && entry && typeof entry === 'object') {
      result[key] = Object.fromEntries(
        Object.entries(entry).map(([envKey, envValue]) => [
          envKey,
          BRIDGE_SECRET_ENV_KEY.test(envKey) ? BRIDGE_REDACTED : redactBridgeCredentialMaterial(envValue),
        ]),
      );
      continue;
    }
    result[key] = redactBridgeCredentialMaterial(entry);
  }
  return result;
}

function safeBridgeJsonStringify(value, space) {
  return JSON.stringify(redactBridgeCredentialMaterial(value), null, space);
}

// Module-level limits — set once in main() after provider/model are resolved.
// Used by BRIDGE_FILESYSTEM_TOOLS handlers for context-aware size caps.
let currentBridgeLimits = null;

// ===== Graceful shutdown handlers (prevent orphan bridges) =====

let isShuttingDown = false;

process.on('SIGTERM', () => {
  if (isShuttingDown) return; // Prevent race with error handler
  isShuttingDown = true;

  bridgeLog('warn', 'Bridge received SIGTERM — exiting gracefully');

  // Extract agent info from argv for cleanup
  const argvAgentIdx = process.argv.indexOf('--agent-id');
  const logAgentId = argvAgentIdx !== -1 ? (process.argv[argvAgentIdx + 1] || 'unknown') : 'unknown';

  const argvStoreDirIdx = process.argv.indexOf('--store-dir');
  const rawStoreDir = argvStoreDirIdx !== -1
    ? (process.argv[argvStoreDirIdx + 1] || '')
    : join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.hive-flow', 'agents');
  let storeDir = '';
  try { storeDir = validateFilePath(rawStoreDir); } catch { /* path outside project root — skip store cleanup */ }

  const argvResultIdx = process.argv.indexOf('--result-file');
  const rawResultFile = argvResultIdx !== -1 ? (process.argv[argvResultIdx + 1] || '') : '';
  let resultFile = '';
  try { resultFile = validateFilePath(rawResultFile); } catch { /* path outside project root — skip file write */ }

  // Write error result file
  const errorResponse = {
    success: false,
    error: 'Bridge terminated: SIGTERM',
    code: 'SIGTERM',
    agentId: logAgentId,
  };

  if (resultFile) {
    try {
      const tmpResult = resultFile + `.tmp.${process.pid}`;
      writeFileSync(tmpResult, safeBridgeJsonStringify(errorResponse, 2) + '\n');
      renameSync(tmpResult, resultFile);
    } catch {
      // File write failed — fall back to stdout
      process.stdout.write(safeBridgeJsonStringify(errorResponse, 2) + '\n');
    }
  } else {
    process.stdout.write(safeBridgeJsonStringify(errorResponse, 2) + '\n');
  }

  // Reset agent status to idle (best-effort, synchronous)
  if (storeDir && logAgentId !== 'unknown') {
    const storeLockPath = join(storeDir, '.store.lock');
    let storeLockAcquired = false;
    try {
      mkdirSync(storeLockPath);
      storeLockAcquired = true;

      const { store, storePath } = loadAgentState(storeDir, logAgentId);
      if (store.agents && store.agents[logAgentId]) {
        store.agents[logAgentId].status = 'idle';
        saveAgentState(storePath, store);
      }
    } catch {
      // Ignore errors - this is best-effort cleanup
    } finally {
      if (storeLockAcquired) {
        try { rmdirSync(storeLockPath); } catch { /* ignore */ }
      }
    }
  }

  process.exit(143); // 128 + 15 (SIGTERM)
});

process.on('uncaughtException', (err) => {
  bridgeLog('error', 'Bridge uncaughtException', { error: err?.message || String(err) });
  process.exit(1);
});

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
    appendFileSync(getBridgeLogPath(), safeBridgeJsonStringify(entry) + '\n', 'utf8');
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
  info:  (msg, meta) => process.stderr.write(`[INFO] ${redactBridgeString(msg)} ${meta ? safeBridgeJsonStringify(meta) : ''}\n`),
  warn:  (msg, meta) => process.stderr.write(`[WARN] ${redactBridgeString(msg)} ${meta ? safeBridgeJsonStringify(meta) : ''}\n`),
  error: (msg, err)  => process.stderr.write(`[ERROR] ${redactBridgeString(msg)} ${redactBridgeCredentialMaterial(err || '')}\n`),
  debug: (msg, meta) => process.stderr.write(`[DEBUG] ${redactBridgeString(msg)} ${meta ? safeBridgeJsonStringify(meta) : ''}\n`),
};

// ===== Constants =====

const DEFAULT_MAX_HISTORY_ENTRIES = 50;
const DEFAULT_MAX_PROMPT_TOKENS = 128000; // 128K tokens safe default
const RUN_SHELL_DEFAULT_TIMEOUT_MS = 30_000;
const RUN_SHELL_MAX_TIMEOUT_MS = 120_000;
const RUN_SHELL_DEFAULT_STDOUT_LIMIT_BYTES = 256 * 1024;
const RUN_SHELL_DEFAULT_STDERR_LIMIT_BYTES = 128 * 1024;
const RUN_SHELL_MAX_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const RUN_SHELL_SANDBOX_UNAVAILABLE = 'sandbox-unavailable:no-verified-backend';

// Per-provider context token limits (tokens, not bytes)
// Sources: deepseek=1M (DeepSeek-V4 unified window), gemini-3.1-pro=1M, sonnet=200K, opus=1M, gpt-5.5=400K, cursor=200K
// anthropic-cli can be sonnet (200K) or opus (1M) — use model-aware routing below
// codex-cli uses gpt-5.5 (400K context)
const PROVIDER_TOKEN_LIMITS = {
  'anthropic-cli': { maxTokens: 1000000, maxEntries: 100 },
  'gemini-cli':    { maxTokens: 1000000, maxEntries: 100 },
  'codex-cli':     { maxTokens: 400000,  maxEntries: 50 },
  'cursor-cli':    { maxTokens: 200000,  maxEntries: 50 },
  'deepseek':      { maxTokens: 1000000, maxEntries: 100 },
  'openrouter':    { maxTokens: 128000,  maxEntries: 30 },
};

const STRICT_API_PROVIDERS = new Set(['openrouter', 'deepseek', 'openai', 'qwen']);

// Providers whose models reject OpenAI-style `tool_choice: "required"`. DeepSeek's
// reasoning models ("thinking mode") return HTTP 400 "Thinking mode does not support
// this tool_choice". For these we omit the nudge and let the model decide; grounding
// is still enforced by the UNGROUNDED_TOOL_TASK floor (a strict task that executes
// zero tools is refused), so correctness is preserved without the incompatible flag.
const TOOL_CHOICE_REQUIRED_UNSUPPORTED = new Set(['deepseek']);

// Model-specific overrides (when model is known at runtime)
const MODEL_LIMITS = {
  // Anthropic
  'opus':                       { maxTokens: 1000000, maxEntries: 100 },
  'claude-opus-4-8':             { maxTokens: 1000000, maxEntries: 100 },
  'claude-opus-4-6':             { maxTokens: 1000000, maxEntries: 100 },
  'sonnet':                      { maxTokens: 200000,  maxEntries: 50 },
  'claude-sonnet-4-6':           { maxTokens: 200000,  maxEntries: 50 },
  'claude-haiku-4-5-20251001':   { maxTokens: 200000,  maxEntries: 50 },
  'claude-3-5-sonnet-20241022':  { maxTokens: 200000,  maxEntries: 50 },
  'claude-3-5-sonnet-latest':    { maxTokens: 200000,  maxEntries: 50 },
  'claude-3-opus-20240229':      { maxTokens: 200000,  maxEntries: 50 },
  'claude-3-sonnet-20240229':    { maxTokens: 200000,  maxEntries: 50 },
  'claude-3-haiku-20240307':     { maxTokens: 200000,  maxEntries: 50 },
  // OpenAI / Codex
  'gpt-5.5':                     { maxTokens: 400000,  maxEntries: 50 },
  'gpt-5.3-codex':               { maxTokens: 256000,  maxEntries: 50 },
  'gpt-5.2-codex':               { maxTokens: 256000,  maxEntries: 50 },
  'gpt-5.1-codex-max':           { maxTokens: 256000,  maxEntries: 50 },
  'gpt-5.1-codex':               { maxTokens: 256000,  maxEntries: 50 },
  'gpt-5-codex':                 { maxTokens: 256000,  maxEntries: 50 },
  'gpt-5-codex-mini':            { maxTokens: 128000,  maxEntries: 30 },
  // Gemini
  'gemini-3.5-flash':            { maxTokens: 1000000, maxEntries: 100 },
  'gemini-2.5-pro':              { maxTokens: 1000000, maxEntries: 100 },
  'gemini-2.5-flash':            { maxTokens: 1000000, maxEntries: 100 },
  'gemini-2.5-flash-lite':       { maxTokens: 1000000, maxEntries: 100 },
  'gemini-3-flash-preview':      { maxTokens: 1000000, maxEntries: 100 },
  // DeepSeek
  'deepseek-v4-pro':             { maxTokens: 1000000, maxEntries: 100 },
  'deepseek-v4-flash':           { maxTokens: 1000000, maxEntries: 100 },
  // OpenRouter known defaults
  'xiaomi/mimo-v2.5-pro':                       { maxTokens: 1048576, maxEntries: 100 },
  'x-ai/grok-4.3':                              { maxTokens: 2000000, maxEntries: 100 },
  'minimax/minimax-m3':                         { maxTokens: 204800,  maxEntries: 50 },
  'moonshotai/kimi-k2.6':                       { maxTokens: 262144,  maxEntries: 50 },
  'qwen/qwen3.7-max':                           { maxTokens: 262144,  maxEntries: 50 },
  'z-ai/glm-5.1':                               { maxTokens: 202752,  maxEntries: 50 },
  'qwen/qwen3.6-plus':                          { maxTokens: 1000000, maxEntries: 100 },
  'nvidia/nemotron-3-super-120b-a12b:free':     { maxTokens: 262144,  maxEntries: 50 },
  'deepseek/deepseek-v4-flash':                 { maxTokens: 1000000, maxEntries: 100 },
};

/**
 * Resolve a per-call entry cap from the model's token window.
 *
 * POLICY: Claude Sonnet-class models (anything matching `claude-*-sonnet*`
 * or the bare alias `sonnet`) are capped at 50 entries regardless of token
 * window. This is a project decision — the bridge intentionally trims Sonnet
 * history more aggressively than the vendor's 1M context window would
 * suggest, because reliable performance at full 1M context is not yet
 * production-grade for our workload.
 *
 * Buckets for non-Sonnet models:
 *  - > 500K tokens → 100 entries
 *  - 200K–500K     → 50 entries
 *  - <  200K       → 30 entries
 *
 * @param {number} maxTokens - Token window for the model
 * @param {string} [modelName] - Optional model name for substring matching
 * @returns {number} entry cap
 */
export function maxEntriesForTokenWindow(maxTokens, modelName) {
  const normalizedModel = String(modelName || '').toLowerCase();
  // Anthropic Sonnet class: keep 50-entry cap regardless of token window
  if (/(^|\/)claude-.*sonnet/.test(normalizedModel) || normalizedModel === 'sonnet') {
    return 50;
  }
  if (maxTokens > 500000) return 100;
  if (maxTokens >= 200000) return 50;
  return 30;
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

function assertCredentialHolderSocketIdentity(socketPath) {
  if (process.platform === 'win32') {
    if (!String(process.env.HIVE_FLOW_CREDENTIAL_HOLDER_SOCKET || '').trim()) {
      throw new Error('credential holder named pipe is not configured');
    }
    if (!socketPath.startsWith('\\\\.\\pipe\\')) {
      throw new Error('credential holder named pipe path is invalid');
    }
    return;
  }
  const stat = lstatSync(socketPath);
  if (!stat.isSocket()) throw new Error('credential holder identity check failed: path is not a socket');
  if (process.getuid && stat.uid !== process.getuid()) {
    throw new Error('credential holder identity check failed: socket owner does not match current user');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('credential holder identity check failed: socket permissions must not grant group/other access');
  }
}

function sendCredentialHolderCommand(socketPath, command) {
  assertCredentialHolderSocketIdentity(socketPath);
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(command)}\n`);
    });
    socket.on('data', chunk => { response += chunk; });
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        resolvePromise(JSON.parse(response.trim()));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function normalizeHolderProviderResponse(response) {
  const record = response && typeof response === 'object' ? response : {};
  return {
    content: typeof record.content === 'string' ? record.content : String(record.text || ''),
    model: typeof record.model === 'string' ? record.model : undefined,
    usage: record.usage && typeof record.usage === 'object' ? record.usage : undefined,
    cost: record.cost,
    toolCalls: Array.isArray(record.toolCalls) ? record.toolCalls : undefined,
    finishReason: typeof record.finishReason === 'string' ? record.finishReason : undefined,
    reasoningContent: typeof record.reasoningContent === 'string' ? record.reasoningContent : undefined,
  };
}

function createStrictHolderProvider(providerName, config, agentId) {
  const socketPath = defaultCredentialHolderSocketPath();
  return {
    async initialize() {
      assertCredentialHolderSocketIdentity(socketPath);
    },
    async complete(request) {
      const response = await sendCredentialHolderCommand(socketPath, {
        action: 'provider_call',
        taskId: `provider-bridge-${agentId}-${Date.now()}`,
        provider: providerName,
        request: {
          action: 'complete',
          payload: {
            ...request,
            timeout: request.timeout || config.timeout,
          },
        },
      });
      if (!response.ok) throw new Error(`credential holder provider_call failed: ${response.error || 'unknown error'}`);
      return normalizeHolderProviderResponse(response.response);
    },
    destroy() {},
  };
}

// Token estimation: ~4 chars per token (conservative for code/mixed content)
export function estimateTokensFromText(text) {
  if (typeof text !== 'string') return 0;
  // Rough estimate: characters / 4
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(msg) {
  let tokenCount = 0;
  const content = typeof msg.content === 'string'
    ? msg.content
    : msg.content == null
      ? ''
      : JSON.stringify(msg.content);
  tokenCount += estimateTokensFromText(content);

  const toolCalls = Array.isArray(msg.toolCalls)
    ? msg.toolCalls
    : Array.isArray(msg.tool_calls)
      ? msg.tool_calls
      : [];
  if (toolCalls.length > 0) {
    tokenCount += estimateTokensFromText(JSON.stringify(toolCalls));
  }

  // Name/toolCallId (minor)
  if (msg.name && typeof msg.name === 'string') {
    tokenCount += estimateTokensFromText(msg.name);
  }
  const toolCallId = typeof msg.toolCallId === 'string'
    ? msg.toolCallId
    : typeof msg.tool_call_id === 'string'
      ? msg.tool_call_id
      : null;
  if (toolCallId) {
    tokenCount += estimateTokensFromText(toolCallId);
  }
  // System prompt overhead (role, structure) - add 10 tokens
  return tokenCount + 10;
}

export function getProviderLimits(providerName, modelName) {
  const limits = { ...(PROVIDER_TOKEN_LIMITS[providerName] || {
    maxTokens: DEFAULT_MAX_PROMPT_TOKENS,
    maxEntries: DEFAULT_MAX_HISTORY_ENTRIES,
  }) };

  const modelLimits = modelName ? MODEL_LIMITS[modelName] : undefined;
  if (modelLimits) {
    limits.maxTokens = modelLimits.maxTokens;
    limits.maxEntries = modelLimits.maxEntries ??
      maxEntriesForTokenWindow(modelLimits.maxTokens, modelName);
  } else {
    limits.maxEntries = limits.maxEntries ??
      maxEntriesForTokenWindow(limits.maxTokens, modelName);
  }

  return {
    ...limits,
    maxChars: limits.maxTokens * 4,
    warningThreshold: Math.max(
      Math.floor(limits.maxTokens * 0.5),   // never less than 50%
      Math.min(
        Math.floor(limits.maxTokens * 0.85),
        limits.maxTokens - 40000,
      ),
    ),
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
  const tmpPath = storePath + '.tmp.' + process.pid;
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
      ...(entry.reasoningContent ? { reasoningContent: entry.reasoningContent } : {}),
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

function getToolResultThreshold(limits) {
  const maxTokens = limits?.maxTokens || 128000;
  if (maxTokens >= 800000) return Infinity; // 1M+ models: no truncation, let trimMessages handle
  if (maxTokens >= 200000) return 100 * 1024; // 200K models: 100KB
  if (maxTokens >= 100000) return 30 * 1024; // 128K models: 30KB
  return 5 * 1024; // small models: 5KB
}

function truncateToolResult(content, toolName, limits) {
  if (typeof content !== 'string') return content;
  const threshold = getToolResultThreshold(limits);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes <= threshold) return content;

  // Infinity threshold means no truncation — should not reach here, but guard anyway
  if (threshold === Infinity) return content;

  const lines = content.split('\n');
  const totalLines = lines.length;

  // If content has very few lines relative to size (e.g., JSON-encoded single-line blob),
  // truncate by characters instead of by lines
  if (totalLines <= 5 || bytes / totalLines > 10000) {
    const maxChars = threshold;
    const head = content.slice(0, Math.floor(maxChars * 0.7));
    const tail = content.slice(-Math.floor(maxChars * 0.2));
    const summary = `[TRUNCATED] ${toolName}: ${totalLines} lines, ${bytes} bytes, ${content.length} chars`;
    return head + `\n\n[... ${summary} ...]\n\n` + tail;
  }

  // Keep first 20 and last 10 lines for structure visibility
  const headLines = lines.slice(0, 20);
  const tailLines = lines.slice(-10);
  const droppedLines = totalLines - 30;

  // Build short summary: byte size, line count, first meaningful content hint
  const firstNonEmpty = lines.find(l => l.trim().length > 10) || lines[0] || '';
  const summary = `[TRUNCATED] ${toolName}: ${totalLines} lines, ${bytes} bytes. First: ${firstNonEmpty.trim().slice(0, 80)}`;

  return [
    ...headLines,
    '',
    `[... ${droppedLines} lines truncated — ${summary} ...]`,
    '',
    ...tailLines,
  ].join('\n');
}

// Priority classes for context trimming
const MSG_PRIORITY = {
  SYSTEM: 0,     // system prompt — never drop
  TASK: 1,       // first user message (task assignment) — never drop
  LATEST: 2,     // last user message — never drop
  ASSISTANT: 3,  // assistant reasoning — summarize before dropping
  TOOL_RESULT: 4, // tool results — summarize first (biggest savings)
};

function classifyMessage(msg, index, total) {
  if (msg.role === 'system') return MSG_PRIORITY.SYSTEM;
  if (msg.role === 'user' && index <= 1) return MSG_PRIORITY.TASK;
  if (index === total - 1) return MSG_PRIORITY.LATEST;
  if (msg.role === 'tool') return MSG_PRIORITY.TOOL_RESULT;
  return MSG_PRIORITY.ASSISTANT;
}

function summarizeToolMessage(msg) {
  const content = typeof msg.content === 'string'
    ? msg.content
    : JSON.stringify(msg.content ?? '');
  const lines = content.split('\n').length;
  const bytes = Buffer.byteLength(content, 'utf8');
  const toolName = msg.name || 'unknown';
  const firstLine = content.split('\n').find(l => l.trim().length > 5) || '';
  return {
    ...msg,
    content: `[SUMMARIZED] ${toolName}: ${lines} lines, ${bytes}B. ${firstLine.trim().slice(0, 120)}`,
    _summarized: true,
  };
}

function summarizeAssistantMessage(msg) {
  const content = typeof msg.content === 'string'
    ? msg.content
    : JSON.stringify(msg.content ?? '');
  const toolCalls = Array.isArray(msg.toolCalls)
    ? msg.toolCalls
    : Array.isArray(msg.tool_calls)
      ? msg.tool_calls
      : [];
  if (content.length <= 200) return msg;
  // Keep first sentence + tool call info
  const firstSentence = content.split(/[.!?\n]/).filter(s => s.trim())[0] || '';
  const toolInfo = toolCalls.length > 0
    ? ` [called: ${toolCalls.map(tc => tc.function?.name || tc.name || 'unknown').join(', ')}]`
    : '';
  return {
    ...msg,
    content: `[SUMMARIZED] ${firstSentence.trim().slice(0, 150)}${toolInfo}`,
    _summarized: true,
  };
}

export function trimMessages(messages, limits) {
  if (!limits) {
    throw new Error('trimMessages requires limits');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return Array.isArray(messages) ? messages : [];
  }

  const maxEntries = typeof limits.maxEntries === 'number' ? limits.maxEntries + 2 : Number.POSITIVE_INFINITY;
  const warningThreshold = typeof limits.warningThreshold === 'number' ? limits.warningThreshold : limits.maxTokens;
  const originalMessageCount = messages.length;

  function getToolCalls(msg) {
    if (Array.isArray(msg.toolCalls)) return msg.toolCalls;
    if (Array.isArray(msg.tool_calls)) return msg.tool_calls;
    return [];
  }

  function getToolCallId(msg) {
    if (typeof msg.toolCallId === 'string') return msg.toolCallId;
    if (typeof msg.tool_call_id === 'string') return msg.tool_call_id;
    return null;
  }

  function createMember(msg, index) {
    return {
      index,
      msg,
      tokens: estimateMessageTokens(msg),
      bytes: messageByteLength(msg),
    };
  }

  function finalizeUnit(unit, protectedIndices) {
    unit.members.sort((a, b) => a.index - b.index);
    unit.startIndex = unit.members[0]?.index ?? Number.POSITIVE_INFINITY;
    unit.protected = unit.members.some((member) => protectedIndices.has(member.index));
    unit.tokens = unit.members.reduce((sum, member) => sum + member.tokens, 0);
    return unit;
  }

  function buildLogicalUnits(sourceMessages) {
    const protectedIndices = new Set();
    if (sourceMessages[0]?.role === 'system') protectedIndices.add(0);
    const firstUserIndex = sourceMessages.findIndex((msg, index) => msg.role === 'user' && index <= 1);
    if (firstUserIndex !== -1) protectedIndices.add(firstUserIndex);
    protectedIndices.add(sourceMessages.length - 1);

    const units = [];
    const toolResultBacklog = [];
    const assistantUnitsByCallId = new Map();

    for (let index = 0; index < sourceMessages.length; index++) {
      const msg = sourceMessages[index];
      const member = createMember(msg, index);

      if (msg.role === 'assistant') {
        const toolCalls = getToolCalls(msg);
        if (toolCalls.length > 0) {
          const unit = { members: [member], protected: false, startIndex: index, tokens: 0 };
          units.push(unit);
          for (const toolCall of toolCalls) {
            if (toolCall?.id) assistantUnitsByCallId.set(toolCall.id, unit);
          }
          continue;
        }
      }

      if (msg.role === 'tool') {
        const toolCallId = getToolCallId(msg);
        const parentUnit = toolCallId ? assistantUnitsByCallId.get(toolCallId) : null;
        if (parentUnit) {
          parentUnit.members.push(member);
        } else {
          toolResultBacklog.push(member);
        }
        continue;
      }

      units.push({ members: [member], protected: false, startIndex: index, tokens: 0 });
    }

    for (const member of toolResultBacklog) {
      const toolCallId = getToolCallId(member.msg);
      const parentUnit = toolCallId ? assistantUnitsByCallId.get(toolCallId) : null;
      if (parentUnit) {
        parentUnit.members.push(member);
      } else {
        units.push({ members: [member], protected: false, startIndex: member.index, tokens: 0 });
      }
    }

    return units
      .filter((unit) => unit.members.length > 0)
      .map((unit) => finalizeUnit(unit, protectedIndices))
      .sort((a, b) => a.startIndex - b.startIndex);
  }

  function totalMessageCount(units) {
    return units.reduce((sum, unit) => sum + unit.members.length, 0);
  }

  function recalculateTotals(units) {
    return units.reduce((sum, unit) => sum + unit.tokens, 0);
  }

  function withinHardLimits(units, totalTokens) {
    return totalTokens <= limits.maxTokens && totalMessageCount(units) <= maxEntries;
  }

  function flattenUnits(units) {
    return units
      .slice()
      .sort((a, b) => a.startIndex - b.startIndex)
      .flatMap((unit) => unit.members.slice().sort((a, b) => a.index - b.index).map((member) => member.msg));
  }

  function removeOrphanedToolResults(compactedMessages) {
    const liveToolCallIds = new Set();
    for (const msg of compactedMessages) {
      if (msg.role !== 'assistant') continue;
      for (const toolCall of getToolCalls(msg)) {
        if (toolCall?.id) liveToolCallIds.add(toolCall.id);
      }
    }

    const cleaned = compactedMessages.filter((msg) => {
      if (msg.role !== 'tool') return true;
      const toolCallId = getToolCallId(msg);
      return Boolean(toolCallId && liveToolCallIds.has(toolCallId));
    });

    if (cleaned.length !== compactedMessages.length) {
      bridgeLog('info', 'Removed orphaned tool results', {
        removedCount: compactedMessages.length - cleaned.length,
      });
    }

    return cleaned;
  }

  const units = buildLogicalUnits(messages);
  const originalTokens = recalculateTotals(units);
  let totalTokens = originalTokens;

  bridgeLog('debug', 'Context size check', {
    messages: originalMessageCount,
    units: units.length,
    totalTokens,
    limit: limits.maxTokens,
    warningThreshold,
    provider: limits.provider || 'unknown',
  });

  if (totalTokens <= warningThreshold && withinHardLimits(units, totalTokens)) {
    return removeOrphanedToolResults(flattenUnits(units));
  }

  if (totalTokens > warningThreshold) {
    while (totalTokens > warningThreshold) {
      const dropIndex = units.findIndex((unit) => !unit.protected);
      if (dropIndex === -1) break;

      const [droppedUnit] = units.splice(dropIndex, 1);
      totalTokens -= droppedUnit.tokens;

      bridgeLog('info', 'Proactive unit drop', {
        startIndex: droppedUnit.startIndex,
        members: droppedUnit.members.length,
        roles: droppedUnit.members.map((member) => member.msg.role),
        tokens: droppedUnit.tokens,
        remainingTokens: totalTokens,
        warningThreshold,
      });
    }

    if (totalTokens <= warningThreshold && withinHardLimits(units, totalTokens)) {
      const compacted = removeOrphanedToolResults(flattenUnits(units));
      bridgeLog('info', 'Proactive trimming successful', {
        originalTokens,
        finalTokens: totalTokens,
        droppedMessages: originalMessageCount - compacted.length,
      });
      return compacted;
    }
  }

  for (const unit of units) {
    if (unit.protected) continue;
    for (const member of unit.members) {
      if (member.msg.role !== 'tool' || member.msg._summarized) continue;

      const summarized = summarizeToolMessage(member.msg);
      if (summarized === member.msg) continue;

      const originalMemberTokens = member.tokens;
      member.msg = summarized;
      member.tokens = estimateMessageTokens(summarized);
      member.bytes = messageByteLength(summarized);
      unit.tokens += member.tokens - originalMemberTokens;
      totalTokens += member.tokens - originalMemberTokens;

      bridgeLog('debug', 'Tool result summarized', {
        startIndex: unit.startIndex,
        toolName: member.msg.name || 'unknown',
        originalTokens: originalMemberTokens,
        summarizedTokens: member.tokens,
        savedTokens: originalMemberTokens - member.tokens,
        remainingTokens: totalTokens,
      });

      if (withinHardLimits(units, totalTokens)) break;
    }
    if (withinHardLimits(units, totalTokens)) break;
  }

  if (withinHardLimits(units, totalTokens)) {
    return removeOrphanedToolResults(flattenUnits(units));
  }

  for (const unit of units) {
    if (unit.protected) continue;
    for (const member of unit.members) {
      if (member.msg.role !== 'assistant' || member.msg._summarized) continue;

      const summarized = summarizeAssistantMessage(member.msg);
      if (summarized === member.msg) continue;

      const originalMemberTokens = member.tokens;
      member.msg = summarized;
      member.tokens = estimateMessageTokens(summarized);
      member.bytes = messageByteLength(summarized);
      unit.tokens += member.tokens - originalMemberTokens;
      totalTokens += member.tokens - originalMemberTokens;

      bridgeLog('debug', 'Assistant message summarized', {
        startIndex: unit.startIndex,
        originalTokens: originalMemberTokens,
        summarizedTokens: member.tokens,
        savedTokens: originalMemberTokens - member.tokens,
        remainingTokens: totalTokens,
      });

      if (withinHardLimits(units, totalTokens)) break;
    }
    if (withinHardLimits(units, totalTokens)) break;
  }

  while (!withinHardLimits(units, totalTokens)) {
    const dropIndex = units.findIndex((unit) => !unit.protected);
    if (dropIndex === -1) break;

    const [droppedUnit] = units.splice(dropIndex, 1);
    totalTokens -= droppedUnit.tokens;

    bridgeLog('info', 'Last-resort unit drop', {
      startIndex: droppedUnit.startIndex,
      members: droppedUnit.members.length,
      roles: droppedUnit.members.map((member) => member.msg.role),
      tokens: droppedUnit.tokens,
      remainingTokens: totalTokens,
    });
  }

  // Safety net: if protected messages alone exceed the limit, aggressively truncate
  // the largest message content to fit. Never return over-limit.
  let result = removeOrphanedToolResults(flattenUnits(units));
  let finalTokens = result.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);

  if (finalTokens > limits.maxTokens && result.length > 0) {
    bridgeLog('warn', 'Protected messages exceed limit — emergency truncation', {
      finalTokens,
      limit: limits.maxTokens,
      messages: result.length,
    });

    // Find the largest message and truncate its content
    let largestIdx = 0;
    let largestTokens = 0;
    for (let i = 0; i < result.length; i++) {
      const t = estimateMessageTokens(result[i]);
      if (t > largestTokens) { largestTokens = t; largestIdx = i; }
    }

    const msg = result[largestIdx];
    if (typeof msg.content === 'string' && msg.content.length > 1000) {
      const targetChars = Math.floor((limits.maxTokens * 0.7) * 4); // rough chars for 70% of limit
      msg.content = msg.content.slice(0, targetChars) +
        `\n\n[EMERGENCY TRUNCATION: content exceeded ${limits.maxTokens} token limit. Original: ${msg.content.length} chars]`;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 1000) {
          const targetChars = Math.floor((limits.maxTokens * 0.7) * 4);
          part.text = part.text.slice(0, targetChars) +
            `\n\n[EMERGENCY TRUNCATION: content exceeded ${limits.maxTokens} token limit]`;
          break;
        }
      }
    }

    result = removeOrphanedToolResults(result);
    finalTokens = result.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
  }

  bridgeLog('info', 'Context compaction complete', {
    originalMessages: originalMessageCount,
    finalMessages: result.length,
    originalTokens,
    finalTokens,
    limit: limits.maxTokens,
    compactionApplied: originalMessageCount !== result.length || originalTokens !== finalTokens,
  });

  return result;
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
    'anthropic-cli': 'claude-opus-4-8',
    'gemini-cli': 'gemini-3.5-flash',
    'codex-cli': 'gpt-5.5',
    'cursor-cli': 'auto',
    'deepseek': 'deepseek-v4-pro',
    'openrouter': 'xiaomi/mimo-v2.5-pro',
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

/**
 * Map an agent's alias-level model to the OpenRouter tier pool to reroll from.
 *
 * Note: `haiku` is intentionally absent — legacy persisted state with
 * `agent.model: 'haiku'` falls through to the `opus` tier rather than re-
 * routing into a haiku-tier model (which would bypass the haiku ban).
 *
 * @param {string} model - Alias-level agent model (opus/sonnet/mini/inherit/etc.)
 * @returns {'opus'|'sonnet'|'haiku'} OpenRouter tier name
 */
function openRouterTierForAgentModel(model) {
  if (model === 'opus') return 'opus';
  if (model === 'sonnet' || model === 'mini') return 'sonnet';
  // Note: 'haiku' is NOT a valid alias for agent tasks per project policy.
  // If legacy state persists haiku, treat it as unknown and fall back to opus.
  return 'opus'; // inherit, missing, haiku-from-legacy, unknown
}

/**
 * Pick an OpenRouter model from `pool` that the agent has not yet attempted
 * during the current task. Returns undefined when no untried models remain
 * (caller should throw OPENROUTER_TIER_EXHAUSTED).
 *
 * @param {string[]} pool - Tier pool from OpenRouter config
 * @param {string|undefined} currentModel - Model that just failed
 * @param {Set<string>} attemptedModels - Models already tried this task
 * @param {(pool: string[]) => string|undefined} selectFromPool - Random picker
 * @returns {string|undefined} next untried model, or undefined if exhausted
 */
function chooseUntriedOpenRouterModel(pool, currentModel, attemptedModels, selectFromPool) {
  if (!Array.isArray(pool) || pool.length === 0) return undefined;
  const available = pool.filter((candidate) =>
    candidate && candidate !== currentModel && !attemptedModels.has(candidate)
  );
  if (available.length === 0) return undefined;
  return selectFromPool(available) ?? available[0];
}

/**
 * Build a non-retryable error indicating all models in a tier have been
 * exhausted for the current task. Marked `retryable: false` so retryWithBackoff
 * short-circuits.
 *
 * @param {string} tier - Tier name (opus/sonnet/haiku)
 * @param {Set<string>} attemptedModels - Models tried during this task
 * @returns {Error} non-retryable error with code OPENROUTER_TIER_EXHAUSTED
 */
function makeOpenRouterTierExhaustedError(tier, attemptedModels) {
  const error = new Error(
    `OpenRouter ${tier} tier exhausted after timeout rerolls; attempted models: ${Array.from(attemptedModels).join(', ')}`
  );
  error.code = 'OPENROUTER_TIER_EXHAUSTED';
  error.retryable = false;
  return error;
}

async function createProviderConfig(providerName, model, timeoutMs, agentToken) {
  const defaults = await getProviderDefaults();
  return buildProviderConfig({
    providerName,
    model,
    timeoutMs,
    agentToken,
    defaults,
    env: process.env,
    cwd: process.cwd(),
  });
}

// ===== Bridge Tool Execution =====

// ===== Bridge Filesystem Security Guardrails =====

const PROJECT_ROOT = resolve(process.cwd());
const FAIL_CLOSED_ENFORCEMENT_LEVEL = 2;

function validateFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('Missing required file path');
  }
  const resolved = resolve(filePath);
  if (!resolved.startsWith(PROJECT_ROOT + '/') && resolved !== PROJECT_ROOT) {
    throw new Error(`Path traversal blocked: ${filePath} resolves outside project root`);
  }
  return resolved;
}

function isProtectedPath(filePath) {
  return protectedPathPolicy.isProtectedWritePath(filePath, PROJECT_ROOT);
}

function isProtectedReadPath(filePath) {
  return protectedPathPolicy.isProtectedReadPath(filePath, PROJECT_ROOT);
}

function assertReadableByBridge(filePath, operation) {
  if (isProtectedReadPath(filePath)) {
    const match = protectedPathPolicy.findProtectedReadPath(filePath, PROJECT_ROOT);
    throw new Error(`${operation} blocked: ${filePath} is a protected read path (${match?.entry || 'policy'})`);
  }
}

function readBridgeHmacKey() {
  try {
    const key = readFileSync(resolve(PROJECT_ROOT, '.hive-flow', 'enforcement', '.hmac-key'), 'utf8').trim();
    return key || null;
  } catch {
    return null;
  }
}

function readVerifiedEnforcementLevel(statePath, missingLevel = 0) {
  return readVerifiedEnforcementState(statePath, missingLevel).level;
}

function normalizedRestrictedGroups(state, level) {
  const groups = Array.isArray(state?.restrictedGroups)
    ? state.restrictedGroups.filter((group) => typeof group === 'string')
    : [];
  if (level >= FAIL_CLOSED_ENFORCEMENT_LEVEL && groups.length === 0) {
    return ['exec', 'write'];
  }
  return [...new Set(groups)];
}

function failClosedEnforcementState() {
  return {
    level: FAIL_CLOSED_ENFORCEMENT_LEVEL,
    restrictedGroups: ['exec', 'write'],
  };
}

function missingEnforcementState(missingLevel) {
  return {
    level: missingLevel,
    restrictedGroups: missingLevel >= FAIL_CLOSED_ENFORCEMENT_LEVEL ? ['exec', 'write'] : [],
  };
}

function readVerifiedEnforcementState(statePath, missingLevel = 0) {
  try {
    if (!existsSync(statePath)) return missingEnforcementState(missingLevel);
    const key = readBridgeHmacKey();
    if (!key) return failClosedEnforcementState();
    const envelope = JSON.parse(readFileSync(statePath, 'utf-8'));
    if (!envelope?.state || typeof envelope.hmac !== 'string') {
      return failClosedEnforcementState();
    }

    const expected = createHmac('sha256', key).update(JSON.stringify(envelope.state)).digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(envelope.hmac, 'hex');
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      return failClosedEnforcementState();
    }

    const level = Number(envelope.state.level);
    if (!Number.isFinite(level)) return failClosedEnforcementState();
    return {
      level,
      restrictedGroups: normalizedRestrictedGroups(envelope.state, level),
    };
  } catch {
    return failClosedEnforcementState();
  }
}

function scopedStatePath(scopeType, scopeId) {
  const sanitized = protectedPathPolicy.sanitizeScopeId(scopeId, '', 64);
  if (!sanitized) return null;
  if (scopeType === 'agent') return resolve(PROJECT_ROOT, '.hive-flow', 'enforcement', 'agents', sanitized, 'state.json');
  if (scopeType === 'hive') return resolve(PROJECT_ROOT, '.hive-flow', 'enforcement', 'hives', sanitized, 'state.json');
  return null;
}

function checkEnforcementState() {
  const snapshots = [
    readVerifiedEnforcementState(resolve(PROJECT_ROOT, '.hive-flow', 'enforcement', 'state.json'), FAIL_CLOSED_ENFORCEMENT_LEVEL),
  ];

  const agentId = process.env.AGENTIC_FLOW_AGENT_ID || process.env.CLAUDE_AGENT_ID || '';
  const agentState = scopedStatePath('agent', agentId);
  if (agentState) snapshots.push(readVerifiedEnforcementState(agentState, 0));

  const hiveState = scopedStatePath('hive', process.env.HIVE_FLOW_HIVE_ID || '');
  if (hiveState) snapshots.push(readVerifiedEnforcementState(hiveState, 0));

  return {
    level: Math.max(...snapshots.map((snapshot) => snapshot.level)),
    restrictedGroups: [...new Set(snapshots.flatMap((snapshot) => snapshot.restrictedGroups))],
  };
}

function checkEnforcementLevel() {
  return checkEnforcementState().level;
}

function bridgeWriteBlockReason() {
  const state = checkEnforcementState();
  if (state.level >= FAIL_CLOSED_ENFORCEMENT_LEVEL) {
    return 'Writes blocked at enforcement level RESTRICTED+';
  }
  if (state.restrictedGroups.includes('write')) {
    return 'Writes blocked by restricted write group';
  }
  return null;
}

function bridgeExecBlockReason() {
  const state = checkEnforcementState();
  if (state.level >= FAIL_CLOSED_ENFORCEMENT_LEVEL) {
    return 'Execution blocked at enforcement level RESTRICTED+';
  }
  if (state.restrictedGroups.includes('exec')) {
    return 'Execution blocked by restricted exec group';
  }
  if (state.restrictedGroups.includes('write')) {
    return 'Execution blocked by restricted write group';
  }
  return null;
}

function bridgeFetchBlockReason() {
  const state = checkEnforcementState();
  if (state.level >= FAIL_CLOSED_ENFORCEMENT_LEVEL) {
    return 'Fetch blocked at enforcement level RESTRICTED+';
  }
  if (state.restrictedGroups.includes('fetch')) {
    return 'Fetch blocked by restricted fetch group';
  }
  if (state.restrictedGroups.includes('exec')) {
    return 'Fetch blocked by restricted exec group';
  }
  return null;
}

function casefoldPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/').toLowerCase();
}

function resolveRealPathForBridge(filePath) {
  const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(PROJECT_ROOT, filePath);
  try {
    return realpathSync.native(absolute);
  } catch {
    const missingSegments = [];
    let current = absolute;
    while (true) {
      try {
        const linkTarget = readlinkSync(current);
        const targetAbsolute = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(current), linkTarget);
        return resolve(targetAbsolute, ...missingSegments.reverse());
      } catch {
        // Not a symlink at this segment.
      }
      try {
        return resolve(realpathSync.native(current), ...missingSegments.reverse());
      } catch {
        const parent = dirname(current);
        if (parent === current) return absolute;
        missingSegments.push(basename(current));
        current = parent;
      }
    }
  }
}

function searchMayIncludeProtectedReadPath(searchPath) {
  const searchRoot = casefoldPath(resolveRealPathForBridge(searchPath));
  return protectedPathPolicy.getProtectedReadPaths(PROJECT_ROOT).some((entry) => {
    const protectedTarget = casefoldPath(resolveRealPathForBridge(entry.absolutePath));
    const rel = relative(searchRoot, protectedTarget);
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
  });
}

function toRgGlobPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function addProtectedReadRgGlob(globs, value, isDirectory) {
  const clean = toRgGlobPath(value).replace(/\/+$/, '');
  if (!clean || clean === '.') return;
  globs.add(`!${clean}`);
  if (isDirectory) {
    globs.add(`!${clean}/**`);
  }
}

function protectedReadRgGlobs(searchPath = PROJECT_ROOT) {
  const globs = new Set();
  const searchRoot = resolveRealPathForBridge(searchPath);
  for (const entry of protectedPathPolicy.loadPolicy().protectedRead) {
    if (entry.includes('${HOME}')) continue;
    const isDirectory = entry.endsWith('/');
    const cleanEntry = entry.replace(/^\.\//, '').replace(/\/+$/, '');
    addProtectedReadRgGlob(globs, cleanEntry, isDirectory);

    const protectedAbsolute = resolveRealPathForBridge(protectedPathPolicy.expandPolicyPath(entry, PROJECT_ROOT));
    const relativeToSearch = relative(searchRoot, protectedAbsolute);
    if (relativeToSearch === '' || (!relativeToSearch.startsWith('..') && !relativeToSearch.startsWith(sep))) {
      addProtectedReadRgGlob(globs, relativeToSearch || basename(protectedAbsolute), isDirectory);
    }
  }
  return [...globs];
}

function runShellDenied(denyReason, error = denyReason) {
  return {
    status: 'denied',
    exitCode: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false,
    sandboxBackend: null,
    denyReason,
    ...(error ? { error } : {}),
  };
}

function clampInteger(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function shellQuoteArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function commandName(value) {
  return basename(String(value || '')).toLowerCase();
}

function isEnvAssignmentToken(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(token || ''));
}

function parseSimpleRunShellCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('run_shell requires a non-empty command or argv array');
  }
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];
    const next = command[index + 1];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === '$' && next === '(') {
      throw new Error('run_shell command substitution is not available');
    }
    if (ch === '`') {
      throw new Error('run_shell backtick command substitution is not available');
    }
    if (ch === '\n' || ch === '\r') {
      throw new Error('run_shell multiline commands are not available');
    }
    if (';&|<>'.includes(ch)) {
      throw new Error('run_shell shell operators, redirects, pipes, and heredocs are not available');
    }

    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    current += ch;
  }

  if (escaped || quote) {
    throw new Error('run_shell command has unterminated quoting or escaping');
  }
  pushCurrent();

  if (tokens.length === 0) {
    throw new Error('run_shell command did not contain an executable');
  }
  if (isEnvAssignmentToken(tokens[0])) {
    throw new Error('run_shell environment-prefix commands are not available');
  }
  return tokens;
}

function normalizeRunShellArgs(args) {
  if (Array.isArray(args?.argv)) {
    if (args.argv.length === 0) {
      throw new Error('run_shell argv must not be empty');
    }
    const argv = args.argv.map((entry) => {
      if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
        throw new Error('run_shell argv entries must be primitive strings');
      }
      return String(entry);
    });
    if (argv.some((entry) => entry.length === 0)) {
      throw new Error('run_shell argv entries must not be empty');
    }
    if (isEnvAssignmentToken(argv[0])) {
      throw new Error('run_shell environment-prefix commands are not available');
    }
    return {
      argv,
      command: argv.map(shellQuoteArg).join(' '),
      mode: 'argv',
    };
  }

  if (typeof args?.command === 'string') {
    if (args.command.trim() === '') {
      throw new Error('run_shell requires a non-empty command or argv array');
    }
    return {
      argv: null,
      command: args.command.trim(),
      mode: 'command',
    };
  }

  throw new Error('run_shell requires either command or argv');
}

function denyUnsafeRunShellCommand(renderedCommand, argv) {
  const executable = commandName(argv[0]);
  if (!executable) return 'run_shell command has no executable';

  const shellWrappers = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
  if (shellWrappers.has(executable)) {
    return 'run_shell shell wrapper launchers are not available';
  }

  const launcherWrappers = new Set([
    'codex',
    'claude',
    'cursor',
    'gemini',
    'qwen',
    'opencode',
    'tmux',
    'zellij',
    'screen',
    'script',
    'nohup',
    'setsid',
    'open',
    'osascript',
  ]);
  if (launcherWrappers.has(executable)) {
    return `run_shell launcher '${executable}' is not available to provider agents`;
  }

  if (executable === 'env') {
    return 'run_shell env launcher wrappers are not available';
  }

  if (argv.some((entry) => /^\/proc\/(?:self|\d+)\/environ$/i.test(String(entry).replace(/\\/g, '/')))) {
    return 'run_shell /proc/*/environ reads are not available';
  }

  if (executable === 'printenv') {
    return 'run_shell printenv is not available because it can expose provider credentials';
  }

  if (executable === 'ps' && argv.slice(1).some((entry) => entry === 'eww' || entry === 'auxeww' || entry === '-E')) {
    return 'run_shell ps environment output is not available';
  }

  if (executable === 'security' && argv[1] === 'find-generic-password' &&
      argv.slice(2).some((entry) => entry === '-w' || entry === '--password')) {
    return 'run_shell macOS keychain password output is not available';
  }

  if (executable === 'secret-tool' && argv[1] === 'lookup') {
    return 'run_shell libsecret lookup output is not available';
  }

  if (executable === 'cmdkey') {
    return 'run_shell Windows credential listing is not available';
  }

  if ((executable === 'powershell' || executable === 'pwsh') &&
      argv.slice(1).some((entry) => /Get-StoredCredential/i.test(entry))) {
    return 'run_shell Windows credential retrieval is not available';
  }

  if (executable === 'git' && String(argv[1] || '').toLowerCase() === 'push') {
    return 'run_shell git push is not available to provider agents';
  }

  if ((executable === 'node' || executable === 'python' || executable === 'python3') &&
      argv.slice(1).some((entry) => entry === '-e' || entry === '--eval' || entry === '-c')) {
    return 'run_shell inline code execution is not available';
  }

  if (/[;&|<>`]/.test(renderedCommand) || /\$\(/.test(renderedCommand)) {
    return 'run_shell shell operators, redirects, pipes, heredocs, and command substitution are not available';
  }

  return null;
}

async function evaluateRunShellBashGate(renderedCommand) {
  if (!permissionGuardGate?.evaluateHookInput) {
    return {
      allowed: false,
      reason: 'permission-guard gate did not export evaluateHookInput',
    };
  }
  try {
    const decision = await permissionGuardGate.evaluateHookInput({
      tool_name: 'Bash',
      tool_input: { command: renderedCommand },
      cwd: PROJECT_ROOT,
      session_id: process.env.CLAUDE_SESSION_ID || 'provider-bridge-run-shell',
    });
    if (decision?.decision === 'allow') {
      return { allowed: true, reason: decision.reason || '' };
    }
    return {
      allowed: false,
      reason: decision?.reason || 'permission-guard denied Bash command',
    };
  } catch (err) {
    return {
      allowed: false,
      reason: `permission-guard gate error: ${err?.message || String(err)}`,
    };
  }
}

async function runShellTool(rawArgs, ctx = {}) {
  let normalized;
  try {
    normalized = normalizeRunShellArgs(rawArgs);
  } catch (err) {
    return runShellDenied('invalid-run-shell-args', err.message || String(err));
  }

  const execBlockReason = bridgeExecBlockReason();
  if (execBlockReason) {
    return runShellDenied('restricted-exec-or-write', execBlockReason);
  }

  const gateDecision = await evaluateRunShellBashGate(normalized.command);
  if (!gateDecision.allowed) {
    return runShellDenied('bash-gate-denied', gateDecision.reason);
  }

  let argv = normalized.argv;
  if (normalized.mode === 'command') {
    try {
      argv = parseSimpleRunShellCommand(normalized.command);
    } catch (err) {
      return runShellDenied('bash-gate-denied', err.message || String(err));
    }
  }

  const unsafeReason = denyUnsafeRunShellCommand(normalized.command, argv);
  if (unsafeReason) {
    return runShellDenied('bash-gate-denied', unsafeReason);
  }

  const sandboxOptions = ctx.sandboxOptions && typeof ctx.sandboxOptions === 'object'
    ? ctx.sandboxOptions
    : {};
  const sandboxResult = await sandboxExec(argv, {
    ...sandboxOptions,
    projectRoot: PROJECT_ROOT,
    timeoutMs: clampInteger(rawArgs.timeoutMs, RUN_SHELL_DEFAULT_TIMEOUT_MS, RUN_SHELL_MAX_TIMEOUT_MS),
    stdoutLimitBytes: clampInteger(rawArgs.stdoutLimitBytes, RUN_SHELL_DEFAULT_STDOUT_LIMIT_BYTES, RUN_SHELL_MAX_OUTPUT_LIMIT_BYTES),
    stderrLimitBytes: clampInteger(rawArgs.stderrLimitBytes, RUN_SHELL_DEFAULT_STDERR_LIMIT_BYTES, RUN_SHELL_MAX_OUTPUT_LIMIT_BYTES),
  });

  if (sandboxResult.status === 'denied') {
    const denied = runShellDenied(
      sandboxResult.denyReason || RUN_SHELL_SANDBOX_UNAVAILABLE,
      sandboxResult.denyReason || RUN_SHELL_SANDBOX_UNAVAILABLE,
    );
    if (sandboxOptions.debugDiagnostics) {
      denied.sandboxDiagnostics = sandboxResult.diagnostics;
    }
    return denied;
  }

  return {
    status: 'executed',
    exitCode: typeof sandboxResult.code === 'number' ? sandboxResult.code : null,
    stdout: sandboxResult.stdout || '',
    stderr: sandboxResult.stderr || '',
    timedOut: sandboxResult.status === 'timeout',
    truncated: Boolean(sandboxResult.stdoutTruncated || sandboxResult.stderrTruncated),
    sandboxBackend: sandboxResult.backend || null,
  };
}

const RUN_COMMAND_DEFAULT_TIMEOUT_MS = 10_000;
const RUN_COMMAND_OUTPUT_LIMIT_BYTES = 32 * 1024;

function runCommandDenied(denyReason, error = denyReason) {
  return {
    status: 'denied',
    exitCode: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false,
    denyReason,
    error,
  };
}

function normalizeRunCommandArgs(rawArgs) {
  try {
    return normalizeRunShellArgs(rawArgs);
  } catch (err) {
    throw new Error(String(err?.message || err).replaceAll('run_shell', 'run_command'));
  }
}

function looksLikeRunCommandPathArg(value) {
  const text = String(value || '');
  if (!text || text.startsWith('-')) return false;
  if (/^\d+$/.test(text)) return false;
  if (/^[+~]?\d+[kKmMgG]?$/.test(text)) return false;
  return true;
}

function assertRunCommandPathArgs(argv, startIndex = 1) {
  for (const arg of argv.slice(startIndex)) {
    if (!looksLikeRunCommandPathArg(arg)) continue;
    const safePath = validateFilePath(arg);
    assertReadableByBridge(safePath, 'run_command');
  }
}

function denyUnsafeReadOnlyCommand(argv) {
  const executable = commandName(argv[0]);
  if (!executable) return 'run_command command has no executable';

  if (executable === 'git') {
    const firstSubcommandIndex = argv.findIndex((entry, index) => index > 0 && !String(entry).startsWith('-'));
    const subcommand = firstSubcommandIndex === -1 ? '' : String(argv[firstSubcommandIndex]).toLowerCase();
    const allowedGitSubcommands = new Set([
      'status',
      'diff',
      'log',
      'show',
      'rev-parse',
      'ls-files',
      'describe',
      'cat-file',
    ]);
    if (!allowedGitSubcommands.has(subcommand)) {
      return `run_command git subcommand '${subcommand || '<missing>'}' is not in the read-only allowlist`;
    }
    for (const arg of argv.slice(1)) {
      const text = String(arg);
      if (
        text === '-c' ||
        text.startsWith('-c=') ||
        text.startsWith('--exec-path') ||
        text.startsWith('--upload-pack') ||
        text.startsWith('--receive-pack') ||
        text.startsWith('--output') ||
        text === '--no-index'
      ) {
        return `run_command git option '${text}' is not available`;
      }
    }
    return null;
  }

  if (executable === 'pwd') {
    return argv.length === 1 ? null : 'run_command pwd does not accept arguments';
  }

  if (executable === 'tail' && argv.slice(1).some((arg) => arg === '-f' || arg === '--follow' || String(arg).startsWith('--follow='))) {
    return 'run_command tail follow mode is not available';
  }

  const pathReadExecutables = new Set(['cat', 'head', 'tail', 'wc', 'ls']);
  if (pathReadExecutables.has(executable)) {
    assertRunCommandPathArgs(argv, 1);
    return null;
  }

  return `run_command executable '${executable}' is not in the read-only allowlist`;
}

async function runCommandTool(rawArgs) {
  let normalized;
  try {
    normalized = normalizeRunCommandArgs(rawArgs);
  } catch (err) {
    return runCommandDenied('invalid-run-command-args', err.message || String(err));
  }

  let argv = normalized.argv;
  if (normalized.mode === 'command') {
    try {
      argv = parseSimpleRunShellCommand(normalized.command);
    } catch (err) {
      return runCommandDenied('read-only-command-denied', String(err?.message || err).replaceAll('run_shell', 'run_command'));
    }
  }

  let unsafeReason;
  try {
    unsafeReason = denyUnsafeReadOnlyCommand(argv);
  } catch (err) {
    return runCommandDenied('read-only-command-denied', err.message || String(err));
  }
  if (unsafeReason) return runCommandDenied('read-only-command-denied', unsafeReason);

  try {
    const output = execFileSync(argv[0], argv.slice(1), {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: clampInteger(rawArgs?.timeoutMs, RUN_COMMAND_DEFAULT_TIMEOUT_MS, RUN_COMMAND_DEFAULT_TIMEOUT_MS),
      maxBuffer: RUN_COMMAND_OUTPUT_LIMIT_BYTES * 2,
    });
    const truncated = Buffer.byteLength(output, 'utf8') > RUN_COMMAND_OUTPUT_LIMIT_BYTES;
    return {
      status: 'executed',
      exitCode: 0,
      stdout: truncated ? output.slice(0, RUN_COMMAND_OUTPUT_LIMIT_BYTES) : output,
      stderr: '',
      timedOut: false,
      truncated,
    };
  } catch (err) {
    const stdout = typeof err.stdout === 'string' ? err.stdout : '';
    const stderr = typeof err.stderr === 'string' ? err.stderr : '';
    return {
      status: 'executed',
      exitCode: typeof err.status === 'number' ? err.status : null,
      stdout: stdout.slice(0, RUN_COMMAND_OUTPUT_LIMIT_BYTES),
      stderr: stderr.slice(0, RUN_COMMAND_OUTPUT_LIMIT_BYTES),
      timedOut: Boolean(err.killed || err.signal === 'SIGTERM' || /timed out/i.test(err.message || '')),
      truncated:
        Buffer.byteLength(stdout, 'utf8') > RUN_COMMAND_OUTPUT_LIMIT_BYTES ||
        Buffer.byteLength(stderr, 'utf8') > RUN_COMMAND_OUTPUT_LIMIT_BYTES,
    };
  }
}

const WEB_FETCH_DEFAULT_MAX_BYTES = 512 * 1024;
const WEB_FETCH_MAX_BYTES = 2 * 1024 * 1024;
const WEB_FETCH_DEFAULT_TIMEOUT_MS = 15_000;
const WEB_FETCH_MAX_TIMEOUT_MS = 30_000;
const WEB_FETCH_DEFAULT_MAX_REDIRECTS = 5;
const WEB_FETCH_MAX_REDIRECTS = 10;

function webResultBase() {
  return {
    finalUrl: null,
    httpStatus: null,
    contentType: '',
    bytes: 0,
    truncated: false,
    redirectCount: 0,
  };
}

function webDenied(denyReason, fields = {}) {
  return {
    status: 'denied',
    ...webResultBase(),
    ...fields,
    denyReason,
  };
}

function normalizeAllowlistHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  try {
    return new URL(`https://${host}`).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return host;
  }
}

function normalizeWebAllowlist(entries) {
  const values = Array.isArray(entries)
    ? entries
    : String(process.env.HIVE_FLOW_PROVIDER_WEB_ALLOWLIST || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  return values
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .map((entry) => {
      const value = entry.trim().toLowerCase().replace(/\.$/, '');
      try {
        const parsed = new URL(value);
        return { kind: 'origin', value: parsed.origin.toLowerCase() };
      } catch {
        if (value.startsWith('*.')) {
          return { kind: 'wildcard-host', value: normalizeAllowlistHost(value.slice(2)) };
        }
        return { kind: 'host', value: normalizeAllowlistHost(value) };
      }
    });
}

function normalizeWebOptions(rawOptions = {}) {
  const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
  return {
    allowlist: normalizeWebAllowlist(options.allowlist),
    allowInsecureTls: options.allowInsecureTls === true,
    allowPrivateFixtureIPs: options.allowPrivateFixtureIPs === true,
    forceDispatcherUnavailable: options.forceDispatcherUnavailable === true,
    maxBytes: clampInteger(options.maxBytes, WEB_FETCH_DEFAULT_MAX_BYTES, WEB_FETCH_MAX_BYTES),
    timeoutMs: clampInteger(options.timeoutMs, WEB_FETCH_DEFAULT_TIMEOUT_MS, WEB_FETCH_MAX_TIMEOUT_MS),
    maxRedirects: clampInteger(options.maxRedirects, WEB_FETCH_DEFAULT_MAX_REDIRECTS, WEB_FETCH_MAX_REDIRECTS),
    resolveHost: typeof options.resolveHost === 'function' ? options.resolveHost : null,
  };
}

function stripTrailingDot(value) {
  return String(value || '').toLowerCase().replace(/\.$/, '');
}

function stripIpv6Brackets(value) {
  const text = String(value || '').trim();
  return text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
}

function rawAuthority(rawUrl) {
  const match = String(rawUrl || '').match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i);
  if (!match) return '';
  const authority = match[1].includes('@') ? match[1].slice(match[1].lastIndexOf('@') + 1) : match[1];
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return end === -1 ? authority : authority.slice(0, end + 1);
  }
  return authority.split(':')[0] || '';
}

function rawHostUsesOddIpv4Encoding(host) {
  const value = stripIpv6Brackets(host).toLowerCase();
  if (!value || !/[0-9]/.test(value)) return false;
  const parts = value.split('.');
  if (parts.some((part) => part === '')) return false;
  if (!parts.every((part) => /^0x[0-9a-f]+$/i.test(part) || /^\d+$/.test(part))) return false;
  if (parts.some((part) => part.startsWith('0x'))) return true;
  if (parts.some((part) => /^0\d+/.test(part))) return true;
  if (parts.length !== 4) return true;
  return parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255);
}

function allowlistMatches(url, allowlist) {
  if (!allowlist.length) return false;
  const hostname = stripTrailingDot(url.hostname);
  const origin = url.origin.toLowerCase();
  return allowlist.some((entry) => {
    if (entry.kind === 'origin') return entry.value === origin;
    if (entry.kind === 'host') return entry.value === hostname;
    if (entry.kind === 'wildcard-host') {
      return hostname === entry.value || hostname.endsWith(`.${entry.value}`);
    }
    return false;
  });
}

function parseIPv4Parts(value) {
  const text = String(value || '').trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return null;
  const parts = text.split('.').map((part) => Number(part));
  return parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function ipv4FromMappedIPv6(value) {
  const text = stripIpv6Brackets(value).toLowerCase();
  if (!text.startsWith('::ffff:')) return null;
  const suffix = text.slice('::ffff:'.length);
  const dotted = parseIPv4Parts(suffix);
  if (dotted) return dotted;
  const hextets = suffix.split(':').filter(Boolean);
  if (hextets.length !== 2) return null;
  const high = Number.parseInt(hextets[0], 16);
  const low = Number.parseInt(hextets[1], 16);
  if (!Number.isInteger(high) || !Number.isInteger(low) || high < 0 || high > 0xffff || low < 0 || low > 0xffff) {
    return null;
  }
  return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255];
}

function ipv4IsBlocked(parts) {
  const [a, b, c, d] = parts;
  if (a === 0) return true; // unspecified/current network
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true; // multicast/reserved/broadcast
  if (a === 169 && b === 254 && c === 169 && d === 254) return true;
  return false;
}

function ipv6IsBlocked(value) {
  const text = stripIpv6Brackets(value).toLowerCase().split('%')[0];
  const mapped = ipv4FromMappedIPv6(text);
  if (mapped) return ipv4IsBlocked(mapped);
  if (text === '::' || text === '0:0:0:0:0:0:0:0') return true;
  if (text === '::1' || text === '0:0:0:0:0:0:0:1') return true;
  const first = text.split(':').find((part) => part.length > 0) || '';
  const firstValue = Number.parseInt(first, 16);
  if (!Number.isInteger(firstValue)) return true;
  if ((firstValue & 0xff00) === 0xff00) return true; // multicast
  if ((firstValue & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((firstValue & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  return false;
}

function ipIsBlocked(address) {
  const normalized = stripIpv6Brackets(address);
  const mapped = ipv4FromMappedIPv6(normalized);
  if (mapped) return ipv4IsBlocked(mapped);
  const ipType = isIP(normalized);
  if (ipType === 4) return ipv4IsBlocked(parseIPv4Parts(normalized));
  if (ipType === 6) return ipv6IsBlocked(normalized);
  return true;
}

function normalizeIpForCompare(address) {
  const mapped = ipv4FromMappedIPv6(address);
  if (mapped) return mapped.join('.');
  return stripIpv6Brackets(address).toLowerCase().split('%')[0];
}

function validateWebFetchUrl(rawUrl, options) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { denyReason: 'invalid-url' };
  }
  const rawHost = rawAuthority(rawUrl);
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { denyReason: 'invalid-url' };
  }
  if (url.protocol !== 'https:') return { denyReason: 'https-only' };
  if (url.username || url.password) return { denyReason: 'embedded-credentials' };
  if (rawHostUsesOddIpv4Encoding(rawHost)) return { denyReason: 'ipv4-odd-encoding', finalUrl: url.href };

  const hostname = stripTrailingDot(stripIpv6Brackets(url.hostname));
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { denyReason: 'localhost-denied', finalUrl: url.href };
  }

  if (isIP(hostname) && ipIsBlocked(hostname)) {
    return { denyReason: 'blocked-ip', finalUrl: url.href };
  }

  if (!allowlistMatches(url, options.allowlist)) {
    return { denyReason: 'allowlist-denied', finalUrl: url.href };
  }

  return { url };
}

async function importUndiciDispatcher(options) {
  if (options.forceDispatcherUnavailable) return null;
  try {
    const undici = await import('undici');
    if (typeof undici.Agent !== 'function' || typeof undici.buildConnector !== 'function' || typeof undici.request !== 'function') {
      return null;
    }
    return undici;
  } catch {
    return null;
  }
}

async function resolveWebHost(url, options) {
  const hostname = stripTrailingDot(stripIpv6Brackets(url.hostname));
  let records;
  try {
    if (options.resolveHost) {
      records = await options.resolveHost(hostname, url);
    } else {
      records = await dnsLookup(hostname, { all: true, verbatim: true });
    }
  } catch {
    return { denyReason: 'dns-resolution-failed' };
  }
  const normalized = (Array.isArray(records) ? records : [records])
    .map((record) => ({
      address: String(record?.address || ''),
      family: Number(record?.family || isIP(String(record?.address || ''))),
    }))
    .filter((record) => record.address && (record.family === 4 || record.family === 6));

  if (!normalized.length) return { denyReason: 'dns-resolution-empty' };

  const safe = normalized.find((record) => options.allowPrivateFixtureIPs || !ipIsBlocked(record.address));
  if (!safe) return { denyReason: 'blocked-ip' };
  return { record: safe };
}

function buildResolvedDispatcher(undici, url, record, options) {
  const baseConnect = undici.buildConnector({
    rejectUnauthorized: !options.allowInsecureTls,
    timeout: options.timeoutMs,
  });
  const expectedAddress = normalizeIpForCompare(record.address);
  const originalHostname = stripTrailingDot(stripIpv6Brackets(url.hostname));
  return new undici.Agent({
    connect(connectOptions, callback) {
      const resolvedConnectOptions = {
        ...connectOptions,
        hostname: record.address,
        host: record.address,
        servername: originalHostname,
      };
      return baseConnect(resolvedConnectOptions, (err, socket) => {
        if (err || !socket) {
          callback(err, socket);
          return;
        }
        const remoteAddress = normalizeIpForCompare(socket.remoteAddress || '');
        if (remoteAddress && remoteAddress !== expectedAddress) {
          socket.destroy();
          callback(new Error('resolved socket remote address mismatch'));
          return;
        }
        callback(null, socket);
      });
    },
  });
}

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' ? value : '';
}

async function readResponseCapped(body, limit) {
  let bytes = 0;
  let truncated = false;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes + buffer.length > limit) {
      bytes = limit;
      truncated = true;
      if (typeof body.destroy === 'function') body.destroy();
      break;
    }
    bytes += buffer.length;
  }
  return { bytes, truncated };
}

async function fetchOneHop(undici, url, record, options) {
  const dispatcher = buildResolvedDispatcher(undici, url, record, options);
  try {
    return await undici.request(url, {
      method: 'GET',
      dispatcher,
      maxRedirections: 0,
      headersTimeout: options.timeoutMs,
      bodyTimeout: options.timeoutMs,
      headers: {
        accept: 'text/plain, text/markdown, application/json;q=0.9, */*;q=0.1',
        'user-agent': 'hive-flow-provider-bridge/1.0',
      },
    });
  } finally {
    try { await dispatcher.close(); } catch { /* ignore close failures */ }
  }
}

async function webFetchTool(rawArgs, ctx = {}) {
  const fetchBlockReason = bridgeFetchBlockReason();
  if (fetchBlockReason) {
    return webDenied('restricted-fetch-or-exec');
  }

  const options = normalizeWebOptions(ctx.webOptions);
  const undici = await importUndiciDispatcher(options);
  if (!undici) return webDenied('dispatcher-unavailable');

  let current = rawArgs?.url;
  let redirectCount = 0;
  for (;;) {
    const validated = validateWebFetchUrl(current, options);
    if (validated.denyReason) {
      return webDenied(validated.denyReason, {
        finalUrl: validated.finalUrl || null,
        redirectCount,
      });
    }

    const resolved = await resolveWebHost(validated.url, options);
    if (resolved.denyReason) {
      return webDenied(resolved.denyReason, {
        finalUrl: validated.url.href,
        redirectCount,
      });
    }

    let response;
    try {
      response = await fetchOneHop(undici, validated.url, resolved.record, options);
    } catch {
      return webDenied('fetch-failed', {
        finalUrl: validated.url.href,
        redirectCount,
      });
    }

    const statusCode = Number(response.statusCode || 0);
    const location = headerValue(response.headers, 'location');
    if (statusCode >= 300 && statusCode < 400 && location) {
      try {
        if (typeof response.body?.dump === 'function') await response.body.dump();
      } catch { /* ignore body drain failures */ }
      if (redirectCount >= options.maxRedirects) {
        return webDenied('redirect-limit-exceeded', {
          finalUrl: validated.url.href,
          httpStatus: statusCode,
          redirectCount,
        });
      }
      redirectCount += 1;
      try {
        current = new URL(location, validated.url).href;
      } catch {
        return webDenied('invalid-redirect-location', {
          finalUrl: validated.url.href,
          httpStatus: statusCode,
          redirectCount,
        });
      }
      continue;
    }

    const readResult = await readResponseCapped(response.body, options.maxBytes);
    return {
      status: 'fetched',
      finalUrl: validated.url.href,
      httpStatus: statusCode,
      contentType: headerValue(response.headers, 'content-type'),
      bytes: readResult.bytes,
      truncated: readResult.truncated,
      redirectCount,
    };
  }
}

async function webSearchTool() {
  return webDenied('web-search-unsupported');
}

// SEC-002/HIGH-003: Bridge tool blocklist — provider agents are restricted to operational tools.
// Governance, enforcement, and system-critical tools are blocked to prevent privilege escalation.
const BRIDGE_BLOCKED_TOOLS = new Set([
  // Enforcement/governance tools
  'workflow_enforcer_override',
  'workflow_enforcer_status',
  'workflow_enforcer_assess',
  // System administration tools
  'system_reset',
  'system_info',
  // Configuration import (could overwrite security settings)
  'config_import',
  'config_reset',
  'config_set',
  // Agent lifecycle (prevent provider agents from terminating other agents)
  'agent_terminate',
  'agent_update',
  // Session manipulation
  'session_delete',
  // Hive termination
  'hive_terminate',
  // Security-sensitive tools
  'claims_steal',
  'claims_mark-stealable',
  'claims_rebalance',
  // Pipeline override
  'pipeline_init',
  'pipeline_stage_complete',
  // Verification gate manipulation
  'verification_gate_run',
  'verification_gate_escalate',
  // Swarm lifecycle
  'swarm_shutdown',
  'swarm_init',
  // Config read (may leak API keys)
  'config_export',
  // Queen protocol (provider agents must not impersonate queens or spawn agents)
  'queen_mission_assign',
  'queen_spawn_worker',
  'queen_report',
  'queen_task_worker',
  'queen_collect_results',
  // Memory deletion (destructive)
  'memory_delete',
  // Agent spawning (prevent provider agents from spawning other agents)
  'agent_spawn',
  // MCP filesystem tools must not bypass the bridge's built-in read/write gates.
  'mcp__filesystem__write_file',
  'mcp__filesystem__edit_file',
  'mcp__filesystem__move_file',
  'mcp__filesystem__rename_file',
  'mcp__filesystem__copy_file',
  'mcp__filesystem__create_directory',
  'mcp__filesystem__delete_file',
  'mcp__filesystem__read_file',
  'mcp__filesystem__read_text_file',
  'mcp__filesystem__read_media_file',
  'mcp__filesystem__read_multiple_files',
  'mcp__filesystem__list_directory',
  'mcp__filesystem__directory_tree',
  'mcp__filesystem__search_files',
]);

// Built-in filesystem tool handlers — always available to provider agents.
// These execute only through the bridge-owned registry below.
const BRIDGE_FILESYSTEM_TOOLS = {
  'read_file': ({ path: filePath }) => {
    const safePath = validateFilePath(filePath);
    assertReadableByBridge(safePath, 'read_file');
    const stats = statSync(safePath);
    const threshold = getToolResultThreshold(currentBridgeLimits);
    const maxReadBytes = threshold === Infinity ? 500 * 1024 : threshold;
    if (stats.size > maxReadBytes) {
      const fd = openSync(safePath, 'r');
      try {
        const headSize = Math.floor(maxReadBytes * 0.7);
        const tailSize = Math.floor(maxReadBytes * 0.2);
        const headBuf = Buffer.alloc(headSize);
        const tailBuf = Buffer.alloc(tailSize);
        readSync(fd, headBuf, 0, headSize, 0);
        readSync(fd, tailBuf, 0, tailSize, stats.size - tailSize);
        return headBuf.toString('utf-8') +
          `\n\n[FILE TRUNCATED: ${stats.size} bytes total, showing first ${headSize} + last ${tailSize} bytes. Use offset/limit for specific sections.]\n\n` +
          tailBuf.toString('utf-8');
      } finally {
        closeSync(fd);
      }
    }
    return readFileSync(safePath, 'utf-8');
  },
  'write_file': ({ path: filePath, content }) => {
    const safePath = validateFilePath(filePath);
    if (isProtectedPath(safePath)) {
      throw new Error(`Write blocked: ${filePath} is a protected path`);
    }
    const writeBlockReason = bridgeWriteBlockReason();
    if (writeBlockReason) {
      throw new Error(writeBlockReason);
    }
    mkdirSync(dirname(safePath), { recursive: true });
    writeFileSync(safePath, content, 'utf-8');
    return `File written: ${safePath}`;
  },
  'edit_file': ({ path: filePath, old_string, new_string }) => {
    const safePath = validateFilePath(filePath);
    if (isProtectedPath(safePath)) {
      throw new Error(`Write blocked: ${filePath} is a protected path`);
    }
    const writeBlockReason = bridgeWriteBlockReason();
    if (writeBlockReason) {
      throw new Error(writeBlockReason);
    }
    const content = readFileSync(safePath, 'utf-8');
    if (old_string === '') {
      return `Error: old_string must be non-empty for ${safePath}`;
    }
    const occurrences = content.split(old_string).length - 1;
    if (occurrences === 0) {
      return `Error: old_string not found in ${safePath}`;
    }
    if (occurrences > 1) {
      stderrLogger.warn('edit_file old_string matched multiple times; replacing all occurrences', {
        path: safePath,
        occurrences,
      });
      bridgeLog('warn', 'edit_file old_string matched multiple times', {
        path: safePath,
        occurrences,
      });
    }
    writeFileSync(safePath, content.split(old_string).join(new_string), 'utf-8');
    return `File edited: ${safePath}`;
  },
  'list_directory': ({ path: dirPath }) => {
    const safePath = validateFilePath(dirPath || '.');
    assertReadableByBridge(safePath, 'list_directory');
    const entries = readdirSync(safePath);
    if (entries.length > 500) {
      return entries.slice(0, 500).join('\n') + `\n\n[TRUNCATED: showing 500 of ${entries.length} entries]`;
    }
    return entries.join('\n');
  },
  'grep': ({ pattern, path, file_glob, max_results }) => {
    if (!pattern) {
      throw new Error('Missing required parameter: pattern');
    }

    // FIX-S2: Reject patterns and globs that begin with `-`. Without this,
    // a prompt-injected agent calling the grep tool with
    // `pattern = "--pre=/tmp/evil.sh"` would cause ripgrep to execute that
    // script as a preprocessor for every file searched (arbitrary code
    // execution). The `--` separator inserted by buildRgArgs/buildGrepArgs
    // is defense-in-depth so ANY future positional becomes safe even if the
    // start-check is bypassed. The validators live in
    // ./bridge-grep-validators.mjs so the security policy can be unit-tested
    // directly (the bridge itself is a process entry point and not
    // module-importable as a unit).
    if (patternIsRejected(pattern)) {
      throw new Error('grep: pattern may not start with "-" (would be parsed as an option)');
    }
    if (fileGlobIsRejected(file_glob)) {
      throw new Error('grep: file_glob may not start with "-"');
    }

    const searchPath = path ? validateFilePath(path) : PROJECT_ROOT;
    if (isProtectedReadPath(searchPath)) {
      throw new Error(`grep blocked: ${searchPath} is a protected read path`);
    }
    const needsProtectedFilter = searchMayIncludeProtectedReadPath(searchPath);
    const maxResults = max_results || 50;

    try {
      // Try ripgrep (rg) first, fall back to grep -rn
      let command, args;
      try {
        execFileSync('rg', ['--version'], { stdio: 'ignore' });
        command = 'rg';
        // FIX-S2: buildRgArgs places ALL rg option flags BEFORE the `--`
        // separator, then the separator, then positionals (pattern +
        // searchPath). This blocks any attacker-controlled string from
        // being interpreted as a flag (e.g. `--pre=` RCE, `--pcre2`, `-x`).
        args = buildRgArgs(
          pattern,
          searchPath,
          file_glob,
          needsProtectedFilter ? protectedReadRgGlobs(searchPath) : [],
        );
      } catch {
        command = 'grep';
        if (needsProtectedFilter) {
          throw new Error('grep fallback cannot safely exclude protected read paths; install ripgrep (rg)');
        }
        if (file_glob) {
          // Basic glob to regex conversion for grep.
          // Note: grep doesn't support glob patterns natively, so we'll do
          // a simple conversion. For simplicity, we'll just reject the call
          // and require ripgrep. Dash-prefixed file_globs were already
          // rejected above via fileGlobIsRejected, so any value reaching
          // here is safe-but-unsupported.
          throw new Error('grep tool with file_glob requires ripgrep (rg). Install rg or use without file_glob.');
        }
        // FIX-S2: buildGrepArgs applies the same `--` separator policy for
        // the grep fallback so the pattern can never be parsed as an option
        // (defense in depth, even though grep has no preprocessor RCE flag).
        args = buildGrepArgs(pattern, searchPath);
      }
      
      const output = execFileSync(command, args, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 5 * 1024 * 1024, // 5MB — prevent ENOBUFS on large repos
      }).trim();
      
      if (!output) {
        return 'No matches found';
      }
      
      const lines = output.split('\n');
      const limitedLines = lines.slice(0, maxResults);
      
      return limitedLines.join('\n');
      
    } catch (error) {
      if (error.status === 1) {
        // grep/rg exit code 1 means no matches found
        return 'No matches found';
      }
      if (error.message.includes('ENOENT')) {
        throw new Error('Neither grep nor ripgrep (rg) found in PATH. Please install grep or rg.');
      }
      throw new Error(`Search failed: ${error.message}`);
    }
  },
  'find_file': ({ pattern, path: searchPath }) => {
    if (!pattern) {
      throw new Error('Missing required parameter: pattern');
    }
    
    const basePath = validateFilePath(searchPath || '.');
    if (isProtectedReadPath(basePath)) {
      throw new Error(`find_file blocked: ${basePath} is a protected read path`);
    }
    
    // Simple glob pattern matching function
    function matchesPattern(filename, pattern) {
      // Convert glob pattern to regex
      let regexStr = pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '§GLOBSTAR§')   // Placeholder before single * replacement
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/§GLOBSTAR§/g, '.*');     // Now replace placeholder with cross-directory match
      
      // Anchor to start and end
      regexStr = '^' + regexStr + '$';
      
      try {
        const regex = new RegExp(regexStr);
        return regex.test(filename);
      } catch {
        // If regex fails, do simple substring match
        return filename.includes(pattern);
      }
    }
    
    // Check if a path should be ignored based on .gitignore patterns
    function shouldIgnore(path, gitignorePatterns) {
      if (!gitignorePatterns || gitignorePatterns.length === 0) {
        return false;
      }
      
      const relativePath = relative(basePath, path);
      
      for (const rule of gitignorePatterns) {
        const pattern = rule.pattern;
        const isNegation = rule.negation;
        
        // Simple pattern matching - for now just check exact matches and wildcards
        if (pattern === relativePath || pattern === path) {
          return !isNegation; // If it's a negation pattern, don't ignore
        }
        
        // Check for wildcard matches
        if (pattern.includes('*')) {
          const regexPattern = pattern
            .replace(/\./g, '\\.')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
          const regex = new RegExp('^' + regexPattern + '$');
          if (regex.test(relativePath) || regex.test(path)) {
            return !isNegation;
          }
        }
      }
      
      return false;
    }
    
    // Read .gitignore patterns from a directory
    function readGitignorePatterns(dir) {
      const gitignorePath = join(dir, '.gitignore');
      const patterns = [];
      
      try {
        if (existsSync(gitignorePath)) {
          const content = readFileSync(gitignorePath, 'utf-8');
          const lines = content.split('\n');
          
          for (const line of lines) {
            const trimmed = line.trim();
            // Skip empty lines and comments
            if (!trimmed || trimmed.startsWith('#')) {
              continue;
            }
            
            const isNegation = trimmed.startsWith('!');
            const pattern = isNegation ? trimmed.substring(1) : trimmed;
            
            patterns.push({
              pattern,
              negation: isNegation
            });
          }
        }
      } catch {
        // If we can't read .gitignore, continue without patterns
      }
      
      return patterns;
    }
    
    // Recursive directory search
    function findFiles(dir, pattern, gitignorePatterns = [], results = []) {
      if (results.length >= 50) return results; // Limit to 50 files
      if (isProtectedReadPath(dir)) return results;
      
      // Read .gitignore for this directory
      const dirGitignorePatterns = readGitignorePatterns(dir);
      const allPatterns = [...gitignorePatterns, ...dirGitignorePatterns];
      
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          if (results.length >= 50) break;
          
          const fullPath = join(dir, entry.name);
          
          // Skip if this path should be ignored
          if (shouldIgnore(fullPath, allPatterns)) {
            continue;
          }
          
          // Skip common ignored directories even without .gitignore
          if (entry.isDirectory()) {
            if (isProtectedReadPath(fullPath)) {
              continue;
            }
            if (entry.name === 'node_modules' || entry.name === '.git' || 
                entry.name === '.hg' || entry.name === '.svn') {
              continue;
            }
            findFiles(fullPath, pattern, allPatterns, results);
          } else if (entry.isFile()) {
            if (isProtectedReadPath(fullPath)) {
              continue;
            }
            const relativePath = relative(basePath, fullPath);
            if (matchesPattern(entry.name, pattern) || matchesPattern(relativePath, pattern)) {
              results.push(resolve(fullPath));
            }
          }
        }
      } catch (err) {
        // Skip directories we can't read
        stderrLogger.debug(`Error reading directory ${dir}:`, err.message);
      }
      
      return results;
    }
    
    const results = findFiles(basePath, pattern);
    return safeBridgeJsonStringify(results);
  },
};

const BRIDGE_TOOL_REGISTRY = {
  ...BRIDGE_FILESYSTEM_TOOLS,
  'run_shell': runShellTool,
  'run_command': runCommandTool,
  'web_fetch': webFetchTool,
  'web_search': webSearchTool,
};

function parseBridgeToolArgs(toolArgs) {
  if (typeof toolArgs === 'string') {
    try { return JSON.parse(toolArgs); } catch { return {}; }
  }
  return toolArgs || {};
}

function bridgeDeniedTool(toolName, denyReason, error) {
  return {
    status: 'denied',
    denyReason,
    error,
    tool: toolName,
  };
}

export async function evaluateToolCall(toolName, toolArgs, ctx = {}) {
  const normalizedToolName = typeof toolName === 'string' ? toolName : '';

  if (!normalizedToolName) {
    return bridgeDeniedTool(String(toolName || ''), 'invalid-tool', 'Tool name must be a non-empty string.');
  }

  if (BRIDGE_BLOCKED_TOOLS.has(toolName)) {
    stderrLogger.warn(`Tool blocked by bridge security policy: ${toolName}`);
    return bridgeDeniedTool(
      toolName,
      'blocked-tool',
      `Tool '${toolName}' is blocked for provider agents (bridge security policy).`,
    );
  }

  if (toolName.startsWith('mcp__')) {
    stderrLogger.warn(`MCP alias denied by provider bridge: ${toolName}`);
    return bridgeDeniedTool(
      toolName,
      'mcp-alias-denied',
      `Tool '${toolName}' is not available to provider agents. Use bridge-owned tools only.`,
    );
  }

  const handler = BRIDGE_TOOL_REGISTRY[toolName];
  if (!handler) {
    stderrLogger.warn(`Unknown provider bridge tool denied: ${toolName}`);
    return bridgeDeniedTool(
      toolName,
      'unknown-tool',
      `Tool '${toolName}' is not in the provider bridge registry.`,
    );
  }

  try {
    const result = await handler(parseBridgeToolArgs(toolArgs), ctx);
    return typeof result === 'string' ? redactBridgeString(result) : safeBridgeJsonStringify(result);
  } catch (err) {
    stderrLogger.error(`Tool execution failed: ${toolName}`, err.message || err);
    return {
      status: 'error',
      error: redactBridgeString(err.message || String(err)),
      tool: toolName,
    };
  }
}

export async function executeBridgeTool(toolName, toolArgs, ctx = {}) {
  bridgeLog('info', 'Bridge tool dispatch', {
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    tool: toolName,
    source: ctx.source || 'provider-response',
  });
  if (typeof ctx.recordExecution === 'function') {
    try { ctx.recordExecution(toolName); } catch { /* test hooks must not break execution */ }
  }
  return evaluateToolCall(toolName, toolArgs, ctx);
}

export async function executeBridgeFilesystemTool(toolName, toolArgs) {
  if (!BRIDGE_FILESYSTEM_TOOLS[toolName]) {
    throw new Error(`Unknown bridge filesystem tool: ${toolName}`);
  }
  return executeBridgeTool(toolName, toolArgs, { source: 'filesystem-export' });
}

async function notifyProviderAuthFailure(providerName, reason) {
  await notifyProviderAuthRequired({
    providerName,
    reason,
  });
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
  const parsed = { agentId: '', task: '', storeDir: '', timeout: 0, agentToken: '', taskStdin: false, taskFile: '', resultFile: '' };

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
      case '--agent-token':
        parsed.agentToken = args[++i] || '';
        break;
      case '--task-file':
        parsed.taskFile = args[++i] || '';
        break;
      case '--result-file':
        parsed.resultFile = args[++i] || '';
        break;
    }
  }

  // When --task-file is set, read task from that file.
  if (parsed.taskFile) {
    // FIX-S1: Defense-in-depth path validation. The path is server-generated
    // (UUID-based, not attacker-controlled), but matches the pattern used by
    // every other path-using bridge handler (e.g. read_file at line ~1114).
    validateFilePath(parsed.taskFile);
    const fileTask = readFileSync(parsed.taskFile, 'utf-8');
    if (fileTask.trim()) {
      parsed.task = fileTask.trim();
    }
  }

  // When --task-stdin is set (or --task is missing), read task from stdin.
  // This avoids shell parsing issues with special characters in task text
  // and bypasses ARG_MAX limits for very long prompts.
  if (!parsed.task && (parsed.taskStdin || !parsed.task)) {
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
    const providerMap = { 'anthropic-cli': 'anthropic', 'gemini-cli': 'gemini', 'codex-cli': 'codex', 'cursor-cli': 'cursor', 'openrouter': 'openrouter' };
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

function taskRequiresBridgeToolGrounding(task) {
  const text = String(task || '').toLowerCase();
  const asksToInspect = /\b(read|inspect|open|list|grep|search|find|check|verify|call)\b/.test(text) ||
    /read_file|list_directory|run_command/.test(text);
  const namesLocalSurface = /\b(file|directory|folder|workspace|repo|repository|path|contents?)\b/.test(text) ||
    /package\.json|tsconfig|readme|git status|exact version/.test(text);
  return asksToInspect && namesLocalSurface;
}

function ungroundedToolTaskError(providerName) {
  const error = new Error(
    `Strict API provider '${providerName}' answered a local workspace task but did not use bridge tools; refusing ungrounded result.`
  );
  error.code = 'UNGROUNDED_TOOL_TASK';
  return error;
}

// ===== Main =====

async function main() {
  const parsed = await parseArgs();
  const { agentId, task, storeDir, timeout: parsedTimeout, agentToken, resultFile, taskFile } = parsed;
  const lockPath = join(storeDir, '.store.lock');

  // ── Phase 1: Lock → read state → unlock ──
  const { store, agent, storePath, messages, providerName } = await withFileLock(lockPath, async () => {
    const { store, agent, storePath } = loadAgentState(storeDir, agentId);
    const rawMessages = buildMessages(agent, task);
    const messages = trimMessages(rawMessages, getProviderLimits(agent.provider, agent.resolvedModel));
    const providerName = agent.provider;
    return { store, agent, storePath, messages, providerName };
  });

  // Set module-level limits so BRIDGE_FILESYSTEM_TOOLS handlers can use them
  currentBridgeLimits = getProviderLimits(providerName, agent.resolvedModel);

  // ── Phase 2: Provider call (no lock held) ──
  const providerModule = await loadProviderModule();

  const defaults = await getProviderDefaults();
  const config = await createProviderConfig(
    providerName,
    agent.resolvedModel || defaults[providerName],
    parsedTimeout,
    agentToken
  );

  const providerClasses = {
    'anthropic-cli': providerModule.AnthropicCLIProvider,
    'gemini-cli': providerModule.GeminiCLIProvider,
    'codex-cli': providerModule.CodexCLIProvider,
    'cursor-cli': providerModule.CursorCLIProvider,
    'deepseek': providerModule.DeepSeekProvider,
    'openrouter': providerModule.OpenRouterProvider,
  };

  const ProviderClass = providerClasses[providerName];
  if (!ProviderClass && !STRICT_API_PROVIDERS.has(providerName)) {
    throw new Error(`Unknown provider: ${providerName}. Supported: ${Object.keys(providerClasses).join(', ')}`);
  }

  const provider = STRICT_API_PROVIDERS.has(providerName)
    ? createStrictHolderProvider(providerName, config, agentId)
    : new ProviderClass({ config, logger: stderrLogger });

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
    if (isProviderAuthError(initError)) {
      await notifyProviderAuthFailure(providerName, msg);
      throw initError;
    }
    throw initError;
  }

  // Corrected limits from Phase 2 OpenRouter dynamic context discovery.
  // Initialized to null; set below if the model's real context window differs
  // from the Phase 1 static limits. Used by the tool-loop re-trim at line ~1861
  // so it doesn't fall back to the stale Phase 1 value on every iteration.
  let dynamicLimits = null;

  let result;
  try {
    const request = {
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
        ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
        ...(m.name ? { name: m.name } : {}),
        ...(m.reasoningContent ? { reasoningContent: m.reasoningContent } : {}),
      })),
      model: agent.resolvedModel || defaults[providerName],
      timeout: parsedTimeout || undefined,
    };

    // Phase 2 re-trim: correct context limits for OpenRouter dynamic models
    if (providerName === 'openrouter' && typeof provider.getModelContextLength === 'function') {
      try {
        if (!agent.resolvedModel) throw new Error('No resolvedModel for openrouter');
        const realContext = await provider.getModelContextLength(agent.resolvedModel);
        if (typeof realContext !== 'number' || realContext <= 0 || !Number.isFinite(realContext)) {
          stderrLogger.warn('[bridge] Invalid context length from provider:', realContext);
        } else {
          const phase1Limits = getProviderLimits(providerName, agent.resolvedModel);
          if (realContext !== phase1Limits.maxTokens) {
            const correctedLimits = {
              ...phase1Limits,
              maxTokens: realContext,
              maxEntries: maxEntriesForTokenWindow(realContext, agent.resolvedModel),
              maxChars: realContext * 4,
              warningThreshold: Math.max(
                Math.floor(realContext * 0.5),
                Math.min(Math.floor(realContext * 0.85), realContext - 40000),
              ),
            };
            // Store for reuse in the tool loop so every iteration uses the same
            // dynamic limit rather than re-calling getProviderLimits().
            dynamicLimits = correctedLimits;
            request.messages = trimMessages(request.messages, correctedLimits);
          }
        }
      } catch (err) {
        stderrLogger.warn('[bridge] OpenRouter dynamic context lookup failed:', err.message);
      }
    }

    const openRouterAttemptedModels = new Set();
    if (providerName === 'openrouter' && request.model) {
      openRouterAttemptedModels.add(request.model);
    }
    let successfulRerolledModel = null;

    // Always include built-in filesystem tools so providers know they can use them.
    // These are handled directly in the bridge (no MCP client required).
    const builtInFilesystemTools = [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read the contents of a file.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Absolute or relative path to the file.' },
            },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Write content to a file, creating parent directories if needed.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Absolute or relative path to the file.' },
              content: { type: 'string', description: 'Full content to write to the file.' },
            },
            required: ['path', 'content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'edit_file',
          description: 'Replace an exact substring in a file with new text.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Absolute or relative path to the file.' },
              old_string: { type: 'string', description: 'The exact text to find and replace.' },
              new_string: { type: 'string', description: 'The text to replace it with.' },
            },
            required: ['path', 'old_string', 'new_string'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'list_directory',
          description: 'List the contents of a directory.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Directory path to list. Defaults to current directory.' },
            },
            required: [],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'grep',
          description: 'Search file contents for pattern using grep/ripgrep.',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'Pattern to search for (regex).' },
              path: { type: 'string', description: 'Directory path to search. Defaults to project root.' },
              file_glob: { type: 'string', description: 'Glob pattern to filter files (e.g., "*.js"). Requires ripgrep (rg).' },
              max_results: { type: 'number', description: 'Maximum number of results to return. Defaults to 50.' },
            },
            required: ['pattern'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'find_file',
          description: 'Search for files by glob pattern.',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'Glob pattern to match (e.g., "*.js", "**/*.md").' },
              path: { type: 'string', description: 'Directory path to search. Defaults to current directory.' },
            },
            required: ['pattern'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'run_shell',
          description: 'Run a simple command in a deny-by-default sandbox. Shell operators, redirects, pipes, env prefixes, launch wrappers, inline code, and network are denied.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'Simple command string. No shell operators, redirects, pipes, env prefixes, or command substitution.' },
              argv: {
                type: 'array',
                description: 'Preferred direct argv form. Executed without shell=true after Bash-gate approval.',
                items: { type: 'string' },
              },
              timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds, capped by the bridge.' },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'web_fetch',
          description: 'Fetch a small HTTPS URL through the bridge SSRF guard. Requires project allowlist; follows redirects manually; returns status, finalUrl, httpStatus, contentType, bytes, truncated, redirectCount, and denyReason on denial.',
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'HTTPS URL to fetch. No embedded credentials. Host must pass the bridge allowlist and SSRF checks.' },
            },
            required: ['url'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Unsupported in provider bridge. Returns a clear web-search-unsupported denial; open web search is intentionally not available.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query. Currently denied by policy.' },
            },
            required: ['query'],
            additionalProperties: false,
          },
        },
      },
    ];

    const runCommandToolDefinition = {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Run a read-only allowlisted command in the project. Allowed: git status/diff/log/show/rev-parse/ls-files/describe/cat-file, pwd, ls, cat, head, tail, wc. No shell, writes, env exposure, launchers, pipes, or redirects.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Simple read-only command string. No shell operators, redirects, pipes, env prefixes, or command substitution.' },
            argv: {
              type: 'array',
              description: 'Preferred direct argv form. Executed without shell=true after the read-only allowlist and project path jail pass.',
              items: { type: 'string' },
            },
            timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds, capped by the bridge.' },
          },
          additionalProperties: false,
        },
      },
    };

    const strictApiReadOnlyToolNames = new Set(['read_file', 'list_directory', 'grep', 'find_file']);
    const strictApiReadOnlyTools = [
      ...builtInFilesystemTools.filter((tool) => strictApiReadOnlyToolNames.has(tool.function.name)),
      runCommandToolDefinition,
    ];

    // Bash-native providers (codex-cli, cursor-cli) have built-in shell execution.
    // They run commands directly and do NOT need structured tool definitions.
    // Sending XML tool schemas to these providers causes them to attempt
    // bash-based tool invocations that don't match the bridge's expectations.
    const BASH_NATIVE_PROVIDERS = new Set(['codex-cli', 'cursor-cli']);
    const isBashNative = BASH_NATIVE_PROVIDERS.has(providerName);
    const isStrictApi = STRICT_API_PROVIDERS.has(providerName);

    if (!isBashNative) {
      if (isStrictApi) {
        request.tools = strictApiReadOnlyTools;
        if (taskRequiresBridgeToolGrounding(task) && !TOOL_CHOICE_REQUIRED_UNSUPPORTED.has(providerName)) {
          request.toolChoice = 'required';
        }
      } else if (agent.config?.tools && Array.isArray(agent.config.tools)) {
        // Merge: built-in filesystem tools first, then agent-specific tools (deduplicated by name)
        const agentToolNames = new Set(agent.config.tools.map((t) => t?.function?.name));
        const deduped = builtInFilesystemTools.filter((t) => !agentToolNames.has(t.function.name));
        request.tools = [...deduped, ...agent.config.tools];
      } else {
        request.tools = builtInFilesystemTools;
      }
    }
    // For bash-native providers, request.tools stays undefined — they handle execution natively.

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
    const MAX_TOOL_ITERATIONS = 25;
    const providerStartTime = Date.now();
    const executedTools = [];

    // Stuck detection state
    const STUCK_WINDOW = 4;
    const STUCK_THRESHOLD = 3;
    const toolCallFingerprints = [];
    let consecutiveErrorIterations = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;

    // Tool-calling loop (no lock held — provider calls can take up to 120s).
    // All structured provider tool calls execute through executeBridgeTool,
    // backed by the bridge-owned registry above. There is intentionally no
    // generic MCP fallback from provider-controlled responses.

    // Derive tasks dir for terminate-marker checks
    const bridgeTasksDir = join(
      process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      '.hive-flow', 'tasks'
    );

    while (iterations < MAX_TOOL_ITERATIONS) {
      // ── Control-file termination check ──
      // agent_terminate writes a marker file instead of sending SIGTERM/SIGKILL.
      // We check at the top of each iteration so the bridge exits gracefully.
      const terminateFile = join(bridgeTasksDir, `.bridge-terminate-${agentId}`);
      if (existsSync(terminateFile)) {
        bridgeLog('warn', 'Terminate marker detected — exiting gracefully', { agentId });

        // Write an error result file so agent_task_result sees completion
        if (resultFile) {
          const termResult = {
            success: false,
            error: 'Agent terminated via control file',
            code: 'TERMINATED',
            agentId,
          };
          try {
            const tmpResult = resultFile + `.tmp.${process.pid}`;
            writeFileSync(tmpResult, safeBridgeJsonStringify(termResult, 2) + '\n');
            renameSync(tmpResult, resultFile);
          } catch (writeErr) {
            bridgeLog('error', 'Failed to write termination result file', { agentId, error: writeErr.message });
          }
        }

        // Reset agent to idle
        try {
          const storeLockPath = join(storeDir, '.store.lock');
          await withFileLock(storeLockPath, async () => {
            const { store: s, agent: a, storePath: sp } = loadAgentState(storeDir, agentId);
            if (a && a.status === 'busy') {
              a.status = 'idle';
              saveAgentState(sp, s);
            }
          });
        } catch (resetErr) {
          bridgeLog('error', 'Failed to reset agent after termination', { agentId, error: resetErr.message });
        }

        // Delete the marker so it doesn't fire again on a future task
        try { unlinkSync(terminateFile); } catch { /* best-effort */ }

        // Exit the bridge process
        process.exit(0);
      }

      const completeWithOpenRouterReroll = async () => {
        try {
          return await provider.complete(request);
        } catch (error) {
          if (providerName === 'openrouter' && classifyError(error) === 'timeout') {
            const tier = openRouterTierForAgentModel(agent.model);
            const configForReroll =
              typeof providerModule.loadOpenRouterConfig === 'function'
                ? providerModule.loadOpenRouterConfig()
                : { tiers: {} };
            const selectForReroll =
              typeof providerModule.selectFromPool === 'function'
                ? providerModule.selectFromPool
                : (pool) => pool[Math.floor(Math.random() * pool.length)];
            const pool = configForReroll.tiers?.[tier] || [];
            const nextModel = chooseUntriedOpenRouterModel(
              pool,
              request.model,
              openRouterAttemptedModels,
              selectForReroll,
            );
            if (!nextModel) {
              throw makeOpenRouterTierExhaustedError(tier, openRouterAttemptedModels);
            }
            openRouterAttemptedModels.add(nextModel);
            bridgeLog('warn', 'OpenRouter timeout reroll selected replacement model', {
              agentId,
              tier,
              previousModel: request.model,
              nextModel,
              attemptedModels: Array.from(openRouterAttemptedModels),
            });
            request.model = nextModel;
            successfulRerolledModel = nextModel;
            dynamicLimits = null;
            currentBridgeLimits = getProviderLimits(providerName, nextModel);
            request.messages = trimMessages(request.messages, currentBridgeLimits);
          }
          throw error;
        }
      };

      try {
        response = await retryWithBackoff(completeWithOpenRouterReroll, {
          maxAttempts: (config.retryAttempts || 0) + 1,
          initialDelay: config.retryDelay || 1000,
          isRetryable: isRetryableError,
        });
      } catch (error) {
        if (isProviderAuthError(error)) {
          await notifyProviderAuthFailure(providerName, error.message || String(error));
        }
        throw error;
      }

      if (successfulRerolledModel && request.model === successfulRerolledModel) {
        agent.resolvedModel = successfulRerolledModel;
        bridgeLog('info', 'OpenRouter reroll succeeded', {
          agentId,
          model: successfulRerolledModel,
          attempts: openRouterAttemptedModels.size,
        });
      }
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
        for (const toolCall of response.toolCalls) {
          bridgeLog('info', `Tool call: ${toolCall.function.name}`, {
            agentId,
            tool: toolCall.function.name,
            args: (toolCall.function.arguments || '').slice(0, 300),
            iteration: iterations,
          });
        }

        request.messages.push({
          role: 'assistant',
          content: response.content || '',
          toolCalls: response.toolCalls,
          ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
        });

        const toolResults = await Promise.all(
          response.toolCalls.map((tc) =>
            executeBridgeTool(tc.function.name, tc.function.arguments, {
              agentId,
              source: 'response-loop',
              recordExecution: (toolName) => executedTools.push(toolName),
            })
              .then((result) => ({ id: tc.id, name: tc.function.name, result }))
              .catch((err) => ({
                id: tc.id,
                name: tc.function.name,
                result: { status: 'error', error: err.message || String(err) },
              }))
          )
        );

        const toolLimits = dynamicLimits ?? getProviderLimits(providerName, agent.resolvedModel);
        for (const tr of toolResults) {
          const rawContent = typeof tr.result === 'string' ? redactBridgeString(tr.result) : safeBridgeJsonStringify(tr.result);
          const truncatedContent = truncateToolResult(rawContent, tr.name, toolLimits);
          const wasTruncated = truncatedContent !== rawContent;
          if (wasTruncated) {
            bridgeLog('info', `Tool result truncated`, {
              agentId,
              tool: tr.name,
              originalBytes: Buffer.byteLength(rawContent, 'utf8'),
              truncatedBytes: Buffer.byteLength(truncatedContent, 'utf8'),
            });
          }
          // Log file mutations for audit trail
          if ((tr.name === 'write_file' || tr.name === 'edit_file') && tr.result && typeof tr.result === 'string') {
            bridgeLog('info', `Worker file mutation: ${tr.name}`, {
              agentId,
              tool: tr.name,
              result: tr.result.slice(0, 200),
            });
          }
          request.messages.push({
            role: 'tool',
            toolCallId: tr.id,
            name: tr.name,
            content: truncatedContent,
          });
        }

        // Re-trim messages after appending tool results to prevent context overflow
        // across multiple tool iterations (Bug fix: single-shot trimming).
        // Prefer dynamicLimits (set by Phase 2 OpenRouter discovery) over the
        // static Phase 1 limits so context windows are consistent throughout.
        const limits = dynamicLimits ?? getProviderLimits(providerName, agent.resolvedModel);
        request.messages = trimMessages(request.messages, limits);

        // Stuck detection: fingerprint + error counter
        if (response.toolCalls && response.toolCalls.length > 0) {
          const fingerprint = JSON.stringify(
            response.toolCalls.map((tc) => ({ n: tc.function.name, a: tc.function.arguments }))
          );
          toolCallFingerprints.push(fingerprint);
          if (toolCallFingerprints.length > STUCK_WINDOW) toolCallFingerprints.shift();
          if (
            toolCallFingerprints.length >= STUCK_WINDOW &&
            toolCallFingerprints.filter((f) => f === fingerprint).length >= STUCK_THRESHOLD
          ) {
            bridgeLog('warn', 'STUCK: repeated tool call fingerprint', {
              agentId, provider: providerName, iterations,
              fingerprint: fingerprint.slice(0, 300),
            });
            break;
          }

          const allErrors = toolResults.every(
            (tr) => tr.result && typeof tr.result === 'object' && tr.result.status === 'error'
          );
          if (allErrors && toolResults.length > 0) {
            consecutiveErrorIterations++;
            if (consecutiveErrorIterations >= MAX_CONSECUTIVE_ERRORS) {
              bridgeLog('warn', 'STUCK: consecutive all-error iterations', {
                agentId, provider: providerName, consecutiveErrorIterations,
              });
              break;
            }
          } else {
            consecutiveErrorIterations = 0;
          }
        }

        if (response.finishReason !== 'tool_calls') {
          break;
        }
      } else {
        break;
      }
    }

    if (iterations >= MAX_TOOL_ITERATIONS) {
      bridgeLog('warn', 'Worker hit MAX_TOOL_ITERATIONS limit', {
        agentId,
        provider: providerName,
        iterations,
        maxIterations: MAX_TOOL_ITERATIONS,
        hasContent: !!(response?.content),
        historyLength: request.messages.length,
      });
    }

    // Post-loop: if content empty after tool work, request text summary
    if ((!response.content || response.content.trim() === '') && iterations > 0) {
      try {
        const summaryRequest = {
          messages: [...request.messages, {
            role: 'user',
            content: 'Summarize what you found and accomplished in the previous tool calls. Provide your analysis and conclusions as text.'
          }],
          model: request.model,
        };
        summaryRequest.messages = trimMessages(summaryRequest.messages, dynamicLimits ?? getProviderLimits(providerName, agent.resolvedModel));
        const summaryResponse = await provider.complete(summaryRequest);
        if (summaryResponse.content && summaryResponse.content.trim() !== '') {
          response = { ...response, content: summaryResponse.content };
        }
      } catch (summaryErr) {
        stderrLogger.warn('[bridge] Post-loop summary request failed:', summaryErr.message);
      }

      // Fallback: if summary also empty, synthesize from tool results
      if ((!response.content || response.content.trim() === '') && iterations > 0) {
        const toolTurns = request.messages.filter(m => m.role === 'tool');
        if (toolTurns.length > 0) {
          const snippets = toolTurns.slice(-5).map(m => {
            const name = m.name || 'tool';
            const body = (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 500);
            return `[${name}]: ${body}`;
          });
          response.content = `[Task completed via ${iterations} tool iterations]\n\n${snippets.join('\n\n')}`;
        } else {
          response.content = `[Task completed via ${iterations} tool iteration(s) — no tool results captured]`;
        }
      }
    }

    const toolUse = {
      iterations,
      tools: [...executedTools],
    };

    if (
      STRICT_API_PROVIDERS.has(providerName) &&
      executedTools.length === 0 &&
      taskRequiresBridgeToolGrounding(task)
    ) {
      throw ungroundedToolTaskError(providerName);
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

    history.push({
      role: 'assistant',
      content: response.content,
      timestamp: new Date().toISOString(),
      ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
    });

    const limits = getProviderLimits(providerName, agent.resolvedModel);
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
      toolUse,
      completedAt: new Date().toISOString(),
    };

    // ── Phase 3: Lock → write state → unlock ──
    // Reset status to idle so agents don't get stuck in 'busy' if
    // agent_task_result is never polled (idempotent: agent_task_result
    // checks `status === 'busy'` before resetting, so this is safe).
    agent.status = 'idle';
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
      toolUse,
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
  if (resultFile) {
    const tmpResult = resultFile + `.tmp.${process.pid}`;
    writeFileSync(tmpResult, safeBridgeJsonStringify(result, 2) + '\n');
    renameSync(tmpResult, resultFile);
  } else {
    process.stdout.write(safeBridgeJsonStringify(result, 2) + '\n');
  }

  // Emit worker-completed event to activity.jsonl for hive observability
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const activityPath = join(projectDir, '.hive-flow', 'logs', 'activity.jsonl');
    const activityDir = dirname(activityPath);
    if (!existsSync(activityDir)) {
      mkdirSync(activityDir, { recursive: true });
    }
    // Read hiveId from the agent's config (set by queen_spawn_worker)
    const agentHiveId = (agent.config && agent.config.hiveId) || agent.hiveId || undefined;
    const completionEvent = JSON.stringify({
      ts: new Date().toISOString(),
      event: 'worker-completed',
      agentId,
      taskId: resultFile ? resultFile.replace(/.*\//, '').replace('.result.json', '') : undefined,
      hiveId: agentHiveId,
      success: result.success === true,
      provider: providerName,
      model: result.model,
    });
    appendFileSync(activityPath, completionEvent + '\n');
  } catch {
    // Best-effort — do not block bridge completion
  }

  // Cleanup: delete task file after successful processing (best-effort)
  if (taskFile) {
    try { unlinkSync(taskFile); } catch { /* ignore */ }
  }
}

async function handleMainError(err) {
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

  // Reset agent status to idle before writing the error result file so that
  // the agent is not left stuck in 'busy' after a bridge failure.
  // Guard against SIGTERM handler already running cleanup
  if (!isShuttingDown) {
    try {
      const argvStoreDirIdx = process.argv.indexOf('--store-dir');
      const rawStoreDir = argvStoreDirIdx !== -1
        ? (process.argv[argvStoreDirIdx + 1] || '')
        : join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.hive-flow', 'agents');
      let storeDir = '';
      try { storeDir = validateFilePath(rawStoreDir); } catch { /* path outside project root — skip */ }
      if (storeDir && logAgentId !== 'unknown') {
        const storePath = join(storeDir, 'store.json');
        const errorLockPath = join(storeDir, '.store.lock');
        await withFileLock(errorLockPath, async () => {
          const freshStore = JSON.parse(readFileSync(storePath, 'utf-8'));
          if (freshStore.agents && freshStore.agents[logAgentId]) {
            freshStore.agents[logAgentId].status = 'idle';
            saveAgentState(storePath, freshStore);
          }
        });
      }
    } catch {
      // Best-effort — do not block error result writing
    }
  }

  // Write error result to --result-file if set, fall back to stdout
  const argvResultIdx = process.argv.indexOf('--result-file');
  const rawResultFile = argvResultIdx !== -1 ? (process.argv[argvResultIdx + 1] || '') : '';
  let resultFile = '';
  try { resultFile = validateFilePath(rawResultFile); } catch { /* path outside project root — skip file write */ }
  if (resultFile) {
    try {
      const tmpResult = resultFile + `.tmp.${process.pid}`;
      writeFileSync(tmpResult, safeBridgeJsonStringify(errorResponse, 2) + '\n');
      renameSync(tmpResult, resultFile);
    } catch {
      // File write failed — fall back to stdout
      process.stdout.write(safeBridgeJsonStringify(errorResponse, 2) + '\n');
    }
  } else {
    process.stdout.write(safeBridgeJsonStringify(errorResponse, 2) + '\n');
  }

  // Cleanup: delete task file (best-effort)
  const argvTaskFileIdx = process.argv.indexOf('--task-file');
  const rawTaskFile = argvTaskFileIdx !== -1 ? (process.argv[argvTaskFileIdx + 1] || '') : '';
  let taskFile = '';
  try { taskFile = validateFilePath(rawTaskFile); } catch { /* path outside project root — skip cleanup */ }
  if (taskFile) {
    try { unlinkSync(taskFile); } catch { /* ignore */ }
  }

  process.exit(1);
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isDirectRun) {
  main().catch(handleMainError);
}
