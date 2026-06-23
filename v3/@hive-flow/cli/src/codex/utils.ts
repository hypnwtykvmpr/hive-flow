/**
 * @hive-flow/cli/codex - Shared Utilities
 */

import fs from 'node:fs/promises';

/**
 * Check if a path exists on the filesystem.
 */
export async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}
