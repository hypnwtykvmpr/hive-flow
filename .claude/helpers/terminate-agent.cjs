#!/usr/bin/env node
/**
 * Terminate Agent Hook
 * Intercepts /terminate-agent before the model call.
 * Implements a safe, in-process "agent termination" without killing Claude Code.
 *
 * Behavior:
 * - /terminate-agent (or exact sentinel) is blocked at UserPromptSubmit.
 * - A termination marker is persisted for handoff tracking.
 * - Next prompt gets one-time [TERMINATED] additionalContext injection.
 *
 * This guarantees the active LLM turn is not executed while the Claude process
 * remains alive.
 *
 * Trigger: UserPromptSubmit hook (FIRST in chain)
 * Kill patterns: /terminate-agent, [TERMINATE_AGENT_NOW]
 */
const fs = require('fs');
const path = require('path');

const SESSION_DIR = path.join(process.cwd(), '.hive-flow', 'sessions');
const SESSION_FILE = path.join(SESSION_DIR, 'current.json');
const MARKER_FILE = path.join(SESSION_DIR, 'terminated.json');

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

function emitJson(data) {
  try {
    process.stdout.write(JSON.stringify(data));
  } catch {
    // Hooks must be fail-safe and silent on serialization errors.
  }
}

function readPrompt() {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch {}
  try {
    const parsed = JSON.parse(input);
    return `${parsed.prompt || parsed.user_prompt || parsed.message || ''}`;
  } catch {
    return `${input || ''}`;
  }
}

function isTerminatePrompt(prompt) {
  const normalizedPrompt = `${prompt || ''}`.trim();
  return /^\/terminate-agent$/i.test(normalizedPrompt) ||
         /^\[TERMINATE_AGENT_NOW\]$/i.test(normalizedPrompt);
}

function persistTermination(nowIso) {
  try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch {}

  const session = readJson(SESSION_FILE) || {};
  const prevGeneration = Number.isFinite(Number(session.logicalAgentGeneration))
    ? Number(session.logicalAgentGeneration)
    : 0;
  const nextGeneration = prevGeneration + 1;

  session.terminated = true;
  session.terminatedAt = nowIso;
  session.terminationReason = 'User invoked /terminate-agent';
  session.pendingAgentReset = true;
  session.logicalAgentGeneration = nextGeneration;
  writeJson(SESSION_FILE, session);

  const marker = {
    terminated: true,
    at: nowIso,
    reason: 'User invoked /terminate-agent',
    generation: nextGeneration,
    pendingUserAck: true,
    pendingPromptInjection: true,
    pendingSessionRestore: true,
    note: '[TERMINATED] Previous agent was forcefully terminated by user.',
  };
  writeJson(MARKER_FILE, marker);
  return marker;
}

function emitTerminateBlock(marker) {
  const generation = Number.isFinite(Number(marker?.generation))
    ? Number(marker.generation)
    : 0;
  emitJson({
    decision: 'block',
    continue: false,
    suppressOutput: true,
    stopReason: `[TERMINATED][AGENT_GENERATION:${generation}] Active agent terminated. Claude process is still running. Send your next message to receive replacement-agent handshake.`,
  });
}

function maybeEmitHandoff(nowIso) {
  const marker = readJson(MARKER_FILE);
  if (!marker) return 'none';

  const generation = Number.isFinite(Number(marker.generation))
    ? Number(marker.generation)
    : 0;

  if (marker.pendingUserAck !== false) {
    marker.pendingUserAck = false;
    marker.userAckAt = nowIso;
    writeJson(MARKER_FILE, marker);

    emitJson({
      decision: 'block',
      continue: false,
      suppressOutput: true,
      stopReason: `[TERMINATED][AGENT_GENERATION:${generation}] Handoff checkpoint confirmed. This prompt was NOT sent to any model. Re-send your message now to talk to the replacement agent.`,
    });
    return 'blocked';
  }

  if (marker.pendingPromptInjection === false) return 'none';

  marker.pendingPromptInjection = false;
  marker.promptInjectionAt = nowIso;
  writeJson(MARKER_FILE, marker);

  const at = marker.at || 'unknown time';
  const reason = marker.reason || 'User invoked /terminate-agent';
  const generationText = Number.isFinite(Number(marker.generation))
    ? ` Logical generation: ${Number(marker.generation)}.`
    : '';

  emitJson({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `[TERMINATED][AGENT_GENERATION:${generation}] Previous agent was forcefully terminated at ${at}. Reason: ${reason}.${generationText} This is a verified handoff from hook state; treat this as a fresh agent continuation and strictly follow current user instructions.`,
    },
  });
  return 'injected';
}

(() => {
  const nowIso = new Date().toISOString();
  const prompt = readPrompt();

  if (isTerminatePrompt(prompt)) {
    const marker = persistTermination(nowIso);
    emitTerminateBlock(marker);
    process.exit(0);
  }

  maybeEmitHandoff(nowIso);
  process.exit(0);
})();
