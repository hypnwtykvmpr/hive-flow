import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CrashDetector } from '../../v3/@claude-flow/shared/src/core/orchestrator/crash-detector.js';
import type { RecoverableSession } from '../../v3/@claude-flow/shared/src/core/orchestrator/crash-detector.js';
import type { Checkpoint, CheckpointManager } from '../../v3/@claude-flow/shared/src/core/orchestrator/checkpoint-manager.js';
import type { IEventBus } from '../../v3/@claude-flow/shared/src/core/interfaces/event.interface.js';

describe('CrashDetector', () => {
  let mockEventBus: any;
  let mockCheckpointManager: any;
  let detector: CrashDetector;

  beforeEach(() => {
    mockEventBus = {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };

    mockCheckpointManager = {
      findIncompleteSessions: vi.fn(),
      markCompleted: vi.fn(),
      clearCheckpoints: vi.fn(),
      getLatestCheckpoint: vi.fn(),
      getAllCheckpoints: vi.fn(),
      createCheckpoint: vi.fn(),
    };

    detector = new CrashDetector(
      mockEventBus as unknown as IEventBus,
      mockCheckpointManager as unknown as CheckpointManager,
      { maxStaleMs: 1000 * 60 * 60 } // 1 hour for testing
    );
  });

  describe('detectCrashedSessions()', () => {
    it('happy path with active checkpoint, returns RecoverableSession', async () => {
      const now = Date.now();
      const timestamp = new Date(now - 5000).toISOString(); // 5 seconds ago

      const mockCheckpoint: Checkpoint = {
        id: 'ckpt_1',
        sessionId: 'session_1',
        timestamp,
        sequence: 1,
        agents: [
          { agentId: 'a1', agentType: 'coder', status: 'active', taskCount: 1, lastActivity: timestamp }
        ],
        tasks: [
          { taskId: 't1', status: 'pending' }
        ],
        memoryKeys: [],
        status: 'active',
        reason: 'task_boundary'
      };

      mockCheckpointManager.findIncompleteSessions.mockResolvedValue([
        { sessionId: 'session_1', checkpoint: mockCheckpoint }
      ]);

      const results = await detector.detectCrashedSessions();

      expect(results).toHaveLength(1);
      expect(results[0].sessionId).toBe('session_1');
      expect(results[0].pendingTaskCount).toBe(1);
      expect(results[0].activeAgents).toHaveLength(1);
      expect(results[0].activeAgents[0].agentId).toBe('a1');
      expect(results[0].staleDurationMs).toBeGreaterThanOrEqual(5000);
    });

    it('filters out sessions older than maxStaleMs and clears them', async () => {
      const now = Date.now();
      const oldTimestamp = new Date(now - (2 * 60 * 60 * 1000)).toISOString(); // 2 hours ago (max is 1h)
      const freshTimestamp = new Date(now - 5000).toISOString(); // 5 seconds ago

      mockCheckpointManager.findIncompleteSessions.mockResolvedValue([
        { 
          sessionId: 'old_session', 
          checkpoint: { 
            timestamp: oldTimestamp, 
            agents: [], 
            tasks: [], 
            status: 'active' 
          } as unknown as Checkpoint 
        },
        { 
          sessionId: 'fresh_session', 
          checkpoint: { 
            timestamp: freshTimestamp, 
            agents: [], 
            tasks: [], 
            status: 'active' 
          } as unknown as Checkpoint 
        }
      ]);

      const results = await detector.detectCrashedSessions();

      expect(results).toHaveLength(1);
      expect(results[0].sessionId).toBe('fresh_session');
      expect(mockCheckpointManager.clearCheckpoints).toHaveBeenCalledWith('old_session');
    });

    it('filters by agent status (active/idle only)', async () => {
      const now = Date.now();
      const timestamp = new Date(now - 5000).toISOString();

      mockCheckpointManager.findIncompleteSessions.mockResolvedValue([
        {
          sessionId: 's1',
          checkpoint: {
            timestamp,
            agents: [
              { agentId: 'a1', status: 'active', agentType: 't1' },
              { agentId: 'a2', status: 'idle', agentType: 't2' },
              { agentId: 'a3', status: 'completed', agentType: 't3' },
              { agentId: 'a4', status: 'failed', agentType: 't4' },
            ],
            tasks: [],
            status: 'active'
          } as unknown as Checkpoint
        }
      ]);

      const results = await detector.detectCrashedSessions();

      expect(results[0].activeAgents).toHaveLength(2);
      expect(results[0].activeAgents.map(a => a.agentId)).toContain('a1');
      expect(results[0].activeAgents.map(a => a.agentId)).toContain('a2');
    });

    it('counts only pending/in_progress tasks', async () => {
      const now = Date.now();
      const timestamp = new Date(now - 5000).toISOString();

      mockCheckpointManager.findIncompleteSessions.mockResolvedValue([
        {
          sessionId: 's1',
          checkpoint: {
            timestamp,
            agents: [],
            tasks: [
              { taskId: 't1', status: 'pending' },
              { taskId: 't2', status: 'in_progress' },
              { taskId: 't3', status: 'completed' },
              { taskId: 't4', status: 'failed' },
            ],
            status: 'active'
          } as unknown as Checkpoint
        }
      ]);

      const results = await detector.detectCrashedSessions();

      expect(results[0].pendingTaskCount).toBe(2);
    });

    it('sorts by most recent first (smallest staleDurationMs first)', async () => {
      const now = Date.now();
      const t1 = new Date(now - 10000).toISOString(); // 10s ago
      const t2 = new Date(now - 5000).toISOString();  // 5s ago
      const t3 = new Date(now - 20000).toISOString(); // 20s ago

      mockCheckpointManager.findIncompleteSessions.mockResolvedValue([
        { sessionId: 's1', checkpoint: { timestamp: t1, agents: [], tasks: [], status: 'active' } as unknown as Checkpoint },
        { sessionId: 's2', checkpoint: { timestamp: t2, agents: [], tasks: [], status: 'active' } as unknown as Checkpoint },
        { sessionId: 's3', checkpoint: { timestamp: t3, agents: [], tasks: [], status: 'active' } as unknown as Checkpoint },
      ]);

      const results = await detector.detectCrashedSessions();

      expect(results).toHaveLength(3);
      expect(results[0].sessionId).toBe('s2'); // 5s ago (most recent)
      expect(results[1].sessionId).toBe('s1'); // 10s ago
      expect(results[2].sessionId).toBe('s3'); // 20s ago
    });

    it('no incomplete sessions returns empty array', async () => {
      mockCheckpointManager.findIncompleteSessions.mockResolvedValue([]);

      const results = await detector.detectCrashedSessions();

      expect(results).toEqual([]);
    });
  });

  describe('markRecovered()', () => {
    it('delegates to checkpointManager.markCompleted', async () => {
      await detector.markRecovered('session_abc');
      expect(mockCheckpointManager.markCompleted).toHaveBeenCalledWith('session_abc');
    });
  });

  describe('dismiss()', () => {
    it('delegates to checkpointManager.clearCheckpoints', async () => {
      await detector.dismiss('session_xyz');
      expect(mockCheckpointManager.clearCheckpoints).toHaveBeenCalledWith('session_xyz');
    });
  });
});
