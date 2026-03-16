/**
 * MCP Enforcement Gate — Risk classification and blocking for MCP tools.
 * Called from callMCPTool() in mcp-client.ts to enforce tool restrictions.
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

export enum ToolRisk {
  CRITICAL = 3,
  HIGH = 2,
  MEDIUM = 1,
  LOW = 0,
}

// Risk classification table
const CRITICAL_TOOLS = new Set([
  'agent_spawn', 'agent_task',
  'workflow_enforcer_override',
  'browser_eval',
  'config_import',
  'system_reset',
]);

const HIGH_TOOLS = new Set([
  'agent_update', 'agent_terminate',
  'config_set', 'config_reset',
  'terminal_execute', 'terminal_create',
  'browser_open', 'browser_click', 'browser_fill',
  'swarm_init',
  'hive-mind_init', 'hive-mind_spawn',
  'claims_claim', 'claims_steal',
  'session_delete',
  'memory_delete',
  'workflow_create', 'workflow_execute',
  'daa_agent_create', 'daa_workflow_execute',
  // 12.8: filesystem tools that can write to protected paths
  'filesystem__write_file', 'filesystem__edit_file', 'filesystem__move_file',
]);

const MEDIUM_TOOLS = new Set([
  'memory_store', 'memory_migrate',
]);

// Everything else is LOW risk

export interface EnforcementResult {
  allowed: boolean;
  risk: ToolRisk;
  reason?: string;
}

export function classifyTool(toolName: string): ToolRisk {
  // Strip mcp__hive-flow__ or mcp__filesystem__ prefix
  const shortName = toolName
    .replace(/^mcp__hive-flow__/, '')
    .replace(/^mcp__filesystem__/, 'filesystem__')
    .replace(/^mcp__playwright__browser_/, 'browser_');

  if (CRITICAL_TOOLS.has(shortName)) return ToolRisk.CRITICAL;
  if (HIGH_TOOLS.has(shortName)) return ToolRisk.HIGH;
  if (MEDIUM_TOOLS.has(shortName)) return ToolRisk.MEDIUM;
  return ToolRisk.LOW;
}

function resolveProjectDir(): string {
  // Priority 1: explicit env var (safe for MCP servers)
  if (process.env.CLAUDE_PROJECT_DIR) {
    return process.env.CLAUDE_PROJECT_DIR;
  }

  // Priority 2: ESM-compatible import.meta.url (if available)
  try {
    // import.meta.url is available in ESM; accessing it in CJS throws
    const metaUrl = (import.meta as { url?: string })?.url;
    if (metaUrl) {
      const { fileURLToPath } = require('url');
      const { dirname } = require('path');
      const thisDir = dirname(fileURLToPath(metaUrl));
      return resolve(thisDir, '..', '..', '..', '..');
    }
  } catch {
    // Not in ESM context — fall through to CJS
  }

  // Priority 3: CJS __dirname traversal (works in compiled .ts → .js)
  return resolve(__dirname, '..', '..', '..', '..');
}

export function getEnforcementLevel(): number {
  try {
    const projectDir = resolveProjectDir();
    const stateFile = join(projectDir, '.hive-flow', 'enforcement', 'state.json');
    if (!existsSync(stateFile)) return 0;

    const raw = JSON.parse(readFileSync(stateFile, 'utf8'));
    // Support both HMAC envelope and legacy format
    const state = raw?.state || raw;
    return typeof state?.level === 'number' ? state.level : 0;
  } catch {
    return 0;
  }
}

/**
 * Check if an MCP tool is allowed at the current enforcement level.
 *
 * Enforcement logic by level:
 *   NORMAL (0)     — All allowed. CRITICAL tools produce audit log entry.
 *   WARNED (1)     — CRITICAL blocked. HIGH allowed with audit.
 *   RESTRICTED (2) — CRITICAL + HIGH blocked. MEDIUM allowed with audit.
 *   HALTED (3)     — All non-LOW blocked.
 */
export function checkMCPEnforcement(toolName: string): EnforcementResult {
  const risk = classifyTool(toolName);
  const level = getEnforcementLevel();

  if (level === 0) {
    return { allowed: true, risk };
  }

  if (level >= 1 && risk >= ToolRisk.CRITICAL) {
    return {
      allowed: false,
      risk,
      reason: `[MCP ENFORCEMENT] Tool '${toolName}' (CRITICAL risk) blocked at enforcement level ${level}.`,
    };
  }

  if (level >= 2 && risk >= ToolRisk.HIGH) {
    return {
      allowed: false,
      risk,
      reason: `[MCP ENFORCEMENT] Tool '${toolName}' (HIGH risk) blocked at enforcement level ${level}.`,
    };
  }

  if (level >= 3 && risk >= ToolRisk.MEDIUM) {
    return {
      allowed: false,
      risk,
      reason: `[MCP ENFORCEMENT] Tool '${toolName}' (MEDIUM risk) blocked at enforcement level ${level}.`,
    };
  }

  return { allowed: true, risk };
}
