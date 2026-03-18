/**
 * Workflow Executor
 *
 * Orchestrates workflow step execution, dispatching to verification gates,
 * planning subflows, and bug-hunter scans as appropriate. This is a pure
 * utility module — it does not export MCP tools.
 */

import {
  executeVerificationGate,
  getDefaultGateConfig,
  shouldEscalate,
  createEscalationRecord,
} from './verification-gate.js';
import type {
  VerificationGateResult,
  VerificationGateConfig,
  ConcernPackage,
  CheckCategory,
} from './verification-gate.js';
import { executePlanningSubflow } from './planning-subflow.js';
import { executeBugHunterScan } from './bug-hunter.js';

// ---------------------------------------------------------------------------
// Shared Workflow Module Integration (Gap 2 + Gap 4)
// ---------------------------------------------------------------------------
// Import shared module types and factories. The @hive-flow/shared/workflow
// subpath is resolved via the package.json "exports" map.

import type {
  WorkflowModule,
  ModuleExecutionContext,
  ModuleExecutionResult,
} from '@hive-flow/shared/workflow';

import {
  createInvestigateModule,
  createVerifyModule,
} from '@hive-flow/shared/workflow';

// ---------------------------------------------------------------------------
// Module Registry — maps module names to factory-created WorkflowModule instances
// ---------------------------------------------------------------------------

const moduleRegistry = new Map<string, WorkflowModule>();

function ensureModuleRegistry(): void {
  if (moduleRegistry.size > 0) return;
  // Populate with built-in modules
  const investigate = createInvestigateModule();
  moduleRegistry.set(investigate.name, investigate);

  const verifyInvestigate = createVerifyModule({ sourceModule: 'investigate' });
  moduleRegistry.set(verifyInvestigate.name, verifyInvestigate);
}

/**
 * Get a module from the registry by name.
 * Returns undefined if not found.
 */
export function getRegisteredModule(name: string): WorkflowModule | undefined {
  ensureModuleRegistry();
  return moduleRegistry.get(name);
}

/**
 * Register a custom module in the registry.
 */
export function registerModule(module: WorkflowModule): void {
  ensureModuleRegistry();
  moduleRegistry.set(module.name, module);
}

/**
 * List all registered module names.
 */
export function listRegisteredModules(): string[] {
  ensureModuleRegistry();
  return Array.from(moduleRegistry.keys());
}

// ---------------------------------------------------------------------------
// Status Enum Adapter (Gap 3)
// ---------------------------------------------------------------------------
// CLI statuses:   draft, ready, running, paused, completed, failed
// Module statuses: pending, running, paused, completed, failed, cancelled

const CLI_TO_MODULE_MAP: Record<string, string> = {
  draft: 'pending',
  ready: 'pending',
  running: 'running',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'failed',
};

const MODULE_TO_CLI_MAP: Record<string, string> = {
  pending: 'draft',
  running: 'running',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'failed',
};

export function cliStatusToModuleStatus(status: string): string {
  return CLI_TO_MODULE_MAP[status] ?? status;
}

export function moduleStatusToCliStatus(status: string): string {
  return MODULE_TO_CLI_MAP[status] ?? status;
}

// ---------------------------------------------------------------------------
// Workflow Hook Dispatch (lightweight — no @hive-flow/hooks dependency)
// ---------------------------------------------------------------------------

export interface WorkflowHookDispatcher {
  dispatch(event: string, context: Record<string, unknown>): Promise<{ success: boolean; abort?: boolean }>;
}

let _hookDispatcher: WorkflowHookDispatcher | null = null;

export function setWorkflowHookDispatcher(dispatcher: WorkflowHookDispatcher | null): void {
  _hookDispatcher = dispatcher;
}

export function getWorkflowHookDispatcher(): WorkflowHookDispatcher | null {
  return _hookDispatcher;
}

async function dispatchHook(
  event: string,
  context: Record<string, unknown>,
  options?: { blocking?: boolean },
): Promise<{ success: boolean; abort?: boolean }> {
  if (!_hookDispatcher) return { success: true };
  try {
    const result = await _hookDispatcher.dispatch(event, context);
    if (options?.blocking && result.abort) {
      return { success: false, abort: true };
    }
    return result;
  } catch {
    return { success: false };
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowStepContext {
  workflowId: string;
  step: {
    stepId: string;
    name: string;
    type: 'task' | 'condition' | 'parallel' | 'loop' | 'wait' | 'verification' | 'module';
    config: Record<string, unknown>;
    gateConfig?: {
      fromPhase: string;
      toPhase: string;
      checks: string[];
      minAgents: number;
    };
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting';
    result?: unknown;
  };
  variables: Record<string, unknown>;
  originalRequest?: string;
}

export interface StepExecutionResult {
  stepId: string;
  status: 'completed' | 'failed' | 'waiting';
  result: unknown;
  bugReport?: unknown;
  gateResult?: unknown;
}

// ---------------------------------------------------------------------------
// Complexity calculation
// ---------------------------------------------------------------------------

export function calculateComplexity(workflowContext: Record<string, unknown>): number {
  let complexity = 1;
  const contextStr = JSON.stringify(workflowContext).toLowerCase();

  // File count estimation
  const files = workflowContext.files as string[] | undefined;
  if (files) {
    if (files.length >= 6) {
      complexity += 5;
    } else if (files.length >= 3) {
      complexity += 3;
    } else {
      complexity += 1;
    }
  }

  // Security requirements bump complexity
  if (contextStr.includes('security') || contextStr.includes('auth') || contextStr.includes('encrypt')) {
    complexity += 2;
  }

  // Step count estimation
  const steps = workflowContext.steps as unknown[] | undefined;
  if (steps) {
    if (steps.length >= 6) {
      complexity += 3;
    } else if (steps.length >= 3) {
      complexity += 2;
    } else {
      complexity += 1;
    }
  }

  return complexity;
}

// ---------------------------------------------------------------------------
// Gate rejection handler
// ---------------------------------------------------------------------------

export async function handleGateRejection(
  gate: VerificationGateResult,
  _phaseTeamId: string,
): Promise<ConcernPackage> {
  const failedChecks = gate.checks.filter((c) => c.status === 'failed');

  const lines = [
    `Verification gate ${gate.gateId} (${gate.fromPhase} -> ${gate.toPhase}) rejected phase output.`,
    `Iteration ${gate.iterations}: ${failedChecks.length} check(s) failed.`,
    '',
    'Required remediations:',
  ];

  for (const check of failedChecks) {
    lines.push(`\n[${check.severity.toUpperCase()}] ${check.category} — ${check.description}`);
    for (const finding of check.findings) {
      lines.push(`  - ${finding}`);
    }
  }

  lines.push('\nPlease address all findings and resubmit for re-verification.');

  return {
    iteration: gate.iterations,
    failedChecks,
    remediationRequest: lines.join('\n'),
    submittedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

export async function executeWorkflowStep(
  ctx: WorkflowStepContext,
): Promise<StepExecutionResult> {
  const { step, variables, originalRequest } = ctx;
  const stepName = step.name;
  const stepType = step.type;

  await dispatchHook('phase-start', {
    workflowId: ctx.workflowId || '',
    stepId: step.stepId || '',
    stepName: stepName,
    stepType: stepType,
  });

  // Build workflow context for gates and subflows
  const workflowContext: Record<string, unknown> = {
    ...variables,
    workflowId: ctx.workflowId,
    originalRequest: originalRequest || '',
  };

  // ----- Verification step -----
  if (stepType === 'verification') {
    const result = await executeVerificationStep(ctx, workflowContext);
    await dispatchHook('phase-complete', {
      workflowId: ctx.workflowId || '',
      stepId: step.stepId || '',
      stepName: stepName,
      status: result.status,
    });
    return result;
  }

  // ----- Planning task -----
  if (stepType === 'task' && stepName.startsWith('Planning')) {
    const taskDescription = (step.config.task as string) || stepName;
    const planResult = await executePlanningSubflow(taskDescription, workflowContext);

    const result: StepExecutionResult = {
      stepId: step.stepId,
      status: 'completed',
      result: planResult,
    };
    await dispatchHook('phase-complete', {
      workflowId: ctx.workflowId || '',
      stepId: step.stepId || '',
      stepName: stepName,
      status: result.status,
    });
    return result;
  }

  // ----- Implementation / Testing / Review tasks (with parallel bug-hunter) -----
  if (
    stepType === 'task' &&
    (stepName.includes('Implementation') || stepName.includes('Testing') || stepName.includes('Review'))
  ) {
    const result = await executePhaseWithBugHunter(ctx, workflowContext);
    await dispatchHook('phase-complete', {
      workflowId: ctx.workflowId || '',
      stepId: step.stepId || '',
      stepName: stepName,
      status: result.status,
    });
    return result;
  }

  // ----- Condition step (Gap 5) -----
  if (stepType === 'condition') {
    const result = await executeConditionStep(ctx, workflowContext);
    await dispatchHook('phase-complete', {
      workflowId: ctx.workflowId || '',
      stepId: step.stepId || '',
      stepName: stepName,
      status: result.status,
    });
    return result;
  }

  // ----- Parallel step (Gap 5) -----
  if (stepType === 'parallel') {
    const result = await executeParallelStep(ctx, workflowContext);
    await dispatchHook('phase-complete', {
      workflowId: ctx.workflowId || '',
      stepId: step.stepId || '',
      stepName: stepName,
      status: result.status,
    });
    return result;
  }

  // ----- Loop step (Gap 5) -----
  if (stepType === 'loop') {
    const result = await executeLoopStep(ctx, workflowContext);
    await dispatchHook('phase-complete', {
      workflowId: ctx.workflowId || '',
      stepId: step.stepId || '',
      stepName: stepName,
      status: result.status,
    });
    return result;
  }

  // ----- Wait step (Gap 5) -----
  if (stepType === 'wait') {
    const result = await executeWaitStep(ctx);
    await dispatchHook('phase-complete', {
      workflowId: ctx.workflowId || '',
      stepId: step.stepId || '',
      stepName: stepName,
      status: result.status,
    });
    return result;
  }

  // ----- Module step (Gap 2 + Gap 4) -----
  if (stepType === 'module') {
    const result = await executeModuleStep(ctx, workflowContext);
    await dispatchHook('phase-complete', {
      workflowId: ctx.workflowId || '',
      stepId: step.stepId || '',
      stepName: stepName,
      status: result.status,
    });
    return result;
  }

  // ----- All other step types (fallback) -----
  await dispatchHook('phase-complete', {
    workflowId: ctx.workflowId || '',
    stepId: step.stepId || '',
    stepName: stepName,
    status: 'completed',
  });

  return {
    stepId: step.stepId,
    status: 'completed',
    result: { executed: true },
  };
}

// ---------------------------------------------------------------------------
// Verification step handler
// ---------------------------------------------------------------------------

async function executeVerificationStep(
  ctx: WorkflowStepContext,
  workflowContext: Record<string, unknown>,
): Promise<StepExecutionResult> {
  const { step } = ctx;
  const phaseOutput = (step.config.phaseOutput as Record<string, unknown>) || {};

  await dispatchHook('module-gate-check', {
    workflowId: ctx.workflowId || '',
    stepId: step.stepId || '',
  });

  // Build gate config from step config or use defaults
  let gateConfig: VerificationGateConfig;
  if (step.gateConfig) {
    gateConfig = {
      fromPhase: step.gateConfig.fromPhase,
      toPhase: step.gateConfig.toPhase,
      checks: step.gateConfig.checks as CheckCategory[],
      minAgents: step.gateConfig.minAgents,
      escalationThreshold: getDefaultGateConfig(step.gateConfig.fromPhase, step.gateConfig.toPhase).escalationThreshold,
    };
  } else {
    const fromPhase = (step.config.fromPhase as string) || 'Unknown';
    const toPhase = (step.config.toPhase as string) || 'Unknown';
    gateConfig = getDefaultGateConfig(fromPhase, toPhase);
  }

  const gateResult = await executeVerificationGate(gateConfig, phaseOutput, workflowContext);

  if (gateResult.status === 'passed') {
    return {
      stepId: step.stepId,
      status: 'completed',
      result: { verified: true },
      gateResult,
    };
  }

  // Gate did not pass — check if we should escalate
  const complexity = calculateComplexity(workflowContext);
  if (shouldEscalate(gateResult.iterations, complexity)) {
    const escalation = createEscalationRecord(gateResult, workflowContext);
    gateResult.escalation = escalation;
    gateResult.status = 'escalated';

    if (escalation.decision === 'pass-with-caveats') {
      gateResult.completedAt = new Date().toISOString();
      return {
        stepId: step.stepId,
        status: 'completed',
        result: { verified: true, passedWithCaveats: true, caveats: escalation.caveats },
        gateResult,
      };
    }
  }

  // Gate is waiting for remediation
  return {
    stepId: step.stepId,
    status: 'waiting',
    result: {
      verified: false,
      concerns: gateResult.concerns,
      escalation: gateResult.escalation,
    },
    gateResult,
  };
}

// ---------------------------------------------------------------------------
// Phase execution with parallel bug-hunter
// ---------------------------------------------------------------------------

async function executePhaseWithBugHunter(
  ctx: WorkflowStepContext,
  workflowContext: Record<string, unknown>,
): Promise<StepExecutionResult> {
  const { step } = ctx;
  const files = (step.config.files as string[]) || [];
  const phaseName = step.name;

  // Execute phase task and bug-hunter scan in parallel
  const phaseTaskPromise = executePhaseTask(step, workflowContext);
  // BH-8 fix: extract actual phase keyword from step name (e.g., "Implementation + Bug Hunter" -> "implementation")
  const phaseKeyword = phaseName.replace(/\s*\+\s*Bug Hunter/i, '').replace(/:.*/,'').trim().toLowerCase() as 'implementation' | 'testing' | 'review';
  const bugConfig = { targetPhase: phaseKeyword, scanScope: files, activeScan: false };
  const bugHunterPromise = executeBugHunterScan(bugConfig, ctx.variables);

  const [phaseResult, bugReport] = await Promise.all([phaseTaskPromise, bugHunterPromise]);

  return {
    stepId: step.stepId,
    status: 'completed',
    result: phaseResult,
    bugReport,
  };
}

async function executePhaseTask(
  step: WorkflowStepContext['step'],
  workflowContext: Record<string, unknown>,
): Promise<unknown> {
  // Check if this step references a registered shared module
  const moduleName = (step.config.moduleName as string) || (step.config.module as string);
  if (moduleName) {
    ensureModuleRegistry();
    const mod = moduleRegistry.get(moduleName);
    if (mod) {
      const moduleCtx: ModuleExecutionContext = {
        workflowId: (workflowContext.workflowId as string) || '',
        moduleInstanceId: `${step.stepId}-${moduleName}`,
        inputs: step.config,
        variables: workflowContext,
        previousOutput: (workflowContext._previousOutput as Record<string, unknown>) || undefined,
      };
      const moduleResult = await mod.execute(moduleCtx);
      return {
        phase: step.name,
        executed: true,
        moduleName,
        moduleSuccess: moduleResult.success,
        moduleOutputs: moduleResult.outputs,
        moduleDurationMs: moduleResult.durationMs,
        moduleGateResult: moduleResult.gateResult,
        moduleHiveResult: moduleResult.hiveResult,
        error: moduleResult.error,
        completedAt: new Date().toISOString(),
      };
    }
  }

  // Fallback: The actual phase work is performed by the swarm agents.
  // This function returns the step config as a receipt of execution.
  return {
    phase: step.name,
    executed: true,
    config: step.config,
    completedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Module step handler (Gap 2 + Gap 4)
// ---------------------------------------------------------------------------

async function executeModuleStep(
  ctx: WorkflowStepContext,
  workflowContext: Record<string, unknown>,
): Promise<StepExecutionResult> {
  const { step } = ctx;
  const moduleName = (step.config.moduleName as string) || (step.config.module as string) || step.name;

  ensureModuleRegistry();
  const mod = moduleRegistry.get(moduleName);

  if (!mod) {
    // No registered module found — return a static receipt (backward compat)
    return {
      stepId: step.stepId,
      status: 'completed',
      result: {
        phase: step.name,
        executed: true,
        moduleNotFound: moduleName,
        config: step.config,
        completedAt: new Date().toISOString(),
      },
    };
  }

  const moduleCtx: ModuleExecutionContext = {
    workflowId: ctx.workflowId,
    moduleInstanceId: `${step.stepId}-${moduleName}`,
    inputs: step.config,
    variables: { ...ctx.variables, ...workflowContext },
    previousOutput: (workflowContext._previousOutput as Record<string, unknown>) || undefined,
  };

  const moduleResult = await mod.execute(moduleCtx);

  // Map module status to CLI status
  const cliStatus = moduleResult.success ? 'completed' : 'failed';

  return {
    stepId: step.stepId,
    status: cliStatus as 'completed' | 'failed',
    result: {
      phase: step.name,
      executed: true,
      moduleName,
      moduleSuccess: moduleResult.success,
      moduleOutputs: moduleResult.outputs,
      moduleDurationMs: moduleResult.durationMs,
      moduleGateResult: moduleResult.gateResult,
      moduleHiveResult: moduleResult.hiveResult,
      error: moduleResult.error,
      completedAt: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Condition step handler (Gap 5)
// ---------------------------------------------------------------------------

async function executeConditionStep(
  ctx: WorkflowStepContext,
  workflowContext: Record<string, unknown>,
): Promise<StepExecutionResult> {
  const { step } = ctx;
  const conditionExpr = (step.config.condition as string) || '';
  const thenBranch = step.config.then as string | undefined;
  const elseBranch = step.config.else as string | undefined;

  // Evaluate condition against workflow variables
  let conditionResult = false;
  try {
    if (conditionExpr) {
      // Simple variable-based condition evaluation
      // Supports: "variableName", "variableName == value", "variableName != value"
      const eqMatch = conditionExpr.match(/^(\w+)\s*==\s*(.+)$/);
      const neqMatch = conditionExpr.match(/^(\w+)\s*!=\s*(.+)$/);
      const existsMatch = conditionExpr.match(/^(\w+)$/);

      if (eqMatch) {
        const [, varName, expected] = eqMatch;
        conditionResult = String(workflowContext[varName]) === expected.trim().replace(/^["']|["']$/g, '');
      } else if (neqMatch) {
        const [, varName, expected] = neqMatch;
        conditionResult = String(workflowContext[varName]) !== expected.trim().replace(/^["']|["']$/g, '');
      } else if (existsMatch) {
        conditionResult = Boolean(workflowContext[existsMatch[1]]);
      }
    }
  } catch {
    conditionResult = false;
  }

  return {
    stepId: step.stepId,
    status: 'completed',
    result: {
      condition: conditionExpr,
      evaluated: conditionResult,
      selectedBranch: conditionResult ? (thenBranch || 'then') : (elseBranch || 'else'),
      completedAt: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Parallel step handler (Gap 5)
// ---------------------------------------------------------------------------

async function executeParallelStep(
  ctx: WorkflowStepContext,
  workflowContext: Record<string, unknown>,
): Promise<StepExecutionResult> {
  const { step } = ctx;
  const branches = (step.config.branches as Array<{ name: string; config?: Record<string, unknown> }>) || [];
  const failureStrategy = (step.config.failureStrategy as string) || 'fail-fast';

  // Execute all branches concurrently
  const branchPromises = branches.map(async (branch) => {
    const branchCtx: WorkflowStepContext = {
      workflowId: ctx.workflowId,
      step: {
        stepId: `${step.stepId}-${branch.name}`,
        name: branch.name,
        type: 'task',
        config: branch.config || {},
        status: 'running',
      },
      variables: { ...ctx.variables, ...workflowContext },
    };

    try {
      return await executePhaseTask(branchCtx.step, workflowContext);
    } catch (err) {
      return {
        branch: branch.name,
        error: err instanceof Error ? err.message : String(err),
        failed: true,
      };
    }
  });

  let branchResults: unknown[];
  if (failureStrategy === 'fail-fast') {
    branchResults = await Promise.all(branchPromises);
  } else {
    // continue-on-error: collect all results
    branchResults = await Promise.allSettled(branchPromises).then(results =>
      results.map(r => r.status === 'fulfilled' ? r.value : { error: (r.reason as Error)?.message })
    );
  }

  const failedCount = branchResults.filter(
    r => r && typeof r === 'object' && 'failed' in r && (r as Record<string, unknown>).failed
  ).length;

  return {
    stepId: step.stepId,
    status: failedCount > 0 && failureStrategy === 'fail-fast' ? 'failed' : 'completed',
    result: {
      branches: branches.map((b, i) => ({
        name: b.name,
        result: branchResults[i],
      })),
      totalBranches: branches.length,
      completedBranches: branches.length - failedCount,
      failedBranches: failedCount,
      completedAt: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Loop step handler (Gap 5)
// ---------------------------------------------------------------------------

async function executeLoopStep(
  ctx: WorkflowStepContext,
  workflowContext: Record<string, unknown>,
): Promise<StepExecutionResult> {
  const { step } = ctx;
  const maxIterations = (step.config.maxIterations as number) || 10;
  const conditionExpr = (step.config.condition as string) || '';
  const loopBody = step.config.body as Record<string, unknown> | undefined;

  const iterations: Array<{ iteration: number; result: unknown }> = [];
  let iterationCount = 0;

  while (iterationCount < maxIterations) {
    iterationCount++;

    // Execute loop body
    const bodyResult = loopBody ? {
      iteration: iterationCount,
      executed: true,
      body: loopBody,
      completedAt: new Date().toISOString(),
    } : { iteration: iterationCount, executed: true };

    // Propagate body results back into workflow context (BH-15)
    // so the exit condition can evaluate updated state
    if (loopBody && typeof loopBody === 'object') {
      for (const [key, value] of Object.entries(loopBody)) {
        workflowContext[key] = value;
      }
    }

    iterations.push({ iteration: iterationCount, result: bodyResult });

    // Check exit condition
    if (conditionExpr) {
      // Simple "until" condition: check if a variable equals a value
      const eqMatch = conditionExpr.match(/^(\w+)\s*==\s*(.+)$/);
      if (eqMatch) {
        const [, varName, expected] = eqMatch;
        if (String(workflowContext[varName]) === expected.trim().replace(/^["']|["']$/g, '')) {
          break;
        }
      } else {
        // If no condition match, just run once
        break;
      }
    } else {
      // No condition — run maxIterations times
      // For safety, break after first iteration if no condition
      if (iterationCount >= maxIterations) break;
    }
  }

  return {
    stepId: step.stepId,
    status: 'completed',
    result: {
      iterations,
      totalIterations: iterationCount,
      maxIterations,
      exitCondition: conditionExpr || 'max-iterations-reached',
      completedAt: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Wait step handler (Gap 5)
// ---------------------------------------------------------------------------

async function executeWaitStep(
  ctx: WorkflowStepContext,
): Promise<StepExecutionResult> {
  const { step } = ctx;
  const waitType = (step.config.waitType as string) || 'duration';
  const durationMs = (step.config.durationMs as number) || 0;
  const waitForEvent = step.config.event as string | undefined;

  if (waitType === 'duration' && durationMs > 0) {
    // Cap wait duration at 30 seconds for safety
    const cappedDuration = Math.min(durationMs, 30000);
    await new Promise(resolve => setTimeout(resolve, cappedDuration));

    return {
      stepId: step.stepId,
      status: 'completed',
      result: {
        waitType: 'duration',
        requestedMs: durationMs,
        actualMs: cappedDuration,
        completedAt: new Date().toISOString(),
      },
    };
  }

  if (waitType === 'event' && waitForEvent) {
    // Event-based wait: return 'waiting' status so the workflow can pause
    // and resume when the event is received
    return {
      stepId: step.stepId,
      status: 'waiting',
      result: {
        waitType: 'event',
        event: waitForEvent,
        waitingSince: new Date().toISOString(),
      },
    };
  }

  // No wait configured — pass through
  return {
    stepId: step.stepId,
    status: 'completed',
    result: {
      waitType,
      skipped: true,
      reason: 'No valid wait configuration',
      completedAt: new Date().toISOString(),
    },
  };
}
