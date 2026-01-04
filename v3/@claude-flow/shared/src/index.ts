/**
 * @claude-flow/shared - Shared Module
 * Common types, events, utilities, and core interfaces for V3 Claude-Flow
 *
 * Based on ADR-002 (DDD) and ADR-006 (Unified Memory Service)
 */

// Types - Shared type definitions
export * from './types.js';

// Events - Event bus and event sourcing
export * from './events.js';

// Re-export from submodules for convenience
export * from './types/index.js';
export * from './core/index.js';
