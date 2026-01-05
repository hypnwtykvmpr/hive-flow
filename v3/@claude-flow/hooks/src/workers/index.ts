/**
 * V3 Workers System - Cross-Platform Background Workers
 *
 * Optimizes Claude Flow with non-blocking, scheduled workers.
 * Works on Linux, macOS, and Windows.
 */

import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

// ============================================================================
// Types
// ============================================================================

export interface WorkerConfig {
  name: string;
  description: string;
  interval: number;  // milliseconds
  enabled: boolean;
  priority: WorkerPriority;
  timeout: number;
  platforms?: ('linux' | 'darwin' | 'win32')[];
}

export enum WorkerPriority {
  Critical = 0,
  High = 1,
  Normal = 2,
  Low = 3,
  Background = 4,
}

export interface WorkerResult {
  worker: string;
  success: boolean;
  duration: number;
  data?: Record<string, unknown>;
  error?: string;
  timestamp: Date;
}

export interface WorkerMetrics {
  name: string;
  status: 'running' | 'idle' | 'error' | 'disabled';
  lastRun?: Date;
  lastDuration?: number;
  runCount: number;
  errorCount: number;
  avgDuration: number;
  lastResult?: Record<string, unknown>;
}

export interface WorkerManagerStatus {
  running: boolean;
  platform: string;
  workers: WorkerMetrics[];
  uptime: number;
  totalRuns: number;
  lastUpdate: Date;
}

export type WorkerHandler = () => Promise<WorkerResult>;

// ============================================================================
// Worker Definitions
// ============================================================================

export const WORKER_CONFIGS: Record<string, WorkerConfig> = {
  'performance': {
    name: 'performance',
    description: 'Benchmark search, memory, startup performance',
    interval: 300_000,  // 5 min
    enabled: true,
    priority: WorkerPriority.Normal,
    timeout: 30_000,
  },
  'health': {
    name: 'health',
    description: 'Monitor disk, memory, CPU, processes',
    interval: 300_000,  // 5 min
    enabled: true,
    priority: WorkerPriority.High,
    timeout: 10_000,
  },
  'patterns': {
    name: 'patterns',
    description: 'Consolidate, dedupe, optimize learned patterns',
    interval: 900_000,  // 15 min
    enabled: true,
    priority: WorkerPriority.Normal,
    timeout: 60_000,
  },
  'ddd': {
    name: 'ddd',
    description: 'Track DDD domain implementation progress',
    interval: 600_000,  // 10 min
    enabled: true,
    priority: WorkerPriority.Low,
    timeout: 30_000,
  },
  'adr': {
    name: 'adr',
    description: 'Check ADR compliance across codebase',
    interval: 900_000,  // 15 min
    enabled: true,
    priority: WorkerPriority.Low,
    timeout: 60_000,
  },
  'security': {
    name: 'security',
    description: 'Scan for secrets, vulnerabilities, CVEs',
    interval: 1_800_000,  // 30 min
    enabled: true,
    priority: WorkerPriority.High,
    timeout: 120_000,
  },
  'learning': {
    name: 'learning',
    description: 'Optimize learning, SONA adaptation',
    interval: 1_800_000,  // 30 min
    enabled: true,
    priority: WorkerPriority.Normal,
    timeout: 60_000,
  },
  'cache': {
    name: 'cache',
    description: 'Clean temp files, old logs, stale cache',
    interval: 3_600_000,  // 1 hour
    enabled: true,
    priority: WorkerPriority.Background,
    timeout: 30_000,
  },
  'git': {
    name: 'git',
    description: 'Track uncommitted changes, branch status',
    interval: 300_000,  // 5 min
    enabled: true,
    priority: WorkerPriority.Normal,
    timeout: 10_000,
  },
  'swarm': {
    name: 'swarm',
    description: 'Monitor swarm activity, agent coordination',
    interval: 60_000,  // 1 min
    enabled: true,
    priority: WorkerPriority.High,
    timeout: 10_000,
  },
};

// ============================================================================
// Worker Manager
// ============================================================================

export class WorkerManager extends EventEmitter {
  private workers: Map<string, WorkerHandler> = new Map();
  private metrics: Map<string, WorkerMetrics> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private running = false;
  private startTime?: Date;
  private projectRoot: string;
  private metricsDir: string;

  constructor(projectRoot?: string) {
    super();
    this.projectRoot = projectRoot || process.cwd();
    this.metricsDir = path.join(this.projectRoot, '.claude-flow', 'metrics');
    this.initializeMetrics();
  }

  private initializeMetrics(): void {
    for (const [name, config] of Object.entries(WORKER_CONFIGS)) {
      this.metrics.set(name, {
        name,
        status: config.enabled ? 'idle' : 'disabled',
        runCount: 0,
        errorCount: 0,
        avgDuration: 0,
      });
    }
  }

  /**
   * Register a worker handler
   */
  register(name: string, handler: WorkerHandler): void {
    this.workers.set(name, handler);
    this.emit('worker:registered', { name });
  }

  /**
   * Start all workers
   */
  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;
    this.startTime = new Date();

    await this.ensureMetricsDir();

    for (const [name, config] of Object.entries(WORKER_CONFIGS)) {
      if (!config.enabled) continue;
      if (config.platforms && !config.platforms.includes(os.platform() as any)) continue;

      this.scheduleWorker(name, config);
    }

    this.emit('manager:started');
  }

  /**
   * Stop all workers
   */
  stop(): void {
    this.running = false;

    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    this.emit('manager:stopped');
  }

  /**
   * Run a specific worker immediately
   */
  async runWorker(name: string): Promise<WorkerResult> {
    const handler = this.workers.get(name);
    const config = WORKER_CONFIGS[name];
    const metrics = this.metrics.get(name);

    if (!handler || !config || !metrics) {
      return {
        worker: name,
        success: false,
        duration: 0,
        error: `Worker '${name}' not found`,
        timestamp: new Date(),
      };
    }

    metrics.status = 'running';
    const startTime = Date.now();

    try {
      const result = await Promise.race([
        handler(),
        new Promise<WorkerResult>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), config.timeout)
        ),
      ]);

      const duration = Date.now() - startTime;

      metrics.status = 'idle';
      metrics.lastRun = new Date();
      metrics.lastDuration = duration;
      metrics.runCount++;
      metrics.avgDuration = (metrics.avgDuration * (metrics.runCount - 1) + duration) / metrics.runCount;
      metrics.lastResult = result.data;

      this.emit('worker:completed', { name, result, duration });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      metrics.status = 'error';
      metrics.errorCount++;
      metrics.lastRun = new Date();

      const result: WorkerResult = {
        worker: name,
        success: false,
        duration,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date(),
      };

      this.emit('worker:error', { name, error, duration });

      return result;
    }
  }

  /**
   * Run all workers (non-blocking)
   */
  async runAll(): Promise<WorkerResult[]> {
    const promises = Array.from(this.workers.keys()).map(name =>
      this.runWorker(name)
    );
    return Promise.all(promises);
  }

  /**
   * Get worker status
   */
  getStatus(): WorkerManagerStatus {
    return {
      running: this.running,
      platform: os.platform(),
      workers: Array.from(this.metrics.values()),
      uptime: this.startTime ? Date.now() - this.startTime.getTime() : 0,
      totalRuns: Array.from(this.metrics.values()).reduce((sum, m) => sum + m.runCount, 0),
      lastUpdate: new Date(),
    };
  }

  /**
   * Get statusline-friendly metrics
   */
  getStatuslineMetrics(): Record<string, unknown> {
    const workers = Array.from(this.metrics.values());
    const running = workers.filter(w => w.status === 'running').length;
    const errors = workers.filter(w => w.status === 'error').length;
    const total = workers.filter(w => w.status !== 'disabled').length;

    return {
      workersActive: running,
      workersTotal: total,
      workersError: errors,
      lastResults: Object.fromEntries(
        workers
          .filter(w => w.lastResult)
          .map(w => [w.name, w.lastResult])
      ),
    };
  }

  private scheduleWorker(name: string, config: WorkerConfig): void {
    const run = async () => {
      if (!this.running) return;

      await this.runWorker(name);

      if (this.running) {
        this.timers.set(name, setTimeout(run, config.interval));
      }
    };

    // Initial run with staggered start
    const stagger = config.priority * 1000;
    this.timers.set(name, setTimeout(run, stagger));
  }

  private async ensureMetricsDir(): Promise<void> {
    try {
      await fs.mkdir(this.metricsDir, { recursive: true });
    } catch {
      // Directory may already exist
    }
  }
}

// ============================================================================
// Built-in Worker Implementations
// ============================================================================

export function createPerformanceWorker(projectRoot: string): WorkerHandler {
  return async (): Promise<WorkerResult> => {
    const startTime = Date.now();

    // Cross-platform memory check
    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memPct = Math.round((1 - freeMem / totalMem) * 100);

    // CPU load
    const cpus = os.cpus();
    const loadAvg = os.loadavg()[0];

    // V3 codebase stats
    let v3Lines = 0;
    try {
      const v3Path = path.join(projectRoot, 'v3');
      v3Lines = await countLines(v3Path, '.ts');
    } catch {
      // V3 dir may not exist
    }

    return {
      worker: 'performance',
      success: true,
      duration: Date.now() - startTime,
      timestamp: new Date(),
      data: {
        memory: {
          heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
          systemPct: memPct,
        },
        cpu: {
          cores: cpus.length,
          loadAvg: loadAvg.toFixed(2),
        },
        codebase: {
          v3Lines,
        },
        speedup: '1.0x',  // Placeholder
      },
    };
  };
}

export function createHealthWorker(projectRoot: string): WorkerHandler {
  return async (): Promise<WorkerResult> => {
    const startTime = Date.now();

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memPct = Math.round((1 - freeMem / totalMem) * 100);

    const uptime = os.uptime();
    const loadAvg = os.loadavg();

    // Disk space (cross-platform approximation)
    let diskPct = 0;
    let diskFree = 'N/A';
    try {
      const stats = await fs.statfs(projectRoot);
      diskPct = Math.round((1 - stats.bavail / stats.blocks) * 100);
      diskFree = `${Math.round(stats.bavail * stats.bsize / 1024 / 1024 / 1024)}GB`;
    } catch {
      // statfs may not be available on all platforms
    }

    const status = memPct > 90 || diskPct > 90 ? 'critical' :
                   memPct > 80 || diskPct > 80 ? 'warning' : 'healthy';

    return {
      worker: 'health',
      success: true,
      duration: Date.now() - startTime,
      timestamp: new Date(),
      data: {
        status,
        memory: { usedPct: memPct, freeMB: Math.round(freeMem / 1024 / 1024) },
        disk: { usedPct: diskPct, free: diskFree },
        system: {
          uptime: Math.round(uptime / 3600),
          loadAvg: loadAvg.map(l => l.toFixed(2)),
          platform: os.platform(),
          arch: os.arch(),
        },
      },
    };
  };
}

export function createSwarmWorker(projectRoot: string): WorkerHandler {
  return async (): Promise<WorkerResult> => {
    const startTime = Date.now();

    // Check for swarm activity file
    const activityPath = path.join(projectRoot, '.claude-flow', 'metrics', 'swarm-activity.json');
    let swarmData: Record<string, unknown> = {};

    try {
      const content = await fs.readFile(activityPath, 'utf-8');
      swarmData = JSON.parse(content);
    } catch {
      // No activity file
    }

    // Check for queue messages
    const queuePath = path.join(projectRoot, '.claude-flow', 'swarm', 'queue');
    let queueCount = 0;
    try {
      const files = await fs.readdir(queuePath);
      queueCount = files.filter(f => f.endsWith('.json')).length;
    } catch {
      // No queue dir
    }

    return {
      worker: 'swarm',
      success: true,
      duration: Date.now() - startTime,
      timestamp: new Date(),
      data: {
        active: (swarmData as any)?.swarm?.active ?? false,
        agentCount: (swarmData as any)?.swarm?.agent_count ?? 0,
        queuePending: queueCount,
        lastUpdate: (swarmData as any)?.timestamp ?? null,
      },
    };
  };
}

export function createGitWorker(projectRoot: string): WorkerHandler {
  return async (): Promise<WorkerResult> => {
    const startTime = Date.now();
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    let gitData: Record<string, unknown> = {
      available: false,
    };

    try {
      const [branch, status, log] = await Promise.all([
        execAsync('git branch --show-current', { cwd: projectRoot }),
        execAsync('git status --porcelain', { cwd: projectRoot }),
        execAsync('git log -1 --format=%H', { cwd: projectRoot }),
      ]);

      const changes = status.stdout.trim().split('\n').filter(Boolean);

      gitData = {
        available: true,
        branch: branch.stdout.trim(),
        uncommitted: changes.length,
        lastCommit: log.stdout.trim().slice(0, 7),
        staged: changes.filter(c => c.startsWith('A ') || c.startsWith('M ')).length,
        modified: changes.filter(c => c.startsWith(' M') || c.startsWith('??')).length,
      };
    } catch {
      // Git not available or not a repo
    }

    return {
      worker: 'git',
      success: true,
      duration: Date.now() - startTime,
      timestamp: new Date(),
      data: gitData,
    };
  };
}

export function createLearningWorker(projectRoot: string): WorkerHandler {
  return async (): Promise<WorkerResult> => {
    const startTime = Date.now();

    const patternsDbPath = path.join(projectRoot, '.claude-flow', 'learning', 'patterns.db');
    let learningData: Record<string, unknown> = {
      patternsDb: false,
      shortTerm: 0,
      longTerm: 0,
      avgQuality: 0,
    };

    try {
      await fs.access(patternsDbPath);
      learningData.patternsDb = true;

      // Read learning metrics if available
      const metricsPath = path.join(projectRoot, '.claude-flow', 'metrics', 'learning.json');
      try {
        const content = await fs.readFile(metricsPath, 'utf-8');
        const metrics = JSON.parse(content);
        learningData = {
          ...learningData,
          shortTerm: metrics.patterns?.shortTerm ?? 0,
          longTerm: metrics.patterns?.longTerm ?? 0,
          avgQuality: metrics.patterns?.avgQuality ?? 0,
          routingAccuracy: metrics.routing?.accuracy ?? 0,
          intelligenceScore: metrics.intelligence?.score ?? 0,
        };
      } catch {
        // No metrics file
      }
    } catch {
      // No patterns DB
    }

    return {
      worker: 'learning',
      success: true,
      duration: Date.now() - startTime,
      timestamp: new Date(),
      data: learningData,
    };
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

async function countLines(dir: string, ext: string): Promise<number> {
  let total = 0;

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        total += await countLines(fullPath, ext);
      } else if (entry.isFile() && entry.name.endsWith(ext)) {
        const content = await fs.readFile(fullPath, 'utf-8');
        total += content.split('\n').length;
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return total;
}

// ============================================================================
// Factory
// ============================================================================

export function createWorkerManager(projectRoot?: string): WorkerManager {
  const root = projectRoot || process.cwd();
  const manager = new WorkerManager(root);

  // Register built-in workers
  manager.register('performance', createPerformanceWorker(root));
  manager.register('health', createHealthWorker(root));
  manager.register('swarm', createSwarmWorker(root));
  manager.register('git', createGitWorker(root));
  manager.register('learning', createLearningWorker(root));

  return manager;
}

// Default instance
export const workerManager = createWorkerManager();
