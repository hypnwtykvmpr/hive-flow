import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginBuilder, PluginRegistry } from '@hive-flow/cli/plugin-sdk';

const tempDirs: string[] = [];

describe('CA-1 plugin seam', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('registers a real plugin and resolves its MCP tool from PluginRegistry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hive-flow-plugin-e2e-'));
    tempDirs.push(dir);
    const registry = new PluginRegistry({
      coreVersion: '3.0.0',
      dataDir: dir,
      loadTimeout: 2000,
    });

    const plugin = new PluginBuilder('ca1-e2e-plugin', '1.0.0')
      .withDescription('CA-1 plugin registry e2e')
      .withMCPTools([
        {
          name: 'ca1_plugin_echo',
          description: 'Echoes a CA-1 plugin payload',
          inputSchema: {
            type: 'object',
            properties: {
              value: { type: 'string' },
            },
            required: ['value'],
          },
          handler: async (input) => ({
            content: [{ type: 'text', text: `plugin:${String(input.value)}` }],
          }),
        },
      ])
      .build();

    await registry.register(plugin);
    await registry.initialize();
    try {
      expect(registry.listPlugins()).toEqual([
        expect.objectContaining({ name: 'ca1-e2e-plugin', version: '1.0.0' }),
      ]);
      const tools = registry.getMCPTools();
      expect(tools.map((tool) => tool.name)).toEqual(['ca1_plugin_echo']);
      await expect(tools[0]!.handler({ value: 'real-seam' })).resolves.toEqual({
        content: [{ type: 'text', text: 'plugin:real-seam' }],
      });
      expect(registry.getStats()).toEqual(expect.objectContaining({ total: 1, initialized: 1, mcpTools: 1 }));
    } finally {
      await registry.shutdown();
    }
  });
});
