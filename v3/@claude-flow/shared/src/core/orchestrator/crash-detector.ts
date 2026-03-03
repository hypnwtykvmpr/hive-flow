/**
 * Crash Detector
 * Scans for incomplete sessions on startup and offers recovery.
 * Works with CheckpointManager to identify sessions that didn't
 * terminate cleanly.
 *
 * Adapted from CodeMachine-CLI's crash recovery patterns.
 */

import type { IEventBus } from '../interfaces/event.interface.js';
import type { CheckpointManager, Checkpoint } from './checkpoint-manager.js';

/** A recoverable session discovered on startup */
export interface RecoverableSession {
  sessionId: string;
  /** When the session was last active */
  lastActiveAt: string;
  /** What was running when it crashed */
  activeAgents: Array<{ agentId: string; agentType: string }>;
  /** How many tasks were pending */
  pendingTaskCount: number;
  /** The checkpoint to restore from */
  checkpoint: Checkpoint;
  /** Time since last activity */
  staleDurationMs: number;
}

/** Configuration for CrashDetector */
export interface CrashDetectorConfig {
  /** Sessions older than this are considered abandoned, not crashed (default: 24h) */
  maxStaleMs?: number;
  /** Whether to auto-detect on startup (default: true) */
  autoDetect?: boolean;
}

const DEFAULT_MAX_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

export class CrashDetector {
  private maxStaleMs: number;

  constructor(
    private eventBus: IEventBus,
    private checkpointManager: CheckpointManager,
    config?: CrashDetectorConfig,
  ) {
    this.maxStaleMs = config?.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
  }

  /**
   * Scan for sessions that crashed (have active checkpoints but no running process).
   * Call this during application startup.
   *
   * Returns sessions that can be recovered, sorted by most recent first.
   */
  async detectCrashedSessions(): Promise<RecoverableSession[]> {
    const incomplete = await this.checkpointManager.findIncompleteSessions();
    const now = Date.now();
    const recoverable: RecoverableSession[] = [];

    for (const { sessionId, checkpoint } of incomplete) {
      const lastActiveAt = new Date(checkpoint.timestamp).getTime();
      const staleDurationMs = now - lastActiveAt;

      // Skip sessions that are too old (abandoned)
      if (staleDurationMs > this.maxStaleMs) {
        // Clean up abandoned sessions
        await this.checkpointManager.clearCheckpoints(sessionId);
        continue;
      }

      const activeAgents = checkpoint.agents
        .filter(a => a.status === 'active' || a.status === 'idle')
        .map(a => ({ agentId: a.agentId, agentType: a.agentType }));

      const pendingTaskCount = checkpoint.tasks
        .filter(t => t.status === 'pending' || t.status === 'in_progress')
        .length;

      recoverable.push({
        sessionId,
        lastActiveAt: checkpoint.timestamp,
        activeAgents,
        pendingTaskCount,
        checkpoint,
        staleDurationMs,
      });
    }

    // Sort by most recent first (smallest staleDurationMs = most recent)
    recoverable.sort((a, b) => a.staleDurationMs - b.staleDurationMs);

    return recoverable;
  }

  /**
   * Mark a session as recovered (acknowledged by user/system).
   * This prevents it from showing up in future crash detection.
   */
  async markRecovered(sessionId: string): Promise<void> {
    await this.checkpointManager.markCompleted(sessionId);
  }

  /**
   * Dismiss a crashed session (user chose not to recover).
   * Cleans up the checkpoint files.
   */
  async dismiss(sessionId: string): Promise<void> {
    await this.checkpointManager.clearCheckpoints(sessionId);
  }
}
