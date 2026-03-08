/**
 * Shutdown Manager
 * Two-stage Ctrl+C graceful shutdown for Hive Flow.
 * Adapted from CodeMachine-CLI's MonitoringCleanup pattern.
 *
 * Stage 1 (first Ctrl+C): Emits warning event. Workflow continues.
 * Stage 2 (second Ctrl+C after debounce): Terminates agents, cleans resources, exits.
 *
 * Also handles SIGTERM, uncaughtException, and unhandledRejection.
 */

import type { IEventBus } from '../core/interfaces/event.interface.js';
import { ProcessGroupManager } from './process-group-manager.js';
import { ResourceCleaner } from './resource-cleaner.js';

/** Events emitted by ShutdownManager through the EventBus */
export const ShutdownEvents = {
  /** First Ctrl+C — show warning to user */
  SHUTDOWN_WARNING: 'system.shutdown.warning',
  /** Second Ctrl+C — shutdown initiated, agents being terminated */
  SHUTDOWN_INITIATED: 'system.shutdown.initiated',
  /** Shutdown complete, about to exit */
  SHUTDOWN_COMPLETE: 'system.shutdown.complete',
  /** Unrecoverable error triggered shutdown */
  SHUTDOWN_ERROR: 'system.shutdown.error',
} as const;

/** Payload for shutdown events */
export interface ShutdownEventPayload {
  reason: string;
  signal?: string;
  error?: Error;
  agentCount?: number;
  processCount?: number;
}

/** Callback for pre-shutdown actions (e.g., save session state) */
export type BeforeShutdownCallback = () => Promise<void>;

/** Configuration for ShutdownManager */
export interface ShutdownManagerConfig {
  /** Minimum ms between first and second Ctrl+C (default: 500) */
  ctrlCDebounceMs?: number;
  /** Max ms to wait for graceful shutdown before force-kill (default: 5000) */
  gracefulTimeoutMs?: number;
  /** Exit code for Ctrl+C (default: 130, standard for SIGINT) */
  exitCode?: number;
  /** Whether to actually call process.exit (false for testing) */
  shouldExit?: boolean;
}

const DEFAULT_CONFIG: Required<ShutdownManagerConfig> = {
  ctrlCDebounceMs: 500,
  gracefulTimeoutMs: 5000,
  exitCode: 130,
  shouldExit: true,
};

class ShutdownManagerImpl {
  private isSetup = false;
  private isShuttingDown = false;
  private firstCtrlCPressed = false;
  private firstCtrlCTime = 0;
  private config: Required<ShutdownManagerConfig> = { ...DEFAULT_CONFIG };
  private eventBus: IEventBus | null = null;
  private beforeShutdownCallbacks: BeforeShutdownCallback[] = [];
  private terminateAllFn: ((reason: string) => Promise<void>) | null = null;

  /**
   * Initialize shutdown handlers.
   * Call once at application startup.
   *
   * @param eventBus - EventBus for emitting shutdown events
   * @param config - Optional configuration overrides
   */
  setup(eventBus: IEventBus, config?: ShutdownManagerConfig): void {
    if (this.isSetup) return;

    this.eventBus = eventBus;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Reset Ctrl+C state on setup
    this.firstCtrlCPressed = false;
    this.firstCtrlCTime = 0;
    this.isSetup = true;

    // SIGINT (Ctrl+C) — two-stage handler
    process.on('SIGINT', () => {
      void this.handleCtrlC();
    });

    // SIGTERM — immediate graceful shutdown
    process.on('SIGTERM', () => {
      void this.handleSignal('SIGTERM', 'Process terminated');
    });

    // Uncaught exceptions — log + shutdown
    process.on('uncaughtException', (error: Error) => {
      void this.handleFatalError('uncaughtException', error);
    });

    // Unhandled rejections — log + shutdown
    process.on('unhandledRejection', (reason: unknown) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      void this.handleFatalError('unhandledRejection', error);
    });
  }

  /**
   * Register a function that terminates all agents.
   * Called by the orchestrator during setup.
   */
  setTerminateAll(fn: (reason: string) => Promise<void>): void {
    this.terminateAllFn = fn;
  }

  /**
   * Register a callback to run before shutdown (e.g., save session).
   * Callbacks run in registration order.
   */
  onBeforeShutdown(callback: BeforeShutdownCallback): void {
    this.beforeShutdownCallbacks.push(callback);
  }

  /**
   * Programmatic trigger for shutdown (e.g., from UI or API).
   */
  async triggerShutdown(reason = 'Programmatic shutdown'): Promise<void> {
    await this.executeShutdown(reason, 'programmatic');
  }

  /**
   * Check if shutdown is in progress.
   */
  get shuttingDown(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Reset state (for testing).
   */
  reset(): void {
    this.isSetup = false;
    this.isShuttingDown = false;
    this.firstCtrlCPressed = false;
    this.firstCtrlCTime = 0;
    this.eventBus = null;
    this.beforeShutdownCallbacks = [];
    this.terminateAllFn = null;
    this.config = { ...DEFAULT_CONFIG };
  }

  // ─── Private ──────────────────────────────────────────────────────

  private async handleCtrlC(): Promise<void> {
    if (!this.firstCtrlCPressed) {
      // Stage 1: Show warning, don't stop anything
      this.firstCtrlCPressed = true;
      this.firstCtrlCTime = Date.now();

      this.eventBus?.emit(ShutdownEvents.SHUTDOWN_WARNING, {
        reason: 'Press Ctrl+C again to exit',
        signal: 'SIGINT',
        processCount: ProcessGroupManager.size,
      } satisfies ShutdownEventPayload);

      return;
    }

    // Check debounce
    const elapsed = Date.now() - this.firstCtrlCTime;
    if (elapsed < this.config.ctrlCDebounceMs) {
      // Too soon — ignore
      return;
    }

    // Stage 2: Actual shutdown
    await this.executeShutdown('User interrupted (Ctrl+C)', 'SIGINT');
  }

  private async handleSignal(signal: string, reason: string): Promise<void> {
    await this.executeShutdown(reason, signal);
  }

  private async handleFatalError(type: string, error: Error): Promise<void> {
    this.eventBus?.emit(ShutdownEvents.SHUTDOWN_ERROR, {
      reason: `${type}: ${error.message}`,
      error,
    } satisfies ShutdownEventPayload);

    await this.executeShutdown(error.message, type);

    if (this.config.shouldExit) {
      process.exit(1);
    }
  }

  private async executeShutdown(reason: string, signal: string): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.eventBus?.emit(ShutdownEvents.SHUTDOWN_INITIATED, {
      reason,
      signal,
      processCount: ProcessGroupManager.size,
    } satisfies ShutdownEventPayload);

    // Phase 1: Run before-shutdown callbacks (save session, etc.)
    for (const callback of this.beforeShutdownCallbacks) {
      try {
        await callback();
      } catch {
        // Don't let callback failures block shutdown
      }
    }

    // Phase 2: Terminate all agents (application-level)
    if (this.terminateAllFn) {
      try {
        await Promise.race([
          this.terminateAllFn(reason),
          new Promise<void>(resolve =>
            setTimeout(resolve, this.config.gracefulTimeoutMs),
          ),
        ]);
      } catch {
        // Don't let agent termination failures block shutdown
      }
    }

    // Phase 3: Kill all child processes (OS-level)
    ProcessGroupManager.killAll();

    // Phase 4: Clean up resources (temp files, locks)
    await ResourceCleaner.cleanAll();

    this.eventBus?.emit(ShutdownEvents.SHUTDOWN_COMPLETE, {
      reason,
      signal,
    } satisfies ShutdownEventPayload);

    if (this.config.shouldExit) {
      process.exit(this.config.exitCode);
    }
  }
}

/** Singleton instance */
export const ShutdownManager = new ShutdownManagerImpl();
