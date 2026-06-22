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
import { homedir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync } from 'child_process';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { lookup as dnsLookup } from 'dns/promises';
import { createConnection, isIP } from 'net';
import { createRequire } from 'module';
import {
  appendTaskJournalEvent,
  classifyJournalError,
} from './agent-task-journal.mjs';
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

const bridgeRequire = createRequire(import.meta.url);

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

function bridgeIntegerEnv(name, fallback, { min = 1, max = 200 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function taskIdFromResultFile(resultFile) {
  if (!resultFile) return '';
  const file = basename(resultFile);
  return file.endsWith('.result.json') ? file.slice(0, -'.result.json'.length) : '';
}

function bridgeStringValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function bridgeResolveHiveHome(env = process.env) {
  const configured = bridgeStringValue(env.HIVE_FLOW_HOME);
  if (configured && isAbsolute(configured)) return resolve(configured);
  return join(homedir(), '.hive-flow');
}

function bridgeWakeClientKind(kind) {
  const raw = String(kind || '').toLowerCase();
  if (raw.includes('codex')) return 'codex';
  if (raw.includes('claude')) return 'claude-code';
  return kind || null;
}

function bridgeSessionValue(env = process.env, owner = {}) {
  return bridgeStringValue(owner.ownerSessionId)
    || bridgeStringValue(env.CODEX_SESSION_ID)
    || bridgeStringValue(env.HIVE_FLOW_SESSION_ID)
    || bridgeStringValue(env.CODEX_THREAD_ID)
    || bridgeStringValue(env.CLAUDE_SESSION_ID)
}

function bridgeClientKind(env = process.env, owner = {}) {
  return bridgeWakeClientKind(bridgeStringValue(owner.ownerClientKind))
    || bridgeStringValue(env.HIVE_FLOW_CLIENT_KIND)
    || bridgeStringValue(env.CLAUDE_CODE_ENTRYPOINT)
    || (bridgeStringValue(env.CODEX_SESSION_ID) || bridgeStringValue(env.CODEX_THREAD_ID) ? 'codex' : null)
    || (bridgeStringValue(env.CLAUDE_SESSION_ID) || bridgeStringValue(env.CLAUDE_PROJECT_DIR) ? 'claude-code' : null)
    || 'claude-code';
}

function bridgeTargetAgent(env = process.env, owner = {}) {
  const explicit = bridgeStringValue(owner.targetAgent);
  if (explicit) return explicit.toLowerCase();
  const raw = bridgeClientKind(env, owner).toLowerCase();
  if (raw.includes('codex')) return 'codex';
  if (raw.includes('claude')) return 'claude';
  return null;
}

function bridgeTargetAgentFromAgentId(agentId) {
  const raw = bridgeStringValue(agentId)?.toLowerCase() || '';
  if (raw.includes('codex')) return 'codex';
  if (raw.includes('claude')) return 'claude';
  return null;
}

function bridgeSessionKeyFor(env = process.env, owner = {}) {
  const session = bridgeSessionValue(env, owner);
  if (!session) return null;
  const clientKind = bridgeClientKind(env, owner);
  return `s_${createHash('sha256').update(`${clientKind}\0${session}`).digest('hex').slice(0, 32)}`;
}

function bridgeTaskNotificationDataDirs(projectRoot, env = process.env, owner = {}) {
  const localDataDir = join(projectRoot, '.hive-flow', 'data');
  const sessionKey = bridgeSessionKeyFor(env, owner);
  if (!sessionKey) return [localDataDir];
  return [
    localDataDir,
    join(bridgeResolveHiveHome(env), 'wake', 'sessions', sessionKey),
  ];
}

function summarizeBridgeResultFile(resultFile, taskId) {
  try {
    const record = JSON.parse(readFileSync(resultFile, 'utf8'));
    const inner = record?.result || record;
    const ok = inner?.success !== false && record?.success !== false;
    const status = ok ? 'completed' : 'failed';
    const agentId = inner?.agentId || record?.agentId || 'unknown';
    let detail = '';
    if (!ok) {
      const err = inner?.error || record?.error || '';
      detail = err ? ` error="${redactBridgeString(String(err)).slice(0, 160)}"` : '';
    } else {
      const content = inner?.content || '';
      const len = typeof content === 'string' ? content.length : 0;
      detail = len ? ` resultChars=${len}` : '';
    }
    return `[TASK COMPLETE: ${taskId}] agent=${agentId} status=${status}${detail}. Call agent_task_result({taskId:"${taskId}"}) for the full payload.`;
  } catch {
    return `[TASK COMPLETE: ${taskId}] result file present. Call agent_task_result({taskId:"${taskId}"}) for the full payload.`;
  }
}

function projectRootFromResultFile(resultFile) {
  try {
    const tasksDir = dirname(resultFile);
    const hiveDir = dirname(tasksDir);
    if (basename(hiveDir) === '.hive-flow' && basename(tasksDir) === 'tasks') {
      return dirname(hiveDir);
    }
  } catch {
    /* fall through */
  }
  return process.env.HIVE_FLOW_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function bridgeReadJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function bridgeOwnerFromObject(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const ownerClientKind = bridgeStringValue(obj.ownerClientKind || obj.owner_client_kind || obj.clientKind || obj.client_kind);
  const explicitTarget = bridgeStringValue(obj.targetAgent || obj.target_agent);
  return {
    ownerSessionId: bridgeStringValue(obj.ownerSessionId || obj.owner_session_id || obj.sessionId || obj.session_id),
    ownerClientKind,
    targetAgent: explicitTarget || (ownerClientKind ? bridgeTargetAgent({}, { ownerClientKind }) : null),
    agentId: bridgeStringValue(obj.agentId || obj.agent_id),
  };
}

function bridgeMergeOwners(...owners) {
  const merged = {};
  for (const owner of owners) {
    if (!owner) continue;
    if (!merged.ownerSessionId && owner.ownerSessionId) merged.ownerSessionId = owner.ownerSessionId;
    if (!merged.ownerClientKind && owner.ownerClientKind) merged.ownerClientKind = owner.ownerClientKind;
    if (!merged.targetAgent && owner.targetAgent) merged.targetAgent = owner.targetAgent;
    if (!merged.agentId && owner.agentId) merged.agentId = owner.agentId;
  }
  if (!merged.targetAgent && merged.ownerClientKind) merged.targetAgent = bridgeTargetAgent({}, merged);
  if (!merged.targetAgent && merged.agentId) merged.targetAgent = bridgeTargetAgentFromAgentId(merged.agentId);
  return merged;
}

function bridgeDurableOwnerFields(env = process.env) {
  const ownerSessionId = bridgeSessionValue(env);
  const ownerClientKind = bridgeClientKind(env);
  const targetAgent = bridgeTargetAgent(env, { ownerSessionId, ownerClientKind });
  return {
    ...(targetAgent ? { targetAgent } : {}),
    ...(ownerSessionId ? { ownerSessionId } : {}),
    ...(ownerClientKind ? { ownerClientKind } : {}),
  };
}

function bridgeTaskOwnershipFromResultFile(resultFile, projectRoot = projectRootFromResultFile(resultFile)) {
  const taskId = taskIdFromResultFile(resultFile);
  const tracking = taskId ? bridgeReadJsonFile(join(projectRoot, '.hive-flow', 'tasks', `${taskId}.json`)) : null;
  const result = bridgeReadJsonFile(resultFile);
  const resultInner = result && typeof result === 'object' ? result.result : null;
  const fromTracking = bridgeOwnerFromObject(tracking);
  const fromResult = bridgeMergeOwners(bridgeOwnerFromObject(result), bridgeOwnerFromObject(resultInner));
  const agentId = fromTracking.agentId || fromResult.agentId;
  let fromAgent = {};
  if (agentId) {
    const store = bridgeReadJsonFile(join(projectRoot, '.hive-flow', 'agents', 'store.json'));
    fromAgent = bridgeOwnerFromObject(store?.agents?.[agentId]);
  }
  return bridgeMergeOwners(fromTracking, fromResult, fromAgent);
}

function appendTaskNotificationOnce(dataDir, taskId, line) {
  const markerPath = join(dataDir, `task-${taskId}.notified`);
  let fd = null;
  let markerCreated = false;
  try {
    mkdirSync(dataDir, { recursive: true });
    fd = openSync(markerPath, 'wx', 0o600);
    markerCreated = true;
    appendFileSync(join(dataDir, 'pending-notifications.jsonl'), line + '\n', 'utf8');
    writeFileSync(fd, JSON.stringify({
      claimedAt: new Date().toISOString(),
      pid: process.pid,
      source: 'provider-agent-bridge',
    }, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    try { if (fd !== null) closeSync(fd); } catch { /* ignore */ }
    if (markerCreated) {
      try { unlinkSync(markerPath); } catch { /* ignore */ }
    }
    return false;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function appendPermissionNotificationOnce(dataDir, taskId, markerKey, line) {
  const safeMarker = String(markerKey || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'permission-request';
  const markerPath = join(dataDir, `task-${taskId}.${safeMarker}.notified`);
  let fd = null;
  let markerCreated = false;
  try {
    mkdirSync(dataDir, { recursive: true });
    fd = openSync(markerPath, 'wx', 0o600);
    markerCreated = true;
    appendFileSync(join(dataDir, 'pending-notifications.jsonl'), line + '\n', 'utf8');
    writeFileSync(fd, JSON.stringify({
      claimedAt: new Date().toISOString(),
      pid: process.pid,
      source: 'provider-agent-bridge:permission-request',
    }, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    try { if (fd !== null) closeSync(fd); } catch { /* ignore */ }
    if (markerCreated) {
      try { unlinkSync(markerPath); } catch { /* ignore */ }
    }
    return false;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export function notifyTaskCompletionFromResultFile(resultFile) {
  try {
    const taskId = taskIdFromResultFile(resultFile);
    if (!taskId) return false;
    const projectRoot = projectRootFromResultFile(resultFile);
    const owner = bridgeTaskOwnershipFromResultFile(resultFile, projectRoot);
    const targetAgent = bridgeTargetAgent(process.env, owner);
    const line = JSON.stringify({
      kind: 'task',
      taskId,
      ts: new Date().toISOString(),
      summary: summarizeBridgeResultFile(resultFile, taskId),
      ...(targetAgent ? { targetAgent } : {}),
      ...(owner.ownerSessionId ? { ownerSessionId: owner.ownerSessionId } : {}),
      ...(owner.ownerClientKind ? { ownerClientKind: owner.ownerClientKind } : {}),
    });
    let wrote = false;
    for (const dataDir of bridgeTaskNotificationDataDirs(projectRoot, process.env, owner)) {
      if (appendTaskNotificationOnce(dataDir, taskId, line)) wrote = true;
    }
    return wrote;
  } catch {
    return false;
  }
}

function notifyPermissionEscalationFromDeniedTool(toolName, denied, ctx = {}) {
  try {
    const resultFile = typeof ctx.resultFile === 'string' ? ctx.resultFile : '';
    const taskId = taskIdFromResultFile(resultFile);
    if (!taskId) return false;
    const projectRoot = projectRootFromResultFile(resultFile);
    const owner = bridgeTaskOwnershipFromResultFile(resultFile, projectRoot);
    const targetAgent = bridgeTargetAgent(process.env, owner);
    const denyReason = String(denied?.error || denied?.message || denied?.denyReason || 'permission-denied').slice(0, 180);
    const denyCode = String(denied?.denyReason || 'permission-denied').slice(0, 80);
    const markerHash = createHash('sha256')
      .update(`${toolName}\0${denyReason}`)
      .digest('hex')
      .slice(0, 16);
    const summary = `[PERMISSION REQUEST: ${taskId}] provider agent ${ctx.agentId || 'unknown'} could not use ${toolName}: ${denyReason}. Owning operator should run an equivalent privileged action or adjust policy if appropriate.`;
    const line = JSON.stringify({
      kind: 'permission-request',
      taskId,
      ts: new Date().toISOString(),
      summary,
      tool: toolName,
      denyReason,
      denyCode,
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      ...(targetAgent ? { targetAgent } : {}),
      ...(owner.ownerSessionId ? { ownerSessionId: owner.ownerSessionId } : {}),
      ...(owner.ownerClientKind ? { ownerClientKind: owner.ownerClientKind } : {}),
    });
    let wrote = false;
    for (const dataDir of bridgeTaskNotificationDataDirs(projectRoot, process.env, owner)) {
      if (appendPermissionNotificationOnce(dataDir, taskId, `permission-${markerHash}`, line)) wrote = true;
    }
    return wrote;
  } catch {
    return false;
  }
}

function appendBridgeJournalEvent({
  event,
  resultFile,
  agentId,
  provider,
  model,
  pid = process.pid,
  meta,
}) {
  const taskId = taskIdFromResultFile(resultFile);
  if (!taskId) return false;
  return appendTaskJournalEvent({
    tasksDir: dirname(resultFile),
    taskId,
    event,
    agentId,
    provider,
    model,
    pid,
    meta,
  });
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
      const payload = safeBridgeJsonStringify(errorResponse, 2) + '\n';
      writeFileSync(tmpResult, payload);
      renameSync(tmpResult, resultFile);
      appendBridgeJournalEvent({
        event: 'result_written',
        resultFile,
        agentId: logAgentId,
        meta: {
          success: false,
          resultBytes: Buffer.byteLength(payload, 'utf8'),
          reason: 'SIGTERM',
          status: 'failed',
        },
      });
      notifyTaskCompletionFromResultFile(resultFile);
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

// DO-NOT-REVERT: strict API providers must receive the guarded bridge web tools.
// OpenRouter/DeepSeek agents are expected to ground web tasks through tool calls,
// not silently answer from model priors.
const STRICT_API_PROVIDERS = new Set(['openrouter', 'deepseek', 'openai', 'qwen']);

// Providers whose models reject OpenAI-style `tool_choice: "required"`.
// DeepSeek reasoning models ("thinking mode") return HTTP 400 for the flag.
// OpenRouter MiniMax M3 returns 404 "No endpoints found that support the
// provided tool_choice value" for grounded bridge tasks. For these we omit the
// nudge and let the model decide; grounding is still enforced by the
// UNGROUNDED_TOOL_TASK floor (a strict task that executes zero tools is
// refused), so correctness is preserved without the incompatible flag.
const TOOL_CHOICE_REQUIRED_UNSUPPORTED = new Set(['deepseek', 'openrouter']);

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
  'x-ai/grok-4.3':                              { maxTokens: 1000000, maxEntries: 100 },
  'minimax/minimax-m3':                         { maxTokens: 1048576, maxEntries: 100 },
  'moonshotai/kimi-k2.6':                       { maxTokens: 262144,  maxEntries: 50 },
  'qwen/qwen3.7-plus':                          { maxTokens: 1000000, maxEntries: 100 },
  'z-ai/glm-5.2':                               { maxTokens: 1000000, maxEntries: 100 },
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

function toolCallsOf(msg) {
  if (Array.isArray(msg?.toolCalls)) return msg.toolCalls;
  if (Array.isArray(msg?.tool_calls)) return msg.tool_calls;
  return [];
}

function toolCallIdOf(msg) {
  if (typeof msg?.toolCallId === 'string') return msg.toolCallId;
  if (typeof msg?.tool_call_id === 'string') return msg.tool_call_id;
  return null;
}

function withNormalizedToolCalls(msg, toolCalls) {
  const next = { ...msg };
  delete next.toolCalls;
  delete next.tool_calls;
  if (toolCalls.length > 0) {
    if (Array.isArray(msg.tool_calls) && !Array.isArray(msg.toolCalls)) {
      next.tool_calls = toolCalls;
    } else {
      next.toolCalls = toolCalls;
    }
  }
  return next;
}

function hasAssistantContent(msg) {
  if (typeof msg.content === 'string') return msg.content.length > 0;
  return msg.content !== undefined && msg.content !== null;
}

export function normalizeForProvider(messages) {
  if (!Array.isArray(messages)) return [];

  const normalized = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') continue;

    const rawToolCalls = toolCallsOf(msg);
    const toolCalls = rawToolCalls.filter((toolCall) => toolCall?.id);
    if (msg.role !== 'assistant' || rawToolCalls.length === 0) {
      if (msg.role === 'tool') continue;
      normalized.push({ ...msg });
      continue;
    }

    const followingTools = [];
    let cursor = i + 1;
    while (cursor < messages.length && messages[cursor]?.role === 'tool') {
      followingTools.push(messages[cursor]);
      cursor += 1;
    }

    const toolResultsById = new Map();
    for (const toolMsg of followingTools) {
      const id = toolCallIdOf(toolMsg);
      if (id && !toolResultsById.has(id)) {
        toolResultsById.set(id, toolMsg);
      }
    }

    const completedCalls = toolCalls.filter((toolCall) => toolResultsById.has(toolCall.id));
    const assistant = withNormalizedToolCalls(msg, completedCalls);
    if (completedCalls.length > 0 || hasAssistantContent(assistant)) {
      normalized.push(assistant);
    }
    for (const toolCall of completedCalls) {
      normalized.push({ ...toolResultsById.get(toolCall.id) });
    }

    i = cursor - 1;
  }

  return normalized;
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

export function prepareForProvider(messages, limits) {
  return trimMessages(normalizeForProvider(messages), limits);
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
    // DO-NOT-REVERT: human-selected OpenRouter default is MiniMax M3. Xiaomi
    // may remain an allowlisted fallback, but it is not the default.
    'openrouter': 'minimax/minimax-m3',
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

// Enforcement state/home layout — MUST mirror `.claude/helpers/enforcement.cjs`
// resolveHiveHome(): when HIVE_FLOW_HOME is set AND absolute, the canonical
// enforcement tree lives at `<HIVE_FLOW_HOME>/enforcement` (state under
// `enforcement/global/state.json`, key at `enforcement/.hmac-key`). When it is
// not set, enforcement.cjs falls back to `<homedir>/.hive-flow/enforcement`.
//
// The bridge historically only read the legacy project-local layout
// (`<PROJECT_ROOT>/.hive-flow/enforcement/state.json` + sibling `.hmac-key`),
// which fail-closes whenever the live signed state is written to the
// HIVE_FLOW_HOME layout (e.g. external-temp fixtures). We resolve the canonical
// home first and fall back to the legacy project-local layout so existing
// installs and the project-rooted parity fixtures stay green. Fail-closed
// tamper behavior, HMAC verification, and path sandboxing are preserved — only
// WHICH home/key the bridge reads from is corrected.
function resolveEnforcementHome() {
  const configured = String(process.env.HIVE_FLOW_HOME || '').trim();
  if (configured && isAbsolute(configured)) return resolve(configured);
  return join(homedir(), '.hive-flow');
}

const ENFORCEMENT_HOME = resolveEnforcementHome();
const CANONICAL_ENFORCEMENT_DIR = join(ENFORCEMENT_HOME, 'enforcement');
const LEGACY_ENFORCEMENT_DIR = resolve(PROJECT_ROOT, '.hive-flow', 'enforcement');

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

function readEnforcementHmacKeyFromDir(enforcementDir) {
  try {
    const key = readFileSync(join(enforcementDir, '.hmac-key'), 'utf8').trim();
    return key || null;
  } catch {
    return null;
  }
}

// Back-compat helper: prefer the canonical (HIVE_FLOW_HOME) key, then the
// legacy project-local key. Retained for any external callers/tests that import
// the bridge and expect a key getter.
function readBridgeHmacKey() {
  return readEnforcementHmacKeyFromDir(CANONICAL_ENFORCEMENT_DIR)
    ?? readEnforcementHmacKeyFromDir(LEGACY_ENFORCEMENT_DIR);
}

function readVerifiedEnforcementLevel(statePath, missingLevel = 0, keyDir) {
  return readVerifiedEnforcementState(statePath, missingLevel, keyDir).level;
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

function readVerifiedEnforcementState(statePath, missingLevel = 0, keyDir) {
  try {
    if (!existsSync(statePath)) return missingEnforcementState(missingLevel);
    // The key MUST come from the same enforcement home that signed this state.
    // When a keyDir is supplied (scoped resolution below) read exactly that
    // home's key; otherwise fall back to canonical-then-legacy for back-compat.
    const key = keyDir ? readEnforcementHmacKeyFromDir(keyDir) : readBridgeHmacKey();
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

// Build the state-file path for a scope within a given enforcement dir.
// Global state lives at `<dir>/global/state.json` in the canonical
// HIVE_FLOW_HOME layout, but at `<dir>/state.json` in the legacy project-local
// layout — the caller selects the correct filename via `globalFile`.
function enforcementStatePathFor(enforcementDir, scopeType, scopeId, globalFile) {
  if (scopeType === 'global') return join(enforcementDir, globalFile);
  const sanitized = protectedPathPolicy.sanitizeScopeId(scopeId, '', 64);
  if (!sanitized) return null;
  if (scopeType === 'agent') return join(enforcementDir, 'agents', sanitized, 'state.json');
  if (scopeType === 'hive') return join(enforcementDir, 'hives', sanitized, 'state.json');
  return null;
}

// Ordered enforcement-home candidates. Each candidate pairs the enforcement dir
// (whose sibling `.hmac-key` signs its states) with the global state filename
// used in that layout.
//
// Ordering rule (preserves prior fail-closed behavior + fixes the
// HIVE_FLOW_HOME bug):
//  - The canonical home is authoritative ONLY when HIVE_FLOW_HOME is set AND
//    ABSOLUTE — exactly matching `resolveEnforcementHome()` semantics (and
//    enforcement.cjs `resolveHiveHome()`). It is where enforcement.cjs and the
//    live diagnostic write the signed state. The legacy project-local layout is
//    consulted only as a fallback for in-flight installs that still keep state
//    under PROJECT_ROOT.
//  - When HIVE_FLOW_HOME is NOT set OR is RELATIVE, use ONLY the legacy
//    project-local layout — exactly the pre-fix behavior. We deliberately do
//    NOT fall back to the homedir canonical layout here: a project-local
//    context with a MISSING global state must fail closed (per the enforcement
//    parity oracle), not silently inherit an unrelated machine-global
//    `~/.hive-flow` state. A RELATIVE HIVE_FLOW_HOME must likewise NOT promote
//    `~/.hive-flow` to canonical.
//
// SAME-ROOT (HIVE_FLOW_HOME === PROJECT_ROOT/.hive-flow): canonical and legacy
// share the SAME `dir`, but they are NOT equivalent candidates — the canonical
// global state lives at `global/state.json` while legacy lives at `state.json`.
// We therefore dedupe by FULL state-path identity (`dir` + `globalFile`), NEVER
// by `dir` alone. Collapsing on `dir` would skip the canonical state and
// re-introduce the fail-closed bug.
function enforcementHomeCandidates() {
  const legacy = { dir: LEGACY_ENFORCEMENT_DIR, globalFile: 'state.json' };
  // Canonical is authoritative ONLY when HIVE_FLOW_HOME is set AND absolute —
  // mirrors resolveEnforcementHome(): a relative value does NOT introduce
  // ~/.hive-flow as canonical.
  const configuredHome = String(process.env.HIVE_FLOW_HOME || '').trim();
  const canonicalAuthoritative = Boolean(configuredHome) && isAbsolute(configuredHome);
  if (!canonicalAuthoritative) return [legacy];

  const canonical = { dir: CANONICAL_ENFORCEMENT_DIR, globalFile: join('global', 'state.json') };
  // Canonical FIRST, legacy fallback. Dedupe by full state-path identity
  // (dir + globalFile) — NOT by dir alone — so the same-root case keeps BOTH.
  const candidates = [canonical, legacy];
  const seen = new Set();
  const deduped = [];
  for (const candidate of candidates) {
    const identity = join(candidate.dir, candidate.globalFile);
    if (seen.has(identity)) continue;
    seen.add(identity);
    deduped.push(candidate);
  }
  return deduped;
}

// Resolve a scope's enforcement snapshot by trying each home candidate in order
// and using the FIRST whose state file exists (each verified with that home's
// own key). If no candidate has a state file, return the missing-state result.
function readScopedEnforcementSnapshot(scopeType, scopeId, missingLevel) {
  for (const candidate of enforcementHomeCandidates()) {
    const statePath = enforcementStatePathFor(candidate.dir, scopeType, scopeId, candidate.globalFile);
    if (!statePath) return null;
    if (existsSync(statePath)) {
      return readVerifiedEnforcementState(statePath, missingLevel, candidate.dir);
    }
  }
  return missingEnforcementState(missingLevel);
}

function checkEnforcementState() {
  const snapshots = [
    readScopedEnforcementSnapshot('global', '', FAIL_CLOSED_ENFORCEMENT_LEVEL),
  ];

  const agentId = process.env.HIVE_FLOW_AGENT_ID || process.env.CLAUDE_AGENT_ID || '';
  if (agentId) {
    const agentSnapshot = readScopedEnforcementSnapshot('agent', agentId, 0);
    if (agentSnapshot) snapshots.push(agentSnapshot);
  }

  const hiveId = process.env.HIVE_FLOW_HIVE_ID || '';
  if (hiveId) {
    const hiveSnapshot = readScopedEnforcementSnapshot('hive', hiveId, 0);
    if (hiveSnapshot) snapshots.push(hiveSnapshot);
  }

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
      session_id: bridgeSessionValue(process.env) || 'provider-bridge-run-shell',
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
  if (options.forceDispatcherUnavailable) {
    bridgeLog('warn', 'web_fetch dispatcher unavailable', { reason: 'forced-unavailable' });
    return null;
  }
  let dynamicUndici = null;
  try {
    dynamicUndici = await import('undici');
    if (typeof dynamicUndici.Agent === 'function' && typeof dynamicUndici.buildConnector === 'function' && typeof dynamicUndici.request === 'function') {
      return dynamicUndici;
    }
  } catch (error) {
    bridgeLog('warn', 'web_fetch dispatcher unavailable', {
      reason: 'dynamic-import-failed',
      error: redactBridgeString(error?.message || String(error)),
    });
  }
  try {
    const requiredUndici = bridgeRequire('undici');
    if (
      typeof requiredUndici.Agent === 'function' &&
      typeof requiredUndici.buildConnector === 'function' &&
      typeof requiredUndici.request === 'function'
    ) {
      bridgeLog('info', 'web_fetch dispatcher loaded through bridge require fallback');
      return requiredUndici;
    }
  } catch (error) {
    bridgeLog('warn', 'web_fetch dispatcher unavailable', {
      reason: 'require-failed',
      error: redactBridgeString(error?.message || String(error)),
    });
  }
  bridgeLog('warn', 'web_fetch dispatcher unavailable', {
    reason: 'missing-undici-api',
    apiTypes: {
      Agent: typeof dynamicUndici?.Agent,
      buildConnector: typeof dynamicUndici?.buildConnector,
      request: typeof dynamicUndici?.request,
    },
    exports: dynamicUndici ? Object.keys(dynamicUndici).slice(0, 20) : [],
    defaultExports: dynamicUndici?.default && typeof dynamicUndici.default === 'object'
      ? Object.keys(dynamicUndici.default).slice(0, 20)
      : [],
  });
  return null;
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

const BRIDGE_TOOL_CAPABILITY_MANIFEST = Object.freeze({
  read_file: {
    capability: 'filesystem.read',
    authority: 'read',
    exposeDefault: true,
    exposeStrictApi: true,
    requiresPathJail: true,
    requiresProtectedReadGate: true,
    outputRedaction: 'bridge-string',
    idempotent: true,
    definition: {
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
  },
  write_file: {
    capability: 'filesystem.write',
    authority: 'write',
    exposeDefault: true,
    // SECURITY-BOUNDARY / REVERSIBLE: exposing write_file to strict API
    // providers means remote OpenRouter/DeepSeek models may request writes
    // inside the project jail. This is intentionally enabled for full harness
    // parity and live diagnostics. To roll back to the previous read-only
    // credential boundary, set write_file/edit_file exposeStrictApi to false.
    // Handler safety still lives in path jail + protected path + enforcement
    // write gates; diagnostics must only write in temporary project roots.
    exposeStrictApi: true,
    requiresPathJail: true,
    requiresProtectedWriteGate: true,
    requiresEnforcementWriteGate: true,
    outputRedaction: 'bridge-string',
    idempotent: false,
    definition: {
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
  },
  edit_file: {
    capability: 'filesystem.write',
    authority: 'write',
    exposeDefault: true,
    // SECURITY-BOUNDARY / REVERSIBLE: strict API edit_file crosses the same
    // remote-write boundary as write_file above. Keep this comment adjacent to
    // the flag so the rollback point is visible during future audits.
    exposeStrictApi: true,
    requiresPathJail: true,
    requiresProtectedWriteGate: true,
    requiresEnforcementWriteGate: true,
    outputRedaction: 'bridge-string',
    idempotent: false,
    definition: {
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
  },
  list_directory: {
    capability: 'filesystem.read',
    authority: 'read',
    exposeDefault: true,
    exposeStrictApi: true,
    requiresPathJail: true,
    requiresProtectedReadGate: true,
    outputRedaction: 'bridge-string',
    idempotent: true,
    definition: {
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
  },
  grep: {
    capability: 'filesystem.search',
    authority: 'read',
    exposeDefault: true,
    exposeStrictApi: true,
    requiresPathJail: true,
    requiresProtectedReadGate: true,
    outputRedaction: 'bridge-string',
    idempotent: true,
    definition: {
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
  },
  find_file: {
    capability: 'filesystem.search',
    authority: 'read',
    exposeDefault: true,
    exposeStrictApi: true,
    requiresPathJail: true,
    requiresProtectedReadGate: true,
    outputRedaction: 'bridge-string',
    idempotent: true,
    definition: {
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
  },
  run_shell: {
    capability: 'process.exec.sandboxed',
    authority: 'exec',
    exposeDefault: true,
    exposeStrictApi: false,
    requiresPermissionGuard: true,
    requiresSandbox: true,
    requiresEnforcementExecGate: true,
    outputRedaction: 'structured-redactor',
    idempotent: false,
    definition: {
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
  },
  run_command: {
    capability: 'process.exec.readonly',
    authority: 'read',
    exposeDefault: false,
    exposeStrictApi: true,
    requiresPathJail: true,
    requiresReadOnlyAllowlist: true,
    outputRedaction: 'structured-redactor',
    idempotent: true,
    definition: {
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
    },
  },
  web_fetch: {
    capability: 'network.fetch.allowlisted',
    authority: 'network',
    exposeDefault: true,
    // DO-NOT-REVERT: strict API agents need this guarded fetch tool for real
    // web grounding; safety lives in allowlist + SSRF + fetch gates below.
    exposeStrictApi: true,
    requiresAllowlist: true,
    requiresSsrfGuard: true,
    requiresEnforcementFetchGate: true,
    outputRedaction: 'structured-redactor',
    idempotent: true,
    definition: {
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
  },
  web_search: {
    capability: 'network.search.unsupported',
    authority: 'unsupported',
    exposeDefault: true,
    // DO-NOT-REVERT: expose the denial-shaped search tool so strict providers
    // can ground "search" attempts honestly instead of hallucinating results.
    exposeStrictApi: true,
    alwaysDenied: true,
    outputRedaction: 'structured-redactor',
    idempotent: true,
    definition: {
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
  },
});

export function bridgeToolDefinitionsForProviderMode(mode = 'default') {
  const strictApi = mode === 'strict-api';
  return Object.values(BRIDGE_TOOL_CAPABILITY_MANIFEST)
    .filter((entry) => strictApi ? entry.exposeStrictApi === true : entry.exposeDefault === true)
    .map((entry) => entry.definition);
}

export function bridgeToolCapabilityManifest() {
  return Object.freeze(Object.fromEntries(
    Object.entries(BRIDGE_TOOL_CAPABILITY_MANIFEST).map(([name, entry]) => [
      name,
      Object.freeze({
        capability: entry.capability,
        authority: entry.authority,
        exposeDefault: entry.exposeDefault === true,
        exposeStrictApi: entry.exposeStrictApi === true,
        requiresPathJail: entry.requiresPathJail === true,
        requiresProtectedReadGate: entry.requiresProtectedReadGate === true,
        requiresProtectedWriteGate: entry.requiresProtectedWriteGate === true,
        requiresEnforcementWriteGate: entry.requiresEnforcementWriteGate === true,
        requiresEnforcementExecGate: entry.requiresEnforcementExecGate === true,
        requiresEnforcementFetchGate: entry.requiresEnforcementFetchGate === true,
        requiresSandbox: entry.requiresSandbox === true,
        requiresPermissionGuard: entry.requiresPermissionGuard === true,
        requiresReadOnlyAllowlist: entry.requiresReadOnlyAllowlist === true,
        requiresAllowlist: entry.requiresAllowlist === true,
        requiresSsrfGuard: entry.requiresSsrfGuard === true,
        alwaysDenied: entry.alwaysDenied === true,
        idempotent: entry.idempotent === true,
        outputRedaction: entry.outputRedaction,
      }),
    ]),
  ));
}

export function bridgeToolRegistryNames() {
  return Object.freeze(Object.keys(BRIDGE_TOOL_REGISTRY).sort());
}

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
    if (
      result &&
      typeof result === 'object' &&
      result.status === 'denied' &&
      (toolName === 'run_command' || toolName === 'run_shell')
    ) {
      notifyPermissionEscalationFromDeniedTool(toolName, result, ctx);
    }
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

/**
 * Decide whether a bridge tool result counts as a SUCCESSFUL grounded execution.
 *
 * A successful result is one that produced real grounded output. Denied/error
 * results MUST NOT count toward grounding, otherwise UNGROUNDED_TOOL_TASK can
 * falsely pass when the model only ever triggered blocked/failed tool calls.
 *
 * Result shapes (from evaluateToolCall):
 *  - string  → success (evaluateToolCall stringifies object handler results, but a
 *              plain handler string result is the success path). NOTE: denied results
 *              are objects that get JSON-stringified by evaluateToolCall, so a string
 *              that parses to {status:'denied'|'error'} must NOT count.
 *  - object {status:'denied'} → NOT successful
 *  - object {status:'error'}  → NOT successful
 *  - any other object         → successful
 */
export function isSuccessfulBridgeToolResult(result) {
  if (result === null || result === undefined) return false;
  if (typeof result === 'string') {
    // evaluateToolCall JSON-stringifies object handler results (incl. denied/error),
    // so a string may actually encode a non-success status. Parse defensively.
    const trimmed = result.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' &&
            (parsed.status === 'denied' || parsed.status === 'error')) {
          return false;
        }
      } catch { /* not JSON — treat as a plain successful string result */ }
    }
    return true;
  }
  if (typeof result === 'object') {
    return result.status !== 'denied' && result.status !== 'error';
  }
  return false;
}

export async function executeBridgeTool(toolName, toolArgs, ctx = {}) {
  bridgeLog('info', 'Bridge tool dispatch', {
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    tool: toolName,
    source: ctx.source || 'provider-response',
  });
  // MUST-FIX-1: Do NOT count executions here. Denied/error tool calls must never
  // count toward grounding. Callers append to executedTools ONLY after checking
  // isSuccessfulBridgeToolResult on the resolved result.
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

export function taskRequiresBridgeToolGrounding(task) {
  const text = String(task || '').toLowerCase();
  const asksToInspect = /\b(read|inspect|open|list|grep|search|find|check|verify|call)\b/.test(text) ||
    /read_file|list_directory|run_command/.test(text);
  const namesLocalSurface = /\b(file|directory|folder|workspace|repo|repository|path|contents?|codebase)\b/.test(text) ||
    /package\.json|tsconfig|readme|git status|exact version/.test(text);
  // MUST-FIX-3: Do NOT treat the bare word "search"/"lookup"/"current"/"latest" as a web
  // signal — those trip on local grep/find tasks ("search the repo for X", "find the latest
  // commit") and wrongly classify them as web-grounding. Require an UNAMBIGUOUS web signal:
  // an explicit URL, "on the web"/"online"/"internet", a web surface noun (website/webpage),
  // a browser/fetch verb, or the literal web_fetch/web_search tool names.
  const hasExplicitWebSignal = /\b(online|internet|website|webpage|browser)\b/.test(text) ||
    /\bon the web\b/.test(text) ||
    /\bweb (search|page|site|lookup|browse|fetch|request)\b/.test(text) ||
    /https?:\/\//.test(text) ||
    /web_fetch|web_search/.test(text);
  // "fetch <url>" / "fetch a url" without the literal http prefix still counts as web.
  const asksForWebGrounding = hasExplicitWebSignal ||
    /\bfetch\b.*\b(url|http|https|web|page|site)\b/.test(text) ||
    /\burl\b/.test(text);
  const namesWebSurface = hasExplicitWebSignal || /\b(url|http|https)\b/.test(text);
  // Freshness/external signals: tasks asking for latest/current/recent/news/release/version
  // data must be grounded even without an explicit web surface or local file surface, because
  // strict providers must not answer from priors when the user needs up-to-date information.
  const hasFreshnessSignal = /\b(latest|current|recent|today|news|release|version|package)\b/.test(text);
  return (asksToInspect && namesLocalSurface) || (asksForWebGrounding && namesWebSurface) || hasFreshnessSignal;
}

// Exactly-one marker invariant: the grounding mandate is identified by this literal.
// We assert it appears AT MOST once in the system message (index 0, trim-protected).
export const GROUNDING_MANDATE_MARKER = '[BRIDGE ENFORCEMENT]';

// Hard-prompt grounding mandate appended ONCE to the system message (preserved slot,
// never trimmed by prepareForProvider). Addresses non-deterministic tool skipping and
// the write_file trailing-newline argument-fidelity miss.
export const GROUNDING_MANDATE_SYSTEM_SUFFIX =
  '\n\n' + GROUNDING_MANDATE_MARKER + ' For ALL tasks requiring file or web operations: ' +
  'you MUST respond with a tool call as your first action. ' +
  'Do NOT produce any assistant text before the tool call. ' +
  'BYTE-EXACT ARGUMENT FIDELITY: Reproduce every tool-call string argument byte-for-byte ' +
  'EXACTLY as provided. If an argument value ends with a newline character (\\n) or contains ' +
  'leading/trailing whitespace, your emitted argument MUST preserve it exactly. ' +
  'NEVER trim, strip, normalize, or "clean up" trailing newlines or whitespace in arguments. ' +
  'Copy every argument verbatim — do NOT infer, paraphrase, omit, add, or repair any part. ' +
  'Do NOT answer from memory or model priors. Only tool calls are acceptable.';

// Providers that support {type:'function',function:{name}} tool_choice but NOT 'required'.
// DeepSeek thinking-mode rejects BOTH forms (HTTP 400) so it is excluded — it gets the
// hard-prompt mandate only, no toolChoice of any kind.
export const SPECIFIC_FUNCTION_SAFE = new Set(['openrouter']);

/**
 * Compute the tool_choice value for a strict-API provider on a grounding-required task.
 * Pure function so the forcing matrix is unit-testable.
 *
 * Returns:
 *  - 'required' when the provider accepts it (not in TOOL_CHOICE_REQUIRED_UNSUPPORTED).
 *  - {type:'function',function:{name}} ONLY when the provider is SPECIFIC_FUNCTION_SAFE
 *    AND exactly one strict tool name appears verbatim in the task text.
 *  - undefined otherwise (incl. ALL DeepSeek paths — DeepSeek never gets any toolChoice).
 */
export function computeStrictGroundingToolChoice({ providerName, task, strictApiToolNames }) {
  const isUnsupportedForcing = TOOL_CHOICE_REQUIRED_UNSUPPORTED.has(providerName);
  if (!isUnsupportedForcing) {
    return 'required';
  }
  // Unsupported-forcing provider (openrouter, deepseek): never send 'required'.
  if (!SPECIFIC_FUNCTION_SAFE.has(providerName)) {
    // DeepSeek and any other unsupported-forcing provider: NO toolChoice at all.
    return undefined;
  }
  const names = Array.isArray(strictApiToolNames) ? strictApiToolNames : [];
  const lower = String(task || '');
  const found = names.filter((name) => {
    // Whole-word / bare-identifier match — avoids 'file' matching 'read_file'.
    const re = new RegExp(`(^|[^a-zA-Z0-9_])${name}($|[^a-zA-Z0-9_])`, 'i');
    return re.test(lower);
  });
  if (found.length === 1) {
    return { type: 'function', function: { name: found[0] } };
  }
  return undefined;
}

/**
 * Inject the grounding mandate into the system message exactly once.
 * Invariant: the marker appears AT MOST once. Mutates `messages` in place and returns it.
 */
export function injectGroundingMandate(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const firstMsg = list[0];
  if (firstMsg && firstMsg.role === 'system') {
    const existing = String(firstMsg.content || '');
    if (!existing.includes(GROUNDING_MANDATE_MARKER)) {
      list[0] = { ...firstMsg, content: existing + GROUNDING_MANDATE_SYSTEM_SUFFIX };
    }
  } else {
    list.unshift({ role: 'system', content: GROUNDING_MANDATE_SYSTEM_SUFFIX.trimStart() });
  }
  return list;
}

function ungroundedToolTaskError(providerName) {
  const error = new Error(
    `Strict API provider '${providerName}' answered a grounded workspace/web task but did not use bridge tools; refusing ungrounded result.`
  );
  error.code = 'UNGROUNDED_TOOL_TASK';
  return error;
}

// ===== Exact-args fidelity enforcement =====
//
// When a diagnostic task carries the machine-readable block:
//   'Your FIRST response MUST be a tool call to the bridge tool named "<tool>".'
//   'Use these exact arguments: <JSON object>.'
// AND exactly ONE strict tool name appears in the task, the bridge validates
// the model's emitted arguments BEFORE executing the tool, retries with a
// precise nudge on mismatch (bounded), and fails closed if still wrong.
//
// ONLY fires when both signals are present. Inert for all other tasks.

const EXACT_ARGS_BLOCK_RE = /Use these exact arguments:\s*(\{[\s\S]*?\})\s*\./;
const EXACT_TOOL_NAME_RE = /bridge tool named\s+"([^"]+)"/;
const MAX_ARG_FIDELITY_RETRIES = 2;

/**
 * Parse the exact-args context from a diagnostic task string.
 * Returns { toolName, expectedArgs } when the task carries the machine-readable
 * exact-args block AND names exactly one strict tool; returns null otherwise.
 *
 * @param {string} task
 * @param {string[]} strictApiToolNames
 * @returns {{ toolName: string, expectedArgs: Record<string,unknown> } | null}
 */
export function parseExactArgsContext(task, strictApiToolNames) {
  if (typeof task !== 'string') return null;

  const argsMatch = EXACT_ARGS_BLOCK_RE.exec(task);
  if (!argsMatch) return null;

  let expectedArgs;
  try {
    expectedArgs = JSON.parse(argsMatch[1]);
  } catch {
    return null;
  }
  if (!expectedArgs || typeof expectedArgs !== 'object' || Array.isArray(expectedArgs)) return null;

  const toolMatch = EXACT_TOOL_NAME_RE.exec(task);
  if (!toolMatch) return null;
  const toolName = toolMatch[1];

  const names = Array.isArray(strictApiToolNames) ? strictApiToolNames : [];
  if (!names.includes(toolName)) return null;

  return { toolName, expectedArgs };
}

/**
 * Deep, canonical JSON-value equality.
 *
 * FIX 1 (Codex bounce): the previous `exactArgsMatch` used strict `!==` on each
 * value, so array/object arguments (run_command argv, edit_file/grep nested args)
 * compared by reference identity and could NEVER match. This implements
 * structural equality with BYTE-EXACT string leaves:
 *   - strings: strict `===` (trailing newline matters; NO normalization).
 *   - numbers/booleans/null: strict `===` (NaN treated as unequal, like JSON).
 *   - arrays: same length + element-wise deep-equal.
 *   - objects: identical key set (no extra/missing) + deep-equal values.
 *   - type mismatch (e.g. array vs object): not equal.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function deepJsonEqual(a, b) {
  if (a === b) return true; // fast path for identical primitives/refs

  // Null / non-object primitives: only equal via the strict === above.
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false; // array vs object never match

  if (aIsArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepJsonEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepJsonEqual(a[key], b[key])) return false;
  }
  return true;
}

/**
 * Compare emitted args against expected for byte-exact, deep fidelity.
 * Returns true only when the top-level arg objects are structurally identical
 * (same key set) AND every leaf value deep-matches (strings byte-identical,
 * including trailing newlines; arrays/objects recursively equal).
 *
 * @param {unknown} emittedArgs
 * @param {Record<string,unknown>} expectedArgs
 * @returns {boolean}
 */
export function exactArgsMatch(emittedArgs, expectedArgs) {
  if (!emittedArgs || typeof emittedArgs !== 'object' || Array.isArray(emittedArgs)) return false;
  if (!expectedArgs || typeof expectedArgs !== 'object' || Array.isArray(expectedArgs)) return false;
  return deepJsonEqual(emittedArgs, expectedArgs);
}

// Trailing-whitespace run that a model may drop when tokenizing a string value.
// Repair only ever ADDS BACK whitespace/newline bytes the expected value already
// ended with; it never alters interior or non-whitespace content.
const TRAILING_WHITESPACE_RE = /[ \t\r\n\f\v]+$/;

/**
 * Decide whether `emitted` differs from `expected` ONLY by a missing/truncated
 * trailing whitespace/newline run on one or more STRING leaves, with everything
 * else (structure, key sets, non-string leaves, interior content) byte-identical.
 *
 * Returns true ONLY when:
 *   - both are objects (not arrays/null) with identical structure at every node;
 *   - every non-string leaf deep-equals;
 *   - every string leaf is either identical, OR the expected leaf equals the
 *     emitted leaf plus a PURE trailing-whitespace run (expected === emitted + ws,
 *     where `ws` is non-empty and only whitespace, AND the emitted leaf does not
 *     itself already end in whitespace that was changed — interior or differing
 *     trailing whitespace is rejected);
 *   - at least one string leaf actually needed the trailing-whitespace repair
 *     (a pure exact match would not reach here — callers gate on !exactArgsMatch);
 *   - ALLOWLIST (default-deny): a repair is permitted ONLY when the differing
 *     string leaf's nearest ancestor object key is one of the content-bearing
 *     keys: `content`, `old_string`, `new_string`. Every other key — including
 *     `path`, `pattern`, `query`, `url`, and any element nested under `argv` —
 *     is NOT repairable. This prevents silently altering semantically meaningful
 *     path/pattern/argv values that happen to differ only by trailing whitespace.
 *
 * Anything else (substantive content change, interior whitespace change, missing
 * key, type change, shape change, disallowed leaf key) returns false.
 *
 * @param {unknown} emitted
 * @param {unknown} expected
 * @returns {boolean} true when expected can be reconstructed from emitted by
 *   appending only trailing whitespace to one or more allowlisted string leaves
 */

/** Keys whose string leaves may be trailing-whitespace-repaired (default-deny). */
const REPAIR_ALLOWLIST = new Set(['content', 'old_string', 'new_string']);

export function isTrailingWhitespaceArtifact(emitted, expected) {
  let repairedAny = false;

  /**
   * @param {unknown} em
   * @param {unknown} ex
   * @param {string|null} leafKey  The nearest ancestor object key, or null at
   *   the root.  Array elements inherit the key of their containing array
   *   property (e.g. argv[0] → leafKey='argv'), so they remain disallowed.
   */
  function walk(em, ex, leafKey) {
    if (typeof ex === 'string') {
      if (typeof em !== 'string') return false;
      if (em === ex) return true;
      // Disallow repair for keys not in the content-bearing allowlist.
      if (!REPAIR_ALLOWLIST.has(leafKey)) return false;
      // expected must equal emitted + a non-empty PURE trailing-whitespace run.
      if (!ex.startsWith(em)) return false; // emitted must be a strict prefix
      const suffix = ex.slice(em.length);
      if (suffix.length === 0) return false;
      if (!/^[ \t\r\n\f\v]+$/.test(suffix)) return false; // only whitespace may be added back
      // Reject CHANGED (not merely truncated) trailing whitespace: the emitted
      // leaf must NOT itself end in trailing whitespace, otherwise the model
      // altered the existing whitespace rather than dropping a clean suffix.
      if (TRAILING_WHITESPACE_RE.test(em)) return false;
      repairedAny = true;
      return true;
    }
    if (ex === null || typeof ex !== 'object') {
      // non-string primitive leaf: must be strictly equal
      return em === ex;
    }
    // object/array node: structures must match exactly, recurse
    const exIsArray = Array.isArray(ex);
    const emIsArray = Array.isArray(em);
    if (em === null || typeof em !== 'object' || exIsArray !== emIsArray) return false;
    if (exIsArray) {
      if (em.length !== ex.length) return false;
      for (let i = 0; i < ex.length; i += 1) {
        // Array elements inherit the parent object key so argv[*] → disallowed.
        if (!walk(em[i], ex[i], leafKey)) return false;
      }
      return true;
    }
    const exKeys = Object.keys(ex);
    const emKeys = Object.keys(em);
    if (exKeys.length !== emKeys.length) return false;
    for (const key of exKeys) {
      if (!Object.prototype.hasOwnProperty.call(em, key)) return false;
      if (!walk(em[key], ex[key], key)) return false;
    }
    return true;
  }

  if (!emitted || typeof emitted !== 'object' || Array.isArray(emitted)) return false;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return false;
  const ok = walk(emitted, expected, null);
  return ok && repairedAny;
}

/**
 * Parse tool-call arguments — handles pre-parsed objects and JSON strings.
 *
 * @param {string|object|undefined} rawArguments
 * @returns {object|null}
 */
export function parseToolCallArguments(rawArguments) {
  if (rawArguments === null || rawArguments === undefined) return {};
  if (typeof rawArguments === 'object' && !Array.isArray(rawArguments)) return rawArguments;
  if (typeof rawArguments === 'string') {
    const trimmed = rawArguments.trim();
    if (trimmed === '' || trimmed === '{}') return {};
    try {
      const parsed = JSON.parse(rawArguments);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
  }
  return null;
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
    const messages = prepareForProvider(rawMessages, getProviderLimits(agent.provider, agent.resolvedModel));
    const providerName = agent.provider;
    return { store, agent, storePath, messages, providerName };
  });
  appendBridgeJournalEvent({
    event: 'bridge_start',
    resultFile,
    agentId,
    provider: providerName,
    model: agent.resolvedModel,
    pid: process.pid,
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
            request.messages = prepareForProvider(request.messages, correctedLimits);
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

    // Always include bridge-owned tools so providers know they can use them.
    // These are handled directly in the bridge (no MCP client required).
    const builtInFilesystemTools = bridgeToolDefinitionsForProviderMode('default');
    const strictApiReadOnlyTools = bridgeToolDefinitionsForProviderMode('strict-api');

    // Bash-native providers (codex-cli, cursor-cli) have built-in shell execution.
    // They run commands directly and do NOT need structured tool definitions.
    // Sending XML tool schemas to these providers causes them to attempt
    // bash-based tool invocations that don't match the bridge's expectations.
    const BASH_NATIVE_PROVIDERS = new Set(['codex-cli', 'cursor-cli']);
    const isBashNative = BASH_NATIVE_PROVIDERS.has(providerName);
    const isStrictApi = STRICT_API_PROVIDERS.has(providerName);

    // Strict-API grounding enforcement uses two complementary mechanisms:
    //
    // 1. TOOL_CHOICE (computeStrictGroundingToolChoice):
    //    - providers that accept 'required' get it directly.
    //    - openrouter/minimax-m3 (rejects 'required') gets specific-function
    //      {type:'function',function:{name}} ONLY when exactly one strict tool name appears
    //      verbatim in the task; otherwise no toolChoice.
    //    - DeepSeek (rejects ALL toolChoice forms, HTTP 400) gets NO toolChoice at all.
    //
    // 2. HARD-PROMPT grounding mandate (injectGroundingMandate): one preserved marker in the
    //    system message (index 0, trim-protected) — invariant: marker appears at most once.
    //    Primary fix for the write_file trailing-newline argument-fidelity miss.

    const strictApiToolNames = strictApiReadOnlyTools.map((t) => t.function.name);
    const requiresGrounding = taskRequiresBridgeToolGrounding(task);
    const isUnsupportedForcing = TOOL_CHOICE_REQUIRED_UNSUPPORTED.has(providerName);

    if (!isBashNative) {
      if (isStrictApi) {
        request.tools = strictApiReadOnlyTools;
        if (requiresGrounding) {
          const toolChoice = computeStrictGroundingToolChoice({
            providerName, task, strictApiToolNames,
          });
          if (toolChoice !== undefined) {
            request.toolChoice = toolChoice;
            bridgeLog('info', 'Strict grounding tool_choice applied', {
              agentId, provider: providerName,
              toolChoice: typeof toolChoice === 'string' ? toolChoice : toolChoice.function.name,
            });
          }
          // Inject the hard-prompt grounding mandate for providers that can't be hard-forced
          // via 'required' (openrouter/minimax-m3, deepseek). This slot is preserved across
          // prepareForProvider trimming so the mandate persists for all tool-loop iterations.
          if (isUnsupportedForcing) {
            injectGroundingMandate(request.messages);
          }
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
    const MAX_TOOL_ITERATIONS = bridgeIntegerEnv('HIVE_FLOW_AGENT_MAX_TOOL_ITERATIONS', 50, {
      min: 1,
      max: 200,
    });
    let hitMaxToolIterations = false;
    let summaryAfterMaxToolIterations = false;
    const providerStartTime = Date.now();
    const executedTools = [];
    // FIX 3 (single-path regression): the UNGROUNDED_TOOL_TASK floor must fire ONLY
    // when the model answered from priors (emitted ZERO tool calls). A tool call that
    // ran but returned a structured denial (web_fetch denied, web_search unsupported,
    // unknown/blocked tool) is still grounded — the model DID invoke a bridge tool.
    // `executedTools` stays success-gated (MUST-FIX-1); `attemptedTools` tracks EVERY
    // tool call the model actually emitted (denied/error included) and is what the
    // floor checks. This restores the single-path contract that denied-tool diagnostics
    // succeed, without un-gating executedTools.
    const attemptedTools = [];
    const completeProviderRequest = async (requestToSend, meta = {}) => {
      const requestStart = Date.now();
      appendBridgeJournalEvent({
        event: 'provider_request_start',
        resultFile,
        agentId,
        provider: providerName,
        model: requestToSend.model || agent.resolvedModel,
        meta: {
          iteration: iterations + 1,
          messageCount: Array.isArray(requestToSend.messages) ? requestToSend.messages.length : undefined,
          ...meta,
        },
      });
      try {
        const providerResponse = await provider.complete(requestToSend);
        appendBridgeJournalEvent({
          event: 'provider_request_end',
          resultFile,
          agentId,
          provider: providerName,
          model: providerResponse.model || requestToSend.model || agent.resolvedModel,
          meta: {
            iteration: iterations + 1,
            durationMs: Date.now() - requestStart,
            finishReason: providerResponse.finishReason,
            contentLength: typeof providerResponse.content === 'string' ? providerResponse.content.length : 0,
            inputTokens: providerResponse.usage?.promptTokens ?? providerResponse.usage?.inputTokens,
            outputTokens: providerResponse.usage?.completionTokens ?? providerResponse.usage?.outputTokens,
            ...meta,
          },
        });
        return providerResponse;
      } catch (error) {
        appendBridgeJournalEvent({
          event: 'provider_error',
          resultFile,
          agentId,
          provider: providerName,
          model: requestToSend.model || agent.resolvedModel,
          meta: {
            iteration: iterations + 1,
            durationMs: Date.now() - requestStart,
            errorClass: classifyJournalError(error),
            httpStatus: error?.status ?? error?.statusCode ?? error?.response?.status,
            ...meta,
          },
        });
        throw error;
      }
    };

    // Stuck detection state
    const STUCK_WINDOW = 4;
    const STUCK_THRESHOLD = 3;
    const toolCallFingerprints = [];
    let consecutiveErrorIterations = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;

    // Exact-args fidelity context: non-null when the task carries the machine-readable
    // 'Use these exact arguments: {...}' block AND names exactly one strict tool.
    // When active, the bridge validates the model's emitted args BEFORE executing the
    // tool; on mismatch it retries with a precise nudge (bounded, fail-closed).
    const exactArgsCtx = isStrictApi
      ? parseExactArgsContext(task, strictApiToolNames)
      : null;
    let argFidelityRetryCount = 0;
    // Once the exact-args expected tool has been emitted correctly (or canonically
    // repaired) and dispatched, the exact-args contract is satisfied. The gate must
    // then go inert so the model's SUBSEQUENT final text answer (a legitimate no-tool
    // turn that summarizes the tool result) is not mis-flagged as a no-tool fidelity
    // violation. This only governs the exact-args gate; the UNGROUNDED floor still
    // applies via attemptedTools.
    let exactArgsSatisfied = false;

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
            const payload = safeBridgeJsonStringify(termResult, 2) + '\n';
            writeFileSync(tmpResult, payload);
            renameSync(tmpResult, resultFile);
            appendBridgeJournalEvent({
              event: 'result_written',
              resultFile,
              agentId,
              provider: providerName,
              model: request.model || agent.resolvedModel,
              meta: {
                success: false,
                resultBytes: Buffer.byteLength(payload, 'utf8'),
                reason: 'TERMINATED',
                status: 'failed',
              },
            });
            notifyTaskCompletionFromResultFile(resultFile);
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
          return await completeProviderRequest(request);
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
            request.messages = prepareForProvider(request.messages, currentBridgeLimits);
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

      // Normalize tool calls so the exact-args fidelity gate (PART 1) can reason
      // about NO-TOOL responses too. A NO-TOOL exact-args response must reach the
      // bounded fidelity path (retry / ARG_FIDELITY_EXHAUSTED), NOT the generic
      // no-tool break that would fail it as UNGROUNDED_TOOL_TASK.
      const calls = Array.isArray(response.toolCalls) ? response.toolCalls : [];

      // Exact-args fidelity gate: when the task carries a 'Use these exact arguments:'
      // block for a single named strict tool, validate the response SHAPE BEFORE any
      // execution AND before the generic no-tool break. FIX 2 (Codex bounce): the gate
      // rejects wrong-tool and multi-tool responses, not just argument mismatches.
      // PART 1 (Codex bounce): the gate ALSO handles NO-TOOL responses here — anything
      // other than exactly one call to the expected tool with deep-matching args is a
      // fidelity violation that must NOT execute. On any violation: nudge, retry (bounded);
      // after the bound, attempt a PART 3 trailing-whitespace canonical repair if the last
      // emitted args differ from expected ONLY by dropped trailing whitespace; otherwise
      // fail closed with ARG_FIDELITY_EXHAUSTED.
      //
      // This path applies ONLY to exact-args tasks (exactArgsCtx !== null). Non-exact
      // generic no-tool grounding keeps the existing UNGROUNDED_TOOL_TASK floor below.
      let exactArgsRepaired = false;
      // EXACT-ARGS ONE-CALL-AND-DONE: capture whether the exact-args contract was
      // ALREADY satisfied BEFORE this response was evaluated. The satisfying response
      // (the one that flips the latch in the gate below) must still execute its single
      // correct call. But any tool calls the model emits on a LATER turn — after the
      // contract is already satisfied — are REDUNDANT and must be DROPPED from execution
      // (minimax-m3 emits edit_file x4; the duplicate non-idempotent calls fail
      // `old_string not found` and corrupt the observed result). This snapshot lets the
      // execution block below distinguish "satisfied THIS response (run it)" from
      // "already satisfied earlier (drop these post-satisfaction calls)".
      const exactArgsSatisfiedBeforeResponse = exactArgsCtx !== null && exactArgsSatisfied;
      if (exactArgsCtx !== null && !exactArgsSatisfied) {
        const single = calls.length === 1 ? calls[0] : null;
        const emittedArgs = single ? parseToolCallArguments(single.function.arguments) : undefined;

        // Shape checks (in order): exactly one call, correct tool name, deep-matching args.
        const wrongCount = calls.length !== 1;
        const wrongTool = !wrongCount && single.function.name !== exactArgsCtx.toolName;
        const wrongArgs = !wrongCount && !wrongTool && !exactArgsMatch(emittedArgs, exactArgsCtx.expectedArgs);

        if (!(wrongCount || wrongTool || wrongArgs)) {
          // Clean exact-args pass: exactly one correct tool with byte-exact args.
          // The contract is satisfied; the gate goes inert for subsequent turns so
          // the model's final text summary is not mis-flagged as a no-tool violation.
          exactArgsSatisfied = true;
        }

        if (wrongCount || wrongTool || wrongArgs) {
          argFidelityRetryCount++;
          const violation = wrongCount
            ? (calls.length === 0 ? 'no-tool-call' : 'multi-tool-call')
            : wrongTool ? 'wrong-tool' : 'arg-mismatch';
          bridgeLog('warn', 'Exact-args fidelity violation — response shape does not match exact-args contract', {
            agentId,
            provider: providerName,
            toolName: exactArgsCtx.toolName,
            violation,
            retry: argFidelityRetryCount,
            emittedToolNames: calls.map((c) => c?.function?.name).slice(0, 5),
            emittedArgs: single ? JSON.stringify(emittedArgs).slice(0, 300) : undefined,
            expectedArgs: JSON.stringify(exactArgsCtx.expectedArgs).slice(0, 300),
          });

          // No assistant message has been pushed yet — wrong/multi/no-tool calls
          // never enter the message history and never execute.

          if (argFidelityRetryCount > MAX_ARG_FIDELITY_RETRIES) {
            // PART 3 (Codex option a): bounded canonical trailing-whitespace repair.
            // The repair is the FINAL exact-args artifact fallback, attempted ONLY after
            // the temp=0 retry/nudge path is exhausted. It applies ONLY when the model
            // emitted exactly one call to the expected tool whose args differ from the
            // expected args SOLELY by a missing/truncated trailing whitespace/newline run
            // on one or more string leaves (a deterministic tokenization artifact). Any
            // other mismatch — wrong tool, multi/no tool, interior-whitespace change,
            // substantive content change, path/shape change — is NOT repaired and fails
            // closed with ARG_FIDELITY_EXHAUSTED.
            const repairable =
              violation === 'arg-mismatch' &&
              single !== null &&
              single.function.name === exactArgsCtx.toolName &&
              isTrailingWhitespaceArtifact(emittedArgs, exactArgsCtx.expectedArgs);

            if (repairable) {
              const repairedLeafKeys = Object.entries(exactArgsCtx.expectedArgs)
                .filter(([k, v]) =>
                  typeof v === 'string' &&
                  typeof emittedArgs[k] === 'string' &&
                  emittedArgs[k] !== v,
                )
                .map(([k]) => k);
              bridgeLog('warn', 'Exact-args trailing-whitespace repair — substituting canonical args', {
                agentId,
                provider: providerName,
                toolName: exactArgsCtx.toolName,
                repairedLeafKeys,
                emittedArgs: JSON.stringify(emittedArgs).slice(0, 300),
                expectedArgs: JSON.stringify(exactArgsCtx.expectedArgs).slice(0, 300),
              });
              appendBridgeJournalEvent({
                event: 'exact_args_trailing_whitespace_repair',
                resultFile,
                agentId,
                provider: providerName,
                model: request.model || agent.resolvedModel,
                meta: {
                  toolName: exactArgsCtx.toolName,
                  repairedLeafKeys,
                  retries: MAX_ARG_FIDELITY_RETRIES,
                },
              });
              // Substitute the canonical expected args for execution. We rewrite the
              // emitted call's arguments to the exact expected JSON so the normal
              // execution path below runs the repaired call and its success is gated
              // by isSuccessfulBridgeToolResult exactly like any other grounded call.
              single.function.arguments = JSON.stringify(exactArgsCtx.expectedArgs);
              exactArgsRepaired = true;
              // Contract satisfied via repair — gate goes inert for subsequent turns.
              exactArgsSatisfied = true;
              // fall through to execution with the repaired single call
            } else {
              const fidelityError = new Error(
                `Argument fidelity failure: provider '${providerName}' did not reproduce ` +
                `exactly one '${exactArgsCtx.toolName}' call with the exact arguments after ` +
                `${MAX_ARG_FIDELITY_RETRIES} retries (last violation: ${violation}). ` +
                `Expected: ${JSON.stringify(exactArgsCtx.expectedArgs)}`
              );
              fidelityError.code = 'ARG_FIDELITY_EXHAUSTED';
              throw fidelityError;
            }
          } else {
            // FIX 4: explicit, byte-level nudge. Models trim trailing whitespace and
            // re-showing escaped \n inside JSON is not landing, so spell out, by name,
            // that any string value ending in a newline MUST keep its FINAL NEWLINE BYTE
            // inside the emitted JSON string value. Tailor the lead line to the violation.
            const expectedJson = JSON.stringify(exactArgsCtx.expectedArgs);
            const trailingNewlineKeys = Object.entries(exactArgsCtx.expectedArgs)
              .filter(([, v]) => typeof v === 'string' && v.endsWith('\n'))
              .map(([k]) => k);
            const shapeLead =
              violation === 'wrong-tool'
                ? `You called the wrong tool. You MUST call ONLY "${exactArgsCtx.toolName}".`
                : violation === 'multi-tool-call'
                  ? `You emitted multiple tool calls. You MUST emit EXACTLY ONE call to "${exactArgsCtx.toolName}" and nothing else.`
                  : violation === 'no-tool-call'
                    ? `You produced no tool call. You MUST call "${exactArgsCtx.toolName}" now.`
                    : `Your tool arguments did not match the required values.`;
            const newlineClause = trailingNewlineKeys.length > 0
              ? ` IMPORTANT: the value(s) for ${trailingNewlineKeys.map((k) => `"${k}"`).join(', ')} END WITH A FINAL NEWLINE BYTE. ` +
                `You MUST emit that final newline INSIDE the JSON string value (i.e. the string must end with \\n). ` +
                `Do NOT trim, strip, or drop the trailing newline — keep the value byte-for-byte identical.`
              : '';
            const fidelityNudge =
              `[BRIDGE ENFORCEMENT — ARGUMENT FIDELITY RETRY ${argFidelityRetryCount}/${MAX_ARG_FIDELITY_RETRIES}] ` +
              `${shapeLead} ` +
              `The arguments MUST be EXACTLY ${expectedJson}, reproduced byte-for-byte ` +
              `including any trailing newline characters or whitespace in string values.` +
              `${newlineClause} ` +
              `Call ${exactArgsCtx.toolName} again with exactly these arguments and no other changes.`;
            request.messages.push({ role: 'user', content: fidelityNudge });
            request.messages = prepareForProvider(
              request.messages,
              dynamicLimits ?? getProviderLimits(providerName, agent.resolvedModel),
            );

            // FIX 4: lower temperature on fidelity retries so the model copies args
            // verbatim instead of paraphrasing. The OpenRouter provider forwards a
            // per-request `temperature` cleanly into the API body (openrouter-provider.ts
            // `complete()`), with no collateral behavior change. Only set it for the
            // openrouter request shape that supports it; leave other providers untouched.
            if (providerName === 'openrouter') {
              request.temperature = 0;
            }
            continue;
          }
        }
      }

      // EXACT-ARGS ONE-CALL-AND-DONE (Codex option a): once the expected exact-args
      // tool call has been satisfied/repaired AND successfully dispatched, the exact-args
      // contract ("exactly one call to the expected tool with the expected args") is
      // complete. If the model emits MORE tool calls on a subsequent turn, they are
      // redundant follow-ons that must NOT execute — for non-idempotent edit_file the
      // first call succeeds and the duplicates fail `old_string not found`, and the
      // diagnostic evaluates the LAST result, flipping ok:true -> ok:false. We DROP the
      // post-satisfaction calls from EXECUTION (and from accounting), never push them into
      // the message history, and break to drive the model to its final text summary built
      // from the already-successful result. This applies ONLY to exact-args tasks after
      // satisfaction; non-exact tasks (and the satisfying response itself) are unaffected.
      if (calls.length > 0 && exactArgsSatisfiedBeforeResponse) {
        bridgeLog('warn', 'Exact-args one-call-and-done — dropping redundant post-satisfaction tool calls', {
          agentId,
          provider: providerName,
          toolName: exactArgsCtx.toolName,
          droppedToolNames: calls.map((c) => c?.function?.name).slice(0, 5),
          droppedCount: calls.length,
          iteration: iterations,
        });
        appendBridgeJournalEvent({
          event: 'exact_args_redundant_call_dropped',
          resultFile,
          agentId,
          provider: providerName,
          model: request.model || agent.resolvedModel,
          meta: {
            toolName: exactArgsCtx.toolName,
            droppedCount: calls.length,
            iteration: iterations,
          },
        });
        // Do NOT execute the dropped calls, do NOT count them in attemptedTools /
        // executedTools, and do NOT append an assistant tool-call message (which would
        // require matching tool results). Stop the loop; the post-loop summary path
        // synthesizes the final answer from the already-successful tool result.
        break;
      }

      if (calls.length > 0) {
        for (const toolCall of calls) {
          bridgeLog('info', `Tool call: ${toolCall.function.name}`, {
            agentId,
            tool: toolCall.function.name,
            args: (toolCall.function.arguments || '').slice(0, 300),
            iteration: iterations,
            ...(exactArgsRepaired ? { exactArgsRepaired: true } : {}),
          });
        }

        request.messages.push({
          role: 'assistant',
          content: response.content || '',
          toolCalls: calls,
          ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
        });

        const toolResults = await Promise.all(
          calls.map((tc) => {
            const toolStart = Date.now();
            // FIX 3: a tool the model actually invoked counts as a grounding ATTEMPT
            // (the model did not answer from priors), regardless of whether the result
            // is a success or a structured denial/error. This is distinct from the
            // success-gated `executedTools` (MUST-FIX-1) and is what the UNGROUNDED floor
            // checks. We reach this map ONLY past the exact-args shape gate, so wrong-tool
            // / multi-tool responses never get here.
            attemptedTools.push(tc.function.name);
            appendBridgeJournalEvent({
              event: 'tool_exec_start',
              resultFile,
              agentId,
              provider: providerName,
              model: request.model || agent.resolvedModel,
              meta: { toolName: tc.function.name, iteration: iterations },
            });
            return executeBridgeTool(tc.function.name, tc.function.arguments, {
              agentId,
              resultFile,
              source: 'response-loop',
            })
              .then((result) => {
                // MUST-FIX-1: count toward grounding ONLY when the tool produced a
                // successful (non-denied, non-error) result. Denied/error calls must
                // not satisfy the UNGROUNDED_TOOL_TASK floor.
                const grounded = isSuccessfulBridgeToolResult(result);
                if (grounded) {
                  executedTools.push(tc.function.name);
                }
                appendBridgeJournalEvent({
                  event: 'tool_exec_end',
                  resultFile,
                  agentId,
                  provider: providerName,
                  model: request.model || agent.resolvedModel,
                  meta: {
                    toolName: tc.function.name,
                    iteration: iterations,
                    durationMs: Date.now() - toolStart,
                    success: grounded,
                  },
                });
                return { id: tc.id, name: tc.function.name, result };
              })
              .catch((err) => {
                appendBridgeJournalEvent({
                  event: 'tool_exec_end',
                  resultFile,
                  agentId,
                  provider: providerName,
                  model: request.model || agent.resolvedModel,
                  meta: {
                    toolName: tc.function.name,
                    iteration: iterations,
                    durationMs: Date.now() - toolStart,
                    success: false,
                    errorClass: classifyJournalError(err),
                  },
                });
                return {
                  id: tc.id,
                  name: tc.function.name,
                  result: { status: 'error', error: err.message || String(err) },
                };
              });
          })
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
        request.messages = prepareForProvider(request.messages, limits);

        // Stuck detection: fingerprint + error counter
        if (calls.length > 0) {
          const fingerprint = JSON.stringify(
            calls.map((tc) => ({ n: tc.function.name, a: tc.function.arguments }))
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

        // MUST-FIX-5: Do NOT break here on finishReason. We are inside the
        // `calls.length > 0` branch — the model just issued tool calls that
        // we executed and appended results for. Some upstreams (incl. minimax-m3 via
        // OpenRouter) return finish_reason:'stop' (or 'length'/null) WHILE also returning
        // tool_calls. Breaking on `finishReason !== 'tool_calls'` would discard the tool
        // results without letting the model produce a final answer grounded on them.
        // Always continue the loop when tool calls were processed; termination is bounded
        // by MAX_TOOL_ITERATIONS, the stuck-fingerprint guard, and the consecutive-error
        // guard above. We only stop via the `else` branch below (genuine final text answer
        // with no pending tool calls).
        // (intentionally fall through to the next loop iteration)
      } else {
        // Model returned no tool calls — a genuine final text answer. Stop the loop.
        //
        // PART 1: an exact-args NO-TOOL response never reaches here — the exact-args
        // fidelity gate above intercepts it (exactArgsCtx !== null) and either retries
        // (bounded) or fails closed with ARG_FIDELITY_EXHAUSTED. So this branch only
        // runs for NON-exact tasks, where grounding is enforced by the post-loop
        // UNGROUNDED_TOOL_TASK floor (which checks attemptedTools).
        //
        // FIX 3 (single-path regression): the previous in-loop grounding retry
        // (MAX_GROUNDING_RETRIES) re-nudged the model and continued here, turning a
        // single fail-closed turn into 3 provider requests and breaking the established
        // "fail closed at exactly one request" contract (single-path web-ungrounded +
        // strict-ungrounded tests). No test required that retry. Re-nudging here is both
        // unnecessary and contract-breaking.
        break;
      }
    }

    if (iterations >= MAX_TOOL_ITERATIONS) {
      hitMaxToolIterations = true;
      bridgeLog('warn', 'Worker hit MAX_TOOL_ITERATIONS limit', {
        agentId,
        provider: providerName,
        iterations,
        maxIterations: MAX_TOOL_ITERATIONS,
        hasContent: !!(response?.content),
        historyLength: request.messages.length,
      });

      try {
        const summaryRequest = {
          messages: [...request.messages, {
            role: 'user',
            content:
              '[BRIDGE ENFORCEMENT — MAX TOOL ITERATIONS REACHED] ' +
              'You have reached the bridge tool-call iteration limit. Do not call any more tools. ' +
              'Write the final task result from the evidence already gathered. ' +
              'If the assignment is incomplete, say so explicitly at the top and list the missing evidence. ' +
              'Do not continue with phrases like "now let me check"; produce the final report text now.',
          }],
          model: request.model,
        };
        if (providerName === 'openrouter') {
          summaryRequest.temperature = 0;
        }
        summaryRequest.messages = prepareForProvider(
          summaryRequest.messages,
          dynamicLimits ?? getProviderLimits(providerName, agent.resolvedModel),
        );
        const summaryResponse = await completeProviderRequest(summaryRequest, {
          reason: 'max-tool-iterations-summary',
          maxIterations: MAX_TOOL_ITERATIONS,
        });
        if (summaryResponse.content && summaryResponse.content.trim() !== '') {
          response = { ...response, ...summaryResponse, content: summaryResponse.content };
          summaryAfterMaxToolIterations = true;
        } else {
          throw new Error('summary request returned empty content');
        }
      } catch (summaryErr) {
        const exhausted = new Error(
          `Provider tool loop exhausted after ${MAX_TOOL_ITERATIONS} iterations and no final summary could be produced: ` +
          `${summaryErr?.message || String(summaryErr)}`
        );
        exhausted.code = 'MAX_TOOL_ITERATIONS_EXHAUSTED';
        throw exhausted;
      }
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
        summaryRequest.messages = prepareForProvider(summaryRequest.messages, dynamicLimits ?? getProviderLimits(providerName, agent.resolvedModel));
        const summaryResponse = await completeProviderRequest(summaryRequest, { reason: 'summary' });
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

    // RETRY-ON-UNGROUNDED removed (Codex blocker #2): the previous post-loop
    // grounding-retry path (bounded by MAX_GROUNDING_RETRIES, same model, no reroll,
    // re-nudge) was REMOVED entirely — it no longer exists. There is now no in-loop
    // re-nudge for ungrounded no-tool answers; the post-loop UNGROUNDED_TOOL_TASK floor
    // below is the sole fail-closed safety net when no tool was attempted. (Exact-args
    // fidelity has its own bounded retry path inside the loop, separate from this.)

    const toolUse = {
      iterations,
      maxIterations: MAX_TOOL_ITERATIONS,
      exhausted: hitMaxToolIterations,
      summaryAfterExhaustion: summaryAfterMaxToolIterations,
      // FIX 3 / PART 2: `tools` reports EVERY tool the model ATTEMPTED to invoke
      // (including denied/error results), so diagnostics that legitimately exercise a
      // denied tool (web_fetch/web_search/unknown/blocked) still surface `tools: [<tool>]`.
      // `successfulTools` reports ONLY tools that produced a successful grounded result
      // (success-gated via isSuccessfulBridgeToolResult), so consumers do NOT confuse
      // attempted calls with successful grounded execution.
      tools: [...attemptedTools],
      successfulTools: [...executedTools],
    };

    // UNGROUNDED_TOOL_TASK floor: fail closed ONLY when the model answered from priors
    // (emitted ZERO tool calls). A tool that ran but was denied/unsupported is still a
    // grounded attempt — the model did call a bridge tool — so it must NOT trip the floor.
    if (
      STRICT_API_PROVIDERS.has(providerName) &&
      attemptedTools.length === 0 &&
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
      ...bridgeDurableOwnerFields(process.env),
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
    const payload = safeBridgeJsonStringify(result, 2) + '\n';
    writeFileSync(tmpResult, payload);
    renameSync(tmpResult, resultFile);
    appendBridgeJournalEvent({
      event: 'result_written',
      resultFile,
      agentId,
      provider: providerName,
      model: result.model,
      meta: {
        success: result.success === true,
        resultBytes: Buffer.byteLength(payload, 'utf8'),
        iterations: result.toolUse?.iterations,
        historyLength: result.historyLength,
      },
    });
    notifyTaskCompletionFromResultFile(resultFile);
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
    agentId: logAgentId !== 'unknown' ? logAgentId : undefined,
    ...bridgeDurableOwnerFields(process.env),
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
      const payload = safeBridgeJsonStringify(errorResponse, 2) + '\n';
      writeFileSync(tmpResult, payload);
      renameSync(tmpResult, resultFile);
      appendBridgeJournalEvent({
        event: 'result_written',
        resultFile,
        agentId: logAgentId,
        meta: {
          success: false,
          resultBytes: Buffer.byteLength(payload, 'utf8'),
          errorClass: classifyJournalError(err),
          classification,
          status: 'failed',
        },
      });
      notifyTaskCompletionFromResultFile(resultFile);
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
