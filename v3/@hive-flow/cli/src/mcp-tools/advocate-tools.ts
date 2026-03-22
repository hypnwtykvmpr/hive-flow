import type { MCPTool } from './types.js';
import { loadHive } from './hive-store.js';
import { WorkflowStateMachine, WORKFLOW_STATES } from '@hive-flow/shared/workflow';
import type { WorkflowStateName } from '@hive-flow/shared/workflow';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const advocateReviewTool: MCPTool = {
  name: 'advocate_review',
  description: 'Advocate review of a hive, returning a summary of audit entries.',
  category: 'advocate',
  inputSchema: {
    type: 'object',
    properties: {
      hiveId: { type: 'string', description: 'ID of the hive to review' }
    },
    required: ['hiveId']
  },
  handler: async (input) => {
    const hiveId = input.hiveId as string;
    const hive = loadHive(hiveId);
    
    if (!hive) {
      return { success: false, error: `Hive '${hiveId}' not found.` };
    }
    
    return {
      success: true,
      hiveId,
      status: hive.status,
      auditEntryCount: hive.audit.length,
      auditEntries: hive.audit,
      delegationMetrics: hive.delegationMetrics || null,
      summary: `Hive ${hiveId} review complete. Status: ${hive.status}, Audit Entries: ${hive.audit.length}.`
    };
  }
};

const advocateApproveTool: MCPTool = {
  name: 'advocate_approve',
  description: 'Advocate approves a workflow state transition.',
  category: 'advocate',
  inputSchema: {
    type: 'object',
    properties: {
      workflowId: { type: 'string', description: 'ID of the workflow' },
      targetState: { type: 'string', description: 'Target state to transition to' }
    },
    required: ['workflowId', 'targetState']
  },
  handler: async (input) => {
    const workflowId = input.workflowId as string;
    const targetState = input.targetState as string;
    
    try {
      const stateMachine = new WorkflowStateMachine(workflowId);
      const result = await stateMachine.advocateTransition(targetState as WorkflowStateName);
      
      return {
        success: true,
        workflowId,
        targetState,
        result
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
};

// ---------------------------------------------------------------------------
// Advocate State Management
// ---------------------------------------------------------------------------

const ADVOCATE_STATE_FILE = '.hive-flow/data/advocate-state.json';
const MAX_HISTORY = 50;

interface AdvocateStateRecord {
  currentState: WorkflowStateName;
  description?: string;
  updatedAt: string;
  updatedBy: string;
}

interface AdvocateStateHistoryEntry extends AdvocateStateRecord {
  previousState: WorkflowStateName;
  timestamp: string;
}

interface AdvocateStateData {
  current: AdvocateStateRecord;
  history: AdvocateStateHistoryEntry[];
  validTransitions: WorkflowStateName[];
}

function getAdvocateStatePath(): string {
  return join(process.cwd(), ADVOCATE_STATE_FILE);
}

function ensureAdvocateStateDir(): void {
  const dir = join(process.cwd(), '.hive-flow/data');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadAdvocateState(): AdvocateStateData | null {
  try {
    const path = getAdvocateStatePath();
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data) as AdvocateStateData;
    }
  } catch {
    // Return null on error
  }
  return null;
}

function saveAdvocateState(data: AdvocateStateData): void {
  ensureAdvocateStateDir();
  const targetPath = getAdvocateStatePath();
  const tmpPath = targetPath + '.tmp.' + process.pid;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  // Atomic rename
  renameSync(tmpPath, targetPath);
}

function getValidTransitions(currentState: WorkflowStateName): WorkflowStateName[] {
  // Advocate can transition to any state except current state
  return WORKFLOW_STATES.filter(state => state !== currentState);
}

// ---------------------------------------------------------------------------
// Advocate Sign State Tool
// ---------------------------------------------------------------------------

const advocateSignStateTool: MCPTool = {
  name: 'advocate_sign_state',
  description: 'Advocate signs a new state with transition validation, atomic write, and history cap of 50 entries.',
  category: 'advocate',
  inputSchema: {
    type: 'object',
    properties: {
      newState: {
        type: 'string',
        enum: WORKFLOW_STATES,
        description: 'Target state to transition to'
      },
      description: {
        type: 'string',
        description: 'Optional description for the state transition'
      }
    },
    required: ['newState']
  },
  handler: async (input) => {
    const newState = input.newState as WorkflowStateName;
    const description = input.description as string | undefined;
    const updatedBy = 'advocate'; // Could be enhanced with authentication context

    try {
      // Load current state
      const currentData = loadAdvocateState();
      const currentState = currentData?.current?.currentState || 'IDLE';
      
      // Validate transition - advocate can transition to any state
      const validTransitions = getValidTransitions(currentState);
      if (!validTransitions.includes(newState)) {
        return {
          success: false,
          error: `Invalid transition from ${currentState} to ${newState}`
        };
      }

      // Create new state record
      const now = new Date().toISOString();
      const newRecord: AdvocateStateRecord = {
        currentState: newState,
        description,
        updatedAt: now,
        updatedBy
      };

      // Create history entry
      const historyEntry: AdvocateStateHistoryEntry = {
        ...newRecord,
        previousState: currentState,
        timestamp: now
      };

      // Update data
      const newData: AdvocateStateData = {
        current: newRecord,
        history: currentData?.history || [],
        validTransitions: getValidTransitions(newState)
      };

      // Add to history and cap at MAX_HISTORY
      newData.history.unshift(historyEntry);
      if (newData.history.length > MAX_HISTORY) {
        newData.history = newData.history.slice(0, MAX_HISTORY);
      }

      // Atomic write
      saveAdvocateState(newData);

      return {
        success: true,
        fromState: currentState,
        toState: newState,
        description,
        timestamp: now,
        historyLength: newData.history.length,
        validTransitions: newData.validTransitions
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
};

// ---------------------------------------------------------------------------
// Advocate Get State Tool
// ---------------------------------------------------------------------------

const advocateGetStateTool: MCPTool = {
  name: 'advocate_get_state',
  description: 'Get current advocate state and valid transitions.',
  category: 'advocate',
  inputSchema: {
    type: 'object',
    properties: {},
    required: []
  },
  handler: async () => {
    try {
      const data = loadAdvocateState();
      const currentState = data?.current?.currentState || 'IDLE';
      const validTransitions = getValidTransitions(currentState);

      return {
        success: true,
        currentState,
        description: data?.current?.description,
        updatedAt: data?.current?.updatedAt || new Date().toISOString(),
        updatedBy: data?.current?.updatedBy || 'system',
        validTransitions,
        historyLength: data?.history?.length || 0
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
};

export const advocateTools: MCPTool[] = [
  advocateReviewTool,
  advocateApproveTool,
  advocateSignStateTool,
  advocateGetStateTool,
];
