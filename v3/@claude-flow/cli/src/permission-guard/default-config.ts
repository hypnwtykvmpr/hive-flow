/**
 * Default Permission Config — Comprehensive allow/deny/escalate patterns.
 * Merged UNDER user config so user overrides always win.
 */

import type { PermissionConfig, BashPatternEntry } from './types.js';

// ---------------------------------------------------------------------------
// Always-allow bash patterns (~50 patterns for common dev commands)
// ---------------------------------------------------------------------------

const DEFAULT_ALLOW_BASH: BashPatternEntry[] = [
  // File inspection
  'ls *', 'cat *', 'head *', 'tail *', 'wc *', 'file *', 'stat *',
  'less *', 'more *', 'bat *',
  // Shell basics
  'echo *', 'printf *', 'pwd', 'whoami', 'date', 'env', 'printenv *',
  'which *', 'type *', 'uname *', 'hostname',
  // Search & filter
  'grep *', 'rg *', 'find *', 'sort *', 'uniq *', 'cut *', 'tr *',
  'sed *', 'awk *', 'diff *', 'md5sum *', 'sha256sum *',
  // System info
  'df *', 'du *', 'free *', 'uptime', 'top -l 1*', 'ps aux*',
  // Git read operations
  'git status*', 'git log*', 'git diff*', 'git branch*', 'git show*',
  'git remote*', 'git tag*', 'git describe*', 'git rev-parse*',
  'git ls-files*', 'git stash list*', 'git config --list*',
  'git config --get*', 'git blame*', 'git shortlog*',
  // Git write (common dev)
  'git add *', 'git commit *', 'git switch *',
  'git merge *', 'git rebase *', 'git stash*', 'git pull*',
  'git push *', 'git fetch*', 'git cherry-pick*',
  // Node/npm
  'node *', 'npm run *', 'npm test*', 'npm list*', 'npm ls*',
  'npm view*', 'npm info*', 'npm outdated*', 'npm audit*',
  'npm pack*', 'npm install*', 'npm ci*', 'npm init*',
  'npx *', 'pnpm *', 'yarn *', 'bun *',
  // TypeScript & linting
  'tsc *', 'tsc', 'eslint *', 'prettier *', 'biome *',
  // Testing
  'jest *', 'jest', 'vitest *', 'vitest', 'mocha *', 'nyc *',
  // Build tools
  'make *', 'make', 'cmake *', 'ninja *',
  // Rust
  'cargo *', 'rustc *', 'rustup *',
  // Go
  'go *',
  // Python
  'python *', 'python3 *', 'pip *', 'pip3 *', 'pytest *', 'mypy *',
  'ruff *', 'black *', 'isort *',
  // System package managers (read ops)
  'brew list*', 'brew info*', 'brew search*',
  'apt list*', 'dpkg -l*',
  // Docker read
  'docker ps*', 'docker images*', 'docker logs*', 'docker inspect*',
  'docker compose ps*', 'docker compose logs*',
  // Kubernetes read
  'kubectl get*', 'kubectl describe*', 'kubectl logs*',
  // Misc dev tools
  'curl *', 'wget *', 'jq *', 'yq *', 'xargs *',
  'tree *', 'tree', 'realpath *', 'basename *', 'dirname *',
  'mkdir *', 'touch *', 'cp *', 'mv *',
];

// ---------------------------------------------------------------------------
// Always-deny bash patterns (~20 patterns for dangerous commands)
// ---------------------------------------------------------------------------

const DEFAULT_DENY_BASH: BashPatternEntry[] = [
  // --- Existing catastrophic patterns ---
  { pattern: 'rm -rf /', feedback: 'Cannot delete root filesystem' },
  { pattern: 'rm -rf /*', feedback: 'Cannot delete root filesystem contents' },
  { pattern: 'rm -fr /', feedback: 'Cannot delete root filesystem' },
  { pattern: 'sudo rm *', feedback: 'Sudo rm is too dangerous for autonomous operation' },
  { pattern: 'sudo dd *', feedback: 'Sudo dd is too dangerous for autonomous operation' },
  { pattern: 'mkfs*', feedback: 'Cannot format filesystems' },
  { pattern: 'dd if=*of=/dev/*', feedback: 'Cannot write directly to block devices' },
  { pattern: 'shred *', feedback: 'Cannot shred files' },
  { pattern: ':(){ :|:& };:', feedback: 'Fork bomb detected' },
  { pattern: 'shutdown*', feedback: 'Cannot shut down the system' },
  { pattern: 'reboot*', feedback: 'Cannot reboot the system' },
  { pattern: 'poweroff*', feedback: 'Cannot power off the system' },
  { pattern: 'halt*', feedback: 'Cannot halt the system' },
  { pattern: 'systemctl stop*', feedback: 'Cannot stop system services' },
  { pattern: 'systemctl disable*', feedback: 'Cannot disable system services' },
  { pattern: 'chmod 777 *', feedback: 'Cannot set world-writable permissions' },
  { pattern: 'curl *|*bash*', feedback: 'Cannot pipe curl to shell' },
  { pattern: 'curl *|*sh*', feedback: 'Cannot pipe curl to shell' },
  { pattern: 'wget *|*bash*', feedback: 'Cannot pipe wget to shell' },
  { pattern: 'wget *|*sh*', feedback: 'Cannot pipe wget to shell' },

  // --- FORBIDDEN patterns (no automated override, no escalation path) ---
  { pattern: 'rm *', feedback: 'DENIED: File deletion is not available. Use `npm run clean` or `make clean` for build artifacts.' },
  { pattern: 'chmod *', feedback: 'DENIED: Permission changes are not available. Configure execute permissions in your build system.' },
  { pattern: 'chown *', feedback: 'DENIED: Ownership changes are not available.' },
  { pattern: 'killall *', feedback: 'DENIED: Bulk process termination is not available. Use the application\'s own stop/restart command.' },
  { pattern: 'docker rm*', feedback: 'DENIED: Container removal is not available. Use `docker-compose down` for managed containers.' },
  { pattern: 'docker rmi*', feedback: 'DENIED: Image removal is not available.' },
  { pattern: 'git push --force*', feedback: 'DENIED: Force push is not available (including --force-with-lease). Rebase and push normally with `git push`.' },
  { pattern: 'git reset --hard*', feedback: 'DENIED: Hard reset is not available. Use `git stash` to save work safely.' },
];

// ---------------------------------------------------------------------------
// Jury-escalation bash patterns (~10 patterns requiring review)
// ---------------------------------------------------------------------------

const DEFAULT_ESCALATION_BASH: BashPatternEntry[] = [
  // Jury-assessable patterns: LLM jury can evaluate with full context.
  // When auto-denied, feedback tells the agent how to re-submit with justification.
  { pattern: 'sudo *', feedback: 'Elevated privileges are auto-denied. Find a userspace alternative. If truly required, re-submit with an explanation of what needs root access and why — a jury will evaluate your justification.' },
  { pattern: 'kill *', feedback: 'Process termination is auto-denied. Use the process\'s own shutdown mechanism (npm stop, the tool\'s CLI). If a process is stuck, re-submit with the specific PID and reason — a jury will evaluate.' },
  { pattern: 'pkill *', feedback: 'Pattern-based process kill is auto-denied. Use the application\'s own shutdown mechanism. If needed, re-submit with the specific process name and reason — a jury will evaluate.' },
  { pattern: 'git checkout *', feedback: 'git checkout is auto-denied — it can discard uncommitted changes. Use `git switch` for branch changes (pre-approved) or `git stash` to save work. If checkout is truly the only option, re-submit with justification — a jury will evaluate.' },
];

// ---------------------------------------------------------------------------
// Always-allow tools
// ---------------------------------------------------------------------------

const DEFAULT_ALLOW_TOOLS = [
  'Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'TodoRead', 'TodoWrite',
  'TaskList', 'TaskGet', 'TaskCreate', 'TaskUpdate',
  'NotebookRead', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
];

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
  always_allow_tools: DEFAULT_ALLOW_TOOLS,
  always_allow_tool_prefixes: ['mcp__claude-flow__'],
  mcp_default_policy: 'allow',
  mcp_deny_tool_prefixes: [],
  mcp_escalate_tool_prefixes: [],
  always_allow_bash_patterns: DEFAULT_ALLOW_BASH,
  always_deny_bash_patterns: DEFAULT_DENY_BASH,
  jury_escalation_bash_patterns: DEFAULT_ESCALATION_BASH,
  allowed_write_paths: [],
  allow_paths_outside_working_directory: false,
  log_file: '',
  notifications: { enabled: false, on_escalation: false, on_deny: false },
};

/**
 * Merge user config over defaults. User values override defaults.
 * Arrays are replaced, not merged (user has full control).
 */
export function mergeWithDefaults(userConfig: Partial<PermissionConfig>): PermissionConfig {
  return { ...DEFAULT_PERMISSION_CONFIG, ...userConfig };
}
