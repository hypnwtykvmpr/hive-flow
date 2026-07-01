import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (hoisted before imports) ───────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { githubTools } from '../mcp-tools/github-tools.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

interface GitHubStore {
  repos: Record<string, unknown>;
  prs: Record<string, unknown>;
  issues: Record<string, unknown>;
  version: string;
}

const repoAnalyzeTool = githubTools.find((t) => t.name === 'github_repo_analyze')!;
const prManageTool = githubTools.find((t) => t.name === 'github_pr_manage')!;
const issueTrackTool = githubTools.find((t) => t.name === 'github_issue_track')!;
const workflowTool = githubTools.find((t) => t.name === 'github_workflow')!;
const metricsTool = githubTools.find((t) => t.name === 'github_metrics')!;

/**
 * Set up fs mocks so the GitHub store loads/saves correctly.
 * gh CLI is NOT available by default (execFileSync throws).
 */
function setupMocks(
  initialStore: GitHubStore = { repos: {}, prs: {}, issues: {}, version: '3.0.0' },
) {
  let currentStore = JSON.parse(JSON.stringify(initialStore));

  // Reset the cached _ghAvailable flag by making auth status throw
  (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
    throw new Error('gh not available');
  });

  (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('store.json')) return true;
    return false;
  });

  (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('store.json')) {
      return JSON.stringify(currentStore);
    }
    throw new Error(`ENOENT: no such file '${p}'`);
  });

  (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(
    (_path: string, data: string) => {
      try {
        currentStore = JSON.parse(data);
      } catch {
        // non-JSON write, ignore
      }
    },
  );

  (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});

  return {
    getPersistedStore: () => currentStore as GitHubStore,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('github-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the module-level _ghAvailable cache between tests
    // We achieve this by making execFileSync always throw initially
  });

  // ========================================================================
  // Tool registration
  // ========================================================================

  describe('tool registration', () => {
    it('exports all expected tools', () => {
      const names = githubTools.map((t) => t.name);
      expect(names).toContain('github_repo_analyze');
      expect(names).toContain('github_pr_manage');
      expect(names).toContain('github_issue_track');
      expect(names).toContain('github_workflow');
      expect(names).toContain('github_metrics');
    });

    it('all tools have category "github"', () => {
      for (const tool of githubTools) {
        expect(tool.category).toBe('github');
      }
    });

    it('all tools have inputSchema with type "object"', () => {
      for (const tool of githubTools) {
        expect(tool.inputSchema.type).toBe('object');
      }
    });
  });

  // ========================================================================
  // github_repo_analyze — simulated fallback
  // ========================================================================

  describe('github_repo_analyze', () => {
    it('returns simulated result when gh is unavailable', async () => {
      setupMocks();
      const result = (await repoAnalyzeTool.handler({
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'develop',
      })) as Record<string, unknown>;

      expect(result.simulated).toBe(true);
      expect(result.githubExecuted).toBe(false);
      expect(result.source).toBe('synthetic-github-fallback');
      expect(result.warning).toMatch(/not live GitHub metrics/i);
      expect(result.success).toBe(true);
      expect(result.repository).toBe('test-owner/test-repo');
      expect(result.branch).toBe('develop');
      expect(result.metrics).toBeDefined();
      expect(result.analysis).toBeDefined();
      expect(result.lastAnalyzed).toBeDefined();
    });

    it('uses default values when owner/repo/branch are omitted', async () => {
      setupMocks();
      const result = (await repoAnalyzeTool.handler({})) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.repository).toBe('owner/repo');
      expect(result.branch).toBe('main');
    });

    it('persists repo info to the store', async () => {
      const { getPersistedStore } = setupMocks();
      await repoAnalyzeTool.handler({ owner: 'acme', repo: 'lib' });

      const store = getPersistedStore();
      expect(store.repos['acme/lib']).toBeDefined();
    });
  });

  // ========================================================================
  // github_pr_manage — simulated fallback
  // ========================================================================

  describe('github_pr_manage', () => {
    it('lists PRs from store (simulated)', async () => {
      setupMocks({
        repos: {},
        prs: {
          'pr-1': { id: 'pr-1', title: 'Fix bug', status: 'open', branch: 'fix', createdAt: '2025-01-01' },
        },
        issues: {},
        version: '3.0.0',
      });

      const result = (await prManageTool.handler({ action: 'list' })) as Record<string, unknown>;

      expect(result.simulated).toBe(true);
      expect(result.githubExecuted).toBe(false);
      expect(result.source).toBe('local-github-cache-fallback');
      expect(result.warning).toMatch(/local hive-flow GitHub store/i);
      expect(result.success).toBe(true);
      expect(result.total).toBe(1);
      expect(result.open).toBe(1);
    });

    it('creates a PR (simulated)', async () => {
      const { getPersistedStore } = setupMocks();

      const result = (await prManageTool.handler({
        action: 'create',
        title: 'Add feature',
        branch: 'feat-x',
        baseBranch: 'main',
      })) as Record<string, unknown>;

      expect(result.simulated).toBe(true);
      expect(result.githubExecuted).toBe(false);
      expect(result.source).toBe('local-github-store-mutation');
      expect(result.warning).toMatch(/no GitHub API mutation was performed/i);
      expect(result.success).toBe(true);
      expect(result.action).toBe('created');
      expect(result.url).toBeDefined();

      const store = getPersistedStore();
      expect(Object.keys(store.prs).length).toBe(1);
    });

    it('reviews a PR (simulated)', async () => {
      setupMocks();

      const result = (await prManageTool.handler({
        action: 'review',
        prNumber: 42,
      })) as Record<string, unknown>;

      expect(result.simulated).toBe(true);
      expect(result.githubExecuted).toBe(false);
      expect(result.source).toBe('synthetic-github-fallback');
      expect(result.warning).toMatch(/not live GitHub metrics/i);
      expect(result.success).toBe(false);
      expect(result.action).toBe('review_unavailable');
      expect(result.prNumber).toBe(42);
      expect(result.reviewed).toBe(false);
      expect((result.review as Record<string, unknown>).status).toBe('unavailable');
    });

    it('merges a PR (simulated)', async () => {
      setupMocks();

      const result = (await prManageTool.handler({
        action: 'merge',
        prNumber: 10,
      })) as Record<string, unknown>;

      expect(result.simulated).toBe(true);
      expect(result.githubExecuted).toBe(false);
      expect(result.source).toBe('local-github-store-mutation');
      expect(result.warning).toMatch(/no GitHub API mutation was performed/i);
      expect(result.success).toBe(true);
      expect(result.action).toBe('merged');
      expect(result.mergedAt).toBeDefined();
    });

    it('closes a PR (simulated)', async () => {
      setupMocks();

      const result = (await prManageTool.handler({
        action: 'close',
        prNumber: 5,
      })) as Record<string, unknown>;

      expect(result.simulated).toBe(true);
      expect(result.githubExecuted).toBe(false);
      expect(result.source).toBe('local-github-store-mutation');
      expect(result.warning).toMatch(/no GitHub API mutation was performed/i);
      expect(result.success).toBe(true);
      expect(result.action).toBe('closed');
      expect(result.closedAt).toBeDefined();
    });

    it('returns error for unknown action', async () => {
      setupMocks();

      const result = (await prManageTool.handler({
        action: 'invalid',
      })) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown action');
    });

    it('defaults action to list', async () => {
      setupMocks();

      const result = (await prManageTool.handler({})) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.simulated).toBe(true);
      expect(result).toHaveProperty('pullRequests');
    });
  });

  // ========================================================================
  // github_issue_track — simulated fallback
  // ========================================================================

  describe('github_issue_track', () => {
    it('lists issues from store (simulated)', async () => {
      setupMocks({
        repos: {},
        prs: {},
        issues: {
          'issue-1': { id: 'issue-1', title: 'Bug', status: 'open', labels: ['bug'], createdAt: '2025-01-01' },
        },
        version: '3.0.0',
      });

      const result = (await issueTrackTool.handler({ action: 'list' })) as Record<string, unknown>;

      expect(result.simulated).toBe(true);
      expect(result.success).toBe(true);
      expect(result.total).toBe(1);
      expect(result.open).toBe(1);
    });

    it('creates an issue (simulated)', async () => {
      const { getPersistedStore } = setupMocks();

      const result = (await issueTrackTool.handler({
        action: 'create',
        title: 'New bug',
        labels: ['bug', 'priority'],
      })) as Record<string, unknown>;

      expect(result.simulated).toBe(true);
      expect(result.success).toBe(true);
      expect(result.action).toBe('created');

      const store = getPersistedStore();
      expect(Object.keys(store.issues).length).toBe(1);
    });

    it('updates an issue (simulated)', async () => {
      setupMocks();

      const result = (await issueTrackTool.handler({
        action: 'update',
        issueNumber: 7,
        title: 'Updated title',
      })) as Record<string, unknown>;

      expect(result.simulated).toBe(true);
      expect(result.success).toBe(true);
      expect(result.action).toBe('updated');
    });

    it('closes an issue (simulated)', async () => {
      setupMocks();

      const result = (await issueTrackTool.handler({
        action: 'close',
        issueNumber: 3,
      })) as Record<string, unknown>;

      expect(result.simulated).toBe(true);
      expect(result.success).toBe(true);
      expect(result.action).toBe('closed');
      expect(result.closedAt).toBeDefined();
    });

    it('returns error for unknown action', async () => {
      setupMocks();

      const result = (await issueTrackTool.handler({
        action: 'invalid',
      })) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown action');
    });
  });

  // ========================================================================
  // github_workflow — simulated fallback
  // ========================================================================

  describe('github_workflow', () => {
    it('lists workflows (simulated)', async () => {
      setupMocks();

      const result = (await workflowTool.handler({ action: 'list' })) as Record<string, unknown>;

      expect(result.simulated).toBe(true);
      expect(result.success).toBe(true);
      expect(result.available).toBe(false);
      expect(Array.isArray(result.workflows)).toBe(true);
      expect((result.workflows as unknown[])).toEqual([]);
    });

    it('triggers a workflow (simulated)', async () => {
      setupMocks();

      const result = (await workflowTool.handler({
        action: 'trigger',
        workflowId: 'ci.yml',
        ref: 'develop',
      })) as Record<string, unknown>;

      expect(result.simulated).toBe(true);
      expect(result.success).toBe(false);
      expect(result.action).toBe('trigger_unavailable');
      expect(result.workflowId).toBe('ci.yml');
      expect(result.ref).toBe('develop');
      expect(result.triggered).toBe(false);
      expect(result.runId).toBeUndefined();
    });

    it('gets workflow status (simulated)', async () => {
      setupMocks();

      const result = (await workflowTool.handler({
        action: 'status',
        workflowId: 'ci.yml',
      })) as Record<string, unknown>;

      expect(result.simulated).toBe(true);
      expect(result.success).toBe(false);
      expect(result.available).toBe(false);
      expect(result.status).toBe('unknown');
      expect(result.conclusion).toBeNull();
    });

    it('cancels a workflow (simulated)', async () => {
      setupMocks();

      const result = (await workflowTool.handler({
        action: 'cancel',
        workflowId: 'ci.yml',
      })) as Record<string, unknown>;

      expect(result.simulated).toBe(true);
      expect(result.success).toBe(false);
      expect(result.action).toBe('cancel_unavailable');
      expect(result.cancelled).toBe(false);
      expect(result.cancelledAt).toBeUndefined();
    });

    it('returns error for unknown action', async () => {
      setupMocks();

      const result = (await workflowTool.handler({
        action: 'unknown',
      })) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown action');
    });
  });

  // ========================================================================
  // github_metrics — simulated fallback
  // ========================================================================

  describe('github_metrics', () => {
    it('returns all metrics (simulated)', async () => {
      setupMocks();

      const result = (await metricsTool.handler({ metric: 'all' })) as Record<string, unknown>;

      expect(result.simulated).toBe(true);
      expect(result.githubExecuted).toBe(false);
      expect(result.source).toBe('synthetic-github-fallback');
      expect(result.warning).toMatch(/not live GitHub metrics/i);
      expect(result.success).toBe(true);
      expect(result.metrics).toBeDefined();
      const metrics = result.metrics as Record<string, unknown>;
      expect(metrics).toHaveProperty('commits');
      expect(metrics).toHaveProperty('contributors');
      expect(metrics).toHaveProperty('traffic');
      expect(metrics).toHaveProperty('releases');
    });

    it('returns specific metric (simulated)', async () => {
      setupMocks();

      const result = (await metricsTool.handler({ metric: 'commits' })) as Record<string, unknown>;

      expect(result.simulated).toBe(true);
      expect(result.success).toBe(true);
      expect(result.metric).toBe('commits');
      expect(result.data).toBeDefined();
    });

    it('defaults metric to "all"', async () => {
      setupMocks();

      const result = (await metricsTool.handler({})) as Record<string, unknown>;

      expect(result.simulated).toBe(true);
      expect(result.success).toBe(true);
      expect(result.metrics).toBeDefined();
    });
  });
});
