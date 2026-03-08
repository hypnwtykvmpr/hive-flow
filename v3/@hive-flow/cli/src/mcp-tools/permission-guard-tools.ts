/**
 * Permission Guard MCP Tools
 *
 * MCP tool definitions for the Permission Guard system.
 * Provides status, history, override, config, and learned pattern tools.
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { MCPTool } from './types.js';
import type {
  EscalationContext,
  VerdictFile,
  AuditLogEntry,
  LearnedPattern,
} from '../permission-guard/types.js';

const HOME = homedir();
const CONFIG_DIR = join(HOME, '.hive-flow', 'permission-guard');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const CONTEXT_DIR = join(HOME, '.claude', 'hooks', 'escalation_context');
const ESCALATION_FILE = join(CONTEXT_DIR, 'latest.json');
const VERDICT_FILE = join(CONTEXT_DIR, 'last_verdict.json');
const LOG_FILE = join(HOME, '.claude', 'hooks', 'permission_log.jsonl');

function readJsonSafe<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export const permissionGuardTools: MCPTool[] = [
  {
    name: 'permission_guard_status',
    description: 'Show current permission guard status, pending escalations, and jury state',
    category: 'permission-guard',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const escalation = readJsonSafe<EscalationContext>(ESCALATION_FILE);
      const verdict = readJsonSafe<VerdictFile>(VERDICT_FILE);
      const configExists = existsSync(CONFIG_PATH);

      // Read vote files
      const voteNames = ['vote_goal_relevance', 'vote_safety', 'vote_convention'];
      const votes: Record<string, unknown> = {};
      for (const name of voteNames) {
        const votePath = join(CONTEXT_DIR, `${name}.json`);
        votes[name] = readJsonSafe(votePath);
      }

      // Count log entries
      let logEntryCount = 0;
      try {
        if (existsSync(LOG_FILE)) {
          const logContent = readFileSync(LOG_FILE, 'utf-8');
          logEntryCount = logContent.trim().split('\n').filter(l => l.trim()).length;
        }
      } catch { /* ignore */ }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'active',
            configPath: CONFIG_PATH,
            configLoaded: configExists,
            escalation: escalation ? {
              ts: escalation.ts,
              escalation_id: escalation.escalation_id,
              status: escalation.status,
              tool_name: escalation.tool_name,
              gate_reason: escalation.gate_reason,
            } : null,
            lastVerdict: verdict ? {
              ts: verdict.ts,
              verdict: verdict.verdict,
              consumed: verdict.consumed,
            } : null,
            votes,
            auditLogEntries: logEntryCount,
          }, null, 2),
        }],
      };
    },
  },
  {
    name: 'permission_guard_history',
    description: 'Show recent permission decisions from the audit log',
    category: 'permission-guard',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum entries to return (default: 20)' },
        filter: { type: 'string', description: 'Filter by decision type: allow, deny, escalate' },
      },
    },
    handler: async (params) => {
      const limit = (params.limit as number) || 20;
      const filter = params.filter as string | undefined;

      let entries: AuditLogEntry[] = [];
      try {
        if (existsSync(LOG_FILE)) {
          const lines = readFileSync(LOG_FILE, 'utf-8')
            .trim()
            .split('\n')
            .filter(l => l.trim());

          entries = lines.map(line => {
            try { return JSON.parse(line); } catch { return null; }
          }).filter((e): e is AuditLogEntry => e !== null);

          if (filter) {
            entries = entries.filter(e => e.decision === filter);
          }

          // Return most recent first
          entries = entries.reverse().slice(0, limit);
        }
      } catch { /* ignore */ }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            entries,
            total: entries.length,
            limit,
            filter: filter || 'all',
            logFile: LOG_FILE,
          }, null, 2),
        }],
      };
    },
  },
  {
    name: 'permission_guard_override',
    description: 'Manual override for a pending jury decision',
    category: 'permission-guard',
    inputSchema: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          description: 'Override decision: allow or deny',
        },
        reason: {
          type: 'string',
          description: 'Reason for the override',
        },
      },
      required: ['decision'],
    },
    handler: async (params) => {
      const decision = params.decision as string;
      if (decision !== 'allow' && decision !== 'deny') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'Decision must be "allow" or "deny"' }),
          }],
          isError: true,
        };
      }

      const overridePath = join(CONTEXT_DIR, 'user_override.json');
      mkdirSync(CONTEXT_DIR, { recursive: true });

      const override = {
        ts: new Date().toISOString(),
        decision,
        reason: (params.reason as string) || 'Manual MCP override',
      };

      const { writeFileSync } = await import('node:fs');
      writeFileSync(overridePath, JSON.stringify(override, null, 2), 'utf-8');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            overridden: true,
            decision,
            reason: override.reason,
            ts: override.ts,
            path: overridePath,
          }, null, 2),
        }],
      };
    },
  },
  {
    name: 'permission_guard_config',
    description: 'View or update permission guard configuration',
    category: 'permission-guard',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: view or update',
        },
        updates: {
          type: 'object',
          description: 'Configuration updates (only for action=update)',
        },
      },
    },
    handler: async (params) => {
      const action = (params.action as string) || 'view';

      if (action === 'view') {
        const config = readJsonSafe(CONFIG_PATH);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              configPath: CONFIG_PATH,
              exists: config !== null,
              config: config || 'No config file found. Using defaults.',
            }, null, 2),
          }],
        };
      }

      if (action === 'update') {
        const updates = params.updates as Record<string, unknown> | undefined;
        if (!updates || Object.keys(updates).length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'No updates provided' }),
            }],
            isError: true,
          };
        }

        mkdirSync(CONFIG_DIR, { recursive: true });
        let config = readJsonSafe<Record<string, unknown>>(CONFIG_PATH) || {};
        config = { ...config, ...updates };

        const { writeFileSync } = await import('node:fs');
        writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');

        // Reset cache so next evaluate() picks up changes
        try {
          const { resetConfigCache } = await import('../permission-guard/gate.js');
          resetConfigCache();
        } catch { /* ignore */ }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              updated: true,
              configPath: CONFIG_PATH,
              appliedUpdates: Object.keys(updates),
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: `Unknown action: ${action}. Use "view" or "update".` }),
        }],
        isError: true,
      };
    },
  },
  {
    name: 'permission_guard_learned',
    description: 'View learned patterns from adaptive voting',
    category: 'permission-guard',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum patterns to return (default: 20)' },
      },
    },
    handler: async (params) => {
      const limit = (params.limit as number) || 20;

      let patterns: LearnedPattern[] = [];
      try {
        const { getLearnedPatterns } = await import('../permission-guard/vote-learner.js');
        patterns = getLearnedPatterns(limit);
      } catch { /* ignore */ }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            patterns,
            total: patterns.length,
            limit,
            approvalThreshold: 5,
            expiryDays: 30,
          }, null, 2),
        }],
      };
    },
  },
];
