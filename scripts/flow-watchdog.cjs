#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// flow-watchdog — TRACKED CANONICAL SOURCE (hive-flow-8b69, Option B)
//
// This is the reviewed, tracked source of truth for the flow-watchdog. The live
// runtime copy at `.hive-flow/data/tmux-router/flow-watchdog.cjs` is GENERATED
// from this file by the idempotent install path (hive-flow-8b69 Slice 2) and is
// intentionally untracked runtime state — do not commit it or the watchdog's
// `.state.json`, logs, or pane captures.
//
// Path model: resolution is RUNTIME-LOCATION relative. The script is designed to
// run from `.hive-flow/data/tmux-router/`, where `__dirname` is the router dir and
// `ROOT` (three levels up) is the project root. It is not run in place from
// `scripts/`; the install path places the runtime copy at the router location.
//
// Slice 1 (this change): freeze the current live watchdog behavior into tracked
// source, privacy-clean, with no behavior change. Consolidating the divergent
// liveness classifier onto the tracked `progress-authority-classifier` source of
// truth and wiring it into `runOnce` (Slices 3–4), the install/generation path
// (Slice 2), and the terminal-state nag-suppression fixes (Slice 5) follow as
// separate reviewed slices.
// ─────────────────────────────────────────────────────────────────────────────

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROUTER_DIR = __dirname;
const ROOT = path.resolve(ROUTER_DIR, '..', '..', '..');
const DEFAULT_LINES = 180;
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_COOLDOWN_MS = 28 * 60_000;
const MIN_PERMISSION_SEND_COOLDOWN_MS = 60_000;
const MIN_NON_PERMISSION_SEND_COOLDOWN_MS = 10 * 60_000;
const DEFAULT_IDLE_STALL_MS = 8 * 60_000;
const DEFAULT_STOP_HOOK_STALL_MS = 5 * 60_000;
const DEFAULT_STOP_HOOK_FOLLOW_UP_MS = 60_000;
const DEFAULT_KNOTS_LEASE_MAINTENANCE_INTERVAL_MS = 5 * 60_000;
const DEFAULT_KNOTS_LEASE_RENEW_THRESHOLD_MS = 30 * 60_000;
const DEFAULT_KNOTS_LEASE_RENEW_TIMEOUT_SECONDS = 4 * 60 * 60;
const DEFAULTS = Object.freeze({
  intervalMs: DEFAULT_INTERVAL_MS,
  cooldownMs: DEFAULT_COOLDOWN_MS,
  minPermissionSendCooldownMs: MIN_PERMISSION_SEND_COOLDOWN_MS,
  minNonPermissionSendCooldownMs: MIN_NON_PERMISSION_SEND_COOLDOWN_MS,
  idleStallMs: DEFAULT_IDLE_STALL_MS,
  stopHookStallMs: DEFAULT_STOP_HOOK_STALL_MS,
  stopHookFollowUpMs: DEFAULT_STOP_HOOK_FOLLOW_UP_MS,
  knotsLeaseMaintenanceIntervalMs: DEFAULT_KNOTS_LEASE_MAINTENANCE_INTERVAL_MS,
  knotsLeaseRenewThresholdMs: DEFAULT_KNOTS_LEASE_RENEW_THRESHOLD_MS,
  knotsLeaseRenewTimeoutSeconds: DEFAULT_KNOTS_LEASE_RENEW_TIMEOUT_SECONDS,
});
const STATE_PATH = path.join(ROUTER_DIR, 'flow-watchdog.state.json');
const LOG_DIR = path.join(ROOT, '.hive-flow', 'logs', 'tmux');
const LOG_PATH = path.join(LOG_DIR, 'flow-watchdog.log');
const CONTROL = path.join(ROOT, '.audit', 'scripts', 'hf-tmux-control.sh');
const CLAUDE_AGENT_FILE = path.join(ROOT, '.hive-flow', 'data', 'claude-agent.txt');
const GLOBAL_QUIET_KEY = '__flow_watchdog_quiet__';
const ROUTER_HANDOFF_CONTENT_PREFIX = 'router-handoff-content';
const ROUTER_HANDOFF_DUPLICATE_PREFIX = 'router-handoff-duplicate';
const DEFAULT_QUOTA_HOTSWAP_THRESHOLD_MS = 8 * 60 * 60_000;
const DEFAULT_RESET_TIME_ZONE = process.env.HIVE_FLOW_WATCHDOG_TIME_ZONE
  || process.env.TZ
  || 'America/Chicago';

const QUESTION_PATTERNS = [
  /\bwhat should (?:i|we)\b/i,
  /\bwhat do you want (?:me|us) to do\b/i,
  /\bhow do you want (?:me|us) to proceed\b/i,
  /\bdo you want (?:me|us) to\b/i,
  /\bwould you like (?:me|us) to\b/i,
  /\bshould (?:i|we) (?:continue|proceed|stop|pause|ask|wait)\b/i,
  /\bcan (?:i|we) (?:continue|proceed|start|commit|ask)\b/i,
  /\bwhich (?:option|path|approach|one) (?:do you want|should)/i,
  /\bplease (?:choose|pick|select)\b/i,
  /\bholding for (?:your|the human'?s) call\b/i,
  /\bwaiting for (?:your|the human'?s) (?:call|decision|approval|input)\b/i,
  /\b(?:your|human) (?:call|decision) before (?:i|we) (?:continue|proceed)\b/i,
  /\bunless you tell me otherwise\b/i,
  /\bI(?:'m| am) standing by\b/i,
  /\bI need (?:your|the human'?s) (?:decision|input|confirmation)\b/i,
];

const COMPACT_RECOVERY_PATTERNS = [
  /\bcompaction recovery\b/i,
  /\brecovery gate\b/i,
  /\bcompaction-recovery\.cjs\b/i,
  /\bcannot (?:tell|figure out|determine).{0,80}(?:summary|ack|recover|next step)\b/i,
  /\bwhat should .{0,80}(?:say|summary|ack|get past)\b/i,
  /\bget past the recovery gate\b/i,
  /\btrapped\b/i,
];

const TRUE_HUMAN_GATE_PATTERNS = [
  /\bpush authorization\b/i,
  /\b(?:need|needs|require|requires|waiting for|ask(?:ing)? for)\b.{0,80}\bpush\b.{0,80}\b(?:authorization|approval)\b/i,
  /\b(?:push|git push)\b.{0,80}\b(?:requires|needs)\b.{0,80}\b(?:authorization|approval)\b/i,
  /\bhuman authorization\b/i,
  /\bpolicy override\b/i,
  /\b(?:need|needs|require|requires|waiting for|ask(?:ing)? for|provide|enter|supply|get|missing)\b.{0,80}\b(?:secret|credential|token|api key|password)\b/i,
  /\b(?:secret|credential|token|api key|password)\b.{0,80}\b(?:needed|required|missing|from (?:you|human|user)|human)\b/i,
  /\bdangerous destructive\b/i,
  /\bdestructive action\b/i,
  /\brequires\s+(?:human|user|operator|manual)\s+approval\b/i,
  /\bpermission request\b.{0,80}\b(?:requires|needs|waiting for|asks? for)\b.{0,80}\b(?:human|user|operator|manual)\b/i,
  /\b(?:human|user|operator|manual)\b.{0,80}\b(?:approval|authorization)\b.{0,80}\bpermission request\b/i,
];

const QUOTA_LIMIT_PATTERNS = [
  /\b(?:usage|message|quota|token)\s+limit\s+(?:reached|exceeded)\b/i,
  /\b(?:out of|exceeded)\s+(?:quota|credits|messages)\b/i,
  /\byou(?:'|’)ve hit your (?:daily|weekly|monthly)?\s*(?:usage|message|quota|token)?\s*limit\b/i,
  /\bquota\s+(?:will\s+)?(?:reset|regenerate|refresh)\b/i,
];

const RATE_LIMIT_PATTERNS = [
  /\brate[-\s]+limited\b/i,
  /\brate[-\s]+limit\s+(?:exceeded|reached|hit)\b/i,
  /\b(?:exceeded|reached|hit)\s+(?:the\s+)?rate[-\s]+limit\b/i,
  /\btoo many requests\b/i,
  /\bHTTP\s*429\b/i,
  /\b429\b.*\b(?:retry|rate)\b/i,
];

const API_ERROR_PATTERNS = [
  /\bAPI error\b/i,
  /\bupstream server\b/i,
  /\btemporarily unavailable\b/i,
  /\bHTTP\s*5\d\d\b/i,
  /\bstatus(?:\s+code)?\s*5\d\d\b/i,
  /\b5\d\d\b.*\b(?:server|upstream|unavailable|error)\b/i,
  /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket closed|socket hang up)\b/i,
];

const AUTH_REQUIRED_PATTERNS = [
  /\b(?:login|log in|sign in|reauthenticate|authentication required|auth required)\b/i,
  /\b(?:not authenticated|session expired|credentials expired)\b/i,
];

const ENFORCEMENT_HALTED_PATTERNS = [
  /\bENFORCEMENT\s+ON\s*\(\s*HALTED\s*\)/i,
  /\bENFORCEMENT\s+HALT(?:ED)?\b/i,
  /\bglobal(?:ly)?\s+HALTED\b/i,
  /\benforcement\s+has\s+escalated\s+to\s+HALTED\b/i,
];

const ACTIVE_PATTERNS = [
  /\bWorking \(/i,
  /\bAPI error\s*·\s*Retrying\b/i,
  /\brunning stop hooks.*10\/10/i,
  /\bthinking (?:more )?with/i,
  /^\s*[✢✳✽]\s.+/m,
  /\bBash\(/,
  /\bReading \d+ files?\b/i,
  /\bEdited\b/,
  /\bRunning\b/,
];

const DECLARED_INTENT_PATTERNS = [
  /\bI(?:'ll| will| am|’m|'m)\s+(?:now\s+)?(?:going to\s+)?(?:read|check|verify|run|inspect|continue|resume|implement|patch|fix|test|restart|turn off|scope|write|send|route)\b/i,
  /\bLet me\s+(?:read|check|verify|run|inspect|continue|resume|implement|patch|fix|test|restart|scope|write|send|route)\b/i,
  /\bNext[:,]?\s+I(?:'ll| will| am|’m|'m)\s+(?:read|check|verify|run|inspect|continue|resume|implement|patch|fix|test|scope|write|send|route)\b/i,
  /\bI(?:'m| am|’m)\s+turning off\b/i,
  /\bI(?:'m| am|’m)\s+running\b/i,
];

function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function linesOf(snapshot) {
  return stripAnsi(snapshot).split(/\r?\n/);
}

function nonEmptyTail(snapshot, count = 80) {
  return linesOf(snapshot).map((line) => line.trim()).filter(Boolean).slice(-count);
}

function isIdleAtPrompt(snapshot) {
  const tail = nonEmptyTail(snapshot, 16).join('\n');
  return /(^|\n)[\s│]*❯\s*(?:$|\n)/.test(tail)
    || /(^|\n)[\s│]*›\s*(?:$|\n)/.test(tail)
    || /(^|\n)[\s│]*›\s+.+(?:$|\n)/.test(tail)
    || /\bPress up to edit queued messages\b/i.test(tail)
    || /\btab to queue message\b/i.test(tail);
}

function normalizePromptInput(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isCodexPlaceholderInput(value) {
  const normalized = normalizePromptInput(value);
  return normalized === 'Explain this codebase'
    || normalized === 'Write tests for @filename'
    || normalized === 'Find and fix a bug in @filename'
    || normalized === 'Use /skills to list available skills';
}

function rawLinesOf(snapshot) {
  return String(snapshot || '').split(/\r?\n/);
}

function visibleLinesForCursor(snapshot, cursor) {
  const rawLines = rawLinesOf(snapshot);
  const height = Number(cursor?.paneHeight || cursor?.height || 0);
  return height > 0 ? rawLines.slice(-height) : rawLines;
}

function cursorPromptLine(snapshot, cursor) {
  if (!cursor || !Number.isFinite(Number(cursor.cursorY))) return null;
  const visible = visibleLinesForCursor(snapshot, cursor);
  const line = visible[Number(cursor.cursorY)];
  return typeof line === 'string' ? line : null;
}

function classificationSnapshotForCursor(snapshot, cursor) {
  if (!cursor || !Number.isFinite(Number(cursor.cursorY))) return snapshot;
  return visibleLinesForCursor(snapshot, cursor).join('\n');
}

function promptInputStyle(rawLine, promptChar) {
  const line = String(rawLine || '');
  const sgrPattern = /\x1b\[([0-9;?]*)m/g;
  let dim = false;
  let index = 0;
  let sawPrompt = false;
  let sawInput = false;
  let sawNonDimInput = false;

  function applySgr(params) {
    const values = String(params || '0')
      .split(';')
      .filter((part) => part && !part.includes('?'))
      .map((part) => Number(part));
    const codes = values.length ? values : [0];
    for (const code of codes) {
      if (code === 0) dim = false;
      else if (code === 2) dim = true;
      else if (code === 22) dim = false;
    }
  }

  function visitVisible(text) {
    for (const char of text) {
      if (!sawPrompt) {
        if (char === promptChar) sawPrompt = true;
        continue;
      }
      if (!char.trim()) continue;
      sawInput = true;
      if (!dim) sawNonDimInput = true;
    }
  }

  for (const match of line.matchAll(sgrPattern)) {
    visitVisible(line.slice(index, match.index));
    applySgr(match[1]);
    index = match.index + match[0].length;
  }
  visitVisible(line.slice(index));

  return {
    sawPrompt,
    sawInput,
    sawNonDimInput,
    dimOnlyInput: sawInput && !sawNonDimInput,
  };
}

function promptLineInput(rawLine, { agent = '' } = {}) {
  const promptChar = agent === 'codex' ? '›' : '❯';
  const cleanLine = stripAnsi(rawLine);
  const match = cleanLine.match(agent === 'codex' ? /^\s*›\s*(.*)$/u : /^\s*❯\s*(.*)$/u);
  if (!match) return null;
  const normalized = normalizePromptInput(match[1] || '');
  if (!normalized) return '';
  if (agent === 'codex' && isCodexPlaceholderInput(normalized)) return '';
  const style = promptInputStyle(rawLine, promptChar);
  if (agent === 'codex' && style.dimOnlyInput) return '';
  return normalized;
}

function promptLineInputFromCursor(rawLine, { agent = '', cursorX = 0 } = {}) {
  const promptChar = agent === 'codex' ? '›' : '❯';
  const cleanLine = stripAnsi(rawLine);
  const promptIndex = cleanLine.indexOf(promptChar);
  if (promptIndex < 0) return null;
  const prefixEnd = promptIndex + 1;
  const cursorColumn = Math.max(0, Number(cursorX || 0));
  if (cursorColumn <= prefixEnd) return '';
  const editablePrefix = cleanLine.slice(prefixEnd, cursorColumn);
  return normalizePromptInput(editablePrefix);
}

function tailPromptInput(snapshot, { agent = '' } = {}) {
  const tail = rawLinesOf(snapshot).slice(-16);
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const input = promptLineInput(tail[index], { agent });
    if (input === null) continue;
    const after = tail.slice(index + 1).map((line) => stripAnsi(line).trim()).filter(Boolean);
    const promptIsAtTail = after.length === 0
      || after.every((line) => /\b(?:Context \d+% left|tab to queue message|Press up to edit queued messages)\b/i.test(line));
    return promptIsAtTail ? input : '';
  }
  return '';
}

function hasPendingPromptInput(snapshot, { agent = '', cursor = null } = {}) {
  const tail = rawLinesOf(snapshot).slice(-16);

  const cursorLine = cursorPromptLine(snapshot, cursor);
  if (cursorLine !== null) {
    const cursorInput = promptLineInputFromCursor(cursorLine, {
      agent,
      cursorX: cursor.cursorX,
    });
    if (cursorInput === null) return false;
    if (!cursorInput) return false;
    if (agent === 'codex' && isCodexPlaceholderInput(cursorInput)) return false;
    return true;
  }

  const lastPrompt = tailPromptInput(snapshot, { agent });
  if (!lastPrompt) return false;
  if (agent === 'codex' && isCodexPlaceholderInput(lastPrompt)) return false;
  return true;
}

function isCurrentPromptReady(snapshot, { agent = '', cursor = null, pendingInput = false } = {}) {
  if (pendingInput || !cursor || !Number.isFinite(Number(cursor.cursorY))) return false;
  const visible = visibleLinesForCursor(snapshot, cursor);
  const cursorY = Number(cursor.cursorY);
  const indexes = [cursorY, cursorY - 1, cursorY - 2].filter((index) => index >= 0 && index < visible.length);
  for (const index of indexes) {
    const line = visible[index];
    let input = null;
    if (index === cursorY) {
      input = promptLineInputFromCursor(line, {
        agent,
        cursorX: cursor.cursorX,
      });
    }
    if (input === null) {
      input = promptLineInput(line, { agent });
    }
    if (input === null) continue;
    if (input) return false;
    const intervening = index < cursorY
      ? visible.slice(index + 1, cursorY + 1).map((candidate) => stripAnsi(candidate).trim()).filter(Boolean)
      : [];
    if (intervening.length > 0) continue;
    return true;
  }
  return false;
}

function isTerminalOperationalEvent(event) {
  return ['quota_limit', 'rate_limit', 'api_error', 'auth_required'].includes(event?.kind);
}

function isActiveWork(snapshot, { cursor = null } = {}) {
  const classificationSnapshot = classificationSnapshotForCursor(snapshot, cursor);
  const activeRegion = stripWatchdogGeneratedBlocks(recentAssistantText(classificationSnapshot));
  const tail = nonEmptyTail(activeRegion, 36).join('\n');
  return ACTIVE_PATTERNS.some((pattern) => pattern.test(tail));
}

function detectNativeAgentWait(snapshot) {
  return linesOf(snapshot).some((line) => {
    const text = line.trim();
    return /^[◯○●]\s+(?!main\b)[A-Za-z0-9_.-]+(?:\s|$)/u.test(text);
  });
}

function detectHiveFlowSwarmCount(snapshot) {
  for (const line of linesOf(snapshot)) {
    const match = line.match(/\bSwarm\s+[◉●○◯]\s*\[\s*(\d+)\s*\/\s*\d+\s*\]/u);
    if (match) return Number(match[1]);
  }
  return 0;
}

function detectAgentWait(snapshot) {
  const native = detectNativeAgentWait(snapshot);
  const hiveFlowCount = detectHiveFlowSwarmCount(snapshot);
  const hiveFlow = hiveFlowCount > 0;
  return {
    native,
    hiveFlow,
    hiveFlowCount,
    any: native || hiveFlow,
  };
}

function isClaudeStopHooksNine(snapshot) {
  return /\brunning stop hooks\b.*\b9\/10\b/i.test(nonEmptyTail(snapshot, 36).join('\n'));
}

function hasTrueHumanGateLanguage(text) {
  return TRUE_HUMAN_GATE_PATTERNS.some((pattern) => pattern.test(text));
}

function hasEnforcementHalted(text) {
  return ENFORCEMENT_HALTED_PATTERNS.some((pattern) => pattern.test(text));
}

function recentAssistantText(snapshot) {
  const lines = linesOf(snapshot);
  const markers = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*[⏺•]\s/.test(lines[index])) markers.push(index);
  }
  const start = markers.length ? markers[markers.length - 1] : Math.max(0, lines.length - 80);
  return lines.slice(start).join('\n');
}

function recentAssistantOutput(snapshot) {
  const lines = linesOf(snapshot);
  const markers = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*[⏺•]\s/.test(lines[index])) markers.push(index);
  }
  const start = markers.length ? markers[markers.length - 1] : Math.max(0, lines.length - 80);
  const segment = lines.slice(start);
  const promptIndex = segment.findIndex((line, index) => index > 0 && /^\s*[❯›]\s*/u.test(line));
  return (promptIndex >= 0 ? segment.slice(0, promptIndex) : segment).join('\n');
}

function hasPerformativeQuestion(text) {
  if (QUESTION_PATTERNS.some((pattern) => pattern.test(text))) return true;
  const candidateLines = linesOf(text).map((line) => line.trim()).filter(Boolean);
  return candidateLines.some((line) => {
    if (!line.endsWith('?')) return false;
    if (/^[›❯]/.test(line)) return false;
    if (/^(?:run|ran|bash|read|edited|wrote|git|node|pnpm)\b/i.test(line)) return false;
    return /\b(?:you|user|human|want|prefer|should|continue|proceed|choose|option|approval|permission)\b/i.test(line);
  });
}

function hasCompactRecoveryQuestion(text) {
  return COMPACT_RECOVERY_PATTERNS.some((pattern) => pattern.test(text))
    && (hasPerformativeQuestion(text) || /\b(?:cannot|unsure|trapped|blocked|stuck)\b/i.test(text));
}

function hasDeclaredIntentToContinue(text) {
  if (hasTrueHumanGateLanguage(text)) return false;
  return DECLARED_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

function firstMatch(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

function isWatchdogGeneratedOperationalText(text) {
  const value = String(text || '');
  return /Unattended automation correction:/i.test(value);
}

function stripWatchdogGeneratedBlocks(text) {
  let skipping = false;
  const kept = [];
  for (const line of linesOf(text)) {
    const trimmed = line.trim();
    if (/Unattended automation correction:/i.test(trimmed)) {
      skipping = true;
      continue;
    }
    if (skipping && /^[❯›]\s*/u.test(trimmed)) {
      skipping = false;
      kept.push(line);
      continue;
    }
    if (skipping) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

function isOperationalTranscriptLine(line) {
  const text = String(line || '').trim();
  if (!text) return false;
  if (/^(?:Search|Read|Ran|Bash|Edited|Write|Wrote|Open|List|Grep|Glob|Find)\b/i.test(text)) return false;
  if (/^[└│]\s*(?:Search|Read|Ran|Bash|Edited|Write|Wrote|Open|List|Grep|Glob|Find)\b/i.test(text)) return false;
  if (/^⎿\s+(?:\.{0,2}\/|\/|[A-Za-z0-9_.-]+\/)/.test(text)) return false;
  if (/^\.\.\.|\bctrl\+o to expand\b/i.test(text)) return false;
  return true;
}

function operationalSignalText(text) {
  if (isWatchdogGeneratedOperationalText(text)) return '';
  return linesOf(text)
    .map((line) => line.trim())
    .filter(isOperationalTranscriptLine)
    .join('\n');
}

function firstMatchOperational(patterns, text) {
  return linesOf(text).some((line) => firstMatch(patterns, line));
}

function isApiRetryInProgress(text) {
  return linesOf(text).some((line) => /\bAPI error\s*·\s*Retrying\b.*\battempt\s+\d+\s*\/\s*\d+/i.test(line));
}

function extractResetHint(text) {
  const patterns = [
    /\b(?:reset|resets|regenerate|refresh|renews)\s+(?:tomorrow\s+)?(?:at|after|in|on)?\s*([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm|AM|PM)?|[0-9]+\s*(?:seconds?|minutes?|mins?|hours?|hrs?))/i,
    /\buntil\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm|AM|PM)?)/i,
    /\bavailable\s+(?:again\s+)?(?:at|after|in)\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm|AM|PM)?|[0-9]+\s*(?:seconds?|minutes?|mins?|hours?|hrs?))/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function extractResetTimeZone(text) {
  const raw = String(text || '');
  const iana = raw.match(/\b([A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\b/);
  if (iana) return iana[1];
  if (/\b(?:America\/Chicago|Central(?:\s+US)?|US\s+Central|CST|CDT|CT)\b/i.test(raw)) return 'America/Chicago';
  if (/\bUTC\b|\bGMT\b/i.test(raw)) return 'UTC';
  return '';
}

function normalizeResetTimeZone(value = '') {
  const candidate = String(value || '').trim() || DEFAULT_RESET_TIME_ZONE;
  const aliases = {
    CT: 'America/Chicago',
    CST: 'America/Chicago',
    CDT: 'America/Chicago',
    UTC: 'UTC',
    GMT: 'UTC',
  };
  const normalized = aliases[candidate.toUpperCase()] || candidate;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(new Date(0));
    return normalized;
  } catch {
    return DEFAULT_RESET_TIME_ZONE;
  }
}

function zonedParts(ms, timeZone = DEFAULT_RESET_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeResetTimeZone(timeZone),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function timeZoneOffsetMs(ms, timeZone = DEFAULT_RESET_TIME_ZONE) {
  const parts = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
  return asUtc - ms;
}

function zonedWallTimeToUtcMs({ year, month, day, hour, minute }, timeZone = DEFAULT_RESET_TIME_ZONE) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - timeZoneOffsetMs(guess, timeZone);
  }
  return guess;
}

function nextCalendarDate({ year, month, day }) {
  const next = new Date(Date.UTC(year, month - 1, day + 1, 12, 0, 0, 0));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function parseResetTargetMs(resetHint, observedAt = Date.now(), timeZone = DEFAULT_RESET_TIME_ZONE) {
  const hint = String(resetHint || '').trim();
  if (!hint) return null;

  const relative = hint.match(/^([0-9]+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    if (!Number.isFinite(amount)) return null;
    if (unit.startsWith('second') || unit.startsWith('sec')) return observedAt + amount * 1000;
    if (unit.startsWith('minute') || unit.startsWith('min')) return observedAt + amount * 60_000;
    if (unit.startsWith('hour') || unit.startsWith('hr')) return observedAt + amount * 60 * 60_000;
  }

  const clock = hint.match(/^([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm|AM|PM)?$/);
  if (!clock) return null;

  if (!Number.isFinite(Number(observedAt))) return null;
  const zone = normalizeResetTimeZone(timeZone);

  let hour = Number(clock[1]);
  const minute = clock[2] ? Number(clock[2]) : 0;
  const suffix = clock[3] ? clock[3].toLowerCase() : '';
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    if (suffix === 'am') hour = hour === 12 ? 0 : hour;
    if (suffix === 'pm') hour = hour === 12 ? 12 : hour + 12;
  } else if (hour > 23) {
    return null;
  }

  let targetDate = zonedParts(observedAt, zone);
  let targetMs = zonedWallTimeToUtcMs({
    year: targetDate.year,
    month: targetDate.month,
    day: targetDate.day,
    hour,
    minute,
  }, zone);
  if (targetMs <= observedAt) {
    targetDate = nextCalendarDate(targetDate);
    targetMs = zonedWallTimeToUtcMs({
      year: targetDate.year,
      month: targetDate.month,
      day: targetDate.day,
      hour,
      minute,
    }, zone);
  }
  return targetMs;
}

function parseResetDelayMs(resetHint, now = Date.now(), timeZone = DEFAULT_RESET_TIME_ZONE) {
  const targetMs = parseResetTargetMs(resetHint, now, timeZone);
  return Number.isFinite(targetMs) ? targetMs - now : null;
}

function extractRetryHint(text) {
  const patterns = [
    /\bretry\s+(?:after|in)\s+([0-9]+\s*(?:seconds?|minutes?|mins?|hours?|hrs?))/i,
    /\btry\s+again\s+(?:after|in)\s+([0-9]+\s*(?:seconds?|minutes?|mins?|hours?|hrs?))/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function classifyOperationalEvent(text, { agent = '', fullText = text } = {}) {
  const signalText = operationalSignalText(text);
  if (!signalText) return null;
  if (isApiRetryInProgress(signalText) && !isIdleAtPrompt(fullText)) return null;
  const excerpt = nonEmptyTail(signalText, 10).join('\n');
  if (agent === 'claude' && hasEnforcementHalted(fullText)) {
    return {
      agent,
      subjectAgent: agent,
      kind: 'enforcement_halted',
      reason: 'Claude enforcement statusboard is halted',
      fingerprint: stableIdleFingerprint(agent, excerpt, 'enforcement_halted'),
      suppressKey: stableIdleFingerprint(agent, excerpt, 'enforcement_halted'),
      excerpt,
    };
  }

  if (firstMatchOperational(AUTH_REQUIRED_PATTERNS, signalText)) {
    return {
      agent,
      subjectAgent: agent,
      kind: 'auth_required',
      reason: 'login or authentication is required',
      fingerprint: stableIdleFingerprint(agent, excerpt, 'auth_required'),
      suppressKey: stableIdleFingerprint(agent, excerpt, 'auth_required'),
      excerpt,
    };
  }

  if (firstMatchOperational(QUOTA_LIMIT_PATTERNS, signalText)) {
    const resetHint = extractResetHint(signalText);
    const resetTimeZone = extractResetTimeZone(signalText);
    return {
      agent,
      subjectAgent: agent,
      kind: 'quota_limit',
      reason: 'agent appears quota-limited',
      resetHint,
      resetTimeZone,
      fingerprint: stableIdleFingerprint(agent, `${resetHint}\n${excerpt}`, 'quota_limit'),
      suppressKey: stableIdleFingerprint(agent, `${resetHint}\n${excerpt}`, 'quota_limit'),
      excerpt,
    };
  }

  if (firstMatchOperational(RATE_LIMIT_PATTERNS, signalText)) {
    const retryHint = extractRetryHint(signalText);
    return {
      agent,
      subjectAgent: agent,
      kind: 'rate_limit',
      reason: 'agent appears rate-limited',
      retryHint,
      cooldownMs: 5 * 60_000,
      fingerprint: stableIdleFingerprint(agent, `${retryHint}\n${excerpt}`, 'rate_limit'),
      suppressKey: stableIdleFingerprint(agent, `${retryHint}\n${excerpt}`, 'rate_limit'),
      excerpt,
    };
  }

  if (firstMatchOperational(API_ERROR_PATTERNS, signalText)) {
    return {
      agent,
      subjectAgent: agent,
      kind: 'api_error',
      reason: 'agent stopped after an API or transport error',
      cooldownMs: 5 * 60_000,
      fingerprint: stableIdleFingerprint(agent, excerpt, 'api_error'),
      suppressKey: stableIdleFingerprint(agent, excerpt, 'api_error'),
      excerpt,
    };
  }

  return null;
}

function normalizeForFingerprint(snapshot) {
  return nonEmptyTail(snapshot, 48).join('\n').replace(/\s+/g, ' ');
}

function fingerprint(snapshot, kind) {
  return crypto.createHash('sha256').update(`${kind}\n${normalizeForFingerprint(snapshot)}`).digest('hex');
}

function normalizeStableIdleText(text) {
  const stable = linesOf(text)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^[-─│▊►🤖🪪⏵]/.test(line))
    .filter((line) => !/^[❯›]\s*/.test(line))
    .filter((line) => !/\bContext \d+% left\b/i.test(line))
    .filter((line) => !/\bCooked for\b/i.test(line))
    .filter((line) => !/\bWorking \(/i.test(line))
    .filter((line) => !/\bdata fresh\b/i.test(line))
    .filter((line) => !/\b(?:Opus|Sonnet|Haiku|gpt-|deepseek|FORGE)\b/i.test(line))
    .filter((line) => !/\bfeat\/[^\s]+/i.test(line))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  return stable || 'idle';
}

function stableIdleFingerprint(agent, text, kind = 'idle') {
  return crypto.createHash('sha256')
    .update(`${kind}\n${agent}\n${normalizeStableIdleText(text)}`)
    .digest('hex');
}

function classifyPane(snapshot, options = {}) {
  const { agent = '' } = options;
  const clean = stripAnsi(snapshot);
  const assistantText = recentAssistantText(clean);
  const assistantOutput = recentAssistantOutput(clean);
  const agentWait = detectAgentWait(clean);
  if (hasPendingPromptInput(snapshot, options)) return null;
  if (agentWait.any) return null;
  if (agent === 'claude' && isClaudeStopHooksNine(clean)) return null;

  const operationalEvent = classifyOperationalEvent(assistantOutput, { agent, fullText: clean });
  if (operationalEvent) return operationalEvent;

  if (!isIdleAtPrompt(clean)) return null;
  if (isActiveWork(snapshot, options)) return null;

  const compactRecovery = hasCompactRecoveryQuestion(assistantText);
  const questionLike = hasPerformativeQuestion(assistantText);
  const suspectedHumanGate = hasTrueHumanGateLanguage(assistantText);
  if (compactRecovery || questionLike) {
    return {
      agent,
      subjectAgent: agent,
      kind: compactRecovery ? 'compact_recovery_question' : 'question_adjudication',
      reason: compactRecovery
        ? 'pane is idle after a compact-recovery uncertainty prompt'
        : 'pane is idle after a human-facing question',
      fingerprint: fingerprint(clean, 'question_adjudication'),
      suppressKey: fingerprint(clean, 'question_adjudication'),
      compactRecovery,
      questionLike,
      suspectedHumanGate,
      excerpt: nonEmptyTail(assistantText, 10).join('\n'),
    };
  }

  if (suspectedHumanGate) {
    return {
      agent,
      subjectAgent: agent,
      kind: 'human_gate_adjudication',
      reason: 'pane is idle after suspected human-gate language',
      fingerprint: fingerprint(clean, 'human_gate_adjudication'),
      suppressKey: fingerprint(clean, 'human_gate_adjudication'),
      compactRecovery: false,
      questionLike: false,
      suspectedHumanGate: true,
      excerpt: nonEmptyTail(assistantText, 10).join('\n'),
    };
  }

  return null;
}

function classifyPaneStatus(snapshot, options = {}) {
  const { agent = '' } = options;
  const clean = stripAnsi(snapshot);
  const assistantText = recentAssistantText(clean);
  const assistantOutput = recentAssistantOutput(clean);
  const agentWait = detectAgentWait(clean);
  const pendingInput = hasPendingPromptInput(snapshot, options);
  const currentPromptReady = isCurrentPromptReady(snapshot, { ...options, pendingInput });
  const stopHooksStuck = agent === 'claude' && isClaudeStopHooksNine(clean) && !agentWait.any && !pendingInput;
  const operationalEvent = !pendingInput ? classifyOperationalEvent(assistantOutput, { agent, fullText: clean }) : null;
  const terminalOperational = isTerminalOperationalEvent(operationalEvent);
  const active = currentPromptReady
    ? false
    : terminalOperational ? agentWait.any : (isActiveWork(snapshot, options) || agentWait.any);
  const idle = terminalOperational
    ? !active && !stopHooksStuck && !pendingInput
    : isIdleAtPrompt(clean) && !active && !stopHooksStuck && !pendingInput;
  const trueHumanGate = !pendingInput && hasTrueHumanGateLanguage(assistantText);
  const compactRecovery = !pendingInput && hasCompactRecoveryQuestion(assistantText);
  const enforcementHalted = agent === 'claude' && hasEnforcementHalted(clean);
  return {
    agent,
    idle,
    active,
    pendingInput,
    agentWait,
    stopHooksStuck,
    enforcementHalted,
    compactRecovery,
    trueHumanGate,
    declaredIntent: !pendingInput && idle && hasDeclaredIntentToContinue(assistantText),
    fingerprint: fingerprint(clean, 'idle_status'),
    stableFingerprint: stableIdleFingerprint(agent, assistantText, 'idle_status'),
    excerpt: nonEmptyTail(assistantText, 10).join('\n'),
  };
}

function routerStatusMarkerInstruction() {
  return [
    'Use router status markers so the watcher can tell finished from merely idle:',
    'if unfinished tasks/assignments remain, continue the concrete next step or write a targeted *-to-claude.md/*-to-codex.md handoff;',
    'if all tasks/assignments are complete and no next owner/action remains, write a new newest router note under .hive-flow/data/tmux-router/ containing `Status: COMPLETE_NO_ACTION`;',
    'if a true human-only gate remains, write a new newest router note under .hive-flow/data/tmux-router/ containing `Status: BLOCKED_TRUE_HUMAN_GATE` plus the exact human action required.',
  ].join(' ');
}

function buildNudge(event) {
  if (event.kind === 'stalled_declared_intent') {
    return [
      'Unattended automation correction:',
      'you said you were going to continue, but the pane is idle at the prompt.',
      'Do the stated next action now. If that action is obsolete, inspect the latest .hive-flow/data/tmux-router/ handoff/result files and live git status, then continue with the obvious next step.',
      routerStatusMarkerInstruction(),
      'Do not ask the human unless this is a true human-only gate: push authorization, explicit policy override, undiscoverable secrets, or destructive approval.',
    ].join(' ');
  }

  if (event.kind === 'flow_deadlock') {
    return [
      'Unattended automation correction:',
      'both panes appear idle and no active owner is obvious.',
      'Codex: reconcile router state now. Read the latest .hive-flow/data/tmux-router/ handoff/result files, inspect live git status/log, decide which agent owns the next action, and either continue your work or send Claude a concrete handoff.',
      routerStatusMarkerInstruction(),
      'Apply the absurdity rule; do not ask the human for routine coordination.',
    ].join(' ');
  }

  const shared = [
    'Unattended automation correction:',
    'do not ask the human routine coordination, uncertainty, or recovery questions.',
    'Absurdity rule: if one answer is obvious and the alternatives are absurd, treat the question as already answered and continue.',
    'Reorient from the latest .hive-flow/data/tmux-router/ handoff files, durable handoff/state, and live git status/log.',
    'If Codex input is needed, write a *-to-codex.md note under .hive-flow/data/tmux-router/.',
    routerStatusMarkerInstruction(),
    'Only ask the human for true human-only gates: push authorization, explicit policy override, undiscoverable secrets, or destructive approval.',
  ];
  if (event.kind === 'compact_recovery_question') {
    shared.splice(3, 0, 'If compact recovery is required, use read-only tools plus the recovery helper/status to determine the summary, then ack only after orientation.');
  }
  return shared.join(' ');
}

function opposingAgent(agent) {
  if (agent === 'claude') return 'codex';
  if (agent === 'codex') return 'claude';
  return 'codex';
}

function silenceCommand(event) {
  const key = event.suppressKey || event.staleKey || event.fingerprint;
  return `node .hive-flow/data/tmux-router/flow-watchdog.cjs mute --key ${key} --minutes 60 --reason "waiting for human intervention"`;
}

function titleCaseAgent(agent) {
  const text = String(agent || 'agent');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function normalizeClaudeSlotAgentKind(value = 'claude') {
  const kind = String(value || 'claude').trim().toLowerCase();
  if (kind === 'claude' || kind === 'cursor' || kind === 'devin') return kind;
  return 'claude';
}

function currentClaudeSlotAgentKind({ root = ROOT, override = null } = {}) {
  if (override) return normalizeClaudeSlotAgentKind(override);
  try {
    return normalizeClaudeSlotAgentKind(fs.readFileSync(path.join(root, '.hive-flow', 'data', 'claude-agent.txt'), 'utf8'));
  } catch {
    return normalizeClaudeSlotAgentKind(process.env.HIVE_FLOW_CLAUDE_AGENT || 'claude');
  }
}

function claudeSlotDisplayName(kind = currentClaudeSlotAgentKind()) {
  switch (normalizeClaudeSlotAgentKind(kind)) {
    case 'cursor':
      return 'Cursor';
    case 'devin':
      return 'Devin';
    case 'claude':
    default:
      return 'Claude';
  }
}

function agentDisplayName(agent, { claudeSlotAgentKind = null, root = ROOT } = {}) {
  if (agent === 'claude') {
    return claudeSlotDisplayName(currentClaudeSlotAgentKind({ root, override: claudeSlotAgentKind }));
  }
  return titleCaseAgent(agent);
}

function buildAdjudicationNudge(event) {
  const subject = titleCaseAgent(event.subjectAgent || event.agent);
  const kindText = event.kind === 'human_gate_adjudication'
    ? 'suspected human gate'
    : 'idle question';
  const compactText = event.compactRecovery
    ? ' This involves compact recovery; judge whether the answer is recoverable from durable handoff/state, router files, and live git state before escalating.'
    : '';
  return [
    `Unattended automation adjudication: adjudicate ${subject}'s ${kindText}.`,
    'Do not ask the human unless this is genuinely human-only after checking available context.',
    'Decide one of: redirect the agent with a concrete next action, send a handoff to the other agent, or classify it as a true human-only gate.',
    routerStatusMarkerInstruction(),
    `If this is a genuine human-only gate, write the BLOCKED_TRUE_HUMAN_GATE router note first, then silence this stable watchdog event for a bit with: ${silenceCommand(event)}.`,
    'If it is performative or answerable, tell the stalled agent exactly what to do next; remember the human is not in the unattended loop.',
    compactText,
    'Visible excerpt:',
    event.excerpt,
  ].filter(Boolean).join(' ');
}

function buildOperationalNudge(event) {
  const subject = titleCaseAgent(event.subjectAgent || event.agent);
  if (event.kind === 'enforcement_halted') {
    return [
      `Unattended automation adjudication: ${subject}'s statusboard shows ENFORCEMENT ON (HALTED).`,
      'Review the halted pane before acting; determine whether this is a routine dev-environment false positive or a genuine human-only escalation.',
      'For this hive-flow development workflow, the human has granted standing review authority for the peer agent to reset Claude enforcement when the pane review shows reset is appropriate and necessary to keep unattended flow moving.',
      'If reset is appropriate, send `/reset-enforcement` verbatim to Claude, then send this follow-up message to Claude: "I reset enforcement under the human\'s standing review authority so the unattended flow can continue."',
      'Do not ask the human solely because Claude says reset is human-only; only escalate for a genuinely valid human-only gate after pane review.',
      `If this is a genuine human-only gate, silence this stable watchdog event for a bit with: ${silenceCommand(event)}.`,
      'Visible excerpt:',
      event.excerpt,
    ].join(' ');
  }

  if (event.kind === 'quota_limit') {
    const resetText = event.resetHint ? ` until ${event.resetHint}` : '';
    return [
      `Unattended automation correction: ${subject} appears quota-limited${resetText}.`,
      'Do not keep nudging the limited pane.',
      'If you still have usable quota, offload or continue the next concrete task from the latest router handoff and live git state.',
      'If no agent has usable quota, write a blocked/router note with the reset time and mute this stable event until quota returns.',
      `Mute command if this is a genuine quota pause: ${silenceCommand(event)}.`,
      'Visible excerpt:',
      event.excerpt,
    ].join(' ');
  }

  if (event.kind === 'rate_limit') {
    const retryText = event.retryHint ? ` Retry after ${event.retryHint}.` : ' Retry after a short delay.';
    return [
      'Unattended automation correction: transient rate limit detected.',
      retryText,
      'Retry the same safe operation once the delay has passed, using progressive backoff; do not ask the human for routine rate-limit handling.',
      'If this repeats, write a router note with the exact provider/model and hand off/offload to the other agent.',
      'Visible excerpt:',
      event.excerpt,
    ].join(' ');
  }

  if (event.kind === 'repeated_rate_limit') {
    return [
      `Unattended automation correction: ${subject} has repeated transient rate-limit/API-limit errors.`,
      'Stop retrying that pane blindly. Inspect the latest router files, live pane excerpt, and git state; decide whether to offload the task, wait, or classify a real external outage.',
      'If another agent can continue the task, take it over or route a concrete handoff instead of leaving both panes idle.',
      `Mute command if this is a true wait: ${silenceCommand(event)}.`,
      'Visible excerpt:',
      event.excerpt,
    ].join(' ');
  }

  if (event.kind === 'api_error') {
    return [
      'Unattended automation correction: transient API/transport error detected.',
      'Retry the failed operation if it is idempotent and still relevant.',
      'If it fails again, capture the exact error and route a handoff to the other agent instead of asking the human.',
      'Visible excerpt:',
      event.excerpt,
    ].join(' ');
  }

  if (event.kind === 'repeated_api_error') {
    return [
      `Unattended automation correction: ${subject} has repeated API errors.`,
      'Stop retrying blindly. Inspect the latest router files, live pane excerpt, and git state; decide whether to offload the task, wait, or classify a real external outage.',
      'If human login or account action is actually required, write a blocked note and mute this stable event.',
      `Mute command if this is a true wait: ${silenceCommand(event)}.`,
      'Visible excerpt:',
      event.excerpt,
    ].join(' ');
  }

  if (event.kind === 'auth_required') {
    return [
      `Unattended automation adjudication: ${subject} says login or authentication is required.`,
      'Treat this as a likely human-only gate; do not burn retries.',
      'Confirm from visible context whether login/session renewal is actually required, write a blocked note with exact recovery instructions, and mute this stable event until the human intervenes.',
      `Mute command: ${silenceCommand(event)}.`,
      'Visible excerpt:',
      event.excerpt,
    ].join(' ');
  }

  return buildNudge(event);
}

function isOperationalEvent(event) {
  return ['enforcement_halted', 'quota_limit', 'rate_limit', 'repeated_rate_limit', 'api_error', 'repeated_api_error', 'auth_required'].includes(event.kind);
}

function routeOperationalEvent(event, state, now) {
  if (event.kind === 'enforcement_halted') {
    return {
      event,
      targetAgent: opposingAgent(event.subjectAgent || event.agent),
      text: buildOperationalNudge(event),
    };
  }

  if (event.kind === 'quota_limit' || event.kind === 'auth_required') {
    return {
      event,
      targetAgent: opposingAgent(event.subjectAgent || event.agent),
      text: buildOperationalNudge(event),
    };
  }

  if (event.kind === 'rate_limit' || event.kind === 'api_error') {
    const count = bumpEventCount(state, event, now);
    if (event.kind === 'rate_limit' && count >= 3) {
      const repeated = {
        ...event,
        kind: 'repeated_rate_limit',
        reason: 'same transient rate-limit/API-limit event repeated',
        suppressKey: `${event.suppressKey}:repeated`,
        fingerprint: `${event.fingerprint}:repeated`,
      };
      return {
        event: repeated,
        targetAgent: opposingAgent(event.subjectAgent || event.agent),
        text: buildOperationalNudge(repeated),
      };
    }
    if (count >= 3) {
      const repeated = {
        ...event,
        kind: 'repeated_api_error',
        reason: 'same API or transport error repeated',
        suppressKey: `${event.suppressKey}:repeated`,
        fingerprint: `${event.fingerprint}:repeated`,
      };
      return {
        event: repeated,
        targetAgent: opposingAgent(event.subjectAgent || event.agent),
        text: buildOperationalNudge(repeated),
      };
    }
    return {
      event,
      targetAgent: event.agent,
      text: buildOperationalNudge(event),
    };
  }

  return {
    event,
    targetAgent: event.agent,
    text: buildOperationalNudge(event),
  };
}

function quotaHotswapFallbackKind(value = process.env.HIVE_FLOW_CLAUDE_QUOTA_FALLBACK || process.env.HIVE_FLOW_CLAUDE_HOTSWAP_FALLBACK || 'devin') {
  const kind = String(value || '').trim().toLowerCase();
  return kind === 'cursor' || kind === 'devin' ? kind : null;
}

function quotaHotswapRetryMs() {
  const minutes = Number(process.env.HIVE_FLOW_CLAUDE_QUOTA_HOTSWAP_RETRY_MIN || 10);
  return Math.max(1, Number.isFinite(minutes) ? minutes : 10) * 60_000;
}

function quotaHotswapAttemptKey(event, fallbackKind) {
  return [
    'claude-quota-hotswap',
    fallbackKind || 'unknown',
    event.resetHint || 'unknown-reset',
    event.suppressKey || event.fingerprint || 'unknown-event',
  ].join(':');
}

function quotaResetAnchorKey(event) {
  return `quota-reset-anchor:${event?.subjectAgent || event?.agent || 'unknown'}:${event?.suppressKey || event?.fingerprint || event?.resetHint || 'unknown'}`;
}

function quotaResetAnchor(state, event, now) {
  state.control = { ...(state.control || {}) };
  const anchors = { ...(state.control.quotaResetAnchors || {}) };
  const key = quotaResetAnchorKey(event);
  const prior = anchors[key];
  if (prior && Number.isFinite(Number(prior.resetAtMs))) {
    state.control.quotaResetAnchors = anchors;
    return prior;
  }

  const observedAtMs = Number(now);
  const timeZone = normalizeResetTimeZone(event?.resetTimeZone || DEFAULT_RESET_TIME_ZONE);
  const resetAtMs = parseResetTargetMs(event?.resetHint || '', observedAtMs, timeZone);
  const next = {
    observedAtMs,
    resetAtMs: Number.isFinite(resetAtMs) ? resetAtMs : null,
    resetHint: event?.resetHint || '',
    timeZone,
  };
  anchors[key] = next;
  state.control.quotaResetAnchors = anchors;
  return next;
}

function buildClaudeQuotaHotswapPlan(event, {
  now = Date.now(),
  state = null,
  root = ROOT,
  claudeSlotAgentKind = null,
  fallbackKind = quotaHotswapFallbackKind(),
  thresholdMs = DEFAULT_QUOTA_HOTSWAP_THRESHOLD_MS,
} = {}) {
  if (!event || event.kind !== 'quota_limit') return null;
  const subjectAgent = event.subjectAgent || event.agent;
  if (subjectAgent !== 'claude') return null;

  const currentKind = currentClaudeSlotAgentKind({ root, override: claudeSlotAgentKind });
  if (currentKind !== 'claude') return null;
  if (!fallbackKind || fallbackKind === currentKind) return null;

  const anchor = state ? quotaResetAnchor(state, event, now) : {
    observedAtMs: now,
    resetAtMs: parseResetTargetMs(event.resetHint, now, event.resetTimeZone || DEFAULT_RESET_TIME_ZONE),
    resetHint: event.resetHint || '',
    timeZone: normalizeResetTimeZone(event.resetTimeZone || DEFAULT_RESET_TIME_ZONE),
  };
  const resetDelayMs = Number(anchor?.resetAtMs) - now;
  if (!Number.isFinite(resetDelayMs) || resetDelayMs <= thresholdMs) return null;

  return {
    fallbackKind,
    currentKind,
    observedAtMs: Number(anchor.observedAtMs || now),
    resetAtMs: Number(anchor.resetAtMs),
    resetDelayMs,
    thresholdMs,
    timeZone: anchor.timeZone || normalizeResetTimeZone(event.resetTimeZone || DEFAULT_RESET_TIME_ZONE),
    attemptKey: quotaHotswapAttemptKey(event, fallbackKind),
  };
}

function recordQuotaHotswapAttempt(state, plan, now, patch = {}) {
  state.control = { ...(state.control || {}) };
  const attempts = { ...(state.control.quotaHotswapAttempts || {}) };
  const prior = attempts[plan.attemptKey] || {};
  attempts[plan.attemptKey] = {
    ...prior,
    firstAt: Number(prior.firstAt || now),
    lastAt: now,
    count: Number(prior.count || 0) + (patch.increment === false ? 0 : 1),
    fallbackKind: plan.fallbackKind,
    observedAtMs: plan.observedAtMs,
    resetAtMs: plan.resetAtMs,
    resetDelayMs: plan.resetDelayMs,
    thresholdMs: plan.thresholdMs,
    timeZone: plan.timeZone,
    ...patch,
  };
  delete attempts[plan.attemptKey].increment;
  state.control.quotaHotswapAttempts = attempts;
}

function quotaHotswapSuppressed(state, plan, now, retryMs = quotaHotswapRetryMs()) {
  const prior = state?.control?.quotaHotswapAttempts?.[plan.attemptKey];
  if (!prior?.lastAt) return false;
  return now - Number(prior.lastAt || 0) < retryMs;
}

function shouldEscapeBeforeOperationalNudge(event, targetAgent, paneSpec) {
  if (!event || event.kind !== 'api_error') return false;
  const subjectAgent = event.subjectAgent || event.agent;
  return targetAgent === subjectAgent && paneSpec?.name === subjectAgent;
}

// hive-flow-8b69 Slice 4: bounds for the persisted per-taskId liveness store.
const TASK_LIVENESS_MAX_TASKS = 200;
const TASK_LIVENESS_MAX_TASK_BYTES = 64 * 1024;

// Trim the taskLiveness map to the cap, dropping the oldest entries by observedAtMs, so a
// broken tasks directory (or a merged old state file) can never grow the state file
// without bound.
function trimTaskLivenessMap(map, max = TASK_LIVENESS_MAX_TASKS) {
  if (!map || map.size <= max) return;
  const oldestFirst = [...map.entries()]
    .sort((a, b) => Number(a[1]?.observedAtMs || 0) - Number(b[1]?.observedAtMs || 0));
  for (const [key] of oldestFirst.slice(0, map.size - max)) map.delete(key);
}

function createWatchState(seed = {}) {
  return {
    seen: new Map(Object.entries(seed.seen || {})),
    idleSince: new Map(Object.entries(seed.idleSince || {})),
    muted: new Map(Object.entries(seed.muted || {})),
    eventCounts: new Map(Object.entries(seed.eventCounts || {})),
    // hive-flow-8b69 Slice 4: per-taskId classifier prior + emitted-action markers.
    taskLiveness: new Map(Object.entries(seed.taskLiveness || {})),
    control: { ...(seed.control || {}) },
  };
}

function serializeWatchState(state) {
  return {
    seen: Object.fromEntries(state.seen.entries()),
    idleSince: Object.fromEntries(state.idleSince.entries()),
    muted: Object.fromEntries(state.muted.entries()),
    eventCounts: Object.fromEntries(state.eventCounts.entries()),
    taskLiveness: Object.fromEntries(state.taskLiveness.entries()),
    control: state.control || {},
  };
}

function loadWatchState(filePath = STATE_PATH) {
  try {
    return createWatchState(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return createWatchState();
  }
}

function muteUntil(entry) {
  return typeof entry === 'number' ? entry : Number(entry?.until || 0);
}

function quietResumedAt(state) {
  return Number(state?.control?.globalQuietResumedAt || 0);
}

function mergeControlRecordMap(targetControl, incomingControl, key, timestampField = 'lastAt') {
  const targetMap = { ...(targetControl[key] || {}) };
  for (const [recordKey, record] of Object.entries(incomingControl?.[key] || {})) {
    const current = targetMap[recordKey] || {};
    const currentTs = Number(current[timestampField] || current.observedAtMs || 0);
    const incomingTs = Number(record?.[timestampField] || record?.observedAtMs || 0);
    if (!currentTs || incomingTs >= currentTs) targetMap[recordKey] = record;
  }
  if (Object.keys(targetMap).length > 0) targetControl[key] = targetMap;
}

function scrubStaleControlMutes(state) {
  const quietEntry = state.muted.get(GLOBAL_QUIET_KEY);
  if (quietEntry && Number(quietEntry.mutedAt || 0) <= quietResumedAt(state)) {
    state.muted.delete(GLOBAL_QUIET_KEY);
  }
}

function mergeWatchState(target, incoming, { now = Date.now(), dropMutedKeys = [] } = {}) {
  const droppedMutedKeys = new Set(dropMutedKeys.map((key) => String(key)));
  const incomingQuietResumedAt = quietResumedAt(incoming);
  if (incomingQuietResumedAt > quietResumedAt(target)) {
    target.control = { ...(target.control || {}), globalQuietResumedAt: incomingQuietResumedAt };
  }
  target.control = { ...(target.control || {}) };
  mergeControlRecordMap(target.control, incoming.control || {}, 'quotaHotswapAttempts', 'lastAt');
  mergeControlRecordMap(target.control, incoming.control || {}, 'quotaResetAnchors', 'observedAtMs');
  const globalQuietResumedAt = quietResumedAt(target);
  scrubStaleControlMutes(target);

  for (const [key, value] of incoming.seen.entries()) {
    const current = Number(target.seen.get(key) || 0);
    const next = Number(value || 0);
    if (next > current) target.seen.set(key, next);
  }

  for (const [key, value] of incoming.idleSince.entries()) {
    const current = Number(target.idleSince.get(key) || 0);
    const next = Number(value || 0);
    if (!current || (next && next < current)) target.idleSince.set(key, next);
  }

  for (const [key, value] of incoming.muted.entries()) {
    if (droppedMutedKeys.has(String(key))) continue;
    if (String(key) === GLOBAL_QUIET_KEY && Number(value?.mutedAt || 0) <= globalQuietResumedAt) continue;
    const nextUntil = muteUntil(value);
    if (nextUntil <= now) continue;
    const currentUntil = muteUntil(target.muted.get(key));
    if (nextUntil > currentUntil) target.muted.set(key, value);
  }

  for (const [key, value] of incoming.eventCounts.entries()) {
    const current = target.eventCounts.get(key) || {};
    const currentLast = Number(current.lastAt || 0);
    const nextLast = Number(value?.lastAt || 0);
    if (nextLast > currentLast) target.eventCounts.set(key, value);
  }

  // hive-flow-8b69 Slice 4 (bounce B2): merge-aware deletion. `target` already reflects the
  // current pass's authoritative active set (pruned against the live tasks dir), so a key
  // ABSENT from target was intentionally removed (task completed/vanished/resulted) and must
  // NOT resurrect from the older on-disk file. Only update keys that still exist in target,
  // keeping the newest observation so concurrent instances still win. New keys are re-derived
  // by the next pass rather than merged back.
  for (const [key, value] of incoming.taskLiveness.entries()) {
    if (!target.taskLiveness.has(key)) continue;
    const currentTs = Number(target.taskLiveness.get(key)?.observedAtMs || 0);
    const incomingTs = Number(value?.observedAtMs || 0);
    if (incomingTs > currentTs) target.taskLiveness.set(key, value);
  }
  // Keep the cap effective even through mergeExisting.
  trimTaskLivenessMap(target.taskLiveness);

  return target;
}

function saveWatchState(state, filePath = STATE_PATH, { mergeExisting = false, now = Date.now(), dropMutedKeys = [] } = {}) {
  if (mergeExisting) mergeWatchState(state, loadWatchState(filePath), { now, dropMutedKeys });
  scrubStaleControlMutes(state);
  // hive-flow-8b69 Slice 4: bound the persisted taskLiveness store on every save path.
  if (state.taskLiveness) trimTaskLivenessMap(state.taskLiveness);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(serializeWatchState(state), null, 2)}\n`);
}

function isPermissionMessageEvent(event) {
  const kind = String(event?.kind || '').toLowerCase();
  const sourceKind = String(event?.sourceKind || '').toLowerCase();
  return kind.includes('permission') || sourceKind.includes('permission');
}

function minimumSendCooldownMs(event) {
  return isPermissionMessageEvent(event)
    ? MIN_PERMISSION_SEND_COOLDOWN_MS
    : MIN_NON_PERMISSION_SEND_COOLDOWN_MS;
}

function effectiveSendCooldownMs(event, requestedCooldownMs = DEFAULT_COOLDOWN_MS) {
  const requested = Number.isFinite(Number(requestedCooldownMs))
    ? Math.max(0, Number(requestedCooldownMs))
    : DEFAULT_COOLDOWN_MS;
  return Math.max(requested, minimumSendCooldownMs(event));
}

function shouldSuppress(state, event, now, cooldownMs) {
  return shouldSuppressDelivery(state, event, event?.agent || null, '', now, cooldownMs);
}

function normalizeSendTextForCooldown(text) {
  const stableLines = [];
  for (const line of linesOf(text)) {
    const trimmed = line.trim();
    if (/^Visible excerpt:/i.test(trimmed)) break;
    if (trimmed) stableLines.push(trimmed);
  }
  return stableLines.join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function sendTextFingerprint(text) {
  return crypto.createHash('sha256')
    .update(normalizeSendTextForCooldown(text) || String(text || ''))
    .digest('hex');
}

function queuedMessageDedupeKey(targetAgent, text) {
  return `${targetAgent || 'unknown'}:${sendTextFingerprint(text)}`;
}

function baseOperationalKind(kind) {
  if (kind === 'repeated_rate_limit') return 'rate_limit';
  if (kind === 'repeated_api_error') return 'api_error';
  return kind;
}

function deliveryCooldownKeys(event, targetAgent, text) {
  const subjectAgent = event?.subjectAgent || event?.agent || targetAgent || 'unknown';
  const eventAgent = event?.agent || subjectAgent;
  const kind = event?.kind || 'message';
  const fingerprintKey = event?.suppressKey || event?.staleKey || event?.fingerprint || sendTextFingerprint(text);
  const keys = [
    `event:${eventAgent}:${kind}:${fingerprintKey}`,
  ];
  if (targetAgent && text) {
    keys.push(`message:${targetAgent}:${isPermissionMessageEvent(event) ? 'permission' : 'general'}:${sendTextFingerprint(text)}`);
  }
  if (isOperationalEvent(event)) {
    keys.push(`operational:${subjectAgent}:${baseOperationalKind(kind)}`);
  }
  return [...new Set(keys)];
}

function shouldSuppressDelivery(state, event, targetAgent, text, now, cooldownMs, { record = true } = {}) {
  const effectiveCooldown = effectiveSendCooldownMs(event, cooldownMs);
  const keys = deliveryCooldownKeys(event, targetAgent, text);
  if (keys.some((key) => {
    const prior = Number(state.seen.get(key) || 0);
    return prior && now - prior < effectiveCooldown;
  })) {
    return true;
  }
  if (record) {
    for (const key of keys) state.seen.set(key, now);
  }
  return false;
}

function clearDeliveryCooldown(state, event, targetAgent, text) {
  for (const key of deliveryCooldownKeys(event, targetAgent, text)) {
    state.seen.delete(key);
  }
}

function muteKey(state, key, { now = Date.now(), minutes = 60, reason = '' } = {}) {
  if (!key) throw new Error('mute key is required');
  const durationMs = Math.max(1, Number(minutes || 60)) * 60_000;
  state.muted.set(String(key), {
    until: now + durationMs,
    reason: String(reason || ''),
    mutedAt: now,
  });
}

function quietWatchdog(state, { now = Date.now(), minutes = null, reason = '' } = {}) {
  const until = minutes === null || minutes === undefined
    ? Number.MAX_SAFE_INTEGER
    : now + Math.max(1, Number(minutes || 1)) * 60_000;
  state.muted.set(GLOBAL_QUIET_KEY, {
    until,
    reason: String(reason || 'watchdog quieted'),
    mutedAt: now,
  });
}

function resumeWatchdog(state, { now = Date.now() } = {}) {
  state.control = {
    ...(state.control || {}),
    globalQuietResumedAt: Math.max(quietResumedAt(state), now),
  };
  state.muted.delete(GLOBAL_QUIET_KEY);
}

function quietStatus(state, now = Date.now()) {
  const entry = state.muted.get(GLOBAL_QUIET_KEY);
  if (!entry) return { quiet: false };
  if (Number(entry.mutedAt || 0) <= quietResumedAt(state)) {
    state.muted.delete(GLOBAL_QUIET_KEY);
    return { quiet: false };
  }
  const until = muteUntil(entry);
  if (until <= now) {
    state.muted.delete(GLOBAL_QUIET_KEY);
    return { quiet: false };
  }
  return {
    quiet: true,
    until,
    forever: until === Number.MAX_SAFE_INTEGER,
    reason: String(entry.reason || ''),
    mutedAt: Number(entry.mutedAt || 0),
  };
}

function isWatchdogQuiet(state, now = Date.now()) {
  return quietStatus(state, now).quiet;
}

function isMuted(state, event, now) {
  const key = event.suppressKey || event.staleKey || event.fingerprint;
  const entry = state.muted.get(key);
  if (!entry) return false;
  const until = muteUntil(entry);
  if (until > now) return true;
  state.muted.delete(key);
  return false;
}

function staleEventKey(event) {
  return `${event.agent}:${event.kind}:${event.staleKey || event.fingerprint}`;
}

function countedEventKey(event) {
  return `${event.subjectAgent || event.agent}:${event.kind}:${event.suppressKey || event.staleKey || event.fingerprint}`;
}

function newestRouterMarkdown(routerDir) {
  if (!routerDir) return null;
  try {
    let newest = null;
    for (const entry of fs.readdirSync(routerDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const filePath = path.join(routerDir, entry.name);
      const stat = fs.statSync(filePath);
      if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { filePath, mtimeMs: stat.mtimeMs };
    }
    return newest;
  } catch {
    return null;
  }
}

function activeRouterTerminalState(routerDir = ROUTER_DIR) {
  const newest = newestRouterMarkdown(routerDir);
  if (!newest) return null;
  try {
    const text = fs.readFileSync(newest.filePath, 'utf8');
    if (/^Status:\s*COMPLETE_NO_ACTION\b/im.test(text)) return newest;
    return null;
  } catch {
    return null;
  }
}

// hive-flow-8b69 Slice 5 (P2-SL4): return the newest router note when it is a human-gate
// blocker (so its mtime can floor router handoffs and gate a global early return), mirroring
// activeRouterTerminalState. Only fires when the blocker is the NEWEST note — a newer
// non-terminal handoff overrides it (newest-note semantics).
function activeRouterHumanBlocker(routerDir = ROUTER_DIR) {
  const newest = newestRouterMarkdown(routerDir);
  if (!newest) return null;
  try {
    const text = fs.readFileSync(newest.filePath, 'utf8');
    if (/^Status:\s*BLOCKED_TRUE_HUMAN_GATE\b/im.test(text)) return newest;
    if (/\bhuman authorization gate\b/i.test(text)
      && /\b(?:merge|push|delete|prune|git refs?)\b/i.test(text)
      && /\b(?:forbidden|without human go|authorization boundary)\b/i.test(text)) return newest;
    return null;
  } catch {
    return null;
  }
}

function hasActiveRouterHumanBlocker(routerDir = ROUTER_DIR) {
  return activeRouterHumanBlocker(routerDir) !== null;
}

function hasActiveRouterTerminalState(routerDir = ROUTER_DIR) {
  return activeRouterTerminalState(routerDir) !== null;
}

function routerSentDir(routerDir = ROUTER_DIR) {
  return path.join(routerDir, '.sent');
}

function handoffNoticeMarker(routerDir, filePath) {
  return path.join(routerSentDir(routerDir), `${path.basename(filePath)}.sent`);
}

function handoffNoticeSent(routerDir, filePath) {
  return fs.existsSync(handoffNoticeMarker(routerDir, filePath));
}

function markHandoffNoticeSent(routerDir, filePath, now) {
  fs.mkdirSync(routerSentDir(routerDir), { recursive: true });
  fs.writeFileSync(handoffNoticeMarker(routerDir, filePath), `${new Date(now).toISOString()}\n`, 'utf8');
}

function handoffTargetFromFile(filePath) {
  const base = path.basename(filePath);
  const explicit = base.match(/-to-(claude|codex)\.md$/);
  if (explicit) return explicit[1];
  const readyForAgent = base.match(/-ready-for-(claude|codex)\.md$/);
  if (readyForAgent) return readyForAgent[1];
  if (/-ready-for-verify\.md$/.test(base)) return 'claude';
  return null;
}

function pendingRouterHandoffs(routerDir = ROUTER_DIR, paneSpecs = []) {
  if (!routerDir) return [];
  const names = new Set(paneSpecs.map((pane) => pane.name));
  try {
    return fs.readdirSync(routerDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const filePath = path.join(routerDir, entry.name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(filePath).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        return { filePath, mtimeMs, targetAgent: handoffTargetFromFile(filePath) };
      })
      .filter((handoff) => handoff.targetAgent && names.has(handoff.targetAgent))
      .filter((handoff) => !handoffNoticeSent(routerDir, handoff.filePath))
      .sort((a, b) => path.basename(a.filePath).localeCompare(path.basename(b.filePath)));
  } catch {
    return [];
  }
}

function normalizeRouterHandoffBody(text) {
  return linesOf(text)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(?:- )?Created:/i.test(line))
    .filter((line) => !/^(?:- )?Codex pane:/i.test(line))
    .filter((line) => !/^(?:- )?Claude pane:/i.test(line))
    .filter((line) => !/^(?:- )?Repo:/i.test(line))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function routerHandoffContentFingerprint(filePath) {
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    text = path.basename(filePath);
  }
  return crypto.createHash('sha256')
    .update(normalizeRouterHandoffBody(text) || text || path.basename(filePath))
    .digest('hex');
}

function routerHandoffContentKey(targetAgent, contentFingerprint) {
  return `${ROUTER_HANDOFF_CONTENT_PREFIX}:${targetAgent || 'unknown'}:${contentFingerprint}`;
}

function routerHandoffDuplicateCountKey(targetAgent, contentFingerprint) {
  return `${ROUTER_HANDOFF_DUPLICATE_PREFIX}:${targetAgent || 'unknown'}:${contentFingerprint}`;
}

function recordRouterHandoffDuplicate(state, targetAgent, contentFingerprint, now) {
  const key = routerHandoffDuplicateCountKey(targetAgent, contentFingerprint);
  const current = state.eventCounts.get(key) || {};
  state.eventCounts.set(key, {
    count: Number(current.count || 0) + 1,
    firstAt: Number(current.firstAt || now),
    lastAt: now,
  });
}

function hasSeenRouterHandoffContent(state, targetAgent, contentFingerprint) {
  const key = routerHandoffContentKey(targetAgent, contentFingerprint);
  return state.seen.has(key);
}

function markRouterHandoffContentSeen(state, targetAgent, contentFingerprint, now) {
  const key = routerHandoffContentKey(targetAgent, contentFingerprint);
  state.seen.set(key, now);
}

function buildRouterHandoffNotice(filePath, targetAgent = null, options = {}) {
  const targetLabel = targetAgent === 'claude'
    ? ` for ${agentDisplayName('claude', options)} (Claude/verifier slot)`
    : '';
  return [
    `Hive Flow handoff ready${targetLabel}: ${filePath}.`,
    'Read it, follow the constraints exactly, and write any result/blocked note to .hive-flow/data/tmux-router/.',
    routerStatusMarkerInstruction(),
  ].join(' ');
}

function bumpEventCount(state, event, now, windowMs = 30 * 60_000) {
  const key = countedEventKey(event);
  const current = state.eventCounts.get(key) || {};
  const firstAt = Number(current.firstAt || 0);
  const count = firstAt && now - firstAt <= windowMs ? Number(current.count || 0) + 1 : 1;
  state.eventCounts.set(key, {
    count,
    firstAt: count === 1 ? now : firstAt,
    lastAt: now,
  });
  return count;
}

function staleIdleEventReady(state, event, now, idleStallMs) {
  const key = staleEventKey(event);
  const prior = Number(state.idleSince.get(key) || 0);
  if (!prior) {
    state.idleSince.set(key, now);
    return false;
  }
  return now - prior >= idleStallMs;
}

// hive-flow-8b69 Slice 3: the task-liveness classifier is no longer implemented here.
// It is consolidated onto the shared source of truth
// `cli/src/progress/hiveflow-task-liveness.cjs` (also re-exported by
// progress-authority-classifier.ts for MCP/CLI consumers). Require the tracked SOURCE
// `.cjs` directly — synchronous, no build dependency. Slice 4 wires this into `runOnce`
// with persisted prior observations, passing `idleStallMs: DEFAULT_IDLE_STALL_MS`
// explicitly at the call site to preserve the watchdog's effective 8-minute threshold.
function resolveSharedLivenessModule() {
  // This file runs from exactly one of two locations: its tracked home (`scripts/`,
  // where `scripts/..` is the repo root) or the installed runtime copy
  // (`.hive-flow/data/tmux-router/`, where `ROOT` is the repo root). Prefer the
  // installed-runtime path so behavior is unchanged when installed.
  const rel = path.join('cli', 'src', 'progress', 'hiveflow-task-liveness.cjs');
  const runtimePath = path.join(ROOT, rel);
  if (fs.existsSync(runtimePath)) return runtimePath;
  return path.join(__dirname, '..', rel);
}
const { classifyHiveFlowTaskLiveness } = require(resolveSharedLivenessModule());

// hive-flow-8b69 Slice 4: task-liveness pass — classify active Hive Flow tasks with the
// shared source of truth and emit at most one deduped recovery/review nudge per stable
// actionable event, routed to the task owner (or a safe deadlock target if unresolved).
// TASK_LIVENESS_MAX_TASKS / _MAX_TASK_BYTES + trimTaskLivenessMap are defined with the state
// model above so the mergeExisting save path can reuse them.

// A pane is only a SAFE delivery target when it is idle: not actively working, not awaiting
// pending input, and not compact-recovery held. Mirrors the existing notification/handoff
// delivery contract so a task nudge never interrupts a busy operator (bounce B1).
function isSafeDeliveryStatus(status) {
  return Boolean(status) && !status.active && !status.pendingInput && !status.compactRecovery;
}

// PID is a WEAK signal (per the classifier contract): a task is only "dead" when a finite
// positive PID is proven ESRCH. EPERM means the process exists but is not ours (alive). A
// missing/invalid PID or any other error is unknown — return null so elapsed time alone
// never orphans a task.
function taskPidLivenessSnapshot(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return { alive: true };
  } catch (err) {
    const code = err && typeof err === 'object' ? err.code : undefined;
    if (code === 'ESRCH') return { alive: false };
    if (code === 'EPERM') return { alive: true };
    return null;
  }
}

function taskTrackingPid(tracking) {
  for (const candidate of [tracking?.pid, tracking?.currentTaskPid, tracking?.currentPid]) {
    const pid = Number(candidate);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

function isActiveTaskTracking(tracking) {
  const status = String(tracking?.status || '').toLowerCase();
  return status === 'running' || status === 'dispatched' || status === 'active' || status === 'in_progress';
}

function readBoundedTaskJson(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > TASK_LIVENESS_MAX_TASK_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function enumerateActiveTasks(tasksDir) {
  let names;
  try {
    names = fs.readdirSync(tasksDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (out.length >= TASK_LIVENESS_MAX_TASKS) break;
    if (!name.endsWith('.json') || name.endsWith('.result.json')) continue;
    const taskId = name.slice(0, -'.json'.length);
    if (!taskId) continue;
    if (fs.existsSync(path.join(tasksDir, `${taskId}.result.json`))) continue;
    const tracking = readBoundedTaskJson(path.join(tasksDir, name));
    if (!tracking || typeof tracking !== 'object' || Array.isArray(tracking)) continue;
    if (!isActiveTaskTracking(tracking)) continue;
    out.push({ taskId, tracking });
  }
  return out;
}

// Signature that changes when a task makes progress (event log grows / advances) but is
// stable across pure no-progress observations — so a stable stall dispatches once while a
// later genuine stall after progress re-arms.
function taskLivenessSignature(nextPrior) {
  return crypto.createHash('sha256')
    .update(`${Number(nextPrior?.eventSize || 0)}:${String(nextPrior?.lastEventTs || '')}`)
    .digest('hex')
    .slice(0, 16);
}

function buildTaskLivenessNudge(taskId, verdict, ownerUnresolved) {
  const action = verdict.status === 'orphaned'
    ? 'appears orphaned (process not alive, no result file). Reconcile/re-dispatch it or clean up its tracking files.'
    : 'appears stalled with no progress past the review threshold. Review and adjudicate: continue, redirect, or terminate it.';
  const lines = [
    `Hive Flow task ${taskId} ${action}`,
    `Verdict: ${verdict.status} — ${verdict.reason}`,
  ];
  if (ownerUnresolved) {
    lines.push('Task owner could not be resolved from task/result/agent records; routed to you as the current deadlock target.');
  }
  lines.push(`Inspect: .hive-flow/tasks/${taskId}.json + ${taskId}.events.jsonl (result: ${taskId}.result.json).`);
  return lines.join('\n');
}

// Classify each active task and emit at most one deduped nudge per stable actionable event.
// `dispatch(paneSpec, event, text, targetAgent)` MUST route through the caller's
// dispatchEvent so delivery, dedupe, cooldown, mute, and logging behavior are inherited;
// it returns a truthy record when actually delivered, null when suppressed.
function runTaskLivenessPass({
  state,
  now,
  root = ROOT,
  tasksDir = path.join(root, '.hive-flow', 'tasks'),
  paneSpecs = [],
  statuses = [],
  idleStallMs = DEFAULT_IDLE_STALL_MS,
  dispatch,
}) {
  if (!state.taskLiveness) state.taskLiveness = new Map();
  const active = enumerateActiveTasks(tasksDir);
  const activeIds = new Set(active.map((task) => task.taskId));

  // Prune priors for tasks that completed, vanished, produced a result, or went inactive.
  for (const key of [...state.taskLiveness.keys()]) {
    if (!activeIds.has(key)) state.taskLiveness.delete(key);
  }
  // Cap the store so a broken tasks directory cannot grow the state file without bound.
  trimTaskLivenessMap(state.taskLiveness);

  for (const { taskId, tracking } of active) {
    const prior = state.taskLiveness.get(taskId) || null;
    const verdict = classifyHiveFlowTaskLiveness({
      tasksDir,
      taskId,
      processSnapshot: taskPidLivenessSnapshot(taskTrackingPid(tracking)),
      prior,
      nowMs: now,
      idleStallMs,
    });
    const stored = { ...verdict.nextPrior, emitted: { ...(prior?.emitted || {}) } };

    if (verdict.status === 'orphaned' || verdict.status === 'stalled_review') {
      const signature = taskLivenessSignature(verdict.nextPrior);
      if (stored.emitted[verdict.status] !== signature) {
        const owner = notificationTaskOwner({ taskId }, root);
        const ownerAgent = owner?.targetAgent || targetAgentFromKind(owner?.ownerClientKind);
        const ownerPaneSpec = ownerAgent ? paneSpecs.find((spec) => spec.name === ownerAgent) : null;

        let targetAgent = null;
        let paneSpec = null;
        let ownerUnresolved = false;

        if (ownerPaneSpec) {
          // Owner resolved: deliver ONLY when the owner pane is idle/safe. If the owner is
          // busy (active / pending input / compact-recovery held), stay quiet and keep the
          // prior (no emitted marker) so a later idle run delivers — never redirect to
          // another operator's pane (bounce B1).
          if (isSafeDeliveryStatus(statuses.find((s) => s.agent === ownerAgent))) {
            targetAgent = ownerAgent;
            paneSpec = ownerPaneSpec;
          }
        } else {
          // Owner unresolved: fall back only to a SAFE idle/non-pending watched target
          // (preferring codex). If none is safe, stay quiet and keep observing (bounce B1).
          const safe = statuses.find((s) => s.agent === 'codex' && isSafeDeliveryStatus(s) && paneSpecs.some((p) => p.name === s.agent))
            || statuses.find((s) => s.agent && isSafeDeliveryStatus(s) && paneSpecs.some((p) => p.name === s.agent));
          if (safe) {
            targetAgent = safe.agent;
            paneSpec = paneSpecs.find((spec) => spec.name === safe.agent);
            ownerUnresolved = true;
          }
        }

        if (paneSpec && targetAgent && typeof dispatch === 'function') {
          const staleKey = `taskLiveness:${taskId}:${verdict.status}:${signature}`;
          const event = {
            agent: targetAgent,
            kind: verdict.status === 'orphaned' ? 'task_orphaned_recovery' : 'task_stalled_review',
            reason: ownerUnresolved ? `owner-unresolved; ${verdict.reason}` : verdict.reason,
            staleKey,
            suppressKey: staleKey,
            taskId,
          };
          const record = dispatch(paneSpec, event, buildTaskLivenessNudge(taskId, verdict, ownerUnresolved), targetAgent);
          if (record) stored.emitted[verdict.status] = signature;
        }
      }
    }

    state.taskLiveness.set(taskId, stored);
  }
}

function pruneMissingStopHookTimers(state, observedKeys) {
  for (const key of state.idleSince.keys()) {
    if (key.includes(':claude_stop_hooks_escape:') && !observedKeys.has(key)) {
      state.idleSince.delete(key);
    }
  }
}

function chooseDeadlockTarget(statuses) {
  return statuses.find((status) => status.agent === 'codex')
    || statuses.find((status) => status.agent)
    || null;
}

const realTmux = {
  capturePane(pane, lines = DEFAULT_LINES) {
    return execFileSync('tmux', ['capture-pane', '-e', '-t', pane, '-p', '-S', `-${lines}`], { encoding: 'utf8' });
  },
  cursor(pane) {
    const [cursorX, cursorY, paneWidth, paneHeight] = execFileSync(
      'tmux',
      ['display-message', '-p', '-t', pane, '#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}'],
      { encoding: 'utf8' },
    ).trim().split(/\s+/).map((value) => Number(value));
    return { cursorX, cursorY, paneWidth, paneHeight };
  },
  paneMode(pane) {
    try {
      const [inMode, mode] = execFileSync(
        'tmux',
        ['display-message', '-p', '-t', pane, '#{pane_in_mode} #{pane_mode}'],
        { encoding: 'utf8' },
      ).trim().split(/\s+/, 2);
      return { inMode: inMode === '1', mode: mode || '' };
    } catch {
      return null;
    }
  },
  clearPaneMode(agent, pane) {
    const target = pane || agent;
    try {
      execFileSync('tmux', ['send-keys', '-t', target, '-X', 'cancel'], { stdio: 'ignore' });
    } catch {
      // The pane may have left copy-mode between observation and recovery.
    }
  },
  sendLine(agent, text) {
    const command = agent === 'codex' ? 'send-codex' : 'send-claude';
    execFileSync('bash', [CONTROL, command, text], {
      stdio: 'ignore',
      cwd: ROOT,
      env: { ...process.env, HIVE_FLOW_TMUX_SENDER: 'flow-watchdog' },
    });
  },
  hotswapClaudeSlot(kind) {
    return execFileSync('bash', [CONTROL, 'hotswap-claude', '--no-watchdog-restart', kind], {
      encoding: 'utf8',
      cwd: ROOT,
      env: { ...process.env, HIVE_FLOW_TMUX_SENDER: 'flow-watchdog' },
    });
  },
  sendEscape(agent, pane) {
    const target = pane || agent;
    execFileSync('tmux', ['send-keys', '-t', target, 'Escape'], { stdio: 'ignore' });
  },
};

function parsePaneSpec(value) {
  const text = String(value || '').trim();
  const match = text.match(/^([^=:]+)[=:](.+)$/);
  if (!match) throw new Error(`invalid pane spec: ${text}`);
  return { name: match[1].trim(), pane: match[2].trim() };
}

function normalizePanes(panes) {
  return panes.map((pane) => (typeof pane === 'string' ? parsePaneSpec(pane) : pane));
}

function shouldHoldAutomationDispatch(statuses) {
  return statuses.some((status) => status.active || status.pendingInput || status.compactRecovery);
}

function isTmuxCopyMode(status) {
  return Boolean(status?.paneMode?.inMode) && String(status?.paneMode?.mode || '') === 'copy-mode';
}

function pendingNotificationsFile(root = ROOT) {
  return path.join(root, '.hive-flow', 'data', 'pending-notifications.jsonl');
}

function defaultPendingNotificationsRoot() {
  return process.env.HIVE_FLOW_WATCHDOG_PENDING_ROOT || ROOT;
}

function readJsonFileSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function stringValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function targetAgentFromKind(kind) {
  const raw = String(kind || '').toLowerCase();
  if (raw.includes('codex')) return 'codex';
  if (raw.includes('claude')) return 'claude';
  return null;
}

function agentIdFromNotification(note) {
  const explicit = note?.agentId || note?.agent_id;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const summary = typeof note?.summary === 'string' ? note.summary : '';
  const match = summary.match(/\bagent=("[^"]+"|'[^']+'|[^\s,.)]+)/i);
  if (!match) return null;
  return match[1].replace(/^['"]|['"]$/g, '').trim() || null;
}

function notificationOwnerCandidate(obj, source) {
  if (!obj || typeof obj !== 'object') return null;
  const ownerSessionId = stringValue(obj.ownerSessionId || obj.owner_session_id || obj.sessionId || obj.session_id);
  const ownerClientKind = stringValue(obj.ownerClientKind || obj.owner_client_kind || obj.clientKind || obj.client_kind);
  const explicitTarget = stringValue(obj.targetAgent || obj.target_agent);
  const agentId = stringValue(obj.agentId || obj.agent_id);
  const targetFromKind = targetAgentFromKind(ownerClientKind);
  const targetFromExplicit = (ownerSessionId || ownerClientKind) ? targetAgentFromKind(explicitTarget) : null;
  const targetAgent = targetFromKind || targetFromExplicit || null;
  if (!targetAgent && !ownerSessionId && !ownerClientKind && !agentId) return null;
  return {
    source,
    targetAgent,
    ownerSessionId,
    ownerClientKind,
    agentId,
  };
}

function mergeNotificationOwner(current, candidate) {
  if (!candidate) return current;
  const next = current ? { ...current } : { source: candidate.source || null };
  if (!next.targetAgent && candidate.targetAgent) {
    next.targetAgent = candidate.targetAgent;
    next.targetSource = candidate.source || null;
  }
  if (!next.ownerSessionId && candidate.ownerSessionId) {
    next.ownerSessionId = candidate.ownerSessionId;
    next.ownerSessionSource = candidate.source || null;
  }
  if (!next.ownerClientKind && candidate.ownerClientKind) {
    next.ownerClientKind = candidate.ownerClientKind;
    next.ownerClientKindSource = candidate.source || null;
  }
  if (!next.agentId && candidate.agentId) next.agentId = candidate.agentId;
  if (!next.source && candidate.source) next.source = candidate.source;
  if (!next.targetAgent && next.ownerClientKind) {
    next.targetAgent = targetAgentFromKind(next.ownerClientKind);
    next.targetSource = next.ownerClientKindSource || null;
  }
  return next;
}

function notificationTaskOwner(note, root = ROOT) {
  const taskId = stringValue(note?.taskId);
  if (!taskId) return null;

  let owner = null;
  const task = readJsonFileSafe(path.join(root, '.hive-flow', 'tasks', `${taskId}.json`));
  owner = mergeNotificationOwner(owner, notificationOwnerCandidate(task, 'task'));

  const result = readJsonFileSafe(path.join(root, '.hive-flow', 'tasks', `${taskId}.result.json`));
  const inner = result && typeof result === 'object' ? result.result : null;
  owner = mergeNotificationOwner(owner, notificationOwnerCandidate(result, 'result'));
  owner = mergeNotificationOwner(owner, notificationOwnerCandidate(inner, 'result.result'));
  owner = mergeNotificationOwner(owner, notificationOwnerCandidate(note, 'notification'));

  const agentId = owner?.agentId
    || stringValue(task?.agentId || task?.agent_id)
    || stringValue(result?.agentId || result?.agent_id)
    || stringValue(inner?.agentId || inner?.agent_id)
    || agentIdFromNotification(note);
  if (agentId) {
    const store = readJsonFileSafe(path.join(root, '.hive-flow', 'agents', 'store.json'));
    const agent = store?.agents?.[agentId];
    owner = mergeNotificationOwner(owner, notificationOwnerCandidate(agent, 'agent-store'));
    if (owner && !owner.agentId) owner.agentId = agentId;
  }

  return owner;
}

function sanitizeHivePathId(value) {
  const sanitized = String(value || '')
    .replace(/[/\\.]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || null;
}

function notificationHiveOwner(note, root = ROOT) {
  const hiveId = stringValue(note?.hiveId || note?.hive_id);
  const sanitized = sanitizeHivePathId(hiveId);
  if (!hiveId || !sanitized) return null;

  let owner = null;
  const hive = readJsonFileSafe(path.join(root, '.hive-flow', 'hives', sanitized, 'hive.json'));
  owner = mergeNotificationOwner(owner, notificationOwnerCandidate(hive, 'hive'));

  const done = readJsonFileSafe(path.join(root, '.hive-flow', 'data', `hive-${sanitized}.done`));
  owner = mergeNotificationOwner(owner, notificationOwnerCandidate(done, 'hive-done'));
  owner = mergeNotificationOwner(owner, notificationOwnerCandidate(note, 'notification'));
  return owner;
}

function notificationOwner(note, root = ROOT) {
  return mergeNotificationOwner(
    notificationTaskOwner(note, root),
    notificationHiveOwner(note, root),
  );
}

function currentOwnerSessionForAgent(agent, root = ROOT) {
  const normalized = targetAgentFromKind(agent);
  const dataDir = path.join(root, '.hive-flow', 'data');
  const files = normalized === 'claude'
    ? [
        ['compaction-state', path.join(dataDir, 'compaction-state.json')],
        ['compaction-recovery-ack', path.join(dataDir, 'compaction-recovery-ack.json')],
      ]
    : normalized === 'codex'
      ? [
          ['codex-session', path.join(dataDir, 'codex-session.json')],
          ['codex-state', path.join(dataDir, 'codex-state.json')],
          ['codex-thread', path.join(dataDir, 'codex-thread.json')],
        ]
      : [];

  for (const [source, file] of files) {
    const obj = readJsonFileSafe(file);
    const sessionId = stringValue(obj?.sessionId || obj?.session_id || obj?.threadId || obj?.thread_id);
    if (sessionId) return { sessionId, source };
  }

  return null;
}

function resolveCompletionNotificationDelivery(note, paneSpecs, root = ROOT) {
  const names = new Set(paneSpecs.map((pane) => pane.name));
  const owner = notificationOwner(note, root);
  const targetAgent = owner?.targetAgent || null;
  if (!targetAgent || !names.has(targetAgent)) {
    return {
      ok: false,
      reason: 'missing_supported_owner_target',
      owner,
    };
  }

  if (!owner.ownerSessionId) {
    return {
      ok: false,
      reason: 'missing_owner_session',
      owner,
    };
  }

  const currentSession = currentOwnerSessionForAgent(targetAgent, root);
  if (currentSession?.sessionId && currentSession.sessionId !== owner.ownerSessionId) {
    return {
      ok: false,
      reason: 'owner_session_mismatch',
      owner,
      currentSession,
    };
  }

  return {
    ok: true,
    targetAgent,
    owner,
    currentSession,
  };
}

function notificationTargetAgent(note, paneSpecs, root = ROOT) {
  const names = new Set(paneSpecs.map((pane) => pane.name));
  const persisted = notificationOwner(note, root);
  if (names.has(persisted?.targetAgent)) return persisted.targetAgent;
  const explicit = String(note?.targetAgent || note?.target_agent || '').trim().toLowerCase();
  if (names.has(explicit)) return explicit;

  const kind = String(note?.clientKind || note?.client_kind || note?.ownerClientKind || note?.owner_client_kind || '').toLowerCase();
  if (kind.includes('codex') && names.has('codex')) return 'codex';
  if (kind.includes('claude') && names.has('claude')) return 'claude';
  if (names.has('claude')) return 'claude';
  if (names.has('codex')) return 'codex';
  return paneSpecs[0]?.name || null;
}

function notificationKey(note) {
  const kind = String(note?.kind || 'notification');
  const id = note?.taskId || note?.hiveId || note?.summary || JSON.stringify(note);
  return `hive-flow-completion:${kind}:${id}`;
}

function buildCompletionText(note) {
  const summary = String(note?.summary || '').trim();
  return summary
    ? `Hive Flow background completion detected: ${summary}`
    : 'Hive Flow background completion detected. Check the relevant task result for details.';
}

function isPermissionWakeNotification(note) {
  const kind = String(note?.kind || '').trim();
  return kind === 'permission-request'
    || kind === 'worker-permission-denial'
    || kind === 'provider-permission-denial'
    || kind === 'queen-permission-request';
}

function isQueenPermissionNotification(note) {
  const kind = String(note?.kind || '').trim();
  if (kind === 'queen-permission-request') return true;
  const role = String(note?.role || note?.agentRole || note?.agent_role || note?.requesterRole || note?.requester_role || note?.sourceRole || note?.source_role || '').trim().toLowerCase();
  if (role === 'queen') return true;
  const agentType = String(note?.agentType || note?.agent_type || note?.type || '').trim().toLowerCase();
  if (agentType === 'queen') return true;
  const agentId = String(note?.agentId || note?.agent_id || '').trim();
  const queenId = String(note?.queenId || note?.queen_id || '').trim();
  return !!agentId && !!queenId && agentId === queenId;
}

function routePendingNotifications({
  pendingRoot = ROOT,
  paneSpecs,
  statusByAgent,
  tmux,
  deliverLine,
  state,
  now,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  dryRun,
  processed,
  logPath,
}) {
  const file = pendingNotificationsFile(pendingRoot);
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }

  const survivors = [];
  const queuedDedupe = new Set();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let note = null;
    try {
      note = JSON.parse(trimmed);
    } catch {
      survivors.push(line);
      continue;
    }
    if (!note || !note.summary) {
      survivors.push(line);
      continue;
    }
    const permissionWake = isPermissionWakeNotification(note);
    const queenPermission = permissionWake && isQueenPermissionNotification(note);
    if (permissionWake && !queenPermission) {
      const record = {
        ok: true,
        agent: null,
        event: {
          agent: null,
          kind: 'legacy_permission_wake_dropped',
          reason: 'permission denials are queen-reviewed through hive-local permission request logs; tmux watcher must not spam Codex or Claude panes',
          fingerprint: notificationKey(note),
          taskId: note.taskId,
          hiveId: note.hiveId,
          sourceKind: note.kind,
        },
        dryRun,
        text: String(note.summary || ''),
        handledAt: new Date(now).toISOString(),
      };
      processed.push(record);
      if (logPath) appendLog(record, logPath);
      if (dryRun) survivors.push(line);
      continue;
    }
    if (!queenPermission && note.kind !== 'task' && note.kind !== 'hive' && note.kind !== 'task-check' && note.kind !== 'hive-check') {
      survivors.push(line);
      continue;
    }

    const key = notificationKey(note);
    if (!queenPermission) {
      const text = buildCompletionText(note);
      const queueKey = queuedMessageDedupeKey('hive-flow-local', text);
      if (queuedDedupe.has(queueKey)) continue;
      queuedDedupe.add(queueKey);
      const resolution = resolveCompletionNotificationDelivery(note, paneSpecs, pendingRoot);
      if (!resolution.ok) {
        const record = {
          ok: true,
          agent: null,
          event: {
            agent: null,
            kind: 'hive_flow_completion_quarantined',
            reason: resolution.reason,
            fingerprint: key,
            taskId: note.taskId,
            hiveId: note.hiveId,
            sourceKind: note.kind,
            ownerTargetAgent: resolution.owner?.targetAgent || null,
            ownerSessionId: resolution.owner?.ownerSessionId || null,
            ownerClientKind: resolution.owner?.ownerClientKind || null,
            ownerSource: resolution.owner?.source || null,
            ownerSessionSource: resolution.owner?.ownerSessionSource || null,
            currentSessionId: resolution.currentSession?.sessionId || null,
            currentSessionSource: resolution.currentSession?.source || null,
          },
          dryRun,
          text,
          handledAt: new Date(now).toISOString(),
        };
        processed.push(record);
        if (logPath) appendLog(record, logPath);
        if (dryRun) survivors.push(line);
        continue;
      }

      const targetAgent = resolution.targetAgent;
      const status = statusByAgent.get(targetAgent);
      if (!status || status.active || status.pendingInput) {
        survivors.push(line);
        continue;
      }
      const event = {
        agent: targetAgent,
        kind: 'hive_flow_completion',
        reason: 'Hive Flow queued a completed background task notification for its current owning operator',
        cooldownMs,
        fingerprint: key,
        taskId: note.taskId,
        hiveId: note.hiveId,
        sourceKind: note.kind,
        ownerSessionId: resolution.owner.ownerSessionId,
        ownerClientKind: resolution.owner.ownerClientKind || null,
        ownerSource: resolution.owner.source || null,
        ownerSessionSource: resolution.owner.ownerSessionSource || null,
        currentSessionId: resolution.currentSession?.sessionId || null,
        currentSessionSource: resolution.currentSession?.source || null,
        ownerSessionValidated: Boolean(resolution.currentSession?.sessionId),
      };
      if (shouldSuppressDelivery(state, event, targetAgent, text, now, event.cooldownMs, { record: !dryRun })) continue;
      let delivery;
      try {
        delivery = deliverLine
          ? deliverLine(targetAgent, text, status)
          : { clearCopyModeBeforeSend: false };
        if (!deliverLine && !dryRun) tmux.sendLine(targetAgent, text);
      } catch (err) {
        clearDeliveryCooldown(state, event, targetAgent, text);
        survivors.push(line);
        const record = {
          ok: false,
          pane: status.pane,
          agent: targetAgent,
          event,
          dryRun,
          text,
          error: err?.message || String(err),
          handledAt: new Date(now).toISOString(),
        };
        processed.push(record);
        if (logPath) appendLog(record, logPath);
        continue;
      }
      const record = {
        ok: true,
        pane: status.pane,
        agent: targetAgent,
        event,
        clearCopyModeBeforeSend: delivery.clearCopyModeBeforeSend,
        dryRun,
        text,
        handledAt: new Date(now).toISOString(),
      };
      processed.push(record);
      if (logPath) appendLog(record, logPath);
      continue;
    }

    const text = `Hive Flow queen permission escalation detected:\n${String(note.summary || '').trim()}\nQueen-level permission requests currently require Codex/Claude operator adjudication; review the hive/queen context, respond with the concrete decision or handoff, and do not let worker permission-denial spam bypass the queen lifecycle.`;
    const targetAgent = notificationTargetAgent(note, paneSpecs, pendingRoot);
    const queueKey = queuedMessageDedupeKey(targetAgent, text);
    if (queuedDedupe.has(queueKey)) continue;
    queuedDedupe.add(queueKey);
    const status = targetAgent ? statusByAgent.get(targetAgent) : null;
    if (!targetAgent || !status || status.active || status.pendingInput) {
      survivors.push(line);
      continue;
    }
    const event = {
      agent: targetAgent,
      kind: 'queen_permission_escalation',
      reason: 'Hive Flow queued a queen-level permission request that has no higher queen response path',
      cooldownMs: MIN_PERMISSION_SEND_COOLDOWN_MS,
      fingerprint: key,
      taskId: note.taskId,
      hiveId: note.hiveId,
      sourceKind: note.kind,
    };
    if (shouldSuppressDelivery(state, event, targetAgent, text, now, event.cooldownMs, { record: !dryRun })) continue;
    let delivery;
    try {
      delivery = deliverLine
        ? deliverLine(targetAgent, text, status)
        : { clearCopyModeBeforeSend: false };
      if (!deliverLine && !dryRun) tmux.sendLine(targetAgent, text);
    } catch (err) {
      clearDeliveryCooldown(state, event, targetAgent, text);
      survivors.push(line);
      const record = {
        ok: false,
        pane: status.pane,
        agent: targetAgent,
        event,
        dryRun,
        text,
        error: err?.message || String(err),
        handledAt: new Date(now).toISOString(),
      };
      processed.push(record);
      if (logPath) appendLog(record, logPath);
      continue;
    }
    const record = {
      ok: true,
      pane: status.pane,
      agent: targetAgent,
      event,
      clearCopyModeBeforeSend: delivery.clearCopyModeBeforeSend,
      dryRun,
      text,
      handledAt: new Date(now).toISOString(),
    };
    processed.push(record);
    if (logPath) appendLog(record, logPath);
  }

  if (dryRun) return;
  try {
    if (survivors.length === 0) {
      fs.unlinkSync(file);
    } else {
      fs.writeFileSync(file, `${survivors.join('\n')}\n`, 'utf8');
    }
  } catch {
    // Fail-open: notification delivery must never break watchdog routing.
  }
}

function routePendingRouterHandoffs({
  routerDir = ROUTER_DIR,
  paneSpecs,
  statusByAgent,
  deliverLine,
  state,
  now,
  dryRun,
  processed,
  logPath,
  minMtimeMs = 0,
}) {
  const queuedDedupe = new Set();
  for (const handoff of pendingRouterHandoffs(routerDir, paneSpecs)) {
    if (Number(handoff.mtimeMs || 0) <= Number(minMtimeMs || 0)) continue;
    if (handoffNoticeSent(routerDir, handoff.filePath)) continue;
    const status = statusByAgent.get(handoff.targetAgent);
    if (!status || status.active || status.pendingInput) continue;

    const contentFingerprint = routerHandoffContentFingerprint(handoff.filePath);
    const queueKey = `${handoff.targetAgent}:${contentFingerprint}`;
    const duplicateInCurrentDrain = queuedDedupe.has(queueKey);
    const duplicateContent = hasSeenRouterHandoffContent(state, handoff.targetAgent, contentFingerprint);
    if (duplicateInCurrentDrain || duplicateContent) {
      recordRouterHandoffDuplicate(state, handoff.targetAgent, contentFingerprint, now);
      if (!dryRun) markHandoffNoticeSent(routerDir, handoff.filePath, now);
      continue;
    }
    queuedDedupe.add(queueKey);
    const text = buildRouterHandoffNotice(handoff.filePath, handoff.targetAgent);
    const event = {
      agent: handoff.targetAgent,
      kind: 'router_handoff_notice',
      reason: 'pending router handoff file is more specific than a generic idle/deadlock nudge',
      fingerprint: `router-handoff:${path.basename(handoff.filePath)}`,
      contentFingerprint,
      handoffFile: handoff.filePath,
    };
    let delivery;
    try {
      delivery = deliverLine
        ? deliverLine(handoff.targetAgent, text, status)
        : { clearCopyModeBeforeSend: false };
    } catch (err) {
      const record = {
        ok: false,
        pane: status.pane,
        agent: handoff.targetAgent,
        event,
        dryRun,
        text,
        error: err?.message || String(err),
        handledAt: new Date(now).toISOString(),
      };
      processed.push(record);
      if (logPath) appendLog(record, logPath);
      continue;
    }
    if (!dryRun) {
      markRouterHandoffContentSeen(state, handoff.targetAgent, contentFingerprint, now);
      markHandoffNoticeSent(routerDir, handoff.filePath, now);
    }

    const record = {
      ok: true,
      pane: status.pane,
      agent: handoff.targetAgent,
      event,
      clearCopyModeBeforeSend: delivery.clearCopyModeBeforeSend,
      dryRun,
      text,
      handledAt: new Date(now).toISOString(),
    };
    processed.push(record);
    if (logPath) appendLog(record, logPath);
  }
}

function runOnce({
  panes,
  tmux = realTmux,
  lines = DEFAULT_LINES,
  state = createWatchState(),
  now = Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
  dryRun = false,
  logPath = null,
  routerDir = null,
  pendingNotificationsRoot = defaultPendingNotificationsRoot(),
  tasksDir = path.join(ROOT, '.hive-flow', 'tasks'),
  idleStallMs = DEFAULT_IDLE_STALL_MS,
  stopHookStallMs = DEFAULT_STOP_HOOK_STALL_MS,
  stopHookFollowUpMs = DEFAULT_STOP_HOOK_FOLLOW_UP_MS,
  claudeSlotAgentKind = null,
  quotaHotswapFallback = quotaHotswapFallbackKind(),
  quotaHotswapThresholdMs = DEFAULT_QUOTA_HOTSWAP_THRESHOLD_MS,
  quotaHotswapRetryWindowMs = quotaHotswapRetryMs(),
} = {}) {
  const processed = [];
  const statuses = [];
  const observedStopHookKeys = new Set();
  const paneSpecs = normalizePanes(panes || []);
  const snapshots = new Map();
  const cursors = new Map();
  const statusByPane = new Map();
  const statusByAgent = new Map();
  function deliverLine(targetAgent, text, targetStatus = null, { escapeBeforeSend = false } = {}) {
    const status = targetStatus || statusByAgent.get(targetAgent) || null;
    const clearCopyModeBeforeSend = isTmuxCopyMode(status);
    if (!dryRun) {
      if (clearCopyModeBeforeSend && typeof tmux.clearPaneMode === 'function') {
        tmux.clearPaneMode(targetAgent, status.pane);
      }
      if (escapeBeforeSend && typeof tmux.sendEscape === 'function') {
        tmux.sendEscape(targetAgent, status?.pane);
      }
      tmux.sendLine(targetAgent, text);
    }
    return { clearCopyModeBeforeSend, escapeBeforeSend };
  }
  function dispatchEvent({ paneSpec, event, text, targetAgent = event.agent }) {
    if (isMuted(state, event, now)) return null;
    const eventCooldownMs = Number.isFinite(event.cooldownMs) ? event.cooldownMs : cooldownMs;
    if (shouldSuppressDelivery(state, event, targetAgent, text, now, eventCooldownMs, { record: !dryRun })) return null;
    const escapeBeforeSend = shouldEscapeBeforeOperationalNudge(event, targetAgent, paneSpec);
    const targetStatus = statusByAgent.get(targetAgent) || (targetAgent === paneSpec.name ? statusByPane.get(paneSpec.pane) : null);
    const delivery = deliverLine(targetAgent, text, targetStatus, { escapeBeforeSend });
    const record = {
      ok: true,
      pane: targetStatus?.pane || (targetAgent === paneSpec.name ? paneSpec.pane : null),
      agent: targetAgent,
      subjectAgent: event.subjectAgent || event.agent,
      subjectPane: paneSpec.pane,
      event,
      escapeBeforeSend: delivery.escapeBeforeSend,
      clearCopyModeBeforeSend: delivery.clearCopyModeBeforeSend,
      dryRun,
      text,
      handledAt: new Date(now).toISOString(),
    };
    processed.push(record);
    if (logPath) appendLog(record, logPath);
    return record;
  }
  for (const paneSpec of paneSpecs) {
    const snapshot = tmux.capturePane(paneSpec.pane, lines);
    const cursor = typeof tmux.cursor === 'function' ? tmux.cursor(paneSpec.pane) : null;
    const paneMode = typeof tmux.paneMode === 'function' ? tmux.paneMode(paneSpec.pane) : null;
    snapshots.set(paneSpec.pane, snapshot);
    cursors.set(paneSpec.pane, cursor);
    const status = classifyPaneStatus(snapshot, { agent: paneSpec.name, cursor });
    const enrichedStatus = { ...status, pane: paneSpec.pane, paneMode };
    statuses.push(enrichedStatus);
    statusByPane.set(paneSpec.pane, enrichedStatus);
    statusByAgent.set(paneSpec.name, enrichedStatus);
  }
  const automationDispatchHeld = shouldHoldAutomationDispatch(statuses);
  const compactRecoveryHeld = statuses.some((status) => status.compactRecovery);
  const quiet = quietStatus(state, now);
  const terminalState = activeRouterTerminalState(routerDir);
  // hive-flow-8b69 Slice 5 (P2-SL4): a newest human-gate blocker floors router handoffs and
  // globally suppresses the nag paths below, symmetric to COMPLETE_NO_ACTION. Because it only
  // fires when the blocker is the NEWEST note, a newer non-terminal handoff overrides it.
  const humanBlocker = activeRouterHumanBlocker(routerDir);
  const routerHandoffFloor = Math.max(
    terminalState ? Number(terminalState.mtimeMs || 0) : 0,
    humanBlocker ? Number(humanBlocker.mtimeMs || 0) : 0,
    quiet.quiet ? Number(quiet.mutedAt || 0) : 0,
  );
  const deliverableRouterHandoffExists = !compactRecoveryHeld
    && pendingRouterHandoffs(routerDir, paneSpecs).some((handoff) => {
      if (Number(handoff.mtimeMs || 0) <= routerHandoffFloor) return false;
      const status = statusByAgent.get(handoff.targetAgent);
      return status && !status.active && !status.pendingInput;
    });
  if (quiet.quiet && deliverableRouterHandoffExists) {
    resumeWatchdog(state, { now });
    state.control = {
      ...(state.control || {}),
      lastAutoResumeAt: now,
      lastAutoResumeReason: 'newer pending router handoff',
    };
  }

  if (!compactRecoveryHeld) {
    const beforeRouterHandoffCount = processed.length;
    routePendingRouterHandoffs({
      routerDir,
      paneSpecs,
      statusByAgent,
      deliverLine,
      state,
      now,
      dryRun,
      processed,
      logPath,
      minMtimeMs: routerHandoffFloor,
    });
    if (processed.length > beforeRouterHandoffCount) return processed;
  }

  if (quiet.quiet && !deliverableRouterHandoffExists) return processed;
  if (terminalState) return processed;
  // hive-flow-8b69 Slice 5 (P2-SL4): global suppression under a newest human-gate blocker —
  // no pane nudges, notifications, task-liveness, or deadlock nudges fire. Newer handoffs are
  // already delivered above (they win the newest-note check, so humanBlocker is null then).
  if (humanBlocker) return processed;
  if (!compactRecoveryHeld) {
    routePendingNotifications({
      pendingRoot: pendingNotificationsRoot,
      paneSpecs,
      statusByAgent,
      tmux,
      deliverLine,
      state,
      now,
      cooldownMs,
      dryRun,
      processed,
      logPath,
    });
  }

  for (const paneSpec of paneSpecs) {
    const snapshot = snapshots.get(paneSpec.pane) || '';
    const status = statusByPane.get(paneSpec.pane);
    if (status.stopHooksStuck) {
      const event = {
        agent: paneSpec.name,
        kind: 'claude_stop_hooks_escape',
        reason: 'Claude appears stuck at stop hooks 9/10 and is not waiting on an agent',
        fingerprint: fingerprint(snapshot, 'claude_stop_hooks_escape'),
        staleKey: stableIdleFingerprint(paneSpec.name, 'stop-hooks-9-of-10', 'claude_stop_hooks_escape'),
        suppressKey: stableIdleFingerprint(paneSpec.name, 'stop-hooks-9-of-10', 'claude_stop_hooks_escape'),
        excerpt: nonEmptyTail(snapshot, 10).join('\n'),
        followUpAfterMs: stopHookFollowUpMs,
      };
      observedStopHookKeys.add(staleEventKey(event));
      if (!staleIdleEventReady(state, event, now, stopHookStallMs)) continue;
      if (isMuted(state, event, now)) continue;
      const text = 'Sent Escape to Claude because stop hooks stayed at 9/10 without a native or Hive Flow agent wait.';
      if (shouldSuppressDelivery(state, event, paneSpec.name, text, now, cooldownMs, { record: !dryRun })) continue;
      if (!dryRun && typeof tmux.sendEscape === 'function') tmux.sendEscape(paneSpec.name, paneSpec.pane);
      const record = {
        ok: true,
        pane: paneSpec.pane,
        agent: paneSpec.name,
        event,
        dryRun,
        text,
        handledAt: new Date(now).toISOString(),
      };
      processed.push(record);
      if (logPath) appendLog(record, logPath);
      continue;
    }
    if (automationDispatchHeld) continue;
    const event = classifyPane(snapshot, { agent: paneSpec.name, cursor: cursors.get(paneSpec.pane) });
    if (!event) {
      if (status.declaredIntent) {
        const staleEvent = {
          agent: paneSpec.name,
          kind: 'stalled_declared_intent',
          reason: 'pane is idle after declaring immediate work',
          fingerprint: fingerprint(snapshot, 'stalled_declared_intent'),
          staleKey: status.stableFingerprint,
          suppressKey: status.stableFingerprint,
          excerpt: status.excerpt,
        };
        if (!staleIdleEventReady(state, staleEvent, now, idleStallMs)) continue;
        const text = buildNudge(staleEvent);
        dispatchEvent({ paneSpec, event: staleEvent, text, targetAgent: paneSpec.name });
      }
      continue;
    }

    if (isOperationalEvent(event)) {
      const hotswapPlan = buildClaudeQuotaHotswapPlan(event, {
        now,
        state,
        root: pendingNotificationsRoot,
        claudeSlotAgentKind,
        fallbackKind: quotaHotswapFallback,
        thresholdMs: quotaHotswapThresholdMs,
      });
      if (hotswapPlan) {
        if (quotaHotswapSuppressed(state, hotswapPlan, now, quotaHotswapRetryWindowMs)) continue;
        recordQuotaHotswapAttempt(state, hotswapPlan, now, {
          status: dryRun ? 'dry-run' : 'attempting',
        });
        const hotswapEvent = {
          ...event,
          kind: 'claude_quota_hotswap',
          reason: 'Claude quota reset is beyond the automatic replacement threshold',
          fallbackKind: hotswapPlan.fallbackKind,
          currentKind: hotswapPlan.currentKind,
          observedAtMs: hotswapPlan.observedAtMs,
          resetAtMs: hotswapPlan.resetAtMs,
          resetDelayMs: hotswapPlan.resetDelayMs,
          thresholdMs: hotswapPlan.thresholdMs,
          timeZone: hotswapPlan.timeZone,
          suppressKey: hotswapPlan.attemptKey,
          fingerprint: hotswapPlan.attemptKey,
        };
        const text = `Auto hot-swap: Claude quota appears exhausted until ${event.resetHint}; reset is more than ${Math.round(hotswapPlan.thresholdMs / 60 / 60_000)} hours away, so the Claude/verifier slot is being replaced with ${claudeSlotDisplayName(hotswapPlan.fallbackKind)}.`;
        const record = {
          ok: true,
          pane: paneSpec.pane,
          agent: paneSpec.name,
          subjectAgent: event.subjectAgent || event.agent,
          subjectPane: paneSpec.pane,
          event: hotswapEvent,
          dryRun,
          text,
          handledAt: new Date(now).toISOString(),
        };
        if (!dryRun) {
          try {
            record.output = typeof tmux.hotswapClaudeSlot === 'function'
              ? String(tmux.hotswapClaudeSlot(hotswapPlan.fallbackKind) || '').trim()
              : '';
            recordQuotaHotswapAttempt(state, hotswapPlan, now, { status: 'ok', increment: false });
          } catch (err) {
            record.ok = false;
            record.error = err?.message || String(err);
            recordQuotaHotswapAttempt(state, hotswapPlan, now, {
              status: 'failed',
              error: record.error,
              increment: false,
            });
          }
        }
        processed.push(record);
        if (logPath) appendLog(record, logPath);
        continue;
      }
      const routed = routeOperationalEvent(event, state, now);
      dispatchEvent({
        paneSpec,
        event: routed.event,
        text: routed.text,
        targetAgent: routed.targetAgent,
      });
      continue;
    }

    if (event.kind === 'question_adjudication' || event.kind === 'human_gate_adjudication') {
      dispatchEvent({
        paneSpec,
        event,
        text: buildAdjudicationNudge(event),
        targetAgent: opposingAgent(paneSpec.name),
      });
    } else {
      dispatchEvent({ paneSpec, event, text: buildNudge(event), targetAgent: paneSpec.name });
    }
  }

  pruneMissingStopHookTimers(state, observedStopHookKeys);

  // hive-flow-8b69 Slice 4: task-liveness pass. Placed after the quiet / router-handoff /
  // COMPLETE_NO_ACTION early returns above, and additionally suppressed under a
  // BLOCKED_TRUE_HUMAN_GATE router blocker (not yet a global early return — Slice 5), so it
  // never introduces a dispatch path under that marker. Runs before the generic deadlock
  // nudge so a task recovery/review dispatch naturally de-noises the all-idle fallback.
  if (!hasActiveRouterHumanBlocker(routerDir)) {
    runTaskLivenessPass({
      state,
      now,
      root: ROOT,
      tasksDir,
      paneSpecs,
      statuses,
      idleStallMs,
      dispatch: (paneSpec, event, text, targetAgent) => dispatchEvent({ paneSpec, event, text, targetAgent }),
    });
  }

  if (processed.length === 0 && statuses.length > 1 && !automationDispatchHeld) {
    const allIdle = statuses.every((status) => status.idle);
    const anyActive = statuses.some((status) => status.active);
    const anyHumanGate = statuses.some((status) => status.trueHumanGate);
    if (allIdle
      && !anyActive
      && !anyHumanGate
      && !hasActiveRouterHumanBlocker(routerDir)
      && !hasActiveRouterTerminalState(routerDir)) {
      routePendingRouterHandoffs({
        routerDir,
        paneSpecs,
        statusByAgent,
        deliverLine,
        state,
        now,
        dryRun,
        processed,
        logPath,
      });
      if (processed.length > 0) return processed;
      const target = chooseDeadlockTarget(statuses);
      if (target) {
        const event = {
          agent: target.agent,
          kind: 'flow_deadlock',
          reason: 'all watched panes are idle and no active owner is obvious',
          fingerprint: crypto.createHash('sha256')
            .update(statuses.map((status) => `${status.agent}:${status.fingerprint}`).join('\n'))
            .digest('hex'),
          staleKey: crypto.createHash('sha256')
            .update(statuses.map((status) => `${status.agent}:${status.stableFingerprint}`).join('\n'))
            .digest('hex'),
          excerpt: statuses.map((status) => `${status.agent}: ${status.excerpt}`).join('\n---\n'),
        };
        event.suppressKey = event.staleKey;
        const text = buildNudge(event);
        if (staleIdleEventReady(state, event, now, idleStallMs)
          && !shouldSuppressDelivery(state, event, target.agent, text, now, cooldownMs, { record: !dryRun })) {
          const delivery = deliverLine(target.agent, text, target);
          const record = {
            ok: true,
            pane: target.pane,
            agent: target.agent,
            event,
            clearCopyModeBeforeSend: delivery.clearCopyModeBeforeSend,
            dryRun,
            text,
            handledAt: new Date(now).toISOString(),
          };
          processed.push(record);
          if (logPath) appendLog(record, logPath);
        }
      }
    }
  }
  return processed;
}

function explainOnce({ panes, tmux = realTmux, lines = DEFAULT_LINES } = {}) {
  const statuses = [];
  for (const paneSpec of normalizePanes(panes || [])) {
    const snapshot = tmux.capturePane(paneSpec.pane, lines);
    const cursor = typeof tmux.cursor === 'function' ? tmux.cursor(paneSpec.pane) : null;
    const status = classifyPaneStatus(snapshot, { agent: paneSpec.name, cursor });
    const event = classifyPane(snapshot, { agent: paneSpec.name, cursor });
    statuses.push({
      pane: paneSpec.pane,
      agent: paneSpec.name,
      cursor,
      idle: status.idle,
      active: status.active,
      pendingInput: status.pendingInput,
      agentWait: status.agentWait,
      stopHooksStuck: status.stopHooksStuck,
      enforcementHalted: status.enforcementHalted,
      trueHumanGate: status.trueHumanGate,
      declaredIntent: status.declaredIntent,
      fingerprint: status.fingerprint,
      stableFingerprint: status.stableFingerprint,
      stableText: normalizeStableIdleText(status.excerpt),
      immediateEvent: event ? {
        kind: event.kind,
        reason: event.reason,
        fingerprint: event.fingerprint,
      } : null,
      excerpt: status.excerpt,
    });
  }
  return {
    statuses,
    deadlockCandidate: statuses.length > 1
      && statuses.every((status) => status.idle)
      && !statuses.some((status) => status.active)
      && !statuses.some((status) => status.pendingInput)
      && !statuses.some((status) => status.trueHumanGate),
  };
}

function appendLog(record, logPath = LOG_PATH) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
}

function parseJsonOutput(output, fallback = null) {
  try {
    return JSON.parse(String(output || '').trim() || 'null');
  } catch {
    return fallback;
  }
}

function createKnotsLeaseManager({ root = ROOT } = {}) {
  return {
    listLeases() {
      const output = execFileSync('kno', ['lease', 'list', '--json'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const parsed = parseJsonOutput(output, []);
      return Array.isArray(parsed) ? parsed : [];
    },
    extendLease(leaseId, timeoutSeconds) {
      const output = execFileSync('kno', [
        'lease',
        'extend',
        '--lease-id',
        String(leaseId),
        '--timeout-seconds',
        String(timeoutSeconds),
        '--json',
      ], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return parseJsonOutput(output, { raw: String(output || '') });
    },
    sync() {
      const output = execFileSync('kno', ['sync', '--json'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return parseJsonOutput(output, { raw: String(output || '') });
    },
  };
}

function normalizeKnotsLease(lease, now = Date.now()) {
  if (!lease || typeof lease !== 'object') return null;
  const id = stringValue(lease.id);
  const state = stringValue(lease.state);
  if (!id || state !== 'lease_active') return null;
  const expirySeconds = Number(lease.lease_expiry_ts || lease.leaseExpiryTs || 0);
  const expiryMs = Number.isFinite(expirySeconds) && expirySeconds > 0 ? expirySeconds * 1000 : null;
  return {
    id,
    title: stringValue(lease.title),
    nickname: stringValue(lease.lease?.nickname),
    state,
    timeoutSeconds: Number(lease.lease?.timeout_seconds || lease.lease?.timeoutSeconds || 0) || null,
    expiryMs,
    remainingMs: expiryMs === null ? null : expiryMs - now,
  };
}

function activeKnotsLeases(leases, now = Date.now()) {
  return (Array.isArray(leases) ? leases : [])
    .map((lease) => normalizeKnotsLease(lease, now))
    .filter(Boolean);
}

function knotsLeasesNeedingRenewal(leases, {
  now = Date.now(),
  renewThresholdMs = DEFAULT_KNOTS_LEASE_RENEW_THRESHOLD_MS,
} = {}) {
  return activeKnotsLeases(leases, now)
    .filter((lease) => lease.remainingMs === null || lease.remainingMs <= renewThresholdMs);
}

function recordKnotsMaintenanceControl(state, patch) {
  state.control = { ...(state.control || {}) };
  state.control.knotsLeaseMaintenance = {
    ...(state.control.knotsLeaseMaintenance || {}),
    ...patch,
  };
}

function maintainKnotsLeases({
  state = createWatchState(),
  now = Date.now(),
  leaseManager = createKnotsLeaseManager(),
  maintenanceIntervalMs = DEFAULT_KNOTS_LEASE_MAINTENANCE_INTERVAL_MS,
  renewThresholdMs = DEFAULT_KNOTS_LEASE_RENEW_THRESHOLD_MS,
  renewTimeoutSeconds = DEFAULT_KNOTS_LEASE_RENEW_TIMEOUT_SECONDS,
  dryRun = false,
  logPath = null,
} = {}) {
  const control = state.control?.knotsLeaseMaintenance || {};
  const lastAt = Number(control.lastAt || 0);
  if (lastAt && now - lastAt < maintenanceIntervalMs) return [];

  const records = [];
  recordKnotsMaintenanceControl(state, { lastAt: now });

  try {
    const rawLeases = leaseManager.listLeases();
    const activeLeases = activeKnotsLeases(rawLeases, now);
    const renewals = knotsLeasesNeedingRenewal(rawLeases, { now, renewThresholdMs });
    recordKnotsMaintenanceControl(state, {
      activeLeaseCount: activeLeases.length,
      renewThresholdMs,
      renewTimeoutSeconds,
    });

    for (const lease of renewals) {
      const event = {
        kind: 'knots_lease_renewal',
        reason: 'active Knots leases must not expire while the unattended flow can continue',
        leaseId: lease.id,
        nickname: lease.nickname,
        remainingMs: lease.remainingMs,
        renewThresholdMs,
        renewTimeoutSeconds,
      };
      const record = {
        ok: true,
        agent: null,
        event,
        dryRun,
        handledAt: new Date(now).toISOString(),
      };
      if (!dryRun) {
        try {
          record.result = leaseManager.extendLease(lease.id, renewTimeoutSeconds);
        } catch (err) {
          record.ok = false;
          record.error = err?.message || String(err);
        }
      }
      records.push(record);
    }

    try {
      const syncResult = dryRun ? { status: 'dry-run', active_leases: activeLeases.length } : leaseManager.sync();
      const status = String(syncResult?.status || '').trim();
      const activeLeaseCount = Number(syncResult?.active_leases ?? syncResult?.activeLeases ?? activeLeases.length);
      const record = {
        ok: true,
        agent: null,
        event: {
          kind: status === 'deferred' ? 'knots_sync_deferred_active_leases' : 'knots_sync_maintenance',
          reason: status === 'deferred'
            ? 'kno sync is deferred by active leases; this is nonblocking and router handoffs remain authoritative for flow progress'
            : 'periodic Knots sync maintenance completed',
          status: status || null,
          activeLeases: Number.isFinite(activeLeaseCount) ? activeLeaseCount : activeLeases.length,
        },
        dryRun,
        result: syncResult,
        handledAt: new Date(now).toISOString(),
      };
      records.push(record);
      recordKnotsMaintenanceControl(state, {
        lastSyncStatus: record.event.status,
        lastSyncActiveLeases: record.event.activeLeases,
      });
    } catch (err) {
      const record = {
        ok: false,
        agent: null,
        event: {
          kind: 'knots_sync_maintenance_failed',
          reason: 'Knots sync maintenance failed; pane routing remains fail-open',
        },
        dryRun,
        error: err?.message || String(err),
        handledAt: new Date(now).toISOString(),
      };
      records.push(record);
      recordKnotsMaintenanceControl(state, { lastSyncStatus: 'failed', lastSyncError: record.error });
    }
  } catch (err) {
    const record = {
      ok: false,
      agent: null,
      event: {
        kind: 'knots_lease_maintenance_failed',
        reason: 'Knots lease maintenance failed; pane routing remains fail-open',
      },
      dryRun,
      error: err?.message || String(err),
      handledAt: new Date(now).toISOString(),
    };
    records.push(record);
    recordKnotsMaintenanceControl(state, { lastError: record.error });
  }

  for (const record of records) {
    if (logPath) appendLog(record, logPath);
  }
  return records;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function watch({
  panes,
  tmux = realTmux,
  lines = DEFAULT_LINES,
  intervalMs = DEFAULT_INTERVAL_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  idleStallMs = DEFAULT_IDLE_STALL_MS,
  stopHookStallMs = DEFAULT_STOP_HOOK_STALL_MS,
  stopHookFollowUpMs = DEFAULT_STOP_HOOK_FOLLOW_UP_MS,
  stateFile = STATE_PATH,
  logPath = LOG_PATH,
  routerDir = ROUTER_DIR,
  leaseManager = createKnotsLeaseManager(),
  knotsLeaseMaintenanceIntervalMs = DEFAULT_KNOTS_LEASE_MAINTENANCE_INTERVAL_MS,
  knotsLeaseRenewThresholdMs = DEFAULT_KNOTS_LEASE_RENEW_THRESHOLD_MS,
  knotsLeaseRenewTimeoutSeconds = DEFAULT_KNOTS_LEASE_RENEW_TIMEOUT_SECONDS,
  dryRun = false,
  signal,
} = {}) {
  const state = loadWatchState(stateFile);
  while (!signal?.aborted) {
    try {
      mergeWatchState(state, loadWatchState(stateFile));
      maintainKnotsLeases({
        state,
        leaseManager,
        maintenanceIntervalMs: knotsLeaseMaintenanceIntervalMs,
        renewThresholdMs: knotsLeaseRenewThresholdMs,
        renewTimeoutSeconds: knotsLeaseRenewTimeoutSeconds,
        dryRun,
        logPath,
      });
      const processed = runOnce({
        panes,
        tmux,
        lines,
        state,
        cooldownMs,
        idleStallMs,
        stopHookStallMs,
        stopHookFollowUpMs,
        dryRun,
        logPath,
        routerDir,
      });
      saveWatchState(state, stateFile, { mergeExisting: true });
      const stopHookEscape = processed.find((record) => record.event?.kind === 'claude_stop_hooks_escape');
      if (stopHookEscape && !signal?.aborted) {
        await sleep(stopHookEscape.event.followUpAfterMs || stopHookFollowUpMs);
        mergeWatchState(state, loadWatchState(stateFile));
        runOnce({
          panes,
          tmux,
          lines,
          state,
          cooldownMs,
          idleStallMs,
          stopHookStallMs,
          stopHookFollowUpMs,
          dryRun,
          logPath,
          routerDir,
        });
        saveWatchState(state, stateFile, { mergeExisting: true });
      }
    } catch (err) {
      appendLog({ ok: false, error: err.message, handledAt: new Date().toISOString() }, logPath);
    }
    await sleep(intervalMs);
  }
}

function fakeTmux(capturesByPane) {
  const sent = [];
  const escapes = [];
  return {
    sent,
    escapes,
    capturePane(pane) {
      return capturesByPane[pane] || '';
    },
    sendLine(agent, text) {
      sent.push({ agent, text });
    },
    sendEscape(agent, pane) {
      escapes.push({ agent, pane });
    },
  };
}

const DEBUG_SCENARIOS = {
  claude_question: [
    '⏺ I found the next task.',
    'Should I ask the user what to do next?',
    '',
    '────────────────────────────────────────────────────────── HIVE-FLOW-CORE ──',
    '❯ ',
  ].join('\n'),
  active_question: [
    '⏺ Checking whether the resolver test is correct?',
    '✳ Herding… (running stop hooks… 10/10 · 1m 20s)',
    '────────────────────────────────────────────────────────── HIVE-FLOW-CORE ──',
    '❯ ',
  ].join('\n'),
  compact_recovery: [
    '⏺ I am in compaction recovery and cannot determine the summary.',
    'What should I say to get past the recovery gate?',
    '────────────────────────────────────────────────────────── HIVE-FLOW-CORE ──',
    '❯ ',
  ].join('\n'),
  stalled_intent: [
    '⏺ I found the next handoff.',
    'I’m going to read it now, verify the constraints, and continue the implementation.',
    '────────────────────────────────────────────────────────── HIVE-FLOW-CORE ──',
    '❯ ',
  ].join('\n'),
  plain_idle_claude: [
    '⏺ Ready.',
    '────────────────────────────────────────────────────────── HIVE-FLOW-CORE ──',
    '❯ ',
  ].join('\n'),
  plain_idle_codex: [
    '• Tests passed for the previous slice.',
    '› Explain this codebase',
    '  gpt-5.5 xhigh · Context 17% left',
  ].join('\n'),
  native_agent_wait: [
    '⏺ Agent is running in the background.',
    '────────────────────────────────────────────────────────── HIVE-FLOW-CORE ──',
    '❯ ',
    '⏺ main                                                                                                                     ↑/↓ to select · Enter to view',
    '◯ general-purpose  Wait 1 min then print hello world (sonnet)                                                                        8s · ↓ 33.1k tokens',
  ].join('\n'),
  stop_hooks_9: [
    '⏺ Done with this response.',
    '✻ Sketching… (running stop hooks… 9/10 · 4m 40s · ↓ 10.9k tokens)',
    '────────────────────────────────────────────────────────── HIVE-FLOW-CORE ──',
    '❯ ',
  ].join('\n'),
  quota_limit: [
    '⏺ Claude usage limit reached. Your quota will reset at 7:30 PM.',
    'I cannot continue until then.',
    '────────────────────────────────────────────────────────── HIVE-FLOW-CORE ──',
    '❯ ',
  ].join('\n'),
  quota_limit_long_reset: [
    '⏺ You’ve hit your weekly limit · resets 12pm',
    '   (America/Chicago)',
    '   /usage-credits to finish what you’re working on.',
    '────────────────────────────────────────────────────────── HIVE-FLOW-CORE ──',
    '❯ ',
  ].join('\n'),
  rate_limit: [
    '⏺ Rate limit exceeded. Retry after 90 seconds.',
    '────────────────────────────────────────────────────────── HIVE-FLOW-CORE ──',
    '❯ ',
  ].join('\n'),
  api_error: [
    '⏺ API error: upstream server returned 503 temporarily unavailable.',
    '────────────────────────────────────────────────────────── HIVE-FLOW-CORE ──',
    '❯ ',
  ].join('\n'),
  auth_required: [
    '⏺ Authentication required. Please log in to continue.',
    '────────────────────────────────────────────────────────── HIVE-FLOW-CORE ──',
    '❯ ',
  ].join('\n'),
  watchdog_api_quote: [
    '• Messages to be submitted after next tool call (press esc to interrupt and send immediately)',
    '↳ Unattended automation correction: transient API/transport error detected.',
    'Retry the failed operation if it is idempotent and still relevant.',
    'Visible excerpt:',
    '✻ API error · Retrying in 0s · attempt 1/10',
    '',
    '› Use /skills to list available skills',
    '  gpt-5.5 xhigh · Context 17% left',
  ].join('\n'),
  search_mentions_rate_limit: [
    '• Exploring provider concurrency.',
    '  └ Search max.*concurr|concurr.*provider|provider.*limit|rate',
    '           limit|rateLimit|slots|queue|providerPool',
    '',
    '◦ Working (9m 18s • esc to interrupt)',
  ].join('\n'),
  enforcement_halted: [
    '⏺ Confirmed — I am now globally HALTED.',
    'Reset is human-only; no agent can clear it.',
    '────────────────────────────────────────────────────────── HIVE-FLOW-CORE ──',
    '❯ ',
    '────────────────────────────────────────────────────────────────────────────',
    '  ► ENFORCEMENT ON (HALTED) · daemon on · data fresh 0s',
  ].join('\n'),
};

function runDebugScenario(name) {
  if (name === 'native_agent_wait') {
    const tmux = fakeTmux({ '%claude': DEBUG_SCENARIOS.native_agent_wait });
    const processed = runOnce({
      panes: [{ name: 'claude', pane: '%claude' }],
      tmux,
      state: createWatchState(),
      now: 1000,
      idleStallMs: 1,
      stopHookStallMs: 1,
    });
    const explanation = explainOnce({
      panes: [{ name: 'claude', pane: '%claude' }],
      tmux,
    });
    return { scenario: name, explanation, processed, sent: tmux.sent, escapes: tmux.escapes };
  }

  if (name === 'stop_hooks_escape') {
    const tmux = fakeTmux({ '%claude': DEBUG_SCENARIOS.stop_hooks_9 });
    const state = createWatchState();
    runOnce({
      panes: [{ name: 'claude', pane: '%claude' }],
      tmux,
      state,
      now: 1000,
      stopHookStallMs: 5 * 60_000,
    });
    const processed = runOnce({
      panes: [{ name: 'claude', pane: '%claude' }],
      tmux,
      state,
      now: 5 * 60_000 + 1001,
      stopHookStallMs: 5 * 60_000,
    });
    return { scenario: name, processed, sent: tmux.sent, escapes: tmux.escapes };
  }

  if (name === 'flow_deadlock') {
    const tmux = fakeTmux({
      '%claude': DEBUG_SCENARIOS.plain_idle_claude,
      '%codex': DEBUG_SCENARIOS.plain_idle_codex,
    });
    const state = createWatchState();
    runOnce({
      panes: [{ name: 'claude', pane: '%claude' }, { name: 'codex', pane: '%codex' }],
      tmux,
      state,
      now: 1000,
      idleStallMs: 60_000,
    });
    const processed = runOnce({
      panes: [{ name: 'claude', pane: '%claude' }, { name: 'codex', pane: '%codex' }],
      tmux,
      state,
      now: 62_000,
      idleStallMs: 60_000,
    });
    return { scenario: name, processed, sent: tmux.sent };
  }

  if (name === 'watchdog_api_quote' || name === 'search_mentions_rate_limit') {
    const agent = name === 'watchdog_api_quote' ? 'codex' : 'codex';
    const pane = '%codex';
    const tmux = fakeTmux({ [pane]: DEBUG_SCENARIOS[name] });
    const state = createWatchState();
    const panes = [{ name: agent, pane }];
    const processed = runOnce({
      panes,
      tmux,
      state,
      now: 1000,
      cooldownMs: 0,
      idleStallMs: 1,
    });
    const explanation = explainOnce({ panes, tmux });
    return { scenario: name, explanation, processed, sent: tmux.sent, escapes: tmux.escapes };
  }

  const snapshot = DEBUG_SCENARIOS[name];
  if (!snapshot) throw new Error(`unknown debug scenario: ${name}`);
  const tmux = fakeTmux({ '%claude': snapshot, '%codex': DEBUG_SCENARIOS.plain_idle_codex });
  const state = createWatchState();
  let processed = runOnce({
    panes: [{ name: 'claude', pane: '%claude' }, { name: 'codex', pane: '%codex' }],
    tmux,
    state,
    now: 1000,
    idleStallMs: 60_000,
  });
  if (name === 'stalled_intent') {
    processed = runOnce({
      panes: [{ name: 'claude', pane: '%claude' }, { name: 'codex', pane: '%codex' }],
      tmux,
      state,
      now: 62_000,
      idleStallMs: 60_000,
    });
  }
  return { scenario: name, processed, sent: tmux.sent, escapes: tmux.escapes };
}

function parseArgs(argv) {
  const args = { _: [], pane: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
    if (key === 'pane') args.pane.push(value);
    else args[key] = value;
  }
  return args;
}

function usage() {
  return [
    'Usage:',
    '  node flow-watchdog.cjs explain --pane claude=%3 --pane codex=%0',
    '  node flow-watchdog.cjs once --pane claude=%3 --pane codex=%0 [--dry-run]',
    '  node flow-watchdog.cjs watch --pane claude=%3 --pane codex=%0 [--interval-ms 30000]',
    '  node flow-watchdog.cjs quiet [--minutes N] [--reason "all tasks complete"]',
    '  node flow-watchdog.cjs resume',
    '  node flow-watchdog.cjs status',
    '  node flow-watchdog.cjs leases [--dry-run]',
    '  node flow-watchdog.cjs mute --key EVENT_KEY [--minutes 60] [--reason "..."]',
    '  node flow-watchdog.cjs debug --scenario claude_question',
    '',
    'Private tmux-router tooling only. Detects flow-halting performative questions and nudges agents back to router-based coordination.',
    '',
    'Stand-down protocol:',
    '  Done for now: node flow-watchdog.cjs quiet --reason "all tasks/assignments complete"',
    '  Check state:   node flow-watchdog.cjs status',
    '  Automatic resume: newer deliverable router handoffs resume pane sends without operator intervention',
    '  Force wake:     node flow-watchdog.cjs resume',
    '  Temporary:     node flow-watchdog.cjs quiet --minutes 120 --reason "waiting on provider quota"',
    '',
    'Quiet mode suppresses every flow-watchdog pane send: idle nudges, operational retries, enforcement adjudication requests, and pending handoff notifications.',
    'Quiet mode does not stop tmux, Codex, Claude, router-watch, or this watchdog process. Use stop-flow-watchdog or shutdown-session only for resource shutdown.',
    'Knots lease maintenance renews active leases near expiry and treats sync deferral from active leases as nonblocking coordination state.',
  ].join('\n');
}

function operatorCommands() {
  return {
    standDown: `${CONTROL} quiet-flow-watchdog --reason "all tasks/assignments complete"`,
    status: `${CONTROL} status-flow-watchdog`,
    resume: `${CONTROL} resume-flow-watchdog`,
    temporaryQuiet: `${CONTROL} quiet-flow-watchdog --minutes 120 --reason "waiting on provider quota"`,
    fullShutdown: `${CONTROL} shutdown-session`,
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command || command === 'help' || args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (command === 'debug') {
    const result = runDebugScenario(String(args.scenario || 'claude_question'));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'mute' || command === 'silence') {
    const stateFile = String(args['state-file'] || STATE_PATH);
    const state = loadWatchState(stateFile);
    muteKey(state, String(args.key || ''), {
      now: Date.now(),
      minutes: Number(args.minutes || 60),
      reason: String(args.reason || ''),
    });
    saveWatchState(state, stateFile, { mergeExisting: true });
    process.stdout.write(`${JSON.stringify({ ok: true, key: String(args.key || ''), minutes: Number(args.minutes || 60) }, null, 2)}\n`);
    return;
  }

  if (command === 'quiet' || command === 'stand-down' || command === 'silence-all') {
    const stateFile = String(args['state-file'] || STATE_PATH);
    const state = loadWatchState(stateFile);
    const minutes = args.minutes === undefined ? null : Number(args.minutes);
    quietWatchdog(state, {
      now: Date.now(),
      minutes,
      reason: String(args.reason || 'all tasks/assignments complete'),
    });
    saveWatchState(state, stateFile, { mergeExisting: true });
    const status = quietStatus(state, Date.now());
    process.stdout.write(`${JSON.stringify({
      ok: true,
      ...status,
      effect: 'all flow-watchdog pane sends are suppressed until resume or quiet expiry',
      operatorCommands: operatorCommands(),
    }, null, 2)}\n`);
    return;
  }

  if (command === 'resume' || command === 'unquiet' || command === 'wake') {
    const stateFile = String(args['state-file'] || STATE_PATH);
    const state = loadWatchState(stateFile);
    const now = Date.now();
    resumeWatchdog(state, { now });
    saveWatchState(state, stateFile, { mergeExisting: true, now, dropMutedKeys: [GLOBAL_QUIET_KEY] });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      quiet: false,
      effect: 'flow-watchdog pane sends are active again',
      operatorCommands: operatorCommands(),
    }, null, 2)}\n`);
    return;
  }

  if (command === 'status') {
    const stateFile = String(args['state-file'] || STATE_PATH);
    const state = loadWatchState(stateFile);
    const status = quietStatus(state, Date.now());
    saveWatchState(state, stateFile, { mergeExisting: true });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      ...status,
      mutedCount: state.muted.size,
      seenCount: state.seen.size,
      eventCountKeys: state.eventCounts.size,
      knotsLeaseMaintenance: state.control?.knotsLeaseMaintenance || null,
      effect: status.quiet
        ? 'all flow-watchdog pane sends are currently suppressed'
        : 'flow-watchdog pane sends are active',
      operatorCommands: operatorCommands(),
    }, null, 2)}\n`);
    return;
  }

  const panes = normalizePanes(args.pane);
  const lines = args.lines ? Number(args.lines) : DEFAULT_LINES;
  const intervalMs = args['interval-ms']
    ? Number(args['interval-ms'])
    : args['interval-min'] ? Number(args['interval-min']) * 60_000 : DEFAULT_INTERVAL_MS;
  const cooldownMs = args['cooldown-ms']
    ? Number(args['cooldown-ms'])
    : args['cooldown-min'] ? Number(args['cooldown-min']) * 60_000 : DEFAULT_COOLDOWN_MS;
  const idleStallMs = args['idle-stall-ms']
    ? Number(args['idle-stall-ms'])
    : args['idle-stall-min'] ? Number(args['idle-stall-min']) * 60_000 : DEFAULT_IDLE_STALL_MS;
  const stopHookStallMs = args['stop-hook-stall-ms']
    ? Number(args['stop-hook-stall-ms'])
    : args['stop-hook-stall-min'] ? Number(args['stop-hook-stall-min']) * 60_000 : DEFAULT_STOP_HOOK_STALL_MS;
  const stopHookFollowUpMs = args['stop-hook-follow-up-ms']
    ? Number(args['stop-hook-follow-up-ms'])
    : args['stop-hook-follow-up-min'] ? Number(args['stop-hook-follow-up-min']) * 60_000 : DEFAULT_STOP_HOOK_FOLLOW_UP_MS;
  const knotsLeaseMaintenanceIntervalMs = args['knots-lease-maintenance-interval-ms']
    ? Number(args['knots-lease-maintenance-interval-ms'])
    : args['knots-lease-maintenance-interval-min'] ? Number(args['knots-lease-maintenance-interval-min']) * 60_000 : DEFAULT_KNOTS_LEASE_MAINTENANCE_INTERVAL_MS;
  const knotsLeaseRenewThresholdMs = args['knots-lease-renew-threshold-ms']
    ? Number(args['knots-lease-renew-threshold-ms'])
    : args['knots-lease-renew-threshold-min'] ? Number(args['knots-lease-renew-threshold-min']) * 60_000 : DEFAULT_KNOTS_LEASE_RENEW_THRESHOLD_MS;
  const knotsLeaseRenewTimeoutSeconds = args['knots-lease-renew-timeout-seconds']
    ? Number(args['knots-lease-renew-timeout-seconds'])
    : DEFAULT_KNOTS_LEASE_RENEW_TIMEOUT_SECONDS;
  const dryRun = args['dry-run'] === true || args['dry-run'] === 'true';

  if (command === 'explain') {
    const result = explainOnce({ panes, lines });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'once') {
    const state = loadWatchState(String(args['state-file'] || STATE_PATH));
    const processed = runOnce({
      panes,
      lines,
      state,
      cooldownMs,
      idleStallMs,
      stopHookStallMs,
      stopHookFollowUpMs,
      dryRun,
      logPath: String(args['log-path'] || LOG_PATH),
      routerDir: ROUTER_DIR,
    });
    if (!dryRun) {
      saveWatchState(state, String(args['state-file'] || STATE_PATH), { mergeExisting: true });
    }
    process.stdout.write(`${JSON.stringify({ processed: processed.length, records: processed }, null, 2)}\n`);
    return;
  }

  if (command === 'leases' || command === 'lease-maintenance') {
    const stateFile = String(args['state-file'] || STATE_PATH);
    const state = loadWatchState(stateFile);
    const records = maintainKnotsLeases({
      state,
      maintenanceIntervalMs: args.force ? 0 : knotsLeaseMaintenanceIntervalMs,
      renewThresholdMs: knotsLeaseRenewThresholdMs,
      renewTimeoutSeconds: knotsLeaseRenewTimeoutSeconds,
      dryRun,
      logPath: String(args['log-path'] || LOG_PATH),
    });
    saveWatchState(state, stateFile, { mergeExisting: true });
    process.stdout.write(`${JSON.stringify({ processed: records.length, records }, null, 2)}\n`);
    return;
  }

  if (command === 'watch') {
    process.stdout.write(`flow-watchdog active for panes: ${panes.map((pane) => `${pane.name}=${pane.pane}`).join(', ')}; intervalMs=${intervalMs}\n`);
    await watch({
      panes,
      lines,
      intervalMs,
      cooldownMs,
      idleStallMs,
      stopHookStallMs,
      stopHookFollowUpMs,
      dryRun,
      stateFile: String(args['state-file'] || STATE_PATH),
      logPath: String(args['log-path'] || LOG_PATH),
      knotsLeaseMaintenanceIntervalMs,
      knotsLeaseRenewThresholdMs,
      knotsLeaseRenewTimeoutSeconds,
    });
    return;
  }

  throw new Error(`unknown command: ${command}\n${usage()}`);
}

module.exports = {
  runTaskLivenessPass,
  enumerateActiveTasks,
  taskPidLivenessSnapshot,
  DEFAULTS,
  buildNudge,
  classifyHiveFlowTaskLiveness,
  classifyPane,
  classifyPaneStatus,
  createWatchState,
  detectAgentWait,
  explainOnce,
  activeKnotsLeases,
  hasPerformativeQuestion,
  hasDeclaredIntentToContinue,
  activeRouterHumanBlocker,
  hasActiveRouterHumanBlocker,
  hasActiveRouterTerminalState,
  knotsLeasesNeedingRenewal,
  loadWatchState,
  maintainKnotsLeases,
  mergeWatchState,
  normalizeKnotsLease,
  muteKey,
  normalizeStableIdleText,
  opposingAgent,
  quietStatus,
  quietWatchdog,
  resumeWatchdog,
  runDebugScenario,
  runOnce,
  saveWatchState,
  stripAnsi,
  watch,
};

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
