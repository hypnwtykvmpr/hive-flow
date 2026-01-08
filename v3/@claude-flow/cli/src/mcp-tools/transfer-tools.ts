/**
 * Transfer MCP Tools
 * Pattern and plugin sharing via IPFS-based decentralized registry
 *
 * @module @claude-flow/cli/mcp-tools/transfer-tools
 * @version 3.0.0
 */

import type { MCPTool, MCPToolResult } from './types.js';

/**
 * Transfer MCP tools for pattern export, import, anonymization, and sharing
 */
export const transferTools: MCPTool[] = [
  // ═══════════════════════════════════════════════════════════════
  // EXPORT TOOLS
  // ═══════════════════════════════════════════════════════════════
  {
    name: 'transfer/export',
    description: 'Export learning patterns to file or IPFS with anonymization',
    category: 'transfer',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        output: {
          type: 'string',
          description: 'Output file path (optional if toIpfs is true)',
        },
        format: {
          type: 'string',
          enum: ['cbor', 'json', 'msgpack', 'cbor.gz', 'cbor.zstd'],
          default: 'cbor',
          description: 'Serialization format',
        },
        anonymize: {
          type: 'string',
          enum: ['minimal', 'standard', 'strict', 'paranoid'],
          default: 'standard',
          description: 'Anonymization level',
        },
        redactPii: {
          type: 'boolean',
          default: true,
          description: 'Redact personally identifiable information',
        },
        stripPaths: {
          type: 'boolean',
          default: false,
          description: 'Strip absolute file paths',
        },
        types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Pattern types to export (routing, complexity, coverage, trajectory)',
        },
        minConfidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          default: 0.5,
          description: 'Minimum confidence threshold for patterns',
        },
        toIpfs: {
          type: 'boolean',
          default: false,
          description: 'Upload to IPFS instead of file',
        },
        pin: {
          type: 'boolean',
          default: true,
          description: 'Pin to IPFS pinning service (requires toIpfs)',
        },
      },
    },
    handler: async (input): Promise<MCPToolResult> => {
      const { exportPatterns } = await import('../transfer/export.js');
      return exportPatterns(input as Parameters<typeof exportPatterns>[0]);
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // IMPORT TOOLS
  // ═══════════════════════════════════════════════════════════════
  {
    name: 'transfer/import',
    description: 'Import learning patterns from file or IPFS',
    category: 'transfer',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Input file path (optional if fromIpfs is set)',
        },
        fromIpfs: {
          type: 'string',
          description: 'IPFS CID to import from',
        },
        fromStore: {
          type: 'string',
          description: 'Pattern store name to import from',
        },
        version: {
          type: 'string',
          default: 'latest',
          description: 'Version to import (for store imports)',
        },
        strategy: {
          type: 'string',
          enum: ['replace', 'merge', 'append'],
          default: 'merge',
          description: 'Import strategy for existing patterns',
        },
        conflictResolution: {
          type: 'string',
          enum: ['highest-confidence', 'newest', 'oldest', 'keep-local', 'keep-remote'],
          default: 'highest-confidence',
          description: 'How to resolve pattern conflicts',
        },
        verifySignature: {
          type: 'boolean',
          default: false,
          description: 'Require valid signature for import',
        },
        dryRun: {
          type: 'boolean',
          default: false,
          description: 'Preview import without applying changes',
        },
      },
    },
    handler: async (input): Promise<MCPToolResult> => {
      const { importPatterns } = await import('../transfer/import.js');
      return importPatterns(input as Parameters<typeof importPatterns>[0]);
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
        input: {
          type: 'string',
          description: 'Input file path',
        },
        output: {
          type: 'string',
          description: 'Output file path',
        },
        level: {
          type: 'string',
          enum: ['minimal', 'standard', 'strict', 'paranoid'],
          default: 'standard',
          description: 'Anonymization level',
        },
        preserveStructure: {
          type: 'boolean',
          default: true,
          description: 'Preserve directory structure in paths',
        },
      },
      required: ['input', 'output'],
    },
    handler: async (input): Promise<MCPToolResult> => {
      const { anonymizePatterns } = await import('../transfer/anonymization/index.js');
      return anonymizePatterns(input as Parameters<typeof anonymizePatterns>[0]);
    },
  },

  {
    name: 'transfer/detect-pii',
    description: 'Scan patterns for PII without redacting',
    category: 'transfer',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Input file or directory to scan',
        },
        detectors: {
          type: 'array',
          items: { type: 'string' },
          default: ['email', 'phone', 'ip', 'path', 'apiKey'],
          description: 'PII detectors to run',
        },
        outputFormat: {
          type: 'string',
          enum: ['summary', 'detailed', 'json'],
          default: 'summary',
          description: 'Output format',
        },
      },
      required: ['input'],
    },
    handler: async (input): Promise<MCPToolResult> => {
      const { detectPii } = await import('../transfer/anonymization/detectors.js');
      return detectPii(input as Parameters<typeof detectPii>[0]);
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
          description: 'Input file path',
        },
        pin: {
          type: 'boolean',
          default: true,
          description: 'Pin to pinning service',
        },
        pinningService: {
          type: 'string',
          enum: ['pinata', 'web3storage', 'infura', 'custom'],
          default: 'pinata',
          description: 'Pinning service to use',
        },
        gateway: {
          type: 'string',
          default: 'https://w3s.link',
          description: 'IPFS gateway URL',
        },
        name: {
          type: 'string',
          description: 'Human-readable name for the upload',
        },
      },
      required: ['input'],
    },
    handler: async (input): Promise<MCPToolResult> => {
      const { uploadToIpfs } = await import('../transfer/ipfs/upload.js');
      return uploadToIpfs(input as Parameters<typeof uploadToIpfs>[0]);
    },
  },

  {
    name: 'transfer/ipfs-download',
    description: 'Download patterns from IPFS',
    category: 'transfer',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        cid: {
          type: 'string',
          description: 'IPFS Content ID (CID)',
        },
        output: {
          type: 'string',
          description: 'Output file path',
        },
        gateway: {
          type: 'string',
          default: 'https://w3s.link',
          description: 'IPFS gateway URL',
        },
        timeout: {
          type: 'number',
          default: 30000,
          description: 'Download timeout in milliseconds',
        },
        verify: {
          type: 'boolean',
          default: true,
          description: 'Verify content integrity',
        },
      },
      required: ['cid', 'output'],
    },
    handler: async (input): Promise<MCPToolResult> => {
      const { downloadFromIpfs } = await import('../transfer/ipfs/download.js');
      return downloadFromIpfs(input as Parameters<typeof downloadFromIpfs>[0]);
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
        recursive: {
          type: 'boolean',
          default: true,
          description: 'Resolve recursively',
        },
      },
      required: ['name'],
    },
    handler: async (input): Promise<MCPToolResult> => {
      const { resolveIPNS } = await import('../transfer/ipfs/client.js');
      const result = await resolveIPNS((input as { name: string }).name);
      return { success: true, cid: result };
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
        language: {
          type: 'string',
          description: 'Filter by programming language',
        },
        minRating: {
          type: 'number',
          minimum: 0,
          maximum: 5,
          description: 'Minimum rating',
        },
        minDownloads: {
          type: 'number',
          minimum: 0,
          description: 'Minimum download count',
        },
        verified: {
          type: 'boolean',
          description: 'Only show verified patterns',
        },
        limit: {
          type: 'number',
          default: 20,
          description: 'Maximum results',
        },
      },
    },
    handler: async (input): Promise<MCPToolResult> => {
      const { searchPatterns } = await import('../transfer/store/search.js');
      return searchPatterns(input as Parameters<typeof searchPatterns>[0]);
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
        version: {
          type: 'string',
          description: 'Specific version (default: latest)',
        },
      },
      required: ['name'],
    },
    handler: async (input): Promise<MCPToolResult> => {
      const { getPatternInfo } = await import('../transfer/store/registry.js');
      return getPatternInfo(input as Parameters<typeof getPatternInfo>[0]);
    },
  },

  {
    name: 'transfer/store-install',
    description: 'Install a pattern from the store',
    category: 'transfer',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Pattern name',
        },
        version: {
          type: 'string',
          default: 'latest',
          description: 'Version to install',
        },
        strategy: {
          type: 'string',
          enum: ['replace', 'merge', 'append'],
          default: 'merge',
          description: 'Import strategy',
        },
      },
      required: ['name'],
    },
    handler: async (input): Promise<MCPToolResult> => {
      const { installPattern } = await import('../transfer/store/install.js');
      return installPattern(input as Parameters<typeof installPattern>[0]);
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
        input: {
          type: 'string',
          description: 'Input pattern file',
        },
        name: {
          type: 'string',
          description: 'Pattern name',
        },
        description: {
          type: 'string',
          description: 'Pattern description',
        },
        category: {
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
          default: 'MIT',
          description: 'SPDX license identifier',
        },
        anonymize: {
          type: 'string',
          enum: ['minimal', 'standard', 'strict', 'paranoid'],
          default: 'strict',
          description: 'Anonymization level before publishing',
        },
      },
      required: ['input', 'name', 'description'],
    },
    handler: async (input): Promise<MCPToolResult> => {
      const { publishPattern } = await import('../transfer/store/publish.js');
      return publishPattern(input as Parameters<typeof publishPattern>[0]);
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
          enum: ['agent', 'hook', 'command', 'provider', 'integration', 'theme', 'core', 'hybrid'],
          description: 'Filter by plugin type',
        },
        verified: {
          type: 'boolean',
          description: 'Only show verified plugins',
        },
        minRating: {
          type: 'number',
          minimum: 0,
          maximum: 5,
          description: 'Minimum rating',
        },
        limit: {
          type: 'number',
          default: 20,
          description: 'Maximum results',
        },
      },
    },
    handler: async (input): Promise<MCPToolResult> => {
      const { createPluginDiscoveryService, searchPlugins } = await import('../plugins/store/index.js');
      const discovery = createPluginDiscoveryService();
      const result = await discovery.discoverRegistry();
      if (!result.success || !result.registry) {
        return { success: false, error: result.error || 'Failed to discover registry' };
      }
      const searchResult = searchPlugins(result.registry, input as Parameters<typeof searchPlugins>[1]);
      return { success: true, ...searchResult };
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
      const { createPluginDiscoveryService } = await import('../plugins/store/index.js');
      const discovery = createPluginDiscoveryService();
      const result = await discovery.discoverRegistry();
      if (!result.success || !result.registry) {
        return { success: false, error: result.error || 'Failed to discover registry' };
      }
      const plugin = result.registry.plugins.find(
        (p) => p.id === (input as { name: string }).name || p.name === (input as { name: string }).name
      );
      if (!plugin) {
        return { success: false, error: 'Plugin not found' };
      }
      return { success: true, plugin };
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // VERIFICATION TOOLS
  // ═══════════════════════════════════════════════════════════════
  {
    name: 'transfer/verify',
    description: 'Verify pattern signature and integrity',
    category: 'transfer',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Pattern file to verify',
        },
        checkSignature: {
          type: 'boolean',
          default: true,
          description: 'Verify cryptographic signature',
        },
        checkIntegrity: {
          type: 'boolean',
          default: true,
          description: 'Verify checksum integrity',
        },
        scanMalware: {
          type: 'boolean',
          default: true,
          description: 'Scan for malicious patterns',
        },
      },
      required: ['input'],
    },
    handler: async (input): Promise<MCPToolResult> => {
      const { verifyPattern } = await import('../transfer/security/verification.js');
      return verifyPattern(input as Parameters<typeof verifyPattern>[0]);
    },
  },

  {
    name: 'transfer/sign',
    description: 'Sign patterns with Ed25519 key',
    category: 'transfer',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Pattern file to sign',
        },
        output: {
          type: 'string',
          description: 'Output file (default: overwrites input)',
        },
        privateKey: {
          type: 'string',
          description: 'Path to Ed25519 private key file',
        },
      },
      required: ['input'],
    },
    handler: async (input): Promise<MCPToolResult> => {
      const { signPattern } = await import('../transfer/security/verification.js');
      return signPattern(input as Parameters<typeof signPattern>[0]);
    },
  },
];

export default transferTools;
