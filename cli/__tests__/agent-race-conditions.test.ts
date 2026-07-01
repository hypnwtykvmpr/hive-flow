/**
 * Concurrent Stress Tests for Agent Race Condition Fixes
 *
 * Tests RC-1 through RC-5:
 *   RC-1: Store-level file locking (withStoreLock)
 *   RC-2: Single writer during task execution
 *   RC-3: State machine (valid transitions only)
 *   RC-4: UUID agent IDs (no collisions)
 *   RC-5: Single store-level lock (not per-agent)
 *
 * These tests exercise the agent-tools handlers directly with real
 * concurrency via Promise.all to surface race conditions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(), // also used by withStoreLock (directory-based lock)
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmdirSync: vi.fn(), // lock cleanup
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:url', () => ({
  fileURLToPath: vi.fn(() => '/fake/dist/src/mcp-tools/agent-tools.js'),
}));

vi.mock('../src/hivector/model-router.js', () => ({
  getModelRouter: () => null,
}));

vi.mock('../src/hivector/enhanced-model-router.js', () => ({
  getEnhancedModelRouter: () => ({
    route: async () => ({ model: 'sonnet', tier: 3, canSkipLLM: false }),
  }),
}));

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { DEFAULT_MAX_AGENTS, DEFAULT_QUEUE_DEPTH } from '../src/shared/core/config/defaults.js';
import { agentTools, loadAgentStore, transitionAgent } from '../src/mcp-tools/agent-tools.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

interface AgentRecord {
  agentId: string;
  agentType: string;
  status: 'spawning' | 'idle' | 'busy' | 'terminated';
  health: number;
  taskCount: number;
  config: Record<string, unknown>;
  createdAt: string;
  idleSince?: string;
  terminatedAt?: string;
  provider?: string;
  model?: string;
  modelRoutedBy?: string;
}

interface AgentStore {
  agents: Record<string, AgentRecord>;
  version: string;
}

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: `agent-test-${Math.random().toString(36).slice(2, 10)}`,
    agentType: 'implementer',
    status: 'idle',
    health: 1.0,
    taskCount: 0,
    config: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeStore(agents: Record<string, AgentRecord> = {}): AgentStore {
  return { agents, version: '3.0.0' };
}

/** Look up a tool handler by name */
function getHandler(name: string) {
  const tool = agentTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool.handler;
}

const spawnHandler = getHandler('agent_spawn');
const terminateHandler = getHandler('agent_terminate');
const updateHandler = getHandler('agent_update');
const listHandler = getHandler('agent_list');
const statusHandler = getHandler('agent_status');
const poolHandler = getHandler('agent_pool');

/**
 * Set up fs mocks so that loadAgentStore/saveAgentStore use an in-memory
 * store. Every writeFileSync call updates the in-memory state so that
 * subsequent readFileSync calls see the latest data — simulating real
 * filesystem persistence without touching disk.
 */
function setupStoreMocks(initialStore: AgentStore) {
  let currentStore = JSON.parse(JSON.stringify(initialStore));

  (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('store.json')) return true;
    if (typeof p === 'string' && p.endsWith('.store.lock')) return false;
    return false;
  });

  (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
    return JSON.stringify(currentStore);
  });

  (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(
    (_path: string, data: string) => {
      try {
        currentStore = JSON.parse(data);
      } catch {
        // tmp file writes may not be valid JSON yet
      }
    },
  );

  (renameSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
  (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});

  return {
    getPersistedStore: () => currentStore as AgentStore,
  };
}

/** Union of possible result shapes returned by agent tool handlers. */
interface AgentHandlerResult {
  success?: boolean;
  status?: string;
  agentId?: string;
  terminated?: boolean;
  total?: number;
  agents?: unknown[];
  error?: string;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Agent Race Condition Stress Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 1. Concurrent spawn — 20 agents in parallel
  // ════════════════════════════════════════════════════════════════════════════
  describe('RC-1/RC-5: Concurrent spawn (20 agents)', () => {
    it('stores the spawn token on the agent record without setting a global env var', async () => {
      delete process.env.HIVE_FLOW_AGENT_TOKEN;
      const { getPersistedStore } = setupStoreMocks(makeStore());

      const result = await spawnHandler({ agentType: 'implementer', agentId: 'spawn-token-check' });

      expect((result as AgentHandlerResult).success).toBe(true);
      expect(process.env.HIVE_FLOW_AGENT_TOKEN).toBeUndefined();

      const storedAgent = getPersistedStore().agents['spawn-token-check'];
      expect(typeof storedAgent?.config._spawnToken).toBe('string');
      expect((storedAgent?.config._spawnToken as string).length).toBeGreaterThan(0);
    });

    it('should create 20 agents with unique IDs and no data corruption', async () => {
      const { getPersistedStore } = setupStoreMocks(makeStore());

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          spawnHandler({ agentType: 'implementer', agentId: `spawn-${i}` }),
        ),
      );

      // All 20 should succeed
      for (const result of results) {
        expect((result as AgentHandlerResult).success).toBe(true);
        expect((result as AgentHandlerResult).status).toBe('spawned');
      }

      // Verify unique IDs
      const ids = results.map((r) => (r as AgentHandlerResult).agentId);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(20);

      // Verify store is valid JSON with correct data
      const store = getPersistedStore();
      expect(store.version).toBe('3.0.0');
      expect(typeof store.agents).toBe('object');
    });

    it('should produce no duplicate IDs when auto-generating IDs concurrently', async () => {
      const { getPersistedStore } = setupStoreMocks(makeStore());

      // Spawn 20 agents WITHOUT explicit IDs — forces auto-generation
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          spawnHandler({ agentType: 'implementer' }),
        ),
      );

      const ids = results.map((r) => (r as AgentHandlerResult).agentId);
      const uniqueIds = new Set(ids);

      // Every auto-generated ID must be unique (RC-4)
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 2. Concurrent spawn + terminate
  // ════════════════════════════════════════════════════════════════════════════
  describe('RC-1/RC-2: Concurrent spawn + terminate', () => {
    it('should handle 10 spawns and 5 terminates concurrently', async () => {
      // Pre-populate store with 5 agents to terminate
      const existingAgents: Record<string, AgentRecord> = {};
      for (let i = 0; i < 5; i++) {
        const agent = makeAgent({ agentId: `existing-${i}`, status: 'idle' });
        existingAgents[agent.agentId] = agent;
      }
      const { getPersistedStore } = setupStoreMocks(makeStore(existingAgents));

      // Spawn 10 new + terminate 5 existing — all at once
      const spawnPromises = Array.from({ length: 10 }, (_, i) =>
        spawnHandler({ agentType: 'implementer', agentId: `new-${i}` }),
      );
      const terminatePromises = Array.from({ length: 5 }, (_, i) =>
        terminateHandler({ agentId: `existing-${i}` }),
      );

      const allResults = await Promise.all([
        ...spawnPromises,
        ...terminatePromises,
      ]);

      // All operations should succeed
      for (const result of allResults) {
        expect((result as AgentHandlerResult).success).toBe(true);
      }

      // Verify final store state
      const store = getPersistedStore();
      expect(typeof store.agents).toBe('object');

      // Count how many terminated agents retained their status.
      // Without store-level locking (RC-1/RC-5), concurrent spawns may
      // overwrite terminate results via stale-read-then-write. Once file
      // locking is implemented, all 5 should be terminated.
      let terminatedCount = 0;
      for (let i = 0; i < 5; i++) {
        const agent = store.agents[`existing-${i}`];
        if (agent && agent.status === 'terminated') {
          terminatedCount++;
        }
      }
      expect(terminatedCount).toBe(5);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 3. UUID uniqueness (RC-4)
  // ════════════════════════════════════════════════════════════════════════════
  describe('RC-4: UUID uniqueness', () => {
    it('should generate 1000 unique agent IDs with no duplicates', async () => {
      setupStoreMocks(makeStore());

      // Generate 1000 IDs by spawning agents with auto-generated IDs
      // We batch in groups of 50 to avoid overwhelming the mock
      const allIds: string[] = [];

      for (let batch = 0; batch < 20; batch++) {
        const results = await Promise.all(
          Array.from({ length: 50 }, () =>
            spawnHandler({ agentType: 'implementer' }),
          ),
        );
        for (const r of results) {
          allIds.push((r as AgentHandlerResult).agentId);
        }
      }

      expect(allIds.length).toBe(1000);

      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(1000);

      // Verify all IDs are non-empty strings
      for (const id of allIds) {
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
      }
    }, 15_000);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 3.5. Spawn hard-cap enforcement (Codex Wave 7.5 B-5 follow-up)
  // ════════════════════════════════════════════════════════════════════════════
  describe('RC-6: agent_spawn production hard-cap (DEFAULT_MAX_AGENTS + DEFAULT_QUEUE_DEPTH)', () => {
    it('rejects with busy:queue-full when workingCount reaches the hard cap', async () => {
      // The production hard-cap branch in agent-tools.ts:agent_spawn is bypassed
      // when process.env.VITEST === 'true' so the surrounding 1000-spawn UUID
      // uniqueness test can run unbounded. Re-enable enforcement for this test.
      const originalVitest = process.env.VITEST;
      delete process.env.VITEST;
      try {
        const hardCap = DEFAULT_MAX_AGENTS + DEFAULT_QUEUE_DEPTH;
        // Pre-populate the store exactly to the production hard cap.
        const agents: Record<string, AgentRecord> = {};
        for (let i = 0; i < hardCap; i++) {
          const id = `cap-test-agent-${i}`;
          agents[id] = makeAgent({ agentId: id, status: i % 3 === 0 ? 'idle' : i % 3 === 1 ? 'busy' : 'spawning' });
        }
        setupStoreMocks(makeStore(agents));

        const result = (await spawnHandler({ agentType: 'implementer' })) as AgentHandlerResult & {
          code?: string;
          workingCount?: number;
          capacity?: number;
        };

        expect(result.success).toBe(false);
        expect(result.error).toBe('busy:queue-full');
        expect(result.code).toBe('busy:queue-full');
        expect(result.workingCount).toBe(hardCap);
        expect(result.capacity).toBe(hardCap);
      } finally {
        if (originalVitest !== undefined) process.env.VITEST = originalVitest;
      }
    });

    it('accepts spawn at workingCount = 59 (one slot remaining below the hard cap)', async () => {
      const originalVitest = process.env.VITEST;
      delete process.env.VITEST;
      try {
        const agents: Record<string, AgentRecord> = {};
        for (let i = 0; i < 59; i++) {
          const id = `cap-boundary-agent-${i}`;
          agents[id] = makeAgent({ agentId: id, status: 'idle' });
        }
        setupStoreMocks(makeStore(agents));

        const result = (await spawnHandler({ agentType: 'implementer', agentId: 'boundary-spawn' })) as AgentHandlerResult;

        expect(result.success).toBe(true);
        expect(result.agentId).toBe('boundary-spawn');
      } finally {
        if (originalVitest !== undefined) process.env.VITEST = originalVitest;
      }
    });

    it('does not count terminated agents toward the working set', async () => {
      const originalVitest = process.env.VITEST;
      delete process.env.VITEST;
      try {
        const hardCap = DEFAULT_MAX_AGENTS + DEFAULT_QUEUE_DEPTH;
        // Hard-cap number of terminated agents present — should NOT block new spawns.
        const agents: Record<string, AgentRecord> = {};
        for (let i = 0; i < hardCap; i++) {
          const id = `terminated-agent-${i}`;
          agents[id] = makeAgent({ agentId: id, status: 'terminated' });
        }
        setupStoreMocks(makeStore(agents));

        const result = (await spawnHandler({ agentType: 'implementer', agentId: 'post-termination-spawn' })) as AgentHandlerResult;

        expect(result.success).toBe(true);
        expect(result.agentId).toBe('post-termination-spawn');
      } finally {
        if (originalVitest !== undefined) process.env.VITEST = originalVitest;
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 4. State machine transitions (RC-3)
  // ════════════════════════════════════════════════════════════════════════════
  describe('RC-3: State machine transitions', () => {
    it('should stamp idleSince and terminatedAt during lifecycle transitions', () => {
      vi.useFakeTimers();
      try {
        const agent = makeAgent({ agentId: 'sm-ts', status: 'spawning' });

        vi.setSystemTime(new Date('2026-03-23T10:00:00.000Z'));
        expect(transitionAgent(agent, 'idle')).toBe(true);
        expect(agent.idleSince).toBe('2026-03-23T10:00:00.000Z');
        expect(agent.terminatedAt).toBeUndefined();

        vi.setSystemTime(new Date('2026-03-23T10:01:00.000Z'));
        expect(transitionAgent(agent, 'busy')).toBe(true);
        expect(agent.idleSince).toBeUndefined();
        expect(agent.terminatedAt).toBeUndefined();

        vi.setSystemTime(new Date('2026-03-23T10:02:00.000Z'));
        expect(transitionAgent(agent, 'idle')).toBe(true);
        expect(agent.idleSince).toBe('2026-03-23T10:02:00.000Z');

        vi.setSystemTime(new Date('2026-03-23T10:03:00.000Z'));
        expect(transitionAgent(agent, 'terminated')).toBe(true);
        expect(agent.idleSince).toBeUndefined();
        expect(agent.terminatedAt).toBe('2026-03-23T10:03:00.000Z');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should allow idle -> busy transition', async () => {
      const agent = makeAgent({ agentId: 'sm-1', status: 'idle' });
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      const result = await updateHandler({
        agentId: 'sm-1',
        status: 'busy',
      });

      expect((result as AgentHandlerResult).success).toBe(true);
    });

    it('should allow busy -> idle transition', async () => {
      const agent = makeAgent({ agentId: 'sm-2', status: 'busy' });
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      const result = await updateHandler({
        agentId: 'sm-2',
        status: 'idle',
      });

      expect((result as AgentHandlerResult).success).toBe(true);
    });

    it('should allow idle -> terminated transition', async () => {
      const agent = makeAgent({ agentId: 'sm-3', status: 'idle' });
      const { getPersistedStore } = setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      const result = await terminateHandler({ agentId: 'sm-3' }) as AgentHandlerResult & { terminatedAt?: string };
      const storedAgent = getPersistedStore().agents['sm-3'];

      expect(result.success).toBe(true);
      expect(result.terminated).toBe(true);
      expect(storedAgent.terminatedAt).toBeDefined();
      expect(result.terminatedAt).toBe(storedAgent.terminatedAt);
    });

    it('should allow busy -> terminated transition', async () => {
      const agent = makeAgent({ agentId: 'sm-4', status: 'busy' });
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      const result = await terminateHandler({ agentId: 'sm-4' });

      expect((result as AgentHandlerResult).success).toBe(true);
    });

    it('should reject terminated -> busy transition', async () => {
      const agent = makeAgent({ agentId: 'sm-5', status: 'terminated' });
      const { getPersistedStore } = setupStoreMocks(
        makeStore({ [agent.agentId]: agent }),
      );

      const result = await updateHandler({
        agentId: 'sm-5',
        status: 'busy',
      });

      // After RC-3 fix, this should either fail or leave status as terminated
      const store = getPersistedStore();
      const storedAgent = store.agents['sm-5'];

      // The agent's status should remain 'terminated' — the transition is invalid
      // If the update handler doesn't enforce state machine, the status will change
      // (indicating the RC-3 fix in agent_update is incomplete)
      if ((result as AgentHandlerResult).success === true && storedAgent?.status === 'busy') {
        // This means agent_update does NOT use transitionAgent() yet
        // Mark this as a known issue — the fix should make this test pass
        expect.soft(storedAgent.status).toBe('terminated');
      } else {
        expect(storedAgent?.status).toBe('terminated');
      }
    });

    it('should reject terminated -> idle transition', async () => {
      const agent = makeAgent({ agentId: 'sm-6', status: 'terminated' });
      const { getPersistedStore } = setupStoreMocks(
        makeStore({ [agent.agentId]: agent }),
      );

      const result = await updateHandler({
        agentId: 'sm-6',
        status: 'idle',
      });

      const store = getPersistedStore();
      const storedAgent = store.agents['sm-6'];

      // Same pattern: after RC-3 fix, terminated -> idle should be rejected
      if ((result as AgentHandlerResult).success === true && storedAgent?.status === 'idle') {
        expect.soft(storedAgent.status).toBe('terminated');
      } else {
        expect(storedAgent?.status).toBe('terminated');
      }
    });

    it('should allow spawning -> idle transition', async () => {
      const agent = makeAgent({ agentId: 'sm-7', status: 'spawning' });
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      const result = await updateHandler({
        agentId: 'sm-7',
        status: 'idle',
      });

      expect((result as AgentHandlerResult).success).toBe(true);
    });

    it('should reject spawning -> busy transition (must go idle first)', async () => {
      const agent = makeAgent({ agentId: 'sm-8', status: 'spawning' });
      const { getPersistedStore } = setupStoreMocks(
        makeStore({ [agent.agentId]: agent }),
      );

      const result = await updateHandler({
        agentId: 'sm-8',
        status: 'busy',
      });

      const store = getPersistedStore();
      const storedAgent = store.agents['sm-8'];

      // spawning -> busy is NOT in VALID_TRANSITIONS, should be rejected
      if ((result as AgentHandlerResult).success === true && storedAgent?.status === 'busy') {
        expect.soft(storedAgent.status).toBe('spawning');
      } else {
        expect(storedAgent?.status).toBe('spawning');
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 5. Concurrent status updates (RC-2)
  // ════════════════════════════════════════════════════════════════════════════
  describe('RC-2: Concurrent status updates', () => {
    it('should handle 10 parallel agent_update calls on different agents without lost updates', async () => {
      // Create 10 agents
      const agents: Record<string, AgentRecord> = {};
      for (let i = 0; i < 10; i++) {
        const agent = makeAgent({
          agentId: `update-${i}`,
          status: 'idle',
          health: 0.5,
          taskCount: 0,
        });
        agents[agent.agentId] = agent;
      }
      const { getPersistedStore } = setupStoreMocks(makeStore(agents));

      // Update all 10 agents concurrently — each gets different health/taskCount
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          updateHandler({
            agentId: `update-${i}`,
            health: 0.8 + i * 0.01,
            taskCount: i + 1,
          }),
        ),
      );

      // All updates should succeed
      for (const result of results) {
        expect((result as AgentHandlerResult).success).toBe(true);
      }

      // Verify store integrity — at minimum, the store should be valid JSON
      const store = getPersistedStore();
      expect(store.version).toBe('3.0.0');
      expect(typeof store.agents).toBe('object');

      // Check that at least some updates persisted correctly
      // (Without locking, concurrent read-modify-write can lose updates)
      let persistedCount = 0;
      for (let i = 0; i < 10; i++) {
        const a = store.agents[`update-${i}`];
        if (a && a.taskCount === i + 1) {
          persistedCount++;
        }
      }

      // With proper locking (RC-1/RC-5), all 10 should persist
      // Without locking, some may be lost due to read-modify-write races
      // We use soft assertion to document expected behavior after fix
      expect.soft(persistedCount).toBe(10);

      // At minimum, the store should not be corrupted
      expect(Object.keys(store.agents).length).toBeGreaterThanOrEqual(1);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 6. Store integrity after concurrent writes (RC-1/RC-5)
  // ════════════════════════════════════════════════════════════════════════════
  describe('RC-1/RC-5: Store integrity after concurrent mixed operations', () => {
    it('should maintain valid store after spawn + update + terminate concurrently', async () => {
      // Pre-populate with agents to update and terminate
      const agents: Record<string, AgentRecord> = {};
      for (let i = 0; i < 5; i++) {
        agents[`to-update-${i}`] = makeAgent({
          agentId: `to-update-${i}`,
          status: 'idle',
          health: 0.5,
        });
      }
      for (let i = 0; i < 5; i++) {
        agents[`to-term-${i}`] = makeAgent({
          agentId: `to-term-${i}`,
          status: 'idle',
        });
      }
      const { getPersistedStore } = setupStoreMocks(makeStore(agents));

      // Fire all three operation types concurrently
      const spawnPromises = Array.from({ length: 5 }, (_, i) =>
        spawnHandler({ agentType: 'tester', agentId: `fresh-${i}` }),
      );
      const updatePromises = Array.from({ length: 5 }, (_, i) =>
        updateHandler({
          agentId: `to-update-${i}`,
          health: 0.99,
          taskCount: 42,
        }),
      );
      const terminatePromises = Array.from({ length: 5 }, (_, i) =>
        terminateHandler({ agentId: `to-term-${i}` }),
      );

      await Promise.all([
        ...spawnPromises,
        ...updatePromises,
        ...terminatePromises,
      ]);

      // Verify store is valid JSON and not corrupted
      const store = getPersistedStore();
      expect(store).toBeDefined();
      expect(store.version).toBe('3.0.0');
      expect(typeof store.agents).toBe('object');

      // Store should not be null or have broken structure
      const agentIds = Object.keys(store.agents);
      expect(agentIds.length).toBeGreaterThan(0);

      // Count how many terminated agents retained their status.
      // Without store-level locking (RC-1/RC-5), concurrent mixed writes
      // may clobber terminate results. Once locking is implemented, all 5
      // should be terminated.
      let terminatedCount = 0;
      for (let i = 0; i < 5; i++) {
        const agent = store.agents[`to-term-${i}`];
        if (agent && agent.status === 'terminated') {
          terminatedCount++;
        }
      }
      expect(terminatedCount).toBe(5);

      // Verify each agent record has required fields (no partial writes)
      for (const [id, agent] of Object.entries(store.agents)) {
        expect(agent.agentId).toBe(id);
        expect(typeof agent.agentType).toBe('string');
        expect(typeof agent.status).toBe('string');
        expect(['spawning', 'idle', 'busy', 'terminated']).toContain(
          agent.status,
        );
        expect(typeof agent.health).toBe('number');
        expect(typeof agent.taskCount).toBe('number');
        expect(typeof agent.createdAt).toBe('string');
      }
    });
  });

  describe('agent_pool lifecycle timestamps', () => {
    it('sets terminatedAt when scaling idle agents down', async () => {
      const agents = {
        'pool-1': makeAgent({ agentId: 'pool-1', agentType: 'implementer', status: 'idle' }),
        'pool-2': makeAgent({ agentId: 'pool-2', agentType: 'implementer', status: 'idle' }),
        'pool-3': makeAgent({ agentId: 'pool-3', agentType: 'implementer', status: 'idle' }),
      };
      const { getPersistedStore } = setupStoreMocks(makeStore(agents));

      const result = await poolHandler({
        action: 'scale',
        agentType: 'implementer',
        targetSize: 1,
      }) as { removed?: string[] };

      expect(result.removed).toHaveLength(2);

      const store = getPersistedStore();
      for (const agentId of result.removed ?? []) {
        expect(store.agents[agentId].status).toBe('terminated');
        expect(store.agents[agentId].terminatedAt).toBeDefined();
      }
    });

    it('sets terminatedAt when draining idle agents', async () => {
      const agents = {
        'drain-1': makeAgent({ agentId: 'drain-1', agentType: 'implementer', status: 'idle' }),
        'drain-2': makeAgent({ agentId: 'drain-2', agentType: 'implementer', status: 'busy' }),
        'drain-3': makeAgent({ agentId: 'drain-3', agentType: 'implementer', status: 'idle' }),
      };
      const { getPersistedStore } = setupStoreMocks(makeStore(agents));

      const result = await poolHandler({
        action: 'drain',
        agentType: 'implementer',
      }) as { drained?: number };

      expect(result.drained).toBe(2);

      const store = getPersistedStore();
      expect(store.agents['drain-1'].terminatedAt).toBeDefined();
      expect(store.agents['drain-3'].terminatedAt).toBeDefined();
      expect(store.agents['drain-2'].terminatedAt).toBeUndefined();
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 7. Lock timeout / stale lock cleanup (RC-1/RC-5)
  // ════════════════════════════════════════════════════════════════════════════
  describe('RC-1/RC-5: Lock timeout and stale lock cleanup', () => {
    it('should succeed even when a stale .store.lock file exists', async () => {
      const { getPersistedStore } = setupStoreMocks(makeStore());

      // Simulate a stale lock file existing on disk
      (existsSync as ReturnType<typeof vi.fn>).mockImplementation(
        (p: string) => {
          if (typeof p === 'string' && p.endsWith('store.json')) return true;
          if (typeof p === 'string' && p.endsWith('.store.lock')) return true; // stale lock
          return false;
        },
      );

      // Operations should still complete (either by waiting or cleaning up stale lock)
      const result = await spawnHandler({
        agentType: 'implementer',
        agentId: 'lock-test-1',
      });

      // The spawn should succeed — stale lock should not block forever
      expect((result as AgentHandlerResult).success).toBe(true);
      expect((result as AgentHandlerResult).agentId).toBe('lock-test-1');
    });

    it('should handle sequential operations correctly after lock contention', async () => {
      setupStoreMocks(makeStore());

      // Rapid sequential spawns — each should see the previous write
      const results: any[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await spawnHandler({
          agentType: 'implementer',
          agentId: `seq-${i}`,
        });
        results.push(r);
      }

      // All should succeed
      for (const r of results) {
        expect(r.success).toBe(true);
      }

      // Verify all 5 are in the store
      const store = loadAgentStore();
      const seqIds = Object.keys(store.agents).filter((id) =>
        id.startsWith('seq-'),
      );

      // With proper locking, all 5 should be present
      // Without locking, earlier writes may be overwritten
      expect.soft(seqIds.length).toBe(5);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Additional: Rapid fire same-agent operations
  // ════════════════════════════════════════════════════════════════════════════
  describe('Rapid-fire operations on same agent', () => {
    it('acquires the store lock for agent_status reads', async () => {
      const agent = makeAgent({ agentId: 'read-locked', status: 'idle' });
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      await statusHandler({ agentId: 'read-locked' });

      expect((mkdirSync as ReturnType<typeof vi.fn>).mock.calls.some(
        ([path]: [string]) => typeof path === 'string' && path.endsWith('.store.lock'),
      )).toBe(true);
    });

    it('should handle concurrent reads (agent_status) without error', async () => {
      const agent = makeAgent({ agentId: 'read-target', status: 'idle' });
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      // 20 concurrent status reads on the same agent
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          statusHandler({ agentId: 'read-target' }),
        ),
      );

      // All reads should return the agent data
      for (const result of results) {
        expect((result as AgentHandlerResult).agentId).toBe('read-target');
        expect((result as AgentHandlerResult).status).toBe('idle');
      }
    });

    it('should handle concurrent list operations without error', async () => {
      const agents: Record<string, AgentRecord> = {};
      for (let i = 0; i < 10; i++) {
        const a = makeAgent({ agentId: `list-${i}`, status: 'idle' });
        agents[a.agentId] = a;
      }
      setupStoreMocks(makeStore(agents));

      // 10 concurrent list operations
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          listHandler({ includeTerminated: true }),
        ),
      );

      for (const result of results) {
        expect((result as AgentHandlerResult).total).toBeGreaterThanOrEqual(1);
        expect(Array.isArray((result as AgentHandlerResult).agents)).toBe(true);
      }
    });
  });
});
