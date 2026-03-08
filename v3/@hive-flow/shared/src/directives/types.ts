/**
 * Directive Types
 * Agent-issued instructions that control workflow execution.
 * Agents write directive files to communicate control flow
 * back to the coordinator.
 *
 * Adapted from CodeMachine-CLI's directive system.
 */

import { z } from 'zod';

/** Supported directive actions */
export type DirectiveActionType =
  | 'loop'       // Repeat previous steps
  | 'checkpoint' // Pause for user confirmation
  | 'continue'   // Normal continuation (default)
  | 'trigger'    // Spawn another agent
  | 'stop'       // Stop the workflow
  | 'error'      // Report an error
  | 'pause';     // Agent requests a pause

/** A directive written by an agent */
export interface DirectiveAction {
  action: DirectiveActionType;
  /** Human-readable reason for the directive */
  reason?: string;
  /** For 'trigger': the agent type or ID to spawn */
  triggerAgentType?: string;
  /** For 'trigger': the task to assign to the triggered agent */
  triggerTask?: string;
  /** For 'loop': how many steps to go back */
  stepsBack?: number;
  /** For 'loop': maximum iteration count before forcing stop */
  maxIterations?: number;
  /** For 'error': error details */
  errorDetails?: string;
}

/** Zod schema for validating directive files */
export const DirectiveActionSchema = z.object({
  action: z.enum(['loop', 'checkpoint', 'continue', 'trigger', 'stop', 'error', 'pause']),
  reason: z.string().optional(),
  triggerAgentType: z.string().optional(),
  triggerTask: z.string().optional(),
  stepsBack: z.number().int().positive().optional(),
  maxIterations: z.number().int().positive().optional(),
  errorDetails: z.string().optional(),
});

/** Result of evaluating a directive */
export interface DirectiveResult {
  /** What the coordinator should do */
  action: 'repeat' | 'pause' | 'stop' | 'spawn' | 'continue' | 'error';
  /** Human-readable reason */
  reason?: string;
  /** For repeat: how many steps back */
  stepsBack?: number;
  /** For spawn: agent config */
  spawnConfig?: { agentType: string; task: string };
  /** For error: error details */
  error?: string;
}

/** Configuration for the DirectiveManager */
export interface DirectiveManagerConfig {
  /** Base directory for directive files */
  directivesDir: string;
  /** Swarm or session ID */
  swarmId: string;
}
