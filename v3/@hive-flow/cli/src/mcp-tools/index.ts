/**
 * MCP Tools Index for CLI
 *
 * Re-exports all tool definitions for use within the CLI package.
 */

export type { MCPTool, MCPToolInputSchema, MCPToolResult } from './types.js';
export { agentTools } from './agent-tools.js';
export { swarmTools } from './swarm-tools.js';
export { memoryTools } from './memory-tools.js';
export { configTools } from './config-tools.js';
export { hooksTools } from './hooks-tools.js';
export { taskTools } from './task-tools.js';
export { sessionTools } from './session-tools.js';
export { hiveMindTools } from './hive-mind-tools.js';
export { workflowTools } from './workflow-tools.js';
export { coverageRouterTools } from '../ruvector/coverage-tools.js';
export { analyzeTools } from './analyze-tools.js';
export { progressTools } from './progress-tools.js';
export { transferTools } from './transfer-tools.js';
export { securityTools } from './security-tools.js';
export { embeddingsTools } from './embeddings-tools.js';
export { claimsTools } from './claims-tools.js';
export { providerTools } from './provider-tools.js';
export { verificationGateTools } from './verification-gate.js';
export { planningSubflowTools } from './planning-subflow.js';
export { isAmbiguityGenuine, resolveAuthorizedAmbiguity, type AmbiguityAssessment, type IntentAuditResult, type IntentAuditScore } from './ambiguity-filter.js';
export { bugHunterTools } from './bug-hunter.js';
export { neuralTools } from './neural-tools.js';
export { workflowEnforcerTools, mapLevelToFlow, validateOptOut, getOrCreateHmacKey, signPayload } from './workflow-enforcer.js';
export { queenTools } from './queen-tools.js';
export type { HiveRecord, HiveWorkerRecord, HiveMission, HiveAuditEntry, HiveBudget, ModuleHiveConfig, HiveStatus, DelegationMetrics } from './hive-store.js';
export { transitionAgent, propagateEnforcementToSubAgent } from './agent-tools.js';
export type {
  ComplexityLevel,
  ComplexityAssessment,
  ComplexitySignal,
  RequiredFlow,
  AgentModelTier,
  FlowComponentConfig,
  PlanningSubflowConfig,
  VerificationGatesConfig,
  AmbiguityFilterConfig,
  DualAgentAuditConfig,
  EnforcementState,
  EnforcementOverride,
  EnforcementAuditEntry,
} from './workflow-enforcer.js';

// Wire up workflow hook dispatcher (optional — only if @hive-flow/hooks is available)
(async () => {
  try {
    const hooksModuleId = '@hive-flow/hooks';
    const hooks = await import(/* webpackIgnore: true */ hooksModuleId);
    if (hooks.HookExecutor && hooks.defaultRegistry) {
      const executor = new hooks.HookExecutor(hooks.defaultRegistry);
      const { setWorkflowHookDispatcher } = await import('./workflow-executor.js');
      setWorkflowHookDispatcher({
        async dispatch(event: string, context: Record<string, unknown>) {
          const result = await executor.execute(event, {
            metadata: context,
            workflow: {
              workflowId: (context.workflowId as string) || '',
              stepId: (context.stepId as string) || '',
              stepName: (context.stepName as string) || '',
              status: (context.status as string) || '',
            },
          }, { continueOnError: true, timeout: 5000 });
          return { success: result.success, abort: result.aborted };
        },
      });
    }
  } catch {
    // @hive-flow/hooks not available — workflow hooks disabled (non-blocking)
  }
})();
