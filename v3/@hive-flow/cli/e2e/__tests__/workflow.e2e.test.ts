import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FLOW_REGISTRY,
  WorkflowStateMachine,
  listFlowNames,
} from '@hive-flow/shared/workflow';

const tempDirs: string[] = [];

describe('CA-1 workflow seam', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('uses the registry and state machine with signed persistence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hive-flow-workflow-e2e-'));
    tempDirs.push(dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      expect(listFlowNames()).toEqual(expect.arrayContaining(['general-development', 'bugfix', 'remediation']));
      const factory = FLOW_REGISTRY.get('general-development');
      expect(factory).toBeDefined();
      const flow = factory!({ namespace: 'ca1-e2e' });
      expect(flow.name).toBe('general-development');

      const machine = new WorkflowStateMachine(flow.name, 'ca1-e2e-workflow');
      expect(machine.getCurrentPosition()).toBe('IDLE');
      expect(machine.agentTransition('INVESTIGATING')).toBe(true);
      expect(machine.agentTransition('IMPLEMENTING')).toBe(false);
      machine.advocateTransition('IMPLEMENTING');
      const moduleId = machine.registerModule('ca1-module', 'ca1-module-instance');
      machine.updateModuleState('ca1-module', { status: 'completed', outputs: { moduleId } });
      const trackId = machine.createParallelTrack(['ca1-module']);
      machine.updateTrackStatus(trackId, 'completed');
      machine.save();

      const loaded = WorkflowStateMachine.load();
      expect(loaded?.getCurrentPosition()).toBe('IMPLEMENTING');
      expect(loaded?.getModuleState('ca1-module')?.status).toBe('completed');
      expect(loaded?.areAllTracksComplete()).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
