/**
 * Tests for CheckpointManager
 * Covers: createCheckpoint, markCompleted, getLatestCheckpoint,
 * getAllCheckpoints, findIncompleteSessions, clearCheckpoints, pruneCheckpoints
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CheckpointManager,
  type Checkpoint,
  type AgentCheckpointState,
  type TaskCheckpointState,
} from '../../v3/@claude-flow/shared/src/core/orchestrator/checkpoint-manager.js';

// Mock EventBus
function createMockEventBus() {
  return {
    emit: vi.fn(),
    emitAsync: vi.fn(),
    on: vi.fn(() => ({ unsubscribe: vi.fn() })),
    subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    once: vi.fn(() => ({ unsubscribe: vi.fn() })),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
    listenerCount: vi.fn(() => 0),
    eventNames: vi.fn(() => []),
  };
}

function createTestAgents(): AgentCheckpointState[] {
  return [
    { agentId: 'agent-1', agentType: 'coder', status: 'active', taskCount: 2, lastActivity: new Date().toISOString() },
    { agentId: 'agent-2', agentType: 'tester', status: 'idle', taskCount: 1, lastActivity: new Date().toISOString() },
  ];
}

function createTestTasks(): TaskCheckpointState[] {
  return [
    { taskId: 'task-1', status: 'completed', assignedTo: 'agent-1' },
    { taskId: 'task-2', status: 'in_progress', assignedTo: 'agent-2' },
    { taskId: 'task-3', status: 'pending' },
  ];
}

describe('CheckpointManager', () => {
  let tmpDir: string;
  let eventBus: ReturnType<typeof createMockEventBus>;
  let manager: CheckpointManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cf-ckpt-test-'));
    eventBus = createMockEventBus();
    manager = new CheckpointManager(eventBus as any, {
      dataDir: tmpDir,
      maxCheckpoints: 3,
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('createCheckpoint', () => {
    it('should create a checkpoint file on disk', async () => {
      const checkpoint = await manager.createCheckpoint(
        'session-1', createTestAgents(), createTestTasks(), ['key-1'], 'test-reason',
      );

      expect(checkpoint.sessionId).toBe('session-1');
      expect(checkpoint.sequence).toBe(1);
      expect(checkpoint.status).toBe('active');
      expect(checkpoint.reason).toBe('test-reason');
      expect(checkpoint.agents).toHaveLength(2);
      expect(checkpoint.tasks).toHaveLength(3);
      expect(checkpoint.memoryKeys).toEqual(['key-1']);
      expect(checkpoint.id).toMatch(/^ckpt_/);

      // Verify file exists on disk
      const sessionDir = join(tmpDir, 'checkpoints', 'session-1');
      const files = await readdir(sessionDir);
      expect(files).toContain('checkpoint-0001.json');
    });

    it('should increment sequence for each checkpoint', async () => {
      const c1 = await manager.createCheckpoint('session-1', [], [], [], 'first');
      const c2 = await manager.createCheckpoint('session-1', [], [], [], 'second');
      const c3 = await manager.createCheckpoint('session-1', [], [], [], 'third');

      expect(c1.sequence).toBe(1);
      expect(c2.sequence).toBe(2);
      expect(c3.sequence).toBe(3);
    });

    it('should emit SESSION_PERSISTED event', async () => {
      await manager.createCheckpoint('session-1', [], [], [], 'test');

      expect(eventBus.emit).toHaveBeenCalledWith(
        'session:persisted',
        expect.objectContaining({
          sessionCount: 1,
          path: expect.stringContaining('checkpoint-0001.json'),
        }),
      );
    });

    it('should include swarmId when provided', async () => {
      const checkpoint = await manager.createCheckpoint(
        'session-1', [], [], [], 'test', 'swarm-42',
      );
      expect(checkpoint.swarmId).toBe('swarm-42');
    });

    it('should prune old checkpoints beyond maxCheckpoints', async () => {
      // maxCheckpoints = 3, create 5
      await manager.createCheckpoint('session-1', [], [], [], 'c1');
      await manager.createCheckpoint('session-1', [], [], [], 'c2');
      await manager.createCheckpoint('session-1', [], [], [], 'c3');
      await manager.createCheckpoint('session-1', [], [], [], 'c4');
      await manager.createCheckpoint('session-1', [], [], [], 'c5');

      const sessionDir = join(tmpDir, 'checkpoints', 'session-1');
      const files = await readdir(sessionDir);
      const checkpointFiles = files.filter(f => f.startsWith('checkpoint-')).sort();

      // Should only keep the 3 most recent
      expect(checkpointFiles).toHaveLength(3);
      expect(checkpointFiles).toEqual([
        'checkpoint-0003.json',
        'checkpoint-0004.json',
        'checkpoint-0005.json',
      ]);
    });
  });

  describe('markCompleted', () => {
    it('should update latest checkpoint status to completed', async () => {
      await manager.createCheckpoint('session-1', [], [], [], 'test');
      await manager.markCompleted('session-1');

      const latest = await manager.getLatestCheckpoint('session-1');
      expect(latest?.status).toBe('completed');
    });

    it('should be a no-op when no checkpoints exist', async () => {
      // Should not throw
      await expect(manager.markCompleted('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('getLatestCheckpoint', () => {
    it('should return most recent checkpoint by filename sort', async () => {
      await manager.createCheckpoint('session-1', [], [], [], 'first');
      await manager.createCheckpoint('session-1', [], [], [], 'second');
      await manager.createCheckpoint('session-1', [], [], [], 'latest');

      const latest = await manager.getLatestCheckpoint('session-1');
      expect(latest?.reason).toBe('latest');
      expect(latest?.sequence).toBe(3);
    });

    it('should return null when session dir does not exist', async () => {
      const result = await manager.getLatestCheckpoint('nonexistent-session');
      expect(result).toBeNull();
    });

    it('should return null when session dir is empty', async () => {
      const sessionDir = join(tmpDir, 'checkpoints', 'empty-session');
      await mkdir(sessionDir, { recursive: true });

      const result = await manager.getLatestCheckpoint('empty-session');
      expect(result).toBeNull();
    });

    it('should handle corrupt JSON gracefully', async () => {
      const sessionDir = join(tmpDir, 'checkpoints', 'corrupt');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, 'checkpoint-0001.json'), 'not json');

      const result = await manager.getLatestCheckpoint('corrupt');
      expect(result).toBeNull();
    });
  });

  describe('getAllCheckpoints', () => {
    it('should return all checkpoints in sequence order', async () => {
      await manager.createCheckpoint('session-1', [], [], [], 'first');
      await manager.createCheckpoint('session-1', [], [], [], 'second');

      const all = await manager.getAllCheckpoints('session-1');
      expect(all).toHaveLength(2);
      expect(all[0].reason).toBe('first');
      expect(all[1].reason).toBe('second');
    });

    it('should return empty array when session dir does not exist', async () => {
      const result = await manager.getAllCheckpoints('nonexistent');
      expect(result).toEqual([]);
    });

    it('should skip corrupt checkpoint files', async () => {
      await manager.createCheckpoint('session-1', [], [], [], 'valid');
      const sessionDir = join(tmpDir, 'checkpoints', 'session-1');
      await writeFile(join(sessionDir, 'checkpoint-0002.json'), '{invalid');

      const all = await manager.getAllCheckpoints('session-1');
      expect(all).toHaveLength(1);
      expect(all[0].reason).toBe('valid');
    });
  });

  describe('findIncompleteSessions', () => {
    it('should find sessions with active checkpoints', async () => {
      await manager.createCheckpoint('session-active', createTestAgents(), createTestTasks(), [], 'test');

      const incomplete = await manager.findIncompleteSessions();
      expect(incomplete).toHaveLength(1);
      expect(incomplete[0].sessionId).toBe('session-active');
      expect(incomplete[0].checkpoint.status).toBe('active');
    });

    it('should ignore completed sessions', async () => {
      await manager.createCheckpoint('session-done', [], [], [], 'test');
      await manager.markCompleted('session-done');

      const incomplete = await manager.findIncompleteSessions();
      expect(incomplete).toHaveLength(0);
    });

    it('should return empty array when checkpoints dir does not exist', async () => {
      // Fresh manager with a nonexistent dataDir
      const freshManager = new CheckpointManager(eventBus as any, {
        dataDir: join(tmpDir, 'nonexistent'),
      });

      const result = await freshManager.findIncompleteSessions();
      expect(result).toEqual([]);
    });

    it('should skip non-directory entries', async () => {
      await manager.createCheckpoint('session-1', [], [], [], 'test');
      // Put a regular file in the checkpoints dir
      const checkpointsDir = join(tmpDir, 'checkpoints');
      await writeFile(join(checkpointsDir, 'notes.txt'), 'some notes');

      const incomplete = await manager.findIncompleteSessions();
      expect(incomplete).toHaveLength(1);
      expect(incomplete[0].sessionId).toBe('session-1');
    });
  });

  describe('clearCheckpoints', () => {
    it('should delete all files in session dir', async () => {
      await manager.createCheckpoint('session-1', [], [], [], 'c1');
      await manager.createCheckpoint('session-1', [], [], [], 'c2');

      await manager.clearCheckpoints('session-1');

      const sessionDir = join(tmpDir, 'checkpoints', 'session-1');
      const files = await readdir(sessionDir);
      expect(files).toHaveLength(0);
    });

    it('should not throw when session dir does not exist', async () => {
      await expect(manager.clearCheckpoints('nonexistent')).resolves.toBeUndefined();
    });
  });
});
