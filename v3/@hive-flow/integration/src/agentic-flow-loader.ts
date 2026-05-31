/**
 * Shared dynamic loader for the optional `agentic-flow` dependency.
 *
 * Every consumer that needs `agentic-flow` should call one of these helpers
 * instead of inlining its own `await import('agentic-flow').catch(() => null)`.
 * The module is loaded at most once and the result is cached for the lifetime
 * of the process.
 *
 * Subpath imports (`agentic-flow/core`, `agentic-flow/embeddings`, etc.) are
 * handled by {@link loadAgenticFlowSubpath} so the same caching / error-handling
 * pattern applies everywhere.
 */

import { createRequire } from 'node:module';
import { sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _mainModulePromise: Promise<any | null> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _subpathCache = new Map<string, Promise<any | null>>();

const require = createRequire(import.meta.url);
const moduleFile = fileURLToPath(import.meta.url);
const localV3Root = findLocalV3Root(moduleFile);

function findLocalV3Root(filePath: string): string | null {
  const marker = `${sep}v3${sep}@hive-flow${sep}integration${sep}`;
  const index = filePath.indexOf(marker);
  return index === -1 ? null : filePath.slice(0, index + `${sep}v3`.length);
}

function canUseResolvedPath(resolvedPath: string): boolean {
  if (!localV3Root) return true;
  return resolvedPath === localV3Root || resolvedPath.startsWith(localV3Root + sep);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function importOptionalAgenticFlow(specifier: string): Promise<any | null> {
  try {
    const resolved = require.resolve(specifier);
    if (!canUseResolvedPath(resolved)) return null;
    return await import(pathToFileURL(resolved).href);
  } catch {
    return null;
  }
}

/**
 * Dynamically import the root `agentic-flow` package.
 *
 * Returns `null` when the package is not installed — callers must
 * handle the fallback case themselves.
 *
 * The result is cached; subsequent calls return the same promise.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadAgenticFlow(): Promise<any | null> {
  if (!_mainModulePromise) {
    _mainModulePromise = importOptionalAgenticFlow('agentic-flow');
  }
  return _mainModulePromise;
}

/**
 * Dynamically import a subpath of `agentic-flow` (e.g. `"core"`, `"embeddings"`,
 * `"reasoningbank"`).
 *
 * @param subpath  The bare subpath **without** the leading package name.
 *                 Example: `"core"` resolves to `import('agentic-flow/core')`.
 *
 * Returns `null` when the subpath (or the package itself) is unavailable.
 * Results are cached per subpath.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadAgenticFlowSubpath(subpath: string): Promise<any | null> {
  if (!_subpathCache.has(subpath)) {
    _subpathCache.set(subpath, importOptionalAgenticFlow(`agentic-flow/${subpath}`));
  }
  return _subpathCache.get(subpath)!;
}

/**
 * Check whether `agentic-flow` is importable without retaining a reference
 * to the module.  Useful for boolean feature-gating.
 */
export async function isAgenticFlowAvailable(): Promise<boolean> {
  return (await loadAgenticFlow()) != null;
}

/**
 * Reset the cached state.  Primarily useful in tests.
 */
export function resetAgenticFlowLoader(): void {
  _mainModulePromise = null;
  _subpathCache.clear();
}
