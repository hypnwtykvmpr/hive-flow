// v3/@hive-flow/cli/src/integrations/adapters/types.ts
//
// Wave 11A — Connector adapter foundation: base types only.
//
// This module defines the contract every per-CLI connector adapter implements.
// The seven concrete adapter modules (claude-code-connector.ts,
// codex-connector.ts, gemini-connector.ts, forgecode-connector.ts,
// cursor-cli-connector.ts, qwen-connector.ts, opencode-connector.ts) land in
// Wave 11B and self-register through `adapter-registry.ts`.
//
// Binding constraints (Phase 10 of the canonical runbook + Phase 5):
//   - Non-Claude CLIs are wrapper-mode only ("Codex Settled Decision"); the
//     wrapper script + integration marker are the install artifacts, not native
//     config-merge edits.
//   - Managed scope (Phase 16) is intentionally NOT modeled here: the foundation
//     supports `project` and `user` scopes only.
//   - The seven target names mirror `AdapterId` in `./index.ts` so the per-CLI
//     files in Wave 11B can re-use the existing MCP-installer adapter naming
//     (`'forgecode'`, `'cursor-cli'`, …) without a parallel naming scheme.
//
// Interface-only module — no runtime code, no I/O.

/**
 * Closed set of connector targets for which Wave 11B will land an adapter file.
 * Mirrors the canonical `AdapterId` union in `./index.ts`. Kept as a separate
 * named alias so the adapter-foundation files (`adapter-registry.ts`,
 * `integration-marker.ts`) can import the type without pulling in the entire
 * MCP-installer adapter map.
 */
export type AdapterTarget =
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'forgecode'
  | 'cursor-cli'
  | 'qwen'
  | 'opencode';

/**
 * Frozen list of every adapter target the registry knows about. Source of truth
 * for `listAdapterTargets()` and the registry's lazy-load map. Keep this in
 * sync with the `AdapterTarget` union above; the static assertion below pins
 * the two together so a future edit to one without the other is a type error.
 */
export const ADAPTER_TARGETS: ReadonlyArray<AdapterTarget> = Object.freeze([
  'claude-code',
  'codex',
  'gemini',
  'forgecode',
  'cursor-cli',
  'qwen',
  'opencode',
] as const) satisfies ReadonlyArray<AdapterTarget>;

/**
 * Compile-time check: every `AdapterTarget` member is listed in
 * `ADAPTER_TARGETS` and vice versa. If the union grows or shrinks without a
 * matching update to the frozen array, this satisfies-clause produces a
 * TypeScript error. Tests in `__tests__/adapter-registry.test.ts` enforce the
 * runtime length as a defence-in-depth check.
 */
type _AdapterTargetExhaustivenessCheck = AdapterTarget extends (typeof ADAPTER_TARGETS)[number]
  ? (typeof ADAPTER_TARGETS)[number] extends AdapterTarget
    ? true
    : never
  : never;
const _adapterTargetExhaustive: _AdapterTargetExhaustivenessCheck = true;
void _adapterTargetExhaustive;

/**
 * Connector tier. The runbook's Phase 10 distinguishes the two install routes:
 *   - `wrapper-mode`: PATH-shim script that delegates to the real host CLI.
 *     Default for every non-Claude target. Records session presence via
 *     `hive-flow statusline session …` callbacks.
 *   - `native-plugin`: target-specific config-merge install (Claude Code's
 *     existing statusline adapter is the only verified instance today; other
 *     targets are spike-gated to a future phase).
 *
 * Wave 11B per-CLI files set this on the adapter they export; the integration
 * marker records the tier the install was performed under so `setup --diagnose
 * connector` can verify wrapper paths only for wrapper-mode installs.
 */
export type AdapterTier = 'wrapper-mode' | 'native-plugin';

/**
 * Scope an adapter install targets. Phase 16's `'managed'` scope is deferred:
 * the foundation accepts only `project` and `user`. The diagnose layer treats
 * any unknown scope value as invalid.
 */
export type AdapterScope = 'project' | 'user';

/**
 * Context passed to `install` / `uninstall`. The shape is deliberately narrower
 * than `AdapterCtx` in `../adapter.ts` (which is the MCP-installer's contract):
 *   - `projectRoot` always required; absolute path.
 *   - `cliBin` is the absolute path to the Hive Flow CLI entry the wrapper
 *     script will call back into. Wave 11B's wrapper template embeds this.
 *   - `scope` is the install scope; the foundation only models `project` and
 *     `user`.
 *   - `dryRun` is optional. When true, adapters return the planned writes
 *     without touching disk.
 *
 * No `homeDir`, `launcherPath`, or `forceAdopt` here — those belong to the
 * MCP-installer adapter contract, not the connector foundation.
 */
export interface AdapterCtx {
  readonly projectRoot: string;
  readonly cliBin: string;
  readonly scope: AdapterScope;
  readonly dryRun?: boolean;
}

/**
 * Result of an `install` call. The two arrays MUST be readonly to prevent the
 * caller from mutating an adapter's view of what it wrote.
 *
 *   - `wrote`: absolute paths the adapter actually created (or *would* have
 *     created, in `dryRun`).
 *   - `skipped`: absolute paths the adapter chose not to touch (idempotent
 *     re-install of an already-owned marker, missing host CLI on PATH, etc.).
 *
 * Adapters surface conflicts ("file exists but is not Hive Flow-owned") by
 * throwing; this contract intentionally has no failure outcome enum so the
 * registry can rely on `Promise.reject` semantics rather than a parallel
 * sentinel value.
 */
export interface InstallResult {
  readonly wrote: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
}

/**
 * Result of an `uninstall` call. `removed` is the set of absolute paths the
 * adapter actually deleted (or *would* have deleted in `dryRun`). Idempotent:
 * an uninstall on an already-absent install returns `removed: []` rather than
 * throwing.
 */
export interface UninstallResult {
  readonly removed: ReadonlyArray<string>;
}

/**
 * Contract every per-CLI connector adapter implements. The Wave 11B files in
 * `./adapters/<target>-connector.ts` `export default` an instance of this
 * shape and call `registerAdapter(target, loader)` from
 * `../adapter-registry.ts` at import time.
 *
 * Install/uninstall are async because the wrapper templates require an I/O
 * call (atomic write of the script, atomic write of the marker, optional
 * `fsync`). They MUST be idempotent: calling install twice with the same
 * context produces the same end-state on disk.
 */
export interface ConnectorAdapter {
  readonly target: AdapterTarget;
  readonly tier: AdapterTier;
  install(ctx: AdapterCtx): Promise<InstallResult>;
  uninstall(ctx: AdapterCtx): Promise<UninstallResult>;
}
