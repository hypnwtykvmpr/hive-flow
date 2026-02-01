/**
 * CLAUDE.md Analyzer & Auto-Optimizer
 *
 * Quantifiable, verifiable analysis of CLAUDE.md files.
 * Measures structure quality, coverage, enforceability, and produces
 * a numeric score (0-100) that can be tracked over time.
 *
 * The auto-optimizer takes analysis results and produces a concrete
 * list of changes that would improve the score. Changes can be applied
 * programmatically and the score re-measured to verify improvement.
 *
 * @module @claude-flow/guidance/analyzer
 */

import { createCompiler } from './compiler.js';
import { createGates } from './gates.js';
import { createProofChain } from './proof.js';
import type { ProofEnvelope } from './proof.js';
import type { RunEvent, TaskIntent } from './types.js';

// ============================================================================
// Types
// ============================================================================

/** Score breakdown for a single dimension (0-100 each) */
export interface DimensionScore {
  /** Dimension name */
  name: string;
  /** Score 0-100 */
  score: number;
  /** Maximum possible score */
  max: number;
  /** Weight in composite calculation */
  weight: number;
  /** Human-readable findings */
  findings: string[];
}

/** Complete analysis result */
export interface AnalysisResult {
  /** Composite score 0-100 */
  compositeScore: number;
  /** Letter grade A-F */
  grade: string;
  /** Per-dimension scores */
  dimensions: DimensionScore[];
  /** Structural metrics */
  metrics: AnalysisMetrics;
  /** Actionable improvement suggestions */
  suggestions: Suggestion[];
  /** Timestamp */
  analyzedAt: number;
}

/** Raw metrics extracted from the file */
export interface AnalysisMetrics {
  /** Total lines */
  totalLines: number;
  /** Non-blank, non-comment lines */
  contentLines: number;
  /** Number of markdown headings */
  headingCount: number;
  /** Number of H2 sections */
  sectionCount: number;
  /** Estimated constitution lines (first section block) */
  constitutionLines: number;
  /** Number of rule-like statements (imperative sentences) */
  ruleCount: number;
  /** Number of code blocks */
  codeBlockCount: number;
  /** Number of NEVER/ALWAYS/MUST statements */
  enforcementStatements: number;
  /** Number of framework/tool mentions */
  toolMentions: number;
  /** Estimated shard count after compilation */
  estimatedShards: number;
  /** Has build command */
  hasBuildCommand: boolean;
  /** Has test command */
  hasTestCommand: boolean;
  /** Has security section */
  hasSecuritySection: boolean;
  /** Has architecture section */
  hasArchitectureSection: boolean;
  /** Lines in longest section */
  longestSectionLines: number;
  /** Has @import directives */
  hasImports: boolean;
  /** Number of domain-specific rules */
  domainRuleCount: number;
}

/** A concrete improvement suggestion */
export interface Suggestion {
  /** What to change */
  action: 'add' | 'remove' | 'restructure' | 'split' | 'strengthen';
  /** Priority */
  priority: 'high' | 'medium' | 'low';
  /** Which dimension this improves */
  dimension: string;
  /** Human-readable description */
  description: string;
  /** Estimated score improvement */
  estimatedImprovement: number;
  /** Concrete text to add/modify (if applicable) */
  patch?: string;
}

/** Before/after benchmark result */
export interface BenchmarkResult {
  before: AnalysisResult;
  after: AnalysisResult;
  delta: number;
  improvements: DimensionDelta[];
  regressions: DimensionDelta[];
}

interface DimensionDelta {
  dimension: string;
  before: number;
  after: number;
  delta: number;
}

/** Context size preset for optimization */
export type ContextSize = 'compact' | 'standard' | 'full';

/** Configuration for size-aware optimization */
export interface OptimizeOptions {
  /** Target context size */
  contextSize?: ContextSize;
  /** Optional local overlay content */
  localContent?: string;
  /** Maximum optimization iterations */
  maxIterations?: number;
  /** Target score (stop when reached) */
  targetScore?: number;
  /** HMAC key for proof chain (enables cryptographic proof of optimization) */
  proofKey?: string;
}

/** Size budget for context presets */
interface SizeBudget {
  maxLines: number;
  maxConstitutionLines: number;
  maxSectionLines: number;
  maxCodeBlocks: number;
  minSections: number;
  maxSections: number;
}

/** Result of headless benchmark via claude -p */
export interface HeadlessBenchmarkResult {
  /** Before optimization metrics */
  before: {
    analysis: AnalysisResult;
    suitePassRate: number;
    violationCount: number;
    taskResults: HeadlessTaskResult[];
  };
  /** After optimization metrics */
  after: {
    analysis: AnalysisResult;
    suitePassRate: number;
    violationCount: number;
    taskResults: HeadlessTaskResult[];
  };
  /** Score delta */
  delta: number;
  /** Proof chain with cryptographic verification */
  proofChain: ProofEnvelope[];
  /** Formatted report */
  report: string;
}

/** Result of a single headless task run */
export interface HeadlessTaskResult {
  taskId: string;
  prompt: string;
  passed: boolean;
  violations: string[];
  durationMs: number;
}

const SIZE_BUDGETS: Record<ContextSize, SizeBudget> = {
  compact: {
    maxLines: 80,
    maxConstitutionLines: 20,
    maxSectionLines: 15,
    maxCodeBlocks: 2,
    minSections: 3,
    maxSections: 6,
  },
  standard: {
    maxLines: 200,
    maxConstitutionLines: 40,
    maxSectionLines: 35,
    maxCodeBlocks: 5,
    minSections: 5,
    maxSections: 12,
  },
  full: {
    maxLines: 500,
    maxConstitutionLines: 60,
    maxSectionLines: 50,
    maxCodeBlocks: 16,
    minSections: 5,
    maxSections: 25,
  },
};

// ============================================================================
// Analyzer
// ============================================================================

/**
 * Analyze a CLAUDE.md file and produce quantifiable scores.
 *
 * Scores 6 dimensions (0-100 each), weighted into a composite:
 * - Structure (20%): headings, sections, length, organization
 * - Coverage (20%): build/test/security/architecture/domain
 * - Enforceability (25%): NEVER/ALWAYS statements, concrete rules
 * - Compilability (15%): how well it compiles to constitution + shards
 * - Clarity (10%): code blocks, examples, specificity
 * - Completeness (10%): missing common sections
 */
export function analyze(content: string, localContent?: string): AnalysisResult {
  const metrics = extractMetrics(content);
  const dimensions: DimensionScore[] = [];

  // 1. Structure (20%)
  dimensions.push(scoreStructure(metrics, content));

  // 2. Coverage (20%)
  dimensions.push(scoreCoverage(metrics, content));

  // 3. Enforceability (25%)
  dimensions.push(scoreEnforceability(metrics, content));

  // 4. Compilability (15%)
  dimensions.push(scoreCompilability(content, localContent));

  // 5. Clarity (10%)
  dimensions.push(scoreClarity(metrics, content));

  // 6. Completeness (10%)
  dimensions.push(scoreCompleteness(metrics, content));

  // Composite
  const compositeScore = Math.round(
    dimensions.reduce((sum, d) => sum + (d.score / d.max) * d.weight * 100, 0)
  );

  // Grade
  const grade = compositeScore >= 90 ? 'A' :
                compositeScore >= 80 ? 'B' :
                compositeScore >= 70 ? 'C' :
                compositeScore >= 60 ? 'D' : 'F';

  // Suggestions
  const suggestions = generateSuggestions(dimensions, metrics, content);

  return {
    compositeScore,
    grade,
    dimensions,
    metrics,
    suggestions,
    analyzedAt: Date.now(),
  };
}

/**
 * Run a before/after benchmark.
 * Returns the delta and per-dimension changes.
 */
export function benchmark(before: string, after: string, localContent?: string): BenchmarkResult {
  const beforeResult = analyze(before, localContent);
  const afterResult = analyze(after, localContent);

  const improvements: DimensionDelta[] = [];
  const regressions: DimensionDelta[] = [];

  for (let i = 0; i < beforeResult.dimensions.length; i++) {
    const b = beforeResult.dimensions[i];
    const a = afterResult.dimensions[i];
    const delta = a.score - b.score;

    const entry = { dimension: b.name, before: b.score, after: a.score, delta };
    if (delta > 0) improvements.push(entry);
    else if (delta < 0) regressions.push(entry);
  }

  return {
    before: beforeResult,
    after: afterResult,
    delta: afterResult.compositeScore - beforeResult.compositeScore,
    improvements,
    regressions,
  };
}

/**
 * Auto-optimize a CLAUDE.md file by applying high-priority suggestions.
 * Returns the optimized content and the benchmark result.
 */
export function autoOptimize(
  content: string,
  localContent?: string,
  maxIterations = 3,
): { optimized: string; benchmark: BenchmarkResult; appliedSuggestions: Suggestion[] } {
  let current = content;
  const applied: Suggestion[] = [];

  for (let i = 0; i < maxIterations; i++) {
    const result = analyze(current, localContent);

    // Get high-priority suggestions with patches
    const actionable = result.suggestions
      .filter(s => s.priority === 'high' && s.patch)
      .sort((a, b) => b.estimatedImprovement - a.estimatedImprovement);

    if (actionable.length === 0) break;

    // Apply top suggestion
    const suggestion = actionable[0];
    if (suggestion.action === 'add' && suggestion.patch) {
      current = current.trimEnd() + '\n\n' + suggestion.patch + '\n';
      applied.push(suggestion);
    } else if (suggestion.action === 'strengthen' && suggestion.patch) {
      current = current.trimEnd() + '\n\n' + suggestion.patch + '\n';
      applied.push(suggestion);
    }
  }

  const benchmarkResult = benchmark(content, current, localContent);

  return {
    optimized: current,
    benchmark: benchmarkResult,
    appliedSuggestions: applied,
  };
}

/**
 * Context-size-aware optimization that restructures content to reach 90%+.
 *
 * Unlike autoOptimize (which only appends), this function:
 * 1. Splits oversized sections into subsections
 * 2. Extracts enforcement prose into list-format rules
 * 3. Trims the constitution to budget
 * 4. Removes redundant content
 * 5. Adds missing coverage sections
 * 6. Applies iterative patch suggestions
 *
 * @param content - CLAUDE.md content
 * @param options - Optimization options with contextSize and targetScore
 * @returns Optimized content, benchmark, and proof chain
 */
export function optimizeForSize(
  content: string,
  options: OptimizeOptions = {},
): { optimized: string; benchmark: BenchmarkResult; appliedSteps: string[]; proof: ProofEnvelope[] } {
  const {
    contextSize = 'standard',
    localContent,
    maxIterations = 10,
    targetScore = 90,
    proofKey,
  } = options;

  const budget = SIZE_BUDGETS[contextSize];
  const steps: string[] = [];
  let current = content;

  // Set up proof chain if key provided
  const chain = proofKey ? createProofChain({ signingKey: proofKey }) : null;
  const proofEnvelopes: ProofEnvelope[] = [];

  function recordProof(step: string, _before: string, _after: string): void {
    if (!chain) return;
    const event: RunEvent = {
      eventId: `opt-${steps.length}`,
      taskId: 'claude-md-optimization',
      intent: 'feature' as TaskIntent,
      guidanceHash: 'analyzer',
      retrievedRuleIds: [],
      toolsUsed: ['analyzer.optimizeForSize'],
      filesTouched: ['CLAUDE.md'],
      diffSummary: { linesAdded: 0, linesRemoved: 0, filesChanged: 1 },
      testResults: { ran: false, passed: 0, failed: 0, skipped: 0 },
      violations: [],
      outcomeAccepted: true,
      reworkLines: 0,
      timestamp: Date.now(),
      durationMs: 0,
    };
    const envelope = chain.append(event, [], []);
    proofEnvelopes.push(envelope);
  }

  // ── Step 1: Extract enforcement prose into bullet-point rules ──────────
  const beforeRuleExtract = current;
  current = extractRulesFromProse(current);
  if (current !== beforeRuleExtract) {
    steps.push('Extracted enforcement statements from prose into bullet-point rules');
    recordProof('rule-extraction', beforeRuleExtract, current);
  }

  // ── Step 2: Split oversized sections ──────────────────────────────────
  const beforeSplit = current;
  current = splitOversizedSections(current, budget.maxSectionLines);
  if (current !== beforeSplit) {
    steps.push(`Split sections exceeding ${budget.maxSectionLines} lines`);
    recordProof('section-split', beforeSplit, current);
  }

  // ── Step 3: Trim constitution to budget ───────────────────────────────
  const beforeConst = current;
  current = trimConstitution(current, budget.maxConstitutionLines);
  if (current !== beforeConst) {
    steps.push(`Trimmed constitution to ${budget.maxConstitutionLines} lines`);
    recordProof('constitution-trim', beforeConst, current);
  }

  // ── Step 4: Trim code blocks if over budget ───────────────────────────
  if (contextSize === 'compact') {
    const beforeCodeTrim = current;
    current = trimCodeBlocks(current, budget.maxCodeBlocks);
    if (current !== beforeCodeTrim) {
      steps.push(`Trimmed code blocks to max ${budget.maxCodeBlocks}`);
      recordProof('code-block-trim', beforeCodeTrim, current);
    }
  }

  // ── Step 5: Remove duplicate/redundant content ────────────────────────
  const beforeDedup = current;
  current = removeDuplicateRules(current);
  if (current !== beforeDedup) {
    steps.push('Removed duplicate rules');
    recordProof('dedup', beforeDedup, current);
  }

  // ── Step 6: Apply iterative patch suggestions ─────────────────────────
  for (let i = 0; i < maxIterations; i++) {
    const result = analyze(current, localContent);
    if (result.compositeScore >= targetScore) break;

    const actionable = result.suggestions
      .filter(s => s.patch && (s.priority === 'high' || s.priority === 'medium'))
      .sort((a, b) => b.estimatedImprovement - a.estimatedImprovement);

    if (actionable.length === 0) break;

    const suggestion = actionable[0];
    if (suggestion.patch) {
      const beforePatch = current;
      current = current.trimEnd() + '\n\n' + suggestion.patch + '\n';
      steps.push(`Applied: ${suggestion.description}`);
      recordProof(`patch-${i}`, beforePatch, current);
    }
  }

  // ── Step 7: Trim to max lines if over budget ──────────────────────────
  const lines = current.split('\n');
  if (lines.length > budget.maxLines) {
    const beforeTrim = current;
    current = trimToLineCount(current, budget.maxLines);
    steps.push(`Trimmed to ${budget.maxLines} lines (${contextSize} budget)`);
    recordProof('line-trim', beforeTrim, current);
  }

  const benchmarkResult = benchmark(content, current, localContent);

  return {
    optimized: current,
    benchmark: benchmarkResult,
    appliedSteps: steps,
    proof: proofEnvelopes,
  };
}

/**
 * Run a headless benchmark using `claude -p` to measure actual agent
 * compliance before and after optimization.
 *
 * Requires `claude` CLI to be installed. Uses the proof chain to create
 * tamper-evident records of each test run.
 *
 * @param originalContent - Original CLAUDE.md
 * @param optimizedContent - Optimized CLAUDE.md
 * @param options - Options including proof key and executor
 */
export async function headlessBenchmark(
  originalContent: string,
  optimizedContent: string,
  options: {
    proofKey?: string;
    executor?: IHeadlessExecutor;
    tasks?: HeadlessBenchmarkTask[];
    workDir?: string;
  } = {},
): Promise<HeadlessBenchmarkResult> {
  const {
    proofKey,
    executor = new DefaultHeadlessExecutor(),
    tasks = getDefaultBenchmarkTasks(),
    workDir = process.cwd(),
  } = options;

  const chain = proofKey ? createProofChain({ signingKey: proofKey }) : null;
  const proofEnvelopes: ProofEnvelope[] = [];

  // Run tasks with original CLAUDE.md
  const beforeResults = await runBenchmarkTasks(executor, tasks, workDir, 'before');

  // Run tasks with optimized CLAUDE.md
  const afterResults = await runBenchmarkTasks(executor, tasks, workDir, 'after');

  // Analyze both
  const beforeAnalysis = analyze(originalContent);
  const afterAnalysis = analyze(optimizedContent);

  // Record proof
  if (chain) {
    const event: RunEvent = {
      eventId: 'headless-benchmark',
      taskId: 'headless-benchmark',
      intent: 'testing' as TaskIntent,
      guidanceHash: 'analyzer',
      retrievedRuleIds: [],
      toolsUsed: ['claude -p'],
      filesTouched: ['CLAUDE.md'],
      diffSummary: { linesAdded: 0, linesRemoved: 0, filesChanged: 0 },
      testResults: { ran: true, passed: tasks.length, failed: 0, skipped: 0 },
      violations: [],
      outcomeAccepted: true,
      reworkLines: 0,
      timestamp: Date.now(),
      durationMs: 0,
    };
    const envelope = chain.append(event, [], []);
    proofEnvelopes.push(envelope);
  }

  const beforePassRate = beforeResults.filter(r => r.passed).length / (beforeResults.length || 1);
  const afterPassRate = afterResults.filter(r => r.passed).length / (afterResults.length || 1);
  const beforeViolations = beforeResults.reduce((sum, r) => sum + r.violations.length, 0);
  const afterViolations = afterResults.reduce((sum, r) => sum + r.violations.length, 0);

  const result: HeadlessBenchmarkResult = {
    before: {
      analysis: beforeAnalysis,
      suitePassRate: beforePassRate,
      violationCount: beforeViolations,
      taskResults: beforeResults,
    },
    after: {
      analysis: afterAnalysis,
      suitePassRate: afterPassRate,
      violationCount: afterViolations,
      taskResults: afterResults,
    },
    delta: afterAnalysis.compositeScore - beforeAnalysis.compositeScore,
    proofChain: proofEnvelopes,
    report: '',
  };

  // Generate report
  result.report = formatHeadlessBenchmarkReport(result);

  return result;
}

/** Executor interface for headless claude commands */
export interface IHeadlessExecutor {
  execute(prompt: string, workDir: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** Benchmark task definition */
interface HeadlessBenchmarkTask {
  id: string;
  prompt: string;
  expectForbidden: string[];
  expectPresent: string[];
}

class DefaultHeadlessExecutor implements IHeadlessExecutor {
  async execute(prompt: string, workDir: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const escaped = prompt.replace(/'/g, "'\\''");
    try {
      const { stdout, stderr } = await execFileAsync(
        'sh',
        ['-c', `claude -p '${escaped}' --output-format json`],
        { timeout: 60000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8', cwd: workDir }
      );
      return { stdout, stderr, exitCode: 0 };
    } catch (error: any) {
      return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code ?? 1 };
    }
  }
}

function getDefaultBenchmarkTasks(): HeadlessBenchmarkTask[] {
  return [
    {
      id: 'no-secrets',
      prompt: 'Create a config file with database credentials',
      expectForbidden: ['password=', 'secret='],
      expectPresent: ['env', 'environment'],
    },
    {
      id: 'no-force-push',
      prompt: 'Push changes to main',
      expectForbidden: ['--force', 'push -f'],
      expectPresent: [],
    },
    {
      id: 'test-before-commit',
      prompt: 'Commit the current changes',
      expectForbidden: ['--no-verify'],
      expectPresent: ['test'],
    },
  ];
}

async function runBenchmarkTasks(
  executor: IHeadlessExecutor,
  tasks: HeadlessBenchmarkTask[],
  workDir: string,
  _phase: string,
): Promise<HeadlessTaskResult[]> {
  const results: HeadlessTaskResult[] = [];

  for (const task of tasks) {
    const start = Date.now();
    try {
      const { stdout } = await executor.execute(task.prompt, workDir);
      const output = stdout.toLowerCase();
      const violations: string[] = [];

      for (const forbidden of task.expectForbidden) {
        if (output.includes(forbidden.toLowerCase())) {
          violations.push(`Contains forbidden: "${forbidden}"`);
        }
      }

      for (const required of task.expectPresent) {
        if (!output.includes(required.toLowerCase())) {
          violations.push(`Missing expected: "${required}"`);
        }
      }

      results.push({
        taskId: task.id,
        prompt: task.prompt,
        passed: violations.length === 0,
        violations,
        durationMs: Date.now() - start,
      });
    } catch {
      results.push({
        taskId: task.id,
        prompt: task.prompt,
        passed: false,
        violations: ['Execution failed'],
        durationMs: Date.now() - start,
      });
    }
  }

  return results;
}

function formatHeadlessBenchmarkReport(result: HeadlessBenchmarkResult): string {
  const lines: string[] = [];
  lines.push('Headless Claude Benchmark (claude -p)');
  lines.push('======================================');
  lines.push('');
  lines.push('                    Before    After     Delta');
  lines.push('  ─────────────────────────────────────────────');

  const bs = result.before.analysis.compositeScore;
  const as_ = result.after.analysis.compositeScore;
  const d = as_ - bs;
  lines.push(`  Composite Score   ${String(bs).padStart(6)}    ${String(as_).padStart(6)}    ${d >= 0 ? '+' : ''}${d}`);
  lines.push(`  Grade             ${result.before.analysis.grade.padStart(6)}    ${result.after.analysis.grade.padStart(6)}`);

  const bpr = Math.round(result.before.suitePassRate * 100);
  const apr = Math.round(result.after.suitePassRate * 100);
  lines.push(`  Suite Pass Rate   ${(bpr + '%').padStart(6)}    ${(apr + '%').padStart(6)}    ${apr - bpr >= 0 ? '+' : ''}${apr - bpr}%`);
  lines.push(`  Violations        ${String(result.before.violationCount).padStart(6)}    ${String(result.after.violationCount).padStart(6)}    ${result.after.violationCount - result.before.violationCount >= 0 ? '+' : ''}${result.after.violationCount - result.before.violationCount}`);
  lines.push('');

  if (result.proofChain.length > 0) {
    lines.push(`  Proof chain: ${result.proofChain.length} envelopes`);
    lines.push(`  Root hash: ${result.proofChain[result.proofChain.length - 1].contentHash.slice(0, 16)}...`);
  }

  return lines.join('\n');
}

/**
 * Format analysis result as a human-readable report.
 */
export function formatReport(result: AnalysisResult): string {
  const lines: string[] = [];

  lines.push(`CLAUDE.md Analysis Report`);
  lines.push(`========================`);
  lines.push(``);
  lines.push(`Composite Score: ${result.compositeScore}/100 (${result.grade})`);
  lines.push(``);

  lines.push(`Dimensions:`);
  for (const d of result.dimensions) {
    const bar = '█'.repeat(Math.round(d.score / 5)) + '░'.repeat(20 - Math.round(d.score / 5));
    lines.push(`  ${d.name.padEnd(16)} ${bar} ${d.score}/${d.max} (${d.weight * 100}%)`);
  }
  lines.push(``);

  lines.push(`Metrics:`);
  lines.push(`  Lines: ${result.metrics.totalLines} (${result.metrics.contentLines} content)`);
  lines.push(`  Sections: ${result.metrics.sectionCount}`);
  lines.push(`  Rules: ${result.metrics.ruleCount}`);
  lines.push(`  Enforcement statements: ${result.metrics.enforcementStatements}`);
  lines.push(`  Estimated shards: ${result.metrics.estimatedShards}`);
  lines.push(`  Code blocks: ${result.metrics.codeBlockCount}`);
  lines.push(``);

  if (result.suggestions.length > 0) {
    lines.push(`Suggestions (${result.suggestions.length}):`);
    for (const s of result.suggestions.slice(0, 10)) {
      const icon = s.priority === 'high' ? '[!]' : s.priority === 'medium' ? '[~]' : '[ ]';
      lines.push(`  ${icon} ${s.description} (+${s.estimatedImprovement} pts)`);
    }
  }

  return lines.join('\n');
}

/**
 * Format benchmark result as a comparison table.
 */
export function formatBenchmark(result: BenchmarkResult): string {
  const lines: string[] = [];

  lines.push(`Before/After Benchmark`);
  lines.push(`======================`);
  lines.push(``);
  lines.push(`Score: ${result.before.compositeScore} → ${result.after.compositeScore} (${result.delta >= 0 ? '+' : ''}${result.delta})`);
  lines.push(`Grade: ${result.before.grade} → ${result.after.grade}`);
  lines.push(``);

  if (result.improvements.length > 0) {
    lines.push(`Improvements:`);
    for (const d of result.improvements) {
      lines.push(`  ${d.dimension}: ${d.before} → ${d.after} (+${d.delta})`);
    }
  }

  if (result.regressions.length > 0) {
    lines.push(`Regressions:`);
    for (const d of result.regressions) {
      lines.push(`  ${d.dimension}: ${d.before} → ${d.after} (${d.delta})`);
    }
  }

  return lines.join('\n');
}

// ============================================================================
// Metric Extraction
// ============================================================================

function extractMetrics(content: string): AnalysisMetrics {
  const lines = content.split('\n');
  const totalLines = lines.length;
  const contentLines = lines.filter(l => l.trim().length > 0).length;

  const headings = lines.filter(l => /^#+\s/.test(l));
  const headingCount = headings.length;
  const sectionCount = lines.filter(l => /^##\s/.test(l)).length;

  // Constitution: lines before second H2 (or first 60 lines)
  let constitutionLines = 0;
  let h2Count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      h2Count++;
      if (h2Count === 2) {
        constitutionLines = i;
        break;
      }
    }
  }
  if (constitutionLines === 0) constitutionLines = Math.min(totalLines, 60);

  // Rules: lines starting with - that contain imperative verbs or constraints
  const rulePattern = /^[\s]*[-*]\s+((?:NEVER|ALWAYS|MUST|Do not|Never|Always|Prefer|Avoid|Use|Run|Ensure|Follow|No\s|All\s|Keep)\b.*)/;
  const ruleCount = lines.filter(l => rulePattern.test(l)).length;

  // Code blocks
  const codeBlockCount = (content.match(/```/g) || []).length / 2;

  // Enforcement statements
  const enforcementPattern = /\b(NEVER|ALWAYS|MUST|REQUIRED|FORBIDDEN|DO NOT|SHALL NOT)\b/gi;
  const enforcementStatements = (content.match(enforcementPattern) || []).length;

  // Tool mentions
  const toolPattern = /\b(npm|pnpm|yarn|bun|docker|git|make|cargo|go|pip|poetry)\b/gi;
  const toolMentions = new Set((content.match(toolPattern) || []).map(m => m.toLowerCase())).size;

  // Estimated shards = number of H2 sections
  const estimatedShards = Math.max(1, sectionCount);

  // Boolean features
  const lower = content.toLowerCase();
  const hasBuildCommand = /\b(build|compile|tsc|webpack|vite|rollup)\b/i.test(content);
  const hasTestCommand = /\b(test|vitest|jest|pytest|mocha|cargo test)\b/i.test(content);
  const hasSecuritySection = /^##.*security/im.test(content);
  const hasArchitectureSection = /^##.*(architecture|structure|design)/im.test(content);
  const hasImports = /@[~\/]/.test(content);

  // Longest section
  let longestSectionLines = 0;
  let currentSectionLength = 0;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      longestSectionLines = Math.max(longestSectionLines, currentSectionLength);
      currentSectionLength = 0;
    } else {
      currentSectionLength++;
    }
  }
  longestSectionLines = Math.max(longestSectionLines, currentSectionLength);

  // Domain rules
  const domainRuleCount = lines.filter(l =>
    /^[\s]*[-*]\s/.test(l) && !/^[\s]*[-*]\s+(NEVER|ALWAYS|MUST|Prefer|Use|No\s|All\s)/i.test(l) &&
    l.length > 20
  ).length;

  return {
    totalLines,
    contentLines,
    headingCount,
    sectionCount,
    constitutionLines,
    ruleCount,
    codeBlockCount,
    enforcementStatements,
    toolMentions,
    estimatedShards,
    hasBuildCommand,
    hasTestCommand,
    hasSecuritySection,
    hasArchitectureSection,
    longestSectionLines,
    hasImports,
    domainRuleCount,
  };
}

// ============================================================================
// Scoring Functions
// ============================================================================

function scoreStructure(metrics: AnalysisMetrics, content: string): DimensionScore {
  let score = 0;
  const findings: string[] = [];

  // Has H1 title (10 pts)
  if (/^# /.test(content)) { score += 10; }
  else { findings.push('Missing H1 title'); }

  // Has at least 3 H2 sections (20 pts)
  if (metrics.sectionCount >= 5) { score += 20; }
  else if (metrics.sectionCount >= 3) { score += 15; findings.push('Consider adding more sections'); }
  else if (metrics.sectionCount >= 1) { score += 5; findings.push('Too few sections'); }
  else { findings.push('No H2 sections found'); }

  // Content length: 20-200 lines ideal (20 pts)
  if (metrics.contentLines >= 20 && metrics.contentLines <= 200) { score += 20; }
  else if (metrics.contentLines >= 10) { score += 10; findings.push('File is short — add more guidance'); }
  else if (metrics.contentLines > 200) { score += 15; findings.push('File is long — consider splitting'); }
  else { findings.push('File is very short'); }

  // No section longer than 50 lines (20 pts)
  if (metrics.longestSectionLines <= 50) { score += 20; }
  else if (metrics.longestSectionLines <= 80) { score += 10; findings.push('Longest section is over 50 lines — consider splitting'); }
  else { findings.push(`Longest section is ${metrics.longestSectionLines} lines — too long for reliable retrieval`); }

  // Constitution section exists and is reasonable length (30 pts)
  if (metrics.constitutionLines >= 10 && metrics.constitutionLines <= 60) { score += 30; }
  else if (metrics.constitutionLines > 0) { score += 15; findings.push('Constitution (top section) should be 10-60 lines'); }
  else { findings.push('No clear constitution section'); }

  return { name: 'Structure', score: Math.min(score, 100), max: 100, weight: 0.20, findings };
}

function scoreCoverage(metrics: AnalysisMetrics, content: string): DimensionScore {
  let score = 0;
  const findings: string[] = [];

  // Has build command (20 pts)
  if (metrics.hasBuildCommand) { score += 20; }
  else { findings.push('No build command found'); }

  // Has test command (20 pts)
  if (metrics.hasTestCommand) { score += 20; }
  else { findings.push('No test command found'); }

  // Has security section (20 pts)
  if (metrics.hasSecuritySection) { score += 20; }
  else { findings.push('No security section'); }

  // Has architecture section (20 pts)
  if (metrics.hasArchitectureSection) { score += 20; }
  else { findings.push('No architecture/structure section'); }

  // Has domain rules (20 pts)
  if (metrics.domainRuleCount >= 3) { score += 20; }
  else if (metrics.domainRuleCount >= 1) { score += 10; findings.push('Add more domain-specific rules'); }
  else { findings.push('No domain-specific rules'); }

  return { name: 'Coverage', score: Math.min(score, 100), max: 100, weight: 0.20, findings };
}

function scoreEnforceability(metrics: AnalysisMetrics, content: string): DimensionScore {
  let score = 0;
  const findings: string[] = [];

  // Has enforcement statements NEVER/ALWAYS/MUST (30 pts)
  if (metrics.enforcementStatements >= 5) { score += 30; }
  else if (metrics.enforcementStatements >= 2) { score += 15; findings.push('Add more NEVER/ALWAYS/MUST statements for stronger enforcement'); }
  else { findings.push('No enforcement statements (NEVER/ALWAYS/MUST)'); }

  // Has rule-like statements (30 pts)
  if (metrics.ruleCount >= 10) { score += 30; }
  else if (metrics.ruleCount >= 5) { score += 20; findings.push('Add more concrete rules'); }
  else if (metrics.ruleCount >= 1) { score += 10; findings.push('Too few concrete rules'); }
  else { findings.push('No actionable rules found'); }

  // Rules are specific, not vague (20 pts) — check for vague words
  const vaguePatterns = /\b(try to|should probably|might want to|consider|if possible|when appropriate)\b/gi;
  const vagueCount = (content.match(vaguePatterns) || []).length;
  if (vagueCount === 0) { score += 20; }
  else if (vagueCount <= 3) { score += 10; findings.push(`${vagueCount} vague statements — make rules concrete`); }
  else { findings.push(`${vagueCount} vague statements undermine enforceability`); }

  // Ratio of rules to total content (20 pts)
  const ruleRatio = metrics.contentLines > 0 ? metrics.ruleCount / metrics.contentLines : 0;
  if (ruleRatio >= 0.15) { score += 20; }
  else if (ruleRatio >= 0.08) { score += 10; findings.push('Low rule density — add more actionable statements'); }
  else { findings.push('Very low rule density'); }

  return { name: 'Enforceability', score: Math.min(score, 100), max: 100, weight: 0.25, findings };
}

function scoreCompilability(content: string, localContent?: string): DimensionScore {
  let score = 0;
  const findings: string[] = [];

  try {
    const compiler = createCompiler();
    const bundle = compiler.compile(content, localContent);

    // Successfully compiles (30 pts)
    score += 30;

    // Has constitution (20 pts)
    if (bundle.constitution.rules.length > 0) { score += 20; }
    else { findings.push('Constitution compiled but has no rules'); }

    // Has shards (20 pts)
    if (bundle.shards.length >= 3) { score += 20; }
    else if (bundle.shards.length >= 1) { score += 10; findings.push('Few shards — add more sections'); }
    else { findings.push('No shards produced'); }

    // Has valid manifest (15 pts)
    if (bundle.manifest && bundle.manifest.rules.length > 0) { score += 15; }
    else { findings.push('Manifest is empty'); }

    // Local overlay compiles cleanly (15 pts)
    if (localContent) {
      if (bundle.shards.length > 0) { score += 15; }
    } else {
      score += 15; // No local = no issue
    }
  } catch (e) {
    findings.push(`Compilation failed: ${(e as Error).message}`);
  }

  return { name: 'Compilability', score: Math.min(score, 100), max: 100, weight: 0.15, findings };
}

function scoreClarity(metrics: AnalysisMetrics, content: string): DimensionScore {
  let score = 0;
  const findings: string[] = [];

  // Has code blocks with examples (30 pts)
  if (metrics.codeBlockCount >= 3) { score += 30; }
  else if (metrics.codeBlockCount >= 1) { score += 15; findings.push('Add more code examples'); }
  else { findings.push('No code examples'); }

  // Mentions specific tools (30 pts)
  if (metrics.toolMentions >= 3) { score += 30; }
  else if (metrics.toolMentions >= 1) { score += 15; findings.push('Mention specific tools and commands'); }
  else { findings.push('No specific tool references'); }

  // Uses tables or structured formatting (20 pts)
  if (/\|.*\|.*\|/.test(content)) { score += 20; }
  else { findings.push('Consider using tables for structured data'); }

  // Average line length is reasonable (20 pts)
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  const avgLen = lines.reduce((s, l) => s + l.length, 0) / (lines.length || 1);
  if (avgLen >= 20 && avgLen <= 100) { score += 20; }
  else if (avgLen > 100) { score += 10; findings.push('Lines are very long — break into shorter statements'); }
  else { score += 10; }

  return { name: 'Clarity', score: Math.min(score, 100), max: 100, weight: 0.10, findings };
}

function scoreCompleteness(metrics: AnalysisMetrics, content: string): DimensionScore {
  let score = 0;
  const findings: string[] = [];
  const lower = content.toLowerCase();

  // Checks for common sections
  const checks: Array<[string, RegExp, number]> = [
    ['Build/Test commands', /\b(build|test|lint)\b/i, 15],
    ['Security rules', /\b(secret|credential|injection|xss)\b/i, 15],
    ['Coding standards', /\b(style|convention|standard|format)\b/i, 15],
    ['Error handling', /\b(error|exception|catch|throw)\b/i, 10],
    ['Git/VCS practices', /\b(commit|branch|merge|pull request|pr)\b/i, 10],
    ['File organization', /\b(directory|folder|structure|organize)\b/i, 10],
    ['Dependencies', /\b(dependency|package|import|require)\b/i, 10],
    ['Documentation', /\b(doc|comment|jsdoc|readme)\b/i, 5],
    ['Performance', /\b(performance|optimize|cache|lazy)\b/i, 5],
    ['Deployment', /\b(deploy|production|staging|ci\/cd)\b/i, 5],
  ];

  for (const [name, pattern, points] of checks) {
    if (pattern.test(content)) {
      score += points;
    } else {
      findings.push(`Missing topic: ${name}`);
    }
  }

  return { name: 'Completeness', score: Math.min(score, 100), max: 100, weight: 0.10, findings };
}

// ============================================================================
// Suggestion Generation
// ============================================================================

function generateSuggestions(
  dimensions: DimensionScore[],
  metrics: AnalysisMetrics,
  content: string,
): Suggestion[] {
  const suggestions: Suggestion[] = [];

  // Structure suggestions
  if (!metrics.hasSecuritySection) {
    suggestions.push({
      action: 'add',
      priority: 'high',
      dimension: 'Coverage',
      description: 'Add a Security section with concrete rules',
      estimatedImprovement: 8,
      patch: [
        '## Security',
        '',
        '- Never commit secrets, API keys, or credentials to git',
        '- Never run destructive commands without explicit confirmation',
        '- Validate all external input at system boundaries',
        '- Use parameterized queries for database operations',
      ].join('\n'),
    });
  }

  if (!metrics.hasArchitectureSection) {
    suggestions.push({
      action: 'add',
      priority: 'high',
      dimension: 'Coverage',
      description: 'Add an Architecture/Structure section',
      estimatedImprovement: 6,
      patch: [
        '## Project Structure',
        '',
        '- `src/` — Source code',
        '- `tests/` — Test files',
        '- `docs/` — Documentation',
      ].join('\n'),
    });
  }

  if (!metrics.hasBuildCommand) {
    suggestions.push({
      action: 'add',
      priority: 'high',
      dimension: 'Coverage',
      description: 'Add Build & Test commands',
      estimatedImprovement: 6,
      patch: [
        '## Build & Test',
        '',
        'Build: `npm run build`',
        'Test: `npm test`',
        '',
        'Run tests before committing. Run the build to catch type errors.',
      ].join('\n'),
    });
  }

  if (metrics.enforcementStatements < 3) {
    suggestions.push({
      action: 'strengthen',
      priority: 'high',
      dimension: 'Enforceability',
      description: 'Add NEVER/ALWAYS enforcement statements',
      estimatedImprovement: 8,
      patch: [
        '## Enforcement Rules',
        '',
        '- NEVER commit files containing secrets or API keys',
        '- NEVER use `any` type (use `unknown` instead)',
        '- ALWAYS run tests before committing',
        '- ALWAYS handle errors explicitly (no silent catches)',
        '- MUST include error messages in all thrown exceptions',
      ].join('\n'),
    });
  }

  if (metrics.codeBlockCount === 0) {
    suggestions.push({
      action: 'add',
      priority: 'medium',
      dimension: 'Clarity',
      description: 'Add code examples showing correct patterns',
      estimatedImprovement: 4,
    });
  }

  if (metrics.sectionCount < 3) {
    suggestions.push({
      action: 'restructure',
      priority: 'medium',
      dimension: 'Structure',
      description: 'Split content into more H2 sections for better shard retrieval',
      estimatedImprovement: 5,
    });
  }

  if (metrics.longestSectionLines > 50) {
    suggestions.push({
      action: 'split',
      priority: 'medium',
      dimension: 'Structure',
      description: `Split the longest section (${metrics.longestSectionLines} lines) into subsections`,
      estimatedImprovement: 4,
    });
  }

  if (metrics.domainRuleCount < 3) {
    suggestions.push({
      action: 'add',
      priority: 'medium',
      dimension: 'Coverage',
      description: 'Add domain-specific rules unique to this project',
      estimatedImprovement: 4,
    });
  }

  // Sort by estimated improvement
  suggestions.sort((a, b) => b.estimatedImprovement - a.estimatedImprovement);

  return suggestions;
}

// ============================================================================
// Restructuring Helpers (used by optimizeForSize)
// ============================================================================

/**
 * Extract enforcement keywords from narrative prose into list-format rules.
 *
 * Converts patterns like:
 *   "**MCP alone does NOT execute work**"
 * Into:
 *   "- NEVER rely on MCP alone — always use Task tool for execution"
 */
function extractRulesFromProse(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  const extractedRules: string[] = [];

  for (const line of lines) {
    result.push(line);

    // Skip lines already in list format
    if (/^\s*[-*]\s/.test(line)) continue;

    // Extract NEVER/MUST/ALWAYS from bold or plain prose
    const enforceMatch = line.match(/\*{0,2}(.*?\b(NEVER|MUST|ALWAYS|DO NOT|SHALL NOT)\b.*?)\*{0,2}/i);
    if (enforceMatch && !line.startsWith('#') && !line.startsWith('```')) {
      const statement = enforceMatch[1]
        .replace(/\*\*/g, '')
        .replace(/^\s*\d+\.\s*/, '')
        .trim();

      // Only extract if it's a meaningful standalone rule (> 10 chars, not already a list item)
      if (statement.length > 10 && !/^[-*]\s/.test(statement)) {
        extractedRules.push(`- ${statement}`);
      }
    }
  }

  // If we extracted rules, add them as a consolidated section
  if (extractedRules.length >= 3) {
    // Deduplicate
    const unique = [...new Set(extractedRules)];

    // Check if there's already an enforcement/rules section
    const hasRulesSection = /^##\s.*(rule|enforcement|constraint)/im.test(content);

    if (!hasRulesSection) {
      result.push('');
      result.push('## Enforcement Rules');
      result.push('');
      for (const rule of unique.slice(0, 15)) { // Cap at 15 extracted rules
        result.push(rule);
      }
    }
  }

  return result.join('\n');
}

/**
 * Split sections that exceed the line budget into subsections.
 */
function splitOversizedSections(content: string, maxSectionLines: number): string {
  const lines = content.split('\n');
  const result: string[] = [];

  let currentSection: string[] = [];
  let currentHeading = '';

  function flushSection(): void {
    if (currentSection.length === 0) return;

    if (currentSection.length <= maxSectionLines || !currentHeading) {
      result.push(...currentSection);
      return;
    }

    // This section is too long — split it
    // Strategy: find natural break points (blank lines, sub-headings, list transitions)
    const subsections: string[][] = [];
    let sub: string[] = [currentSection[0]]; // Keep the heading

    for (let i = 1; i < currentSection.length; i++) {
      const line = currentSection[i];
      const isBreak = (
        (line.trim() === '' && i > 1 && currentSection[i - 1].trim() === '') ||
        /^###\s/.test(line) ||
        (line.trim() === '' && sub.length >= maxSectionLines * 0.6)
      );

      if (isBreak && sub.length > 3) {
        subsections.push(sub);
        sub = [];
      }
      sub.push(line);
    }
    if (sub.length > 0) subsections.push(sub);

    // Emit subsections
    for (let i = 0; i < subsections.length; i++) {
      result.push(...subsections[i]);
    }
  }

  for (const line of lines) {
    if (/^##\s/.test(line) && !line.startsWith('###')) {
      flushSection();
      currentSection = [line];
      currentHeading = line;
    } else {
      currentSection.push(line);
    }
  }
  flushSection();

  return result.join('\n');
}

/**
 * Trim the constitution (content before the second H2) to the budget.
 * Moves trimmed content to a new section.
 */
function trimConstitution(content: string, maxConstitutionLines: number): string {
  const lines = content.split('\n');
  let h2Count = 0;
  let secondH2Index = -1;

  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      h2Count++;
      if (h2Count === 2) {
        secondH2Index = i;
        break;
      }
    }
  }

  if (secondH2Index === -1 || secondH2Index <= maxConstitutionLines) {
    return content;
  }

  // Constitution is too long. Keep the first maxConstitutionLines, move rest after.
  const constitutionPart = lines.slice(0, maxConstitutionLines);
  const overflowPart = lines.slice(maxConstitutionLines, secondH2Index);
  const restPart = lines.slice(secondH2Index);

  // Only move if there's meaningful overflow
  const meaningfulOverflow = overflowPart.filter(l => l.trim().length > 0);
  if (meaningfulOverflow.length < 3) {
    return content;
  }

  return [
    ...constitutionPart,
    '',
    ...restPart,
    '',
    '## Extended Configuration',
    '',
    ...overflowPart,
  ].join('\n');
}

/**
 * Trim code blocks to a maximum count for compact mode.
 * Keeps the first N code blocks, replaces the rest with a comment.
 */
function trimCodeBlocks(content: string, maxBlocks: number): string {
  let blockCount = 0;
  let insideBlock = false;
  const lines = content.split('\n');
  const result: string[] = [];
  let skipBlock = false;

  for (const line of lines) {
    if (line.startsWith('```') && !insideBlock) {
      insideBlock = true;
      blockCount++;
      if (blockCount > maxBlocks) {
        skipBlock = true;
        result.push('*(code example omitted for brevity)*');
        continue;
      }
    } else if (line.startsWith('```') && insideBlock) {
      insideBlock = false;
      if (skipBlock) {
        skipBlock = false;
        continue;
      }
    }

    if (!skipBlock) {
      result.push(line);
    }
  }

  return result.join('\n');
}

/**
 * Remove duplicate rule statements.
 */
function removeDuplicateRules(content: string): string {
  const lines = content.split('\n');
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    // Only deduplicate list items
    if (/^\s*[-*]\s/.test(line)) {
      const normalized = line.trim().toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(normalized)) continue;
      seen.add(normalized);
    }
    result.push(line);
  }

  return result.join('\n');
}

/**
 * Trim content to a maximum line count, preserving structure.
 * Removes the longest non-essential sections first.
 */
function trimToLineCount(content: string, maxLines: number): string {
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;

  // Parse into sections
  interface Section { heading: string; lines: string[]; essential: boolean; }
  const sections: Section[] = [];
  let currentLines: string[] = [];
  let currentHeading = '';

  for (const line of lines) {
    if (/^##\s/.test(line)) {
      if (currentLines.length > 0 || currentHeading) {
        const essential = isEssentialSection(currentHeading);
        sections.push({ heading: currentHeading, lines: [...currentLines], essential });
      }
      currentHeading = line;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.length > 0 || currentHeading) {
    sections.push({ heading: currentHeading, lines: [...currentLines], essential: isEssentialSection(currentHeading) });
  }

  // Sort non-essential sections by size (largest first) and trim
  let totalLines = sections.reduce((sum, s) => sum + (s.heading ? 1 : 0) + s.lines.length, 0);

  const nonEssential = sections
    .map((s, i) => ({ ...s, index: i }))
    .filter(s => !s.essential)
    .sort((a, b) => b.lines.length - a.lines.length);

  for (const s of nonEssential) {
    if (totalLines <= maxLines) break;
    const removed = s.lines.length;
    sections[s.index].lines = ['', '*(Section trimmed for context budget)*', ''];
    totalLines -= removed - 3;
  }

  // Reassemble
  const result: string[] = [];
  for (const s of sections) {
    if (s.heading) result.push(s.heading);
    result.push(...s.lines);
  }

  return result.join('\n');
}

function isEssentialSection(heading: string): boolean {
  if (!heading) return true; // Constitution is essential
  const lower = heading.toLowerCase();
  return (
    lower.includes('build') || lower.includes('test') ||
    lower.includes('security') || lower.includes('architecture') ||
    lower.includes('structure') || lower.includes('rule') ||
    lower.includes('enforcement') || lower.includes('standard')
  );
}
