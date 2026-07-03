#!/usr/bin/env node
//
// Agent Message Inbox Re-scan (P2b, Knot hive-flow-d790)
//
// Compaction/restart guarantee for the durable inter-agent message store
// (cli/src/mcp-tools/agent-message-store.ts): on SessionStart, surface every
// undrained (pending/delivered, un-acked) message addressed to THIS session --
// session-level inboxes and inboxes of agents this session owns. Wake notices
// (pending-notifications.jsonl) are truncate-on-drain and can be lost across a
// crash; the durable inbox records are the source of truth this re-scan reads.
//
// READ-ONLY + advisory: no delivered-marking, no quarantine, no signature
// verification -- state mutation and tamper handling belong to the real read
// paths (agent_message_inbox / agent_message_ack / bridge fold-in). Records are
// matched by CONTENT (to.ownerSessionId) rather than by recomputing recipient
// key hashes, so the scan cannot drift from the store's key derivation.
//
// Wiring: .claude/helpers/sentinel-recovery.cjs (SessionStart, Permission-Guard
// protected) calls mergeSessionStartOutput() via an optional require -- the
// protected hunk is applied by the landing operator. This module also runs
// standalone (stdin session JSON -> stdout hook JSON) for direct testing.
//
// Fail-open everywhere: any error yields the unmodified watcher result / {}.

'use strict';

const fs = require('fs');
const path = require('path');

const MESSAGE_RESCAN_MAX_LINES = 10;

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw || !raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Resolve the current session id. Prefers the shared helper (same priority
 *  order as the rest of the harness); falls back to plain input/env fields so
 *  the module still works where the helpers dir is unavailable. */
function resolveSessionIdSafe(sessionInput, env, projectRoot) {
  try {
    const helper = require(path.join(projectRoot, '.claude', 'helpers', 'session-id.cjs'));
    if (helper && typeof helper.resolveSessionId === 'function') {
      const resolved = helper.resolveSessionId(sessionInput || {}, env || {});
      if (resolved) return resolved;
    }
  } catch { /* fall through to plain fields */ }
  const input = sessionInput || {};
  const fromInput = input.session_id || input.sessionId;
  if (typeof fromInput === 'string' && fromInput.trim()) return fromInput.trim();
  const fromEnv = (env || {}).CLAUDE_SESSION_ID || (env || {}).HIVE_FLOW_SESSION_ID;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  return null;
}

/** List undrained (pending/delivered) messages addressed to sessionId. */
function scanUndrainedMessages(projectRoot, sessionId) {
  if (!sessionId) return [];
  const inboxRoot = path.join(projectRoot, '.hive-flow', 'messages', 'inbox');
  if (!fs.existsSync(inboxRoot)) return [];
  const found = [];
  let recipientDirs;
  try {
    recipientDirs = fs.readdirSync(inboxRoot);
  } catch {
    return [];
  }
  for (const dirName of recipientDirs) {
    const dirPath = path.join(inboxRoot, dirName);
    let entries;
    try {
      entries = fs.readdirSync(dirPath);
    } catch {
      continue; // not a directory or unreadable -- advisory scan skips
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const record = readJson(path.join(dirPath, entry));
      if (!record || typeof record.messageId !== 'string' || !record.to) continue;
      if (record.to.ownerSessionId !== sessionId) continue;
      const state = record.deliveryState;
      if (state !== 'pending' && state !== 'delivered') continue;
      found.push({
        messageId: record.messageId,
        fromAgentId: (record.from && record.from.agentId) || 'unknown',
        toAgentId: record.to.agentId || null,
        verb: record.verb || 'unknown',
        priority: record.priority || 'normal',
        deliveryState: state,
      });
    }
  }
  return found;
}

function buildMessageRescanContext(messages) {
  if (!messages || messages.length === 0) return null;
  const shown = messages.slice(0, MESSAGE_RESCAN_MAX_LINES);
  const lines = shown.map((m) => {
    // Same addressing discipline as the wake notice: an agent-addressed message
    // must be read AND acked with agentId, else the ack resolves the caller's
    // session-level inbox (Codex bounce 20260703T223229Z).
    const inboxArgs = m.toAgentId ? `{agentId:"${m.toAgentId}"}` : '{}';
    const ackArgs = m.toAgentId
      ? `{messageId:"${m.messageId}", agentId:"${m.toAgentId}"}`
      : `{messageId:"${m.messageId}"}`;
    return `  - ${m.messageId} from=${m.fromAgentId} verb=${m.verb} priority=${m.priority} state=${m.deliveryState}. Read: agent_message_inbox(${inboxArgs}); ack: agent_message_ack(${ackArgs}).`;
  });
  let context = `[AGENT MESSAGES] ${messages.length} undrained inter-agent message(s) for this session:\n${lines.join('\n')}`;
  if (messages.length > shown.length) {
    context += `\n  ...and ${messages.length - shown.length} more -- drain with agent_message_inbox.`;
  }
  return context;
}

/**
 * Merge the inbox re-scan into a SessionStart hook result. `priorResult` is the
 * caller's existing output (e.g. sentinel watcher recovery); when the scan finds
 * nothing (or fails) the prior result is returned UNCHANGED, so the protected
 * caller's behavior is a strict superset of today's.
 */
function mergeSessionStartOutput(priorResult, projectRoot, sessionInput = undefined, env = process.env) {
  const base = priorResult && typeof priorResult === 'object' ? priorResult : {};
  try {
    const input = sessionInput === undefined ? readStdinJson() : (sessionInput || {});
    const sessionId = resolveSessionIdSafe(input, env, projectRoot);
    if (!sessionId) return base;
    const messageContext = buildMessageRescanContext(scanUndrainedMessages(projectRoot, sessionId));
    if (!messageContext) return base;
    const priorContext = base
      && base.hookSpecificOutput
      && base.hookSpecificOutput.additionalContext;
    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: priorContext ? `${priorContext}\n\n${messageContext}` : messageContext,
      },
    };
  } catch {
    return base; // fail-open: advisory only
  }
}

module.exports = {
  scanUndrainedMessages,
  buildMessageRescanContext,
  mergeSessionStartOutput,
  resolveSessionIdSafe,
};

// Standalone mode (testing / manual): stdin session JSON -> stdout hook JSON.
if (require.main === module) {
  try {
    const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.env.HIVE_FLOW_PROJECT_ROOT || process.cwd();
    process.stdout.write(JSON.stringify(mergeSessionStartOutput({}, projectRoot)));
  } catch {
    process.stdout.write(JSON.stringify({}));
  }
}
