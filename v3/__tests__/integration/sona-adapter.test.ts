/**
 * SONAAdapter Test Suite
 *
 * Comprehensive tests for the SONA learning adapter.
 * Tests trajectory tracking, pattern storage, and learning modes.
 *
 * @module v3/__tests__/integration/sona-adapter.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SONAAdapter,
  createSONAAdapter,
} from '../../integration/sona-adapter.js';
import type { SONAConfiguration, SONALearningMode } from '../../integration/types.js';

describe('SONAAdapter', () => {
  let adapter: SONAAdapter;

  beforeEach(async () => {
    adapter = new SONAAdapter();
    await adapter.initialize();
  });

  afterEach(async () => {
    if (adapter) {
      await adapter.shutdown();
    }
  });

  describe('initialization', () => {
    it('should initialize with default configuration', async () => {
      const newAdapter = new SONAAdapter();
      await newAdapter.initialize();

      expect(newAdapter.getMode()).toBe('balanced');

      await newAdapter.shutdown();
    });

    it('should initialize with custom configuration', async () => {
      const newAdapter = new SONAAdapter({
        mode: 'real-time',
        learningRate: 0.01,
        maxPatterns: 5000,
      });
      await newAdapter.initialize();

      expect(newAdapter.getMode()).toBe('real-time');

      await newAdapter.shutdown();
    });

    it('should emit initialized event', async () => {
      const newAdapter = new SONAAdapter();
      const handler = vi.fn();
      newAdapter.on('initialized', handler);

      await newAdapter.initialize();

      expect(handler).toHaveBeenCalledWith({ mode: 'balanced' });

      await newAdapter.shutdown();
    });
  });

  describe('learning modes', () => {
    const modes: SONALearningMode[] = [
      'real-time',
      'balanced',
      'research',
      'edge',
      'batch',
    ];

    it.each(modes)('should switch to %s mode', async (mode) => {
      await adapter.setMode(mode);
      expect(adapter.getMode()).toBe(mode);
    });

    it('should emit mode-changed event', async () => {
      const handler = vi.fn();
      adapter.on('mode-changed', handler);

      await adapter.setMode('research');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          previousMode: 'balanced',
          newMode: 'research',
        })
      );
    });

    it('should apply mode-specific configuration', async () => {
      await adapter.setMode('edge');

      const stats = await adapter.getStats();
      expect(stats.currentMode).toBe('edge');
    });
  });

  describe('trajectory tracking', () => {
    it('should begin a new trajectory', async () => {
      const trajectoryId = await adapter.beginTrajectory({
        taskId: 'test-task-1',
        description: 'Test trajectory',
        category: 'testing',
      });

      expect(trajectoryId).toMatch(/^traj_/);
    });

    it('should record trajectory steps', async () => {
      const trajectoryId = await adapter.beginTrajectory({
        taskId: 'test-task-1',
      });

      await adapter.recordTrajectoryStep({
        trajectoryId,
        action: 'Action 1',
        observation: 'Observation 1',
        reward: 0.5,
      });

      await adapter.recordTrajectoryStep({
        trajectoryId,
        action: 'Action 2',
        observation: 'Observation 2',
        reward: 0.8,
      });

      const trajectory = await adapter.endTrajectory({
        trajectoryId,
        success: true,
      });

      expect(trajectory.steps).toHaveLength(2);
      expect(trajectory.totalReward).toBe(1.3);
    });

    it('should end trajectory with verdict', async () => {
      const trajectoryId = await adapter.beginTrajectory({
        taskId: 'test-task-1',
      });

      const trajectory = await adapter.endTrajectory({
        trajectoryId,
        success: true,
        verdict: 'positive',
        reward: 1.0,
      });

      expect(trajectory.verdict).toBe('positive');
      expect(trajectory.endTime).toBeDefined();
    });

    it('should throw for non-existent trajectory', async () => {
      await expect(
        adapter.recordTrajectoryStep({
          trajectoryId: 'non-existent',
          action: 'test',
          observation: 'test',
          reward: 0,
        })
      ).rejects.toThrow('not found');
    });

    it('should emit trajectory events', async () => {
      const startHandler = vi.fn();
      const stepHandler = vi.fn();
      const completeHandler = vi.fn();

      adapter.on('trajectory-started', startHandler);
      adapter.on('trajectory-step-recorded', stepHandler);
      adapter.on('trajectory-completed', completeHandler);

      const trajectoryId = await adapter.beginTrajectory({
        taskId: 'test-task-1',
      });

      await adapter.recordTrajectoryStep({
        trajectoryId,
        action: 'Action',
        observation: 'Observation',
        reward: 0.5,
      });

      await adapter.endTrajectory({
        trajectoryId,
        success: true,
      });

      expect(startHandler).toHaveBeenCalled();
      expect(stepHandler).toHaveBeenCalled();
      expect(completeHandler).toHaveBeenCalled();
    });

    it('should update stats for active trajectories', async () => {
      const id1 = await adapter.beginTrajectory({ taskId: 'task-1' });
      const id2 = await adapter.beginTrajectory({ taskId: 'task-2' });

      const stats = await adapter.getStats();
      expect(stats.activeTrajectories).toBe(2);

      await adapter.endTrajectory({ trajectoryId: id1, success: true });

      const updatedStats = await adapter.getStats();
      expect(updatedStats.activeTrajectories).toBe(1);
      expect(updatedStats.completedTrajectories).toBe(1);

      await adapter.endTrajectory({ trajectoryId: id2, success: false });
    });
  });

  describe('pattern storage', () => {
    it('should store a pattern', async () => {
      const patternId = await adapter.storePattern({
        pattern: 'Test pattern',
        solution: 'Test solution',
        category: 'testing',
        confidence: 0.9,
      });

      expect(patternId).toMatch(/^pat_/);
    });

    it('should retrieve stored pattern', async () => {
      const patternId = await adapter.storePattern({
        pattern: 'Test pattern',
        solution: 'Test solution',
        category: 'testing',
        confidence: 0.9,
      });

      const pattern = await adapter.getPattern(patternId);

      expect(pattern).toBeDefined();
      expect(pattern!.pattern).toBe('Test pattern');
      expect(pattern!.solution).toBe('Test solution');
      expect(pattern!.confidence).toBe(0.9);
    });

    it('should return null for non-existent pattern', async () => {
      const pattern = await adapter.getPattern('non-existent');
      expect(pattern).toBeNull();
    });

    it('should delete pattern', async () => {
      const patternId = await adapter.storePattern({
        pattern: 'Test pattern',
        solution: 'Test solution',
        category: 'testing',
        confidence: 0.9,
      });

      const deleted = await adapter.deletePattern(patternId);
      expect(deleted).toBe(true);

      const pattern = await adapter.getPattern(patternId);
      expect(pattern).toBeNull();
    });

    it('should clamp confidence to valid range', async () => {
      const patternId = await adapter.storePattern({
        pattern: 'Test pattern',
        solution: 'Test solution',
        category: 'testing',
        confidence: 1.5, // Should be clamped to 1.0
      });

      const pattern = await adapter.getPattern(patternId);
      expect(pattern!.confidence).toBe(1.0);
    });
  });

  describe('pattern search', () => {
    beforeEach(async () => {
      // Store some test patterns
      await adapter.storePattern({
        pattern: 'authentication login user',
        solution: 'Use JWT tokens',
        category: 'security',
        confidence: 0.9,
      });

      await adapter.storePattern({
        pattern: 'authentication oauth provider',
        solution: 'Use OAuth 2.0',
        category: 'security',
        confidence: 0.85,
      });

      await adapter.storePattern({
        pattern: 'database query optimization',
        solution: 'Add indexes',
        category: 'performance',
        confidence: 0.95,
      });
    });

    it('should find similar patterns', async () => {
      const results = await adapter.findSimilarPatterns({
        query: 'authentication user login',
        topK: 5,
      });

      expect(results.length).toBeGreaterThan(0);
    });

    it('should filter by category', async () => {
      const results = await adapter.findSimilarPatterns({
        query: 'authentication',
        category: 'security',
        topK: 10,
      });

      for (const pattern of results) {
        expect(pattern.category).toBe('security');
      }
    });

    it('should respect topK limit', async () => {
      const results = await adapter.findSimilarPatterns({
        query: 'authentication',
        topK: 1,
      });

      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('should update usage count on retrieval', async () => {
      const patternId = await adapter.storePattern({
        pattern: 'test usage tracking',
        solution: 'test solution',
        category: 'testing',
        confidence: 0.9,
      });

      // Search for the pattern
      await adapter.findSimilarPatterns({
        query: 'test usage tracking',
        topK: 5,
      });

      const pattern = await adapter.getPattern(patternId);
      expect(pattern!.usageCount).toBeGreaterThan(0);
    });
  });

  describe('learning cycle', () => {
    it('should force learning cycle', async () => {
      const handler = vi.fn();
      adapter.on('learning-cycle-completed', handler);

      await adapter.forceLearningCycle();

      expect(handler).toHaveBeenCalled();
    });

    it('should update stats after learning cycle', async () => {
      const statsBefore = await adapter.getStats();

      await adapter.forceLearningCycle();

      const statsAfter = await adapter.getStats();
      expect(statsAfter.learningCycles).toBe(statsBefore.learningCycles + 1);
    });
  });

  describe('pattern import/export', () => {
    it('should export patterns', async () => {
      await adapter.storePattern({
        pattern: 'Export test 1',
        solution: 'Solution 1',
        category: 'testing',
        confidence: 0.9,
      });

      await adapter.storePattern({
        pattern: 'Export test 2',
        solution: 'Solution 2',
        category: 'testing',
        confidence: 0.8,
      });

      const exported = await adapter.exportPatterns();

      expect(exported.length).toBeGreaterThanOrEqual(2);
    });

    it('should import patterns', async () => {
      const patterns = [
        {
          id: 'import-1',
          pattern: 'Import test 1',
          solution: 'Solution 1',
          category: 'testing',
          confidence: 0.9,
          usageCount: 5,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          metadata: {},
        },
        {
          id: 'import-2',
          pattern: 'Import test 2',
          solution: 'Solution 2',
          category: 'testing',
          confidence: 0.8,
          usageCount: 3,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          metadata: {},
        },
      ];

      const imported = await adapter.importPatterns(patterns);
      expect(imported).toBe(2);

      const pattern = await adapter.getPattern('import-1');
      expect(pattern).toBeDefined();
    });

    it('should not import duplicate patterns', async () => {
      const patterns = [
        {
          id: 'unique-id',
          pattern: 'Test',
          solution: 'Solution',
          category: 'testing',
          confidence: 0.9,
          usageCount: 0,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          metadata: {},
        },
      ];

      const firstImport = await adapter.importPatterns(patterns);
      const secondImport = await adapter.importPatterns(patterns);

      expect(firstImport).toBe(1);
      expect(secondImport).toBe(0);
    });
  });

  describe('statistics', () => {
    it('should return learning statistics', async () => {
      const stats = await adapter.getStats();

      expect(stats).toHaveProperty('totalPatterns');
      expect(stats).toHaveProperty('activeTrajectories');
      expect(stats).toHaveProperty('completedTrajectories');
      expect(stats).toHaveProperty('averageConfidence');
      expect(stats).toHaveProperty('learningCycles');
      expect(stats).toHaveProperty('lastConsolidation');
      expect(stats).toHaveProperty('memoryUsage');
      expect(stats).toHaveProperty('currentMode');
    });

    it('should track average confidence', async () => {
      await adapter.storePattern({
        pattern: 'P1',
        solution: 'S1',
        category: 'test',
        confidence: 0.8,
      });

      await adapter.storePattern({
        pattern: 'P2',
        solution: 'S2',
        category: 'test',
        confidence: 0.6,
      });

      const stats = await adapter.getStats();
      expect(stats.averageConfidence).toBeCloseTo(0.7, 1);
    });
  });

  describe('factory function', () => {
    it('should create initialized adapter', async () => {
      const newAdapter = await createSONAAdapter({
        mode: 'research',
      });

      expect(newAdapter.getMode()).toBe('research');

      await newAdapter.shutdown();
    });
  });

  describe('shutdown', () => {
    it('should complete active trajectories on shutdown', async () => {
      const id = await adapter.beginTrajectory({ taskId: 'test' });

      await adapter.shutdown();

      // Adapter should be in a clean state
      const newAdapter = new SONAAdapter();
      await newAdapter.initialize();

      const stats = await newAdapter.getStats();
      expect(stats.activeTrajectories).toBe(0);

      await newAdapter.shutdown();
    });
  });
});
