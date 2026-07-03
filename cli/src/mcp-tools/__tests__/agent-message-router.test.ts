// cli/src/mcp-tools/__tests__/agent-message-router.test.ts
//
// P3 (Knot hive-flow-ef30): mediation router on the message spine.
//
// Acceptance coverage:
//   1. Escalation REFUSED without unblockCondition (blocked/terminal), with no
//      store write at all -- the refusal gate runs before any persistence.
//   2. Mediation cannot bypass enforcement: replies are ADVISORY messages only;
//      nothing is executed, no task artifacts appear, no permission/enforcement
//      state changes, and the persisted agent/hive records stay byte-identical.
//   3. Recipient discovery ignores agent_list drift: the mediator comes from the
//      AUTHORITATIVE hive record (queenId) + persisted agent store, even when a
//      runtime/live view would disagree (e.g. the record-designated queen looks
//      terminated while another agent looks active).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  agentMessageRouterTools,
  escalateBlockedMessage,
  mediateMessage,
  resolveMediator,
} from '../agent-message-router.js';
import { listInbox, readInboxMessage, recipientKey } from '../agent-message-store.js';

let root: string;
let home: string;
let savedHome: string | undefined;

const HIVE_ID = 'hive-h1';
const WORKER = { agentId: 'agent-worker', ownerSessionId: 'sess-owner', ownerClientKind: 'codex', hiveId: HIVE_ID };
// The hive record designates queen-b; queen-a merely LOOKS live. Discovery must
// follow the record, not liveness appearance.
const QUEEN_A = { agentId: 'agent-queen-a', ownerSessionId: 'sess-owner', ownerClientKind: 'codex', status: 'active' };
const QUEEN_B = { agentId: 'agent-queen-b', ownerSessionId: 'sess-queen-b', ownerClientKind: 'claude-code', status: 'terminated' };
const LONER = { agentId: 'agent-loner', ownerSessionId: 'sess-parent', ownerClientKind: 'claude-code' };
// Owned by the SAME parent session as LONER: may mediate the session-level
// owning-parent inbox. QUEEN_B (sess-queen-b) is the cross-session control.
const PARENT_HELPER = { agentId: 'agent-parent-helper', ownerSessionId: 'sess-parent', ownerClientKind: 'claude-code' };

function tool(name: string) {
  const found = agentMessageRouterTools.find(t => t.name === name);
  if (!found) throw new Error(`tool not registered: ${name}`);
  return found;
}

function agentStorePath(): string {
  return join(root, '.hive-flow', 'agents', 'store.json');
}
function hiveRecordPath(): string {
  return join(root, '.hive-flow', 'hives', HIVE_ID, 'hive.json');
}

function seedFixtures(): void {
  const agentsDir = join(root, '.hive-flow', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  const agents: Record<string, unknown> = {};
  for (const a of [WORKER, QUEEN_A, QUEEN_B, LONER, PARENT_HELPER]) {
    agents[a.agentId] = {
      agentId: a.agentId,
      agentType: 'coder',
      status: (a as { status?: string }).status ?? 'idle',
      health: 'healthy',
      taskCount: 0,
      config: {},
      createdAt: new Date().toISOString(),
      ownerSessionId: a.ownerSessionId,
      ownerClientKind: a.ownerClientKind,
      ...((a as { hiveId?: string }).hiveId ? { hiveId: (a as { hiveId?: string }).hiveId } : {}),
    };
  }
  writeFileSync(agentStorePath(), JSON.stringify({ version: 3, agents }, null, 2), 'utf-8');

  const hiveDir = join(root, '.hive-flow', 'hives', HIVE_ID);
  mkdirSync(hiveDir, { recursive: true });
  writeFileSync(hiveRecordPath(), JSON.stringify({
    hiveId: HIVE_ID,
    queenId: QUEEN_B.agentId,
    status: 'active',
    ownerSessionId: 'sess-hive-owner',
    ownerClientKind: 'claude-code',
    workers: [
      // P4: the escalating worker is a hive member so the waiting-on-peer
      // lifecycle (escalate -> waiting, mediate -> idle) is observable.
      { workerId: 'w-1', agentId: WORKER.agentId, role: 'coder', provider: 'deepseek', status: 'idle', spawnedAt: new Date().toISOString() },
    ],
    budget: {},
    audit: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');
}

function escalate(over: Record<string, unknown> = {}) {
  return escalateBlockedMessage({
    fromAgentId: WORKER.agentId,
    body: 'web_fetch denied by the allowlist gate; cannot ground the doc claim',
    blockerClass: 'needs-mediation',
    unblockCondition: 'mediator approves an alternate grounding source or redirects',
    ...over,
  } as Parameters<typeof escalateBlockedMessage>[0], root);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hf-iac-p3-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'hf-iac-p3-home-')));
  savedHome = process.env.HIVE_FLOW_HOME;
  process.env.HIVE_FLOW_HOME = home;
  seedFixtures();
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HIVE_FLOW_HOME;
  else process.env.HIVE_FLOW_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Acceptance 1: escalation refused without unblockCondition
// ---------------------------------------------------------------------------

describe('escalation refusal gate', () => {
  it('refuses a blocked escalation without unblockCondition and writes NOTHING', async () => {
    const res = await escalate({ unblockCondition: undefined });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toMatch(/unblock-condition-required/);
    // Refusal happens before persistence: no message store exists at all.
    expect(existsSync(join(root, '.hive-flow', 'messages'))).toBe(false);
  });

  it('refuses a terminal-class ask without unblockCondition', async () => {
    const res = await escalate({ verb: 'ask', blockerClass: 'terminal', unblockCondition: undefined });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toMatch(/unblock-condition-required/);
  });

  it('allows a plain ask without unblockCondition (not a blocked/terminal escalation)', async () => {
    const res = await escalate({ verb: 'ask', blockerClass: undefined, unblockCondition: undefined });
    expect(res.success).toBe(true);
  });

  it('the MCP tool surface enforces the same gate', async () => {
    const res = await tool('agent_message_escalate').handler({
      fromAgentId: WORKER.agentId,
      body: 'blocked on denied tool',
      projectRoot: root,
    }) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unblock-condition-required/);
  });
});

// ---------------------------------------------------------------------------
// Acceptance 3: mediator discovery from authoritative records only
// ---------------------------------------------------------------------------

describe('mediator discovery ignores live-view drift', () => {
  it('routes to the hive-record queen even though it looks terminated while another agent looks active', () => {
    const res = resolveMediator(WORKER.agentId, root);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.mediator.kind).toBe('queen');
      // The record-designated queen-b (status terminated) wins; the
      // active-looking queen-a is never considered.
      expect(res.mediator.to.agentId).toBe(QUEEN_B.agentId);
      expect(res.mediator.to.ownerSessionId).toBe(QUEEN_B.ownerSessionId);
      expect(res.mediator.hiveId).toBe(HIVE_ID);
    }
  });

  it('falls back to the owning-parent session for hiveless senders', () => {
    const res = resolveMediator(LONER.agentId, root);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.mediator.kind).toBe('owning-parent');
      expect(res.mediator.to).toEqual({ ownerSessionId: LONER.ownerSessionId, ownerClientKind: LONER.ownerClientKind });
    }
  });

  it('falls back to the owning-parent when the hive record is missing', () => {
    rmSync(join(root, '.hive-flow', 'hives'), { recursive: true, force: true });
    const res = resolveMediator(WORKER.agentId, root);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.mediator.kind).toBe('owning-parent');
  });

  it('refuses rather than guess when the queen has no ownership anywhere', () => {
    // Strip queen-b's stamps from BOTH the agent store and the hive record.
    const store = JSON.parse(readFileSync(agentStorePath(), 'utf-8'));
    delete store.agents[QUEEN_B.agentId].ownerSessionId;
    delete store.agents[QUEEN_B.agentId].ownerClientKind;
    writeFileSync(agentStorePath(), JSON.stringify(store, null, 2), 'utf-8');
    const hive = JSON.parse(readFileSync(hiveRecordPath(), 'utf-8'));
    delete hive.ownerSessionId;
    delete hive.ownerClientKind;
    writeFileSync(hiveRecordPath(), JSON.stringify(hive, null, 2), 'utf-8');

    const res = resolveMediator(WORKER.agentId, root);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unaddressable-queen/);
  });

  it('unknown senders are refused', () => {
    const res = resolveMediator('agent-ghost', root);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unknown-sender/);
  });
});

// ---------------------------------------------------------------------------
// Escalation round-trip + Acceptance 2: mediation cannot bypass enforcement
// ---------------------------------------------------------------------------

describe('escalate -> mediate round-trip, advisory-only', () => {
  it('delivers the escalation to the queen inbox with ack-required high priority', async () => {
    const res = await escalate();
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.mediator.kind).toBe('queen');
    const queenInbox = listInbox({ agentId: QUEEN_B.agentId, ownerSessionId: QUEEN_B.ownerSessionId, ownerClientKind: QUEEN_B.ownerClientKind }, root);
    expect(queenInbox.messages.map(m => m.messageId)).toEqual([res.message.messageId]);
    expect(queenInbox.messages[0].requiresAck).toBe(true);
    expect(queenInbox.messages[0].priority).toBe('high');
    expect(queenInbox.messages[0].unblockCondition).toContain('alternate grounding source');

    // P4: the durable escalation marks the sender's hive worker waiting-on-peer
    // (non-settled for the watcher, non-idle for the reaper).
    expect(res.senderMarkedWaiting).toBe(true);
    const hive = JSON.parse(readFileSync(hiveRecordPath(), 'utf-8'));
    expect(hive.workers.find((w: { agentId: string }) => w.agentId === WORKER.agentId)?.status).toBe('waiting-on-peer');
  });

  it('mediates with redirect: advisory reply, original acked, only message + waiting-lifecycle state changes', async () => {
    const escalated = await escalate();
    expect(escalated.success).toBe(true);
    if (!escalated.success) return;

    // Snapshot AFTER escalation (which legitimately set waiting-on-peer):
    // mediation may change ONLY the worker's waiting-lifecycle fields.
    const agentStoreBefore = readFileSync(agentStorePath(), 'utf-8');
    const hiveAfterEscalate = JSON.parse(readFileSync(hiveRecordPath(), 'utf-8'));
    expect(hiveAfterEscalate.workers[0].status).toBe('waiting-on-peer');

    const res = await mediateMessage({
      mediatorAgentId: QUEEN_B.agentId,
      messageId: escalated.message.messageId,
      decision: 'redirect',
      guidance: 'do not retry the denied fetch; cite the local mirror instead',
      redirectTask: 'ground the claim from docs/mirrors/spec.md and note the source',
    }, root);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.advisory).toBe(true);
    expect(res.originalAcked).toBe(true);

    // The reply is a linked ADVISORY message to the blocked worker.
    expect(res.reply.replyTo).toBe(escalated.message.messageId);
    expect(res.reply.conversationId).toBe(escalated.message.conversationId);
    expect(res.reply.seq).toBe(escalated.message.seq + 1);
    // P4 loop bound: replies inherit the conversation hop budget.
    expect(res.reply.hop).toBe(escalated.message.hop + 1);
    expect(res.reply.maxHops).toBe(escalated.message.maxHops);
    expect(res.reply.verb).toBe('redirect');
    expect(res.reply.body).toContain('[ADVISORY]');
    expect(res.reply.body).toContain('no execution authority');
    const workerInbox = listInbox(WORKER, root);
    expect(workerInbox.messages.map(m => m.messageId)).toEqual([res.reply.messageId]);

    // ENFORCEMENT-BYPASS GUARDS: mediation wrote ONLY message records plus the
    // sender's waiting-lifecycle fields (waiting-on-peer -> idle, fresh
    // idleSince). Everything enforcement-relevant stays untouched.
    expect(readFileSync(agentStorePath(), 'utf-8')).toBe(agentStoreBefore);
    expect(res.senderWaitingCleared).toBe(true);
    const hiveAfterMediate = JSON.parse(readFileSync(hiveRecordPath(), 'utf-8'));
    expect(hiveAfterMediate.workers[0].status).toBe('idle');
    expect(hiveAfterMediate.workers[0].idleSince).toBeTruthy();
    expect(hiveAfterMediate.queenId).toBe(hiveAfterEscalate.queenId);
    expect(hiveAfterMediate.status).toBe(hiveAfterEscalate.status);
    expect(hiveAfterMediate.audit).toEqual(hiveAfterEscalate.audit);
    expect(hiveAfterMediate.budget).toEqual(hiveAfterEscalate.budget);
    expect(hiveAfterMediate.permissionRequests).toEqual(hiveAfterEscalate.permissionRequests);
    expect(existsSync(join(root, '.hive-flow', 'tasks'))).toBe(false);
    expect(existsSync(join(root, '.hive-flow', 'enforcement'))).toBe(false);

    // The consumed escalation is out of the queen's active inbox (acked).
    const queenInbox = listInbox({ agentId: QUEEN_B.agentId, ownerSessionId: QUEEN_B.ownerSessionId, ownerClientKind: QUEEN_B.ownerClientKind }, root);
    expect(queenInbox.messages).toHaveLength(0);
    const ackedRecord = readInboxMessage(
      recipientKey({ agentId: QUEEN_B.agentId, ownerSessionId: QUEEN_B.ownerSessionId, ownerClientKind: QUEEN_B.ownerClientKind }),
      escalated.message.messageId,
      root,
    );
    expect(ackedRecord.ok && ackedRecord.message.deliveryState).toBe('acked');
  });

  it('requires guidance always and redirectTask for redirect', async () => {
    const escalated = await escalate();
    expect(escalated.success).toBe(true);
    if (!escalated.success) return;

    const noGuidance = await mediateMessage({
      mediatorAgentId: QUEEN_B.agentId,
      messageId: escalated.message.messageId,
      decision: 'resume',
      guidance: '  ',
    }, root);
    expect(noGuidance.success).toBe(false);
    if (!noGuidance.success) expect(noGuidance.error).toMatch(/guidance-required/);

    const noRedirectTask = await mediateMessage({
      mediatorAgentId: QUEEN_B.agentId,
      messageId: escalated.message.messageId,
      decision: 'redirect',
      guidance: 'use the mirror',
    }, root);
    expect(noRedirectTask.success).toBe(false);
    if (!noRedirectTask.success) expect(noRedirectTask.error).toMatch(/redirect-task-required/);
  });

  it('refuses to mediate a missing or non-escalation message', async () => {
    const missing = await mediateMessage({
      mediatorAgentId: QUEEN_B.agentId,
      messageId: 'msg-never-existed',
      decision: 'resume',
      guidance: 'n/a',
    }, root);
    expect(missing.success).toBe(false);
    if (!missing.success) expect(missing.error).toMatch(/original-not-found/);
  });
});

// ---------------------------------------------------------------------------
// Owning-parent mediation via the session-level inbox
// (Codex bounce 20260703T230451Z: the fallback must be mediatable, not a
// stuck-escalation false success)
// ---------------------------------------------------------------------------

describe('owning-parent mediation (session-level inbox)', () => {
  async function escalateFromLoner() {
    const res = await escalateBlockedMessage({
      fromAgentId: LONER.agentId,
      body: 'hiveless worker blocked: provider auth expired',
      blockerClass: 'needs-mediation',
      unblockCondition: 'parent session re-authorizes the provider or redirects',
    }, root);
    expect(res.success).toBe(true);
    if (!res.success) throw new Error('escalation failed');
    expect(res.mediator.kind).toBe('owning-parent');
    // P4: hiveless senders have no hive worker row to mark.
    expect(res.senderMarkedWaiting).toBe(false);
    return res;
  }

  it('a same-owner persisted mediator resumes a session-level escalation end to end', async () => {
    const escalated = await escalateFromLoner();
    const sessionInbox = { ownerSessionId: LONER.ownerSessionId, ownerClientKind: LONER.ownerClientKind };
    expect(listInbox(sessionInbox, root).messages.map(m => m.messageId)).toEqual([escalated.message.messageId]);

    const agentStoreBefore = readFileSync(agentStorePath(), 'utf-8');
    const res = await mediateMessage({
      mediatorAgentId: PARENT_HELPER.agentId,
      messageId: escalated.message.messageId,
      decision: 'resume',
      guidance: 'auth restored; continue the original task from the last artifact',
    }, root);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.advisory).toBe(true);
    expect(res.originalAcked).toBe(true);

    // Advisory reply reaches the blocked sender, linked to the escalation.
    expect(res.reply.replyTo).toBe(escalated.message.messageId);
    expect(res.reply.from.agentId).toBe(PARENT_HELPER.agentId);
    const lonerInbox = listInbox(LONER, root);
    expect(lonerInbox.messages.map(m => m.messageId)).toEqual([res.reply.messageId]);

    // The escalation was consumed AT THE SESSION-LEVEL ADDRESS it lived at.
    expect(listInbox(sessionInbox, root).messages).toHaveLength(0);
    const ackedRecord = readInboxMessage(recipientKey(sessionInbox), escalated.message.messageId, root);
    expect(ackedRecord.ok && ackedRecord.message.deliveryState).toBe('acked');

    // Advisory-only: message state is the ONLY state that changed.
    expect(readFileSync(agentStorePath(), 'utf-8')).toBe(agentStoreBefore);
    expect(existsSync(join(root, '.hive-flow', 'tasks'))).toBe(false);
    expect(existsSync(join(root, '.hive-flow', 'enforcement'))).toBe(false);
  });

  it('a cross-session persisted mediator cannot see or mediate the escalation', async () => {
    const escalated = await escalateFromLoner();
    // QUEEN_B is persisted but owned by sess-queen-b: its derived session key
    // differs, so the escalation is structurally invisible to it.
    const res = await mediateMessage({
      mediatorAgentId: QUEEN_B.agentId,
      messageId: escalated.message.messageId,
      decision: 'resume',
      guidance: 'attempted cross-session mediation',
    }, root);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toMatch(/original-not-found/);
    // The escalation is still pending for the rightful parent session.
    const sessionInbox = { ownerSessionId: LONER.ownerSessionId, ownerClientKind: LONER.ownerClientKind };
    expect(listInbox(sessionInbox, root).messages.map(m => m.messageId)).toEqual([escalated.message.messageId]);
  });

  it('redirect works on the session-level path with the same mandatory redirectTask', async () => {
    const escalated = await escalateFromLoner();
    const res = await mediateMessage({
      mediatorAgentId: PARENT_HELPER.agentId,
      messageId: escalated.message.messageId,
      decision: 'redirect',
      guidance: 'provider auth will stay down; use the offline fixture path',
      redirectTask: 'run the suite against tests/fixtures/offline instead',
    }, root);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.reply.verb).toBe('redirect');
    expect(res.reply.body).toContain('redirectTask:');
  });
});
