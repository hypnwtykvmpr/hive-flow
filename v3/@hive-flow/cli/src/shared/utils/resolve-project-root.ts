/**
 * Project Root Resolution Utility
 *
 * Resolves the hive-flow project root by checking environment variables,
 * walking up from cwd for marker files, and falling back to a global data dir.
 *
 * @module @hive-flow/cli/shared/utils/resolve-project-root
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** Cached project root to avoid repeated filesystem walks */
let cachedRoot: string | null = null;

/** Sentinel value indicating the cached result is the global fallback */
let cachedIsProject = false;

/** Marker files/dirs that indicate a hive-flow project root */
const PROJECT_MARKERS = ['.hive-flow', 'hive-flow.config.json'] as const;

/**
 * Returns the global hive-flow data directory (~/.hive-flow/).
 * Creates the directory if it does not exist.
 */
export function getGlobalDataDir(): string {
  const dir = join(homedir(), '.hive-flow');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Checks whether a directory contains a package.json with a @hive-flow dependency.
 */
function hasHiveFlowDependency(dir: string): boolean {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const raw = readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };
    return Object.keys(allDeps).some((k) => k.startsWith('@hive-flow/'));
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
    if (hasHiveFlowDependency(current)) return current;

    const parent = dirname(current);
    if (parent === current || current === root) break;
    current = parent;
  }
  return null;
}

/**
 * Resolves the project root directory. Search strategy:
 * 1. `HIVE_FLOW_PROJECT_ROOT` environment variable
 * 2. Walk up from cwd looking for `.hive-flow/`, `hive-flow.config.json`,
 *    or a `package.json` with a `@hive-flow` dependency
 * 3. Falls back to `~/.hive-flow/` (global data dir)
 *
 * The result is cached per-process. Use {@link resetProjectRootCache} to clear.
 */
export function resolveProjectRoot(): string {
  if (cachedRoot !== null) return cachedRoot;

  const envRoot = process.env['HIVE_FLOW_PROJECT_ROOT'];
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
 * (not the global `~/.hive-flow/` fallback).
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
