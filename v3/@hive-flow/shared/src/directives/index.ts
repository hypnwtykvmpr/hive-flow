/**
 * Directives Module
 * Agent-issued instructions that control workflow execution.
 * Ported from CodeMachine-CLI's directives system.
 *
 * Supported directives:
 * - loop: Repeat previous steps
 * - checkpoint: Pause for user confirmation
 * - trigger: Spawn another agent
 * - stop: Stop the workflow
 * - error: Report an error
 * - pause: Agent requests pause
 */

export { DirectiveInterpreter, DirectiveEvents } from './interpreter.js';
export {
  readDirective,
  writeDirective,
  resetDirective,
  removeDirective,
} from './reader.js';
export { DirectiveActionSchema } from './types.js';
export type {
  DirectiveAction,
  DirectiveActionType,
  DirectiveResult,
  DirectiveManagerConfig,
} from './types.js';
