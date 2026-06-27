#!/usr/bin/env node
//
// Drain Notifications — UserPromptSubmit hook
//
// Guaranteed-delivery fallback for the Sentinel Protocol. Reads pending
// agent/hive completion lines written by agent-task-rewake.cjs to
// `.hive-flow/data/pending-notifications.jsonl` and injects them as
// additionalContext on the human's next prompt, so a completion is NEVER
// silently lost even where async-rewake (exit 2) is not honored.
//
// Each line is JSON: { taskId, ts, summary }. After draining, the file is
// truncated so each completion surfaces exactly once.
//
// Fail-open: any error produces no output (never blocks the prompt).

'use strict';

const fs = require('fs');
const path = require('path');
const { wakeSessionPaths } = require('./wake-paths.cjs');
const { defaultClientKind, targetAgentFromClientKind } = require('./client-kind.cjs');

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function emptyOutput() {
  return {};
}

function pendingFile(projectRoot) {
  return path.join(projectRoot, '.hive-flow', 'data', 'pending-notifications.jsonl');
}

function pendingFiles(projectRoot, sessionInput = null, env = process.env) {
  const files = [];
  const wake = wakeSessionPaths(sessionInput, env);
  if (wake) files.push(wake.pendingFile);
  files.push(pendingFile(projectRoot));
  return files;
}

function currentTargetAgent(sessionInput = null, env = process.env) {
  const explicit = sessionInput && typeof sessionInput === 'object' && !Array.isArray(sessionInput)
    ? (sessionInput.clientKind || sessionInput.client_kind)
    : null;
  return (
    targetAgentFromClientKind(explicit) ||
    targetAgentFromClientKind(env.HIVE_FLOW_CLIENT_KIND) ||
    targetAgentFromClientKind(env.CLAUDE_CODE_ENTRYPOINT) ||
    targetAgentFromClientKind(defaultClientKind(env)) ||
    'claude'
  );
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function targetAgentFromKind(kind) {
  return targetAgentFromClientKind(kind);
}

function targetAgentFromAgentId(agentId) {
  const raw = typeof agentId === 'string' ? agentId.trim().toLowerCase() : '';
  if (!raw) return null;
  const genericRoleTokens = new Set(['agent', 'worker', 'provider', 'task', 'hive', 'queen']);
  const tokens = raw.split(/[^a-z0-9]+/).filter(Boolean);
  for (const token of tokens) {
    if (genericRoleTokens.has(token)) continue;
    const target = targetAgentFromKind(token);
    if (target) return target;
  }
  if (raw.includes('codex')) return 'codex';
  if (raw.includes('claude')) return 'claude';
  return null;
}

function agentIdFromNotification(obj) {
  const explicit = obj?.agentId || obj?.agent_id;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const summary = typeof obj?.summary === 'string' ? obj.summary : '';
  const match = summary.match(/\bagent=("[^"]+"|'[^']+'|[^\s,.)]+)/i);
  if (!match) return null;
  return match[1].replace(/^['"]|['"]$/g, '').trim() || null;
}

function taskOwnerTargetAgent(projectRoot, obj) {
  const taskId = typeof obj?.taskId === 'string' ? obj.taskId : null;
  if (!taskId) return null;

  const task = readJsonFile(path.join(projectRoot, '.hive-flow', 'tasks', `${taskId}.json`));
  const fromTask = targetAgentFromKind(task?.ownerClientKind || task?.owner_client_kind || task?.clientKind || task?.client_kind);
  if (fromTask) return fromTask;

  const result = readJsonFile(path.join(projectRoot, '.hive-flow', 'tasks', `${taskId}.result.json`));
  const inner = result && typeof result === 'object' ? result.result : null;
  const fromResult = targetAgentFromKind(result?.ownerClientKind || result?.owner_client_kind || inner?.ownerClientKind || inner?.owner_client_kind);
  if (fromResult) return fromResult;

  const agentId = task?.agentId || task?.agent_id || result?.agentId || result?.agent_id || inner?.agentId || inner?.agent_id || agentIdFromNotification(obj);
  if (typeof agentId !== 'string' || !agentId.trim()) return null;
  const fromAgentId = targetAgentFromKind(agentId) || targetAgentFromAgentId(agentId);
  if (fromAgentId) return fromAgentId;
  const store = readJsonFile(path.join(projectRoot, '.hive-flow', 'agents', 'store.json'));
  const agent = store?.agents?.[agentId.trim()];
  return targetAgentFromKind(agent?.ownerClientKind || agent?.owner_client_kind);
}

function notificationTargetsAgent(obj, targetAgent, projectRoot = projectDir()) {
  if (!targetAgent) return true;
  const persisted = taskOwnerTargetAgent(projectRoot, obj);
  if (persisted) return persisted === targetAgent;
  const explicit = String(obj?.targetAgent || obj?.target_agent || '').trim().toLowerCase();
  if (explicit) return explicit === targetAgent;
  const kind = String(obj?.clientKind || obj?.client_kind || obj?.ownerClientKind || obj?.owner_client_kind || '').toLowerCase();
  const kindTarget = targetAgentFromKind(kind);
  if (kindTarget) return targetAgent === kindTarget;
  return true;
}

function isPermissionWakeNotification(obj) {
  const kind = String(obj?.kind || '').trim();
  return kind === 'permission-request'
    || kind === 'worker-permission-denial'
    || kind === 'provider-permission-denial'
    || kind === 'queen-permission-request';
}

function isQueenPermissionNotification(obj) {
  const kind = String(obj?.kind || '').trim();
  if (kind === 'queen-permission-request') return true;
  const role = String(obj?.role || obj?.agentRole || obj?.agent_role || obj?.requesterRole || obj?.requester_role || obj?.sourceRole || obj?.source_role || '').trim().toLowerCase();
  if (role === 'queen') return true;
  const agentType = String(obj?.agentType || obj?.agent_type || obj?.type || '').trim().toLowerCase();
  if (agentType === 'queen') return true;
  const agentId = String(obj?.agentId || obj?.agent_id || '').trim();
  const queenId = String(obj?.queenId || obj?.queen_id || '').trim();
  return !!agentId && !!queenId && agentId === queenId;
}

function hasHivePermissionScope(obj) {
  const hiveId = String(obj?.hiveId || obj?.hive_id || '').trim();
  return hiveId.length > 0;
}

function suppressPermissionWake(obj) {
  if (!isPermissionWakeNotification(obj)) return false;
  if (isQueenPermissionNotification(obj)) return false;
  const kind = String(obj?.kind || '').trim();
  if (kind === 'worker-permission-denial' && !hasHivePermissionScope(obj)) return false;
  return true;
}

function collectDrainFiles(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const files = [];

  try {
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith(`${base}.draining-`)) {
          files.push(path.join(dir, entry));
        }
      }
    }
  } catch {
    return files;
  }

  try {
    if (fs.existsSync(file)) {
      const draining = `${file}.draining-${process.pid}-${Date.now()}`;
      fs.renameSync(file, draining);
      files.push(draining);
    }
  } catch {
    // If another hook is draining concurrently, let that owner finish.
  }

  return files;
}

function parseSummariesFromLines(lines, targetAgent = null, projectRoot = projectDir()) {
  const summaries = new Map();
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (suppressPermissionWake(obj)) continue;
      if (!notificationTargetsAgent(obj, targetAgent, projectRoot)) continue;
      if (obj && obj.summary) {
        const key = obj.taskId || obj.hiveId || obj.summary;
        const kind = typeof obj.kind === 'string' ? obj.kind : '';
        const existing = summaries.get(key);
        const entry = { kind, summary: `- ${obj.summary}` };
        if (!existing || supersedesCheckDue(existing.kind, kind)) summaries.set(key, entry);
      }
    } catch {
      /* skip corrupt line */
    }
  }
  return [...summaries.values()].map((entry) => entry.summary);
}

function originalPendingFileForDrain(drainFile) {
  const marker = '.draining-';
  const index = String(drainFile).indexOf(marker);
  return index === -1 ? drainFile : drainFile.slice(0, index);
}

function supersedesCheckDue(existingKind, nextKind) {
  return (
    (existingKind === 'hive-check' && nextKind === 'hive') ||
    (existingKind === 'task-check' && nextKind === 'task')
  );
}

function drainNotifications(projectRoot = projectDir(), sessionInput = null) {
  const drainFiles = [];
  for (const file of pendingFiles(projectRoot, sessionInput, process.env)) {
    drainFiles.push(...collectDrainFiles(file));
  }
  if (drainFiles.length === 0) return emptyOutput();

  const lines = [];
  const targetAgent = currentTargetAgent(sessionInput, process.env);
  const survivorsByFile = new Map();
  for (const drainFile of drainFiles) {
    try {
      const raw = fs.readFileSync(drainFile, 'utf8');
      for (const line of raw.split('\n').map((l) => l.trim()).filter(Boolean)) {
        let obj = null;
        try {
          obj = JSON.parse(line);
        } catch {
          lines.push(line);
          continue;
        }
        if (suppressPermissionWake(obj)) continue;
        if (!notificationTargetsAgent(obj, targetAgent, projectRoot)) {
          const originalFile = originalPendingFileForDrain(drainFile);
          const existing = survivorsByFile.get(originalFile) || [];
          existing.push(line);
          survivorsByFile.set(originalFile, existing);
          continue;
        }
        lines.push(line);
      }
    } catch {
      // Leave unread files in place so a future prompt can retry.
      continue;
    }
  }

  const summaries = parseSummariesFromLines(lines, targetAgent, projectRoot);

  // Remove only after parsing; an interruption before this point leaves a
  // .draining-* file that the next run recovers.
  for (const drainFile of drainFiles) {
    try { fs.unlinkSync(drainFile); } catch { /* retry on a future run */ }
  }
  for (const [file, survivorLines] of survivorsByFile.entries()) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${survivorLines.join('\n')}\n`);
    } catch {
      // A failed restore should not block the active prompt hook.
    }
  }

  if (summaries.length === 0) {
    return emptyOutput();
  }

  const context = `Hive Flow — background agent task(s) completed since your last message:\n${summaries.join('\n')}`;
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  };
}

if (require.main === module) {
  try {
    process.stdout.write(JSON.stringify(drainNotifications()));
  } catch {
    try { process.stdout.write('{}'); } catch { /* noop */ }
  }
}

module.exports = {
  projectDir,
  emptyOutput,
  pendingFile,
  pendingFiles,
  currentTargetAgent,
  readJsonFile,
  targetAgentFromKind,
  targetAgentFromAgentId,
  agentIdFromNotification,
  taskOwnerTargetAgent,
  notificationTargetsAgent,
  collectDrainFiles,
  parseSummariesFromLines,
  originalPendingFileForDrain,
  supersedesCheckDue,
  drainNotifications,
};
