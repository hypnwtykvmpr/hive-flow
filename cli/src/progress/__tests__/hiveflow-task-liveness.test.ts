// hive-flow-8b69 (Option B, Slice 3): focused tests for the shared CommonJS liveness
// source of truth, imported DIRECTLY (not via the progress-authority-classifier re-export),
// plus proof the re-export is the very same implementation.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyHiveFlowTaskLiveness,
  DEFAULT_TASK_STALL_REVIEW_MS,
} from '../hiveflow-task-liveness.cjs';
import { classifyHiveFlowTaskLiveness as reExported } from '../progress-authority-classifier.js';

let tasksDir: string;

beforeEach(() => {
  tasksDir = mkdtempSync(join(tmpdir(), 'hiveflow-liveness-'));
});
afterEach(() => {
  rmSync(tasksDir, { recursive: true, force: true });
});

function writeResult(taskId: string): void {
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, `${taskId}.result.json`), JSON.stringify({ ok: true }));
}
function writeEvents(taskId: string, lines: Array<Record<string, unknown>>): void {
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, `${taskId}.events.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

describe('hiveflow-task-liveness shared module (hive-flow-8b69 Slice 3)', () => {
  it('is the SAME implementation the progress-authority-classifier re-exports', () => {
    expect(reExported).toBe(classifyHiveFlowTaskLiveness);
  });

  it('defaults the stall-review threshold to the tracked 30 minutes', () => {
    expect(DEFAULT_TASK_STALL_REVIEW_MS).toBe(30 * 60 * 1000);
  });

  it('returns unknown when no task id is supplied', () => {
    expect(classifyHiveFlowTaskLiveness({ tasksDir }).status).toBe('unknown');
  });

  it('returns completed when a result file is present (wins over a dead process)', () => {
    writeResult('t1');
    const r = classifyHiveFlowTaskLiveness({ tasksDir, taskId: 't1', processSnapshot: { alive: false } });
    expect(r.status).toBe('completed');
  });

  it('returns orphaned when the process is dead and no result exists', () => {
    const r = classifyHiveFlowTaskLiveness({ tasksDir, taskId: 't2', processSnapshot: { alive: false } });
    expect(r.status).toBe('orphaned');
  });

  it('returns in_flight when a provider request is in flight', () => {
    writeEvents('t3', [{ event: 'provider_request_start', ts: new Date(0).toISOString() }]);
    const r = classifyHiveFlowTaskLiveness({ tasksDir, taskId: 't3' });
    expect(r.status).toBe('in_flight');
  });

  it('returns observing on the first no-progress observation', () => {
    const r = classifyHiveFlowTaskLiveness({ tasksDir, taskId: 't4', prior: null });
    expect(r.status).toBe('observing');
  });

  it('honours an explicit idleStallMs override (watchdog preserves its 8-minute window)', () => {
    // Not stalled: silent below the explicit threshold with enough stable observations.
    const nowMs = 10 * 60 * 1000;
    writeEvents('t5', [{ event: 'iteration', ts: new Date(nowMs - 60_000).toISOString() }]);
    const r = classifyHiveFlowTaskLiveness({
      tasksDir,
      taskId: 't5',
      nowMs,
      idleStallMs: 8 * 60 * 1000,
      prior: { observedAtMs: 0, eventSize: 999_999, lastEventTs: new Date(nowMs - 60_000).toISOString(), stableObservationCount: 5 },
    });
    // silentForMs (~60s) < 8min threshold → not stalled_review.
    expect(r.status).not.toBe('stalled_review');
  });
});
