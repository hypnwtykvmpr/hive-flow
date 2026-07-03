// cli/src/integrations/adapters/shell-prompt.ts
/**
 * Shell-prompt suppression adapter (canonical, hand-written like
 * claude-code-statusline.ts).
 *
 * Purpose: inside a Claude Code session, collapse the host shell's own prompt
 * (e.g. a powerline/oh-my-zsh theme's `┌──(user@host)─[cwd]` / `└─ <model>`
 * block) to a minimal stub so the Hive Flow statusboard — installed as the
 * Claude Code `statusLine` by the sibling claude-code-statusline adapter — is
 * the single source of status. Normal (non-Claude-Code) terminals are left
 * completely untouched.
 *
 * SUPPRESS, not REPLACE: the adapter only APPENDS a managed, env-gated override
 * block to the end of the shell startup file. It never edits the user's own
 * PROMPT/PS1 lines, so uninstall (stripping the block) restores the prior
 * prompt byte-for-byte without needing to store a copy of the rc.
 *
 * Reversibility: the block is delimited by managed markers, backed up once via
 * `copyBackupOnce` before the first write, recorded in the shared integration
 * `state.json` (kind `'shell-prompt'`), idempotent on re-apply, and ownership-
 * gated on uninstall (refuses to remove a tampered block without --force-adopt).
 *
 * Dispatched per-feature from `commands/setup.ts` as part of the `statusline`
 * feature; NOT wired into the connector `ADAPTER_TARGETS` union (a prompt
 * suppression is not a CLI connector).
 */
import { copyBackupOnce, atomicWrite, readTextIfExists } from '../atomic-merge.js';
import { checksumEntry, entryId, readState, writeState } from '../state.js';
import type { AdapterCtx, AdapterResult, IntegrationAdapter } from '../adapter.js';

const BLOCK_START = '# >>> hive-flow prompt (managed) >>>';
const BLOCK_END = '# <<< hive-flow prompt (managed) <<<';
const JSON_PATH_LABEL = 'shell-prompt';

/**
 * The managed region, terminated by its own trailing newline. Gated on
 * `CLAUDECODE` (exported by Claude Code sessions) so it is inert in every other
 * shell. Handles both zsh (`PROMPT`/`RPROMPT`) and bash/POSIX (`PS1`). Appended
 * AFTER the user's theme so this override wins.
 */
function managedRegion(): string {
  return [
    BLOCK_START,
    '# Suppresses the redundant host shell prompt inside Claude Code sessions so',
    '# the Hive Flow statusboard is the single source of status. Managed file —',
    '# remove with: hive-flow setup --uninstall --features statusline',
    'if [ -n "$CLAUDECODE" ]; then',
    "  PS1='$ '",
    '  if [ -n "$ZSH_VERSION" ]; then',
    "    PROMPT='%# '",
    "    RPROMPT=''",
    '  fi',
    'fi',
    BLOCK_END,
    '',
  ].join('\n');
}

function profilePathFor(ctx: AdapterCtx): string {
  if (!ctx.shellProfilePath) {
    throw new Error('shellProfilePath missing from AdapterCtx');
  }
  return ctx.shellProfilePath;
}

function stateIdFor(filePath: string, ctx: AdapterCtx): string {
  return entryId({
    agent: 'claude-code',
    kind: 'shell-prompt',
    scope: ctx.scope,
    targetPath: filePath,
    jsonPath: JSON_PATH_LABEL,
  });
}

interface BlockLocation {
  /** Byte index of the managed region START. */
  regionStart: number;
  /** Byte index just past the END marker's trailing newline. */
  regionEnd: number;
  /** Exact text of the managed region (START..END\n), for checksum/compare. */
  block: string;
}

/**
 * Locate EVERY managed block in `source`, left-to-right and non-overlapping.
 * A well-behaved install holds exactly one; we detect duplicates (e.g. from a
 * hand-edited rc or a botched prior install) so `apply`/`verify`/`uninstall`
 * can normalize/reject/remove them all rather than silently leaving extras.
 */
function locateAllBlocks(source: string): BlockLocation[] {
  const blocks: BlockLocation[] = [];
  let from = 0;
  for (;;) {
    const startIdx = source.indexOf(BLOCK_START, from);
    if (startIdx === -1) break;
    const endMarkerIdx = source.indexOf(BLOCK_END, startIdx);
    if (endMarkerIdx === -1) break;
    // regionEnd: include the END marker line and its trailing newline if present.
    let regionEnd = endMarkerIdx + BLOCK_END.length;
    if (source[regionEnd] === '\n') regionEnd += 1;
    blocks.push({ regionStart: startIdx, regionEnd, block: source.slice(startIdx, regionEnd) });
    from = regionEnd;
  }
  return blocks;
}

/**
 * Compute the rc text with the managed block present exactly once at the end.
 * Invertible by `withoutAllBlocks`: a non-empty base gets exactly one separator
 * newline before the block; an empty base gets none.
 */
function withBlock(base: string): string {
  const region = managedRegion();
  if (base === '') return region;
  return `${base}\n${region}`;
}

/**
 * Strip EVERY managed block from `source`, byte-exactly. For each block we also
 * remove a single immediately-preceding '\n' — but ONLY when that newline is
 * not itself inside another managed region (i.e. it is the separator we own
 * between non-managed content and a block, never a prior block's own trailing
 * newline). Removing right-to-left keeps earlier indices valid. The result for
 * a canonically-installed rc is byte-identical to the pre-install text.
 */
function withoutAllBlocks(source: string): string {
  const blocks = locateAllBlocks(source);
  if (blocks.length === 0) return source;
  const insideRegion = (idx: number): boolean =>
    blocks.some((b) => idx >= b.regionStart && idx < b.regionEnd);
  const ranges = blocks.map((b) => {
    const sepOwned = b.regionStart > 0 && source[b.regionStart - 1] === '\n' && !insideRegion(b.regionStart - 1);
    return { start: sepOwned ? b.regionStart - 1 : b.regionStart, end: b.regionEnd };
  });
  ranges.sort((a, z) => z.start - a.start);
  let out = source;
  for (const { start, end } of ranges) {
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

async function planOrApply(ctx: AdapterCtx, dryRun: boolean): Promise<AdapterResult> {
  const filePath = profilePathFor(ctx);
  const stateId = stateIdFor(filePath, ctx);
  const region = managedRegion();
  const regionChecksum = checksumEntry(region);

  const existingText = await readTextIfExists(filePath);
  const source = existingText ?? '';
  const blocks = locateAllBlocks(source);

  // Idempotent: EXACTLY ONE identical managed block already present → no-op.
  // Two-or-more blocks (even if each is identical) are not canonical and must
  // be collapsed, so they fall through to the rewrite path below.
  if (blocks.length === 1 && blocks[0].block === region) {
    return {
      outcome: 'already-registered',
      filePath,
      changed: false,
      message: 'Shell-prompt suppression already installed.',
    };
  }

  // Normalize: strip ALL existing managed blocks (older version, duplicates, or
  // user-tampered) and append exactly one canonical block. Re-applying our own
  // managed content is always safe — apply owns the managed region wholesale.
  const base = withoutAllBlocks(source);
  const next = withBlock(base);

  if (dryRun) {
    return {
      outcome: 'planned',
      filePath,
      changed: true,
      message: blocks.length > 0 ? 'Would normalize shell-prompt suppression block.' : 'Would install shell-prompt suppression block.',
    };
  }

  const backupPath = existingText === null ? undefined : await copyBackupOnce(filePath);
  await atomicWrite(filePath, next, { mode: 0o600, fsync: true });

  const stored = await readState(ctx.statePath);
  stored.entries[stateId] = {
    agent: 'claude-code',
    kind: 'shell-prompt',
    scope: ctx.scope,
    targetPath: filePath,
    jsonPath: JSON_PATH_LABEL,
    checksum: regionChecksum,
    launcherPath: '',
    installedAt: new Date().toISOString(),
    version: 1,
  };
  await writeState(ctx.statePath, stored);

  return {
    outcome: 'applied',
    filePath,
    changed: true,
    backupPath,
    message: blocks.length > 0 ? 'Normalized shell-prompt suppression block.' : 'Installed shell-prompt suppression block.',
  };
}

async function uninstall(ctx: AdapterCtx): Promise<AdapterResult> {
  const filePath = profilePathFor(ctx);
  const source = await readTextIfExists(filePath);
  if (source === null) {
    return {
      outcome: 'already-registered',
      filePath,
      changed: false,
      message: 'Shell startup file absent; nothing to remove.',
    };
  }

  const blocks = locateAllBlocks(source);
  if (blocks.length === 0) {
    return {
      outcome: 'already-registered',
      filePath,
      changed: false,
      message: 'No shell-prompt suppression block present.',
    };
  }

  const stateId = stateIdFor(filePath, ctx);
  const state = await readState(ctx.statePath);
  const record = state.entries[stateId];

  // Ownership gate: refuse to strip if ANY retained managed block does not match
  // the recorded expected region (tampered/foreign content), unless the caller
  // explicitly opts in. Exact duplicates of our region all match and are removed.
  const tampered = !record || blocks.some((b) => checksumEntry(b.block) !== record.checksum);
  if (tampered && !ctx.forceAdopt) {
    return {
      outcome: 'conflict:manual-entry',
      filePath,
      changed: false,
      message: 'Refusing to remove a modified shell-prompt block. Use --force-adopt if intentional.',
    };
  }

  const restored = withoutAllBlocks(source);

  if (ctx.dryRun) {
    return {
      outcome: 'planned',
      filePath,
      changed: true,
      message: 'Would remove shell-prompt suppression block and restore prior prompt.',
    };
  }

  const backupPath = await copyBackupOnce(filePath);
  await atomicWrite(filePath, restored, { mode: 0o600, fsync: true });
  const next = await readState(ctx.statePath);
  delete next.entries[stateId];
  await writeState(ctx.statePath, next);

  return {
    outcome: 'applied',
    filePath,
    changed: true,
    backupPath,
    message: 'Removed shell-prompt suppression; restored prior prompt.',
  };
}

async function verify(ctx: AdapterCtx): Promise<{ ok: boolean; output: string }> {
  const filePath = profilePathFor(ctx);
  const text = await readTextIfExists(filePath);
  if (text === null) return { ok: false, output: `${filePath} missing` };
  const blocks = locateAllBlocks(text);
  if (blocks.length === 0) {
    return { ok: false, output: 'Shell-prompt suppression block not present.' };
  }
  if (blocks.length > 1) {
    return { ok: false, output: `Expected exactly one managed shell-prompt block; found ${blocks.length}.` };
  }
  if (blocks[0].block !== managedRegion()) {
    return { ok: false, output: 'Shell-prompt block present but does not match the expected managed region (tampered or stale).' };
  }
  if (!blocks[0].block.includes('$CLAUDECODE')) {
    return { ok: false, output: 'Shell-prompt block present but not gated on CLAUDECODE.' };
  }
  return { ok: true, output: `Shell-prompt suppression installed in ${filePath} (CLAUDECODE-gated).` };
}

export const shellPromptAdapter: IntegrationAdapter = {
  id: 'shell-prompt',
  plan: (ctx) => planOrApply(ctx, true),
  apply: (ctx) => planOrApply(ctx, ctx.dryRun),
  verify,
  uninstall,
};

// Exported for focused unit/property tests (pure region helpers).
export const __testing = { managedRegion, withBlock, withoutAllBlocks, locateAllBlocks, BLOCK_START, BLOCK_END };
