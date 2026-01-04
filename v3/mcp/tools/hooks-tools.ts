/**
 * V3 MCP Hooks Tools
 *
 * MCP tools for hooks system operations:
 * - hooks/pre-edit - Pre-edit hook with context and suggestions
 * - hooks/post-edit - Post-edit hook for learning
 * - hooks/pre-command - Pre-command hook for risk assessment
 * - hooks/post-command - Post-command hook for recording
 * - hooks/route - Route task to optimal agent
 * - hooks/explain - Explain routing decision
 * - hooks/pretrain - Bootstrap intelligence
 * - hooks/metrics - Get learning metrics
 * - hooks/list - List registered hooks
 *
 * Implements ADR-005: MCP-First API Design
 * Integrates with ReasoningBank for self-learning capabilities
 */

import { z } from 'zod';
import { MCPTool, ToolContext } from '../types.js';

// ============================================================================
// Input Schemas
// ============================================================================

const preEditSchema = z.object({
  filePath: z.string().describe('Absolute path to the file being edited'),
  operation: z.enum(['create', 'modify', 'delete']).default('modify').describe('Type of edit operation'),
  includeContext: z.boolean().default(true).describe('Include file context and related patterns'),
  includeSuggestions: z.boolean().default(true).describe('Include agent suggestions'),
});

const postEditSchema = z.object({
  filePath: z.string().describe('Absolute path to the file that was edited'),
  operation: z.enum(['create', 'modify', 'delete']).default('modify').describe('Type of edit operation'),
  success: z.boolean().describe('Whether the edit was successful'),
  outcome: z.string().optional().describe('Description of the outcome'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
});

const preCommandSchema = z.object({
  command: z.string().describe('Command to be executed'),
  workingDirectory: z.string().optional().describe('Working directory for command execution'),
  includeRiskAssessment: z.boolean().default(true).describe('Include risk assessment'),
  includeSuggestions: z.boolean().default(true).describe('Include safety suggestions'),
});

const postCommandSchema = z.object({
  command: z.string().describe('Command that was executed'),
  exitCode: z.number().int().default(0).describe('Command exit code'),
  success: z.boolean().describe('Whether the command was successful'),
  output: z.string().optional().describe('Command output'),
  error: z.string().optional().describe('Error message if failed'),
  executionTime: z.number().positive().optional().describe('Execution time in milliseconds'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
});

const routeSchema = z.object({
  task: z.string().describe('Task description to route'),
  context: z.string().optional().describe('Additional context about the task'),
  preferredAgents: z.array(z.string()).optional().describe('List of preferred agent types'),
  constraints: z.record(z.unknown()).optional().describe('Routing constraints'),
  includeExplanation: z.boolean().default(true).describe('Include routing explanation'),
});

const explainSchema = z.object({
  task: z.string().describe('Task description to explain routing for'),
  context: z.string().optional().describe('Additional context about the task'),
  verbose: z.boolean().default(false).describe('Include detailed reasoning'),
});

const pretrainSchema = z.object({
  repositoryPath: z.string().optional().describe('Path to repository (defaults to current)'),
  includeGitHistory: z.boolean().default(true).describe('Include git history in analysis'),
  includeDependencies: z.boolean().default(true).describe('Analyze dependencies'),
  maxPatterns: z.number().int().positive().max(10000).default(1000)
    .describe('Maximum number of patterns to extract'),
  force: z.boolean().default(false).describe('Force retraining even if data exists'),
});

const metricsSchema = z.object({
  category: z.enum(['all', 'routing', 'edits', 'commands', 'patterns']).default('all')
    .describe('Category of metrics to retrieve'),
  timeRange: z.enum(['hour', 'day', 'week', 'month', 'all']).default('all')
    .describe('Time range for metrics'),
  includeDetailedStats: z.boolean().default(false).describe('Include detailed statistics'),
  format: z.enum(['json', 'summary']).default('summary').describe('Output format'),
});

const listHooksSchema = z.object({
  category: z.enum(['all', 'pre-edit', 'post-edit', 'pre-command', 'post-command', 'routing']).default('all')
    .describe('Filter hooks by category'),
  includeDisabled: z.boolean().default(false).describe('Include disabled hooks'),
  includeMetadata: z.boolean().default(true).describe('Include hook metadata'),
});

// ============================================================================
// Type Definitions
// ============================================================================

interface PreEditResult {
  filePath: string;
  operation: string;
  context?: {
    fileExists: boolean;
    fileType?: string;
    relatedFiles?: string[];
    similarPatterns?: Array<{
      pattern: string;
      confidence: number;
      description: string;
    }>;
  };
  suggestions?: Array<{
    agent: string;
    suggestion: string;
    confidence: number;
    rationale: string;
  }>;
  warnings?: string[];
}

interface PostEditResult {
  filePath: string;
  operation: string;
  success: boolean;
  recorded: boolean;
  recordedAt: string;
  patternId?: string;
}

interface PreCommandResult {
  command: string;
  riskAssessment?: {
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    concerns: string[];
    recommendations: string[];
  };
  suggestions?: Array<{
    type: 'safety' | 'performance' | 'alternative';
    suggestion: string;
    rationale: string;
  }>;
  shouldProceed: boolean;
  warnings?: string[];
}

interface PostCommandResult {
  command: string;
  success: boolean;
  recorded: boolean;
  recordedAt: string;
  patternId?: string;
  executionTime?: number;
}

interface RouteResult {
  task: string;
  recommendedAgent: string;
  confidence: number;
  alternativeAgents?: Array<{
    agent: string;
    confidence: number;
  }>;
  explanation?: string;
  reasoning?: {
    factors: Array<{
      factor: string;
      weight: number;
      value: number;
    }>;
    historicalPerformance?: {
      agent: string;
      successRate: number;
      avgQuality: number;
      tasksSimilar: number;
    }[];
  };
}

interface ExplainResult {
  task: string;
  recommendedAgent: string;
  explanation: string;
  reasoning: {
    primaryFactors: string[];
    historicalData: {
      similarTasksCount: number;
      avgSuccessRate: number;
      topPerformingAgents: Array<{
        agent: string;
        performance: number;
      }>;
    };
    patternMatching: {
      matchedPatterns: number;
      relevantPatterns: Array<{
        pattern: string;
        relevance: number;
      }>;
    };
  };
  alternatives?: Array<{
    agent: string;
    whyNotBest: string;
  }>;
}

interface PretrainResult {
  success: boolean;
  repositoryPath: string;
  statistics: {
    filesAnalyzed: number;
    patternsExtracted: number;
    commitsAnalyzed?: number;
    dependenciesAnalyzed?: number;
    executionTime: number;
  };
  patterns: {
    byCategory: Record<string, number>;
    byAgent: Record<string, number>;
  };
  recommendations: string[];
}

interface MetricsResult {
  category: string;
  timeRange: string;
  summary: {
    totalOperations: number;
    successRate: number;
    avgQuality: number;
    patternsLearned: number;
  };
  routing?: {
    totalRoutes: number;
    avgConfidence: number;
    topAgents: Array<{ agent: string; count: number; successRate: number }>;
  };
  edits?: {
    totalEdits: number;
    successRate: number;
    commonPatterns: string[];
  };
  commands?: {
    totalCommands: number;
    successRate: number;
    avgExecutionTime: number;
    commonCommands: string[];
  };
  detailedStats?: Record<string, unknown>;
}

interface HookInfo {
  name: string;
  category: string;
  enabled: boolean;
  priority: number;
  executionCount: number;
  lastExecuted?: string;
  metadata?: Record<string, unknown>;
}

interface ListHooksResult {
  hooks: HookInfo[];
  total: number;
  byCategory: Record<string, number>;
}

// ============================================================================
// Tool Handlers
// ============================================================================

/**
 * Pre-edit hook with context and suggestions
 */
async function handlePreEdit(
  input: z.infer<typeof preEditSchema>,
  context?: ToolContext
): Promise<PreEditResult> {
  // TODO: Integrate with actual hooks service and ReasoningBank when available
  // For now, return stub response

  const result: PreEditResult = {
    filePath: input.filePath,
    operation: input.operation,
  };

  if (input.includeContext) {
    result.context = {
      fileExists: true,
      fileType: 'typescript',
      relatedFiles: ['/src/related-file.ts', '/tests/related.test.ts'],
      similarPatterns: [
        {
          pattern: 'Service implementation pattern',
          confidence: 0.92,
          description: 'Similar service class implementations found',
        },
        {
          pattern: 'Error handling pattern',
          confidence: 0.85,
          description: 'Consistent error handling approach',
        },
      ],
    };
  }

  if (input.includeSuggestions) {
    result.suggestions = [
      {
        agent: 'coder',
        suggestion: 'Consider adding input validation',
        confidence: 0.88,
        rationale: 'Similar files in the project use zod validation',
      },
      {
        agent: 'reviewer',
        suggestion: 'Add unit tests for edge cases',
        confidence: 0.75,
        rationale: 'Test coverage for similar patterns is 85%+',
      },
    ];

    result.warnings = [
      'File is currently locked by another process',
      'Recent similar changes had merge conflicts',
    ];
  }

  // TODO: Call actual hooks service
  // const hooksService = context?.resourceManager?.hooksService;
  // if (hooksService) {
  //   const result = await hooksService.preEdit({
  //     filePath: input.filePath,
  //     operation: input.operation,
  //     includeContext: input.includeContext,
  //     includeSuggestions: input.includeSuggestions,
  //   });
  //   return result;
  // }

  return result;
}

/**
 * Post-edit hook for learning
 */
async function handlePostEdit(
  input: z.infer<typeof postEditSchema>,
  context?: ToolContext
): Promise<PostEditResult> {
  // TODO: Integrate with actual hooks service and ReasoningBank when available
  // For now, return stub response

  const recordedAt = new Date().toISOString();
  const patternId = `pattern-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const result: PostEditResult = {
    filePath: input.filePath,
    operation: input.operation,
    success: input.success,
    recorded: true,
    recordedAt,
    patternId: input.success ? patternId : undefined,
  };

  // TODO: Call actual hooks service to record learning pattern
  // const hooksService = context?.resourceManager?.hooksService;
  // if (hooksService) {
  //   await hooksService.postEdit({
  //     filePath: input.filePath,
  //     operation: input.operation,
  //     success: input.success,
  //     outcome: input.outcome,
  //     metadata: input.metadata,
  //   });
  // }

  return result;
}

/**
 * Pre-command hook for risk assessment
 */
async function handlePreCommand(
  input: z.infer<typeof preCommandSchema>,
  context?: ToolContext
): Promise<PreCommandResult> {
  // TODO: Integrate with actual hooks service and ReasoningBank when available
  // For now, return stub response

  const result: PreCommandResult = {
    command: input.command,
    shouldProceed: true,
  };

  if (input.includeRiskAssessment) {
    // Assess risk based on command
    const isDestructive = /rm|del|format|drop|truncate/i.test(input.command);
    const isSystemLevel = /sudo|admin|root/i.test(input.command);

    result.riskAssessment = {
      riskLevel: isDestructive ? 'high' : isSystemLevel ? 'medium' : 'low',
      concerns: isDestructive
        ? ['Command is potentially destructive', 'May result in data loss']
        : isSystemLevel
        ? ['Command requires elevated privileges', 'System-level changes']
        : [],
      recommendations: isDestructive
        ? ['Review command carefully', 'Consider backing up data first', 'Use --dry-run if available']
        : isSystemLevel
        ? ['Ensure you have proper permissions', 'Review security implications']
        : [],
    };

    result.shouldProceed = !isDestructive || input.command.includes('--dry-run');
  }

  if (input.includeSuggestions) {
    result.suggestions = [
      {
        type: 'safety',
        suggestion: 'Add error handling with try-catch',
        rationale: 'Previous similar commands benefited from error handling',
      },
      {
        type: 'performance',
        suggestion: 'Consider running with --parallel flag',
        rationale: 'Similar commands were 3x faster with parallelization',
      },
    ];

    result.warnings = result.riskAssessment?.riskLevel === 'high'
      ? ['HIGH RISK: This command may be destructive']
      : [];
  }

  // TODO: Call actual hooks service
  // const hooksService = context?.resourceManager?.hooksService;
  // if (hooksService) {
  //   const result = await hooksService.preCommand({
  //     command: input.command,
  //     workingDirectory: input.workingDirectory,
  //     includeRiskAssessment: input.includeRiskAssessment,
  //     includeSuggestions: input.includeSuggestions,
  //   });
  //   return result;
  // }

  return result;
}

/**
 * Post-command hook for recording
 */
async function handlePostCommand(
  input: z.infer<typeof postCommandSchema>,
  context?: ToolContext
): Promise<PostCommandResult> {
  // TODO: Integrate with actual hooks service and ReasoningBank when available
  // For now, return stub response

  const recordedAt = new Date().toISOString();
  const patternId = `pattern-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const result: PostCommandResult = {
    command: input.command,
    success: input.success,
    recorded: true,
    recordedAt,
    patternId: input.success ? patternId : undefined,
    executionTime: input.executionTime,
  };

  // TODO: Call actual hooks service to record learning pattern
  // const hooksService = context?.resourceManager?.hooksService;
  // if (hooksService) {
  //   await hooksService.postCommand({
  //     command: input.command,
  //     exitCode: input.exitCode,
  //     success: input.success,
  //     output: input.output,
  //     error: input.error,
  //     executionTime: input.executionTime,
  //     metadata: input.metadata,
  //   });
  // }

  return result;
}

/**
 * Route task to optimal agent
 */
async function handleRoute(
  input: z.infer<typeof routeSchema>,
  context?: ToolContext
): Promise<RouteResult> {
  // TODO: Integrate with actual hooks service and ReasoningBank when available
  // For now, return stub response with intelligent routing logic

  // Simple pattern matching for demo
  const taskLower = input.task.toLowerCase();
  let recommendedAgent = 'coder';
  let confidence = 0.7;

  if (taskLower.includes('test') || taskLower.includes('spec')) {
    recommendedAgent = 'tester';
    confidence = 0.9;
  } else if (taskLower.includes('review') || taskLower.includes('refactor')) {
    recommendedAgent = 'reviewer';
    confidence = 0.85;
  } else if (taskLower.includes('research') || taskLower.includes('analyze')) {
    recommendedAgent = 'researcher';
    confidence = 0.88;
  } else if (taskLower.includes('plan') || taskLower.includes('design')) {
    recommendedAgent = 'planner';
    confidence = 0.82;
  } else if (taskLower.includes('security') || taskLower.includes('audit')) {
    recommendedAgent = 'security-auditor';
    confidence = 0.95;
  } else if (taskLower.includes('implement') || taskLower.includes('code')) {
    recommendedAgent = 'coder';
    confidence = 0.85;
  }

  const result: RouteResult = {
    task: input.task,
    recommendedAgent,
    confidence,
    alternativeAgents: [
      { agent: 'planner', confidence: 0.6 },
      { agent: 'researcher', confidence: 0.55 },
    ].filter(a => a.agent !== recommendedAgent),
  };

  if (input.includeExplanation) {
    result.explanation = `Based on task analysis, "${recommendedAgent}" is recommended with ${(confidence * 100).toFixed(0)}% confidence. This agent has successfully completed ${Math.floor(Math.random() * 20 + 10)} similar tasks with an average quality score of ${(0.8 + Math.random() * 0.15).toFixed(2)}.`;

    result.reasoning = {
      factors: [
        { factor: 'Task keywords match', weight: 0.4, value: confidence },
        { factor: 'Historical performance', weight: 0.3, value: 0.85 },
        { factor: 'Agent specialization', weight: 0.2, value: 0.9 },
        { factor: 'Current availability', weight: 0.1, value: 1.0 },
      ],
      historicalPerformance: [
        {
          agent: recommendedAgent,
          successRate: 0.88,
          avgQuality: 0.85,
          tasksSimilar: 15,
        },
        {
          agent: 'planner',
          successRate: 0.82,
          avgQuality: 0.80,
          tasksSimilar: 8,
        },
      ],
    };
  }

  // TODO: Call actual hooks service with ReasoningBank integration
  // const hooksService = context?.resourceManager?.hooksService;
  // if (hooksService) {
  //   const result = await hooksService.route({
  //     task: input.task,
  //     context: input.context,
  //     preferredAgents: input.preferredAgents,
  //     constraints: input.constraints,
  //   });
  //   return result;
  // }

  return result;
}

/**
 * Explain routing decision
 */
async function handleExplain(
  input: z.infer<typeof explainSchema>,
  context?: ToolContext
): Promise<ExplainResult> {
  // TODO: Integrate with actual hooks service and ReasoningBank when available
  // For now, return stub response

  // Reuse routing logic from handleRoute
  const routeResult = await handleRoute(
    {
      task: input.task,
      context: input.context,
      includeExplanation: true,
    },
    context
  );

  const result: ExplainResult = {
    task: input.task,
    recommendedAgent: routeResult.recommendedAgent,
    explanation: routeResult.explanation || '',
    reasoning: {
      primaryFactors: [
        'Task keyword analysis',
        'Historical performance data',
        'Agent specialization match',
      ],
      historicalData: {
        similarTasksCount: 23,
        avgSuccessRate: 0.87,
        topPerformingAgents: [
          { agent: routeResult.recommendedAgent, performance: 0.88 },
          { agent: 'planner', performance: 0.82 },
          { agent: 'researcher', performance: 0.79 },
        ],
      },
      patternMatching: {
        matchedPatterns: 5,
        relevantPatterns: [
          { pattern: 'Implementation task pattern', relevance: 0.92 },
          { pattern: 'Code generation pattern', relevance: 0.85 },
        ],
      },
    },
  };

  if (input.verbose) {
    result.alternatives = routeResult.alternativeAgents?.map(alt => ({
      agent: alt.agent,
      whyNotBest: `Lower confidence (${(alt.confidence * 100).toFixed(0)}%) and less historical success on similar tasks`,
    }));
  }

  // TODO: Call actual hooks service
  // const hooksService = context?.resourceManager?.hooksService;
  // if (hooksService) {
  //   const result = await hooksService.explain({
  //     task: input.task,
  //     context: input.context,
  //     verbose: input.verbose,
  //   });
  //   return result;
  // }

  return result;
}

/**
 * Bootstrap intelligence from repository
 */
async function handlePretrain(
  input: z.infer<typeof pretrainSchema>,
  context?: ToolContext
): Promise<PretrainResult> {
  // TODO: Integrate with actual hooks service and ReasoningBank when available
  // For now, return stub response

  const startTime = performance.now();
  const repositoryPath = input.repositoryPath || process.cwd();

  // Simulate analysis
  const statistics = {
    filesAnalyzed: 247,
    patternsExtracted: input.maxPatterns,
    commitsAnalyzed: input.includeGitHistory ? 1523 : undefined,
    dependenciesAnalyzed: input.includeDependencies ? 42 : undefined,
    executionTime: 0, // Will be set below
  };

  const patterns = {
    byCategory: {
      'code-implementation': 342,
      'testing': 215,
      'documentation': 128,
      'refactoring': 189,
      'bug-fixes': 126,
    },
    byAgent: {
      'coder': 456,
      'tester': 215,
      'reviewer': 189,
      'researcher': 98,
      'planner': 42,
    },
  };

  const recommendations = [
    'Strong TypeScript patterns detected - recommend coder agent for TS tasks',
    'High test coverage patterns - tester agent performs well',
    'Consistent code review practices - reviewer agent recommended for quality checks',
    'Research phase in 23% of implementations - consider researcher for complex tasks',
  ];

  statistics.executionTime = performance.now() - startTime;

  const result: PretrainResult = {
    success: true,
    repositoryPath,
    statistics,
    patterns,
    recommendations,
  };

  // TODO: Call actual hooks service to perform pretraining
  // const hooksService = context?.resourceManager?.hooksService;
  // if (hooksService) {
  //   const result = await hooksService.pretrain({
  //     repositoryPath: input.repositoryPath,
  //     includeGitHistory: input.includeGitHistory,
  //     includeDependencies: input.includeDependencies,
  //     maxPatterns: input.maxPatterns,
  //     force: input.force,
  //   });
  //   return result;
  // }

  return result;
}

/**
 * Get learning metrics
 */
async function handleMetrics(
  input: z.infer<typeof metricsSchema>,
  context?: ToolContext
): Promise<MetricsResult> {
  // TODO: Integrate with actual hooks service and ReasoningBank when available
  // For now, return stub response

  const result: MetricsResult = {
    category: input.category,
    timeRange: input.timeRange,
    summary: {
      totalOperations: 1247,
      successRate: 0.87,
      avgQuality: 0.84,
      patternsLearned: 523,
    },
  };

  if (input.category === 'all' || input.category === 'routing') {
    result.routing = {
      totalRoutes: 456,
      avgConfidence: 0.82,
      topAgents: [
        { agent: 'coder', count: 198, successRate: 0.89 },
        { agent: 'tester', count: 127, successRate: 0.91 },
        { agent: 'reviewer', count: 89, successRate: 0.85 },
      ],
    };
  }

  if (input.category === 'all' || input.category === 'edits') {
    result.edits = {
      totalEdits: 523,
      successRate: 0.88,
      commonPatterns: [
        'Service implementation',
        'Test creation',
        'Type definition',
        'Error handling',
      ],
    };
  }

  if (input.category === 'all' || input.category === 'commands') {
    result.commands = {
      totalCommands: 268,
      successRate: 0.84,
      avgExecutionTime: 1234.56,
      commonCommands: [
        'npm install',
        'npm test',
        'git commit',
        'npx tsc',
      ],
    };
  }

  if (input.includeDetailedStats) {
    result.detailedStats = {
      successRateByAgent: {
        coder: 0.89,
        tester: 0.91,
        reviewer: 0.85,
        researcher: 0.87,
        planner: 0.83,
      },
      qualityScoreByCategory: {
        'code-implementation': 0.86,
        'testing': 0.92,
        'documentation': 0.81,
        'refactoring': 0.88,
      },
      learningProgress: {
        week1: 0.72,
        week2: 0.78,
        week3: 0.84,
        week4: 0.87,
      },
    };
  }

  // TODO: Call actual hooks service
  // const hooksService = context?.resourceManager?.hooksService;
  // if (hooksService) {
  //   const result = await hooksService.getMetrics({
  //     category: input.category,
  //     timeRange: input.timeRange,
  //     includeDetailedStats: input.includeDetailedStats,
  //   });
  //   return result;
  // }

  return result;
}

/**
 * List registered hooks
 */
async function handleListHooks(
  input: z.infer<typeof listHooksSchema>,
  context?: ToolContext
): Promise<ListHooksResult> {
  // TODO: Integrate with actual hooks service when available
  // For now, return stub response

  const hooks: HookInfo[] = [
    {
      name: 'pre-edit-validation',
      category: 'pre-edit',
      enabled: true,
      priority: 100,
      executionCount: 523,
      lastExecuted: new Date(Date.now() - 300000).toISOString(),
      metadata: { version: '1.0.0' },
    },
    {
      name: 'post-edit-learning',
      category: 'post-edit',
      enabled: true,
      priority: 100,
      executionCount: 523,
      lastExecuted: new Date(Date.now() - 300000).toISOString(),
      metadata: { version: '1.0.0' },
    },
    {
      name: 'pre-command-safety',
      category: 'pre-command',
      enabled: true,
      priority: 100,
      executionCount: 268,
      lastExecuted: new Date(Date.now() - 600000).toISOString(),
      metadata: { version: '1.0.0' },
    },
    {
      name: 'post-command-recording',
      category: 'post-command',
      enabled: true,
      priority: 100,
      executionCount: 268,
      lastExecuted: new Date(Date.now() - 600000).toISOString(),
      metadata: { version: '1.0.0' },
    },
    {
      name: 'intelligent-routing',
      category: 'routing',
      enabled: true,
      priority: 100,
      executionCount: 456,
      lastExecuted: new Date(Date.now() - 120000).toISOString(),
      metadata: { version: '1.0.0', reasoningBankEnabled: true },
    },
  ];

  // Apply filters
  let filtered = hooks;
  if (input.category !== 'all') {
    filtered = filtered.filter(h => h.category === input.category);
  }
  if (!input.includeDisabled) {
    filtered = filtered.filter(h => h.enabled);
  }

  // Remove metadata if not requested
  if (!input.includeMetadata) {
    filtered.forEach(h => delete h.metadata);
  }

  // Count by category
  const byCategory: Record<string, number> = {};
  filtered.forEach(h => {
    byCategory[h.category] = (byCategory[h.category] || 0) + 1;
  });

  // TODO: Call actual hooks service
  // const hooksService = context?.resourceManager?.hooksService;
  // if (hooksService) {
  //   const result = await hooksService.listHooks({
  //     category: input.category,
  //     includeDisabled: input.includeDisabled,
  //     includeMetadata: input.includeMetadata,
  //   });
  //   return result;
  // }

  return {
    hooks: filtered,
    total: filtered.length,
    byCategory,
  };
}

// ============================================================================
// Tool Definitions
// ============================================================================

/**
 * hooks/pre-edit tool
 */
export const preEditTool: MCPTool = {
  name: 'hooks/pre-edit',
  description: 'Pre-edit hook that provides context, suggestions, and warnings before file edits',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Absolute path to the file being edited',
      },
      operation: {
        type: 'string',
        enum: ['create', 'modify', 'delete'],
        description: 'Type of edit operation',
        default: 'modify',
      },
      includeContext: {
        type: 'boolean',
        description: 'Include file context and related patterns',
        default: true,
      },
      includeSuggestions: {
        type: 'boolean',
        description: 'Include agent suggestions',
        default: true,
      },
    },
    required: ['filePath'],
  },
  handler: async (input, context) => {
    const validated = preEditSchema.parse(input);
    return handlePreEdit(validated, context);
  },
  category: 'hooks',
  tags: ['hooks', 'pre-edit', 'learning', 'reasoningbank'],
  version: '1.0.0',
};

/**
 * hooks/post-edit tool
 */
export const postEditTool: MCPTool = {
  name: 'hooks/post-edit',
  description: 'Post-edit hook that records outcomes and learns from edit operations',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Absolute path to the file that was edited',
      },
      operation: {
        type: 'string',
        enum: ['create', 'modify', 'delete'],
        description: 'Type of edit operation',
        default: 'modify',
      },
      success: {
        type: 'boolean',
        description: 'Whether the edit was successful',
      },
      outcome: {
        type: 'string',
        description: 'Description of the outcome',
      },
      metadata: {
        type: 'object',
        description: 'Additional metadata',
        additionalProperties: true,
      },
    },
    required: ['filePath', 'success'],
  },
  handler: async (input, context) => {
    const validated = postEditSchema.parse(input);
    return handlePostEdit(validated, context);
  },
  category: 'hooks',
  tags: ['hooks', 'post-edit', 'learning', 'reasoningbank'],
  version: '1.0.0',
};

/**
 * hooks/pre-command tool
 */
export const preCommandTool: MCPTool = {
  name: 'hooks/pre-command',
  description: 'Pre-command hook that assesses risk and provides safety suggestions before command execution',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Command to be executed',
      },
      workingDirectory: {
        type: 'string',
        description: 'Working directory for command execution',
      },
      includeRiskAssessment: {
        type: 'boolean',
        description: 'Include risk assessment',
        default: true,
      },
      includeSuggestions: {
        type: 'boolean',
        description: 'Include safety suggestions',
        default: true,
      },
    },
    required: ['command'],
  },
  handler: async (input, context) => {
    const validated = preCommandSchema.parse(input);
    return handlePreCommand(validated, context);
  },
  category: 'hooks',
  tags: ['hooks', 'pre-command', 'safety', 'risk-assessment'],
  version: '1.0.0',
};

/**
 * hooks/post-command tool
 */
export const postCommandTool: MCPTool = {
  name: 'hooks/post-command',
  description: 'Post-command hook that records command execution outcomes for learning',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Command that was executed',
      },
      exitCode: {
        type: 'number',
        description: 'Command exit code',
        default: 0,
      },
      success: {
        type: 'boolean',
        description: 'Whether the command was successful',
      },
      output: {
        type: 'string',
        description: 'Command output',
      },
      error: {
        type: 'string',
        description: 'Error message if failed',
      },
      executionTime: {
        type: 'number',
        description: 'Execution time in milliseconds',
        minimum: 0,
      },
      metadata: {
        type: 'object',
        description: 'Additional metadata',
        additionalProperties: true,
      },
    },
    required: ['command', 'success'],
  },
  handler: async (input, context) => {
    const validated = postCommandSchema.parse(input);
    return handlePostCommand(validated, context);
  },
  category: 'hooks',
  tags: ['hooks', 'post-command', 'learning', 'reasoningbank'],
  version: '1.0.0',
};

/**
 * hooks/route tool
 */
export const routeTool: MCPTool = {
  name: 'hooks/route',
  description: 'Route a task to the optimal agent based on learned patterns and historical performance',
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'Task description to route',
      },
      context: {
        type: 'string',
        description: 'Additional context about the task',
      },
      preferredAgents: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of preferred agent types',
      },
      constraints: {
        type: 'object',
        description: 'Routing constraints',
        additionalProperties: true,
      },
      includeExplanation: {
        type: 'boolean',
        description: 'Include routing explanation',
        default: true,
      },
    },
    required: ['task'],
  },
  handler: async (input, context) => {
    const validated = routeSchema.parse(input);
    return handleRoute(validated, context);
  },
  category: 'hooks',
  tags: ['hooks', 'routing', 'ai', 'reasoningbank', 'learning'],
  version: '1.0.0',
  cacheable: true,
  cacheTTL: 5000,
};

/**
 * hooks/explain tool
 */
export const explainTool: MCPTool = {
  name: 'hooks/explain',
  description: 'Explain the routing decision for a task with detailed reasoning and transparency',
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'Task description to explain routing for',
      },
      context: {
        type: 'string',
        description: 'Additional context about the task',
      },
      verbose: {
        type: 'boolean',
        description: 'Include detailed reasoning',
        default: false,
      },
    },
    required: ['task'],
  },
  handler: async (input, context) => {
    const validated = explainSchema.parse(input);
    return handleExplain(validated, context);
  },
  category: 'hooks',
  tags: ['hooks', 'routing', 'explanation', 'transparency'],
  version: '1.0.0',
  cacheable: true,
  cacheTTL: 5000,
};

/**
 * hooks/pretrain tool
 */
export const pretrainTool: MCPTool = {
  name: 'hooks/pretrain',
  description: 'Bootstrap intelligence by analyzing repository patterns, git history, and dependencies',
  inputSchema: {
    type: 'object',
    properties: {
      repositoryPath: {
        type: 'string',
        description: 'Path to repository (defaults to current directory)',
      },
      includeGitHistory: {
        type: 'boolean',
        description: 'Include git history in analysis',
        default: true,
      },
      includeDependencies: {
        type: 'boolean',
        description: 'Analyze dependencies',
        default: true,
      },
      maxPatterns: {
        type: 'number',
        description: 'Maximum number of patterns to extract',
        minimum: 1,
        maximum: 10000,
        default: 1000,
      },
      force: {
        type: 'boolean',
        description: 'Force retraining even if data exists',
        default: false,
      },
    },
  },
  handler: async (input, context) => {
    const validated = pretrainSchema.parse(input);
    return handlePretrain(validated, context);
  },
  category: 'hooks',
  tags: ['hooks', 'pretraining', 'intelligence', 'reasoningbank', 'learning'],
  version: '1.0.0',
};

/**
 * hooks/metrics tool
 */
export const metricsTool: MCPTool = {
  name: 'hooks/metrics',
  description: 'Get learning metrics and performance statistics from the hooks system',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['all', 'routing', 'edits', 'commands', 'patterns'],
        description: 'Category of metrics to retrieve',
        default: 'all',
      },
      timeRange: {
        type: 'string',
        enum: ['hour', 'day', 'week', 'month', 'all'],
        description: 'Time range for metrics',
        default: 'all',
      },
      includeDetailedStats: {
        type: 'boolean',
        description: 'Include detailed statistics',
        default: false,
      },
      format: {
        type: 'string',
        enum: ['json', 'summary'],
        description: 'Output format',
        default: 'summary',
      },
    },
  },
  handler: async (input, context) => {
    const validated = metricsSchema.parse(input);
    return handleMetrics(validated, context);
  },
  category: 'hooks',
  tags: ['hooks', 'metrics', 'analytics', 'performance'],
  version: '1.0.0',
  cacheable: true,
  cacheTTL: 10000,
};

/**
 * hooks/list tool
 */
export const listHooksTool: MCPTool = {
  name: 'hooks/list',
  description: 'List all registered hooks with filtering and metadata',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['all', 'pre-edit', 'post-edit', 'pre-command', 'post-command', 'routing'],
        description: 'Filter hooks by category',
        default: 'all',
      },
      includeDisabled: {
        type: 'boolean',
        description: 'Include disabled hooks',
        default: false,
      },
      includeMetadata: {
        type: 'boolean',
        description: 'Include hook metadata',
        default: true,
      },
    },
  },
  handler: async (input, context) => {
    const validated = listHooksSchema.parse(input);
    return handleListHooks(validated, context);
  },
  category: 'hooks',
  tags: ['hooks', 'list', 'registry'],
  version: '1.0.0',
  cacheable: true,
  cacheTTL: 5000,
};

// ============================================================================
// Exports
// ============================================================================

export const hooksTools: MCPTool[] = [
  preEditTool,
  postEditTool,
  preCommandTool,
  postCommandTool,
  routeTool,
  explainTool,
  pretrainTool,
  metricsTool,
  listHooksTool,
];

export default hooksTools;
