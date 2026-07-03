// cli/src/integrations/adapters/factories.ts
import { spawnSync } from 'node:child_process';
import { parse, modify, applyEdits, type JSONPath } from 'jsonc-parser';
import { upsertJsonPath, readTextIfExists, atomicWrite, copyBackupOnce } from '../atomic-merge.js';
import { upsertTomlBlock, removeTomlBlock } from '../toml-block.js';
import { readState, writeState, checksumEntry, entryId } from '../state.js';
import { detectVariants } from '../variant-detection.js';
import type { AdapterCtx, AdapterResult, IntegrationAdapter } from '../adapter.js';

function walkValue(node: any, path: JSONPath): unknown {
  let cur: any = node;
  for (const p of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p as any];
  }
  return cur;
}

const TRANSIT_OUTCOMES = new Set(['applied', 'planned', 'already-registered']);

// -----------------------------------------------------------------------------
// JSON adapter factory
// -----------------------------------------------------------------------------

export interface JsonAdapterConfig {
  id: string;
  cli: { bin: string; args: string[] };
  verifyMatch: RegExp;
  userPath: (homeDir: string) => string | null;          // null = scope unsupported (falls through to manual-command)
  projectPath: (projectRoot: string) => string | null;
  jsonPath: JSONPath;                                    // e.g., ['mcpServers', 'hive-flow']
  parentPathForVariantScan: string;                      // dotted parent, e.g., 'mcpServers'
  canonicalKey: string;                                  // e.g., 'hive-flow'
  buildValue: (ctx: AdapterCtx) => unknown;
}

function jsonFilePath(cfg: JsonAdapterConfig, ctx: AdapterCtx): string | null {
  return ctx.scope === 'user' ? cfg.userPath(ctx.homeDir) : cfg.projectPath(ctx.projectRoot);
}

export function makeJsonAdapter(cfg: JsonAdapterConfig): IntegrationAdapter {
  async function planOrApply(ctx: AdapterCtx, dryRun: boolean): Promise<AdapterResult> {
    const filePath = jsonFilePath(cfg, ctx);
    if (!filePath) return { outcome: 'manual-command', message: `${cfg.id} does not support ${ctx.scope}-scope file merge.` };

    // Variant pre-flight: catch HIVE-FLOW / hive_flow / etc. before the case-sensitive merge.
    const variants = await detectVariants(filePath, cfg.parentPathForVariantScan, cfg.canonicalKey);
    if (variants.length > 0) {
      return { outcome: 'conflict:duplicate', filePath, message: `Pre-existing key variants of '${cfg.canonicalKey}' under '${cfg.parentPathForVariantScan}': ${variants.join(', ')}. Resolve manually before applying.` };
    }

    const value = cfg.buildValue(ctx);
    const stateId = entryId({ agent: cfg.id, kind: 'mcp', scope: ctx.scope, targetPath: filePath, jsonPath: cfg.jsonPath.join('.') });
    const state = await readState(ctx.statePath);

    const result = await upsertJsonPath({
      filePath, ownership: 'agent', jsonPath: cfg.jsonPath, value,
      dryRun, createIfMissing: ctx.createConfig, forceAdopt: ctx.forceAdopt,
      isManaged: async (existing) => {
        const r = state.entries[stateId];
        return !!r && r.checksum === checksumEntry(existing);
      },
    });

    if (!dryRun && result.outcome === 'applied') {
      const s2 = await readState(ctx.statePath);
      s2.entries[stateId] = {
        agent: cfg.id, kind: 'mcp', scope: ctx.scope,
        targetPath: filePath, jsonPath: cfg.jsonPath.join('.'),
        checksum: checksumEntry(value), launcherPath: ctx.launcherPath,
        installedAt: new Date().toISOString(), version: 1,
      };
      await writeState(ctx.statePath, s2);
    }
    return result;
  }

  async function uninstall(ctx: AdapterCtx): Promise<AdapterResult> {
    const filePath = jsonFilePath(cfg, ctx);
    if (!filePath) return { outcome: 'manual-command', message: `${cfg.id} ${ctx.scope}-scope uninstall is manual.` };
    const stateId = entryId({ agent: cfg.id, kind: 'mcp', scope: ctx.scope, targetPath: filePath, jsonPath: cfg.jsonPath.join('.') });

    const fileText = await readTextIfExists(filePath);
    if (fileText === null) return { outcome: 'already-registered', filePath, message: `${cfg.id} config absent; nothing to remove.` };

    const existing = walkValue(parse(fileText, [], { allowTrailingComma: true }), cfg.jsonPath);
    if (existing === undefined) return { outcome: 'already-registered', filePath, message: `No '${cfg.canonicalKey}' entry at ${cfg.jsonPath.join('.')}.` };

    const state = await readState(ctx.statePath);
    const ourEntry = state.entries[stateId];
    if ((!ourEntry || ourEntry.checksum !== checksumEntry(existing)) && !ctx.forceAdopt) {
      return { outcome: 'conflict:manual-entry', filePath, message: `Refusing to remove unmanaged '${cfg.canonicalKey}' entry. Use --force-adopt.` };
    }

    // jsonc-parser's modify(..., undefined, ...) deletes the path while preserving siblings, comments, and formatting.
    const edits = modify(fileText, cfg.jsonPath, undefined, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } });
    const after = applyEdits(fileText, edits);
    if (ctx.dryRun) return { outcome: 'planned', filePath, changed: true, message: `Would remove ${cfg.jsonPath.join('.')}.` };
    const backupPath = await copyBackupOnce(filePath);
    await atomicWrite(filePath, after);
    const s2 = await readState(ctx.statePath);
    delete s2.entries[stateId];
    await writeState(ctx.statePath, s2);
    return { outcome: 'applied', filePath, changed: true, backupPath, message: `Removed ${cfg.jsonPath.join('.')}.` };
  }

  async function verifyImpl(ctx: AdapterCtx): Promise<{ ok: boolean; output: string }> {
    const r = spawnSync(cfg.cli.bin, cfg.cli.args, { cwd: ctx.projectRoot, encoding: 'utf8', timeout: 10_000 });
    const output = (r.stdout ?? '') + (r.stderr ?? '');
    return { ok: r.status === 0 && cfg.verifyMatch.test(output), output: output.slice(0, 2000) };
  }

  return {
    id: cfg.id,
    plan:      (ctx) => planOrApply(ctx, true),
    apply:     (ctx) => planOrApply(ctx, ctx.dryRun),
    verify:    verifyImpl,
    uninstall: uninstall,
  };
}

// -----------------------------------------------------------------------------
// TOML adapter factory (main table + optional env subtable)
// -----------------------------------------------------------------------------

export interface TomlAdapterConfig {
  id: string;
  cli: { bin: string; args: string[] };
  verifyMatch: RegExp;
  userPath: (homeDir: string) => string | null;
  projectPath: (projectRoot: string) => string | null;
  mainTable: string;                                     // e.g., 'mcp_servers.hive-flow'
  envTable?: string;                                     // e.g., 'mcp_servers.hive-flow.env'
  canonicalKey: string;                                  // e.g., 'hive-flow'
  buildMain: (ctx: AdapterCtx) => Record<string, unknown>;
  buildEnv?: (ctx: AdapterCtx) => Record<string, unknown>;
}

export function makeTomlAdapter(cfg: TomlAdapterConfig): IntegrationAdapter {
  function tomlFilePath(ctx: AdapterCtx): string | null {
    return ctx.scope === 'user' ? cfg.userPath(ctx.homeDir) : cfg.projectPath(ctx.projectRoot);
  }

  async function planOrApply(ctx: AdapterCtx, dryRun: boolean): Promise<AdapterResult> {
    const filePath = tomlFilePath(ctx);
    if (!filePath) return { outcome: 'manual-command', message: `${cfg.id} does not support ${ctx.scope}-scope TOML merge.` };

    // Variant pre-flight against TOML headers.
    const variants = await detectVariants(filePath, 'mcp_servers', cfg.canonicalKey);
    if (variants.length > 0) {
      return { outcome: 'conflict:duplicate', filePath, message: `Pre-existing TOML key variants of '${cfg.canonicalKey}': ${variants.join(', ')}.` };
    }

    const stateId = entryId({ agent: cfg.id, kind: 'mcp', scope: ctx.scope, targetPath: filePath, jsonPath: cfg.mainTable });
    const state = await readState(ctx.statePath);
    const stateEntry = state.entries[stateId];

    // Checksum-backed ownership policy (parity with JSON; Codex pass-4 item 2).
    // Main table: compare existing-on-disk checksum against state.checksum.
    // Env subtable: compare existing-on-disk checksum against state.envChecksum.
    // If either differs from the last-written value, the user tampered with our block —
    // require --force-adopt to overwrite.
    const isManagedMain = async (existingMain: Record<string, unknown>) =>
      stateEntry !== undefined && stateEntry.checksum === checksumEntry(existingMain);
    const isManagedEnv = async (existingEnv: Record<string, unknown>) =>
      stateEntry !== undefined && stateEntry.envChecksum === checksumEntry(existingEnv);

    const mainResult = await upsertTomlBlock({
      filePath, tableName: cfg.mainTable, values: cfg.buildMain(ctx),
      ownership: 'agent', dryRun, createIfMissing: ctx.createConfig,
      isManaged: isManagedMain, forceAdopt: ctx.forceAdopt,
    });
    if (!TRANSIT_OUTCOMES.has(mainResult.outcome as string)) return mainResult as AdapterResult;

    let envResult: AdapterResult | undefined;
    if (cfg.envTable && cfg.buildEnv) {
      envResult = await upsertTomlBlock({
        filePath, tableName: cfg.envTable, values: cfg.buildEnv(ctx),
        ownership: 'agent', dryRun,
        // Mirror the main-table `createIfMissing` (Codex pass-5 item 1). In dry-run, the main
        // upsert returns `planned` without creating the file, so the env upsert would otherwise
        // see the file as absent and return `missing-config`. Sharing `ctx.createConfig` keeps
        // dry-run + --create-config consistent across both tables.
        createIfMissing: ctx.createConfig,
        isManaged: isManagedEnv, forceAdopt: ctx.forceAdopt,
      }) as AdapterResult;
      if (!TRANSIT_OUTCOMES.has(envResult.outcome as string)) return envResult;
    }

    // Aggregate main + env outcomes so env-only changes are not silently hidden (Codex pass-3 item 4).
    const applied = mainResult.outcome === 'applied' || envResult?.outcome === 'applied';
    const planned = mainResult.outcome === 'planned' || envResult?.outcome === 'planned';
    const aggregatedOutcome = applied ? 'applied' : planned ? 'planned' : mainResult.outcome;

    if (!dryRun && applied) {
      const s2 = await readState(ctx.statePath);
      s2.entries[stateId] = {
        agent: cfg.id, kind: 'mcp', scope: ctx.scope,
        targetPath: filePath, jsonPath: cfg.mainTable,
        checksum: checksumEntry(cfg.buildMain(ctx)),
        envChecksum: cfg.envTable && cfg.buildEnv ? checksumEntry(cfg.buildEnv(ctx)) : undefined,
        launcherPath: ctx.launcherPath, installedAt: new Date().toISOString(), version: 1,
      };
      await writeState(ctx.statePath, s2);
    }

    // Codex pass-5 item 3: return an internally consistent aggregate when env changes but main didn't.
    // Spreading `...mainResult` would leak `changed: false, message: 'No change needed.'` even
    // though the env subtable updated. Build an explicit result instead.
    if (applied || planned) {
      const subjectLabel = cfg.envTable ? `${cfg.mainTable} and/or ${cfg.envTable}` : cfg.mainTable;
      return {
        outcome: aggregatedOutcome as AdapterResult['outcome'],
        filePath,
        changed: true,
        message: planned ? `Would update ${subjectLabel}.` : `Updated ${subjectLabel}.`,
        beforeChecksum: mainResult.beforeChecksum,
        afterChecksum: envResult?.afterChecksum ?? mainResult.afterChecksum,
        backupPath: envResult?.backupPath ?? mainResult.backupPath,
      };
    }
    return mainResult as AdapterResult;
  }

  async function verifyImpl(ctx: AdapterCtx): Promise<{ ok: boolean; output: string }> {
    const r = spawnSync(cfg.cli.bin, cfg.cli.args, { cwd: ctx.projectRoot, encoding: 'utf8', timeout: 10_000 });
    const output = (r.stdout ?? '') + (r.stderr ?? '');
    return { ok: r.status === 0 && cfg.verifyMatch.test(output), output: output.slice(0, 2000) };
  }

  async function uninstall(ctx: AdapterCtx): Promise<AdapterResult> {
    const filePath = tomlFilePath(ctx);
    if (!filePath) return { outcome: 'manual-command', message: `${cfg.id} ${ctx.scope}-scope uninstall is manual.` };
    const stateId = entryId({ agent: cfg.id, kind: 'mcp', scope: ctx.scope, targetPath: filePath, jsonPath: cfg.mainTable });
    const state = await readState(ctx.statePath);
    const stateEntry = state.entries[stateId];
    // Checksum-backed ownership (parity with JSON; Codex pass-4 item 2).
    const isManagedMain = async (existingMain: Record<string, unknown>) =>
      stateEntry !== undefined && stateEntry.checksum === checksumEntry(existingMain);
    const isManagedEnv = async (existingEnv: Record<string, unknown>) =>
      stateEntry !== undefined && stateEntry.envChecksum === checksumEntry(existingEnv);
    // Remove env subtable first (if present), then the main table.
    // Codex pass-5 item 2: if env removal returns a conflict or failure, bail out BEFORE touching
    // the main table — otherwise we orphan the env subtable and lose state when main succeeds.
    if (cfg.envTable) {
      const envResult = await removeTomlBlock({ filePath, tableName: cfg.envTable, ownership: 'agent', dryRun: ctx.dryRun, isManaged: isManagedEnv, forceAdopt: ctx.forceAdopt });
      if (!TRANSIT_OUTCOMES.has(envResult.outcome as string)) return envResult as AdapterResult;
    }
    const result = await removeTomlBlock({ filePath, tableName: cfg.mainTable, ownership: 'agent', dryRun: ctx.dryRun, isManaged: isManagedMain, forceAdopt: ctx.forceAdopt });
    if (!ctx.dryRun && result.outcome === 'applied') {
      const s2 = await readState(ctx.statePath);
      delete s2.entries[stateId];
      await writeState(ctx.statePath, s2);
    }
    return result as AdapterResult;
  }

  return {
    id: cfg.id,
    plan:      (ctx) => planOrApply(ctx, true),
    apply:     (ctx) => planOrApply(ctx, ctx.dryRun),
    verify:    verifyImpl,
    uninstall: uninstall,
  };
}

// -----------------------------------------------------------------------------
// Manual-command adapter (for scopes with no file-merge surface)
// Falls through to a JsonAdapter for scopes outside `manualScopes`.
// -----------------------------------------------------------------------------

export interface ManualCommandAdapterConfig {
  id: string;
  manualScopes: Array<'user' | 'project'>;
  buildCommand: (ctx: AdapterCtx) => string;
  cli: { bin: string; args: string[] };
  verifyMatch: RegExp;
  uninstallCommand?: (ctx: AdapterCtx) => string;
  /** Optional idempotency probe. If it returns true for the current scope,
   *  plan/apply return `already-registered` instead of `manual-command`. Lets
   *  the manual-command adapter report idempotent state when the user has
   *  already run the manual CLI registration (e.g., forge user-scope writes
   *  to `~/.forge/.mcp.json` after `forge mcp import`). */
  isAlreadyRegistered?: (ctx: AdapterCtx) => Promise<boolean>;
}

export function makeManualCommandAdapter(cfg: ManualCommandAdapterConfig, fallback: IntegrationAdapter): IntegrationAdapter {
  const isManual = (ctx: AdapterCtx) => cfg.manualScopes.includes(ctx.scope);
  async function manualResult(ctx: AdapterCtx): Promise<AdapterResult> {
    if (cfg.isAlreadyRegistered && (await cfg.isAlreadyRegistered(ctx))) {
      return { outcome: 'already-registered', message: `${cfg.id} ${ctx.scope}-scope already registered (manual CLI registration detected).` };
    }
    return { outcome: 'manual-command', manualCommand: cfg.buildCommand(ctx), message: `${cfg.id} ${ctx.scope}-scope requires manual CLI registration.` };
  }
  return {
    id: cfg.id,
    async plan(ctx) {
      return isManual(ctx) ? manualResult(ctx) : fallback.plan(ctx);
    },
    async apply(ctx) {
      return isManual(ctx) ? manualResult(ctx) : fallback.apply(ctx);
    },
    async verify(ctx) {
      const r = spawnSync(cfg.cli.bin, cfg.cli.args, { cwd: ctx.projectRoot, encoding: 'utf8', timeout: 10_000 });
      const output = (r.stdout ?? '') + (r.stderr ?? '');
      return { ok: r.status === 0 && cfg.verifyMatch.test(output), output: output.slice(0, 2000) };
    },
    async uninstall(ctx) {
      if (isManual(ctx)) {
        const cmd = cfg.uninstallCommand?.(ctx) ?? `${cfg.cli.bin} mcp remove hive-flow --scope ${ctx.scope}`;
        return { outcome: 'manual-command', manualCommand: cmd, message: `${cfg.id} ${ctx.scope}-scope uninstall is manual.` };
      }
      return fallback.uninstall(ctx);
    },
  };
}
