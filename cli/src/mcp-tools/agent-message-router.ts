/**
 * Agent Message Mediation Router -- P3 of the inter-agent communication design
 * (Knot hive-flow-2ee8 / hive-flow-ef30; design of record: 2ee8 knot note +
 * router 20260703T192135Z; Codex PLAN_REVIEW_PASS 20260703T192607Z).
 *
 * Generalized blocked/ask mediation on the message spine, built ALONGSIDE the
 * queen_permission_* channel (shared primitives, NO in-place migration):
 *
 *  - escalate: a blocked/ask message routes to its MEDIATOR -- the hive queen
 *    when the sender's persisted record carries a hiveId (queen resolved from
 *    the AUTHORITATIVE hive record + agent store, NEVER from agent_list or any
 *    runtime-merged live view -- statusboard drift C4/FM-12), else the sender's
 *    owning-parent session inbox.
 *  - Refusal gate (FM-11): a blocked or terminal-class escalation with no
 *    stated unblockCondition is REFUSED before any store write -- the same
 *    discipline the deferral ledger and queen deny-guidance enforce.
 *  - mediate: the mediator answers resume/redirect with MANDATORY guidance
 *    (redirect additionally requires redirectTask -- mirrors
 *    queen_permission_decide). The reply is ADVISORY ONLY: this router never
 *    dispatches tasks, never executes commands, never writes permission
 *    decisions or enforcement state. A mediation reply cannot bypass the
 *    enforcement ladder -- any tool call the unblocked agent then attempts is
 *    still gated by the hooks exactly as before.
 */

import type { MCPTool } from './types.js';
import {
  sendMessage,
  readInboxMessage,
  ackMessage,
  recipientKey,
  type AgentMessage,
  type BlockerClass,
  type MessagePriority,
} from './agent-message-store.js';
import { resolveDeliveryPlan, writeMessageWakeNotice, type DeliveryPlan } from './agent-message-tools.js';
import { loadAgentStore, resolveProjectRootFromInput } from './agent-tools.js';
import { loadHive, saveHive, withHiveLock } from './hive-store.js';

const ESCALATION_VERBS = ['blocked', 'ask'] as const;
const MEDIATION_VERBS = ['resume', 'redirect'] as const;
const BLOCKER_CLASSES: BlockerClass[] = ['self-redirectable', 'needs-mediation', 'terminal'];

type EscalationVerb = (typeof ESCALATION_VERBS)[number];
type MediationVerb = (typeof MEDIATION_VERBS)[number];

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

interface PersistedAgentLike {
  ownerSessionId?: string;
  ownerClientKind?: string;
  hiveId?: string;
  provider?: string;
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

// ---------------------------------------------------------------------------
// Mediator discovery (authoritative records ONLY)
// ---------------------------------------------------------------------------

export interface MediatorResolution {
  kind: 'queen' | 'owning-parent';
  to: { agentId?: string; ownerSessionId: string; ownerClientKind: string; hiveId?: string; role?: string };
  hiveId?: string;
}

type MediatorResult =
  | { ok: true; mediator: MediatorResolution }
  | { ok: false; error: string };

/**
 * Resolve the mediator for a sender. Reads ONLY the persisted agent store and
 * the hive record on disk -- deliberately no agent_list / runtime-merged view,
 * so a drifted statusboard (live-count 0, stale liveness, divergent "active"
 * flags) can never redirect an escalation (FM-12). The hive record's queenId is
 * authoritative even if some live view believes another agent is queen.
 */
export function resolveMediator(fromAgentId: string, projectRoot: string): MediatorResult {
  const sender = lookupPersistedAgent(fromAgentId, projectRoot);
  if (!sender) {
    return { ok: false, error: `unknown-sender: no persisted record for '${fromAgentId}'` };
  }

  if (sender.hiveId) {
    const hive = loadHive(sender.hiveId, projectRoot);
    if (hive?.queenId) {
      const queenRec = lookupPersistedAgent(hive.queenId, projectRoot);
      const ownerSessionId = queenRec?.ownerSessionId || hive.ownerSessionId || '';
      const ownerClientKind = queenRec?.ownerClientKind || hive.ownerClientKind || '';
      if (ownerSessionId && ownerClientKind) {
        return {
          ok: true,
          mediator: {
            kind: 'queen',
            hiveId: sender.hiveId,
            to: {
              agentId: hive.queenId,
              ownerSessionId,
              ownerClientKind,
              hiveId: sender.hiveId,
              role: 'queen',
            },
          },
        };
      }
      // Queen exists but has no resolvable ownership anywhere -- refuse rather
      // than guess an address (FM-3: no fabricated ownership).
      return {
        ok: false,
        error: `unaddressable-queen: hive '${sender.hiveId}' queen '${hive.queenId}' has no ownership stamp on its record or the hive record`,
      };
    }
    // Hive record missing/queenless -> fall through to owning-parent.
  }

  if (!sender.ownerSessionId || !sender.ownerClientKind) {
    return { ok: false, error: `unaddressable-parent: sender '${fromAgentId}' record has no ownership stamp` };
  }
  return {
    ok: true,
    mediator: {
      kind: 'owning-parent',
      to: { ownerSessionId: sender.ownerSessionId, ownerClientKind: sender.ownerClientKind },
    },
  };
}

// ---------------------------------------------------------------------------
// waiting-on-peer lifecycle (P4, Knot hive-flow-5de8)
//
// Mirrors permission-waiting: a hive worker with an outstanding escalation is
// NON-SETTLED (watcher allComplete excludes it) and NON-IDLE (the idle reaper's
// selection predicate is `status === 'idle'`, so a waiting worker is
// structurally never reclaimed -- the reaper carve-out is data-driven, no
// reaper change needed). Best-effort lifecycle truth: failures never fail the
// messaging operation itself.
// ---------------------------------------------------------------------------

async function setHiveWorkerWaitingState(
  agentId: string,
  waiting: boolean,
  projectRoot: string,
): Promise<boolean> {
  try {
    const rec = lookupPersistedAgent(agentId, projectRoot);
    if (!rec?.hiveId) return false;
    const hiveId = rec.hiveId;
    return await withHiveLock(hiveId, async () => {
      const hive = loadHive(hiveId, projectRoot);
      if (!hive) return false;
      const worker = (hive.workers || []).find(w => w.agentId === agentId);
      if (!worker) return false;
      if (waiting) {
        if (worker.status === 'waiting-on-peer') return true;
        if (worker.status === 'terminated') return false;
        worker.status = 'waiting-on-peer';
      } else {
        if (worker.status !== 'waiting-on-peer') return false;
        worker.status = 'idle';
        // Fresh idle clock: the reaper measures idleness from idleSince, and a
        // just-unblocked worker has not been idling since before it waited.
        (worker as { idleSince?: string }).idleSince = new Date().toISOString();
      }
      saveHive(hiveId, hive, projectRoot);
      return true;
    }, projectRoot);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Escalation (blocked/ask -> mediator)
// ---------------------------------------------------------------------------

export interface EscalateInput {
  fromAgentId: string;
  body: string;
  verb?: EscalationVerb;
  blockerClass?: BlockerClass;
  unblockCondition?: string;
  conversationId?: string;
  priority?: MessagePriority;
}

export async function escalateBlockedMessage(
  input: EscalateInput,
  projectRoot: string,
): Promise<
  | { success: true; message: AgentMessage; mediator: MediatorResolution; delivery: DeliveryPlan; wakeNotified: boolean; senderMarkedWaiting: boolean }
  | { success: false; error: string }
> {
  const verb: EscalationVerb = input.verb ?? 'blocked';
  if (!ESCALATION_VERBS.includes(verb)) {
    return { success: false, error: `invalid-escalation-verb: '${String(input.verb)}'. Valid: ${ESCALATION_VERBS.join(', ')}` };
  }
  if (!input.body?.trim()) return { success: false, error: 'body-required' };

  // Refusal gate BEFORE any store write (FM-11): no escalation without a
  // stated unblock condition for blocked / terminal-class messages.
  const unblockCondition = str(input.unblockCondition);
  if ((verb === 'blocked' || input.blockerClass === 'terminal') && !unblockCondition) {
    return {
      success: false,
      error: 'unblock-condition-required: the router refuses to escalate a blocked/terminal message without a stated unblock condition',
    };
  }

  const mediatorResult = resolveMediator(input.fromAgentId, projectRoot);
  if (!mediatorResult.ok) return { success: false, error: mediatorResult.error };
  const { mediator } = mediatorResult;

  try {
    const message = await sendMessage({
      fromAgentId: input.fromAgentId,
      to: mediator.to,
      verb,
      body: input.body,
      ...(input.blockerClass ? { blockerClass: input.blockerClass } : {}),
      ...(unblockCondition ? { unblockCondition } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      priority: input.priority ?? 'high',
      requiresAck: true,
    }, projectRoot);
    const wakeNotified = writeMessageWakeNotice(message, projectRoot);
    const delivery = resolveDeliveryPlan(message.to, projectRoot);
    // P4: the escalation is durable -- mark the sender's hive worker
    // waiting-on-peer (non-settled for the watcher, non-idle for the reaper).
    const senderMarkedWaiting = await setHiveWorkerWaitingState(input.fromAgentId, true, projectRoot);
    return { success: true, message, mediator, delivery, wakeNotified, senderMarkedWaiting };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Mediation (resume/redirect reply -- ADVISORY ONLY)
// ---------------------------------------------------------------------------

export interface MediateInput {
  mediatorAgentId: string;
  messageId: string;
  decision: MediationVerb;
  guidance: string;
  redirectTask?: string;
}

export async function mediateMessage(
  input: MediateInput,
  projectRoot: string,
): Promise<
  | { success: true; reply: AgentMessage; originalAcked: boolean; advisory: true; delivery: DeliveryPlan; wakeNotified: boolean; senderWaitingCleared: boolean }
  | { success: false; error: string }
> {
  const decision = input.decision;
  if (!MEDIATION_VERBS.includes(decision)) {
    return { success: false, error: `invalid-mediation-verb: '${String(decision)}'. Valid: ${MEDIATION_VERBS.join(', ')}` };
  }
  // Mandatory-guidance discipline, mirroring queen_permission_decide:
  // every mediation reply carries guidance; redirect also names the safe
  // replacement task.
  const guidance = str(input.guidance);
  if (!guidance) {
    return { success: false, error: 'guidance-required: a mediation reply must carry guidance for the blocked agent' };
  }
  const redirectTask = str(input.redirectTask);
  if (decision === 'redirect' && !redirectTask) {
    return { success: false, error: 'redirect-task-required: decision=redirect must name the safe replacement task' };
  }

  const mediatorAgentId = str(input.mediatorAgentId);
  const mediatorRec = mediatorAgentId ? lookupPersistedAgent(mediatorAgentId, projectRoot) : null;
  if (!mediatorRec?.ownerSessionId || !mediatorRec.ownerClientKind) {
    return { success: false, error: `unknown-mediator: '${mediatorAgentId}' has no persisted ownership record` };
  }

  // The escalation lives in the MEDIATOR's inbox. Two candidate addresses
  // (Codex bounce 20260703T230451Z): the mediator's own agent-addressed inbox
  // (queen path), then the mediator's OWNER SESSION-LEVEL inbox -- owning-parent
  // escalations from hiveless senders are addressed to the parent session
  // (agentId ''), and any persisted agent OWNED BY that session may mediate
  // them. Both keys derive from the mediator's OWN persisted record, so a
  // mediator owned by a different session computes a different session key and
  // structurally cannot see the escalation (cross-session mediation impossible).
  const messageId = str(input.messageId);
  const agentAddress = {
    agentId: mediatorAgentId,
    ownerSessionId: mediatorRec.ownerSessionId,
    ownerClientKind: mediatorRec.ownerClientKind,
  };
  const sessionAddress = {
    ownerSessionId: mediatorRec.ownerSessionId,
    ownerClientKind: mediatorRec.ownerClientKind,
  };
  let inboxAddress: { agentId?: string; ownerSessionId: string; ownerClientKind: string } = agentAddress;
  let original = readInboxMessage(recipientKey(agentAddress), messageId, projectRoot);
  if (!original.ok && original.reason === 'not-found') {
    // Only a clean miss falls through; a corrupt agent-inbox record keeps its
    // own error (never masked by the session-level lookup).
    inboxAddress = sessionAddress;
    original = readInboxMessage(recipientKey(sessionAddress), messageId, projectRoot);
  }
  if (!original.ok) {
    return { success: false, error: `original-not-found: ${original.reason}` };
  }
  const originalMessage = original.message;
  if (!ESCALATION_VERBS.includes(originalMessage.verb as EscalationVerb)) {
    return { success: false, error: `not-mediatable: verb=${originalMessage.verb} (only ${ESCALATION_VERBS.join('/')} escalations are mediated)` };
  }

  // ADVISORY ONLY: the reply is a message, never an execution. No task is
  // dispatched, no permission decision recorded, no enforcement state touched.
  // The [ADVISORY] framing makes the non-authority explicit to the recipient.
  const bodyLines = [
    `[ADVISORY] Mediation ${decision} for ${originalMessage.messageId}.`,
    `guidance: ${guidance}`,
  ];
  if (redirectTask) bodyLines.push(`redirectTask: ${redirectTask}`);
  bodyLines.push('This reply carries no execution authority; denied tools remain denied by the enforcement ladder.');

  try {
    const reply = await sendMessage({
      fromAgentId: mediatorAgentId,
      to: originalMessage.from,
      verb: decision,
      body: bodyLines.join('\n'),
      conversationId: originalMessage.conversationId,
      replyTo: originalMessage.messageId,
      seq: (originalMessage.seq ?? 0) + 1,
      // P4 loop bound: replies inherit the conversation's hop budget. A
      // mediation ping-pong chain increments hop each round and dead-letters
      // at maxHops instead of looping forever (FM-10).
      hop: (originalMessage.hop ?? 0) + 1,
      maxHops: originalMessage.maxHops,
      priority: originalMessage.priority,
    }, projectRoot);
    if (reply.deliveryState === 'dead-letter') {
      // The reply died at the loop bound: the escalation stays un-acked and
      // the worker stays waiting -- no false mediation success.
      return { success: false, error: `reply-dead-lettered: ${reply.deadLetterReason ?? 'dead-letter'}` };
    }
    const wakeNotified = writeMessageWakeNotice(reply, projectRoot);
    const delivery = resolveDeliveryPlan(reply.to, projectRoot);
    // Mediation consumes the escalation: ack it at the ADDRESS IT WAS FOUND AT
    // (agent inbox for queen-path, session-level inbox for owning-parent-path;
    // at-most-once -- a duplicate mediation attempt surfaces alreadyAcked).
    const ackResult = await ackMessage(inboxAddress, originalMessage.messageId, projectRoot);
    // P4: the wait is answered -- restore the sender's hive worker to idle
    // with a fresh idle clock.
    const senderWaitingCleared = await setHiveWorkerWaitingState(originalMessage.from.agentId, false, projectRoot);
    return { success: true, reply, originalAcked: ackResult.acked, advisory: true, delivery, wakeNotified, senderWaitingCleared };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

export const agentMessageRouterTools: MCPTool[] = [
  {
    name: 'agent_message_escalate',
    description: 'Escalate a blocked/ask message to its mediator: the hive queen when the sender has a hiveId (resolved from the authoritative hive record, never agent_list), else the owning-parent session. Refuses blocked/terminal escalations without an unblockCondition. Mediation is advisory and cannot bypass the enforcement ladder.',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        fromAgentId: { type: 'string', description: 'Blocked sender agent id (must be persisted; ownership stamped from its record).' },
        body: { type: 'string', description: 'What is blocked and why.' },
        verb: { type: 'string', enum: [...ESCALATION_VERBS], description: 'Escalation verb (default blocked).' },
        blockerClass: { type: 'string', enum: [...BLOCKER_CLASSES], description: 'Blocker classification.' },
        unblockCondition: { type: 'string', description: 'REQUIRED for blocked/terminal: the condition that unblocks the work.' },
        conversationId: { type: 'string', description: 'Optional conversation id (minted when absent).' },
        priority: { type: 'string', enum: ['urgent', 'high', 'normal', 'low'], description: 'Priority (default high).' },
        projectRoot: { type: 'string', description: 'Effective project root override.' },
        cwd: { type: 'string', description: 'Alias for projectRoot.' },
      },
      required: ['fromAgentId', 'body'],
    },
    handler: async (input) => {
      const rootResult = resolveProjectRootFromInput(input);
      if (!rootResult.ok) return { success: false, error: rootResult.error };
      return escalateBlockedMessage({
        fromAgentId: str(input.fromAgentId),
        body: typeof input.body === 'string' ? input.body : '',
        ...(str(input.verb) ? { verb: str(input.verb) as EscalationVerb } : {}),
        ...(str(input.blockerClass) ? { blockerClass: str(input.blockerClass) as BlockerClass } : {}),
        ...(str(input.unblockCondition) ? { unblockCondition: str(input.unblockCondition) } : {}),
        ...(str(input.conversationId) ? { conversationId: str(input.conversationId) } : {}),
        ...(str(input.priority) ? { priority: str(input.priority) as MessagePriority } : {}),
      }, rootResult.projectRoot);
    },
  },
  {
    name: 'agent_message_mediate',
    description: 'Answer a blocked/ask escalation as its mediator with resume or redirect. Guidance is mandatory; redirect additionally requires redirectTask (mirrors queen_permission_decide). The reply is ADVISORY ONLY -- it never executes anything and cannot bypass the enforcement ladder. Acks the original escalation at-most-once.',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        mediatorAgentId: { type: 'string', description: 'Mediator agent id (must be persisted; the escalation must be in its inbox).' },
        messageId: { type: 'string', description: 'The escalation messageId being answered.' },
        decision: { type: 'string', enum: [...MEDIATION_VERBS], description: 'resume (continue original work) or redirect (do the safe replacement).' },
        guidance: { type: 'string', description: 'REQUIRED: how the blocked agent should proceed.' },
        redirectTask: { type: 'string', description: 'REQUIRED for decision=redirect: the safe replacement task.' },
        projectRoot: { type: 'string', description: 'Effective project root override.' },
        cwd: { type: 'string', description: 'Alias for projectRoot.' },
      },
      required: ['mediatorAgentId', 'messageId', 'decision', 'guidance'],
    },
    handler: async (input) => {
      const rootResult = resolveProjectRootFromInput(input);
      if (!rootResult.ok) return { success: false, error: rootResult.error };
      return mediateMessage({
        mediatorAgentId: str(input.mediatorAgentId),
        messageId: str(input.messageId),
        decision: str(input.decision) as MediationVerb,
        guidance: typeof input.guidance === 'string' ? input.guidance : '',
        ...(str(input.redirectTask) ? { redirectTask: str(input.redirectTask) } : {}),
      }, rootResult.projectRoot);
    },
  },
];
