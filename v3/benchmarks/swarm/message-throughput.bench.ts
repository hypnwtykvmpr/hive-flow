/**
 * Message Throughput Benchmark
 *
 * Target: <0.1ms per message
 *
 * Measures message passing throughput between agents including
 * serialization, routing, and delivery.
 */

import { benchmark, BenchmarkRunner, formatTime, meetsTarget } from '../framework/benchmark.js';

// ============================================================================
// Message Types
// ============================================================================

interface Message {
  id: string;
  type: string;
  from: string;
  to: string;
  payload: unknown;
  timestamp: number;
  headers?: Record<string, string>;
}

interface MessageStats {
  sent: number;
  received: number;
  dropped: number;
  latencySum: number;
}

// ============================================================================
// Message Channel Implementations
// ============================================================================

/**
 * Simple synchronous message channel
 */
class SyncChannel {
  private handlers = new Map<string, (msg: Message) => void>();
  private stats: MessageStats = { sent: 0, received: 0, dropped: 0, latencySum: 0 };

  subscribe(agentId: string, handler: (msg: Message) => void): void {
    this.handlers.set(agentId, handler);
  }

  send(message: Message): boolean {
    this.stats.sent++;
    const handler = this.handlers.get(message.to);
    if (handler) {
      handler(message);
      this.stats.received++;
      this.stats.latencySum += Date.now() - message.timestamp;
      return true;
    }
    this.stats.dropped++;
    return false;
  }

  getStats(): MessageStats {
    return { ...this.stats };
  }

  reset(): void {
    this.stats = { sent: 0, received: 0, dropped: 0, latencySum: 0 };
  }
}

/**
 * Async message queue with buffering
 */
class AsyncMessageQueue {
  private queues = new Map<string, Message[]>();
  private stats: MessageStats = { sent: 0, received: 0, dropped: 0, latencySum: 0 };
  private maxQueueSize = 1000;

  enqueue(message: Message): boolean {
    this.stats.sent++;

    let queue = this.queues.get(message.to);
    if (!queue) {
      queue = [];
      this.queues.set(message.to, queue);
    }

    if (queue.length >= this.maxQueueSize) {
      this.stats.dropped++;
      return false;
    }

    queue.push(message);
    return true;
  }

  dequeue(agentId: string): Message | undefined {
    const queue = this.queues.get(agentId);
    if (queue && queue.length > 0) {
      const message = queue.shift()!;
      this.stats.received++;
      this.stats.latencySum += Date.now() - message.timestamp;
      return message;
    }
    return undefined;
  }

  dequeueAll(agentId: string): Message[] {
    const queue = this.queues.get(agentId) || [];
    this.queues.set(agentId, []);
    this.stats.received += queue.length;
    for (const msg of queue) {
      this.stats.latencySum += Date.now() - msg.timestamp;
    }
    return queue;
  }

  getStats(): MessageStats {
    return { ...this.stats };
  }

  reset(): void {
    this.queues.clear();
    this.stats = { sent: 0, received: 0, dropped: 0, latencySum: 0 };
  }
}

/**
 * Pub/Sub message broker
 */
class PubSubBroker {
  private topics = new Map<string, Set<string>>();
  private handlers = new Map<string, (msg: Message) => void>();
  private stats: MessageStats = { sent: 0, received: 0, dropped: 0, latencySum: 0 };

  subscribe(agentId: string, topic: string, handler: (msg: Message) => void): void {
    if (!this.topics.has(topic)) {
      this.topics.set(topic, new Set());
    }
    this.topics.get(topic)!.add(agentId);
    this.handlers.set(`${agentId}:${topic}`, handler);
  }

  publish(topic: string, message: Message): number {
    const subscribers = this.topics.get(topic);
    if (!subscribers) return 0;

    let delivered = 0;
    for (const agentId of subscribers) {
      this.stats.sent++;
      const handler = this.handlers.get(`${agentId}:${topic}`);
      if (handler) {
        handler({ ...message, to: agentId });
        this.stats.received++;
        this.stats.latencySum += Date.now() - message.timestamp;
        delivered++;
      }
    }

    return delivered;
  }

  getStats(): MessageStats {
    return { ...this.stats };
  }

  reset(): void {
    this.stats = { sent: 0, received: 0, dropped: 0, latencySum: 0 };
  }
}

/**
 * Batched message channel
 */
class BatchedChannel {
  private batch: Message[] = [];
  private handlers = new Map<string, (msgs: Message[]) => void>();
  private batchSize = 100;
  private stats: MessageStats = { sent: 0, received: 0, dropped: 0, latencySum: 0 };

  subscribe(agentId: string, handler: (msgs: Message[]) => void): void {
    this.handlers.set(agentId, handler);
  }

  send(message: Message): void {
    this.stats.sent++;
    this.batch.push(message);

    if (this.batch.length >= this.batchSize) {
      this.flush();
    }
  }

  flush(): void {
    // Group messages by recipient
    const byRecipient = new Map<string, Message[]>();
    for (const msg of this.batch) {
      if (!byRecipient.has(msg.to)) {
        byRecipient.set(msg.to, []);
      }
      byRecipient.get(msg.to)!.push(msg);
    }

    // Deliver to each recipient
    for (const [agentId, messages] of byRecipient) {
      const handler = this.handlers.get(agentId);
      if (handler) {
        handler(messages);
        this.stats.received += messages.length;
        for (const msg of messages) {
          this.stats.latencySum += Date.now() - msg.timestamp;
        }
      } else {
        this.stats.dropped += messages.length;
      }
    }

    this.batch = [];
  }

  getStats(): MessageStats {
    return { ...this.stats };
  }

  reset(): void {
    this.batch = [];
    this.stats = { sent: 0, received: 0, dropped: 0, latencySum: 0 };
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function createMessage(from: string, to: string, payload: unknown): Message {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: 'data',
    from,
    to,
    payload,
    timestamp: Date.now(),
  };
}

// ============================================================================
// Benchmark Suite
// ============================================================================

export async function runMessageThroughputBenchmarks(): Promise<void> {
  const runner = new BenchmarkRunner('Message Throughput');

  console.log('\n--- Message Throughput Benchmarks ---\n');

  // Setup channels
  const syncChannel = new SyncChannel();
  const asyncQueue = new AsyncMessageQueue();
  const pubsub = new PubSubBroker();
  const batchedChannel = new BatchedChannel();

  // Register handlers
  for (let i = 0; i < 100; i++) {
    syncChannel.subscribe(`agent-${i}`, () => {});
    batchedChannel.subscribe(`agent-${i}`, () => {});
  }
  for (let i = 0; i < 100; i++) {
    pubsub.subscribe(`agent-${i}`, 'broadcast', () => {});
  }

  // Benchmark 1: Single Message - Sync Channel
  const syncSingleResult = await runner.run(
    'sync-channel-single-message',
    async () => {
      const msg = createMessage('sender', 'agent-0', { data: 'test' });
      syncChannel.send(msg);
    },
    { iterations: 100000 }
  );

  console.log(`Sync Channel (single): ${formatTime(syncSingleResult.mean)}`);
  const throughputTarget = meetsTarget('message-throughput', syncSingleResult.mean);
  console.log(`  Target (<0.1ms): ${throughputTarget.met ? 'PASS' : 'FAIL'}`);

  // Benchmark 2: Message Batch - Sync Channel (100 messages)
  const syncBatchResult = await runner.run(
    'sync-channel-100-messages',
    async () => {
      for (let i = 0; i < 100; i++) {
        const msg = createMessage('sender', `agent-${i}`, { data: i });
        syncChannel.send(msg);
      }
    },
    { iterations: 1000 }
  );

  console.log(`Sync Channel (100 messages): ${formatTime(syncBatchResult.mean)}`);
  console.log(`  Per message: ${formatTime(syncBatchResult.mean / 100)}`);

  // Benchmark 3: Async Queue - Enqueue
  const asyncEnqueueResult = await runner.run(
    'async-queue-enqueue',
    async () => {
      const msg = createMessage('sender', 'agent-0', { data: 'test' });
      asyncQueue.enqueue(msg);
    },
    { iterations: 100000 }
  );

  console.log(`Async Queue (enqueue): ${formatTime(asyncEnqueueResult.mean)}`);

  // Benchmark 4: Async Queue - Dequeue
  // Pre-populate queue
  for (let i = 0; i < 10000; i++) {
    asyncQueue.enqueue(createMessage('sender', 'agent-0', { data: i }));
  }

  const asyncDequeueResult = await runner.run(
    'async-queue-dequeue',
    async () => {
      asyncQueue.dequeue('agent-0');
    },
    { iterations: 10000 }
  );

  console.log(`Async Queue (dequeue): ${formatTime(asyncDequeueResult.mean)}`);

  // Benchmark 5: Async Queue - Batch Dequeue
  asyncQueue.reset();
  for (let i = 0; i < 100; i++) {
    asyncQueue.enqueue(createMessage('sender', 'agent-1', { data: i }));
  }

  const asyncBatchDequeueResult = await runner.run(
    'async-queue-batch-dequeue',
    async () => {
      asyncQueue.dequeueAll('agent-1');
      // Refill for next iteration
      for (let i = 0; i < 100; i++) {
        asyncQueue.enqueue(createMessage('sender', 'agent-1', { data: i }));
      }
    },
    { iterations: 1000 }
  );

  console.log(`Async Queue (batch dequeue 100): ${formatTime(asyncBatchDequeueResult.mean)}`);

  // Benchmark 6: Pub/Sub - Single Publish
  const pubsubSingleResult = await runner.run(
    'pubsub-single-publish',
    async () => {
      const msg = createMessage('publisher', '', { event: 'test' });
      pubsub.publish('broadcast', msg);
    },
    { iterations: 1000 }
  );

  console.log(`Pub/Sub (to 100 subscribers): ${formatTime(pubsubSingleResult.mean)}`);
  console.log(`  Per subscriber: ${formatTime(pubsubSingleResult.mean / 100)}`);

  // Benchmark 7: Batched Channel - Single Message
  const batchedSingleResult = await runner.run(
    'batched-channel-single',
    async () => {
      const msg = createMessage('sender', 'agent-0', { data: 'test' });
      batchedChannel.send(msg);
    },
    { iterations: 10000 }
  );

  console.log(`Batched Channel (single, no flush): ${formatTime(batchedSingleResult.mean)}`);

  // Benchmark 8: Batched Channel - Full Batch + Flush
  batchedChannel.reset();

  const batchedFlushResult = await runner.run(
    'batched-channel-flush-100',
    async () => {
      for (let i = 0; i < 100; i++) {
        batchedChannel.send(createMessage('sender', `agent-${i}`, { data: i }));
      }
      batchedChannel.flush();
    },
    { iterations: 1000 }
  );

  console.log(`Batched Channel (100 + flush): ${formatTime(batchedFlushResult.mean)}`);
  console.log(`  Per message: ${formatTime(batchedFlushResult.mean / 100)}`);

  // Benchmark 9: Message Serialization
  const serializationResult = await runner.run(
    'message-serialization',
    async () => {
      const msg = createMessage('sender', 'receiver', {
        data: Array.from({ length: 100 }, (_, i) => i),
        nested: { level1: { level2: { value: 42 } } },
      });
      JSON.stringify(msg);
    },
    { iterations: 10000 }
  );

  console.log(`Message Serialization: ${formatTime(serializationResult.mean)}`);

  // Benchmark 10: Message Deserialization
  const msgJson = JSON.stringify(
    createMessage('sender', 'receiver', {
      data: Array.from({ length: 100 }, (_, i) => i),
    })
  );

  const deserializationResult = await runner.run(
    'message-deserialization',
    async () => {
      JSON.parse(msgJson);
    },
    { iterations: 10000 }
  );

  console.log(`Message Deserialization: ${formatTime(deserializationResult.mean)}`);

  // Benchmark 11: High Throughput Test (1000 messages)
  syncChannel.reset();

  const highThroughputResult = await runner.run(
    'high-throughput-1000-messages',
    async () => {
      for (let i = 0; i < 1000; i++) {
        const msg = createMessage('sender', `agent-${i % 100}`, { seq: i });
        syncChannel.send(msg);
      }
    },
    { iterations: 100 }
  );

  console.log(`High Throughput (1000 messages): ${formatTime(highThroughputResult.mean)}`);
  console.log(`  Throughput: ${(1000 / highThroughputResult.mean * 1000).toFixed(0)} msg/sec`);

  // Summary
  console.log('\n--- Summary ---');
  console.log(`Single message: ${formatTime(syncSingleResult.mean)}`);
  console.log(`Batch (100): ${formatTime(syncBatchResult.mean)} (${formatTime(syncBatchResult.mean / 100)}/msg)`);
  console.log(`Pub/Sub (100 subs): ${formatTime(pubsubSingleResult.mean)}`);
  console.log(`Serialization: ${formatTime(serializationResult.mean)}`);
  console.log(`\nThroughput: ${(1000 / highThroughputResult.mean * 1000).toFixed(0)} messages/sec`);

  // Print full results
  runner.printResults();
}

// ============================================================================
// Message Throughput Optimization Strategies
// ============================================================================

export const messageOptimizations = {
  /**
   * Zero-copy messaging
   */
  zeroCopy: {
    description: 'Use SharedArrayBuffer to avoid copying message data',
    expectedImprovement: '3-5x for large messages',
    implementation: `
      class ZeroCopyChannel {
        send(data: Uint8Array): void {
          const sab = new SharedArrayBuffer(data.length);
          new Uint8Array(sab).set(data);
          this.deliverReference(sab);
        }
      }
    `,
  },

  /**
   * Message batching
   */
  messageBatching: {
    description: 'Batch multiple messages to amortize overhead',
    expectedImprovement: '5-10x throughput',
    implementation: `
      class BatchedSender {
        private batch: Message[] = [];
        private batchSize = 100;

        send(msg: Message): void {
          this.batch.push(msg);
          if (this.batch.length >= this.batchSize) {
            this.flush();
          }
        }

        private flush(): void {
          this.transport.sendBatch(this.batch);
          this.batch = [];
        }
      }
    `,
  },

  /**
   * Binary serialization
   */
  binarySerialization: {
    description: 'Use binary format instead of JSON',
    expectedImprovement: '2-4x serialization speed',
    implementation: `
      import msgpack from '@msgpack/msgpack';

      function serialize(msg: Message): Uint8Array {
        return msgpack.encode(msg);
      }

      function deserialize(data: Uint8Array): Message {
        return msgpack.decode(data) as Message;
      }
    `,
  },

  /**
   * Connection pooling
   */
  connectionPooling: {
    description: 'Reuse connections for message delivery',
    expectedImprovement: '10-20x for remote messaging',
    implementation: `
      class ConnectionPool {
        private pool: Connection[] = [];

        async getConnection(target: string): Promise<Connection> {
          const cached = this.pool.find(c => c.target === target && c.idle);
          if (cached) {
            cached.idle = false;
            return cached;
          }
          return this.createConnection(target);
        }
      }
    `,
  },

  /**
   * Priority queuing
   */
  priorityQueuing: {
    description: 'Process high-priority messages first',
    expectedImprovement: 'Lower latency for critical messages',
    implementation: `
      class PriorityQueue {
        private high: Message[] = [];
        private normal: Message[] = [];
        private low: Message[] = [];

        enqueue(msg: Message): void {
          const queue = this.getQueue(msg.priority);
          queue.push(msg);
        }

        dequeue(): Message | undefined {
          return this.high.shift() || this.normal.shift() || this.low.shift();
        }
      }
    `,
  },
};

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runMessageThroughputBenchmarks().catch(console.error);
}

export default runMessageThroughputBenchmarks;
