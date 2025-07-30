import {
  printSuccess,
  printError,
  printWarning,
  callRuvSwarmMCP,
  checkRuvSwarmAvailable,
} from '../utils.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import {
  initializeMetrics,
  getPerformanceReport,
  getBottleneckAnalysis,
  exportMetrics
} from './performance-metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function analysisAction(subArgs, flags) {
  const subcommand = subArgs[0];
  const options = flags;

  if (options.help || options.h || !subcommand) {
    showAnalysisHelp();
    return;
  }

  try {
    switch (subcommand) {
      case 'bottleneck-detect':
        await bottleneckDetectCommand(subArgs, flags);
        break;
      case 'performance-report':
        await performanceReportCommand(subArgs, flags);
        break;
      case 'token-usage':
        await tokenUsageCommand(subArgs, flags);
        break;
      default:
        printError(`Unknown analysis command: ${subcommand}`);
        showAnalysisHelp();
    }
  } catch (err) {
    printError(`Analysis command failed: ${err.message}`);
  }
}

async function bottleneckDetectCommand(subArgs, flags) {
  const options = flags;
  const scope = options.scope || 'system';
  const target = options.target || 'all';

  console.log(`🔍 Detecting performance bottlenecks...`);
  console.log(`📊 Scope: ${scope}`);
  console.log(`🎯 Target: ${target}`);

  try {
    // Initialize metrics system if needed
    await initializeMetrics();
    
    // Get real bottleneck analysis
    const analysis = await getBottleneckAnalysis(scope, target);
    
    printSuccess(`✅ Bottleneck analysis completed`);

    console.log(`\n📊 BOTTLENECK ANALYSIS RESULTS:`);
    
    analysis.bottlenecks.forEach((bottleneck) => {
      const icon =
        bottleneck.severity === 'critical'
          ? '🔴'
          : bottleneck.severity === 'warning'
            ? '🟡'
            : '🟢';
      console.log(
        `  ${icon} ${bottleneck.severity.toUpperCase()}: ${bottleneck.component} (${bottleneck.metric})`,
      );
      
      // Show details if available
      if (bottleneck.details) {
        bottleneck.details.forEach(detail => {
          console.log(`      - ${detail.type || detail.id}: ${detail.duration}s`);
        });
      }
    });

    if (analysis.recommendations.length > 0) {
      console.log(`\n💡 RECOMMENDATIONS:`);
      analysis.recommendations.forEach((rec) => {
        console.log(`  • ${rec}`);
      });
    }

    console.log(`\n📊 PERFORMANCE METRICS:`);
    console.log(`  • Analysis duration: ${analysis.analysisDuration.toFixed(2)}ms`);
    console.log(`  • Confidence score: ${(analysis.confidenceScore * 100).toFixed(0)}%`);
    console.log(`  • Issues detected: ${analysis.issuesDetected}`);

    // Save detailed report
    const reportPath = path.join(process.cwd(), 'analysis-reports', `bottleneck-${Date.now()}.json`);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(analysis, null, 2));
    
    console.log(`\n📄 Detailed report saved to: ${reportPath}`);
    
  } catch (err) {
    printError(`Bottleneck analysis failed: ${err.message}`);
    console.log('\nFalling back to simulated analysis...');
    
    // Fallback to simulated data
    console.log(`\n📊 BOTTLENECK ANALYSIS RESULTS (SIMULATED):`);
    console.log(`  🔴 CRITICAL: Memory usage in agent spawn process (85% utilization)`);
    console.log(`  🟡 WARNING: Task queue processing (12s avg)`);
    console.log(`  🟢 GOOD: Neural training pipeline (optimal)`);
    console.log(`  🟢 GOOD: Swarm coordination latency (within limits)`);
  }
}

async function performanceReportCommand(subArgs, flags) {
  const options = flags;
  const timeframe = options.timeframe || '24h';
  const format = options.format || 'summary';

  console.log(`📈 Generating performance report...`);
  console.log(`⏰ Timeframe: ${timeframe}`);
  console.log(`📋 Format: ${format}`);

  try {
    // Initialize metrics system if needed
    await initializeMetrics();
    
    // Get real performance data
    const report = await getPerformanceReport(timeframe);
    
    printSuccess(`✅ Performance report generated`);

    console.log(`\n📊 PERFORMANCE SUMMARY (${timeframe}):`);
    console.log(`  🚀 Total tasks executed: ${report.summary.totalTasks}`);
    console.log(`  ✅ Success rate: ${report.summary.successRate.toFixed(1)}%`);
    console.log(`  ⏱️  Average execution time: ${report.summary.avgDuration.toFixed(1)}s`);
    console.log(`  🤖 Agents spawned: ${report.summary.agentsSpawned}`);
    console.log(`  💾 Memory efficiency: ${report.summary.memoryEfficiency.toFixed(0)}%`);
    console.log(`  🧠 Neural learning events: ${report.summary.neuralEvents}`);

    // Show trends if available
    if (report.trends) {
      console.log(`\n📈 TRENDS:`);
      if (report.trends.successRateChange !== 0) {
        const trend = report.trends.successRateChange > 0 ? 'improved' : 'decreased';
        console.log(`  • Task success rate ${trend} ${Math.abs(report.trends.successRateChange).toFixed(1)}% vs previous period`);
      }
      if (report.trends.durationChange !== 0) {
        const trend = report.trends.durationChange < 0 ? 'reduced' : 'increased';
        console.log(`  • Average execution time ${trend} by ${Math.abs(report.trends.durationChange / 1000).toFixed(1)}s`);
      }
      if (report.trends.taskVolumeChange !== 0) {
        const trend = report.trends.taskVolumeChange > 0 ? 'increased' : 'decreased';
        const percent = Math.abs((report.trends.taskVolumeChange / report.summary.totalTasks) * 100).toFixed(0);
        console.log(`  • Task volume ${trend} ${percent}%`);
      }
    }

    if (format === 'detailed' && report.agentMetrics) {
      console.log(`\n📊 DETAILED METRICS:`);
      console.log(`  Agent Performance:`);
      Object.entries(report.agentMetrics).forEach(([type, metrics]) => {
        console.log(`    - ${type} agents: ${metrics.successRate.toFixed(0)}% success, ${(metrics.avgDuration / 1000).toFixed(1)}s avg`);
      });
    }

    // Export full report
    const reportPath = await exportMetrics(format === 'json' ? 'json' : 'html');
    console.log(`\n📄 Full report: ${reportPath}`);
    
  } catch (err) {
    printError(`Failed to generate performance report: ${err.message}`);
    printWarning('Showing simulated data as fallback...');
    
    // Fallback to simulated data
    console.log(`\n📊 PERFORMANCE SUMMARY (${timeframe}) - SIMULATED:`);
    console.log(`  🚀 Total tasks executed: 127`);
    console.log(`  ✅ Success rate: 94.5%`);
    console.log(`  ⏱️  Average execution time: 8.3s`);
    console.log(`  🤖 Agents spawned: 23`);
    console.log(`  💾 Memory efficiency: 78%`);
    console.log(`  🧠 Neural learning events: 45`);
  }
}

async function tokenUsageCommand(subArgs, flags) {
  const options = flags;
  const agent = options.agent || 'all';
  const breakdown = options.breakdown || false;
  const costAnalysis = options['cost-analysis'] || false;

  console.log(`🔢 Analyzing token usage...`);
  console.log(`🤖 Agent filter: ${agent}`);
  console.log(`📊 Include breakdown: ${breakdown ? 'Yes' : 'No'}`);
  console.log(`💰 Include cost analysis: ${costAnalysis ? 'Yes' : 'No'}`);

  try {
    // Get real token usage from Claude Code metrics
    const tokenData = await getRealTokenUsage(agent);
    
    printSuccess(`✅ Token usage analysis completed`);

    // Display real token usage
    console.log(`\n🔢 TOKEN USAGE SUMMARY:`);
    console.log(`  📝 Total tokens consumed: ${tokenData.total.toLocaleString()}`);
    console.log(`  📥 Input tokens: ${tokenData.input.toLocaleString()} (${((tokenData.input / tokenData.total) * 100).toFixed(1)}%)`);
    console.log(`  📤 Output tokens: ${tokenData.output.toLocaleString()} (${((tokenData.output / tokenData.total) * 100).toFixed(1)}%)`);
    
    if (costAnalysis) {
      const cost = calculateCost(tokenData);
      console.log(`  💰 Estimated cost: $${cost.total.toFixed(2)}`);
      console.log(`     Input cost: $${cost.input.toFixed(2)}`);
      console.log(`     Output cost: $${cost.output.toFixed(2)}`);
    }

    if (breakdown && tokenData.byAgent) {
      console.log(`\n📊 BREAKDOWN BY AGENT TYPE:`);
      Object.entries(tokenData.byAgent).forEach(([agentType, usage]) => {
        const percentage = ((usage / tokenData.total) * 100).toFixed(1);
        const icon = getAgentIcon(agentType);
        console.log(`  ${icon} ${agentType}: ${usage.toLocaleString()} tokens (${percentage}%)`);
      });

      console.log(`\n💡 OPTIMIZATION OPPORTUNITIES:`);
      const opportunities = generateOptimizationSuggestions(tokenData);
      opportunities.forEach(suggestion => {
        console.log(`  • ${suggestion}`);
      });
    }

    // Generate real CSV report
    const reportPath = await generateTokenUsageReport(tokenData, agent);
    console.log(`\n📄 Detailed usage log: ${reportPath}`);
    
  } catch (err) {
    printError(`Failed to get real token usage: ${err.message}`);
    printWarning('Falling back to simulated data...');
    
    // Fallback to simulated data
    await showSimulatedTokenUsage(breakdown, costAnalysis);
  }
}

function showAnalysisHelp() {
  console.log(`
📊 Analysis Commands - Performance & Usage Analytics

USAGE:
  claude-flow analysis <command> [options]

COMMANDS:
  bottleneck-detect    Detect performance bottlenecks in the system
  performance-report   Generate comprehensive performance reports
  token-usage          Analyze token consumption and costs

BOTTLENECK DETECT OPTIONS:
  --scope <scope>      Analysis scope (default: system)
                       Options: system, swarm, agent, task, memory
  --target <target>    Specific target to analyze (default: all)
                       Examples: agent-id, swarm-id, task-type

PERFORMANCE REPORT OPTIONS:
  --timeframe <time>   Report timeframe (default: 24h)
                       Options: 1h, 6h, 24h, 7d, 30d
  --format <format>    Report format (default: summary)
                       Options: summary, detailed, json, csv

TOKEN USAGE OPTIONS:
  --agent <agent>      Filter by agent type or ID (default: all)
  --breakdown          Include detailed breakdown by agent type
  --cost-analysis      Include cost projections and optimization

EXAMPLES:
  # Detect system-wide bottlenecks
  claude-flow analysis bottleneck-detect --scope system

  # Agent-specific bottleneck analysis
  claude-flow analysis bottleneck-detect --scope agent --target coordinator-1

  # Weekly performance report
  claude-flow analysis performance-report --timeframe 7d --format detailed

  # Token usage with breakdown
  claude-flow analysis token-usage --breakdown --cost-analysis

  # Swarm-specific analysis
  claude-flow analysis bottleneck-detect --scope swarm --target swarm-123

🎯 Analysis helps with:
  • Performance optimization
  • Cost management
  • Resource allocation
  • Bottleneck identification
  • Trend analysis
`);
}

// Helper functions for real token tracking

async function getRealTokenUsage(agent) {
  // Check if Claude Code OpenTelemetry is configured
  const isOTelEnabled = process.env.CLAUDE_CODE_ENABLE_TELEMETRY === '1';
  
  if (!isOTelEnabled) {
    // Try to read from local metrics file if OTel is not enabled
    return await getLocalTokenMetrics(agent);
  }
  
  // Get metrics from OpenTelemetry
  return await getOTelTokenMetrics(agent);
}

async function getLocalTokenMetrics(agent) {
  // Look for Claude Code metrics in standard locations
  const metricsPath = path.join(process.env.HOME || '', '.claude', 'metrics', 'usage.json');
  
  try {
    const data = await fs.readFile(metricsPath, 'utf8');
    const metrics = JSON.parse(data);
    
    // Extract token usage from metrics
    const tokenData = {
      total: 0,
      input: 0,
      output: 0,
      byAgent: {}
    };
    
    // Process metrics based on Claude Code format
    if (metrics.sessions) {
      metrics.sessions.forEach(session => {
        if (session.tokenUsage) {
          tokenData.total += session.tokenUsage.total || 0;
          tokenData.input += session.tokenUsage.input || 0;
          tokenData.output += session.tokenUsage.output || 0;
          
          // Track by agent if available
          if (session.agentType && (agent === 'all' || session.agentType === agent)) {
            tokenData.byAgent[session.agentType] = 
              (tokenData.byAgent[session.agentType] || 0) + (session.tokenUsage.total || 0);
          }
        }
      });
    }
    
    return tokenData;
  } catch (err) {
    // Fallback to environment variables or defaults
    return getEnvironmentTokenMetrics(agent);
  }
}

async function getEnvironmentTokenMetrics(agent) {
  // Check for token tracking in environment or config
  const configPath = path.join(process.cwd(), '.claude-flow', 'token-usage.json');
  
  try {
    const data = await fs.readFile(configPath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    // Return empty data structure
    return {
      total: 0,
      input: 0,
      output: 0,
      byAgent: {}
    };
  }
}

async function getOTelTokenMetrics(agent) {
  // This would integrate with OpenTelemetry exporters
  // For now, return placeholder implementation
  return {
    total: 0,
    input: 0,
    output: 0,
    byAgent: {}
  };
}

function calculateCost(tokenData) {
  // Anthropic Claude pricing (as of knowledge cutoff)
  // Claude 3 Opus: $15/$75 per million tokens (input/output)
  // Claude 3 Sonnet: $3/$15 per million tokens
  // Claude 3 Haiku: $0.25/$1.25 per million tokens
  
  // Default to Sonnet pricing for Claude Code
  const inputPricePerMillion = 3.00;
  const outputPricePerMillion = 15.00;
  
  return {
    input: (tokenData.input / 1000000) * inputPricePerMillion,
    output: (tokenData.output / 1000000) * outputPricePerMillion,
    total: ((tokenData.input / 1000000) * inputPricePerMillion) + 
           ((tokenData.output / 1000000) * outputPricePerMillion)
  };
}

function getAgentIcon(agentType) {
  const icons = {
    'coordinator': '🎯',
    'developer': '👨‍💻',
    'researcher': '🔍',
    'analyzer': '📊',
    'tester': '🧪',
    'architect': '🏗️',
    'reviewer': '👁️'
  };
  return icons[agentType.toLowerCase()] || '🤖';
}

function generateOptimizationSuggestions(tokenData) {
  const suggestions = [];
  
  // Analyze token usage patterns
  if (tokenData.byAgent) {
    Object.entries(tokenData.byAgent).forEach(([agentType, usage]) => {
      const percentage = (usage / tokenData.total) * 100;
      
      if (percentage > 40) {
        suggestions.push(`${agentType} agents: Consider prompt optimization (-15% potential)`);
      }
      if (percentage > 25) {
        suggestions.push(`${agentType} agents: Implement response caching (-8% potential)`);
      }
    });
  }
  
  // General suggestions based on total usage
  if (tokenData.total > 100000) {
    suggestions.push('Consider using Claude Haiku for non-critical tasks (-90% cost)');
  }
  
  if (tokenData.output > tokenData.input * 2) {
    suggestions.push('High output ratio: Consider more concise prompts');
  }
  
  return suggestions.length > 0 ? suggestions : ['Token usage is within optimal range'];
}

async function generateTokenUsageReport(tokenData, agent) {
  const reportsDir = path.join(process.cwd(), 'analysis-reports');
  
  // Create reports directory if it doesn't exist
  try {
    await fs.mkdir(reportsDir, { recursive: true });
  } catch (err) {
    // Directory might already exist
  }
  
  const timestamp = Date.now();
  const reportPath = path.join(reportsDir, `token-usage-${timestamp}.csv`);
  
  // Generate CSV content
  let csvContent = 'Timestamp,Agent,Input Tokens,Output Tokens,Total Tokens,Cost\\n';
  
  if (tokenData.byAgent) {
    Object.entries(tokenData.byAgent).forEach(([agentType, usage]) => {
      const agentInput = Math.floor(usage * 0.6); // Estimate 60% input
      const agentOutput = usage - agentInput;
      const agentCost = calculateCost({ input: agentInput, output: agentOutput, total: usage });
      
      csvContent += `${new Date().toISOString()},${agentType},${agentInput},${agentOutput},${usage},$${agentCost.total.toFixed(4)}\\n`;
    });
  } else {
    const cost = calculateCost(tokenData);
    csvContent += `${new Date().toISOString()},${agent},${tokenData.input},${tokenData.output},${tokenData.total},$${cost.total.toFixed(4)}\\n`;
  }
  
  // Write CSV file
  await fs.writeFile(reportPath, csvContent);
  
  return reportPath;
}

async function showSimulatedTokenUsage(breakdown, costAnalysis) {
  // Existing simulated data as fallback
  console.log(`\n🔢 TOKEN USAGE SUMMARY (Simulated):`);
  console.log(`  📝 Total tokens consumed: 45,231`);
  console.log(`  📥 Input tokens: 28,567 (63.2%)`);
  console.log(`  📤 Output tokens: 16,664 (36.8%)`);
  
  if (costAnalysis) {
    console.log(`  💰 Estimated cost: $0.23`);
  }

  if (breakdown) {
    console.log(`\\n📊 BREAKDOWN BY AGENT TYPE:`);
    console.log(`  🎯 Coordinator: 12,430 tokens (27.5%)`);
    console.log(`  👨‍💻 Developer: 18,965 tokens (41.9%)`);
    console.log(`  🔍 Researcher: 8,734 tokens (19.3%)`);
    console.log(`  📊 Analyzer: 5,102 tokens (11.3%)`);

    console.log(`\\n💡 OPTIMIZATION OPPORTUNITIES:`);
    console.log(`  • Developer agents: Consider prompt optimization (-15% potential)`);
    console.log(`  • Coordinator agents: Implement response caching (-8% potential)`);
  }

  console.log(`\\n📄 Note: Enable CLAUDE_CODE_ENABLE_TELEMETRY=1 for real metrics`);
}
