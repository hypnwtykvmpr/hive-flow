/**
 * Agent Coordination Benchmark
 *
 * Target: <50ms for coordination operations
 *
 * Measures agent-to-agent coordination including message passing,
 * state synchronization, and coordination patterns.
 */

import { benchmark, BenchmarkRunner, formatTime, meetsTarget } from '../framework/benchmark.js';

// ============================================================================
// Agent Types and Coordination
// ============================================================================

interface Agent {
  id: string;
  type: string;
  status: 'idle' | 'busy' | 'waiting';
  inbox: Message[];
  outbox: Message[];
}

interface Message {
  id: string;
  from: string;
  to: string;
  type: 'request' | 'response' | 'broadcast' | 'heartbeat';
  payload: unknown;
  timestamp: number;
}

interface CoordinationResult {
  success: boolean;
  latency: number;
  messagesExchanged: number;
}

/**
 * Simple message broker for agent communication
 */
class MessageBroker {
  private agents = new Map<string, Agent>();
  private messageQueue: Message[] = [];

  register(agent: Agent): void {
    this.agents.set(agent.id, agent);
  }

  send(message: Message): void {
    this.messageQueue.push(message);
    const recipient = this.agents.get(message.to);
    if (recipient) {
      recipient.inbox.push(message);
    }
  }

  broadcast(from: string, type: string, payload: unknown): void {
    for (const [id, agent] of this.agents) {
      if (id !== from) {
        const message: Message = {
          id: `msg-${Date.now()}-${Math.random()}`,
          from,
          to: id,
          type: 'broadcast',
          payload,
          timestamp: Date.now(),
        };
        agent.inbox.push(message);
        this.messageQueue.push(message);
      }
    }
  }

  processMessage(agentId: string): Message | undefined {
    const agent = this.agents.get(agentId);
    if (agent && agent.inbox.length > 0) {
      return agent.inbox.shift();
    }
    return undefined;
  }

  get totalMessages(): number {
    return this.messageQueue.length;
  }
}

/**
 * Hierarchical coordinator for multi-agent orchestration
 */
class HierarchicalCoordinator {
  private queen: Agent;
  private workers: Agent[] = [];
  private broker: MessageBroker;

  constructor(numWorkers: number) {
    this.broker = new MessageBroker();

    this.queen = {
      id: 'queen',
      type: 'coordinator',
      status: 'idle',
      inbox: [],
      outbox: [],
    };
    this.broker.register(this.queen);

    for (let i = 0; i < numWorkers; i++) {
      const worker: Agent = {
        id: `worker-${i}`,
        type: 'worker',
        status: 'idle',
        inbox: [],
        outbox: [],
      };
      this.workers.push(worker);
      this.broker.register(worker);
    }
  }

  async delegateTask(task: unknown): Promise<CoordinationResult> {
    const startTime = performance.now();
    let messagesExchanged = 0;

    // Queen broadcasts task
    this.broker.broadcast(this.queen.id, 'task', task);
    messagesExchanged += this.workers.length;

    // Workers acknowledge
    for (const worker of this.workers) {
      const ack: Message = {
        id: `ack-${Date.now()}`,
        from: worker.id,
        to: this.queen.id,
        type: 'response',
        payload: { status: 'accepted' },
        timestamp: Date.now(),
      };
      this.broker.send(ack);
      messagesExchanged++;
    }

    // Process acknowledgments
    while (this.queen.inbox.length > 0) {
      this.broker.processMessage(this.queen.id);
    }

    return {
      success: true,
      latency: performance.now() - startTime,
      messagesExchanged,
    };
  }

  async gatherResults(): Promise<CoordinationResult> {
    const startTime = performance.now();
    let messagesExchanged = 0;

    // Request results from all workers
    for (const worker of this.workers) {
      const request: Message = {
        id: `req-${Date.now()}`,
        from: this.queen.id,
        to: worker.id,
        type: 'request',
        payload: { action: 'getResults' },
        timestamp: Date.now(),
      };
      this.broker.send(request);
      messagesExchanged++;
    }

    // Workers send results
    for (const worker of this.workers) {
      this.broker.processMessage(worker.id);
      const response: Message = {
        id: `res-${Date.now()}`,
        from: worker.id,
        to: this.queen.id,
        type: 'response',
        payload: { results: ['data'] },
        timestamp: Date.now(),
      };
      this.broker.send(response);
      messagesExchanged++;
    }

    // Queen processes all results
    while (this.queen.inbox.length > 0) {
      this.broker.processMessage(this.queen.id);
    }

    return {
      success: true,
      latency: performance.now() - startTime,
      messagesExchanged,
    };
  }

  get workerCount(): number {
    return this.workers.length;
  }
}

/**
 * Mesh coordinator for peer-to-peer communication
 */
class MeshCoordinator {
  private agents: Agent[] = [];
  private broker: MessageBroker;

  constructor(numAgents: number) {
    this.broker = new MessageBroker();

    for (let i = 0; i < numAgents; i++) {
      const agent: Agent = {
        id: `mesh-agent-${i}`,
        type: 'peer',
        status: 'idle',
        inbox: [],
        outbox: [],
      };
      this.agents.push(agent);
      this.broker.register(agent);
    }
  }

  async gossip(originId: number, data: unknown): Promise<CoordinationResult> {
    const startTime = performance.now();
    let messagesExchanged = 0;

    const visited = new Set<string>();
    const queue: string[] = [this.agents[originId]!.id];
    visited.add(this.agents[originId]!.id);

    while (queue.length > 0) {
      const current = queue.shift()!;

      // Send to 2-3 random peers
      const numPeers = Math.min(3, this.agents.length - visited.size);
      const peers = this.agents
        .filter((a) => !visited.has(a.id))
        .slice(0, numPeers);

      for (const peer of peers) {
        const message: Message = {
          id: `gossip-${Date.now()}`,
          from: current,
          to: peer.id,
          type: 'broadcast',
          payload: data,
          timestamp: Date.now(),
        };
        this.broker.send(message);
        messagesExchanged++;
        visited.add(peer.id);
        queue.push(peer.id);
      }
    }

    return {
      success: visited.size === this.agents.length,
      latency: performance.now() - startTime,
      messagesExchanged,
    };
  }

  get agentCount(): number {
    return this.agents.length;
  }
}

// ============================================================================
// Benchmark Suite
// ============================================================================

export async function runAgentCoordinationBenchmarks(): Promise<void> {
  const runner = new BenchmarkRunner('Agent Coordination');

  console.log('\n--- Agent Coordination Benchmarks ---\n');

  // Benchmark 1: Create Message Broker
  const brokerCreateResult = await runner.run(
    'create-message-broker',
    async () => {
      const broker = new MessageBroker();
      void broker;
    },
    { iterations: 10000 }
  );

  console.log(`Create Message Broker: ${formatTime(brokerCreateResult.mean)}`);

  // Benchmark 2: Register Agent
  const broker = new MessageBroker();

  const registerResult = await runner.run(
    'register-agent',
    async () => {
      const agent: Agent = {
        id: `agent-${Date.now()}`,
        type: 'worker',
        status: 'idle',
        inbox: [],
        outbox: [],
      };
      broker.register(agent);
    },
    { iterations: 5000 }
  );

  console.log(`Register Agent: ${formatTime(registerResult.mean)}`);

  // Benchmark 3: Send Single Message
  const sender: Agent = { id: 'sender', type: 'worker', status: 'idle', inbox: [], outbox: [] };
  const receiver: Agent = { id: 'receiver', type: 'worker', status: 'idle', inbox: [], outbox: [] };
  broker.register(sender);
  broker.register(receiver);

  const sendMessageResult = await runner.run(
    'send-message',
    async () => {
      const message: Message = {
        id: `msg-${Date.now()}`,
        from: 'sender',
        to: 'receiver',
        type: 'request',
        payload: { data: 'test' },
        timestamp: Date.now(),
      };
      broker.send(message);
    },
    { iterations: 10000 }
  );

  console.log(`Send Message: ${formatTime(sendMessageResult.mean)}`);

  // Benchmark 4: Hierarchical Coordination - 5 Workers
  const hierCoord5 = new HierarchicalCoordinator(5);

  const hierDelegate5Result = await runner.run(
    'hierarchical-delegate-5-workers',
    async () => {
      await hierCoord5.delegateTask({ action: 'process', data: [1, 2, 3] });
    },
    { iterations: 500 }
  );

  console.log(`Hierarchical Delegate (5 workers): ${formatTime(hierDelegate5Result.mean)}`);
  const coordTarget = meetsTarget('agent-coordination', hierDelegate5Result.mean);
  console.log(`  Target (<50ms): ${coordTarget.met ? 'PASS' : 'FAIL'}`);

  // Benchmark 5: Hierarchical Coordination - 15 Workers
  const hierCoord15 = new HierarchicalCoordinator(15);

  const hierDelegate15Result = await runner.run(
    'hierarchical-delegate-15-workers',
    async () => {
      await hierCoord15.delegateTask({ action: 'process', data: [1, 2, 3] });
    },
    { iterations: 200 }
  );

  console.log(`Hierarchical Delegate (15 workers): ${formatTime(hierDelegate15Result.mean)}`);

  // Benchmark 6: Gather Results - 5 Workers
  const gather5Result = await runner.run(
    'hierarchical-gather-5-workers',
    async () => {
      await hierCoord5.gatherResults();
    },
    { iterations: 500 }
  );

  console.log(`Hierarchical Gather (5 workers): ${formatTime(gather5Result.mean)}`);

  // Benchmark 7: Gather Results - 15 Workers
  const gather15Result = await runner.run(
    'hierarchical-gather-15-workers',
    async () => {
      await hierCoord15.gatherResults();
    },
    { iterations: 200 }
  );

  console.log(`Hierarchical Gather (15 workers): ${formatTime(gather15Result.mean)}`);

  // Benchmark 8: Mesh Gossip - 10 Peers
  const meshCoord10 = new MeshCoordinator(10);

  const gossip10Result = await runner.run(
    'mesh-gossip-10-peers',
    async () => {
      await meshCoord10.gossip(0, { data: 'gossip message' });
    },
    { iterations: 500 }
  );

  console.log(`Mesh Gossip (10 peers): ${formatTime(gossip10Result.mean)}`);

  // Benchmark 9: Mesh Gossip - 50 Peers
  const meshCoord50 = new MeshCoordinator(50);

  const gossip50Result = await runner.run(
    'mesh-gossip-50-peers',
    async () => {
      await meshCoord50.gossip(0, { data: 'gossip message' });
    },
    { iterations: 100 }
  );

  console.log(`Mesh Gossip (50 peers): ${formatTime(gossip50Result.mean)}`);

  // Benchmark 10: Full Coordination Cycle
  const hierCoordFull = new HierarchicalCoordinator(10);

  const fullCycleResult = await runner.run(
    'full-coordination-cycle',
    async () => {
      await hierCoordFull.delegateTask({ action: 'compute' });
      await hierCoordFull.gatherResults();
    },
    { iterations: 200 }
  );

  console.log(`Full Coordination Cycle (10 workers): ${formatTime(fullCycleResult.mean)}`);

  // Summary
  console.log('\n--- Summary ---');
  console.log(`Message passing: ${formatTime(sendMessageResult.mean)}`);
  console.log(`5-worker coordination: ${formatTime(hierDelegate5Result.mean)}`);
  console.log(`15-worker coordination: ${formatTime(hierDelegate15Result.mean)}`);
  console.log(`Gossip (10 peers): ${formatTime(gossip10Result.mean)}`);
  console.log(`Gossip (50 peers): ${formatTime(gossip50Result.mean)}`);
  console.log(`\nScaling: 5->15 workers = ${(hierDelegate15Result.mean / hierDelegate5Result.mean).toFixed(2)}x`);
  console.log(`Scaling: 10->50 peers = ${(gossip50Result.mean / gossip10Result.mean).toFixed(2)}x`);

  // Print full results
  runner.printResults();
}

// ============================================================================
// Agent Coordination Optimization Strategies
// ============================================================================

export const coordinationOptimizations = {
  /**
   * Message batching
   */
  messageBatching: {
    description: 'Batch multiple messages to reduce overhead',
    expectedImprovement: '3-5x',
    implementation: `
      class BatchedBroker {
        private batch: Message[] = [];
        private batchSize = 100;

        send(message: Message): void {
          this.batch.push(message);
          if (this.batch.length >= this.batchSize) {
            this.flush();
          }
        }

        private flush(): void {
          for (const msg of this.batch) {
            this.deliver(msg);
          }
          this.batch = [];
        }
      }
    `,
  },

  /**
   * Zero-copy messaging
   */
  zeroCopyMessaging: {
    description: 'Share references instead of copying data',
    expectedImprovement: '2-4x for large payloads',
    implementation: `
      interface SharedMessage {
        id: string;
        payload: SharedArrayBuffer;
      }

      function createSharedMessage(data: Uint8Array): SharedMessage {
        const sab = new SharedArrayBuffer(data.length);
        const view = new Uint8Array(sab);
        view.set(data);
        return { id: generateId(), payload: sab };
      }
    `,
  },

  /**
   * Hierarchical aggregation
   */
  hierarchicalAggregation: {
    description: 'Aggregate results in tree structure to reduce queen load',
    expectedImprovement: 'O(log n) instead of O(n)',
    implementation: `
      class HierarchicalAggregator {
        async aggregate(workers: Agent[]): Promise<Result> {
          // Create tree of aggregators
          const levels = Math.ceil(Math.log2(workers.length));
          let current = workers.map(w => w.result);

          for (let level = 0; level < levels; level++) {
            const next = [];
            for (let i = 0; i < current.length; i += 2) {
              next.push(this.combine(current[i], current[i + 1]));
            }
            current = next;
          }

          return current[0];
        }
      }
    `,
  },

  /**
   * Async message processing
   */
  asyncProcessing: {
    description: 'Process messages asynchronously with backpressure',
    expectedImprovement: '2-3x throughput',
    implementation: `
      class AsyncBroker {
        private queue = new AsyncQueue<Message>();

        async process(): Promise<void> {
          while (true) {
            const messages = await this.queue.dequeue(100); // Batch up to 100
            await Promise.all(messages.map(m => this.handle(m)));
          }
        }
      }
    `,
  },

  /**
   * Local-first coordination
   */
  localFirstCoordination: {
    description: 'Process locally when possible, coordinate only when needed',
    expectedImprovement: '5-10x for local operations',
    implementation: `
      class LocalFirstCoordinator {
        canProcessLocally(task: Task): boolean {
          return task.dependencies.every(d => this.hasLocal(d));
        }

        async execute(task: Task): Promise<Result> {
          if (this.canProcessLocally(task)) {
            return this.executeLocal(task);
          }
          return this.executeDistributed(task);
        }
      }
    `,
  },
};

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAgentCoordinationBenchmarks().catch(console.error);
}

export default runAgentCoordinationBenchmarks;
