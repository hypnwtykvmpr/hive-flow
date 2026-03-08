/**
 * Hive-Mind Adaptive Topology Tests
 * Tests for adding 'adaptive' and 'hierarchical-mesh' topology support to the MCP hive-mind tools
 *
 * Covers:
 * - MCP tool schema validation (adaptive + hierarchical-mesh in topology enum)
 * - hive-mind_init handler with adaptive topology
 * - hive-mind_status reporting adaptive topology
 * - Worker operations (spawn, join, leave, broadcast) under adaptive topology
 * - Backward compatibility with all original topology values
 * - Edge cases: empty hive, switching topology under load, switching during active consensus
 * - CLI and MCP consistency (TOPOLOGIES array vs MCP enum)
 * - hierarchical-mesh topology support
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Constants matching the source module
const STORAGE_DIR = '.claude-flow';
const HIVE_DIR = 'hive-mind';
const HIVE_FILE = 'state.json';

// Use a temp directory for test isolation
const TEST_CWD = join(process.cwd(), '.test-hive-mind-adaptive');

function getHivePath(): string {
  return join(TEST_CWD, STORAGE_DIR, HIVE_DIR, HIVE_FILE);
}

function getAgentStorePath(): string {
  return join(TEST_CWD, STORAGE_DIR, 'agents', 'store.json');
}

function ensureTestDir(): void {
  const dir = join(TEST_CWD, STORAGE_DIR, HIVE_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function writeHiveState(state: Record<string, unknown>): void {
  ensureTestDir();
  writeFileSync(getHivePath(), JSON.stringify(state, null, 2), 'utf-8');
}

function readHiveState(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(getHivePath(), 'utf-8'));
  } catch {
    return {};
  }
}

function readAgentStore(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(getAgentStorePath(), 'utf-8'));
  } catch {
    return { agents: {} };
  }
}

function cleanTestDir(): void {
  try {
    rmSync(TEST_CWD, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// Helper type for tool lookup
type ToolMap = Record<string, { handler: (input: Record<string, unknown>) => Promise<unknown>; inputSchema: { properties: Record<string, unknown> } }>;

async function loadTools(): Promise<ToolMap> {
  const { hiveMindTools } = await import('../src/mcp-tools/hive-mind-tools.js');
  const map: ToolMap = {};
  for (const tool of hiveMindTools) {
    map[tool.name] = tool as unknown as ToolMap[string];
  }
  return map;
}

describe('Hive-Mind Adaptive Topology', () => {
  let tools: ToolMap;

  beforeEach(async () => {
    cleanTestDir();
    ensureTestDir();
    vi.spyOn(process, 'cwd').mockReturnValue(TEST_CWD);
    tools = await loadTools();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanTestDir();
  });

  // ─── MCP Tool Schema Validation ───────────────────────────────────────────

  describe('MCP Tool Schema Validation', () => {
    it('should include adaptive in the hive-mind_init topology enum', () => {
      const topologyProp = tools['hive-mind_init'].inputSchema.properties.topology as {
        type: string;
        enum: string[];
      };
      expect(topologyProp).toBeDefined();
      expect(topologyProp.enum).toContain('adaptive');
    });

    it('should include hierarchical-mesh in the hive-mind_init topology enum', () => {
      const topologyProp = tools['hive-mind_init'].inputSchema.properties.topology as {
        type: string;
        enum: string[];
      };
      expect(topologyProp.enum).toContain('hierarchical-mesh');
    });

    it('should preserve all original topology values', () => {
      const topologyProp = tools['hive-mind_init'].inputSchema.properties.topology as {
        type: string;
        enum: string[];
      };
      expect(topologyProp.enum).toContain('mesh');
      expect(topologyProp.enum).toContain('hierarchical');
      expect(topologyProp.enum).toContain('ring');
      expect(topologyProp.enum).toContain('star');
    });

    it('should have exactly 6 topology values in the enum', () => {
      const topologyProp = tools['hive-mind_init'].inputSchema.properties.topology as {
        type: string;
        enum: string[];
      };
      expect(topologyProp.enum).toHaveLength(6);
    });

    it('should define topology property as string type', () => {
      const topologyProp = tools['hive-mind_init'].inputSchema.properties.topology as {
        type: string;
        enum: string[];
      };
      expect(topologyProp.type).toBe('string');
    });
  });

  // ─── hive-mind_init with adaptive topology ────────────────────────────────

  describe('hive-mind_init with adaptive topology', () => {
    it('should successfully initialize with adaptive topology', async () => {
      const result = await tools['hive-mind_init'].handler({ topology: 'adaptive' }) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.topology).toBe('adaptive');
      expect(result.status).toBe('initialized');
    });

    it('should persist adaptive topology in state file', async () => {
      await tools['hive-mind_init'].handler({ topology: 'adaptive' });

      const state = readHiveState();
      expect(state.topology).toBe('adaptive');
      expect(state.initialized).toBe(true);
    });

    it('should set queen when initializing with adaptive topology', async () => {
      const result = await tools['hive-mind_init'].handler({
        topology: 'adaptive',
        queenId: 'adaptive-queen-1',
      }) as Record<string, unknown>;

      expect(result.queenId).toBe('adaptive-queen-1');

      const state = readHiveState();
      const queen = state.queen as { agentId: string };
      expect(queen.agentId).toBe('adaptive-queen-1');
    });

    it('should auto-generate queen ID if not provided', async () => {
      const result = await tools['hive-mind_init'].handler({
        topology: 'adaptive',
      }) as Record<string, unknown>;

      expect(result.queenId).toBeDefined();
      expect(typeof result.queenId).toBe('string');
      expect((result.queenId as string).startsWith('queen-')).toBe(true);
    });

    it('should return config with adaptive topology', async () => {
      const result = await tools['hive-mind_init'].handler({ topology: 'adaptive' }) as Record<string, unknown>;
      const config = result.config as Record<string, unknown>;

      expect(config.topology).toBe('adaptive');
      expect(config.consensus).toBe('byzantine');
      expect(config.maxAgents).toBe(15);
      expect(config.persist).toBe(true);
      expect(config.memoryBackend).toBe('hybrid');
    });

    it('should generate a unique hive ID', async () => {
      const result = await tools['hive-mind_init'].handler({ topology: 'adaptive' }) as Record<string, unknown>;

      expect(result.hiveId).toBeDefined();
      expect(typeof result.hiveId).toBe('string');
      expect((result.hiveId as string).startsWith('hive-')).toBe(true);
    });

    it('should record creation timestamp', async () => {
      const before = new Date().toISOString();
      const result = await tools['hive-mind_init'].handler({ topology: 'adaptive' }) as Record<string, unknown>;
      const after = new Date().toISOString();

      expect(result.createdAt).toBeDefined();
      expect(result.createdAt! >= before).toBe(true);
      expect(result.createdAt! <= after).toBe(true);
    });
  });

  // ─── hive-mind_init with hierarchical-mesh topology ───────────────────────

  describe('hive-mind_init with hierarchical-mesh topology', () => {
    it('should successfully initialize with hierarchical-mesh topology', async () => {
      const result = await tools['hive-mind_init'].handler({ topology: 'hierarchical-mesh' }) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.topology).toBe('hierarchical-mesh');
      expect(result.status).toBe('initialized');
    });

    it('should persist hierarchical-mesh topology in state file', async () => {
      await tools['hive-mind_init'].handler({ topology: 'hierarchical-mesh' });

      const state = readHiveState();
      expect(state.topology).toBe('hierarchical-mesh');
    });

    it('should support full lifecycle with hierarchical-mesh', async () => {
      // Init
      await tools['hive-mind_init'].handler({ topology: 'hierarchical-mesh' });

      // Spawn workers
      const spawn = await tools['hive-mind_spawn'].handler({ count: 3 }) as Record<string, unknown>;
      expect(spawn.success).toBe(true);

      // Check status
      const status = await tools['hive-mind_status'].handler({}) as Record<string, unknown>;
      expect(status.topology).toBe('hierarchical-mesh');
      expect(status.workerCount).toBe(3);

      // Shutdown
      const shutdown = await tools['hive-mind_shutdown'].handler({ force: true }) as Record<string, unknown>;
      expect(shutdown.success).toBe(true);
    });
  });

  // ─── hive-mind_status with adaptive topology ──────────────────────────────

  describe('hive-mind_status with adaptive topology', () => {
    it('should report adaptive topology in status', async () => {
      await tools['hive-mind_init'].handler({ topology: 'adaptive' });
      const status = await tools['hive-mind_status'].handler({}) as Record<string, unknown>;

      expect(status.topology).toBe('adaptive');
      expect(status.status).toBe('active');
      expect(status.initialized).toBe(true);
    });

    it('should report adaptive topology in verbose status', async () => {
      await tools['hive-mind_init'].handler({ topology: 'adaptive' });
      const status = await tools['hive-mind_status'].handler({ verbose: true }) as Record<string, unknown>;

      expect(status.topology).toBe('adaptive');
      expect(status.workerDetails).toBeDefined();
      expect(status.sharedMemory).toBeDefined();
    });

    it('should include health info for adaptive hive', async () => {
      await tools['hive-mind_init'].handler({ topology: 'adaptive' });
      const status = await tools['hive-mind_status'].handler({}) as Record<string, unknown>;

      const health = status.health as Record<string, string>;
      expect(health.overall).toBe('healthy');
      expect(health.queen).toBe('healthy');
      expect(health.consensus).toBe('healthy');
    });

    it('should report metrics for adaptive hive', async () => {
      await tools['hive-mind_init'].handler({ topology: 'adaptive' });
      const status = await tools['hive-mind_status'].handler({}) as Record<string, unknown>;

      const metrics = status.metrics as Record<string, unknown>;
      expect(metrics.totalTasks).toBeDefined();
      expect(metrics.completedTasks).toBeDefined();
      expect(metrics.consensusRounds).toBeDefined();
    });
  });

  // ─── Worker operations with adaptive topology ─────────────────────────────

  describe('Worker operations with adaptive topology', () => {
    beforeEach(async () => {
      await tools['hive-mind_init'].handler({ topology: 'adaptive' });
    });

    it('should spawn workers after adaptive init', async () => {
      const result = await tools['hive-mind_spawn'].handler({ count: 3 }) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.spawned).toBe(3);
      expect(result.totalWorkers).toBe(3);
      expect(result.hiveStatus).toBe('active');
    });

    it('should spawn specialist workers', async () => {
      const result = await tools['hive-mind_spawn'].handler({
        count: 2,
        role: 'specialist',
        agentType: 'security-architect',
        prefix: 'sec-worker',
      }) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.spawned).toBe(2);
      const workers = result.workers as Array<{ role: string }>;
      expect(workers[0].role).toBe('specialist');
    });

    it('should cap spawned workers at 20', async () => {
      const result = await tools['hive-mind_spawn'].handler({ count: 50 }) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.spawned).toBe(20);
    });

    it('should join agents to adaptive hive', async () => {
      const result = await tools['hive-mind_join'].handler({
        agentId: 'adaptive-agent-1',
        role: 'worker',
      }) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.agentId).toBe('adaptive-agent-1');
      expect(result.totalWorkers).toBe(1);
    });

    it('should not duplicate agent on re-join', async () => {
      await tools['hive-mind_join'].handler({ agentId: 'agent-dup' });
      await tools['hive-mind_join'].handler({ agentId: 'agent-dup' });

      const state = readHiveState();
      const workers = state.workers as Array<{ agentId: string }>;
      const dupCount = workers.filter(w => w.agentId === 'agent-dup').length;
      expect(dupCount).toBe(1);
    });

    it('should leave adaptive hive', async () => {
      await tools['hive-mind_join'].handler({ agentId: 'leaver-1' });
      const result = await tools['hive-mind_leave'].handler({ agentId: 'leaver-1' }) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.remainingWorkers).toBe(0);
    });

    it('should fail to leave if agent not in hive', async () => {
      const result = await tools['hive-mind_leave'].handler({ agentId: 'ghost-agent' }) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toContain('not in hive');
    });

    it('should broadcast in adaptive hive', async () => {
      await tools['hive-mind_spawn'].handler({ count: 3 });
      const result = await tools['hive-mind_broadcast'].handler({
        message: 'Test broadcast in adaptive mode',
        priority: 'high',
        fromId: 'queen-1',
      }) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.recipients).toBe(3);
      expect(result.priority).toBe('high');
    });

    it('should persist broadcast messages in shared memory', async () => {
      await tools['hive-mind_broadcast'].handler({
        message: 'Persisted broadcast',
        priority: 'normal',
      });

      const state = readHiveState();
      const sharedMem = state.sharedMemory as Record<string, unknown>;
      const broadcasts = sharedMem.broadcasts as Array<{ message: string }>;
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].message).toBe('Persisted broadcast');
    });

    it('should store agent records in agent store', async () => {
      await tools['hive-mind_spawn'].handler({ count: 2 });

      const store = readAgentStore();
      const agents = store.agents as Record<string, unknown>;
      expect(Object.keys(agents).length).toBe(2);
    });
  });

  // ─── Backward Compatibility ───────────────────────────────────────────────

  describe('Backward Compatibility', () => {
    const ORIGINAL_TOPOLOGIES = ['mesh', 'hierarchical', 'ring', 'star'];

    for (const topo of ORIGINAL_TOPOLOGIES) {
      it(`should still initialize with ${topo} topology`, async () => {
        const result = await tools['hive-mind_init'].handler({ topology: topo }) as Record<string, unknown>;

        expect(result.success).toBe(true);
        expect(result.topology).toBe(topo);
      });

      it(`should persist ${topo} topology correctly`, async () => {
        await tools['hive-mind_init'].handler({ topology: topo });

        const state = readHiveState();
        expect(state.topology).toBe(topo);
      });
    }

    it('should default to mesh when no topology specified', async () => {
      const result = await tools['hive-mind_init'].handler({}) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.topology).toBe('mesh');
    });

    it('should default to mesh with empty input object', async () => {
      const result = await tools['hive-mind_init'].handler({}) as Record<string, unknown>;

      expect(result.topology).toBe('mesh');
      const config = result.config as Record<string, unknown>;
      expect(config.topology).toBe('mesh');
    });
  });

  // ─── Edge Cases ───────────────────────────────────────────────────────────

  describe('Edge Cases', () => {
    it('should handle re-initialization switching from mesh to adaptive', async () => {
      await tools['hive-mind_init'].handler({ topology: 'mesh' });
      let state = readHiveState();
      expect(state.topology).toBe('mesh');

      await tools['hive-mind_init'].handler({ topology: 'adaptive' });
      state = readHiveState();
      expect(state.topology).toBe('adaptive');
    });

    it('should handle re-initialization switching from adaptive to mesh', async () => {
      await tools['hive-mind_init'].handler({ topology: 'adaptive' });
      await tools['hive-mind_init'].handler({ topology: 'mesh' });

      const state = readHiveState();
      expect(state.topology).toBe('mesh');
    });

    it('should handle topology switching under load (workers active)', async () => {
      // Init with mesh and spawn workers
      await tools['hive-mind_init'].handler({ topology: 'mesh' });
      await tools['hive-mind_spawn'].handler({ count: 5 });

      let status = await tools['hive-mind_status'].handler({}) as Record<string, unknown>;
      expect(status.topology).toBe('mesh');
      expect(status.workerCount).toBe(5);

      // Re-init with adaptive (workers from previous state are in the file)
      await tools['hive-mind_init'].handler({ topology: 'adaptive' });

      status = await tools['hive-mind_status'].handler({}) as Record<string, unknown>;
      expect(status.topology).toBe('adaptive');
      // Workers from previous init persist in the state file since init doesn't clear them
      expect(status.initialized).toBe(true);
    });

    it('should handle topology switching during active consensus', async () => {
      // Init with hierarchical and create a pending consensus proposal
      await tools['hive-mind_init'].handler({ topology: 'hierarchical' });
      await tools['hive-mind_join'].handler({ agentId: 'voter-a' });
      await tools['hive-mind_join'].handler({ agentId: 'voter-b' });
      await tools['hive-mind_join'].handler({ agentId: 'voter-c' });

      // Create a pending proposal
      const proposal = await tools['hive-mind_consensus'].handler({
        action: 'propose',
        type: 'task-assignment',
        value: { task: 'implement feature X' },
        voterId: 'voter-a',
      }) as Record<string, unknown>;

      expect(proposal.status).toBe('pending');
      const proposalId = proposal.proposalId as string;

      // Cast one vote (not enough for majority)
      await tools['hive-mind_consensus'].handler({
        action: 'vote',
        proposalId,
        voterId: 'voter-b',
        vote: true,
      });

      // Now switch topology to adaptive while consensus is pending
      await tools['hive-mind_init'].handler({ topology: 'adaptive' });

      // Verify topology changed
      const state = readHiveState();
      expect(state.topology).toBe('adaptive');

      // Verify pending consensus from prior topology still exists in state
      const consensus = state.consensus as { pending: Array<{ proposalId: string; status: string }> };
      const pendingProposal = consensus.pending.find(
        (p: { proposalId: string }) => p.proposalId === proposalId
      );
      expect(pendingProposal).toBeDefined();
      expect(pendingProposal!.status).toBe('pending');
    });

    it('should handle empty hive status', async () => {
      // Status without any initialization
      const status = await tools['hive-mind_status'].handler({}) as Record<string, unknown>;

      expect(status.status).toBe('offline');
      expect(status.initialized).toBe(false);
      expect(status.workerCount).toBe(0);
    });

    it('should handle empty hive operations (spawn without init)', async () => {
      const result = await tools['hive-mind_spawn'].handler({ count: 3 }) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toContain('not initialized');
    });

    it('should handle empty hive operations (join without init)', async () => {
      const result = await tools['hive-mind_join'].handler({ agentId: 'lonely-agent' }) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toContain('not initialized');
    });

    it('should handle empty hive operations (broadcast without init)', async () => {
      const result = await tools['hive-mind_broadcast'].handler({ message: 'hello' }) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toContain('not initialized');
    });

    it('should handle empty hive operations (shutdown without init)', async () => {
      const result = await tools['hive-mind_shutdown'].handler({}) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toContain('not initialized');
    });

    it('should handle adaptive shutdown gracefully with workers', async () => {
      await tools['hive-mind_init'].handler({ topology: 'adaptive' });
      await tools['hive-mind_spawn'].handler({ count: 4 });

      const result = await tools['hive-mind_shutdown'].handler({ graceful: true, force: true }) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.workersTerminated).toBe(4);

      const state = readHiveState();
      expect(state.initialized).toBe(false);
      const workers = state.workers as string[];
      expect(workers).toHaveLength(0);
    });

    it('should block graceful shutdown with pending consensus (no force)', async () => {
      await tools['hive-mind_init'].handler({ topology: 'adaptive' });
      await tools['hive-mind_join'].handler({ agentId: 'w1' });

      // Create a pending proposal
      await tools['hive-mind_consensus'].handler({
        action: 'propose',
        type: 'general',
        value: 'test',
        voterId: 'w1',
      });

      // Try graceful shutdown without force
      const result = await tools['hive-mind_shutdown'].handler({ graceful: true }) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toContain('pending consensus');
    });

    it('should handle consensus proposals in adaptive topology', async () => {
      await tools['hive-mind_init'].handler({ topology: 'adaptive' });
      await tools['hive-mind_join'].handler({ agentId: 'voter-1' });
      await tools['hive-mind_join'].handler({ agentId: 'voter-2' });

      const proposal = await tools['hive-mind_consensus'].handler({
        action: 'propose',
        type: 'topology-switch',
        value: { targetTopology: 'mesh' },
        voterId: 'voter-1',
      }) as Record<string, unknown>;

      expect(proposal.proposalId).toBeDefined();
      expect(proposal.status).toBe('pending');
    });

    it('should handle consensus voting to approval in adaptive topology', async () => {
      await tools['hive-mind_init'].handler({ topology: 'adaptive' });
      await tools['hive-mind_join'].handler({ agentId: 'v1' });
      await tools['hive-mind_join'].handler({ agentId: 'v2' });
      await tools['hive-mind_join'].handler({ agentId: 'v3' });

      // Propose
      const proposal = await tools['hive-mind_consensus'].handler({
        action: 'propose',
        type: 'general',
        value: 'approve this',
        voterId: 'v1',
      }) as Record<string, unknown>;
      const proposalId = proposal.proposalId as string;

      // Vote: 2 out of 3 needed (majority = ceil(3/2) + 1 = 3)
      // Actually majority = ceil(3/2) + 1 = 3, so we need all 3 votes
      await tools['hive-mind_consensus'].handler({
        action: 'vote', proposalId, voterId: 'v1', vote: true,
      });
      await tools['hive-mind_consensus'].handler({
        action: 'vote', proposalId, voterId: 'v2', vote: true,
      });
      const finalVote = await tools['hive-mind_consensus'].handler({
        action: 'vote', proposalId, voterId: 'v3', vote: true,
      }) as Record<string, unknown>;

      expect(finalVote.status).toBe('approved');
    });

    it('should handle shared memory in adaptive topology', async () => {
      await tools['hive-mind_init'].handler({ topology: 'adaptive' });

      // Store
      await tools['hive-mind_memory'].handler({
        action: 'set',
        key: 'adaptive-config',
        value: { mode: 'dynamic', threshold: 0.75 },
      });

      // Retrieve
      const result = await tools['hive-mind_memory'].handler({
        action: 'get',
        key: 'adaptive-config',
      }) as Record<string, unknown>;

      expect(result.exists).toBe(true);
      const value = result.value as { mode: string; threshold: number };
      expect(value.mode).toBe('dynamic');
      expect(value.threshold).toBe(0.75);
    });

    it('should handle memory list in adaptive topology', async () => {
      await tools['hive-mind_init'].handler({ topology: 'adaptive' });

      await tools['hive-mind_memory'].handler({ action: 'set', key: 'key1', value: 'val1' });
      await tools['hive-mind_memory'].handler({ action: 'set', key: 'key2', value: 'val2' });

      const result = await tools['hive-mind_memory'].handler({ action: 'list' }) as Record<string, unknown>;
      expect(result.count).toBe(2);
      expect(result.keys).toContain('key1');
      expect(result.keys).toContain('key2');
    });

    it('should handle memory delete in adaptive topology', async () => {
      await tools['hive-mind_init'].handler({ topology: 'adaptive' });

      await tools['hive-mind_memory'].handler({ action: 'set', key: 'to-delete', value: 'gone' });
      const delResult = await tools['hive-mind_memory'].handler({ action: 'delete', key: 'to-delete' }) as Record<string, unknown>;
      expect(delResult.deleted).toBe(true);

      const getResult = await tools['hive-mind_memory'].handler({ action: 'get', key: 'to-delete' }) as Record<string, unknown>;
      expect(getResult.exists).toBe(false);
    });

    it('should handle corrupted state file gracefully', async () => {
      // Write invalid JSON to state file
      ensureTestDir();
      writeFileSync(getHivePath(), 'not valid json!!!', 'utf-8');

      // loadHiveState should return default state, not throw
      const result = await tools['hive-mind_init'].handler({ topology: 'adaptive' }) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.topology).toBe('adaptive');
    });

    it('should handle no state file (fresh start)', async () => {
      // Remove the hive state file if it exists
      try { rmSync(getHivePath()); } catch { /* ignore */ }

      const result = await tools['hive-mind_init'].handler({ topology: 'adaptive' }) as Record<string, unknown>;
      expect(result.success).toBe(true);
    });
  });

  // ─── Topology Switching Real-World Scenarios ──────────────────────────────

  describe('Topology Switching Real-World Scenarios', () => {
    it('should switch from star to adaptive and continue operations', async () => {
      // Start with star topology
      await tools['hive-mind_init'].handler({ topology: 'star' });
      await tools['hive-mind_spawn'].handler({ count: 3 });
      await tools['hive-mind_broadcast'].handler({ message: 'initial broadcast' });

      // Switch to adaptive
      await tools['hive-mind_init'].handler({ topology: 'adaptive' });

      // Continue operations
      const joinResult = await tools['hive-mind_join'].handler({ agentId: 'new-agent' }) as Record<string, unknown>;
      expect(joinResult.success).toBe(true);

      const broadcastResult = await tools['hive-mind_broadcast'].handler({ message: 'post-switch' }) as Record<string, unknown>;
      expect(broadcastResult.success).toBe(true);

      const status = await tools['hive-mind_status'].handler({}) as Record<string, unknown>;
      expect(status.topology).toBe('adaptive');
    });

    it('should cycle through all topologies without errors', async () => {
      const ALL_TOPOLOGIES = ['mesh', 'hierarchical', 'ring', 'star', 'adaptive', 'hierarchical-mesh'];

      for (const topo of ALL_TOPOLOGIES) {
        const result = await tools['hive-mind_init'].handler({ topology: topo }) as Record<string, unknown>;
        expect(result.success).toBe(true);
        expect(result.topology).toBe(topo);

        const status = await tools['hive-mind_status'].handler({}) as Record<string, unknown>;
        expect(status.topology).toBe(topo);
      }
    });

    it('should handle rapid init-shutdown cycles with adaptive', async () => {
      for (let i = 0; i < 5; i++) {
        await tools['hive-mind_init'].handler({ topology: 'adaptive' });
        await tools['hive-mind_spawn'].handler({ count: 2 });
        await tools['hive-mind_shutdown'].handler({ force: true });
      }

      // Final state should be shut down
      const state = readHiveState();
      expect(state.initialized).toBe(false);
    });

    it('should handle mixed operations under adaptive with many workers', async () => {
      await tools['hive-mind_init'].handler({ topology: 'adaptive' });

      // Spawn many workers
      await tools['hive-mind_spawn'].handler({ count: 10 });

      // Join more
      await tools['hive-mind_join'].handler({ agentId: 'manual-1' });
      await tools['hive-mind_join'].handler({ agentId: 'manual-2' });

      // Store shared memory
      await tools['hive-mind_memory'].handler({
        action: 'set', key: 'plan', value: { phase: 'execution' },
      });

      // Propose consensus
      await tools['hive-mind_consensus'].handler({
        action: 'propose',
        type: 'scaling',
        value: { addWorkers: 5 },
        voterId: 'manual-1',
      });

      // Leave one
      await tools['hive-mind_leave'].handler({ agentId: 'manual-2' });

      // Check final status
      const status = await tools['hive-mind_status'].handler({ verbose: true }) as Record<string, unknown>;
      expect(status.topology).toBe('adaptive');
      expect(status.workerCount).toBe(11); // 10 spawned + 1 manual (minus 1 left)
      expect(status.pendingConsensus).toBe(1);
      expect(status.sharedMemoryKeys).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── CLI and MCP Consistency ──────────────────────────────────────────────

  describe('CLI and MCP Consistency', () => {
    it('should include adaptive in MCP schema matching CLI TOPOLOGIES', () => {
      // CLI defines: hierarchical, mesh, hierarchical-mesh, adaptive
      const topologyProp = tools['hive-mind_init'].inputSchema.properties.topology as {
        enum: string[];
      };

      // Both CLI and MCP must support adaptive
      expect(topologyProp.enum).toContain('adaptive');
    });

    it('should include hierarchical-mesh in MCP schema matching CLI TOPOLOGIES', () => {
      const topologyProp = tools['hive-mind_init'].inputSchema.properties.topology as {
        enum: string[];
      };

      // Both CLI and MCP must support hierarchical-mesh
      expect(topologyProp.enum).toContain('hierarchical-mesh');
    });

    it('should include all CLI topology values in MCP enum', () => {
      // CLI TOPOLOGIES array values
      const cliTopologies = ['hierarchical', 'mesh', 'hierarchical-mesh', 'adaptive'];
      const topologyProp = tools['hive-mind_init'].inputSchema.properties.topology as {
        enum: string[];
      };

      for (const cliTopo of cliTopologies) {
        expect(topologyProp.enum).toContain(cliTopo);
      }
    });

    it('should handle the CLI default topology (hierarchical-mesh) in MCP', async () => {
      // CLI defaults to hierarchical-mesh for init
      const result = await tools['hive-mind_init'].handler({ topology: 'hierarchical-mesh' }) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.topology).toBe('hierarchical-mesh');
    });

    it('should handle the MCP default topology (mesh) correctly', async () => {
      // MCP handler defaults to mesh when no topology provided
      const result = await tools['hive-mind_init'].handler({}) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.topology).toBe('mesh');
    });

    it('should expose all 9 hive-mind tools', async () => {
      const { hiveMindTools } = await import('../src/mcp-tools/hive-mind-tools.js');
      const toolNames = hiveMindTools.map(t => t.name);

      expect(toolNames).toContain('hive-mind_init');
      expect(toolNames).toContain('hive-mind_status');
      expect(toolNames).toContain('hive-mind_spawn');
      expect(toolNames).toContain('hive-mind_join');
      expect(toolNames).toContain('hive-mind_leave');
      expect(toolNames).toContain('hive-mind_consensus');
      expect(toolNames).toContain('hive-mind_broadcast');
      expect(toolNames).toContain('hive-mind_shutdown');
      expect(toolNames).toContain('hive-mind_memory');
    });
  });
});
