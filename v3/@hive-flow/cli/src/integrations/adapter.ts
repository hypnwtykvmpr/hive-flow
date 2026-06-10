// v3/@hive-flow/cli/src/integrations/adapter.ts
/**
 * Canonical contract every integration adapter (Claude Code, Codex, ForgeCode,
 * OpenCode, Cursor CLI, Qwen, Gemini) implements. Used by the factory layer in
 * adapters/factories.ts and the dispatch map in adapters/index.ts.
 *
 * Interface-only module — no runtime code, no imports.
 */

export interface AdapterCtx {
  projectRoot: string;
  homeDir: string;
  scope: 'project' | 'user';
  launcherPath: string;
  /** Path to the on-disk statusline launcher shim (set by setup.ts when the
   *  statusline feature is requested). Required by the Claude Code statusline
   *  adapter; ignored by MCP adapters. */
  statuslineLauncherPath?: string;
  /** Optional override for Claude Code user settings. Used by global init tests
   *  and by operators who point the adapter at a non-default settings file. */
  userSettingsPath?: string;
  dryRun: boolean;
  forceAdopt: boolean;
  createConfig: boolean;
  statePath: string;
}

export type AdapterOutcome =
  | 'applied' | 'already-registered' | 'planned'
  | 'missing-config' | 'invalid-config'
  | 'conflict:manual-entry' | 'conflict:duplicate'
  | 'manual-command' | 'failed' | 'busy:locked';

export interface AdapterResult {
  outcome: AdapterOutcome;
  filePath?: string;
  changed?: boolean;
  message?: string;
  manualCommand?: string;
  beforeChecksum?: string;
  afterChecksum?: string;
  backupPath?: string;
}

export interface IntegrationAdapter {
  id: string;
  plan(ctx: AdapterCtx): Promise<AdapterResult>;
  apply(ctx: AdapterCtx): Promise<AdapterResult>;
  verify(ctx: AdapterCtx): Promise<{ ok: boolean; output: string }>;
  uninstall(ctx: AdapterCtx): Promise<AdapterResult>;
}
