#!/usr/bin/env node
/**
 * @hive-flow/cli - MCP Server Entry Point
 *
 * Direct stdio MCP server for Claude Code integration.
 * This entry point handles stdin/stdout directly for MCP protocol
 * without any CLI formatting output that would corrupt the protocol.
 *
 * Includes pre-flight npx cache repair to prevent ENOTEMPTY errors
 * in remote/CI environments (known npm 10.x bug).
 */

// Pre-flight: repair stale npx cache to prevent ENOTEMPTY on next run
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

try {
  const npxRoot = join(homedir(), '.npm', '_npx');
  if (existsSync(npxRoot)) {
    for (const dir of readdirSync(npxRoot)) {
      const nm = join(npxRoot, dir, 'node_modules');
      if (!existsSync(nm)) continue;
      try {
        for (const entry of readdirSync(nm)) {
          if (entry.startsWith('.') && entry.includes('-') && /[A-Za-z]{8}$/.test(entry)) {
            try {
              const p = join(nm, entry);
              if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
            } catch {}
          }
        }
      } catch {}
    }
  }
} catch {}

import { randomUUID } from 'crypto';
import { listMCPTools, callMCPTool, hasTool } from '../dist/src/mcp-client.js';
import { bootstrapProductionCredentialHolder } from '../dist/src/credential-store/holder-runtime.js';

/**
 * JSON-RPC error codes (MCP / JSON-RPC 2.0 spec)
 * Mirrors @hive-flow/mcp ErrorCodes — kept local to avoid cross-package import.
 */
const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

const VERSION = '3.0.0';
const sessionId = `mcp-${Date.now()}-${randomUUID().slice(0, 8)}`;

// Log to stderr (doesn't corrupt stdout for MCP protocol)
console.error(
  `[${new Date().toISOString()}] INFO [hive-flow-mcp] (${sessionId}) Starting in stdio mode`
);
console.error(JSON.stringify({
  arch: process.arch,
  mode: 'mcp-stdio',
  nodeVersion: process.version,
  pid: process.pid,
  platform: process.platform,
  protocol: 'stdio',
  sessionId,
  version: VERSION,
}));

let credentialHolderRuntime = null;

async function bootstrapCredentialHolder() {
  try {
    credentialHolderRuntime = await bootstrapProductionCredentialHolder({
      projectRoot: process.cwd(),
    });
    console.error(JSON.stringify({
      event: 'credential-holder-started',
      seededProviders: credentialHolderRuntime.seededProviders,
      socketPath: credentialHolderRuntime.socketPath,
    }));
  } catch (error) {
    const message = `Credential holder bootstrap skipped: ${error instanceof Error ? error.message : String(error)}`;
    if (process.env.HIVE_FLOW_CREDENTIAL_HOLDER_REQUIRED === '1') {
      console.error(`[${new Date().toISOString()}] ERROR [hive-flow-mcp] ${message}`);
      process.exit(1);
    }
    console.error(`[${new Date().toISOString()}] WARN [hive-flow-mcp] ${message}`);
  }
}

async function shutdown(signal) {
  console.error(`[${new Date().toISOString()}] INFO [hive-flow-mcp] ${signal}, shutting down...`);
  if (credentialHolderRuntime) {
    try {
      await credentialHolderRuntime.stop();
    } catch (error) {
      console.error(`[${new Date().toISOString()}] WARN [hive-flow-mcp] credential holder stop failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  process.exit(0);
}

await bootstrapCredentialHolder();

// Handle stdin messages
let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;

  // Process complete JSON messages (newline-delimited)
  let lines = buffer.split('\n');
  buffer = lines.pop() || ''; // Keep incomplete line in buffer

  for (const line of lines) {
    if (line.trim()) {
      try {
        const message = JSON.parse(line);
        const response = await handleMessage(message);
        if (response) {
          console.log(JSON.stringify(response));
        }
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] ERROR [hive-flow-mcp] Failed to parse:`,
          error instanceof Error ? error.message : String(error)
        );
        // Send parse error response
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
  void shutdown(`(${sessionId}) stdin closed`);
});

// Handle process termination
process.on('SIGINT', () => {
  void shutdown('Received SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('Received SIGTERM');
});

/**
 * Handle MCP message
 */
async function handleMessage(message) {
  if (!message.method) {
    return {
      jsonrpc: '2.0',
      id: message.id,
      error: { code: ErrorCodes.INVALID_REQUEST, message: 'Invalid Request: missing method' },
    };
  }

  const params = message.params || {};

  try {
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
        console.error(`[${new Date().toISOString()}] INFO [hive-flow-mcp] Client initialized`);
        return null; // No response for notifications

      case 'ping':
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: {},
        };

      default:
        return {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: ErrorCodes.METHOD_NOT_FOUND, message: `Method not found: ${message.method}` },
        };
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ERROR [hive-flow-mcp] ${message.method}:`, error);
    return {
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: ErrorCodes.INTERNAL_ERROR,
        message: error instanceof Error ? error.message : 'Internal error',
      },
    };
  }
}
