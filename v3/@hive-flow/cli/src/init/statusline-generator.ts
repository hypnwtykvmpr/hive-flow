/**
 * Statusline Configuration Generator (Optimized)
 * Creates fast, reliable statusline for V3 progress display
 *
 * Performance:
 * - Single combined git execSync call (not 8+ separate ones)
 * - process.memoryUsage() instead of ps aux
 * - No recursive test file content reading
 * - Shared settings cache
 * - Strict 2s timeouts on all shell calls
 */

import type { InitOptions } from './types.js';
import { DEFAULT_QUEUE_DEPTH } from '../shared/core/config/defaults.js';

/**
 * Generate optimized statusline script
 * Output format:
 * ▊ Hive Flow V3 ● user  │  ⎇ branch  │  Opus 4.6
 * ─────────────────────────────────────────────────────
 * 🏗️  DDD Domains    [●●○○○]  2/5    ⚡ HNSW
 * 🤖 Swarm  ◉ [ 5/15]  👥 2    🪝 10/17    🟢 CVE 3/3    💾 4MB    🧠  63%
 * 🔧 Architecture    ADRs ●71%  │  DDD ● 13%  │  Security ●CLEAN
 * 📊 HiveMemory    Embeddings ●3104⚡  │  Size 216KB  │  Tests ●6 (~24 cases)  │  MCP ●1/1
 */
export function generateStatuslineScript(options: InitOptions): string {
  const maxAgents = options.runtime.maxAgents;
  const queueDepth = DEFAULT_QUEUE_DEPTH;

  return `#!/usr/bin/env node
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

// Configuration
const CONFIG = {
  maxAgents: ${maxAgents},
  queueDepth: ${queueDepth},
};

const CWD = process.cwd();

// ANSI colors
const c = {
  reset: '\\x1b[0m',
  bold: '\\x1b[1m',
  dim: '\\x1b[2m',
  red: '\\x1b[0;31m',
  green: '\\x1b[0;32m',
  blue: '\\x1b[0;34m',
  purple: '\\x1b[0;35m',
  cyan: '\\x1b[0;36m',
  brightRed: '\\x1b[1;31m',
  brightGreen: '\\x1b[1;32m',
  // Phase 12: single warning/intermediate carrier. Orange (256-color 38;5;208)
  // mirrors the canonical claude-code-renderer palette warn slot. Legacy
  // amber palette entries were removed in favor of this single owner.
  warn: '\\x1b[38;5;208m',
  brightBlue: '\\x1b[1;34m',
  brightPurple: '\\x1b[1;35m',
  brightCyan: '\\x1b[1;36m',
  brightWhite: '\\x1b[1;37m',
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

  const raw = safeExec("sh -c '" + script + "'", 3000);
  if (!raw) return result;

  const parts = raw.split('---SEP---').map(s => s.trim());
  if (parts.length >= 4) {
    result.name = parts[0] || 'user';
    result.gitBranch = parts[1] || '';

    // Parse porcelain status
    if (parts[2]) {
      for (const line of parts[2].split('\\n')) {
        if (!line || line.length < 2) continue;
        const x = line[0], y = line[1];
        if (x === '?' && y === '?') { result.untracked++; continue; }
        if (x !== ' ' && x !== '?') result.staged++;
        if (y !== ' ' && y !== '?') result.modified++;
      }
    }

    // Parse ahead/behind
    const ab = (parts[3] || '0 0').split(/\\s+/);
    result.ahead = parseInt(ab[0]) || 0;
    result.behind = parseInt(ab[1]) || 0;
  }

  return result;
}

// Detect model name from Claude config (pure file reads, no exec)
function getModelName() {
  try {
    const claudeConfig = readJSON(path.join(os.homedir(), '.claude.json'));
    if (claudeConfig && claudeConfig.projects) {
      for (const [projectPath, projectConfig] of Object.entries(claudeConfig.projects)) {
        if (CWD === projectPath || CWD.startsWith(projectPath + '/')) {
          const usage = projectConfig.lastModelUsage;
          if (usage) {
            const ids = Object.keys(usage);
            if (ids.length > 0) {
              let modelId = ids[ids.length - 1];
              let latest = 0;
              for (const id of ids) {
                const ts = usage[id] && usage[id].lastUsedAt ? new Date(usage[id].lastUsedAt).getTime() : 0;
                if (ts > latest) { latest = ts; modelId = id; }
              }
              if (modelId.includes('opus')) return 'Opus 4.6';
              if (modelId.includes('sonnet')) return 'Sonnet 4.6';
              return modelId.split('-').slice(1, 3).join(' ');
            }
          }
          break;
        }
      }
    }
  } catch { /* ignore */ }

  // Fallback: settings.json model field
  const settings = getSettings();
  if (settings && settings.model) {
    const m = settings.model;
    if (m.includes('opus')) return 'Opus 4.6';
    if (m.includes('sonnet')) return 'Sonnet 4.6';
  }
  return 'Claude Code';
}

// Get learning stats — REAL counts only.
//
// Phase 12: a memory.db file SIZE must never be converted into a pattern or
// session count. Patterns come from the learning metrics file when it records
// an exact count; otherwise patterns is 0. Sessions come from the metrics file
// or the real count of session files on disk — never from a byte heuristic.
function getLearningStats() {
  const learningData = readJSON(path.join(CWD, '.hive-flow', 'metrics', 'learning.json'));

  let patterns = 0;
  if (learningData) {
    if (typeof learningData.patterns === 'number') {
      patterns = Math.floor(learningData.patterns);
    } else if (learningData.patterns && typeof learningData.patterns.total === 'number') {
      patterns = Math.floor(learningData.patterns.total);
    }
  }

  let sessions = 0;
  if (learningData && learningData.sessions && typeof learningData.sessions.total === 'number') {
    sessions = Math.floor(learningData.sessions.total);
  } else {
    try {
      const sessDir = path.join(CWD, '.claude', 'sessions');
      if (fs.existsSync(sessDir)) {
        sessions = fs.readdirSync(sessDir).filter(f => f.endsWith('.json')).length;
      }
    } catch { /* ignore */ }
  }

  return { patterns: Math.max(0, patterns), sessions: Math.max(0, sessions) };
}

// V3 progress from metrics files (pure file reads)
function getV3Progress() {
  const learning = getLearningStats();
  const totalDomains = 5;

  // Phase 12: DDD progress comes only from the real ddd-progress.json metric.
  // Never estimate domain completion from a pattern count — that fabricates a
  // domain-completion claim with no trusted source.
  const dddData = readJSON(path.join(CWD, '.hive-flow', 'metrics', 'ddd-progress.json'));
  const dddProgress = dddData ? (dddData.progress || 0) : 0;
  const domainsCompleted = Math.min(5, Math.floor(dddProgress / 20));

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

// Swarm status (pure file reads, NO ps aux).
// Read order: live agent store first (always current, no staleness window),
// then metrics files as fallback (rejected if older than 10 min) so stale
// writes can't mask an active live hive. Counts only owned agents with live
// process evidence; completed/idle records without a live pid are retained in
// store.json for history but must never keep the live Swarm row visible.
function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 1;
}

function isPidDefinitelyDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err && err.code === 'ESRCH';
  }
}

function hasLiveProcessEvidence(agent) {
  return isPositiveInteger(agent.currentTaskPid) && !isPidDefinitelyDead(agent.currentTaskPid);
}

function hasOwnerSession(agent) {
  return typeof agent.ownerSessionId === 'string' && agent.ownerSessionId.trim().length > 0;
}

function getSwarmStatus() {
  // PRIMARY: live agent store written by MCP agent_spawn / queen_mission_assign.
  // Returns both 'active' (non-terminated) and 'executing' (running/busy) so the
  // renderer can distinguish idle-but-alive from actually-doing-work.
  try {
    const storePath = path.join(CWD, '.hive-flow', 'agents', 'store.json');
    if (fs.existsSync(storePath)) {
      const store = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
      let agents = [];
      if (store && store.agents && typeof store.agents === 'object' && !Array.isArray(store.agents)) {
        agents = Object.values(store.agents).filter(v => v && typeof v === 'object');
      } else if (store && Array.isArray(store.agents)) {
        agents = store.agents;
      } else if (store && Array.isArray(store.entries)) {
        agents = store.entries;
      }
      const active = agents.filter(a =>
        a.status !== 'terminated' &&
        a.status !== 'failed' &&
        hasOwnerSession(a) &&
        hasLiveProcessEvidence(a)
      );
      const executing = active.filter(a => a.status === 'running' || a.status === 'busy');
      if (active.length > 0) {
        return {
          activeAgents: active.length,
          executingAgents: executing.length,
          maxAgents: CONFIG.maxAgents,
          coordinationActive: true,
        };
      }
    }
  } catch { /* fall through to metrics-file fallbacks */ }

  // Do not fall back to aggregate metrics here. Swarm is a live-process
  // surface; metrics files can be fresh and still describe agents that have
  // already exited.
  return { activeAgents: 0, executingAgents: 0, maxAgents: CONFIG.maxAgents, coordinationActive: false };
}

// System metrics (uses process.memoryUsage() — no shell spawn)
function getSystemMetrics() {
  const memoryMB = Math.floor(process.memoryUsage().heapUsed / 1024 / 1024);

  // Intelligence from learning.json
  const learningData = readJSON(path.join(CWD, '.hive-flow', 'metrics', 'learning.json'));
  let intelligencePct = 0;
  let contextPct = 0;

  // Phase 12: intelligence is a REAL score from learning.json only. Never
  // synthesize it from pattern/vector counts or from directory-existence
  // "maturity" heuristics — those fabricate a percentage with no trusted
  // source. When the metric is absent, intelligencePct stays 0 (omitted).
  if (learningData && learningData.intelligence && learningData.intelligence.score !== undefined) {
    intelligencePct = Math.min(100, Math.floor(learningData.intelligence.score));
  }

  // Phase 12: context% is a REAL metric from learning.json only. Never derive
  // it from a session count heuristic.
  if (
    learningData &&
    learningData.context &&
    typeof learningData.context.usedPct === 'number'
  ) {
    contextPct = Math.min(100, Math.floor(learningData.context.usedPct));
  }

  // Sub-agents from file metrics (no ps aux)
  let subAgents = 0;
  const activityData = readJSON(path.join(CWD, '.hive-flow', 'metrics', 'swarm-activity.json'));
  if (activityData && activityData.processes && activityData.processes.estimated_agents) {
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
    return { count: total, implemented: impl, compliance: complianceData.compliance || 0, source: 'compliance-data' };
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
          f.endsWith('.md') && (f.startsWith('ADR-') || f.startsWith('adr-') || /^\\d{4}-/.test(f))
        );
        // Phase 12: no trusted compliance data — report file count only.
        // Never synthesize an "implemented" count or compliance percentage
        // from the file count. The renderer shows the count, not a fake %.
        return { count: files.length, implemented: 0, compliance: 0, source: 'file-count-only' };
      }
    } catch { /* ignore */ }
  }

  return { count: 0, implemented: 0, compliance: 0, source: 'none' };
}

// Hooks status (shared settings cache)
function getHooksStatus() {
  let enabled = 0;
  const total = 17;
  const settings = getSettings();

  if (settings && settings.hooks) {
    for (const category of Object.keys(settings.hooks)) {
      const h = settings.hooks[category];
      if (Array.isArray(h) && h.length > 0) enabled++;
    }
  }

  try {
    const hooksDir = path.join(CWD, '.claude', 'hooks');
    if (fs.existsSync(hooksDir)) {
      const hookFiles = fs.readdirSync(hooksDir).filter(f => f.endsWith('.js') || f.endsWith('.sh')).length;
      enabled = Math.max(enabled, hookFiles);
    }
  } catch { /* ignore */ }

  return { enabled, total };
}

// HiveMemory stats (pure stat calls + one trusted metrics read)
function getHiveMemoryStats() {
  let vectorCount = 0;
  let dbSizeKB = 0;
  let namespaces = 0;
  let hasHnsw = false;

  // Phase 12: the vector/embedding count is a REAL metric, never synthesized
  // from a database or index file size. Read the exact count from a trusted
  // memory stats file when present; otherwise leave it 0 so the renderer omits
  // the count rather than fabricating one from bytes-on-disk.
  const statsPaths = [
    path.join(CWD, '.hive-flow', 'memory', 'stats.json'),
    path.join(CWD, '.swarm', 'memory', 'stats.json'),
  ];
  for (const sp of statsPaths) {
    const stats = readJSON(sp);
    if (stats) {
      const exact = (stats.embeddings && typeof stats.embeddings.count === 'number')
        ? stats.embeddings.count
        : (typeof stats.vectorCount === 'number' ? stats.vectorCount : undefined);
      if (typeof exact === 'number' && exact >= 0) vectorCount = Math.floor(exact);
      break;
    }
  }

  // dbSizeKB and namespaces are real filesystem facts (bytes on disk, db file
  // count) — kept. Only the vector COUNT must not be derived from size.
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
      namespaces = 1;
      break;
    }
  }

  if (namespaces === 0) {
    const dbDirs = [
      path.join(CWD, '.hive-flow', 'hivememory'),
      path.join(CWD, '.swarm', 'hivememory'),
      path.join(CWD, '.hivememory'),
    ];
    for (const dir of dbDirs) {
      try {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
          const files = fs.readdirSync(dir);
          namespaces = files.filter(f => f.endsWith('.db') || f.endsWith('.sqlite')).length;
          for (const file of files) {
            const stat = safeStat(path.join(dir, file));
            if (stat && stat.isFile()) dbSizeKB += stat.size / 1024;
          }
          break;
        }
      } catch { /* ignore */ }
    }
  }

  // hasHnsw is a real fact: the index file physically exists. No size-derived
  // count is taken from it.
  const hnswPaths = [
    path.join(CWD, '.swarm', 'hnsw.index'),
    path.join(CWD, '.hive-flow', 'hnsw.index'),
  ];
  for (const p of hnswPaths) {
    const stat = safeStat(p);
    if (stat) {
      hasHnsw = true;
      break;
    }
  }

  return { vectorCount, dbSizeKB: Math.floor(dbSizeKB), namespaces, hasHnsw };
}

// Test stats (count files only — NO reading file contents)
function getTestStats() {
  let testFiles = 0;

  function countTestFiles(dir, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 2) return;
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

  var testDirNames = ['tests', 'test', '__tests__', 'v3/__tests__'];
  for (var i = 0; i < testDirNames.length; i++) {
    countTestFiles(path.join(CWD, testDirNames[i]));
  }
  countTestFiles(path.join(CWD, 'src'));

  return { testFiles, testCases: testFiles * 4 };
}

// Integration status (shared settings + file checks)
function getIntegrationStatus() {
  const mcpServers = { total: 0, enabled: 0 };
  const settings = getSettings();

  if (settings && settings.mcpServers && typeof settings.mcpServers === 'object') {
    const servers = Object.keys(settings.mcpServers);
    mcpServers.total = servers.length;
    mcpServers.enabled = settings.enabledMcpjsonServers
      ? settings.enabledMcpjsonServers.filter(s => servers.includes(s)).length
      : servers.length;
  }

  if (mcpServers.total === 0) {
    const mcpConfig = readJSON(path.join(CWD, '.mcp.json'))
                   || readJSON(path.join(os.homedir(), '.claude', 'mcp.json'));
    if (mcpConfig && mcpConfig.mcpServers) {
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

// Session stats (pure file reads)
function getSessionStats() {
  var sessionPaths = ['.hive-flow/session.json', '.claude/session.json'];
  for (var i = 0; i < sessionPaths.length; i++) {
    const data = readJSON(path.join(CWD, sessionPaths[i]));
    if (data && data.startTime) {
      const diffMs = Date.now() - new Date(data.startTime).getTime();
      const mins = Math.floor(diffMs / 60000);
      const duration = mins < 60 ? mins + 'm' : Math.floor(mins / 60) + 'h' + (mins % 60) + 'm';
      return { duration: duration };
    }
  }
  return { duration: '' };
}

// ─── Rendering ──────────────────────────────────────────────────

function progressBar(current, total) {
  const width = 5;
  const filled = Math.round((current / total) * width);
  return '[' + '\\u25CF'.repeat(filled) + '\\u25CB'.repeat(width - filled) + ']';
}

function generateStatusline() {
  const git = getGitInfo();
  // Prefer model name from Claude Code stdin data, fallback to file-based detection
  const modelName = getModelFromStdin() || getModelName();
  const ctxInfo = getContextFromStdin();
  const costInfo = getCostFromStdin();
  const progress = getV3Progress();
  const security = getSecurityStatus();
  const swarm = getSwarmStatus();
  const system = getSystemMetrics();
  const adrs = getADRStatus();
  const hooks = getHooksStatus();
  const hiveMemory = getHiveMemoryStats();
  const tests = getTestStats();
  const session = getSessionStats();
  const integration = getIntegrationStatus();
  const lines = [];

  // Header — project label is derived at runtime (basename of cwd, title-cased)
  // so generated statuslines reflect the project they live in, not a hardcoded
  // 'Hive Flow V3' literal. Falls back to 'Hive Flow' if basename is empty.
  const projectLabel = (() => {
    const base = require('path').basename(process.cwd());
    if (!base) return 'Hive Flow';
    return base.replace(/[\\s_-]+/g, ' ').replace(/\\b\\w/g, (ch) => ch.toUpperCase()).trim();
  })();
  let header = c.bold + c.brightPurple + '\\u258A ' + projectLabel + ' ' + c.reset;
  header += (swarm.coordinationActive ? c.brightCyan : c.dim) + '\\u25CF ' + c.brightCyan + git.name + c.reset;
  if (git.gitBranch) {
    header += '  ' + c.dim + '\\u2502' + c.reset + '  ' + c.brightBlue + '\\u23C7 ' + git.gitBranch + c.reset;
    const changes = git.modified + git.staged + git.untracked;
    if (changes > 0) {
      let ind = '';
      if (git.staged > 0) ind += c.brightGreen + '+' + git.staged + c.reset;
      if (git.modified > 0) ind += c.warn + '~' + git.modified + c.reset;
      if (git.untracked > 0) ind += c.dim + '?' + git.untracked + c.reset;
      header += ' ' + ind;
    }
    if (git.ahead > 0) header += ' ' + c.brightGreen + '\\u2191' + git.ahead + c.reset;
    if (git.behind > 0) header += ' ' + c.brightRed + '\\u2193' + git.behind + c.reset;
  }
  header += '  ' + c.dim + '\\u2502' + c.reset + '  ' + c.purple + modelName + c.reset;
  // Show session duration from Claude Code stdin if available, else from local files
  const duration = costInfo ? costInfo.duration : session.duration;
  if (duration) header += '  ' + c.dim + '\\u2502' + c.reset + '  ' + c.cyan + '\\u23F1 ' + duration + c.reset;
  // Show context usage from Claude Code stdin if available
  if (ctxInfo && ctxInfo.usedPct > 0) {
    const ctxColor = ctxInfo.usedPct >= 90 ? c.brightRed : ctxInfo.usedPct >= 70 ? c.warn : c.brightGreen;
    header += '  ' + c.dim + '\\u2502' + c.reset + '  ' + ctxColor + '\\u25CF ' + ctxInfo.usedPct + '% ctx' + c.reset;
  }
  // Show cost from Claude Code stdin if available
  if (costInfo && costInfo.costUsd > 0) {
    header += '  ' + c.dim + '\\u2502' + c.reset + '  ' + c.warn + '$' + costInfo.costUsd.toFixed(2) + c.reset;
  }
  lines.push(header);

  // Separator
  lines.push(c.dim + '\\u2500'.repeat(53) + c.reset);

  // Line 1: DDD Domains
  const domainsColor = progress.domainsCompleted >= 3 ? c.brightGreen : progress.domainsCompleted > 0 ? c.warn : c.red;
  // Phase 12: show "HNSW" only as a presence indicator when the index exists
  // and a real vector count is known — never a fabricated speedup multiplier
  // (the old numeric/HNSW-indexed/large-scale HNSW-indexed claims were synthesized from a byte-derived count
  // and are removed). When no trusted perf metric exists, omit the indicator
  // rather than print an aspirational "target" string.
  let perfIndicator = '';
  if (hiveMemory.hasHnsw && hiveMemory.vectorCount > 0) {
    perfIndicator = c.brightGreen + '\\u26A1 HNSW' + c.reset;
  } else if (progress.patternsLearned > 0) {
    const pk = progress.patternsLearned >= 1000 ? (progress.patternsLearned / 1000).toFixed(1) + 'k' : String(progress.patternsLearned);
    perfIndicator = c.warn + '\\uD83D\\uDCDA ' + pk + ' patterns' + c.reset;
  }
  lines.push(
    c.brightCyan + '\\uD83C\\uDFD7\\uFE0F  DDD Domains' + c.reset + '    ' + progressBar(progress.domainsCompleted, progress.totalDomains) + '  ' +
    domainsColor + progress.domainsCompleted + c.reset + '/' + c.brightWhite + progress.totalDomains + c.reset + '    ' + perfIndicator
  );

  // Line 2: Swarm + Hooks + CVE + Memory + Intelligence
  // Tri-state coloration:
  //   bright green ◉  — at least one agent currently running/busy (truly executing)
  //   bright yellow ○ — agents alive but all idle (swarm present, no active work)
  //   dim ○           — no non-terminated agents
  const swarmExecuting = (swarm.executingAgents || 0) > 0;
  const swarmHasAgents = swarm.activeAgents > 0;
  const swarmInd = swarmExecuting
    ? c.brightGreen + '\\u25C9' + c.reset
    : swarmHasAgents
      ? c.warn + '\\u25CB' + c.reset
      : c.dim + '\\u25CB' + c.reset;
  const agentsColor = swarmExecuting ? c.brightGreen : swarmHasAgents ? c.warn : c.dim;

  // Queen segment — separate from worker [N/max] because queens don't consume
  // worker slots. Bright cyan when any queen is running/busy, dark yellow
  // (renders as olive/brown) when all queens are idle. Omitted entirely when 0.
  let queenSegment = '';
  const queenCount = swarm.activeQueens || 0;
  if (queenCount > 0) {
    const queenExecuting = (swarm.executingQueens || 0) > 0;
    const queenColor = queenExecuting ? c.brightCyan : c.warn;
    queenSegment = ' ' + queenColor + '\\u265B' + queenCount + c.reset;
  }
  const secIcon = security.status === 'CLEAN' ? '\\uD83D\\uDFE2' : security.status === 'IN_PROGRESS' ? '\\uD83D\\uDFE1' : '\\uD83D\\uDD34';
  const secColor = security.status === 'CLEAN' ? c.brightGreen : security.status === 'IN_PROGRESS' ? c.warn : c.brightRed;
  const hooksColor = hooks.enabled > 0 ? c.brightGreen : c.dim;
  const intellColor = system.intelligencePct >= 80 ? c.brightGreen : system.intelligencePct >= 40 ? c.warn : c.dim;
  const swarmSegment = swarmHasAgents || queenCount > 0
    ? c.warn + '\\uD83E\\uDD16 Swarm' + c.reset + '  ' + swarmInd + ' [' + agentsColor + String(swarm.activeAgents).padStart(2) + c.reset + '/' + c.brightWhite + swarm.maxAgents + c.reset + ']' + queenSegment + '  '
    : '';

  lines.push(
    swarmSegment +
    c.brightPurple + '\\uD83D\\uDC65 ' + system.subAgents + c.reset + '    ' +
    c.brightBlue + '\\uD83E\\uDE9D ' + hooksColor + hooks.enabled + c.reset + '/' + c.brightWhite + hooks.total + c.reset + '    ' +
    secIcon + ' ' + secColor + 'CVE ' + security.cvesFixed + c.reset + '/' + c.brightWhite + security.totalCves + c.reset + '    ' +
    c.brightCyan + '\\uD83D\\uDCBE ' + system.memoryMB + 'MB' + c.reset + '    ' +
    intellColor + '\\uD83E\\uDDE0 ' + String(system.intelligencePct).padStart(3) + '%' + c.reset
  );

  // Line 3: Architecture
  const dddColor = progress.dddProgress >= 50 ? c.brightGreen : progress.dddProgress > 0 ? c.warn : c.red;
  const adrColor = adrs.count > 0 ? (adrs.implemented === adrs.count && adrs.source === 'compliance-data' ? c.brightGreen : c.warn) : c.dim;
  // Phase 12: only show a compliance % when it comes from trusted compliance
  // data. With file-count-only (no trusted metric) show the count, never a
  // synthesized percentage or implemented/total ratio.
  const adrDisplay = adrs.source === 'file-count-only'
    ? adrColor + '\\u25CF' + adrs.count + c.reset
    : (adrs.compliance > 0 ? adrColor + '\\u25CF' + adrs.compliance + '%' + c.reset : adrColor + '\\u25CF' + adrs.implemented + '/' + adrs.count + c.reset);

  lines.push(
    c.brightPurple + '\\uD83D\\uDD27 Architecture' + c.reset + '    ' +
    c.cyan + 'ADRs' + c.reset + ' ' + adrDisplay + '  ' + c.dim + '\\u2502' + c.reset + '  ' +
    c.cyan + 'DDD' + c.reset + ' ' + dddColor + '\\u25CF' + String(progress.dddProgress).padStart(3) + '%' + c.reset + '  ' + c.dim + '\\u2502' + c.reset + '  ' +
    c.cyan + 'Security' + c.reset + ' ' + secColor + '\\u25CF' + security.status + c.reset
  );

  // Line 4: HiveMemory, Tests, Integration
  const hnswInd = hiveMemory.hasHnsw ? c.brightGreen + '\\u26A1' + c.reset : '';
  const sizeDisp = hiveMemory.dbSizeKB >= 1024 ? (hiveMemory.dbSizeKB / 1024).toFixed(1) + 'MB' : hiveMemory.dbSizeKB + 'KB';
  const testColor = tests.testFiles > 0 ? c.brightGreen : c.dim;
  // Phase 12: the embeddings segment renders ONLY when backed by an exact
  // count from memory/stats.json (hiveMemory.vectorCount > 0). The legacy
  // byte-derived embedding label was removed; when no real count exists the
  // segment is omitted rather than printing a fabricated number.
  const embStr = hiveMemory.vectorCount > 0
    ? c.cyan + 'Embeddings' + c.reset + ' ' + c.brightGreen + '\\u25CF' + hiveMemory.vectorCount + hnswInd + c.reset + '  ' + c.dim + '\\u2502' + c.reset + '  '
    : '';

  let integStr = '';
  if (integration.mcpServers.total > 0) {
    const mcpCol = integration.mcpServers.enabled === integration.mcpServers.total ? c.brightGreen :
                   integration.mcpServers.enabled > 0 ? c.warn : c.red;
    integStr += c.cyan + 'MCP' + c.reset + ' ' + mcpCol + '\\u25CF' + integration.mcpServers.enabled + '/' + integration.mcpServers.total + c.reset;
  }
  if (integration.hasDatabase) integStr += (integStr ? '  ' : '') + c.brightGreen + '\\u25C6' + c.reset + 'DB';
  if (integration.hasApi) integStr += (integStr ? '  ' : '') + c.brightGreen + '\\u25C6' + c.reset + 'API';
  if (!integStr) integStr = c.dim + '\\u25CF none' + c.reset;

  lines.push(
    c.brightCyan + '\\uD83D\\uDCCA HiveMemory' + c.reset + '    ' +
    embStr +
    c.cyan + 'Size' + c.reset + ' ' + c.brightWhite + sizeDisp + c.reset + '  ' + c.dim + '\\u2502' + c.reset + '  ' +
    c.cyan + 'Tests' + c.reset + ' ' + testColor + '\\u25CF' + tests.testFiles + c.reset + ' ' + c.dim + '(~' + tests.testCases + ' cases)' + c.reset + '  ' + c.dim + '\\u2502' + c.reset + '  ' +
    integStr
  );

  return lines.join('\\n');
}

// JSON output
function generateJSON() {
  const git = getGitInfo();
  return {
    user: { name: git.name, gitBranch: git.gitBranch, modelName: getModelName() },
    v3Progress: getV3Progress(),
    security: getSecurityStatus(),
    swarm: getSwarmStatus(),
    system: getSystemMetrics(),
    adrs: getADRStatus(),
    hooks: getHooksStatus(),
    hiveMemory: getHiveMemoryStats(),
    tests: getTestStats(),
    git: { modified: git.modified, untracked: git.untracked, staged: git.staged, ahead: git.ahead, behind: git.behind },
    lastUpdated: new Date().toISOString(),
  };
}

// ─── Stdin reader (Claude Code pipes session JSON) ──────────────

// Claude Code sends session JSON via stdin (model, context, cost, etc.)
// Read it synchronously so the script works both:
//   1. When invoked by Claude Code (stdin has JSON)
//   2. When invoked manually from terminal (stdin is empty/tty)
let _stdinData = null;
function getStdinData() {
  if (_stdinData !== undefined && _stdinData !== null) return _stdinData;
  try {
    // Check if stdin is a TTY (manual run) — skip reading
    if (process.stdin.isTTY) { _stdinData = null; return null; }
    // Read stdin synchronously via fd 0
    const chunks = [];
    const buf = Buffer.alloc(4096);
    let bytesRead;
    try {
      while ((bytesRead = fs.readSync(0, buf, 0, buf.length, null)) > 0) {
        chunks.push(buf.slice(0, bytesRead));
      }
    } catch { /* EOF or read error */ }
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (raw && raw.startsWith('{')) {
      _stdinData = JSON.parse(raw);
    } else {
      _stdinData = null;
    }
  } catch {
    _stdinData = null;
  }
  return _stdinData;
}

// Override model detection to prefer stdin data from Claude Code
function getModelFromStdin() {
  const data = getStdinData();
  if (data && data.model && data.model.display_name) return data.model.display_name;
  return null;
}

// Get context window info from Claude Code session
function getContextFromStdin() {
  const data = getStdinData();
  if (data && data.context_window) {
    return {
      usedPct: Math.floor(data.context_window.used_percentage || 0),
      remainingPct: Math.floor(data.context_window.remaining_percentage || 100),
    };
  }
  return null;
}

// Get cost info from Claude Code session
function getCostFromStdin() {
  const data = getStdinData();
  if (data && data.cost) {
    const durationMs = data.cost.total_duration_ms || 0;
    const mins = Math.floor(durationMs / 60000);
    const secs = Math.floor((durationMs % 60000) / 1000);
    return {
      costUsd: data.cost.total_cost_usd || 0,
      duration: mins > 0 ? mins + 'm' + secs + 's' : secs + 's',
      linesAdded: data.cost.total_lines_added || 0,
      linesRemoved: data.cost.total_lines_removed || 0,
    };
  }
  return null;
}

// ─── Main ───────────────────────────────────────────────────────
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(generateJSON(), null, 2));
} else if (process.argv.includes('--compact')) {
  console.log(JSON.stringify(generateJSON()));
} else {
  console.log(generateStatusline());
}
`;
}

/**
 * Generate statusline hook for shell integration
 */
export function generateStatuslineHook(options: InitOptions): string {
  if (!options.statusline.enabled) {
    return '#!/bin/bash\n# Statusline disabled\n';
  }

  return `#!/bin/bash
# Hive Flow V3 Statusline Hook
# Source this in your .bashrc/.zshrc for terminal statusline

# Function to get statusline
hive_flow_statusline() {
  local statusline_script="\${HIVE_FLOW_DIR:-.claude}/helpers/statusline.cjs"
  if [ -f "$statusline_script" ]; then
    node "$statusline_script" 2>/dev/null || echo ""
  fi
}

# Bash: Add to PS1
# export PS1='$(hive_flow_statusline) \\n\\$ '

# Zsh: Add to RPROMPT
# export RPROMPT='$(hive_flow_statusline)'

# Claude Code: Add to .claude/settings.json
# "statusLine": {
#   "type": "command",
#   "command": "node .claude/helpers/statusline.cjs 2>/dev/null"
#   "when": "test -f .claude/helpers/statusline.cjs"
# }
`;
}
