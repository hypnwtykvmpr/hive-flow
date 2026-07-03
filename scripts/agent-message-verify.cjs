#!/usr/bin/env node
//
// Agent Message Verification (P4 fix, Knot hive-flow-5de8; Codex bounce
// 20260703T233445Z)
//
// CJS lockstep mirror of the verification semantics owned by
// cli/src/mcp-tools/agent-message-store.ts, for load-bearing .cjs consumers
// that cannot import the TS store (scripts/hive-watcher.cjs). The watcher's
// waiting-on-peer gate holds hives open; counting UNVERIFIED raw records there
// would let a forged/tampered or TTL-expired record pin allComplete=false
// forever. Verification-impossible (no signing key) fails toward LIVENESS:
// nothing counts as waiting.
//
// MUST stay in lockstep with the store:
//   - messageSigningView(): field order is the contract (signingView()).
//   - verifyMessageSignature(): HMAC-sha256 over the view, timing-safe compare,
//     missing signature => false (treated as tamper).
//   - isTtlExpired(): createdAt + ttlMs overdue (the DURABLE 'expired'
//     transition stays store-owned; consumers only skip).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Read the store's self-managed signing key. Null when absent/unreadable. */
function readMessageSigningKey(projectRoot) {
  try {
    const key = fs.readFileSync(path.join(projectRoot, '.hive-flow', 'messages', '.hmac-key'), 'utf8').trim();
    return key || null;
  } catch {
    return null;
  }
}

// MUST match signingView() in agent-message-store.ts (field order is the contract).
function messageSigningView(m) {
  return JSON.stringify([
    m.messageId, m.dedupKey, m.conversationId, m.seq, m.hop, m.maxHops,
    m.ttlMs ?? null, m.from, m.to, m.verb, m.replyTo ?? null,
    m.blockerClass ?? null, m.unblockCondition ?? null, m.priority, m.body,
    m.requiresAck, m.ackDeadlineAt ?? null, m.createdAt,
  ]);
}

/** Missing/empty signature or key => false (unverifiable is never trusted). */
function verifyMessageSignature(m, signingKey) {
  if (!m || typeof m.signature !== 'string' || !m.signature || !signingKey) return false;
  let expected;
  try {
    expected = crypto.createHmac('sha256', signingKey).update(messageSigningView(m)).digest('hex');
  } catch {
    return false;
  }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(m.signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** True when the record carries a ttlMs and is overdue. */
function isTtlExpired(m, nowMs = Date.now()) {
  if (!m || m.ttlMs === undefined) return false;
  const expiresAt = Date.parse(m.createdAt) + m.ttlMs;
  return Number.isFinite(expiresAt) && nowMs > expiresAt;
}

module.exports = {
  readMessageSigningKey,
  messageSigningView,
  verifyMessageSignature,
  isTtlExpired,
};
