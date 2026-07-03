// cli/src/integrations/toml-block.ts
import { readTextIfExists, copyBackupOnce, atomicWrite } from './atomic-merge.js';
import { createHash } from 'node:crypto';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface TomlBlockOptions {
  filePath: string;
  tableName: string;        // e.g., 'mcp_servers.hive-flow'
  values: Record<string, unknown>;
  dryRun: boolean;
  ownership: 'agent' | 'hive-flow';
  /** When true, create the agent TOML config with empty body if absent. Maps to --create-config. */
  createIfMissing: boolean;
  /** Predicate: returns true if the existing block was previously written by Hive Flow.
   *  Symmetric with JSON's isManaged. Adapter compares against state.checksum. */
  isManaged: (existingTomlBlock: Record<string, unknown>) => Promise<boolean>;
  /** Take ownership of an unmanaged block (writes through anyway). Equivalent to JSON's forceAdopt. */
  forceAdopt: boolean;
}

function renderTomlValue(v: unknown): string {
  if (typeof v === 'string') {
    // Escape control chars properly for basic strings.
    return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (Array.isArray(v)) return `[${v.map(renderTomlValue).join(', ')}]`;
  if (v === null) throw new Error('TOML does not support null');
  throw new Error(`Unsupported TOML value: ${typeof v}`);
}

function renderBlock(tableName: string, values: Record<string, unknown>): string {
  const lines = [`[${tableName}]`];
  for (const [k, v] of Object.entries(values)) lines.push(`${k} = ${renderTomlValue(v)}`);
  return lines.join('\n') + '\n';
}

// Find [tableName] block. Treats [[arrayOfTables]] as a different construct (does NOT match).
function findBlockRange(source: string, tableName: string): { start: number; end: number } | null {
  const escName = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the table header at line start; reject [[name]] (array-of-table) headers
  const headerRe = new RegExp(`(?:^|\\n)\\s*\\[${escName}\\]\\s*(?:\\n|$)`);
  const headerMatch = source.match(headerRe);
  if (!headerMatch || headerMatch.index === undefined) return null;
  let startIdx = headerMatch.index === 0 ? 0 : headerMatch.index + 1; // skip leading \n
  // Advance to the '[' header character so the range starts at the block, not at a preceding blank line.
  while (startIdx < source.length && source[startIdx] !== '[') startIdx++;
  // End: next line that is "[" or "[[" at the start
  const restStart = startIdx + headerMatch[0].length;
  const restRe = /\n\s*\[\[?/;
  const restMatch = source.slice(restStart).match(restRe);
  const endIdx = restMatch && restMatch.index !== undefined ? restStart + restMatch.index + 1 : source.length;
  return { start: startIdx, end: endIdx };
}

function countHeaders(source: string, tableName: string): number {
  const escName = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\n)\\s*\\[${escName}\\]\\s*(?:\\n|$)`, 'g');
  return (source.match(re) ?? []).length;
}

export async function upsertTomlBlock(opts: TomlBlockOptions) {
  const before = await readTextIfExists(opts.filePath);
  if (before === null) {
    if (opts.ownership === 'agent' && !opts.createIfMissing) {
      return { outcome: 'missing-config' as const, filePath: opts.filePath, changed: false, message: `Config file does not exist: ${opts.filePath}. Use --create-config to opt in.` };
    }
  }
  const source = before ?? '';

  // Duplicate detection
  const headerCount = countHeaders(source, opts.tableName);
  if (headerCount > 1) {
    return { outcome: 'conflict:duplicate' as const, filePath: opts.filePath, changed: false, message: `Multiple [${opts.tableName}] blocks found in ${opts.filePath}. Resolve manually.` };
  }

  const block = renderBlock(opts.tableName, opts.values);
  const range = findBlockRange(source, opts.tableName);

  let after: string;
  if (range) {
    const current = source.slice(range.start, range.end).trim() + '\n';
    if (current === block) {
      const checksum = sha(source);
      return { outcome: 'already-registered' as const, filePath: opts.filePath, changed: false, beforeChecksum: checksum, afterChecksum: checksum, message: 'No change needed.' };
    }
    // Ownership policy parity with JSON: allow update when block is state-owned OR forceAdopt is set.
    const existingBlock = parseTomlBlockBody(source.slice(range.start, range.end));
    const managed = await opts.isManaged(existingBlock);
    if (!managed && !opts.forceAdopt) {
      return { outcome: 'conflict:manual-entry' as const, filePath: opts.filePath, changed: false, message: `Existing [${opts.tableName}] block exists and is not Hive Flow-owned. Use --force-adopt to take ownership.` };
    }
    after = source.slice(0, range.start) + block + source.slice(range.end);
  } else {
    const sep = source.length === 0 || source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
    after = source + sep + block;
  }

  const beforeChecksum = sha(source);
  const afterChecksum = sha(after);
  if (opts.dryRun) {
    return { outcome: 'planned' as const, filePath: opts.filePath, changed: true, beforeChecksum, afterChecksum, message: `Would update [${opts.tableName}].` };
  }

  let backupPath: string | undefined;
  if (before !== null) backupPath = await copyBackupOnce(opts.filePath);
  await atomicWrite(opts.filePath, after);
  return { outcome: 'applied' as const, filePath: opts.filePath, changed: true, beforeChecksum, afterChecksum, backupPath, message: `Updated [${opts.tableName}].` };
}

// -----------------------------------------------------------------------------
// parseTomlBlockBody — minimal scalar TOML parser for a single [table] block's body.
// Sufficient for our adapter use case: string / boolean / number / string-array values
// like `command = "..."`, `args = ["a","b"]`, `enabled = true`, `tool_timeout_sec = 60`.
// NOT a general TOML parser: does not handle inline tables, mixed-type arrays, datetimes,
// multi-line strings, or hex/oct/bin integer literals. Used only for ownership-checksum
// comparison and `removeTomlBlock` ownership verification.
// -----------------------------------------------------------------------------

export function parseTomlBlockBody(blockText: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = blockText.split('\n');
  // Skip the [header] line (first non-blank line that starts with `[`)
  let started = false;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!started) {
      if (trimmed.startsWith('[')) { started = true; continue; }
      continue;
    }
    if (trimmed.startsWith('[')) break;     // next table started; stop
    // Strip inline `# ...` comments (naive — does not handle `#` inside strings).
    const noComment = stripInlineComment(rawLine).trim();
    if (!noComment) continue;
    const eq = noComment.indexOf('=');
    if (eq < 0) continue;
    const key = noComment.slice(0, eq).trim();
    const valueText = noComment.slice(eq + 1).trim();
    result[key] = parseTomlScalar(valueText);
  }
  return result;
}

export function stripInlineComment(line: string): string {
  // Only strip `# ...` when not inside a "..." string. Single-pass scanner.
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== '\\') inString = !inString;
    if (ch === '#' && !inString) return line.slice(0, i);
  }
  return line;
}

export function parseTomlScalar(text: string): unknown {
  if (text.startsWith('"') && text.endsWith('"')) {
    // Single-pass scan: walk the inner string, decoding TOML basic-string escapes.
    // Avoids multi-step replace() with sentinel placeholders.
    let out = '';
    const inner = text.slice(1, -1);
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '\\' && i + 1 < inner.length) {
        const next = inner[++i];
        if      (next === 'n')  out += '\n';
        else if (next === 'r')  out += '\r';
        else if (next === 't')  out += '\t';
        else if (next === '"')  out += '"';
        else if (next === '\\') out += '\\';
        else                    out += next;
      } else {
        out += inner[i];
      }
    }
    return out;
  }
  if (text === 'true')  return true;
  if (text === 'false') return false;
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevelCommas(inner).map(s => parseTomlScalar(s.trim()));
  }
  const num = Number(text);
  if (Number.isFinite(num) && text !== '') return num;
  return text;     // fallback (e.g., unquoted identifier - unlikely in our use case)
}

export function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0, inString = false, start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && s[i - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

// -----------------------------------------------------------------------------
// removeTomlBlock — inverse of upsertTomlBlock. Strips the [tableName] block and
// its body up to the next `[` header (or EOF), preserving everything else and
// collapsing the trailing blank-line run to a single blank.
// -----------------------------------------------------------------------------

export interface TomlBlockRemoveOptions {
  filePath: string;
  tableName: string;
  ownership: 'agent' | 'hive-flow';
  dryRun: boolean;
  /** Symmetric with TomlBlockOptions: refuse removal when block is unmanaged unless forceAdopt. */
  isManaged: (existingTomlBlock: Record<string, unknown>) => Promise<boolean>;
  forceAdopt: boolean;
}

export async function removeTomlBlock(opts: TomlBlockRemoveOptions) {
  const source = await readTextIfExists(opts.filePath);
  if (source === null) {
    return { outcome: 'already-registered' as const, filePath: opts.filePath, changed: false, message: `${opts.filePath} does not exist; nothing to remove.` };
  }
  const range = findBlockRange(source, opts.tableName);
  if (range === null) {
    return { outcome: 'already-registered' as const, filePath: opts.filePath, changed: false, message: `[${opts.tableName}] is not in ${opts.filePath}.` };
  }
  // Ownership check — symmetric with upsertTomlBlock.
  const existingBlock = parseTomlBlockBody(source.slice(range.start, range.end));
  const managed = await opts.isManaged(existingBlock);
  if (!managed && !opts.forceAdopt) {
    return { outcome: 'conflict:manual-entry' as const, filePath: opts.filePath, changed: false, message: `[${opts.tableName}] is not Hive Flow-owned; refusing to remove. Use --force-adopt.` };
  }
  // Strip block + collapse the blank-line run that follows.
  const after = (source.slice(0, range.start) + source.slice(range.end)).replace(/\n{3,}/g, '\n\n');
  const beforeChecksum = sha(source);
  const afterChecksum = sha(after);
  if (opts.dryRun) {
    return { outcome: 'planned' as const, filePath: opts.filePath, changed: true, beforeChecksum, afterChecksum, message: `Would remove [${opts.tableName}].` };
  }
  const backupPath = await copyBackupOnce(opts.filePath);
  await atomicWrite(opts.filePath, after);
  return { outcome: 'applied' as const, filePath: opts.filePath, changed: true, beforeChecksum, afterChecksum, backupPath, message: `Removed [${opts.tableName}].` };
}
