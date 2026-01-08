/**
 * Transfer MCP Tools
 * Pattern and plugin sharing via IPFS-based decentralized registry
 *
 * @module @claude-flow/cli/mcp-tools/transfer-tools
 * @version 3.0.0
 */

import type { MCPTool, MCPToolResult } from './types.js';

/**
 * Helper to create MCP tool result
 */
function createResult(data: unknown, isError = false): MCPToolResult {
  return {
    content: [
      {
        type: 'text',
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
    isError,
  };
}

/**
 * Transfer MCP tools for pattern export, import, anonymization, and sharing
 */
export const transferTools: MCPTool[] = [
  // ═══════════════════════════════════════════════════════════════
  // EXPORT TOOLS
  // ═══════════════════════════════════════════════════════════════
  {
    name: 'transfer/export',
    description: 'Export learning patterns to file with anonymization',
    category: 'transfer',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        output: {
          type: 'string',
          description: 'Output file path',
        },
        format: {
          type: 'string',
          enum: ['cbor', 'json'],
          description: 'Serialization format',
        },
        anonymize: {
          type: 'string',
          enum: ['minimal', 'standard', 'strict', 'paranoid'],
          description: 'Anonymization level',
        },
        types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Pattern types to export',
        },
      },
    },
    handler: async (input): Promise<MCPToolResult> => {
      try {
        const { exportPatterns } = await import('../transfer/export.js');
        const result = await exportPatterns(input as Parameters<typeof exportPatterns>[0]);
        return createResult(result);
      } catch (error) {
        return createResult({ error: (error as Error).message }, true);
      }
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // ANONYMIZATION TOOLS
  // ═══════════════════════════════════════════════════════════════
  {
    name: 'transfer/anonymize',
    description: 'Anonymize patterns with configurable PII redaction',
    category: 'transfer',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['minimal', 'standard', 'strict', 'paranoid'],
          description: 'Anonymization level',
        },
        preserveStructure: {
          type: 'boolean',
          description: 'Preserve directory structure in paths',
        },
      },
    },
    handler: async (input): Promise<MCPToolResult> => {
      try {
        const { createAnonymizer } = await import('../transfer/anonymization/index.js');
        const level = (input as { level?: string }).level || 'standard';
        const anonymizer = createAnonymizer(level as 'minimal' | 'standard' | 'strict' | 'paranoid');
        return createResult({
          success: true,
          level,
          message: `Anonymizer created with ${level} level`,
          detectors: anonymizer.getDetectors?.() || ['email', 'phone', 'ip', 'path', 'apiKey'],
        });
      } catch (error) {
        return createResult({ error: (error as Error).message }, true);
      }
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // IPFS TOOLS
  // ═══════════════════════════════════════════════════════════════
  {
    name: 'transfer/ipfs-upload',
    description: 'Upload patterns to IPFS with optional pinning',
    category: 'transfer',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Input file path or content',
        },
        pin: {
          type: 'boolean',
          description: 'Pin to pinning service',
        },
        gateway: {
          type: 'string',
          description: 'IPFS gateway URL',
        },
        name: {
          type: 'string',
          description: 'Human-readable name for the upload',
        },
      },
    },
    handler: async (input): Promise<MCPToolResult> => {
      try {
        const { uploadToIPFS } = await import('../transfer/ipfs/upload.js');
        const result = await uploadToIPFS(input as Parameters<typeof uploadToIPFS>[0]);
        return createResult(result);
      } catch (error) {
        return createResult({ error: (error as Error).message }, true);
      }
    },
  },

  {
    name: 'transfer/ipfs-resolve',
    description: 'Resolve IPNS name to CID',
    category: 'transfer',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'IPNS name to resolve',
        },
      },
      required: ['name'],
    },
    handler: async (input): Promise<MCPToolResult> => {
      try {
        const { resolveIPNS } = await import('../transfer/ipfs/client.js');
        const result = await resolveIPNS((input as { name: string }).name);
        return createResult({ success: true, cid: result });
      } catch (error) {
        return createResult({ error: (error as Error).message }, true);
      }
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // PATTERN STORE TOOLS
  // ═══════════════════════════════════════════════════════════════
  {
    name: 'transfer/store-search',
    description: 'Search the pattern store',
    category: 'transfer',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
        category: {
          type: 'string',
          description: 'Filter by category',
        },
        minRating: {
          type: 'number',
          description: 'Minimum rating',
        },
        verified: {
          type: 'boolean',
          description: 'Only show verified patterns',
        },
        limit: {
          type: 'number',
          description: 'Maximum results',
        },
      },
    },
    handler: async (input): Promise<MCPToolResult> => {
      try {
        const { createPatternStore } = await import('../transfer/store/index.js');
        const store = createPatternStore();
        await store.initialize();
        const results = store.search(input as Parameters<typeof store.search>[0]);
        return createResult(results);
      } catch (error) {
        return createResult({ error: (error as Error).message }, true);
      }
    },
  },

  {
    name: 'transfer/store-info',
    description: 'Get detailed info about a pattern',
    category: 'transfer',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Pattern name',
        },
      },
      required: ['name'],
    },
    handler: async (input): Promise<MCPToolResult> => {
      try {
        const { createPatternStore } = await import('../transfer/store/index.js');
        const store = createPatternStore();
        await store.initialize();
        const pattern = store.getPattern((input as { name: string }).name);
        if (!pattern) {
          return createResult({ error: 'Pattern not found' }, true);
        }
        return createResult(pattern);
      } catch (error) {
        return createResult({ error: (error as Error).message }, true);
      }
    },
  },

  {
    name: 'transfer/store-download',
    description: 'Download a pattern from the store',
    category: 'transfer',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Pattern name',
        },
        output: {
          type: 'string',
          description: 'Output file path',
        },
        verify: {
          type: 'boolean',
          description: 'Verify pattern integrity',
        },
      },
      required: ['name'],
    },
    handler: async (input): Promise<MCPToolResult> => {
      try {
        const { createPatternStore } = await import('../transfer/store/index.js');
        const store = createPatternStore();
        await store.initialize();
        const result = await store.download(
          (input as { name: string }).name,
          input as Parameters<typeof store.download>[1]
        );
        return createResult(result);
      } catch (error) {
        return createResult({ error: (error as Error).message }, true);
      }
    },
  },

  {
    name: 'transfer/store-publish',
    description: 'Publish patterns to the store',
    category: 'transfer',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Pattern name',
        },
        description: {
          type: 'string',
          description: 'Pattern description',
        },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Categories',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for discovery',
        },
        license: {
          type: 'string',
          description: 'SPDX license identifier',
        },
        anonymize: {
          type: 'string',
          enum: ['minimal', 'standard', 'strict', 'paranoid'],
          description: 'Anonymization level before publishing',
        },
      },
      required: ['name', 'description'],
    },
    handler: async (input): Promise<MCPToolResult> => {
      try {
        const { createPatternStore } = await import('../transfer/store/index.js');
        const store = createPatternStore();
        await store.initialize();
        // Create a minimal CFP for demo
        const cfp = {
          magic: 'CFP1' as const,
          version: '1.0.0',
          createdAt: new Date().toISOString(),
          generatedBy: 'claude-flow-v3',
          metadata: {
            id: `pattern-${Date.now()}`,
            name: (input as { name: string }).name,
            description: (input as { description: string }).description,
            tags: (input as { tags?: string[] }).tags || [],
          },
          anonymization: {
            level: (input as { anonymize?: string }).anonymize || 'standard',
            appliedTransforms: [],
            piiRedacted: true,
            pathsStripped: true,
            timestampsGeneralized: true,
            checksum: '',
          },
          patterns: {
            routing: [],
            complexity: [],
            coverage: [],
            trajectory: [],
            custom: [],
          },
          statistics: {
            totalPatterns: 0,
            avgConfidence: 0,
            patternTypes: {},
            timeRange: { start: '', end: '' },
          },
        };
        const result = await store.publish(cfp, input as Parameters<typeof store.publish>[1]);
        return createResult(result);
      } catch (error) {
        return createResult({ error: (error as Error).message }, true);
      }
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // PLUGIN STORE TOOLS
  // ═══════════════════════════════════════════════════════════════
  {
    name: 'transfer/plugin-search',
    description: 'Search the plugin store',
    category: 'transfer',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
        category: {
          type: 'string',
          description: 'Filter by category',
        },
        type: {
          type: 'string',
          description: 'Filter by plugin type',
        },
        verified: {
          type: 'boolean',
          description: 'Only show verified plugins',
        },
        minRating: {
          type: 'number',
          description: 'Minimum rating',
        },
        limit: {
          type: 'number',
          description: 'Maximum results',
        },
      },
    },
    handler: async (input): Promise<MCPToolResult> => {
      try {
        const { createPluginDiscoveryService, searchPlugins } = await import(
          '../plugins/store/index.js'
        );
        const discovery = createPluginDiscoveryService();
        const result = await discovery.discoverRegistry();
        if (!result.success || !result.registry) {
          return createResult({ error: result.error || 'Failed to discover registry' }, true);
        }
        const searchResult = searchPlugins(result.registry, input as Parameters<typeof searchPlugins>[1]);
        return createResult(searchResult);
      } catch (error) {
        return createResult({ error: (error as Error).message }, true);
      }
    },
  },

  {
    name: 'transfer/plugin-info',
    description: 'Get detailed info about a plugin',
    category: 'transfer',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Plugin name or ID',
        },
      },
      required: ['name'],
    },
    handler: async (input): Promise<MCPToolResult> => {
      try {
        const { createPluginDiscoveryService } = await import('../plugins/store/index.js');
        const discovery = createPluginDiscoveryService();
        const result = await discovery.discoverRegistry();
        if (!result.success || !result.registry) {
          return createResult({ error: result.error || 'Failed to discover registry' }, true);
        }
        const plugin = result.registry.plugins.find(
          (p) =>
            p.id === (input as { name: string }).name || p.name === (input as { name: string }).name
        );
        if (!plugin) {
          return createResult({ error: 'Plugin not found' }, true);
        }
        return createResult(plugin);
      } catch (error) {
        return createResult({ error: (error as Error).message }, true);
      }
    },
  },

  {
    name: 'transfer/plugin-featured',
    description: 'Get featured plugins from the store',
    category: 'transfer',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum results',
        },
      },
    },
    handler: async (input): Promise<MCPToolResult> => {
      try {
        const { createPluginDiscoveryService, getFeaturedPlugins } = await import(
          '../plugins/store/index.js'
        );
        const discovery = createPluginDiscoveryService();
        const result = await discovery.discoverRegistry();
        if (!result.success || !result.registry) {
          return createResult({ error: result.error || 'Failed to discover registry' }, true);
        }
        const featured = getFeaturedPlugins(result.registry);
        const limit = (input as { limit?: number }).limit || 10;
        return createResult(featured.slice(0, limit));
      } catch (error) {
        return createResult({ error: (error as Error).message }, true);
      }
    },
  },

  {
    name: 'transfer/plugin-official',
    description: 'Get official plugins from the store',
    category: 'transfer',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (): Promise<MCPToolResult> => {
      try {
        const { createPluginDiscoveryService, getOfficialPlugins } = await import(
          '../plugins/store/index.js'
        );
        const discovery = createPluginDiscoveryService();
        const result = await discovery.discoverRegistry();
        if (!result.success || !result.registry) {
          return createResult({ error: result.error || 'Failed to discover registry' }, true);
        }
        const official = getOfficialPlugins(result.registry);
        return createResult(official);
      } catch (error) {
        return createResult({ error: (error as Error).message }, true);
      }
    },
  },
];

export default transferTools;
