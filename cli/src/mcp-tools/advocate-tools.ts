import type { MCPTool } from './types.js';
import { loadHive } from './hive-store.js';
import { WorkflowStateMachine } from '../shared/workflow/index.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmdirSync, statSync, renameSync } from 'node:fs';
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
      const result = await stateMachine.advocateTransition(targetState as Parameters<typeof stateMachine.advocateTransition>[0]);
      
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
const ADVOCATE_LOCK_PATH = '.hive-flow/data/.advocate-state.lock';
const MAX_HISTORY = 50;

// Flat schema matching hook-handler.cjs
const ADVOCATE_STATES = ['active', 'waiting-for-hive', 'waiting-for-human', 'finished'] as const;
type AdvocateStateName = typeof ADVOCATE_STATES[number];

const VALID_TRANSITIONS: Record<AdvocateStateName, AdvocateStateName[]> = {
  'active': ['waiting-for-hive', 'waiting-for-human', 'finished'],
  'waiting-for-hive': ['active', 'finished'],
  'waiting-for-human': ['active'],
  'finished': ['active'],
};

interface AdvocateStateHistoryEntry {
  from: string;
  to: string;
  at: string;
  description: string;
}

interface AdvocateStateData {
  state: AdvocateStateName;
  updatedAt: string;
  description: string;
  history: AdvocateStateHistoryEntry[];
}

function getAdvocateStatePath(): string {
  return join(process.cwd(), ADVOCATE_STATE_FILE);
}

function getAdvocateLockPath(): string {
  return join(process.cwd(), ADVOCATE_LOCK_PATH);
}

function ensureAdvocateStateDir(): void {
  const dir = join(process.cwd(), '.hive-flow/data');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function withAdvocateStateLock<T>(fn: () => T): T {
  const lockPath = getAdvocateLockPath();
  const start = Date.now();
  while (Date.now() - start < 5000) {
    try {
      mkdirSync(lockPath);
      break;
    } catch {
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 10000) {
          try { rmdirSync(lockPath); } catch { /* ignore */ }
          continue;
        }
      } catch { continue; }
      const wait = Date.now() + 50 + Math.random() * 50;
      while (Date.now() < wait) { /* spin */ }
    }
  }
  try { return fn(); } finally { try { rmdirSync(lockPath); } catch { /* ignore */ } }
}

function loadAdvocateState(): AdvocateStateData | null {
  try {
    const filePath = getAdvocateStatePath();
    if (existsSync(filePath)) {
      const data = readFileSync(filePath, 'utf-8');
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

function getValidTransitions(currentState: string): AdvocateStateName[] {
  return VALID_TRANSITIONS[currentState as AdvocateStateName] ?? (ADVOCATE_STATES.filter(s => s !== currentState) as AdvocateStateName[]);
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
        enum: ADVOCATE_STATES,
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
    const newState = input.newState as AdvocateStateName;
    const description = (input.description as string | undefined) ?? '';
    const cleanDescription = String(description).replace(/[\x00-\x1f]/g, '').slice(0, 200);

    if (!ADVOCATE_STATES.includes(newState)) {
      return { success: false, error: `Invalid state: ${newState}` };
    }

    try {
      ensureAdvocateStateDir();

      return withAdvocateStateLock(() => {
        // Load current state inside lock
        const currentData = loadAdvocateState();
        const currentState: string = currentData?.state ?? 'waiting-for-human';

        // Validate transition
        const validTransitions = getValidTransitions(currentState);
        if (!validTransitions.includes(newState)) {
          return {
            success: false,
            error: `Invalid transition from ${currentState} to ${newState}`
          };
        }

        const now = new Date().toISOString();
        const historyEntry: AdvocateStateHistoryEntry = {
          from: currentState,
          to: newState,
          at: now,
          description: cleanDescription,
        };

        const history = [...(currentData?.history ?? []), historyEntry].slice(-MAX_HISTORY);

        const newData: AdvocateStateData = {
          state: newState,
          updatedAt: now,
          description: cleanDescription,
          history,
        };

        saveAdvocateState(newData);

        return {
          success: true,
          fromState: currentState,
          toState: newState,
          description: cleanDescription,
          timestamp: now,
          historyLength: history.length,
          validTransitions: getValidTransitions(newState)
        };
      });
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
      const state: string = data?.state ?? 'waiting-for-human';
      const validTransitions = getValidTransitions(state);

      return {
        success: true,
        state,
        description: data?.description ?? '',
        updatedAt: data?.updatedAt ?? new Date().toISOString(),
        validTransitions,
        historyLength: data?.history?.length ?? 0
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
