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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _mainModulePromise: Promise<any | null> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _subpathCache = new Map<string, Promise<any | null>>();

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
    _mainModulePromise = import('agentic-flow').catch(() => null);
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
    // Dynamic specifier must be a template literal for bundlers to keep it
    // as-is (non-statically-analysable).
    _subpathCache.set(
      subpath,
      import(`agentic-flow/${subpath}`).catch(() => null),
    );
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
