// cli/src/mcp-tools/__tests__/agent-message-native-adapter.test.ts
//
// P2b (Knot hive-flow-d790): native-claude SendMessage delivery adapter.
//
// Acceptance coverage:
//   1. Native delivery writes a durable record with SHAPE PARITY to adapter A
//      (same envelope, same store, signature verifies) -- the record, not the
//      relay, is the delivery guarantee.
//   2. Transport-agnostic deliver(): resolveDeliveryPlan dispatches adapter A
//      (file-substrate: pull-at-dispatch for provider agents, session-drain for
//      non-claude session inboxes) vs adapter B (native-claude: SendMessage
//      relay instruction for the owning Claude session) by recipient kind.
//      MCP handlers cannot invoke Claude Code tools, so the plan is an explicit
//      relay INSTRUCTION and deliveryState stays pending (never optimistic).
//   3. Inbox re-scan on restore: scripts/agent-message-rescan.cjs surfaces
//      undrained messages for the session at SessionStart (module + standalone
//      subprocess protocols), read-only, with the corrected ack addressing.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { agentMessageTools, resolveDeliveryPlan } from '../agent-message-tools.js';
import { sendMessage, listInbox, verifyMessageSignature, ackMessage } from '../agent-message-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const rescanScript = join(repoRoot, 'scripts', 'agent-message-rescan.cjs');
const cjsRequire = createRequire(import.meta.url);

interface RescanModule {
  scanUndrainedMessages: (projectRoot: string, sessionId: string | null) => Array<{ messageId: string; toAgentId: string | null; deliveryState: string }>;
  buildMessageRescanContext: (messages: unknown[]) => string | null;
  mergeSessionStartOutput: (prior: Record<string, unknown>, projectRoot: string, sessionInput?: Record<string, unknown>, env?: Record<string, string | undefined>) => Record<string, unknown> & { hookSpecificOutput?: { additionalContext?: string } };
}
const rescan = cjsRequire(rescanScript) as RescanModule;

let root: string;
let home: string;
let savedHome: string | undefined;

const SENDER = { agentId: 'agent-alice', ownerSessionId: 'sess-alice', ownerClientKind: 'claude-code' };
const PROVIDER_RECIPIENT = { agentId: 'agent-worker', ownerSessionId: 'sess-owner', ownerClientKind: 'codex' };
// Native teammate: addressable by NAME within the owning Claude session; not in
// the provider agent store (adapter B's whole point).
const NATIVE_RECIPIENT = { agentId: 'architect', ownerSessionId: 'sess-native', ownerClientKind: 'claude-code' };

function tool(name: string) {
  const found = agentMessageTools.find(t => t.name === name);
  if (!found) throw new Error(`tool not registered: ${name}`);
  return found;
}

function seedAgents(): void {
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
      [PROVIDER_RECIPIENT.agentId]: {
        agentId: PROVIDER_RECIPIENT.agentId, agentType: 'coder', status: 'idle', health: 'healthy',
        taskCount: 0, config: {}, createdAt: new Date().toISOString(), provider: 'deepseek',
        ownerSessionId: PROVIDER_RECIPIENT.ownerSessionId, ownerClientKind: PROVIDER_RECIPIENT.ownerClientKind,
      },
    },
  }, null, 2), 'utf-8');
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hf-iac-p2b-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'hf-iac-p2b-home-')));
  savedHome = process.env.HIVE_FLOW_HOME;
  process.env.HIVE_FLOW_HOME = home;
  seedAgents();
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HIVE_FLOW_HOME;
  else process.env.HIVE_FLOW_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Acceptance 2: transport-agnostic deliver() dispatch by recipient kind
// ---------------------------------------------------------------------------

describe('resolveDeliveryPlan dispatch', () => {
  it('routes provider-backed persisted agents to adapter A pull-at-dispatch', () => {
    const plan = resolveDeliveryPlan(PROVIDER_RECIPIENT, root);
    expect(plan.adapter).toBe('file-substrate');
    expect(plan.mode).toBe('pull-at-dispatch');
    expect(plan.relay).toBeUndefined();
    expect(plan.detail).toContain('deepseek');
  });

  it('routes native-claude recipients to adapter B with a SendMessage relay instruction', () => {
    const plan = resolveDeliveryPlan(NATIVE_RECIPIENT, root);
    expect(plan.adapter).toBe('native-claude');
    expect(plan.mode).toBe('owner-session-relay');
    expect(plan.relay).toEqual({ tool: 'SendMessage', recipient: 'architect' });
  });

  it('routes a session-level claude inbox to adapter B without a teammate name', () => {
    const plan = resolveDeliveryPlan({ ownerSessionId: 'sess-x', ownerClientKind: 'claude-code' }, root);
    expect(plan.adapter).toBe('native-claude');
    expect(plan.relay).toEqual({ tool: 'SendMessage', recipient: null });
  });

  it('routes non-claude session-level inboxes to adapter A session-drain', () => {
    const plan = resolveDeliveryPlan({ ownerSessionId: 'sess-x', ownerClientKind: 'codex' }, root);
    expect(plan.adapter).toBe('file-substrate');
    expect(plan.mode).toBe('session-drain');
  });

  it('agent_message_send returns the delivery plan and keeps deliveryState pending (no optimistic success)', async () => {
    const res = await tool('agent_message_send').handler({
      fromAgentId: SENDER.agentId,
      toAgentId: NATIVE_RECIPIENT.agentId,
      toOwnerSessionId: NATIVE_RECIPIENT.ownerSessionId,
      toOwnerClientKind: NATIVE_RECIPIENT.ownerClientKind,
      verb: 'ask',
      body: 'native adapter canary',
      projectRoot: root,
    }) as { success: boolean; message: { deliveryState: string }; delivery: { adapter: string; relay?: { recipient: string | null } } };
    expect(res.success).toBe(true);
    expect(res.delivery.adapter).toBe('native-claude');
    expect(res.delivery.relay?.recipient).toBe('architect');
    // The relay is an instruction, not an outcome: still pending until acked.
    expect(res.message.deliveryState).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Acceptance 1: durable record + shape parity with adapter A
// ---------------------------------------------------------------------------

describe('native delivery durable record parity', () => {
  it('writes the identical envelope shape to the same store as a provider-addressed send', async () => {
    const nativeMsg = await sendMessage({
      fromAgentId: SENDER.agentId, to: NATIVE_RECIPIENT, verb: 'inform', body: 'parity native',
    }, root);
    const providerMsg = await sendMessage({
      fromAgentId: SENDER.agentId, to: PROVIDER_RECIPIENT, verb: 'inform', body: 'parity provider',
    }, root);

    // Same envelope field set, byte-for-byte key parity.
    expect(Object.keys(nativeMsg).sort()).toEqual(Object.keys(providerMsg).sort());
    // Same store, same integrity guarantees: both listable and signature-valid.
    expect(verifyMessageSignature(nativeMsg, root)).toBe(true);
    expect(verifyMessageSignature(providerMsg, root)).toBe(true);
    const nativeInbox = listInbox(NATIVE_RECIPIENT, root);
    expect(nativeInbox.messages.map(m => m.messageId)).toEqual([nativeMsg.messageId]);
    expect(nativeInbox.deadLetters).toHaveLength(0);
    // Ack path parity too: the native record acks like any other.
    const acked = await ackMessage(NATIVE_RECIPIENT, nativeMsg.messageId, root);
    expect(acked).toMatchObject({ acked: true, alreadyAcked: false });
  });
});

// ---------------------------------------------------------------------------
// Acceptance 3: SessionStart inbox re-scan on restore
// ---------------------------------------------------------------------------

describe('inbox re-scan on restore (scripts/agent-message-rescan.cjs)', () => {
  it('surfaces undrained messages for the session with corrected ack addressing', async () => {
    const sent = await sendMessage({
      fromAgentId: SENDER.agentId, to: NATIVE_RECIPIENT, verb: 'ask', body: 'restore me', priority: 'high',
    }, root);

    const out = rescan.mergeSessionStartOutput({}, root, { session_id: NATIVE_RECIPIENT.ownerSessionId }, {});
    const context = out.hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain('[AGENT MESSAGES] 1 undrained');
    expect(context).toContain(sent.messageId);
    // Agent-addressed: ack instruction must carry agentId (bounce 20260703T223229Z).
    expect(context).toContain(`agent_message_ack({messageId:"${sent.messageId}", agentId:"architect"})`);
  });

  it('merges with a prior watcher context and returns prior unchanged when inbox is empty', async () => {
    const prior = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '[SENTINEL RECOVERY] 1 dead watcher(s)' } };
    // Empty inbox: prior returned UNCHANGED (strict superset guarantee).
    expect(rescan.mergeSessionStartOutput(prior, root, { session_id: 'sess-nobody' }, {})).toBe(prior);
    expect(rescan.mergeSessionStartOutput({}, root, {}, {})).toEqual({});

    await sendMessage({ fromAgentId: SENDER.agentId, to: NATIVE_RECIPIENT, verb: 'inform', body: 'both sections' }, root);
    const merged = rescan.mergeSessionStartOutput(prior, root, { session_id: NATIVE_RECIPIENT.ownerSessionId }, {});
    const context = merged.hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain('[SENTINEL RECOVERY]');
    expect(context).toContain('[AGENT MESSAGES]');
    expect(context.indexOf('[SENTINEL RECOVERY]')).toBeLessThan(context.indexOf('[AGENT MESSAGES]'));
  });

  it('is read-only and skips acked/terminal records', async () => {
    const sent = await sendMessage({
      fromAgentId: SENDER.agentId, to: NATIVE_RECIPIENT, verb: 'inform', body: 'read-only probe',
    }, root);
    const key = listInbox(NATIVE_RECIPIENT, root).messages[0];
    expect(key.messageId).toBe(sent.messageId);
    const recordPathDir = join(root, '.hive-flow', 'messages', 'inbox');
    const before = JSON.stringify(rescan.scanUndrainedMessages(root, NATIVE_RECIPIENT.ownerSessionId));
    expect(before).toContain(sent.messageId);
    // Scan mutated nothing: a second identical scan sees identical state.
    expect(JSON.stringify(rescan.scanUndrainedMessages(root, NATIVE_RECIPIENT.ownerSessionId))).toBe(before);
    expect(recordPathDir).toBeTruthy();

    await ackMessage(NATIVE_RECIPIENT, sent.messageId, root);
    // Acked (terminal) records are drained -- not re-reported on restore.
    expect(rescan.scanUndrainedMessages(root, NATIVE_RECIPIENT.ownerSessionId)).toHaveLength(0);
    expect(rescan.buildMessageRescanContext([])).toBeNull();
  });

  it('standalone subprocess speaks the SessionStart stdin/stdout hook protocol', async () => {
    const sent = await sendMessage({
      fromAgentId: SENDER.agentId, to: NATIVE_RECIPIENT, verb: 'handoff', body: 'subprocess canary',
    }, root);

    const stdout = execFileSync('node', [rescanScript], {
      input: JSON.stringify({ session_id: NATIVE_RECIPIENT.ownerSessionId }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_SESSION_ID: '', HIVE_FLOW_SESSION_ID: '' },
      encoding: 'utf-8',
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain(sent.messageId);

    // Unknown session -> {} (zero noise, never blocks session start).
    const empty = execFileSync('node', [rescanScript], {
      input: JSON.stringify({ session_id: 'sess-unknown' }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_SESSION_ID: '', HIVE_FLOW_SESSION_ID: '' },
      encoding: 'utf-8',
    });
    expect(JSON.parse(empty)).toEqual({});
  });
});
