/**
 * Directive Interpreter
 * Evaluates directive actions and produces coordinator-actionable results.
 * Adapted from CodeMachine-CLI's evaluator pattern.
 */

import type { IEventBus } from '../core/interfaces/event.interface.js';
import type { DirectiveAction, DirectiveResult, DirectiveManagerConfig } from './types.js';
import { readDirective, resetDirective, removeDirective } from './reader.js';

/** Events emitted when directives are processed */
export const DirectiveEvents = {
  LOOP_REQUESTED: 'directive.loop.requested',
  CHECKPOINT_REQUESTED: 'directive.checkpoint.requested',
  TRIGGER_REQUESTED: 'directive.trigger.requested',
  STOP_REQUESTED: 'directive.stop.requested',
  ERROR_REPORTED: 'directive.error.reported',
  PAUSE_REQUESTED: 'directive.pause.requested',
} as const;

/** Iteration tracking for loop directives */
interface LoopState {
  agentId: string;
  iterationCount: number;
}

export class DirectiveInterpreter {
  private loopStates = new Map<string, LoopState>();

  constructor(
    private eventBus: IEventBus,
    private config: DirectiveManagerConfig,
  ) {}

  /**
   * Check for and interpret a directive from a specific agent.
   * Called by the coordinator after each task completes.
   *
   * Returns null if no actionable directive was found.
   */
  async evaluate(agentId: string): Promise<DirectiveResult | null> {
    const directive = await readDirective(this.config.directivesDir, agentId);
    if (!directive || directive.action === 'continue') {
      // Clear loop state when agent completes without a loop directive
      this.loopStates.delete(agentId);
      return null;
    }

    // Consume the directive (reset to continue)
    await resetDirective(this.config.directivesDir, agentId);

    // Clear loop state for non-loop directives to prevent stale iteration counts
    if (directive.action !== 'loop') {
      this.loopStates.delete(agentId);
    }

    return this.interpret(agentId, directive);
  }

  /**
   * Check all agents for pending directives.
   * Returns the first actionable directive found.
   */
  async evaluateAll(agentIds: string[]): Promise<{ agentId: string; result: DirectiveResult } | null> {
    for (const agentId of agentIds) {
      const result = await this.evaluate(agentId);
      if (result) {
        return { agentId, result };
      }
    }
    return null;
  }

  /** Clean up directive files for a swarm */
  async cleanup(): Promise<void> {
    this.loopStates.clear();
    // Remove the entire directives directory for this swarm
    await removeDirective(this.config.directivesDir);
  }

  /** Get loop iteration count for an agent */
  getLoopCount(agentId: string): number {
    return this.loopStates.get(agentId)?.iterationCount ?? 0;
  }

  // ─── Private ──────────────────────────────────────────────────

  private interpret(agentId: string, directive: DirectiveAction): DirectiveResult {
    switch (directive.action) {
      case 'loop':
        return this.handleLoop(agentId, directive);

      case 'checkpoint':
        this.eventBus.emit(DirectiveEvents.CHECKPOINT_REQUESTED, {
          agentId,
          reason: directive.reason,
        });
        return { action: 'pause', reason: directive.reason ?? 'Checkpoint reached' };

      case 'trigger':
        if (!directive.triggerAgentType) {
          return { action: 'error', error: 'Trigger directive missing triggerAgentType' };
        }
        this.eventBus.emit(DirectiveEvents.TRIGGER_REQUESTED, {
          agentId,
          triggerAgentType: directive.triggerAgentType,
          triggerTask: directive.triggerTask,
        });
        return {
          action: 'spawn',
          reason: directive.reason,
          spawnConfig: {
            agentType: directive.triggerAgentType,
            task: directive.triggerTask ?? '',
          },
        };

      case 'stop':
        this.eventBus.emit(DirectiveEvents.STOP_REQUESTED, {
          agentId,
          reason: directive.reason,
        });
        return { action: 'stop', reason: directive.reason ?? 'Agent requested stop' };

      case 'error':
        this.eventBus.emit(DirectiveEvents.ERROR_REPORTED, {
          agentId,
          error: directive.errorDetails ?? directive.reason,
        });
        return {
          action: 'error',
          reason: directive.reason,
          error: directive.errorDetails ?? directive.reason,
        };

      case 'pause':
        this.eventBus.emit(DirectiveEvents.PAUSE_REQUESTED, {
          agentId,
          reason: directive.reason,
        });
        return { action: 'pause', reason: directive.reason ?? 'Agent requested pause' };

      default:
        return { action: 'continue' };
    }
  }

  private handleLoop(agentId: string, directive: DirectiveAction): DirectiveResult {
    // Track iteration count
    let loopState = this.loopStates.get(agentId);
    if (!loopState) {
      loopState = { agentId, iterationCount: 0 };
      this.loopStates.set(agentId, loopState);
    }

    loopState.iterationCount++;

    // Check max iterations
    if (directive.maxIterations && loopState.iterationCount > directive.maxIterations) {
      this.loopStates.delete(agentId);
      return {
        action: 'continue',
        reason: `Loop limit reached (${directive.maxIterations} iterations)`,
      };
    }

    this.eventBus.emit(DirectiveEvents.LOOP_REQUESTED, {
      agentId,
      iterationCount: loopState.iterationCount,
      stepsBack: directive.stepsBack,
      reason: directive.reason,
    });

    return {
      action: 'repeat',
      stepsBack: directive.stepsBack ?? 1,
      reason: directive.reason ?? `Loop iteration ${loopState.iterationCount}`,
    };
  }
}
