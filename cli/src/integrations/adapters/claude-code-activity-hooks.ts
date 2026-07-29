// cli/src/integrations/adapters/claude-code-activity-hooks.ts
/**
 * Claude Code activity-tracker hooks adapter (hive-flow-f16a).
 *
 * Installs the hook family that feeds the statusline activity cell
 * (Idle / Thinking / Working / Waiting / Needs you) into Claude Code's
 * `settings.json`.
 *
 * OWNERSHIP IS PER-ENTRY, NOT PER-OBJECT (binding review constraint). A managed
 * entry is exactly one whose `command` references our `claude-activity-hook`
 * launcher path. This adapter:
 *   - NEVER checksums, replaces, or restores the whole `hooks` object;
 *   - NEVER replaces a whole event array;
 *   - only ever adds, updates, or removes entries carrying our launcher path.
 * Unrelated hooks — whether they existed before installation or were added
 * afterwards — survive apply, reconcile, and uninstall untouched. Consequently
 * uninstall needs no `previousValue` snapshot: removal is surgical, so there is
 * nothing to restore.
 */
import { join } from 'node:path';
import { applyEdits, modify, parse, type JSONPath, type ParseError } from 'jsonc-parser';
import { atomicWrite, copyBackupOnce, readTextIfExists } from '../atomic-merge.js';
import { entryId, readState, writeState } from '../state.js';
import { commandForClaudeSettings, resolveActivityHookLauncherPath } from '../launcher.js';
import type { AdapterCtx, AdapterResult, IntegrationAdapter } from '../adapter.js';

const JSON_PATH_LABEL = 'hooks';

/**
 * Claude Code hook event -> tracker argument -> tool matcher.
 *
 * This is the portable tracker's verified event set, ported verbatim. Do NOT
 * add newer Claude hook events here without an empirical acceptance gap: this
 * is a faithful port, not an activity-system expansion.
 */
export const HOOK_WIRING: ReadonlyArray<readonly [string, string, string | null]> = [
  ['SessionStart', 'session-start', null],
  ['UserPromptSubmit', 'prompt', null],
  ['PreToolUse', 'pre-tool', '*'],
  ['PostToolUse', 'post-tool', '*'],
  // A tool that FAILS or is DENIED still ends its execution. Without these the
  // activity cell freezes on "Working · <tool>" until the state ages out.
  ['PostToolUseFailure', 'tool-failed', '*'],
  ['PermissionDenied', 'permission-denied', '*'],
  // The authoritative "a human is required" signal. Notification stays a
  // separately filtered secondary channel.
  ['PermissionRequest', 'permission-request', '*'],
  // Exactly paired, and carrying agent_id — this is what makes the live-agent
  // set work at all.
  ['SubagentStart', 'subagent-start', null],
  ['SubagentStop', 'subagent-stop', null],
  ['Stop', 'stop', null],
  // An aborted turn fires StopFailure, not Stop.
  ['StopFailure', 'stop-failed', null],
  // The tracker filters by notification_type; most do NOT mean a human is needed.
  ['Notification', 'notify', null],
  ['SessionEnd', 'session-end', null],
];

/** Claude Code defines hook timeouts in seconds. */
const HOOK_TIMEOUT_SECONDS = 3;

interface HookEntry {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
}
interface HookGroup {
  matcher?: unknown;
  hooks?: unknown;
}

function filePathFor(ctx: AdapterCtx): string {
  if (ctx.scope === 'user' && ctx.userSettingsPath) return ctx.userSettingsPath;
  return ctx.scope === 'user'
    ? join(ctx.homeDir, '.claude', 'settings.json')
    : join(ctx.projectRoot, '.claude', 'settings.json');
}

function hookLauncherPathFor(ctx: AdapterCtx): string {
  return resolveActivityHookLauncherPath(ctx.scope, ctx.homeDir, ctx.projectRoot);
}

function parseErrors(source: string): ParseError[] {
  const errors: ParseError[] = [];
  parse(source, errors, { allowTrailingComma: true });
  return errors;
}

function readRoot(source: string): Record<string, unknown> | undefined {
  const root = parse(source, [], { allowTrailingComma: true }) as unknown;
  if (!root || typeof root !== 'object' || Array.isArray(root)) return undefined;
  return root as Record<string, unknown>;
}

function readEventGroups(root: Record<string, unknown> | undefined, event: string): HookGroup[] {
  const hooks = root?.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
  const groups = (hooks as Record<string, unknown>)[event];
  return Array.isArray(groups) ? (groups as HookGroup[]) : [];
}

/** True when this entry is one of OURS (identified solely by launcher path). */
function isManagedEntry(entry: unknown, launcherPath: string): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const command = (entry as HookEntry).command;
  return typeof command === 'string' && command.includes(launcherPath);
}

/**
 * Compute the replacement array for one event: strip only OUR entries, drop
 * groups we thereby emptied, and (when installing) append exactly one fresh
 * group. Every unrelated group and entry is carried through by reference.
 */
function nextEventGroups(
  existing: HookGroup[],
  launcherPath: string,
  wiring: readonly [string, string, string | null],
  mode: 'install' | 'remove',
): HookGroup[] {
  const [, arg, matcher] = wiring;
  const out: HookGroup[] = [];
  for (const group of existing) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      out.push(group); // untouched: not a shape we own
      continue;
    }
    if (!Array.isArray(group.hooks)) {
      out.push(group); // untouched: unrelated shape
      continue;
    }
    const kept = (group.hooks as unknown[]).filter((entry) => !isManagedEntry(entry, launcherPath));
    if (kept.length === (group.hooks as unknown[]).length) {
      out.push(group); // no entry of ours here — carry through untouched
      continue;
    }
    // We removed at least one of our entries from this group. Keep the group
    // (with its remaining unrelated entries) unless it is now empty.
    if (kept.length > 0) out.push({ ...group, hooks: kept });
  }

  if (mode === 'remove') return out;

  const command = `${commandForClaudeSettings(launcherPath)} ${arg}`;
  const entry: HookEntry = { type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS };
  out.push(matcher !== null ? { matcher, hooks: [entry] } : { hooks: [entry] });
  return out;
}

interface HookPlan {
  readonly edits: Array<{ path: JSONPath; value: unknown }>;
  readonly managedCount: number;
}

function buildPlan(
  root: Record<string, unknown> | undefined,
  launcherPath: string,
  mode: 'install' | 'remove',
): HookPlan {
  const edits: Array<{ path: JSONPath; value: unknown }> = [];
  let managedCount = 0;
  for (const wiring of HOOK_WIRING) {
    const [event] = wiring;
    const existing = readEventGroups(root, event);
    const next = nextEventGroups(existing, launcherPath, wiring, mode);
    if (mode === 'install') managedCount++;

    // Removing the last entry from an event we solely populated deletes the key
    // rather than leaving an empty array behind.
    const value = mode === 'remove' && next.length === 0 ? undefined : next;
    if (JSON.stringify(value ?? null) === JSON.stringify(existing.length ? existing : null)) {
      continue; // already in the desired shape — emit no edit (idempotency)
    }
    if (value === undefined && existing.length === 0) continue;
    edits.push({ path: ['hooks', event], value });
  }
  return { edits, managedCount };
}

function applyPlan(source: string, plan: HookPlan): string {
  let out = source;
  for (const edit of plan.edits) {
    out = applyEdits(
      out,
      modify(out, edit.path, edit.value, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
      }),
    );
  }
  return out;
}

async function planOrApply(ctx: AdapterCtx, dryRun: boolean): Promise<AdapterResult> {
  const filePath = filePathFor(ctx);
  const launcherPath = hookLauncherPathFor(ctx);
  const source = await readTextIfExists(filePath);

  if (source === null) {
    if (!ctx.createConfig) {
      return {
        outcome: 'invalid-config',
        filePath,
        changed: false,
        message: 'Claude settings file absent; re-run with config creation enabled.',
      };
    }
    const created = applyPlan('{}\n', buildPlan(undefined, launcherPath, 'install'));
    if (dryRun) {
      return { outcome: 'planned', filePath, changed: true, message: 'Would create settings with activity hooks.' };
    }
    await atomicWrite(filePath, created, { mode: 0o600, fsync: true });
    await recordState(ctx, filePath, launcherPath);
    return { outcome: 'applied', filePath, changed: true, message: 'Installed Claude activity hooks.' };
  }

  if (parseErrors(source).length > 0) {
    return {
      outcome: 'invalid-config',
      filePath,
      changed: false,
      message: `Refusing to modify malformed ${filePath}.`,
    };
  }

  const root = readRoot(source);
  const plan = buildPlan(root, launcherPath, 'install');
  if (plan.edits.length === 0) {
    return {
      outcome: 'already-registered',
      filePath,
      changed: false,
      message: `Claude activity hooks already installed (${plan.managedCount} events).`,
    };
  }

  const next = applyPlan(source, plan);
  // Never emit a document we cannot re-parse.
  if (parseErrors(next).length > 0) {
    return { outcome: 'failed', filePath, changed: false, message: 'Refusing to write unparseable settings.' };
  }

  if (dryRun) {
    return {
      outcome: 'planned',
      filePath,
      changed: true,
      message: `Would install Claude activity hooks (${plan.edits.length} events).`,
    };
  }

  const backupPath = await copyBackupOnce(filePath);
  await atomicWrite(filePath, next, { mode: 0o600, fsync: true });
  await recordState(ctx, filePath, launcherPath);
  return {
    outcome: 'applied',
    filePath,
    changed: true,
    backupPath,
    message: `Installed Claude activity hooks (${plan.edits.length} events).`,
  };
}

async function recordState(ctx: AdapterCtx, filePath: string, launcherPath: string): Promise<void> {
  const stateId = entryId({
    agent: 'claude-code',
    kind: 'statusline',
    scope: ctx.scope,
    targetPath: filePath,
    jsonPath: JSON_PATH_LABEL,
  });
  const next = await readState(ctx.statePath);
  // Bookkeeping only. Uninstall identifies our entries by launcher path in the
  // live file, so no previousValue snapshot of the hooks object is kept.
  next.entries[stateId] = {
    agent: 'claude-code',
    kind: 'statusline',
    scope: ctx.scope,
    targetPath: filePath,
    jsonPath: JSON_PATH_LABEL,
    checksum: '',
    launcherPath,
    installedAt: new Date().toISOString(),
    version: 1,
  };
  await writeState(ctx.statePath, next);
}

async function uninstall(ctx: AdapterCtx): Promise<AdapterResult> {
  const filePath = filePathFor(ctx);
  const launcherPath = hookLauncherPathFor(ctx);
  const source = await readTextIfExists(filePath);
  if (source === null) {
    return { outcome: 'already-registered', filePath, changed: false, message: 'Claude settings file absent.' };
  }
  if (parseErrors(source).length > 0) {
    return { outcome: 'invalid-config', filePath, changed: false, message: `Refusing to repair malformed ${filePath}.` };
  }

  const plan = buildPlan(readRoot(source), launcherPath, 'remove');
  if (plan.edits.length === 0) {
    return { outcome: 'already-registered', filePath, changed: false, message: 'No Hive Flow activity hooks present.' };
  }

  const next = applyPlan(source, plan);
  if (parseErrors(next).length > 0) {
    return { outcome: 'failed', filePath, changed: false, message: 'Refusing to write unparseable settings.' };
  }
  if (ctx.dryRun) {
    return { outcome: 'planned', filePath, changed: true, message: 'Would remove Claude activity hooks.' };
  }

  const backupPath = await copyBackupOnce(filePath);
  await atomicWrite(filePath, next, { mode: 0o600, fsync: true });
  const stateId = entryId({
    agent: 'claude-code',
    kind: 'statusline',
    scope: ctx.scope,
    targetPath: filePath,
    jsonPath: JSON_PATH_LABEL,
  });
  const state = await readState(ctx.statePath);
  delete state.entries[stateId];
  await writeState(ctx.statePath, state);
  return {
    outcome: 'applied',
    filePath,
    changed: true,
    backupPath,
    message: 'Removed Hive Flow activity hooks (unrelated hooks preserved).',
  };
}

async function verify(ctx: AdapterCtx): Promise<{ ok: boolean; output: string }> {
  const filePath = filePathFor(ctx);
  const launcherPath = hookLauncherPathFor(ctx);
  const source = await readTextIfExists(filePath);
  if (source === null) return { ok: false, output: `${filePath} missing` };
  if (parseErrors(source).length > 0) return { ok: false, output: 'Unable to parse settings.' };

  const root = readRoot(source);
  const missing: string[] = [];
  let installed = 0;
  for (const [event] of HOOK_WIRING) {
    const found = readEventGroups(root, event).some(
      (group) =>
        Array.isArray(group?.hooks) &&
        (group.hooks as unknown[]).some((entry) => isManagedEntry(entry, launcherPath)),
    );
    if (found) installed++;
    else missing.push(event);
  }
  return {
    ok: missing.length === 0,
    output:
      missing.length === 0
        ? `Claude activity hooks present for all ${installed} events.`
        : `Missing activity hooks for: ${missing.join(', ')}`,
  };
}

export const claudeCodeActivityHooksAdapter: IntegrationAdapter = {
  id: 'claude-code-activity-hooks',
  plan: (ctx) => planOrApply(ctx, true),
  apply: (ctx) => planOrApply(ctx, ctx.dryRun),
  verify,
  uninstall,
};
