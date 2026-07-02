import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queenTools } from '../queen-tools.js';
import { createHive, loadHive, saveHive, withHiveLock } from '../hive-store.js';
import { setWorkflowHookDispatcher } from '../workflow-executor.js';
import type { HiveAuditEntry, HiveRecord, HiveWorkerRecord } from '../hive-store.js';

const originalCwd = process.cwd();
const originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
let tempDir: string;

function getQueenTool(name: string) {
  const tool = queenTools.find(t => t.name === name);
  if (!tool) throw new Error(`Missing queen tool ${name}`);
  return tool;
}

function isoMsAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function makeWorker(overrides: Partial<HiveWorkerRecord> = {}): HiveWorkerRecord {
  return {
    workerId: 'worker-1',
    agentId: 'agent-1',
    role: 'coder',
    provider: 'codex-cli',
    status: 'idle',
    spawnedAt: isoMsAgo(10 * 60_000),
    ...overrides,
  };
}

function taskedAudit(hiveId: string, worker: HiveWorkerRecord): HiveAuditEntry {
  return {
    timestamp: isoMsAgo(9 * 60_000),
    event: 'worker-tasked',
    hiveId,
    workerId: worker.workerId,
    agentId: worker.agentId,
    detail: `${worker.workerId} was tasked`,
  };
}

async function seedHive(workers: HiveWorkerRecord[], audit: HiveAuditEntry[] = []): Promise<HiveRecord> {
  const hive = createHive('queen-settlement', { maxWorkers: workers.length || 1 });
  await withHiveLock(hive.hiveId, () => {
    const fresh = loadHive(hive.hiveId);
    if (!fresh) throw new Error(`Missing hive ${hive.hiveId}`);
    fresh.status = 'active';
    fresh.workers = workers;
    fresh.audit = audit;
    fresh.budget.workersAllocated = workers.length;
    saveHive(hive.hiveId, fresh);
  });
  const saved = loadHive(hive.hiveId);
  if (!saved) throw new Error(`Missing saved hive ${hive.hiveId}`);
  return saved;
}

function writeTracking(taskId: string, tracking: Record<string, unknown>, result?: unknown): void {
  const tasksDir = join(tempDir, '.hive-flow', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, `${taskId}.json`), JSON.stringify({
    taskId,
    status: 'running',
    startedAt: isoMsAgo(5 * 60_000),
    ...tracking,
  }, null, 2));
  if (result !== undefined) {
    writeFileSync(join(tasksDir, `${taskId}.result.json`), JSON.stringify(result, null, 2));
  }
}

async function pollHive(hiveId: string): Promise<Record<string, unknown>> {
  const tool = getQueenTool('hive_poll_workers');
  return await tool.handler({ hiveId }) as Record<string, unknown>;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'queen-tools-settlement-'));
  process.chdir(tempDir);
  process.env.CLAUDE_PROJECT_DIR = tempDir;
  delete process.env.HIVE_FLOW_SETTLE_GRACE_MS;
  setWorkflowHookDispatcher(null);
});

afterEach(() => {
  delete process.env.HIVE_FLOW_SETTLE_GRACE_MS;
  setWorkflowHookDispatcher(null);
  process.chdir(originalCwd);
  if (originalProjectDir === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('queen hive settlement predicate', () => {
  it('settles a never-tasked hive after the startup grace window as failed', async () => {
    const worker = makeWorker();
    const hive = await seedHive([worker]);

    const result = await pollHive(hive.hiveId);
    const settled = loadHive(hive.hiveId);

    expect(result.success).toBe(true);
    expect(result.runningCount).toBe(0);
    expect(result.completedCount).toBe(0);
    expect(result.allComplete).toBe(true);
    expect(result.allWorkersSettled).toBe(true);
    expect(settled?.status).toBe('failed');
    expect(settled?.completedAt).toBeTruthy();
    expect(settled?.error).toMatch(/Hive settled with no completed workers/);
  });

  it('keeps a freshly-spawned never-tasked hive active inside the startup grace window', async () => {
    const worker = makeWorker({ spawnedAt: isoMsAgo(2_000) });
    const hive = await seedHive([worker]);

    const result = await pollHive(hive.hiveId);
    const settled = loadHive(hive.hiveId);

    expect(result.success).toBe(true);
    expect(result.runningCount).toBe(0);
    expect(result.allComplete).toBe(false);
    expect(result.readyForReport).toBe(false);
    expect(settled?.status).toBe('active');
    expect(settled?.completedAt).toBeUndefined();
  });

  it('settles completed tasked workers as completed', async () => {
    const worker = makeWorker();
    const hive = await seedHive([worker]);
    writeTracking('task-complete', {
      agentId: worker.agentId,
      pid: process.pid,
    }, { ok: true });
    await withHiveLock(hive.hiveId, () => {
      const fresh = loadHive(hive.hiveId);
      if (!fresh) throw new Error(`Missing hive ${hive.hiveId}`);
      fresh.audit.push(taskedAudit(hive.hiveId, worker));
      saveHive(hive.hiveId, fresh);
    });

    const result = await pollHive(hive.hiveId);
    const settled = loadHive(hive.hiveId);

    expect(result.success).toBe(true);
    expect(result.completedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.allComplete).toBe(true);
    expect(settled?.status).toBe('completed');
    expect(settled?.error).toBeUndefined();
    expect(settled?.completedAt).toBeTruthy();
  });

  // P2-SH2 (hive-flow-4a28): a worker blocked on an undecided permission request must
  // NOT let the hive settle, even though it otherwise looks idle/settled.
  it('does not settle while a worker is blocked on a pending permission request', async () => {
    const worker = makeWorker();
    const hive = await seedHive([worker]);
    // Worker was tasked (so it is past the startup grace window) but is now idle,
    // awaiting a queen decision on a permission request it raised.
    await withHiveLock(hive.hiveId, () => {
      const fresh = loadHive(hive.hiveId);
      if (!fresh) throw new Error(`Missing hive ${hive.hiveId}`);
      fresh.audit.push(taskedAudit(hive.hiveId, worker));
      saveHive(hive.hiveId, fresh);
    });
    // Undecided permission request in the append-only log.
    const hiveDir = join(tempDir, '.hive-flow', 'hives', hive.hiveId);
    mkdirSync(hiveDir, { recursive: true });
    writeFileSync(join(hiveDir, 'permission-requests.jsonl'), `${JSON.stringify({
      kind: 'worker-permission-denial',
      requestId: 'perm-blocked-1',
      taskId: 'task-blocked',
      ts: new Date(0).toISOString(),
      agentId: worker.agentId,
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      tool: 'run_command',
      denyReason: 'blocked pending queen decision',
      denyCode: 'read-only-command-denied',
    })}\n`);

    const result = await pollHive(hive.hiveId);
    const settled = loadHive(hive.hiveId);

    expect(result.success).toBe(true);
    expect(result.blockedCount).toBe(1);
    expect(result.blockedWorkers).toContain(worker.workerId);
    expect(result.allComplete).toBe(false);        // blocked worker prevents settlement
    expect(result.allWorkersSettled).toBe(false);
    expect(settled?.status).toBe('active');         // NOT auto-transitioned
    const ws = (result.workers as Array<Record<string, unknown>>).find(w => w.workerId === worker.workerId);
    expect(ws?.status).toBe('permission-waiting');  // first-class blocked state in the report
  });

  it('does not settle while any worker is still running', async () => {
    const running = makeWorker({ workerId: 'worker-running', agentId: 'agent-running' });
    const completed = makeWorker({ workerId: 'worker-completed', agentId: 'agent-completed' });
    const hive = await seedHive([running, completed]);
    await withHiveLock(hive.hiveId, () => {
      const fresh = loadHive(hive.hiveId);
      if (!fresh) throw new Error(`Missing hive ${hive.hiveId}`);
      fresh.audit = [taskedAudit(hive.hiveId, running), taskedAudit(hive.hiveId, completed)];
      saveHive(hive.hiveId, fresh);
    });
    writeTracking('task-running', {
      agentId: running.agentId,
      pid: process.pid,
      status: 'running',
    });
    writeTracking('task-done', {
      agentId: completed.agentId,
      pid: process.pid,
    }, { ok: true });

    const result = await pollHive(hive.hiveId);
    const settled = loadHive(hive.hiveId);

    expect(result.success).toBe(true);
    expect(result.runningCount).toBe(1);
    expect(result.completedCount).toBe(1);
    expect(result.allComplete).toBe(false);
    expect(settled?.status).toBe('active');
  });
});

// d3-002 regression: hive_terminate must persist partial worker mutations before
// returning early on an [MCP ENFORCEMENT] error, so the store stays consistent
// with the in-memory hive record.
//
// Deterministic red/green proof:
//   - worker-1 agent_terminate → success  (worker-1 gets mutated to 'terminated' in memory)
//   - worker-2 agent_terminate → [MCP ENFORCEMENT] deny (early-return triggered)
//   - Pre-fix: saveHive() was only called after the early-return, so worker-1 stayed
//     'idle' on disk (store inconsistent with memory). Post-fix: saveHive() is called
//     before returning, so worker-1 is persisted as 'terminated' on disk.
describe('hive_terminate — store consistency on enforcement error (d3-002)', () => {
  it('persists worker-1 as terminated even when worker-2 triggers [MCP ENFORCEMENT] early-return', async () => {
    const hive = await seedHive([
      makeWorker({ workerId: 'worker-1', agentId: 'agent-1', status: 'idle' }),
      makeWorker({ workerId: 'worker-2', agentId: 'agent-2', status: 'idle' }),
    ]);

    const terminateTool = getQueenTool('hive_terminate');

    // Seed agent store so agent_terminate finds the agents
    const agentStoreDir = join(tempDir, '.hive-flow', 'agents');
    mkdirSync(agentStoreDir, { recursive: true });
    writeFileSync(join(agentStoreDir, 'agents.json'), JSON.stringify({
      agents: {
        [hive.queenId]: { agentId: hive.queenId, status: 'idle', provider: 'codex-cli', model: 'gpt-5.5', config: {}, spawnedAt: new Date().toISOString() },
        'agent-1': { agentId: 'agent-1', status: 'idle', provider: 'codex-cli', model: 'gpt-5.5', config: {}, spawnedAt: new Date().toISOString() },
        'agent-2': { agentId: 'agent-2', status: 'idle', provider: 'codex-cli', model: 'gpt-5.5', config: {}, spawnedAt: new Date().toISOString() },
      },
    }, null, 2));

    // Intercept agentTools to inject a controlled agent_terminate handler.
    // callAgentTerminate() does `await import('./agent-tools.js')` on every call —
    // ES module imports are cached, so mutating agentTools in-place is visible.
    //
    // We also redirect HIVE_FLOW_HOME to a pristine temp dir so that
    // assertDispatchAllowed() in callAgentTerminate() sees enforcement level 0
    // (NORMAL — no enforcement state files) and passes the gate, letting our
    // injected handler control success/failure per agent.
    const savedHiveFlowHome = process.env.HIVE_FLOW_HOME;
    process.env.HIVE_FLOW_HOME = tempDir; // no enforcement files here → level 0

    const { agentTools } = await import('../agent-tools.js');
    const terminateEntry = agentTools.find(t => t.name === 'agent_terminate');
    if (!terminateEntry) throw new Error('agent_terminate tool not found in agentTools');

    const originalHandler = terminateEntry.handler;

    // Replace handler: worker-1 (agent-1) succeeds, worker-2 (agent-2) returns enforcement deny.
    // This directly proves the d3-002 bug: pre-fix, saveHive() was NOT called before the
    // early-return, so worker-1's in-memory mutation was never persisted to disk.
    terminateEntry.handler = async (input: Record<string, unknown>) => {
      const agentId = input.agentId as string;
      if (agentId === 'agent-1') {
        // Succeed for worker-1 — hive_terminate will then mutate worker-1 to 'terminated'
        // in the hive record (line 1092 in queen-tools.ts) before processing worker-2.
        return { success: true, agentId, terminated: true };
      }
      // agent-2 and the queen: simulate [MCP ENFORCEMENT] block on worker-2.
      if (agentId === 'agent-2') {
        return { success: false, error: '[MCP ENFORCEMENT] test deny' };
      }
      // queen: also succeed so it doesn't interfere
      return { success: true, agentId, terminated: true };
    };

    let result: Record<string, unknown>;
    try {
      result = await terminateTool.handler({ hiveId: hive.hiveId, reason: 'test' }) as Record<string, unknown>;
    } finally {
      terminateEntry.handler = originalHandler;
      if (savedHiveFlowHome === undefined) {
        delete process.env.HIVE_FLOW_HOME;
      } else {
        process.env.HIVE_FLOW_HOME = savedHiveFlowHome;
      }
    }

    // The enforcement error on worker-2 must cause hive_terminate to return failure
    expect(result!.success).toBe(false);
    expect(String(result!.error)).toContain('[MCP ENFORCEMENT]');

    // CRITICAL invariant (d3-002): worker-1 must be persisted as 'terminated' with
    // terminatedAt set. Pre-fix: the early-return happened before saveHive(), so
    // worker-1 stayed 'idle' on disk. Post-fix: saveHive() is called before returning.
    const stored = loadHive(hive.hiveId);
    expect(stored).not.toBeNull();

    const w1 = stored!.workers.find(w => w.workerId === 'worker-1');
    expect(w1).toBeDefined();
    expect(w1!.status).toBe('terminated');
    expect(w1!.terminatedAt).toBeDefined();

    // Confirm worker-2 is NOT terminated (enforcement blocked it)
    const w2 = stored!.workers.find(w => w.workerId === 'worker-2');
    expect(w2).toBeDefined();
    expect(w2!.status).not.toBe('terminated');
  });
});

// P2-SH2 (hive-flow-4a28): hive_status must surface workers blocked on an undecided
// permission request via blockedCount/blockedWorkers and a relabeled worker row, using
// the SAME derived source of truth as settlement — never a persisted mutable status.
describe('hive_status — permission-waiting visibility (hive-flow-4a28)', () => {
  async function seedBlockedHive(requestId: string): Promise<{ hive: HiveRecord; worker: HiveWorkerRecord }> {
    const worker = makeWorker();
    const hive = await seedHive([worker]);
    const hiveDir = join(tempDir, '.hive-flow', 'hives', hive.hiveId);
    mkdirSync(hiveDir, { recursive: true });
    writeFileSync(join(hiveDir, 'permission-requests.jsonl'), `${JSON.stringify({
      kind: 'worker-permission-denial',
      requestId,
      taskId: 'task-blocked',
      ts: new Date(0).toISOString(),
      agentId: worker.agentId,
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      tool: 'run_command',
      denyReason: 'blocked pending queen decision',
      denyCode: 'read-only-command-denied',
    })}\n`);
    return { hive, worker };
  }

  it('single-hive lookup exposes blockedCount/blockedWorkers and relabels the worker row', async () => {
    const { hive, worker } = await seedBlockedHive('perm-status-single');
    const tool = getQueenTool('hive_status');
    const result = await tool.handler({ hiveId: hive.hiveId }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.blockedCount).toBe(1);
    expect(result.blockedWorkers).toContain(worker.workerId);
    const returnedHive = result.hive as { workers: Array<Record<string, unknown>> };
    const ws = returnedHive.workers.find(w => w.workerId === worker.workerId);
    expect(ws?.status).toBe('permission-waiting');
  });

  it('list view exposes per-hive blockedCount/blockedWorkers', async () => {
    const { hive, worker } = await seedBlockedHive('perm-status-list');
    const tool = getQueenTool('hive_status');
    const result = await tool.handler({}) as Record<string, unknown>;

    expect(result.success).toBe(true);
    const summaries = result.hives as Array<Record<string, unknown>>;
    const summary = summaries.find(h => h.hiveId === hive.hiveId);
    expect(summary).toBeDefined();
    expect(summary?.blockedCount).toBe(1);
    expect(summary?.blockedWorkers).toContain(worker.workerId);
  });
});

// P2-SH2 (hive-flow-4a28): the statusboard runtime rows (collectActiveHiveRuntimeState)
// AND agent_list must surface a LIVE worker blocked on an undecided permission request as
// permission-waiting instead of an indistinguishable busy — same derived source of truth.
describe('statusboard / agent_list — permission-waiting visibility (hive-flow-4a28)', () => {
  it('relabels a live blocked worker as permission-waiting in runtime state and agent_list', async () => {
    const worker = makeWorker({ taskId: 'task-blocked' });
    const hive = await seedHive([worker]);
    // Runtime rows require an owner session; keep the hive active + past startup grace.
    await withHiveLock(hive.hiveId, () => {
      const fresh = loadHive(hive.hiveId);
      if (!fresh) throw new Error(`Missing hive ${hive.hiveId}`);
      fresh.ownerSessionId = 'sess-4a28-statusboard';
      fresh.audit.push(taskedAudit(hive.hiveId, worker));
      saveHive(hive.hiveId, fresh);
    });
    // Live task tracking (real, alive pid) so the worker counts as a live runtime row.
    writeTracking('task-blocked', { agentId: worker.agentId, pid: process.pid, status: 'running' });
    // Undecided permission request in the append-only log → worker is blocked.
    const hiveDir = join(tempDir, '.hive-flow', 'hives', hive.hiveId);
    mkdirSync(hiveDir, { recursive: true });
    writeFileSync(join(hiveDir, 'permission-requests.jsonl'), `${JSON.stringify({
      kind: 'worker-permission-denial',
      requestId: 'perm-runtime-1',
      taskId: 'task-blocked',
      ts: new Date(0).toISOString(),
      agentId: worker.agentId,
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      tool: 'run_command',
      denyReason: 'blocked pending queen decision',
      denyCode: 'read-only-command-denied',
    })}\n`);

    const { collectActiveHiveRuntimeState } = await import('../../statusline/hive-ownership.js');
    const runtime = await collectActiveHiveRuntimeState(tempDir);
    const runtimeWorker = runtime?.activeAgents.find(a => a.agentId === worker.agentId);
    expect(runtimeWorker).toBeDefined();
    expect(runtimeWorker?.status).toBe('permission-waiting');

    const { agentTools } = await import('../agent-tools.js');
    const listTool = agentTools.find(t => t.name === 'agent_list');
    if (!listTool) throw new Error('agent_list tool not found');
    const listResult = await listTool.handler({}) as { agents: Array<Record<string, unknown>> };
    const listed = listResult.agents.find(a => a.agentId === worker.agentId);
    expect(listed).toBeDefined();
    expect(listed?.status).toBe('permission-waiting');
  });

  // Bounce #2 (Codex, 2026-07-02): the real production path is a worker that ALSO
  // has a persisted store.json row. appendHiveRuntimeAgents skipped such agents (they
  // are already in `seen`), so the persisted busy/idle status leaked through. The
  // overlay must relabel the persisted row to permission-waiting WITHOUT mutating the store.
  it('overlays permission-waiting onto a persisted store row without mutating the store', async () => {
    const worker = makeWorker({ taskId: 'task-blocked-persisted' });
    const hive = await seedHive([worker]);
    await withHiveLock(hive.hiveId, () => {
      const fresh = loadHive(hive.hiveId);
      if (!fresh) throw new Error(`Missing hive ${hive.hiveId}`);
      fresh.ownerSessionId = 'sess-4a28-persisted';
      fresh.audit.push(taskedAudit(hive.hiveId, worker));
      saveHive(hive.hiveId, fresh);
    });
    // Real persisted store row for the worker — the production path.
    const agentStoreDir = join(tempDir, '.hive-flow', 'agents');
    mkdirSync(agentStoreDir, { recursive: true });
    const storePath = join(agentStoreDir, 'store.json');
    writeFileSync(storePath, JSON.stringify({
      agents: {
        [worker.agentId]: {
          agentId: worker.agentId,
          agentType: 'coder',
          status: 'busy',
          health: 1,
          taskCount: 1,
          config: {},
          createdAt: isoMsAgo(10 * 60_000),
          provider: 'codex-cli',
        },
      },
    }, null, 2));
    // Live task tracking so the worker is a live runtime row.
    writeTracking('task-blocked-persisted', { agentId: worker.agentId, pid: process.pid, status: 'running' });
    // Undecided permission request → blocked.
    const hiveDir = join(tempDir, '.hive-flow', 'hives', hive.hiveId);
    mkdirSync(hiveDir, { recursive: true });
    writeFileSync(join(hiveDir, 'permission-requests.jsonl'), `${JSON.stringify({
      kind: 'worker-permission-denial',
      requestId: 'perm-persisted-1',
      taskId: 'task-blocked-persisted',
      ts: new Date(0).toISOString(),
      agentId: worker.agentId,
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      tool: 'run_command',
      denyReason: 'blocked pending queen decision',
      denyCode: 'read-only-command-denied',
    })}\n`);

    const { agentTools } = await import('../agent-tools.js');
    const listTool = agentTools.find(t => t.name === 'agent_list');
    if (!listTool) throw new Error('agent_list tool not found');

    // Default list: the persisted busy row is overlaid to permission-waiting.
    const all = await listTool.handler({}) as { agents: Array<Record<string, unknown>> };
    const listed = all.agents.find(a => a.agentId === worker.agentId);
    expect(listed).toBeDefined();
    expect(listed?.source).toBe('agent-store');            // the REAL persisted row, not a synthetic runtime row
    expect(listed?.status).toBe('permission-waiting');

    // Status filters reflect the overlay.
    const waiting = await listTool.handler({ status: 'permission-waiting' }) as { agents: Array<Record<string, unknown>> };
    expect(waiting.agents.some(a => a.agentId === worker.agentId)).toBe(true);

    const busy = await listTool.handler({ status: 'busy' }) as { agents: Array<Record<string, unknown>> };
    expect(busy.agents.some(a => a.agentId === worker.agentId)).toBe(false);

    // The store on disk is NOT mutated — the overlay is read-only.
    const storeOnDisk = JSON.parse(readFileSync(storePath, 'utf-8')) as { agents: Record<string, { status: string }> };
    expect(storeOnDisk.agents[worker.agentId].status).toBe('busy');
  });
});
