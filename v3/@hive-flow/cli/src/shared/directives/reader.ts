/**
 * Directive Reader
 * Reads and validates directive files written by agents.
 * Adapted from CodeMachine-CLI's directive reader.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DirectiveActionSchema, type DirectiveAction } from './types.js';

const DIRECTIVE_FILENAME = 'directive.json';

/**
 * Read and parse a directive file from the given directory.
 * Returns null if no directive file exists or if it's invalid.
 */
export async function readDirective(directivesDir: string, agentId?: string): Promise<DirectiveAction | null> {
  const subdir = agentId ? path.join(directivesDir, agentId) : directivesDir;
  const filePath = path.join(subdir, DIRECTIVE_FILENAME);

  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content);
    const result = DirectiveActionSchema.safeParse(parsed);

    if (!result.success) {
      return null;
    }

    return result.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null; // No directive file — normal case
    }
    return null; // Parse/read error — treat as no directive
  }
}

/**
 * Write a directive file (used by agents to communicate with coordinator).
 */
export async function writeDirective(
  directivesDir: string,
  directive: DirectiveAction,
  agentId?: string,
): Promise<void> {
  const subdir = agentId ? path.join(directivesDir, agentId) : directivesDir;
  await fs.mkdir(subdir, { recursive: true });

  const filePath = path.join(subdir, DIRECTIVE_FILENAME);
  await fs.writeFile(filePath, JSON.stringify(directive, null, 2));
}

/**
 * Reset directive to 'continue' (clear any pending directive).
 */
export async function resetDirective(directivesDir: string, agentId?: string): Promise<void> {
  await writeDirective(directivesDir, { action: 'continue' }, agentId);
}

/**
 * Remove directive file entirely.
 */
export async function removeDirective(directivesDir: string, agentId?: string): Promise<void> {
  const subdir = agentId ? path.join(directivesDir, agentId) : directivesDir;
  const filePath = path.join(subdir, DIRECTIVE_FILENAME);

  try {
    await fs.unlink(filePath);
  } catch {
    // File doesn't exist — fine
  }
}
