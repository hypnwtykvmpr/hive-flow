// v3/@hive-flow/cli/src/integrations/adapter-registry.ts
//
// Wave 11A — Connector adapter registry (foundation).
//
// Target -> adapter lazy loader. The seven per-CLI adapter modules in
// `./adapters/<target>-connector.ts` self-register through `registerAdapter()`
// at import time (Wave 11B). The registry intentionally starts empty; Wave 11A
// ships only the foundation primitives that the per-CLI files will import.
//
// Why self-registration instead of a static `CONNECTOR_LOADERS` map (the shape
// the canonical runbook sketches in Phase 10):
//   - Phase 5 of this project forbids deferred-work markers in source. A static
//     map referencing `./adapters/claude-code-connector.js` while those files
//     do not yet exist would either need a deferred-work comment or fail
//     typecheck the moment Wave 11A lands.
//   - Self-registration keeps Wave 11A's surface area honest: `loadAdapter()`
//     can only return adapters that have actually imported and registered
//     themselves. Tests in `__tests__/adapter-registry.test.ts` cover the
//     "unknown target" rejection path without needing the per-CLI files.
//   - Wave 11B simply adds a `registerAdapter(target, loader)` call at the top
//     of each per-CLI module. No central map edit is required.
//
// Binding constraints (Phase 10 of the canonical runbook):
//   - Listing every target is independent of loading any adapter. `listAdapterTargets()`
//     returns the frozen `ADAPTER_TARGETS` array from `./adapters/types.ts`
//     regardless of which adapters have registered, so callers can build a
//     consistent UI before Wave 11B lands.
//   - The registry never invokes an adapter; it only resolves the target name to
//     a loader. Per-CLI files perform the install/uninstall.

import type { ConnectorAdapter, AdapterTarget } from './adapters/types.js';
import { ADAPTER_TARGETS } from './adapters/types.js';

/**
 * Lazy-loader signature for an adapter module. The module is expected to
 * provide a `default` export shaped as `ConnectorAdapter`; the loader return
 * type accepts that shape directly so Wave 11B can pass an already-resolved
 * instance (e.g. `() => Promise.resolve(theAdapter)`) for tests.
 */
export type AdapterLoader = () => Promise<ConnectorAdapter | { default: ConnectorAdapter }>;

/**
 * Mutable map of registered adapter loaders, keyed by `AdapterTarget`. Filled
 * by `registerAdapter()` at module import time when Wave 11B's per-CLI files
 * land. Kept as a module-scope `Map` (not a const object) so the registry can
 * be cleared in tests without resorting to module-mock gymnastics.
 *
 * Exposed only through `registerAdapter()` / `loadAdapter()` /
 * `listRegisteredTargets()`. Callers MUST NOT mutate the map directly.
 */
const adapterLoaders: Map<AdapterTarget, AdapterLoader> = new Map();

/**
 * Register a lazy loader for `target`. Wave 11B's per-CLI modules call this at
 * the top of their file body so a side-effecting `import` is sufficient to
 * make the adapter available through `loadAdapter()`.
 *
 * Last-write-wins: registering the same target twice replaces the previous
 * loader. This is the documented behavior so test suites can inject a stub
 * loader without first calling an "unregister" helper.
 */
export function registerAdapter(target: AdapterTarget, loader: AdapterLoader): void {
  if (typeof loader !== 'function') {
    throw new TypeError(`registerAdapter: loader for ${target} must be a function`);
  }
  if (!isKnownTarget(target)) {
    // Defence in depth: TypeScript already rejects unknown string literals,
    // but runtime callers (e.g. dynamic plugin loaders) MUST hit a clear
    // reject before silently growing the map outside the canonical set.
    throw new TypeError(`registerAdapter: unknown target "${String(target)}"`);
  }
  adapterLoaders.set(target, loader);
}

/**
 * Remove a previously-registered loader. Used by tests to reset the registry
 * between cases. Returns `true` when a loader was removed, `false` when none
 * was registered for `target`.
 */
export function unregisterAdapter(target: AdapterTarget): boolean {
  return adapterLoaders.delete(target);
}

/**
 * Clear every registered loader. Test-only helper; production callers do not
 * need this. Exposed as a named export rather than a module-internal helper so
 * `__tests__/adapter-registry.test.ts` can call it directly.
 */
export function resetAdapterRegistry(): void {
  adapterLoaders.clear();
}

/**
 * Load the adapter for `target`. Resolves the loader, invokes it, and
 * normalizes either a bare `ConnectorAdapter` or a module namespace with a
 * `default` export.
 *
 * Throws when:
 *   - `target` is not a member of `AdapterTarget` (defence-in-depth).
 *   - no loader is registered for `target` (Wave 11B may not have shipped the
 *     per-CLI file yet, or the test reset the registry).
 *   - the loader resolves to a value that is not shaped as `ConnectorAdapter`.
 *
 * The thrown errors are typed as plain `Error` rather than a custom subclass
 * because callers (setup command, diagnose layer) only need the message; no
 * known caller branches on the constructor.
 */
export async function loadAdapter(target: AdapterTarget): Promise<ConnectorAdapter> {
  if (!isKnownTarget(target)) {
    throw new Error(`loadAdapter: unknown target "${String(target)}"`);
  }
  const loader = adapterLoaders.get(target);
  if (!loader) {
    throw new Error(
      `loadAdapter: no adapter registered for "${target}". ` +
        `Per-CLI connector files land in Wave 11B; ensure the corresponding ` +
        `./adapters/${target}-connector module has been imported before calling loadAdapter.`,
    );
  }
  const resolved = await loader();
  const adapter = isModuleWithDefault(resolved) ? resolved.default : resolved;
  if (!isConnectorAdapter(adapter)) {
    throw new Error(
      `loadAdapter: loader for "${target}" did not resolve to a ConnectorAdapter shape`,
    );
  }
  if (adapter.target !== target) {
    throw new Error(
      `loadAdapter: loader for "${target}" returned adapter with target="${String(adapter.target)}"`,
    );
  }
  return adapter;
}

/**
 * Return the canonical list of every adapter target the registry knows about.
 * Independent of which adapters have registered: the seven names are fixed in
 * `./adapters/types.ts` so callers can build a consistent UI before Wave 11B
 * lands.
 */
export function listAdapterTargets(): ReadonlyArray<AdapterTarget> {
  return ADAPTER_TARGETS;
}

/**
 * Return the subset of targets that currently have a registered loader. Used
 * by `setup --diagnose connector` to distinguish "not yet shipped" from "not
 * installed".
 */
export function listRegisteredTargets(): ReadonlyArray<AdapterTarget> {
  // Materialize through the canonical order from `ADAPTER_TARGETS` rather than
  // the insertion order of the Map so callers get a deterministic listing.
  return Object.freeze(
    ADAPTER_TARGETS.filter((target) => adapterLoaders.has(target)),
  );
}

/**
 * Type-guard predicate: is `value` a known `AdapterTarget`? Exported so the
 * setup command can sanitize `--agents` input before passing it to
 * `loadAdapter()`.
 */
export function isKnownTarget(value: unknown): value is AdapterTarget {
  if (typeof value !== 'string') return false;
  return (ADAPTER_TARGETS as ReadonlyArray<string>).includes(value);
}

/** Narrow check for "the loader returned a module namespace with `default`". */
function isModuleWithDefault(
  value: unknown,
): value is { default: ConnectorAdapter } {
  if (value === null || typeof value !== 'object') return false;
  const candidate = (value as { default?: unknown }).default;
  return isConnectorAdapter(candidate);
}

/**
 * Structural check that `value` matches `ConnectorAdapter`. Cheap shape probe:
 * we verify `target`, `tier`, `install`, and `uninstall` are present and of
 * the right runtime type. This is intentionally not a full schema validation —
 * TypeScript already pins the shape at compile time; runtime is defence in
 * depth.
 */
function isConnectorAdapter(value: unknown): value is ConnectorAdapter {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as {
    target?: unknown;
    tier?: unknown;
    install?: unknown;
    uninstall?: unknown;
  };
  if (!isKnownTarget(candidate.target)) return false;
  if (candidate.tier !== 'wrapper-mode' && candidate.tier !== 'native-plugin') return false;
  if (typeof candidate.install !== 'function') return false;
  if (typeof candidate.uninstall !== 'function') return false;
  return true;
}
