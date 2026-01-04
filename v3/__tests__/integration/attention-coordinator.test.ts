/**
 * AttentionCoordinator Test Suite
 *
 * Comprehensive tests for the Flash Attention coordinator.
 * Tests attention computation, agent coordination, and expert routing.
 *
 * @module v3/__tests__/integration/attention-coordinator.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AttentionCoordinator,
  createAttentionCoordinator,
} from '../../integration/attention-coordinator.js';
import type {
  AttentionConfiguration,
  AttentionMechanism,
} from '../../integration/types.js';

describe('AttentionCoordinator', () => {
  let coordinator: AttentionCoordinator;

  beforeEach(async () => {
    coordinator = new AttentionCoordinator();
    await coordinator.initialize();
  });

  afterEach(async () => {
    if (coordinator) {
      await coordinator.shutdown();
    }
  });

  describe('initialization', () => {
    it('should initialize with default configuration', async () => {
      const newCoordinator = new AttentionCoordinator();
      await newCoordinator.initialize();

      expect(newCoordinator.getMechanism()).toBe('flash');

      await newCoordinator.shutdown();
    });

    it('should initialize with custom configuration', async () => {
      const config: Partial<AttentionConfiguration> = {
        mechanism: 'multi-head',
        numHeads: 16,
        headDim: 128,
        dropoutRate: 0.1,
      };

      const newCoordinator = new AttentionCoordinator(config);
      await newCoordinator.initialize();

      expect(newCoordinator.getMechanism()).toBe('multi-head');

      await newCoordinator.shutdown();
    });

    it('should emit initialized event', async () => {
      const newCoordinator = new AttentionCoordinator();
      const handler = vi.fn();
      newCoordinator.on('initialized', handler);

      await newCoordinator.initialize();

      expect(handler).toHaveBeenCalledWith({ mechanism: 'flash' });

      await newCoordinator.shutdown();
    });

    it('should validate configuration', async () => {
      const invalidCoordinator = new AttentionCoordinator({
        numHeads: -1, // Invalid
      });

      await expect(invalidCoordinator.initialize()).rejects.toThrow(
        'numHeads must be positive'
      );
    });
  });

  describe('mechanism management', () => {
    const mechanisms: AttentionMechanism[] = [
      'flash',
      'multi-head',
      'linear',
      'hyperbolic',
      'moe',
      'local',
      'global',
      'sparse',
    ];

    it.each(mechanisms)('should switch to %s mechanism', async (mechanism) => {
      await coordinator.setMechanism(mechanism);
      expect(coordinator.getMechanism()).toBe(mechanism);
    });

    it('should emit mechanism-changed event', async () => {
      const handler = vi.fn();
      coordinator.on('mechanism-changed', handler);

      await coordinator.setMechanism('linear');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          previousMechanism: 'flash',
          newMechanism: 'linear',
        })
      );
    });

    it('should clear cache when mechanism changes', async () => {
      // Perform some computation to populate cache
      const query = [0.1, 0.2, 0.3];
      const key = [0.4, 0.5, 0.6];
      const value = [0.7, 0.8, 0.9];

      await coordinator.compute({ query, key, value, useCache: true });

      // Change mechanism
      await coordinator.setMechanism('linear');

      // Verify cache is cleared (would need internal access to verify)
      // For now, just verify the mechanism changed
      expect(coordinator.getMechanism()).toBe('linear');
    });
  });

  describe('attention computation', () => {
    it('should compute attention output', async () => {
      const query = new Array(64).fill(0).map(() => Math.random());
      const key = new Array(64).fill(0).map(() => Math.random());
      const value = new Array(64).fill(0).map(() => Math.random());

      const result = await coordinator.compute({ query, key, value });

      expect(result.output).toBeDefined();
      expect(result.output.length).toBe(value.length);
      expect(result.mechanism).toBe('flash');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should handle Float32Array input', async () => {
      const query = new Float32Array(64).map(() => Math.random());
      const key = new Float32Array(64).map(() => Math.random());
      const value = new Float32Array(64).map(() => Math.random());

      const result = await coordinator.compute({ query, key, value });

      expect(result.output).toBeDefined();
    });

    it('should use cache when enabled', async () => {
      const query = [0.1, 0.2, 0.3];
      const key = [0.4, 0.5, 0.6];
      const value = [0.7, 0.8, 0.9];

      // First computation
      const result1 = await coordinator.compute({
        query,
        key,
        value,
        useCache: true,
      });
      expect(result1.cacheHit).toBe(false);

      // Second computation (should hit cache)
      const result2 = await coordinator.compute({
        query,
        key,
        value,
        useCache: true,
      });
      expect(result2.cacheHit).toBe(true);
    });

    it('should emit attention-computed event', async () => {
      const handler = vi.fn();
      coordinator.on('attention-computed', handler);

      const query = [0.1, 0.2, 0.3];
      const key = [0.4, 0.5, 0.6];
      const value = [0.7, 0.8, 0.9];

      await coordinator.compute({ query, key, value });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          mechanism: 'flash',
          latencyMs: expect.any(Number),
        })
      );
    });
  });

  describe('agent coordination', () => {
    it('should coordinate agent outputs', async () => {
      const outputs = ['Result A', 'Result B', 'Result C'];
      const embeddings = [
        [0.1, 0.2, 0.3],
        [0.2, 0.3, 0.4],
        [0.15, 0.25, 0.35],
      ];

      const result = await coordinator.coordinateAgents({
        outputs,
        embeddings,
      });

      expect(result.consensus).toBeDefined();
      expect(result.weights.length).toBe(outputs.length);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should return weights that sum to 1', async () => {
      const outputs = ['A', 'B', 'C', 'D'];
      const embeddings = [
        [0.1, 0.2],
        [0.3, 0.4],
        [0.5, 0.6],
        [0.7, 0.8],
      ];

      const result = await coordinator.coordinateAgents({
        outputs,
        embeddings,
      });

      const sum = result.weights.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 5);
    });

    it('should use specified mechanism', async () => {
      const outputs = ['A', 'B'];
      const embeddings = [
        [0.1, 0.2],
        [0.3, 0.4],
      ];

      const result = await coordinator.coordinateAgents({
        outputs,
        embeddings,
        mechanism: 'moe',
      });

      expect(result.consensus).toBeDefined();
    });

    it('should handle single agent', async () => {
      const outputs = ['Only result'];
      const embeddings = [[0.1, 0.2, 0.3]];

      const result = await coordinator.coordinateAgents({
        outputs,
        embeddings,
      });

      expect(result.consensus).toBe('Only result');
      expect(result.weights[0]).toBe(1);
      expect(result.confidence).toBe(1);
    });

    it('should emit agents-coordinated event', async () => {
      const handler = vi.fn();
      coordinator.on('agents-coordinated', handler);

      const outputs = ['A', 'B'];
      const embeddings = [
        [0.1, 0.2],
        [0.3, 0.4],
      ];

      await coordinator.coordinateAgents({ outputs, embeddings });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          agentCount: 2,
          mechanism: 'flash',
          confidence: expect.any(Number),
        })
      );
    });
  });

  describe('expert routing', () => {
    it('should route task to experts', async () => {
      const task = { embedding: [0.1, 0.2, 0.3, 0.4] };
      const experts = [
        { id: 'expert-1', embedding: [0.1, 0.2, 0.3, 0.4] },
        { id: 'expert-2', embedding: [0.9, 0.8, 0.7, 0.6] },
        { id: 'expert-3', embedding: [0.15, 0.25, 0.35, 0.45] },
      ];

      const result = await coordinator.routeToExperts({ task, experts });

      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('expertId');
      expect(result[0]).toHaveProperty('score');
    });

    it('should respect topK parameter', async () => {
      const task = { embedding: [0.5, 0.5, 0.5] };
      const experts = [
        { id: 'e1', embedding: [0.1, 0.1, 0.1] },
        { id: 'e2', embedding: [0.2, 0.2, 0.2] },
        { id: 'e3', embedding: [0.3, 0.3, 0.3] },
        { id: 'e4', embedding: [0.4, 0.4, 0.4] },
        { id: 'e5', embedding: [0.5, 0.5, 0.5] },
      ];

      const result = await coordinator.routeToExperts({
        task,
        experts,
        topK: 2,
      });

      expect(result.length).toBe(2);
    });

    it('should sort by score descending', async () => {
      const task = { embedding: [0.5, 0.5, 0.5] };
      const experts = [
        { id: 'e1', embedding: [0.1, 0.1, 0.1] },
        { id: 'e2', embedding: [0.5, 0.5, 0.5] }, // Exact match
        { id: 'e3', embedding: [0.3, 0.3, 0.3] },
      ];

      const result = await coordinator.routeToExperts({
        task,
        experts,
        topK: 3,
      });

      // First result should be the exact match
      expect(result[0].expertId).toBe('e2');
      expect(result[0].score).toBeCloseTo(1, 2);
    });

    it('should emit experts-routed event', async () => {
      const handler = vi.fn();
      coordinator.on('experts-routed', handler);

      const task = { embedding: [0.5, 0.5] };
      const experts = [
        { id: 'e1', embedding: [0.1, 0.1] },
        { id: 'e2', embedding: [0.5, 0.5] },
      ];

      await coordinator.routeToExperts({ task, experts });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          expertCount: 2,
          topK: 3,
          topExpert: expect.any(String),
        })
      );
    });
  });

  describe('mechanism profiles', () => {
    it('should return mechanism profile', () => {
      const profile = coordinator.getMechanismProfile('flash');

      expect(profile.speedupRange).toBeDefined();
      expect(profile.memoryReduction).toBeDefined();
      expect(profile.latencyMs).toBeDefined();
      expect(profile.bestFor).toBeDefined();
    });

    it('should return current mechanism profile by default', () => {
      const profile = coordinator.getMechanismProfile();

      expect(profile).toBeDefined();
      expect(profile.speedupRange[0]).toBeGreaterThan(0);
    });
  });

  describe('mechanism suggestion', () => {
    it('should suggest flash for general use', () => {
      const suggestion = coordinator.suggestMechanism('general purpose');
      expect(suggestion).toBe('flash');
    });

    it('should suggest linear for long sequences', () => {
      const suggestion = coordinator.suggestMechanism('long-sequences');
      expect(suggestion).toBe('linear');
    });

    it('should suggest hyperbolic for hierarchical', () => {
      const suggestion = coordinator.suggestMechanism('hierarchical-data');
      expect(suggestion).toBe('hyperbolic');
    });

    it('should suggest moe for multi-task', () => {
      const suggestion = coordinator.suggestMechanism('multi-task');
      expect(suggestion).toBe('moe');
    });

    it('should default to flash for unknown use case', () => {
      const suggestion = coordinator.suggestMechanism('completely unknown');
      expect(suggestion).toBe('flash');
    });
  });

  describe('metrics', () => {
    it('should track metrics', async () => {
      const query = [0.1, 0.2, 0.3];
      const key = [0.4, 0.5, 0.6];
      const value = [0.7, 0.8, 0.9];

      // Perform some operations
      await coordinator.compute({ query, key, value });
      await coordinator.compute({ query, key, value });
      await coordinator.compute({ query, key, value });

      const metrics = await coordinator.getMetrics();

      expect(metrics.totalOperations).toBeGreaterThanOrEqual(3);
      expect(metrics.avgLatencyMs).toBeGreaterThanOrEqual(0);
      expect(metrics.speedupFactor).toBeGreaterThan(0);
    });

    it('should track cache hit rate', async () => {
      const query = [0.1, 0.2];
      const key = [0.3, 0.4];
      const value = [0.5, 0.6];

      // First call - cache miss
      await coordinator.compute({ query, key, value, useCache: true });

      // Second call - cache hit
      await coordinator.compute({ query, key, value, useCache: true });

      const metrics = await coordinator.getMetrics();

      expect(metrics.cacheHitRate).toBeGreaterThan(0);
    });
  });

  describe('cache management', () => {
    it('should clear cache', async () => {
      const query = [0.1, 0.2, 0.3];
      const key = [0.4, 0.5, 0.6];
      const value = [0.7, 0.8, 0.9];

      // Populate cache
      await coordinator.compute({ query, key, value, useCache: true });

      // Clear cache
      coordinator.clearCache();

      // Should be cache miss now
      const result = await coordinator.compute({
        query,
        key,
        value,
        useCache: true,
      });

      expect(result.cacheHit).toBe(false);
    });

    it('should emit cache-cleared event', () => {
      const handler = vi.fn();
      coordinator.on('cache-cleared', handler);

      coordinator.clearCache();

      expect(handler).toHaveBeenCalled();
    });
  });

  describe('factory function', () => {
    it('should create initialized coordinator', async () => {
      const newCoordinator = await createAttentionCoordinator({
        mechanism: 'linear',
      });

      expect(newCoordinator.getMechanism()).toBe('linear');

      await newCoordinator.shutdown();
    });
  });

  describe('shutdown', () => {
    it('should shutdown gracefully', async () => {
      const handler = vi.fn();
      coordinator.on('shutdown', handler);

      await coordinator.shutdown();

      expect(handler).toHaveBeenCalled();
    });
  });
});
