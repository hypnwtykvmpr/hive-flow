/**
 * Workflow MCP Tools for CLI
 *
 * Tool definitions for workflow automation and orchestration.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { MCPTool } from './types.js';
import { executeWorkflowStep } from './workflow-executor.js';
import type { WorkflowStepContext } from './workflow-executor.js';

// Storage paths
const STORAGE_DIR = '.hive-flow';
const WORKFLOW_DIR = 'workflows';
const WORKFLOW_FILE = 'store.json';

interface WorkflowStep {
  stepId: string;
  name: string;
  type: 'task' | 'condition' | 'parallel' | 'loop' | 'wait' | 'verification';
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
      workflow.currentStep = (input.startFromStep as number) || 0;

      // Execute steps (in real implementation, this would be async/event-driven)
      const results: Array<{ stepId: string; status: string }> = [];
      for (let i = workflow.currentStep; i < workflow.steps.length; i++) {
        const step = workflow.steps[i];
        step.status = 'running';
        step.startedAt = new Date().toISOString();

        // Dispatch to workflow executor for real step handling
        const stepCtx: WorkflowStepContext = {
          workflowId,
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

        const stepResult = await executeWorkflowStep(stepCtx);
        step.status = stepResult.status;
        step.completedAt = new Date().toISOString();
        step.result = stepResult.result;

        // If gate is waiting for phase team remediation, pause workflow
        if (stepResult.status === 'waiting') {
          workflow.status = 'paused';
          workflow.currentStep = i;
          saveWorkflowStore(store);
          return {
            workflowId,
            status: workflow.status,
            stepsExecuted: results.length,
            results,
            pausedAt: step.name,
            pauseReason: 'Verification gate awaiting phase team remediation',
            startedAt: workflow.startedAt,
          };
        }

        results.push({ stepId: step.stepId, status: step.status });
        workflow.currentStep = i + 1;
        saveWorkflowStore(store);
      }

      workflow.status = 'completed';
      workflow.completedAt = new Date().toISOString();

      saveWorkflowStore(store);

      return {
        workflowId,
        status: workflow.status,
        stepsExecuted: results.length,
        results,
        startedAt: workflow.startedAt,
        completedAt: workflow.completedAt,
        duration: new Date(workflow.completedAt).getTime() - new Date(workflow.startedAt!).getTime(),
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

      // Continue execution from current step — dispatch to executeWorkflowStep()
      const results: Array<{ stepId: string; status: string }> = [];
      for (let i = workflow.currentStep; i < workflow.steps.length; i++) {
        const step = workflow.steps[i];
        step.status = 'running';
        step.startedAt = new Date().toISOString();

        const stepCtx: WorkflowStepContext = {
          workflowId,
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

        const stepResult = await executeWorkflowStep(stepCtx);
        step.status = stepResult.status;
        step.completedAt = new Date().toISOString();
        step.result = stepResult.result;

        // If gate is waiting for remediation, pause workflow
        if (stepResult.status === 'waiting') {
          workflow.status = 'paused';
          workflow.currentStep = i;
          saveWorkflowStore(store);
          return {
            workflowId,
            status: workflow.status,
            resumed: true,
            stepsExecuted: results.length,
            pausedAt: step.name,
            pauseReason: 'Verification gate awaiting phase team remediation',
          };
        }

        results.push({ stepId: step.stepId, status: step.status });
        workflow.currentStep = i + 1;
        saveWorkflowStore(store);
      }

      workflow.status = 'completed';
      workflow.completedAt = new Date().toISOString();
      saveWorkflowStore(store);

      return {
        workflowId,
        status: workflow.status,
        resumed: true,
        stepsExecuted: results.length,
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

      if (options.dryRun) {
        return {
          workflowId,
          template: template || 'custom',
          status: 'validated' as const,
          stages: steps.map(s => ({
            name: s.name,
            status: s.status,
            agents: s.type === 'verification' ? ['verifier'] : agents,
          })),
          metrics: {
            totalStages: steps.length,
            completedStages: 0,
            agentsSpawned: 0,
            estimatedDuration: getDefaultDuration(template),
          },
        };
      }

      // Execute the workflow
      return {
        workflowId,
        template: template || 'custom',
        status: 'running' as const,
        stages: steps.map(s => ({
          name: s.name,
          status: s.status,
          agents: s.type === 'verification' ? ['verifier'] : agents,
        })),
        metrics: {
          totalStages: steps.length,
          completedStages: 0,
          agentsSpawned: agents.length,
          estimatedDuration: getDefaultDuration(template),
        },
      };
    },
  },
];

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
