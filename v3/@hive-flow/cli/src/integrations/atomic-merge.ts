// v3/@hive-flow/cli/src/integrations/atomic-merge.ts
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile, copyFile, open, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { applyEdits, modify, parse, type JSONPath, type ParseError } from 'jsonc-parser';

// ParseErrorCode is a const enum in jsonc-parser; use numeric literals to avoid
// isolatedModules incompatibility. InvalidCommentToken = 10 (tolerated in .jsonc files).
const JSONC_INVALID_COMMENT_TOKEN = 10;
import { createHash } from 'node:crypto';

export type EditOutcome =
  | 'applied' | 'already-registered' | 'missing-config' | 'invalid-config'
  | 'conflict:manual-entry' | 'conflict:duplicate' | 'busy:locked'
  | 'planned' | 'failed';

export interface EditResult {
  outcome: EditOutcome;
  filePath: string;
  changed: boolean;
  beforeChecksum?: string;
  afterChecksum?: string;
  backupPath?: string;
  message: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function readTextIfExists(p: string): Promise<string | null> {
  try { return await readFile(p, 'utf8'); } catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
}

export async function copyBackupOnce(filePath: string): Promise<string | undefined> {
  // Numeric rotation so multi-modification rollback is possible.
  for (let i = 0; i < 100; i++) {
    const bak = `${filePath}.hive-flow.bak${i === 0 ? '' : `.${i}`}`;
    try {
      // COPYFILE_EXCL: errors if dest exists; race-safe between concurrent writers.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const constants = (await import('node:fs')).constants;
      await copyFile(filePath, bak, constants.COPYFILE_EXCL);
      return bak;
    } catch (e: any) {
      if (e.code === 'EEXIST') continue;  // try next slot
      throw e;
    }
  }
  throw new Error(`Refusing to write ${filePath}: backup rotation exhausted (100 .bak slots used).`);
}

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  // Preserve existing file mode (e.g., 0600 secrets); default to 0644 if file doesn't exist.
  let mode: number | undefined;
  try {
    const { stat: fsStat } = await import('node:fs/promises');
    const s = await fsStat(filePath);
    mode = s.mode & 0o777;
  } catch { /* file may not exist yet */ }
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, { encoding: 'utf8', mode: mode ?? 0o644 });
  try {
    await rename(tmp, filePath);
  } catch (e: any) {
    if (e.code === 'EXDEV') {
      // Cross-device rename. Fallback to copy+unlink.
      await copyFile(tmp, filePath);
      const fsp = await import('node:fs/promises');
      await fsp.unlink(tmp).catch(() => {});
      return;
    }
    throw e;
  }
}

export interface JsonEditOptions {
  filePath: string;
  ownership: 'hive-flow' | 'agent';
  jsonPath: JSONPath;
  value: unknown;
  dryRun: boolean;
  /** When true, create the agent config with a minimal `{}` body if absent.
   *  Default false → return `missing-config`. Maps to `hive-flow setup --create-config`. */
  createIfMissing: boolean;
  /** If true, refuse to take action when an existing entry is not in the ownership state. */
  isManaged: (existingValue: unknown) => Promise<boolean>;
  forceAdopt: boolean;
}

export async function upsertJsonPath(opts: JsonEditOptions): Promise<EditResult> {
  // Rule 1: ownership-aware creation
  const fileText = await readTextIfExists(opts.filePath);
  if (fileText === null) {
    if (opts.ownership === 'agent' && !opts.createIfMissing) {
      return { outcome: 'missing-config', filePath: opts.filePath, changed: false, message: `Config file does not exist: ${opts.filePath}. Use --create-config to opt in.` };
    }
    // Either Hive Flow-owned path (allowed to create) or --create-config supplied: proceed with minimal seed.
  }

  const source = fileText ?? '{}\n';

  // Rule 4: detect malformed JSON properly.
  // Bug-fix vs Codex runbook: `parseTree() === undefined` only catches EMPTY input. For malformed
  // JSON, parseTree returns a tree with errors populated. The CORRECT check is `parse(...) errors length`.
  const errors: ParseError[] = [];
  parse(source, errors, { allowTrailingComma: true });
  // Filter out errors we tolerate (InvalidCommentToken=10 occurs in strict JSON; tolerable for .jsonc)
  const blocking = errors.filter(e => e.error !== JSONC_INVALID_COMMENT_TOKEN);
  if (blocking.length > 0) {
    return { outcome: 'invalid-config', filePath: opts.filePath, changed: false, message: `Refusing to repair malformed ${opts.filePath}: parse errors at offsets ${blocking.map(e => e.offset).join(', ')}.` };
  }

  // Check ownership before modifying an existing entry
  const existingNode = parse(source, [], { allowTrailingComma: true });
  const existingValue = walkValue(existingNode, opts.jsonPath);
  if (existingValue !== undefined && !opts.forceAdopt) {
    const managed = await opts.isManaged(existingValue);
    if (!managed && !deepEqual(existingValue, opts.value)) {
      return { outcome: 'conflict:manual-entry', filePath: opts.filePath, changed: false, message: `Existing entry at ${opts.jsonPath.join('.')} is not owned by Hive Flow. Use --force-adopt to take ownership.` };
    }
  }

  // Apply targeted edit (preserves surrounding formatting, comments, ordering)
  const edits = modify(source, opts.jsonPath, opts.value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
    isArrayInsertion: false,
  });
  const after = applyEdits(source, edits);
  const beforeChecksum = sha(source);
  const afterChecksum = sha(after);

  // Rule 2: skip if byte-equal
  if (beforeChecksum === afterChecksum) {
    return { outcome: 'already-registered', filePath: opts.filePath, changed: false, beforeChecksum, afterChecksum, message: `No change needed.` };
  }

  if (opts.dryRun) {
    return { outcome: 'planned', filePath: opts.filePath, changed: true, beforeChecksum, afterChecksum, message: `Would update ${opts.jsonPath.join('.')} in ${opts.filePath}.` };
  }

  // Resolve symlinks so writes update the target file (and backup lands next to it),
  // not the symlink path itself. Falls back to the original path when realpath fails
  // (dangling symlink, transient I/O, etc.).
  let resolvedFilePath = opts.filePath;
  if (fileText !== null) {
    try {
      resolvedFilePath = await realpath(opts.filePath);
    } catch {
      // keep opts.filePath as-is
    }
  }

  // Rule 6: backup + atomic write. Wrap in try/catch so callers receive
  // outcome:'failed' on EACCES, ENOSPC, etc. instead of a raw throw. The
  // atomic temp+rename guarantees the target file is unchanged on write failure.
  let backupPath: string | undefined;
  try {
    if (fileText !== null) backupPath = await copyBackupOnce(resolvedFilePath);
    await atomicWrite(resolvedFilePath, after);
  } catch (e: any) {
    return {
      outcome: 'failed',
      filePath: opts.filePath,
      changed: false,
      beforeChecksum,
      afterChecksum,
      backupPath,
      message: `Write failed: ${e.code ?? 'error'}: ${e.message ?? String(e)}`,
    };
  }
  return { outcome: 'applied', filePath: opts.filePath, changed: true, beforeChecksum, afterChecksum, backupPath, message: `Updated ${opts.jsonPath.join('.')}.` };
}

function walkValue(node: any, path: JSONPath): unknown {
  let cur: any = node;
  for (const p of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as any)[p as any];
  }
  return cur;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/** Canonical serialization: sorts object keys recursively so {a:1,b:2} === {b:2,a:1}. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(k =>
      JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}
