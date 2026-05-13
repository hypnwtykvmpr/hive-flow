/**
 * Argument validators for the bridge `grep` tool.
 *
 * Extracted into a separate module so the validators can be unit-tested
 * directly (the bridge itself is a process entry point and not module-
 * importable as a unit). The bridge imports these and applies them before
 * invoking the underlying `rg` / `grep` subprocess.
 *
 * SECURITY: rejects dash-prefixed values that would otherwise be interpreted
 * by ripgrep as options. The most dangerous is `--pre=<path>`, which would
 * execute an arbitrary script per file searched (RCE via prompt-injected
 * LLM tool call).
 */

/**
 * Returns true if a pattern is unsafe (must be rejected by the grep handler).
 * Currently rejects values starting with `-` to prevent option-confusion.
 */
export function patternIsRejected(pattern) {
  return typeof pattern !== 'string' || pattern.length === 0 || pattern.startsWith('-');
}

/**
 * Returns true if a file_glob value is unsafe.
 * Same rule as patterns.
 */
export function fileGlobIsRejected(fileGlob) {
  if (fileGlob === undefined || fileGlob === null) return false;
  return typeof fileGlob !== 'string' || fileGlob.startsWith('-');
}

/**
 * Build rg argv with proper option/positional separation.
 * Options (-n, -H, --color=never, optional --glob) come BEFORE `--`.
 * Positionals (pattern, searchPath) come AFTER `--`.
 */
export function buildRgArgs(pattern, searchPath, fileGlob) {
  if (patternIsRejected(pattern)) {
    throw new Error('grep: pattern may not start with "-" (would be parsed as an option)');
  }
  if (fileGlobIsRejected(fileGlob)) {
    throw new Error('grep: file_glob may not start with "-"');
  }
  const args = ['-n', '-H', '--color=never'];
  if (fileGlob) {
    args.push('--glob', fileGlob);
  }
  args.push('--', pattern, searchPath);
  return args;
}

/**
 * Build grep fallback argv with proper option/positional separation.
 */
export function buildGrepArgs(pattern, searchPath) {
  if (patternIsRejected(pattern)) {
    throw new Error('grep: pattern may not start with "-" (would be parsed as an option)');
  }
  return ['-rn', '--color=never', '--', pattern, searchPath];
}
