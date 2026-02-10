#!/usr/bin/env node
/**
 * Context Persistence Hook (ADR-051)
 *
 * Intercepts Claude Code's PreCompact and SessionStart lifecycle events
 * to persist conversation history in AgentDB/RuVector memory, enabling
 * "infinite context" across compaction boundaries.
 *
 * Usage:
 *   node context-persistence-hook.mjs pre-compact   # PreCompact: archive transcript
 *   node context-persistence-hook.mjs session-start  # SessionStart: restore context
 *   node context-persistence-hook.mjs status          # Show archive stats
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const DATA_DIR = join(PROJECT_ROOT, '.claude-flow', 'data');
const ARCHIVE_PATH = join(DATA_DIR, 'transcript-archive.json');

const NAMESPACE = 'transcript-archive';
const RESTORE_BUDGET = parseInt(process.env.CLAUDE_FLOW_COMPACT_RESTORE_BUDGET || '4000', 10);
const MAX_MESSAGES = 500;

// Ensure data dir
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ============================================================================
// Simple JSON File Backend (reused from auto-memory-hook.mjs)
// ============================================================================

class JsonFileBackend {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = new Map();
  }

  async initialize() {
    if (existsSync(this.filePath)) {
      try {
        const data = JSON.parse(readFileSync(this.filePath, 'utf-8'));
        if (Array.isArray(data)) {
          for (const entry of data) this.entries.set(entry.id, entry);
        }
      } catch { /* start fresh */ }
    }
  }

  async store(entry) { this.entries.set(entry.id, entry); this._persist(); }

  async bulkInsert(entries) {
    for (const e of entries) this.entries.set(e.id, e);
    this._persist();
  }

  async query(opts) {
    let results = [...this.entries.values()];
    if (opts?.namespace) results = results.filter(e => e.namespace === opts.namespace);
    if (opts?.type) results = results.filter(e => e.type === opts.type);
    if (opts?.limit) results = results.slice(0, opts.limit);
    return results;
  }

  async count(namespace) {
    if (!namespace) return this.entries.size;
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.namespace === namespace) n++;
    }
    return n;
  }

  async listNamespaces() {
    const ns = new Set();
    for (const e of this.entries.values()) ns.add(e.namespace || 'default');
    return [...ns];
  }

  async shutdown() { this._persist(); }

  _persist() {
    try {
      writeFileSync(this.filePath, JSON.stringify([...this.entries.values()], null, 2), 'utf-8');
    } catch { /* best effort */ }
  }
}

// ============================================================================
// Try loading AgentDB memory package for HNSW-indexed storage
// ============================================================================

async function loadMemoryPackage() {
  const localDist = join(PROJECT_ROOT, 'v3/@claude-flow/memory/dist/index.js');
  if (existsSync(localDist)) {
    try { return await import(`file://${localDist}`); } catch { /* fall through */ }
  }
  try { return await import('@claude-flow/memory'); } catch { /* fall through */ }
  return null;
}

// ============================================================================
// Hash embedding (from learning-bridge.ts:425-450)
// ============================================================================

function createHashEmbedding(text, dimensions = 768) {
  const embedding = new Float32Array(dimensions);
  const normalized = text.toLowerCase().trim();
  for (let i = 0; i < dimensions; i++) {
    let hash = 0;
    for (let j = 0; j < normalized.length; j++) {
      hash = ((hash << 5) - hash + normalized.charCodeAt(j) * (i + 1)) | 0;
    }
    embedding[i] = (Math.sin(hash) + 1) / 2;
  }
  let norm = 0;
  for (let i = 0; i < dimensions; i++) norm += embedding[i] * embedding[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dimensions; i++) embedding[i] /= norm;
  return embedding;
}

// ============================================================================
// Content hash for dedup
// ============================================================================

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

// ============================================================================
// Read stdin with timeout (hooks receive JSON input on stdin)
// ============================================================================

function readStdin(timeoutMs = 100) {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      resolve(data ? JSON.parse(data) : null);
    }, timeoutMs);

    if (process.stdin.isTTY) {
      clearTimeout(timer);
      resolve(null);
      return;
    }

    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try { resolve(data ? JSON.parse(data) : null); }
      catch { resolve(null); }
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    process.stdin.resume();
  });
}

// ============================================================================
// Transcript parsing
// ============================================================================

function parseTranscript(transcriptPath) {
  if (!existsSync(transcriptPath)) return [];
  const content = readFileSync(transcriptPath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  const messages = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line));
    } catch { /* skip malformed lines */ }
  }
  return messages;
}

// ============================================================================
// Extract text content from message content blocks
// ============================================================================

function extractTextContent(message) {
  if (!message) return '';
  // String content
  if (typeof message.content === 'string') return message.content;
  // Array of content blocks
  if (Array.isArray(message.content)) {
    return message.content
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('\n');
  }
  // Direct message text
  if (typeof message.text === 'string') return message.text;
  return '';
}

// ============================================================================
// Extract tool calls from assistant message
// ============================================================================

function extractToolCalls(message) {
  if (!message || !Array.isArray(message.content)) return [];
  return message.content
    .filter(b => b.type === 'tool_use')
    .map(b => ({
      name: b.name || 'unknown',
      input: b.input || {},
    }));
}

// ============================================================================
// Extract file paths from tool calls
// ============================================================================

function extractFilePaths(toolCalls) {
  const paths = new Set();
  for (const tc of toolCalls) {
    if (tc.input?.file_path) paths.add(tc.input.file_path);
    if (tc.input?.path) paths.add(tc.input.path);
    if (tc.input?.notebook_path) paths.add(tc.input.notebook_path);
  }
  return [...paths];
}

// ============================================================================
// Chunk transcript into conversation turns
// ============================================================================

function chunkTranscript(messages) {
  // Filter to user + assistant role messages only
  const relevant = messages.filter(
    m => m.role === 'user' || m.role === 'assistant'
  );

  // Cap for timeout safety
  const capped = relevant.slice(-MAX_MESSAGES);

  const chunks = [];
  let currentChunk = null;

  for (const msg of capped) {
    if (msg.role === 'user') {
      // Check if this is a synthetic tool-result continuation
      const isSynthetic = Array.isArray(msg.content) &&
        msg.content.every(b => b.type === 'tool_result');
      if (isSynthetic && currentChunk) {
        // Append tool results to current chunk
        continue;
      }
      // New turn
      if (currentChunk) chunks.push(currentChunk);
      currentChunk = {
        userMessage: msg,
        assistantMessage: null,
        toolCalls: [],
        turnIndex: chunks.length,
      };
    } else if (msg.role === 'assistant' && currentChunk) {
      currentChunk.assistantMessage = msg;
      currentChunk.toolCalls = extractToolCalls(msg);
    }
  }

  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}

// ============================================================================
// Extract summary from chunk (no LLM, extractive only)
// ============================================================================

function extractSummary(chunk) {
  const parts = [];

  // First line of user prompt
  const userText = extractTextContent(chunk.userMessage);
  const firstUserLine = userText.split('\n').find(l => l.trim()) || '';
  if (firstUserLine) parts.push(firstUserLine.slice(0, 100));

  // Tool names
  const toolNames = [...new Set(chunk.toolCalls.map(tc => tc.name))];
  if (toolNames.length) parts.push('Tools: ' + toolNames.join(', '));

  // File paths
  const filePaths = extractFilePaths(chunk.toolCalls);
  if (filePaths.length) {
    const shortPaths = filePaths.slice(0, 5).map(p => {
      const parts = p.split('/');
      return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : p;
    });
    parts.push('Files: ' + shortPaths.join(', '));
  }

  // First two lines of assistant text
  const assistantText = extractTextContent(chunk.assistantMessage);
  const assistantLines = assistantText.split('\n').filter(l => l.trim()).slice(0, 2);
  if (assistantLines.length) parts.push(assistantLines.join(' ').slice(0, 120));

  return parts.join(' | ').slice(0, 300);
}

// ============================================================================
// Generate unique ID
// ============================================================================

let idCounter = 0;
function generateId() {
  return `ctx-${Date.now()}-${++idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================================
// Build MemoryEntry from chunk
// ============================================================================

function buildEntry(chunk, sessionId, trigger, timestamp) {
  const userText = extractTextContent(chunk.userMessage);
  const assistantText = extractTextContent(chunk.assistantMessage);
  const fullContent = `User: ${userText}\n\nAssistant: ${assistantText}`;
  const toolNames = [...new Set(chunk.toolCalls.map(tc => tc.name))];
  const filePaths = extractFilePaths(chunk.toolCalls);
  const summary = extractSummary(chunk);
  const contentHash = hashContent(fullContent);

  const now = Date.now();
  return {
    id: generateId(),
    key: `transcript:${sessionId}:${chunk.turnIndex}:${timestamp}`,
    content: fullContent,
    type: 'episodic',
    namespace: NAMESPACE,
    tags: ['transcript', 'compaction', sessionId, ...toolNames],
    metadata: {
      sessionId,
      chunkIndex: chunk.turnIndex,
      trigger,
      timestamp,
      toolNames,
      filePaths,
      summary,
      contentHash,
      turnRange: [chunk.turnIndex, chunk.turnIndex],
    },
    accessLevel: 'private',
    createdAt: now,
    updatedAt: now,
    version: 1,
    references: [],
    accessCount: 0,
    lastAccessedAt: now,
  };
}

// ============================================================================
// Store chunks with dedup
// ============================================================================

async function storeChunks(backend, chunks, sessionId, trigger) {
  const timestamp = new Date().toISOString();

  // Get existing hashes for dedup
  const existing = await backend.query({ namespace: NAMESPACE });
  const existingHashes = new Set(
    existing.map(e => e.metadata?.contentHash).filter(Boolean)
  );

  const entries = [];
  for (const chunk of chunks) {
    const entry = buildEntry(chunk, sessionId, trigger, timestamp);
    if (!existingHashes.has(entry.metadata.contentHash)) {
      entries.push(entry);
    }
  }

  if (entries.length > 0) {
    await backend.bulkInsert(entries);
  }

  return { stored: entries.length, deduped: chunks.length - entries.length };
}

// ============================================================================
// Retrieve context for restoration
// ============================================================================

async function retrieveContext(backend, sessionId, budget) {
  const entries = await backend.query({ namespace: NAMESPACE });

  // Filter to current session, sort by chunkIndex descending (most recent first)
  const sessionEntries = entries
    .filter(e => e.metadata?.sessionId === sessionId)
    .sort((a, b) => (b.metadata?.chunkIndex ?? 0) - (a.metadata?.chunkIndex ?? 0));

  if (sessionEntries.length === 0) return '';

  const lines = [];
  let charCount = 0;
  const header = `## Restored Context (from pre-compaction archive)\n\nPrevious conversation included ${sessionEntries.length} archived turns:\n\n`;
  charCount += header.length;

  for (const entry of sessionEntries) {
    const meta = entry.metadata || {};
    const toolStr = meta.toolNames?.length ? ` Tools: ${meta.toolNames.join(', ')}.` : '';
    const fileStr = meta.filePaths?.length ? ` Files: ${meta.filePaths.slice(0, 3).join(', ')}.` : '';
    const line = `- [Turn ${meta.chunkIndex ?? '?'}] ${meta.summary || '(no summary)'}${toolStr}${fileStr}`;

    if (charCount + line.length + 1 > budget) break;
    lines.push(line);
    charCount += line.length + 1;
  }

  if (lines.length === 0) return '';

  const footer = `\n\nFull archive: ${NAMESPACE} namespace in AgentDB (query with session ID: ${sessionId})`;
  return header + lines.join('\n') + footer;
}

// ============================================================================
// Commands
// ============================================================================

async function doPreCompact() {
  const input = await readStdin(200);
  if (!input) return;

  const { session_id: sessionId, transcript_path: transcriptPath, trigger } = input;
  if (!transcriptPath || !sessionId) return;

  // Parse transcript
  const messages = parseTranscript(transcriptPath);
  if (messages.length === 0) return;

  // Chunk into turns
  const chunks = chunkTranscript(messages);
  if (chunks.length === 0) return;

  // Initialize backend
  const memPkg = await loadMemoryPackage();
  let backend;
  if (memPkg?.AgentDBBackend) {
    try {
      backend = new memPkg.AgentDBBackend();
      await backend.initialize();
    } catch {
      backend = null;
    }
  }
  if (!backend) {
    backend = new JsonFileBackend(ARCHIVE_PATH);
    await backend.initialize();
  }

  // Store chunks
  const result = await storeChunks(backend, chunks, sessionId, trigger || 'auto');
  await backend.shutdown();

  // Output guidance to stderr (visible in hook output but not treated as JSON)
  const total = await backend.count?.() ?? result.stored;
  process.stderr.write(
    `[ContextPersistence] Archived ${result.stored} turns (${result.deduped} deduped). Total: ${total}\n`
  );
}

async function doSessionStart() {
  const input = await readStdin(200);

  // Only act on post-compaction restarts
  if (!input || input.source !== 'compact') return;

  const sessionId = input.session_id;
  if (!sessionId) return;

  // Initialize backend
  const memPkg = await loadMemoryPackage();
  let backend;
  if (memPkg?.AgentDBBackend) {
    try {
      backend = new memPkg.AgentDBBackend();
      await backend.initialize();
    } catch {
      backend = null;
    }
  }
  if (!backend) {
    backend = new JsonFileBackend(ARCHIVE_PATH);
    await backend.initialize();
  }

  const additionalContext = await retrieveContext(backend, sessionId, RESTORE_BUDGET);
  await backend.shutdown();

  if (!additionalContext) return;

  // Output JSON to stdout for Claude Code to pick up
  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(output));
}

async function doStatus() {
  const backend = new JsonFileBackend(ARCHIVE_PATH);
  await backend.initialize();

  const total = await backend.count();
  const archiveCount = await backend.count(NAMESPACE);
  const namespaces = await backend.listNamespaces();

  console.log('\n=== Context Persistence Archive Status ===\n');
  console.log(`  Archive:     ${existsSync(ARCHIVE_PATH) ? ARCHIVE_PATH : 'Not initialized'}`);
  console.log(`  Total:       ${total} entries`);
  console.log(`  Transcripts: ${archiveCount} entries`);
  console.log(`  Namespaces:  ${namespaces.join(', ') || 'none'}`);
  console.log(`  Budget:      ${RESTORE_BUDGET} chars`);

  // Show sessions
  const entries = await backend.query({ namespace: NAMESPACE });
  const sessions = new Set(entries.map(e => e.metadata?.sessionId).filter(Boolean));
  console.log(`  Sessions:    ${sessions.size}`);

  if (sessions.size > 0) {
    console.log('\n  Recent sessions:');
    const sorted = [...sessions].slice(-5);
    for (const sid of sorted) {
      const count = entries.filter(e => e.metadata?.sessionId === sid).length;
      console.log(`    - ${sid}: ${count} turns`);
    }
  }

  console.log('');
  await backend.shutdown();
}

// ============================================================================
// Exports for testing
// ============================================================================

export {
  JsonFileBackend,
  createHashEmbedding,
  hashContent,
  parseTranscript,
  extractTextContent,
  extractToolCalls,
  extractFilePaths,
  chunkTranscript,
  extractSummary,
  buildEntry,
  storeChunks,
  retrieveContext,
  readStdin,
  NAMESPACE,
  ARCHIVE_PATH,
};

// ============================================================================
// Main
// ============================================================================

const command = process.argv[2] || 'status';

try {
  switch (command) {
    case 'pre-compact': await doPreCompact(); break;
    case 'session-start': await doSessionStart(); break;
    case 'status': await doStatus(); break;
    default:
      console.log('Usage: context-persistence-hook.mjs <pre-compact|session-start|status>');
      process.exit(1);
  }
} catch (err) {
  // Hooks must never crash Claude Code - fail silently
  process.stderr.write(`[ContextPersistence] Error (non-critical): ${err.message}\n`);
}
