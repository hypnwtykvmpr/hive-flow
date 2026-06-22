#!/usr/bin/env node
/**
 * @hive-flow/cli - CLI Entry Point
 *
 * Hive Flow V3 Command Line Interface
 *
 * Auto-detects MCP mode when stdin is piped and no args provided.
 * This allows: echo '{"jsonrpc":"2.0",...}' | hive-flow
 *
 * Includes pre-flight npx cache repair to prevent ENOTEMPTY errors
 * in remote/CI environments (known npm 10.x bug).
 */

import { repairCacheIntegrity, repairNpxCache } from './npx-repair.js';

try {
  repairNpxCache();
  repairCacheIntegrity();
} catch {}

import { randomUUID } from 'crypto';

const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

// Check if we should run in MCP server mode
// Conditions:
//   1. stdin is being piped AND no CLI arguments provided (auto-detect)
//   2. stdin is being piped AND args are "mcp start" (explicit, e.g. hive-flow mcp start)
const cliArgs = process.argv.slice(2);
const isExplicitMCP = cliArgs.length >= 1 && cliArgs[0] === 'mcp' && (cliArgs.length === 1 || cliArgs[1] === 'start');
const isMCPMode = !process.stdin.isTTY && (process.argv.length === 2 || isExplicitMCP);

if (isMCPMode) {
  // Run MCP server mode
  const { listMCPTools, callMCPTool, hasTool } = await import('../dist/src/mcp-client.js');
  const { loadHive, listHives } = await import('../dist/src/mcp-tools/hive-store.js');

  const VERSION = '3.0.0';
  const sessionId = `mcp-${Date.now()}-${randomUUID().slice(0, 8)}`;

  // --- Hive completion polling ---
  const HIVE_POLL_INTERVAL = 5000;
  const TERMINAL_STATUSES = new Set(['completed', 'failed', 'terminated']);
  const monitoredHiveIds = new Set();
  const notifiedTerminalHives = new Set();
  let pollingInterval = null;

  const sendHiveNotification = (hive) => {
    if (notifiedTerminalHives.has(hive.hiveId)) {
      console.error(`[${new Date().toISOString()}] DEBUG [hive-flow-mcp] (${sessionId}) Suppressing duplicate notification for ${hive.hiveId}`);
      return;
    }
    notifiedTerminalHives.add(hive.hiveId);
    console.error(`[${new Date().toISOString()}] INFO [hive-flow-mcp] (${sessionId}) Emitting notification to stdout for hive ${hive.hiveId} status=${hive.status}`);
    console.log(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: {
        level: 'info',
        data: {
          type: 'hive_status_update',
          hiveId: hive.hiveId,
          queenId: hive.queenId,
          status: hive.status,
          completedAt: hive.completedAt,
        },
      },
    }));
    console.error(`[${new Date().toISOString()}] INFO [hive-flow-mcp] (${sessionId}) Hive ${hive.hiveId} → ${hive.status}`);
  };

  const pollHiveStatus = async (hiveId) => {
    try {
      console.error(`[${new Date().toISOString()}] DEBUG [hive-flow-mcp] (${sessionId}) Polling hive ${hiveId}`);
      let hive = loadHive(hiveId);
      if (!hive) { console.error(`[${new Date().toISOString()}] DEBUG [hive-flow-mcp] (${sessionId}) loadHive(${hiveId}) returned null, removing from monitor`); monitoredHiveIds.delete(hiveId); return; }
      if (TERMINAL_STATUSES.has(hive.status)) {
        sendHiveNotification(hive);
        monitoredHiveIds.delete(hiveId);
        return;
      }
      try {
        const pollResult = await callMCPTool('hive_poll_workers', { hiveId }, { sessionId });
        if (pollResult && (pollResult.allWorkersSettled || pollResult.allComplete)) {
          const freshHive = loadHive(hiveId);
          if (freshHive && TERMINAL_STATUSES.has(freshHive.status)) {
            console.error(`[${new Date().toISOString()}] INFO [hive-flow-mcp] (${sessionId}) Hive ${hiveId} completed — detected by internal poll`);
            sendHiveNotification(freshHive);
            monitoredHiveIds.delete(hiveId);
          } else {
            console.error(`[${new Date().toISOString()}] DEBUG [hive-flow-mcp] (${sessionId}) Hive ${hiveId} allComplete=true but freshHive.status=${freshHive?.status ?? 'null'} — not yet terminal`);
          }
        } else {
          console.error(`[${new Date().toISOString()}] DEBUG [hive-flow-mcp] (${sessionId}) Hive ${hiveId} not settled: allComplete=${pollResult?.allComplete} allWorkersSettled=${pollResult?.allWorkersSettled} runningCount=${pollResult?.runningCount}`);
        }
      } catch (pollErr) {
        console.error(`[${new Date().toISOString()}] WARN [hive-flow-mcp] Internal poll failed for ${hiveId}:`, pollErr?.message || pollErr);
      }
    } catch (e) {
      console.error(`[${new Date().toISOString()}] WARN [hive-flow-mcp] pollHiveStatus error for ${hiveId}:`, e?.message || e);
    }
  };

  const startHivePolling = () => {
    if (pollingInterval) return;
    pollingInterval = setInterval(async () => {
      const ids = Array.from(monitoredHiveIds);
      console.error(`[${new Date().toISOString()}] DEBUG [hive-flow-mcp] (${sessionId}) Poll tick — ${ids.length} hive(s) monitored`);
      if (ids.length === 0) return;
      await Promise.allSettled(ids.map(id => pollHiveStatus(id)));
    }, HIVE_POLL_INTERVAL);
    pollingInterval.unref();
    console.error(`[${new Date().toISOString()}] INFO [hive-flow-mcp] (${sessionId}) Hive polling started (${monitoredHiveIds.size} hive(s))`);
  };

  const registerHiveForMonitoring = (hiveId) => {
    if (monitoredHiveIds.has(hiveId) || notifiedTerminalHives.has(hiveId)) return;
    monitoredHiveIds.add(hiveId);
    console.error(`[${new Date().toISOString()}] INFO [hive-flow-mcp] (${sessionId}) Registered hive ${hiveId} for monitoring`);
    startHivePolling();
    void pollHiveStatus(hiveId);
  };

  // Bootstrap: monitor any already-active hives
  try {
    const activeHives = listHives('active');
    for (const h of activeHives) {
      if (!TERMINAL_STATUSES.has(h.status)) monitoredHiveIds.add(h.hiveId);
    }
    if (monitoredHiveIds.size > 0) startHivePolling();
  } catch (e) {
    console.error(`[${new Date().toISOString()}] WARN [hive-flow-mcp] Failed to bootstrap hive monitoring:`, e?.message || e);
  }

  console.error(
    `[${new Date().toISOString()}] INFO [hive-flow-mcp] (${sessionId}) Starting in stdio mode`
  );

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    let lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          const response = await handleMessage(message);
          if (response) {
            console.log(JSON.stringify(response));
          }
        } catch (error) {
          console.log(JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: ErrorCodes.PARSE_ERROR, message: 'Parse error' },
          }));
        }
      }
    }
  });

  process.stdin.on('end', () => {
    process.exit(0);
  });

  async function handleMessage(message) {
    if (!message.method) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: ErrorCodes.INVALID_REQUEST, message: 'Invalid Request: missing method' },
      };
    }

    const params = message.params || {};

    switch (message.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'hive-flow', version: VERSION },
            capabilities: {
              tools: { listChanged: true },
              resources: { subscribe: true, listChanged: true },
            },
          },
        };

      case 'tools/list': {
        const tools = listMCPTools();
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: tools.map(tool => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          },
        };
      }

      case 'tools/call': {
        const toolName = params.name;
        const toolParams = params.arguments || {};

        if (!hasTool(toolName)) {
          return {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: ErrorCodes.METHOD_NOT_FOUND, message: `Tool not found: ${toolName}` },
          };
        }

        try {
          const result = await callMCPTool(toolName, toolParams, { sessionId });
          // Auto-register hive for monitoring after queen_mission_assign
          if (toolName === 'queen_mission_assign' && result?.success && typeof result.hiveId === 'string') {
            console.error(`[${new Date().toISOString()}] INFO [hive-flow-mcp] (${sessionId}) queen_mission_assign returned hiveId=${result.hiveId}, registering for monitoring`);
            try { registerHiveForMonitoring(result.hiveId); } catch { /* ignore */ }
          }
          return {
            jsonrpc: '2.0',
            id: message.id,
            result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
          };
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: ErrorCodes.INTERNAL_ERROR,
              message: error instanceof Error ? error.message : 'Tool execution failed',
            },
          };
        }
      }

      case 'notifications/initialized':
        return null;

      case 'ping':
        return { jsonrpc: '2.0', id: message.id, result: {} };

      default:
        return {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: ErrorCodes.METHOD_NOT_FOUND, message: `Method not found: ${message.method}` },
        };
    }
  }
} else {
  // Run normal CLI mode
  const { CLI } = await import('../dist/src/index.js');
  const cli = new CLI();
  try {
    await cli.run();
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
  process.exit(0);
}
