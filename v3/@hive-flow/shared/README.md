# @hive-flow/shared


> Shared utilities, types, and core infrastructure for Hive Flow V3 - the foundation module used by all other @hive-flow packages.

## Features

- **Core Types** - Agent, Task, Memory, MCP, and Swarm type definitions
- **Core Interfaces** - Agent, Task, Memory, Event, and Coordinator interfaces
- **Configuration** - Schema validation, loading, and default values
- **Event System** - Event bus, coordinator, and handler utilities
- **Hooks System** - Pre/post execution hooks for extensibility
- **MCP Infrastructure** - Server, transport, connection pool, and tool registry
- **Health Monitoring** - Health checks and monitoring utilities

## Quick Start

```typescript
import {
  AgentState,
  TaskDefinition,
  MemoryEntry,
  EventBus,
  ConfigLoader
} from '@hive-flow/shared';

// Use shared types
const agent: AgentState = {
  id: { id: 'agent-1', swarmId: 'swarm-1', type: 'coder' },
  name: 'Code Agent',
  type: 'coder',
  status: 'idle'
};

// Use configuration
const config = await ConfigLoader.load('./config.json');

// Use event system
const eventBus = new EventBus();
eventBus.on('task.completed', (event) => {
  console.log(`Task ${event.taskId} completed`);
});
```

## Package Exports

```typescript
// Main entry (recommended - includes all modules)
import { ... } from '@hive-flow/shared';

// Submodule exports (for tree-shaking or specific imports)
import { ... } from '@hive-flow/shared/types';      // Type definitions
import { ... } from '@hive-flow/shared/core';       // Config, interfaces, orchestrator
import { ... } from '@hive-flow/shared/events';     // Event sourcing (ADR-007)
import { ... } from '@hive-flow/shared/hooks';      // Hooks system
import { ... } from '@hive-flow/shared/mcp';        // MCP server infrastructure
import { ... } from '@hive-flow/shared/security';   // Security utilities
import { ... } from '@hive-flow/shared/resilience'; // Retry, circuit breaker, rate limiter
```

## API Reference

### Types

```typescript
import type {
  // Agent types
  AgentId,
  AgentState,
  AgentType,
  AgentStatus,
  AgentCapabilities,
  AgentMetrics,

  // Task types
  TaskId,
  TaskDefinition,
  TaskType,
  TaskStatus,
  TaskPriority,

  // Memory types
  MemoryEntry,
  MemoryType,
  SearchResult,

  // Swarm types
  SwarmId,
  SwarmStatus,
  SwarmEvent,
  CoordinatorConfig,

  // MCP types
  MCPTool,
  MCPRequest,
  MCPResponse
} from '@hive-flow/shared/types';
```

### Core Interfaces

```typescript
import type {
  IAgent,
  ITask,
  IMemory,
  ICoordinator,
  IEventHandler
} from '@hive-flow/shared/core';

// Agent interface
interface IAgent {
  getId(): AgentId;
  getState(): AgentState;
  execute(task: TaskDefinition): Promise<TaskResult>;
  handleMessage(message: Message): Promise<void>;
}

// Memory interface
interface IMemory {
  store(entry: MemoryEntry): Promise<string>;
  retrieve(id: string): Promise<MemoryEntry | null>;
  search(query: SearchQuery): Promise<SearchResult[]>;
  delete(id: string): Promise<boolean>;
}

// Coordinator interface
interface ICoordinator {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  registerAgent(agent: IAgent): Promise<string>;
  submitTask(task: TaskDefinition): Promise<string>;
}
```

### Configuration

```typescript
import {
  ConfigLoader,
  ConfigValidator,
  defaultConfig,
  ConfigSchema
} from '@hive-flow/shared/core';

// Load configuration
const config = await ConfigLoader.load('./config.json');
const config2 = await ConfigLoader.loadFromEnv();

// Validate configuration
const errors = ConfigValidator.validate(config);
if (errors.length > 0) {
  console.error('Invalid config:', errors);
}

// Default configuration
const defaults = defaultConfig();
```

### Event System

```typescript
import { EventBus, EventCoordinator } from '@hive-flow/shared/events';

const eventBus = new EventBus();

// Subscribe to events
eventBus.on('agent.joined', (event) => {
  console.log(`Agent ${event.agentId} joined`);
});

eventBus.on('task.*', (event) => {
  console.log(`Task event: ${event.type}`);
});

// Emit events
eventBus.emit({
  type: 'task.completed',
  taskId: 'task-1',
  result: { success: true }
});

// Event coordinator for complex workflows
const coordinator = new EventCoordinator();
coordinator.orchestrate([
  { event: 'step1.done', handler: () => startStep2() },
  { event: 'step2.done', handler: () => startStep3() }
]);
```

### Hooks System

```typescript
import { HooksManager, Hook } from '@hive-flow/shared/hooks';

const hooks = new HooksManager();

// Register pre-execution hook
hooks.register('pre:task', async (context) => {
  console.log(`Starting task: ${context.taskId}`);
  return { ...context, startTime: Date.now() };
});

// Register post-execution hook
hooks.register('post:task', async (context, result) => {
  const duration = Date.now() - context.startTime;
  console.log(`Task completed in ${duration}ms`);
});

// Execute with hooks
const result = await hooks.execute('task', context, async (ctx) => {
  return await runTask(ctx);
});
```

### MCP Infrastructure

```typescript
import {
  createMCPServer,
  createToolRegistry,
  createConnectionPool,
  createSessionManager,
  defineTool,
  quickStart,
} from '@hive-flow/shared/mcp';

// Quick start - simplest way to create an MCP server
const server = await quickStart({
  transport: 'stdio',
  name: 'My MCP Server',
});

// Tool registry
const registry = createToolRegistry();
registry.register(defineTool({
  name: 'swarm_init',
  description: 'Initialize a swarm',
  inputSchema: { type: 'object', properties: { topology: { type: 'string' } } },
  handler: async (params) => ({ result: 'initialized' }),
}));

// Connection pool
const pool = createConnectionPool({
  maxConnections: 10,
  acquireTimeoutMs: 30000,
});

// Session manager
const sessions = createSessionManager({ timeoutMs: 3600000 });
const session = await sessions.create({ clientInfo: { name: 'client' } });
```

### Health Monitor

```typescript
import { HealthMonitor, HealthCheck } from '@hive-flow/shared/core';

const monitor = new HealthMonitor();

// Register health checks
monitor.register('database', async () => {
  const connected = await db.ping();
  return { healthy: connected, latency: pingTime };
});

monitor.register('memory', async () => {
  const usage = process.memoryUsage();
  return { healthy: usage.heapUsed < MAX_HEAP, usage };
});

// Run health checks
const report = await monitor.check();
// { overall: 'healthy', checks: { database: {...}, memory: {...} } }
```

## TypeScript Types

All types are fully exported and documented:

```typescript
// Re-export all types
export * from './types/agent.types';
export * from './types/task.types';
export * from './types/memory.types';
export * from './types/swarm.types';
export * from './types/mcp.types';
```

## Dependencies

- `sql.js` - SQLite WASM for cross-platform persistence

## Used By

This package is a dependency of all other @hive-flow modules:

- [@hive-flow/cli](../cli) - CLI module
- [@hive-flow/security](../security) - Security & validation
- [@hive-flow/memory](../memory) - HiveMemory & HNSW indexing
- [@hive-flow/cli/neural](../cli/docs/neural/) - SONA learning & RL algorithms
- [@hive-flow/cli/performance](../cli/docs/performance) - Benchmarking & optimization
- [@hive-flow/cli/swarm](../cli/docs/swarm) - 15-agent coordination
- [@hive-flow/cli/integration](../cli/src/integration) - local compatibility API bridge
- [@hive-flow/cli/testing](../cli/src/testing) - TDD framework & fixtures
- [@hive-flow/embeddings](../embeddings) - Embedding service
- [@hive-flow/cli/hooks](../cli/docs/hooks/) - Hooks system

## License

MIT
