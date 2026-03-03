/**
 * Context Manager CLI Command
 *
 * Manage proactive context window optimization.
 * Subcommands: status, rerank, shadow, cull-plan
 *
 * @module v3/cli/commands/context-manager
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ============================================================================
// Subcommands
// ============================================================================

const statusSubcommand: Command = {
  name: 'status',
  description: 'Show context manager status',
  options: [
    { name: 'json', short: 'j', type: 'boolean', description: 'Output as JSON' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const dataDir = join(process.cwd(), '.claude-flow', 'data');
    const shadowPath = join(dataDir, 'shadow-context.json');
    const cullPath = join(dataDir, 'cull-plan.json');
    const hasShadow = existsSync(shadowPath);
    const hasCull = existsSync(cullPath);

    if (ctx.flags.json) {
      const result: Record<string, unknown> = { shadowExists: hasShadow, cullPlanExists: hasCull };
      if (hasShadow) {
        try {
          const data = JSON.parse(readFileSync(shadowPath, 'utf-8'));
          result.entries = data.entries?.length || 0;
          result.lastUpdated = data.updatedAt;
        } catch { /* ignore */ }
      }
      if (hasCull) {
        try { result.cullPlan = JSON.parse(readFileSync(cullPath, 'utf-8')); } catch { /* ignore */ }
      }
      output.writeln(JSON.stringify(result, null, 2));
    } else {
      output.writeln('Context Manager Status');
      output.writeln('\u2500'.repeat(40));
      output.writeln(`Shadow copy: ${hasShadow ? 'Active' : 'Not initialized'}`);
      if (hasShadow) {
        try {
          const data = JSON.parse(readFileSync(shadowPath, 'utf-8'));
          output.writeln(`  Entries: ${data.entries?.length || 0}`);
          output.writeln(`  Last updated: ${new Date(data.updatedAt).toISOString()}`);
        } catch { /* ignore */ }
      }
      output.writeln(`Cull plan: ${hasCull ? 'Available' : 'None'}`);
      if (hasCull) {
        try {
          const plan = JSON.parse(readFileSync(cullPath, 'utf-8'));
          output.writeln(`  Phase: ${plan.phase}`);
          output.writeln(`  Entries to cull: ${plan.entriesToCull?.length || 0}`);
          output.writeln(`  Tokens freed: ${plan.tokensFreed || 0}`);
        } catch { /* ignore */ }
      }
    }
    return { success: true };
  },
};

const rerankSubcommand: Command = {
  name: 'rerank',
  description: 'Trigger manual re-ranking cycle',
  options: [],
  action: async (): Promise<CommandResult> => {
    try {
      const { runContextManagerWorker } = await import('../services/context-manager-worker.js');
      const result = await runContextManagerWorker(process.cwd());
      if (result.success) {
        output.writeln(`Re-ranking complete (${result.durationMs}ms)`);
        output.writeln(`  Phase: ${result.phase}`);
        output.writeln(`  Entries ranked: ${result.entriesTracked}`);
        output.writeln(`  Context usage: ${(result.contextPercentage * 100).toFixed(1)}%`);
        if (result.cullPlanGenerated) output.writeln('  Cull plan generated');
      } else {
        output.writeln(`Re-ranking failed: ${result.error}`);
      }
      return { success: result.success };
    } catch (error) {
      output.writeln(`Error: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false };
    }
  },
};

const shadowSubcommand: Command = {
  name: 'shadow',
  description: 'Show shadow copy entries',
  options: [
    { name: 'limit', short: 'l', type: 'number', description: 'Max entries to show', default: '10' },
    { name: 'sort', type: 'string', description: 'Sort by: rank, recency, tokens', default: 'rank' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const shadowPath = join(process.cwd(), '.claude-flow', 'data', 'shadow-context.json');
    if (!existsSync(shadowPath)) {
      output.writeln('No shadow copy found. Run context-manager rerank first.');
      return { success: false };
    }
    try {
      const data = JSON.parse(readFileSync(shadowPath, 'utf-8'));
      const entries = data.entries || [];
      const limit = parseInt(ctx.flags.limit as string || '10', 10);
      const sort = ctx.flags.sort as string || 'rank';

      let sorted = [...entries];
      if (sort === 'rank') sorted.sort((a: Record<string, number>, b: Record<string, number>) => (a.importanceRank || 999) - (b.importanceRank || 999));
      else if (sort === 'recency') sorted.sort((a: Record<string, number>, b: Record<string, number>) => b.createdAt - a.createdAt);
      else if (sort === 'tokens') sorted.sort((a: Record<string, number>, b: Record<string, number>) => b.tokenEstimate - a.tokenEstimate);
      sorted = sorted.slice(0, limit);

      output.writeln(`Shadow Copy (${entries.length} total, showing ${sorted.length})`);
      output.writeln('\u2500'.repeat(60));
      for (const e of sorted) {
        const rank = e.importanceRank ? `#${e.importanceRank}` : 'unranked';
        const score = e.importanceScore ? e.importanceScore.toFixed(3) : '-.---';
        const preview = (e.summaryShort || e.content || '').slice(0, 60);
        output.writeln(`  ${rank.padEnd(8)} score=${score} tokens=${String(e.tokenEstimate).padEnd(6)} ${e.role}: ${preview}...`);
      }
    } catch (error) {
      output.writeln(`Error: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false };
    }
    return { success: true };
  },
};

const cullPlanSubcommand: Command = {
  name: 'cull-plan',
  description: 'Show current cull plan',
  options: [
    { name: 'json', short: 'j', type: 'boolean', description: 'Output as JSON' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const cullPath = join(process.cwd(), '.claude-flow', 'data', 'cull-plan.json');
    if (!existsSync(cullPath)) {
      output.writeln('No cull plan found. Context may not be at warning/critical levels.');
      return { success: true };
    }
    try {
      const plan = JSON.parse(readFileSync(cullPath, 'utf-8'));
      if (ctx.flags.json) {
        output.writeln(JSON.stringify(plan, null, 2));
      } else {
        output.writeln(`Cull Plan (${plan.phase} phase)`);
        output.writeln('\u2500'.repeat(50));
        output.writeln(`  Created: ${new Date(plan.createdAt).toISOString()}`);
        output.writeln(`  Total entries: ${plan.totalEntries}`);
        output.writeln(`  Tokens freed: ${plan.tokensFreed}`);
        output.writeln(`  Tokens retained: ${plan.tokensRetained}`);
        output.writeln(`\n  Entries to cull (${plan.entriesToCull?.length || 0}):`);
        for (const e of (plan.entriesToCull || []).slice(0, 5)) {
          output.writeln(`    #${e.rank} score=${e.score.toFixed(3)} tokens=${e.tokenEstimate}: ${e.summaryShort}`);
        }
        if ((plan.entriesToCull?.length || 0) > 5) output.writeln(`    ... and ${plan.entriesToCull.length - 5} more`);
        output.writeln(`\n  Entries to summarize (${plan.entriesToSummarize?.length || 0}):`);
        for (const e of (plan.entriesToSummarize || []).slice(0, 5)) {
          output.writeln(`    #${e.rank}: ${(e.summaryLong || '').slice(0, 80)}...`);
        }
      }
    } catch (error) {
      output.writeln(`Error: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false };
    }
    return { success: true };
  },
};

// ============================================================================
// Main Command
// ============================================================================

export const contextManagerCommand: Command = {
  name: 'context-manager',
  description: 'Manage context window optimization',
  aliases: ['ctx'],
  subcommands: [statusSubcommand, rerankSubcommand, shadowSubcommand, cullPlanSubcommand],
  options: [],
  action: async (): Promise<CommandResult> => {
    output.writeln('Context Manager - Proactive context window optimization');
    output.writeln('');
    output.writeln('Subcommands:');
    output.writeln('  status      Show context manager status');
    output.writeln('  rerank      Trigger manual re-ranking cycle');
    output.writeln('  shadow      Show shadow copy entries');
    output.writeln('  cull-plan   Show current cull plan');
    output.writeln('');
    output.writeln('Usage: claude-flow context-manager <subcommand>');
    return { success: true };
  },
};

export default contextManagerCommand;
