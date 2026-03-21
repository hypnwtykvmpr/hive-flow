import type { MCPTool } from './types.js';
import { loadHive } from './hive-store.js';
import { WorkflowStateMachine } from '@hive-flow/shared/workflow';
import type { WorkflowStateName } from '@hive-flow/shared/workflow';

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

export const advocateTools: MCPTool[] = [
  advocateReviewTool,
  advocateApproveTool,
];
