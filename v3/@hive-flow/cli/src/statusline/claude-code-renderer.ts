// v3/@hive-flow/cli/src/statusline/claude-code-renderer.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveProjectIdentity } from './project-identity.js';
import { resolveModelDisplay } from './model-display.js';

type JsonObject = Record<string, unknown>;
const RENDER_BUDGET_MS = 220;
const ansi = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  brightGreen: '\x1b[1;32m',
  brightYellow: '\x1b[1;33m',
  yellow: '\x1b[0;33m',
  brightCyan: '\x1b[1;36m',
  brightWhite: '\x1b[1;37m',
};

export async function readStatuslineStdin(): Promise<JsonObject | undefined> {
  if (process.stdin.isTTY) return undefined;
  let raw = '';
  for await (const chunk of process.stdin) raw += Buffer.from(chunk).toString('utf8');
  raw = raw.trim();
  if (!raw.startsWith('{')) return undefined;
  try {
    return JSON.parse(raw) as JsonObject;
  } catch {
    return undefined;
  }
}

function stringAt(data: unknown, path: string[]): string | undefined {
  let cur: any = data;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return typeof cur === 'string' && cur.trim() ? cur.trim() : undefined;
}

function numberAt(data: unknown, path: string[]): number | undefined {
  let cur: any = data;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  const value = Number(cur);
  return Number.isFinite(value) ? value : undefined;
}

export function resolveActiveCwd(stdinData?: JsonObject, fallback = process.cwd()): string {
  return (
    stringAt(stdinData, ['workspace', 'current_dir']) ??
    stringAt(stdinData, ['cwd']) ??
    stringAt(stdinData, ['workspace', 'project_dir']) ??
    fallback
  );
}

function cacheRoot(cwd: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  const dir = join(tmpdir(), `hive-flow-statusline-${hash}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cachePath(cwd: string, key: string): string {
  const hash = createHash('sha256').update(key).digest('hex');
  return join(cacheRoot(cwd), `${hash}.txt`);
}

function readCache(cwd: string, key: string, ttlMs: number): string | undefined {
  try {
    const file = cachePath(cwd, key);
    const stat = statSync(file);
    if (Date.now() - stat.mtimeMs > ttlMs) return undefined;
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function writeCache(cwd: string, key: string, value: string): void {
  try {
    writeFileSync(cachePath(cwd, key), value, 'utf8');
  } catch {
    // Cache writes are best-effort; statusline rendering must never fail because of cache I/O.
  }
}

function remainingBudget(deadlineMs: number, timeoutMs: number): number {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 25) return 0;
  return Math.max(25, Math.min(timeoutMs, remaining));
}

function safeSpawn(bin: string, args: string[], cwd: string, deadlineMs: number, timeoutMs = 900, ttlMs = 0): string {
  const key = `spawn:${bin}:${args.join('\0')}`;
  if (ttlMs > 0) {
    const cached = readCache(cwd, key, ttlMs);
    if (cached !== undefined) return cached;
  }
  const budgetedTimeout = remainingBudget(deadlineMs, timeoutMs);
  if (budgetedTimeout <= 0) return '';
  try {
    const r = spawnSync(bin, args, {
      cwd,
      encoding: 'utf8',
      timeout: budgetedTimeout,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const value = r.status === 0 ? (r.stdout ?? '').trim() : '';
    if (ttlMs > 0) writeCache(cwd, key, value);
    return value;
  } catch {
    return '';
  }
}

function readJson(filePath: string): any | undefined {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function gitInfo(cwd: string, deadlineMs: number) {
  const branch = safeSpawn('git', ['branch', '--show-current'], cwd, deadlineMs, 900, 2_000);
  const status = safeSpawn('git', ['status', '--porcelain'], cwd, deadlineMs, 1200, 2_000);
  const upstream = safeSpawn('git', ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], cwd, deadlineMs, 900, 2_000);
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  for (const line of status.split('\n')) {
    if (!line) continue;
    const x = line[0];
    const y = line[1];
    if (x === '?' && y === '?') {
      untracked++;
      continue;
    }
    if (x && x !== ' ' && x !== '?') staged++;
    if (y && y !== ' ' && y !== '?') modified++;
  }
  const [aheadRaw, behindRaw] = upstream.split(/\s+/);
  return {
    branch,
    staged,
    modified,
    untracked,
    ahead: Number.parseInt(aheadRaw ?? '0', 10) || 0,
    behind: Number.parseInt(behindRaw ?? '0', 10) || 0,
  };
}

function stashCount(cwd: string, deadlineMs: number): number | undefined {
  const out = safeSpawn('git', ['stash', 'list'], cwd, deadlineMs, 900, 5_000);
  if (!out) return undefined;
  return out.split('\n').filter(Boolean).length;
}

function gitDbSize(cwd: string, deadlineMs: number): string | undefined {
  const gitDir = safeSpawn('git', ['rev-parse', '--git-dir'], cwd, deadlineMs, 900, 5_000);
  if (!gitDir) return undefined;
  const out = safeSpawn('du', ['-sh', gitDir], cwd, deadlineMs, 1500, 120_000);
  return out ? out.split(/\s+/)[0] : undefined;
}

function worktreeCount(cwd: string): number | undefined {
  const dir = join(cwd, '.worktrees');
  if (!existsSync(dir)) return undefined;
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  } catch {
    return undefined;
  }
}

function beadsStatus(cwd: string, deadlineMs: number): string | undefined {
  if (!existsSync(join(cwd, '.beads'))) return undefined;
  const out = safeSpawn('bd', ['status', '--json'], cwd, deadlineMs, 1000, 30_000);
  if (!out) return undefined;
  try {
    const data = JSON.parse(out);
    const open = data.open ?? 0;
    const inProgress = data.in_progress ?? 0;
    const blocked = data.blocked ?? 0;
    return blocked > 0 ? `${open}/${inProgress}/${blocked}` : `${open}/${inProgress}`;
  } catch {
    return undefined;
  }
}

function mcpCount(cwd: string): { project: number; user: number; total: number } | undefined {
  const projectMcp = readJson(join(cwd, '.mcp.json'));
  const userMcp = readJson(join(homedir(), '.claude.json'));
  const projectNames = projectMcp?.mcpServers && typeof projectMcp.mcpServers === 'object'
    ? Object.keys(projectMcp.mcpServers)
    : [];
  const userNames = userMcp?.mcpServers && typeof userMcp.mcpServers === 'object'
    ? Object.keys(userMcp.mcpServers)
    : [];
  const project = projectNames.length;
  const user = userNames.length;
  const total = new Set([...projectNames, ...userNames]).size;
  return total > 0 ? { project, user, total } : undefined;
}

function activePr(cwd: string, branch: string, deadlineMs: number): string | undefined {
  if (!branch) return undefined;
  const out = safeSpawn('gh', ['pr', 'view', '--json', 'number', '--jq', '.number'], cwd, deadlineMs, 1200, 120_000);
  if (!out || out === 'null') return undefined;
  return `PR #${out}`;
}

function fileSizeKB(filePath: string): number {
  try {
    return Math.floor(statSync(filePath).size / 1024);
  } catch {
    return 0;
  }
}

function agentRecordsFromStore(store: any): any[] {
  if (store?.agents && typeof store.agents === 'object' && !Array.isArray(store.agents)) {
    return Object.values(store.agents).filter((value: any) => value && typeof value === 'object');
  }
  if (Array.isArray(store?.agents)) return store.agents;
  if (Array.isArray(store?.entries)) return store.entries;
  if (Array.isArray(store)) return store;
  if (store && typeof store === 'object') {
    return Object.values(store).filter((value: any) => value && typeof value === 'object');
  }
  return [];
}

function hiveRows(cwd: string): string[] {
  const rows: string[] = [];
  const store = readJson(join(cwd, '.hive-flow', 'agents', 'store.json'));
  const agents = agentRecordsFromStore(store);
  const live = agents.filter((agent: any) => agent.status !== 'terminated' && agent.status !== 'failed');
  const isQueen = (agent: any) => agent.agentType === 'queen' || agent.type === 'queen';
  const workers = live.filter((agent: any) => !isQueen(agent));
  const queens = live.filter(isQueen);
  const executingWorkers = workers.filter((agent: any) => agent.status === 'running' || agent.status === 'busy');
  const executingQueens = queens.filter((agent: any) => agent.status === 'running' || agent.status === 'busy');
  const activeAgents = workers.length;

  const settings = readJson(join(cwd, '.claude', 'settings.json'));
  let hookCategories = 0;
  let hookMatchers = 0;
  let hookCommands = 0;
  if (settings?.hooks && typeof settings.hooks === 'object') {
    for (const hookList of Object.values(settings.hooks)) {
      if (!Array.isArray(hookList) || hookList.length === 0) continue;
      hookCategories++;
      for (const hook of hookList as any[]) {
        hookMatchers++;
        const commands = hook.commands ?? hook.hooks ?? [];
        if (Array.isArray(commands)) hookCommands += commands.length;
      }
    }
  }

  const hookParts: string[] = [];
  if (hookCategories > 0) hookParts.push(`${hookCategories}c`);
  if (hookMatchers > 0) hookParts.push(`${hookMatchers}m`);
  if (hookCommands > 0) hookParts.push(`${hookCommands}cmd`);
  const hooksDisplay = hookParts.join('/');
  if (activeAgents > 0 || queens.length > 0) {
    const hooksSegment = hooksDisplay ? `  🪝 ${hooksDisplay}` : '';
    const swarmExecuting = executingWorkers.length > 0;
    const swarmHasAgents = activeAgents > 0;
    const swarmInd = swarmExecuting
      ? `${ansi.brightGreen}◉${ansi.reset}`
      : swarmHasAgents
        ? `${ansi.brightYellow}○${ansi.reset}`
        : `${ansi.dim}○${ansi.reset}`;
    const agentsColor = swarmExecuting ? ansi.brightGreen : swarmHasAgents ? ansi.brightYellow : ansi.dim;
    const queenSegment = queens.length > 0
      ? ` ${(executingQueens.length > 0 ? ansi.brightCyan : ansi.yellow)}♛${queens.length}${ansi.reset}`
      : '';
    rows.push(
      `🤖 Swarm  ${swarmInd} [${agentsColor}${String(activeAgents).padStart(2)}${ansi.reset}/${ansi.brightWhite}50${ansi.reset}]${queenSegment}${hooksSegment}`,
    );
  } else if (hooksDisplay) {
    rows.push(`🪝 Hooks ${hooksDisplay}`);
  }

  const adrDirs = [
    join(cwd, 'v3', 'implementation', 'adrs'),
    join(cwd, 'docs', 'adrs'),
    join(cwd, '.hive-flow', 'adrs'),
  ];
  for (const adrDir of adrDirs) {
    if (!existsSync(adrDir)) continue;
    const count = readdirSync(adrDir).filter((file) =>
      file.endsWith('.md') && (file.startsWith('ADR-') || file.startsWith('adr-') || /^\d{4}-/.test(file))
    ).length;
    if (count > 0) {
      rows.push(`🔧 Architecture    ADRs ●${count}`);
      break;
    }
  }

  const memoryDb = join(cwd, '.hive-flow', 'memory.db');
  const hnsw = join(cwd, '.hive-flow', 'hnsw.index');
  const dbSizeKB = fileSizeKB(memoryDb);
  const hnswSize = fileSizeKB(hnsw);
  const mcp = mcpCount(cwd);
  if (dbSizeKB > 0 || hnswSize > 0 || mcp) {
    const vectorPart = hnswSize > 0 ? `Vectors ●${Math.floor((hnswSize * 1024) / 512)}⚡` : undefined;
    const sizePart = dbSizeKB > 0 ? `Size ${dbSizeKB}KB` : undefined;
    const mcpPart = mcp !== undefined ? `MCP ●${mcp.total}` : undefined;
    rows.push(['📊 AgentDB', vectorPart, sizePart, mcpPart].filter(Boolean).join('  │  '));
  }

  return rows;
}

function formatContext(stdinData?: JsonObject): string | undefined {
  const pct = numberAt(stdinData, ['context_window', 'used_percentage']);
  if (pct === undefined) return undefined;
  const input = numberAt(stdinData, ['context_window', 'total_input_tokens']);
  const output = numberAt(stdinData, ['context_window', 'total_output_tokens']);
  const tokens = input !== undefined || output !== undefined
    ? ` · ${input ?? 0} in/${output ?? 0} out`
    : '';
  return `📖 ${Math.floor(pct)}% ctx${tokens}`;
}

function formatCost(stdinData?: JsonObject): string | undefined {
  const cost = numberAt(stdinData, ['cost', 'total_cost_usd']);
  if (cost === undefined || cost <= 0) return undefined;
  return `$${cost.toFixed(2)}`;
}

function formatDuration(stdinData?: JsonObject): string | undefined {
  const ms = numberAt(stdinData, ['cost', 'total_duration_ms']);
  if (ms === undefined || ms <= 0) return undefined;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `⏱ ${hours}h${minutes}m`;
  if (minutes > 0) return `⏱ ${minutes}m${seconds}s`;
  return `⏱ ${seconds}s`;
}

function formatRateLimit(stdinData?: JsonObject): string | undefined {
  const five = numberAt(stdinData, ['rate_limits', 'five_hour', 'used_percentage']);
  const seven = numberAt(stdinData, ['rate_limits', 'seven_day', 'used_percentage']);
  if (five === undefined && seven === undefined) return undefined;
  const parts: string[] = [];
  if (five !== undefined) parts.push(`5h ${Math.floor(five)}%`);
  if (seven !== undefined) parts.push(`7d ${Math.floor(seven)}%`);
  return `limits ${parts.join('/')}`;
}

function formatLineDelta(stdinData?: JsonObject): string | undefined {
  const added = numberAt(stdinData, ['cost', 'total_lines_added']);
  const removed = numberAt(stdinData, ['cost', 'total_lines_removed']);
  if ((added === undefined || added <= 0) && (removed === undefined || removed <= 0)) return undefined;
  const parts: string[] = [];
  if (added !== undefined && added > 0) parts.push(`+${added}`);
  if (removed !== undefined && removed > 0) parts.push(`-${removed}`);
  return `Δ ${parts.join('/')}`;
}

function formatAgentSession(stdinData?: JsonObject): string | undefined {
  const parts: string[] = [];
  const agent = stringAt(stdinData, ['agent', 'name']);
  const session = stringAt(stdinData, ['session_name']);
  if (agent) parts.push(`agent ${agent}`);
  if (session) parts.push(session);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function formatWorktree(stdinData?: JsonObject): string | undefined {
  const name =
    stringAt(stdinData, ['worktree', 'name']) ??
    stringAt(stdinData, ['workspace', 'git_worktree']);
  const branch = stringAt(stdinData, ['worktree', 'branch']);
  if (name && branch) return `wt ${name}:${branch}`;
  if (name) return `wt ${name}`;
  if (branch) return `wt ${branch}`;
  return undefined;
}

export async function renderClaudeCodeStatusline(stdinData?: JsonObject, cwd = process.cwd()): Promise<string> {
  try {
    const deadlineMs = Date.now() + RENDER_BUDGET_MS;
    const activeCwd = resolveActiveCwd(stdinData, cwd);
    const identity = await resolveProjectIdentity({ stdinData, cwd: activeCwd });
    const model = resolveModelDisplay(stdinData);
    const git = gitInfo(activeCwd, deadlineMs);

    const headerParts: string[] = [`▊ ${identity.value.displayName}`];
    if (git.branch) {
      let gitPart = `⏇ ${git.branch}`;
      if (git.staged > 0) gitPart += ` +${git.staged}`;
      if (git.modified > 0) gitPart += `~${git.modified}`;
      if (git.untracked > 0) gitPart += `?${git.untracked}`;
      if (git.ahead > 0) gitPart += ` ↑${git.ahead}`;
      if (git.behind > 0) gitPart += ` ↓${git.behind}`;
      headerParts.push(gitPart);
    }
    if (model.value.modelDisplay) headerParts.push(model.value.modelDisplay);
    const context = formatContext(stdinData);
    if (context) headerParts.push(context);
    const cost = formatCost(stdinData);
    if (cost) headerParts.push(cost);
    const duration = formatDuration(stdinData);
    if (duration) headerParts.push(duration);
    const limits = formatRateLimit(stdinData);
    if (limits) headerParts.push(limits);

    const lines: string[] = [headerParts.join('  │  '), '─────────────────────────────────────────────────────'];

    const extraParts: string[] = [];
    const beads = beadsStatus(activeCwd, deadlineMs);
    if (beads) extraParts.push(`📋 ${beads}`);
    const wt = worktreeCount(activeCwd);
    if (wt && wt > 0) extraParts.push(`🌳 ${wt}`);
    const stash = stashCount(activeCwd, deadlineMs);
    if (stash && stash > 0) extraParts.push(`📦 ${stash}`);
    const repoSize = gitDbSize(activeCwd, deadlineMs);
    if (repoSize) extraParts.push(`💾 ${repoSize}`);
    const pr = activePr(activeCwd, git.branch, deadlineMs);
    if (pr) extraParts.push(pr);
    const lineDelta = formatLineDelta(stdinData);
    if (lineDelta) extraParts.push(lineDelta);
    const agentSession = formatAgentSession(stdinData);
    if (agentSession) extraParts.push(agentSession);
    const stdinWorktree = formatWorktree(stdinData);
    if (stdinWorktree) extraParts.push(stdinWorktree);
    const mcp = mcpCount(activeCwd);
    if (mcp && mcp.total > 0) extraParts.push(`MCP ${mcp.total}`);
    if (extraParts.length > 0) lines.push(extraParts.join('  │  '));

    lines.push(...hiveRows(activeCwd));
    return lines.join('\n');
  } catch {
    // Render failures degrade silently to empty output — never stack traces.
    return '';
  }
}
