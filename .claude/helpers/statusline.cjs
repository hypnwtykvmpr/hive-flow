#!/usr/bin/env node
/**
 * Hive Flow V3 Statusline Generator (Optimized)
 * Displays real-time V3 implementation progress and system status
 *
 * Usage: node statusline.cjs [--json] [--compact]
 *
 * Performance notes:
 * - Single git execSync call (combines branch + status + upstream)
 * - No recursive file reading (only stat/readdir, never read test contents)
 * - No ps aux calls (uses process.memoryUsage() + file-based metrics)
 * - Strict 2s timeout on all execSync calls
 * - Shared settings cache across functions
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');
const crypto = require('crypto');

// Configuration
// keep in sync with @hive-flow/shared/core/config/defaults (DEFAULT_MAX_AGENTS=50, DEFAULT_QUEUE_DEPTH=10).
// Long-term: replace with a runtime import once this .cjs migrates to ESM.
const CONFIG = {
  maxAgents: 50,
  queueDepth: 10,
};

const CWD = process.cwd();
/** Resolved from repo root — same layout as context-persistence-hook.mjs (`PROJECT_ROOT/.hive-flow/data`). */
const AUTOPILOT_STATE_PATH = path.join(__dirname, '..', '..', '.hive-flow', 'data', 'autopilot-state.json');

let _stdinData = undefined;
function getStdinData() {
  if (_stdinData !== undefined) return _stdinData;
  try {
    if (process.stdin.isTTY) { _stdinData = null; return null; }
    const chunks = [];
    const buf = Buffer.alloc(4096);
    try {
      let bytesRead;
      while ((bytesRead = fs.readSync(0, buf, 0, buf.length, null)) > 0) {
        chunks.push(buf.slice(0, bytesRead));
      }
    } catch { /* EOF */ }
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    _stdinData = (raw && raw.startsWith('{')) ? JSON.parse(raw) : null;
  } catch { _stdinData = null; }
  return _stdinData;
}

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[0;31m',
  green: '\x1b[0;32m',
  yellow: '\x1b[0;33m',
  blue: '\x1b[0;34m',
  purple: '\x1b[0;35m',
  cyan: '\x1b[0;36m',
  brightRed: '\x1b[1;31m',
  brightGreen: '\x1b[1;32m',
  brightYellow: '\x1b[1;33m',
  brightBlue: '\x1b[1;34m',
  brightPurple: '\x1b[1;35m',
  brightCyan: '\x1b[1;36m',
  brightWhite: '\x1b[1;37m',
};

// Safe execSync with strict timeout (returns empty string on failure)
function safeExec(cmd, timeoutMs = 2000) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

// Safe JSON file reader (returns null on failure)
function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

// Safe file stat (returns null on failure)
function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch { /* ignore */ }
  return null;
}

// Shared settings cache — read once, used by multiple functions
let _settingsCache = undefined;
function getSettings() {
  if (_settingsCache !== undefined) return _settingsCache;
  _settingsCache = readJSON(path.join(CWD, '.claude', 'settings.json'))
                || readJSON(path.join(CWD, '.claude', 'settings.local.json'))
                || null;
  return _settingsCache;
}

// ─── Data Collection (all pure-Node.js or single-exec) ──────────

// Get all git info in ONE shell call
function getGitInfo() {
  const result = {
    name: 'user', gitBranch: '', modified: 0, untracked: 0,
    staged: 0, ahead: 0, behind: 0,
  };

  // Single shell: get user.name, branch, porcelain status, and upstream diff
  const script = [
    'git config user.name 2>/dev/null || echo user',
    'echo "---SEP---"',
    'git branch --show-current 2>/dev/null',
    'echo "---SEP---"',
    'git status --porcelain 2>/dev/null',
    'echo "---SEP---"',
    'git rev-list --left-right --count HEAD...@{upstream} 2>/dev/null || echo "0 0"',
  ].join('; ');

  const raw = safeExec(`sh -c '${script}'`, 3000);
  if (!raw) return result;

  const parts = raw.split('---SEP---').map(s => s.trim());
  if (parts.length >= 4) {
    result.name = parts[0] || 'user';
    result.gitBranch = parts[1] || '';

    // Parse porcelain status
    if (parts[2]) {
      for (const line of parts[2].split('\n')) {
        if (!line || line.length < 2) continue;
        const x = line[0], y = line[1];
        if (x === '?' && y === '?') { result.untracked++; continue; }
        if (x !== ' ' && x !== '?') result.staged++;
        if (y !== ' ' && y !== '?') result.modified++;
      }
    }

    // Parse ahead/behind
    const ab = (parts[3] || '0 0').split(/\s+/);
    result.ahead = parseInt(ab[0]) || 0;
    result.behind = parseInt(ab[1]) || 0;
  }

  return result;
}

// Detect model name. Stdin-first (Claude Code passes the live model); falls back to
// version-less family names from tracked usage / settings. Version-pinning strings like
// "Sonnet 4.6" were removed — they go stale on every model release and contradict the
// model-display.ts contract (never emit a hardcoded fallback version).
function getModelName() {
  // Primary: stdin.model.display_name (always current, fresh per turn).
  const stdin = getStdinData();
  if (stdin?.model) {
    const display = String(stdin.model.display_name || '').trim();
    if (display) {
      const id = String(stdin.model.id || '');
      // Append " 1M" for the 1M-context variant when the id is tagged [1m] and the display
      // doesn't already include the suffix.
      if (/\[1m\]/i.test(id) && !/\b1M\b/.test(display)) return `${display} 1M`;
      return display;
    }
  }

  // Tracked usage fallback — version-less family only.
  try {
    const claudeConfig = readJSON(path.join(os.homedir(), '.claude.json'));
    if (claudeConfig?.projects) {
      for (const [projectPath, projectConfig] of Object.entries(claudeConfig.projects)) {
        if (CWD === projectPath || CWD.startsWith(projectPath + '/')) {
          const usage = projectConfig.lastModelUsage;
          if (usage) {
            const ids = Object.keys(usage);
            if (ids.length > 0) {
              let modelId = ids[ids.length - 1];
              let latest = 0;
              for (const id of ids) {
                const ts = usage[id]?.lastUsedAt ? new Date(usage[id].lastUsedAt).getTime() : 0;
                if (ts > latest) { latest = ts; modelId = id; }
              }
              if (modelId.includes('opus')) return 'Opus';
              if (modelId.includes('sonnet')) return 'Sonnet';
              if (modelId.includes('haiku')) return 'Haiku';
              return modelId.split('-').slice(1, 3).join(' ');
            }
          }
          break;
        }
      }
    }
  } catch { /* ignore */ }

  // settings.json model field — version-less family.
  const settings = getSettings();
  if (settings?.model) {
    const m = settings.model;
    if (m.includes('opus')) return 'Opus';
    if (m.includes('sonnet')) return 'Sonnet';
    if (m.includes('haiku')) return 'Haiku';
  }

  // Project-level hiveFlow.modelPreferences.default — version-less family.
  const projSettings = readJSON(path.join(CWD, '.claude', 'settings.json'));
  if (projSettings?.hiveFlow?.modelPreferences?.default) {
    const m = projSettings.hiveFlow.modelPreferences.default;
    if (m.includes('opus')) return 'Opus';
    if (m.includes('sonnet')) return 'Sonnet';
    if (m.includes('haiku')) return 'Haiku';
  }

  return 'Claude Code';
}

// Get learning stats from memory database (pure stat calls)
function getLearningStats() {
  const memoryPaths = [
    path.join(CWD, '.swarm', 'memory.db'),
    path.join(CWD, '.hive-flow', 'memory.db'),
    path.join(CWD, '.claude', 'memory.db'),
    path.join(CWD, 'data', 'memory.db'),
    path.join(CWD, '.agentdb', 'memory.db'),
  ];

  for (const dbPath of memoryPaths) {
    const stat = safeStat(dbPath);
    if (stat) {
      const sizeKB = stat.size / 1024;
      const patterns = Math.floor(sizeKB / 2);
      return {
        patterns,
        sessions: Math.max(1, Math.floor(patterns / 10)),
      };
    }
  }

  // Check session files count
  let sessions = 0;
  try {
    const sessDir = path.join(CWD, '.claude', 'sessions');
    if (fs.existsSync(sessDir)) {
      sessions = fs.readdirSync(sessDir).filter(f => f.endsWith('.json')).length;
    }
  } catch { /* ignore */ }

  return { patterns: 0, sessions };
}

// V3 progress from metrics files (pure file reads)
function getV3Progress() {
  const learning = getLearningStats();
  const totalDomains = 5;

  const dddData = readJSON(path.join(CWD, '.hive-flow', 'metrics', 'ddd-progress.json'));
  let dddProgress = dddData?.progress || 0;
  let domainsCompleted = Math.min(5, Math.floor(dddProgress / 20));

  if (dddProgress === 0 && learning.patterns > 0) {
    if (learning.patterns >= 500) domainsCompleted = 5;
    else if (learning.patterns >= 200) domainsCompleted = 4;
    else if (learning.patterns >= 100) domainsCompleted = 3;
    else if (learning.patterns >= 50) domainsCompleted = 2;
    else if (learning.patterns >= 10) domainsCompleted = 1;
    dddProgress = Math.floor((domainsCompleted / totalDomains) * 100);
  }

  return {
    domainsCompleted, totalDomains, dddProgress,
    patternsLearned: learning.patterns,
    sessionsCompleted: learning.sessions,
  };
}

// Security status (pure file reads)
function getSecurityStatus() {
  const totalCves = 3;
  const auditData = readJSON(path.join(CWD, '.hive-flow', 'security', 'audit-status.json'));
  if (auditData) {
    return {
      status: auditData.status || 'PENDING',
      cvesFixed: auditData.cvesFixed || 0,
      totalCves: auditData.totalCves || 3,
    };
  }

  let cvesFixed = 0;
  try {
    const scanDir = path.join(CWD, '.claude', 'security-scans');
    if (fs.existsSync(scanDir)) {
      cvesFixed = Math.min(totalCves, fs.readdirSync(scanDir).filter(f => f.endsWith('.json')).length);
    }
  } catch { /* ignore */ }

  return {
    status: cvesFixed >= totalCves ? 'CLEAN' : cvesFixed > 0 ? 'IN_PROGRESS' : 'PENDING',
    cvesFixed,
    totalCves,
  };
}

// Read agent store and split into workers and queens. Queens are control-plane
// orchestrators — they do not consume worker slots, so the [N/50] bracket
// counts workers only and queens render as a separate ♛N segment.
//
// Returned buckets:
//   - activeAgents:    non-terminated/failed workers (workers only, NO queens)
//   - executingAgents: workers currently 'running'/'busy' (drives bright-green)
//   - activeQueens:    non-terminated/failed queens (renders separately)
//   - executingQueens: queens currently 'running'/'busy' (drives queen color)
//   - agents:          all live (non-terminated) records — used by provider tracking
//
// Shape priority (live MCP write path → legacy fallbacks):
//   1. Modern dict: { agents: { <id>: { status, agentType, ... }, ... }, version: 1 }
//   2. Legacy array: { agents: [...] } | { entries: [...] } | top-level array
//   3. Top-level dict-of-records (very old): { <id>: { status, ... }, ... }
function getAgentStoreCount() {
  try {
    const storePath = path.join(CWD, '.hive-flow', 'agents', 'store.json');
    if (fs.existsSync(storePath)) {
      const store = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
      let all = [];

      if (store?.agents && typeof store.agents === 'object' && !Array.isArray(store.agents)) {
        all = Object.values(store.agents).filter(v => v && typeof v === 'object');
      } else if (Array.isArray(store?.agents)) {
        all = store.agents;
      } else if (Array.isArray(store?.entries)) {
        all = store.entries;
      } else if (Array.isArray(store)) {
        all = store;
      } else if (typeof store === 'object' && store !== null) {
        all = Object.values(store).filter(v => v && typeof v === 'object' && 'status' in v);
      }

      if (all.length > 0) {
        const live = all.filter(a => a.status !== 'terminated' && a.status !== 'failed');
        const isQueen = (a) => a.agentType === 'queen';
        const workers = live.filter(a => !isQueen(a));
        const queens = live.filter(isQueen);
        const workersExecuting = workers.filter(a => a.status === 'running' || a.status === 'busy');
        const queensExecuting = queens.filter(a => a.status === 'running' || a.status === 'busy');
        return {
          activeAgents: workers.length,
          executingAgents: workersExecuting.length,
          activeQueens: queens.length,
          executingQueens: queensExecuting.length,
          agents: live,
        };
      }
    }
  } catch { /* store.json doesn't exist or is invalid -- fall through */ }
  return { activeAgents: 0, executingAgents: 0, activeQueens: 0, executingQueens: 0, agents: [] };
}

// Swarm status (pure file reads, NO ps aux).
// Read order: store.json (live, no staleness window) → swarm-activity.json
// → v3-progress.json (both gated by 10-min freshness). Previous order put the
// stale metrics files first, so a multi-day-old v3-progress.json with
// activeAgents:0 would short-circuit a live hive's store.json (CLAUDE-LF-002).
const SWARM_FRESHNESS_MS = 10 * 60 * 1000;

function getSwarmStatus() {
  // PRIMARY: live agent store. Always current — written by MCP agent_spawn /
  // queen_mission_assign. Returns workers (active/executing) AND queens
  // (active/executing) separately so the renderer can color and place them
  // independently. Queens don't count against the worker cap.
  const storeData = getAgentStoreCount();
  if (storeData.activeAgents > 0 || storeData.activeQueens > 0) {
    return {
      activeAgents: storeData.activeAgents,
      executingAgents: storeData.executingAgents,
      activeQueens: storeData.activeQueens,
      executingQueens: storeData.executingQueens,
      maxAgents: CONFIG.maxAgents,
      coordinationActive: true,
    };
  }

  // FALLBACK 1: swarm-activity.json — fresh-only. Legacy collector doesn't
  // differentiate executing from active or queens from workers; treat the count
  // as workers and assume reported agents are executing.
  const activityData = readJSON(path.join(CWD, '.hive-flow', 'metrics', 'swarm-activity.json'));
  if (activityData?.swarm) {
    const updated = activityData.lastUpdated ? Date.parse(activityData.lastUpdated) : 0;
    if (!updated || Date.now() - updated < SWARM_FRESHNESS_MS) {
      const count = activityData.swarm.agent_count || 0;
      return {
        activeAgents: count,
        executingAgents: count,
        activeQueens: 0,
        executingQueens: 0,
        maxAgents: CONFIG.maxAgents,
        coordinationActive: activityData.swarm.coordination_active || activityData.swarm.active || false,
      };
    }
  }

  // FALLBACK 2: v3-progress.json — fresh-only. Stale writes (older than 10 min)
  // are ignored so they cannot mask an active live store.
  const progressData = readJSON(path.join(CWD, '.hive-flow', 'metrics', 'v3-progress.json'));
  if (progressData?.swarm) {
    const updated = progressData.lastUpdated ? Date.parse(progressData.lastUpdated) : 0;
    if (updated && Date.now() - updated < SWARM_FRESHNESS_MS) {
      const count = progressData.swarm.activeAgents || progressData.swarm.agent_count || 0;
      return {
        activeAgents: count,
        executingAgents: count,
        activeQueens: 0,
        executingQueens: 0,
        maxAgents: progressData.swarm.totalAgents || CONFIG.maxAgents,
        coordinationActive: progressData.swarm.active || (progressData.swarm.activeAgents > 0),
      };
    }
  }

  return { activeAgents: 0, executingAgents: 0, activeQueens: 0, executingQueens: 0, maxAgents: CONFIG.maxAgents, coordinationActive: false };
}

// System metrics (uses process.memoryUsage() — no shell spawn)
function getSystemMetrics() {
  const memoryMB = Math.floor(process.memoryUsage().heapUsed / 1024 / 1024);
  const learning = getLearningStats();
  const agentdb = getAgentDBStats();

  // Intelligence from learning.json
  const learningData = readJSON(path.join(CWD, '.hive-flow', 'metrics', 'learning.json'));
  let intelligencePct = 0;
  let contextPct = 0;

  if (learningData?.intelligence?.score !== undefined) {
    intelligencePct = Math.min(100, Math.floor(learningData.intelligence.score));
  } else {
    const fromPatterns = learning.patterns > 0 ? Math.min(100, Math.floor(learning.patterns / 10)) : 0;
    const fromVectors = agentdb.vectorCount > 0 ? Math.min(100, Math.floor(agentdb.vectorCount / 100)) : 0;
    intelligencePct = Math.max(fromPatterns, fromVectors);
  }

  // Maturity fallback (pure fs checks, no git exec)
  if (intelligencePct === 0) {
    let score = 0;
    if (fs.existsSync(path.join(CWD, '.claude'))) score += 15;
    const srcDirs = ['src', 'lib', 'app', 'packages', 'v3'];
    for (const d of srcDirs) { if (fs.existsSync(path.join(CWD, d))) { score += 15; break; } }
    const testDirs = ['tests', 'test', '__tests__', 'spec'];
    for (const d of testDirs) { if (fs.existsSync(path.join(CWD, d))) { score += 10; break; } }
    const cfgFiles = ['package.json', 'tsconfig.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
    for (const f of cfgFiles) { if (fs.existsSync(path.join(CWD, f))) { score += 5; break; } }
    intelligencePct = Math.min(100, score);
  }

  if (learningData?.sessions?.total !== undefined) {
    contextPct = Math.min(100, learningData.sessions.total * 5);
  } else {
    contextPct = Math.min(100, Math.floor(learning.sessions * 5));
  }

  // Sub-agents from file metrics (no ps aux)
  let subAgents = 0;
  const activityData = readJSON(path.join(CWD, '.hive-flow', 'metrics', 'swarm-activity.json'));
  if (activityData?.processes?.estimated_agents) {
    subAgents = activityData.processes.estimated_agents;
  }

  return { memoryMB, contextPct, intelligencePct, subAgents };
}

// ADR status (count files only — don't read contents)
function getADRStatus() {
  const complianceData = readJSON(path.join(CWD, '.hive-flow', 'metrics', 'adr-compliance.json'));
  if (complianceData) {
    const checks = complianceData.checks || {};
    const total = Object.keys(checks).length;
    const impl = Object.values(checks).filter(c => c.compliant).length;
    return { count: total, implemented: impl, compliance: complianceData.compliance || 0 };
  }

  // Fallback: just count ADR files (don't read them)
  const adrPaths = [
    path.join(CWD, 'v3', 'implementation', 'adrs'),
    path.join(CWD, 'docs', 'adrs'),
    path.join(CWD, '.hive-flow', 'adrs'),
  ];

  for (const adrPath of adrPaths) {
    try {
      if (fs.existsSync(adrPath)) {
        const files = fs.readdirSync(adrPath).filter(f =>
          f.endsWith('.md') && (f.startsWith('ADR-') || f.startsWith('adr-') || /^\d{4}-/.test(f))
        );
        // Estimate: ~70% implemented in mature projects
        const implemented = Math.floor(files.length * 0.7);
        const compliance = files.length > 0 ? Math.floor((implemented / files.length) * 100) : 0;
        return { count: files.length, implemented, compliance };
      }
    } catch { /* ignore */ }
  }

  return { count: 0, implemented: 0, compliance: 0 };
}

// Hooks status — Row 11 REPLACE: parse real category/matcher/command counts from settings.
// Drops the hardcoded total=17. Returns { categories, matchers, commands }.
function getHooksStatus() {
  let categories = 0;
  let matchers = 0;
  let commands = 0;
  const settings = getSettings();

  if (settings?.hooks && typeof settings.hooks === 'object') {
    for (const [, hookList] of Object.entries(settings.hooks)) {
      if (!Array.isArray(hookList) || hookList.length === 0) continue;
      categories++;
      for (const hook of hookList) {
        // Each hook entry is a matcher object; its commands[] holds the actual runners.
        matchers++;
        const cmds = hook.commands ?? hook.hooks ?? [];
        commands += Array.isArray(cmds) ? cmds.length : 0;
      }
    }
  }

  return { categories, matchers, commands };
}

// AgentDB stats (pure stat calls)
function getAgentDBStats() {
  let vectorCount = 0;
  let dbSizeKB = 0;
  let namespaces = 0;
  let hasHnsw = false;

  const dbFiles = [
    path.join(CWD, '.swarm', 'memory.db'),
    path.join(CWD, '.hive-flow', 'memory.db'),
    path.join(CWD, '.claude', 'memory.db'),
    path.join(CWD, 'data', 'memory.db'),
  ];

  for (const f of dbFiles) {
    const stat = safeStat(f);
    if (stat) {
      dbSizeKB = stat.size / 1024;
      vectorCount = Math.floor(dbSizeKB / 2);
      namespaces = 1;
      break;
    }
  }

  if (vectorCount === 0) {
    const dbDirs = [
      path.join(CWD, '.hive-flow', 'agentdb'),
      path.join(CWD, '.swarm', 'agentdb'),
      path.join(CWD, '.agentdb'),
    ];
    for (const dir of dbDirs) {
      try {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
          const files = fs.readdirSync(dir);
          namespaces = files.filter(f => f.endsWith('.db') || f.endsWith('.sqlite')).length;
          for (const file of files) {
            const stat = safeStat(path.join(dir, file));
            if (stat?.isFile()) dbSizeKB += stat.size / 1024;
          }
          vectorCount = Math.floor(dbSizeKB / 2);
          break;
        }
      } catch { /* ignore */ }
    }
  }

  const hnswPaths = [
    path.join(CWD, '.swarm', 'hnsw.index'),
    path.join(CWD, '.hive-flow', 'hnsw.index'),
  ];
  for (const p of hnswPaths) {
    const stat = safeStat(p);
    if (stat) {
      hasHnsw = true;
      vectorCount = Math.max(vectorCount, Math.floor(stat.size / 512));
      break;
    }
  }

  return { vectorCount, dbSizeKB: Math.floor(dbSizeKB), namespaces, hasHnsw };
}

// Test stats (count files only — NO reading file contents)
function getTestStats() {
  let testFiles = 0;

  function countTestFiles(dir, depth = 0) {
    if (depth > 2) return; // Shallower recursion limit
    try {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          countTestFiles(path.join(dir, entry.name), depth + 1);
        } else if (entry.isFile()) {
          const n = entry.name;
          if (n.includes('.test.') || n.includes('.spec.') || n.includes('_test.') || n.includes('_spec.')) {
            testFiles++;
          }
        }
      }
    } catch { /* ignore */ }
  }

  for (const d of ['tests', 'test', '__tests__', 'v3/__tests__']) {
    countTestFiles(path.join(CWD, d));
  }
  countTestFiles(path.join(CWD, 'src'));

  // Estimate ~4 test cases per file (avoids reading every file)
  return { testFiles, testCases: testFiles * 4 };
}

// Integration status (shared settings + file checks)
function getIntegrationStatus() {
  const mcpServers = { total: 0, enabled: 0 };
  const settings = getSettings();

  if (settings?.mcpServers && typeof settings.mcpServers === 'object') {
    const servers = Object.keys(settings.mcpServers);
    mcpServers.total = servers.length;
    mcpServers.enabled = settings.enabledMcpjsonServers
      ? settings.enabledMcpjsonServers.filter(s => servers.includes(s)).length
      : servers.length;
  }

  // Fallback: .mcp.json
  if (mcpServers.total === 0) {
    const mcpConfig = readJSON(path.join(CWD, '.mcp.json'))
                   || readJSON(path.join(os.homedir(), '.claude', 'mcp.json'));
    if (mcpConfig?.mcpServers) {
      const s = Object.keys(mcpConfig.mcpServers);
      mcpServers.total = s.length;
      mcpServers.enabled = s.length;
    }
  }

  const hasDatabase = ['.swarm/memory.db', '.hive-flow/memory.db', 'data/memory.db']
    .some(p => fs.existsSync(path.join(CWD, p)));
  const hasApi = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);

  return { mcpServers, hasDatabase, hasApi };
}

function detectContextWindow() {
  const stdinData = getStdinData();
  if (stdinData?.context_window?.context_window_size != null) {
    const n = Number(stdinData.context_window.context_window_size);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // Autopilot persistence (ADR-051) — authoritative when present
  try {
    if (fs.existsSync(AUTOPILOT_STATE_PATH)) {
      const state = JSON.parse(fs.readFileSync(AUTOPILOT_STATE_PATH, 'utf-8'));
      if (state.contextWindow > 0) return state.contextWindow;
    }
  } catch { /* ignore */ }
  const envOverride = process.env.HIVE_FLOW_CONTEXT_WINDOW;
  if (envOverride) {
    const n = parseInt(envOverride, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const modelName = (stdinData?.model?.display_name || stdinData?.model?.model_id || getModelName() || '').toLowerCase();
  if (modelName.includes('1m') || modelName.includes('[1m]')) return 1000000;
  const claudeModel = (process.env.CLAUDE_MODEL || '').toLowerCase();
  if (claudeModel.includes('[1m]') || claudeModel.includes('1m')) return 1000000;
  // Default Anthropic API context window for standard (non-1M) models
  return 200000;
}

// Context usage estimate (reads tool call counter from hook handler)
function getContextUsage() {
  const stdinData = getStdinData();
  if (stdinData?.context_window) {
    const cw = stdinData.context_window;
    if (cw.used_percentage != null) {
      const pct = Math.floor(cw.used_percentage);
      return { calls: -1, pct, nearCompaction: pct >= 70 };
    }
    if (cw.remaining_percentage != null) {
      const pct = Math.floor(100 - cw.remaining_percentage);
      return { calls: -1, pct, nearCompaction: pct >= 70 };
    }
  }
  const contextWindow = detectContextWindow();
  const ctxFile = path.join(CWD, '.claude', '.context-tracker.json');
  try {
    const data = JSON.parse(fs.readFileSync(ctxFile, 'utf-8'));
    const calls = data.calls || 0;
    const estimatedTokens = calls * 1500;
    const pct = Math.min(99, Math.floor((estimatedTokens / contextWindow) * 100));
    return { calls, pct, nearCompaction: pct >= 70 };
  } catch { /* no tracker */ }
  return { calls: 0, pct: 0, nearCompaction: false };
}

// Session stats (pure file reads)
function getSessionStats() {
  for (const p of ['.hive-flow/session.json', '.claude/session.json']) {
    const data = readJSON(path.join(CWD, p));
    if (data?.startTime) {
      const diffMs = Date.now() - new Date(data.startTime).getTime();
      const mins = Math.floor(diffMs / 60000);
      const duration = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60}m`;
      return { duration };
    }
  }
  return { duration: '' };
}

// Advocate state
function getAdvocateState() {
  const advocateStatePath = path.join(CWD, '.hive-flow', 'data', 'advocate-state.json');
  const data = readJSON(advocateStatePath);

  if (!data) {
    return { state: 'none', indicator: '', display: '', color: c.dim };
  }

  const state = data.state || 'none';

  // Map states to indicators, colors, and display text
  switch (state) {
    case 'active':
      return {
        state,
        indicator: 'ADV:ACT',
        display: 'ADV:ACT',
        color: c.brightGreen
      };
    case 'waiting_human':
    case 'waiting-for-human':
      return {
        state,
        indicator: 'ADV:W:H',
        display: 'ADV:W:H',
        color: c.brightYellow
      };
    case 'waiting_hive':
    case 'waiting-for-hive':
      return {
        state,
        indicator: 'ADV:W:U',
        display: 'ADV:W:U',
        color: c.dim
      };
    case 'finalized':
    case 'finished':
      return {
        state,
        indicator: 'ADV:FIN',
        display: 'ADV:FIN',
        color: c.brightCyan
      };
    default:
      return {
        state,
        indicator: '',
        display: '',
        color: c.dim
      };
  }
}

// Daemon status — Row 24 ADD-CONDITIONAL: show `○ daemon off` only when not running.
// Probes the PID file; if absent or PID dead, daemon is off.
function getDaemonStatus() {
  const pidPaths = [
    path.join(CWD, '.hive-flow', 'daemon.pid'),
    path.join(CWD, '.claude', 'daemon.pid'),
  ];
  for (const pidPath of pidPaths) {
    try {
      if (fs.existsSync(pidPath)) {
        const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
        if (pid > 0) {
          try {
            // Signal 0 — existence check, no signal sent.
            process.kill(pid, 0);
            return { running: true };
          } catch { /* PID dead */ }
        }
      }
    } catch { /* file unreadable */ }
  }
  return { running: false };
}

// Enforcement level — Row 25 ADD-CONDITIONAL: show only when ≠ Normal (≠ 0).
function readEnforcementLevelFile(stateFile) {
  const data = readJSON(stateFile);
  if (!data || typeof data !== 'object') return 0;
  const rawLevel = data.state?.level
    ?? data.payload?.level
    ?? data.level
    ?? data.enforcementLevel
    ?? 0;
  const level = Number(rawLevel);
  return Number.isFinite(level) && level >= 0 ? level : 0;
}

function sanitizeScopeId(id) {
  return String(id || '')
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, 64);
}

function getProjectScopeId() {
  return `project-${crypto.createHash('sha256').update(CWD).digest('hex').slice(0, 16)}`;
}

function getEnforcementStateFiles() {
  const enforcementDir = path.join(CWD, '.hive-flow', 'enforcement');
  const stdin = getStdinData();
  const sessionId = sanitizeScopeId(stdin?.session_id || stdin?.sessionId || process.env.CLAUDE_SESSION_ID);
  const agentId = sanitizeScopeId(process.env.AGENTIC_FLOW_AGENT_ID || process.env.CLAUDE_AGENT_ID);
  const hiveId = sanitizeScopeId(process.env.HIVE_FLOW_HIVE_ID);
  const files = [
    path.join(enforcementDir, 'state.json'),
    path.join(enforcementDir, 'projects', getProjectScopeId(), 'state.json'),
  ];
  if (sessionId) files.push(path.join(enforcementDir, 'sessions', sessionId, 'state.json'));
  if (agentId) files.push(path.join(enforcementDir, 'agents', agentId, 'state.json'));
  if (hiveId) files.push(path.join(enforcementDir, 'hives', hiveId, 'state.json'));
  return files;
}

function getEnforcementLevel() {
  const level = Math.max(0, ...getEnforcementStateFiles().map(readEnforcementLevelFile));
  const labels = ['Normal', 'Warned', 'Restricted', 'Halted'];
  return { level, label: labels[level] ?? String(level) };
}

// Pipeline stage — Row 26 ADD-CONDITIONAL: show only when present.
function getPipelineStage() {
  const stateFile = path.join(CWD, '.hive-flow', 'data', 'pipeline-state.json');
  const data = readJSON(stateFile);
  if (!data) return { stage: '' };
  return { stage: data.currentStage ?? data.stage ?? '' };
}

// ─── Rendering ──────────────────────────────────────────────────

function progressBar(current, total) {
  const width = 5;
  const filled = Math.round((current / total) * width);
  return '[' + '\u25CF'.repeat(filled) + '\u25CB'.repeat(width - filled) + ']';
}

// Get AI provider usage (pure file reads + agent store supplement)
function getProviderUsage() {
  const usagePath = path.join(CWD, '.hive-flow', 'metrics', 'provider-usage.json');
  const data = readJSON(usagePath);
  const providers = data?.providers ? { ...data.providers } : {};

  // Ensure default Claude tiers exist
  ['opus', 'sonnet', 'haiku'].forEach(p => {
    if (!providers[p]) {
      providers[p] = { calls: 0, tokens: 0, ttfb_avg_ms: 0, last_used: null };
    }
  });

  // Supplement with model data from store.json agents (captures MCP-spawned agents)
  try {
    const storeData = getAgentStoreCount();
    for (const agent of storeData.agents) {
      if (agent.status === 'terminated') continue;
      const model = agent.model || agent.modelId || '';
      const provider = agent.provider || '';
      // Map to provider key
      let key = '';
      if (model.includes('opus')) key = 'opus';
      else if (model.includes('sonnet')) key = 'sonnet';
      else if (model.includes('haiku')) key = 'haiku';
      else if (provider === 'gemini-cli' || model.includes('gemini')) key = 'gemini';
      else if (provider === 'codex-cli' || model.includes('gpt') || model.includes('codex')) key = 'codex';
      else if (provider === 'cursor-cli') key = 'cursor';
      else if (model) key = model;
      if (key) {
        if (!providers[key]) {
          providers[key] = { calls: 0, tokens: 0, ttfb_avg_ms: 0, last_used: null };
        }
        providers[key].calls += 1;
      }
    }
  } catch { /* store.json unavailable -- keep provider-usage.json data only */ }

  return providers;
}

function generateStatusline() {
  // Collect all data (mostly pure Node.js, one git exec)
  const git = getGitInfo();
  const modelName = getModelName();
  const progress = getV3Progress();
  const security = getSecurityStatus();
  const swarm = getSwarmStatus();
  const system = getSystemMetrics();
  const adrs = getADRStatus();
  const hooks = getHooksStatus();
  const agentdb = getAgentDBStats();
  const tests = getTestStats();
  const session = getSessionStats();
  const integration = getIntegrationStatus();
  const context = getContextUsage();
  const advocate = getAdvocateState();
  const lines = [];

  // Header \u2014 project name resolved from stdin \u2192 package.json \u2192 cwd basename (Codex pass-1 row 1 REPLACE).
  // Mirrors the contract in v3/@hive-flow/cli/src/statusline/project-identity.ts.
  const projectName = (() => {
    const s = getStdinData();
    if (s?.workspace?.current_dir) {
      const base = path.basename(String(s.workspace.current_dir));
      if (base) return base.replace(/[\s_-]+/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase()).trim();
    }
    const pkg = readJSON(path.join(CWD, 'package.json'));
    if (pkg?.name && typeof pkg.name === 'string') {
      return pkg.name.replace(/^@[^/]+\//, '').replace(/[\s_-]+/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase()).trim();
    }
    return path.basename(CWD) || 'Hive Flow';
  })();
  let header = `${c.bold}${c.brightPurple}\u258A ${projectName} ${c.reset}`;
  header += `${swarm.coordinationActive ? c.brightCyan : c.dim}\u25CF ${c.brightCyan}${git.name}${c.reset}`;
  if (git.gitBranch) {
    header += `  ${c.dim}\u2502${c.reset}  ${c.brightBlue}\u23C7 ${git.gitBranch}${c.reset}`;
    const changes = git.modified + git.staged + git.untracked;
    if (changes > 0) {
      let ind = '';
      if (git.staged > 0) ind += `${c.brightGreen}+${git.staged}${c.reset}`;
      if (git.modified > 0) ind += `${c.brightYellow}~${git.modified}${c.reset}`;
      if (git.untracked > 0) ind += `${c.dim}?${git.untracked}${c.reset}`;
      header += ` ${ind}`;
    }
    if (git.ahead > 0) header += ` ${c.brightGreen}\u2191${git.ahead}${c.reset}`;
    if (git.behind > 0) header += ` ${c.brightRed}\u2193${git.behind}${c.reset}`;
  }
  header += `  ${c.dim}\u2502${c.reset}  ${c.purple}${modelName}${c.reset}`;
  if (session.duration) header += `  ${c.dim}\u2502${c.reset}  ${c.cyan}\u23F1 ${session.duration}${c.reset}`;
  // Context usage indicator
  if (context.pct > 0) {
    const ctxColor = context.pct >= 75 ? c.brightRed : context.pct >= 50 ? c.brightYellow : c.brightGreen;
    header += `  ${c.dim}\u2502${c.reset}  ${ctxColor}\uD83D\uDCD6 ${context.pct}% ctx${c.reset}`;
    if (context.nearCompaction) header += ` ${c.brightRed}\u26A0 compaction soon${c.reset}`;
  }
  lines.push(header);

  // Separator
  lines.push(`${c.dim}\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${c.reset}`);

  // Provider Usage — Row 6 REPLACE: only render providers with calls > 0.
  const providers = getProviderUsage();
  // All Claude tiers shown only when calls >= 1 (no forced zeros).
  const claudeNames = ['opus', 'sonnet', 'haiku'].filter(p => (providers[p]?.calls || 0) > 0);
  const externalNames = Object.keys(providers).filter(
    p => !['opus', 'sonnet', 'haiku'].includes(p) && providers[p].calls > 0
  );

  const colorFor = (p) => {
    if (p.calls <= 0) return c.dim;
    if (p.ttfb_avg_ms > 0 && p.ttfb_avg_ms < 1000) return c.brightGreen;
    if (p.ttfb_avg_ms >= 1000 && p.ttfb_avg_ms <= 3000) return c.brightYellow;
    if (p.ttfb_avg_ms > 3000) return c.brightRed;
    return c.brightGreen;
  };

  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  const formatFull = (name) => {
    const p = providers[name] || { calls: 0, ttfb_avg_ms: 0 };
    return `${colorFor(p)}${capitalize(name)} ${p.calls}${c.reset}`;
  };
  const formatAbbr = (name) => {
    const p = providers[name] || { calls: 0, ttfb_avg_ms: 0 };
    return `${colorFor(p)}${capitalize(name).substring(0, 2)}:${p.calls}${c.reset}`;
  };

  // Only render providers row when at least one provider has calls > 0.
  const allVisible = [...claudeNames, ...externalNames];
  if (allVisible.length > 0) {
    const fullClaude = claudeNames.map(formatFull).join(`${c.dim},${c.reset} `);
    const fullExternal = externalNames.map(formatFull).join(`${c.dim},${c.reset} `);
    const fullLine = fullClaude && fullExternal
      ? `\uD83E\uDD16 ${fullClaude} ${c.dim}|${c.reset} ${fullExternal}`
      : `\uD83E\uDD16 ${fullClaude || fullExternal}`;

    const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
    if (stripAnsi(fullLine).length <= 70) {
      lines.push(fullLine);
    } else {
      const abbrClaude = claudeNames.map(formatAbbr).join(`${c.dim},${c.reset} `);
      const abbrExternal = externalNames.map(formatAbbr).join(`${c.dim},${c.reset} `);
      const abbrLine = abbrClaude && abbrExternal
        ? `\uD83E\uDD16 ${abbrClaude} ${c.dim}|${c.reset} ${abbrExternal}`
        : `\uD83E\uDD16 ${abbrClaude || abbrExternal}`;
      lines.push(abbrLine);
    }
  }

  // Row 7 (DDD Domains 0/5) \u2014 OMIT: synthetic, daemon-not-running upstream cause.
  // Row 8 (\u26A1 target: 150x-12500x) \u2014 OMIT: marketing placeholder. Both rows removed.

  // Line 2: Swarm + Hooks (Row 11 REPLACE: live c/m/cmd counts) \u2014 subAgents(10)/CVE(12)/heap(13)/intelligence(14) OMITted.
  // Tri-state coloration:
  //   bright green \u25C9  \u2014 at least one agent currently running/busy (truly executing)
  //   bright yellow \u25CB \u2014 agents alive but all idle (swarm present, no active work)
  //   dim \u25CB           \u2014 no non-terminated agents
  const swarmExecuting = (swarm.executingAgents ?? 0) > 0;
  const swarmHasAgents = swarm.activeAgents > 0;
  const swarmInd = swarmExecuting
    ? `${c.brightGreen}\u25C9${c.reset}`
    : swarmHasAgents
      ? `${c.brightYellow}\u25CB${c.reset}`
      : `${c.dim}\u25CB${c.reset}`;
  const agentsColor = swarmExecuting ? c.brightGreen : swarmHasAgents ? c.brightYellow : c.dim;

  // Queen segment — separate from worker [N/50] because queens don't consume
  // worker slots. Bright cyan when any queen is running/busy, dark yellow
  // (renders as olive/brown on most terminals) when all queens are idle.
  // Omitted entirely when no queens are present.
  let queenSegment = '';
  const queenCount = swarm.activeQueens ?? 0;
  if (queenCount > 0) {
    const queenExecuting = (swarm.executingQueens ?? 0) > 0;
    const queenColor = queenExecuting ? c.brightCyan : c.yellow;
    queenSegment = ` ${queenColor}♛${queenCount}${c.reset}`;
  }
  const hooksColor = (hooks.categories > 0 || hooks.commands > 0) ? c.brightGreen : c.dim;

  // Advocate indicator (Row 23 KEEP-CONDITIONAL \u2014 already gated by indicator non-empty)
  const advocateIndicator = advocate.indicator ? ` ${advocate.color}${advocate.indicator}${c.reset}` : '';

  // Hooks display: 12c/28m/75cmd \u2014 omit zero segments gracefully.
  let hooksDisplay = '';
  if (hooks.categories > 0 || hooks.matchers > 0 || hooks.commands > 0) {
    const parts = [];
    if (hooks.categories > 0) parts.push(`${hooks.categories}c`);
    if (hooks.matchers > 0) parts.push(`${hooks.matchers}m`);
    if (hooks.commands > 0) parts.push(`${hooks.commands}cmd`);
    hooksDisplay = parts.join('/') || '0';
  } else {
    hooksDisplay = '0';
  }

  lines.push(
    `${c.brightYellow}\uD83E\uDD16 Swarm${c.reset}  ${swarmInd} [${agentsColor}${String(swarm.activeAgents).padStart(2)}${c.reset}/${c.brightWhite}${swarm.maxAgents}${c.reset}]${queenSegment}${advocateIndicator}  ` +
    `${c.brightBlue}\uD83E\uDE9D ${hooksColor}${hooksDisplay}${c.reset}`
  );

  // Line 3: Architecture \u2014 ADRs only. DDD\u25CF%(16) and Security\u25CFPENDING(17) OMITted (synthetic/no live scanner).
  const adrColor = adrs.count > 0 ? (adrs.implemented === adrs.count ? c.brightGreen : c.yellow) : c.dim;
  const adrDisplay = adrs.compliance > 0 ? `${adrColor}\u25CF${adrs.compliance}%${c.reset}` : `${adrColor}\u25CF${adrs.implemented}/${adrs.count}${c.reset}`;

  lines.push(
    `${c.brightPurple}\uD83D\uDD27 Architecture${c.reset}    ` +
    `${c.cyan}ADRs${c.reset} ${adrDisplay}`
  );

  // Line 4: AgentDB, Tests, Integration
  const hnswInd = agentdb.hasHnsw ? `${c.brightGreen}\u26A1${c.reset}` : '';
  const sizeDisp = agentdb.dbSizeKB >= 1024 ? `${(agentdb.dbSizeKB / 1024).toFixed(1)}MB` : `${agentdb.dbSizeKB}KB`;
  const vectorColor = agentdb.vectorCount > 0 ? c.brightGreen : c.dim;
  const testColor = tests.testFiles > 0 ? c.brightGreen : c.dim;

  let integStr = '';
  if (integration.mcpServers.total > 0) {
    const mcpCol = integration.mcpServers.enabled === integration.mcpServers.total ? c.brightGreen :
                   integration.mcpServers.enabled > 0 ? c.brightYellow : c.red;
    integStr += `${c.cyan}MCP${c.reset} ${mcpCol}\u25CF${integration.mcpServers.enabled}/${integration.mcpServers.total}${c.reset}`;
  }
  if (integration.hasDatabase) integStr += (integStr ? '  ' : '') + `${c.brightGreen}\u25C6${c.reset}DB`;
  if (integration.hasApi) integStr += (integStr ? '  ' : '') + `${c.brightGreen}\u25C6${c.reset}API`;
  if (!integStr) integStr = `${c.dim}\u25CF none${c.reset}`;

  lines.push(
    `${c.brightCyan}\uD83D\uDCCA AgentDB${c.reset}    ` +
    `${c.cyan}Vectors${c.reset} ${vectorColor}\u25CF${agentdb.vectorCount}${hnswInd}${c.reset}  ${c.dim}\u2502${c.reset}  ` +
    `${c.cyan}Size${c.reset} ${c.brightWhite}${sizeDisp}${c.reset}  ${c.dim}\u2502${c.reset}  ` +
    `${c.cyan}Tests${c.reset} ${testColor}\u25CF${tests.testFiles}${c.reset}  ${c.dim}\u2502${c.reset}  ` +
    integStr
  );

  // Row 24 ADD-CONDITIONAL: daemon status \u2014 show `\u25CB daemon off` only when not running.
  const daemon = getDaemonStatus();
  if (!daemon.running) {
    lines.push(`${c.dim}\u25CB daemon off${c.reset}`);
  }

  // Row 25 ADD-CONDITIONAL: enforcement level \u2014 show only when \u2260 Normal (level \u2260 0).
  const enforcement = getEnforcementLevel();
  if (enforcement.level !== 0) {
    const enfColor = enforcement.level >= 3 ? c.brightRed : enforcement.level >= 2 ? c.brightYellow : c.yellow;
    lines.push(`${enfColor}\u26A0 Enforcement: ${enforcement.label} (L${enforcement.level})${c.reset}`);
  }

  // Row 26 ADD-CONDITIONAL: pipeline stage \u2014 show only when present.
  const pipeline = getPipelineStage();
  if (pipeline.stage) {
    lines.push(`${c.cyan}\u27F3 Pipeline: ${pipeline.stage}${c.reset}`);
  }

  return lines.join('\n');
}

// JSON output — applies runbook §8 OMIT > FAKE: only emit a field when its
// source is live and verifiable. Synthetic / heuristic-only fields
// (v3Progress, intelligencePct, fake testCases derived from file-count, etc.)
// are intentionally OMITTED rather than emitted with stale or fabricated
// values. Real-source fields (memoryMB from process, dbSizeKB from fs.stat,
// testFiles from fs.readdir, etc.) are kept.
function generateJSON() {
  const git = getGitInfo();
  const security = getSecurityStatus();
  const agentdb = getAgentDBStats();
  const tests = getTestStats();
  const system = getSystemMetrics();
  const adrs = getADRStatus();

  const json = {
    user: { name: git.name, gitBranch: git.gitBranch, modelName: getModelName() },
    providers: getProviderUsage(),
    swarm: getSwarmStatus(),
    hooks: getHooksStatus(),
    daemon: getDaemonStatus(),
    enforcement: getEnforcementLevel(),
    pipeline: getPipelineStage(),
    git: { modified: git.modified, untracked: git.untracked, staged: git.staged, ahead: git.ahead, behind: git.behind },
    context: getContextUsage(),
    advocate: getAdvocateState(),
    lastUpdated: new Date().toISOString(),
  };

  // OMIT-on-no-source fields. Each block keeps only the live-derived sub-fields.
  if (security && (security.cvesFixed > 0 || security.status === 'CLEAN')) {
    json.security = { status: security.status, cvesFixed: security.cvesFixed, totalCves: security.totalCves };
  }
  if (system) {
    const sys = {};
    if (typeof system.memoryMB === 'number' && system.memoryMB >= 0) sys.memoryMB = system.memoryMB;
    if (typeof system.contextPct === 'number') sys.contextPct = system.contextPct;
    if (typeof system.subAgents === 'number' && system.subAgents > 0) sys.subAgents = system.subAgents;
    // intelligencePct intentionally omitted — synthetic fallback, no live source.
    if (Object.keys(sys).length > 0) json.system = sys;
  }
  if (adrs && adrs.count > 0) {
    json.adrs = { count: adrs.count, implemented: adrs.implemented, compliance: adrs.compliance };
  }
  if (agentdb && (agentdb.dbSizeKB > 0 || agentdb.vectorCount > 0)) {
    // vectorCount is heuristic-derived from file size; emit only dbSizeKB + hasHnsw
    // which have real sources. Per runbook OMIT > FAKE.
    json.agentdb = { dbSizeKB: agentdb.dbSizeKB, hasHnsw: agentdb.hasHnsw, namespaces: agentdb.namespaces };
  }
  if (tests && tests.testFiles > 0) {
    // testCases (testFiles * 4) is synthetic — OMITTED. Only the real testFiles count is emitted.
    json.tests = { testFiles: tests.testFiles };
  }
  // v3Progress intentionally OMITTED — synthetic with no live source.
  return json;
}

// ─── Main ───────────────────────────────────────────────────────
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(generateJSON(), null, 2));
} else if (process.argv.includes('--compact')) {
  console.log(JSON.stringify(generateJSON()));
} else {
  console.log(generateStatusline());
}
