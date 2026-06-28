import fc from 'fast-check';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { propertyRunsFromEnv } from '../../__tests__/property-runs.js';
import {
  classifyHiveFlowTaskLiveness,
  classifyProgressAuthority,
  collectProgressAuthoritySnapshot,
  redactClassifierString,
  type ProgressAuthoritySnapshot,
} from '../progress-authority-classifier.js';

const PROPERTY_RUNS = propertyRunsFromEnv(100);
const nowMs = Date.parse('2026-06-13T00:00:00.000Z');
const observedAt = new Date(nowMs).toISOString();
const roots: string[] = [];
const here = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(here, '../progress-authority-classifier.ts');
const privateWorkflowTokenPattern = new RegExp(
  `\\b(?:${[
    [98, 100],
    [98, 101, 97, 100, 115],
    [107, 110, 111],
    [107, 110, 111, 116, 115],
  ].map((codes) => String.fromCharCode(...codes)).join('|')})\\b`,
  'i',
);

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hf-progress-authority-'));
  roots.push(root);
  return root;
}

function writeTaskEvents(tasksDir: string, taskId: string, events: unknown[]): void {
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(tasksDir, `${taskId}.events.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
}

function baseSnapshot(overrides: Partial<ProgressAuthoritySnapshot> = {}): ProgressAuthoritySnapshot {
  const projectRoot = overrides.projectRoot ?? tempRoot();
  return {
    nowMs,
    observedAt,
    cwd: projectRoot,
    projectRoot,
    agent: 'codex',
    sessionId: 'session-a',
    router: {
      available: false,
      notesScanned: 0,
      concreteAction: false,
      humanGate: false,
      pushHeld: false,
      continuationAfterGate: false,
    },
    git: {
      available: true,
      dirtyFiles: 0,
    },
    workflow: {
      available: false,
      inProgress: 0,
      open: 0,
      closed: 0,
      malformed: 0,
      stale: true,
    },
    swarm: {
      available: false,
      alive: 0,
      executing: 0,
    },
    tasks: {
      available: false,
      runningLive: 0,
      runningNoPid: 0,
      runningDead: 0,
      completedResults: 0,
      failedResults: 0,
      malformed: 0,
    },
    ...overrides,
  };
}

describe('progress authority classifier', () => {
  it('never classifies missing authority as progressing', () => {
    fc.assert(
      fc.property(
        fc.record({
          dirtyFiles: fc.integer({ min: 0, max: 500 }),
          ahead: fc.integer({ min: 0, max: 20 }),
          behind: fc.integer({ min: 0, max: 20 }),
          openWorkflowItems: fc.integer({ min: 0, max: 20 }),
        }),
        (input) => {
          const result = classifyProgressAuthority(baseSnapshot({
            git: {
              available: true,
              dirtyFiles: input.dirtyFiles,
              ahead: input.ahead,
              behind: input.behind,
            },
            workflow: {
              available: true,
              inProgress: 0,
              open: input.openWorkflowItems,
              closed: 0,
              malformed: 0,
              stale: false,
            },
          }));

          expect(result.authority.present).toBe(false);
          expect(result.classification).not.toBe('progressing');
        },
      ),
      { numRuns: PROPERTY_RUNS, seed: 13_501 },
    );
  });

  it('is idempotent for identical snapshots because now is injected', () => {
    fc.assert(
      fc.property(
        fc.record({
          routerConcrete: fc.boolean(),
          routerHumanGate: fc.boolean(),
          routerContinuation: fc.boolean(),
          swarmExecuting: fc.integer({ min: 0, max: 5 }),
          tasksLive: fc.integer({ min: 0, max: 5 }),
          tasksNoPid: fc.integer({ min: 0, max: 5 }),
          workflowItemInProgress: fc.integer({ min: 0, max: 5 }),
        }),
        (input) => {
          const snapshot = baseSnapshot({
            router: {
              available: input.routerConcrete || input.routerHumanGate,
              notesScanned: input.routerConcrete || input.routerHumanGate ? 1 : 0,
              latestMtimeMs: nowMs - 1000,
              humanGateMtimeMs: input.routerHumanGate ? nowMs - 1000 : undefined,
              concreteAction: input.routerConcrete,
              humanGate: input.routerHumanGate,
              pushHeld: input.routerHumanGate,
              continuationAfterGate: input.routerContinuation,
            },
            swarm: {
              available: input.swarmExecuting > 0,
              alive: input.swarmExecuting,
              executing: input.swarmExecuting,
            },
            tasks: {
              available: input.tasksLive > 0 || input.tasksNoPid > 0,
              runningLive: input.tasksLive,
              runningNoPid: input.tasksNoPid,
              runningDead: 0,
              completedResults: 0,
              failedResults: 0,
              malformed: 0,
            },
            workflow: {
              available: input.workflowItemInProgress > 0,
              inProgress: input.workflowItemInProgress,
              open: 0,
              closed: 0,
              malformed: 0,
              stale: false,
            },
          });

          expect(classifyProgressAuthority(snapshot)).toEqual(classifyProgressAuthority(snapshot));
        },
      ),
      { numRuns: PROPERTY_RUNS, seed: 13_502 },
    );
  });

  it('redacts secret-like values from classifier output', () => {
    const secrets = [
      'or-abcdefghijklmnop',
      'sk-abcdefghijklmnop',
      'Bearer abcdefghijklmnop',
      'AKIA1234567890ABCDEF',
      'AIzaSyA0000000000000000000000000',
      'HF_TOKEN=supersecret',
      '0123456789abcdef0123456789abcdef01234567',
    ];

    fc.assert(
      fc.property(fc.constantFrom(...secrets), (secret) => {
        const result = classifyProgressAuthority(baseSnapshot({
          router: {
            available: true,
            notesScanned: 1,
            latestMtimeMs: nowMs - 1000,
            concreteAction: true,
            humanGate: false,
            pushHeld: false,
            continuationAfterGate: false,
            excerpt: `handoff contains ${secret}`,
          },
          git: {
            available: false,
            dirtyFiles: 0,
            error: `git failed with ${secret}`,
          },
          swarm: {
            available: false,
            alive: 0,
            executing: 0,
            error: `swarm failed with ${secret}`,
          },
        }));

        const rendered = JSON.stringify(result);
        expect(rendered).not.toContain(secret);
        expect(rendered).toContain('[REDACTED]');
      }),
      { numRuns: PROPERTY_RUNS, seed: 13_503 },
    );
  });

  it('treats live execution after a human gate as newer continuation', () => {
    const result = classifyProgressAuthority(baseSnapshot({
      router: {
        available: true,
        notesScanned: 1,
        latestMtimeMs: nowMs - 60_000,
        humanGateMtimeMs: nowMs - 60_000,
        concreteAction: false,
        humanGate: true,
        pushHeld: true,
        continuationAfterGate: false,
        excerpt: 'push held; waiting for human',
      },
      swarm: {
        available: true,
        alive: 1,
        executing: 1,
        freshness: 'fresh',
      },
    }));

    expect(result.classification).toBe('progressing');
    expect(result.reasons).toContain('live execution observed');
  });

  it('preserves explicit human-gate precedence when no continuation exists', () => {
    const result = classifyProgressAuthority(baseSnapshot({
      router: {
        available: true,
        notesScanned: 1,
        latestMtimeMs: nowMs - 60_000,
        humanGateMtimeMs: nowMs - 60_000,
        concreteAction: true,
        humanGate: true,
        pushHeld: true,
        continuationAfterGate: false,
        excerpt: 'queue complete; push held',
      },
    }));

    expect(result.classification).toBe('waiting-for-human');
    expect(result.authority.present).toBe(true);
  });

  it('documents and tests the read-only source contract', () => {
    const source = readFileSync(modulePath, 'utf8');
    expect(source).not.toMatch(/\b(?:writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync|rmdirSync|createWriteStream)\b/);
    expect(source).not.toMatch(privateWorkflowTokenPattern);
    expect(source).toContain("spawnSync('git', ['status', '--short', '--branch']");
    expect(source).toContain("spawnSync('git', ['rev-parse', 'HEAD']");
    expect(source).toContain('WORKFLOW_TRACKER_COMMAND_ENV');
    expect(source).toContain("spawnSync(command, workflowTrackerCommandArgs()");
    expect(source).not.toMatch(/spawnSync\((?!'(?:git)'|command)/);
    expect(source).toContain('shell: false');
    expect(source).toContain('timeout: 500');
    expect(source).toContain('timeout: 1_000');
  });

  it('uses workflow tracker state as the workflow authority source', async () => {
    const root = tempRoot();
    mkdirSync(join(root, '.workflow-tracker'), { recursive: true });
    writeFileSync(join(root, '.workflow-tracker', 'state.sqlite'), 'sqlite-placeholder', 'utf8');

    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    const trackerPath = join(binDir, 'workflow-tracker');
    writeFileSync(
      trackerPath,
      '#!/bin/sh\nprintf \'[{"id":"workflowItem-a","state":"claimed"},{"id":"workflowItem-b","state":"ready"},{"id":"workflowItem-c","state":"shipped"}]\'\n',
      'utf8',
    );
    chmodSync(trackerPath, 0o755);

    const originalPath = process.env.PATH;
    const originalCommand = process.env.HIVE_FLOW_WORKFLOW_TRACKER_COMMAND;
    const originalStatePath = process.env.HIVE_FLOW_WORKFLOW_TRACKER_STATE_PATH;
    process.env.PATH = `${binDir}${process.platform === 'win32' ? ';' : ':'}${originalPath ?? ''}`;
    process.env.HIVE_FLOW_WORKFLOW_TRACKER_COMMAND = 'workflow-tracker';
    process.env.HIVE_FLOW_WORKFLOW_TRACKER_STATE_PATH = '.workflow-tracker/state.sqlite';
    try {
      const snapshot = await collectProgressAuthoritySnapshot({ cwd: root, nowMs });
      const result = classifyProgressAuthority(snapshot);

      expect(snapshot.workflow.available).toBe(true);
      expect(snapshot.workflow.inProgress).toBe(1);
      expect(snapshot.workflow.open).toBe(1);
      expect(snapshot.workflow.closed).toBe(1);
      expect(result.authority.sources).toContain('workflow-tracker');
      expect(result.classification).toBe('stalled');
    } finally {
      process.env.PATH = originalPath;
      if (originalCommand === undefined) delete process.env.HIVE_FLOW_WORKFLOW_TRACKER_COMMAND;
      else process.env.HIVE_FLOW_WORKFLOW_TRACKER_COMMAND = originalCommand;
      if (originalStatePath === undefined) delete process.env.HIVE_FLOW_WORKFLOW_TRACKER_STATE_PATH;
      else process.env.HIVE_FLOW_WORKFLOW_TRACKER_STATE_PATH = originalStatePath;
    }
  });

  it('uses bounded redaction equivalent to the task journal discipline', () => {
    const redacted = redactClassifierString(`token=or-abcdefghijklmnop ${'x'.repeat(800)}`);
    expect(redacted).not.toContain('or-abcdefghijklmnop');
    expect(redacted.length).toBeLessThanOrEqual(500);
  });

  it('does not refresh a stale handoff because an unrelated router note is newer', async () => {
    const root = tempRoot();
    const routerDir = join(root, '.hive-flow', 'data', 'tmux-router');
    mkdirSync(routerDir, { recursive: true });
    const staleHandoff = join(routerDir, '20260612-000000-to-codex.md');
    const newerChatter = join(routerDir, '20260612-010000-to-claude.md');
    writeFileSync(staleHandoff, 'Hive Flow handoff ready: read task and implement to-codex.', 'utf8');
    writeFileSync(newerChatter, 'Status note only; no concrete continuation for Codex.', 'utf8');
    utimesSync(staleHandoff, new Date(nowMs - 20 * 60_000), new Date(nowMs - 20 * 60_000));
    utimesSync(newerChatter, new Date(nowMs - 60_000), new Date(nowMs - 60_000));

    const snapshot = await collectProgressAuthoritySnapshot({ cwd: root, agent: 'codex', nowMs });
    const result = classifyProgressAuthority(snapshot);

    expect(snapshot.router.latestPath).toBe(newerChatter);
    expect(snapshot.router.concreteAction).toBe(false);
    expect(result.classification).toBe('insufficient-evidence');
  });

  it('classifies a long-running provider request as in-flight instead of hung', () => {
    const root = tempRoot();
    const tasksDir = join(root, '.hive-flow', 'tasks');
    const taskId = 'task-long-bughunt';
    writeTaskEvents(tasksDir, taskId, [
      { ts: '2026-06-12T21:00:00.000Z', event: 'bridge_start', taskId, pid: 123 },
      { ts: '2026-06-12T21:05:00.000Z', event: 'provider_request_start', taskId, pid: 123, meta: { iteration: 8 } },
    ]);

    const eventsFile = join(tasksDir, `${taskId}.events.jsonl`);
    const result = classifyHiveFlowTaskLiveness({
      tasksDir,
      taskId,
      nowMs,
      processSnapshot: { alive: true, state: 'S', cpuTimeMs: 100 },
      idleStallMs: 5 * 60_000,
      prior: {
        observedAtMs: nowMs - 45 * 60_000,
        eventSize: statSync(eventsFile).size,
        lastEventTs: '2026-06-12T21:05:00.000Z',
        processSnapshot: { alive: true, state: 'S', cpuTimeMs: 100 },
        stableObservationCount: 12,
      },
    });

    expect(result.status).toBe('in_flight');
    expect(result.hung).toBe(false);
    expect(result.shouldTerminate).toBe(false);
    expect(result.signals.providerRequestInFlight).toBe(true);
  });

  it('requires multiple no-progress signals before classifying a task as stalled review', () => {
    const root = tempRoot();
    const tasksDir = join(root, '.hive-flow', 'tasks');
    const taskId = 'task-needs-review';
    writeTaskEvents(tasksDir, taskId, [
      { ts: '2026-06-12T22:00:00.000Z', event: 'tool_exec_end', taskId, pid: 456, meta: { success: true } },
    ]);
    const eventsFile = join(tasksDir, `${taskId}.events.jsonl`);

    const first = classifyHiveFlowTaskLiveness({
      tasksDir,
      taskId,
      nowMs,
      processSnapshot: { alive: true, state: 'S', cpuTimeMs: 1_000 },
      idleStallMs: 5 * 60_000,
    });
    expect(first.status).toBe('observing');
    expect(first.hung).toBe(false);

    const stalled = classifyHiveFlowTaskLiveness({
      tasksDir,
      taskId,
      nowMs: nowMs + 10 * 60_000,
      processSnapshot: { alive: true, state: 'S', cpuTimeMs: 1_000 },
      idleStallMs: 5 * 60_000,
      minStableObservations: 3,
      prior: {
        observedAtMs: nowMs,
        eventSize: statSync(eventsFile).size,
        lastEventTs: '2026-06-12T22:00:00.000Z',
        processSnapshot: { alive: true, state: 'S', cpuTimeMs: 1_000 },
        stableObservationCount: 2,
      },
    });
    expect(stalled.status).toBe('stalled_review');
    expect(stalled.hung).toBe(false);
    expect(stalled.shouldTerminate).toBe(false);
    expect(stalled.signals.eventAdvanced).toBe(false);
    expect(stalled.signals.processCpuAdvanced).toBe(false);
  });

  it('treats event growth as progress regardless of total runtime', () => {
    const root = tempRoot();
    const tasksDir = join(root, '.hive-flow', 'tasks');
    const taskId = 'task-progress-growth';
    writeTaskEvents(tasksDir, taskId, [
      { ts: '2026-06-12T10:00:00.000Z', event: 'bridge_start', taskId, pid: 789 },
      { ts: '2026-06-12T23:55:00.000Z', event: 'tool_exec_end', taskId, pid: 789, meta: { success: true } },
    ]);
    const eventSize = statSync(join(tasksDir, `${taskId}.events.jsonl`)).size;

    const result = classifyHiveFlowTaskLiveness({
      tasksDir,
      taskId,
      nowMs,
      processSnapshot: { alive: true, state: 'S', cpuTimeMs: 10_000 },
      prior: {
        observedAtMs: nowMs - 10 * 60 * 60_000,
        eventSize: eventSize - 10,
        lastEventTs: '2026-06-12T10:00:00.000Z',
        processSnapshot: { alive: true, state: 'S', cpuTimeMs: 10_000 },
        stableObservationCount: 20,
      },
    });

    expect(result.status).toBe('progressing');
    expect(result.hung).toBe(false);
    expect(result.shouldTerminate).toBe(false);
    expect(result.nextPrior.stableObservationCount).toBe(0);
  });
});
