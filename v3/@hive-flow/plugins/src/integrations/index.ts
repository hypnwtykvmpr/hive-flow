/**
 * Integrations Module
 *
 * Provides integration bridges for external systems:
 * - local compatibility API for swarm coordination
 * - HiveMemory for vector storage and similarity search
 */

export {
  // Hive Integration
  HiveIntegrationBridge,
  getHiveIntegrationBridge,
  HIVE_INTEGRATION_EVENTS,
  type HiveIntegrationConfig,
  type SwarmTopology,
  type AgentSpawnOptions,
  type SpawnedAgent,
  type TaskOrchestrationOptions,
  type OrchestrationResult,
  type HiveIntegrationEvent,

  // HiveMemory
  HiveMemoryBridge,
  getHiveMemoryBridge,
  resetBridges,
  type HiveMemoryConfig,
  type VectorEntry,
  type VectorSearchOptions,
  type VectorSearchResult,
} from './hive-integration.js';
