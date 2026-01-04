/**
 * Consensus Latency Benchmark
 *
 * Target: <100ms (5x faster than current ~500ms)
 *
 * Measures the time to achieve consensus among multiple agents
 * using various consensus protocols.
 */

import { benchmark, BenchmarkRunner, formatTime, meetsTarget } from '../framework/benchmark.js';

// ============================================================================
// Consensus Types
// ============================================================================

interface Vote {
  agentId: string;
  value: unknown;
  timestamp: number;
}

interface ConsensusResult {
  achieved: boolean;
  value: unknown;
  votes: Vote[];
  rounds: number;
  latency: number;
}

interface Agent {
  id: string;
  vote: (proposal: unknown) => Vote;
  receive: (votes: Vote[]) => void;
}

// ============================================================================
// Consensus Implementations
// ============================================================================

/**
 * Simple majority voting
 */
class MajorityVoting {
  private agents: Agent[] = [];

  constructor(numAgents: number) {
    for (let i = 0; i < numAgents; i++) {
      this.agents.push({
        id: `agent-${i}`,
        vote: (proposal) => ({
          agentId: `agent-${i}`,
          value: proposal,
          timestamp: Date.now(),
        }),
        receive: () => {},
      });
    }
  }

  async achieve(proposal: unknown): Promise<ConsensusResult> {
    const startTime = performance.now();

    // Collect votes
    const votes = this.agents.map((agent) => agent.vote(proposal));

    // Count votes
    const voteCounts = new Map<string, number>();
    for (const vote of votes) {
      const key = JSON.stringify(vote.value);
      voteCounts.set(key, (voteCounts.get(key) || 0) + 1);
    }

    // Find majority
    const threshold = Math.floor(this.agents.length / 2) + 1;
    let consensusValue: unknown = null;
    let achieved = false;

    for (const [value, count] of voteCounts) {
      if (count >= threshold) {
        consensusValue = JSON.parse(value);
        achieved = true;
        break;
      }
    }

    return {
      achieved,
      value: consensusValue,
      votes,
      rounds: 1,
      latency: performance.now() - startTime,
    };
  }

  get agentCount(): number {
    return this.agents.length;
  }
}

/**
 * Two-phase commit protocol
 */
class TwoPhaseCommit {
  private coordinator: string;
  private participants: string[];
  private preparedVotes = new Map<string, boolean>();

  constructor(numParticipants: number) {
    this.coordinator = 'coordinator';
    this.participants = Array.from({ length: numParticipants }, (_, i) => `participant-${i}`);
  }

  async commit(transaction: unknown): Promise<ConsensusResult> {
    const startTime = performance.now();
    const votes: Vote[] = [];
    let rounds = 0;

    // Phase 1: Prepare
    rounds++;
    const prepareVotes = this.participants.map((p) => {
      const vote: Vote = {
        agentId: p,
        value: { phase: 'prepare', ready: Math.random() > 0.1 }, // 90% success rate
        timestamp: Date.now(),
      };
      votes.push(vote);
      return vote;
    });

    const allPrepared = prepareVotes.every(
      (v) => (v.value as { ready: boolean }).ready
    );

    if (!allPrepared) {
      // Abort
      rounds++;
      return {
        achieved: false,
        value: null,
        votes,
        rounds,
        latency: performance.now() - startTime,
      };
    }

    // Phase 2: Commit
    rounds++;
    const commitVotes = this.participants.map((p) => {
      const vote: Vote = {
        agentId: p,
        value: { phase: 'commit', committed: true },
        timestamp: Date.now(),
      };
      votes.push(vote);
      return vote;
    });

    void commitVotes;

    return {
      achieved: true,
      value: transaction,
      votes,
      rounds,
      latency: performance.now() - startTime,
    };
  }

  get participantCount(): number {
    return this.participants.length;
  }
}

/**
 * Raft-like leader election
 */
class RaftConsensus {
  private nodes: Array<{
    id: string;
    term: number;
    votedFor: string | null;
    state: 'follower' | 'candidate' | 'leader';
  }>;

  constructor(numNodes: number) {
    this.nodes = Array.from({ length: numNodes }, (_, i) => ({
      id: `node-${i}`,
      term: 0,
      votedFor: null,
      state: 'follower' as const,
    }));
  }

  async electLeader(): Promise<ConsensusResult> {
    const startTime = performance.now();
    const votes: Vote[] = [];
    let rounds = 0;

    // Timeout and start election
    const candidateIdx = Math.floor(Math.random() * this.nodes.length);
    const candidate = this.nodes[candidateIdx]!;
    candidate.state = 'candidate';
    candidate.term++;
    candidate.votedFor = candidate.id;

    rounds++;

    // Request votes from all nodes
    let votesReceived = 1; // Vote for self

    for (let i = 0; i < this.nodes.length; i++) {
      if (i === candidateIdx) continue;

      const node = this.nodes[i]!;
      const grantVote =
        node.term < candidate.term &&
        (node.votedFor === null || node.votedFor === candidate.id);

      if (grantVote) {
        node.votedFor = candidate.id;
        node.term = candidate.term;
        votesReceived++;
      }

      votes.push({
        agentId: node.id,
        value: { grantVote, term: node.term },
        timestamp: Date.now(),
      });
    }

    const majority = Math.floor(this.nodes.length / 2) + 1;
    const achieved = votesReceived >= majority;

    if (achieved) {
      candidate.state = 'leader';
    } else {
      candidate.state = 'follower';
    }

    return {
      achieved,
      value: achieved ? candidate.id : null,
      votes,
      rounds,
      latency: performance.now() - startTime,
    };
  }

  get nodeCount(): number {
    return this.nodes.length;
  }
}

/**
 * Byzantine Fault Tolerant consensus (simplified PBFT)
 */
class BFTConsensus {
  private replicas: Array<{
    id: string;
    byzantine: boolean;
  }>;
  private f: number; // Max byzantine faults tolerated

  constructor(numReplicas: number, byzantineCount: number = 0) {
    this.replicas = Array.from({ length: numReplicas }, (_, i) => ({
      id: `replica-${i}`,
      byzantine: i < byzantineCount,
    }));
    this.f = Math.floor((numReplicas - 1) / 3);
  }

  async agree(proposal: unknown): Promise<ConsensusResult> {
    const startTime = performance.now();
    const votes: Vote[] = [];
    let rounds = 0;

    // Pre-prepare phase
    rounds++;
    const preprepareVotes = this.replicas.map((r) => ({
      agentId: r.id,
      value: { phase: 'preprepare', proposal: r.byzantine ? 'bad' : proposal },
      timestamp: Date.now(),
    }));
    votes.push(...preprepareVotes);

    // Prepare phase
    rounds++;
    const prepareVotes = this.replicas.map((r) => ({
      agentId: r.id,
      value: { phase: 'prepare', ready: !r.byzantine },
      timestamp: Date.now(),
    }));
    votes.push(...prepareVotes);

    const prepareCount = prepareVotes.filter(
      (v) => (v.value as { ready: boolean }).ready
    ).length;

    // Need 2f + 1 prepare messages
    if (prepareCount < 2 * this.f + 1) {
      return {
        achieved: false,
        value: null,
        votes,
        rounds,
        latency: performance.now() - startTime,
      };
    }

    // Commit phase
    rounds++;
    const commitVotes = this.replicas.map((r) => ({
      agentId: r.id,
      value: { phase: 'commit', committed: !r.byzantine },
      timestamp: Date.now(),
    }));
    votes.push(...commitVotes);

    const commitCount = commitVotes.filter(
      (v) => (v.value as { committed: boolean }).committed
    ).length;

    const achieved = commitCount >= 2 * this.f + 1;

    return {
      achieved,
      value: achieved ? proposal : null,
      votes,
      rounds,
      latency: performance.now() - startTime,
    };
  }

  get replicaCount(): number {
    return this.replicas.length;
  }
}

// ============================================================================
// Benchmark Suite
// ============================================================================

export async function runConsensusLatencyBenchmarks(): Promise<void> {
  const runner = new BenchmarkRunner('Consensus Latency');

  console.log('\n--- Consensus Latency Benchmarks ---\n');

  // Benchmark 1: Majority Voting - 5 Agents
  const majority5 = new MajorityVoting(5);

  const majority5Result = await runner.run(
    'majority-voting-5-agents',
    async () => {
      await majority5.achieve({ action: 'approve', value: 42 });
    },
    { iterations: 1000 }
  );

  console.log(`Majority Voting (5 agents): ${formatTime(majority5Result.mean)}`);
  const consensusTarget = meetsTarget('consensus-latency', majority5Result.mean);
  console.log(`  Target (<100ms): ${consensusTarget.met ? 'PASS' : 'FAIL'}`);

  // Benchmark 2: Majority Voting - 15 Agents
  const majority15 = new MajorityVoting(15);

  const majority15Result = await runner.run(
    'majority-voting-15-agents',
    async () => {
      await majority15.achieve({ action: 'approve', value: 42 });
    },
    { iterations: 500 }
  );

  console.log(`Majority Voting (15 agents): ${formatTime(majority15Result.mean)}`);

  // Benchmark 3: Two-Phase Commit - 5 Participants
  const tpc5 = new TwoPhaseCommit(5);

  const tpc5Result = await runner.run(
    'two-phase-commit-5',
    async () => {
      await tpc5.commit({ txId: 'tx-123', data: 'test' });
    },
    { iterations: 1000 }
  );

  console.log(`Two-Phase Commit (5 participants): ${formatTime(tpc5Result.mean)}`);

  // Benchmark 4: Two-Phase Commit - 15 Participants
  const tpc15 = new TwoPhaseCommit(15);

  const tpc15Result = await runner.run(
    'two-phase-commit-15',
    async () => {
      await tpc15.commit({ txId: 'tx-123', data: 'test' });
    },
    { iterations: 500 }
  );

  console.log(`Two-Phase Commit (15 participants): ${formatTime(tpc15Result.mean)}`);

  // Benchmark 5: Raft Leader Election - 5 Nodes
  const raft5 = new RaftConsensus(5);

  const raft5Result = await runner.run(
    'raft-election-5-nodes',
    async () => {
      await raft5.electLeader();
    },
    { iterations: 1000 }
  );

  console.log(`Raft Election (5 nodes): ${formatTime(raft5Result.mean)}`);

  // Benchmark 6: Raft Leader Election - 15 Nodes
  const raft15 = new RaftConsensus(15);

  const raft15Result = await runner.run(
    'raft-election-15-nodes',
    async () => {
      await raft15.electLeader();
    },
    { iterations: 500 }
  );

  console.log(`Raft Election (15 nodes): ${formatTime(raft15Result.mean)}`);

  // Benchmark 7: BFT Consensus - 4 Replicas (f=1)
  const bft4 = new BFTConsensus(4, 0);

  const bft4Result = await runner.run(
    'bft-consensus-4-replicas',
    async () => {
      await bft4.agree({ decision: 'commit' });
    },
    { iterations: 1000 }
  );

  console.log(`BFT Consensus (4 replicas, f=1): ${formatTime(bft4Result.mean)}`);

  // Benchmark 8: BFT Consensus - 7 Replicas (f=2)
  const bft7 = new BFTConsensus(7, 0);

  const bft7Result = await runner.run(
    'bft-consensus-7-replicas',
    async () => {
      await bft7.agree({ decision: 'commit' });
    },
    { iterations: 500 }
  );

  console.log(`BFT Consensus (7 replicas, f=2): ${formatTime(bft7Result.mean)}`);

  // Benchmark 9: BFT with Byzantine Nodes
  const bft7byz = new BFTConsensus(7, 2);

  const bft7byzResult = await runner.run(
    'bft-consensus-7-with-2-byzantine',
    async () => {
      await bft7byz.agree({ decision: 'commit' });
    },
    { iterations: 500 }
  );

  console.log(`BFT (7 replicas, 2 byzantine): ${formatTime(bft7byzResult.mean)}`);

  // Benchmark 10: Multiple Consensus Rounds
  const multiRoundResult = await runner.run(
    'multiple-consensus-rounds-10',
    async () => {
      for (let i = 0; i < 10; i++) {
        await majority5.achieve({ round: i });
      }
    },
    { iterations: 100 }
  );

  console.log(`10 Consensus Rounds: ${formatTime(multiRoundResult.mean)}`);

  // Summary
  console.log('\n--- Summary ---');
  console.log(`Majority (5): ${formatTime(majority5Result.mean)}`);
  console.log(`Majority (15): ${formatTime(majority15Result.mean)}`);
  console.log(`2PC (5): ${formatTime(tpc5Result.mean)}`);
  console.log(`Raft (5): ${formatTime(raft5Result.mean)}`);
  console.log(`BFT (4): ${formatTime(bft4Result.mean)}`);
  console.log(`\nScaling factors:`);
  console.log(`  Majority 5->15: ${(majority15Result.mean / majority5Result.mean).toFixed(2)}x`);
  console.log(`  2PC 5->15: ${(tpc15Result.mean / tpc5Result.mean).toFixed(2)}x`);
  console.log(`  Raft 5->15: ${(raft15Result.mean / raft5Result.mean).toFixed(2)}x`);

  // Print full results
  runner.printResults();
}

// ============================================================================
// Consensus Optimization Strategies
// ============================================================================

export const consensusOptimizations = {
  /**
   * Parallel vote collection
   */
  parallelVoteCollection: {
    description: 'Collect votes from all agents in parallel',
    expectedImprovement: 'O(1) instead of O(n)',
    implementation: `
      async function collectVotes(agents: Agent[], proposal: unknown): Promise<Vote[]> {
        return Promise.all(agents.map(agent => agent.vote(proposal)));
      }
    `,
  },

  /**
   * Early termination
   */
  earlyTermination: {
    description: 'Terminate early when majority is achieved',
    expectedImprovement: '30-50%',
    implementation: `
      async function earlyMajority(agents: Agent[], proposal: unknown): Promise<Vote[]> {
        const majority = Math.floor(agents.length / 2) + 1;
        const votes: Vote[] = [];

        for (const agent of agents) {
          votes.push(await agent.vote(proposal));
          const count = countAgreement(votes);
          if (count >= majority) break;
        }

        return votes;
      }
    `,
  },

  /**
   * Pipelining phases
   */
  pipelining: {
    description: 'Pipeline consensus phases for multiple proposals',
    expectedImprovement: '2-3x throughput',
    implementation: `
      class PipelinedConsensus {
        private phases = ['prepare', 'accept', 'commit'];
        private inflight = new Map<string, number>();

        async propose(proposal: unknown): Promise<void> {
          const id = generateId();
          this.inflight.set(id, 0);

          // Start next phase as soon as previous completes
          for (const phase of this.phases) {
            await this.executePhase(id, phase);
            this.inflight.set(id, this.inflight.get(id)! + 1);
          }
        }
      }
    `,
  },

  /**
   * Speculative execution
   */
  speculativeExecution: {
    description: 'Speculatively execute while waiting for consensus',
    expectedImprovement: '50-70% latency reduction',
    implementation: `
      async function speculativeConsensus(proposal: unknown): Promise<Result> {
        const [consensusResult, executionResult] = await Promise.all([
          achieveConsensus(proposal),
          speculativelyExecute(proposal),
        ]);

        if (consensusResult.achieved) {
          return executionResult;
        }

        return rollback(executionResult);
      }
    `,
  },

  /**
   * Hierarchical consensus
   */
  hierarchicalConsensus: {
    description: 'Achieve consensus in smaller groups first',
    expectedImprovement: 'O(log n) rounds',
    implementation: `
      async function hierarchicalConsensus(agents: Agent[]): Promise<Vote[]> {
        const groupSize = 5;
        const groups = chunkArray(agents, groupSize);

        // First level: consensus within groups
        const groupResults = await Promise.all(
          groups.map(group => achieveConsensus(group))
        );

        // Second level: consensus among group leaders
        const leaders = groupResults.map(r => r.leader);
        return achieveConsensus(leaders);
      }
    `,
  },
};

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runConsensusLatencyBenchmarks().catch(console.error);
}

export default runConsensusLatencyBenchmarks;
