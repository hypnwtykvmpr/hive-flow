/**
 * GitHub MCP Tools for CLI
 *
 * V2/V3 GitHub integration tools — wired to the `gh` CLI when available.
 *
 * - When `gh` is installed and authenticated, tools execute real GitHub API calls
 * - When `gh` is unavailable, tools fall back to local simulated data
 * - All responses include `simulated: boolean` so callers know which path ran
 */

import type { MCPTool } from './types.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Check if `gh` CLI is available and authenticated
let _ghAvailable: boolean | null = null;
function ghAvailable(): boolean {
  if (_ghAvailable !== null) return _ghAvailable;
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe', timeout: 5000 });
    _ghAvailable = true;
  } catch {
    _ghAvailable = false;
  }
  return _ghAvailable;
}

// Run a `gh` command, return parsed JSON or null on failure
function gh(args: string[], cwd?: string): unknown | null {
  try {
    const out = execFileSync('gh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
      encoding: 'utf-8',
      ...(cwd ? { cwd } : {}),
    });
    try {
      return JSON.parse(out);
    } catch {
      return out.trim();
    }
  } catch {
    return null;
  }
}

// Storage paths
const STORAGE_DIR = '.hive-flow';
const GITHUB_DIR = 'github';
const GITHUB_FILE = 'store.json';

interface RepoInfo {
  owner: string;
  name: string;
  branch: string;
  lastAnalyzed?: string;
  metrics?: {
    commits: number;
    branches: number;
    contributors: number;
    openIssues: number;
    openPRs: number;
  };
}

interface GitHubStore {
  repos: Record<string, RepoInfo>;
  prs: Record<string, { id: string; title: string; status: string; branch: string; createdAt: string }>;
  issues: Record<string, { id: string; title: string; status: string; labels: string[]; createdAt: string }>;
  version: string;
}

function getGitHubDir(): string {
  return join(process.cwd(), STORAGE_DIR, GITHUB_DIR);
}

function getGitHubPath(): string {
  return join(getGitHubDir(), GITHUB_FILE);
}

function ensureGitHubDir(): void {
  const dir = getGitHubDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadGitHubStore(): GitHubStore {
  try {
    const path = getGitHubPath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {
    // Return empty store
  }
  return { repos: {}, prs: {}, issues: {}, version: '3.0.0' };
}

function saveGitHubStore(store: GitHubStore): void {
  ensureGitHubDir();
  writeFileSync(getGitHubPath(), JSON.stringify(store, null, 2), 'utf-8');
}

function simulatedGitHubFallback(kind: 'synthetic' | 'local-cache' | 'local-mutation' = 'synthetic') {
  const label = kind === 'synthetic'
    ? 'synthetic-github-fallback'
    : kind === 'local-cache'
      ? 'local-github-cache-fallback'
      : 'local-github-store-mutation';
  const warning = kind === 'local-mutation'
    ? 'GitHub CLI was unavailable or returned no data; no GitHub API mutation was performed. Only the local hive-flow GitHub store was updated.'
    : kind === 'local-cache'
      ? 'GitHub CLI was unavailable or returned no data; response is from the local hive-flow GitHub store, not live GitHub.'
      : 'GitHub CLI was unavailable or returned no data; response uses synthetic placeholder values, not live GitHub metrics.';

  return {
    simulated: true,
    githubExecuted: false,
    source: label,
    warning,
  };
}

export const githubTools: MCPTool[] = [
  {
    name: 'github_repo_analyze',
    description: 'Analyze a GitHub repository',
    category: 'github',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        branch: { type: 'string', description: 'Branch to analyze' },
        deep: { type: 'boolean', description: 'Deep analysis' },
      },
    },
    handler: async (input) => {
      const store = loadGitHubStore();
      const owner = (input.owner as string) || 'owner';
      const repo = (input.repo as string) || 'repo';
      const branch = (input.branch as string) || 'main';
      const repoKey = `${owner}/${repo}`;

      // Try real gh CLI
      if (ghAvailable()) {
        const repoData = gh([
          'repo', 'view', `${owner}/${repo}`,
          '--json', 'name,owner,defaultBranchRef,description,languages,stargazerCount,forkCount,issues,pullRequests,watchers',
        ]) as Record<string, unknown> | null;

        if (repoData && typeof repoData === 'object') {
          const languages = repoData.languages as Array<{ node: { name: string } }> | undefined;
          const langNames = languages?.map(l => l.node?.name || l).filter(Boolean) ?? [];
          const issues = repoData.issues as { totalCount?: number } | undefined;
          const prs = repoData.pullRequests as { totalCount?: number } | undefined;

          const repoInfo: RepoInfo = {
            owner,
            name: repo,
            branch,
            lastAnalyzed: new Date().toISOString(),
            metrics: {
              commits: 0, // gh repo view doesn't expose commit count directly
              branches: 0,
              contributors: 0,
              openIssues: issues?.totalCount ?? 0,
              openPRs: prs?.totalCount ?? 0,
            },
          };

          store.repos[repoKey] = repoInfo;
          saveGitHubStore(store);

          return {
            simulated: false,
            success: true,
            repository: repoKey,
            branch,
            metrics: repoInfo.metrics,
            analysis: {
              languages: langNames.length > 0 ? langNames : ['Unknown'],
              mainLanguage: langNames[0] || 'Unknown',
              description: repoData.description ?? '',
              stars: repoData.stargazerCount ?? 0,
              forks: repoData.forkCount ?? 0,
              watchers: (repoData.watchers as { totalCount?: number })?.totalCount ?? 0,
            },
            lastAnalyzed: repoInfo.lastAnalyzed,
          };
        }
      }

      // Simulated fallback
      const repoInfo: RepoInfo = {
        owner,
        name: repo,
        branch,
        lastAnalyzed: new Date().toISOString(),
        metrics: {
          commits: Math.floor(Math.random() * 1000) + 100,
          branches: Math.floor(Math.random() * 20) + 1,
          contributors: Math.floor(Math.random() * 50) + 1,
          openIssues: Math.floor(Math.random() * 30),
          openPRs: Math.floor(Math.random() * 10),
        },
      };

      store.repos[repoKey] = repoInfo;
      saveGitHubStore(store);

      return {
        ...simulatedGitHubFallback('synthetic'),
        success: true,
        repository: repoKey,
        branch,
        metrics: repoInfo.metrics,
        analysis: {
          languages: ['TypeScript', 'JavaScript', 'JSON'],
          mainLanguage: 'TypeScript',
          codeQuality: 'A',
          testCoverage: `${Math.floor(Math.random() * 30) + 70}%`,
          dependencies: Math.floor(Math.random() * 50) + 20,
          securityIssues: Math.floor(Math.random() * 3),
        },
        lastAnalyzed: repoInfo.lastAnalyzed,
      };
    },
  },
  {
    name: 'github_pr_manage',
    description: 'Manage pull requests',
    category: 'github',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'review', 'merge', 'close'], description: 'Action to perform' },
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        prNumber: { type: 'number', description: 'PR number' },
        title: { type: 'string', description: 'PR title' },
        branch: { type: 'string', description: 'Source branch' },
        baseBranch: { type: 'string', description: 'Target branch' },
        body: { type: 'string', description: 'PR description' },
      },
    },
    handler: async (input) => {
      const store = loadGitHubStore();
      const action = (input.action as string) || 'list';
      const owner = (input.owner as string) || 'owner';
      const repo = (input.repo as string) || 'repo';
      const nwo = `${owner}/${repo}`;

      if (action === 'list') {
        if (ghAvailable()) {
          const data = gh([
            'pr', 'list', '-R', nwo,
            '--json', 'number,title,state,headRefName,baseRefName,createdAt,url',
            '--limit', '30',
          ]) as Array<Record<string, unknown>> | null;
          if (Array.isArray(data)) {
            return {
              simulated: false,
              success: true,
              pullRequests: data.map(pr => ({
                id: pr.number,
                title: pr.title,
                status: (pr.state as string)?.toLowerCase(),
                branch: pr.headRefName,
                baseBranch: pr.baseRefName,
                createdAt: pr.createdAt,
                url: pr.url,
              })),
              total: data.length,
              open: data.filter(pr => (pr.state as string)?.toLowerCase() === 'open').length,
            };
          }
        }
        // Simulated fallback
        const prs = Object.values(store.prs);
        return {
          ...simulatedGitHubFallback('local-cache'),
          success: true,
          pullRequests: prs,
          total: prs.length,
          open: prs.filter(pr => pr.status === 'open').length,
        };
      }

      if (action === 'create') {
        if (ghAvailable()) {
          const title = (input.title as string) || 'New PR';
          const branch = (input.branch as string) || '';
          const baseBranch = (input.baseBranch as string) || 'main';
          const body = (input.body as string) || '';
          const args = ['pr', 'create', '-R', nwo, '--title', title, '--base', baseBranch, '--body', body];
          if (branch) args.push('--head', branch);
          args.push('--json', 'number,title,url,state,createdAt');
          const data = gh(args) as Record<string, unknown> | null;
          if (data && typeof data === 'object') {
            return {
              simulated: false,
              success: true,
              action: 'created',
              pullRequest: data,
              url: data.url,
            };
          }
        }
        // Simulated fallback
        const prId = `pr-${Date.now()}`;
        const pr = {
          id: prId,
          title: (input.title as string) || 'New PR',
          status: 'open',
          branch: (input.branch as string) || 'feature',
          baseBranch: (input.baseBranch as string) || 'main',
          createdAt: new Date().toISOString(),
        };
        store.prs[prId] = pr;
        saveGitHubStore(store);
        return {
          ...simulatedGitHubFallback('local-mutation'),
          success: true,
          action: 'created',
          pullRequest: pr,
          url: `https://github.com/${owner}/${repo}/pull/${prId}`,
        };
      }

      if (action === 'review') {
        if (ghAvailable() && input.prNumber) {
          const data = gh([
            'pr', 'view', String(input.prNumber), '-R', nwo,
            '--json', 'number,title,state,reviews,comments,additions,deletions,changedFiles',
          ]) as Record<string, unknown> | null;
          if (data && typeof data === 'object') {
            return {
              simulated: false,
              success: true,
              action: 'reviewed',
              prNumber: input.prNumber,
              review: data,
            };
          }
        }
        return {
          ...simulatedGitHubFallback('synthetic'),
          success: false,
          action: 'review_unavailable',
          prNumber: input.prNumber,
          reviewed: false,
          review: {
            status: 'unavailable',
            comments: [],
            suggestion: 'GitHub CLI was unavailable; no pull request review was performed.',
          },
        };
      }

      if (action === 'merge') {
        const prNumber = input.prNumber as number;
        if (ghAvailable() && prNumber) {
          const data = gh([
            'pr', 'merge', String(prNumber), '-R', nwo, '--merge',
            '--json', 'number,title,state,mergedAt',
          ]) as Record<string, unknown> | null;
          if (data && typeof data === 'object') {
            return {
              simulated: false,
              success: true,
              action: 'merged',
              prNumber,
              ...data,
            };
          }
        }
        // Simulated fallback
        const prKey = Object.keys(store.prs).find(k => k.includes(String(prNumber)));
        if (prKey && store.prs[prKey]) {
          store.prs[prKey].status = 'merged';
          saveGitHubStore(store);
        }
        return {
          ...simulatedGitHubFallback('local-mutation'),
          success: true,
          action: 'merged',
          prNumber,
          mergedAt: new Date().toISOString(),
        };
      }

      if (action === 'close') {
        const prNumber = input.prNumber as number;
        if (ghAvailable() && prNumber) {
          const data = gh([
            'pr', 'close', String(prNumber), '-R', nwo,
          ]);
          if (data !== null) {
            return {
              simulated: false,
              success: true,
              action: 'closed',
              prNumber,
              closedAt: new Date().toISOString(),
            };
          }
        }
        // Simulated fallback
        const prKey = Object.keys(store.prs).find(k => k.includes(String(prNumber)));
        if (prKey && store.prs[prKey]) {
          store.prs[prKey].status = 'closed';
          saveGitHubStore(store);
        }
        return {
          ...simulatedGitHubFallback('local-mutation'),
          success: true,
          action: 'closed',
          prNumber,
          closedAt: new Date().toISOString(),
        };
      }

      return { success: false, error: 'Unknown action' };
    },
  },
  {
    name: 'github_issue_track',
    description: 'Track and manage issues',
    category: 'github',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'close', 'assign'], description: 'Action to perform' },
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        issueNumber: { type: 'number', description: 'Issue number' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
        labels: { type: 'array', description: 'Issue labels' },
        assignees: { type: 'array', description: 'Assignees' },
      },
    },
    handler: async (input) => {
      const store = loadGitHubStore();
      const action = (input.action as string) || 'list';
      const owner = (input.owner as string) || 'owner';
      const repo = (input.repo as string) || 'repo';
      const nwo = `${owner}/${repo}`;

      if (action === 'list') {
        if (ghAvailable()) {
          const data = gh([
            'issue', 'list', '-R', nwo,
            '--json', 'number,title,state,labels,assignees,createdAt,url',
            '--limit', '30',
          ]) as Array<Record<string, unknown>> | null;
          if (Array.isArray(data)) {
            return {
              simulated: false,
              success: true,
              issues: data.map(i => ({
                id: i.number,
                title: i.title,
                status: (i.state as string)?.toLowerCase(),
                labels: (i.labels as Array<{ name: string }>)?.map(l => l.name) ?? [],
                assignees: (i.assignees as Array<{ login: string }>)?.map(a => a.login) ?? [],
                createdAt: i.createdAt,
                url: i.url,
              })),
              total: data.length,
              open: data.filter(i => (i.state as string)?.toLowerCase() === 'open').length,
            };
          }
        }
        // Simulated fallback
        const issues = Object.values(store.issues);
        return {
          ...simulatedGitHubFallback('local-cache'),
          success: true,
          issues,
          total: issues.length,
          open: issues.filter(i => i.status === 'open').length,
        };
      }

      if (action === 'create') {
        if (ghAvailable()) {
          const title = (input.title as string) || 'New Issue';
          const body = (input.body as string) || '';
          const labels = (input.labels as string[]) || [];
          const assignees = (input.assignees as string[]) || [];
          const args = ['issue', 'create', '-R', nwo, '--title', title, '--body', body];
          for (const l of labels) args.push('--label', l);
          for (const a of assignees) args.push('--assignee', a);
          args.push('--json', 'number,title,url,state,createdAt');
          const data = gh(args) as Record<string, unknown> | null;
          if (data && typeof data === 'object') {
            return {
              simulated: false,
              success: true,
              action: 'created',
              issue: data,
            };
          }
        }
        // Simulated fallback
        const issueId = `issue-${Date.now()}`;
        const issue = {
          id: issueId,
          title: (input.title as string) || 'New Issue',
          status: 'open',
          labels: (input.labels as string[]) || [],
          createdAt: new Date().toISOString(),
        };
        store.issues[issueId] = issue;
        saveGitHubStore(store);
        return {
          ...simulatedGitHubFallback('local-mutation'),
          success: true,
          action: 'created',
          issue,
        };
      }

      if (action === 'update') {
        const issueNumber = input.issueNumber as number;
        if (ghAvailable() && issueNumber) {
          const args = ['issue', 'edit', String(issueNumber), '-R', nwo];
          if (input.title) args.push('--title', input.title as string);
          if (input.labels) {
            for (const l of input.labels as string[]) args.push('--add-label', l);
          }
          if (input.assignees) {
            for (const a of input.assignees as string[]) args.push('--add-assignee', a);
          }
          const data = gh(args);
          if (data !== null) {
            return {
              simulated: false,
              success: true,
              action: 'updated',
              issueNumber,
            };
          }
        }
        // Simulated fallback
        const issueKey = Object.keys(store.issues).find(k => k.includes(String(issueNumber)));
        if (issueKey && store.issues[issueKey]) {
          if (input.title) store.issues[issueKey].title = input.title as string;
          if (input.labels) store.issues[issueKey].labels = input.labels as string[];
          saveGitHubStore(store);
        }
        return {
          ...simulatedGitHubFallback('local-mutation'),
          success: true,
          action: 'updated',
          issueNumber,
        };
      }

      if (action === 'close') {
        const issueNumber = input.issueNumber as number;
        if (ghAvailable() && issueNumber) {
          const data = gh(['issue', 'close', String(issueNumber), '-R', nwo]);
          if (data !== null) {
            return {
              simulated: false,
              success: true,
              action: 'closed',
              issueNumber,
              closedAt: new Date().toISOString(),
            };
          }
        }
        // Simulated fallback
        const issueKey = Object.keys(store.issues).find(k => k.includes(String(issueNumber)));
        if (issueKey && store.issues[issueKey]) {
          store.issues[issueKey].status = 'closed';
          saveGitHubStore(store);
        }
        return {
          ...simulatedGitHubFallback('local-mutation'),
          success: true,
          action: 'closed',
          issueNumber,
          closedAt: new Date().toISOString(),
        };
      }

      return { success: false, error: 'Unknown action' };
    },
  },
  {
    name: 'github_workflow',
    description: 'Manage GitHub Actions workflows',
    category: 'github',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'trigger', 'status', 'cancel'], description: 'Action to perform' },
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        workflowId: { type: 'string', description: 'Workflow ID or name' },
        ref: { type: 'string', description: 'Branch or tag ref' },
      },
    },
    handler: async (input) => {
      const action = (input.action as string) || 'list';
      const owner = (input.owner as string) || 'owner';
      const repo = (input.repo as string) || 'repo';
      const nwo = `${owner}/${repo}`;

      if (action === 'list') {
        if (ghAvailable()) {
          const data = gh([
            'run', 'list', '-R', nwo,
            '--json', 'databaseId,workflowName,status,conclusion,createdAt,url,headBranch',
            '--limit', '20',
          ]) as Array<Record<string, unknown>> | null;
          if (Array.isArray(data)) {
            return {
              simulated: false,
              success: true,
              workflows: data.map(r => ({
                id: r.databaseId,
                name: r.workflowName,
                status: r.status,
                conclusion: r.conclusion,
                branch: r.headBranch,
                createdAt: r.createdAt,
                url: r.url,
              })),
            };
          }
        }
        return {
          ...simulatedGitHubFallback('synthetic'),
          success: true,
          available: false,
          workflows: [],
        };
      }

      if (action === 'trigger') {
        if (ghAvailable() && input.workflowId) {
          const ref = (input.ref as string) || 'main';
          const data = gh([
            'workflow', 'run', input.workflowId as string, '-R', nwo, '--ref', ref,
          ]);
          if (data !== null) {
            return {
              simulated: false,
              success: true,
              action: 'triggered',
              workflowId: input.workflowId,
              ref,
              triggeredAt: new Date().toISOString(),
            };
          }
        }
        return {
          ...simulatedGitHubFallback('synthetic'),
          success: false,
          action: 'trigger_unavailable',
          workflowId: input.workflowId,
          ref: input.ref || 'main',
          triggered: false,
        };
      }

      if (action === 'status') {
        if (ghAvailable() && input.workflowId) {
          // Get the latest run for this workflow
          const data = gh([
            'run', 'list', '-R', nwo,
            '--workflow', input.workflowId as string,
            '--json', 'databaseId,status,conclusion,createdAt,updatedAt,url',
            '--limit', '1',
          ]) as Array<Record<string, unknown>> | null;
          if (Array.isArray(data) && data.length > 0) {
            const run = data[0];
            return {
              simulated: false,
              success: true,
              workflowId: input.workflowId,
              runId: run.databaseId,
              status: run.status,
              conclusion: run.conclusion,
              createdAt: run.createdAt,
              updatedAt: run.updatedAt,
              url: run.url,
            };
          }
        }
        return {
          ...simulatedGitHubFallback('synthetic'),
          success: false,
          workflowId: input.workflowId,
          available: false,
          status: 'unknown',
          conclusion: null,
          duration: null,
        };
      }

      if (action === 'cancel') {
        if (ghAvailable() && input.workflowId) {
          // workflowId here may be a run ID for cancellation
          const data = gh(['run', 'cancel', input.workflowId as string, '-R', nwo]);
          if (data !== null) {
            return {
              simulated: false,
              success: true,
              action: 'cancelled',
              workflowId: input.workflowId,
              cancelledAt: new Date().toISOString(),
            };
          }
        }
        return {
          ...simulatedGitHubFallback('synthetic'),
          success: false,
          action: 'cancel_unavailable',
          workflowId: input.workflowId,
          cancelled: false,
        };
      }

      return { success: false, error: 'Unknown action' };
    },
  },
  {
    name: 'github_metrics',
    description: 'Get repository metrics and statistics',
    category: 'github',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        metric: { type: 'string', enum: ['all', 'commits', 'contributors', 'traffic', 'releases'], description: 'Metric type' },
        timeRange: { type: 'string', description: 'Time range' },
      },
    },
    handler: async (input) => {
      const metric = (input.metric as string) || 'all';
      const owner = (input.owner as string) || 'owner';
      const repo = (input.repo as string) || 'repo';
      const nwo = `${owner}/${repo}`;

      if (ghAvailable()) {
        const realMetrics: Record<string, unknown> = {};
        let gotData = false;

        if (metric === 'all' || metric === 'commits') {
          // Get recent commits
          const commits = gh([
            'api', `repos/${nwo}/commits`, '--jq', 'length', '-q', 'per_page=100',
          ]);
          if (commits !== null) {
            const total = typeof commits === 'number' ? commits : parseInt(String(commits), 10) || 0;
            realMetrics.commits = { total, note: 'Latest page (up to 100)' };
            gotData = true;
          }
        }

        if (metric === 'all' || metric === 'contributors') {
          const contributors = gh([
            'api', `repos/${nwo}/contributors`, '--jq', 'length', '-q', 'per_page=100',
          ]);
          if (contributors !== null) {
            const total = typeof contributors === 'number' ? contributors : parseInt(String(contributors), 10) || 0;
            realMetrics.contributors = { total };
            gotData = true;
          }
        }

        if (metric === 'all' || metric === 'releases') {
          const releases = gh([
            'release', 'list', '-R', nwo,
            '--json', 'tagName,publishedAt,isLatest',
            '--limit', '10',
          ]) as Array<Record<string, unknown>> | null;
          if (Array.isArray(releases)) {
            const latest = releases.find(r => r.isLatest);
            realMetrics.releases = {
              total: releases.length,
              latest: latest?.tagName ?? releases[0]?.tagName ?? 'none',
              items: releases.map(r => ({ tag: r.tagName, publishedAt: r.publishedAt })),
            };
            gotData = true;
          }
        }

        if (metric === 'all' || metric === 'traffic') {
          // Traffic requires push access; try but expect it may fail
          const views = gh(['api', `repos/${nwo}/traffic/views`]) as Record<string, unknown> | null;
          if (views && typeof views === 'object') {
            realMetrics.traffic = {
              views: views.count ?? 0,
              uniqueVisitors: views.uniques ?? 0,
            };
            gotData = true;
          }
        }

        if (gotData) {
          if (metric === 'all') {
            return { simulated: false, success: true, metrics: realMetrics };
          }
          if (realMetrics[metric]) {
            return { simulated: false, success: true, metric, data: realMetrics[metric] };
          }
        }
      }

      // Simulated fallback
      const metrics = {
        commits: {
          total: Math.floor(Math.random() * 1000) + 500,
          lastWeek: Math.floor(Math.random() * 50) + 10,
          lastMonth: Math.floor(Math.random() * 200) + 50,
        },
        contributors: {
          total: Math.floor(Math.random() * 50) + 5,
          active: Math.floor(Math.random() * 20) + 3,
          new: Math.floor(Math.random() * 5),
        },
        traffic: {
          views: Math.floor(Math.random() * 5000) + 1000,
          uniqueVisitors: Math.floor(Math.random() * 1000) + 200,
          clones: Math.floor(Math.random() * 500) + 50,
        },
        releases: {
          total: Math.floor(Math.random() * 20) + 5,
          latest: '3.0.0-alpha.86',
          downloads: Math.floor(Math.random() * 10000) + 1000,
        },
      };

      if (metric === 'all') {
        return { ...simulatedGitHubFallback('synthetic'), success: true, metrics };
      }

      return {
        ...simulatedGitHubFallback('synthetic'),
        success: true,
        metric,
        data: metrics[metric as keyof typeof metrics],
      };
    },
  },
];
