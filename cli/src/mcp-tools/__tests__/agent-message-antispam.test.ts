// cli/src/mcp-tools/__tests__/agent-message-antispam.test.ts
//
// P4 (Knot hive-flow-5de8): anti-spam on the message spine, enforced at the
// store choke point (sendMessage) so no tool path can bypass it.
//
// Acceptance coverage:
//   - rate-cap throttles but urgent bypasses (per-pair and per-sender windows)
//   - loop-storm to dead-letter cap (hop >= maxHops drops DURABLY, never
//     silently, never into the inbox; storms still count against the caps)
// Plus: consecutive-frame de-dup (dedupKey cannot catch cross-conversation
// repeats), dedup fold-in precedence (idempotent resend is not spam), and TTL
// expiry at read.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sendMessage, listInbox, recipientKey, readInboxMessage } from '../agent-message-store.js';

let root: string;

const SENDER = { agentId: 'agent-alice', ownerSessionId: 'sess-alice', ownerClientKind: 'claude-code' };

function recipient(n: number) {
  return { agentId: '', ownerSessionId: `sess-r${n}`, ownerClientKind: 'codex' };
}

function seedSender(): void {
  const dir = join(root, '.hive-flow', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'store.json'), JSON.stringify({
    version: 3,
    agents: {
      [SENDER.agentId]: {
        agentId: SENDER.agentId, agentType: 'coder', status: 'idle', health: 'healthy',
        taskCount: 0, config: {}, createdAt: new Date().toISOString(),
        ownerSessionId: SENDER.ownerSessionId, ownerClientKind: SENDER.ownerClientKind,
      },
    },
  }, null, 2), 'utf-8');
}

async function send(to: ReturnType<typeof recipient>, body: string, over: Record<string, unknown> = {}) {
  return sendMessage({
    fromAgentId: SENDER.agentId,
    to,
    verb: 'inform',
    body,
    conversationId: `conv-${body.replace(/[^a-z0-9]+/gi, '-').slice(0, 24)}`,
    ...over,
  }, root);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hf-iac-p4-spam-')));
  seedSender();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('dedup precedence and consecutive-frame de-dup', () => {
  it('idempotent resend (same conversation) folds BEFORE any guard fires', async () => {
    const first = await send(recipient(1), 'same payload', { conversationId: 'conv-fixed' });
    const second = await send(recipient(1), 'same payload', { conversationId: 'conv-fixed' });
    expect(second.messageId).toBe(first.messageId);
  });

  it('rejects an identical consecutive frame across conversations', async () => {
    await send(recipient(1), 'same payload', { conversationId: 'conv-a' });
    await expect(send(recipient(1), 'same payload', { conversationId: 'conv-b' }))
      .rejects.toThrow(/duplicate-frame/);
    // A different body to the same pair is fine, and the original may follow again.
    await send(recipient(1), 'different payload');
    await send(recipient(1), 'same payload', { conversationId: 'conv-c' });
  });
});

describe('windowed rate caps with urgent bypass', () => {
  it('caps a pair at 20 per window; urgent bypasses the throttle', async () => {
    for (let i = 0; i < 20; i++) {
      await send(recipient(1), `pair probe ${i}`);
    }
    await expect(send(recipient(1), 'pair probe 20')).rejects.toThrow(/rate-capped: pair/);
    // Urgent bypasses the cap (never the de-dup)...
    const urgent = await send(recipient(1), 'pair probe urgent', { priority: 'urgent' });
    expect(urgent.deliveryState).toBe('pending');
    // ...and a different pair is unaffected.
    await send(recipient(2), 'other pair probe');
  });

  it('caps a sender across pairs at 60 per window; urgent bypasses', async () => {
    for (let pair = 1; pair <= 3; pair++) {
      for (let i = 0; i < 20; i++) {
        await send(recipient(pair), `sender probe p${pair} n${i}`);
      }
    }
    await expect(send(recipient(4), 'sender probe overflow')).rejects.toThrow(/rate-capped: sender/);
    const urgent = await send(recipient(4), 'sender probe urgent', { priority: 'urgent' });
    expect(urgent.deliveryState).toBe('pending');
  }, 30000);
});

describe('loop-storm to dead-letter cap', () => {
  it('drops hop >= maxHops durably to dead-letter, never into the inbox', async () => {
    const to = recipient(1);
    const withinBound = await send(to, 'hop 7 frame', { hop: 7, maxHops: 8 });
    expect(withinBound.deliveryState).toBe('pending');

    const overflow = await send(to, 'hop 8 frame', { hop: 8, maxHops: 8 });
    expect(overflow.deliveryState).toBe('dead-letter');
    expect(overflow.deadLetterReason).toMatch(/max-hops-exceeded/);
    // Durable evidence, no inbox delivery, audit trail in the outbox.
    expect(existsSync(join(root, '.hive-flow', 'messages', 'deadletter', `${overflow.messageId}.json`))).toBe(true);
    expect(listInbox(to, root).messages.map(m => m.messageId)).toEqual([withinBound.messageId]);
    const outbox = readFileSync(join(root, '.hive-flow', 'messages', 'outbox.jsonl'), 'utf-8');
    expect(outbox).toContain(overflow.messageId);
  });

  it('a hop-overflow storm still counts against the rate cap (no cap evasion by dying at the bound)', async () => {
    const to = recipient(1);
    for (let i = 0; i < 20; i++) {
      const dropped = await send(to, `storm frame ${i}`, { hop: 9, maxHops: 8 });
      expect(dropped.deliveryState).toBe('dead-letter');
    }
    await expect(send(to, 'storm frame 20', { hop: 9, maxHops: 8 })).rejects.toThrow(/rate-capped: pair/);
    // The storm delivered NOTHING and the dead-letter dir holds the evidence.
    expect(listInbox(to, root).messages).toHaveLength(0);
    const deadDir = join(root, '.hive-flow', 'messages', 'deadletter');
    expect(readdirSync(deadDir).filter(n => n.endsWith('.json')).length).toBe(20);
  }, 30000);
});

describe('TTL expiry at read', () => {
  it('transitions an overdue record durably to expired and drops it from the active list', async () => {
    const to = recipient(1);
    const shortLived = await send(to, 'expires fast', { ttlMs: 1 });
    const longLived = await send(to, 'stays fresh', { ttlMs: 60_000 });
    await new Promise(r => setTimeout(r, 15));

    const active = listInbox(to, root);
    expect(active.messages.map(m => m.messageId)).toEqual([longLived.messageId]);

    // Durable transition, visible with includeTerminal and on direct read.
    const record = readInboxMessage(recipientKey(to), shortLived.messageId, root);
    expect(record.ok && record.message.deliveryState).toBe('expired');
    const terminal = listInbox(to, root, { includeTerminal: true });
    expect(terminal.messages.find(m => m.messageId === shortLived.messageId)?.deliveryState).toBe('expired');
  });
});
