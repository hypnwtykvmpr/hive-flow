/**
 * Risk Classifier — Categorizes commands by risk level.
 * Determines timeout behavior: low risk auto-allows, high risk auto-denies.
 */

import type { RiskLevel, RiskClassification } from './types.js';

// ---------------------------------------------------------------------------
// Risk rules (ordered critical-first for priority matching)
// ---------------------------------------------------------------------------

const RISK_RULES: Array<{ level: RiskLevel; category: string; patterns: RegExp[] }> = [
  { level: 'critical', category: 'system-destruction', patterns: [
    /\bsudo\s+rm\b/, /\bsudo\s+dd\b/, /\bsudo\s+mkfs\b/,
    /\bdd\s+if=.*of=\/dev\//, /\bmkfs\b/, /\bshred\b/,
    /\b(?:reboot|shutdown|poweroff|halt)\b/,
    /\bsystemctl\s+(stop|disable|mask)\b/,
    /:\(\)\s*\{/, // fork bomb
  ]},
  { level: 'high', category: 'destructive-operations', patterns: [
    /\brm\s+.*-[a-zA-Z]*r/, /\brm\s+-rf\b/, /\brm\s+-fr\b/,
    /\bchmod\s+(777|666|a\+[rwx])\b/, /\bchmod\s+-R\b/,
    /\bchown\s+-R\b/,
    /\bgit\s+push\s+.*--force/, /\bgit\s+push\s+-f\b/,
    /\bgit\s+reset\s+--hard/,
    /\bcurl\s.*\|\s*(?:bash|sh)\b/, /\bwget\s.*\|\s*(?:bash|sh)\b/,
    /\bdocker\s+rm\b/, /\bdocker\s+rmi\b/,
    /\bkill\s+-9\b/, /\bkillall\b/, /\bpkill\b/,
  ]},
  { level: 'medium', category: 'state-changing', patterns: [
    /\bnpm\s+install\b/, /\bnpm\s+i\b/, /\byarn\s+add\b/, /\bpnpm\s+add\b/,
    /\bgit\s+commit\b/, /\bgit\s+push\b/, /\bgit\s+merge\b/, /\bgit\s+rebase\b/,
    /\bgit\s+checkout\b/, /\bgit\s+switch\b/, /\bgit\s+stash\b/,
    /\bmkdir\b/, /\btouch\b/, /\bmv\b/, /\bcp\b/,
    /\bdocker\s+(build|run|compose)\b/,
    /\bnpm\s+run\s+(?!lint|test|build|check|format|typecheck)\w/,
  ]},
  { level: 'low', category: 'read-only', patterns: [
    /^ls\b/, /^cat\b/, /^head\b/, /^tail\b/, /^echo\b/, /^printf\b/,
    /^pwd$/, /^whoami$/, /^date$/, /^env$/,
    /^git\s+(status|log|diff|branch|show|remote|tag|describe|rev-parse|ls-files)\b/,
    /^npm\s+(list|ls|view|info|outdated|audit|pack)\b/,
    /^npm\s+run\s+(lint|test|build|check|format|typecheck)\b/,
    /^npx\s/, /^node\s+--version/, /^node\s+-[pe]\s/,
    /^tsc\b/, /^eslint\b/, /^prettier\b/, /^jest\b/, /^vitest\b/,
    /^cargo\s+(build|test|check|clippy|fmt|doc)\b/,
    /^go\s+(build|test|vet|fmt|mod)\b/,
    /^make\b/, /^grep\b/, /^rg\b/, /^find\b/,
    /^sort\b/, /^uniq\b/, /^cut\b/, /^tr\b/, /^wc\b/,
    /^diff\b/, /^stat\b/, /^file\b/, /^which\b/, /^type\b/,
    /^uname\b/, /^df\b/, /^du\b/, /^free\b/,
  ]},
];

// ---------------------------------------------------------------------------
// Tool-level risk
// ---------------------------------------------------------------------------

const TOOL_RISK: Record<string, RiskLevel> = {
  Read: 'none', Glob: 'none', Grep: 'none', LS: 'none',
  WebSearch: 'none', TodoRead: 'none', TaskList: 'none',
  TaskGet: 'none', NotebookRead: 'none',
  Write: 'medium', Edit: 'medium', MultiEdit: 'medium',
  WebFetch: 'low', NotebookEdit: 'medium',
};

const SENSITIVE_PATHS = ['/etc/', '/.ssh/', '/.aws/', '/.gnupg/', '/usr/', '/System/', '/var/'];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getTimeoutBehavior(level: RiskLevel): 'allow' | 'deny' {
  return level === 'none' || level === 'low' ? 'allow' : 'deny';
}

export function classifyCommand(command: string): RiskClassification {
  const cmd = command.trim();
  if (!cmd) return { level: 'none', category: 'empty', timeoutBehavior: 'allow' };

  for (const rule of RISK_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(cmd)) {
        return { level: rule.level, category: rule.category, timeoutBehavior: getTimeoutBehavior(rule.level) };
      }
    }
  }

  return { level: 'medium', category: 'unknown', timeoutBehavior: 'deny' };
}

export function classifyTool(toolName: string, toolInput?: Record<string, unknown>): RiskClassification {
  const baseLevel = TOOL_RISK[toolName] || 'medium';

  // Bump Write/Edit risk if targeting sensitive paths
  if ((toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') && toolInput) {
    const filePath = String(toolInput.file_path || toolInput.filePath || '');
    if (SENSITIVE_PATHS.some(p => filePath.includes(p))) {
      return { level: 'high', category: 'sensitive-path-write', timeoutBehavior: 'deny' };
    }
  }

  return { level: baseLevel, category: toolName, timeoutBehavior: getTimeoutBehavior(baseLevel) };
}

export function isNeverAutoAllow(command: string): boolean {
  const classification = classifyCommand(command);
  return classification.level === 'critical';
}
