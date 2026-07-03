// cli/src/mcp-tools/__tests__/agent-message-tools.test.ts
//
// P2a of the inter-agent communication design (Knot hive-flow-abc9). Verifies the
// MCP tool surface over the P1 store: agent_message_send / agent_message_inbox /
// agent_message_ack. Sender anti-forgery stays in the store (persisted-record
// stamping); recipient addressing resolves persisted-record-first, explicit-pair
// second, with no env guessing for send targets. Wake notices are best-effort
// and at-most-once per messageId per directory.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { agentMessageTools } from '../agent-message-tools.js';
import { listInbox } from '../agent-message-store.js';

let root: string;
let home: string;
let savedHome: string | undefined;

function tool(name: string) {
  const found = agentMessageTools.find(t => t.name === name);
  if (!found) throw new Error(`tool not registered: ${name}`);
  return found;
}

function seedAgents(agents: Array<{ agentId: string; ownerSessionId: string; ownerClientKind: string }>): void {
  const dir = join(root, '.hive-flow', 'agents');
  mkdirSync(dir, { recursive: true });
  const store: { version: number; agents: Record<string, unknown> } = { version: 3, agents: {} };
  for (const a of agents) {
    store.agents[a.agentId] = {
      agentId: a.agentId,
      agentType: 'coder',
      status: 'idle',
      health: 'healthy',
      taskCount: 0,
      config: {},
      createdAt: new Date().toISOString(),
      ownerSessionId: a.ownerSessionId,
      ownerClientKind: a.ownerClientKind,
    };
  }
  writeFileSync(join(dir, 'store.json'), JSON.stringify(store, null, 2), 'utf-8');
}

const SENDER = { agentId: 'agent-alice', ownerSessionId: 'sess-alice', ownerClientKind: 'claude-code' };
const RECIPIENT = { agentId: 'agent-bob', ownerSessionId: 'sess-bob', ownerClientKind: 'codex' };

function sendInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fromAgentId: SENDER.agentId,
    toAgentId: RECIPIENT.agentId,
    verb: 'inform',
    body: 'slice update: P2a canary',
    conversationId: 'conv-p2a-1',
    projectRoot: root,
    ...over,
  };
}

beforeEach(() => {
  // realpath: macOS tmpdir is a symlink (/var -> /private/var) and
  // resolveProjectRootFromInput resolves to the real path.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hf-iac-p2a-tools-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'hf-iac-p2a-home-')));
  savedHome = process.env.HIVE_FLOW_HOME;
  process.env.HIVE_FLOW_HOME = home;
  seedAgents([SENDER, RECIPIENT]);
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HIVE_FLOW_HOME;
  else process.env.HIVE_FLOW_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// agent_message_send
// ---------------------------------------------------------------------------

describe('agent_message_send', () => {
  it('sends to a persisted recipient and stamps the sender from its record', async () => {
    const res = await tool('agent_message_send').handler(sendInput()) as {
      success: boolean; message: { messageId: string; from: Record<string, string>; to: Record<string, string>; deliveryState: string };
    };
    expect(res.success).toBe(true);
    expect(res.message.messageId).toMatch(/^msg-/);
    expect(res.message.deliveryState).toBe('pending');
    // sender stamped from persisted record, recipient resolved from persisted record
    expect(res.message.from.ownerSessionId).toBe(SENDER.ownerSessionId);
    expect(res.message.from.ownerClientKind).toBe(SENDER.ownerClientKind);
    expect(res.message.to.ownerSessionId).toBe(RECIPIENT.ownerSessionId);
    expect(res.message.to.ownerClientKind).toBe(RECIPIENT.ownerClientKind);

    const inbox = listInbox(RECIPIENT, root);
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].body).toBe('slice update: P2a canary');
  });

  it('rejects an unknown (unpersisted) sender', async () => {
    const res = await tool('agent_message_send').handler(sendInput({ fromAgentId: 'agent-ghost' })) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unknown-sender/);
    expect(listInbox(RECIPIENT, root).messages).toHaveLength(0);
  });

  it('requires a recipient (toAgentId or explicit owner pair)', async () => {
    const res = await tool('agent_message_send').handler(sendInput({ toAgentId: undefined })) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/recipient-required/);
  });

  it('refuses to guess for an unpersisted toAgentId without an explicit pair', async () => {
    const res = await tool('agent_message_send').handler(sendInput({ toAgentId: 'agent-nowhere' })) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unknown-recipient/);
  });

  it('accepts explicit owner-pair addressing without a persisted recipient', async () => {
    const to = { ownerSessionId: 'sess-external', ownerClientKind: 'claude-code' };
    const res = await tool('agent_message_send').handler(sendInput({
      toAgentId: undefined,
      toOwnerSessionId: to.ownerSessionId,
      toOwnerClientKind: to.ownerClientKind,
    })) as { success: boolean };
    expect(res.success).toBe(true);
    expect(listInbox(to, root).messages).toHaveLength(1);
  });

  it('rejects an invalid verb and an empty body', async () => {
    const badVerb = await tool('agent_message_send').handler(sendInput({ verb: 'shout' })) as { success: boolean; error?: string };
    expect(badVerb.success).toBe(false);
    expect(badVerb.error).toMatch(/invalid-verb/);

    const noBody = await tool('agent_message_send').handler(sendInput({ body: '   ' })) as { success: boolean; error?: string };
    expect(noBody.success).toBe(false);
    expect(noBody.error).toMatch(/body-required/);
  });

  it('propagates store invariants (blocked without unblockCondition)', async () => {
    const res = await tool('agent_message_send').handler(sendInput({ verb: 'blocked' })) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unblock-condition-required/);
  });
});

// ---------------------------------------------------------------------------
// Wake notice
// ---------------------------------------------------------------------------

describe('agent_message_send — wake notice', () => {
  it('drops an at-most-once wake notice in the project data dir and the owner wake session dir', async () => {
    const res = await tool('agent_message_send').handler(sendInput()) as { success: boolean; wakeNotified: boolean; message: { messageId: string } };
    expect(res.success).toBe(true);
    expect(res.wakeNotified).toBe(true);

    const dataFile = join(root, '.hive-flow', 'data', 'pending-notifications.jsonl');
    expect(existsSync(dataFile)).toBe(true);
    const lines = readFileSync(dataFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const notice = JSON.parse(lines[0]);
    expect(notice.kind).toBe('agent-message');
    expect(notice.messageId).toBe(res.message.messageId);
    expect(notice.targetAgent).toBe('codex'); // recipient ownerClientKind is codex
    expect(notice.projectRoot).toBe(root);
    expect(existsSync(join(root, '.hive-flow', 'data', `message-${res.message.messageId}.notified`))).toBe(true);

    // wake-paths parity: s_<sha256(normalizedKind NUL session)[0..32]>
    const sep = String.fromCharCode(0);
    const key = 's_' + createHash('sha256').update(['codex', RECIPIENT.ownerSessionId].join(sep)).digest('hex').slice(0, 32);
    const homeFile = join(home, 'wake', 'sessions', key, 'pending-notifications.jsonl');
    expect(existsSync(homeFile)).toBe(true);

    // dedup fold-in (same dedupKey) returns the same messageId -> no second line
    const again = await tool('agent_message_send').handler(sendInput()) as { success: boolean; message: { messageId: string } };
    expect(again.success).toBe(true);
    expect(again.message.messageId).toBe(res.message.messageId);
    expect(readFileSync(dataFile, 'utf-8').trim().split('\n')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// agent_message_inbox / agent_message_ack
// ---------------------------------------------------------------------------

describe('agent_message_inbox', () => {
  it('lists a persisted agent inbox by agentId alone', async () => {
    await tool('agent_message_send').handler(sendInput());
    const res = await tool('agent_message_inbox').handler({ agentId: RECIPIENT.agentId, projectRoot: root }) as {
      success: boolean; count: number; messages: Array<{ body: string }>; deadLetters: unknown[];
    };
    expect(res.success).toBe(true);
    expect(res.count).toBe(1);
    expect(res.messages[0].body).toBe('slice update: P2a canary');
    expect(res.deadLetters).toHaveLength(0);
  });

  it('lists a session-level inbox by explicit owner pair', async () => {
    await tool('agent_message_send').handler(sendInput({
      toAgentId: undefined,
      toOwnerSessionId: 'sess-external',
      toOwnerClientKind: 'claude-code',
    }));
    const res = await tool('agent_message_inbox').handler({
      ownerSessionId: 'sess-external', ownerClientKind: 'claude-code', projectRoot: root,
    }) as { success: boolean; count: number };
    expect(res.success).toBe(true);
    expect(res.count).toBe(1);
  });

  it('refuses an unpersisted agentId without an explicit pair', async () => {
    const res = await tool('agent_message_inbox').handler({ agentId: 'agent-nowhere', projectRoot: root }) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unknown-agent/);
  });
});

describe('agent_message_ack', () => {
  it('acks at-most-once and reports duplicates', async () => {
    const sent = await tool('agent_message_send').handler(sendInput()) as { message: { messageId: string } };
    const first = await tool('agent_message_ack').handler({
      messageId: sent.message.messageId, agentId: RECIPIENT.agentId, projectRoot: root,
    }) as { success: boolean; acked: boolean; alreadyAcked: boolean };
    expect(first).toMatchObject({ success: true, acked: true, alreadyAcked: false });

    const second = await tool('agent_message_ack').handler({
      messageId: sent.message.messageId, agentId: RECIPIENT.agentId, projectRoot: root,
    }) as { success: boolean; acked: boolean; alreadyAcked: boolean };
    expect(second).toMatchObject({ success: true, acked: true, alreadyAcked: true });
  });

  it('never acks a missing message', async () => {
    const res = await tool('agent_message_ack').handler({
      messageId: 'msg-does-not-exist', agentId: RECIPIENT.agentId, projectRoot: root,
    }) as { success: boolean; reason?: string };
    expect(res.success).toBe(false);
    expect(res.reason).toBe('not-found');
  });
});
