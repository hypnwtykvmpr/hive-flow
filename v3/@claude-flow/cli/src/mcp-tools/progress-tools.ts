/**
 * V3 Progress MCP Tools
 *
 * Provides MCP tools for checking and syncing V3 implementation progress.
 *
 * @module @claude-flow/cli/mcp-tools/progress
 */

import type { MCPTool, MCPToolResult } from './types.js';
import { V3ProgressService, type V3ProgressMetrics } from '@claude-flow/shared';

// Singleton service instance
let progressService: V3ProgressService | null = null;

function getProgressService(): V3ProgressService {
  if (!progressService) {
    progressService = new V3ProgressService();
  }
  return progressService;
}

/**
 * progress/check - Get current V3 implementation progress
 */
const progressCheck: MCPTool = {
  name: 'progress/check',
  description: 'Get current V3 implementation progress percentage and metrics',
  inputSchema: {
    type: 'object',
    properties: {
      detailed: {
        type: 'boolean',
        description: 'Include detailed breakdown by category',
        default: false,
      },
    },
    required: [],
  },
  handler: async (params: { detailed?: boolean }): Promise<MCPToolResult> => {
    try {
      const service = getProgressService();
      const metrics = await service.calculate();

      if (params.detailed) {
        return {
          success: true,
          data: {
            overall: metrics.overall,
            cli: metrics.cli,
            mcp: metrics.mcp,
            hooks: metrics.hooks,
            packages: metrics.packages,
            ddd: metrics.ddd,
            codebase: metrics.codebase,
            lastUpdated: metrics.lastUpdated,
          },
        };
      }

      return {
        success: true,
        data: {
          progress: metrics.overall,
          summary: `V3 Implementation: ${metrics.overall}% complete`,
          breakdown: {
            cli: `${metrics.cli.progress}%`,
            mcp: `${metrics.mcp.progress}%`,
            hooks: `${metrics.hooks.progress}%`,
            packages: `${metrics.packages.progress}%`,
            ddd: `${metrics.ddd.progress}%`,
          },
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

/**
 * progress/sync - Calculate and persist V3 progress
 */
const progressSync: MCPTool = {
  name: 'progress/sync',
  description: 'Calculate and persist V3 progress metrics to file',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async (): Promise<MCPToolResult> => {
    try {
      const service = getProgressService();
      const metrics = await service.sync();

      return {
        success: true,
        data: {
          progress: metrics.overall,
          message: `Progress synced: ${metrics.overall}%`,
          persisted: true,
          lastUpdated: metrics.lastUpdated,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

/**
 * progress/summary - Get human-readable progress summary
 */
const progressSummary: MCPTool = {
  name: 'progress/summary',
  description: 'Get human-readable V3 implementation progress summary',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async (): Promise<MCPToolResult> => {
    try {
      const service = getProgressService();
      const summary = await service.getSummary();

      return {
        success: true,
        data: {
          summary,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

/**
 * progress/watch - Start watching progress changes
 */
const progressWatch: MCPTool = {
  name: 'progress/watch',
  description: 'Start/stop automatic progress monitoring',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'stop', 'status'],
        description: 'Action to perform',
        default: 'status',
      },
      interval: {
        type: 'number',
        description: 'Update interval in milliseconds (for start)',
        default: 30000,
      },
    },
    required: [],
  },
  handler: async (params: { action?: string; interval?: number }): Promise<MCPToolResult> => {
    try {
      const service = getProgressService();
      const action = params.action || 'status';

      switch (action) {
        case 'start':
          service.startAutoUpdate(params.interval || 30000);
          return {
            success: true,
            data: {
              message: `Auto-update started (interval: ${params.interval || 30000}ms)`,
              watching: true,
            },
          };

        case 'stop':
          service.stopAutoUpdate();
          return {
            success: true,
            data: {
              message: 'Auto-update stopped',
              watching: false,
            },
          };

        case 'status':
          const metrics = service.getLastMetrics();
          return {
            success: true,
            data: {
              hasMetrics: !!metrics,
              lastProgress: metrics?.overall ?? null,
              lastUpdated: metrics?.lastUpdated ?? null,
            },
          };

        default:
          return {
            success: false,
            error: `Unknown action: ${action}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

/**
 * All progress tools
 */
export const progressTools: MCPTool[] = [
  progressCheck,
  progressSync,
  progressSummary,
  progressWatch,
];

export default progressTools;
