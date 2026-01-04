/**
 * V3 MCP Swarm Tools
 *
 * MCP tools for swarm coordination operations:
 * - swarm/init - Initialize swarm coordination
 * - swarm/status - Get swarm status
 * - swarm/scale - Scale swarm agents
 *
 * Implements ADR-005: MCP-First API Design
 */

import { z } from 'zod';
import { MCPTool, ToolContext } from '../types.js';

// ============================================================================
// Input Schemas
// ============================================================================

const initSwarmSchema = z.object({
  topology: z.enum(['hierarchical', 'mesh', 'adaptive', 'collective', 'hierarchical-mesh'])
    .default('hierarchical-mesh')
    .describe('Swarm coordination topology'),
  maxAgents: z.number().int().positive().max(1000).default(15)
    .describe('Maximum number of agents in the swarm'),
  config: z.object({
    communicationProtocol: z.enum(['direct', 'message-bus', 'pubsub']).optional(),
    consensusMechanism: z.enum(['majority', 'unanimous', 'weighted', 'none']).optional(),
    failureHandling: z.enum(['retry', 'failover', 'ignore']).optional(),
    loadBalancing: z.boolean().optional(),
    autoScaling: z.boolean().optional(),
  }).optional().describe('Swarm configuration'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
});

const swarmStatusSchema = z.object({
  includeAgents: z.boolean().default(true).describe('Include individual agent information'),
  includeMetrics: z.boolean().default(false).describe('Include performance metrics'),
  includeTopology: z.boolean().default(false).describe('Include topology graph'),
});

const scaleSwarmSchema = z.object({
  targetAgents: z.number().int().positive().max(1000)
    .describe('Target number of agents'),
  scaleStrategy: z.enum(['gradual', 'immediate', 'adaptive']).default('gradual')
    .describe('Scaling strategy'),
  agentTypes: z.array(z.string()).optional()
    .describe('Specific agent types to scale (if not provided, will scale proportionally)'),
  reason: z.string().optional().describe('Reason for scaling'),
});

// ============================================================================
// Type Definitions
// ============================================================================

interface SwarmConfig {
  topology: 'hierarchical' | 'mesh' | 'adaptive' | 'collective' | 'hierarchical-mesh';
  maxAgents: number;
  currentAgents: number;
  communicationProtocol?: string;
  consensusMechanism?: string;
  failureHandling?: string;
  loadBalancing?: boolean;
  autoScaling?: boolean;
}

interface SwarmAgent {
  id: string;
  type: string;
  status: 'active' | 'idle' | 'busy' | 'error';
  role?: 'coordinator' | 'worker' | 'specialist';
  connections?: string[];
}

interface SwarmMetrics {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  inProgressTasks: number;
  averageTaskDuration: number;
  throughput: number;
  efficiency: number;
  uptime: number;
}

interface SwarmTopology {
  nodes: Array<{ id: string; type: string; role?: string }>;
  edges: Array<{ from: string; to: string; weight?: number }>;
  depth?: number;
  fanout?: number;
}

interface InitSwarmResult {
  swarmId: string;
  topology: string;
  initializedAt: string;
  config: SwarmConfig;
}

interface SwarmStatusResult {
  swarmId: string;
  status: 'initializing' | 'active' | 'scaling' | 'degraded' | 'stopped';
  config: SwarmConfig;
  agents?: SwarmAgent[];
  metrics?: SwarmMetrics;
  topology?: SwarmTopology;
  lastActivityAt?: string;
}

interface ScaleSwarmResult {
  swarmId: string;
  previousAgents: number;
  targetAgents: number;
  currentAgents: number;
  scalingStatus: 'in-progress' | 'completed' | 'failed';
  scaledAt: string;
  addedAgents?: string[];
  removedAgents?: string[];
}

// ============================================================================
// Tool Handlers
// ============================================================================

/**
 * Initialize swarm coordination
 */
async function handleInitSwarm(
  input: z.infer<typeof initSwarmSchema>,
  context?: ToolContext
): Promise<InitSwarmResult> {
  const swarmId = `swarm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const initializedAt = new Date().toISOString();

  const config: SwarmConfig = {
    topology: input.topology,
    maxAgents: input.maxAgents,
    currentAgents: 0,
    communicationProtocol: input.config?.communicationProtocol || 'message-bus',
    consensusMechanism: input.config?.consensusMechanism || 'majority',
    failureHandling: input.config?.failureHandling || 'retry',
    loadBalancing: input.config?.loadBalancing ?? true,
    autoScaling: input.config?.autoScaling ?? true,
  };

  // Try to use swarmCoordinator if available
  if (context?.swarmCoordinator) {
    try {
      const { UnifiedSwarmCoordinator } = await import('@claude-flow/swarm');
      const coordinator = context.swarmCoordinator as InstanceType<typeof UnifiedSwarmCoordinator>;

      // Initialize the coordinator with the config
      await coordinator.initialize({
        topology: {
          type: input.topology as any,
          maxAgents: input.maxAgents,
        },
        consensus: {
          algorithm: input.config?.consensusMechanism === 'unanimous' ? 'byzantine' as any :
                     input.config?.consensusMechanism === 'weighted' ? 'raft' as any : 'gossip' as any,
          threshold: input.config?.consensusMechanism === 'unanimous' ? 1.0 :
                    input.config?.consensusMechanism === 'weighted' ? 0.66 : 0.5,
        },
        messageBus: {
          maxQueueSize: 10000,
          batchSize: 100,
        },
      });

      const status = await coordinator.getStatus();
      config.currentAgents = status.agents.length;

      return {
        swarmId: status.swarmId,
        topology: input.topology,
        initializedAt,
        config,
      };
    } catch (error) {
      // Fall through to simple implementation if coordinator fails
      console.error('Failed to initialize swarm via coordinator:', error);
    }
  }

  // Simple implementation when no coordinator is available
  return {
    swarmId,
    topology: input.topology,
    initializedAt,
    config,
  };
}

/**
 * Get swarm status
 */
async function handleSwarmStatus(
  input: z.infer<typeof swarmStatusSchema>,
  context?: ToolContext
): Promise<SwarmStatusResult> {
  // TODO: Integrate with actual swarm coordinator when available
  // For now, return stub response

  const swarmId = 'swarm-current';
  const config: SwarmConfig = {
    topology: 'hierarchical-mesh',
    maxAgents: 15,
    currentAgents: 5,
    communicationProtocol: 'message-bus',
    consensusMechanism: 'majority',
    failureHandling: 'retry',
    loadBalancing: true,
    autoScaling: true,
  };

  const result: SwarmStatusResult = {
    swarmId,
    status: 'active',
    config,
    lastActivityAt: new Date().toISOString(),
  };

  if (input.includeAgents) {
    result.agents = [
      {
        id: 'agent-coordinator-1',
        type: 'queen-coordinator',
        status: 'active',
        role: 'coordinator',
        connections: ['agent-security-1', 'agent-core-1', 'agent-integration-1'],
      },
      {
        id: 'agent-security-1',
        type: 'security-architect',
        status: 'busy',
        role: 'specialist',
        connections: ['agent-coordinator-1'],
      },
      {
        id: 'agent-core-1',
        type: 'core-architect',
        status: 'active',
        role: 'worker',
        connections: ['agent-coordinator-1'],
      },
      {
        id: 'agent-integration-1',
        type: 'integration-architect',
        status: 'idle',
        role: 'worker',
        connections: ['agent-coordinator-1'],
      },
      {
        id: 'agent-performance-1',
        type: 'performance-engineer',
        status: 'active',
        role: 'specialist',
        connections: ['agent-coordinator-1'],
      },
    ];
  }

  if (input.includeMetrics) {
    result.metrics = {
      totalTasks: 150,
      completedTasks: 120,
      failedTasks: 5,
      inProgressTasks: 25,
      averageTaskDuration: 2345.67,
      throughput: 0.85,
      efficiency: 0.92,
      uptime: 7200000,
    };
  }

  if (input.includeTopology) {
    result.topology = {
      nodes: [
        { id: 'agent-coordinator-1', type: 'queen-coordinator', role: 'coordinator' },
        { id: 'agent-security-1', type: 'security-architect', role: 'specialist' },
        { id: 'agent-core-1', type: 'core-architect', role: 'worker' },
        { id: 'agent-integration-1', type: 'integration-architect', role: 'worker' },
        { id: 'agent-performance-1', type: 'performance-engineer', role: 'specialist' },
      ],
      edges: [
        { from: 'agent-coordinator-1', to: 'agent-security-1', weight: 1.0 },
        { from: 'agent-coordinator-1', to: 'agent-core-1', weight: 0.8 },
        { from: 'agent-coordinator-1', to: 'agent-integration-1', weight: 0.9 },
        { from: 'agent-coordinator-1', to: 'agent-performance-1', weight: 0.7 },
      ],
      depth: 2,
      fanout: 4,
    };
  }

  // TODO: Call actual swarm coordinator
  // const swarmCoordinator = context?.swarmCoordinator as SwarmCoordinator;
  // if (swarmCoordinator) {
  //   const status = await swarmCoordinator.getStatus({
  //     includeAgents: input.includeAgents,
  //     includeMetrics: input.includeMetrics,
  //     includeTopology: input.includeTopology,
  //   });
  //   return status;
  // }

  return result;
}

/**
 * Scale swarm agents
 */
async function handleScaleSwarm(
  input: z.infer<typeof scaleSwarmSchema>,
  context?: ToolContext
): Promise<ScaleSwarmResult> {
  // TODO: Integrate with actual swarm coordinator when available
  // For now, return stub response

  const swarmId = 'swarm-current';
  const previousAgents = 5;
  const scaledAt = new Date().toISOString();

  const result: ScaleSwarmResult = {
    swarmId,
    previousAgents,
    targetAgents: input.targetAgents,
    currentAgents: input.targetAgents,
    scalingStatus: 'completed',
    scaledAt,
  };

  if (input.targetAgents > previousAgents) {
    // Scaling up
    const newAgentCount = input.targetAgents - previousAgents;
    result.addedAgents = Array.from({ length: newAgentCount }, (_, i) =>
      `agent-new-${i + 1}`
    );
  } else if (input.targetAgents < previousAgents) {
    // Scaling down
    const removedAgentCount = previousAgents - input.targetAgents;
    result.removedAgents = Array.from({ length: removedAgentCount }, (_, i) =>
      `agent-removed-${i + 1}`
    );
  }

  // TODO: Call actual swarm coordinator
  // const swarmCoordinator = context?.swarmCoordinator as SwarmCoordinator;
  // if (swarmCoordinator) {
  //   const scaleResult = await swarmCoordinator.scale({
  //     targetAgents: input.targetAgents,
  //     strategy: input.scaleStrategy,
  //     agentTypes: input.agentTypes,
  //     reason: input.reason,
  //   });
  //   return scaleResult;
  // }

  return result;
}

// ============================================================================
// Tool Definitions
// ============================================================================

/**
 * swarm/init tool
 */
export const initSwarmTool: MCPTool = {
  name: 'swarm/init',
  description: 'Initialize swarm coordination with specified topology and configuration',
  inputSchema: {
    type: 'object',
    properties: {
      topology: {
        type: 'string',
        enum: ['hierarchical', 'mesh', 'adaptive', 'collective', 'hierarchical-mesh'],
        description: 'Swarm coordination topology',
        default: 'hierarchical-mesh',
      },
      maxAgents: {
        type: 'number',
        description: 'Maximum number of agents in the swarm',
        minimum: 1,
        maximum: 1000,
        default: 15,
      },
      config: {
        type: 'object',
        description: 'Swarm configuration',
        properties: {
          communicationProtocol: {
            type: 'string',
            enum: ['direct', 'message-bus', 'pubsub'],
          },
          consensusMechanism: {
            type: 'string',
            enum: ['majority', 'unanimous', 'weighted', 'none'],
          },
          failureHandling: {
            type: 'string',
            enum: ['retry', 'failover', 'ignore'],
          },
          loadBalancing: { type: 'boolean' },
          autoScaling: { type: 'boolean' },
        },
      },
      metadata: {
        type: 'object',
        description: 'Additional metadata',
        additionalProperties: true,
      },
    },
  },
  handler: async (input, context) => {
    const validated = initSwarmSchema.parse(input);
    return handleInitSwarm(validated, context);
  },
  category: 'swarm',
  tags: ['swarm', 'coordination', 'initialization'],
  version: '1.0.0',
};

/**
 * swarm/status tool
 */
export const swarmStatusTool: MCPTool = {
  name: 'swarm/status',
  description: 'Get current swarm status including agents, metrics, and topology',
  inputSchema: {
    type: 'object',
    properties: {
      includeAgents: {
        type: 'boolean',
        description: 'Include individual agent information',
        default: true,
      },
      includeMetrics: {
        type: 'boolean',
        description: 'Include performance metrics',
        default: false,
      },
      includeTopology: {
        type: 'boolean',
        description: 'Include topology graph',
        default: false,
      },
    },
  },
  handler: async (input, context) => {
    const validated = swarmStatusSchema.parse(input);
    return handleSwarmStatus(validated, context);
  },
  category: 'swarm',
  tags: ['swarm', 'status', 'monitoring'],
  version: '1.0.0',
  cacheable: true,
  cacheTTL: 2000,
};

/**
 * swarm/scale tool
 */
export const scaleSwarmTool: MCPTool = {
  name: 'swarm/scale',
  description: 'Scale swarm up or down to target number of agents',
  inputSchema: {
    type: 'object',
    properties: {
      targetAgents: {
        type: 'number',
        description: 'Target number of agents',
        minimum: 1,
        maximum: 1000,
      },
      scaleStrategy: {
        type: 'string',
        enum: ['gradual', 'immediate', 'adaptive'],
        description: 'Scaling strategy',
        default: 'gradual',
      },
      agentTypes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific agent types to scale',
      },
      reason: {
        type: 'string',
        description: 'Reason for scaling',
      },
    },
    required: ['targetAgents'],
  },
  handler: async (input, context) => {
    const validated = scaleSwarmSchema.parse(input);
    return handleScaleSwarm(validated, context);
  },
  category: 'swarm',
  tags: ['swarm', 'scaling', 'coordination'],
  version: '1.0.0',
};

// ============================================================================
// Exports
// ============================================================================

export const swarmTools: MCPTool[] = [
  initSwarmTool,
  swarmStatusTool,
  scaleSwarmTool,
];

export default swarmTools;
