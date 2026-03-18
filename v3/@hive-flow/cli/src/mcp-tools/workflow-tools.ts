/**
 * Workflow MCP Tools for CLI
 *
 * Tool definitions for workflow automation and orchestration.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MCPTool } from './types.js';
import { executeWorkflowStep, getWorkflowHookDispatcher } from './workflow-executor.js';
import type { WorkflowStepContext } from './workflow-executor.js';

async function dispatchWorkflowHook(event: string, context: Record<string, unknown>): Promise<void> {
  const dispatcher = getWorkflowHookDispatcher();
  if (!dispatcher) return;
  try {
    await dispatcher.dispatch(event, context);
  } catch {
    // Hook failure never crashes workflows
  }
}

// Storage paths
const STORAGE_DIR = '.hive-flow';
const WORKFLOW_DIR = 'workflows';
const WORKFLOW_FILE = 'store.json';

interface WorkflowStep {
  stepId: string;
  name: string;
  type: 'task' | 'condition' | 'parallel' | 'loop' | 'wait' | 'verification' | 'module';
  config: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting';
  result?: unknown;
  startedAt?: string;
  completedAt?: string;
  gateConfig?: {
    fromPhase: string;
    toPhase: string;
    checks: string[];
    minAgents: number;
  };
}

interface WorkflowRecord {
  workflowId: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  status: 'draft' | 'ready' | 'running' | 'paused' | 'completed' | 'failed';
  currentStep: number;
  variables: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

interface WorkflowStore {
  workflows: Record<string, WorkflowRecord>;
  templates: Record<string, WorkflowRecord>;
  version: string;
}

function getWorkflowDir(): string {
  return join(process.cwd(), STORAGE_DIR, WORKFLOW_DIR);
}

function getWorkflowPath(): string {
  return join(getWorkflowDir(), WORKFLOW_FILE);
}

function ensureWorkflowDir(): void {
  const dir = getWorkflowDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadWorkflowStore(): WorkflowStore {
  try {
    const path = getWorkflowPath();
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // Return default store on error
  }
  return { workflows: {}, templates: {}, version: '3.0.0' };
}

function saveWorkflowStore(store: WorkflowStore): void {
  ensureWorkflowDir();
  const targetPath = getWorkflowPath();
  const tmpPath = targetPath + '.tmp.' + process.pid;
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmpPath, targetPath);
}

// ---------------------------------------------------------------------------
// Shared step execution loop (extracted from workflow_execute/resume/run)
// ---------------------------------------------------------------------------

export interface ExecuteStepLoopParams {
  workflow: WorkflowRecord;
  steps: WorkflowStep[];
  startIndex: number;
  dispatchFailHook: boolean;
  dispatchCompleteHook: boolean;
  extraReturnFields: Record<string, unknown>;
  saveStore: () => void;
}

export interface StepLoopResult {
  completed: boolean;
  results: Array<{ stepId: string; status: string }>;
  /** Set when workflow paused on a gate wait */
  pausedAt?: string;
  pauseReason?: string;
  /** Error info when a step throws */
  error?: string;
  failedStep?: string;
}

export async function executeStepLoop(params: ExecuteStepLoopParams): Promise<StepLoopResult> {
  const { workflow, steps, startIndex, dispatchFailHook, dispatchCompleteHook, saveStore } = params;

  const results: Array<{ stepId: string; status: string }> = [];

  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];
    step.status = 'running';
    step.startedAt = new Date().toISOString();

    const stepCtx: WorkflowStepContext = {
      workflowId: workflow.workflowId,
      step: {
        stepId: step.stepId,
        name: step.name,
        type: step.type,
        config: step.config,
        gateConfig: step.gateConfig,
        status: step.status,
      },
      variables: workflow.variables,
      originalRequest: workflow.variables.originalRequest as string | undefined,
    };

    await dispatchWorkflowHook('module-start', {
      workflowId: workflow.workflowId,
      stepId: step.stepId,
      stepName: step.name,
      stepType: step.type,
    });

    let stepResult;
    try {
      stepResult = await executeWorkflowStep(stepCtx);
    } catch (stepError: unknown) {
      step.status = 'failed';
      step.completedAt = new Date().toISOString();
      workflow.status = 'failed';
      workflow.error = stepError instanceof Error ? stepError.message : String(stepError);
      workflow.completedAt = new Date().toISOString();
      saveStore();

      if (dispatchFailHook) {
        await dispatchWorkflowHook('workflow-failed', {
          workflowId: workflow.workflowId,
          name: workflow.name,
          error: workflow.error,
        });
      }

      return {
        completed: false,
        results,
        error: workflow.error,
        failedStep: step.name,
      };
    }

    step.status = stepResult.status;
    step.completedAt = new Date().toISOString();
    step.result = stepResult.result;

    await dispatchWorkflowHook('module-complete', {
      workflowId: workflow.workflowId,
      stepId: step.stepId,
      stepName: step.name,
      status: stepResult.status,
    });

    // If gate is waiting for phase team remediation, pause workflow
    if (stepResult.status === 'waiting') {
      workflow.status = 'paused';
      workflow.currentStep = i;
      saveStore();
      return {
        completed: false,
        results,
        pausedAt: step.name,
        pauseReason: 'Verification gate awaiting phase team remediation',
      };
    }

    results.push({ stepId: step.stepId, status: step.status });
    workflow.currentStep = i + 1;
    saveStore();
  }

  workflow.status = 'completed';
  workflow.completedAt = new Date().toISOString();

  if (dispatchCompleteHook) {
    await dispatchWorkflowHook('workflow-complete', {
      workflowId: workflow.workflowId,
      name: workflow.name,
      stepsExecuted: results.length,
    });
  }

  saveStore();

  return { completed: true, results };
}

export const workflowTools: MCPTool[] = [
  {
    name: 'workflow_create',
    description: 'Create a new workflow',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name' },
        description: { type: 'string', description: 'Workflow description' },
        steps: {
          type: 'array',
          description: 'Workflow steps',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['task', 'condition', 'parallel', 'loop', 'wait', 'verification'] },
              config: { type: 'object' },
            },
          },
        },
        variables: { type: 'object', description: 'Initial variables' },
      },
      required: ['name'],
    },
    handler: async (input) => {
      const store = loadWorkflowStore();
      const workflowId = `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const steps: WorkflowStep[] = ((input.steps as Array<{name?: string; type?: string; config?: Record<string, unknown>}>) || []).map((s, i) => ({
        stepId: `step-${i + 1}`,
        name: s.name || `Step ${i + 1}`,
        type: (s.type as WorkflowStep['type']) || 'task',
        config: s.config || {} as Record<string, unknown>,
        status: 'pending' as const,
      }));

      const workflow: WorkflowRecord = {
        workflowId,
        name: input.name as string,
        description: input.description as string,
        steps,
        status: steps.length > 0 ? 'ready' : 'draft',
        currentStep: 0,
        variables: (input.variables as Record<string, unknown>) || {},
        createdAt: new Date().toISOString(),
      };

      store.workflows[workflowId] = workflow;
      saveWorkflowStore(store);

      return {
        workflowId,
        name: workflow.name,
        status: workflow.status,
        stepCount: steps.length,
        createdAt: workflow.createdAt,
      };
    },
  },
  {
    name: 'workflow_execute',
    description: 'Execute a workflow',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID to execute' },
        variables: { type: 'object', description: 'Runtime variables to inject' },
        startFromStep: { type: 'number', description: 'Step to start from (0-indexed)' },
      },
      required: ['workflowId'],
    },
    handler: async (input) => {
      const store = loadWorkflowStore();
      const workflowId = input.workflowId as string;
      const workflow = store.workflows[workflowId];

      if (!workflow) {
        return { workflowId, error: 'Workflow not found' };
      }

      if (workflow.status === 'running') {
        return { workflowId, error: 'Workflow already running' };
      }

      // Inject runtime variables
      if (input.variables) {
        workflow.variables = { ...workflow.variables, ...(input.variables as Record<string, unknown>) };
      }

      workflow.status = 'running';
      workflow.startedAt = new Date().toISOString();
      workflow.currentStep = (input.startFromStep as number) ?? 0;

      await dispatchWorkflowHook('workflow-start', {
        workflowId,
        name: workflow.name,
        stepCount: workflow.steps.length,
      });

      const loopResult = await executeStepLoop({
        workflow,
        steps: workflow.steps,
        startIndex: workflow.currentStep,
        dispatchFailHook: true,
        dispatchCompleteHook: true,
        extraReturnFields: {},
        saveStore: () => saveWorkflowStore(store),
      });

      if (loopResult.error) {
        return { success: false, workflowId: workflow.workflowId, error: loopResult.error, step: loopResult.failedStep };
      }

      if (loopResult.pausedAt) {
        return {
          workflowId,
          status: workflow.status,
          stepsExecuted: loopResult.results.length,
          results: loopResult.results,
          pausedAt: loopResult.pausedAt,
          pauseReason: loopResult.pauseReason,
          startedAt: workflow.startedAt,
        };
      }

      return {
        workflowId,
        status: workflow.status,
        stepsExecuted: loopResult.results.length,
        results: loopResult.results,
        startedAt: workflow.startedAt,
        completedAt: workflow.completedAt,
        duration: new Date(workflow.completedAt!).getTime() - new Date(workflow.startedAt!).getTime(),
      };
    },
  },
  {
    name: 'workflow_status',
    description: 'Get workflow status',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID' },
        verbose: { type: 'boolean', description: 'Include step details' },
      },
      required: ['workflowId'],
    },
    handler: async (input) => {
      const store = loadWorkflowStore();
      const workflowId = input.workflowId as string;
      const workflow = store.workflows[workflowId];

      if (!workflow) {
        return { workflowId, error: 'Workflow not found' };
      }

      const completedSteps = workflow.steps.filter(s => s.status === 'completed').length;
      const progress = workflow.steps.length > 0 ? (completedSteps / workflow.steps.length) * 100 : 0;

      const status = {
        workflowId: workflow.workflowId,
        name: workflow.name,
        status: workflow.status,
        progress,
        currentStep: workflow.currentStep,
        totalSteps: workflow.steps.length,
        completedSteps,
        createdAt: workflow.createdAt,
        startedAt: workflow.startedAt,
        completedAt: workflow.completedAt,
      };

      if (input.verbose) {
        return {
          ...status,
          description: workflow.description,
          variables: workflow.variables,
          steps: workflow.steps.map(s => ({
            stepId: s.stepId,
            name: s.name,
            type: s.type,
            status: s.status,
            startedAt: s.startedAt,
            completedAt: s.completedAt,
          })),
          error: workflow.error,
        };
      }

      return status;
    },
  },
  {
    name: 'workflow_list',
    description: 'List all workflows',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status' },
        limit: { type: 'number', description: 'Max workflows to return' },
      },
    },
    handler: async (input) => {
      const store = loadWorkflowStore();
      let workflows = Object.values(store.workflows);

      // Apply filters
      if (input.status) {
        workflows = workflows.filter(w => w.status === input.status);
      }

      // Sort by creation date (newest first)
      workflows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      // Apply limit
      const limit = (input.limit as number) || 20;
      workflows = workflows.slice(0, limit);

      return {
        workflows: workflows.map(w => ({
          workflowId: w.workflowId,
          name: w.name,
          status: w.status,
          stepCount: w.steps.length,
          createdAt: w.createdAt,
          completedAt: w.completedAt,
        })),
        total: workflows.length,
        filters: { status: input.status },
      };
    },
  },
  {
    name: 'workflow_pause',
    description: 'Pause a running workflow',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID' },
      },
      required: ['workflowId'],
    },
    handler: async (input) => {
      const store = loadWorkflowStore();
      const workflowId = input.workflowId as string;
      const workflow = store.workflows[workflowId];

      if (!workflow) {
        return { workflowId, error: 'Workflow not found' };
      }

      if (workflow.status !== 'running') {
        return { workflowId, error: 'Workflow not running' };
      }

      workflow.status = 'paused';
      saveWorkflowStore(store);

      return {
        workflowId,
        status: workflow.status,
        pausedAt: new Date().toISOString(),
        currentStep: workflow.currentStep,
      };
    },
  },
  {
    name: 'workflow_resume',
    description: 'Resume a paused workflow',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID' },
      },
      required: ['workflowId'],
    },
    handler: async (input) => {
      const store = loadWorkflowStore();
      const workflowId = input.workflowId as string;
      const workflow = store.workflows[workflowId];

      if (!workflow) {
        return { workflowId, error: 'Workflow not found' };
      }

      if (workflow.status !== 'paused') {
        return { workflowId, error: 'Workflow not paused' };
      }

      workflow.status = 'running';
      saveWorkflowStore(store);

      const loopResult = await executeStepLoop({
        workflow,
        steps: workflow.steps,
        startIndex: workflow.currentStep,
        dispatchFailHook: true,
        dispatchCompleteHook: true,
        extraReturnFields: { resumed: true },
        saveStore: () => saveWorkflowStore(store),
      });

      if (loopResult.error) {
        return { success: false, workflowId, error: loopResult.error, step: loopResult.failedStep };
      }

      if (loopResult.pausedAt) {
        return {
          workflowId,
          status: workflow.status,
          resumed: true,
          stepsExecuted: loopResult.results.length,
          pausedAt: loopResult.pausedAt,
          pauseReason: loopResult.pauseReason,
        };
      }

      return {
        workflowId,
        status: workflow.status,
        resumed: true,
        stepsExecuted: loopResult.results.length,
        completedAt: workflow.completedAt,
      };
    },
  },
  {
    name: 'workflow_cancel',
    description: 'Cancel a workflow',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID' },
        reason: { type: 'string', description: 'Cancellation reason' },
      },
      required: ['workflowId'],
    },
    handler: async (input) => {
      const store = loadWorkflowStore();
      const workflowId = input.workflowId as string;
      const workflow = store.workflows[workflowId];

      if (!workflow) {
        return { workflowId, error: 'Workflow not found' };
      }

      if (workflow.status === 'completed' || workflow.status === 'failed') {
        return { workflowId, error: 'Workflow already finished' };
      }

      workflow.status = 'failed';
      workflow.error = (input.reason as string) || 'Cancelled by user';
      workflow.completedAt = new Date().toISOString();

      // Mark remaining steps as skipped
      for (let i = workflow.currentStep; i < workflow.steps.length; i++) {
        workflow.steps[i].status = 'skipped';
      }

      saveWorkflowStore(store);

      return {
        workflowId,
        status: workflow.status,
        cancelledAt: workflow.completedAt,
        reason: workflow.error,
        skippedSteps: workflow.steps.length - workflow.currentStep,
      };
    },
  },
  {
    name: 'workflow_delete',
    description: 'Delete a workflow',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID' },
      },
      required: ['workflowId'],
    },
    handler: async (input) => {
      const store = loadWorkflowStore();
      const workflowId = input.workflowId as string;

      if (!store.workflows[workflowId]) {
        return { workflowId, error: 'Workflow not found' };
      }

      const workflow = store.workflows[workflowId];
      if (workflow.status === 'running') {
        return { workflowId, error: 'Cannot delete running workflow' };
      }

      delete store.workflows[workflowId];
      saveWorkflowStore(store);

      return {
        workflowId,
        deleted: true,
        deletedAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'workflow_template',
    description: 'Save workflow as template or create from template',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'create', 'list'], description: 'Template action' },
        workflowId: { type: 'string', description: 'Workflow ID (for save)' },
        templateId: { type: 'string', description: 'Template ID (for create)' },
        templateName: { type: 'string', description: 'Template name (for save)' },
        newName: { type: 'string', description: 'New workflow name (for create)' },
      },
      required: ['action'],
    },
    handler: async (input) => {
      const store = loadWorkflowStore();
      const action = input.action as string;

      if (action === 'save') {
        const workflow = store.workflows[input.workflowId as string];
        if (!workflow) {
          return { action, error: 'Workflow not found' };
        }

        const templateId = `template-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const template: WorkflowRecord = {
          ...workflow,
          workflowId: templateId,
          name: (input.templateName as string) || `${workflow.name} Template`,
          status: 'draft',
          currentStep: 0,
          createdAt: new Date().toISOString(),
          startedAt: undefined,
          completedAt: undefined,
        };

        // Reset step statuses
        template.steps = template.steps.map(s => ({
          ...s,
          status: 'pending',
          result: undefined,
          startedAt: undefined,
          completedAt: undefined,
        }));

        store.templates[templateId] = template;
        saveWorkflowStore(store);

        return {
          action,
          templateId,
          name: template.name,
          savedAt: new Date().toISOString(),
        };
      }

      if (action === 'create') {
        const template = store.templates[input.templateId as string];
        if (!template) {
          return { action, error: 'Template not found' };
        }

        const workflowId = `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const workflow: WorkflowRecord = {
          ...template,
          workflowId,
          name: (input.newName as string) || template.name.replace(' Template', ''),
          status: 'ready',
          createdAt: new Date().toISOString(),
        };

        store.workflows[workflowId] = workflow;
        saveWorkflowStore(store);

        return {
          action,
          workflowId,
          name: workflow.name,
          fromTemplate: input.templateId,
          createdAt: workflow.createdAt,
        };
      }

      if (action === 'list') {
        return {
          action,
          templates: Object.values(store.templates).map(t => ({
            templateId: t.workflowId,
            name: t.name,
            stepCount: t.steps.length,
            createdAt: t.createdAt,
          })),
          total: Object.keys(store.templates).length,
        };
      }

      return { action, error: 'Unknown action' };
    },
  },
  {
    name: 'workflow_run',
    description: 'Run a workflow (alias for workflow_execute with template support)',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Workflow template name' },
        file: { type: 'string', description: 'Workflow definition file' },
        task: { type: 'string', description: 'Task description' },
        options: { type: 'object', description: 'Execution options' },
      },
    },
    handler: async (input) => {
      const template = input.template as string;
      const task = (input.task as string) || '';
      const options = (input.options as Record<string, unknown>) || {};
      const store = loadWorkflowStore();

      // Create workflow from template
      const workflowId = `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const stages = getDefaultStages(template);
      const agents = getDefaultAgents(template);

      const steps: WorkflowStep[] = stages.map((name, i) => ({
        stepId: `step-${i + 1}`,
        name,
        type: name.startsWith('Verify:') ? 'verification' as const : 'task' as const,
        config: { task, template },
        status: 'pending' as const,
        ...(name.startsWith('Verify:') ? {
          gateConfig: parseGateConfig(name),
        } : {}),
      }));

      const workflow: WorkflowRecord = {
        workflowId,
        name: `${template} workflow`,
        description: task,
        steps,
        status: options.dryRun ? 'draft' : 'ready',
        currentStep: 0,
        variables: { originalRequest: task, template },
        createdAt: new Date().toISOString(),
      };

      store.workflows[workflowId] = workflow;
      saveWorkflowStore(store);

      // Gap 1 fix: workflow_run now actually chains create -> execute
      // Gap 7 (minor): detect module references and delegate to module executor
      // If input.file is provided (Gap 4), parse it as a module chain definition
      const filePath = input.file as string | undefined;
      if (filePath) {
        // Validate file path — prevent reading sensitive/protected files
        const resolvedPath = resolve(filePath);
        const cwd = process.cwd();
        if (!resolvedPath.startsWith(cwd)) {
          return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'File path must be within the project directory' }) }] };
        }
        const protectedPatterns = [/\.env/, /\.hive-flow\/enforcement/, /\.claude\/helpers/, /\.claude\/settings/];
        const relPath = resolvedPath.slice(cwd.length + 1);
        if (protectedPatterns.some(p => p.test(relPath))) {
          return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Cannot read protected files' }) }] };
        }

        try {
          // BH-1 fix: use resolvedPath (validated above) instead of raw filePath
          const fileContent = readFileSync(resolvedPath, 'utf-8');
          const fileDef = JSON.parse(fileContent);
          // If the file contains a modules array, treat it as a module chain
          if (fileDef.modules && Array.isArray(fileDef.modules)) {
            // Store module chain info in workflow variables for the executor
            workflow.variables.moduleChain = fileDef.modules;
            workflow.variables.sharedState = fileDef.sharedState || {};
            // Gap 4: Create steps from module definitions with type 'module'
            // so the executor routes them to the module registry
            workflow.steps = fileDef.modules.map((mod: { moduleName?: string; name?: string }, i: number) => ({
              stepId: `step-${i + 1}`,
              name: mod.moduleName || mod.name || `Module ${i + 1}`,
              type: 'module' as const,
              config: { ...mod, moduleName: mod.moduleName || mod.name, task },
              status: 'pending' as const,
            }));
          } else if (fileDef.steps && Array.isArray(fileDef.steps)) {
            // Standard step-based workflow definition
            workflow.steps = fileDef.steps.map((s: { name?: string; type?: string; config?: Record<string, unknown> }, i: number) => ({
              stepId: `step-${i + 1}`,
              name: s.name || `Step ${i + 1}`,
              type: (s.type as WorkflowStep['type']) || 'task',
              config: s.config || {},
              status: 'pending' as const,
            }));
          }
          workflow.status = workflow.steps.length > 0 ? 'ready' : 'draft';
          store.workflows[workflowId] = workflow;
          saveWorkflowStore(store);
        } catch (fileErr) {
          return {
            workflowId,
            error: `Failed to parse workflow file: ${fileErr instanceof Error ? fileErr.message : String(fileErr)}`,
          };
        }
      }

      if (options.dryRun) {
        return {
          workflowId,
          template: template || 'custom',
          status: 'validated' as const,
          stages: workflow.steps.map(s => ({
            name: s.name,
            status: s.status,
            agents: s.type === 'verification' ? ['verifier'] : agents,
          })),
          metrics: {
            totalStages: workflow.steps.length,
            completedStages: 0,
            agentsSpawned: 0,
            estimatedDuration: getDefaultDuration(template),
          },
        };
      }

      // Chain to workflow_execute for actual execution (Gap 1 fix)
      workflow.status = 'running';
      workflow.startedAt = new Date().toISOString();
      saveWorkflowStore(store);

      const loopResult = await executeStepLoop({
        workflow,
        steps: workflow.steps,
        startIndex: 0,
        dispatchFailHook: true,
        dispatchCompleteHook: true,
        extraReturnFields: { template: template || 'custom' },
        saveStore: () => saveWorkflowStore(store),
      });

      if (loopResult.error) {
        return { success: false, workflowId, error: loopResult.error, step: loopResult.failedStep };
      }

      if (loopResult.pausedAt) {
        return {
          workflowId,
          template: template || 'custom',
          status: 'paused' as const,
          stepsExecuted: loopResult.results.length,
          pausedAt: loopResult.pausedAt,
          pauseReason: loopResult.pauseReason,
        };
      }

      return {
        workflowId,
        template: template || 'custom',
        status: workflow.status,
        stepsExecuted: loopResult.results.length,
        results: loopResult.results,
        startedAt: workflow.startedAt,
        completedAt: workflow.completedAt,
        metrics: {
          totalStages: workflow.steps.length,
          completedStages: loopResult.results.filter(r => r.status === 'completed').length,
          agentsSpawned: agents.length,
          estimatedDuration: getDefaultDuration(template),
        },
      };
    },
  },
];

// ============================================================================
// Pipeline State Helpers (inline — avoids CJS/ESM boundary crossing)
// ============================================================================

// Derive project root from this module's location (Finding 2: HMAC key path mismatch).
// workflow-tools.ts lives at: <root>/v3/@hive-flow/cli/src/mcp-tools/workflow-tools.ts
// Traversing up 5 levels:       mcp-tools -> src -> cli -> @hive-flow -> v3 -> <root>
const __wfFilename = fileURLToPath(import.meta.url);
const __wfDirname = dirname(__wfFilename);
const PIPELINE_PROJECT_ROOT = resolve(__wfDirname, '..', '..', '..', '..', '..');
const PIPELINE_ENFORCEMENT_DIR = join(PIPELINE_PROJECT_ROOT, '.hive-flow', 'enforcement');
const PIPELINE_STATE_PATH = join(PIPELINE_ENFORCEMENT_DIR, 'pipeline-state.json');
const PIPELINE_HMAC_KEY_FILE = join(PIPELINE_ENFORCEMENT_DIR, '.hmac-key');
const PIPELINE_VIOLATIONS_FILE = join(PIPELINE_ENFORCEMENT_DIR, 'violations.jsonl');

function getPipelineHmacKey(): string {
  try {
    if (existsSync(PIPELINE_HMAC_KEY_FILE)) {
      return readFileSync(PIPELINE_HMAC_KEY_FILE, 'utf-8').trim();
    }
  } catch { /* fall through */ }
  const key = randomBytes(32).toString('hex');
  try {
    mkdirSync(PIPELINE_ENFORCEMENT_DIR, { recursive: true });
    writeFileSync(PIPELINE_HMAC_KEY_FILE, key, { mode: 0o600 });
  } catch { /* ephemeral key */ }
  return key;
}

function pipelineComputeHmac(data: unknown): string {
  const key = getPipelineHmacKey();
  return createHmac('sha256', key).update(JSON.stringify(data)).digest('hex');
}

function pipelineSignState(state: unknown): { state: unknown; hmac: string } {
  return { state, hmac: pipelineComputeHmac(state) };
}

function pipelineVerifyState(envelope: unknown): { valid: boolean; state: Record<string, unknown> | null } {
  if (!envelope || typeof envelope !== 'object') return { valid: false, state: null };
  const env = envelope as { state?: unknown; hmac?: string };
  if (!env.hmac || !env.state) return { valid: false, state: null };
  const expected = pipelineComputeHmac(env.state);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(env.hmac, 'hex');
  if (expectedBuf.length !== actualBuf.length) return { valid: false, state: null };
  const valid = timingSafeEqual(expectedBuf, actualBuf);
  return { valid, state: valid ? (env.state as Record<string, unknown>) : null };
}

function pipelineReadState(): { state: Record<string, unknown> | null; error?: string } {
  try {
    if (!existsSync(PIPELINE_STATE_PATH)) return { state: null };
    const raw = JSON.parse(readFileSync(PIPELINE_STATE_PATH, 'utf-8'));
    const { valid, state } = pipelineVerifyState(raw);
    if (!valid || !state) return { state: null, error: 'integrity-failed' };
    return { state };
  } catch {
    return { state: null };
  }
}

function pipelineWriteState(state: Record<string, unknown>): void {
  mkdirSync(PIPELINE_ENFORCEMENT_DIR, { recursive: true });
  const signed = pipelineSignState(state);
  const tmpPath = `${PIPELINE_STATE_PATH}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(signed, null, 2), 'utf-8');
  // renameSync used for atomic write
  renameSync(tmpPath, PIPELINE_STATE_PATH);
}

function pipelineAppendViolation(entry: Record<string, unknown>): void {
  try {
    mkdirSync(PIPELINE_ENFORCEMENT_DIR, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    appendFileSync(PIPELINE_VIOLATIONS_FILE, line, 'utf-8');
  } catch { /* best-effort */ }
}

// ============================================================================
// Pipeline MCP Tools
// ============================================================================

workflowTools.push(
  {
    name: 'pipeline_init',
    description: 'Initialize a pipeline enforcement gate that blocks git commit until all stages are complete',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task identifier for this pipeline (auto-generated if omitted)' },
        stages: {
          type: 'array',
          items: { type: 'string' },
          description: 'Stage names required before commit is allowed (defaults: implement, verify, test, debug, verify_test, audit, verify_audit)',
        },
      },
    },
    handler: async (input) => {
      const defaultStages = ['implement', 'verify', 'test', 'debug', 'verify_test', 'audit', 'verify_audit'];
      const stages = (input.stages as string[] | undefined)?.length ? (input.stages as string[]) : defaultStages;
      const taskId = (input.taskId as string) || `task-${Date.now()}`;
      const stagesObj: Record<string, { complete: boolean; completedAt: string | null; completedBy: string | null }> = {};
      for (const s of stages) {
        stagesObj[s] = { complete: false, completedAt: null, completedBy: null };
      }
      const state: Record<string, unknown> = {
        taskId,
        startedAt: new Date().toISOString(),
        stages: stagesObj,
        requiredStages: stages,
        overrideActive: false,
        overrideReason: null,
        overrideAt: null,
      };
      pipelineWriteState(state);
      pipelineAppendViolation({ type: 'pipeline-init', taskId, stages });
      return { taskId, stages, startedAt: state.startedAt, message: `Pipeline initialized with ${stages.length} stages` };
    },
  },
  {
    name: 'pipeline_stage_complete',
    description: 'Mark a pipeline stage as complete',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        stage: { type: 'string', description: 'Stage name to mark complete' },
        taskId: { type: 'string', description: 'Task ID to validate against (optional)' },
      },
      required: ['stage'],
    },
    handler: async (input) => {
      const { state, error } = pipelineReadState();
      if (error) return { success: false, reason: 'Pipeline state integrity check failed' };
      if (!state) return { success: false, reason: 'No active pipeline' };
      const stageName = input.stage as string;
      const taskId = input.taskId as string | undefined;
      if (taskId && state.taskId !== taskId) {
        return { success: false, reason: `Task ID mismatch: expected ${state.taskId}, got ${taskId}` };
      }
      const stages = state.stages as Record<string, { complete: boolean; completedAt: string | null; completedBy: string | null }>;
      if (!stages[stageName]) return { success: false, reason: `Unknown stage: ${stageName}` };
      if (stages[stageName].complete) return { success: true, reason: 'Already complete', stage: stageName };
      stages[stageName].complete = true;
      stages[stageName].completedAt = new Date().toISOString();
      stages[stageName].completedBy = process.env.CLAUDE_SESSION_ID || null;
      pipelineWriteState(state);
      pipelineAppendViolation({ type: 'pipeline-stage-complete', taskId: state.taskId, stage: stageName });
      return { success: true, stage: stageName, completedAt: stages[stageName].completedAt };
    },
  },
  {
    name: 'pipeline_status',
    description: 'Get the current pipeline enforcement status',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (_input) => {
      const { state, error } = pipelineReadState();
      if (error) return { error: 'Pipeline state integrity check failed' };
      if (!state) return { active: false, message: 'No active pipeline' };
      const stages = state.stages as Record<string, { complete: boolean; completedAt: string | null }>;
      const requiredStages = state.requiredStages as string[];
      const stageDetails = requiredStages.map(name => ({
        name,
        complete: stages[name]?.complete ?? false,
        completedAt: stages[name]?.completedAt ?? null,
      }));
      const incompleteStages = stageDetails.filter(s => !s.complete).map(s => s.name);
      return {
        active: true,
        taskId: state.taskId,
        startedAt: state.startedAt,
        overrideActive: state.overrideActive,
        overrideReason: state.overrideReason,
        stages: stageDetails,
        incompleteStages,
        allComplete: incompleteStages.length === 0,
        commitBlocked: !state.overrideActive && incompleteStages.length > 0,
      };
    },
  }
);

function getDefaultStages(template: string): string[] {
  const stages: Record<string, string[]> = {
    development: [
      'Planning',
      'Verify: Planning -> Implementation',
      'Implementation + Bug Hunter',
      'Verify: Implementation -> Testing',
      'Testing + Bug Hunter',
      'Verify: Testing -> Review',
      'Review + Bug Hunter',
      'Verify: Review -> Integration',
      'Integration',
    ],
    research: ['Discovery', 'Analysis', 'Synthesis', 'Documentation'],
    testing: ['Unit Tests', 'Integration Tests', 'E2E Tests', 'Performance Tests'],
    'security-audit': ['Threat Model', 'Static Analysis', 'Dynamic Analysis', 'Report'],
    'code-review': ['Initial Review', 'Security Check', 'Quality Analysis', 'Feedback'],
    refactoring: ['Analysis', 'Planning', 'Refactor', 'Validation'],
    sparc: ['Specification', 'Pseudocode', 'Architecture', 'Refinement', 'Completion'],
  };
  return stages[template] || ['Initialize', 'Execute', 'Complete'];
}

function getDefaultAgents(template: string): string[] {
  const agents: Record<string, string[]> = {
    development: ['planner', 'coder', 'tester', 'reviewer', 'verifier', 'bug-hunter'],
    research: ['researcher', 'analyst'],
    testing: ['tester', 'coder'],
    'security-audit': ['security-architect', 'security-auditor'],
    'code-review': ['reviewer', 'security-auditor', 'analyst'],
    refactoring: ['architect', 'coder', 'reviewer'],
    sparc: ['architect', 'coder', 'tester', 'reviewer'],
  };
  return agents[template] || ['coder'];
}

function getDefaultDuration(template: string): string {
  const durations: Record<string, string> = {
    development: '30-60 min',
    research: '10-20 min',
    testing: '5-15 min',
    'security-audit': '20-40 min',
    'code-review': '10-25 min',
    refactoring: '15-35 min',
    sparc: '25-45 min',
  };
  return durations[template] || '10-20 min';
}

function parseGateConfig(stageName: string): { fromPhase: string; toPhase: string; checks: string[]; minAgents: number } {
  // Parse "Verify: Planning -> Implementation" format
  const match = stageName.match(/Verify:\s*(.+?)\s*->\s*(.+)/);
  if (!match) return { fromPhase: 'unknown', toPhase: 'unknown', checks: ['factual', 'syntax', 'semantic', 'security'], minAgents: 2 };

  const from = match[1].trim();
  const to = match[2].trim();

  // Default check configs per transition
  const checkConfigs: Record<string, string[]> = {
    'Planning->Implementation': ['factual', 'syntax', 'semantic', 'blindspot', 'error-omission', 'alternative', 'edge-case', 'security'],
    'Implementation->Testing': ['syntax', 'semantic', 'security', 'edge-case'],
    'Testing->Review': ['error-omission', 'edge-case', 'blindspot'],
    'Review->Integration': ['factual', 'security', 'alternative'],
  };

  const normalizedKey = `${from.replace(/ \+ Bug Hunter/, '')}->` + to.replace(/ \+ Bug Hunter/, '');

  return {
    fromPhase: from,
    toPhase: to,
    checks: checkConfigs[normalizedKey] || ['factual', 'syntax', 'semantic', 'security'],
    minAgents: 2,
  };
}
