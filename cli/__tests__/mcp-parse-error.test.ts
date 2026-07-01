/**
 * MCP Server JSON-RPC Parse Error Tests
 *
 * Verifies that the MCP server returns proper -32700 parse error responses
 * when receiving malformed JSON over stdin, per JSON-RPC 2.0 spec.
 *
 * Spawns the MCP server as a child process and communicates via stdio.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const MCP_SERVER_PATH = join(__dirname, '..', 'bin', 'mcp-server.js');

/**
 * Helper: spawn the MCP server and collect stdout lines.
 * Returns helpers to send messages and read responses.
 */
function createMcpProcess(): {
  proc: ChildProcess;
  send: (line: string) => void;
  readLine: (timeoutMs?: number) => Promise<string>;
  readResponse: (timeoutMs?: number) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
} {
  const proc = spawn('node', [MCP_SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test' },
  });

  const stdoutLines: string[] = [];
  let lineResolvers: Array<(line: string) => void> = [];
  let stdoutBuffer = '';

  proc.stdout!.setEncoding('utf8');
  proc.stdout!.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    const parts = stdoutBuffer.split('\n');
    stdoutBuffer = parts.pop() || '';
    for (const line of parts) {
      if (line.trim()) {
        if (lineResolvers.length > 0) {
          const resolver = lineResolvers.shift()!;
          resolver(line);
        } else {
          stdoutLines.push(line);
        }
      }
    }
  });

  function send(line: string): void {
    proc.stdin!.write(line + '\n');
  }

  function readLine(timeoutMs = 5000): Promise<string> {
    // Check buffered lines first
    if (stdoutLines.length > 0) {
      return Promise.resolve(stdoutLines.shift()!);
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = lineResolvers.indexOf(resolver);
        if (idx >= 0) lineResolvers.splice(idx, 1);
        reject(new Error(`Timed out waiting for stdout line after ${timeoutMs}ms`));
      }, timeoutMs);

      const resolver = (line: string) => {
        clearTimeout(timer);
        resolve(line);
      };
      lineResolvers.push(resolver);
    });
  }

  async function readResponse(timeoutMs = 5000): Promise<Record<string, unknown>> {
    const line = await readLine(timeoutMs);
    return JSON.parse(line);
  }

  async function close(): Promise<void> {
    return new Promise<void>((resolve) => {
      proc.on('close', () => resolve());
      proc.stdin!.end();
      // Force kill after 3s if it hasn't exited
      const killTimer = setTimeout(() => {
        proc.kill('SIGKILL');
      }, 3000);
      proc.on('close', () => clearTimeout(killTimer));
    });
  }

  return { proc, send, readLine, readResponse, close };
}

describe('MCP Server Parse Error Handling', () => {
  let mcp: ReturnType<typeof createMcpProcess>;

  beforeEach(() => {
    mcp = createMcpProcess();
  });

  afterEach(async () => {
    await mcp.close();
  });

  it('should return -32700 for malformed JSON', async () => {
    mcp.send('this is not valid json{{{');

    const response = await mcp.readResponse();

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error',
      },
    });
  });

  it('should return a valid response for well-formed JSON-RPC (initialize)', async () => {
    mcp.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    }));

    const response = await mcp.readResponse();

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();
    const result = response.result as Record<string, unknown>;
    expect(result.protocolVersion).toBeDefined();
    expect(result.serverInfo).toBeDefined();
  });

  it('should ignore empty lines (no response)', async () => {
    // Send an empty line followed by a valid request.
    // The empty line should produce no output; only the valid request should.
    mcp.send('');  // empty line
    mcp.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 42,
      method: 'ping',
      params: {},
    }));

    const response = await mcp.readResponse();

    // The response should be for the ping, not a parse error from the empty line
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 42,
      result: {},
    });
  });

  it('should return -32700 for truncated/partial JSON', async () => {
    mcp.send('{"jsonrpc":"2.0","id":1,"method":"ini');

    const response = await mcp.readResponse();

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error',
      },
    });
  });

  it('should handle interleaved valid and invalid messages correctly', async () => {
    // Send valid message first
    mcp.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: {},
    }));

    const response1 = await mcp.readResponse();
    expect(response1).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {},
    });

    // Send malformed message
    mcp.send('not json at all');

    const response2 = await mcp.readResponse();
    expect(response2).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error',
      },
    });

    // Send another valid message to confirm server still works
    mcp.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'ping',
      params: {},
    }));

    const response3 = await mcp.readResponse();
    expect(response3).toMatchObject({
      jsonrpc: '2.0',
      id: 3,
      result: {},
    });
  });
});
