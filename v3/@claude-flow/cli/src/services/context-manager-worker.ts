/**
 * Context Manager Worker
 *
 * Daemon worker that orchestrates the shadow copy, re-ranker, and offloader.
 * Runs on a 2-minute interval to continuously optimize the context window.
 *
 * @module v3/cli/services/context-manager-worker
 */

import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContextShadow } from './context-shadow.js';
import { ContextReranker } from './context-reranker.js';
import type { CullPlan } from './context-reranker.js';
import { ContextOffloader } from './context-offloader.js';

// ============================================================================
// Types
// ============================================================================

export interface ContextManagerResult {
  success: boolean;
  phase: 'tracking' | 'warning' | 'critical';
  entriesTracked: number;
  tokenEstimate: number;
  contextPercentage: number;
  cullPlanGenerated: boolean;
  offloadAttempted: boolean;
  offloadSuccess: boolean;
  durationMs: number;
  error?: string;
}

// ============================================================================
// Worker Entry Point
// ============================================================================

export async function runContextManagerWorker(projectRoot: string): Promise<ContextManagerResult> {
  const start = Date.now();

  try {
    const shadow = new ContextShadow(projectRoot);
    await shadow.initialize();

    const transcriptPath = findActiveTranscript(projectRoot);
    if (!transcriptPath) {
      return makeResult({ success: true, durationMs: Date.now() - start });
    }

    const sessionId = getActiveSessionId(projectRoot) || 'default';
    const state = await shadow.updateFromTranscript(transcriptPath, sessionId);

    const reranker = new ContextReranker(shadow);
    const result = await reranker.rerank(sessionId);

    let offloadAttempted = false;
    let offloadSuccess = false;

    if (result.phase !== 'tracking') {
      const offloader = new ContextOffloader();
      if (offloader.isEnabled()) {
        const availability = offloader.checkProviders();
        if (availability.recommended) {
          offloadAttempted = true;
          const entries = await shadow.getAll(sessionId);
          const request = offloader.buildRequest(sessionId, entries, result.phase as 'warning' | 'critical');
          const prompt = offloader.buildOffloadPrompt(request);
          saveOffloadRequest(projectRoot, prompt, availability.recommended);
          offloadSuccess = true;
        }
      }
    }

    if (result.cullPlan) {
      saveCullPlan(projectRoot, result.cullPlan);
    }

    return makeResult({
      success: true,
      phase: result.phase,
      entriesTracked: result.entriesRanked,
      tokenEstimate: state.totalTokens,
      contextPercentage: state.contextPercentage,
      cullPlanGenerated: result.cullPlan !== null,
      offloadAttempted,
      offloadSuccess,
      durationMs: Date.now() - start,
    });
  } catch (error) {
    return makeResult({
      success: false,
      durationMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ============================================================================
// Helpers
// ============================================================================

function makeResult(partial: Partial<ContextManagerResult>): ContextManagerResult {
  return {
    success: false,
    phase: 'tracking',
    entriesTracked: 0,
    tokenEstimate: 0,
    contextPercentage: 0,
    cullPlanGenerated: false,
    offloadAttempted: false,
    offloadSuccess: false,
    durationMs: 0,
    ...partial,
  };
}

function findActiveTranscript(projectRoot: string): string | null {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const claudeDir = join(homeDir, '.claude', 'projects');
  if (!existsSync(claudeDir)) return null;

  const projectKey = projectRoot.replace(/\//g, '-');
  const transcriptDir = join(claudeDir, projectKey);
  if (!existsSync(transcriptDir)) return null;

  try {
    const files = readdirSync(transcriptDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ path: join(transcriptDir, f), mtime: statSync(join(transcriptDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? files[0].path : null;
  } catch {
    return null;
  }
}

function getActiveSessionId(projectRoot: string): string | null {
  try {
    const sessionFile = join(projectRoot, '.claude-flow', 'data', 'active-session.json');
    if (existsSync(sessionFile)) {
      const data = JSON.parse(readFileSync(sessionFile, 'utf-8'));
      return data.sessionId || null;
    }
  } catch { /* non-fatal */ }
  return null;
}

function saveCullPlan(projectRoot: string, plan: CullPlan): void {
  try {
    const dataDir = join(projectRoot, '.claude-flow', 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'cull-plan.json'), JSON.stringify(plan, null, 2), 'utf-8');
  } catch { /* non-fatal */ }
}

function saveOffloadRequest(projectRoot: string, prompt: string, provider: string): void {
  try {
    const dataDir = join(projectRoot, '.claude-flow', 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, 'offload-request.json'),
      JSON.stringify({ prompt, provider, timestamp: Date.now() }),
      'utf-8',
    );
  } catch { /* non-fatal */ }
}

export default runContextManagerWorker;
