#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Forbidden patterns — asking for already-granted permission
const PERMISSION_PATTERNS = [
  /\bshall I proceed\b/i,
  /\bready to proceed\b/i,
  /\bshould I continue\b/i,
  /\bdo you want me to\b/i,
  /\bwould you like me to\b/i,
  /\bwith your permission\b/i,
  /\bwait for your (go-ahead|approval|confirmation)\b/i,
  /\bbefore I (continue|proceed|move forward)\b/i,
  /\blet me know if you'd like\b/i,
  /\bplease confirm\b/i,
];

// Patterns that indicate genuine completion (not a premature stop)
const COMPLETION_PATTERNS = [
  /\b(all|both|every) (bands?|workers?|agents?|phases?).*(complete|done|finished|committed)\b/i,
  /\bverification.*(pass|clean|complete)\b/i,
  /\bcommit.*success\b/i,
  /\bphase \d+.*(complete|done)\b/i,
];

// True clarification request patterns (require specific new info from human)
const GENUINE_CLARIFICATION_PATTERNS = [
  /which (option|approach|path) should/i,
  /what (value|name|path|url) should/i,
  /which (file|module|package) did you mean/i,
  // Genuine NEW permission requests — agent lacks access it hasn't been granted
  /\bdon't (currently )?have (write |read |file |shell |network )?access\b/i,
  /\bnot (currently )?in my (allowed|permitted|current) (tools|permissions)\b/i,
  /\bneed (write|read|file system|filesystem|shell|network|bash) (access|permission)\b/i,
  /\brequires? (write|read|file|shell|exec|network) (access|permission)/i,
  /\bcannot (read|write|access|modify|create|delete) .{1,60} (permission|access)/i,
  /\bpermission (denied|not granted) for\b/i,
];

function readInput() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.resume();
  });
}

function getLastAssistantText(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    // Scan from end to find last assistant message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'assistant' && entry.message?.content) {
          const content = entry.message.content;
          if (Array.isArray(content)) {
            return content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join(' ');
          }
          if (typeof content === 'string') return content;
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* unreadable transcript */ }
  return null;
}

function getRunningTaskCount(projectDir) {
  const liveTasksPath = path.join(projectDir, '.hive-flow/data/live-tasks.json');
  try {
    if (fs.existsSync(liveTasksPath)) {
      const tasks = JSON.parse(fs.readFileSync(liveTasksPath, 'utf8'));
      if (Array.isArray(tasks)) {
        return tasks.filter(t => t.status === 'running').length;
      }
    }
  } catch { /* state file unreadable */ }
  return 0;
}

function isPlanActive(projectDir) {
  // Guard only activates when enforcement state is authorized (plan in effect).
  // This mirrors the anti-re-request hook in hook-handler.cjs — when no active
  // plan exists, we don't intercept normal conversation / genuine new requests.
  try {
    const statePath = path.join(projectDir, '.hive-flow', 'enforcement', 'state.json');
    if (!fs.existsSync(statePath)) return false;
    const raw = fs.readFileSync(statePath, 'utf8');
    const envelope = JSON.parse(raw);
    // Validate HMAC before trusting state
    const hmacKeyPath = path.join(projectDir, '.hive-flow', 'enforcement', '.hmac-key');
    if (fs.existsSync(hmacKeyPath)) {
      const hmacKey = fs.readFileSync(hmacKeyPath, 'utf8').trim();
      // BUG-07: Read {state,hmac} envelope format (matching enforcement.cjs), not {payload,signature}
      const stateData = envelope.state;
      const expectedHmac = crypto.createHmac('sha256', hmacKey).update(JSON.stringify(stateData)).digest('hex');
      const sigBuf = Buffer.from(envelope.hmac || '', 'hex');
      const expBuf = Buffer.from(expectedHmac, 'hex');
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
      return stateData?.authorized === true;
    }
    // No HMAC key — conservative: treat as not authorized
    return false;
  } catch {
    return false;
  }
}

async function main() {
  const raw = await readInput();
  if (!raw.trim()) process.exit(0);

  let ctx;
  try { ctx = JSON.parse(raw); } catch { process.exit(0); }

  const transcriptPath = ctx.transcript_path;
  const projectDir = path.resolve(__dirname, '..', '..'); // BUG-10: __dirname-derived, not env-poisonable

  // CORRECTION 1: Only activate when a plan/permission is in effect.
  // When the user is just chatting with no active authorization, the guard is silent.
  if (!isPlanActive(projectDir)) process.exit(0);

  const lastText = getLastAssistantText(transcriptPath);
  if (!lastText) process.exit(0);

  // Check if this looks like genuine task completion — if so, the plan is done.
  // CORRECTION 1 (continued): disarm the guard so normal conversation resumes.
  const isCompletion = COMPLETION_PATTERNS.some(p => p.test(lastText));
  if (isCompletion) process.exit(0); // enforcement state naturally reflects no active task after completion

  // Check for genuine clarification request (specific new info needed)
  const isGenuineClarification = GENUINE_CLARIFICATION_PATTERNS.some(p => p.test(lastText));
  if (isGenuineClarification) process.exit(0);

  // Check for permission re-request patterns
  const matchedPattern = PERMISSION_PATTERNS.find(p => p.test(lastText));
  if (!matchedPattern) process.exit(0);

  // Pattern matched — check for running sub-agents
  const runningTasks = getRunningTaskCount(projectDir);

  if (runningTasks > 0) {
    // Has running agents — the stop is "waiting on results", not premature
    // Inject a passive reminder
    process.stdout.write(JSON.stringify({
      additionalContext: `[StopGuard] ${runningTasks} background agent(s) still running. Waiting on results is correct — do NOT poll them. Respond to the human's message normally, then wait.`
    }));
    process.exit(0);
  }

  // No running agents AND permission re-request = FORBIDDEN STOP
  const snippet = lastText.substring(0, 200).replace(/\n/g, ' ');
  process.stdout.write(JSON.stringify({
    additionalContext: `\u26d4 STOP-GUARD INTERCEPT \u2014 FORBIDDEN BEHAVIOR DETECTED

Your previous response matched a permission re-request pattern.
Last message snippet: "${snippet}..."

MANDATORY SELF-CHECK before responding:
1. Is your assigned task 100% complete? \u2192 Report completion with specifics (commit hash, test results, etc.). Do NOT ask if they want more.
2. Do you need NEW information you cannot derive from the existing plan? \u2192 Ask ONE specific, necessary question with full context. Do NOT ask general "shall I proceed" questions.
3. Were you about to ask for already-granted permission? \u2192 CONTINUE AUTONOMOUSLY. You have authorization.

Stopping to re-request already-granted permission is a TERMINABLE OFFENSE per operational rules. If the stop was a mistake, continue executing the task right now.`
  }));
  process.exit(0);
}

main().catch(() => process.exit(0));
