#!/usr/bin/env node
/**
 * NPX Cache Repair
 *
 * Fixes the ENOTEMPTY error that occurs when npx's cache gets corrupted
 * from interrupted installs. This is a known npm bug affecting npm 10.x
 * on Node 22+ particularly in remote/CI environments.
 *
 * Usage:
 *   - Imported by bin entry points before main logic
 *   - Can also be run standalone from the CLI package bin directory:
 *     node npx-repair.js
 */
import { readdirSync, readFileSync, rmSync, statSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Remove stale .{name}-{hash} rename artifacts from npx cache dirs.
 * These are leftover from npm's atomic rename strategy when interrupted.
 */
export function repairNpxCache() {
  const npxCacheRoot = join(homedir(), '.npm', '_npx');
  if (!existsSync(npxCacheRoot)) return;

  let cleaned = 0;
  try {
    const cacheDirs = readdirSync(npxCacheRoot);
    for (const dir of cacheDirs) {
      const nmDir = join(npxCacheRoot, dir, 'node_modules');
      if (!existsSync(nmDir)) continue;

      try {
        const entries = readdirSync(nmDir);
        for (const entry of entries) {
          // Stale rename targets look like: .package-name-XxXxXxXx
          if (entry.startsWith('.') && entry.includes('-') && /[A-Za-z]{8}$/.test(entry)) {
            const fullPath = join(nmDir, entry);
            try {
              const stat = statSync(fullPath);
              if (stat.isDirectory()) {
                rmSync(fullPath, { recursive: true, force: true });
                cleaned++;
              }
            } catch {
              // ignore individual failures
            }
          }
        }
      } catch {
        // can't read this cache dir, skip
      }
    }
  } catch {
    // npx cache root not readable, nothing to do
  }

  return cleaned;
}

/**
 * Test whether a single cacache index line's JSON key belongs to a hive-flow
 * package.
 *
 * WHY a key-field check instead of a raw substring match:
 *   cacache index-v5 bucket files are JSONL — multiple package entries per
 *   file.  A bare `content.includes('hive-flow')` would match any line that
 *   merely *mentions* the string (e.g. a description field of an unrelated
 *   package, or a package named `claude-flow`/`hive-flow-unrelated`).  That
 *   caused the whole bucket to be deleted, evicting unrelated packages.
 *
 *   We check the `key` field because npm/make-fetch-happen always sets it to
 *   the canonical form:
 *     "make-fetch-happen:request-cache:https://registry.npmjs.org/<pkg>/..."
 *   or the shorter tarball form ending in `.tgz`.
 *   Anchoring to `registry.npmjs.org/hive-flow` and
 *   `registry.npmjs.org/@hive-flow/` ensures we only match the real
 *   `hive-flow` package and the `@hive-flow/*` scope — nothing else.
 *
 * @param {string} content - A single non-empty line from a cacache bucket file
 *   (format: "<hash>\t<JSON>") or any string to test.
 * @returns {boolean}
 */
export function isHiveFlowCacheIndexEntry(content) {
  const str = String(content || '');
  // Fast-path: reject lines that don't mention hive-flow at all.
  if (!str.includes('hive-flow')) return false;

  // Try to extract the JSON portion (everything after the first tab).
  const tabIdx = str.indexOf('\t');
  const jsonStr = tabIdx !== -1 ? str.slice(tabIdx + 1) : str;

  let key;
  try {
    const parsed = JSON.parse(jsonStr);
    key = typeof parsed?.key === 'string' ? parsed.key : null;
  } catch {
    // Not valid JSON — fall back to a conservative URL-pattern check on the
    // raw string so that malformed-but-real hive-flow entries are still caught.
    key = null;
  }

  if (key !== null) {
    // Match only the real hive-flow package and @hive-flow/* scope.
    // Patterns anchored to the npm registry URL segment so that packages
    // such as `hive-flow-utils` or `not-hive-flow` do NOT match.
    //
    // In a valid npm registry URL the package name is always followed by
    // '/', '?', '#', or end-of-string — never '-' (which would be part of
    // a different package name like `hive-flow-utils`).
    return (
      /registry\.npmjs\.org\/hive-flow(?:[/?#]|$)/.test(key) ||
      /registry\.npmjs\.org\/@hive-flow(?:\/|%2[fF])/.test(key)
    );
  }

  // Fallback for non-JSON content: require the registry URL patterns.
  return (
    /registry\.npmjs\.org\/hive-flow(?:[/?#]|$)/.test(str) ||
    /registry\.npmjs\.org\/@hive-flow(?:\/|%2[fF])/.test(str)
  );
}

/**
 * Pure helper: given a cacache bucket file's raw JSONL content, compute which
 * lines survive after dropping hive-flow entries. Extracted so the destructive
 * repair path has a unit-testable safety boundary (no real ~/.npm cache needed).
 *
 * @param {string} content - raw bucket file content
 * @returns {{ removed: number, survivors: string, deleteBucket: boolean }}
 *   removed      count of hive-flow lines dropped
 *   survivors    rewritten content (non-hive-flow lines + preserved blanks)
 *   deleteBucket true when >=1 line was removed AND nothing real survives
 *                (only blank/whitespace) -> caller should unlink the bucket
 */
export function pruneHiveFlowCacheIndexBucket(content) {
  const lines = String(content ?? '').split('\n');
  const keep = [];
  let removed = 0;
  for (const line of lines) {
    if (line.trim() !== '' && isHiveFlowCacheIndexEntry(line)) {
      removed++;
    } else {
      keep.push(line);
    }
  }
  const survivors = keep.join('\n');
  return { removed, survivors, deleteBucket: removed > 0 && survivors.trim() === '' };
}

export function repairCacheIntegrity() {
  const indexDir = join(homedir(), '.npm', '_cacache', 'index-v5');
  if (!existsSync(indexDir)) return 0;

  let cleaned = 0;
  function walk(dir) {
    try {
      for (const entry of readdirSync(dir)) {
        const fp = join(dir, entry);
        try {
          const s = statSync(fp);
          if (s.isDirectory()) {
            walk(fp);
          } else {
            const content = readFileSync(fp, 'utf-8');
            // Delegate JSONL filtering to the pure, unit-tested helper so the
            // destructive rewrite path keeps a pinned safety boundary.
            const { removed, survivors, deleteBucket } = pruneHiveFlowCacheIndexBucket(content);
            if (removed > 0) {
              if (deleteBucket) {
                // Nothing real survives (only blanks) — unlink the empty shell.
                unlinkSync(fp);
              } else {
                // Rewrite with only the non-hive-flow entries so unrelated
                // packages in the same bucket are not evicted.
                writeFileSync(fp, survivors, 'utf-8');
              }
              cleaned += removed;
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip unreadable dir */ }
  }
  walk(indexDir);
  return cleaned;
}

/**
 * Remove a specific corrupted npx cache entry by hash.
 */
export function removeNpxCacheEntry(hash) {
  const target = join(homedir(), '.npm', '_npx', hash);
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    return true;
  }
  return false;
}

/**
 * Full cache nuke — removes all npx cache entries.
 * Use as last resort when repair isn't enough.
 */
export function nukeNpxCache() {
  const npxCacheRoot = join(homedir(), '.npm', '_npx');
  if (existsSync(npxCacheRoot)) {
    rmSync(npxCacheRoot, { recursive: true, force: true });
    return true;
  }
  return false;
}

// Run standalone
if (process.argv[1] && process.argv[1].includes('npx-repair')) {
  const arg = process.argv[2];
  if (arg === '--nuke') {
    console.error('[npx-repair] Removing entire npx cache...');
    nukeNpxCache();
    console.error('[npx-repair] Done.');
  } else {
    const cleaned = repairNpxCache();
    const intFixed = repairCacheIntegrity();
    if (cleaned > 0) {
      console.error(`[npx-repair] Cleaned ${cleaned} stale cache entries.`);
    }
    if (intFixed > 0) {
      console.error(`[npx-repair] Removed ${intFixed} corrupted integrity entries.`);
    }
  }
}
