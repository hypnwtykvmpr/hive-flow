/**
 * V3 Claude-Flow Test Setup
 *
 * London School TDD Global Configuration
 * - Initializes mock infrastructure
 * - Sets up global test utilities
 * - Configures behavior verification helpers
 */
import { vi, beforeEach, afterEach, expect } from 'vitest';

// Re-export commonly used testing utilities
export { vi, expect } from 'vitest';
export { createMock, createDeepMock, createSpyMock } from './helpers/create-mock';
export { createTestApplication } from './helpers/test-application';
export { createSwarmTestInstance } from './helpers/swarm-instance';

// Custom matchers for London School testing
expect.extend({
  /**
   * Verify a mock was called with specific interaction pattern
   */
  toHaveBeenCalledWithInteraction(received, expected) {
    const pass = received.mock.calls.some((call: unknown[]) =>
      JSON.stringify(call) === JSON.stringify(expected)
    );

    return {
      pass,
      message: () => pass
        ? `Expected mock not to have been called with ${JSON.stringify(expected)}`
        : `Expected mock to have been called with ${JSON.stringify(expected)}, but was called with ${JSON.stringify(received.mock.calls)}`,
    };
  },

  /**
   * Verify mock call order for behavior testing
   */
  toHaveBeenCalledBefore(received, other) {
    const receivedCalls = received.mock.invocationCallOrder;
    const otherCalls = other.mock.invocationCallOrder;

    if (receivedCalls.length === 0 || otherCalls.length === 0) {
      return {
        pass: false,
        message: () => 'Expected both mocks to have been called',
      };
    }

    const pass = Math.min(...receivedCalls) < Math.min(...otherCalls);

    return {
      pass,
      message: () => pass
        ? `Expected first mock not to have been called before second mock`
        : `Expected first mock to have been called before second mock`,
    };
  },

  /**
   * Verify interaction count for behavior verification
   */
  toHaveInteractionCount(received, expected) {
    const actual = received.mock.calls.length;
    const pass = actual === expected;

    return {
      pass,
      message: () => pass
        ? `Expected mock not to have ${expected} interactions`
        : `Expected mock to have ${expected} interactions, but had ${actual}`,
    };
  },
});

// Global setup - runs once before all tests
beforeEach(() => {
  // Reset all mocks before each test (London School principle)
  vi.clearAllMocks();

  // Reset any timers
  vi.useRealTimers();
});

afterEach(() => {
  // Verify no unhandled mock calls (strict verification)
  vi.restoreAllMocks();
});

// Type declarations for custom matchers
declare module 'vitest' {
  interface Assertion<T = unknown> {
    toHaveBeenCalledWithInteraction(expected: unknown[]): T;
    toHaveBeenCalledBefore(other: ReturnType<typeof vi.fn>): T;
    toHaveInteractionCount(expected: number): T;
  }
  interface AsymmetricMatchersContaining {
    toHaveBeenCalledWithInteraction(expected: unknown[]): unknown;
    toHaveBeenCalledBefore(other: ReturnType<typeof vi.fn>): unknown;
    toHaveInteractionCount(expected: number): unknown;
  }
}

/**
 * Test configuration constants
 */
export const TEST_CONFIG = {
  // Security test thresholds
  SECURITY_COVERAGE_TARGET: 0.95,

  // Performance test thresholds
  FLASH_ATTENTION_SPEEDUP_MIN: 2.49,
  FLASH_ATTENTION_SPEEDUP_MAX: 7.47,
  AGENTDB_SEARCH_IMPROVEMENT_MIN: 150,
  AGENTDB_SEARCH_IMPROVEMENT_MAX: 12500,
  MEMORY_REDUCTION_TARGET: 0.50,

  // Timeouts
  ASYNC_TIMEOUT: 5000,
  INTEGRATION_TIMEOUT: 10000,
  ACCEPTANCE_TIMEOUT: 30000,
} as const;
