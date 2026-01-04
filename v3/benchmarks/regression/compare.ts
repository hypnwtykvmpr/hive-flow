/**
 * Benchmark Comparison Utility
 *
 * Compares current benchmark results against baseline to detect
 * performance regressions and validate improvements.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BenchmarkResult, compareResults, printComparisonReport, formatTime, formatBytes } from '../framework/benchmark.js';

// ============================================================================
// Types
// ============================================================================

interface BaselineBenchmark {
  mean: number;
  median: number;
  p95: number;
  p99: number;
  unit: string;
  target: number | null;
  description: string;
}

interface BaselineData {
  version: string;
  timestamp: string;
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
    cpus: number;
    memory: number;
  };
  benchmarks: {
    [category: string]: {
      [name: string]: BaselineBenchmark;
    };
  };
  targets: {
    [name: string]: {
      v2: number | null;
      v3: number | string;
      improvement: string;
      unit?: string;
    };
  };
}

interface ComparisonSummary {
  totalBenchmarks: number;
  improved: number;
  regressed: number;
  unchanged: number;
  targetsMet: number;
  targetsMissed: number;
  overallStatus: 'pass' | 'fail' | 'warning';
  details: ComparisonDetail[];
}

interface ComparisonDetail {
  category: string;
  name: string;
  baseline: number;
  current: number;
  change: number;
  changePercent: number;
  target: number | null;
  targetMet: boolean;
  status: 'improved' | 'regressed' | 'unchanged';
  severity: 'critical' | 'warning' | 'info';
}

// ============================================================================
// Comparison Logic
// ============================================================================

/**
 * Load baseline data from JSON file
 */
export function loadBaseline(baselinePath: string): BaselineData {
  const content = fs.readFileSync(baselinePath, 'utf-8');
  return JSON.parse(content) as BaselineData;
}

/**
 * Compare a single benchmark against baseline
 */
function compareBenchmark(
  name: string,
  category: string,
  current: number,
  baseline: BaselineBenchmark
): ComparisonDetail {
  const change = current - baseline.mean;
  const changePercent = (change / baseline.mean) * 100;

  // Determine status
  let status: 'improved' | 'regressed' | 'unchanged';
  if (changePercent <= -5) {
    status = 'improved';
  } else if (changePercent >= 5) {
    status = 'regressed';
  } else {
    status = 'unchanged';
  }

  // Check target
  const targetMet = baseline.target === null || current <= baseline.target;

  // Determine severity
  let severity: 'critical' | 'warning' | 'info';
  if (status === 'regressed' && changePercent >= 20) {
    severity = 'critical';
  } else if (status === 'regressed' || !targetMet) {
    severity = 'warning';
  } else {
    severity = 'info';
  }

  return {
    category,
    name,
    baseline: baseline.mean,
    current,
    change,
    changePercent,
    target: baseline.target,
    targetMet,
    status,
    severity,
  };
}

/**
 * Compare current results against baseline
 */
export function compareWithBaseline(
  currentResults: Map<string, number>,
  baseline: BaselineData
): ComparisonSummary {
  const details: ComparisonDetail[] = [];

  // Compare each category
  for (const [category, benchmarks] of Object.entries(baseline.benchmarks)) {
    for (const [name, baselineBench] of Object.entries(benchmarks)) {
      const current = currentResults.get(`${category}/${name}`) || currentResults.get(name);
      if (current !== undefined) {
        details.push(compareBenchmark(name, category, current, baselineBench));
      }
    }
  }

  // Calculate summary
  const improved = details.filter((d) => d.status === 'improved').length;
  const regressed = details.filter((d) => d.status === 'regressed').length;
  const unchanged = details.filter((d) => d.status === 'unchanged').length;
  const targetsMet = details.filter((d) => d.targetMet).length;
  const targetsMissed = details.filter((d) => !d.targetMet).length;

  // Determine overall status
  let overallStatus: 'pass' | 'fail' | 'warning';
  const criticalRegressions = details.filter(
    (d) => d.severity === 'critical'
  ).length;

  if (criticalRegressions > 0) {
    overallStatus = 'fail';
  } else if (regressed > improved || targetsMissed > 0) {
    overallStatus = 'warning';
  } else {
    overallStatus = 'pass';
  }

  return {
    totalBenchmarks: details.length,
    improved,
    regressed,
    unchanged,
    targetsMet,
    targetsMissed,
    overallStatus,
    details,
  };
}

/**
 * Print comparison summary
 */
export function printComparisonSummary(summary: ComparisonSummary): void {
  console.log('\n' + '='.repeat(80));
  console.log('Performance Regression Analysis');
  console.log('='.repeat(80) + '\n');

  // Overall status
  const statusSymbol =
    summary.overallStatus === 'pass'
      ? '[PASS]'
      : summary.overallStatus === 'fail'
        ? '[FAIL]'
        : '[WARN]';

  console.log(`Overall Status: ${statusSymbol}\n`);

  // Summary stats
  console.log('Summary:');
  console.log(`  Total Benchmarks: ${summary.totalBenchmarks}`);
  console.log(`  Improved:         ${summary.improved}`);
  console.log(`  Regressed:        ${summary.regressed}`);
  console.log(`  Unchanged:        ${summary.unchanged}`);
  console.log(`  Targets Met:      ${summary.targetsMet}`);
  console.log(`  Targets Missed:   ${summary.targetsMissed}`);

  // Critical regressions
  const critical = summary.details.filter((d) => d.severity === 'critical');
  if (critical.length > 0) {
    console.log('\n--- CRITICAL REGRESSIONS ---\n');
    for (const detail of critical) {
      console.log(
        `  [CRITICAL] ${detail.category}/${detail.name}: ` +
          `${formatTime(detail.baseline)} -> ${formatTime(detail.current)} ` +
          `(${detail.changePercent >= 0 ? '+' : ''}${detail.changePercent.toFixed(1)}%)`
      );
    }
  }

  // Warnings
  const warnings = summary.details.filter((d) => d.severity === 'warning');
  if (warnings.length > 0) {
    console.log('\n--- WARNINGS ---\n');
    for (const detail of warnings) {
      const reason = !detail.targetMet
        ? `missed target ${formatTime(detail.target!)}`
        : 'regression';
      console.log(
        `  [WARN] ${detail.category}/${detail.name}: ` +
          `${formatTime(detail.baseline)} -> ${formatTime(detail.current)} ` +
          `(${reason})`
      );
    }
  }

  // Improvements
  const improvements = summary.details.filter((d) => d.status === 'improved');
  if (improvements.length > 0) {
    console.log('\n--- IMPROVEMENTS ---\n');
    for (const detail of improvements) {
      console.log(
        `  [OK] ${detail.category}/${detail.name}: ` +
          `${formatTime(detail.baseline)} -> ${formatTime(detail.current)} ` +
          `(${detail.changePercent.toFixed(1)}%)`
      );
    }
  }

  // V3 Target Progress
  console.log('\n--- V3 TARGET PROGRESS ---\n');

  const targetProgress = [
    { name: 'CLI Cold Start', target: 500, unit: 'ms', improvement: '5x' },
    { name: 'MCP Server Init', target: 400, unit: 'ms', improvement: '4.5x' },
    { name: 'Agent Spawn', target: 200, unit: 'ms', improvement: '4x' },
    { name: 'Vector Search', target: 1, unit: 'ms', improvement: '150x' },
    { name: 'Memory Write', target: 5, unit: 'ms', improvement: '10x' },
    { name: 'Consensus Latency', target: 100, unit: 'ms', improvement: '5x' },
    { name: 'Flash Attention', target: null, unit: '', improvement: '2.49x-7.47x' },
    { name: 'Memory Usage', target: 256, unit: 'MB', improvement: '50%' },
  ];

  console.log(
    `${'Target'.padEnd(20)} ${'Goal'.padEnd(12)} ${'Expected'.padEnd(15)} Status`
  );
  console.log('-'.repeat(60));

  for (const target of targetProgress) {
    const goalStr = target.target !== null ? `<${target.target}${target.unit}` : 'N/A';
    console.log(
      `${target.name.padEnd(20)} ${goalStr.padEnd(12)} ${target.improvement.padEnd(15)} [PENDING]`
    );
  }

  console.log('\n');
}

/**
 * Save comparison results to file
 */
export function saveComparisonResults(
  summary: ComparisonSummary,
  outputPath: string
): void {
  const output = {
    timestamp: new Date().toISOString(),
    summary: {
      totalBenchmarks: summary.totalBenchmarks,
      improved: summary.improved,
      regressed: summary.regressed,
      unchanged: summary.unchanged,
      targetsMet: summary.targetsMet,
      targetsMissed: summary.targetsMissed,
      overallStatus: summary.overallStatus,
    },
    details: summary.details,
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Comparison results saved to: ${outputPath}`);
}

// ============================================================================
// CLI Interface
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const baselinePath = args[0] || path.join(__dirname, 'baseline-v2.json');
  const outputPath = args[1] || path.join(__dirname, 'comparison-results.json');

  console.log('Loading baseline...');
  const baseline = loadBaseline(baselinePath);
  console.log(`Loaded baseline v${baseline.version} from ${baseline.timestamp}`);

  // For demo purposes, generate some mock current results
  // In real usage, these would come from running the benchmark suite
  const currentResults = new Map<string, number>([
    // Improved (simulated V3 performance)
    ['startup/cli-cold-start', 450],
    ['startup/cli-warm-start', 80],
    ['startup/mcp-server-init', 350],
    ['startup/agent-spawn', 180],

    // Memory improvements with HNSW
    ['memory/vector-search-1k', 0.5],
    ['memory/vector-search-10k', 0.8],
    ['memory/hnsw-indexing', 8],
    ['memory/memory-write', 3],
    ['memory/cache-hit-rate', 0.08],

    // Swarm improvements
    ['swarm/agent-coordination-5', 40],
    ['swarm/agent-coordination-15', 120],
    ['swarm/task-decomposition', 15],
    ['swarm/consensus-latency', 80],
    ['swarm/message-throughput', 0.05],

    // Attention benchmarks
    ['attention/standard-attention-512', 100],
    ['attention/flash-attention-512', 35], // ~2.85x speedup

    // System benchmarks
    ['system/memory-usage-baseline', 280000000], // ~267MB
    ['system/sona-adaptation', 0.04],
  ]);

  console.log('\nComparing with baseline...');
  const summary = compareWithBaseline(currentResults, baseline);

  printComparisonSummary(summary);

  if (outputPath) {
    saveComparisonResults(summary, outputPath);
  }

  // Exit with appropriate code
  if (summary.overallStatus === 'fail') {
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export default {
  loadBaseline,
  compareWithBaseline,
  printComparisonSummary,
  saveComparisonResults,
};
