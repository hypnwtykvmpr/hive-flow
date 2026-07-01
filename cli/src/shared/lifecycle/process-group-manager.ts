/**
 * Process Group Manager
 * Tracks spawned child processes and provides group kill capabilities.
 * Adapted from CodeMachine-CLI's spawn.ts process tracking pattern.
 *
 * Key behaviors:
 * - Global registry of active child processes
 * - Unix process group killing (negative PID sends signal to entire group)
 * - Two-phase termination: SIGTERM first, SIGKILL after timeout
 * - Cross-platform: falls back to direct kill on Windows
 */

import { type ChildProcess } from 'node:child_process';

/** Tracked process entry with metadata */
export interface TrackedProcess {
  process: ChildProcess;
  pid: number;
  label?: string;
  spawnedAt: Date;
}

/**
 * Global registry for active child processes.
 * Singleton — all parts of the application share one registry.
 */
class ProcessGroupManagerImpl {
  private processes = new Map<number, TrackedProcess>();
  private readonly FORCE_KILL_TIMEOUT_MS = 1000;

  /** Register a child process for tracking */
  track(child: ChildProcess, label?: string): void {
    if (!child.pid) return;
    this.processes.set(child.pid, {
      process: child,
      pid: child.pid,
      label,
      spawnedAt: new Date(),
    });

    // Auto-remove when process exits
    child.once('exit', () => {
      if (child.pid) this.processes.delete(child.pid);
    });
    child.once('error', () => {
      if (child.pid) this.processes.delete(child.pid);
    });
  }

  /** Untrack a process (e.g., if caller handles cleanup) */
  untrack(pid: number): void {
    this.processes.delete(pid);
  }

  /** Get all currently tracked processes */
  getAll(): TrackedProcess[] {
    return Array.from(this.processes.values());
  }

  /** Get count of active processes */
  get size(): number {
    return this.processes.size;
  }

  /**
   * Kill a single process by PID.
   * On Unix, kills the entire process group (negative PID).
   * Falls back to direct kill if group kill fails.
   */
  kill(pid: number): void {
    const entry = this.processes.get(pid);
    if (!entry) return;

    this.killProcess(entry);
    this.processes.delete(pid);
  }

  /**
   * Kill all tracked processes.
   * SIGTERM first, then SIGKILL after timeout for stragglers.
   */
  killAll(): void {
    for (const entry of this.processes.values()) {
      this.killProcess(entry);
    }
    this.processes.clear();
  }

  private killProcess(entry: TrackedProcess): void {
    const { process: child, pid } = entry;

    try {
      if (process.platform !== 'win32' && pid) {
        // Unix: kill entire process group with negative PID
        try {
          process.kill(-pid, 'SIGTERM');
          // Force kill after timeout — check child.killed to avoid PID reuse risk
          const ref = child;
          setTimeout(() => {
            try {
              if (!ref.killed) {
                process.kill(-pid, 'SIGKILL');
              }
            } catch {
              // Process group already dead
            }
          }, this.FORCE_KILL_TIMEOUT_MS);
        } catch {
          // Fallback: kill just the direct child
          if (!child.killed) {
            child.kill('SIGTERM');
          }
        }
      } else {
        // Windows or no PID: use child.kill()
        if (!child.killed) {
          child.kill('SIGTERM');
          setTimeout(() => {
            try {
              if (!child.killed) {
                child.kill('SIGKILL');
              }
            } catch {
              // Process already dead
            }
          }, this.FORCE_KILL_TIMEOUT_MS);
        }
      }
    } catch {
      // Ignore errors during cleanup — process may already be dead
    }
  }
}

/** Singleton instance */
export const ProcessGroupManager = new ProcessGroupManagerImpl();
