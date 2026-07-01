import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import {
  ClaimService,
  GitHubSync,
  type Claimant,
  type GitHubIssue,
  type IssueClaim,
} from '../claim-service.js';
import { propertyRunsFromEnv } from '../../__tests__/property-runs.js';

const execFileSyncMock = vi.mocked(execFileSync);
const PROPERTY_RUNS = propertyRunsFromEnv(25);

const alice = { type: 'human', userId: 'u-alice', name: 'alice' } satisfies Claimant;
const bob = { type: 'human', userId: 'u-bob', name: 'bob' } satisfies Claimant;
const coderA = { type: 'agent', agentId: 'coder-a', agentType: 'coder' } satisfies Claimant;
const coderB = { type: 'agent', agentId: 'coder-b', agentType: 'coder' } satisfies Claimant;
const coderC = { type: 'agent', agentId: 'coder-c', agentType: 'coder' } satisfies Claimant;
const testerA = { type: 'agent', agentId: 'tester-a', agentType: 'tester' } satisfies Claimant;
const reviewerA = { type: 'agent', agentId: 'reviewer-a', agentType: 'reviewer' } satisfies Claimant;

function makeProjectRoot(): string {
  return mkdtempSync(join(tmpdir(), 'hf-claim-service-'));
}

async function makeService(
  root = makeProjectRoot(),
  config?: ConstructorParameters<typeof ClaimService>[1],
): Promise<{ root: string; service: ClaimService }> {
  const service = new ClaimService(root, config);
  await service.initialize();
  return { root, service };
}

function claimsFile(root: string): string {
  return join(root, '.hive-flow', 'claims', 'claims.json');
}

async function claimMany(service: ClaimService, owner: Claimant, issueIds: string[]): Promise<void> {
  for (const issueId of issueIds) {
    const result = await service.claim(issueId, owner);
    expect(result.success).toBe(true);
  }
}

function claimantKey(claimant: Claimant): string {
  return claimant.type === 'human'
    ? `human:${claimant.userId}`
    : `agent:${claimant.agentType}:${claimant.agentId}`;
}

describe('ClaimService lifecycle', () => {
  let roots: string[];

  beforeEach(() => {
    roots = [];
    vi.useRealTimers();
  });

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function fixture(config?: ConstructorParameters<typeof ClaimService>[1]): Promise<{
    root: string;
    service: ClaimService;
  }> {
    const created = await makeService(undefined, config);
    roots.push(created.root);
    return created;
  }

  it('runs the full claim -> accept handoff -> release lifecycle and records events', async () => {
    const { service } = await fixture();

    const claimed = await service.claim('ISSUE-1', alice);
    expect(claimed.success).toBe(true);
    expect(claimed.claim).toMatchObject({
      issueId: 'ISSUE-1',
      claimant: alice,
      status: 'active',
      progress: 0,
    });

    await expect(service.claim('ISSUE-1', coderA)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('already claimed'),
    });

    await service.requestHandoff('ISSUE-1', alice, coderA, 'implementation ready');
    const pending = await service.getIssueStatus('ISSUE-1');
    expect(pending).toMatchObject({
      status: 'handoff-pending',
      claimant: alice,
      handoffTo: coderA,
      handoffReason: 'implementation ready',
    });

    await service.acceptHandoff('ISSUE-1', coderA);
    const accepted = await service.getIssueStatus('ISSUE-1');
    expect(accepted).toMatchObject({
      status: 'active',
      claimant: coderA,
    });
    expect(accepted?.handoffTo).toBeUndefined();
    expect(accepted?.handoffReason).toBeUndefined();

    await service.release('ISSUE-1', coderA);
    expect(await service.getIssueStatus('ISSUE-1')).toBeNull();

    expect(service.getEventLog().map((event) => event.type)).toEqual([
      'issue:claimed',
      'issue:handoff:requested',
      'issue:handoff:accepted',
      'issue:released',
    ]);
  });

  it('rejects a handoff without changing the current owner', async () => {
    const { service } = await fixture();

    await service.claim('ISSUE-2', alice);
    await service.requestHandoff('ISSUE-2', alice, bob, 'needs human review');

    await expect(service.rejectHandoff('ISSUE-2', coderA, 'wrong recipient')).rejects.toThrow(
      /Handoff not addressed/,
    );

    await service.rejectHandoff('ISSUE-2', bob, 'not available');
    const rejected = await service.getIssueStatus('ISSUE-2');
    expect(rejected).toMatchObject({
      status: 'active',
      claimant: alice,
    });
    expect(rejected?.handoffTo).toBeUndefined();
    expect(service.getEventLog().at(-1)).toMatchObject({
      type: 'issue:handoff:rejected',
      issueId: 'ISSUE-2',
      claimant: bob,
      data: { reason: 'not available' },
    });

    await expect(service.release('ISSUE-2', bob)).rejects.toThrow(/not claimed by/);
    await service.release('ISSUE-2', alice);
    expect(await service.getIssueStatus('ISSUE-2')).toBeNull();
  });

  it('persists claims as JSON and reloads Date fields on a fresh service', async () => {
    const { root, service } = await fixture();

    await service.claim('ISSUE-3', coderA);
    await service.updateProgress('ISSUE-3', 42);
    await service.updateStatus('ISSUE-3', 'blocked', 'waiting for dependency');

    const raw = JSON.parse(readFileSync(claimsFile(root), 'utf8')) as { claims: IssueClaim[] };
    expect(raw.claims).toHaveLength(1);
    expect(raw.claims[0]).toMatchObject({
      issueId: 'ISSUE-3',
      status: 'blocked',
      blockReason: 'waiting for dependency',
      progress: 42,
    });

    const reloaded = new ClaimService(root);
    await reloaded.initialize();
    const claim = await reloaded.getIssueStatus('ISSUE-3');
    expect(claim).toMatchObject({
      issueId: 'ISSUE-3',
      claimant: coderA,
      status: 'blocked',
      progress: 42,
    });
    expect(claim?.claimedAt).toBeInstanceOf(Date);
    expect(claim?.statusChangedAt).toBeInstanceOf(Date);
  });

  it('isolates a corrupt persistence document by starting with an empty claim set', async () => {
    const { root } = await fixture();
    writeFileSync(claimsFile(root), '{"claims":[{"issueId":"ok"}]\nnot-json\n');

    const service = new ClaimService(root);
    await service.initialize();

    expect(await service.getAllClaims()).toEqual([]);
  });

  it('allows one scheduled recipient to accept a pending handoff when duplicate accepts race', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async (scheduler) => {
        const { root, service } = await makeService();
        try {
          await service.claim('ISSUE-RACE', alice);
          await service.requestHandoff('ISSUE-RACE', alice, coderA, 'race check');

          const scheduledAccept = scheduler.scheduleFunction((label: string) =>
            service.acceptHandoff('ISSUE-RACE', coderA).then(
              () => ({ label, ok: true as const }),
              (error: unknown) => ({ label, ok: false as const, error }),
            )
          );

          const first = scheduledAccept('first');
          const second = scheduledAccept('second');
          await scheduler.waitAll();

          const results = await Promise.all([first, second]);
          expect(results.filter((result) => result.ok)).toHaveLength(1);
          expect(results.filter((result) => !result.ok)).toHaveLength(1);

          const finalClaim = await service.getIssueStatus('ISSUE-RACE');
          expect(finalClaim).toMatchObject({
            status: 'active',
            claimant: coderA,
          });
          expect(service.getEventLog().filter((event) => event.type === 'issue:handoff:accepted')).toHaveLength(1);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }),
      { seed: 70_701, numRuns: PROPERTY_RUNS },
    );
  });
});

describe('ClaimService work stealing and rebalancing', () => {
  let roots: string[];

  beforeEach(() => {
    roots = [];
  });

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  async function fixture(config?: ConstructorParameters<typeof ClaimService>[1]): Promise<ClaimService> {
    const { root, service } = await makeService(undefined, config);
    roots.push(root);
    return service;
  }

  it('authorizes same-type and configured cross-type steals, then transfers ownership with context', async () => {
    const sameTypeService = await fixture({ requireSameType: true });
    await sameTypeService.claim('STEAL-1', coderA);
    await sameTypeService.markStealable('STEAL-1', {
      reason: 'voluntary',
      stealableAt: new Date('2026-01-01T00:00:00.000Z'),
      preferredTypes: ['coder'],
      progress: 12,
      context: 'handover notes',
    });

    await expect(sameTypeService.steal('STEAL-1', testerA)).resolves.toMatchObject({
      success: false,
      error: 'Cross-type steal not allowed',
    });

    const stolenByCoder = await sameTypeService.steal('STEAL-1', coderB);
    expect(stolenByCoder).toMatchObject({
      success: true,
      previousOwner: coderA,
      context: { reason: 'voluntary', progress: 12, context: 'handover notes' },
    });
    expect(await sameTypeService.getIssueStatus('STEAL-1')).toMatchObject({
      status: 'active',
      claimant: coderB,
    });
    expect(await sameTypeService.getStealable()).toEqual([]);

    const crossTypeService = await fixture({ requireSameType: true });
    await crossTypeService.claim('STEAL-2', testerA);
    await crossTypeService.markStealable('STEAL-2', {
      reason: 'blocked-timeout',
      stealableAt: new Date('2026-01-01T00:00:00.000Z'),
      progress: 5,
    });

    await expect(crossTypeService.steal('STEAL-2', reviewerA)).resolves.toMatchObject({
      success: true,
      previousOwner: testerA,
    });
  });

  it('rejects stealing unclaimed or active work and filters stealable work by preferred agent type', async () => {
    const service = await fixture();

    await expect(service.steal('MISSING', coderA)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('not claimed'),
    });

    await service.claim('ACTIVE', coderA);
    await expect(service.steal('ACTIVE', coderB)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('not stealable'),
    });

    await service.claim('PREFERRED', testerA);
    await service.markStealable('PREFERRED', {
      reason: 'stale',
      stealableAt: new Date(),
      preferredTypes: ['reviewer'],
      progress: 10,
    });

    expect(await service.getStealable('coder')).toEqual([]);
    expect((await service.getStealable('reviewer')).map((claim) => claim.issueId)).toEqual(['PREFERRED']);
  });

  it('suggests low-progress moves from overloaded agents to underloaded agents of the same type', async () => {
    const service = await fixture({ overloadThreshold: 5 });

    await claimMany(service, coderA, ['RB-1', 'RB-2', 'RB-3', 'RB-4', 'RB-5']);
    await claimMany(service, coderB, ['RB-6']);
    await claimMany(service, coderC, ['RB-7']);
    await service.updateProgress('RB-1', 5);
    await service.updateProgress('RB-2', 24);
    await service.updateProgress('RB-3', 25);
    await service.updateProgress('RB-4', 90);
    await service.updateProgress('RB-5', 100);
    await service.updateProgress('RB-6', 30);
    await service.updateProgress('RB-7', 40);

    const result = await service.rebalance('swarm-1');

    expect(result.moved).toEqual([]);
    expect(result.suggested).toHaveLength(2);
    expect(result.suggested.map((suggestion) => suggestion.issueId)).toEqual(['RB-1', 'RB-2']);
    expect(result.suggested.map((suggestion) => claimantKey(suggestion.currentOwner))).toEqual([
      claimantKey(coderA),
      claimantKey(coderA),
    ]);
    expect(result.suggested.every((suggestion) => suggestion.suggestedOwner.type === 'agent')).toBe(true);
    expect(
      result.suggested.every(
        (suggestion) =>
          suggestion.suggestedOwner.type === 'agent' &&
          ['coder-b', 'coder-c'].includes(suggestion.suggestedOwner.agentId),
      ),
    ).toBe(true);
  });

  it('does not rebalance human claims, single-agent swarms, or high-progress work', async () => {
    const humanOnly = await fixture();
    await humanOnly.claim('HUMAN-1', alice);
    expect(await humanOnly.rebalance('swarm-human')).toEqual({ moved: [], suggested: [] });

    const singleAgent = await fixture({ overloadThreshold: 2 });
    await claimMany(singleAgent, coderA, ['SINGLE-1', 'SINGLE-2']);
    expect(await singleAgent.rebalance('swarm-single')).toEqual({ moved: [], suggested: [] });

    const highProgress = await fixture({ overloadThreshold: 4 });
    await claimMany(highProgress, coderA, ['HIGH-1', 'HIGH-2', 'HIGH-3', 'HIGH-4']);
    await claimMany(highProgress, coderB, ['HIGH-5']);
    await claimMany(highProgress, coderC, ['HIGH-6']);
    await highProgress.updateProgress('HIGH-1', 25);
    await highProgress.updateProgress('HIGH-2', 75);
    await highProgress.updateProgress('HIGH-3', 90);
    await highProgress.updateProgress('HIGH-4', 100);
    expect(await highProgress.rebalance('swarm-high')).toEqual({ moved: [], suggested: [] });
  });
});

describe('GitHubSync', () => {
  let root: string;
  let service: ClaimService;
  let sync: GitHubSync;

  beforeEach(async () => {
    root = makeProjectRoot();
    service = new ClaimService(root);
    await service.initialize();
    sync = new GitHubSync(service, { enabled: true, repo: 'owner/repo' });
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('loads GitHub issues through gh and normalizes labels, assignees, state, and dates', async () => {
    execFileSyncMock.mockImplementation((command, args) => {
      if (command === 'gh' && Array.isArray(args) && args[0] === '--version') {
        return Buffer.from('gh version 2.0.0');
      }
      if (command === 'gh' && Array.isArray(args) && args[0] === 'issue' && args[1] === 'list') {
        return JSON.stringify([
          {
            number: 7,
            title: 'Test issue',
            body: null,
            state: 'OPEN',
            labels: [{ name: 'bug' }],
            assignees: [{ login: 'alice' }],
            url: 'https://github.com/owner/repo/issues/7',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-02T00:00:00Z',
          },
        ]);
      }
      throw new Error(`unexpected command: ${command} ${Array.isArray(args) ? args.join(' ') : ''}`);
    });

    const result = await sync.syncIssues('open');

    expect(result.success).toBe(true);
    expect(result.synced).toBe(1);
    expect(result.issues).toHaveLength(1);
    const issue = result.issues?.[0] as GitHubIssue;
    expect(issue).toMatchObject({
      number: 7,
      title: 'Test issue',
      body: '',
      state: 'open',
      labels: ['bug'],
      assignees: ['alice'],
      url: 'https://github.com/owner/repo/issues/7',
    });
    expect(issue.createdAt).toBeInstanceOf(Date);
    expect(issue.updatedAt).toBeInstanceOf(Date);
    expect(execFileSyncMock).toHaveBeenCalledWith('gh', [
      'issue',
      'list',
      '--repo',
      'owner/repo',
      '--state',
      'open',
      '--json',
      'number,title,body,state,labels,assignees,url,createdAt,updatedAt',
      '--limit',
      '100',
    ], { encoding: 'utf-8' });
  });

  it('claims and releases GitHub issues through gh without invoking a shell', async () => {
    execFileSyncMock.mockReturnValue(Buffer.from('ok'));

    const claimResult = await sync.claimOnGitHub(12, alice);
    const releaseResult = await sync.releaseOnGitHub(12, alice);

    expect(claimResult).toEqual({ success: true, synced: 1, errors: [] });
    expect(releaseResult).toEqual({ success: true, synced: 1, errors: [] });
    expect(execFileSyncMock).toHaveBeenCalledWith('gh', ['--version'], { stdio: 'ignore' });
    expect(execFileSyncMock).toHaveBeenCalledWith('gh', [
      'issue',
      'edit',
      '12',
      '--repo',
      'owner/repo',
      '--add-label',
      'claimed',
    ], { stdio: 'ignore' });
    expect(execFileSyncMock).toHaveBeenCalledWith('gh', [
      'issue',
      'edit',
      '12',
      '--repo',
      'owner/repo',
      '--add-assignee',
      'alice',
    ], { stdio: 'ignore' });
    expect(execFileSyncMock).toHaveBeenCalledWith('gh', [
      'issue',
      'edit',
      '12',
      '--repo',
      'owner/repo',
      '--remove-label',
      'claimed',
    ], { stdio: 'ignore' });
    expect(execFileSyncMock).toHaveBeenCalledWith('gh', [
      'issue',
      'edit',
      '12',
      '--repo',
      'owner/repo',
      '--remove-assignee',
      'alice',
    ], { stdio: 'ignore' });
    expect(execFileSyncMock.mock.calls.every((call) => call[0] === 'gh')).toBe(true);
  });

  it('rejects invalid GitHub inputs before calling gh issue commands', async () => {
    execFileSyncMock.mockReturnValue(Buffer.from('gh version 2.0.0'));
    const invalidRepoSync = new GitHubSync(service, { enabled: true, repo: 'owner/repo;rm -rf' });
    const invalidLabelSync = new GitHubSync(service, {
      enabled: true,
      repo: 'owner/repo',
      claimLabel: 'claimed;bad',
    });

    await expect(sync.claimOnGitHub(0, alice)).resolves.toMatchObject({
      success: false,
      errors: ['Invalid issue number'],
    });
    await expect(invalidRepoSync.syncIssues('open')).resolves.toMatchObject({
      success: false,
      errors: ['Could not determine GitHub repository'],
    });
    await expect(invalidLabelSync.claimOnGitHub(1, alice)).resolves.toMatchObject({
      success: false,
      errors: ['Invalid claim label configuration'],
    });

    expect(execFileSyncMock.mock.calls.filter((call) => call[1]?.[0] === 'issue')).toHaveLength(0);
  });

  it('bulk-syncs numeric local claim ids and returns GitHub failures without throwing', async () => {
    await service.claim('issue-101', alice);
    await service.claim('no-number', coderA);
    execFileSyncMock.mockImplementation((command, args) => {
      if (command === 'gh' && Array.isArray(args) && args[0] === '--version') {
        return Buffer.from('gh version 2.0.0');
      }
      if (command === 'gh' && Array.isArray(args) && args[0] === 'issue' && args[1] === 'edit') {
        throw new Error('label missing');
      }
      return Buffer.from('ok');
    });

    const result = await sync.syncAllClaimsToGitHub();

    expect(result).toEqual({
      success: false,
      synced: 0,
      errors: [
        'Failed to add claim label (label may not exist)',
        'Failed to assign issue',
      ],
    });
  });
});
