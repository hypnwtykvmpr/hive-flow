// cli/src/mcp-tools/__tests__/agent-message-bridge-delivery.test.ts
//
// P2a integration canary (Knot hive-flow-abc9): messages written by the REAL TS
// store (agent-message-store.ts) must be found, folded, and delivered by the
// provider bridge's mirrored read-side (provider-agent-bridge.mjs). This is the
// lockstep proof for the duplicated surface: recipientKey derivation, signingView
// field order, and the guarded pending -> delivered transition.
//
// Acceptance coverage:
//   1. provider file-substrate canary  -- a pending message folds into the next
//      task's model-visible context (buildMessages) and is marked delivered.
//   2. no false success on failed delivery -- delivery marking is guarded
//      (unknown / non-pending / tampered ids are skipped, never "delivered"),
//      and the flag-off / empty-inbox path is a byte-identical no-op.
//   3. cross-session dead-letter -- a tampered record in another session's inbox
//      is durably quarantined with evidence, and is gone from the active listing
//      for both the bridge and the store.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  sendMessage,
  listInbox,
  readInboxMessage,
  ackMessage,
  recipientKey,
} from '../agent-message-store.js';

// Runtime-joined path (this file lives at cli/src/mcp-tools/__tests__/).
const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(here, '..', '..', '..', 'packages', 'providers', 'scripts', 'provider-agent-bridge.mjs');

interface BridgeMessagingExports {
  BRIDGE_INBOX_FOLD_MARKER: string;
  agentMessagingEnabled: (env?: Record<string, string | undefined>) => boolean;
  bridgeProjectRootForMessages: (storeDir: string, resultFile?: string) => string;
  bridgeMessageRecipientKey: (party: { agentId?: string; ownerSessionId: string; ownerClientKind: string }) => string;
  bridgeListPendingMessages: (projectRoot: string, party: { agentId?: string; ownerSessionId: string; ownerClientKind: string }) =>
    { pending: Array<{ messageId: string; body: string; priority: string }>; skippedReason?: string };
  buildInboxFoldBlock: (pending: unknown[]) => string | null;
  buildMessages: (agent: Record<string, unknown>, newTask: string, inboxFoldBlock?: string | null) => Array<{ role: string; content: string }>;
  bridgeMarkMessagesDelivered: (projectRoot: string, party: { agentId?: string; ownerSessionId: string; ownerClientKind: string }, ids: string[]) =>
    Promise<{ delivered: string[]; skipped: Array<{ messageId: string; reason: string }> }>;
}

let bridge: BridgeMessagingExports;
let root: string;

const SENDER = { agentId: 'agent-alice', ownerSessionId: 'sess-alice', ownerClientKind: 'claude-code' };
const RECIPIENT = { agentId: 'agent-worker', ownerSessionId: 'sess-owner', ownerClientKind: 'codex' };

function seedSender(): void {
  const dir = join(root, '.hive-flow', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'store.json'), JSON.stringify({
    version: 3,
    agents: {
      [SENDER.agentId]: {
        agentId: SENDER.agentId,
        agentType: 'coder',
        status: 'idle',
        health: 'healthy',
        taskCount: 0,
        config: {},
        createdAt: new Date().toISOString(),
        ownerSessionId: SENDER.ownerSessionId,
        ownerClientKind: SENDER.ownerClientKind,
      },
    },
  }, null, 2), 'utf-8');
}

async function send(body: string, over: Record<string, unknown> = {}) {
  return sendMessage({
    fromAgentId: SENDER.agentId,
    to: RECIPIENT,
    verb: 'inform',
    body,
    conversationId: `conv-${body.slice(0, 12).replace(/[^a-z0-9]+/gi, '-')}`,
    ...over,
  }, root);
}

beforeEach(async () => {
  bridge = await import(pathToFileURL(bridgePath).href) as unknown as BridgeMessagingExports;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hf-iac-p2a-bridge-')));
  seedSender();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Lockstep parity: store write -> bridge read
// ---------------------------------------------------------------------------

describe('store/bridge lockstep parity', () => {
  it('derives the identical recipientKey for the same party', () => {
    expect(bridge.bridgeMessageRecipientKey(RECIPIENT)).toBe(recipientKey(RECIPIENT));
  });

  it('verifies and lists a store-written message (signature parity)', async () => {
    const sent = await send('parity probe');
    const { pending, skippedReason } = bridge.bridgeListPendingMessages(root, RECIPIENT);
    expect(skippedReason).toBeUndefined();
    expect(pending.map(m => m.messageId)).toEqual([sent.messageId]);
  });

  it('resolves the project root from the agent store dir', () => {
    expect(bridge.bridgeProjectRootForMessages(join(root, '.hive-flow', 'agents'))).toBe(root);
  });
});

// ---------------------------------------------------------------------------
// Acceptance 1: provider file-substrate delivery canary
// ---------------------------------------------------------------------------

describe('pull-at-dispatch delivery canary', () => {
  it('folds a pending message into the next task context and marks it delivered', async () => {
    const sent = await send('please prioritize the auth module');

    // Dispatch-time fold: pending inbox -> fold block -> model-visible messages.
    const { pending } = bridge.bridgeListPendingMessages(root, RECIPIENT);
    const block = bridge.buildInboxFoldBlock(pending);
    expect(block).toContain(bridge.BRIDGE_INBOX_FOLD_MARKER);
    expect(block).toContain(sent.messageId);
    expect(block).toContain('please prioritize the auth module');

    const agent = { systemPrompt: 'You are a worker.', conversationHistory: [{ role: 'user', content: 'earlier turn' }] };
    const messages = bridge.buildMessages(agent, 'next task', block);
    // Order contract: [system, ...history, inbox block, task]
    expect(messages[messages.length - 1]).toMatchObject({ role: 'user', content: 'next task' });
    expect(messages[messages.length - 2].content).toContain(bridge.BRIDGE_INBOX_FOLD_MARKER);

    // Post-success delivery marking: guarded pending -> delivered.
    const marked = await bridge.bridgeMarkMessagesDelivered(root, RECIPIENT, [sent.messageId]);
    expect(marked.delivered).toEqual([sent.messageId]);
    expect(marked.skipped).toHaveLength(0);

    const record = readInboxMessage(recipientKey(RECIPIENT), sent.messageId, root);
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.message.deliveryState).toBe('delivered');
      expect(record.message.deliveredAt).toBeTruthy();
    }

    // Delivered messages do NOT re-fold on the next dispatch...
    expect(bridge.bridgeListPendingMessages(root, RECIPIENT).pending).toHaveLength(0);
    // ...and the store-side ack path still works afterwards (delivered -> acked).
    const acked = await ackMessage(RECIPIENT, sent.messageId, root);
    expect(acked).toMatchObject({ acked: true, alreadyAcked: false });
  });

  it('orders folded messages by priority then creation', async () => {
    await send('routine note', { priority: 'low' });
    const urgent = await send('blocker: need decision', { priority: 'urgent' });
    const { pending } = bridge.bridgeListPendingMessages(root, RECIPIENT);
    expect(pending[0].messageId).toBe(urgent.messageId);
  });
});

// ---------------------------------------------------------------------------
// Acceptance 2: no false success
// ---------------------------------------------------------------------------

describe('no false success on failed delivery', () => {
  it('flag-off and empty-inbox paths are byte-identical no-ops', () => {
    expect(bridge.agentMessagingEnabled({})).toBe(false);
    expect(bridge.agentMessagingEnabled({ HIVE_FLOW_AGENT_MESSAGING: '0' })).toBe(false);
    expect(bridge.agentMessagingEnabled({ HIVE_FLOW_AGENT_MESSAGING: '1' })).toBe(true);
    expect(bridge.agentMessagingEnabled({ HIVE_FLOW_AGENT_MESSAGING: 'true' })).toBe(true);

    const agent = { systemPrompt: 'sys', conversationHistory: [{ role: 'user', content: 'h1' }] };
    const withoutBlock = bridge.buildMessages(agent, 'task');
    const withNullBlock = bridge.buildMessages(agent, 'task', null);
    expect(withNullBlock).toEqual(withoutBlock);
    expect(withoutBlock.map(m => m.content)).toEqual(['sys', 'h1', 'task']);
    expect(bridge.buildInboxFoldBlock([])).toBeNull();
  });

  it('never reports delivery for unknown, tampered, or already-terminal messages', async () => {
    const sent = await send('deliver me once');

    // Unknown id -> skipped, not delivered.
    const unknown = await bridge.bridgeMarkMessagesDelivered(root, RECIPIENT, ['msg-never-existed']);
    expect(unknown.delivered).toHaveLength(0);
    expect(unknown.skipped[0].reason).toBe('not-found');

    // Tampered record -> skipped, not delivered.
    const key = recipientKey(RECIPIENT);
    const recordPath = join(root, '.hive-flow', 'messages', 'inbox', key, `${sent.messageId}.json`);
    const original = readFileSync(recordPath, 'utf-8');
    const tampered = JSON.parse(original);
    tampered.body = 'forged body';
    writeFileSync(recordPath, JSON.stringify(tampered, null, 2), 'utf-8');
    const forged = await bridge.bridgeMarkMessagesDelivered(root, RECIPIENT, [sent.messageId]);
    expect(forged.delivered).toHaveLength(0);
    expect(forged.skipped[0].reason).toBe('signature-mismatch');

    // Restore and deliver once; a second attempt is refused (not re-delivered).
    writeFileSync(recordPath, original, 'utf-8');
    const first = await bridge.bridgeMarkMessagesDelivered(root, RECIPIENT, [sent.messageId]);
    expect(first.delivered).toEqual([sent.messageId]);
    const second = await bridge.bridgeMarkMessagesDelivered(root, RECIPIENT, [sent.messageId]);
    expect(second.delivered).toHaveLength(0);
    expect(second.skipped[0].reason).toMatch(/not-pending: delivered/);
  });

  it('folds nothing when the signing key is unavailable (verification-impossible is not delivery)', async () => {
    await send('unverifiable without key');
    rmSync(join(root, '.hive-flow', 'messages', '.hmac-key'));
    const listed = bridge.bridgeListPendingMessages(root, RECIPIENT);
    expect(listed.pending).toHaveLength(0);
    expect(listed.skippedReason).toBe('no-signing-key');
    // Nothing was quarantined: the records may be valid, we just cannot verify.
    expect(existsSync(join(root, '.hive-flow', 'messages', 'deadletter'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Acceptance 3: cross-session dead-letter
// ---------------------------------------------------------------------------

describe('cross-session dead-letter', () => {
  it('durably quarantines a tampered record in another session inbox', async () => {
    const otherSession = { agentId: 'agent-remote', ownerSessionId: 'sess-other', ownerClientKind: 'claude-code' };
    const sent = await sendMessage({
      fromAgentId: SENDER.agentId,
      to: otherSession,
      verb: 'handoff',
      body: 'take over slice B',
    }, root);

    const key = recipientKey(otherSession);
    const inboxDir = join(root, '.hive-flow', 'messages', 'inbox', key);
    const recordPath = join(inboxDir, `${sent.messageId}.json`);
    const tampered = JSON.parse(readFileSync(recordPath, 'utf-8'));
    tampered.to.ownerSessionId = 'sess-hijacked';
    writeFileSync(recordPath, JSON.stringify(tampered, null, 2), 'utf-8');

    // Bridge dispatch for that session: excluded from fold + durably quarantined.
    const listed = bridge.bridgeListPendingMessages(root, otherSession);
    expect(listed.pending).toHaveLength(0);
    const deadDir = join(root, '.hive-flow', 'messages', 'deadletter');
    const evidence = readdirSync(deadDir).filter(n => n.startsWith('corrupt-'));
    expect(evidence).toHaveLength(1);
    const evidenceBody = JSON.parse(readFileSync(join(deadDir, evidence[0]), 'utf-8'));
    expect(evidenceBody.reason).toBe('signature-mismatch');
    expect(evidenceBody.messageId).toBe(sent.messageId);
    expect(existsSync(recordPath)).toBe(false);
    expect(existsSync(recordPath + '.corrupt')).toBe(true);

    // Second scan re-reports nothing; store-side listing agrees (active inbox clean).
    expect(bridge.bridgeListPendingMessages(root, otherSession).pending).toHaveLength(0);
    expect(readdirSync(deadDir).filter(n => n.startsWith('corrupt-'))).toHaveLength(1);
    const storeView = listInbox(otherSession, root);
    expect(storeView.messages).toHaveLength(0);
  });
});
