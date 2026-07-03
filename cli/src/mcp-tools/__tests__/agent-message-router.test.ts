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
  for (const a of [WORKER, QUEEN_A, QUEEN_B, LONER]) {
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
    workers: [],
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
  });

  it('mediates with redirect: advisory reply, original acked, zero authoritative-state mutation', async () => {
    const escalated = await escalate();
    expect(escalated.success).toBe(true);
    if (!escalated.success) return;

    // Snapshot every authoritative record the mediation must NOT touch.
    const agentStoreBefore = readFileSync(agentStorePath(), 'utf-8');
    const hiveBefore = readFileSync(hiveRecordPath(), 'utf-8');

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
    expect(res.reply.verb).toBe('redirect');
    expect(res.reply.body).toContain('[ADVISORY]');
    expect(res.reply.body).toContain('no execution authority');
    const workerInbox = listInbox(WORKER, root);
    expect(workerInbox.messages.map(m => m.messageId)).toEqual([res.reply.messageId]);

    // ENFORCEMENT-BYPASS GUARDS: mediation wrote ONLY message records.
    expect(readFileSync(agentStorePath(), 'utf-8')).toBe(agentStoreBefore);
    expect(readFileSync(hiveRecordPath(), 'utf-8')).toBe(hiveBefore);
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
