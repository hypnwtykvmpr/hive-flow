/**
 * Project Root Resolution Utility
 *
 * Resolves the claude-flow project root by checking environment variables,
 * walking up from cwd for marker files, and falling back to a global data dir.
 *
 * @module @claude-flow/shared/utils/resolve-project-root
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** Cached project root to avoid repeated filesystem walks */
let cachedRoot: string | null = null;

/** Sentinel value indicating the cached result is the global fallback */
let cachedIsProject = false;

/** Marker files/dirs that indicate a claude-flow project root */
const PROJECT_MARKERS = ['.claude-flow', 'claude-flow.config.json'] as const;

/**
 * Returns the global claude-flow data directory (~/.claude-flow/).
 * Creates the directory if it does not exist.
 */
export function getGlobalDataDir(): string {
  const dir = join(homedir(), '.claude-flow');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Checks whether a directory contains a package.json with a @claude-flow dependency.
 */
function hasClaudeFlowDependency(dir: string): boolean {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const raw = readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };
    return Object.keys(allDeps).some((k) => k.startsWith('@claude-flow/'));
  } catch {
    return false;
  }
}

/**
 * Walks up from `startDir` looking for project markers.
 * Returns the first matching directory, or null if none found.
 */
function findProjectRoot(startDir: string): string | null {
  let current = resolve(startDir);
  const root = dirname(current) === current ? current : '/';

  while (true) {
    for (const marker of PROJECT_MARKERS) {
      if (existsSync(join(current, marker))) return current;
    }
    if (hasClaudeFlowDependency(current)) return current;

    const parent = dirname(current);
    if (parent === current || current === root) break;
    current = parent;
  }
  return null;
}

/**
 * Resolves the project root directory. Search strategy:
 * 1. `CLAUDE_FLOW_PROJECT_ROOT` environment variable
 * 2. Walk up from cwd looking for `.claude-flow/`, `claude-flow.config.json`,
 *    or a `package.json` with a `@claude-flow` dependency
 * 3. Falls back to `~/.claude-flow/` (global data dir)
 *
 * The result is cached per-process. Use {@link resetProjectRootCache} to clear.
 */
export function resolveProjectRoot(): string {
  if (cachedRoot !== null) return cachedRoot;

  const envRoot = process.env['CLAUDE_FLOW_PROJECT_ROOT'];
  if (envRoot && existsSync(envRoot)) {
    cachedRoot = resolve(envRoot);
    cachedIsProject = true;
    return cachedRoot;
  }

  const found = findProjectRoot(process.cwd());
  if (found) {
    cachedRoot = found;
    cachedIsProject = true;
    return cachedRoot;
  }

  cachedRoot = getGlobalDataDir();
  cachedIsProject = false;
  return cachedRoot;
}

/**
 * Returns a subdirectory under the project root, creating it if needed.
 * @param subdir - Relative path beneath the project root (e.g. `"data/memory"`)
 */
export function resolveStorageDir(subdir: string): string {
  const dir = join(resolveProjectRoot(), subdir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Returns `true` if {@link resolveProjectRoot} found a real project
 * (not the global `~/.claude-flow/` fallback).
 */
export function isInsideProject(): boolean {
  resolveProjectRoot(); // ensure cache is populated
  return cachedIsProject;
}

/**
 * Clears the cached project root. Useful for testing.
 */
export function resetProjectRootCache(): void {
  cachedRoot = null;
  cachedIsProject = false;
}
