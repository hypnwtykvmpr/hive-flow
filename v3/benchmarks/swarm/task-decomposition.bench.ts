/**
 * Task Decomposition Benchmark
 *
 * Target: <20ms for task decomposition
 *
 * Measures the time to decompose complex tasks into subtasks
 * for parallel execution by multiple agents.
 */

import { benchmark, BenchmarkRunner, formatTime, meetsTarget } from '../framework/benchmark.js';

// ============================================================================
// Task Types
// ============================================================================

interface Task {
  id: string;
  type: string;
  description: string;
  priority: number;
  dependencies: string[];
  estimatedDuration: number;
  assignedTo?: string;
}

interface SubTask extends Task {
  parentId: string;
  order: number;
}

interface TaskGraph {
  tasks: Map<string, Task>;
  edges: Map<string, string[]>; // task -> dependencies
}

interface DecompositionResult {
  subtasks: SubTask[];
  parallelGroups: SubTask[][];
  criticalPath: string[];
  estimatedTotalTime: number;
}

// ============================================================================
// Task Decomposition Strategies
// ============================================================================

/**
 * Simple linear decomposition
 */
function linearDecompose(task: Task, numParts: number): SubTask[] {
  const subtasks: SubTask[] = [];

  for (let i = 0; i < numParts; i++) {
    subtasks.push({
      id: `${task.id}-part-${i}`,
      parentId: task.id,
      type: task.type,
      description: `Part ${i + 1} of ${task.description}`,
      priority: task.priority,
      dependencies: i > 0 ? [`${task.id}-part-${i - 1}`] : task.dependencies,
      estimatedDuration: task.estimatedDuration / numParts,
      order: i,
    });
  }

  return subtasks;
}

/**
 * Parallel decomposition (all subtasks independent)
 */
function parallelDecompose(task: Task, numParts: number): SubTask[] {
  const subtasks: SubTask[] = [];

  for (let i = 0; i < numParts; i++) {
    subtasks.push({
      id: `${task.id}-parallel-${i}`,
      parentId: task.id,
      type: task.type,
      description: `Parallel chunk ${i + 1} of ${task.description}`,
      priority: task.priority,
      dependencies: task.dependencies, // All depend only on parent's deps
      estimatedDuration: task.estimatedDuration / numParts,
      order: i,
    });
  }

  return subtasks;
}

/**
 * DAG-based decomposition with topological sort
 */
function dagDecompose(tasks: Task[]): DecompositionResult {
  const graph: TaskGraph = {
    tasks: new Map(tasks.map((t) => [t.id, t])),
    edges: new Map(tasks.map((t) => [t.id, t.dependencies])),
  };

  // Topological sort using Kahn's algorithm
  const inDegree = new Map<string, number>();
  for (const task of tasks) {
    inDegree.set(task.id, 0);
  }

  for (const [, deps] of graph.edges) {
    for (const dep of deps) {
      inDegree.set(dep, (inDegree.get(dep) || 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  const sorted: string[] = [];
  const parallelGroups: SubTask[][] = [];

  while (queue.length > 0) {
    // All tasks in current queue can run in parallel
    const currentGroup: SubTask[] = [];
    const nextQueue: string[] = [];

    for (const taskId of queue) {
      const task = graph.tasks.get(taskId)!;
      currentGroup.push({
        ...task,
        parentId: 'root',
        order: sorted.length,
      });
      sorted.push(taskId);

      // Reduce in-degree of dependent tasks
      for (const [depId, deps] of graph.edges) {
        if (deps.includes(taskId)) {
          const newDegree = (inDegree.get(depId) || 1) - 1;
          inDegree.set(depId, newDegree);
          if (newDegree === 0) {
            nextQueue.push(depId);
          }
        }
      }
    }

    if (currentGroup.length > 0) {
      parallelGroups.push(currentGroup);
    }
    queue.length = 0;
    queue.push(...nextQueue);
  }

  // Find critical path
  const criticalPath = findCriticalPath(tasks, sorted);

  // Calculate estimated total time (parallel execution)
  const estimatedTotalTime = parallelGroups.reduce(
    (total, group) => total + Math.max(...group.map((t) => t.estimatedDuration)),
    0
  );

  return {
    subtasks: parallelGroups.flat(),
    parallelGroups,
    criticalPath,
    estimatedTotalTime,
  };
}

/**
 * Find critical path in task graph
 */
function findCriticalPath(tasks: Task[], sorted: string[]): string[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const longestPath = new Map<string, number>();
  const predecessor = new Map<string, string>();

  for (const taskId of sorted) {
    const task = taskMap.get(taskId)!;
    let maxPredDuration = 0;
    let maxPredId = '';

    for (const depId of task.dependencies) {
      const predDuration = longestPath.get(depId) || 0;
      if (predDuration > maxPredDuration) {
        maxPredDuration = predDuration;
        maxPredId = depId;
      }
    }

    longestPath.set(taskId, maxPredDuration + task.estimatedDuration);
    if (maxPredId) {
      predecessor.set(taskId, maxPredId);
    }
  }

  // Find task with longest path
  let maxTask = '';
  let maxDuration = 0;
  for (const [taskId, duration] of longestPath) {
    if (duration > maxDuration) {
      maxDuration = duration;
      maxTask = taskId;
    }
  }

  // Reconstruct path
  const path: string[] = [];
  let current = maxTask;
  while (current) {
    path.unshift(current);
    current = predecessor.get(current) || '';
  }

  return path;
}

/**
 * SPARC-based decomposition
 */
function sparcDecompose(task: Task): SubTask[] {
  const phases = [
    { name: 'specification', ratio: 0.1 },
    { name: 'pseudocode', ratio: 0.15 },
    { name: 'architecture', ratio: 0.2 },
    { name: 'refinement', ratio: 0.4 },
    { name: 'completion', ratio: 0.15 },
  ];

  const subtasks: SubTask[] = [];
  let prevId = '';

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i]!;
    const subtask: SubTask = {
      id: `${task.id}-${phase.name}`,
      parentId: task.id,
      type: phase.name,
      description: `${phase.name.charAt(0).toUpperCase() + phase.name.slice(1)} for ${task.description}`,
      priority: task.priority,
      dependencies: prevId ? [prevId] : task.dependencies,
      estimatedDuration: task.estimatedDuration * phase.ratio,
      order: i,
    };
    subtasks.push(subtask);
    prevId = subtask.id;
  }

  return subtasks;
}

// ============================================================================
// Benchmark Suite
// ============================================================================

export async function runTaskDecompositionBenchmarks(): Promise<void> {
  const runner = new BenchmarkRunner('Task Decomposition');

  console.log('\n--- Task Decomposition Benchmarks ---\n');

  // Create sample tasks
  const sampleTask: Task = {
    id: 'task-1',
    type: 'development',
    description: 'Implement user authentication',
    priority: 1,
    dependencies: [],
    estimatedDuration: 100,
  };

  const complexTasks: Task[] = Array.from({ length: 50 }, (_, i) => ({
    id: `task-${i}`,
    type: 'development',
    description: `Task ${i}`,
    priority: Math.floor(Math.random() * 10),
    dependencies: i > 0 ? [`task-${Math.floor(Math.random() * i)}`] : [],
    estimatedDuration: 10 + Math.random() * 90,
  }));

  // Benchmark 1: Linear Decomposition
  const linearResult = await runner.run(
    'linear-decompose-10',
    async () => {
      linearDecompose(sampleTask, 10);
    },
    { iterations: 5000 }
  );

  console.log(`Linear Decompose (10 parts): ${formatTime(linearResult.mean)}`);
  const decomposeTarget = meetsTarget('task-decomposition', linearResult.mean);
  console.log(`  Target (<20ms): ${decomposeTarget.met ? 'PASS' : 'FAIL'}`);

  // Benchmark 2: Parallel Decomposition
  const parallelResult = await runner.run(
    'parallel-decompose-10',
    async () => {
      parallelDecompose(sampleTask, 10);
    },
    { iterations: 5000 }
  );

  console.log(`Parallel Decompose (10 parts): ${formatTime(parallelResult.mean)}`);

  // Benchmark 3: SPARC Decomposition
  const sparcResult = await runner.run(
    'sparc-decompose',
    async () => {
      sparcDecompose(sampleTask);
    },
    { iterations: 5000 }
  );

  console.log(`SPARC Decompose (5 phases): ${formatTime(sparcResult.mean)}`);

  // Benchmark 4: DAG Decomposition - Small (10 tasks)
  const smallTasks = complexTasks.slice(0, 10);

  const dagSmallResult = await runner.run(
    'dag-decompose-10-tasks',
    async () => {
      dagDecompose(smallTasks);
    },
    { iterations: 1000 }
  );

  console.log(`DAG Decompose (10 tasks): ${formatTime(dagSmallResult.mean)}`);

  // Benchmark 5: DAG Decomposition - Medium (50 tasks)
  const dagMediumResult = await runner.run(
    'dag-decompose-50-tasks',
    async () => {
      dagDecompose(complexTasks);
    },
    { iterations: 500 }
  );

  console.log(`DAG Decompose (50 tasks): ${formatTime(dagMediumResult.mean)}`);

  // Benchmark 6: Critical Path Finding
  const sorted = complexTasks.map((t) => t.id);

  const criticalPathResult = await runner.run(
    'find-critical-path-50',
    async () => {
      findCriticalPath(complexTasks, sorted);
    },
    { iterations: 1000 }
  );

  console.log(`Find Critical Path (50 tasks): ${formatTime(criticalPathResult.mean)}`);

  // Benchmark 7: Large Decomposition (100 subtasks)
  const largeLinearResult = await runner.run(
    'linear-decompose-100',
    async () => {
      linearDecompose(sampleTask, 100);
    },
    { iterations: 1000 }
  );

  console.log(`Linear Decompose (100 parts): ${formatTime(largeLinearResult.mean)}`);

  // Benchmark 8: Nested Decomposition
  const nestedResult = await runner.run(
    'nested-decompose',
    async () => {
      // First level
      const level1 = parallelDecompose(sampleTask, 5);
      // Second level - decompose each part
      const level2: SubTask[] = [];
      for (const subtask of level1) {
        level2.push(...linearDecompose(subtask, 4));
      }
    },
    { iterations: 1000 }
  );

  console.log(`Nested Decompose (5x4=20): ${formatTime(nestedResult.mean)}`);

  // Benchmark 9: Task Prioritization
  const prioritizeResult = await runner.run(
    'task-prioritization-50',
    async () => {
      const sorted = [...complexTasks].sort((a, b) => b.priority - a.priority);
      void sorted;
    },
    { iterations: 5000 }
  );

  console.log(`Task Prioritization (50 tasks): ${formatTime(prioritizeResult.mean)}`);

  // Benchmark 10: Dependency Resolution
  const dependencyResult = await runner.run(
    'dependency-resolution-50',
    async () => {
      const resolved = new Set<string>();
      const pending = [...complexTasks];

      while (pending.length > 0) {
        const ready = pending.filter((t) =>
          t.dependencies.every((d) => resolved.has(d))
        );
        for (const task of ready) {
          resolved.add(task.id);
          const idx = pending.indexOf(task);
          if (idx >= 0) pending.splice(idx, 1);
        }
        if (ready.length === 0) break; // Circular dependency
      }
    },
    { iterations: 500 }
  );

  console.log(`Dependency Resolution (50 tasks): ${formatTime(dependencyResult.mean)}`);

  // Summary
  console.log('\n--- Summary ---');
  console.log(`Simple decomposition: ${formatTime(linearResult.mean)}`);
  console.log(`SPARC decomposition: ${formatTime(sparcResult.mean)}`);
  console.log(`DAG (10 tasks): ${formatTime(dagSmallResult.mean)}`);
  console.log(`DAG (50 tasks): ${formatTime(dagMediumResult.mean)}`);
  console.log(`\nScaling: 10->50 tasks = ${(dagMediumResult.mean / dagSmallResult.mean).toFixed(2)}x`);
  console.log(`Per-task cost (50): ${formatTime(dagMediumResult.mean / 50)}`);

  // Print full results
  runner.printResults();
}

// ============================================================================
// Task Decomposition Optimization Strategies
// ============================================================================

export const decompositionOptimizations = {
  /**
   * Cached dependency graph
   */
  cachedDependencyGraph: {
    description: 'Cache computed dependency graphs for reuse',
    expectedImprovement: '5-10x for repeated operations',
    implementation: `
      class CachedTaskGraph {
        private graphCache = new Map<string, TaskGraph>();

        getGraph(taskId: string): TaskGraph {
          if (!this.graphCache.has(taskId)) {
            this.graphCache.set(taskId, this.buildGraph(taskId));
          }
          return this.graphCache.get(taskId)!;
        }
      }
    `,
  },

  /**
   * Incremental decomposition
   */
  incrementalDecomposition: {
    description: 'Decompose tasks incrementally as needed',
    expectedImprovement: '2-3x for large task sets',
    implementation: `
      class IncrementalDecomposer {
        private decomposed = new Map<string, SubTask[]>();

        decomposeOnDemand(task: Task, depth: number): SubTask[] {
          if (depth === 0) return [this.toSubTask(task)];

          if (!this.decomposed.has(task.id)) {
            const subtasks = this.decompose(task);
            this.decomposed.set(task.id, subtasks);
          }

          return this.decomposed.get(task.id)!.flatMap(
            st => this.decomposeOnDemand(st, depth - 1)
          );
        }
      }
    `,
  },

  /**
   * Parallel decomposition processing
   */
  parallelProcessing: {
    description: 'Decompose independent branches in parallel',
    expectedImprovement: '2-4x on multi-core systems',
    implementation: `
      async function parallelDecompose(tasks: Task[]): Promise<SubTask[]> {
        const independentGroups = findIndependentGroups(tasks);
        const results = await Promise.all(
          independentGroups.map(group => decompose(group))
        );
        return results.flat();
      }
    `,
  },

  /**
   * Template-based decomposition
   */
  templateDecomposition: {
    description: 'Use pre-defined templates for common task types',
    expectedImprovement: '10x for known task types',
    implementation: `
      const templates = new Map<string, DecompositionTemplate>();

      templates.set('feature', {
        phases: ['design', 'implement', 'test', 'document'],
        ratios: [0.1, 0.5, 0.3, 0.1],
      });

      function templateDecompose(task: Task): SubTask[] {
        const template = templates.get(task.type);
        if (template) {
          return applyTemplate(task, template);
        }
        return defaultDecompose(task);
      }
    `,
  },

  /**
   * Heuristic-based splitting
   */
  heuristicSplitting: {
    description: 'Use heuristics to determine optimal split points',
    expectedImprovement: '20-30% better parallelism',
    implementation: `
      function heuristicSplit(task: Task): number {
        // Based on task complexity, type, and available workers
        const baseChunks = Math.ceil(task.estimatedDuration / 30);
        const maxChunks = Math.min(baseChunks, availableWorkers);
        return Math.max(1, maxChunks);
      }
    `,
  },
};

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTaskDecompositionBenchmarks().catch(console.error);
}

export default runTaskDecompositionBenchmarks;
