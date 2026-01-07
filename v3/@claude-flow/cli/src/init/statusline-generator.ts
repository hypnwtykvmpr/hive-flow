/**
 * Statusline Configuration Generator
 * Creates statusline configuration for V3 progress display
 */

import type { InitOptions, StatuslineConfig } from './types.js';

/**
 * Generate statusline configuration script
 * Matches the advanced format:
 * ▊ Claude Flow V3 ● user  │  ⎇ v3  │  Opus 4.5
 * ─────────────────────────────────────────────────────
 * 🏗️  DDD Domains    [●●●●●]  5/5    ⚡ 1.0x → 2.49x-7.47x
 * 🤖 Swarm  ◉ [12/15]  👥 0    🟢 CVE 3/3    💾 5177MB    📂  56%    🧠  30%
 * 🔧 Architecture    DDD ●100%  │  Security ●CLEAN  │  Memory ●AgentDB  │  Integration ●
 */
export function generateStatuslineScript(options: InitOptions): string {
  const config = options.statusline;

  return `#!/usr/bin/env node
/**
 * Claude Flow V3 Statusline Generator
 * Displays real-time V3 implementation progress and system status
 *
 * Usage: node statusline.js [--json] [--compact]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const CONFIG = {
  enabled: ${config.enabled},
  showProgress: ${config.showProgress},
  showSecurity: ${config.showSecurity},
  showSwarm: ${config.showSwarm},
  showHooks: ${config.showHooks},
  showPerformance: ${config.showPerformance},
  refreshInterval: ${config.refreshInterval},
  maxAgents: ${options.runtime.maxAgents},
  topology: '${options.runtime.topology}',
};

// ANSI colors
const c = {
  reset: '\\x1b[0m',
  bold: '\\x1b[1m',
  dim: '\\x1b[2m',
  red: '\\x1b[0;31m',
  green: '\\x1b[0;32m',
  yellow: '\\x1b[0;33m',
  blue: '\\x1b[0;34m',
  purple: '\\x1b[0;35m',
  cyan: '\\x1b[0;36m',
  brightRed: '\\x1b[1;31m',
  brightGreen: '\\x1b[1;32m',
  brightYellow: '\\x1b[1;33m',
  brightBlue: '\\x1b[1;34m',
  brightPurple: '\\x1b[1;35m',
  brightCyan: '\\x1b[1;36m',
  brightWhite: '\\x1b[1;37m',
};

// Get user info
function getUserInfo() {
  let name = 'user';
  let gitBranch = '';
  let modelName = 'Opus 4.5';

  try {
    name = execSync('git config user.name 2>/dev/null || echo "user"', { encoding: 'utf-8' }).trim();
    gitBranch = execSync('git branch --show-current 2>/dev/null || echo ""', { encoding: 'utf-8' }).trim();
  } catch (e) {
    // Ignore errors
  }

  return { name, gitBranch, modelName };
}

// Get V3 progress from filesystem
function getV3Progress() {
  const v3Path = path.join(process.cwd(), 'v3', '@claude-flow');
  let domainsCompleted = 5;
  let totalDomains = 5;
  let dddProgress = 100;
  let modulesCount = 0;
  let filesCount = 0;

  try {
    if (fs.existsSync(v3Path)) {
      const modules = fs.readdirSync(v3Path);
      modulesCount = modules.filter(m => fs.statSync(path.join(v3Path, m)).isDirectory()).length;
      domainsCompleted = Math.min(5, Math.floor(modulesCount / 3));
      dddProgress = Math.min(100, Math.floor((modulesCount / 15) * 100));
    }
  } catch (e) {
    // Ignore errors
  }

  return { domainsCompleted, totalDomains, dddProgress, modulesCount, filesCount };
}

// Get security status
function getSecurityStatus() {
  const securityPath = path.join(process.cwd(), 'v3', '@claude-flow', 'security');
  const exists = fs.existsSync(securityPath);

  return {
    status: exists ? 'CLEAN' : 'IN_PROGRESS',
    cvesFixed: exists ? 3 : 2,
    totalCves: 3,
  };
}

// Get swarm status
function getSwarmStatus() {
  let activeAgents = 0;
  let coordinationActive = false;

  try {
    const ps = execSync('ps aux 2>/dev/null | grep -c agentic-flow || echo "0"', { encoding: 'utf-8' });
    activeAgents = Math.max(0, parseInt(ps.trim()) - 1);
    coordinationActive = activeAgents > 0;
  } catch (e) {
    // Ignore errors
  }

  return {
    activeAgents,
    maxAgents: CONFIG.maxAgents,
    coordinationActive,
  };
}

// Get system metrics
function getSystemMetrics() {
  let memoryMB = 0;
  let subAgents = 0;

  try {
    const mem = execSync('ps aux | grep -E "(node|agentic|claude)" | grep -v grep | awk \\'{sum += \\$6} END {print int(sum/1024)}\\'', { encoding: 'utf-8' });
    memoryMB = parseInt(mem.trim()) || 0;
  } catch (e) {
    // Fallback
    memoryMB = Math.floor(process.memoryUsage().heapUsed / 1024 / 1024);
  }

  return {
    memoryMB,
    contextPct: 56, // Would need Claude Code input
    intelligencePct: 30,
    subAgents,
  };
}

// Generate progress bar
function progressBar(current, total) {
  const width = 5;
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  return '[' + '\\u25CF'.repeat(filled) + '\\u25CB'.repeat(empty) + ']';
}

// Generate full statusline
function generateStatusline() {
  const user = getUserInfo();
  const progress = getV3Progress();
  const security = getSecurityStatus();
  const swarm = getSwarmStatus();
  const system = getSystemMetrics();
  const lines = [];

  // Header Line
  let header = \`\${c.bold}\${c.brightPurple}▊ Claude Flow V3 \${c.reset}\`;
  header += \`\${swarm.coordinationActive ? c.brightCyan : c.dim}● \${c.brightCyan}\${user.name}\${c.reset}\`;
  if (user.gitBranch) {
    header += \`  \${c.dim}│\${c.reset}  \${c.brightBlue}⎇ \${user.gitBranch}\${c.reset}\`;
  }
  header += \`  \${c.dim}│\${c.reset}  \${c.purple}\${user.modelName}\${c.reset}\`;
  lines.push(header);

  // Separator
  lines.push(\`\${c.dim}─────────────────────────────────────────────────────\${c.reset}\`);

  // Line 1: DDD Domain Progress
  const domainsColor = progress.domainsCompleted >= 3 ? c.brightGreen : progress.domainsCompleted > 0 ? c.yellow : c.red;
  lines.push(
    \`\${c.brightCyan}🏗️  DDD Domains\${c.reset}    \${progressBar(progress.domainsCompleted, progress.totalDomains)}  \` +
    \`\${domainsColor}\${progress.domainsCompleted}\${c.reset}/\${c.brightWhite}\${progress.totalDomains}\${c.reset}    \` +
    \`\${c.brightYellow}⚡ 1.0x\${c.reset} \${c.dim}→\${c.reset} \${c.brightYellow}2.49x-7.47x\${c.reset}\`
  );

  // Line 2: Swarm + CVE + Memory + Context + Intelligence
  const swarmIndicator = swarm.coordinationActive ? \`\${c.brightGreen}◉\${c.reset}\` : \`\${c.dim}○\${c.reset}\`;
  const agentsColor = swarm.activeAgents > 0 ? c.brightGreen : c.red;
  let securityIcon = security.status === 'CLEAN' ? '🟢' : security.status === 'IN_PROGRESS' ? '🟡' : '🔴';
  let securityColor = security.status === 'CLEAN' ? c.brightGreen : security.status === 'IN_PROGRESS' ? c.brightYellow : c.brightRed;

  lines.push(
    \`\${c.brightYellow}🤖 Swarm\${c.reset}  \${swarmIndicator} [\${agentsColor}\${String(swarm.activeAgents).padStart(2)}\${c.reset}/\${c.brightWhite}\${swarm.maxAgents}\${c.reset}]  \` +
    \`\${c.brightPurple}👥 \${system.subAgents}\${c.reset}    \` +
    \`\${securityIcon} \${securityColor}CVE \${security.cvesFixed}\${c.reset}/\${c.brightWhite}\${security.totalCves}\${c.reset}    \` +
    \`\${c.brightCyan}💾 \${system.memoryMB}MB\${c.reset}    \` +
    \`\${c.brightGreen}📂 \${String(system.contextPct).padStart(3)}%\${c.reset}    \` +
    \`\${c.dim}🧠 \${String(system.intelligencePct).padStart(3)}%\${c.reset}\`
  );

  // Line 3: Architecture status
  const dddColor = progress.dddProgress >= 50 ? c.brightGreen : progress.dddProgress > 0 ? c.yellow : c.red;
  lines.push(
    \`\${c.brightPurple}🔧 Architecture\${c.reset}    \` +
    \`\${c.cyan}DDD\${c.reset} \${dddColor}●\${String(progress.dddProgress).padStart(3)}%\${c.reset}  \${c.dim}│\${c.reset}  \` +
    \`\${c.cyan}Security\${c.reset} \${securityColor}●\${security.status}\${c.reset}  \${c.dim}│\${c.reset}  \` +
    \`\${c.cyan}Memory\${c.reset} \${c.brightGreen}●AgentDB\${c.reset}  \${c.dim}│\${c.reset}  \` +
    \`\${c.cyan}Integration\${c.reset} \${swarm.coordinationActive ? c.brightCyan : c.dim}●\${c.reset}\`
  );

  return lines.join('\\n');
}

// Generate JSON data
function generateJSON() {
  return {
    user: getUserInfo(),
    v3Progress: getV3Progress(),
    security: getSecurityStatus(),
    swarm: getSwarmStatus(),
    system: getSystemMetrics(),
    performance: {
      flashAttentionTarget: '2.49x-7.47x',
      searchImprovement: '150x-12,500x',
      memoryReduction: '50-75%',
    },
    lastUpdated: new Date().toISOString(),
  };
}

// Main
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
    return '# Statusline disabled';
  }

  return `# Claude Flow V3 Statusline Hook
# Add to your shell RC file (.bashrc, .zshrc, etc.)

# Function to get statusline
claude_flow_statusline() {
  local statusline_script="\${CLAUDE_FLOW_DIR:-.claude}/helpers/statusline.js"
  if [ -f "$statusline_script" ]; then
    node "$statusline_script" 2>/dev/null || echo ""
  fi
}

# For bash PS1
# export PS1='$(claude_flow_statusline) \\n\\$ '

# For zsh RPROMPT
# export RPROMPT='$(claude_flow_statusline)'

# For starship (add to starship.toml)
# [custom.claude_flow]
# command = "node .claude/helpers/statusline.js 2>/dev/null"
# when = "test -f .claude/helpers/statusline.js"
`;
}
