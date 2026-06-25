/**
 * @hive-flow/cli/hooks - V3 Hooks System
 *
 * Event-driven lifecycle hooks with ReasoningBank learning integration.
 *
 * Features:
 * - Hook registration and execution
 * - Background daemons for metrics and learning
 * - Statusline integration
 * - MCP tool definitions
 * - V2 compatibility layer
 *
 * @packageDocumentation
 */

// Types
export * from './types.js';

// ReasoningBank - Vector-based pattern learning
export {
  ReasoningBank,
  reasoningBank,
  type GuidancePattern,
  type GuidanceResult,
  type RoutingResult,
  type ReasoningBankConfig,
  type ReasoningBankMetrics,
} from './reasoningbank/index.js';

// Guidance Provider - Claude-visible output generation
export {
  GuidanceProvider,
  guidanceProvider,
  type ClaudeHookOutput,
} from './reasoningbank/guidance-provider.js';

// Registry
export {
  HookRegistry,
  defaultRegistry,
  registerHook,
  unregisterHook,
} from './registry/index.js';

// Executor
export {
  HookExecutor,
  defaultExecutor,
  executeHooks,
} from './executor/index.js';

// Daemons
export {
  DaemonManager,
  MetricsDaemon,
  SwarmMonitorDaemon,
  HooksLearningDaemon,
  defaultDaemonManager,
} from './daemons/index.js';

// Statusline: the legacy fabricator (StatuslineGenerator) was removed in
// statusboard Slice C. The canonical renderer lives in
// `src/statusline/claude-code-renderer.ts` and is the only honest source.

// MCP Tools
export {
  hooksMCPTools,
  getHooksTool,
  preEditTool,
  postEditTool,
  routeTaskTool,
  metricsTool,
  preCommandTool,
  postCommandTool,
  daemonStatusTool,
  type MCPTool,
} from './mcp/index.js';

// Official Claude Code Hooks Bridge
export {
  OfficialHooksBridge,
  V3_TO_OFFICIAL_HOOK_MAP,
  V3_TOOL_MATCHERS,
  processOfficialHookInput,
  outputOfficialHookResult,
  executeWithBridge,
  type OfficialHookEvent,
  type OfficialHookInput,
  type OfficialHookOutput,
} from './bridge/official-hooks-bridge.js';

// Swarm Communication
export {
  SwarmCommunication,
  swarmComm,
  type SwarmMessage,
  type PatternBroadcast,
  type ConsensusRequest,
  type TaskHandoff,
  type SwarmAgentState,
  type SwarmConfig,
} from './swarm/index.js';

// Workers - Cross-platform background workers
export {
  WorkerManager,
  WorkerPriority,
  AlertSeverity,
  WORKER_CONFIGS,
  DEFAULT_THRESHOLDS,
  createWorkerManager,
  workerManager,
  // Worker factories
  createPerformanceWorker,
  createHealthWorker,
  createSwarmWorker,
  createGitWorker,
  createLearningWorker,
  createADRWorker,
  createDDDWorker,
  createSecurityWorker,
  createPatternsWorker,
  createCacheWorker,
  // Types
  type WorkerConfig,
  type WorkerResult,
  type WorkerMetrics,
  type WorkerManagerStatus,
  type WorkerHandler,
  type WorkerAlert,
  type AlertThreshold,
  type PersistedWorkerState,
  type HistoricalMetric,
  type StatuslineData,
} from './workers/index.js';

// Workers - MCP Tools
export {
  workerMCPTools,
  createWorkerToolHandler,
  workerRunTool,
  workerStatusTool,
  workerAlertsTool,
  workerHistoryTool,
  workerStatuslineTool,
  workerRunAllTool,
  workerStartTool,
  workerStopTool,
  type MCPToolDefinition,
  type MCPToolResult,
} from './workers/mcp-tools.js';

// Workers - Session Integration
export {
  onSessionStart,
  onSessionEnd,
  formatSessionStartOutput,
  generateShellHook,
  getGlobalManager,
  setGlobalManager,
  initializeGlobalManager,
  type SessionHookConfig,
  type SessionHookResult,
} from './workers/session-hook.js';

// Version
export const VERSION = '3.0.0-alpha.1';

/**
 * Initialize hooks system with default configuration
 */
export async function initializeHooks(options?: {
  enableDaemons?: boolean;
}): Promise<{
  registry: import('./registry/index.js').HookRegistry;
  executor: import('./executor/index.js').HookExecutor;
}> {
  const { HookRegistry } = await import('./registry/index.js');
  const { HookExecutor } = await import('./executor/index.js');
  const { DaemonManager, MetricsDaemon, SwarmMonitorDaemon, HooksLearningDaemon } = await import('./daemons/index.js');

  const registry = new HookRegistry();
  const executor = new HookExecutor(registry);

  // Start daemons if enabled
  if (options?.enableDaemons !== false) {
    const daemonManager = new DaemonManager();
    const metricsDaemon = new MetricsDaemon(daemonManager);
    const swarmDaemon = new SwarmMonitorDaemon(daemonManager);
    const learningDaemon = new HooksLearningDaemon(daemonManager);

    await Promise.all([
      metricsDaemon.start(),
      swarmDaemon.start(),
      learningDaemon.start(),
    ]);
  }

  return { registry, executor };
}

/**
 * Quick hooks execution helper
 */
export async function runHook(
  event: import('./types.js').HookEvent,
  context: Partial<import('./types.js').HookContext>
): Promise<import('./types.js').HookExecutionResult> {
  const { executeHooks } = await import('./executor/index.js');
  return executeHooks(event, context);
}

/**
 * Register a new hook with simplified API
 */
export async function addHook(
  event: import('./types.js').HookEvent,
  handler: import('./types.js').HookHandler,
  options?: {
    priority?: import('./types.js').HookPriority;
    name?: string;
  }
): Promise<string> {
  const { registerHook: register } = await import('./registry/index.js');
  const { HookPriority } = await import('./types.js');

  return register(
    event,
    handler,
    options?.priority ?? HookPriority.Normal,
    { name: options?.name }
  );
}
