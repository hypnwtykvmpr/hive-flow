/**
 * Default Permission Config — Comprehensive allow/deny/escalate patterns.
 * Merged UNDER user config so user overrides always win.
 */

import type { PermissionConfig, BashPatternEntry } from './types.js';

// ---------------------------------------------------------------------------
// Always-allow bash patterns (~50 patterns for common dev commands)
// ---------------------------------------------------------------------------

const NO_WRITE_REDIRECTS = '(?!.*(?:^|\\s)(?:\\d?>|\\d?>>|&>|&>>|>|>>))';
const NO_TEE_PIPE = '(?!.*(?:^|\\s)\\|\\s*tee\\b)';
const NO_DD_OUTPUT = '(?!.*\\bdd\\b[^\\n]*\\bof=)';
const READ_ONLY_EFFECTS = `${NO_WRITE_REDIRECTS}${NO_TEE_PIPE}${NO_DD_OUTPUT}`;
const readOnly = (pattern: string): string => `^${READ_ONLY_EFFECTS}${pattern}`;
const readOnlyCommand = (command: string): string => readOnly(`${command}\\b.*`);

const DEFAULT_ALLOW_BASH: BashPatternEntry[] = [
  // File inspection
  readOnlyCommand('ls'), readOnlyCommand('cat'), readOnlyCommand('head'), readOnlyCommand('tail'),
  readOnlyCommand('wc'), readOnlyCommand('file'), readOnlyCommand('stat'),
  readOnlyCommand('less'), readOnlyCommand('more'), readOnlyCommand('bat'),
  // Shell basics
  readOnlyCommand('echo'), readOnlyCommand('printf'), readOnlyCommand('pwd'), readOnlyCommand('whoami'),
  readOnlyCommand('date'), readOnly('env\\s*$'), readOnlyCommand('printenv'),
  readOnlyCommand('which'), readOnlyCommand('type'), readOnlyCommand('uname'), readOnlyCommand('hostname'),
  // Search & filter
  readOnlyCommand('grep'), readOnlyCommand('rg'),
  readOnly('find\\b(?!.*(?:^|\\s)-(?:exec|execdir|delete|fprintf)(?:\\b|=)).*'),
  readOnlyCommand('sort'), readOnlyCommand('uniq'), readOnlyCommand('cut'), readOnlyCommand('tr'),
  readOnly('sed\\b(?!.*(?:^|\\s)-i(?:\\b|\\S*)).*'),
  readOnly('awk\\b(?!.*\\bsystem\\s*\\()(?!.*\\bprint\\b[^\\n]*>).*'),
  readOnlyCommand('diff'), readOnlyCommand('md5sum'), readOnlyCommand('sha256sum'),
  // System info
  readOnlyCommand('df'), readOnlyCommand('du'), readOnlyCommand('free'), readOnlyCommand('uptime'),
  readOnly('top\\s+-l\\s+1\\b.*'), readOnly('ps\\s+aux\\b.*'),
  // Git read operations
  readOnly('git\\s+status\\b.*'), readOnly('git\\s+log\\b.*'), readOnly('git\\s+diff\\b.*'),
  readOnly('git\\s+branch\\s*$'), readOnly('git\\s+branch\\s+(?:--list|-l|-a|-r|-v|-vv|--show-current)\\b.*'),
  readOnly('git\\s+show\\b.*'), readOnly('git\\s+remote\\s*(?:-v\\s*)?$'),
  readOnly('git\\s+tag\\s*$'), readOnly('git\\s+tag\\s+(?:--list|-l)\\b.*'),
  readOnly('git\\s+describe\\b.*'), readOnly('git\\s+rev-parse\\b.*'),
  readOnly('git\\s+ls-files\\b.*'), readOnly('git\\s+stash\\s+list\\b.*'),
  readOnly('git\\s+config\\s+--list\\b.*'), readOnly('git\\s+config\\s+--get\\b.*'),
  readOnly('git\\s+blame\\b.*'), readOnly('git\\s+shortlog\\b.*'),
  // Node/npm
  'node *', readOnly('npm\\s+run\\s+(?:lint|test|build|check|format|typecheck)(?:\\b|[-_:].*)?'),
  readOnly('npm\\s+test\\b.*'), readOnly('npm\\s+list\\b.*'), readOnly('npm\\s+ls\\b.*'),
  readOnly('npm\\s+view\\b.*'), readOnly('npm\\s+info\\b.*'), readOnly('npm\\s+outdated\\b.*'),
  readOnly('npm\\s+audit\\b.*'), readOnly('npm\\s+pack\\b.*'),
  'npx *', 'pnpm *', 'yarn *', 'bun *',
  // TypeScript & linting
  readOnlyCommand('tsc'), readOnlyCommand('eslint'), readOnlyCommand('prettier'), readOnlyCommand('biome'),
  // Testing
  readOnlyCommand('jest'), readOnlyCommand('vitest'), readOnlyCommand('mocha'), readOnlyCommand('nyc'),
  // Build tools
  readOnlyCommand('make'), readOnlyCommand('cmake'), readOnlyCommand('ninja'),
  // Rust
  'cargo *', 'rustc *', 'rustup *',
  // Go
  'go *',
  // Python
  'python *', 'python3 *', readOnly('pip\\s+list\\b.*'), readOnly('pip\\s+show\\b.*'),
  readOnly('pip3\\s+list\\b.*'), readOnly('pip3\\s+show\\b.*'), readOnlyCommand('pytest'), readOnlyCommand('mypy'),
  readOnlyCommand('ruff'), readOnlyCommand('black'), readOnlyCommand('isort'),
  // System package managers (read ops)
  readOnly('brew\\s+list\\b.*'), readOnly('brew\\s+info\\b.*'), readOnly('brew\\s+search\\b.*'),
  readOnly('apt\\s+list\\b.*'), readOnly('dpkg\\s+-l\\b.*'),
  // Docker read
  readOnly('docker\\s+ps\\b.*'), readOnly('docker\\s+images\\b.*'), readOnly('docker\\s+logs\\b.*'), readOnly('docker\\s+inspect\\b.*'),
  readOnly('docker\\s+compose\\s+ps\\b.*'), readOnly('docker\\s+compose\\s+logs\\b.*'),
  // Kubernetes read
  readOnly('kubectl\\s+get\\b.*'), readOnly('kubectl\\s+describe\\b.*'), readOnly('kubectl\\s+logs\\b.*'),
  // Misc dev tools
  readOnlyCommand('jq'), readOnlyCommand('yq'), 'xargs *',
  readOnlyCommand('tree'), readOnlyCommand('realpath'), readOnlyCommand('basename'), readOnlyCommand('dirname'),
];

// ---------------------------------------------------------------------------
// Always-deny bash patterns (~20 patterns for dangerous commands)
// ---------------------------------------------------------------------------

const DEFAULT_DENY_BASH: BashPatternEntry[] = [
  // --- Existing catastrophic patterns ---
  // --- Catastrophic patterns (proper regex, anchored by checkBashPatterns) ---
  { pattern: 'rm\\s+-rf\\s+/', feedback: 'Cannot delete root filesystem' },
  { pattern: 'rm\\s+-rf\\s+/.*', feedback: 'Cannot delete root filesystem contents' },
  { pattern: 'rm\\s+-fr\\s+/', feedback: 'Cannot delete root filesystem' },
  { pattern: '^sudo\\s+rm\\b', feedback: 'Sudo rm is too dangerous for autonomous operation' },
  { pattern: '^sudo\\s+dd\\b', feedback: 'Sudo dd is too dangerous for autonomous operation' },
  { pattern: '^mkfs\\b', feedback: 'Cannot format filesystems' },
  { pattern: '^dd\\s+.*of=/dev/', feedback: 'Cannot write directly to block devices' },
  { pattern: '^shred\\b', feedback: 'Cannot shred files' },
  { pattern: '^:\\(\\)\\{\\s*:\\|:\\&\\s*\\};:', feedback: 'Fork bomb detected' },
  { pattern: '^shutdown\\b', feedback: 'Cannot shut down the system' },
  { pattern: '^reboot\\b', feedback: 'Cannot reboot the system' },
  { pattern: '^poweroff\\b', feedback: 'Cannot power off the system' },
  { pattern: '^halt\\b', feedback: 'Cannot halt the system' },
  { pattern: '^systemctl\\s+stop\\b', feedback: 'Cannot stop system services' },
  { pattern: '^systemctl\\s+disable\\b', feedback: 'Cannot disable system services' },
  { pattern: '^chmod\\s+777\\b', feedback: 'Cannot set world-writable permissions' },
  { pattern: '^curl\\b.*\\|.*\\bbash\\b', feedback: 'Cannot pipe curl to shell' },
  { pattern: '^curl\\b.*\\|.*\\bsh\\b', feedback: 'Cannot pipe curl to shell' },
  { pattern: '^wget\\b.*\\|.*\\bbash\\b', feedback: 'Cannot pipe wget to shell' },
  { pattern: '^wget\\b.*\\|.*\\bsh\\b', feedback: 'Cannot pipe wget to shell' },

  // --- FORBIDDEN patterns (no automated override, no escalation path) ---
  { pattern: '^rm\\s+.*(?:-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r|--recursive\\b.*--force\\b|--force\\b.*--recursive\\b)', feedback: 'DENIED: Recursive forced deletion is not available. Use the project clean command for build artifacts.' },
  { pattern: '^sudo\\s+rm\\b', feedback: 'DENIED: Sudo rm is not available.' },
  { pattern: '^chmod\\s+777\\b', feedback: 'DENIED: World-writable permissions are not available.' },
  { pattern: '^chmod\\s+-R\\b', feedback: 'DENIED: Recursive chmod is not available.' },
  { pattern: '^chown\\b', feedback: 'DENIED: Ownership changes are not available.' },
  { pattern: '^killall\\b', feedback: 'DENIED: Bulk process termination is not available. Use the application\'s own stop/restart command.' },
  { pattern: '^docker\\s+rm\\b', feedback: 'DENIED: Container removal is not available. Use `docker-compose down` for managed containers.' },
  { pattern: '^docker\\s+rmi\\b', feedback: 'DENIED: Image removal is not available.' },
  { pattern: '^git\\s+push\\s+--force', feedback: 'DENIED: Force push is not available (including --force-with-lease). Rebase and push normally with `git push`.' },
  { pattern: '^git\\s+push\\s+-f\\b', feedback: 'DENIED: Force push is not available. Rebase and push normally with `git push`.' },
  { pattern: '^git\\s+reset\\s+--hard', feedback: 'DENIED: Hard reset is not available. Use `git stash` to save work safely.' },
];

// ---------------------------------------------------------------------------
// Jury-escalation bash patterns (~10 patterns requiring review)
// ---------------------------------------------------------------------------

const DEFAULT_ESCALATION_BASH: BashPatternEntry[] = [
  // Jury-assessable patterns: LLM jury can evaluate with full context.
  // When auto-denied, feedback tells the agent how to re-submit with justification.
  { pattern: '^sudo\\b', feedback: 'Elevated privileges are auto-denied. Find a userspace alternative. If truly required, re-submit with an explanation of what needs root access and why — a jury will evaluate your justification.' },
  { pattern: '^kill\\b', feedback: 'Process termination is auto-denied. Use the process\'s own shutdown mechanism (npm stop, the tool\'s CLI). If a process is stuck, re-submit with the specific PID and reason — a jury will evaluate.' },
  { pattern: '^pkill\\b', feedback: 'Pattern-based process kill is auto-denied. Use the application\'s own shutdown mechanism. If needed, re-submit with the specific process name and reason — a jury will evaluate.' },
  { pattern: '^git\\s+checkout\\b', feedback: 'git checkout is auto-denied — it can discard uncommitted changes. Use `git switch` for branch changes; the inline jury can fast-approve it when safe. Use `git stash` to save work. If checkout is truly the only option, re-submit with justification — a jury will evaluate.' },
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
  always_allow_tool_prefixes: ['mcp__hive-flow__'],
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
