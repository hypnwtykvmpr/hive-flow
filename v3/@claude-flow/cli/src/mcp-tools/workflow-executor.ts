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
// Types
// ---------------------------------------------------------------------------

export interface WorkflowStepContext {
  workflowId: string;
  step: {
    stepId: string;
    name: string;
    type: 'task' | 'condition' | 'parallel' | 'loop' | 'wait' | 'verification';
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

  // Build workflow context for gates and subflows
  const workflowContext: Record<string, unknown> = {
    ...variables,
    workflowId: ctx.workflowId,
    originalRequest: originalRequest || '',
  };

  // ----- Verification step -----
  if (stepType === 'verification') {
    return await executeVerificationStep(ctx, workflowContext);
  }

  // ----- Planning task -----
  if (stepType === 'task' && stepName.startsWith('Planning')) {
    const taskDescription = (step.config.task as string) || stepName;
    const planResult = await executePlanningSubflow(taskDescription, workflowContext);

    return {
      stepId: step.stepId,
      status: 'completed',
      result: planResult,
    };
  }

  // ----- Implementation / Testing / Review tasks (with parallel bug-hunter) -----
  if (
    stepType === 'task' &&
    (stepName.includes('Implementation') || stepName.includes('Testing') || stepName.includes('Review'))
  ) {
    return await executePhaseWithBugHunter(ctx, workflowContext);
  }

  // ----- All other step types -----
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
  const bugConfig = { targetPhase: phaseName as 'implementation' | 'testing' | 'review', scanScope: files, activeScan: false };
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
  _workflowContext: Record<string, unknown>,
): Promise<unknown> {
  // The actual phase work is performed by the swarm agents.
  // This function returns the step config as a receipt of execution.
  return {
    phase: step.name,
    executed: true,
    config: step.config,
    completedAt: new Date().toISOString(),
  };
}
