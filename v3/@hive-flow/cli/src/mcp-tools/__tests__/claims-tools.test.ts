/**
 * Tests for claims-tools.ts
 *
 * Covers: module structure, handler existence, core claim operations,
 * invalid-format errors, and duplicate-claim protection.
 *
 * The file-system layer (loadClaims / saveClaims) is mocked so tests run
 * without touching the real working directory.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── fs mock ──────────────────────────────────────────────────────────────────
// Must be hoisted before the module-under-test is imported.
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));

import { claimsTools } from '../claims-tools.js';
import * as fs from 'fs';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Return the handler for a named tool, throwing if not found. */
function getHandler(name: string) {
  const tool = claimsTools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool.handler;
}

/** Build a minimal in-memory ClaimsStore JSON string. */
function makeStoreJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ claims: {}, stealable: {}, contests: {}, ...overrides });
}

// ── module-level checks ───────────────────────────────────────────────────────

describe('claimsTools module', () => {
  it('exports an array', () => {
    expect(Array.isArray(claimsTools)).toBe(true);
  });

  it('exports at least one tool', () => {
    expect(claimsTools.length).toBeGreaterThan(0);
  });

  const expectedNames = [
    'claims_claim',
    'claims_release',
    'claims_handoff',
    'claims_accept-handoff',
    'claims_status',
    'claims_list',
    'claims_mark-stealable',
    'claims_steal',
    'claims_stealable',
    'claims_load',
    'claims_board',
    'claims_rebalance',
  ];

  it.each(expectedNames)('has tool "%s"', (name) => {
    expect(claimsTools.some(t => t.name === name)).toBe(true);
  });

  it('every tool has a name, description, inputSchema and handler', () => {
    for (const tool of claimsTools) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('every tool belongs to the "claims" category', () => {
    for (const tool of claimsTools) {
      expect(tool.category).toBe('claims');
    }
  });
});

// ── claims_claim ──────────────────────────────────────────────────────────────

describe('claims_claim handler', () => {
  const handler = getHandler('claims_claim');

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.renameSync).mockReset();
  });

  it('rejects an invalid claimant format', async () => {
    const result = await handler({ issueId: 'ISSUE-1', claimant: 'badformat' }) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  it('creates a claim for a valid human claimant', async () => {
    const result = await handler({ issueId: 'ISSUE-1', claimant: 'human:user-1:Alice' }) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect((result.claim as Record<string, unknown>).issueId).toBe('ISSUE-1');
    expect((result.claim as Record<string, unknown>).status).toBe('active');
  });

  it('creates a claim for a valid agent claimant', async () => {
    const result = await handler({ issueId: 'ISSUE-2', claimant: 'agent:coder-1:coder' }) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect((result.claim as Record<string, unknown>).issueId).toBe('ISSUE-2');
  });

  it('rejects duplicate claim on the same issue', async () => {
    // Simulate an existing claim in the store
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      makeStoreJson({
        claims: {
          'ISSUE-3': {
            issueId: 'ISSUE-3',
            claimant: { type: 'human', userId: 'user-1', name: 'Alice' },
            claimedAt: new Date().toISOString(),
            status: 'active',
            statusChangedAt: new Date().toISOString(),
            progress: 0,
          },
        },
      })
    );

    const result = await handler({ issueId: 'ISSUE-3', claimant: 'agent:coder-1:coder' }) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/already claimed/i);
  });

  it('stores context when provided', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await handler({ issueId: 'ISSUE-4', claimant: 'human:user-2:Bob', context: 'fixing auth' }) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect((result.claim as Record<string, unknown>).context).toBe('fixing auth');
  });
});

// ── claims_release ────────────────────────────────────────────────────────────

describe('claims_release handler', () => {
  const handler = getHandler('claims_release');

  beforeEach(() => {
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.renameSync).mockReset();
  });

  it('fails with invalid claimant format', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await handler({ issueId: 'ISSUE-1', claimant: 'invalid' }) as Record<string, unknown>;
    expect(result.success).toBe(false);
  });

  it('fails when the issue is not claimed', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await handler({ issueId: 'ISSUE-X', claimant: 'human:user-1:Alice' }) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/not claimed/i);
  });

  it('fails when a non-owner tries to release', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      makeStoreJson({
        claims: {
          'ISSUE-5': {
            issueId: 'ISSUE-5',
            claimant: { type: 'human', userId: 'user-1', name: 'Alice' },
            claimedAt: new Date().toISOString(),
            status: 'active',
            statusChangedAt: new Date().toISOString(),
            progress: 0,
          },
        },
      })
    );
    const result = await handler({ issueId: 'ISSUE-5', claimant: 'human:user-2:Bob' }) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/only the current claimant/i);
  });

  it('succeeds when the owner releases', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      makeStoreJson({
        claims: {
          'ISSUE-6': {
            issueId: 'ISSUE-6',
            claimant: { type: 'human', userId: 'user-1', name: 'Alice' },
            claimedAt: new Date().toISOString(),
            status: 'active',
            statusChangedAt: new Date().toISOString(),
            progress: 0,
          },
        },
      })
    );
    const result = await handler({ issueId: 'ISSUE-6', claimant: 'human:user-1:Alice' }) as Record<string, unknown>;
    expect(result.success).toBe(true);
  });
});

// ── claims_handoff ────────────────────────────────────────────────────────────

describe('claims_handoff handler', () => {
  const handler = getHandler('claims_handoff');

  it('fails with invalid from/to claimant', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await handler({ issueId: 'X', from: 'bad', to: 'bad' }) as Record<string, unknown>;
    expect(result.success).toBe(false);
  });

  it('sets status to handoff-pending when valid', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      makeStoreJson({
        claims: {
          'ISSUE-7': {
            issueId: 'ISSUE-7',
            claimant: { type: 'human', userId: 'user-1', name: 'Alice' },
            claimedAt: new Date().toISOString(),
            status: 'active',
            statusChangedAt: new Date().toISOString(),
            progress: 30,
          },
        },
      })
    );
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.renameSync).mockReset();

    const result = await handler({
      issueId: 'ISSUE-7',
      from: 'human:user-1:Alice',
      to: 'agent:coder-1:coder',
      reason: 'handing over',
    }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect((result.claim as Record<string, unknown>).status).toBe('handoff-pending');
  });
});

// ── claims_accept-handoff ─────────────────────────────────────────────────────

describe('claims_accept-handoff handler', () => {
  const handler = getHandler('claims_accept-handoff');

  it('fails when no pending handoff exists', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      makeStoreJson({
        claims: {
          'ISSUE-8': {
            issueId: 'ISSUE-8',
            claimant: { type: 'human', userId: 'user-1', name: 'Alice' },
            claimedAt: new Date().toISOString(),
            status: 'active',
            statusChangedAt: new Date().toISOString(),
            progress: 0,
          },
        },
      })
    );
    const result = await handler({ issueId: 'ISSUE-8', claimant: 'agent:coder-1:coder' }) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/no pending handoff/i);
  });

  it('transfers ownership when claimant matches handoffTo', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      makeStoreJson({
        claims: {
          'ISSUE-9': {
            issueId: 'ISSUE-9',
            claimant: { type: 'human', userId: 'user-1', name: 'Alice' },
            claimedAt: new Date().toISOString(),
            status: 'handoff-pending',
            statusChangedAt: new Date().toISOString(),
            progress: 50,
            handoffTo: { type: 'agent', agentId: 'coder-1', agentType: 'coder' },
          },
        },
      })
    );
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.renameSync).mockReset();

    const result = await handler({ issueId: 'ISSUE-9', claimant: 'agent:coder-1:coder' }) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect((result.claim as Record<string, unknown>).status).toBe('active');
  });
});

// ── claims_status ─────────────────────────────────────────────────────────────

describe('claims_status handler', () => {
  const handler = getHandler('claims_status');

  it('fails when issue is not claimed', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await handler({ issueId: 'ISSUE-X', status: 'paused' }) as Record<string, unknown>;
    expect(result.success).toBe(false);
  });

  it('updates status to paused', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      makeStoreJson({
        claims: {
          'ISSUE-10': {
            issueId: 'ISSUE-10',
            claimant: { type: 'human', userId: 'user-1', name: 'Alice' },
            claimedAt: new Date().toISOString(),
            status: 'active',
            statusChangedAt: new Date().toISOString(),
            progress: 0,
          },
        },
      })
    );
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.renameSync).mockReset();

    const result = await handler({ issueId: 'ISSUE-10', status: 'paused' }) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect((result.claim as Record<string, unknown>).status).toBe('paused');
  });

  it('clamps progress to 0-100', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      makeStoreJson({
        claims: {
          'ISSUE-11': {
            issueId: 'ISSUE-11',
            claimant: { type: 'human', userId: 'user-1', name: 'Alice' },
            claimedAt: new Date().toISOString(),
            status: 'active',
            statusChangedAt: new Date().toISOString(),
            progress: 50,
          },
        },
      })
    );
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.renameSync).mockReset();

    const result = await handler({ issueId: 'ISSUE-11', status: 'active', progress: 150 }) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect((result.claim as Record<string, unknown>).progress).toBe(100);
  });
});

// ── claims_list ───────────────────────────────────────────────────────────────

describe('claims_list handler', () => {
  const handler = getHandler('claims_list');

  it('returns an empty list when there are no claims', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await handler({}) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
  });

  it('filters by status', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      makeStoreJson({
        claims: {
          A: { issueId: 'A', claimant: { type: 'human', userId: 'u1', name: 'A' }, status: 'active', claimedAt: '', statusChangedAt: '', progress: 0 },
          B: { issueId: 'B', claimant: { type: 'human', userId: 'u1', name: 'A' }, status: 'paused', claimedAt: '', statusChangedAt: '', progress: 0 },
        },
      })
    );
    const result = await handler({ status: 'active' }) as Record<string, unknown>;
    expect(result.count).toBe(1);
  });

  it('filters by agentType', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      makeStoreJson({
        claims: {
          A: { issueId: 'A', claimant: { type: 'agent', agentId: 'c1', agentType: 'coder' }, status: 'active', claimedAt: '', statusChangedAt: '', progress: 0 },
          B: { issueId: 'B', claimant: { type: 'agent', agentId: 'r1', agentType: 'reviewer' }, status: 'active', claimedAt: '', statusChangedAt: '', progress: 0 },
        },
      })
    );
    const result = await handler({ agentType: 'coder' }) as Record<string, unknown>;
    expect(result.count).toBe(1);
  });
});

// ── claims_mark-stealable ─────────────────────────────────────────────────────

describe('claims_mark-stealable handler', () => {
  const handler = getHandler('claims_mark-stealable');

  it('fails when issue is not claimed', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await handler({ issueId: 'ISSUE-X', reason: 'voluntary' }) as Record<string, unknown>;
    expect(result.success).toBe(false);
  });

  it('marks a claimed issue as stealable', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      makeStoreJson({
        claims: {
          'ISSUE-12': {
            issueId: 'ISSUE-12',
            claimant: { type: 'agent', agentId: 'c1', agentType: 'coder' },
            claimedAt: new Date().toISOString(),
            status: 'active',
            statusChangedAt: new Date().toISOString(),
            progress: 10,
          },
        },
      })
    );
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.renameSync).mockReset();

    const result = await handler({ issueId: 'ISSUE-12', reason: 'overloaded' }) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect((result.claim as Record<string, unknown>).status).toBe('stealable');
  });
});

// ── claims_steal ──────────────────────────────────────────────────────────────

describe('claims_steal handler', () => {
  const handler = getHandler('claims_steal');

  it('fails with invalid stealer format', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await handler({ issueId: 'X', stealer: 'bad' }) as Record<string, unknown>;
    expect(result.success).toBe(false);
  });

  it('fails when issue is not stealable', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      makeStoreJson({
        claims: {
          'ISSUE-13': {
            issueId: 'ISSUE-13',
            claimant: { type: 'agent', agentId: 'c1', agentType: 'coder' },
            status: 'active',
            claimedAt: '',
            statusChangedAt: '',
            progress: 0,
          },
        },
        stealable: {},
      })
    );
    const result = await handler({ issueId: 'ISSUE-13', stealer: 'agent:c2:coder' }) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/not stealable/i);
  });

  it('blocks stealer not matching preferred types', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      makeStoreJson({
        claims: {
          'ISSUE-14': {
            issueId: 'ISSUE-14',
            claimant: { type: 'agent', agentId: 'c1', agentType: 'coder' },
            status: 'stealable',
            claimedAt: '',
            statusChangedAt: '',
            progress: 0,
          },
        },
        stealable: {
          'ISSUE-14': {
            reason: 'voluntary',
            stealableAt: new Date().toISOString(),
            preferredTypes: ['reviewer'],
            progress: 0,
          },
        },
      })
    );
    const result = await handler({ issueId: 'ISSUE-14', stealer: 'agent:c2:coder' }) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/prefers agent types/i);
  });

  it('successfully steals when stealable and type matches', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      makeStoreJson({
        claims: {
          'ISSUE-15': {
            issueId: 'ISSUE-15',
            claimant: { type: 'agent', agentId: 'c1', agentType: 'coder' },
            status: 'stealable',
            claimedAt: '',
            statusChangedAt: '',
            progress: 0,
          },
        },
        stealable: {
          'ISSUE-15': {
            reason: 'voluntary',
            stealableAt: new Date().toISOString(),
            preferredTypes: ['coder'],
            progress: 0,
          },
        },
      })
    );
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.renameSync).mockReset();

    const result = await handler({ issueId: 'ISSUE-15', stealer: 'agent:c2:coder' }) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect((result.claim as Record<string, unknown>).status).toBe('active');
  });
});

// ── claims_stealable ──────────────────────────────────────────────────────────

describe('claims_stealable handler', () => {
  const handler = getHandler('claims_stealable');

  it('returns all stealable issues', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      makeStoreJson({
        claims: {
          'ISSUE-16': { issueId: 'ISSUE-16', claimant: { type: 'agent', agentId: 'c1', agentType: 'coder' }, status: 'stealable', claimedAt: '', statusChangedAt: '', progress: 5 },
        },
        stealable: {
          'ISSUE-16': { reason: 'stale', stealableAt: new Date().toISOString(), progress: 5 },
        },
      })
    );
    const result = await handler({}) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
  });

  it('filters by agentType when provided', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      makeStoreJson({
        claims: {
          A: { issueId: 'A', claimant: { type: 'agent', agentId: 'c1', agentType: 'coder' }, status: 'stealable', claimedAt: '', statusChangedAt: '', progress: 0 },
          B: { issueId: 'B', claimant: { type: 'agent', agentId: 'r1', agentType: 'reviewer' }, status: 'stealable', claimedAt: '', statusChangedAt: '', progress: 0 },
        },
        stealable: {
          A: { reason: 'voluntary', stealableAt: '', preferredTypes: ['coder'], progress: 0 },
          B: { reason: 'voluntary', stealableAt: '', preferredTypes: ['reviewer'], progress: 0 },
        },
      })
    );
    const result = await handler({ agentType: 'coder' }) as Record<string, unknown>;
    expect(result.count).toBe(1);
  });
});

// ── claims_load ───────────────────────────────────────────────────────────────

describe('claims_load handler', () => {
  const handler = getHandler('claims_load');

  it('returns zero loads when no agent claims exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await handler({}) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.totalAgents).toBe(0);
  });

  it('computes utilization correctly', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      makeStoreJson({
        claims: {
          A: { issueId: 'A', claimant: { type: 'agent', agentId: 'c1', agentType: 'coder' }, status: 'active', claimedAt: '', statusChangedAt: '', progress: 0 },
          B: { issueId: 'B', claimant: { type: 'agent', agentId: 'c1', agentType: 'coder' }, status: 'active', claimedAt: '', statusChangedAt: '', progress: 0 },
        },
      })
    );
    const result = await handler({}) as Record<string, unknown>;
    expect(result.success).toBe(true);
    const loads = result.loads as Array<Record<string, unknown>>;
    expect(loads[0].claimCount).toBe(2);
    expect(loads[0].utilization).toBeCloseTo(0.4);
  });
});

// ── claims_board ──────────────────────────────────────────────────────────────

describe('claims_board handler', () => {
  const handler = getHandler('claims_board');

  it('returns board structure with summary', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await handler({}) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.board).toBeDefined();
    const summary = result.summary as Record<string, unknown>;
    expect(summary.total).toBe(0);
  });

  it('categorises claims by status', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      makeStoreJson({
        claims: {
          A: { issueId: 'A', claimant: { type: 'human', userId: 'u1', name: 'Alice' }, status: 'active', claimedAt: '', statusChangedAt: '', progress: 40 },
          B: { issueId: 'B', claimant: { type: 'human', userId: 'u1', name: 'Alice' }, status: 'blocked', claimedAt: '', statusChangedAt: '', progress: 0, blockReason: 'waiting' },
        },
      })
    );
    const result = await handler({}) as Record<string, unknown>;
    const summary = result.summary as Record<string, unknown>;
    expect(summary.active).toBe(1);
    expect(summary.blocked).toBe(1);
  });
});

// ── claims_rebalance ──────────────────────────────────────────────────────────

describe('claims_rebalance handler', () => {
  const handler = getHandler('claims_rebalance');

  it('returns dry-run result by default', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await handler({}) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
  });

  it('reports metrics even when no agents exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await handler({ dryRun: true }) as Record<string, unknown>;
    const metrics = result.metrics as Record<string, unknown>;
    expect(metrics.totalAgents).toBe(0);
  });
});
