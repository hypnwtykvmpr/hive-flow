/**
 * Checkpoint Manager
 * Saves atomic snapshots of swarm state at task boundaries.
 * Enables crash recovery by providing known-good restoration points.
 *
 * Adapted from CodeMachine-CLI's step indexing and session capture patterns.
 */

import { mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IEventBus } from '../interfaces/event.interface.js';
import { SystemEventTypes } from '../interfaces/event.interface.js';

/** State snapshot of a single agent at checkpoint time */
export interface AgentCheckpointState {
  agentId: string;
  agentType: string;
  status: string;
  currentTaskId?: string;
  taskCount: number;
  lastActivity: string;
}

/** State snapshot of a single task at checkpoint time */
export interface TaskCheckpointState {
  taskId: string;
  status: string;
  assignedTo?: string;
  result?: string;
}

/** A complete checkpoint snapshot */
export interface Checkpoint {
  id: string;
  sessionId: string;
  swarmId?: string;
  timestamp: string;
  /** Sequential checkpoint number within session */
  sequence: number;
  /** Agent states at checkpoint time */
  agents: AgentCheckpointState[];
  /** Pending/in-progress tasks */
  tasks: TaskCheckpointState[];
  /** Memory keys that were active (for selective restoration) */
  memoryKeys: string[];
  /** Completion status */
  status: 'active' | 'completed' | 'crashed';
  /** Reason for checkpoint */
  reason: string;
}

/** Configuration for CheckpointManager */
export interface CheckpointManagerConfig {
  /** Directory to store checkpoint files */
  dataDir: string;
  /** Maximum checkpoints to retain per session (default: 10) */
  maxCheckpoints?: number;
  /** Whether to auto-checkpoint on task completion (default: true) */
  autoCheckpoint?: boolean;
}

export class CheckpointManager {
  private sequence = 0;
  private checkpointsDir: string;
  private maxCheckpoints: number;

  constructor(
    private eventBus: IEventBus,
    private config: CheckpointManagerConfig,
  ) {
    this.checkpointsDir = join(config.dataDir, 'checkpoints');
    this.maxCheckpoints = config.maxCheckpoints ?? 10;
  }

  /**
   * Create a checkpoint snapshot.
   * Call this at task boundaries (after task completion/failure).
   */
  async createCheckpoint(
    sessionId: string,
    agents: AgentCheckpointState[],
    tasks: TaskCheckpointState[],
    memoryKeys: string[],
    reason: string,
    swarmId?: string,
  ): Promise<Checkpoint> {
    this.sequence++;

    const checkpoint: Checkpoint = {
      id: `ckpt_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`,
      sessionId,
      swarmId,
      timestamp: new Date().toISOString(),
      sequence: this.sequence,
      agents,
      tasks,
      memoryKeys,
      status: 'active',
      reason,
    };

    // Persist to disk
    const sessionDir = join(this.checkpointsDir, sessionId);
    await mkdir(sessionDir, { recursive: true });

    const filename = `checkpoint-${String(this.sequence).padStart(4, '0')}.json`;
    await writeFile(join(sessionDir, filename), JSON.stringify(checkpoint, null, 2));

    // Prune old checkpoints
    await this.pruneCheckpoints(sessionId);

    this.eventBus.emit(SystemEventTypes.SESSION_PERSISTED, {
      sessionCount: 1,
      path: join(sessionDir, filename),
    });

    return checkpoint;
  }

  /**
   * Mark the latest checkpoint as completed (session ended normally).
   */
  async markCompleted(sessionId: string): Promise<void> {
    const latest = await this.getLatestCheckpoint(sessionId);
    if (latest) {
      latest.status = 'completed';
      const sessionDir = join(this.checkpointsDir, sessionId);
      const filename = `checkpoint-${String(latest.sequence).padStart(4, '0')}.json`;
      await writeFile(join(sessionDir, filename), JSON.stringify(latest, null, 2));
    }
  }

  /**
   * Get the latest checkpoint for a session.
   */
  async getLatestCheckpoint(sessionId: string): Promise<Checkpoint | null> {
    const sessionDir = join(this.checkpointsDir, sessionId);

    try {
      const files = await readdir(sessionDir);
      const checkpointFiles = files
        .filter(f => f.startsWith('checkpoint-') && f.endsWith('.json'))
        .sort()
        .reverse();

      if (checkpointFiles.length === 0) return null;

      const content = await readFile(join(sessionDir, checkpointFiles[0]), 'utf8');
      return JSON.parse(content) as Checkpoint;
    } catch {
      return null;
    }
  }

  /**
   * Get all checkpoints for a session, ordered by sequence.
   */
  async getAllCheckpoints(sessionId: string): Promise<Checkpoint[]> {
    const sessionDir = join(this.checkpointsDir, sessionId);

    try {
      const files = await readdir(sessionDir);
      const checkpointFiles = files
        .filter(f => f.startsWith('checkpoint-') && f.endsWith('.json'))
        .sort();

      const checkpoints: Checkpoint[] = [];
      for (const file of checkpointFiles) {
        try {
          const content = await readFile(join(sessionDir, file), 'utf8');
          checkpoints.push(JSON.parse(content));
        } catch {
          // Skip corrupt checkpoint files
        }
      }

      return checkpoints;
    } catch {
      return [];
    }
  }

  /**
   * Find all sessions with incomplete (active) checkpoints.
   * These are sessions that didn't complete normally — potential crash recovery candidates.
   */
  async findIncompleteSessions(): Promise<Array<{ sessionId: string; checkpoint: Checkpoint }>> {
    const incomplete: Array<{ sessionId: string; checkpoint: Checkpoint }> = [];

    try {
      const sessionDirs = await readdir(this.checkpointsDir, { withFileTypes: true });

      for (const entry of sessionDirs) {
        // Only process directories, skip regular files
        if (!entry.isDirectory()) continue;
        const sessionId = entry.name;

        const latest = await this.getLatestCheckpoint(sessionId);
        if (latest && latest.status === 'active') {
          incomplete.push({ sessionId, checkpoint: latest });
        }
      }
    } catch {
      // Checkpoints directory doesn't exist yet
    }

    return incomplete;
  }

  /**
   * Remove all checkpoints for a session.
   */
  async clearCheckpoints(sessionId: string): Promise<void> {
    const sessionDir = join(this.checkpointsDir, sessionId);

    try {
      const files = await readdir(sessionDir);
      for (const file of files) {
        await unlink(join(sessionDir, file));
      }
    } catch {
      // Directory doesn't exist — fine
    }
  }

  // ─── Private ──────────────────────────────────────────────────

  private async pruneCheckpoints(sessionId: string): Promise<void> {
    const sessionDir = join(this.checkpointsDir, sessionId);

    try {
      const files = await readdir(sessionDir);
      const checkpointFiles = files
        .filter(f => f.startsWith('checkpoint-') && f.endsWith('.json'))
        .sort();

      if (checkpointFiles.length > this.maxCheckpoints) {
        const toRemove = checkpointFiles.slice(0, checkpointFiles.length - this.maxCheckpoints);
        for (const file of toRemove) {
          await unlink(join(sessionDir, file));
        }
      }
    } catch {
      // Ignore pruning errors
    }
  }
}
