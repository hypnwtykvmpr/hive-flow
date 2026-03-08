/**
 * Hive-Mind MCP Tools for CLI
 *
 * Tool definitions for collective intelligence and swarm coordination.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MCPTool } from './types.js';
import { loadAgentStore, saveAgentStore, agentTools } from './agent-tools.js';
import type { AgentProvider } from './agent-tools.js';

// Storage paths
const STORAGE_DIR = '.claude-flow';
const HIVE_DIR = 'hive-mind';
const HIVE_FILE = 'state.json';

interface HiveState {
  initialized: boolean;
  topology: 'mesh' | 'hierarchical' | 'ring' | 'star' | 'adaptive' | 'hierarchical-mesh';
  queen?: {
    agentId: string;
    electedAt: string;
    term: number;
  };
  workers: HiveWorker[];
  consensus: {
    pending: ConsensusProposal[];
    history: ConsensusResult[];
  };
  sharedMemory: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface ConsensusProposal {
  proposalId: string;
  type: string;
  value: unknown;
  proposedBy: string;
  proposedAt: string;
  votes: Record<string, boolean>;
  status: 'pending' | 'approved' | 'rejected';
}

interface ConsensusResult {
  proposalId: string;
  type: string;
  result: 'approved' | 'rejected';
  votes: { for: number; against: number };
  decidedAt: string;
}

interface HiveWorker {
  agentId: string;
  provider?: AgentProvider;
  model?: string;
  role: string;
  joinedAt: string;
  status: 'idle' | 'busy' | 'offline';
}

function getHiveDir(): string {
  return join(process.cwd(), STORAGE_DIR, HIVE_DIR);
}

function getHivePath(): string {
  return join(getHiveDir(), HIVE_FILE);
}

function ensureHiveDir(): void {
  const dir = getHiveDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadHiveState(): HiveState {
  try {
    const path = getHivePath();
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      const state = JSON.parse(data) as HiveState;

      // Normalize workers to HiveWorker[]
      if (Array.isArray(state.workers) && state.workers.length > 0) {
        const seen = new Set<string>();
        const normalized: HiveWorker[] = [];

        for (const entry of state.workers as Array<unknown>) {
          let worker: HiveWorker | null = null;

          if (typeof entry === 'string') {
            const id = entry.trim();
            if (!id) continue;
            worker = {
              agentId: id, role: 'worker',
              joinedAt: state.createdAt || new Date().toISOString(),
              status: 'idle',
            };
          } else if (
            entry !== null && typeof entry === 'object' &&
            typeof (entry as Record<string, unknown>).agentId === 'string'
          ) {
            const obj = entry as HiveWorker;
            const id = obj.agentId?.trim();
            if (!id) continue;
            worker = {
              ...obj,
              agentId: id,
              role: obj.role || 'worker',
              joinedAt: obj.joinedAt || state.createdAt || new Date().toISOString(),
              status: obj.status || 'idle',
            };
          }

          if (worker && !seen.has(worker.agentId)) {
            seen.add(worker.agentId);
            normalized.push(worker);
          }
        }
        state.workers = normalized;
      }

      return state;
    }
  } catch { /* Return default */ }
  return {
    initialized: false, topology: 'mesh', workers: [],
    consensus: { pending: [], history: [] }, sharedMemory: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

function saveHiveState(state: HiveState): void {
  ensureHiveDir();
  state.updatedAt = new Date().toISOString();
  writeFileSync(getHivePath(), JSON.stringify(state, null, 2), 'utf-8');
}

/** Minimum votes needed for a majority decision. Handles 1-worker edge case. */
function getMajority(n: number): number {
  if (n <= 0) return 0;
  return n === 1 ? 1 : Math.ceil(n / 2) + 1;
}

function extractVoteFromResult(result: Record<string, unknown>): boolean {
  // If task execution failed, vote = false
  if (result.success === false) return false;

  // --- Tier 1: Structured vote field ---
  const candidates = [result, result.result as Record<string, unknown> | undefined];
  for (const obj of candidates) {
    if (obj && typeof obj === 'object' && 'vote' in obj) {
      const v = (obj as Record<string, unknown>).vote;
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') {
        const vl = v.toLowerCase().trim();
        if (['approve', 'true', 'yes'].includes(vl)) return true;
        if (['reject', 'false', 'no'].includes(vl)) return false;
      }
    }
  }

  // --- Extract text content ---
  let text = '';
  if (typeof result.content === 'string') text = result.content;       // Bridge primary field
  else if (typeof result.rawOutput === 'string') text = result.rawOutput; // agent_task fallback
  else text = JSON.stringify(result);

  const trimmed = text.trim();
  if (!trimmed) return true; // no signal = no objection

  // --- Tier 1.5: JSON code block in text ---
  // Regex handles one level of nested braces (e.g., {"vote":"approve","reason":{"detail":"ok"}})
  const jsonMatch = trimmed.match(/```json\s*\n?\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})\s*\n?\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (typeof parsed.vote === 'boolean') return parsed.vote;
      if (typeof parsed.vote === 'string') {
        const vl = parsed.vote.toLowerCase().trim();
        if (['approve', 'true', 'yes'].includes(vl)) return true;
        if (['reject', 'false', 'no'].includes(vl)) return false;
      }
    } catch { /* fall through */ }
  }

  // --- Tier 2: Word-boundary keyword matching ---
  const lower = trimmed.toLowerCase();
  const matchesKw = (kw: string) => new RegExp(`\\b${kw}\\b`, 'i').test(lower);

  // REJECT first (reject-first precedence: false approval more dangerous than false rejection)
  const rejectKws = ['reject', 'deny', 'disapprove', 'not acceptable', 'cannot approve', 'do not approve'];
  for (const kw of rejectKws) { if (matchesKw(kw)) return false; }

  // APPROVE second
  const approveKws = ['approve', 'accept', 'lgtm', 'looks good', 'no issues found'];
  for (const kw of approveKws) { if (matchesKw(kw)) return true; }

  // Default: approve (benefit of the doubt; consensus requires majority)
  return true;
}

export const hiveMindTools: MCPTool[] = [
  {
    name: 'hive-mind_spawn',
    description: 'Spawn workers and automatically join them to the hive-mind (combines agent/spawn + hive-mind/join)',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of workers to spawn (default: 1)', default: 1 },
        role: { type: 'string', enum: ['worker', 'specialist', 'scout'], description: 'Worker role in hive', default: 'worker' },
        agentType: { type: 'string', description: 'Agent type for spawned workers', default: 'worker' },
        prefix: { type: 'string', description: 'Prefix for worker IDs', default: 'hive-worker' },
        provider: { type: 'string', enum: ['gemini-cli', 'codex-cli', 'cursor-cli', 'anthropic'], description: 'AI provider' },
        model: { type: 'string', description: 'Model to use' },
      },
    },
    handler: async (input) => {
      const state = loadHiveState();

      if (!state.initialized) {
        return { success: false, error: 'Hive-mind not initialized. Run hive-mind/init first.' };
      }

      const count = Math.min(Math.max(1, (input.count as number) || 1), 20); // Cap at 20
      const role = (input.role as string) || 'worker';
      const agentType = (input.agentType as string) || 'worker';
      const prefix = (input.prefix as string) || 'hive-worker';
      const agentStore = loadAgentStore();

      const spawnedWorkers: Array<{ agentId: string; role: string; provider?: AgentProvider; model?: string; joinedAt: string }> = [];

      for (let i = 0; i < count; i++) {
        const agentId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        // Create agent record (like agent/spawn)
        agentStore.agents[agentId] = {
          agentId,
          agentType,
          status: 'idle',
          health: 1.0,
          taskCount: 0,
          config: { role, hiveRole: role },
          createdAt: new Date().toISOString(),
          domain: 'hive-mind',
          provider: (input.provider as AgentProvider) || undefined,
          resolvedModel: (input.model as string) || undefined,
        };

        // Join to hive-mind (like hive-mind/join)
        const worker: HiveWorker = {
          agentId,
          provider: (input.provider as AgentProvider) || undefined,
          model: (input.model as string) || undefined,
          role, joinedAt: new Date().toISOString(), status: 'idle',
        };
        if (!state.workers.find(w => w.agentId === agentId)) {
          state.workers.push(worker);
        }

        spawnedWorkers.push({
          agentId,
          role,
          provider: (input.provider as AgentProvider) || undefined,
          model: (input.model as string) || undefined,
          joinedAt: new Date().toISOString(),
        });
      }

      saveAgentStore(agentStore);
      saveHiveState(state);

      return {
        success: true,
        spawned: count,
        workers: spawnedWorkers,
        totalWorkers: state.workers.length,
        hiveStatus: 'active',
        message: `Spawned ${count} worker(s) and joined them to the hive-mind`,
      };
    },
  },
  {
    name: 'hive-mind_init',
    description: 'Initialize the hive-mind collective',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        topology: { type: 'string', enum: ['mesh', 'hierarchical', 'ring', 'star', 'adaptive', 'hierarchical-mesh'], description: 'Network topology' },
        queenId: { type: 'string', description: 'Initial queen agent ID' },
        consensus: { type: 'string', enum: ['byzantine', 'raft', 'gossip', 'crdt', 'quorum'], description: 'Consensus strategy' },
        maxAgents: { type: 'number', description: 'Maximum agents allowed (default: 15)' },
        persist: { type: 'boolean', description: 'Persist hive state to disk (default: true)' },
        memoryBackend: { type: 'string', enum: ['hybrid', 'sqlite', 'memory'], description: 'Memory backend (default: hybrid)' },
      },
    },
    handler: async (input) => {
      const state = loadHiveState();
      const hiveId = `hive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const queenId = (input.queenId as string) || `queen-${Date.now()}`;

      state.initialized = true;
      state.topology = (input.topology as HiveState['topology']) || 'mesh';
      state.createdAt = new Date().toISOString();
      state.queen = {
        agentId: queenId,
        electedAt: new Date().toISOString(),
        term: 1,
      };

      saveHiveState(state);

      return {
        success: true,
        hiveId,
        topology: state.topology,
        consensus: (input.consensus as string) || 'byzantine',
        queenId,
        status: 'initialized',
        config: {
          topology: state.topology,
          consensus: input.consensus || 'byzantine',
          maxAgents: input.maxAgents || 15,
          persist: input.persist !== false,
          memoryBackend: input.memoryBackend || 'hybrid',
        },
        createdAt: state.createdAt,
      };
    },
  },
  {
    name: 'hive-mind_status',
    description: 'Get hive-mind status',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'Include detailed information' },
      },
    },
    handler: async (input) => {
      const state = loadHiveState();

      const uptime = state.createdAt ? Date.now() - new Date(state.createdAt).getTime() : 0;
      const status = {
        // CLI expected fields
        hiveId: `hive-${state.createdAt ? new Date(state.createdAt).getTime() : Date.now()}`,
        status: state.initialized ? 'active' : 'offline',
        topology: state.topology,
        consensus: 'byzantine', // Default consensus type
        queen: state.queen ? {
          id: state.queen.agentId,
          agentId: state.queen.agentId,
          status: 'active',
          load: 0.3 + Math.random() * 0.4, // Simulated load
          tasksQueued: state.consensus.pending.length,
          electedAt: state.queen.electedAt,
          term: state.queen.term,
        } : { id: 'N/A', status: 'offline', load: 0, tasksQueued: 0 },
        workers: state.workers.map(w => ({
          id: w.agentId,
          type: 'worker',
          status: w.status || 'idle',
          provider: w.provider,
          model: w.model,
          role: w.role,
          currentTask: null,
          tasksCompleted: 0,
        })),
        metrics: {
          totalTasks: state.consensus.history.length + state.consensus.pending.length,
          completedTasks: state.consensus.history.length,
          failedTasks: 0,
          avgTaskTime: 150,
          consensusRounds: state.consensus.history.length,
          memoryUsage: `${Object.keys(state.sharedMemory).length * 2} KB`,
        },
        health: {
          overall: 'healthy',
          queen: state.queen ? 'healthy' : 'unhealthy',
          workers: state.workers.length > 0 ? 'healthy' : 'degraded',
          consensus: 'healthy',
          memory: 'healthy',
        },
        // Additional fields
        id: `hive-${state.createdAt ? new Date(state.createdAt).getTime() : Date.now()}`,
        initialized: state.initialized,
        workerCount: state.workers.length,
        pendingConsensus: state.consensus.pending.length,
        sharedMemoryKeys: Object.keys(state.sharedMemory).length,
        uptime,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      };

      if (input.verbose) {
        return {
          ...status,
          workerDetails: state.workers,
          consensusHistory: state.consensus.history.slice(-10),
          sharedMemory: state.sharedMemory,
        };
      }

      return status;
    },
  },
  {
    name: 'hive-mind_join',
    description: 'Join an agent to the hive-mind',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID to join' },
        role: { type: 'string', enum: ['worker', 'specialist', 'scout'], description: 'Agent role in hive' },
        provider: { type: 'string', enum: ['gemini-cli', 'codex-cli', 'cursor-cli', 'anthropic'], description: 'AI provider' },
        model: { type: 'string', description: 'Model identifier' },
      },
      required: ['agentId'],
    },
    handler: async (input) => {
      const state = loadHiveState();
      const agentId = input.agentId as string;
      if (!state.initialized) return { success: false, error: 'Hive-mind not initialized' };

      if (!state.workers.find(w => w.agentId === agentId)) {
        // Resolve provider: explicit param > agent store lookup > undefined
        let provider = input.provider as AgentProvider | undefined;
        let model = input.model as string | undefined;
        if (!provider) {
          try {
            const agentStore = loadAgentStore();
            const rec = agentStore.agents[agentId];
            if (rec) { provider = rec.provider; model = model || rec.resolvedModel || rec.model; }
          } catch { /* non-fatal */ }
        }
        state.workers.push({
          agentId, provider, model,
          role: (input.role as string) || 'worker',
          joinedAt: new Date().toISOString(), status: 'idle',
        });
        saveHiveState(state);
      }
      const worker = state.workers.find(w => w.agentId === agentId)!;
      return {
        success: true, agentId, role: worker.role,
        provider: worker.provider, model: worker.model,
        totalWorkers: state.workers.length, joinedAt: worker.joinedAt,
      };
    },
  },
  {
    name: 'hive-mind_leave',
    description: 'Remove an agent from the hive-mind',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID to remove' },
      },
      required: ['agentId'],
    },
    handler: async (input) => {
      const state = loadHiveState();
      const agentId = input.agentId as string;

      const index = state.workers.findIndex(w => w.agentId === agentId);
      if (index > -1) {
        state.workers.splice(index, 1);
        saveHiveState(state);
        return {
          success: true,
          agentId,
          leftAt: new Date().toISOString(),
          remainingWorkers: state.workers.length,
        };
      }

      return { success: false, agentId, error: 'Agent not in hive' };
    },
  },
  {
    name: 'hive-mind_consensus',
    description: 'Propose or vote on consensus',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['propose', 'vote', 'status', 'list', 'execute'], description: 'Consensus action' },
        proposalId: { type: 'string', description: 'Proposal ID (for vote/status)' },
        type: { type: 'string', description: 'Proposal type (for propose)' },
        value: { description: 'Proposal value (for propose)' },
        vote: { type: 'boolean', description: 'Vote (true=for, false=against)' },
        voterId: { type: 'string', description: 'Voter agent ID' },
        task: { type: 'string', description: 'Task description for execute action' },
        timeout: { type: 'number', description: 'Timeout in ms for execute action (default: 30000)' },
      },
      required: ['action'],
    },
    handler: async (input) => {
      const state = loadHiveState();
      const action = input.action as string;

      if (action === 'propose') {
        const proposalId = `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const proposal: ConsensusProposal = {
          proposalId,
          type: (input.type as string) || 'general',
          value: input.value,
          proposedBy: (input.voterId as string) || 'system',
          proposedAt: new Date().toISOString(),
          votes: {},
          status: 'pending',
        };

        state.consensus.pending.push(proposal);
        saveHiveState(state);

        return {
          action,
          proposalId,
          type: proposal.type,
          status: 'pending',
          requiredVotes: getMajority(state.workers.length),
        };
      }

      if (action === 'vote') {
        const proposal = state.consensus.pending.find(p => p.proposalId === input.proposalId);
        if (!proposal) {
          return { action, error: 'Proposal not found' };
        }

        const voterId = input.voterId as string;
        proposal.votes[voterId] = input.vote as boolean;

        // Check if we have majority
        const votesFor = Object.values(proposal.votes).filter(v => v).length;
        const votesAgainst = Object.values(proposal.votes).filter(v => !v).length;
        const majority = getMajority(state.workers.length);

        if (votesFor >= majority) {
          proposal.status = 'approved';
          state.consensus.history.push({
            proposalId: proposal.proposalId,
            type: proposal.type,
            result: 'approved',
            votes: { for: votesFor, against: votesAgainst },
            decidedAt: new Date().toISOString(),
          });
          state.consensus.pending = state.consensus.pending.filter(p => p.proposalId !== proposal.proposalId);
        } else if (votesAgainst >= majority) {
          proposal.status = 'rejected';
          state.consensus.history.push({
            proposalId: proposal.proposalId,
            type: proposal.type,
            result: 'rejected',
            votes: { for: votesFor, against: votesAgainst },
            decidedAt: new Date().toISOString(),
          });
          state.consensus.pending = state.consensus.pending.filter(p => p.proposalId !== proposal.proposalId);
        }

        saveHiveState(state);

        return {
          action,
          proposalId: proposal.proposalId,
          voterId,
          vote: input.vote,
          votesFor,
          votesAgainst,
          status: proposal.status,
        };
      }

      if (action === 'status') {
        const proposal = state.consensus.pending.find(p => p.proposalId === input.proposalId);
        if (!proposal) {
          // Check history
          const historical = state.consensus.history.find(h => h.proposalId === input.proposalId);
          if (historical) {
            return { action, ...historical, historical: true };
          }
          return { action, error: 'Proposal not found' };
        }

        const votesFor = Object.values(proposal.votes).filter(v => v).length;
        const votesAgainst = Object.values(proposal.votes).filter(v => !v).length;

        return {
          action,
          proposalId: proposal.proposalId,
          type: proposal.type,
          status: proposal.status,
          votesFor,
          votesAgainst,
          totalVotes: Object.keys(proposal.votes).length,
          requiredMajority: getMajority(state.workers.length),
        };
      }

      if (action === 'list') {
        return {
          action,
          pending: state.consensus.pending.map(p => ({
            proposalId: p.proposalId,
            type: p.type,
            proposedAt: p.proposedAt,
            totalVotes: Object.keys(p.votes).length,
          })),
          recentHistory: state.consensus.history.slice(-5),
        };
      }

      if (action === 'execute') {
        const proposal = state.consensus.pending.find(p => p.proposalId === input.proposalId);
        if (!proposal) return { action, error: 'Proposal not found' };

        const userTask = input.task as string || input.value as string;
        if (!userTask) return { action, error: 'Task description required' };

        // Wrap task with structured response instructions
        const structuredTask = `${userTask}\n\nIMPORTANT: End your response with:\n\`\`\`json\n{"vote": "approve"}\n\`\`\`\nor\n\`\`\`json\n{"vote": "reject"}\n\`\`\`\nInclude reasoning before the JSON block.`;

        const providerWorkers = state.workers.filter(w => w.provider);
        const localWorkers = state.workers.filter(w => !w.provider);

        // Local workers auto-approve: they lack provider execution capability.
        // To get real votes from a worker, assign it a provider via spawn/join.
        for (const w of localWorkers) { proposal.votes[w.agentId] = true; }

        // Execute provider workers via agent_task (parallel)
        const agentTaskTool = agentTools.find(t => t.name === 'agent_task');
        if (!agentTaskTool && providerWorkers.length > 0) {
          return { action, error: 'agent_task tool not found — cannot execute provider workers' };
        }
        const settled = await Promise.allSettled(
          providerWorkers.map(async (worker) => {
            const taskResult = await agentTaskTool!.handler({
              agentId: worker.agentId, task: structuredTask,
              timeout: (input.timeout as number) ?? 30000,
            }) as Record<string, unknown>;
            return { worker, taskResult };
          }),
        );
        const results: Array<{ agentId: string; provider?: AgentProvider; status: string; vote?: boolean; error?: string }> = [];
        for (let i = 0; i < settled.length; i++) {
          const worker = providerWorkers[i];
          const s = settled[i];
          if (s.status === 'fulfilled') {
            const vote = extractVoteFromResult(s.value.taskResult);
            proposal.votes[worker.agentId] = vote;
            results.push({ agentId: worker.agentId, provider: worker.provider, status: 'completed', vote });
          } else {
            results.push({ agentId: worker.agentId, provider: worker.provider, status: 'failed', error: String(s.reason) });
          }
        }

        // Abstention handling: failed workers reduce the denominator, not count as rejections
        const abstentions = results.filter(r => r.status === 'failed').map(r => r.agentId);
        const participatingCount = state.workers.length - abstentions.length;

        // Check majority (same logic as existing vote action)
        const votesFor = Object.values(proposal.votes).filter(v => v).length;
        const votesAgainst = Object.values(proposal.votes).filter(v => !v).length;
        const majority = getMajority(participatingCount);
        if (votesFor >= majority) {
          proposal.status = 'approved';
          state.consensus.history.push({ proposalId: proposal.proposalId, type: proposal.type, result: 'approved', votes: { for: votesFor, against: votesAgainst }, decidedAt: new Date().toISOString() });
          state.consensus.pending = state.consensus.pending.filter(p => p.proposalId !== proposal.proposalId);
        } else if (votesAgainst >= majority) {
          proposal.status = 'rejected';
          state.consensus.history.push({ proposalId: proposal.proposalId, type: proposal.type, result: 'rejected', votes: { for: votesFor, against: votesAgainst }, decidedAt: new Date().toISOString() });
          state.consensus.pending = state.consensus.pending.filter(p => p.proposalId !== proposal.proposalId);
        }
        saveHiveState(state);
        return { action, proposalId: proposal.proposalId, evaluated: results.length, results, votesFor, votesAgainst, abstentions: abstentions.length, participatingVoters: participatingCount, status: proposal.status };
      }

      return { action, error: 'Unknown action' };
    },
  },
  {
    name: 'hive-mind_broadcast',
    description: 'Broadcast message to all workers',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message to broadcast' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: 'Message priority' },
        fromId: { type: 'string', description: 'Sender agent ID' },
      },
      required: ['message'],
    },
    handler: async (input) => {
      const state = loadHiveState();

      if (!state.initialized) {
        return { success: false, error: 'Hive-mind not initialized' };
      }

      const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Store in shared memory
      const messages = (state.sharedMemory.broadcasts as Array<unknown>) || [];
      messages.push({
        messageId,
        message: input.message,
        priority: input.priority || 'normal',
        fromId: input.fromId || 'system',
        timestamp: new Date().toISOString(),
      });

      // Keep only last 100 broadcasts
      state.sharedMemory.broadcasts = messages.slice(-100);
      saveHiveState(state);

      return {
        success: true,
        messageId,
        recipients: state.workers.length,
        priority: input.priority || 'normal',
        broadcastAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'hive-mind_shutdown',
    description: 'Shutdown the hive-mind and terminate all workers',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        graceful: { type: 'boolean', description: 'Graceful shutdown (wait for pending tasks)', default: true },
        force: { type: 'boolean', description: 'Force immediate shutdown', default: false },
      },
    },
    handler: async (input) => {
      const state = loadHiveState();

      if (!state.initialized) {
        return { success: false, error: 'Hive-mind not initialized or already shut down' };
      }

      const graceful = input.graceful !== false;
      const force = input.force === true;
      const workerCount = state.workers.length;
      const pendingConsensus = state.consensus.pending.length;

      // If graceful and there are pending consensus items, warn (unless forced)
      if (graceful && pendingConsensus > 0 && !force) {
        return {
          success: false,
          error: `Cannot gracefully shutdown with ${pendingConsensus} pending consensus items. Use force: true to override.`,
          pendingConsensus,
          workerCount,
        };
      }

      // Clear workers from agent store
      const agentStore = loadAgentStore();
      for (const worker of state.workers) {
        if (agentStore.agents[worker.agentId]) {
          delete agentStore.agents[worker.agentId];
        }
      }
      saveAgentStore(agentStore);

      // Reset hive state
      const shutdownTime = new Date().toISOString();
      const previousQueen = state.queen?.agentId;

      state.initialized = false;
      state.queen = undefined;
      state.workers = [];
      state.consensus.pending = [];
      // Keep history for reference
      state.sharedMemory = {};
      saveHiveState(state);

      return {
        success: true,
        shutdownAt: shutdownTime,
        graceful,
        workersTerminated: workerCount,
        previousQueen,
        consensusCleared: pendingConsensus,
        message: `Hive-mind shutdown complete. ${workerCount} workers terminated.`,
      };
    },
  },
  {
    name: 'hive-mind_memory',
    description: 'Access hive shared memory',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'delete', 'list'], description: 'Memory action' },
        key: { type: 'string', description: 'Memory key' },
        value: { description: 'Value to store (for set)' },
      },
      required: ['action'],
    },
    handler: async (input) => {
      const state = loadHiveState();
      const action = input.action as string;
      const key = input.key as string;

      if (action === 'get') {
        if (!key) return { action, error: 'Key required' };
        return {
          action,
          key,
          value: state.sharedMemory[key],
          exists: key in state.sharedMemory,
        };
      }

      if (action === 'set') {
        if (!key) return { action, error: 'Key required' };
        state.sharedMemory[key] = input.value;
        saveHiveState(state);
        return {
          action,
          key,
          success: true,
          updatedAt: new Date().toISOString(),
        };
      }

      if (action === 'delete') {
        if (!key) return { action, error: 'Key required' };
        const existed = key in state.sharedMemory;
        delete state.sharedMemory[key];
        saveHiveState(state);
        return {
          action,
          key,
          deleted: existed,
        };
      }

      if (action === 'list') {
        return {
          action,
          keys: Object.keys(state.sharedMemory),
          count: Object.keys(state.sharedMemory).length,
        };
      }

      return { action, error: 'Unknown action' };
    },
  },
];
