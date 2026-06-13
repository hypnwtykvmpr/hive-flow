import fc from 'fast-check';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { propertyRunsFromEnv } from '../../__tests__/property-runs.js';
import {
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
    beads: {
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
          openBeads: fc.integer({ min: 0, max: 20 }),
        }),
        (input) => {
          const result = classifyProgressAuthority(baseSnapshot({
            git: {
              available: true,
              dirtyFiles: input.dirtyFiles,
              ahead: input.ahead,
              behind: input.behind,
            },
            beads: {
              available: true,
              inProgress: 0,
              open: input.openBeads,
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
          beadInProgress: fc.integer({ min: 0, max: 5 }),
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
            beads: {
              available: input.beadInProgress > 0,
              inProgress: input.beadInProgress,
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
    expect(source).not.toMatch(/\b(?:bd|beads)\s+(?:ready|update|close|create|claim|sync|dolt)\b/);
    expect(source).toContain("spawnSync('git', ['status', '--short', '--branch']");
    expect(source).toContain("spawnSync('git', ['rev-parse', 'HEAD']");
    expect(source).not.toMatch(/spawnSync\((?!'git')/);
    expect(source).toContain('shell: false');
    expect(source).toContain('timeout: 500');
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
});
