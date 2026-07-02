// Type declarations for the shared CommonJS liveness module
// `hiveflow-task-liveness.cjs` (hive-flow-8b69, Option B, Slice 3). Consumed by
// `progress-authority-classifier.ts` under `moduleResolution: bundler`.

export interface HiveFlowTaskProcessSnapshot {
  alive?: boolean;
  state?: string;
  cpuTimeMs?: number;
}

export interface HiveFlowTaskLivenessPrior {
  observedAtMs: number;
  eventSize: number;
  lastEventTs?: string;
  processSnapshot?: HiveFlowTaskProcessSnapshot | null;
  stableObservationCount?: number;
}

export interface HiveFlowTaskLivenessOptions {
  tasksDir?: string;
  taskId?: string;
  nowMs?: number;
  processSnapshot?: HiveFlowTaskProcessSnapshot | null;
  prior?: HiveFlowTaskLivenessPrior | null;
  idleStallMs?: number;
  minStableObservations?: number;
}

export interface HiveFlowTaskLivenessResult {
  status: 'unknown' | 'completed' | 'progressing' | 'in_flight' | 'orphaned' | 'observing' | 'stalled_review';
  reason: string;
  hung: boolean;
  shouldTerminate: boolean;
  taskId: string;
  signals: {
    resultPresent: boolean;
    eventFilePresent: boolean;
    eventAdvanced: boolean;
    providerRequestInFlight: boolean;
    processAlive: boolean;
    processDead: boolean;
    processCpuAdvanced: boolean;
    silentForMs: number | null;
    stableObservationCount: number;
  };
  nextPrior: HiveFlowTaskLivenessPrior;
}

export function classifyHiveFlowTaskLiveness(
  options?: HiveFlowTaskLivenessOptions,
): HiveFlowTaskLivenessResult;

export const DEFAULT_TASK_STALL_REVIEW_MS: number;
