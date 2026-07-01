/**
 * Coordination MCP Tools for CLI
 *
 * V2 Compatibility - Swarm coordination and orchestration tools
 *
 * ⚠️ IMPORTANT: These tools provide LOCAL STATE MANAGEMENT.
 * - Topology/consensus state is tracked locally
 * - No actual distributed coordination
 * - Useful for single-machine workflow orchestration
 */

import type { MCPTool } from './types.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

// Storage paths
const STORAGE_DIR = '.hive-flow';
const COORD_DIR = 'coordination';
const COORD_FILE = 'store.json';

interface TopologyConfig {
  type: 'mesh' | 'hierarchical' | 'ring' | 'star' | 'hybrid' | 'hierarchical-mesh';
  maxNodes: number;
  redundancy: number;
  consensusAlgorithm: string;
}

interface LoadBalanceConfig {
  algorithm: 'round-robin' | 'least-connections' | 'weighted' | 'adaptive';
  weights: Record<string, number>;
  healthCheck: boolean;
}

interface SyncState {
  lastSync: string;
  syncCount: number;
  conflicts: number;
  pendingChanges: number;
}

interface OrchestrationRecord {
  id: string;
  task: string;
  agents: string[];
  strategy: 'parallel' | 'sequential' | 'pipeline' | 'broadcast';
  status: 'recorded';
  topology: string;
  createdAt: string;
}

interface CoordinationStore {
  topology: TopologyConfig;
  loadBalance: LoadBalanceConfig;
  sync: SyncState;
  nodes: Record<string, { id: string; status: string; load: number; lastHeartbeat: string }>;
  orchestrations: Record<string, OrchestrationRecord>;
  version: string;
}

function getCoordDir(): string {
  return join(process.cwd(), STORAGE_DIR, COORD_DIR);
}

function getCoordPath(): string {
  return join(getCoordDir(), COORD_FILE);
}

function ensureCoordDir(): void {
  const dir = getCoordDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadCoordStore(): CoordinationStore {
  try {
    const path = getCoordPath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {
    // Return default store
  }
  return {
    topology: {
      type: 'hierarchical',
      maxNodes: 15,
      redundancy: 2,
      consensusAlgorithm: 'raft',
    },
    loadBalance: {
      algorithm: 'adaptive',
      weights: {},
      healthCheck: true,
    },
    sync: {
      lastSync: new Date().toISOString(),
      syncCount: 0,
      conflicts: 0,
      pendingChanges: 0,
    },
    nodes: {},
    orchestrations: {},
    version: '3.0.0',
  };
}

function saveCoordStore(store: CoordinationStore): void {
  ensureCoordDir();
  writeFileSync(getCoordPath(), JSON.stringify(store, null, 2), 'utf-8');
}

function normalizeCoordStore(store: CoordinationStore): CoordinationStore {
  store.orchestrations ??= {};
  return store;
}

export const coordinationTools: MCPTool[] = [
  {
    name: 'coordination_topology',
    description: 'Configure swarm topology',
    category: 'coordination',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'optimize'], description: 'Action to perform' },
        type: { type: 'string', enum: ['mesh', 'hierarchical', 'ring', 'star', 'hybrid', 'hierarchical-mesh'], description: 'Topology type' },
        maxNodes: { type: 'number', description: 'Maximum nodes' },
        redundancy: { type: 'number', description: 'Redundancy level' },
        consensusAlgorithm: { type: 'string', enum: ['raft', 'byzantine', 'gossip', 'crdt'], description: 'Consensus algorithm' },
      },
    },
    handler: async (input) => {
      const store = normalizeCoordStore(loadCoordStore());
      const action = (input.action as string) || 'get';

      if (action === 'get') {
        return {
          success: true,
          topology: store.topology,
          nodes: Object.keys(store.nodes).length,
          status: 'active',
        };
      }

      if (action === 'set') {
        if (input.type) store.topology.type = input.type as TopologyConfig['type'];
        if (input.maxNodes) store.topology.maxNodes = input.maxNodes as number;
        if (input.redundancy) store.topology.redundancy = input.redundancy as number;
        if (input.consensusAlgorithm) store.topology.consensusAlgorithm = input.consensusAlgorithm as string;

        saveCoordStore(store);

        return {
          success: true,
          action: 'updated',
          topology: store.topology,
        };
      }

      if (action === 'optimize') {
        // Analyze current state and suggest optimal topology
        const nodeCount = Object.keys(store.nodes).length;
        let recommended: TopologyConfig['type'] = 'hierarchical';

        if (nodeCount <= 5) {
          recommended = 'mesh';
        } else if (nodeCount <= 15) {
          recommended = 'hierarchical';
        } else {
          recommended = 'hybrid';
        }

        return {
          success: true,
          action: 'optimize',
          current: store.topology.type,
          recommended,
          reason: nodeCount <= 5
            ? 'Small cluster benefits from full mesh connectivity'
            : nodeCount <= 15
              ? 'Medium cluster works well with hierarchical coordination'
              : 'Large cluster needs hybrid approach for scalability',
        };
      }

      return { success: false, error: 'Unknown action' };
    },
  },
  {
    name: 'coordination_load_balance',
    description: 'Configure load balancing',
    category: 'coordination',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'distribute'], description: 'Action to perform' },
        algorithm: { type: 'string', enum: ['round-robin', 'least-connections', 'weighted', 'adaptive'], description: 'Algorithm' },
        weights: { type: 'object', description: 'Node weights' },
        task: { type: 'string', description: 'Task to distribute' },
      },
    },
    handler: async (input) => {
      const store = normalizeCoordStore(loadCoordStore());
      const action = (input.action as string) || 'get';

      if (action === 'get') {
        const nodes = Object.values(store.nodes);
        const avgLoad = nodes.length > 0
          ? nodes.reduce((sum, n) => sum + n.load, 0) / nodes.length
          : 0;

        return {
          success: true,
          loadBalance: store.loadBalance,
          metrics: {
            nodeCount: nodes.length,
            avgLoad,
            maxLoad: nodes.length > 0 ? Math.max(...nodes.map(n => n.load)) : 0,
            minLoad: nodes.length > 0 ? Math.min(...nodes.map(n => n.load)) : 0,
          },
        };
      }

      if (action === 'set') {
        if (input.algorithm) store.loadBalance.algorithm = input.algorithm as LoadBalanceConfig['algorithm'];
        if (input.weights) store.loadBalance.weights = input.weights as Record<string, number>;

        saveCoordStore(store);

        return {
          success: true,
          action: 'updated',
          loadBalance: store.loadBalance,
        };
      }

      if (action === 'distribute') {
        const task = input.task as string;
        const nodes = Object.values(store.nodes).filter(n => n.status === 'active');

        if (nodes.length === 0) {
          return { success: false, error: 'No active nodes available' };
        }

        // Select node based on algorithm
        let selectedNode: typeof nodes[0];
        const algorithm = store.loadBalance.algorithm;

        if (algorithm === 'least-connections' || algorithm === 'adaptive') {
          selectedNode = nodes.reduce((min, n) => n.load < min.load ? n : min);
        } else if (algorithm === 'weighted') {
          const weights = store.loadBalance.weights;
          selectedNode = nodes.reduce((max, n) => (weights[n.id] || 1) > (weights[max.id] || 1) ? n : max);
        } else {
          // Round robin - just pick first active
          selectedNode = nodes[0];
        }

        // Update load
        selectedNode.load += 1;
        saveCoordStore(store);

        return {
          success: true,
          action: 'distributed',
          task,
          assignedTo: selectedNode.id,
          algorithm,
          nodeLoad: selectedNode.load,
        };
      }

      return { success: false, error: 'Unknown action' };
    },
  },
  {
    name: 'coordination_sync',
    description: 'Synchronize state across nodes',
    category: 'coordination',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'trigger', 'resolve'], description: 'Action to perform' },
        force: { type: 'boolean', description: 'Force synchronization' },
        conflictResolution: { type: 'string', enum: ['latest', 'merge', 'manual'], description: 'Conflict resolution strategy' },
      },
    },
    handler: async (input) => {
      const store = normalizeCoordStore(loadCoordStore());
      const action = (input.action as string) || 'status';

      if (action === 'status') {
        const timeSinceSync = Date.now() - new Date(store.sync.lastSync).getTime();

        return {
          success: true,
          sync: store.sync,
          timeSinceSync: `${Math.floor(timeSinceSync / 1000)}s`,
          status: store.sync.conflicts > 0 ? 'conflicts' : store.sync.pendingChanges > 0 ? 'pending' : 'synced',
        };
      }

      if (action === 'trigger') {
        store.sync.syncCount++;
        store.sync.lastSync = new Date().toISOString();
        store.sync.pendingChanges = 0;

        // Simulate sync
        await new Promise(resolve => setTimeout(resolve, 50));

        saveCoordStore(store);

        return {
          success: true,
          action: 'synchronized',
          syncCount: store.sync.syncCount,
          syncedAt: store.sync.lastSync,
          nodesSync: Object.keys(store.nodes).length,
        };
      }

      if (action === 'resolve') {
        const strategy = (input.conflictResolution as string) || 'latest';

        if (store.sync.conflicts > 0) {
          const resolved = store.sync.conflicts;
          store.sync.conflicts = 0;
          saveCoordStore(store);

          return {
            success: true,
            action: 'resolved',
            strategy,
            conflictsResolved: resolved,
          };
        }

        return {
          success: true,
          action: 'resolve',
          message: 'No conflicts to resolve',
        };
      }

      return { success: false, error: 'Unknown action' };
    },
  },
  {
    name: 'coordination_node',
    description: 'Manage coordination nodes',
    category: 'coordination',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove', 'heartbeat'], description: 'Action to perform' },
        nodeId: { type: 'string', description: 'Node ID' },
        status: { type: 'string', description: 'Node status' },
      },
    },
    handler: async (input) => {
      const store = normalizeCoordStore(loadCoordStore());
      const action = (input.action as string) || 'list';

      if (action === 'list') {
        const nodes = Object.values(store.nodes);

        return {
          success: true,
          nodes: nodes.map(n => ({
            id: n.id,
            status: n.status,
            load: n.load,
            lastHeartbeat: n.lastHeartbeat,
          })),
          total: nodes.length,
          active: nodes.filter(n => n.status === 'active').length,
        };
      }

      if (action === 'add') {
        const nodeId = (input.nodeId as string) || `node-${Date.now()}`;

        store.nodes[nodeId] = {
          id: nodeId,
          status: 'active',
          load: 0,
          lastHeartbeat: new Date().toISOString(),
        };

        saveCoordStore(store);

        return {
          success: true,
          action: 'added',
          nodeId,
          totalNodes: Object.keys(store.nodes).length,
        };
      }

      if (action === 'remove') {
        const nodeId = input.nodeId as string;

        if (!store.nodes[nodeId]) {
          return { success: false, error: 'Node not found' };
        }

        delete store.nodes[nodeId];
        saveCoordStore(store);

        return {
          success: true,
          action: 'removed',
          nodeId,
          totalNodes: Object.keys(store.nodes).length,
        };
      }

      if (action === 'heartbeat') {
        const nodeId = input.nodeId as string;

        if (store.nodes[nodeId]) {
          store.nodes[nodeId].lastHeartbeat = new Date().toISOString();
          store.nodes[nodeId].status = 'active';
          saveCoordStore(store);
        }

        return {
          success: true,
          action: 'heartbeat',
          nodeId,
          timestamp: new Date().toISOString(),
        };
      }

      return { success: false, error: 'Unknown action' };
    },
  },
  {
    name: 'coordination_consensus',
    description: 'Manage consensus protocol',
    category: 'coordination',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'propose', 'vote', 'commit'], description: 'Action to perform' },
        proposal: { type: 'object', description: 'Proposal data' },
        vote: { type: 'string', enum: ['accept', 'reject'], description: 'Vote' },
      },
    },
    handler: async (input) => {
      const store = normalizeCoordStore(loadCoordStore());
      const action = (input.action as string) || 'status';

      if (action === 'status') {
        const nodeCount = Object.keys(store.nodes).length;
        const quorum = Math.floor(nodeCount / 2) + 1;

        return {
          success: true,
          algorithm: store.topology.consensusAlgorithm,
          nodes: nodeCount,
          quorum,
          status: nodeCount >= quorum ? 'operational' : 'degraded',
        };
      }

      if (action === 'propose') {
        const proposalId = `proposal-${Date.now()}`;

        return {
          success: true,
          action: 'proposed',
          proposalId,
          proposal: input.proposal,
          status: 'pending',
          requiredVotes: Math.floor(Object.keys(store.nodes).length / 2) + 1,
        };
      }

      if (action === 'vote') {
        return {
          success: true,
          action: 'voted',
          vote: input.vote,
          timestamp: new Date().toISOString(),
        };
      }

      if (action === 'commit') {
        return {
          success: true,
          action: 'committed',
          committedAt: new Date().toISOString(),
        };
      }

      return { success: false, error: 'Unknown action' };
    },
  },
  {
    name: 'coordination_orchestrate',
    description: 'Orchestrate multi-agent coordination',
    category: 'coordination',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task to orchestrate' },
        agents: { type: 'array', description: 'Agent IDs to coordinate' },
        strategy: { type: 'string', enum: ['parallel', 'sequential', 'pipeline', 'broadcast'], description: 'Orchestration strategy' },
        timeout: { type: 'number', description: 'Timeout in ms' },
      },
      required: ['task'],
    },
    handler: async (input) => {
      const store = normalizeCoordStore(loadCoordStore());
      const task = input.task as string;
      const agents = (input.agents as string[]) || Object.keys(store.nodes);
      const strategy = (input.strategy as string) || 'parallel';

      const orchestrationId = `orch-${randomUUID()}`;
      const createdAt = new Date().toISOString();
      const record: OrchestrationRecord = {
        id: orchestrationId,
        task,
        strategy: strategy as OrchestrationRecord['strategy'],
        agents,
        status: 'recorded',
        topology: store.topology.type,
        createdAt,
      };
      store.orchestrations[orchestrationId] = record;
      saveCoordStore(store);

      return {
        success: true,
        orchestrationId,
        task,
        strategy,
        agents,
        status: record.status,
        topology: store.topology.type,
        createdAt,
        executed: false,
        message: 'Coordination plan recorded in local state; no provider agent task dispatch was performed by this compatibility tool.',
      };
    },
  },
  {
    name: 'coordination_metrics',
    description: 'Get coordination metrics',
    category: 'coordination',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['all', 'latency', 'throughput', 'availability'], description: 'Metric type' },
        timeRange: { type: 'string', description: 'Time range' },
      },
    },
    handler: async (input) => {
      const store = normalizeCoordStore(loadCoordStore());
      const metric = (input.metric as string) || 'all';

      const nodes = Object.values(store.nodes);
      const activeNodes = nodes.filter(n => n.status === 'active');
      const loads = nodes.map(n => n.load);
      const totalNodes = nodes.length;
      const avgLoad = loads.length > 0 ? loads.reduce((sum, load) => sum + load, 0) / loads.length : 0;
      const lastSyncMs = Date.parse(store.sync.lastSync);
      const lastSyncAgeMs = Number.isFinite(lastSyncMs) ? Date.now() - lastSyncMs : null;

      const metrics = {
        latency: {
          available: false,
          unit: 'ms',
          reason: 'No real latency samples are recorded by the local coordination store.',
        },
        throughput: {
          available: false,
          unit: 'ops/s',
          reason: 'No real throughput counters are recorded by the local coordination store.',
        },
        availability: {
          activeNodes: activeNodes.length,
          totalNodes,
          inactiveNodes: totalNodes - activeNodes.length,
          availabilityRatio: totalNodes > 0 ? activeNodes.length / totalNodes : null,
          syncStatus: store.sync.conflicts === 0 ? 'healthy' : 'conflicts',
        },
        load: {
          avgLoad,
          maxLoad: loads.length > 0 ? Math.max(...loads) : 0,
          minLoad: loads.length > 0 ? Math.min(...loads) : 0,
          totalLoad: loads.reduce((sum, load) => sum + load, 0),
        },
        sync: {
          syncCount: store.sync.syncCount,
          conflicts: store.sync.conflicts,
          pendingChanges: store.sync.pendingChanges,
          lastSync: store.sync.lastSync,
          lastSyncAgeMs,
        },
        orchestration: {
          recorded: Object.keys(store.orchestrations).length,
        },
      };

      if (metric === 'all') {
        return { success: true, metrics };
      }

      return {
        success: true,
        metric,
        data: metrics[metric as keyof typeof metrics],
      };
    },
  },
];
