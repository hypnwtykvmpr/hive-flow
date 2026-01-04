# @claude-flow/swarm

V3 Unified Swarm Coordination Module implementing ADR-003: Single Coordination Engine

## Architecture (ADR-003)

This module provides **ONE canonical coordination engine**: `UnifiedSwarmCoordinator`

### Key Components

```
@claude-flow/swarm
├── UnifiedSwarmCoordinator ⭐ CANONICAL ENGINE (use this)
│   ├── 15-agent domain routing
│   ├── Parallel execution
│   ├── Consensus algorithms
│   ├── Topology management
│   └── Performance: <100ms coordination
│
└── SwarmHub (deprecated)
    └── Thin facade for backward compatibility
```

## Quick Start (Recommended)

```typescript
import { createUnifiedSwarmCoordinator } from '@claude-flow/swarm';

// Create coordinator
const coordinator = createUnifiedSwarmCoordinator({
  topology: { type: 'hierarchical', maxAgents: 15 },
  consensus: { algorithm: 'raft', threshold: 0.66 },
});

// Initialize
await coordinator.initialize();

// Spawn 15-agent hierarchy
const agents = await coordinator.spawnFullHierarchy();
console.log(`Spawned ${agents.size} agents across 5 domains`);

// Submit tasks to specific domains
const securityTaskId = await coordinator.submitTask({
  type: 'review',
  name: 'CVE Security Audit',
  priority: 'critical',
  maxRetries: 3,
});

await coordinator.assignTaskToDomain(securityTaskId, 'security');

// Parallel execution across domains
const results = await coordinator.executeParallel([
  { task: { type: 'coding', name: 'Core Implementation' }, domain: 'core' },
  { task: { type: 'testing', name: 'Security Tests' }, domain: 'security' },
  { task: { type: 'documentation', name: 'API Docs' }, domain: 'integration' },
]);

console.log(`Completed ${results.filter(r => r.success).length} tasks in parallel`);

// Get swarm status
const status = coordinator.getStatus();
console.log('Domain Status:', status.domains);
console.log('Metrics:', status.metrics);

// Shutdown
await coordinator.shutdown();
```

## 15-Agent Domain Architecture

The coordinator manages 5 domains with specific agent assignments:

| Domain | Agents | Capabilities |
|--------|--------|--------------|
| **Queen** | 1 | Top-level coordination, consensus, planning |
| **Security** | 2-4 | Security architecture, CVE fixes, threat modeling |
| **Core** | 5-9 | DDD design, memory unification, type modernization |
| **Integration** | 10-12 | agentic-flow integration, CLI, neural features |
| **Support** | 13-15 | TDD testing, performance, deployment |

### Domain-Based Task Routing

```typescript
// Route tasks to optimal domains
await coordinator.assignTaskToDomain(securityTask, 'security');
await coordinator.assignTaskToDomain(coreTask, 'core');
await coordinator.assignTaskToDomain(integrationTask, 'integration');

// Get agents by domain
const securityAgents = coordinator.getAgentsByDomain('security');
console.log(`Security domain has ${securityAgents.length} agents`);

// Get domain status
const status = coordinator.getStatus();
status.domains.forEach(domain => {
  console.log(`${domain.name}: ${domain.availableAgents}/${domain.agentCount} available`);
});
```

## Parallel Execution

Execute tasks across multiple domains simultaneously for maximum throughput:

```typescript
const tasks = [
  { task: { type: 'coding', name: 'Implement Auth' }, domain: 'core' },
  { task: { type: 'testing', name: 'Security Tests' }, domain: 'security' },
  { task: { type: 'review', name: 'Code Review' }, domain: 'support' },
];

const results = await coordinator.executeParallel(tasks);

// Check results
results.forEach(result => {
  if (result.success) {
    console.log(`✅ ${result.domain}: ${result.durationMs}ms`);
  } else {
    console.error(`❌ ${result.domain}: ${result.error?.message}`);
  }
});
```

## Topology Support

Choose the coordination pattern that fits your needs:

### Hierarchical (Default)
```typescript
const coordinator = createUnifiedSwarmCoordinator({
  topology: { type: 'hierarchical', maxAgents: 15 },
});
```
- Queen agent coordinates domain leads
- Domain leads manage worker agents
- Best for 15-agent V3 architecture

### Mesh
```typescript
const coordinator = createUnifiedSwarmCoordinator({
  topology: { type: 'mesh', maxAgents: 15 },
});
```
- All agents communicate peer-to-peer
- No central coordinator
- Best for distributed workloads

### Centralized
```typescript
const coordinator = createUnifiedSwarmCoordinator({
  topology: { type: 'centralized', maxAgents: 15 },
});
```
- Single coordinator manages all agents
- Simplest to reason about
- Best for small swarms

## Consensus Algorithms

Choose how agents reach agreement:

### Raft (Default)
```typescript
const coordinator = createUnifiedSwarmCoordinator({
  consensus: { algorithm: 'raft', threshold: 0.66 },
});
```
- Leader-based consensus
- Strong consistency guarantees
- Target: <100ms consensus time

### Byzantine Fault Tolerance
```typescript
const coordinator = createUnifiedSwarmCoordinator({
  consensus: { algorithm: 'byzantine', threshold: 0.66 },
});
```
- Handles malicious agents
- Byzantine fault tolerance
- Higher overhead but more secure

### Gossip Protocol
```typescript
const coordinator = createUnifiedSwarmCoordinator({
  consensus: { algorithm: 'gossip', threshold: 0.66 },
});
```
- Eventual consistency
- Low overhead
- Best for large swarms

## Performance Targets

The coordinator is optimized for V3 performance requirements:

| Metric | Target | Actual |
|--------|--------|--------|
| Coordination Latency | <100ms | Verified in tests |
| Consensus Time | <100ms | Verified in tests |
| Message Throughput | >1000 msgs/sec | Verified in tests |
| Agent Utilization | >85% | Achieved via parallel execution |

### Performance Monitoring

```typescript
const report = coordinator.getPerformanceReport();

console.log('Coordination Latency:', {
  p50: report.coordinationLatencyP50,
  p99: report.coordinationLatencyP99,
});

console.log('Throughput:', {
  messagesPerSec: report.messagesPerSecond,
  tasksPerSec: report.taskThroughput,
});

console.log('Utilization:', {
  agentUtilization: report.agentUtilization,
  consensusSuccessRate: report.consensusSuccessRate,
});
```

## Backward Compatibility (SwarmHub)

For existing code using `SwarmHub`, the compatibility layer is maintained:

```typescript
import { createSwarmHub } from '@claude-flow/swarm';

// ⚠️ DEPRECATED: Use createUnifiedSwarmCoordinator() instead
const hub = createSwarmHub();
await hub.initialize();

// SwarmHub delegates all operations to UnifiedSwarmCoordinator
const coordinator = hub.getCoordinator();

// Use coordinator for advanced features
await coordinator.executeParallel(tasks);
```

### Migration from SwarmHub

```typescript
// OLD (deprecated)
import { createSwarmHub } from '@claude-flow/swarm';
const hub = createSwarmHub();
await hub.initialize();
await hub.spawnAllAgents();

// NEW (recommended)
import { createUnifiedSwarmCoordinator } from '@claude-flow/swarm';
const coordinator = createUnifiedSwarmCoordinator();
await coordinator.initialize();
await coordinator.spawnFullHierarchy();
```

## Advanced Features

### Agent Pool Management

```typescript
// Get domain-specific pool
const corePool = coordinator.getDomainPool('core');
const stats = corePool?.getPoolStats();

console.log('Core Domain Pool:', {
  total: stats?.total,
  available: stats?.available,
  busy: stats?.busy,
});
```

### Custom Agent Registration

```typescript
// Register agent with automatic domain assignment
const { agentId, domain } = await coordinator.registerAgentWithDomain(
  {
    name: 'security-agent-2',
    type: 'specialist',
    status: 'idle',
    capabilities: {
      codeReview: true,
      securityAudit: true,
    },
    // ... other agent properties
  },
  2 // Agent number 2 → security domain
);

console.log(`Registered ${agentId} in ${domain} domain`);
```

### Event Monitoring

```typescript
coordinator.on('agent.joined', (event) => {
  console.log('Agent joined:', event.data.agentId);
});

coordinator.on('task.completed', (event) => {
  console.log('Task completed:', event.data.taskId);
});

coordinator.on('consensus.achieved', (event) => {
  console.log('Consensus achieved:', event.data.approvalRate);
});

coordinator.on('swarm.initialized', (event) => {
  console.log('Swarm initialized:', event.data.swarmId);
});
```

## API Reference

### UnifiedSwarmCoordinator

#### Lifecycle
- `initialize(): Promise<void>` - Initialize coordinator
- `shutdown(): Promise<void>` - Shutdown coordinator
- `pause(): Promise<void>` - Pause operations
- `resume(): Promise<void>` - Resume operations

#### Agent Management
- `registerAgent(agent): Promise<string>` - Register agent
- `registerAgentWithDomain(agent, number): Promise<{agentId, domain}>` - Register with domain
- `unregisterAgent(id): Promise<void>` - Unregister agent
- `spawnFullHierarchy(): Promise<Map<number, {agentId, domain}>>` - Spawn 15 agents
- `getAgent(id): AgentState | undefined` - Get agent by ID
- `getAllAgents(): AgentState[]` - Get all agents
- `getAgentsByDomain(domain): AgentState[]` - Get agents in domain

#### Task Management
- `submitTask(task): Promise<string>` - Submit task
- `assignTaskToDomain(taskId, domain): Promise<string | undefined>` - Assign to domain
- `executeParallel(tasks): Promise<ParallelExecutionResult[]>` - Parallel execution
- `cancelTask(taskId): Promise<void>` - Cancel task
- `getTask(id): TaskDefinition | undefined` - Get task by ID

#### Coordination
- `proposeConsensus(value): Promise<ConsensusResult>` - Propose consensus
- `broadcastMessage(payload, priority): Promise<void>` - Broadcast message

#### Monitoring
- `getState(): CoordinatorState` - Get current state
- `getMetrics(): CoordinatorMetrics` - Get metrics
- `getPerformanceReport(): PerformanceReport` - Get performance stats
- `getStatus(): {swarmId, status, domains, metrics}` - Get comprehensive status

## Contributing

This module follows ADR-003: Single Coordination Engine. When contributing:

1. **All coordination logic** goes in `UnifiedSwarmCoordinator`
2. **SwarmHub** is a thin facade - no new logic there
3. **Domain-based routing** should be used for 15-agent hierarchy
4. **Performance targets** must be maintained (<100ms coordination)

## License

MIT

---

**ADR-003 Compliance**: This module implements a single canonical coordination engine with backward compatibility via facade pattern.
