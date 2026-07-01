/**
 * Jury Verdict Collector — Polls jury votes and determines verdict.
 *
 * Reads vote files written by jury agents, tallies them, and produces
 * a final verdict. The Safety juror has veto power.
 *
 * Ported from Python jury_verdict.py.
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync,
  openSync, closeSync, statSync,
} from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type {
  JuryVote,
  JuryVerdict,
  VerdictFile,
  EscalationContext,
  UserOverride,
} from './types.js';
import { classifyCommand, getTimeoutBehavior } from './risk-classifier.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOME = homedir();
const CONTEXT_DIR = join(HOME, '.claude', 'hooks', 'escalation_context');

const VOTE_FILES: Record<string, string> = {
  'Goal Relevance': join(CONTEXT_DIR, 'vote_goal_relevance.json'),
  'Safety': join(CONTEXT_DIR, 'vote_safety.json'),
  'Convention': join(CONTEXT_DIR, 'vote_convention.json'),
};
const OVERRIDE_FILE = join(CONTEXT_DIR, 'user_override.json');
const ESCALATION_FILE = join(CONTEXT_DIR, 'latest.json');
const VERDICT_FILE = join(CONTEXT_DIR, 'last_verdict.json');

const LOCK_FILE = join(CONTEXT_DIR, '.jury.lock');
const LOCK_STALE_MS = 60_000;

const POLL_INTERVAL_MS = 500;
const MAX_WAIT_MS = 5_000;
const FRESHNESS_THRESHOLD = 5.0; // seconds
const VOTE_READ_RETRIES = 3;
const VOTE_READ_RETRY_DELAY_MS = 150;

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}.json`);
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Jury lock — prevents concurrent jury polls
// ---------------------------------------------------------------------------

/**
 * Try to acquire the jury lock file. Uses O_CREAT|O_EXCL for atomic creation.
 * If the lock exists and is older than LOCK_STALE_MS, removes it and retries.
 * @returns true if lock acquired, false if another jury is active.
 */
function acquireJuryLock(): boolean {
  mkdirSync(CONTEXT_DIR, { recursive: true });
  try {
    const fd = openSync(LOCK_FILE, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
    closeSync(fd);
    return true;
  } catch {
    // Lock file exists — check if stale
    try {
      const st = statSync(LOCK_FILE);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        unlinkSync(LOCK_FILE);
        const fd = openSync(LOCK_FILE, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
        closeSync(fd);
        return true;
      }
    } catch {
      // stat/unlink/re-create failed — another process raced us
    }
    return false;
  }
}

function releaseJuryLock(): void {
  try { unlinkSync(LOCK_FILE); } catch { /* already removed */ }
}

// ---------------------------------------------------------------------------
// Vote file cleanup
// ---------------------------------------------------------------------------

function cleanupVoteFiles(): void {
  for (const path of Object.values(VOTE_FILES)) {
    try { unlinkSync(path); } catch { /* missing is fine */ }
  }
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Escalation helpers
// ---------------------------------------------------------------------------

function getEscalationTs(): string | null {
  const esc = readJson<EscalationContext>(ESCALATION_FILE);
  return esc?.ts ?? null;
}

function getEscalationId(): string | null {
  const esc = readJson<EscalationContext>(ESCALATION_FILE);
  return esc?.escalation_id ?? null;
}

export function checkUserOverride(escalationTs: string | null): UserOverride | null {
  const override = readJson<UserOverride>(OVERRIDE_FILE);
  if (!override || !override.ts) return null;
  if (escalationTs && override.ts > escalationTs) return override;
  return null;
}

// ---------------------------------------------------------------------------
// Vote collection
// ---------------------------------------------------------------------------

export async function collectVotes(escalationTs: string | null): Promise<Record<string, JuryVote | null>> {
  const escalationId = getEscalationId();
  const votes: Record<string, JuryVote | null> = {};

  for (const [name, path] of Object.entries(VOTE_FILES)) {
    let vote: JuryVote | null = null;

    for (let attempt = 0; attempt < VOTE_READ_RETRIES; attempt++) {
      vote = readJson<JuryVote>(path);
      if (vote !== null) break;
      if (attempt < VOTE_READ_RETRIES - 1 && existsSync(path)) {
        await sleep(VOTE_READ_RETRY_DELAY_MS);
      }
    }

    if (vote === null) {
      votes[name] = null;
      continue;
    }

    // Primary validation: escalation_id must match
    if (escalationId) {
      votes[name] = vote.escalation_id === escalationId ? vote : null;
    } else if (escalationTs && (vote.ts || '') >= escalationTs) {
      // Fallback: timestamp freshness
      votes[name] = vote;
    } else {
      votes[name] = null;
    }
  }

  return votes;
}

// ---------------------------------------------------------------------------
// Vote tallying
// ---------------------------------------------------------------------------

export interface VoteTally {
  allow: number;
  deny: number;
  pending: number;
}

export function tallyVotes(votes: Record<string, JuryVote | null>): VoteTally {
  let allow = 0;
  let deny = 0;
  let pending = 0;

  for (const vote of Object.values(votes)) {
    if (vote === null || !vote.vote) {
      pending++;
    } else if (vote.vote === 'allow') {
      allow++;
    } else {
      deny++;
    }
  }

  return { allow, deny, pending };
}

export function safetyApproved(votes: Record<string, JuryVote | null>): boolean {
  const safetyVote = votes['Safety'];
  return safetyVote !== null && safetyVote?.vote === 'allow';
}

// ---------------------------------------------------------------------------
// Verdict formatting
// ---------------------------------------------------------------------------

export function formatVerdictMessage(
  verdict: JuryVerdict,
  votes: Record<string, JuryVote | null>,
  override?: UserOverride | null,
): string {
  const lines: string[] = [`[Permission Guard] Jury verdict: ${verdict}`];

  if (override) {
    lines.push(`  User override: ${override.decision || '?'} — ${override.reason || 'no reason'}`);
    return lines.join('\n');
  }

  for (const [name, vote] of Object.entries(votes)) {
    if (vote === null) {
      lines.push(`  ${name}: (no vote)`);
    } else {
      const v = (vote.vote || '?').toUpperCase();
      const reason = vote.reason || 'no reason';
      lines.push(`  ${name}: ${v} — ${reason}`);
    }
  }

  return lines.join('\n');
}

export function formatClaudeMessage(
  verdict: JuryVerdict,
  votes: Record<string, JuryVote | null>,
): string {
  const reasons: string[] = [];

  for (const [name, vote] of Object.entries(votes)) {
    if (vote && vote.vote === 'deny') {
      reasons.push(`[JURY: ${name}] DENIED — ${vote.reason || 'no reason given'}`);
    }
  }

  // Highlight safety veto
  const allowCount = Object.values(votes).filter(v => v && v.vote === 'allow').length;
  if (!safetyApproved(votes) && allowCount >= 2) {
    reasons.unshift('[SAFETY VETO] Safety juror denied — overrides majority approval');
  }

  return reasons.length > 0 ? reasons.join('; ') : `Jury verdict: ${verdict}`;
}

// ---------------------------------------------------------------------------
// Verdict file persistence
// ---------------------------------------------------------------------------

export function writeVerdictFile(verdict: JuryVerdict, message: string): void {
  try {
    const data: VerdictFile = {
      ts: new Date().toISOString(),
      verdict,
      message,
      consumed: false,
    };
    atomicWriteJson(VERDICT_FILE, data);
  } catch {
    // Non-critical — verdict visibility is best-effort
  }
}

function markEscalationResolved(): void {
  try {
    const esc = readJson<EscalationContext>(ESCALATION_FILE);
    if (esc) {
      esc.status = 'resolved';
      atomicWriteJson(ESCALATION_FILE, esc);
    }
  } catch {
    // Non-critical
  }
}

// ---------------------------------------------------------------------------
// Polling-based verdict collection
// ---------------------------------------------------------------------------

export interface JuryResult {
  verdict: JuryVerdict;
  votes: Record<string, JuryVote | null>;
  override: UserOverride | null;
  message: string;
  isAllowed: boolean;
}

/**
 * Poll jury votes until a verdict is reached.
 *
 * Waits for ALL 3 votes (not just early majority) before returning,
 * because the agent hooks run in parallel and the PermissionRequest
 * result is the combination of ALL hooks.
 *
 * @param pollIntervalMs - milliseconds between polls (default 500)
 * @param maxWaitMs - maximum milliseconds to wait (default 25000)
 */
export async function pollForVerdict(
  pollIntervalMs: number = POLL_INTERVAL_MS,
  maxWaitMs: number = MAX_WAIT_MS,
): Promise<JuryResult | null> {
  // Early-exit: check escalation freshness
  const escalation = readJson<EscalationContext>(ESCALATION_FILE);
  if (!escalation || !escalation.ts) return null;

  try {
    const escTime = new Date(escalation.ts).getTime();
    const age = (Date.now() - escTime) / 1000;
    if (age > FRESHNESS_THRESHOLD) return null;
  } catch {
    return null;
  }

  if (escalation.status !== 'jury_active') return null;

  // Acquire jury lock — prevents concurrent polls
  if (!acquireJuryLock()) return null;

  try {
    const escalationTs = getEscalationTs();
    const start = Date.now();
    let finalVerdict: JuryVerdict = 'TIMEOUT';
    let finalVotes: Record<string, JuryVote | null> = {};
    let finalOverride: UserOverride | null = null;

    while (Date.now() - start < maxWaitMs) {
      // Check user override
      const override = checkUserOverride(escalationTs);
      if (override) {
        finalOverride = override;
        finalVerdict = override.decision === 'allow' ? 'USER_APPROVED' : 'USER_DENIED';
        break;
      }

      // Collect and tally votes
      const votes = await collectVotes(escalationTs);
      const tally = tallyVotes(votes);

      if (tally.pending === 0) {
        finalVerdict = tally.allow >= 2 && safetyApproved(votes) ? 'APPROVED' : 'DENIED';
        finalVotes = votes;
        break;
      }

      await sleep(pollIntervalMs);
    }

    // Timeout — use risk-based auto-decision
    if (finalVerdict === 'TIMEOUT' && !finalOverride) {
      finalVotes = await collectVotes(escalationTs);
      const tally = tallyVotes(finalVotes);
      if (tally.allow >= 2 && safetyApproved(finalVotes)) {
        finalVerdict = 'APPROVED';
      } else if (tally.deny >= 2) {
        finalVerdict = 'DENIED';
      } else {
        // Risk-based timeout: read escalation context for command
        const esc = readJson<EscalationContext>(ESCALATION_FILE);
        const cmd = esc?.tool_input_summary?.command || '';
        const risk = classifyCommand(cmd);
        const behavior = getTimeoutBehavior(risk.level);
        finalVerdict = behavior === 'allow' ? 'TIMEOUT_ALLOW' : 'TIMEOUT_DENY';
      }
    }

    const isAllowed = finalVerdict === 'APPROVED' || finalVerdict === 'USER_APPROVED' || finalVerdict === 'TIMEOUT_ALLOW';
    const message = formatVerdictMessage(finalVerdict, finalVotes, finalOverride);

    // Persist verdict
    writeVerdictFile(finalVerdict, message);
    markEscalationResolved();

    // Clean up vote files to prevent stale data accumulation
    cleanupVoteFiles();

    // Record verdict for adaptive learning
    try {
      const voteLearner = await import('./vote-learner.js');
      const escCtx = readJson<EscalationContext>(ESCALATION_FILE);
      if (escCtx) {
        const cmdPattern = escCtx.tool_input_summary?.command || escCtx.file_path || '';
        if (escCtx.tool_name && cmdPattern) {
          voteLearner.recordVerdict(escCtx.tool_name, cmdPattern, isAllowed ? 'allow' : 'deny');
        }
      }
    } catch {
      // vote-learner not available
    }

    return { verdict: finalVerdict, votes: finalVotes, override: finalOverride, message, isAllowed };
  } finally {
    releaseJuryLock();
  }
}
