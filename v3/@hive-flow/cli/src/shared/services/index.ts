/**
 * Shared Services
 *
 * @module @hive-flow/cli/shared/services
 */

export {
  V3ProgressService,
  createV3ProgressService,
  getV3Progress,
  syncV3Progress,
  getDefaultProgressService,
  type V3ProgressMetrics,
  type V3ProgressOptions,
  type ProgressChangeEvent,
} from './v3-progress.service.js';

export {
  ProviderRegistry,
  ProviderEvents,
  type ProviderType,
  type ProviderHealthStatus,
  type ProviderCapabilities,
  type ProviderMetadata,
  type ProviderModule,
  type ProviderHealthResult,
  type ProviderRegistryConfig,
} from './provider-registry.js';

// Health Services
export * from './health/index.js';
