// cli/src/integrations/adapters/claude-code-statusline.ts
/**
 * Claude Code Statusline Adapter (canonical).
 *
 * Hand-written rather than composed from `makeJsonAdapter` because the
 * statusline contract requires:
 *   - Storing `previousValue` / `previousChecksum` on the `ManagedRecord` so
 *     uninstall can restore (not just delete) whatever statusLine the user had
 *     before Hive Flow took ownership.
 *   - A `verify()` that not only checks the configured path but also actually
 *     spawns the launcher shim against a sample Claude Code stdin payload and
 *     asserts the rendered output contains the canonical "▊" sentinel emitted
 *     by `claude-code-renderer.ts`.
 *   - A project-scope override warning surfaced through both `apply` and
 *     `verify` outputs so the user is told when a project-scope settings file
 *     will shadow the user-scope configuration they just installed.
 *
 * Dispatched per-feature from `commands/setup.ts` (Wave 4); NOT wired into the
 * `ADAPTERS` map in `adapters/index.ts` — that map is reserved for MCP-style
 * adapters spread across the seven canonical agents.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { applyEdits, modify, parse, type JSONPath, type ParseError } from 'jsonc-parser';
import { atomicWrite, copyBackupOnce, readTextIfExists, upsertJsonPath } from '../atomic-merge.js';
import { checksumEntry, entryId, readState, writeState } from '../state.js';
import { commandForClaudeSettings } from '../launcher.js';
import type { AdapterCtx, AdapterResult, IntegrationAdapter } from '../adapter.js';

const JSON_PATH: JSONPath = ['statusLine'];
const JSON_PATH_LABEL = 'statusLine';

function filePathFor(ctx: AdapterCtx): string {
  if (ctx.scope === 'user' && ctx.userSettingsPath) {
    return ctx.userSettingsPath;
  }
  return ctx.scope === 'user'
    ? join(ctx.homeDir, '.claude', 'settings.json')
    : join(ctx.projectRoot, '.claude', 'settings.json');
}

function buildValue(ctx: AdapterCtx): Record<string, unknown> {
  if (!ctx.statuslineLauncherPath) {
    throw new Error('statuslineLauncherPath missing from AdapterCtx');
  }
  return {
    type: 'command',
    command: commandForClaudeSettings(ctx.statuslineLauncherPath),
    padding: 0,
    // Official Claude Code docs define refreshInterval as seconds; minimum is 1.
    // Live swarm visibility depends on this row updating promptly while agents
    // start, finish, or fail.
    refreshInterval: 1,
  };
}

function readExistingStatusLine(source: string): unknown {
  const root = parse(source, [], { allowTrailingComma: true }) as unknown;
  if (root === null || typeof root !== 'object') return undefined;
  return (root as Record<string, unknown>).statusLine;
}

function commandFromStatusLine(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const command = (value as Record<string, unknown>).command;
    if (typeof command === 'string' && command.trim() !== '') return command;
  }
  return undefined;
}

function isManagedStatuslineCommand(command: string, launcherPath: string | undefined): boolean {
  return !!launcherPath && command.includes(launcherPath);
}

export async function previousStatusLineCommandForLauncher(ctx: AdapterCtx): Promise<string | undefined> {
  const filePath = filePathFor(ctx);
  const stateId = entryId({
    agent: 'claude-code',
    kind: 'statusline',
    scope: ctx.scope,
    targetPath: filePath,
    jsonPath: JSON_PATH_LABEL,
  });
  const state = await readState(ctx.statePath);
  const record = state.entries[stateId];
  const fromRecord = commandFromStatusLine(record?.previousValue);
  if (fromRecord && !isManagedStatuslineCommand(fromRecord, ctx.statuslineLauncherPath)) {
    return fromRecord;
  }

  const existingText = await readTextIfExists(filePath);
  if (existingText === null || parseErrors(existingText).length > 0) return undefined;
  const fromSettings = commandFromStatusLine(readExistingStatusLine(existingText));
  if (!fromSettings || isManagedStatuslineCommand(fromSettings, ctx.statuslineLauncherPath)) {
    return undefined;
  }
  return fromSettings;
}

function parseErrors(source: string): ParseError[] {
  const errors: ParseError[] = [];
  parse(source, errors, { allowTrailingComma: true });
  return errors;
}

/**
 * When installing at user scope, warn if a project-scope settings file
 * (settings.local.json wins over settings.json) has its own `statusLine`,
 * because Claude Code's project scope shadows user scope for that project.
 *
 * Returns `undefined` when no override is present, a "malformed" message when
 * the project file fails to parse, or an "override" message when a competing
 * statusLine is found.
 */
async function activeProjectOverrideWarning(ctx: AdapterCtx): Promise<string | undefined> {
  if (ctx.scope !== 'user') return undefined;
  const candidates = [
    join(ctx.projectRoot, '.claude', 'settings.local.json'),
    join(ctx.projectRoot, '.claude', 'settings.json'),
  ];
  for (const candidate of candidates) {
    const text = await readTextIfExists(candidate);
    if (text === null) continue;
    const errors = parseErrors(text);
    if (errors.length > 0) {
      return `Note: ${candidate} is malformed; Claude Code may not apply user statusLine in this project.`;
    }
    const value = readExistingStatusLine(text);
    if (value !== undefined) {
      return `Note: ${candidate} contains statusLine and will override user settings for this project.`;
    }
  }
  return undefined;
}

async function planOrApply(ctx: AdapterCtx, dryRun: boolean): Promise<AdapterResult> {
  const filePath = filePathFor(ctx);
  const value = buildValue(ctx);
  const stateId = entryId({
    agent: 'claude-code',
    kind: 'statusline',
    scope: ctx.scope,
    targetPath: filePath,
    jsonPath: JSON_PATH_LABEL,
  });

  const state = await readState(ctx.statePath);
  const existingText = await readTextIfExists(filePath);
  const existingBefore = existingText === null ? undefined : readExistingStatusLine(existingText);
  const previousManaged = state.entries[stateId];
  const overrideWarning = await activeProjectOverrideWarning(ctx);

  const result = await upsertJsonPath({
    filePath,
    ownership: 'agent',
    jsonPath: JSON_PATH,
    value,
    dryRun,
    createIfMissing: ctx.createConfig,
    forceAdopt: ctx.forceAdopt,
    isManaged: async (existing) => {
      const record = state.entries[stateId];
      return !!record && record.checksum === checksumEntry(existing);
    },
  });

  if (overrideWarning) {
    result.message = result.message
      ? `${result.message} ${overrideWarning}`
      : overrideWarning;
  }

  if (!dryRun && result.outcome === 'applied') {
    // Re-read state in case a concurrent writer mutated it between the initial
    // read and the upsert. Last-writer-wins is acceptable for ownership
    // records (the entry is keyed by stateId and idempotent).
    const next = await readState(ctx.statePath);
    // previousValue rotation rule:
    //   1. If we previously owned this entry (re-apply), keep whatever we
    //      saved the FIRST time we took ownership — never overwrite with our
    //      own freshly-managed value.
    //   2. Otherwise, capture the user's prior statusLine if it differs from
    //      the value we're about to install.
    //   3. If neither applies (no prior entry, or prior entry is byte-equal),
    //      leave previousValue undefined so uninstall removes cleanly.
    const previousValue =
      previousManaged?.previousValue !== undefined
        ? previousManaged.previousValue
        : existingBefore !== undefined && checksumEntry(existingBefore) !== checksumEntry(value)
          ? existingBefore
          : undefined;

    next.entries[stateId] = {
      agent: 'claude-code',
      kind: 'statusline',
      scope: ctx.scope,
      targetPath: filePath,
      jsonPath: JSON_PATH_LABEL,
      checksum: checksumEntry(value),
      launcherPath: ctx.statuslineLauncherPath ?? '',
      installedAt: new Date().toISOString(),
      version: 1,
      previousValue,
      previousChecksum: previousValue === undefined ? undefined : checksumEntry(previousValue),
    };
    await writeState(ctx.statePath, next);
  }

  return result;
}

async function uninstall(ctx: AdapterCtx): Promise<AdapterResult> {
  const filePath = filePathFor(ctx);
  const source = await readTextIfExists(filePath);
  if (source === null) {
    return {
      outcome: 'already-registered',
      filePath,
      changed: false,
      message: 'Claude settings file absent; nothing to remove.',
    };
  }

  const errors = parseErrors(source);
  if (errors.length > 0) {
    return {
      outcome: 'invalid-config',
      filePath,
      changed: false,
      message: `Refusing to repair malformed ${filePath}.`,
    };
  }

  const existing = readExistingStatusLine(source);
  if (existing === undefined) {
    return {
      outcome: 'already-registered',
      filePath,
      changed: false,
      message: 'No statusLine entry present.',
    };
  }

  const stateId = entryId({
    agent: 'claude-code',
    kind: 'statusline',
    scope: ctx.scope,
    targetPath: filePath,
    jsonPath: JSON_PATH_LABEL,
  });
  const state = await readState(ctx.statePath);
  const record = state.entries[stateId];

  // Ownership gate: refuse to touch a statusLine we never installed unless the
  // caller explicitly opted in with --force-adopt. Mirrors upsertJsonPath's
  // adoption semantics.
  if ((!record || record.checksum !== checksumEntry(existing)) && !ctx.forceAdopt) {
    return {
      outcome: 'conflict:manual-entry',
      filePath,
      changed: false,
      message: 'Refusing to remove unmanaged Claude Code statusLine. Use --force-adopt if intentional.',
    };
  }

  // Restore plan: if we recorded a previousValue and its stored
  // previousChecksum verifies, we'll splice it back in; otherwise we delete.
  const replacement = record?.previousValue === undefined ? undefined : record.previousValue;
  if (
    replacement !== undefined &&
    record?.previousChecksum &&
    checksumEntry(replacement) !== record.previousChecksum
  ) {
    return {
      outcome: 'failed',
      filePath,
      changed: false,
      message: `Refusing to restore statusLine: stored previousValue checksum does not match previousChecksum. Recover manually from ${filePath}.hive-flow.bak* if needed.`,
    };
  }

  const edits = modify(source, JSON_PATH, replacement, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
  });
  const after = applyEdits(source, edits);

  if (ctx.dryRun) {
    return {
      outcome: 'planned',
      filePath,
      changed: true,
      message: replacement === undefined ? 'Would remove statusLine.' : 'Would restore previous statusLine.',
    };
  }

  const backupPath = await copyBackupOnce(filePath);
  await atomicWrite(filePath, after, { mode: 0o600, fsync: true });
  const next = await readState(ctx.statePath);
  delete next.entries[stateId];
  await writeState(ctx.statePath, next);
  return {
    outcome: 'applied',
    filePath,
    changed: true,
    backupPath,
    message: replacement === undefined ? 'Removed Hive Flow statusLine.' : 'Restored previous statusLine.',
  };
}

async function verify(ctx: AdapterCtx): Promise<{ ok: boolean; output: string }> {
  const filePath = filePathFor(ctx);
  const text = await readTextIfExists(filePath);
  if (text === null) return { ok: false, output: `${filePath} missing` };

  if (!ctx.statuslineLauncherPath) {
    return { ok: false, output: 'No statusline launcher path in context.' };
  }

  let configured = false;
  try {
    const value = readExistingStatusLine(text) as
      | { type?: unknown; command?: unknown }
      | undefined;
    configured =
      !!value &&
      value.type === 'command' &&
      typeof value.command === 'string' &&
      value.command.includes(ctx.statuslineLauncherPath);
  } catch {
    return { ok: false, output: 'Unable to parse statusLine.' };
  }

  if (!configured) {
    return { ok: false, output: 'Claude Code statusLine does not point at Hive Flow launcher.' };
  }

  const sample = JSON.stringify({
    cwd: ctx.projectRoot,
    workspace: { current_dir: ctx.projectRoot, project_dir: ctx.projectRoot },
    model: { id: 'claude-opus-4-8[1m]', display_name: 'Opus 4.8' },
    context_window: {
      used_percentage: 12,
      total_input_tokens: 1000,
      total_output_tokens: 20,
      context_window_size: 1_000_000,
    },
  });
  const r = spawnSync(ctx.statuslineLauncherPath, [], {
    cwd: ctx.projectRoot,
    input: sample,
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (r.error) {
    return { ok: false, output: `Failed to execute statusline launcher: ${(r.error as Error).message}` };
  }
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(0, 2000);
  const overrideWarning = await activeProjectOverrideWarning(ctx);
  return {
    ok: r.status === 0 && /▊/.test(output),
    output: overrideWarning ? `${output}\n${overrideWarning}` : output,
  };
}

export const claudeCodeStatuslineAdapter: IntegrationAdapter = {
  id: 'claude-code-statusline',
  plan: (ctx) => planOrApply(ctx, true),
  apply: (ctx) => planOrApply(ctx, ctx.dryRun),
  verify,
  uninstall,
};
