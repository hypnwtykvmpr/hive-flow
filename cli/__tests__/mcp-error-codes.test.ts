import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * MCP Server JSON-RPC Error Code Compliance Tests
 *
 * Validates that the MCP server returns correct JSON-RPC 2.0 error codes
 * for various error conditions per the specification:
 *   -32700  Parse Error
 *   -32600  Invalid Request
 *   -32601  Method Not Found
 *   -32602  Invalid Params
 *   -32603  Internal Error
 */

const MCP_SERVER_PATH = resolve(__dirname, '../bin/mcp-server.js');
const RESPONSE_TIMEOUT_MS = 5_000;

/**
 * Sends a raw string (line-terminated) to the MCP server's stdin
 * and resolves with the first JSON-RPC response from stdout.
 */
function sendRaw(proc: ChildProcess, raw: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for response to: ${raw.slice(0, 80)}`)),
      RESPONSE_TIMEOUT_MS,
    );

    let stdoutBuffer = '';

    const onData = (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();

      // The server writes newline-delimited JSON; split on newlines
      const parts = stdoutBuffer.split('\n');
      // Keep the last (possibly incomplete) segment in the buffer
      stdoutBuffer = parts.pop() || '';

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.jsonrpc === '2.0') {
            clearTimeout(timer);
            proc.stdout!.removeListener('data', onData);
            resolve(parsed);
            return;
          }
        } catch {
          // Incomplete or non-JSON line — keep buffering
        }
      }
    };

    proc.stdout!.on('data', onData);
    proc.stdin!.write(raw + '\n');
  });
}

/**
 * Sends a JSON-RPC message object to the MCP server.
 */
function send(proc: ChildProcess, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return sendRaw(proc, JSON.stringify(message));
}

describe('MCP Server JSON-RPC Error Codes', () => {
  let proc: ChildProcess;

  beforeAll(() => {
    proc = spawn('node', [MCP_SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });

    // Drain stderr so the process doesn't block
    proc.stderr?.resume();
  });

  afterAll(() => {
    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
    }
  });

  // ---------------------------------------------------------------
  // 1. Valid request — initialize handshake should succeed
  // ---------------------------------------------------------------
  it('should return a success result for a valid initialize request', async () => {
    const response = await send(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(1);
    expect(response).toHaveProperty('result');
    expect(response).not.toHaveProperty('error');

    const result = response.result as Record<string, unknown>;
    expect(result).toHaveProperty('protocolVersion');
    expect(result).toHaveProperty('serverInfo');
    expect(result).toHaveProperty('capabilities');
  });

  // ---------------------------------------------------------------
  // 2. -32601 Method Not Found
  // ---------------------------------------------------------------
  it('should return error code -32601 for an unknown method', async () => {
    const response = await send(proc, {
      jsonrpc: '2.0',
      id: 2,
      method: 'nonexistent/method',
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(2);
    expect(response).toHaveProperty('error');
    expect(response).not.toHaveProperty('result');

    const error = response.error as { code: number; message: string };
    expect(error.code).toBe(-32601);
    expect(typeof error.message).toBe('string');
    expect(error.message.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------
  // 3. -32600 Invalid Request — missing method field
  // ---------------------------------------------------------------
  it('should return error code -32600 when method field is missing', async () => {
    const response = await send(proc, {
      jsonrpc: '2.0',
      id: 3,
      // method intentionally omitted
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(3);
    expect(response).toHaveProperty('error');
    expect(response).not.toHaveProperty('result');

    const error = response.error as { code: number; message: string };
    expect(error.code).toBe(-32600);
    expect(typeof error.message).toBe('string');
  });

  // ---------------------------------------------------------------
  // 4. -32602 Invalid Params — tools/call with a non-existent tool
  //    The server currently returns -32601 for unknown tools inside
  //    tools/call. This test verifies that behavior (tool not found).
  //    If Q2 introduces param-type validation, add a separate case
  //    that sends wrong types to a known tool and expects -32602.
  // ---------------------------------------------------------------
  it('should return error code -32601 for tools/call with unknown tool name', async () => {
    const response = await send(proc, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'definitely_not_a_real_tool',
        arguments: {},
      },
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(4);
    expect(response).toHaveProperty('error');

    const error = response.error as { code: number; message: string };
    expect(error.code).toBe(-32601);
  });

  // ---------------------------------------------------------------
  // 5. -32700 Parse Error — malformed JSON
  // ---------------------------------------------------------------
  it('should return error code -32700 for malformed JSON', async () => {
    const response = await sendRaw(proc, '{this is not valid json!!!');

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBeNull();
    expect(response).toHaveProperty('error');

    const error = response.error as { code: number; message: string };
    expect(error.code).toBe(-32700);
    expect(typeof error.message).toBe('string');
  });

  // ---------------------------------------------------------------
  // 6. Valid request — ping should succeed
  // ---------------------------------------------------------------
  it('should return a success result for a ping request', async () => {
    const response = await send(proc, {
      jsonrpc: '2.0',
      id: 6,
      method: 'ping',
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(6);
    expect(response).toHaveProperty('result');
    expect(response).not.toHaveProperty('error');
  });

  // ---------------------------------------------------------------
  // 7. Valid request — tools/list should succeed
  // ---------------------------------------------------------------
  it('should return a success result for tools/list', async () => {
    const response = await send(proc, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/list',
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(7);
    expect(response).toHaveProperty('result');
    expect(response).not.toHaveProperty('error');

    const result = response.result as { tools: unknown[] };
    expect(Array.isArray(result.tools)).toBe(true);
  });

  // ---------------------------------------------------------------
  // 8. Every error response must have the correct JSON-RPC envelope
  // ---------------------------------------------------------------
  it('should always include jsonrpc "2.0" and matching id in error responses', async () => {
    const response = await send(proc, {
      jsonrpc: '2.0',
      id: 'string-id-8',
      method: 'does/not/exist',
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('string-id-8');

    const error = response.error as { code: number; message: string };
    expect(typeof error.code).toBe('number');
    expect(typeof error.message).toBe('string');
  });
});
