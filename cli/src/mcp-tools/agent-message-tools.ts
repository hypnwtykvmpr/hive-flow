/**
 * Agent Message MCP Tools -- operator/agent surface over the P1 message store.
 *
 * P2a of the inter-agent communication design (Knot hive-flow-2ee8 / hive-flow-abc9;
 * design of record: 2ee8 knot note + router 20260703T192135Z; Codex PLAN_REVIEW_PASS
 * 20260703T192607Z). Three tools: agent_message_send / agent_message_inbox /
 * agent_message_ack. Delivery to provider agents happens pull-at-dispatch in the
 * provider bridge (flag-gated); these tools are the durable send/read/ack surface.
 *
 * Anti-forgery: sender ownership is stamped inside the store from the persisted
 * AgentRecord (sendMessage rejects unknown senders). Recipient addressing resolves
 * from the persisted record when an agentId is given; otherwise it must be explicit
 * (ownerSessionId + ownerClientKind). Nothing is re-derived from env at read time.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { MCPTool } from './types.js';
import {
  sendMessage,
  listInbox,
  ackMessage,
  type AgentMessage,
  type MessageVerb,
  type MessagePriority,
  type BlockerClass,
} from './agent-message-store.js';
import { loadAgentStore, resolveProjectRootFromInput } from './agent-tools.js';
import { resolveOwnerStampOrError } from './session-id.js';

const MESSAGE_VERBS: MessageVerb[] = ['ask', 'inform', 'handoff', 'blocked', 'reply', 'ack', 'resume', 'redirect'];
const MESSAGE_PRIORITIES: MessagePriority[] = ['urgent', 'high', 'normal', 'low'];
const BLOCKER_CLASSES: BlockerClass[] = ['self-redirectable', 'needs-mediation', 'terminal'];

// NUL separator built via fromCharCode so the source stays pure ASCII (a literal
// NUL byte makes git classify the file as binary). Matches the wake-path scheme
// sha256(clientKind NUL sessionId) used by the bridge and .claude/helpers/wake-paths.cjs.
const SEP = String.fromCharCode(0);

interface PersistedAgentLike {
  ownerSessionId?: string;
  ownerClientKind?: string;
  hiveId?: string;
}

interface RecipientAddress {
  agentId?: string;
  ownerSessionId: string;
  ownerClientKind: string;
  hiveId?: string;
  role?: string;
}

type AddressResult =
  | { ok: true; to: RecipientAddress }
  | { ok: false; error: string };

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function lookupPersistedAgent(agentId: string, projectRoot: string): PersistedAgentLike | null {
  try {
    const store = loadAgentStore(projectRoot);
    const rec = store.agents?.[agentId] as PersistedAgentLike | undefined;
    return rec ?? null;
  } catch {
    return null;
  }
}

/** Resolve where a message is going. Persisted record wins; explicit pair is the
 *  fallback; there is no env-derived guessing for send targets. */
function resolveSendRecipient(input: Record<string, unknown>, projectRoot: string): AddressResult {
  const toAgentId = str(input.toAgentId);
  const explicitSession = str(input.toOwnerSessionId);
  const explicitKind = str(input.toOwnerClientKind);

  if (toAgentId) {
    const rec = lookupPersistedAgent(toAgentId, projectRoot);
    if (rec?.ownerSessionId && rec.ownerClientKind) {
      return {
        ok: true,
        to: {
          agentId: toAgentId,
          ownerSessionId: rec.ownerSessionId,
          ownerClientKind: rec.ownerClientKind,
          ...(rec.hiveId ? { hiveId: rec.hiveId } : {}),
          ...(str(input.toRole) ? { role: str(input.toRole) } : {}),
        },
      };
    }
    // Persisted record missing/unstamped: explicit addressing may still target the
    // agent's inbox, but we refuse to guess.
    if (explicitSession && explicitKind) {
      return {
        ok: true,
        to: {
          agentId: toAgentId,
          ownerSessionId: explicitSession,
          ownerClientKind: explicitKind,
          ...(str(input.toHiveId) ? { hiveId: str(input.toHiveId) } : {}),
          ...(str(input.toRole) ? { role: str(input.toRole) } : {}),
        },
      };
    }
    return {
      ok: false,
      error: `unknown-recipient: agent '${toAgentId}' has no persisted ownership record; pass toOwnerSessionId + toOwnerClientKind explicitly`,
    };
  }

  if (explicitSession && explicitKind) {
    return {
      ok: true,
      to: {
        ownerSessionId: explicitSession,
        ownerClientKind: explicitKind,
        ...(str(input.toHiveId) ? { hiveId: str(input.toHiveId) } : {}),
        ...(str(input.toRole) ? { role: str(input.toRole) } : {}),
      },
    };
  }

  return {
    ok: false,
    error: 'recipient-required: pass toAgentId (persisted agent) or toOwnerSessionId + toOwnerClientKind',
  };
}

/** Resolve which inbox a read/ack targets. Persisted agentId wins; explicit pair
 *  next; otherwise the caller's own trusted session stamp (session-level inbox). */
function resolveInboxAddress(
  input: Record<string, unknown>,
  context: Record<string, unknown> | undefined,
  surface: string,
  projectRoot: string,
): AddressResult {
  const agentId = str(input.agentId);
  const explicitSession = str(input.ownerSessionId);
  const explicitKind = str(input.ownerClientKind);

  if (agentId) {
    const rec = lookupPersistedAgent(agentId, projectRoot);
    if (rec?.ownerSessionId && rec.ownerClientKind) {
      return {
        ok: true,
        to: { agentId, ownerSessionId: rec.ownerSessionId, ownerClientKind: rec.ownerClientKind },
      };
    }
    if (explicitSession && explicitKind) {
      return { ok: true, to: { agentId, ownerSessionId: explicitSession, ownerClientKind: explicitKind } };
    }
    return {
      ok: false,
      error: `unknown-agent: '${agentId}' has no persisted ownership record; pass ownerSessionId + ownerClientKind explicitly`,
    };
  }

  if (explicitSession && explicitKind) {
    return { ok: true, to: { ownerSessionId: explicitSession, ownerClientKind: explicitKind } };
  }

  const stamp = resolveOwnerStampOrError(input, process.env, context, surface);
  if (!stamp.success) return { ok: false, error: stamp.error };
  return { ok: true, to: { ownerSessionId: stamp.ownerSessionId, ownerClientKind: stamp.ownerClientKind } };
}

// ---------------------------------------------------------------------------
// Wake notice (best-effort; never fails a send)
// ---------------------------------------------------------------------------

/** Mirrors bridgeWakeClientKind in provider-agent-bridge.mjs. */
function wakeClientKind(kind: string): string {
  const raw = kind.toLowerCase();
  if (raw.includes('codex')) return 'codex';
  if (raw.includes('claude')) return 'claude-code';
  return kind;
}

function wakeTargetAgent(kind: string): string | null {
  const raw = kind.toLowerCase();
  if (raw.includes('codex')) return 'codex';
  if (raw.includes('claude')) return 'claude';
  return null;
}

/** Mirrors bridgeResolveHiveHome / wake-paths.cjs resolveHiveHome. */
function resolveHiveHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = str(env.HIVE_FLOW_HOME);
  if (configured && isAbsolute(configured)) return resolve(configured);
  return join(homedir(), '.hive-flow');
}

/** Session key parity with wake-paths.cjs: s_<sha256(clientKind NUL session)[0..32]>. */
function wakeSessionKey(ownerClientKind: string, ownerSessionId: string): string {
  const kind = wakeClientKind(ownerClientKind);
  const digest = createHash('sha256').update([kind, ownerSessionId].join(SEP)).digest('hex').slice(0, 32);
  return `s_${digest}`;
}

/**
 * Drop a wake notice for the recipient's owner session so the Stop/SessionStart/
 * UserPromptSubmit drain (drain-notifications.cjs) surfaces the message as
 * additionalContext. At-most-once per messageId per directory via an O_EXCL marker
 * (same pattern as the bridge's appendTaskNotificationOnce). Best-effort.
 */
function writeMessageWakeNotice(message: AgentMessage, projectRoot: string): boolean {
  // The ack instruction must carry the SAME addressing as the inbox instruction:
  // an agent-addressed message acked without agentId resolves the caller's
  // session-level inbox and never acks (Codex bounce 20260703T223229Z).
  const inboxArgs = message.to.agentId ? `{agentId:"${message.to.agentId}"}` : '{}';
  const ackArgs = message.to.agentId
    ? `{messageId:"${message.messageId}", agentId:"${message.to.agentId}"}`
    : `{messageId:"${message.messageId}"}`;
  const summary =
    `[AGENT MESSAGE: ${message.messageId}] from=${message.from.agentId} verb=${message.verb} ` +
    `priority=${message.priority}. Read with agent_message_inbox(${inboxArgs}); ` +
    `ack with agent_message_ack(${ackArgs}).`;
  const line = JSON.stringify({
    kind: 'agent-message',
    messageId: message.messageId,
    ts: new Date().toISOString(),
    summary,
    projectRoot,
    ...(message.to.agentId ? { agentId: message.to.agentId } : {}),
    ownerClientKind: message.to.ownerClientKind,
    ...(wakeTargetAgent(message.to.ownerClientKind) ? { targetAgent: wakeTargetAgent(message.to.ownerClientKind) } : {}),
  });
  const dirs = [
    join(projectRoot, '.hive-flow', 'data'),
    join(resolveHiveHome(), 'wake', 'sessions', wakeSessionKey(message.to.ownerClientKind, message.to.ownerSessionId)),
  ];
  const safeId = message.messageId.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120);
  let notified = false;
  for (const dir of dirs) {
    let fd: number | null = null;
    try {
      mkdirSync(dir, { recursive: true });
      fd = openSync(join(dir, `message-${safeId}.notified`), 'wx', 0o600);
      appendFileSync(join(dir, 'pending-notifications.jsonl'), line + '\n', 'utf8');
      writeFileSync(fd, JSON.stringify({ claimedAt: new Date().toISOString(), pid: process.pid, source: 'agent-message-send' }) + '\n', 'utf8');
      notified = true;
    } catch {
      // marker exists (already notified) or dir unwritable -- both non-fatal
    } finally {
      if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    }
  }
  return notified;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const agentMessageTools: MCPTool[] = [
  {
    name: 'agent_message_send',
    description: 'Send a durable inter-agent message. Sender ownership is stamped from the persisted agent record (unknown senders are rejected). Recipient resolves from a persisted agentId or explicit ownerSessionId + ownerClientKind. Delivery to provider agents is pull-at-dispatch (flag HIVE_FLOW_AGENT_MESSAGING); a wake notice is dropped for the recipient owner session.',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        fromAgentId: { type: 'string', description: 'Sender agent id. Must be a persisted agent with ownership; the stamp comes from the record, not this input.' },
        toAgentId: { type: 'string', description: 'Recipient agent id. Ownership resolves from its persisted record.' },
        toOwnerSessionId: { type: 'string', description: 'Explicit recipient owner session id (required when toAgentId is absent or unpersisted).' },
        toOwnerClientKind: { type: 'string', description: 'Explicit recipient owner client kind (pairs with toOwnerSessionId).' },
        toHiveId: { type: 'string', description: 'Optional recipient hive id.' },
        toRole: { type: 'string', description: 'Optional recipient role hint.' },
        verb: { type: 'string', enum: [...MESSAGE_VERBS], description: 'Message verb.' },
        body: { type: 'string', description: 'Message body.' },
        conversationId: { type: 'string', description: 'Optional conversation id (minted when absent).' },
        replyTo: { type: 'string', description: 'messageId this message answers.' },
        priority: { type: 'string', enum: [...MESSAGE_PRIORITIES], description: 'Delivery priority (default normal).' },
        blockerClass: { type: 'string', enum: [...BLOCKER_CLASSES], description: 'Blocker classification for verb=blocked.' },
        unblockCondition: { type: 'string', description: 'Required for verb=blocked and blockerClass=terminal.' },
        requiresAck: { type: 'boolean', description: 'Whether the recipient must ack.' },
        ttlMs: { type: 'number', description: 'Optional time-to-live in ms.' },
        projectRoot: { type: 'string', description: 'Effective project root override.' },
        cwd: { type: 'string', description: 'Alias for projectRoot.' },
      },
      required: ['fromAgentId', 'verb', 'body'],
    },
    handler: async (input) => {
      const rootResult = resolveProjectRootFromInput(input);
      if (!rootResult.ok) return { success: false, error: rootResult.error };
      const projectRoot = rootResult.projectRoot;

      const verb = str(input.verb) as MessageVerb;
      if (!MESSAGE_VERBS.includes(verb)) {
        return { success: false, error: `invalid-verb: '${String(input.verb ?? '')}'. Valid: ${MESSAGE_VERBS.join(', ')}` };
      }
      const body = typeof input.body === 'string' ? input.body : '';
      if (!body.trim()) return { success: false, error: 'body-required' };

      const recipient = resolveSendRecipient(input, projectRoot);
      if (!recipient.ok) return { success: false, error: recipient.error };

      try {
        const message = await sendMessage({
          fromAgentId: str(input.fromAgentId),
          to: recipient.to,
          verb,
          body,
          ...(str(input.conversationId) ? { conversationId: str(input.conversationId) } : {}),
          ...(str(input.replyTo) ? { replyTo: str(input.replyTo) } : {}),
          ...(str(input.priority) ? { priority: str(input.priority) as MessagePriority } : {}),
          ...(str(input.blockerClass) ? { blockerClass: str(input.blockerClass) as BlockerClass } : {}),
          ...(str(input.unblockCondition) ? { unblockCondition: str(input.unblockCondition) } : {}),
          ...(typeof input.requiresAck === 'boolean' ? { requiresAck: input.requiresAck } : {}),
          ...(typeof input.ttlMs === 'number' && Number.isFinite(input.ttlMs) ? { ttlMs: input.ttlMs } : {}),
        }, projectRoot);
        const wakeNotified = writeMessageWakeNotice(message, projectRoot);
        return { success: true, message, wakeNotified };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'agent_message_inbox',
    description: 'List pending/delivered inter-agent messages for an inbox. Addressing: persisted agentId, explicit ownerSessionId + ownerClientKind, or (default) the caller session inbox. Corrupt/tampered records are durably dead-lettered and reported, never silently dropped.',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Inbox owner agent id (resolves ownership from its persisted record).' },
        ownerSessionId: { type: 'string', description: 'Explicit inbox owner session id (session-level inbox when agentId is absent).' },
        ownerClientKind: { type: 'string', description: 'Explicit inbox owner client kind (pairs with ownerSessionId).' },
        includeTerminal: { type: 'boolean', description: 'Include acked/dead-letter/expired records (default false).' },
        projectRoot: { type: 'string', description: 'Effective project root override.' },
        cwd: { type: 'string', description: 'Alias for projectRoot.' },
      },
      required: [],
    },
    handler: async (input, context) => {
      const rootResult = resolveProjectRootFromInput(input);
      if (!rootResult.ok) return { success: false, error: rootResult.error };
      const projectRoot = rootResult.projectRoot;

      const address = resolveInboxAddress(input, context, 'agent_message_inbox', projectRoot);
      if (!address.ok) return { success: false, error: address.error };

      try {
        const { messages, deadLetters } = listInbox(address.to, projectRoot, {
          includeTerminal: input.includeTerminal === true,
        });
        return { success: true, count: messages.length, messages, deadLetters };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'agent_message_ack',
    description: 'Acknowledge an inter-agent message at-most-once. A missing or corrupt/tampered record is never acked (corrupt records are durably dead-lettered); a duplicate ack is a safe no-op.',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'Message id to acknowledge.' },
        agentId: { type: 'string', description: 'Inbox owner agent id (resolves ownership from its persisted record).' },
        ownerSessionId: { type: 'string', description: 'Explicit inbox owner session id.' },
        ownerClientKind: { type: 'string', description: 'Explicit inbox owner client kind.' },
        projectRoot: { type: 'string', description: 'Effective project root override.' },
        cwd: { type: 'string', description: 'Alias for projectRoot.' },
      },
      required: ['messageId'],
    },
    handler: async (input, context) => {
      const rootResult = resolveProjectRootFromInput(input);
      if (!rootResult.ok) return { success: false, error: rootResult.error };
      const projectRoot = rootResult.projectRoot;

      const messageId = str(input.messageId);
      if (!messageId) return { success: false, error: 'messageId-required' };

      const address = resolveInboxAddress(input, context, 'agent_message_ack', projectRoot);
      if (!address.ok) return { success: false, error: address.error };

      try {
        const result = await ackMessage(address.to, messageId, projectRoot);
        return {
          success: result.acked,
          acked: result.acked,
          alreadyAcked: result.alreadyAcked,
          ...(result.reason ? { reason: result.reason } : {}),
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
];
