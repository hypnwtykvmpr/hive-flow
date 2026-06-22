/**
 * Swarm MCP Tools for CLI
 *
 * Tool definitions for swarm coordination.
 */

import type { MCPTool } from './types.js';
import { DEFAULT_MAX_AGENTS } from '@hive-flow/shared/core/config/defaults';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAgentStore } from './agent-tools.js';

const STORAGE_DIR = '.hive-flow';
const SWARM_DIR = 'swarms';
const SWARM_STORE_FILE = 'store.json';

interface SwarmRecord {
  swarmId: string;
  topology: string;
  status: 'running' | 'stopped';
  maxAgents: number;
  config: Record<string, unknown>;
  initializedAt: string;
  stoppedAt?: string;
}

interface SwarmStore {
  swarms: Record<string, SwarmRecord>;
  activeSwarmId?: string;
  version: string;
}

function getSwarmDir(): string {
  return join(process.cwd(), STORAGE_DIR, SWARM_DIR);
}

function getSwarmStorePath(): string {
  return join(getSwarmDir(), SWARM_STORE_FILE);
}

function loadSwarmStore(): SwarmStore {
  try {
    const storePath = getSwarmStorePath();
    if (existsSync(storePath)) {
      const parsed = JSON.parse(readFileSync(storePath, 'utf-8')) as Partial<SwarmStore>;
      return {
        swarms: parsed.swarms && typeof parsed.swarms === 'object' ? parsed.swarms : {},
        activeSwarmId: typeof parsed.activeSwarmId === 'string' ? parsed.activeSwarmId : undefined,
        version: typeof parsed.version === 'string' ? parsed.version : '3.1.0',
      };
    }
  } catch {
    // Treat unreadable swarm metadata as no active swarm; health will report storage status separately.
  }
  return { swarms: {}, version: '3.1.0' };
}

function saveSwarmStore(store: SwarmStore): void {
  const dir = getSwarmDir();
  mkdirSync(dir, { recursive: true });
  const targetPath = getSwarmStorePath();
  const tmpPath = `${targetPath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmpPath, targetPath);
}

function selectSwarm(store: SwarmStore, swarmId: unknown): SwarmRecord | undefined {
  const explicitId = typeof swarmId === 'string' && swarmId.trim() ? swarmId.trim() : undefined;
  if (explicitId) return store.swarms[explicitId];
  const activeId = store.activeSwarmId;
  return activeId ? store.swarms[activeId] : undefined;
}

function readAgentSummary() {
  const agents = Object.values(loadAgentStore().agents ?? {});
  const activeStatuses = new Set(['spawning', 'idle', 'busy']);
  const active = agents.filter(agent => activeStatuses.has(agent.status)).length;
  const busy = agents.filter(agent => agent.status === 'busy').length;
  const idle = agents.filter(agent => agent.status === 'idle').length;
  const terminated = agents.filter(agent => agent.status === 'terminated').length;
  return {
    total: agents.length,
    active,
    busy,
    idle,
    terminated,
  };
}

function readTaskSummary() {
  const tasksDir = join(process.cwd(), STORAGE_DIR, 'tasks');
  let storeTasks: Array<{ status?: string }> = [];
  let runningProviderTasks = 0;
  let completedProviderTasks = 0;

  try {
    const storePath = join(tasksDir, 'store.json');
    if (existsSync(storePath)) {
      const store = JSON.parse(readFileSync(storePath, 'utf-8')) as { tasks?: Record<string, { status?: string }> };
      storeTasks = Object.values(store.tasks ?? {});
    }
  } catch {
    storeTasks = [];
  }

  try {
    if (existsSync(tasksDir)) {
      for (const file of readdirSync(tasksDir)) {
        if (file.startsWith('task-') && file.endsWith('.json') && !file.endsWith('.result.json')) {
          runningProviderTasks += 1;
        }
        if (file.startsWith('task-') && file.endsWith('.result.json')) {
          completedProviderTasks += 1;
        }
      }
    }
  } catch {
    // Keep counts best-effort.
  }

  const pending = storeTasks.filter(task => task.status === 'pending').length;
  const inProgress = storeTasks.filter(task => task.status === 'in_progress').length + runningProviderTasks;
  const completed = storeTasks.filter(task => task.status === 'completed').length + completedProviderTasks;
  const failed = storeTasks.filter(task => task.status === 'failed').length;
  const cancelled = storeTasks.filter(task => task.status === 'cancelled').length;

  return {
    total: pending + inProgress + completed + failed + cancelled,
    pending,
    inProgress,
    completed,
    failed,
    cancelled,
  };
}

function storageWritable(): boolean {
  try {
    mkdirSync(getSwarmDir(), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export const swarmTools: MCPTool[] = [
  {
    name: 'swarm_init',
    description: 'Initialize a swarm',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        topology: { type: 'string', description: 'Swarm topology type' },
        maxAgents: { type: 'number', description: 'Maximum number of agents' },
        config: { type: 'object', description: 'Swarm configuration' },
      },
    },
    handler: async (input) => {
      const topology = input.topology || 'hierarchical-mesh';
      const maxAgents = input.maxAgents || DEFAULT_MAX_AGENTS;
      const config = (input.config || {}) as Record<string, unknown>;
      const swarmId = `swarm-${randomUUID()}`;
      const initializedAt = new Date().toISOString();
      const store = loadSwarmStore();
      store.swarms[swarmId] = {
        swarmId,
        topology: String(topology),
        status: 'running',
        maxAgents: Number(maxAgents),
        initializedAt,
        config: {
          topology,
          maxAgents,
          communicationProtocol: (config.communicationProtocol as string) || 'message-bus',
          autoScaling: (config.autoScaling as boolean) ?? true,
          consensusMechanism: (config.consensusMechanism as string) || 'majority',
          ...config,
        },
      };
      store.activeSwarmId = swarmId;
      saveSwarmStore(store);

      return {
        success: true,
        swarmId,
        topology,
        initializedAt,
        config: store.swarms[swarmId].config,
      };
    },
  },
  {
    name: 'swarm_status',
    description: 'Get swarm status',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'Swarm ID' },
      },
    },
    handler: async (input) => {
      const store = loadSwarmStore();
      const swarm = selectSwarm(store, input.swarmId);
      const agents = readAgentSummary();
      const tasks = readTaskSummary();

      return {
        success: true,
        swarmId: swarm?.swarmId ?? input.swarmId ?? store.activeSwarmId ?? null,
        status: swarm?.status ?? 'not_initialized',
        topology: swarm?.topology ?? null,
        initializedAt: swarm?.initializedAt ?? null,
        stoppedAt: swarm?.stoppedAt ?? null,
        maxAgents: swarm?.maxAgents ?? DEFAULT_MAX_AGENTS,
        agentCount: agents.active,
        taskCount: tasks.total,
        agents,
        tasks,
      };
    },
  },
  {
    name: 'swarm_shutdown',
    description: 'Shutdown a swarm',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'Swarm ID' },
        graceful: { type: 'boolean', description: 'Graceful shutdown' },
      },
    },
    handler: async (input) => {
      const store = loadSwarmStore();
      const swarm = selectSwarm(store, input.swarmId);
      if (swarm) {
        swarm.status = 'stopped';
        swarm.stoppedAt = new Date().toISOString();
        if (store.activeSwarmId === swarm.swarmId) delete store.activeSwarmId;
        saveSwarmStore(store);
      }

      return {
        success: Boolean(swarm),
        swarmId: swarm?.swarmId ?? input.swarmId ?? null,
        terminated: Boolean(swarm),
        status: swarm ? 'stopped' : 'not_found',
      };
    },
  },
  {
    name: 'swarm_health',
    description: 'Check swarm health status',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'Swarm ID to check' },
      },
    },
    handler: async (input) => {
      const store = loadSwarmStore();
      const swarm = selectSwarm(store, input.swarmId);
      const agents = readAgentSummary();
      const tasks = readTaskSummary();
      const storageOk = storageWritable();
      const checks = [
        {
          name: 'swarm',
          status: swarm?.status === 'running' ? 'ok' : 'warn',
          message: swarm?.status === 'running' ? `Active swarm ${swarm.swarmId}` : 'No active running swarm',
        },
        {
          name: 'agents',
          status: agents.active > 0 ? 'ok' : 'warn',
          message: agents.active > 0 ? `${agents.active} active agent records` : 'No active agent records',
        },
        {
          name: 'tasks',
          status: tasks.failed > 0 ? 'warn' : 'ok',
          message: tasks.failed > 0 ? `${tasks.failed} failed task records` : `${tasks.total} tracked task records`,
        },
        {
          name: 'storage',
          status: storageOk ? 'ok' : 'error',
          message: storageOk ? 'Swarm metadata directory writable' : 'Cannot write swarm metadata directory',
        },
      ] as const;
      const hasError = checks.some(check => check.status === 'error');
      const hasWarn = checks.some(check => check.status === 'warn');

      return {
        success: true,
        status: hasError ? 'unhealthy' as const : hasWarn ? 'degraded' as const : 'healthy' as const,
        swarmId: swarm?.swarmId ?? input.swarmId ?? store.activeSwarmId ?? null,
        checks,
        agents,
        tasks,
        checkedAt: new Date().toISOString(),
      };
    },
  },
];
