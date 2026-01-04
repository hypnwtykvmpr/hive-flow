/**
 * AgenticFlowBridge Test Suite
 *
 * Comprehensive tests for the agentic-flow integration bridge.
 * Tests initialization, component management, and lifecycle.
 *
 * @module v3/__tests__/integration/agentic-flow-bridge.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AgenticFlowBridge,
  createAgenticFlowBridge,
  getDefaultBridge,
  resetDefaultBridge,
} from '../../integration/agentic-flow-bridge.js';
import type { IntegrationConfig, FeatureFlags } from '../../integration/types.js';

describe('AgenticFlowBridge', () => {
  let bridge: AgenticFlowBridge;

  beforeEach(() => {
    bridge = new AgenticFlowBridge();
  });

  afterEach(async () => {
    if (bridge) {
      await bridge.shutdown();
    }
    await resetDefaultBridge();
  });

  describe('initialization', () => {
    it('should initialize with default configuration', async () => {
      await bridge.initialize();

      const status = bridge.getStatus();
      expect(status.initialized).toBe(true);
      expect(status.connectedComponents).toContain('sdk');
    });

    it('should initialize with custom configuration', async () => {
      const customConfig: Partial<IntegrationConfig> = {
        features: {
          enableSONA: true,
          enableFlashAttention: false,
          enableAgentDB: true,
          enableTrajectoryTracking: true,
          enableGNN: false,
          enableIntelligenceBridge: true,
          enableQUICTransport: false,
          enableNightlyLearning: false,
          enableAutoConsolidation: true,
        },
        debug: true,
      };

      await bridge.initialize(customConfig);

      const flags = bridge.getFeatureFlags();
      expect(flags.enableSONA).toBe(true);
      expect(flags.enableFlashAttention).toBe(false);
    });

    it('should be idempotent - multiple initialize calls are safe', async () => {
      await bridge.initialize();
      await bridge.initialize();
      await bridge.initialize();

      const status = bridge.getStatus();
      expect(status.initialized).toBe(true);
    });

    it('should emit initialized event', async () => {
      const handler = vi.fn();
      bridge.on('initialized', handler);

      await bridge.initialize();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          duration: expect.any(Number),
          components: expect.any(Array),
        })
      );
    });
  });

  describe('runtime detection', () => {
    it('should detect runtime information', async () => {
      await bridge.initialize();

      const status = bridge.getStatus();
      expect(status.runtime).toBeDefined();
      expect(status.runtime.platform).toMatch(/linux|darwin|win32/);
      expect(status.runtime.arch).toMatch(/x64|arm64|ia32/);
      expect(status.runtime.nodeVersion).toMatch(/^v\d+/);
    });

    it('should determine performance tier', async () => {
      await bridge.initialize();

      const status = bridge.getStatus();
      expect(['optimal', 'good', 'fallback']).toContain(
        status.runtime.performanceTier
      );
    });
  });

  describe('component management', () => {
    it('should provide SONA adapter when enabled', async () => {
      await bridge.initialize({
        features: {
          enableSONA: true,
          enableFlashAttention: false,
          enableAgentDB: false,
          enableTrajectoryTracking: false,
          enableGNN: false,
          enableIntelligenceBridge: false,
          enableQUICTransport: false,
          enableNightlyLearning: false,
          enableAutoConsolidation: false,
        },
      });

      const sona = await bridge.getSONAAdapter();
      expect(sona).toBeDefined();
    });

    it('should throw when SONA is disabled', async () => {
      await bridge.initialize({
        features: {
          enableSONA: false,
          enableFlashAttention: true,
          enableAgentDB: true,
          enableTrajectoryTracking: false,
          enableGNN: false,
          enableIntelligenceBridge: false,
          enableQUICTransport: false,
          enableNightlyLearning: false,
          enableAutoConsolidation: false,
        },
      });

      await expect(bridge.getSONAAdapter()).rejects.toThrow('disabled');
    });

    it('should provide Attention coordinator when enabled', async () => {
      await bridge.initialize({
        features: {
          enableSONA: false,
          enableFlashAttention: true,
          enableAgentDB: false,
          enableTrajectoryTracking: false,
          enableGNN: false,
          enableIntelligenceBridge: false,
          enableQUICTransport: false,
          enableNightlyLearning: false,
          enableAutoConsolidation: false,
        },
      });

      const attention = await bridge.getAttentionCoordinator();
      expect(attention).toBeDefined();
    });

    it('should throw when Attention is disabled', async () => {
      await bridge.initialize({
        features: {
          enableSONA: true,
          enableFlashAttention: false,
          enableAgentDB: true,
          enableTrajectoryTracking: false,
          enableGNN: false,
          enableIntelligenceBridge: false,
          enableQUICTransport: false,
          enableNightlyLearning: false,
          enableAutoConsolidation: false,
        },
      });

      await expect(bridge.getAttentionCoordinator()).rejects.toThrow('disabled');
    });

    it('should provide SDK bridge', async () => {
      await bridge.initialize();

      const sdk = await bridge.getSDKBridge();
      expect(sdk).toBeDefined();
    });
  });

  describe('feature management', () => {
    it('should check if feature is enabled', async () => {
      await bridge.initialize({
        features: {
          enableSONA: true,
          enableFlashAttention: false,
          enableAgentDB: true,
          enableTrajectoryTracking: true,
          enableGNN: true,
          enableIntelligenceBridge: true,
          enableQUICTransport: false,
          enableNightlyLearning: false,
          enableAutoConsolidation: true,
        },
      });

      expect(bridge.isFeatureEnabled('enableSONA')).toBe(true);
      expect(bridge.isFeatureEnabled('enableFlashAttention')).toBe(false);
    });

    it('should enable feature dynamically', async () => {
      await bridge.initialize({
        features: {
          enableSONA: false,
          enableFlashAttention: true,
          enableAgentDB: true,
          enableTrajectoryTracking: false,
          enableGNN: false,
          enableIntelligenceBridge: false,
          enableQUICTransport: false,
          enableNightlyLearning: false,
          enableAutoConsolidation: false,
        },
      });

      expect(bridge.isFeatureEnabled('enableSONA')).toBe(false);

      await bridge.enableFeature('enableSONA');

      expect(bridge.isFeatureEnabled('enableSONA')).toBe(true);
    });

    it('should disable feature dynamically', async () => {
      await bridge.initialize({
        features: {
          enableSONA: true,
          enableFlashAttention: true,
          enableAgentDB: true,
          enableTrajectoryTracking: true,
          enableGNN: true,
          enableIntelligenceBridge: true,
          enableQUICTransport: false,
          enableNightlyLearning: false,
          enableAutoConsolidation: true,
        },
      });

      expect(bridge.isFeatureEnabled('enableSONA')).toBe(true);

      await bridge.disableFeature('enableSONA');

      expect(bridge.isFeatureEnabled('enableSONA')).toBe(false);
    });

    it('should emit feature-enabled event', async () => {
      await bridge.initialize({
        features: {
          enableSONA: false,
          enableFlashAttention: true,
          enableAgentDB: true,
          enableTrajectoryTracking: false,
          enableGNN: false,
          enableIntelligenceBridge: false,
          enableQUICTransport: false,
          enableNightlyLearning: false,
          enableAutoConsolidation: false,
        },
      });

      const handler = vi.fn();
      bridge.on('feature-enabled', handler);

      await bridge.enableFeature('enableSONA');

      expect(handler).toHaveBeenCalledWith({ feature: 'enableSONA' });
    });
  });

  describe('health check', () => {
    it('should perform health check on all components', async () => {
      await bridge.initialize();

      const health = await bridge.healthCheck();

      expect(health['sdk']).toBeDefined();
      expect(health['sdk'].status).toBe('healthy');
    });

    it('should report unhealthy components', async () => {
      await bridge.initialize();

      // Get health with all components
      const health = await bridge.healthCheck();

      for (const component of Object.values(health)) {
        expect(['healthy', 'degraded', 'unhealthy']).toContain(component.status);
      }
    });
  });

  describe('reconfiguration', () => {
    it('should reconfigure bridge settings', async () => {
      await bridge.initialize({
        features: {
          enableSONA: true,
          enableFlashAttention: true,
          enableAgentDB: true,
          enableTrajectoryTracking: true,
          enableGNN: true,
          enableIntelligenceBridge: true,
          enableQUICTransport: false,
          enableNightlyLearning: false,
          enableAutoConsolidation: true,
        },
      });

      await bridge.reconfigure({
        debug: true,
      });

      // Should emit reconfigured event
      const handler = vi.fn();
      bridge.on('reconfigured', handler);

      await bridge.reconfigure({
        debug: false,
      });

      expect(handler).toHaveBeenCalled();
    });
  });

  describe('shutdown', () => {
    it('should shutdown gracefully', async () => {
      await bridge.initialize();

      const shutdownHandler = vi.fn();
      bridge.on('shutdown', shutdownHandler);

      await bridge.shutdown();

      expect(shutdownHandler).toHaveBeenCalled();

      const status = bridge.getStatus();
      expect(status.initialized).toBe(false);
    });

    it('should clear all components on shutdown', async () => {
      await bridge.initialize({
        features: {
          enableSONA: true,
          enableFlashAttention: true,
          enableAgentDB: true,
          enableTrajectoryTracking: true,
          enableGNN: true,
          enableIntelligenceBridge: true,
          enableQUICTransport: false,
          enableNightlyLearning: false,
          enableAutoConsolidation: true,
        },
      });

      await bridge.shutdown();

      const status = bridge.getStatus();
      expect(status.connectedComponents).toHaveLength(0);
    });
  });

  describe('factory functions', () => {
    it('should create bridge with createAgenticFlowBridge', async () => {
      const newBridge = await createAgenticFlowBridge();

      const status = newBridge.getStatus();
      expect(status.initialized).toBe(true);

      await newBridge.shutdown();
    });

    it('should provide singleton with getDefaultBridge', async () => {
      const bridge1 = await getDefaultBridge();
      const bridge2 = await getDefaultBridge();

      expect(bridge1).toBe(bridge2);
    });

    it('should reset singleton with resetDefaultBridge', async () => {
      const bridge1 = await getDefaultBridge();
      await resetDefaultBridge();
      const bridge2 = await getDefaultBridge();

      expect(bridge1).not.toBe(bridge2);
    });
  });
});
