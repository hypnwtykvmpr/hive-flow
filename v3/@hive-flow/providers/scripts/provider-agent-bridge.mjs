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

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, existsSync, rmdirSync, statSync, unlinkSync, readdirSync, openSync, readSync, closeSync } from 'fs';
import { join, dirname, resolve, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync } from 'child_process';
import {
  patternIsRejected,
  fileGlobIsRejected,
  buildRgArgs,
  buildGrepArgs,
} from './bridge-grep-validators.mjs';

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
      writeFileSync(tmpResult, JSON.stringify(errorResponse, null, 2) + '\n');
      renameSync(tmpResult, resultFile);
    } catch {
      // File write failed — fall back to stdout
      process.stdout.write(JSON.stringify(errorResponse, null, 2) + '\n');
    }
  } else {
    process.stdout.write(JSON.stringify(errorResponse, null, 2) + '\n');
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
const DEFAULT_MAX_PROMPT_TOKENS = 128000; // 128K tokens safe default

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

// Model-specific overrides (when model is known at runtime)
const MODEL_LIMITS = {
  // Anthropic
  'opus':                       { maxTokens: 1000000, maxEntries: 100 },
  'claude-opus-4-7':             { maxTokens: 1000000, maxEntries: 100 },
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
  'gemini-3.1-pro-preview':      { maxTokens: 1000000, maxEntries: 100 },
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
  'minimax/minimax-m2.7':                       { maxTokens: 204800,  maxEntries: 50 },
  'moonshotai/kimi-k2.6':                       { maxTokens: 262144,  maxEntries: 50 },
  'qwen/qwen3.6-max-preview':                   { maxTokens: 262144,  maxEntries: 50 },
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
function maxEntriesForTokenWindow(maxTokens, modelName) {
  const normalizedModel = String(modelName || '').toLowerCase();
  // Anthropic Sonnet class: keep 50-entry cap regardless of token window
  if (/(^|\/)claude-.*sonnet/.test(normalizedModel) || normalizedModel === 'sonnet') {
    return 50;
  }
  if (maxTokens > 500000) return 100;
  if (maxTokens >= 200000) return 50;
  return 30;
}

// Token estimation: ~4 chars per token (conservative for code/mixed content)
function estimateTokensFromText(text) {
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

function getProviderLimits(providerName, modelName) {
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

function trimMessages(messages, limits) {
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
    'anthropic-cli': 'claude-opus-4-7',
    'gemini-cli': 'gemini-3.1-pro-preview',
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
  return {
    provider: providerName,
    model: model || defaults[providerName] || 'auto',
    timeout: timeoutMs || 300000,
    retryAttempts: 2,
    retryDelay: 1000,
    ...(agentToken ? { env: { HIVE_FLOW_AGENT_TOKEN: agentToken } } : {}),
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
    try {
      const mod = await import(pathToFileURL(mcpClientPath).href);
      if (mod && (typeof mod.callMCPTool === 'function' || typeof mod.default?.callMCPTool === 'function')) {
        // Normalise: if callMCPTool is only on the default export, lift it
        _mcpClient = typeof mod.callMCPTool === 'function' ? mod : mod.default;
        stderrLogger.debug('MCP client loaded from dist', { path: mcpClientPath });
        bridgeLog('info', 'MCP client loaded', { source: 'dist', path: mcpClientPath });
        return _mcpClient;
      }
      stderrLogger.warn('MCP client module loaded but callMCPTool not found', {
        exports: Object.keys(mod).slice(0, 10),
      });
    } catch (importErr) {
      stderrLogger.warn('MCP client dist import failed, trying fallbacks', {
        error: (importErr.message || String(importErr)).slice(0, 300),
      });
      bridgeLog('warn', 'MCP client dist import failed', {
        path: mcpClientPath,
        error: (importErr.message || String(importErr)).slice(0, 300),
        code: importErr.code || null,
      });
    }
  }

  // Fallback: try package import
  try {
    const mod = await import('@hive-flow/cli/mcp-client');
    if (mod && (typeof mod.callMCPTool === 'function' || typeof mod.default?.callMCPTool === 'function')) {
      _mcpClient = typeof mod.callMCPTool === 'function' ? mod : mod.default;
      bridgeLog('info', 'MCP client loaded', { source: 'package-subpath' });
      return _mcpClient;
    }
  } catch {
    // Final fallback
    try {
      const mod = await import('@hive-flow/cli');
      if (mod && (typeof mod.callMCPTool === 'function' || typeof mod.default?.callMCPTool === 'function')) {
        _mcpClient = typeof mod.callMCPTool === 'function' ? mod : mod.default;
        bridgeLog('info', 'MCP client loaded', { source: 'package-main' });
        return _mcpClient;
      }
    } catch {
      // All paths exhausted
    }
  }

  stderrLogger.warn('MCP client unavailable — all import paths failed');
  bridgeLog('warn', 'MCP client unavailable', { triedDist: mcpClientPath });
  return null;
}

// ===== Bridge Filesystem Security Guardrails =====

const PROJECT_ROOT = resolve(process.cwd());

function validateFilePath(filePath) {
  const resolved = resolve(filePath);
  if (!resolved.startsWith(PROJECT_ROOT + '/') && resolved !== PROJECT_ROOT) {
    throw new Error(`Path traversal blocked: ${filePath} resolves outside project root`);
  }
  return resolved;
}

const PROTECTED_WRITE_PATHS = [
  '.hive-flow/enforcement/',
  '.claude/helpers/',
  '.claude/settings.json',
  '.env',
  'state.json',
  'role.json',
  '.hive-flow/data/advocate-state.json',
];

function isProtectedPath(filePath) {
  const rel = resolve(filePath).replace(PROJECT_ROOT + '/', '');
  return PROTECTED_WRITE_PATHS.some(p => rel.includes(p));
}

function checkEnforcementLevel() {
  try {
    const statePath = resolve(PROJECT_ROOT, '.hive-flow', 'enforcement', 'state.json');
    const raw = readFileSync(statePath, 'utf-8');
    const state = JSON.parse(raw);
    const level = state?.payload ? JSON.parse(state.payload).level : (state.level || 0);
    return level;
  } catch { return 0; }
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
]);

// Built-in filesystem tool handlers — always available to provider agents.
// These bypass the MCP client entirely so providers can read/write/edit files
// even when the CLI MCP client is unavailable in the bridge subprocess.
const BRIDGE_FILESYSTEM_TOOLS = {
  'read_file': ({ path: filePath }) => {
    const safePath = validateFilePath(filePath);
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
    validateFilePath(filePath);
    if (isProtectedPath(filePath)) {
      throw new Error(`Write blocked: ${filePath} is a protected path`);
    }
    if (checkEnforcementLevel() >= 2) {
      throw new Error(`Writes blocked at enforcement level RESTRICTED+`);
    }
    const safePath = resolve(filePath);
    mkdirSync(dirname(safePath), { recursive: true });
    writeFileSync(safePath, content, 'utf-8');
    return `File written: ${safePath}`;
  },
  'edit_file': ({ path: filePath, old_string, new_string }) => {
    validateFilePath(filePath);
    if (isProtectedPath(filePath)) {
      throw new Error(`Write blocked: ${filePath} is a protected path`);
    }
    if (checkEnforcementLevel() >= 2) {
      throw new Error(`Writes blocked at enforcement level RESTRICTED+`);
    }
    const safePath = resolve(filePath);
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
        args = buildRgArgs(pattern, searchPath, file_glob);
      } catch {
        command = 'grep';
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
            if (entry.name === 'node_modules' || entry.name === '.git' || 
                entry.name === '.hg' || entry.name === '.svn') {
              continue;
            }
            findFiles(fullPath, pattern, allPatterns, results);
          } else if (entry.isFile()) {
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
    return JSON.stringify(results);
  },
};

async function executeMCPTool(toolName, toolArgs) {
  // Built-in filesystem tools — handle before MCP client or blocklist checks
  const fsHandler = BRIDGE_FILESYSTEM_TOOLS[toolName];
  if (fsHandler) {
    let parsedFsArgs;
    if (typeof toolArgs === 'string') {
      try { parsedFsArgs = JSON.parse(toolArgs); } catch { parsedFsArgs = {}; }
    } else {
      parsedFsArgs = toolArgs || {};
    }
    try {
      const result = fsHandler(parsedFsArgs);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      return { status: 'error', error: err.message || String(err) };
    }
  }

  // SEC-002: Check blocklist before any execution
  if (BRIDGE_BLOCKED_TOOLS.has(toolName)) {
    stderrLogger.warn(`Tool blocked by bridge security policy: ${toolName}`);
    return {
      status: 'error',
      error: `Tool '${toolName}' is blocked for provider agents (bridge security policy).`,
    };
  }

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
    ];

    // Bash-native providers (codex-cli, cursor-cli) have built-in shell execution.
    // They run commands directly and do NOT need structured tool definitions.
    // Sending XML tool schemas to these providers causes them to attempt
    // bash-based tool invocations that don't match the bridge's expectations.
    const BASH_NATIVE_PROVIDERS = new Set(['codex-cli', 'cursor-cli']);
    const isBashNative = BASH_NATIVE_PROVIDERS.has(providerName);

    if (!isBashNative) {
      if (agent.config?.tools && Array.isArray(agent.config.tools)) {
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
    const MAX_TOOL_ITERATIONS = 50;
    const providerStartTime = Date.now();

    // Stuck detection state
    const STUCK_WINDOW = 4;
    const STUCK_THRESHOLD = 3;
    const toolCallFingerprints = [];
    let consecutiveErrorIterations = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;

    // Tool-calling loop (no lock held — provider calls can take up to 120s)
    // Note: MCP tool execution requires the CLI MCP client, which is typically
    // unavailable when bridge runs as a subprocess. When unavailable, tool calls
    // are reported in the response but not executed — the provider's text response
    // is used as-is. This is sufficient for prompt-response hive workers.
    const mcpAvailable = !!(await loadMCPClient());

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
            writeFileSync(tmpResult, JSON.stringify(termResult, null, 2) + '\n');
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

      response = await retryWithBackoff(completeWithOpenRouterReroll, {
        maxAttempts: (config.retryAttempts || 0) + 1,
        initialDelay: config.retryDelay || 1000,
        isRetryable: isRetryableError,
      });

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
            executeMCPTool(tc.function.name, tc.function.arguments)
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
          const rawContent = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result);
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
    writeFileSync(tmpResult, JSON.stringify(result, null, 2) + '\n');
    renameSync(tmpResult, resultFile);
  } else {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
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

main().catch(async (err) => {
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
      writeFileSync(tmpResult, JSON.stringify(errorResponse, null, 2) + '\n');
      renameSync(tmpResult, resultFile);
    } catch {
      // File write failed — fall back to stdout
      process.stdout.write(JSON.stringify(errorResponse, null, 2) + '\n');
    }
  } else {
    process.stdout.write(JSON.stringify(errorResponse, null, 2) + '\n');
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
});
