/**
 * Hive Flow V3 - Modular AI Agent Coordination System
 *
 * This is the main entry point that re-exports all @hive-flow modules.
 * Each module can also be imported directly for tree-shaking.
 *
 * @example
 * // Import everything
 * import * as hiveFlow from '@hive-flow/v3';
 *
 * // Or import specific modules
 * import { UnifiedSwarmCoordinator } from '@hive-flow/swarm';
 * import { PasswordHasher } from '@hive-flow/security';
 * import { HNSWIndex } from '@hive-flow/memory';
 *
 * Complete reimagining based on 10 ADRs:
 * - ADR-001: Local compatibility foundation
 * - ADR-002: Domain-Driven Design structure
 * - ADR-003: Single coordination engine
 * - ADR-004: Plugin-based architecture
 * - ADR-005: MCP-first API design
 * - ADR-006: Unified memory service
 * - ADR-007: Event sourcing for state changes
 * - ADR-008: Vitest over Jest
 * - ADR-009: Hybrid memory backend default
 * - ADR-010: Remove Deno support (Node.js 20+ only)
 *
 * Performance Targets:
 * - Flash Attention: optimization enabled
 * - AgentDB Search: HNSW indexing improvements
 * - Memory Reduction: 50-75%
 * - Code Reduction: <5,000 lines (vs 15,000+)
 * - Startup Time: <500ms
 *
 * @module @hive-flow/v3
 * @version 3.0.0-alpha.1
 */

// =============================================================================
// @hive-flow Module Exports (New Modular Architecture)
// =============================================================================

/**
 * Security module - CVE fixes, input validation, credential management
 * @see {@link @hive-flow/security}
 */
export * as security from './@hive-flow/security/src/index.js';

/**
 * Memory module - AgentDB, HNSW indexing, vector search
 * @see {@link @hive-flow/memory}
 */
export * as memory from './@hive-flow/memory/src/index.js';

/**
 * Swarm module - 15-agent coordination, hierarchical mesh, consensus
 * @see {@link @hive-flow/swarm}
 */
export * as swarm from './@hive-flow/swarm/src/index.js';

/**
 * Integration module - local compatibility adapters, ADR alignment
 * @see {@link @hive-flow/integration}
 */
export * as integration from './@hive-flow/integration/src/index.js';

/**
 * Shared module - common types, events, utilities, core interfaces
 * @see {@link @hive-flow/shared}
 */
export * as shared from './@hive-flow/shared/src/index.js';

/**
 * CLI module - Command parsing, prompts, output formatting
 * @see {@link @hive-flow/cli}
 */
export * as cli from './@hive-flow/cli/src/index.js';

/**
 * Neural module - SONA learning, neural modes
 * @see {@link @hive-flow/neural}
 */
export * as neural from './@hive-flow/neural/src/index.js';

/**
 * Performance module - Benchmarking, Flash Attention validation
 * @see {@link @hive-flow/performance}
 */
export * as performance from './@hive-flow/performance/src/index.js';

/**
 * Testing module - TDD London School framework, test utilities
 * @see {@link @hive-flow/testing}
 */
export * as testing from './@hive-flow/testing/src/index.js';

/**
 * Deployment module - Release management, CI/CD
 * @see {@link @hive-flow/deployment}
 */
export * as deployment from './@hive-flow/deployment/src/index.js';

// =============================================================================
// Module List for Dynamic Loading
// =============================================================================

export const MODULES = [
  '@hive-flow/shared',
  '@hive-flow/security',
  '@hive-flow/memory',
  '@hive-flow/swarm',
  '@hive-flow/integration',
  '@hive-flow/cli',
  '@hive-flow/neural',
  '@hive-flow/performance',
  '@hive-flow/testing',
  '@hive-flow/deployment',
] as const;

export type ModuleName = (typeof MODULES)[number];

// =============================================================================
// Legacy Compatibility Layer (Gradual Migration Support)
// =============================================================================

// =============================================================================
// V3 Core Architecture (Decomposed Orchestrator)
// Note: The following modules are reserved for future implementation.
// =============================================================================

// Core Interfaces (./core/interfaces/index.js - not yet implemented)
// Orchestrator Components (./core/orchestrator/index.js - not yet implemented)
// Event Bus (./core/event-bus.js - not yet implemented)
// Configuration (./core/config/index.js - not yet implemented)
// V3 Extended Types (./types/index.js - not yet implemented)

// =============================================================================
// Legacy/Shared Exports (Preserved for Backward Compatibility)
// Note: These modules (./shared/types, ./shared/events, ./coordination/*)
// are reserved for future implementation.
// =============================================================================

// Shared Types (./shared/types - not yet implemented at this path)
// Event System (./shared/events - not yet implemented at this path)
// Agent Registry (./coordination/agent-registry - not yet implemented)
// Task Orchestrator (./coordination/task-orchestrator - not yet implemented)
// Swarm Hub (./coordination/swarm-hub - not yet implemented)

// Configuration (swarm.config is available)
export type {
  V3SwarmConfig,
  DomainConfig,
  PhaseConfig,
  GitHubConfig,
  LoggingConfig,
  TopologyConfig
} from './swarm.config';

export {
  defaultSwarmConfig,
  agentRoleMapping,
  getAgentsByDomain,
  getAgentConfig,
  getPhaseConfig,
  getActiveAgentsForPhase,
  createCustomConfig,
  topologyConfigs,
  getTopologyConfig
} from './swarm.config';

// =============================================================================
// Version Info
// =============================================================================

export const V3_VERSION = {
  major: 3,
  minor: 0,
  patch: 0,
  prerelease: 'alpha',
  full: '3.0.0-alpha',
  buildDate: new Date().toISOString()
};

export const V3_INFO = {
  name: 'hive-flow',
  version: V3_VERSION.full,
  description: 'Complete reimagining of Hive-Flow with 15-agent hierarchical mesh swarm',
  license: 'MIT',
  engines: {
    node: '>=20.0.0'
  },
  features: [
    'agentic-flow integration (ADR-001)',
    'Domain-Driven Design (ADR-002)',
    'Single coordination engine (ADR-003)',
    'Plugin architecture (ADR-004)',
    'MCP-first API (ADR-005)',
    'Unified memory service (ADR-006)',
    'Event sourcing (ADR-007)',
    'Vitest testing (ADR-008)',
    'Hybrid memory backend (ADR-009)',
    'Node.js 20+ focus (ADR-010)'
  ],
  performanceTargets: {
    flashAttention: 'Flash Attention optimization',
    agentDbSearch: 'HNSW indexing improvements',
    memoryReduction: '50-75%',
    codeReduction: '<5,000 lines',
    startupTime: '<500ms'
  },
  agents: {
    total: 15,
    topology: 'hierarchical-mesh',
    domains: ['security', 'core', 'integration', 'quality', 'performance', 'deployment']
  }
};

// =============================================================================
// Default Export
// =============================================================================

export default {
  // Version info
  version: V3_VERSION,
  info: V3_INFO,
};
