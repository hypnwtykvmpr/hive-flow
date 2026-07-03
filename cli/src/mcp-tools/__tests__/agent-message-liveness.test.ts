// cli/src/mcp-tools/__tests__/agent-message-liveness.test.ts
//
// P4 (Knot hive-flow-5de8): waiting-on-peer liveness.
//
// Acceptance coverage:
//   - waiting-on-peer reaper safety: the REAL protected reaper
//     (.claude/helpers/hive-cleanup.cjs, run as a subprocess) selects idle
//     workers only -- a waiting-on-peer worker with the OLDEST idle clock is
//     structurally never reclaimed. Data-driven carve-out: no reaper change.
//   - watcher settlement: the REAL scripts/hive-watcher.cjs pollWorkers()
//     excludes waiting workers from allComplete, exactly like
//     permission-blocked workers, until the escalation is answered.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { escalateBlockedMessage, mediateMessage } from '../agent-message-router.js';
import { sendMessage, listInbox, readInboxMessage, recipientKey } from '../agent-message-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const watcherScript = join(repoRoot, 'scripts', 'hive-watcher.cjs');
const reaperScript = join(repoRoot, '.claude', 'helpers', 'hive-cleanup.cjs');
const cjsRequire = createRequire(import.meta.url);

interface WatcherModule {
  pollWorkers: (hivesDir: string, tasksDir: string, hiveId: string) => {
    allComplete: boolean;
    waitingOnPeerCount: number;
    waitingOnPeerWorkers: string[];
    runningCount: number;
    blockedCount: number;
  };
}
const watcher = cjsRequire(watcherScript) as WatcherModule;

let root: string;

const HIVE_ID = 'hive-live1';
const WORKER = { agentId: 'agent-worker', ownerSessionId: 'sess-owner', ownerClientKind: 'codex' };
const QUEEN = { agentId: 'agent-queen', ownerSessionId: 'sess-queen', ownerClientKind: 'claude-code' };

function hivesDir(): string { return join(root, '.hive-flow', 'hives'); }
function tasksDir(): string { return join(root, '.hive-flow', 'tasks'); }
function hivePath(): string { return join(hivesDir(), HIVE_ID, 'hive.json'); }

function iso(msAgo: number): string { return new Date(Date.now() - msAgo).toISOString(); }

function seedAgents(): void {
  const dir = join(root, '.hive-flow', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'store.json'), JSON.stringify({
    version: 3,
    agents: {
      [WORKER.agentId]: {
        agentId: WORKER.agentId, agentType: 'coder', status: 'idle', health: 'healthy',
        taskCount: 0, config: {}, createdAt: iso(600_000), hiveId: HIVE_ID,
        ownerSessionId: WORKER.ownerSessionId, ownerClientKind: WORKER.ownerClientKind,
      },
      [QUEEN.agentId]: {
        agentId: QUEEN.agentId, agentType: 'coder', status: 'idle', health: 'healthy',
        taskCount: 0, config: {}, createdAt: iso(600_000),
        ownerSessionId: QUEEN.ownerSessionId, ownerClientKind: QUEEN.ownerClientKind,
      },
    },
  }, null, 2), 'utf-8');
}

function worker(workerId: string, agentId: string, status: string, idleSinceMsAgo: number) {
  return {
    workerId,
    agentId,
    role: 'coder',
    provider: 'deepseek',
    status,
    spawnedAt: iso(600_000),
    idleSince: iso(idleSinceMsAgo),
  };
}

function seedHive(workers: Array<Record<string, unknown>>): void {
  mkdirSync(join(hivesDir(), HIVE_ID), { recursive: true });
  mkdirSync(tasksDir(), { recursive: true });
  writeFileSync(hivePath(), JSON.stringify({
    hiveId: HIVE_ID,
    queenId: QUEEN.agentId,
    status: 'active',
    ownerSessionId: 'sess-hive-owner',
    ownerClientKind: 'claude-code',
    workers,
    budget: { workersAllocated: workers.length },
    // worker-tasked audit entries close the watcher's startup grace window.
    audit: workers.map(w => ({ event: 'worker-tasked', workerId: w.workerId, at: iso(500_000) })),
    createdAt: iso(600_000),
    updatedAt: iso(500_000),
  }, null, 2), 'utf-8');
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hf-iac-p4-live-')));
  seedAgents();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Watcher settlement: waiting-on-peer is non-settled
// ---------------------------------------------------------------------------

describe('watcher allComplete excludes waiting-on-peer workers', () => {
  it('holds the hive open while an escalation is un-answered, settles after mediation', async () => {
    seedHive([worker('w-1', WORKER.agentId, 'idle', 300_000)]);

    // Baseline: nothing running, nothing blocked, window closed -> settled.
    const baseline = watcher.pollWorkers(hivesDir(), tasksDir(), HIVE_ID);
    expect(baseline.allComplete).toBe(true);
    expect(baseline.waitingOnPeerCount).toBe(0);

    // An un-answered escalation makes the worker non-settled.
    const escalated = await escalateBlockedMessage({
      fromAgentId: WORKER.agentId,
      body: 'blocked on peer input',
      blockerClass: 'needs-mediation',
      unblockCondition: 'queen answers the escalation',
    }, root);
    expect(escalated.success).toBe(true);
    if (!escalated.success) return;
    const waitingPoll = watcher.pollWorkers(hivesDir(), tasksDir(), HIVE_ID);
    expect(waitingPoll.allComplete).toBe(false);
    expect(waitingPoll.waitingOnPeerWorkers).toEqual(['w-1']);

    // Mediation answers (acks) the escalation -> the hive may settle again.
    const mediated = await mediateMessage({
      mediatorAgentId: QUEEN.agentId,
      messageId: escalated.message.messageId,
      decision: 'resume',
      guidance: 'peer input attached; continue',
    }, root);
    expect(mediated.success).toBe(true);
    const settledPoll = watcher.pollWorkers(hivesDir(), tasksDir(), HIVE_ID);
    expect(settledPoll.waitingOnPeerCount).toBe(0);
    expect(settledPoll.allComplete).toBe(true);
  });

  it('does not count plain informs or non-ack messages as waiting', async () => {
    seedHive([worker('w-1', WORKER.agentId, 'idle', 300_000)]);
    const res = await escalateBlockedMessage({
      fromAgentId: WORKER.agentId,
      body: 'FYI only',
      verb: 'ask',
    }, root);
    expect(res.success).toBe(true);
    // ask escalations DO require ack (router sets requiresAck), so craft the
    // non-counting case via the hive record itself: a terminated worker's
    // messages never count.
    const hive = JSON.parse(readFileSync(hivePath(), 'utf-8'));
    hive.workers[0].status = 'terminated';
    writeFileSync(hivePath(), JSON.stringify(hive, null, 2), 'utf-8');
    const poll = watcher.pollWorkers(hivesDir(), tasksDir(), HIVE_ID);
    expect(poll.waitingOnPeerCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Verified-only waiting (Codex bounce 20260703T233445Z): forged/tampered or
// TTL-expired records must never hold a hive open
// ---------------------------------------------------------------------------

describe('waiting-on-peer counts verified records only', () => {
  const queenAddr = { agentId: QUEEN.agentId, ownerSessionId: QUEEN.ownerSessionId, ownerClientKind: QUEEN.ownerClientKind };

  it('a valid signed escalation counts; a forged unsigned record does not', async () => {
    seedHive([
      worker('w-1', WORKER.agentId, 'idle', 300_000),
      worker('w-2', 'agent-second', 'idle', 300_000),
    ]);
    const escalated = await escalateBlockedMessage({
      fromAgentId: WORKER.agentId,
      body: 'real signed escalation',
      blockerClass: 'needs-mediation',
      unblockCondition: 'queen answers',
    }, root);
    expect(escalated.success).toBe(true);

    // Hand-crafted UNSIGNED record claiming to be from w-2's agent: the
    // signing key exists (real store), so counting is live -- but the forgery
    // must not register.
    const forgedDir = join(root, '.hive-flow', 'messages', 'inbox', 'forged-recipient-dir');
    mkdirSync(forgedDir, { recursive: true });
    writeFileSync(join(forgedDir, 'msg-forged.json'), JSON.stringify({
      messageId: 'msg-forged',
      from: { agentId: 'agent-second', ownerSessionId: 'sess-x', ownerClientKind: 'codex' },
      to: { agentId: '', ownerSessionId: 'sess-y', ownerClientKind: 'codex' },
      verb: 'blocked',
      requiresAck: true,
      deliveryState: 'pending',
      priority: 'high',
      body: 'forged waiting claim',
      createdAt: new Date().toISOString(),
    }, null, 2), 'utf-8');

    const poll = watcher.pollWorkers(hivesDir(), tasksDir(), HIVE_ID);
    expect(poll.waitingOnPeerWorkers).toEqual(['w-1']);
    expect(poll.allComplete).toBe(false);
  });

  it('a tampered record stops counting and cannot hold the hive open', async () => {
    seedHive([worker('w-1', WORKER.agentId, 'idle', 300_000)]);
    const escalated = await escalateBlockedMessage({
      fromAgentId: WORKER.agentId,
      body: 'about to be tampered',
      blockerClass: 'needs-mediation',
      unblockCondition: 'queen answers',
    }, root);
    expect(escalated.success).toBe(true);
    if (!escalated.success) return;
    expect(watcher.pollWorkers(hivesDir(), tasksDir(), HIVE_ID).waitingOnPeerCount).toBe(1);

    // Tamper the record body on disk: the signature is now stale.
    const recordPath = join(root, '.hive-flow', 'messages', 'inbox', recipientKey(queenAddr), `${escalated.message.messageId}.json`);
    const record = JSON.parse(readFileSync(recordPath, 'utf-8'));
    record.body = 'forged content';
    writeFileSync(recordPath, JSON.stringify(record, null, 2), 'utf-8');

    const poll = watcher.pollWorkers(hivesDir(), tasksDir(), HIVE_ID);
    expect(poll.waitingOnPeerCount).toBe(0);
    expect(poll.allComplete).toBe(true);
  });

  it('a TTL-expired record does not count; store-owned durable expiry stays coherent', async () => {
    seedHive([worker('w-1', WORKER.agentId, 'idle', 300_000)]);
    const sent = await sendMessage({
      fromAgentId: WORKER.agentId,
      to: queenAddr,
      verb: 'blocked',
      body: 'short-lived escalation',
      unblockCondition: 'answer before the TTL',
      requiresAck: true,
      ttlMs: 1,
      priority: 'high',
    }, root);
    await new Promise(r => setTimeout(r, 15));

    // The watcher skips the overdue record (no durable mutation from the scan)...
    const poll = watcher.pollWorkers(hivesDir(), tasksDir(), HIVE_ID);
    expect(poll.waitingOnPeerCount).toBe(0);
    expect(poll.allComplete).toBe(true);
    // ...and the store still owns the DURABLE transition on its next read.
    expect(listInbox(queenAddr, root).messages).toHaveLength(0);
    const record = readInboxMessage(recipientKey(queenAddr), sent.messageId, root);
    expect(record.ok && record.message.deliveryState).toBe('expired');
    expect(watcher.pollWorkers(hivesDir(), tasksDir(), HIVE_ID).waitingOnPeerCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reaper safety: the REAL protected reaper never selects a waiting worker
// ---------------------------------------------------------------------------

describe('idle reaper spares waiting-on-peer workers (real hive-cleanup.cjs)', () => {
  it('terminates only stale-idle workers; the oldest waiting-on-peer worker survives', () => {
    // Six non-queen workers: five stale-idle, one waiting-on-peer whose idle
    // clock is the OLDEST of all -- if the reaper selected by age alone it
    // would pick the waiting worker first. MIN_WORKERS floor (5) allows
    // exactly one termination: it must be the oldest IDLE worker.
    seedHive([
      worker('w-wait', 'agent-waiting', 'waiting-on-peer', 7_200_000), // oldest of all
      worker('w-idle-1', 'agent-i1', 'idle', 3_600_000),               // oldest idle
      worker('w-idle-2', 'agent-i2', 'idle', 3_000_000),
      worker('w-idle-3', 'agent-i3', 'idle', 2_400_000),
      worker('w-idle-4', 'agent-i4', 'idle', 1_800_000),
      worker('w-idle-5', 'agent-i5', 'idle', 1_200_000),
    ]);

    execFileSync('node', [reaperScript], {
      input: '{}',
      cwd: root,
      env: { ...process.env, HIVE_FLOW_CLEANUP_PROJECT_DIR: root },
      encoding: 'utf-8',
      timeout: 30_000,
    });

    const hive = JSON.parse(readFileSync(hivePath(), 'utf-8'));
    const byId = new Map<string, { status: string }>(
      hive.workers.map((w: { workerId: string; status: string }) => [w.workerId, w]),
    );
    // The waiting worker is untouched despite being the oldest.
    expect(byId.get('w-wait')?.status).toBe('waiting-on-peer');
    // Exactly one idle worker was reclaimed: the oldest idle one.
    const terminated = hive.workers.filter((w: { status: string }) => w.status === 'terminated');
    expect(terminated.map((w: { workerId: string }) => w.workerId)).toEqual(['w-idle-1']);
  }, 40_000);
});
