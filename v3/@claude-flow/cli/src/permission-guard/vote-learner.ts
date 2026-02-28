/**
 * Vote Learner — Adaptive learning from jury vote patterns.
 *
 * Tracks jury verdicts over time and auto-allows commands that have been
 * consistently approved. Patterns expire after 30 days of non-use.
 *
 * Ported from Python vote_learner.py.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir, hostname, userInfo } from 'node:os';
import { isNeverAutoAllow } from './risk-classifier.js';
import type { LearnedPattern, LearnedPatternStore, SignedPatternStore } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOME = homedir();
const PATTERNS_FILE = join(HOME, '.claude', 'hooks', 'escalation_context', 'learned_patterns.json');

/** Number of consecutive approvals before auto-allowing. */
const APPROVAL_THRESHOLD = 5;

/** Patterns expire after 30 days of non-use (seconds). */
const EXPIRY_SECONDS = 30 * 24 * 60 * 60;

/** Maximum stored patterns to prevent unbounded memory growth. */
const MAX_PATTERNS = 500;

/** Chained commands that should NEVER be auto-allowed. */
const CHAINED_CMD_REGEX = /[;&|]|\$\(|\`/;

/** Risk-tiered approval thresholds. */
const RISK_THRESHOLDS: Record<string, number> = {
  low: 3,
  medium: 5,
  high: 10,
  critical: Infinity,
};

function deriveHmacKey(): string {
  try {
    const host = hostname();
    const uid = String(userInfo().uid);
    return `pg-vote-learner-${host}-${uid}`;
  } catch {
    return 'pg-vote-learner-fallback';
  }
}

function computeHmac(data: string): string {
  return createHmac('sha256', deriveHmacKey()).update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Command normalization
// ---------------------------------------------------------------------------

function isSubcommand(token: string): boolean {
  if (token.includes('/') || token.includes('.') || token.includes('=') || token.includes('~')) {
    return false;
  }
  if (/^\d+$/.test(token)) return false;
  return /^[a-zA-Z-]+$/.test(token);
}

/**
 * Normalize a command to a pattern: base command + subcommands + flags.
 *
 * Strips positional arguments (paths, values) to keep only the command
 * name, subcommands, and flags.
 */
export function normalizeCommand(cmd: string): string {
  const trimmed = cmd.trim();
  if (!trimmed) return '';

  const parts = trimmed.split(/\s+/);
  const normalized: string[] = [];
  let seenFlag = false;

  for (const part of parts) {
    if (normalized.length === 0) {
      normalized.push(part);
    } else if (part.startsWith('-')) {
      normalized.push(part);
      seenFlag = true;
    } else if (!seenFlag && isSubcommand(part)) {
      normalized.push(part);
    }
    // else: positional arg or flag value — skip
  }

  return normalized.join(' ');
}

function makeKey(toolName: string, cmdPattern: string): string {
  return `${toolName}::${cmdPattern}`;
}

// ---------------------------------------------------------------------------
// Pattern store I/O
// ---------------------------------------------------------------------------

function loadPatterns(): LearnedPatternStore {
  try {
    const raw = readFileSync(PATTERNS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    // Support both signed and unsigned formats
    if (parsed && typeof parsed === 'object' && 'hmac' in parsed && 'patterns' in parsed) {
      const signed = parsed as SignedPatternStore;
      const expected = computeHmac(JSON.stringify(signed.patterns));
      if (signed.hmac !== expected) {
        // Tampered — reset
        return {};
      }
      return signed.patterns;
    }
    // Legacy unsigned format — migrate on next save
    return parsed as LearnedPatternStore;
  } catch {
    return {};
  }
}

function savePatterns(data: LearnedPatternStore): void {
  try {
    const targetDir = dirname(PATTERNS_FILE);
    mkdirSync(targetDir, { recursive: true });
    const signed: SignedPatternStore = {
      version: 1,
      patterns: data,
      hmac: computeHmac(JSON.stringify(data)),
    };
    const tmpPath = join(targetDir, `.learned_patterns.${randomUUID()}.tmp`);
    try {
      writeFileSync(tmpPath, JSON.stringify(signed, null, 2), 'utf-8');
      renameSync(tmpPath, PATTERNS_FILE);
    } catch {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  } catch {
    // Storage failure should never block the gate
  }
}

function pruneExpired(data: LearnedPatternStore): LearnedPatternStore {
  const now = Date.now() / 1000; // seconds
  const pruned: LearnedPatternStore = {};
  for (const [key, entry] of Object.entries(data)) {
    if (now - (entry.last_seen || 0) < EXPIRY_SECONDS) {
      pruned[key] = entry;
    }
  }
  return pruned;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a jury verdict for a tool+command pattern.
 *
 * Tracks consecutive approvals. A single deny resets the counter.
 */
export function recordVerdict(toolName: string, cmdPattern: string, verdict: string): void {
  const normalized = normalizeCommand(cmdPattern);
  if (!normalized) return;

  const key = makeKey(toolName, normalized);
  let data = loadPatterns();
  data = pruneExpired(data);

  const entry: LearnedPattern = data[key] || {
    approvals: 0,
    last_seen: 0,
    pattern: normalized,
    tool: toolName,
  };

  if (verdict === 'allow') {
    entry.approvals = (entry.approvals || 0) + 1;
  } else {
    entry.approvals = 0;
  }

  entry.last_seen = Date.now() / 1000;
  data[key] = entry;

  // Enforce max patterns — evict least-recently-used when over limit
  const keys = Object.keys(data);
  if (keys.length > MAX_PATTERNS) {
    const sorted = keys.sort((a, b) => (data[b].last_seen || 0) - (data[a].last_seen || 0));
    const pruned: LearnedPatternStore = {};
    for (let i = 0; i < MAX_PATTERNS; i++) {
      pruned[sorted[i]] = data[sorted[i]];
    }
    savePatterns(pruned);
    return;
  }

  savePatterns(data);
}

/**
 * Check if a command has been consistently approved by the jury.
 *
 * Returns "allow" if the normalized command has >= APPROVAL_THRESHOLD
 * consecutive approvals and hasn't expired. Returns null otherwise.
 */
export function checkLearnedPattern(toolName: string, cmd: string): 'allow' | null {
  const normalized = normalizeCommand(cmd);
  if (!normalized) return null;

  // Never auto-allow chained commands
  if (CHAINED_CMD_REGEX.test(cmd)) return null;

  // Never auto-allow critical-risk commands
  if (isNeverAutoAllow(cmd)) return null;

  const key = makeKey(toolName, normalized);
  const data = loadPatterns();

  const entry = data[key];
  if (!entry) return null;

  // Check expiry
  const now = Date.now() / 1000;
  if (now - (entry.last_seen || 0) > EXPIRY_SECONDS) return null;

  // Use fixed threshold (risk-tiered thresholds require risk-classifier integration)
  if ((entry.approvals || 0) >= APPROVAL_THRESHOLD) return 'allow';

  return null;
}

/**
 * Get all learned patterns (for MCP tool display).
 */
export function getLearnedPatterns(limit: number = 20): LearnedPattern[] {
  let data = loadPatterns();
  data = pruneExpired(data);

  return Object.values(data)
    .sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0))
    .slice(0, limit);
}
