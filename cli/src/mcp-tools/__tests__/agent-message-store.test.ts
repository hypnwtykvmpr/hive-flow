// cli/src/mcp-tools/__tests__/agent-message-store.test.ts
//
// P1 of the inter-agent communication design (Knot hive-flow-2ee8). Verifies the
// durable AgentMessage store: compaction survival, idempotent reads, dead-letter
// on malformed/tampered records, ownership-forgery rejection (sender identity is
// stamped from the persisted record only), and dedupKey fold-in.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  sendMessage,
  listInbox,
  readInboxMessage,
  ackMessage,
  deadLetterMessage,
  verifyMessageSignature,
  recipientKey,
  resolveSenderStamp,
  type SendMessageInput,
} from '../agent-message-store.js';

let root: string;

// Seed a persisted agent record so sender ownership can be resolved.
function seedAgent(agentId: string, ownerSessionId: string, ownerClientKind: string): void {
  const dir = join(root, '.hive-flow', 'agents');
  mkdirSync(dir, { recursive: true });
  const store = {
    version: 3,
    agents: {
      [agentId]: {
        agentId,
        agentType: 'coder',
        status: 'idle',
        health: 'healthy',
        taskCount: 0,
        config: {},
        createdAt: new Date().toISOString(),
        ownerSessionId,
        ownerClientKind,
      },
    },
  };
  writeFileSync(join(dir, 'store.json'), JSON.stringify(store, null, 2), 'utf-8');
}

const RECIPIENT = { agentId: 'agent-bob', ownerSessionId: 'sess-bob', ownerClientKind: 'claude' };

function baseInput(over: Partial<SendMessageInput> = {}): SendMessageInput {
  return {
    fromAgentId: 'agent-alice',
    to: RECIPIENT,
    verb: 'inform',
    body: 'status update: slice compiling',
    conversationId: 'conv-fixed-1',
    ...over,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hf-iac-p1-'));
  seedAgent('agent-alice', 'sess-alice', 'claude');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Durable write + compaction survival
// ---------------------------------------------------------------------------

describe('sendMessage — durable, signed, compaction-surviving', () => {
  it('persists a signed record readable byte-consistently from a fresh read', async () => {
    const sent = await sendMessage(baseInput(), root);
    expect(sent.messageId).toMatch(/^msg-/);
    expect(sent.deliveryState).toBe('pending');
    expect(sent.signature).toBeTruthy();

    // "Compaction": drop all in-memory state, re-read purely from disk.
    const key = recipientKey(RECIPIENT);
    const res = readInboxMessage(key, sent.messageId, root);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.message.messageId).toBe(sent.messageId);
      expect(res.message.body).toBe(sent.body);
      expect(verifyMessageSignature(res.message, root)).toBe(true);
    }

    // The outbox audit log has the send.
    const outbox = readFileSync(join(root, '.hive-flow', 'messages', 'outbox.jsonl'), 'utf-8');
    expect(outbox).toContain(sent.messageId);
  });

  it('reads are idempotent (double read returns the same record)', async () => {
    const sent = await sendMessage(baseInput(), root);
    const key = recipientKey(RECIPIENT);
    const a = readInboxMessage(key, sent.messageId, root);
    const b = readInboxMessage(key, sent.messageId, root);
    expect(a).toEqual(b);
    const l1 = listInbox(RECIPIENT, root);
    const l2 = listInbox(RECIPIENT, root);
    expect(l1.messages.map(m => m.messageId)).toEqual(l2.messages.map(m => m.messageId));
  });
});

// ---------------------------------------------------------------------------
// Anti-forgery: sender identity from the persisted record only
// ---------------------------------------------------------------------------

describe('sendMessage — sender identity is stamped from the persisted record', () => {
  it('stamps from.ownership from the persisted AgentRecord', async () => {
    const sent = await sendMessage(baseInput(), root);
    expect(sent.from.agentId).toBe('agent-alice');
    expect(sent.from.ownerSessionId).toBe('sess-alice'); // persisted value, not caller input
    expect(sent.from.ownerClientKind).toBe('claude');
  });

  it('rejects a send from an agent with no persisted record (unknown sender)', async () => {
    await expect(sendMessage(baseInput({ fromAgentId: 'agent-ghost' }), root)).rejects.toThrow(/unknown-sender/);
  });

  it('rejects a persisted agent that lacks ownership fields', async () => {
    // Overwrite the store with an agent missing ownership.
    writeFileSync(
      join(root, '.hive-flow', 'agents', 'store.json'),
      JSON.stringify({ version: 3, agents: { 'agent-noown': { agentId: 'agent-noown', status: 'idle' } } }),
      'utf-8',
    );
    expect(resolveSenderStamp('agent-noown', root)).toBeNull();
    await expect(sendMessage(baseInput({ fromAgentId: 'agent-noown' }), root)).rejects.toThrow(/unknown-sender/);
  });
});

// ---------------------------------------------------------------------------
// Addressing + blocker invariants
// ---------------------------------------------------------------------------

describe('sendMessage — store-level invariants', () => {
  it('requires explicit recipient ownerSessionId + ownerClientKind', async () => {
    const bad = baseInput({ to: { agentId: 'agent-bob', ownerSessionId: '', ownerClientKind: '' } });
    await expect(sendMessage(bad, root)).rejects.toThrow(/recipient-addressing-required/);
  });

  it('requires an unblockCondition on a blocked message', async () => {
    await expect(sendMessage(baseInput({ verb: 'blocked' }), root)).rejects.toThrow(/unblock-condition-required/);
    const ok = await sendMessage(baseInput({ verb: 'blocked', unblockCondition: 'need write access to config', conversationId: 'conv-blk' }), root);
    expect(ok.verb).toBe('blocked');
    expect(ok.unblockCondition).toBe('need write access to config');
  });
});

// ---------------------------------------------------------------------------
// dedupKey fold-in
// ---------------------------------------------------------------------------

describe('sendMessage — dedupKey fold-in', () => {
  it('folds an identical resend into the existing record (no duplicate)', async () => {
    const first = await sendMessage(baseInput(), root);
    const second = await sendMessage(baseInput(), root);
    expect(second.messageId).toBe(first.messageId);
    expect(listInbox(RECIPIENT, root).messages).toHaveLength(1);
  });

  it('a different body produces a distinct message', async () => {
    const first = await sendMessage(baseInput(), root);
    const other = await sendMessage(baseInput({ body: 'different content entirely' }), root);
    expect(other.messageId).not.toBe(first.messageId);
    expect(other.dedupKey).not.toBe(first.dedupKey);
    expect(listInbox(RECIPIENT, root).messages).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Dead-letter on malformed / tampered records (never a silent drop)
// ---------------------------------------------------------------------------

describe('read — dead-letter on malformed or tampered records', () => {
  it('reports malformed JSON as a dead-letter, not a silent drop', async () => {
    await sendMessage(baseInput(), root); // creates the recipient inbox dir
    const inboxDir = join(root, '.hive-flow', 'messages', 'inbox', recipientKey(RECIPIENT));
    writeFileSync(join(inboxDir, 'garbage.json'), '{ this is not valid json ', 'utf-8');
    const { messages, deadLetters } = listInbox(RECIPIENT, root);
    expect(messages).toHaveLength(1); // the valid one
    expect(deadLetters.some(d => d.reason === 'malformed-json')).toBe(true);
  });

  it('detects a tampered body via signature mismatch', async () => {
    const sent = await sendMessage(baseInput(), root);
    const key = recipientKey(RECIPIENT);
    const path = join(root, '.hive-flow', 'messages', 'inbox', key, sent.messageId + '.json');
    const rec = JSON.parse(readFileSync(path, 'utf-8'));
    rec.body = 'tampered payload — inject me'; // alter content, keep old signature
    writeFileSync(path, JSON.stringify(rec, null, 2), 'utf-8');

    expect(verifyMessageSignature(rec, root)).toBe(false);
    const res = readInboxMessage(key, sent.messageId, root);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.deadLetter).toBe(true);
      expect(res.reason).toBe('signature-mismatch');
    }
    const listed = listInbox(RECIPIENT, root);
    expect(listed.deadLetters.some(d => d.reason === 'signature-mismatch')).toBe(true);
  });

  it('a missing record is a benign not-found, not a dead-letter', () => {
    const key = recipientKey(RECIPIENT);
    const res = readInboxMessage(key, 'msg-does-not-exist', root);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.deadLetter).toBe(false);
      expect(res.reason).toBe('not-found');
    }
  });
});

// ---------------------------------------------------------------------------
// Ack (at-most-once) + dead-letter transition
// ---------------------------------------------------------------------------

describe('ackMessage — at-most-once', () => {
  it('first ack transitions to acked; a second ack is a safe no-op', async () => {
    const sent = await sendMessage(baseInput({ requiresAck: true }), root);
    const first = await ackMessage(RECIPIENT, sent.messageId, root);
    expect(first).toEqual({ acked: true, alreadyAcked: false });
    const second = await ackMessage(RECIPIENT, sent.messageId, root);
    expect(second).toEqual({ acked: true, alreadyAcked: true });

    const key = recipientKey(RECIPIENT);
    const res = readInboxMessage(key, sent.messageId, root);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message.deliveryState).toBe('acked');
    // acked message is excluded from the default (non-terminal) inbox listing.
    expect(listInbox(RECIPIENT, root).messages).toHaveLength(0);
    expect(listInbox(RECIPIENT, root, { includeTerminal: true }).messages).toHaveLength(1);
  });
});

describe('deadLetterMessage', () => {
  it('moves a message to the dead-letter store with a reason', async () => {
    const sent = await sendMessage(baseInput(), root);
    await deadLetterMessage(sent, 'ownership-boundary-crossing', root);
    const dlPath = join(root, '.hive-flow', 'messages', 'deadletter', sent.messageId + '.json');
    expect(existsSync(dlPath)).toBe(true);
    const dl = JSON.parse(readFileSync(dlPath, 'utf-8'));
    expect(dl.deliveryState).toBe('dead-letter');
    expect(dl.deadLetterReason).toBe('ownership-boundary-crossing');
  });
});
