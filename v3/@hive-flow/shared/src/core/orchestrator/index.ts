/**
 * V3 Orchestrator Facade
 * Unified interface to decomposed orchestrator components.
 * Composition root: all module dependencies are wired here.
 */

import type { IOrchestrator, IHealthStatus, IOrchestratorMetrics } from '../interfaces/coordinator.interface.js';
import type { ITask, ITaskCreate, ITaskResult } from '../interfaces/task.interface.js';
import type { IAgent, IAgentConfig } from '../interfaces/agent.interface.js';
import type { IEventBus } from '../interfaces/event.interface.js';

import { TaskManager } from './task-manager.js';
import { SessionManager, type ISessionManager, type SessionManagerConfig } from './session-manager.js';
import { HealthMonitor, type HealthMonitorConfig } from './health-monitor.js';
import { LifecycleManager, type LifecycleManagerConfig } from './lifecycle-manager.js';
import { EventCoordinator } from './event-coordinator.js';
import { CheckpointManager, type CheckpointManagerConfig } from './checkpoint-manager.js';
import { CrashDetector, type CrashDetectorConfig } from './crash-detector.js';
import { EventBus } from '../event-bus.js';

// Ported modules
import { ShutdownManager, type ShutdownManagerConfig } from '../../lifecycle/shutdown-manager.js';
import { SignalManager, type SignalManagerConfig } from '../../signals/index.js';
import { DirectiveInterpreter, type DirectiveManagerConfig } from '../../directives/index.js';
import { ObservabilityManager, type ObservabilityConfig } from '../../observability/index.js';
import { ProviderRegistry, type ProviderRegistryConfig } from '../../services/provider-registry.js';
import { BaseHealthService, SessionIntegrityService } from '../../services/health/index.js';
import { AgentTaskDLQ, type IDLQBackend } from '../../resilience/dlq.js';

export * from './task-manager.js';
export * from './session-manager.js';
export * from './health-monitor.js';
export * from './lifecycle-manager.js';
export * from './event-coordinator.js';
export * from './checkpoint-manager.js';
export * from './crash-detector.js';

/**
 * Orchestrator facade configuration
 * (Note: For schema-validated config, use OrchestratorConfig from config/schema.ts)
 */
export interface OrchestratorFacadeConfig {
  session: SessionManagerConfig;
  health: HealthMonitorConfig;
  lifecycle: LifecycleManagerConfig;
  /** Checkpoint config (optional — enables crash recovery) */
  checkpoint?: CheckpointManagerConfig;
  /** Crash detector config (optional — requires checkpoint) */
  crashDetector?: CrashDetectorConfig;
  /** Shutdown manager config (optional — enables graceful Ctrl+C handling) */
  shutdown?: ShutdownManagerConfig;
  /** Signal manager config (optional — enables pause/resume/stop signals) */
  signal?: SignalManagerConfig;
  /** Directive interpreter config (optional — enables agent-driven control flow) */
  directive?: DirectiveManagerConfig;
  /** Observability config (optional — enables tracing/metrics) */
  observability?: Partial<ObservabilityConfig>;
  /** Provider registry config (optional — enables auto-discovery) */
  providers?: ProviderRegistryConfig;
  /**
   * Memory manager backend (optional).
   * When provided, Phase 4 services (SessionIntegrityService, AgentTaskDLQ)
   * are created and returned alongside the core components.
   * Must satisfy IDLQBackend: { store, get, query, delete }.
   */
  memoryManager?: IDLQBackend;
}

/**
 * Default orchestrator facade configuration
 */
export const defaultOrchestratorFacadeConfig: OrchestratorFacadeConfig = {
  session: {
    persistSessions: true,
    dataDir: './data',
    sessionRetentionMs: 3600000,
  },
  health: {
    checkInterval: 30000,
    historyLimit: 100,
    degradedThreshold: 1,
    unhealthyThreshold: 2,
  },
  lifecycle: {
    maxConcurrentAgents: 20,
    spawnTimeout: 30000,
    terminateTimeout: 10000,
    maxSpawnRetries: 3,
  },
};

/**
 * Create orchestrator components.
 * This is the composition root — all module dependencies are wired here.
 *
 * Optional modules (signals, directives, observability, providers, checkpoint,
 * crash detection, shutdown) are only instantiated when their config is provided.
 */
export function createOrchestrator(config: Partial<OrchestratorFacadeConfig> = {}) {
  const mergedConfig: OrchestratorFacadeConfig = {
    session: { ...defaultOrchestratorFacadeConfig.session, ...config.session },
    health: { ...defaultOrchestratorFacadeConfig.health, ...config.health },
    lifecycle: { ...defaultOrchestratorFacadeConfig.lifecycle, ...config.lifecycle },
    checkpoint: config.checkpoint,
    crashDetector: config.crashDetector,
    shutdown: config.shutdown,
    signal: config.signal,
    directive: config.directive,
    observability: config.observability,
    providers: config.providers,
    memoryManager: config.memoryManager,
  };

  // ─── Core components (always created) ────────────────────────
  const eventBus = new EventBus();
  const taskManager = new TaskManager(eventBus);
  const sessionManager = new SessionManager(eventBus, mergedConfig.session);
  const healthMonitor = new HealthMonitor(eventBus, mergedConfig.health);
  const lifecycleManager = new LifecycleManager(eventBus, mergedConfig.lifecycle);
  const eventCoordinator = new EventCoordinator(eventBus);

  // ─── Optional modules (created when config is provided) ──────

  // Observability — lazy init via env vars, zero overhead when off
  const observability = new ObservabilityManager(eventBus, mergedConfig.observability);
  observability.initialize();

  // Provider registry — auto-discovers from ~/.claude/providers/
  const providerRegistry = new ProviderRegistry(eventBus, mergedConfig.providers);

  // Checkpoint + Crash detector — enables session recovery
  let checkpointManager: CheckpointManager | undefined;
  let crashDetector: CrashDetector | undefined;
  if (mergedConfig.checkpoint) {
    checkpointManager = new CheckpointManager(eventBus, mergedConfig.checkpoint);
    crashDetector = new CrashDetector(eventBus, checkpointManager, mergedConfig.crashDetector);
  }

  // Signal manager — file-based IPC for pause/resume/stop
  let signalManager: SignalManager | undefined;
  if (mergedConfig.signal) {
    signalManager = new SignalManager(eventBus, mergedConfig.signal);
  }

  // Directive interpreter — agent-driven workflow control
  let directiveInterpreter: DirectiveInterpreter | undefined;
  if (mergedConfig.directive) {
    directiveInterpreter = new DirectiveInterpreter(eventBus, mergedConfig.directive);
  }

  // ─── Phase 4 optional services ───────────────────────────────
  // SessionIntegrityService and AgentTaskDLQ require a memory backend.
  // They are only created when the caller supplies a memoryManager-compatible
  // backend via config.memoryManager (see OrchestratorFacadeConfig).
  let sessionIntegrityService: SessionIntegrityService | undefined;
  let agentTaskDLQ: AgentTaskDLQ | undefined;
  if (mergedConfig.memoryManager) {
    sessionIntegrityService = new SessionIntegrityService();
    agentTaskDLQ = new AgentTaskDLQ(
      {
        debug: (msg: string, meta?: unknown) => console.debug(`[DLQ] ${msg}`, meta ?? ''),
        info:  (msg: string, meta?: unknown) => console.info(`[DLQ] ${msg}`, meta ?? ''),
        warn:  (msg: string, meta?: unknown) => console.warn(`[DLQ] ${msg}`, meta ?? ''),
        error: (msg: string, meta?: unknown) => console.error(`[DLQ] ${msg}`, meta ?? ''),
      },
      mergedConfig.memoryManager as IDLQBackend
    );
  }

  // ─── Shutdown wiring ─────────────────────────────────────────
  // ShutdownManager is a process-wide singleton, so we wire it
  // if shutdown config is provided (or always for production use).
  if (mergedConfig.shutdown !== undefined) {
    ShutdownManager.setup(eventBus, mergedConfig.shutdown);

    // Wire lifecycle manager's terminateAll as the shutdown kill function
    ShutdownManager.setTerminateAll(async (reason: string) => {
      await lifecycleManager.terminateAll?.(reason);
    });

    // Save session state and flush observability before exit
    ShutdownManager.onBeforeShutdown(async () => {
      await sessionManager.persistSessions();
      if (checkpointManager) {
        // Checkpoint managers persist on their own via createCheckpoint,
        // but we mark active sessions as crashed on unclean shutdown
      }
      await observability.shutdown();
      if (signalManager) {
        await signalManager.cleanup();
      }
    });
  }

  return {
    eventBus,
    taskManager,
    sessionManager,
    healthMonitor,
    lifecycleManager,
    eventCoordinator,
    observability,
    providerRegistry,
    checkpointManager,
    crashDetector,
    signalManager,
    directiveInterpreter,
    /** SessionIntegrityService (Phase 4) — present when memoryManager is provided */
    sessionIntegrityService,
    /** AgentTaskDLQ (Phase 4) — present when memoryManager is provided */
    agentTaskDLQ,
    config: mergedConfig,
  };
}

/**
 * Orchestrator type for facade
 */
export type OrchestratorComponents = ReturnType<typeof createOrchestrator>;
