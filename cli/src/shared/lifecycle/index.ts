/**
 * Lifecycle Module
 * Graceful shutdown, process tracking, and resource cleanup.
 * Ported from CodeMachine-CLI's monitoring/cleanup and process/spawn patterns.
 */

export { ShutdownManager, ShutdownEvents } from './shutdown-manager.js';
export type {
  ShutdownManagerConfig,
  ShutdownEventPayload,
  BeforeShutdownCallback,
} from './shutdown-manager.js';

export { ProcessGroupManager } from './process-group-manager.js';
export type { TrackedProcess } from './process-group-manager.js';

export { ManagedProcessService } from './ManagedProcessService.js';
export type { ManagedProcessOptions } from './ManagedProcessService.js';

export { ResourceCleaner } from './resource-cleaner.js';
export type { CleanupHandler } from './resource-cleaner.js';
