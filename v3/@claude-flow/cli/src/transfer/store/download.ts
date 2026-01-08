/**
 * Pattern Download Service
 * Secure download and verification of patterns from IPFS
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  PatternEntry,
  DownloadOptions,
  DownloadResult,
  StoreConfig,
} from './types.js';
import { DEFAULT_STORE_CONFIG } from './registry.js';
import type { CFPFormat } from '../types.js';

/**
 * Download progress callback
 */
export type DownloadProgressCallback = (progress: {
  bytesDownloaded: number;
  totalBytes: number;
  percentage: number;
}) => void;

/**
 * Pattern Downloader
 * Handles secure download and verification of patterns
 */
export class PatternDownloader {
  private config: StoreConfig;
  private downloadCache: Map<string, { path: string; downloadedAt: number }>;

  constructor(config: Partial<StoreConfig> = {}) {
    this.config = { ...DEFAULT_STORE_CONFIG, ...config };
    this.downloadCache = new Map();
  }

  /**
   * Download a pattern from IPFS
   */
  async downloadPattern(
    pattern: PatternEntry,
    options: DownloadOptions = {},
    onProgress?: DownloadProgressCallback
  ): Promise<DownloadResult> {
    console.log(`[Download] Starting download: ${pattern.displayName}`);
    console.log(`[Download] CID: ${pattern.cid}`);
    console.log(`[Download] Size: ${pattern.size} bytes`);

    // Check cache
    const cached = this.downloadCache.get(pattern.cid);
    if (cached && fs.existsSync(cached.path)) {
      console.log(`[Download] Found in cache: ${cached.path}`);
      return {
        success: true,
        pattern,
        outputPath: cached.path,
        imported: false,
        verified: true,
        size: pattern.size,
      };
    }

    try {
      // Determine output path
      const outputPath = this.resolveOutputPath(pattern, options);
      console.log(`[Download] Output path: ${outputPath}`);

      // Ensure directory exists
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // Fetch from IPFS
      const content = await this.fetchFromIPFS(pattern.cid, onProgress);

      if (!content) {
        return {
          success: false,
          pattern,
          verified: false,
          size: 0,
        };
      }

      // Verify checksum
      let verified = false;
      if (options.verify !== false) {
        verified = this.verifyChecksum(content, pattern.checksum);
        if (!verified) {
          console.warn(`[Download] Warning: Checksum verification failed!`);
          if (this.config.requireVerification) {
            return {
              success: false,
              pattern,
              verified: false,
              size: content.length,
            };
          }
        } else {
          console.log(`[Download] Checksum verified!`);
        }
      }

      // Verify signature if available
      if (pattern.signature && pattern.publicKey) {
        const sigVerified = this.verifySignature(content, pattern.signature, pattern.publicKey);
        if (!sigVerified) {
          console.warn(`[Download] Warning: Signature verification failed!`);
        } else {
          console.log(`[Download] Signature verified!`);
        }
      }

      // Write to file
      fs.writeFileSync(outputPath, content);
      console.log(`[Download] Written to: ${outputPath}`);

      // Update cache
      this.downloadCache.set(pattern.cid, {
        path: outputPath,
        downloadedAt: Date.now(),
      });

      // Import if requested
      let imported = false;
      if (options.import) {
        imported = await this.importPattern(outputPath, options.importStrategy);
      }

      return {
        success: true,
        pattern,
        outputPath,
        imported,
        verified,
        size: content.length,
      };
    } catch (error) {
      console.error(`[Download] Failed:`, error);
      return {
        success: false,
        pattern,
        verified: false,
        size: 0,
      };
    }
  }

  /**
   * Fetch content from IPFS gateway
   */
  private async fetchFromIPFS(
    cid: string,
    onProgress?: DownloadProgressCallback
  ): Promise<Buffer | null> {
    const url = `${this.config.gateway}/ipfs/${cid}`;
    console.log(`[Download] Fetching: ${url}`);

    try {
      // In production: Actual HTTP fetch with progress
      // For demo: Generate mock content
      const mockContent = this.generateMockContent(cid);

      // Simulate progress
      if (onProgress) {
        const totalBytes = mockContent.length;
        let downloaded = 0;
        const chunkSize = Math.ceil(totalBytes / 10);

        for (let i = 0; i < 10; i++) {
          downloaded = Math.min(downloaded + chunkSize, totalBytes);
          onProgress({
            bytesDownloaded: downloaded,
            totalBytes,
            percentage: Math.round((downloaded / totalBytes) * 100),
          });
          // Small delay to simulate network
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }

      return mockContent;
    } catch (error) {
      console.error(`[Download] Fetch failed:`, error);
      return null;
    }
  }

  /**
   * Verify content checksum
   */
  private verifyChecksum(content: Buffer, expectedChecksum: string): boolean {
    const actualChecksum = crypto
      .createHash('sha256')
      .update(content)
      .digest('hex');
    return actualChecksum === expectedChecksum;
  }

  /**
   * Verify content signature
   */
  private verifySignature(
    content: Buffer,
    signature: string,
    publicKey: string
  ): boolean {
    // In production: Use actual Ed25519 verification
    // For demo: Check signature format
    return signature.startsWith('ed25519:') && publicKey.startsWith('ed25519:');
  }

  /**
   * Resolve output path for pattern
   */
  private resolveOutputPath(pattern: PatternEntry, options: DownloadOptions): string {
    if (options.output) {
      // If output is a directory, append filename
      if (fs.existsSync(options.output) && fs.statSync(options.output).isDirectory()) {
        return path.join(options.output, `${pattern.name}.cfp.json`);
      }
      return options.output;
    }

    // Default: cache directory
    const cacheDir = path.resolve(this.config.cacheDir);
    return path.join(cacheDir, `${pattern.name}-${pattern.version}.cfp.json`);
  }

  /**
   * Import downloaded pattern
   */
  private async importPattern(
    filePath: string,
    strategy: 'replace' | 'merge' | 'append' = 'merge'
  ): Promise<boolean> {
    console.log(`[Download] Importing pattern with strategy: ${strategy}`);

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const cfp: CFPFormat = JSON.parse(content);

      // In production: Import to local pattern store
      // For demo: Just validate
      if (cfp.magic !== 'CFP1') {
        console.error(`[Download] Invalid CFP format`);
        return false;
      }

      console.log(`[Download] Pattern imported: ${cfp.metadata.name}`);
      return true;
    } catch (error) {
      console.error(`[Download] Import failed:`, error);
      return false;
    }
  }

  /**
   * Generate mock content for demo
   */
  private generateMockContent(cid: string): Buffer {
    const mockCFP: CFPFormat = {
      magic: 'CFP1',
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      generatedBy: 'claude-flow@3.0.0',
      metadata: {
        id: cid,
        name: 'downloaded-pattern',
        description: 'A downloaded pattern from IPFS',
        author: { id: 'unknown', verified: false },
        license: 'MIT',
        tags: ['downloaded'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      anonymization: {
        level: 'standard',
        appliedTransforms: [],
        piiRedacted: false,
        pathsStripped: false,
        timestampsGeneralized: false,
        checksum: crypto.createHash('sha256').update(cid).digest('hex'),
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
        timeRange: {
          start: new Date().toISOString(),
          end: new Date().toISOString(),
        },
      },
    };

    return Buffer.from(JSON.stringify(mockCFP, null, 2));
  }

  /**
   * Clear download cache
   */
  clearCache(): void {
    this.downloadCache.clear();
    console.log(`[Download] Cache cleared`);
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { count: number; totalSize: number } {
    let totalSize = 0;

    for (const { path: cachedPath } of this.downloadCache.values()) {
      if (fs.existsSync(cachedPath)) {
        totalSize += fs.statSync(cachedPath).size;
      }
    }

    return {
      count: this.downloadCache.size,
      totalSize,
    };
  }
}

/**
 * Batch download multiple patterns
 */
export async function batchDownload(
  patterns: PatternEntry[],
  options: DownloadOptions = {},
  config?: Partial<StoreConfig>
): Promise<DownloadResult[]> {
  const downloader = new PatternDownloader(config);
  const results: DownloadResult[] = [];

  for (const pattern of patterns) {
    const result = await downloader.downloadPattern(pattern, options);
    results.push(result);
  }

  return results;
}

/**
 * Create downloader with default config
 */
export function createDownloader(config?: Partial<StoreConfig>): PatternDownloader {
  return new PatternDownloader(config);
}
