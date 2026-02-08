/**
 * AutoMemoryBridge - Bidirectional sync between Claude Code Auto Memory and AgentDB
 *
 * Per ADR-048: Bridges Claude Code's auto memory (markdown files at
 * ~/.claude/projects/<project>/memory/) with claude-flow's unified memory
 * system (AgentDB + HNSW).
 *
 * Auto memory files are human-readable markdown that Claude loads into its
 * system prompt. MEMORY.md (first 200 lines) is the entrypoint; topic files
 * store detailed notes and are read on demand.
 *
 * @module @claude-flow/memory/auto-memory-bridge
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  IMemoryBackend,
  MemoryEntry,
  MemoryEntryInput,
  MemoryQuery,
} from './types.js';

// ===== Types =====

/** Insight category for organization in MEMORY.md */
export type InsightCategory =
  | 'project-patterns'
  | 'debugging'
  | 'architecture'
  | 'performance'
  | 'security'
  | 'preferences'
  | 'swarm-results';

/** Sync direction */
export type SyncDirection = 'to-auto' | 'from-auto' | 'bidirectional';

/** Sync mode determines when syncs occur */
export type SyncMode = 'on-write' | 'on-session-end' | 'periodic';

/** Prune strategy for keeping MEMORY.md under line limit */
export type PruneStrategy = 'confidence-weighted' | 'fifo' | 'lru';

/** Configuration for AutoMemoryBridge */
export interface AutoMemoryBridgeConfig {
  /** Auto memory directory path (auto-resolved if not provided) */
  memoryDir?: string;

  /** Working directory for git root detection */
  workingDir?: string;

  /** Max lines for MEMORY.md index (default: 180, Claude reads first 200) */
  maxIndexLines?: number;

  /** Topic file mapping: category → filename */
  topicMapping?: Partial<Record<InsightCategory, string>>;

  /** Sync mode (default: 'on-session-end') */
  syncMode?: SyncMode;

  /** Periodic sync interval in ms (if syncMode is 'periodic') */
  syncIntervalMs?: number;

  /** Minimum confidence for syncing to auto memory (default: 0.7) */
  minConfidence?: number;

  /** Maximum lines per topic file (default: 500) */
  maxTopicFileLines?: number;

  /** Prune strategy for MEMORY.md (default: 'confidence-weighted') */
  pruneStrategy?: PruneStrategy;
}

/** A memory insight to record */
export interface MemoryInsight {
  /** Category for organization */
  category: InsightCategory;

  /** One-line summary for MEMORY.md index */
  summary: string;

  /** Detailed content (goes in topic file if > 2 lines) */
  detail?: string;

  /** Source: which agent/hook discovered this */
  source: string;

  /** Confidence score (0-1), used for curation priority */
  confidence: number;

  /** AgentDB entry ID for cross-reference */
  agentDbId?: string;
}

/** Result of a sync operation */
export interface SyncResult {
  /** Number of entries synced */
  synced: number;

  /** Categories that were updated */
  categories: string[];

  /** Duration of sync in milliseconds */
  durationMs: number;

  /** Any errors encountered */
  errors: string[];
}

/** Result of an import operation */
export interface ImportResult {
  /** Number of entries imported */
  imported: number;

  /** Number of entries skipped (already in AgentDB) */
  skipped: number;

  /** Files processed */
  files: string[];

  /** Duration in milliseconds */
  durationMs: number;
}

/** Parsed markdown entry from a topic file */
interface ParsedEntry {
  heading: string;
  content: string;
  metadata: Record<string, string>;
}

// ===== Constants =====

const DEFAULT_TOPIC_MAPPING: Record<InsightCategory, string> = {
  'project-patterns': 'patterns.md',
  'debugging': 'debugging.md',
  'architecture': 'architecture.md',
  'performance': 'performance.md',
  'security': 'security.md',
  'preferences': 'preferences.md',
  'swarm-results': 'swarm-results.md',
};

const DEFAULT_CONFIG: Required<AutoMemoryBridgeConfig> = {
  memoryDir: '',
  workingDir: process.cwd(),
  maxIndexLines: 180,
  topicMapping: DEFAULT_TOPIC_MAPPING,
  syncMode: 'on-session-end',
  syncIntervalMs: 60_000,
  minConfidence: 0.7,
  maxTopicFileLines: 500,
  pruneStrategy: 'confidence-weighted',
};

// ===== AutoMemoryBridge =====

/**
 * Bidirectional bridge between Claude Code auto memory and AgentDB.
 *
 * @example
 * ```typescript
 * const bridge = new AutoMemoryBridge(memoryBackend, {
 *   workingDir: '/workspaces/my-project',
 * });
 *
 * // Record an insight
 * await bridge.recordInsight({
 *   category: 'debugging',
 *   summary: 'HNSW index requires initialization before search',
 *   source: 'agent:tester',
 *   confidence: 0.95,
 * });
 *
 * // Sync to auto memory files
 * await bridge.syncToAutoMemory();
 *
 * // Import auto memory into AgentDB
 * await bridge.importFromAutoMemory();
 * ```
 */
export class AutoMemoryBridge extends EventEmitter {
  private config: Required<AutoMemoryBridgeConfig>;
  private backend: IMemoryBackend;
  private lastSyncTime: number = 0;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private insights: MemoryInsight[] = [];

  constructor(backend: IMemoryBackend, config: AutoMemoryBridgeConfig = {}) {
    super();
    this.backend = backend;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      topicMapping: {
        ...DEFAULT_TOPIC_MAPPING,
        ...(config.topicMapping || {}),
      },
    };

    if (!this.config.memoryDir) {
      this.config.memoryDir = resolveAutoMemoryDir(this.config.workingDir);
    }

    if (this.config.syncMode === 'periodic' && this.config.syncIntervalMs > 0) {
      this.startPeriodicSync();
    }
  }

  /** Get the resolved auto memory directory path */
  getMemoryDir(): string {
    return this.config.memoryDir;
  }

  /** Get the path to MEMORY.md */
  getIndexPath(): string {
    return path.join(this.config.memoryDir, 'MEMORY.md');
  }

  /** Get the path to a topic file */
  getTopicPath(category: InsightCategory): string {
    const filename = this.config.topicMapping[category] || `${category}.md`;
    return path.join(this.config.memoryDir, filename);
  }

  /**
   * Record a memory insight.
   * Stores in the in-memory buffer and optionally writes immediately.
   */
  async recordInsight(insight: MemoryInsight): Promise<void> {
    this.insights.push(insight);

    // Store in AgentDB
    await this.storeInsightInAgentDB(insight);

    // If sync-on-write, write immediately to files
    if (this.config.syncMode === 'on-write') {
      await this.writeInsightToFiles(insight);
    }

    this.emit('insight:recorded', insight);
  }

  /**
   * Sync high-confidence AgentDB entries to auto memory files.
   * Called on session-end or periodically.
   */
  async syncToAutoMemory(): Promise<SyncResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    const updatedCategories = new Set<string>();

    try {
      // Ensure directory exists
      await this.ensureMemoryDir();

      // Flush buffered insights to files
      for (const insight of this.insights) {
        try {
          await this.writeInsightToFiles(insight);
          updatedCategories.add(insight.category);
        } catch (err) {
          errors.push(`Failed to write insight: ${(err as Error).message}`);
        }
      }

      // Query AgentDB for high-confidence entries since last sync
      const entries = await this.queryRecentInsights();
      for (const entry of entries) {
        try {
          const category = this.classifyEntry(entry);
          await this.appendToTopicFile(category, entry);
          updatedCategories.add(category);
        } catch (err) {
          errors.push(`Failed to sync entry ${entry.id}: ${(err as Error).message}`);
        }
      }

      // Curate MEMORY.md index
      await this.curateIndex();

      const synced = this.insights.length + entries.length;
      this.insights = [];
      this.lastSyncTime = Date.now();

      const result: SyncResult = {
        synced,
        categories: [...updatedCategories],
        durationMs: Date.now() - startTime,
        errors,
      };

      this.emit('sync:completed', result);
      return result;
    } catch (err) {
      errors.push(`Sync failed: ${(err as Error).message}`);
      this.emit('sync:failed', { error: err });
      return {
        synced: 0,
        categories: [],
        durationMs: Date.now() - startTime,
        errors,
      };
    }
  }

  /**
   * Import auto memory files into AgentDB.
   * Called on session-start to hydrate AgentDB with previous learnings.
   */
  async importFromAutoMemory(): Promise<ImportResult> {
    const startTime = Date.now();
    const memoryDir = this.config.memoryDir;

    if (!fs.existsSync(memoryDir)) {
      return { imported: 0, skipped: 0, files: [], durationMs: 0 };
    }

    let imported = 0;
    let skipped = 0;
    const processedFiles: string[] = [];

    const files = fs.readdirSync(memoryDir)
      .filter(f => f.endsWith('.md'));

    for (const file of files) {
      const filePath = path.join(memoryDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const entries = parseMarkdownEntries(content);

      for (const entry of entries) {
        const contentHash = hashContent(entry.content);

        // Check if already in AgentDB by content hash
        const existing = await this.findByContentHash(contentHash);
        if (existing) {
          skipped++;
          continue;
        }

        // Store in AgentDB
        const input: MemoryEntryInput = {
          key: `auto-memory:${file}:${entry.heading}`,
          content: entry.content,
          namespace: 'auto-memory',
          type: 'semantic',
          tags: ['auto-memory', file.replace('.md', '')],
          metadata: {
            sourceFile: file,
            heading: entry.heading,
            importedAt: new Date().toISOString(),
            contentHash,
          },
        };

        await this.storeInBackend(input);
        imported++;
      }

      processedFiles.push(file);
    }

    const result: ImportResult = {
      imported,
      skipped,
      files: processedFiles,
      durationMs: Date.now() - startTime,
    };

    this.emit('import:completed', result);
    return result;
  }

  /**
   * Curate MEMORY.md to stay under the line limit.
   * Groups entries by category and prunes low-confidence items.
   */
  async curateIndex(): Promise<void> {
    const indexPath = this.getIndexPath();
    await this.ensureMemoryDir();

    // Collect summaries from all topic files
    const sections: Record<string, string[]> = {};

    for (const [category, filename] of Object.entries(this.config.topicMapping)) {
      const topicPath = path.join(this.config.memoryDir, filename as string);
      if (fs.existsSync(topicPath)) {
        const content = fs.readFileSync(topicPath, 'utf-8');
        const summaries = extractSummaries(content);
        if (summaries.length > 0) {
          sections[category] = summaries;
        }
      }
    }

    // Generate MEMORY.md content
    const lines: string[] = [
      '# Claude Flow V3 Project Memory',
      '',
    ];

    const categoryLabels: Record<string, string> = {
      'project-patterns': 'Project Patterns',
      'debugging': 'Debugging',
      'architecture': 'Architecture',
      'performance': 'Performance',
      'security': 'Security',
      'preferences': 'Preferences',
      'swarm-results': 'Swarm Results',
    };

    for (const [category, summaries] of Object.entries(sections)) {
      const label = categoryLabels[category] || category;
      const filename = (this.config.topicMapping as Record<string, string>)[category] || `${category}.md`;

      lines.push(`## ${label}`);
      for (const summary of summaries) {
        lines.push(`- ${summary}`);
      }
      lines.push(`- See \`${filename}\` for details`);
      lines.push('');
    }

    // Prune if over limit
    while (lines.length > this.config.maxIndexLines) {
      // Remove lines from the largest section
      const sectionSizes = Object.entries(sections)
        .map(([cat, items]) => ({ cat, size: items.length }))
        .sort((a, b) => b.size - a.size);

      if (sectionSizes.length > 0 && sectionSizes[0].size > 1) {
        sections[sectionSizes[0].cat].pop();
        // Regenerate (simplified: just trim last entry from largest section)
        lines.length = 0;
        lines.push('# Claude Flow V3 Project Memory', '');
        for (const [category, summaries] of Object.entries(sections)) {
          const label = categoryLabels[category] || category;
          const filename = (this.config.topicMapping as Record<string, string>)[category] || `${category}.md`;
          lines.push(`## ${label}`);
          for (const summary of summaries) {
            lines.push(`- ${summary}`);
          }
          lines.push(`- See \`${filename}\` for details`);
          lines.push('');
        }
      } else {
        break;
      }
    }

    fs.writeFileSync(indexPath, lines.join('\n'), 'utf-8');
    this.emit('index:curated', { lines: lines.length });
  }

  /**
   * Get auto memory status: directory info, file count, line counts.
   */
  getStatus(): {
    memoryDir: string;
    exists: boolean;
    files: { name: string; lines: number }[];
    totalLines: number;
    indexLines: number;
    lastSyncTime: number;
    bufferedInsights: number;
  } {
    const memoryDir = this.config.memoryDir;
    const exists = fs.existsSync(memoryDir);

    if (!exists) {
      return {
        memoryDir,
        exists: false,
        files: [],
        totalLines: 0,
        indexLines: 0,
        lastSyncTime: this.lastSyncTime,
        bufferedInsights: this.insights.length,
      };
    }

    const files: { name: string; lines: number }[] = [];
    let totalLines = 0;
    let indexLines = 0;

    const mdFiles = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md'));
    for (const file of mdFiles) {
      const content = fs.readFileSync(path.join(memoryDir, file), 'utf-8');
      const lineCount = content.split('\n').length;
      files.push({ name: file, lines: lineCount });
      totalLines += lineCount;
      if (file === 'MEMORY.md') {
        indexLines = lineCount;
      }
    }

    return {
      memoryDir,
      exists: true,
      files,
      totalLines,
      indexLines,
      lastSyncTime: this.lastSyncTime,
      bufferedInsights: this.insights.length,
    };
  }

  /** Stop periodic sync and clean up */
  destroy(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.removeAllListeners();
  }

  // ===== Private Methods =====

  private async ensureMemoryDir(): Promise<void> {
    const dir = this.config.memoryDir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private async storeInsightInAgentDB(insight: MemoryInsight): Promise<void> {
    const content = insight.detail
      ? `${insight.summary}\n\n${insight.detail}`
      : insight.summary;

    const input: MemoryEntryInput = {
      key: `insight:${insight.category}:${Date.now()}`,
      content,
      namespace: 'learnings',
      type: 'semantic',
      tags: ['insight', insight.category, `source:${insight.source}`],
      metadata: {
        category: insight.category,
        summary: insight.summary,
        source: insight.source,
        confidence: insight.confidence,
        contentHash: hashContent(content),
        ...(insight.agentDbId ? { linkedEntryId: insight.agentDbId } : {}),
      },
    };

    await this.storeInBackend(input);
  }

  private async storeInBackend(input: MemoryEntryInput): Promise<void> {
    // Use the backend's store method with a constructed entry
    const { createDefaultEntry } = await import('./types.js');
    const entry = createDefaultEntry(input);
    await this.backend.store(entry);
  }

  private async writeInsightToFiles(insight: MemoryInsight): Promise<void> {
    await this.ensureMemoryDir();

    const topicPath = this.getTopicPath(insight.category);
    const line = formatInsightLine(insight);

    // Append to topic file
    if (fs.existsSync(topicPath)) {
      const existing = fs.readFileSync(topicPath, 'utf-8');
      // Skip if already present
      if (existing.includes(insight.summary)) return;

      const lineCount = existing.split('\n').length;
      if (lineCount >= this.config.maxTopicFileLines) {
        // Prune oldest entries
        const pruned = pruneTopicFile(existing, this.config.maxTopicFileLines - 10);
        fs.writeFileSync(topicPath, pruned + '\n' + line, 'utf-8');
      } else {
        fs.appendFileSync(topicPath, '\n' + line, 'utf-8');
      }
    } else {
      const categoryLabels: Record<string, string> = {
        'project-patterns': 'Project Patterns',
        'debugging': 'Debugging Insights',
        'architecture': 'Architecture Notes',
        'performance': 'Performance Notes',
        'security': 'Security Notes',
        'preferences': 'Preferences',
        'swarm-results': 'Swarm Results',
      };
      const header = `# ${categoryLabels[insight.category] || insight.category}\n\n`;
      fs.writeFileSync(topicPath, header + line, 'utf-8');
    }
  }

  private async queryRecentInsights(): Promise<MemoryEntry[]> {
    const query: MemoryQuery = {
      type: 'hybrid',
      namespace: 'learnings',
      tags: ['insight'],
      updatedAfter: this.lastSyncTime || 0,
      limit: 50,
    };

    try {
      const entries = await this.backend.query(query);
      return entries.filter(e => {
        const confidence = (e.metadata?.confidence as number) || 0;
        return confidence >= this.config.minConfidence;
      });
    } catch {
      return [];
    }
  }

  private classifyEntry(entry: MemoryEntry): InsightCategory {
    const category = entry.metadata?.category as InsightCategory | undefined;
    if (category && Object.keys(DEFAULT_TOPIC_MAPPING).includes(category)) {
      return category;
    }

    // Classify by tags
    const tags = entry.tags || [];
    if (tags.includes('debugging') || tags.includes('bug') || tags.includes('fix')) {
      return 'debugging';
    }
    if (tags.includes('architecture') || tags.includes('design')) {
      return 'architecture';
    }
    if (tags.includes('performance') || tags.includes('benchmark')) {
      return 'performance';
    }
    if (tags.includes('security') || tags.includes('cve')) {
      return 'security';
    }
    if (tags.includes('swarm') || tags.includes('agent')) {
      return 'swarm-results';
    }

    return 'project-patterns';
  }

  private async appendToTopicFile(
    category: InsightCategory,
    entry: MemoryEntry,
  ): Promise<void> {
    const insight: MemoryInsight = {
      category,
      summary: (entry.metadata?.summary as string) || entry.content.split('\n')[0],
      detail: entry.content,
      source: (entry.metadata?.source as string) || 'agentdb',
      confidence: (entry.metadata?.confidence as number) || 0.5,
      agentDbId: entry.id,
    };

    await this.writeInsightToFiles(insight);
  }

  private async findByContentHash(hash: string): Promise<MemoryEntry | null> {
    try {
      const results = await this.backend.query({
        type: 'hybrid',
        namespace: 'auto-memory',
        metadata: { contentHash: hash },
        limit: 1,
      });
      return results.length > 0 ? results[0] : null;
    } catch {
      return null;
    }
  }

  private startPeriodicSync(): void {
    this.syncTimer = setInterval(async () => {
      try {
        await this.syncToAutoMemory();
      } catch (err) {
        this.emit('sync:error', err);
      }
    }, this.config.syncIntervalMs);

    // Unref so it doesn't prevent process exit
    if (this.syncTimer.unref) {
      this.syncTimer.unref();
    }
  }
}

// ===== Utility Functions =====

/**
 * Resolve the auto memory directory for a given working directory.
 * Mirrors Claude Code's path derivation from git root.
 */
export function resolveAutoMemoryDir(workingDir: string): string {
  const gitRoot = findGitRoot(workingDir);
  const basePath = gitRoot || workingDir;

  // Claude Code uses the path with '/' replaced by '-', leading '-' removed
  const projectKey = basePath.replace(/\//g, '-').replace(/^-/, '');

  return path.join(
    process.env.HOME || process.env.USERPROFILE || '~',
    '.claude',
    'projects',
    projectKey,
    'memory',
  );
}

/**
 * Find the git root directory by walking up from workingDir.
 */
export function findGitRoot(dir: string): string | null {
  let current = path.resolve(dir);
  const root = path.parse(current).root;

  while (current !== root) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    current = path.dirname(current);
  }

  return null;
}

/**
 * Parse markdown content into structured entries.
 * Splits on ## headings and extracts content under each.
 */
export function parseMarkdownEntries(content: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  const lines = content.split('\n');
  let currentHeading = '';
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      // Save previous section
      if (currentHeading && currentLines.length > 0) {
        entries.push({
          heading: currentHeading,
          content: currentLines.join('\n').trim(),
          metadata: {},
        });
      }
      currentHeading = headingMatch[1];
      currentLines = [];
    } else if (currentHeading) {
      currentLines.push(line);
    }
  }

  // Save last section
  if (currentHeading && currentLines.length > 0) {
    entries.push({
      heading: currentHeading,
      content: currentLines.join('\n').trim(),
      metadata: {},
    });
  }

  return entries;
}

/**
 * Extract one-line summaries from a topic file.
 * Returns bullet-point items (lines starting with '- ').
 */
export function extractSummaries(content: string): string[] {
  return content
    .split('\n')
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim())
    .filter(line => !line.startsWith('See `'));
}

/**
 * Format an insight as a markdown line for topic files.
 */
export function formatInsightLine(insight: MemoryInsight): string {
  const timestamp = new Date().toISOString().split('T')[0];
  const prefix = `- ${insight.summary}`;
  const suffix = ` _(${insight.source}, ${timestamp}, conf: ${insight.confidence.toFixed(2)})_`;

  if (insight.detail && insight.detail.split('\n').length > 2) {
    return `${prefix}${suffix}\n  ${insight.detail.split('\n').join('\n  ')}`;
  }

  return `${prefix}${suffix}`;
}

/**
 * Hash content for deduplication.
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Prune a topic file to stay under the line limit.
 * Removes oldest entries (those closest to the top after the header).
 */
export function pruneTopicFile(content: string, maxLines: number): string {
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;

  // Keep header (first 3 lines) and newest entries (from bottom)
  const header = lines.slice(0, 3);
  const entries = lines.slice(3);

  // Keep the most recent entries
  const kept = entries.slice(entries.length - (maxLines - 3));
  return [...header, ...kept].join('\n');
}

export default AutoMemoryBridge;
