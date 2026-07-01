/**
 * Context Shadow Copy
 *
 * Maintains a full, incrementally-updated mirror of the conversation
 * with pre-computed importance scores for re-ranking.
 * Uses in-memory storage with JSON file persistence.
 *
 * @module v3/cli/services/context-shadow
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ============================================================================
// Types
// ============================================================================

export interface ShadowEntry {
  id: string;
  messageIndex: number;
  role: string;
  content: string;
  contentHash: string;
  sessionId: string;
  tokenEstimate: number;
  importanceScore: number;
  importanceRank: number;
  lastRankedAt: number;
  summaryShort: string;
  summaryLong: string;
  toolNames: string[];
  filePaths: string[];
  embedding: Buffer | null;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

export interface ShadowState {
  totalEntries: number;
  totalTokens: number;
  contextPercentage: number;
  rankingPhase: 'tracking' | 'warning' | 'critical';
  lastUpdated: number;
}

export interface TieredRestoration {
  tier1Critical: string;
  tier2Summary: string;
  tier3References: string;
  totalChars: number;
}

// ============================================================================
// Constants
// ============================================================================

function getContextWindowTokens(): number {
  const model = process.env.CLAUDE_MODEL_ID ?? process.env.ANTHROPIC_MODEL ?? process.env.CLAUDE_MODEL ?? '';
  return model.toLowerCase().includes('[1m]') ? 1_000_000 : 200_000;
}
const CONTEXT_WINDOW_TOKENS = getContextWindowTokens();
const RESTORE_BUDGET = 4000;

// ============================================================================
// ContextShadow
// ============================================================================

export class ContextShadow {
  private entries: ShadowEntry[] = [];
  private hashIndex = new Map<string, boolean>();
  private dataDir: string;
  private dbPath: string;

  constructor(projectRoot: string) {
    this.dataDir = join(projectRoot, '.hive-flow', 'data');
    this.dbPath = join(this.dataDir, 'shadow-context.json');
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    if (existsSync(this.dbPath)) {
      try {
        const raw = readFileSync(this.dbPath, 'utf-8');
        const data = JSON.parse(raw);
        this.entries = data.entries || [];
        this.rebuildIndex();
      } catch {
        this.entries = [];
      }
    }
  }

  async updateFromTranscript(transcriptPath: string, sessionId: string): Promise<ShadowState> {
    if (!existsSync(transcriptPath)) {
      return this.getState(sessionId);
    }

    const raw = readFileSync(transcriptPath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    const now = Date.now();
    let added = 0;

    for (let i = 0; i < lines.length; i++) {
      try {
        const msg = JSON.parse(lines[i]);
        const content = extractContent(msg);
        if (!content) continue;

        const hash = createHash('sha256').update(content).digest('hex');
        if (this.hashIndex.has(hash)) continue;

        const { toolNames, filePaths } = extractMetadata(msg);

        this.entries.push({
          id: `shadow-${sessionId}-${i}`,
          messageIndex: i,
          role: msg.role || 'unknown',
          content,
          contentHash: hash,
          sessionId,
          tokenEstimate: Math.ceil(content.length / 3.5),
          importanceScore: 0.5,
          importanceRank: 0,
          lastRankedAt: 0,
          summaryShort: '',
          summaryLong: '',
          toolNames,
          filePaths,
          embedding: null,
          confidence: 1.0,
          createdAt: now,
          updatedAt: now,
        });
        this.hashIndex.set(hash, true);
        added++;
      } catch {
        // Skip malformed lines
      }
    }

    if (added > 0) this.persist();
    return this.getState(sessionId);
  }

  async getAll(sessionId: string): Promise<ShadowEntry[]> {
    return this.entries.filter(e => e.sessionId === sessionId);
  }

  async getByRank(sessionId: string, limit: number): Promise<ShadowEntry[]> {
    return this.entries
      .filter(e => e.sessionId === sessionId && e.importanceRank > 0)
      .sort((a, b) => a.importanceRank - b.importanceRank)
      .slice(0, limit);
  }

  async getLowestRanked(sessionId: string, limit: number): Promise<ShadowEntry[]> {
    return this.entries
      .filter(e => e.sessionId === sessionId && e.importanceRank > 0)
      .sort((a, b) => b.importanceRank - a.importanceRank)
      .slice(0, limit);
  }

  async updateRankings(rankings: Array<{ id: string; score: number; rank: number }>): Promise<void> {
    const rankMap = new Map(rankings.map(r => [r.id, r]));
    const now = Date.now();
    for (const entry of this.entries) {
      const ranking = rankMap.get(entry.id);
      if (ranking) {
        entry.importanceScore = ranking.score;
        entry.importanceRank = ranking.rank;
        entry.lastRankedAt = now;
        entry.updatedAt = now;
      }
    }
    this.persist();
  }

  async updateSummaries(summaries: Array<{ id: string; summaryShort: string; summaryLong: string }>): Promise<void> {
    const sumMap = new Map(summaries.map(s => [s.id, s]));
    const now = Date.now();
    for (const entry of this.entries) {
      const summary = sumMap.get(entry.id);
      if (summary) {
        entry.summaryShort = summary.summaryShort;
        entry.summaryLong = summary.summaryLong;
        entry.updatedAt = now;
      }
    }
    this.persist();
  }

  async getState(sessionId: string): Promise<ShadowState> {
    const sessionEntries = this.entries.filter(e => e.sessionId === sessionId);
    const totalTokens = sessionEntries.reduce((sum, e) => sum + e.tokenEstimate, 0);
    const percentage = totalTokens / CONTEXT_WINDOW_TOKENS;
    let phase: ShadowState['rankingPhase'] = 'tracking';
    if (percentage >= 0.85) phase = 'critical';
    else if (percentage >= 0.70) phase = 'warning';
    return { totalEntries: sessionEntries.length, totalTokens, contextPercentage: percentage, rankingPhase: phase, lastUpdated: Date.now() };
  }

  async getEntryCount(): Promise<number> {
    return this.entries.length;
  }

  private rebuildIndex(): void {
    this.hashIndex.clear();
    for (const entry of this.entries) {
      this.hashIndex.set(entry.contentHash, true);
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.dbPath, JSON.stringify({ entries: this.entries, updatedAt: Date.now() }), 'utf-8');
    } catch {
      // Non-fatal: shadow copy is best-effort
    }
  }
}

// ============================================================================
// Tiered Restoration
// ============================================================================

export function buildTieredRestoration(
  entries: ShadowEntry[],
  budget: number = RESTORE_BUDGET,
  tier1Pct = 0.50,
  tier2Pct = 0.35,
  tier3Pct = 0.15,
): TieredRestoration {
  const sorted = [...entries].sort((a, b) => a.importanceRank - b.importanceRank);
  const tier1Budget = Math.floor(budget * tier1Pct);
  const tier2Budget = Math.floor(budget * tier2Pct);
  const tier3Budget = Math.floor(budget * tier3Pct);

  let tier1 = '', t1Used = 0, t1Count = 0;
  for (const e of sorted) {
    if (t1Used + e.content.length > tier1Budget) break;
    tier1 += `[${e.role}] ${e.content}\n`;
    t1Used += e.content.length;
    t1Count++;
  }

  let tier2 = '', t2Used = 0;
  for (let i = t1Count; i < sorted.length; i++) {
    const e = sorted[i];
    const summary = e.summaryLong || e.summaryShort || e.content.slice(0, 100);
    if (t2Used + summary.length > tier2Budget) break;
    tier2 += `- ${summary}\n`;
    t2Used += summary.length;
  }

  const files = new Set<string>();
  const tools = new Set<string>();
  for (const e of sorted) {
    for (const f of e.filePaths) files.add(f);
    for (const t of e.toolNames) tools.add(t);
  }
  const refLine = `Files: ${[...files].slice(0, 20).join(', ')}\nTools: ${[...tools].slice(0, 10).join(', ')}`;
  const tier3 = refLine.length <= tier3Budget ? refLine : '';
  const t3Used = tier3.length;

  return { tier1Critical: tier1, tier2Summary: tier2, tier3References: tier3, totalChars: t1Used + t2Used + t3Used };
}

// ============================================================================
// Helpers
// ============================================================================

function extractContent(msg: Record<string, unknown>): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<Record<string, unknown>>)
      .filter(c => c.type === 'text')
      .map(c => String(c.text || ''))
      .join('\n');
  }
  if (msg.message && typeof (msg.message as Record<string, unknown>).content === 'string') {
    return (msg.message as Record<string, unknown>).content as string;
  }
  return '';
}

function extractMetadata(msg: Record<string, unknown>): { toolNames: string[]; filePaths: string[] } {
  const toolNames: string[] = [];
  const filePaths: string[] = [];
  const blocks = Array.isArray(msg.content) ? (msg.content as Array<Record<string, unknown>>) : [];
  for (const b of blocks) {
    if (b.type === 'tool_use' && typeof b.name === 'string') {
      toolNames.push(b.name);
      const input = b.input as Record<string, unknown> | undefined;
      if (input) {
        if (typeof input.file_path === 'string') filePaths.push(input.file_path);
        if (typeof input.path === 'string') filePaths.push(input.path);
      }
    }
  }
  return { toolNames, filePaths };
}

export default ContextShadow;
