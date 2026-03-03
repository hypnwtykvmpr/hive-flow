/**
 * Claude Flow V3 - Modular AI Agent Coordination System
 *
 * This is the main entry point that re-exports all @claude-flow modules.
 * Each module can also be imported directly for tree-shaking.
 *
 * @example
 * // Import everything
 * import * as claudeFlow from '@claude-flow/v3';
 *
 * // Or import specific modules
 * import { UnifiedSwarmCoordinator } from '@claude-flow/swarm';
 * import { PasswordHasher } from '@claude-flow/security';
 * import { HNSWIndex } from '@claude-flow/memory';
 *
 * Complete reimagining based on 10 ADRs:
 * - ADR-001: Adopt agentic-flow as core foundation
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
 * - Flash Attention: 2.49x-7.47x speedup
 * - AgentDB Search: 150x-12,500x improvement
 * - Memory Reduction: 50-75%
 * - Code Reduction: <5,000 lines (vs 15,000+)
 * - Startup Time: <500ms
 *
 * @module @claude-flow/v3
 * @version 3.0.0-alpha.1
 */

// =============================================================================
// @claude-flow Module Exports (New Modular Architecture)
// =============================================================================

/**
 * Security module - CVE fixes, input validation, credential management
 * @see {@link @claude-flow/security}
 */
export * as security from './@claude-flow/security/src/index.js';

/**
 * Memory module - AgentDB, HNSW indexing, vector search
 * @see {@link @claude-flow/memory}
 */
export * as memory from './@claude-flow/memory/src/index.js';

/**
 * Swarm module - 15-agent coordination, hierarchical mesh, consensus
 * @see {@link @claude-flow/swarm}
 */
export * as swarm from './@claude-flow/swarm/src/index.js';

/**
 * Integration module - agentic-flow@alpha integration, ADR-001 compliance
 * @see {@link @claude-flow/integration}
 */
export * as integration from './@claude-flow/integration/src/index.js';

/**
 * Shared module - common types, events, utilities, core interfaces
 * @see {@link @claude-flow/shared}
 */
export * as shared from './@claude-flow/shared/src/index.js';

/**
 * CLI module - Command parsing, prompts, output formatting
 * @see {@link @claude-flow/cli}
 */
export * as cli from './@claude-flow/cli/src/index.js';

/**
 * Neural module - SONA learning, neural modes
 * @see {@link @claude-flow/neural}
 */
export * as neural from './@claude-flow/neural/src/index.js';

/**
 * Performance module - Benchmarking, Flash Attention validation
 * @see {@link @claude-flow/performance}
 */
export * as performance from './@claude-flow/performance/src/index.js';

/**
 * Testing module - TDD London School framework, test utilities
 * @see {@link @claude-flow/testing}
 */
export * as testing from './@claude-flow/testing/src/index.js';

/**
 * Deployment module - Release management, CI/CD
 * @see {@link @claude-flow/deployment}
 */
export * as deployment from './@claude-flow/deployment/src/index.js';

// =============================================================================
// Module List for Dynamic Loading
// =============================================================================

export const MODULES = [
  '@claude-flow/shared',
  '@claude-flow/security',
  '@claude-flow/memory',
  '@claude-flow/swarm',
  '@claude-flow/integration',
  '@claude-flow/cli',
  '@claude-flow/neural',
  '@claude-flow/performance',
  '@claude-flow/testing',
  '@claude-flow/deployment',
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
  name: 'claude-flow',
  version: V3_VERSION.full,
  description: 'Complete reimagining of Claude-Flow with 15-agent hierarchical mesh swarm',
  repository: 'https://github.com/ruvnet/claude-flow',
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
    flashAttention: '2.49x-7.47x speedup',
    agentDbSearch: '150x-12,500x improvement',
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
