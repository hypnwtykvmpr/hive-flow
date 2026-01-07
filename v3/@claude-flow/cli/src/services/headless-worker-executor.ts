/**
 * Headless Worker Executor
 * Enables workers to invoke Claude Code in headless mode with configurable sandbox profiles.
 *
 * Based on ADR-019 (Headless Runtime Package) and ADR-020 (Headless Worker Integration)
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import type { WorkerType } from './worker-daemon.js';

// Headless worker types - workers that can use Claude Code AI
export type HeadlessWorkerType =
  | 'audit'
  | 'optimize'
  | 'testgaps'
  | 'document'
  | 'ultralearn'
  | 'refactor'
  | 'deepdive'
  | 'predict';

// Local worker types - workers that run locally without AI
export type LocalWorkerType =
  | 'map'
  | 'consolidate'
  | 'benchmark'
  | 'preload';

// Array of headless worker types for runtime checking
export const HEADLESS_WORKERS: HeadlessWorkerType[] = [
  'audit',
  'optimize',
  'testgaps',
  'document',
  'ultralearn',
  'refactor',
  'deepdive',
  'predict',
];

// Sandbox modes
export type SandboxMode = 'strict' | 'permissive' | 'disabled';

// Model types
export type ModelType = 'sonnet' | 'opus' | 'haiku';

/**
 * Headless worker configuration
 */
export interface HeadlessWorkerConfig {
  type: HeadlessWorkerType;

  // Prompt template for Claude Code
  promptTemplate: string;

  // Sandbox profile
  sandbox: SandboxMode;

  // Model to use (default: sonnet)
  model?: ModelType;

  // Max output tokens
  maxOutputTokens?: number;

  // Timeout in ms (default: 5 minutes)
  timeoutMs?: number;

  // File patterns to include as context
  contextPatterns?: string[];

  // Output parsing format
  outputFormat?: 'text' | 'json' | 'markdown';
}

/**
 * Execution result from headless worker
 */
export interface HeadlessExecutionResult {
  success: boolean;
  output: string;
  parsedOutput?: unknown;
  durationMs: number;
  tokensUsed?: number;
  model: string;
  sandboxMode: SandboxMode;
  workerType: HeadlessWorkerType;
}

/**
 * Default headless worker configurations based on ADR-020
 */
export const HEADLESS_WORKER_CONFIGS: Record<HeadlessWorkerType, HeadlessWorkerConfig> = {
  audit: {
    type: 'audit',
    promptTemplate: `Analyze this codebase for security vulnerabilities:
- Check for hardcoded secrets (API keys, passwords)
- Identify SQL injection risks
- Find XSS vulnerabilities
- Check for insecure dependencies
- Identify authentication/authorization issues

Provide a JSON report with:
{
  "vulnerabilities": [{ "severity": "high|medium|low", "file": "...", "line": N, "description": "..." }],
  "riskScore": 0-100,
  "recommendations": ["..."]
}`,
    sandbox: 'strict',
    model: 'haiku',
    outputFormat: 'json',
    contextPatterns: ['**/*.ts', '**/*.js', '**/.env*', '**/package.json'],
    timeoutMs: 5 * 60 * 1000,
  },

  optimize: {
    type: 'optimize',
    promptTemplate: `Analyze this codebase for performance optimizations:
- Identify N+1 query patterns
- Find unnecessary re-renders in React
- Suggest caching opportunities
- Identify memory leaks
- Find redundant computations

Provide actionable suggestions with code examples.`,
    sandbox: 'permissive',
    model: 'sonnet',
    outputFormat: 'markdown',
    contextPatterns: ['src/**/*.ts', 'src/**/*.tsx'],
    timeoutMs: 10 * 60 * 1000,
  },

  testgaps: {
    type: 'testgaps',
    promptTemplate: `Analyze test coverage and identify gaps:
- Find untested functions and classes
- Identify edge cases not covered
- Suggest new test scenarios
- Check for missing error handling tests
- Identify integration test gaps

For each gap, provide a test skeleton.`,
    sandbox: 'permissive',
    model: 'sonnet',
    outputFormat: 'markdown',
    contextPatterns: ['src/**/*.ts', 'tests/**/*.ts', '__tests__/**/*.ts'],
    timeoutMs: 10 * 60 * 1000,
  },

  document: {
    type: 'document',
    promptTemplate: `Generate documentation for undocumented code:
- Add JSDoc comments to functions
- Create README sections for modules
- Document API endpoints
- Add inline comments for complex logic
- Generate usage examples

Focus on public APIs and exported functions.`,
    sandbox: 'permissive',
    model: 'haiku',
    outputFormat: 'markdown',
    contextPatterns: ['src/**/*.ts'],
    timeoutMs: 10 * 60 * 1000,
  },

  ultralearn: {
    type: 'ultralearn',
    promptTemplate: `Deeply analyze this codebase to learn:
- Architectural patterns used
- Coding conventions
- Domain-specific terminology
- Common patterns and idioms
- Team preferences

Store insights for future context.`,
    sandbox: 'strict',
    model: 'opus',
    outputFormat: 'json',
    contextPatterns: ['**/*.ts', '**/CLAUDE.md', '**/README.md'],
    timeoutMs: 15 * 60 * 1000,
  },

  refactor: {
    type: 'refactor',
    promptTemplate: `Suggest refactoring opportunities:
- Identify code duplication
- Suggest better abstractions
- Find opportunities for design patterns
- Identify overly complex functions
- Suggest module reorganization

Provide before/after code examples.`,
    sandbox: 'permissive',
    model: 'sonnet',
    outputFormat: 'markdown',
    contextPatterns: ['src/**/*.ts'],
    timeoutMs: 10 * 60 * 1000,
  },

  deepdive: {
    type: 'deepdive',
    promptTemplate: `Perform deep analysis of this codebase:
- Understand data flow
- Map dependencies
- Identify architectural issues
- Find potential bugs
- Analyze error handling

Provide comprehensive report.`,
    sandbox: 'strict',
    model: 'opus',
    outputFormat: 'markdown',
    contextPatterns: ['src/**/*.ts'],
    timeoutMs: 15 * 60 * 1000,
  },

  predict: {
    type: 'predict',
    promptTemplate: `Based on recent activity, predict what the developer needs:
- Files likely to be edited next
- Tests that should be run
- Documentation to reference
- Dependencies to check

Provide preload suggestions in JSON format:
{
  "filesToPreload": ["..."],
  "testsToRun": ["..."],
  "docsToReference": ["..."]
}`,
    sandbox: 'strict',
    model: 'haiku',
    outputFormat: 'json',
    contextPatterns: ['.claude-flow/metrics/*.json'],
    timeoutMs: 2 * 60 * 1000,
  },
};

/**
 * Check if a worker type is a headless worker
 */
export function isHeadlessWorker(type: WorkerType): type is HeadlessWorkerType {
  return HEADLESS_WORKERS.includes(type as HeadlessWorkerType);
}

/**
 * HeadlessWorkerExecutor - Executes workers using Claude Code in headless mode
 */
export class HeadlessWorkerExecutor extends EventEmitter {
  private projectRoot: string;
  private maxConcurrent: number;
  private activeProcesses: Map<string, ChildProcess> = new Map();
  private claudeCodeAvailable: boolean | null = null;

  constructor(projectRoot: string, options?: { maxConcurrent?: number }) {
    super();
    this.projectRoot = projectRoot;
    this.maxConcurrent = options?.maxConcurrent ?? 2;
  }

  /**
   * Check if Claude Code CLI is available
   */
  async isAvailable(): Promise<boolean> {
    if (this.claudeCodeAvailable !== null) {
      return this.claudeCodeAvailable;
    }

    try {
      execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
      this.claudeCodeAvailable = true;
      this.emit('availability:checked', { available: true });
      return true;
    } catch {
      this.claudeCodeAvailable = false;
      this.emit('availability:checked', { available: false });
      return false;
    }
  }

  /**
   * Execute a headless worker
   */
  async execute(workerType: HeadlessWorkerType): Promise<HeadlessExecutionResult> {
    const config = HEADLESS_WORKER_CONFIGS[workerType];
    if (!config) {
      throw new Error(`Unknown headless worker type: ${workerType}`);
    }

    const startTime = Date.now();
    const executionId = `${workerType}_${Date.now()}`;

    this.emit('execution:start', {
      executionId,
      workerType,
      config
    });

    try {
      // Check availability
      const available = await this.isAvailable();
      if (!available) {
        throw new Error('Claude Code CLI not available');
      }

      // Build context from file patterns
      const context = await this.buildContext(config.contextPatterns || []);

      // Build the full prompt
      const fullPrompt = this.buildPrompt(config.promptTemplate, context);

      // Execute Claude Code headlessly
      const result = await this.executeClaudeCode(fullPrompt, {
        sandbox: config.sandbox,
        model: config.model || 'sonnet',
        timeoutMs: config.timeoutMs || 300000,
        executionId,
      });

      // Parse output if JSON expected
      let parsedOutput: unknown;
      if (config.outputFormat === 'json' && result.output) {
        try {
          // Try to extract JSON from the output
          const jsonMatch = result.output.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsedOutput = JSON.parse(jsonMatch[0]);
          }
        } catch {
          // Keep raw output if parsing fails
        }
      }

      const executionResult: HeadlessExecutionResult = {
        success: result.success,
        output: result.output,
        parsedOutput,
        durationMs: Date.now() - startTime,
        tokensUsed: result.tokensUsed,
        model: config.model || 'sonnet',
        sandboxMode: config.sandbox,
        workerType,
      };

      this.emit('execution:complete', {
        executionId,
        result: executionResult
      });

      return executionResult;
    } catch (error) {
      const errorResult: HeadlessExecutionResult = {
        success: false,
        output: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
        model: config.model || 'sonnet',
        sandboxMode: config.sandbox,
        workerType,
      };

      this.emit('execution:error', {
        executionId,
        error: error instanceof Error ? error.message : String(error),
        result: errorResult
      });

      throw error;
    } finally {
      this.activeProcesses.delete(executionId);
    }
  }

  /**
   * Build context from file patterns
   */
  private async buildContext(patterns: string[]): Promise<string> {
    if (patterns.length === 0) return '';

    const files: string[] = [];

    for (const pattern of patterns) {
      const matches = this.simpleGlob(pattern);
      files.push(...matches);
    }

    // Limit to reasonable context size
    const maxFiles = 20;
    const maxCharsPerFile = 5000;
    const selectedFiles = [...new Set(files)].slice(0, maxFiles);

    const contextParts: string[] = [];
    for (const file of selectedFiles) {
      try {
        const fullPath = join(this.projectRoot, file);
        if (existsSync(fullPath)) {
          const content = readFileSync(fullPath, 'utf-8');
          const truncated = content.slice(0, maxCharsPerFile);
          const suffix = content.length > maxCharsPerFile ? '\n... (truncated)' : '';
          contextParts.push(`--- ${file} ---\n${truncated}${suffix}`);
        }
      } catch {
        // Skip unreadable files
      }
    }

    return contextParts.join('\n\n');
  }

  /**
   * Simple glob implementation for file matching
   */
  private simpleGlob(pattern: string): string[] {
    const results: string[] = [];

    // Handle simple patterns
    if (!pattern.includes('*')) {
      const fullPath = join(this.projectRoot, pattern);
      if (existsSync(fullPath)) {
        results.push(pattern);
      }
      return results;
    }

    // Handle recursive patterns like **/*.ts
    const parts = pattern.split('/');
    const hasRecursive = parts.includes('**');

    const scanDir = (dir: string, remainingParts: string[]): void => {
      if (remainingParts.length === 0) return;

      try {
        const entries = readdirSync(join(this.projectRoot, dir), { withFileTypes: true });
        const currentPart = remainingParts[0];
        const isLastPart = remainingParts.length === 1;

        for (const entry of entries) {
          const entryPath = dir ? `${dir}/${entry.name}` : entry.name;

          if (currentPart === '**') {
            // Recursive - match this level and descend
            if (entry.isDirectory()) {
              scanDir(entryPath, remainingParts); // Keep ** for deeper levels
              scanDir(entryPath, remainingParts.slice(1)); // Try next pattern part
            } else if (entry.isFile() && remainingParts.length > 1) {
              // Check if file matches next pattern
              const nextPart = remainingParts[1];
              if (this.matchesPattern(entry.name, nextPart)) {
                results.push(entryPath);
              }
            }
          } else if (this.matchesPattern(entry.name, currentPart)) {
            if (isLastPart && entry.isFile()) {
              results.push(entryPath);
            } else if (!isLastPart && entry.isDirectory()) {
              scanDir(entryPath, remainingParts.slice(1));
            }
          }
        }
      } catch {
        // Skip unreadable directories
      }
    };

    scanDir('', parts);
    return results.slice(0, 100); // Limit results
  }

  /**
   * Match filename against a simple pattern
   */
  private matchesPattern(name: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern === '**') return true;

    // Handle *.ext patterns
    if (pattern.startsWith('*.')) {
      const ext = pattern.slice(1);
      return name.endsWith(ext);
    }

    // Handle prefix* patterns
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      return name.startsWith(prefix);
    }

    // Exact match
    return name === pattern;
  }

  /**
   * Build full prompt with context
   */
  private buildPrompt(template: string, context: string): string {
    if (!context) {
      return template;
    }

    return `${template}

## Codebase Context

${context}

## Instructions

Analyze the above codebase context and provide your response following the format specified in the task.`;
  }

  /**
   * Execute Claude Code in headless mode
   */
  private async executeClaudeCode(
    prompt: string,
    options: {
      sandbox: SandboxMode;
      model: ModelType;
      timeoutMs: number;
      executionId: string;
    }
  ): Promise<{ success: boolean; output: string; tokensUsed?: number }> {
    return new Promise((resolve, reject) => {
      // Map model names to API model IDs
      const modelMap: Record<ModelType, string> = {
        sonnet: 'claude-sonnet-4-20250514',
        opus: 'claude-opus-4-20250514',
        haiku: 'claude-haiku-4-20250514',
      };

      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        CLAUDE_CODE_HEADLESS: 'true',
        CLAUDE_CODE_SANDBOX_MODE: options.sandbox,
      };

      // Set model if specified
      if (options.model) {
        env.ANTHROPIC_MODEL = modelMap[options.model];
      }

      // Spawn claude CLI process
      const child = spawn('claude', ['--print', prompt], {
        cwd: this.projectRoot,
        env,
        timeout: options.timeoutMs,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.activeProcesses.set(options.executionId, child);

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        this.emit('output', {
          executionId: options.executionId,
          type: 'stdout',
          data: chunk
        });
      });

      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        this.emit('output', {
          executionId: options.executionId,
          type: 'stderr',
          data: chunk
        });
      });

      child.on('close', (code: number | null) => {
        this.activeProcesses.delete(options.executionId);
        resolve({
          success: code === 0,
          output: stdout || stderr,
        });
      });

      child.on('error', (error: Error) => {
        this.activeProcesses.delete(options.executionId);
        reject(error);
      });

      // Setup timeout
      const timeoutId = setTimeout(() => {
        if (this.activeProcesses.has(options.executionId)) {
          child.kill('SIGTERM');
          reject(new Error(`Execution timed out after ${options.timeoutMs}ms`));
        }
      }, options.timeoutMs);

      child.on('close', () => {
        clearTimeout(timeoutId);
      });
    });
  }

  /**
   * Cancel a running execution
   */
  cancel(executionId: string): boolean {
    const process = this.activeProcesses.get(executionId);
    if (process) {
      process.kill('SIGTERM');
      this.activeProcesses.delete(executionId);
      this.emit('execution:cancelled', { executionId });
      return true;
    }
    return false;
  }

  /**
   * Get number of active executions
   */
  getActiveCount(): number {
    return this.activeProcesses.size;
  }

  /**
   * Cancel all running executions
   */
  cancelAll(): void {
    for (const [id, process] of this.activeProcesses) {
      process.kill('SIGTERM');
      this.emit('execution:cancelled', { executionId: id });
    }
    this.activeProcesses.clear();
  }

  /**
   * Get worker configuration
   */
  getConfig(workerType: HeadlessWorkerType): HeadlessWorkerConfig | undefined {
    return HEADLESS_WORKER_CONFIGS[workerType];
  }
}

export default HeadlessWorkerExecutor;
