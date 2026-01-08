/**
 * IPFS-Based Pattern Discovery
 * Secure discovery mechanism for finding patterns in decentralized environment
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  PatternRegistry,
  PatternEntry,
  KnownRegistry,
  StoreConfig,
} from './types.js';
import {
  BOOTSTRAP_REGISTRIES,
  DEFAULT_STORE_CONFIG,
  deserializeRegistry,
} from './registry.js';

/**
 * Discovery result
 */
export interface DiscoveryResult {
  success: boolean;
  registry?: PatternRegistry;
  source: string;
  fromCache: boolean;
  cid?: string;
  error?: string;
}

/**
 * Resolved IPNS result
 */
export interface IPNSResolution {
  ipnsName: string;
  cid: string;
  resolvedAt: string;
  expiresAt: string;
}

/**
 * Pattern Store Discovery Service
 * Handles secure discovery of pattern registries via IPFS/IPNS
 */
export class PatternDiscovery {
  private config: StoreConfig;
  private cache: Map<string, { registry: PatternRegistry; expiresAt: number }>;
  private ipnsCache: Map<string, IPNSResolution>;

  constructor(config: Partial<StoreConfig> = {}) {
    this.config = { ...DEFAULT_STORE_CONFIG, ...config };
    this.cache = new Map();
    this.ipnsCache = new Map();
  }

  /**
   * Discover and load the pattern registry
   */
  async discoverRegistry(registryName?: string): Promise<DiscoveryResult> {
    const targetRegistry = registryName || this.config.defaultRegistry;
    const knownRegistry = this.config.registries.find(r => r.name === targetRegistry);

    if (!knownRegistry) {
      return {
        success: false,
        source: targetRegistry,
        fromCache: false,
        error: `Unknown registry: ${targetRegistry}`,
      };
    }

    console.log(`[Discovery] Looking for registry: ${knownRegistry.name}`);

    // Check cache first
    const cached = this.getCachedRegistry(knownRegistry.ipnsName);
    if (cached) {
      console.log(`[Discovery] Found in cache`);
      return {
        success: true,
        registry: cached,
        source: knownRegistry.name,
        fromCache: true,
      };
    }

    // Resolve IPNS to get current CID
    console.log(`[Discovery] Resolving IPNS: ${knownRegistry.ipnsName}`);
    const resolution = await this.resolveIPNS(knownRegistry.ipnsName);

    if (!resolution) {
      return {
        success: false,
        source: knownRegistry.name,
        fromCache: false,
        error: 'Failed to resolve IPNS name',
      };
    }

    // Fetch registry from IPFS
    console.log(`[Discovery] Fetching from IPFS: ${resolution.cid}`);
    const registry = await this.fetchRegistry(resolution.cid, knownRegistry.gateway);

    if (!registry) {
      return {
        success: false,
        source: knownRegistry.name,
        fromCache: false,
        cid: resolution.cid,
        error: 'Failed to fetch registry from IPFS',
      };
    }

    // Verify registry if trusted
    if (knownRegistry.trusted && registry.registrySignature) {
      const verified = this.verifyRegistry(registry, knownRegistry.publicKey);
      if (!verified) {
        console.warn(`[Discovery] Warning: Registry signature verification failed`);
      }
    }

    // Cache the result
    this.cacheRegistry(knownRegistry.ipnsName, registry);

    return {
      success: true,
      registry,
      source: knownRegistry.name,
      fromCache: false,
      cid: resolution.cid,
    };
  }

  /**
   * Resolve IPNS name to CID
   */
  async resolveIPNS(ipnsName: string): Promise<IPNSResolution | null> {
    // Check cache
    const cached = this.ipnsCache.get(ipnsName);
    if (cached && new Date(cached.expiresAt) > new Date()) {
      return cached;
    }

    try {
      // In production: Call IPFS gateway /api/v0/name/resolve
      // For demo: Generate mock CID
      const mockCid = this.generateMockCID(ipnsName);

      const resolution: IPNSResolution = {
        ipnsName,
        cid: mockCid,
        resolvedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour
      };

      this.ipnsCache.set(ipnsName, resolution);
      return resolution;
    } catch (error) {
      console.error(`[Discovery] IPNS resolution failed:`, error);
      return null;
    }
  }

  /**
   * Fetch registry from IPFS gateway
   */
  async fetchRegistry(cid: string, gateway: string): Promise<PatternRegistry | null> {
    try {
      const url = `${gateway}/ipfs/${cid}`;
      console.log(`[Discovery] Fetching: ${url}`);

      // In production: Actual HTTP fetch
      // For demo: Return mock registry with Seraphine
      const mockRegistry = this.createMockRegistry(cid);
      return mockRegistry;
    } catch (error) {
      console.error(`[Discovery] Fetch failed:`, error);
      return null;
    }
  }

  /**
   * Verify registry signature
   */
  verifyRegistry(registry: PatternRegistry, expectedPublicKey: string): boolean {
    if (!registry.registrySignature) {
      return false;
    }

    // In production: Actual Ed25519 verification
    // For demo: Check signature length
    return registry.registrySignature.length === 64;
  }

  /**
   * Get cached registry
   */
  getCachedRegistry(ipnsName: string): PatternRegistry | null {
    const cached = this.cache.get(ipnsName);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.registry;
    }
    return null;
  }

  /**
   * Cache registry
   */
  cacheRegistry(ipnsName: string, registry: PatternRegistry): void {
    this.cache.set(ipnsName, {
      registry,
      expiresAt: Date.now() + this.config.cacheExpiry,
    });
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
    this.ipnsCache.clear();
  }

  /**
   * List all known registries
   */
  listRegistries(): KnownRegistry[] {
    return this.config.registries;
  }

  /**
   * Add a custom registry
   */
  addRegistry(registry: KnownRegistry): void {
    const existing = this.config.registries.findIndex(r => r.name === registry.name);
    if (existing >= 0) {
      this.config.registries[existing] = registry;
    } else {
      this.config.registries.push(registry);
    }
  }

  /**
   * Generate mock CID for demo
   */
  private generateMockCID(input: string): string {
    const hash = crypto.createHash('sha256').update(input + 'registry').digest();
    const prefix = 'bafybei';
    const base32Chars = 'abcdefghijklmnopqrstuvwxyz234567';
    let result = prefix;
    for (let i = 0; i < 44; i++) {
      result += base32Chars[hash[i % hash.length] % 32];
    }
    return result;
  }

  /**
   * Create mock registry with Seraphine genesis
   */
  private createMockRegistry(cid: string): PatternRegistry {
    return {
      version: '1.0.0',
      updatedAt: new Date().toISOString(),
      ipnsName: 'k51qzi5uqu5dj0w8q1xvqn8ql2g4p7x8qpk9vz3xm1y2n3o4p5q6r7s8t9u0v',
      previousCid: undefined,

      patterns: [
        {
          id: 'seraphine-genesis-v1',
          name: 'seraphine-genesis',
          displayName: 'Seraphine Genesis',
          description: 'The foundational Claude Flow pattern model. Contains core routing patterns, complexity heuristics, and coordination trajectories for multi-agent swarms.',
          version: '1.0.0',
          cid: 'bafybeibqsa442vty2cvhku4ujlrkupyl75536ene7ybqsa442v',
          size: 8808,
          checksum: '8df766b89d044815c84796e7f33ba30d7806bff7eb2a75e2a0b7d26b64c45231',
          author: {
            id: 'claude-flow-team',
            displayName: 'Claude Flow Team',
            verified: true,
            patterns: 1,
            totalDownloads: 1000,
          },
          license: 'MIT',
          categories: ['routing', 'coordination'],
          tags: ['genesis', 'foundational', 'routing', 'swarm', 'coordination', 'multi-agent', 'hello-world'],
          language: 'typescript',
          framework: 'claude-flow',
          downloads: 1000,
          rating: 5.0,
          ratingCount: 42,
          lastUpdated: new Date().toISOString(),
          createdAt: '2026-01-08T18:42:31.126Z',
          minClaudeFlowVersion: '3.0.0',
          verified: true,
          trustLevel: 'verified',
          signature: 'ed25519:genesis-pattern-signature',
          publicKey: 'ed25519:claude-flow-team-key',
        },
      ],

      categories: [
        { id: 'routing', name: 'Task Routing', description: 'Task routing patterns', patternCount: 1, icon: '🔀' },
        { id: 'coordination', name: 'Swarm Coordination', description: 'Multi-agent coordination', patternCount: 1, icon: '🐝' },
        { id: 'security', name: 'Security', description: 'Security patterns', patternCount: 0, icon: '🔒' },
        { id: 'performance', name: 'Performance', description: 'Performance patterns', patternCount: 0, icon: '⚡' },
        { id: 'testing', name: 'Testing', description: 'Testing patterns', patternCount: 0, icon: '🧪' },
      ],

      authors: [
        {
          id: 'claude-flow-team',
          displayName: 'Claude Flow Team',
          publicKey: 'ed25519:claude-flow-team-key',
          verified: true,
          patterns: 1,
          totalDownloads: 1000,
        },
      ],

      totalPatterns: 1,
      totalDownloads: 1000,
      totalAuthors: 1,

      featured: ['seraphine-genesis-v1'],
      trending: ['seraphine-genesis-v1'],
      newest: ['seraphine-genesis-v1'],

      registrySignature: crypto.randomBytes(32).toString('hex'),
      registryPublicKey: 'ed25519:claude-flow-registry-key',
    };
  }
}

/**
 * Create discovery service with default config
 */
export function createDiscoveryService(config?: Partial<StoreConfig>): PatternDiscovery {
  return new PatternDiscovery(config);
}
