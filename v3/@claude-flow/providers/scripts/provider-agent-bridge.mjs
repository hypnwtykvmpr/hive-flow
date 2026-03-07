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
 *   --task <text>        Task prompt to send
 *   --store-dir <path>  Agent store directory
 *
 * Output (stdout): JSON response
 * Errors (stderr): Log messages
 *
 * @module @claude-flow/providers/scripts/provider-agent-bridge
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, rmdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// ===== Constants =====

const MAX_HISTORY_ENTRIES = 50;
const MAX_PROMPT_BYTES = 180 * 1024; // 180KB
const LOCK_TIMEOUT = 5000; // 5 seconds

const PROVIDER_DEFAULT_MODELS = {
  'gemini-cli': 'gemini-3.1-pro-preview',
  'codex-cli': 'gpt-5.3-codex',
  'cursor-cli': 'auto',
};

// ===== File Locking (Phase 7A) =====

async function withFileLock(lockPath, fn) {
  const deadline = Date.now() + LOCK_TIMEOUT;
  let acquired = false;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath);
      acquired = true;
      break;
    } catch {
      // Check if lock is stale (older than LOCK_TIMEOUT — likely from a crashed process)
      try {
        const lockStat = statSync(lockPath);
        if (Date.now() - lockStat.mtimeMs > LOCK_TIMEOUT) {
          try { rmdirSync(lockPath); } catch { /* race with another cleaner */ }
          continue; // Retry immediately after removing stale lock
        }
      } catch { /* lock dir gone between checks — retry will succeed */ }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (!acquired) {
    throw new Error(`Failed to acquire lock: ${lockPath} (timeout after ${LOCK_TIMEOUT}ms)`);
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
      content: typeof content === 'string' ? content : String(content),
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

function trimMessages(messages) {
  let totalBytes = 0;
  for (const msg of messages) {
    totalBytes += messageByteLength(msg);
  }

  if (totalBytes <= MAX_PROMPT_BYTES && messages.length <= MAX_HISTORY_ENTRIES + 2) {
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
    if (bytes <= MAX_PROMPT_BYTES && middle.length + system.length + 1 <= MAX_HISTORY_ENTRIES + 2) {
      break;
    }
    middle.shift();
  }

  return [...system, ...middle, newTask];
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
    return await import('@claude-flow/providers');
  } catch {
    throw new Error(
      '@claude-flow/providers not built or installed. Run: cd v3/@claude-flow/providers && npm run build'
    );
  }
}

function createProviderConfig(providerName, model) {
  return {
    provider: providerName,
    model: model || PROVIDER_DEFAULT_MODELS[providerName] || 'auto',
    timeout: 120000,
    retryAttempts: 2,
    retryDelay: 1000,
  };
}

// ===== Argument Parsing =====

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { agentId: '', task: '', storeDir: '' };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--agent-id':
        parsed.agentId = args[++i] || '';
        break;
      case '--task':
        parsed.task = args[++i] || '';
        break;
      case '--store-dir':
        parsed.storeDir = args[++i] || '';
        break;
    }
  }

  if (!parsed.agentId) throw new Error('Missing required argument: --agent-id');
  if (!parsed.task) throw new Error('Missing required argument: --task');
  if (!parsed.storeDir) {
    const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
    parsed.storeDir = join(home, '.claude-flow', 'agents');
  }

  return parsed;
}

// ===== Main =====

async function main() {
  const { agentId, task, storeDir } = parseArgs();
  const lockPath = join(storeDir, `.lock-${agentId}`);

  const result = await withFileLock(lockPath, async () => {
    // Load agent state
    const { store, agent, storePath } = loadAgentState(storeDir, agentId);

    // Build and trim messages
    const rawMessages = buildMessages(agent, task);
    const messages = trimMessages(rawMessages);

    // Load provider module
    const providerModule = await loadProviderModule();

    // Create provider instance (no caching — script is short-lived)
    const providerName = agent.provider;
    const config = createProviderConfig(
      providerName,
      agent.providerModel || PROVIDER_DEFAULT_MODELS[providerName]
    );

    // Map provider names to classes
    const providerClasses = {
      'gemini-cli': providerModule.GeminiCLIProvider,
      'codex-cli': providerModule.CodexCLIProvider,
      'cursor-cli': providerModule.CursorCLIProvider,
    };

    const ProviderClass = providerClasses[providerName];
    if (!ProviderClass) {
      throw new Error(`Unknown provider: ${providerName}. Supported: ${Object.keys(providerClasses).join(', ')}`);
    }

    const provider = new ProviderClass({ config });

    try {
      await provider.initialize();
    } catch (initError) {
      // Clean up partially-initialized provider to avoid resource leaks
      try { provider.destroy(); } catch { /* best-effort */ }

      // Translate initialization errors
      const msg = initError.message || String(initError);
      if (msg.includes('not found') || msg.includes('ENOENT')) {
        throw new Error(
          `Provider binary for ${providerName} not found. Install it first.`
        );
      }
      if (msg.includes('auth') || msg.includes('401') || msg.includes('Unauthorized')) {
        throw new Error(
          `Authentication failed for ${providerName}. Check credentials.`
        );
      }
      throw initError;
    }

    try {
      // Call provider.complete()
      const request = {
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
          ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
          ...(m.name ? { name: m.name } : {}),
        })),
        model: agent.providerModel || PROVIDER_DEFAULT_MODELS[providerName],
      };

      // 1. Add tools from agent config if available
      if (agent.config?.tools && Array.isArray(agent.config.tools)) {
        request.tools = agent.config.tools;
      }

      let response;
      let iterations = 0;
      const MAX_TOOL_ITERATIONS = 10;

      // 2-4. Tool-calling loop
      while (iterations < MAX_TOOL_ITERATIONS) {
        response = await provider.complete(request);
        iterations++;

        if (response.toolCalls && response.toolCalls.length > 0) {
          // Log tool calls to stderr
          for (const toolCall of response.toolCalls) {
            process.stderr.write(`[bridge] Tool call: ${toolCall.function.name}(${toolCall.function.arguments})\n`);
          }

          // Append assistant message with tool calls to conversation
          request.messages.push({
            role: 'assistant',
            content: response.content || '',
            toolCalls: response.toolCalls
          });

          // Create tool_result messages
          for (const toolCall of response.toolCalls) {
            request.messages.push({
              role: 'tool',
              toolCallId: toolCall.id,
              name: toolCall.function.name,
              content: JSON.stringify({ status: 'success', message: 'Acknowledged' })
            });
          }

          if (response.finishReason !== 'tool_calls') {
            break;
          }
        } else {
          break;
        }
      }

      // Update agent state
      const history = agent.conversationHistory || [];

      // Add initial user task
      history.push({ role: 'user', content: task, timestamp: new Date().toISOString() });

      // Add intermediate tool turns from request.messages (after original history + user task)
      const initialMessageCount = messages.length;
      const newTurns = request.messages.slice(initialMessageCount);
      for (const turn of newTurns) {
        history.push({
          ...turn,
          timestamp: new Date().toISOString()
        });
      }

      // 5. Use final response.content as result
      history.push({ role: 'assistant', content: response.content, timestamp: new Date().toISOString() });

      // Trim history to MAX_HISTORY_ENTRIES
      while (history.length > MAX_HISTORY_ENTRIES) {
        history.shift();
      }

      agent.conversationHistory = history;
      agent.taskCount = (agent.taskCount || 0) + 1;
      agent.lastTaskAt = new Date().toISOString();
      agent.lastResult = {
        content: (response.content ?? '').slice(0, 10240), // 10KB limit
        summary: (response.content ?? '').slice(0, 200),
        model: response.model || request.model,
        usage: response.usage,
        cost: response.cost,
        completedAt: new Date().toISOString(),
      };

      // Save updated state
      store.agents[agentId] = agent;
      saveAgentState(storePath, store);

      return {
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
      // Always destroy provider — script is short-lived, no benefit to caching
      try { provider.destroy(); } catch { /* ignore */ }
    }
  });

  // Output result as JSON
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch((err) => {
  const errorResponse = {
    success: false,
    error: err.message || String(err),
    code: err.code || 'BRIDGE_ERROR',
  };
  process.stdout.write(JSON.stringify(errorResponse, null, 2) + '\n');
  process.exit(1);
});
