/**
 * Resource Cleaner
 * Manages cleanup of temporary files, lock files, and other resources
 * during shutdown. Supports registering arbitrary async cleanup handlers.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** A registered cleanup handler */
export interface CleanupHandler {
  name: string;
  priority: number; // Lower = runs first
  handler: () => Promise<void>;
}

class ResourceCleanerImpl {
  private handlers: CleanupHandler[] = [];
  private tempFiles = new Set<string>();
  private lockFiles = new Set<string>();
  private isCleaning = false;

  /** Register a cleanup handler with priority (lower runs first) */
  register(name: string, handler: () => Promise<void>, priority = 100): void {
    this.handlers.push({ name, priority, handler });
  }

  /** Track a temp file for cleanup on shutdown */
  trackTempFile(filePath: string): void {
    this.tempFiles.add(filePath);
  }

  /** Track a lock file for cleanup on shutdown */
  trackLockFile(filePath: string): void {
    this.lockFiles.add(filePath);
  }

  /** Remove a temp file from tracking (e.g., if caller cleaned it up) */
  untrackTempFile(filePath: string): void {
    this.tempFiles.delete(filePath);
  }

  /** Remove a lock file from tracking */
  untrackLockFile(filePath: string): void {
    this.lockFiles.delete(filePath);
  }

  /**
   * Run all cleanup handlers, remove tracked files.
   * Idempotent — safe to call multiple times.
   */
  async cleanAll(): Promise<{ succeeded: string[]; failed: string[] }> {
    if (this.isCleaning) {
      return { succeeded: [], failed: [] };
    }

    this.isCleaning = true;
    const succeeded: string[] = [];
    const failed: string[] = [];

    try {
      // Run registered handlers in priority order
      const sorted = [...this.handlers].sort((a, b) => a.priority - b.priority);
      for (const { name, handler } of sorted) {
        try {
          await handler();
          succeeded.push(name);
        } catch {
          failed.push(name);
        }
      }

      // Remove lock files
      for (const lockFile of this.lockFiles) {
        try {
          await fs.unlink(lockFile);
          succeeded.push(`lock:${path.basename(lockFile)}`);
        } catch {
          // Lock file may not exist — not an error
        }
      }

      // Remove temp files
      for (const tempFile of this.tempFiles) {
        try {
          await fs.unlink(tempFile);
          succeeded.push(`temp:${path.basename(tempFile)}`);
        } catch {
          // Temp file may not exist — not an error
        }
      }
    } finally {
      // Only clear handlers on success or after all attempts
      // Keep tempFiles/lockFiles cleared since we attempted deletion
      this.handlers = [];
      this.tempFiles.clear();
      this.lockFiles.clear();
      this.isCleaning = false;
    }

    return { succeeded, failed };
  }
}

/** Singleton instance */
export const ResourceCleaner = new ResourceCleanerImpl();
