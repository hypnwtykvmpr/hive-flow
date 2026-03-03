/**
 * Glob-to-Regex Converter for Permission Guard
 *
 * Converts shell glob patterns (used in default-config.ts) into proper RegExp
 * objects. This fixes a systemic bug where all 80+ patterns use shell glob
 * syntax (e.g. "rm *", "git push --force*") but were previously interpreted
 * as raw regex, where * means "zero or more of preceding character".
 *
 * Broken behavior (raw regex):
 *   "rm *"              becomes "rm" + zero-or-more spaces (quantifies the space)
 *   "git push --force*" becomes "git push --forc" + zero-or-more "e"s
 *   "node *"            becomes "nod" + zero-or-more "e"s (matches "node_modules")
 *
 * Fixed behavior (glob-to-regex):
 *   "rm *"              becomes /^rm .STAR/ (matches "rm -rf ./build")
 *   "git push --force*" becomes /^git push --force.STAR/ (matches "git push --force origin")
 *   "node *"            becomes /^node .STAR/ (matches "node script.js", NOT "node_modules")
 */

// ---------------------------------------------------------------------------
// Regex metacharacters that must be escaped when converting from glob
// ---------------------------------------------------------------------------

const REGEX_METACHAR = /[.+^${}()|\\[\]\\]/g;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detects whether a pattern is a shell glob (contains unescaped `*` or `?`)
 * versus an already-valid regex (anchored with `^`).
 *
 * Heuristic:
 *   - Patterns starting with `^` are treated as pre-existing regex.
 *   - Everything else is treated as a glob pattern.
 *
 * This is intentionally simple. The default-config patterns are either
 * plain globs like `rm *` or explicit regex like `^halt(\s|$)`. There is
 * no ambiguous middle ground in the current pattern set.
 */
export function isGlobPattern(pattern: string): boolean {
  if (!pattern) return false;
  // Patterns anchored with ^ are already regex
  if (pattern.startsWith('^')) return false;
  // Everything else is treated as glob
  return true;
}

/**
 * Convert a shell glob pattern to a RegExp.
 *
 * Conversion rules:
 *   1. If the pattern starts with `^`, it is already regex -- pass through.
 *   2. Escape all regex metacharacters (`.`, `+`, `^`, `$`, etc.).
 *   3. Convert glob `*` to regex `.*` (match any sequence of characters).
 *   4. Convert glob `?` to regex `.` (match exactly one character).
 *   5. Auto-anchor the result with `^` to prevent substring matching.
 *
 * The resulting RegExp uses the case-insensitive flag (`i`) to match
 * the existing behavior in gate.ts.
 *
 * @param pattern - A shell glob pattern or pre-existing regex string
 * @returns A compiled RegExp object
 * @throws {Error} If the resulting regex is invalid (should not happen with
 *                 well-formed glob patterns)
 */
export function globToRegex(pattern: string): RegExp {
  // Empty pattern matches nothing
  if (!pattern) {
    return /(?!)/;
  }

  // Already a regex -- pass through unchanged
  if (pattern.startsWith('^')) {
    return new RegExp(pattern, 'i');
  }

  // Step 1: Escape all regex metacharacters in the glob string.
  //         This ensures that characters like `.`, `+`, `(`, `)`, `|`, `[`, `]`
  //         are treated as literals, not regex operators.
  //         We must NOT escape `*` and `?` here -- they are glob operators.
  let regexStr = pattern.replace(REGEX_METACHAR, '\\$&');

  // Step 2: Convert glob wildcards to regex equivalents.
  //         `*` -> `.*` (match zero or more of any character)
  //         `?` -> `.`  (match exactly one of any character)
  regexStr = regexStr.replace(/\*/g, '.*');
  regexStr = regexStr.replace(/\?/g, '.');

  // Step 3: Auto-anchor to the start of the string.
  //         Without this, `rm .*` would match "inform ation" via substring.
  regexStr = `^(?:${regexStr})`;

  return new RegExp(regexStr, 'i');
}

/**
 * Test whether a command matches a glob pattern.
 *
 * Convenience wrapper that compiles the glob and tests the command string.
 * Useful for one-off checks where caching the compiled regex is not needed.
 *
 * @param command - The command string to test
 * @param pattern - The glob pattern to match against
 * @returns true if the command matches the pattern
 */
export function globMatch(command: string, pattern: string): boolean {
  try {
    return globToRegex(pattern).test(command);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pre-compiled pattern cache
// ---------------------------------------------------------------------------

const compiledCache = new Map<string, RegExp>();

/**
 * Get a compiled RegExp for a glob pattern, using a cache to avoid
 * recompilation on every permission check.
 *
 * @param pattern - A glob pattern or pre-existing regex string
 * @returns A compiled RegExp (cached)
 */
export function getCompiledPattern(pattern: string): RegExp {
  let cached = compiledCache.get(pattern);
  if (cached) return cached;
  cached = globToRegex(pattern);
  compiledCache.set(pattern, cached);
  return cached;
}

/**
 * Clear the compiled pattern cache.
 * Primarily useful for testing.
 */
export function clearPatternCache(): void {
  compiledCache.clear();
}
