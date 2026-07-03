/**
 * Agent Message Store -- durable persistence layer for inter-agent messages.
 *
 * P1 of the inter-agent communication design (Knot hive-flow-2ee8; design of
 * record: the 2ee8 knot note + router 20260703T192135Z; Codex PLAN_REVIEW_PASS
 * 20260703T192607Z). This is the ENVELOPE + STORE only -- delivery adapters
 * (P2a/P2b), mediation routing (P3), and anti-spam (P4) build on top of it.
 *
 * Design principle: reuse the proven file-backed, lock-guarded, atomic-write,
 * idempotent-read spine that powers `hive-store.ts` and the queen permission
 * channel (which survived a forced compaction byte-identical). Messages are a
 * new consumer of that spine, NOT a new in-memory bus.
 *
 * Store layout under `<projectRoot>/.hive-flow/messages/` (private, runtime-owned):
 *   - `outbox.jsonl`                    append-only audit log of every send
 *   - `inbox/<recipientKey>/<id>.json`  per-recipient durable inbox record
 *   - `inbox/<recipientKey>/<id>.acked` O_EXCL at-most-once ack marker
 *   - `deadletter/<id>.json`            dead-lettered records with a reason
 *   - `.hmac-key`                       per-store message-signing key (0600)
 *   - `.lock`                           store-level mkdir lock
 *
 * Corrections carried from plan review: a per-message HMAC signature is NET-NEW
 * (source only has `HiveState.signature`, not a per-permission-request field).
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmdirSync, renameSync,
  statSync, readdirSync, openSync, closeSync, appendFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID, randomBytes, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { sanitizePathId } from '../shared/index.js';
import { loadAgentStore } from './agent-tools.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_DIR = '.hive-flow';
const MESSAGES_DIR = 'messages';
const INBOX_DIR = 'inbox';
const DEADLETTER_DIR = 'deadletter';
const OUTBOX_FILE = 'outbox.jsonl';
const KEY_FILE = '.hmac-key';
const LOCK_FILE = '.lock';
const RATE_STATE_FILE = 'rate-state.json';

// Anti-spam caps (P4, Knot hive-flow-5de8; DoR FM-10). Reuses the denial-ledger
// actor-keyed windowed pattern. ponytail: generous constants; make them
// config/env-tunable when real traffic data shows these are wrong.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_PER_PAIR = 20;
const RATE_MAX_PER_SENDER = 60;

// NUL delimiter for hash inputs (collision-safe: cannot appear in the fields;
// matches the codebase sha256(clientKind\0sessionId) wake-path scheme). Built via
// fromCharCode so the SOURCE stays pure ASCII -- a literal NUL byte would make git
// classify this file as binary.
const SEP = String.fromCharCode(0);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MessageVerb =
  | 'ask'       // question/help request; a reply is expected
  | 'inform'    // FYI; no reply expected
  | 'handoff'   // transfer work + next-owner
  | 'blocked'   // sender is blocked; needs mediation (requires unblockCondition)
  | 'reply'     // answers a prior messageId (replyTo)
  | 'ack'       // acknowledges receipt of a prior messageId
  | 'resume'    // mediator decision: continue original work
  | 'redirect'; // mediator decision: do a safe replacement instead

export type DeliveryState = 'pending' | 'delivered' | 'acked' | 'dead-letter' | 'expired';
export type BlockerClass = 'self-redirectable' | 'needs-mediation' | 'terminal';
export type MessagePriority = 'urgent' | 'high' | 'normal' | 'low';

/** Sender/recipient identity. Ownership fields are load-bearing for routing. */
export interface MessageParty {
  agentId: string;
  /** Explicit ownership addressing -- never re-derived from env (sidesteps 6c50/5799). */
  ownerSessionId: string;
  ownerClientKind: string;
  hiveId?: string;
  role?: string;
}

/** The durable inter-agent message envelope. */
export interface AgentMessage {
  /** `msg-<uuid>` minted ONCE at send and echoed verbatim thereafter -- never re-derived. */
  messageId: string;
  /** Stable content hash for idempotent fold-in (dedup). */
  dedupKey: string;
  conversationId: string;
  /** Monotonic per-conversation sequence (loop/echo guard input for P4). */
  seq: number;
  hop: number;
  maxHops: number;
  ttlMs?: number;
  /** Stamped from the sender's authoritative persisted record -- not caller input. */
  from: MessageParty;
  to: MessageParty;
  verb: MessageVerb;
  /** messageId this message answers (thread correlation). */
  replyTo?: string;
  blockerClass?: BlockerClass;
  unblockCondition?: string;
  priority: MessagePriority;
  body: string;
  /** DERIVED from the real delivery/ack result -- never a hardcoded constant. */
  deliveryState: DeliveryState;
  requiresAck: boolean;
  ackDeadlineAt?: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  ackedAt?: string;
  deadLetterReason?: string;
  /** NET-NEW per-message HMAC over the immutable core (tamper detection). */
  signature?: string;
}

export interface SendMessageInput {
  /** Sender agent id; ownership is stamped from its persisted record. */
  fromAgentId: string;
  to: {
    agentId?: string;
    ownerSessionId: string;
    ownerClientKind: string;
    hiveId?: string;
    role?: string;
  };
  verb: MessageVerb;
  body: string;
  conversationId?: string;
  replyTo?: string;
  seq?: number;
  priority?: MessagePriority;
  blockerClass?: BlockerClass;
  unblockCondition?: string;
  requiresAck?: boolean;
  maxHops?: number;
  ttlMs?: number;
  hop?: number;
}

/** Result of a read that may surface a malformed/tampered record as a dead-letter.
 *  `deadLetter` is false for benign misses (not-found/unreadable) and true when the
 *  record exists but is corrupt/tampered (caller should route it to dead-letter). */
export type InboxReadResult =
  | { ok: true; message: AgentMessage }
  | { ok: false; deadLetter: boolean; reason: string; messageId?: string };

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getMessagesDir(projectRoot = process.cwd()): string {
  return join(projectRoot, STORAGE_DIR, MESSAGES_DIR);
}
function getInboxRoot(projectRoot = process.cwd()): string {
  return join(getMessagesDir(projectRoot), INBOX_DIR);
}
function getRecipientInboxDir(key: string, projectRoot = process.cwd()): string {
  const safe = sanitizePathId(key, 128);
  if (!safe) throw new Error('Invalid recipientKey');
  return join(getInboxRoot(projectRoot), safe);
}
function getInboxRecordPath(key: string, messageId: string, projectRoot = process.cwd()): string {
  const safeId = sanitizePathId(messageId, 128);
  if (!safeId) throw new Error('Invalid messageId');
  return join(getRecipientInboxDir(key, projectRoot), safeId + '.json');
}
function getAckMarkerPath(key: string, messageId: string, projectRoot = process.cwd()): string {
  const safeId = sanitizePathId(messageId, 128);
  if (!safeId) throw new Error('Invalid messageId');
  return join(getRecipientInboxDir(key, projectRoot), safeId + '.acked');
}
function getDeadLetterDir(projectRoot = process.cwd()): string {
  return join(getMessagesDir(projectRoot), DEADLETTER_DIR);
}
function getOutboxPath(projectRoot = process.cwd()): string {
  return join(getMessagesDir(projectRoot), OUTBOX_FILE);
}
function getLockPath(projectRoot = process.cwd()): string {
  return join(getMessagesDir(projectRoot), LOCK_FILE);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Deterministic recipient inbox key: `sha256(ownerClientKind \0 ownerSessionId \0 agentId)`.
 * Mirrors the existing wake-path scheme (session+client-kind scoped) but adds the
 * agentId so an inbox is per-recipient-agent.
 */
export function recipientKey(party: { agentId?: string; ownerSessionId: string; ownerClientKind: string }): string {
  return createHash('sha256')
    .update([party.ownerClientKind, party.ownerSessionId, party.agentId ?? ''].join(SEP))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Store-level lock (mkdir-based, mirrors withHiveLock)
//
// ponytail: single store-level lock. Per-recipient locks if message throughput
// ever dominates -- inbox writes to distinct recipient dirs don't conflict, but
// the shared outbox append and key creation do.
// ---------------------------------------------------------------------------

export async function withMessagesLock<T>(fn: () => T | Promise<T>, projectRoot = process.cwd()): Promise<T> {
  ensureDir(getMessagesDir(projectRoot));
  const lockPath = getLockPath(projectRoot);
  const maxWait = 10000;
  const start = Date.now();
  let acquired = false;

  while (Date.now() - start < maxWait) {
    try {
      mkdirSync(lockPath);
      acquired = true;
      break;
    } catch {
      try {
        const lockStat = statSync(lockPath);
        if (Date.now() - lockStat.mtimeMs > 30000) {
          try { rmdirSync(lockPath); } catch { /* race with another cleaner */ }
          continue;
        }
      } catch {
        continue; // lock dir gone -- retry
      }
      await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
    }
  }
  if (!acquired) throw new Error('Failed to acquire messages lock within 10s');

  try {
    return await fn();
  } finally {
    try { rmdirSync(lockPath); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Signing (NET-NEW per-message HMAC)
// ---------------------------------------------------------------------------

/** Lazily create/read the message-signing key. Self-managed so the store works
 *  standalone (e.g. under a temp projectRoot in tests) without the enforcement key. */
function getSigningKey(projectRoot = process.cwd()): string {
  const keyPath = join(getMessagesDir(projectRoot), KEY_FILE);
  try {
    if (existsSync(keyPath)) return readFileSync(keyPath, 'utf-8').trim();
  } catch { /* fall through to create */ }
  ensureDir(getMessagesDir(projectRoot));
  const key = randomBytes(32).toString('hex');
  try {
    // O_EXCL create so a concurrent creator wins exactly once; on race, re-read.
    const fd = openSync(keyPath, 'wx', 0o600);
    try { writeFileSync(fd, key); } finally { closeSync(fd); }
    return key;
  } catch {
    return readFileSync(keyPath, 'utf-8').trim();
  }
}

/** The immutable subset the signature covers. Mutable delivery fields
 *  (deliveryState/updatedAt/deliveredAt/ackedAt/deadLetterReason) are excluded
 *  so state can evolve without invalidating the signature. */
function signingView(m: AgentMessage): string {
  return JSON.stringify([
    m.messageId, m.dedupKey, m.conversationId, m.seq, m.hop, m.maxHops,
    m.ttlMs ?? null, m.from, m.to, m.verb, m.replyTo ?? null,
    m.blockerClass ?? null, m.unblockCondition ?? null, m.priority, m.body,
    m.requiresAck, m.ackDeadlineAt ?? null, m.createdAt,
  ]);
}

function signMessage(m: AgentMessage, projectRoot: string): string {
  return createHmac('sha256', getSigningKey(projectRoot)).update(signingView(m)).digest('hex');
}

/** Verify a message's signature. Missing signature -> false (treated as tamper). */
export function verifyMessageSignature(m: AgentMessage, projectRoot = process.cwd()): boolean {
  if (!m.signature) return false;
  const expected = signMessage(m, projectRoot);
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(m.signature, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Sender identity (anti-forgery)
// ---------------------------------------------------------------------------

/** Resolve the sender's ownership from its AUTHORITATIVE persisted AgentRecord.
 *  Returns null if the agent is not persisted (unknown sender -> send rejected). */
export function resolveSenderStamp(
  agentId: string,
  projectRoot = process.cwd(),
): { ownerSessionId: string; ownerClientKind: string; hiveId?: string } | null {
  const store = loadAgentStore(projectRoot);
  const rec = store.agents?.[agentId];
  if (!rec) return null;
  if (!rec.ownerSessionId || !rec.ownerClientKind) return null;
  return { ownerSessionId: rec.ownerSessionId, ownerClientKind: rec.ownerClientKind };
}

// ---------------------------------------------------------------------------
// dedup + validation
// ---------------------------------------------------------------------------

function computeDedupKey(from: MessageParty, to: MessageParty, verb: MessageVerb, conversationId: string, body: string): string {
  const bodyDigest = createHash('sha256').update(body).digest('hex');
  return createHash('sha256')
    .update([from.agentId, recipientKey(to), verb, conversationId, bodyDigest].join(SEP))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Anti-spam rate state (P4 -- per-pair + per-sender windowed caps)
// ---------------------------------------------------------------------------

interface RateState {
  pairs: Record<string, { sent: number[]; lastBodyDigest?: string }>;
  senders: Record<string, number[]>;
}

function getRateStatePath(projectRoot: string): string {
  return join(getMessagesDir(projectRoot), RATE_STATE_FILE);
}

/** Read the windowed send ledger. Corrupt/absent state resets empty -- the caps
 *  are an abuse guard, not an integrity boundary. Callers hold the store lock. */
function readRateState(projectRoot: string): RateState {
  try {
    const raw = readFileSync(getRateStatePath(projectRoot), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<RateState>;
    return {
      pairs: parsed.pairs && typeof parsed.pairs === 'object' ? parsed.pairs : {},
      senders: parsed.senders && typeof parsed.senders === 'object' ? parsed.senders : {},
    };
  } catch {
    return { pairs: {}, senders: {} };
  }
}

function writeRateState(state: RateState, projectRoot: string): void {
  ensureDir(getMessagesDir(projectRoot));
  const target = getRateStatePath(projectRoot);
  const tmp = target + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(state), 'utf-8');
  renameSync(tmp, target);
}

/** Drop timestamps that fell out of the window (in place). */
function pruneWindow(sent: number[], nowMs: number): void {
  let keepFrom = 0;
  while (keepFrom < sent.length && nowMs - sent[keepFrom] > RATE_WINDOW_MS) keepFrom++;
  if (keepFrom > 0) sent.splice(0, keepFrom);
}

/** Store-level invariants (defense in depth; the P3 router enforces the same). */
function validateSendInput(input: SendMessageInput): void {
  if (!input.fromAgentId) throw new Error('sender-required');
  if (!input.to?.ownerSessionId || !input.to?.ownerClientKind) {
    throw new Error('recipient-addressing-required: ownerSessionId + ownerClientKind');
  }
  if (input.verb === 'blocked' && !input.unblockCondition) {
    throw new Error('unblock-condition-required: a blocked message must state its unblock condition');
  }
  if (input.blockerClass === 'terminal' && !input.unblockCondition) {
    throw new Error('unblock-condition-required: a terminal blocker must state its unblock condition');
  }
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/** Parse + verify one inbox record. Malformed JSON, missing required fields, or a
 *  failed signature all surface as a dead-letter result (never a silent drop). */
function parseInboxRecord(raw: string, projectRoot: string): InboxReadResult {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, deadLetter: true, reason: 'malformed-json' };
  }
  const m = obj as Partial<AgentMessage>;
  if (!m || typeof m.messageId !== 'string' || typeof m.body !== 'string' || !m.from || !m.to || !m.verb) {
    return { ok: false, deadLetter: true, reason: 'missing-required-fields', messageId: (m && typeof m.messageId === 'string') ? m.messageId : undefined };
  }
  if (!verifyMessageSignature(m as AgentMessage, projectRoot)) {
    return { ok: false, deadLetter: true, reason: 'signature-mismatch', messageId: m.messageId };
  }
  return { ok: true, message: m as AgentMessage };
}

/**
 * Durably quarantine a corrupt/tampered inbox record: write raw evidence + reason
 * under `deadletter/corrupt-<hash>.json` (idempotent by content hash) and move the
 * bad file out of the active `.json` listing (`.corrupt`). Best-effort and never
 * throws: corruption becomes durable evidence, never a silent in-memory-only report.
 */
function quarantineCorruptRecord(
  inboxDir: string,
  fileName: string | null,
  raw: string,
  reason: string,
  projectRoot: string,
  messageId?: string,
): void {
  try {
    ensureDir(getDeadLetterDir(projectRoot));
    const hash = createHash('sha256').update((raw || '') + '|' + (messageId ?? '') + '|' + reason).digest('hex').slice(0, 32);
    const target = join(getDeadLetterDir(projectRoot), `corrupt-${hash}.json`);
    if (!existsSync(target)) {
      const evidence = {
        quarantinedAt: new Date().toISOString(),
        reason,
        messageId: messageId ?? null,
        sourceFile: fileName,
        rawEvidence: raw,
      };
      const tmp = target + '.tmp.' + process.pid;
      writeFileSync(tmp, JSON.stringify(evidence, null, 2), 'utf-8');
      renameSync(tmp, target);
    }
    if (fileName) {
      const src = join(inboxDir, fileName);
      try { if (existsSync(src)) renameSync(src, src + '.corrupt'); } catch { /* rename race -- evidence already durable */ }
    }
  } catch { /* best-effort: never throw from a read/quarantine path */ }
}

/** Read a single inbox record by id. Idempotent; safe to call repeatedly.
 *  Pure read (no side effects) -- durable dead-lettering of corruption happens at
 *  the `listInbox` / `ackMessage` boundary, which owns the quarantine. */
export function readInboxMessage(key: string, messageId: string, projectRoot = process.cwd()): InboxReadResult {
  const path = getInboxRecordPath(key, messageId, projectRoot);
  if (!existsSync(path)) return { ok: false, deadLetter: false, reason: 'not-found', messageId };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { ok: false, deadLetter: true, reason: 'unreadable', messageId };
  }
  return parseInboxRecord(raw, projectRoot);
}

/** List a recipient's inbox. Malformed/tampered records are reported (with reason)
 *  rather than dropped. Optionally include terminal (acked/dead-letter) records. */
export function listInbox(
  to: { agentId?: string; ownerSessionId: string; ownerClientKind: string },
  projectRoot = process.cwd(),
  opts: { includeTerminal?: boolean } = {},
): { messages: AgentMessage[]; deadLetters: Array<{ messageId?: string; reason: string }> } {
  const key = recipientKey(to);
  const dir = getRecipientInboxDir(key, projectRoot);
  const messages: AgentMessage[] = [];
  const deadLetters: Array<{ messageId?: string; reason: string }> = [];
  if (!existsSync(dir)) return { messages, deadLetters };
  let entries: string[] = [];
  try {
    entries = readdirSync(dir).filter(n => n.endsWith('.json'));
  } catch {
    return { messages, deadLetters };
  }
  for (const name of entries) {
    let raw: string;
    try { raw = readFileSync(join(dir, name), 'utf-8'); } catch { deadLetters.push({ reason: 'unreadable' }); continue; }
    const res = parseInboxRecord(raw, projectRoot);
    if (!res.ok) {
      deadLetters.push({ messageId: res.messageId, reason: res.reason });
      // Durably dead-letter the corruption (evidence + move out of active listing).
      quarantineCorruptRecord(dir, name, raw, res.reason, projectRoot, res.messageId);
      continue;
    }
    let m = res.message;
    // P4 TTL expiry at read: an overdue non-terminal record transitions durably
    // to 'expired' and drops out of the active listing. deliveryState is outside
    // the signing view, so the transition never invalidates the signature.
    if (m.ttlMs !== undefined && (m.deliveryState === 'pending' || m.deliveryState === 'delivered')) {
      const expiresAt = Date.parse(m.createdAt) + m.ttlMs;
      if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
        m = { ...m, deliveryState: 'expired', updatedAt: new Date().toISOString() };
        try { writeInboxRecord(m, projectRoot); } catch { /* best-effort; re-expires next read */ }
      }
    }
    if (!opts.includeTerminal && (m.deliveryState === 'acked' || m.deliveryState === 'dead-letter' || m.deliveryState === 'expired')) continue;
    messages.push(m);
  }
  // Priority then creation order -- stable delivery order.
  const rank: Record<MessagePriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  messages.sort((a, b) => (rank[a.priority] - rank[b.priority]) || a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq);
  return { messages, deadLetters };
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

function writeInboxRecord(m: AgentMessage, projectRoot: string): void {
  const key = recipientKey(m.to);
  ensureDir(getRecipientInboxDir(key, projectRoot));
  const target = getInboxRecordPath(key, m.messageId, projectRoot);
  const tmp = target + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf-8');
  renameSync(tmp, target);
}

/**
 * Send a message: stamp `from` from the persisted record, mint id + dedupKey,
 * sign, append to outbox, and write the durable inbox record. Idempotent by
 * dedupKey -- a non-terminal message with the same dedupKey is folded (the
 * existing record is returned, no duplicate delivery).
 */
export async function sendMessage(input: SendMessageInput, projectRoot = process.cwd()): Promise<AgentMessage> {
  validateSendInput(input);

  // Anti-forgery: ownership comes from the sender's authoritative persisted
  // record, overriding anything the caller might claim. Unknown sender -> reject.
  const stamp = resolveSenderStamp(input.fromAgentId, projectRoot);
  if (!stamp) throw new Error(`unknown-sender: no persisted record with ownership for ${input.fromAgentId}`);

  const from: MessageParty = {
    agentId: input.fromAgentId,
    ownerSessionId: stamp.ownerSessionId,
    ownerClientKind: stamp.ownerClientKind,
    ...(stamp.hiveId ? { hiveId: stamp.hiveId } : {}),
  };
  const to: MessageParty = {
    agentId: input.to.agentId ?? '',
    ownerSessionId: input.to.ownerSessionId,
    ownerClientKind: input.to.ownerClientKind,
    ...(input.to.hiveId ? { hiveId: input.to.hiveId } : {}),
    ...(input.to.role ? { role: input.to.role } : {}),
  };

  const conversationId = input.conversationId ?? `conv-${randomUUID()}`;
  const dedupKey = computeDedupKey(from, to, input.verb, conversationId, input.body);

  const bodyDigest = createHash('sha256').update(input.body).digest('hex');
  const pairKey = createHash('sha256').update([input.fromAgentId, recipientKey(to)].join(SEP)).digest('hex');

  return withMessagesLock(async () => {
    // dedup fold-in: return an existing non-terminal record with the same dedupKey.
    // Runs BEFORE the anti-spam guards -- an idempotent resend is not spam.
    const existing = listInbox(to, projectRoot, { includeTerminal: false }).messages
      .find(m => m.dedupKey === dedupKey);
    if (existing) return existing;

    // ---- P4 anti-spam guards (Knot hive-flow-5de8; DoR FM-10) ----
    const rateState = readRateState(projectRoot);
    const pairEntry = rateState.pairs[pairKey] ?? { sent: [] };
    const senderSent = rateState.senders[input.fromAgentId] ?? [];
    const nowMs = Date.now();
    pruneWindow(pairEntry.sent, nowMs);
    pruneWindow(senderSent, nowMs);

    // Consecutive-frame de-dup: identical body to the same pair as the
    // immediately previous frame. dedupKey cannot catch these when the sender
    // varies conversationId/verb. Not a throttle -- applies to urgent too.
    if (pairEntry.lastBodyDigest === bodyDigest) {
      throw new Error('duplicate-frame: identical consecutive message to the same recipient (vary the body, or resend within the same conversation for dedup fold-in)');
    }

    // Windowed rate caps; urgent bypasses the throttle (never the de-dup).
    const effectivePriority = input.priority ?? 'normal';
    if (effectivePriority !== 'urgent') {
      if (pairEntry.sent.length >= RATE_MAX_PER_PAIR) {
        throw new Error(`rate-capped: pair limit ${RATE_MAX_PER_PAIR} per ${RATE_WINDOW_MS / 60000}min reached for '${input.fromAgentId}' to this recipient (priority=urgent bypasses)`);
      }
      if (senderSent.length >= RATE_MAX_PER_SENDER) {
        throw new Error(`rate-capped: sender limit ${RATE_MAX_PER_SENDER} per ${RATE_WINDOW_MS / 60000}min reached for '${input.fromAgentId}' (priority=urgent bypasses)`);
      }
    }

    const now = new Date().toISOString();
    const message: AgentMessage = {
      messageId: `msg-${randomUUID()}`,
      dedupKey,
      conversationId,
      seq: input.seq ?? 0,
      hop: input.hop ?? 0,
      maxHops: input.maxHops ?? 8,
      ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
      from,
      to,
      verb: input.verb,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.blockerClass ? { blockerClass: input.blockerClass } : {}),
      ...(input.unblockCondition ? { unblockCondition: input.unblockCondition } : {}),
      priority: input.priority ?? 'normal',
      body: input.body,
      deliveryState: 'pending',
      requiresAck: input.requiresAck ?? false,
      createdAt: now,
      updatedAt: now,
    };
    message.signature = signMessage(message, projectRoot);

    // Record the send attempt in the rate ledger. Hop-overflow dead-letters
    // count too -- a loop storm must not evade the caps by dying at the bound.
    pairEntry.sent.push(nowMs);
    pairEntry.lastBodyDigest = bodyDigest;
    senderSent.push(nowMs);
    rateState.pairs[pairKey] = pairEntry;
    rateState.senders[input.fromAgentId] = senderSent;
    writeRateState(rateState, projectRoot);

    ensureDir(getMessagesDir(projectRoot));

    // Loop bound (FM-10): hop >= maxHops drops DURABLY to dead-letter -- audit
    // trail in the outbox, evidence in deadletter/, never an inbox delivery,
    // never a silent drop. The returned record carries deliveryState
    // 'dead-letter' so the caller sees the real outcome.
    if (message.hop >= message.maxHops) {
      appendFileSync(getOutboxPath(projectRoot), JSON.stringify(message) + '\n', 'utf-8');
      return deadLetterMessageUnsafe(message, `max-hops-exceeded: hop ${message.hop} >= maxHops ${message.maxHops}`, projectRoot);
    }

    // Append-only audit log first, then the durable inbox record.
    appendFileSync(getOutboxPath(projectRoot), JSON.stringify(message) + '\n', 'utf-8');
    writeInboxRecord(message, projectRoot);
    return message;
  }, projectRoot);
}

/**
 * Advance a PENDING message to DELIVERED -- the ONLY forward transition a delivery
 * adapter may perform. It refuses to skip states or reopen a terminal record, so
 * `deliveryState` stays derived from a real delivery outcome rather than a free
 * setter. Terminal transitions have their own evidence-bearing helpers:
 * `ackMessage` (-> acked) and `deadLetterMessage` (-> dead-letter).
 */
export async function markDelivered(
  to: { agentId?: string; ownerSessionId: string; ownerClientKind: string },
  messageId: string,
  projectRoot = process.cwd(),
): Promise<{ ok: boolean; message?: AgentMessage; reason?: string }> {
  const key = recipientKey(to);
  return withMessagesLock(async () => {
    const res = readInboxMessage(key, messageId, projectRoot);
    if (!res.ok) return { ok: false, reason: res.reason };
    const m = res.message;
    if (m.deliveryState !== 'pending') return { ok: false, reason: `not-pending: ${m.deliveryState}` };
    m.deliveryState = 'delivered';
    m.deliveredAt = new Date().toISOString();
    m.updatedAt = m.deliveredAt;
    writeInboxRecord(m, projectRoot);
    return { ok: true, message: m };
  }, projectRoot);
}

/**
 * Acknowledge a message at-most-once. Reads + verifies FIRST -- a missing or
 * corrupt/tampered record is NEVER ACKed: it returns `{ acked: false, reason }`
 * and, for a corrupt record, is durably dead-lettered. Only a valid message gets
 * the O_EXCL `.acked` marker; a second ack is a no-op (`alreadyAcked: true`), so a
 * duplicate ack is safe under compaction.
 */
export async function ackMessage(
  to: { agentId?: string; ownerSessionId: string; ownerClientKind: string },
  messageId: string,
  projectRoot = process.cwd(),
): Promise<{ acked: boolean; alreadyAcked: boolean; reason?: string }> {
  const key = recipientKey(to);
  return withMessagesLock(async () => {
    // Never ACK a message we cannot read + verify.
    const res = readInboxMessage(key, messageId, projectRoot);
    if (!res.ok) {
      if (res.deadLetter) {
        const dir = getRecipientInboxDir(key, projectRoot);
        const fileName = (sanitizePathId(messageId, 128) ?? messageId) + '.json';
        let raw = '';
        try { raw = readFileSync(join(dir, fileName), 'utf-8'); } catch { /* already moved */ }
        quarantineCorruptRecord(dir, fileName, raw, res.reason, projectRoot, messageId);
      }
      return { acked: false, alreadyAcked: false, reason: res.reason };
    }
    // Valid message -- at-most-once O_EXCL marker.
    const markerPath = getAckMarkerPath(key, messageId, projectRoot);
    ensureDir(getRecipientInboxDir(key, projectRoot));
    let firstAck = false;
    try {
      const fd = openSync(markerPath, 'wx');
      try { writeFileSync(fd, new Date().toISOString()); } finally { closeSync(fd); }
      firstAck = true;
    } catch {
      firstAck = false; // marker already exists -> already acked
    }
    if (firstAck) {
      const m = res.message;
      m.deliveryState = 'acked';
      m.ackedAt = new Date().toISOString();
      m.updatedAt = m.ackedAt;
      writeInboxRecord(m, projectRoot);
    }
    return { acked: true, alreadyAcked: !firstAck };
  }, projectRoot);
}

/** Lock-free dead-letter core; callers must hold the messages lock (or accept
 *  the atomic-write-only guarantee). Returns the terminal record. */
function deadLetterMessageUnsafe(message: AgentMessage, reason: string, projectRoot: string): AgentMessage {
  ensureDir(getDeadLetterDir(projectRoot));
  const updated: AgentMessage = { ...message, deliveryState: 'dead-letter', deadLetterReason: reason, updatedAt: new Date().toISOString() };
  const safeId = sanitizePathId(updated.messageId, 128) || `msg-${randomUUID()}`;
  const target = join(getDeadLetterDir(projectRoot), safeId + '.json');
  const tmp = target + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf-8');
  renameSync(tmp, target);
  // Reflect terminal state in the inbox record if present.
  try {
    const key = recipientKey(updated.to);
    const inboxPath = getInboxRecordPath(key, updated.messageId, projectRoot);
    if (existsSync(inboxPath)) writeInboxRecord(updated, projectRoot);
  } catch { /* inbox record absent -- dead-letter copy is authoritative */ }
  return updated;
}

/** Move a message to the dead-letter store with a reason (no silent drops). */
export async function deadLetterMessage(
  message: AgentMessage,
  reason: string,
  projectRoot = process.cwd(),
): Promise<void> {
  await withMessagesLock(async () => {
    deadLetterMessageUnsafe(message, reason, projectRoot);
  }, projectRoot);
}
