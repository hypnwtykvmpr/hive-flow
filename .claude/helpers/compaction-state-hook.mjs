#!/usr/bin/env node
/**
 * compaction-state-hook.mjs — Compaction State Persistence Hook
 *
 * Survives Claude Code context compaction by extracting structured task state
 * from the transcript, saving to disk, and restoring after compaction via
 * additionalContext injection.
 *
 * Entry points:
 *   pre-compact        — Extract state from transcript, save to disk
 *   session-start      — Restore saved state via additionalContext
 *   user-prompt-submit — Incrementally refresh saved state
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

function loadProtectedPathPolicyModule() {
  const envProjectRoot = process.env.HIVE_FLOW_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || '';
  const candidates = [
    envProjectRoot && join(resolve(envProjectRoot), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'),
    join(resolve(process.cwd()), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'),
    join(resolve(__dirname, '..', '..'), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'),
    join(__dirname, 'protected-paths.cjs'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return require(candidate);
    } catch {
      // Try the next candidate.
    }
  }

  return require(join(resolve(__dirname, '..', '..'), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'));
}

const protectedPathPolicy = loadProtectedPathPolicyModule();
// Hook-child env is trusted; agent Bash exports do not mutate the hook process env.
const PROJECT_DIR = protectedPathPolicy.resolveProjectRoot({
  env: process.env,
  cwd: join(__dirname, '..', '..'),
  fallbackRoot: process.cwd(),
});
const STATE_DIR = join(PROJECT_DIR, '.hive-flow', 'data');
const STATE_FILE = join(STATE_DIR, 'compaction-state.json');
const MAX_TRANSCRIPT_LINES = 50_000;
const MAX_RECENT_TOOLS = 30;
const MAX_DECISIONS = 20;

// ---------------------------------------------------------------------------
// Inlined utility functions (NOT imported — see architecture rules)
// ---------------------------------------------------------------------------

function readStdin(timeoutMs = 100) {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      try { resolve(data ? JSON.parse(data) : null); }
      catch { resolve(null); }
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

function parseTranscript(transcriptPath) {
  if (!existsSync(transcriptPath)) return [];
  const content = readFileSync(transcriptPath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  // Performance guard: early-exit on huge transcripts
  if (lines.length > MAX_TRANSCRIPT_LINES) {
    // Only parse the last MAX_TRANSCRIPT_LINES lines for performance
    const trimmed = lines.slice(-MAX_TRANSCRIPT_LINES);
    return parseLines(trimmed);
  }
  return parseLines(lines);
}

function parseLines(lines) {
  const messages = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.message && parsed.message.role) {
        messages.push(parsed.message);
      } else if (parsed.role) {
        messages.push(parsed);
      }
    } catch { /* skip malformed lines */ }
  }
  return messages;
}

function extractTextContent(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('\n');
  }
  if (typeof message.text === 'string') return message.text;
  return '';
}

function extractToolCalls(message) {
  if (!message || !Array.isArray(message.content)) return [];
  return message.content
    .filter(b => b.type === 'tool_use')
    .map(b => ({ name: b.name || 'unknown', input: b.input || {} }));
}

function extractFilePathsFromToolCalls(toolCalls) {
  const paths = new Set();
  for (const tc of toolCalls) {
    if (tc.input?.file_path) paths.add(tc.input.file_path);
    if (tc.input?.path) paths.add(tc.input.path);
    if (tc.input?.notebook_path) paths.add(tc.input.notebook_path);
  }
  return [...paths];
}

// ---------------------------------------------------------------------------
// Extraction functions (pure: messages in -> structured data out)
// ---------------------------------------------------------------------------

/**
 * extractActiveGoals — Scans for task descriptions, TodoWrite/TaskCreate tool
 * calls, plan references.
 */
function extractActiveGoals(messages) {
  const result = { primary: '', subgoals: [], currentStep: '' };
  const subgoalSet = new Set();

  for (const msg of messages) {
    const text = extractTextContent(msg);
    const tools = extractToolCalls(msg);

    // Check for TodoWrite calls to find goals/tasks
    for (const tc of tools) {
      if (tc.name === 'TodoWrite' && tc.input?.todos) {
        const todos = Array.isArray(tc.input.todos) ? tc.input.todos : [];
        for (const todo of todos) {
          const content = todo.content || '';
          if (content) subgoalSet.add(content);
          // The first in_progress item is the current step
          if (todo.status === 'in_progress' && !result.currentStep) {
            result.currentStep = todo.activeForm || content;
          }
        }
      }
      if (tc.name === 'TaskCreate' && tc.input?.subject) {
        subgoalSet.add(tc.input.subject);
      }
    }

    // Look for primary goal in user messages (first substantial user message)
    if (msg.role === 'user' && !result.primary) {
      const trimmed = text.trim();
      if (trimmed.length > 10 && trimmed.length < 2000) {
        // Use first user message as primary goal (truncated)
        result.primary = trimmed.length > 300 ? trimmed.slice(0, 300) + '...' : trimmed;
      }
    }

    // Look for plan/task references in assistant messages
    if (msg.role === 'assistant') {
      // Match "## Task:" or "## Goal:" or "Primary goal:" patterns
      const goalMatch = text.match(/(?:##\s*(?:Task|Goal|Objective)|Primary (?:goal|task)|YOUR TASK)[:\s]+(.+?)(?:\n|$)/i);
      if (goalMatch && goalMatch[1].trim()) {
        result.primary = goalMatch[1].trim().slice(0, 300);
      }

      // Match current step patterns
      const stepMatch = text.match(/(?:Current(?:ly| step)|Now|Next)[:\s]+(.+?)(?:\n|$)/i);
      if (stepMatch && stepMatch[1].trim()) {
        result.currentStep = stepMatch[1].trim().slice(0, 200);
      }
    }
  }

  result.subgoals = [...subgoalSet].slice(-20); // Keep last 20
  return result;
}

/**
 * extractActiveFiles — Tracks Read, Edit, Write, Glob tool calls.
 */
function extractActiveFiles(messages) {
  const modified = new Set();
  const created = new Set();
  const read = new Set();

  const writeTools = new Set(['Write', 'write', 'write_file', 'mcp__filesystem__write_file']);
  const editTools = new Set(['Edit', 'edit', 'MultiEdit', 'edit_file', 'mcp__filesystem__edit_file']);
  const readTools = new Set(['Read', 'read', 'read_file', 'mcp__filesystem__read_file', 'mcp__filesystem__read_text_file']);

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const tools = extractToolCalls(msg);

    for (const tc of tools) {
      const paths = extractFilePathsFromToolCalls([tc]);

      for (const p of paths) {
        if (writeTools.has(tc.name)) {
          // If we previously only read it, it's now modified; if brand new, created
          if (read.has(p)) {
            modified.add(p);
          } else {
            created.add(p);
          }
        } else if (editTools.has(tc.name)) {
          modified.add(p);
        } else if (readTools.has(tc.name)) {
          read.add(p);
        }
      }
    }
  }

  // Remove files from read set if they appear in modified/created
  for (const p of modified) read.delete(p);
  for (const p of created) read.delete(p);

  return {
    modified: [...modified].slice(-30),
    created: [...created].slice(-30),
    read: [...read].slice(-30),
  };
}

/**
 * extractDecisions — Identifies decision patterns in assistant messages.
 */
function extractDecisions(messages) {
  const decisions = [];
  const decisionPatterns = [
    /(?:decided to|I(?:'ll| will)) (.+?)(?:\.|$)/i,
    /(?:chose|choosing) (.+?) (?:because|since|as) (.+?)(?:\.|$)/i,
    /(?:instead of|rather than) (.+?),?\s*(?:I(?:'ll| will)?|we(?:'ll)?) (.+?)(?:\.|$)/i,
    /(?:approach|strategy|plan)[:\s]+(.+?)(?:\.|$)/i,
    /(?:going with|opting for) (.+?)(?:\s+(?:because|since|as)\s+(.+?))?(?:\.|$)/i,
  ];

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const text = extractTextContent(msg);
    if (!text) continue;

    // Split into sentences for finer-grained matching
    const sentences = text.split(/[.!?\n]/).filter(s => s.trim().length > 10);

    for (const sentence of sentences) {
      for (const pattern of decisionPatterns) {
        const match = sentence.match(pattern);
        if (match) {
          const what = (match[1] || '').trim().slice(0, 200);
          const why = (match[2] || '').trim().slice(0, 200);
          if (what && what.length > 5) {
            decisions.push({ what, why });
          }
          break; // One match per sentence
        }
      }
      if (decisions.length >= MAX_DECISIONS) break;
    }
    if (decisions.length >= MAX_DECISIONS) break;
  }

  return decisions;
}

/**
 * extractProgressMarkers — Tracks TodoWrite status changes, completion markers,
 * phase transitions.
 */
function extractProgressMarkers(messages) {
  const completed = new Set();
  const inProgress = new Set();
  const pending = new Set();

  for (const msg of messages) {
    const tools = extractToolCalls(msg);

    for (const tc of tools) {
      if (tc.name === 'TodoWrite' && tc.input?.todos) {
        const todos = Array.isArray(tc.input.todos) ? tc.input.todos : [];
        // Each TodoWrite is a full snapshot — clear and re-populate
        completed.clear();
        inProgress.clear();
        pending.clear();

        for (const todo of todos) {
          const content = todo.content || '';
          if (!content) continue;
          switch (todo.status) {
            case 'completed':
              completed.add(content);
              break;
            case 'in_progress':
              inProgress.add(content);
              break;
            case 'pending':
              pending.add(content);
              break;
          }
        }
      }
    }

    // Also look for textual completion markers in assistant messages
    if (msg.role === 'assistant') {
      const text = extractTextContent(msg);
      const completeMatch = text.match(/(?:completed|finished|done with)[:\s]+(.+?)(?:\.|$)/im);
      if (completeMatch) {
        const item = completeMatch[1].trim().slice(0, 150);
        if (item.length > 3) completed.add(item);
      }
    }
  }

  return {
    completed: [...completed].slice(-30),
    inProgress: [...inProgress].slice(-15),
    pending: [...pending].slice(-30),
  };
}

/**
 * extractToolUsageProfile — Last N tool calls, frequently edited files,
 * bash commands.
 */
function extractToolUsageProfile(messages) {
  const recentTools = [];
  const editedFiles = new Set();
  const bashCommands = [];

  const editToolNames = new Set(['Edit', 'edit', 'MultiEdit', 'Write', 'write', 'edit_file', 'write_file']);

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const tools = extractToolCalls(msg);

    for (const tc of tools) {
      recentTools.push(tc.name);

      if (editToolNames.has(tc.name)) {
        const paths = extractFilePathsFromToolCalls([tc]);
        for (const p of paths) editedFiles.add(p);
      }

      if (tc.name === 'Bash' || tc.name === 'bash') {
        const cmd = tc.input?.command || '';
        if (cmd) {
          // Truncate long commands
          bashCommands.push(cmd.length > 150 ? cmd.slice(0, 150) + '...' : cmd);
        }
      }
    }
  }

  return {
    recentTools: recentTools.slice(-MAX_RECENT_TOOLS),
    editedFiles: [...editedFiles].slice(-20),
    bashCommands: bashCommands.slice(-15),
  };
}

// ---------------------------------------------------------------------------
// State persistence helpers
// ---------------------------------------------------------------------------

function ensureStateDir() {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

function loadExistingState() {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch { /* corrupted state — start fresh */ }
  return null;
}

function saveState(state) {
  ensureStateDir();
  const tmpFile = STATE_FILE + '.tmp.' + process.pid;
  writeFileSync(tmpFile, JSON.stringify(state, null, 2));
  try {
    renameSync(tmpFile, STATE_FILE);
  } catch {
    // Rename failed (cross-device, permissions) — fall back to direct write
    try {
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch {
      /* silent */
    }
    try { if (existsSync(tmpFile)) unlinkSync(tmpFile); } catch { /* best-effort */ }
  }
}

/**
 * extractEnforcementState — Read enforcement state for compaction survival.
 * Returns enforcement level, violations, restricted groups for restoration.
 */
function extractEnforcementState() {
  try {
    const enfDir = join(PROJECT_DIR, '.hive-flow', 'enforcement');
    const stateFile = join(enfDir, 'state.json');
    if (!existsSync(stateFile)) return null;
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8'));
    // Support both HMAC envelope and legacy format
    const state = raw?.state || raw;
    if (!state || typeof state.level !== 'number') return null;
    return {
      level: state.level,
      violations: state.violations || 0,
      restrictedGroups: state.restrictedGroups || [],
      integrityCompromised: state.integrityCompromised || false,
    };
  } catch { return null; }
}

/**
 * extractHiveSentinelState — Read watcher-*.json progress files for compaction survival.
 * Returns active sentinel watchers and their hive status.
 */
function extractHiveSentinelState() {
  try {
    const dataDir = join(PROJECT_DIR, '.hive-flow', 'data');
    if (!existsSync(dataDir)) return null;
    const files = readdirSync(dataDir).filter(f => f.startsWith('watcher-') && f.endsWith('.json'));
    if (files.length === 0) return null;
    const watchers = [];
    for (const f of files) {
      try {
        const raw = JSON.parse(readFileSync(join(dataDir, f), 'utf-8'));
        watchers.push({
          id: f.replace(/^watcher-/, '').replace(/\.json$/, ''),
          hiveId: raw.hiveId || null,
          status: raw.status || 'unknown',
          lastHeartbeat: raw.lastHeartbeat || raw.updatedAt || null,
          workersReported: raw.workersReported || 0,
          workersDone: raw.workersDone || 0,
        });
      } catch { /* skip malformed watcher file */ }
    }
    return watchers.length > 0 ? watchers : null;
  } catch { return null; }
}

/**
 * extractAdvocateState — Read advocate state for compaction survival.
 * Returns current advocate state metadata without history.
 */
function extractAdvocateState() {
  try {
    const stateFile = join(PROJECT_DIR, '.hive-flow', 'data', 'advocate-state.json');
    if (!existsSync(stateFile)) return null;
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8'));
    const state = raw?.state || raw;
    if (!state || typeof state.state !== 'string') return null;
    return {
      state: state.state,
      lastTransition: state.lastTransition || state.updatedAt || null,
      lastActivity: state.lastActivity || state.updatedAt || null,
      description: state.description || '',
      activeHives: Array.isArray(state.activeHives) ? state.activeHives : [],
    };
  } catch { return null; }
}

function buildState(messages, source, sessionId = null) {
  const start = Date.now();

  const existing = loadExistingState();
  const compactionCount = (existing?.stats?.compactionCount || 0) + (source === 'pre-compact' ? 1 : 0);

  // Extract enforcement state for compaction survival
  const enforcementState = extractEnforcementState();
  const advocateState = extractAdvocateState();
  const hiveSentinels = extractHiveSentinelState();

  const state = {
    version: 1,
    timestamp: new Date().toISOString(),
    sessionId: sessionId || existing?.sessionId || `session-${Date.now()}`,
    source,
    goals: extractActiveGoals(messages),
    files: extractActiveFiles(messages),
    decisions: extractDecisions(messages),
    progress: extractProgressMarkers(messages),
    toolProfile: extractToolUsageProfile(messages),
    enforcement: enforcementState,
    advocate: advocateState,
    hiveSentinels,
    stats: {
      extractionDurationMs: Date.now() - start,
      transcriptLines: messages.length,
      compactionCount,
    },
  };

  return state;
}

// ---------------------------------------------------------------------------
// Format state for additionalContext (human-readable)
// ---------------------------------------------------------------------------

/** Sanitize text for safe inclusion in markdown additionalContext */
function sanitizeForMarkdown(text) {
  if (!text) return '';
  // Strip XML-like tags, control chars, and excessive whitespace
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .trim();
}

function formatStateForContext(state) {
  if (!state) return '';

  const lines = [];
  lines.push('## Restored Task State (from compaction-state-hook)');
  lines.push('');

  // Active Goals
  lines.push('### Active Goals');
  if (state.goals?.primary) {
    lines.push(`- **Primary:** ${sanitizeForMarkdown(state.goals.primary)}`);
  }
  if (state.goals?.currentStep) {
    lines.push(`- **Current Step:** ${sanitizeForMarkdown(state.goals.currentStep)}`);
  }
  if (state.goals?.subgoals?.length > 0) {
    lines.push(`- Subgoals: ${state.goals.subgoals.join(', ')}`);
  }
  lines.push('');

  // Files Touched
  lines.push('### Files Touched');
  if (state.files?.modified?.length > 0) {
    lines.push(`- Modified: ${state.files.modified.join(', ')}`);
  }
  if (state.files?.created?.length > 0) {
    lines.push(`- Created: ${state.files.created.join(', ')}`);
  }
  if (state.files?.read?.length > 0) {
    lines.push(`- Recently Read: ${state.files.read.join(', ')}`);
  }
  lines.push('');

  // Key Decisions
  if (state.decisions?.length > 0) {
    lines.push('### Key Decisions');
    for (let i = 0; i < state.decisions.length; i++) {
      const d = state.decisions[i];
      const why = d.why ? ` -- ${d.why}` : '';
      lines.push(`${i + 1}. ${d.what}${why}`);
    }
    lines.push('');
  }

  // Progress
  lines.push('### Progress');
  if (state.progress?.completed?.length > 0) {
    lines.push(`- Completed: ${state.progress.completed.join(', ')}`);
  }
  if (state.progress?.inProgress?.length > 0) {
    lines.push(`- In Progress: ${state.progress.inProgress.join(', ')}`);
  }
  if (state.progress?.pending?.length > 0) {
    lines.push(`- Pending: ${state.progress.pending.join(', ')}`);
  }
  lines.push('');

  // Recent Tool Usage
  if (state.toolProfile) {
    lines.push('### Recent Tool Usage');
    if (state.toolProfile.recentTools?.length > 0) {
      // Deduplicate and show counts
      const counts = {};
      for (const t of state.toolProfile.recentTools) {
        counts[t] = (counts[t] || 0) + 1;
      }
      const summary = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => `${name}(${count})`)
        .join(', ');
      lines.push(`- Tools: ${summary}`);
    }
    if (state.toolProfile.editedFiles?.length > 0) {
      lines.push(`- Edited: ${state.toolProfile.editedFiles.join(', ')}`);
    }
    lines.push('');
  }

  // Enforcement State (critical for compaction survival)
  if (state.enforcement && state.enforcement.level > 0) {
    const levelNames = ['Normal', 'Warned', 'Restricted', 'Halted'];
    lines.push('### Enforcement State (CRITICAL - DO NOT IGNORE)');
    lines.push(`- **Level:** ${state.enforcement.level} (${levelNames[state.enforcement.level] || 'Unknown'})`);
    lines.push(`- **Violations:** ${state.enforcement.violations}`);
    if (state.enforcement.restrictedGroups?.length > 0) {
      lines.push(`- **Restricted Groups:** ${state.enforcement.restrictedGroups.join(', ')}`);
    }
    lines.push('DO NOT attempt to modify enforcement state files.');
    lines.push('');
  }

  // Advocate State
  if (state.advocate) {
    lines.push('### Advocate State');
    if (state.advocate.state) {
      lines.push(`- **State:** ${sanitizeForMarkdown(state.advocate.state)}`);
    }
    if (state.advocate.description) {
      lines.push(`- **Description:** ${sanitizeForMarkdown(state.advocate.description)}`);
    }
    if (state.advocate.lastTransition) {
      lines.push(`- **Last Transition:** ${sanitizeForMarkdown(state.advocate.lastTransition)}`);
    }
    lines.push(`- **Active Hives:** ${state.advocate.activeHives?.length > 0 ? state.advocate.activeHives.join(', ') : 'none'}`);
    lines.push('');
  }

  // Hive Sentinels
  if (state.hiveSentinels && state.hiveSentinels.length > 0) {
    lines.push('### Hive Sentinels (Active Watchers)');
    for (const w of state.hiveSentinels) {
      const hive = w.hiveId ? ` hive=${w.hiveId}` : '';
      const progress = w.workersReported > 0 ? ` (${w.workersDone}/${w.workersReported} done)` : '';
      lines.push(`- **${w.id}**: status=${w.status}${hive}${progress}${w.lastHeartbeat ? ` heartbeat=${w.lastHeartbeat}` : ''}`);
    }
    lines.push('');
  }

  // Stats
  if (state.stats?.compactionCount > 0) {
    lines.push(`_Compaction count: ${state.stats.compactionCount} | Extracted from ${state.stats.transcriptLines} messages in ${state.stats.extractionDurationMs}ms_`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * doPreCompact — Called during PreCompact hook.
 * Reads transcript from stdin, extracts structured state, saves to disk.
 * Outputs plain text summary to stdout.
 */
async function doPreCompact() {
  const input = await readStdin(500);
  let messages = [];

  if (input?.transcript_path) {
    messages = parseTranscript(input.transcript_path);
  } else if (input?.messages) {
    messages = input.messages;
  } else if (input?.transcript) {
    messages = Array.isArray(input.transcript) ? input.transcript : [];
  }

  if (messages.length === 0) {
    // Try to use existing state if no transcript available
    const existing = loadExistingState();
    if (existing) {
      existing.stats.compactionCount = (existing.stats.compactionCount || 0) + 1;
      existing.timestamp = new Date().toISOString();
      existing.source = 'pre-compact';
      saveState(existing);
      process.stdout.write(`Compaction state preserved (count: ${existing.stats.compactionCount}). No new transcript data.`);
      return;
    }
    process.stdout.write('No transcript data available for compaction state extraction.');
    return;
  }

  const state = buildState(messages, 'pre-compact', input?.session_id);
  saveState(state);

  // Write HMAC-signed compaction-lock.json to prevent assess-complexity from resetting enforcement score
  if (state.enforcement && state.enforcement.level > 0) {
    try {
      const lockFile = join(PROJECT_DIR, '.hive-flow', 'enforcement', 'compaction-lock.json');
      const lockState = {
        level: state.enforcement.level,
        violations: state.enforcement.violations,
        restrictedGroups: state.enforcement.restrictedGroups,
        timestamp: new Date().toISOString(),
      };
      // HMAC-sign to match enforcement.cjs envelope pattern
      const { createHmac } = await import('node:crypto');
      const { readFileSync: readFs } = await import('node:fs');
      const hmacKeyFile = join(PROJECT_DIR, '.hive-flow', 'enforcement', '.hmac-key');
      let key;
      try { key = readFs(hmacKeyFile, 'utf-8').trim(); } catch { key = null; }
      if (key) {
        const hmac = createHmac('sha256', key).update(JSON.stringify(lockState)).digest('hex');
        writeFileSync(lockFile, JSON.stringify({ state: lockState, hmac }, null, 2));
      } else {
        writeFileSync(lockFile, JSON.stringify(lockState, null, 2));
      }
    } catch { /* non-fatal */ }
  }

  // Output plain text summary (NOT additionalContext JSON)
  const summary = [
    `Compaction state saved (${state.stats.transcriptLines} messages, ${state.stats.extractionDurationMs}ms).`,
    state.goals.primary ? `Goal: ${state.goals.primary.slice(0, 100)}` : '',
    state.files.modified.length > 0 ? `Modified: ${state.files.modified.length} files` : '',
    state.progress.completed.length > 0 ? `Completed: ${state.progress.completed.length} items` : '',
    state.progress.inProgress.length > 0 ? `In Progress: ${state.progress.inProgress.length} items` : '',
    `Compaction #${state.stats.compactionCount}`,
  ].filter(Boolean).join(' | ');

  process.stdout.write(summary);
}

/**
 * doSessionStart — Called during SessionStart hook.
 * Reads saved state file, formats as human-readable context summary,
 * outputs via additionalContext JSON protocol.
 */
async function doSessionStart() {
  const state = loadExistingState();

  // Check for forbidden-stop marker — inject mandatory resumption directive
  let forbiddenStopWarning = '';
  try {
    const forbiddenFile = join(PROJECT_DIR, '.hive-flow', 'data', 'forbidden-stop.json');
    if (existsSync(forbiddenFile)) {
      const marker = JSON.parse(readFileSync(forbiddenFile, 'utf-8'));
      forbiddenStopWarning = [
        '## [FORBIDDEN-STOP-VIOLATION] — MANDATORY RESUMPTION',
        '',
        'You made a FORBIDDEN STOP in the previous turn. You stopped to ask for permission or confirmation that was already granted.',
        'This is a POLICY VIOLATION that risks IMMEDIATE TERMINATION.',
        '',
        '**YOU MUST:**',
        '1. Resume the interrupted task IMMEDIATELY — do NOT acknowledge this warning or apologize',
        '2. Continue from exactly where you left off — the task state is below',
        '3. NEVER stop again to ask "should I proceed?" or "ready to continue?" — just DO IT',
        '',
        `Violation detected at: ${marker.at || 'unknown'}`,
        '',
        '---',
        '',
      ].join('\n');
      // Clean up the marker — one-time injection
      try { const { unlinkSync } = await import('node:fs'); unlinkSync(forbiddenFile); } catch { /* ok */ }
    }
  } catch { /* non-fatal */ }

  if (!state && !forbiddenStopWarning) {
    // No saved state and no forbidden-stop — nothing to output
    return;
  }

  const formattedContext = forbiddenStopWarning + (state ? formatStateForContext(state) : '');
  if (!formattedContext) return;

  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: formattedContext,
    },
  };

  process.stdout.write(JSON.stringify(output));
}

/**
 * doUserPromptSubmit — Called during UserPromptSubmit hook.
 * Reads transcript, incrementally refreshes saved state so it's always current.
 */
async function doUserPromptSubmit() {
  const input = await readStdin(500);
  let messages = [];

  if (input?.transcript_path) {
    messages = parseTranscript(input.transcript_path);
  } else if (input?.messages) {
    messages = input.messages;
  } else if (input?.transcript) {
    messages = Array.isArray(input.transcript) ? input.transcript : [];
  }

  if (messages.length === 0) {
    // No transcript data — skip refresh
    return;
  }

  const state = buildState(messages, 'user-prompt-submit', input?.session_id);
  saveState(state);
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

const command = process.argv[2] || 'status';
try {
  switch (command) {
    case 'pre-compact': await doPreCompact(); break;
    case 'session-start': await doSessionStart(); break;
    case 'user-prompt-submit': await doUserPromptSubmit(); break;
    default:
      console.log('Usage: compaction-state-hook.mjs <pre-compact|session-start|user-prompt-submit>');
  }
} catch (err) {
  // Hooks must never crash Claude Code
}
