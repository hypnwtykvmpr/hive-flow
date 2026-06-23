/**
 * DirectiveInterpreter Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DirectiveInterpreter, DirectiveEvents } from '../../v3/@hive-flow/cli/src/shared/directives/interpreter.js';
import { writeDirective } from '../../v3/@hive-flow/cli/src/shared/directives/reader.js';
import type { IEventBus } from '../../v3/@hive-flow/cli/src/shared/core/interfaces/event.interface.js';

function createMockEventBus(): IEventBus & { emit: Mock } {
  return {
    emit: vi.fn(),
    emitAsync: vi.fn(),
    on: vi.fn().mockReturnValue({ unsubscribe: vi.fn(), pause: vi.fn(), resume: vi.fn(), isActive: vi.fn() }),
    subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn(), pause: vi.fn(), resume: vi.fn(), isActive: vi.fn() }),
    once: vi.fn().mockReturnValue({ unsubscribe: vi.fn(), pause: vi.fn(), resume: vi.fn(), isActive: vi.fn() }),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
    listenerCount: vi.fn().mockReturnValue(0),
    eventNames: vi.fn().mockReturnValue([]),
  } as unknown as IEventBus & { emit: Mock };
}

describe('DirectiveInterpreter', () => {
  let eventBus: IEventBus & { emit: Mock };
  let interpreter: DirectiveInterpreter;
  let directivesDir: string;

  beforeEach(async () => {
    eventBus = createMockEventBus();
    directivesDir = path.join(os.tmpdir(), `hive-flow-test-directives-${Date.now()}`);
    await fs.mkdir(directivesDir, { recursive: true });
    interpreter = new DirectiveInterpreter(eventBus, {
      directivesDir,
      swarmId: 'test-swarm',
    });
  });

  afterEach(async () => {
    await interpreter.cleanup();
    try {
      await fs.rm(directivesDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  describe('evaluate', () => {
    it('should return null when no directive exists', async () => {
      const result = await interpreter.evaluate('agent-1');
      expect(result).toBeNull();
    });

    it('should return null for continue directive', async () => {
      await writeDirective(directivesDir, { action: 'continue' }, 'agent-1');
      const result = await interpreter.evaluate('agent-1');
      expect(result).toBeNull();
    });

    it('should handle loop directive', async () => {
      await writeDirective(directivesDir, {
        action: 'loop',
        reason: 'Need to retry',
        stepsBack: 2,
      }, 'agent-1');

      const result = await interpreter.evaluate('agent-1');
      expect(result).not.toBeNull();
      expect(result!.action).toBe('repeat');
      expect(result!.stepsBack).toBe(2);
    });

    it('should track loop iterations', async () => {
      await writeDirective(directivesDir, { action: 'loop' }, 'agent-1');
      await interpreter.evaluate('agent-1');
      expect(interpreter.getLoopCount('agent-1')).toBe(1);

      await writeDirective(directivesDir, { action: 'loop' }, 'agent-1');
      await interpreter.evaluate('agent-1');
      expect(interpreter.getLoopCount('agent-1')).toBe(2);
    });

    it('should enforce maxIterations on loops', async () => {
      await writeDirective(directivesDir, {
        action: 'loop',
        maxIterations: 2,
      }, 'agent-1');
      await interpreter.evaluate('agent-1'); // iteration 1

      await writeDirective(directivesDir, {
        action: 'loop',
        maxIterations: 2,
      }, 'agent-1');
      await interpreter.evaluate('agent-1'); // iteration 2

      await writeDirective(directivesDir, {
        action: 'loop',
        maxIterations: 2,
      }, 'agent-1');
      const result = await interpreter.evaluate('agent-1'); // iteration 3 — over limit

      expect(result).not.toBeNull();
      expect(result!.action).toBe('continue');
      expect(result!.reason).toContain('Loop limit reached');
    });

    it('should handle checkpoint directive', async () => {
      await writeDirective(directivesDir, {
        action: 'checkpoint',
        reason: 'Please review before continuing',
      }, 'agent-1');

      const result = await interpreter.evaluate('agent-1');
      expect(result!.action).toBe('pause');

      expect(eventBus.emit).toHaveBeenCalledWith(
        DirectiveEvents.CHECKPOINT_REQUESTED,
        expect.objectContaining({ agentId: 'agent-1' }),
      );
    });

    it('should handle trigger directive', async () => {
      await writeDirective(directivesDir, {
        action: 'trigger',
        triggerAgentType: 'tester',
        triggerTask: 'Run unit tests',
      }, 'agent-1');

      const result = await interpreter.evaluate('agent-1');
      expect(result!.action).toBe('spawn');
      expect(result!.spawnConfig).toEqual({
        agentType: 'tester',
        task: 'Run unit tests',
      });
    });

    it('should handle trigger without agentType as error', async () => {
      await writeDirective(directivesDir, {
        action: 'trigger',
      }, 'agent-1');

      const result = await interpreter.evaluate('agent-1');
      expect(result!.action).toBe('error');
    });

    it('should handle stop directive', async () => {
      await writeDirective(directivesDir, {
        action: 'stop',
        reason: 'Task complete',
      }, 'agent-1');

      const result = await interpreter.evaluate('agent-1');
      expect(result!.action).toBe('stop');

      expect(eventBus.emit).toHaveBeenCalledWith(
        DirectiveEvents.STOP_REQUESTED,
        expect.objectContaining({ agentId: 'agent-1', reason: 'Task complete' }),
      );
    });

    it('should handle error directive', async () => {
      await writeDirective(directivesDir, {
        action: 'error',
        reason: 'Build failed',
        errorDetails: 'TypeScript compilation error',
      }, 'agent-1');

      const result = await interpreter.evaluate('agent-1');
      expect(result!.action).toBe('error');
      expect(result!.error).toBe('TypeScript compilation error');
    });

    it('should consume directive after evaluation', async () => {
      await writeDirective(directivesDir, { action: 'stop' }, 'agent-1');

      await interpreter.evaluate('agent-1');

      // Second evaluation should find reset/cleared directive
      const result = await interpreter.evaluate('agent-1');
      expect(result).toBeNull();
    });

    it('evaluate clears loop state on non-loop directive (pause)', async () => {
      // Establish a loop state
      await writeDirective(directivesDir, { action: 'loop' }, 'agent-1');
      await interpreter.evaluate('agent-1');
      expect(interpreter.getLoopCount('agent-1')).toBe(1);

      // Now send a non-loop directive (checkpoint/pause)
      await writeDirective(directivesDir, { action: 'checkpoint' }, 'agent-1');
      await interpreter.evaluate('agent-1');

      // Loop state should be cleared
      expect(interpreter.getLoopCount('agent-1')).toBe(0);
    });

    it('evaluate clears loop state on continue/null result', async () => {
      // Establish loop state
      await writeDirective(directivesDir, { action: 'loop' }, 'agent-1');
      await interpreter.evaluate('agent-1');
      expect(interpreter.getLoopCount('agent-1')).toBe(1);

      // Now no directive exists (equivalent to continue)
      await interpreter.evaluate('agent-1');

      // Loop state should be cleared
      expect(interpreter.getLoopCount('agent-1')).toBe(0);
    });
  });

  describe('evaluateAll', () => {
    it('should return first actionable directive', async () => {
      await writeDirective(directivesDir, { action: 'continue' }, 'agent-1');
      await writeDirective(directivesDir, { action: 'stop', reason: 'done' }, 'agent-2');

      const result = await interpreter.evaluateAll(['agent-1', 'agent-2']);
      expect(result).not.toBeNull();
      expect(result!.agentId).toBe('agent-2');
      expect(result!.result.action).toBe('stop');
    });

    it('should return null when no actionable directives', async () => {
      const result = await interpreter.evaluateAll(['agent-1', 'agent-2']);
      expect(result).toBeNull();
    });
  });

  describe('cleanup', () => {
    it('cleanup() clears loop states', async () => {
      await writeDirective(directivesDir, { action: 'loop' }, 'agent-1');
      await interpreter.evaluate('agent-1');
      expect(interpreter.getLoopCount('agent-1')).toBe(1);

      await interpreter.cleanup();
      expect(interpreter.getLoopCount('agent-1')).toBe(0);
    });
  });
});
