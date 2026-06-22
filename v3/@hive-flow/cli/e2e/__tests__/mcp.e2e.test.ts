import { describe, expect, it } from 'vitest';
import { createMCPServer, type ILogger, type MCPRequest, type MCPResponse } from '../../src/mcp/index.js';
import { compactTextResponse, readJsonFixture, stableJson } from './helpers.js';

interface RequestHarness {
  handleRequest(request: MCPRequest): Promise<MCPResponse>;
}

const logger: ILogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('CA-1 MCP seam', () => {
  it('lists and calls a registered tool through the real JSON-RPC router', async () => {
    const observed = new Map<string, string>();
    const server = createMCPServer(
      { name: 'ca1-e2e', version: '0.0.0', transport: 'in-process' },
      logger
    );

    expect(server.registerTool({
      name: 'ca1_memory_store',
      description: 'Store one CA-1 memory value',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['key', 'value'],
        additionalProperties: false,
      },
      handler: async (input) => {
        const args = input as { key: string; value: string };
        observed.set(args.key, args.value);
        return { ok: true, key: args.key, storedValue: args.value };
      },
      category: 'memory',
      tags: ['ca1', 'e2e'],
    })).toBe(true);

    // The public server seam exposes request routing through transports. The
    // in-process transport is intentionally no-op, so this adapter drives the
    // same router that transports use after registerTool has populated it.
    const rpc = (server as unknown as RequestHarness).handleRequest.bind(server);

    const initialize = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: { major: 2025, minor: 11, patch: 25 },
        capabilities: {},
        clientInfo: { name: 'ca1-e2e', version: '0.0.0' },
      },
    });
    const toolsList = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const toolCall = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'ca1_memory_store',
        arguments: { key: 'ca1-wire', value: 'golden-wire' },
      },
    });

    expect(observed.get('ca1-wire')).toBe('golden-wire');
    expect(stableJson(initialize)).toEqual(await readJsonFixture('mcp-wire/initialize-response.json'));
    expect(stableJson(toWireFixture(toolsList))).toEqual(await readJsonFixture('mcp-wire/tools-list-response.json'));
    expect(stableJson(compactTextResponse(toolCall))).toEqual(await readJsonFixture('mcp-wire/tool-call-response.json'));
  });
});

function toWireFixture(response: MCPResponse): MCPResponse {
  const tools = ((response.result as { tools?: Array<Record<string, unknown>> })?.tools ?? [])
    .filter((tool) => tool.name === 'ca1_memory_store');
  return {
    ...response,
    result: { tools },
  };
}
