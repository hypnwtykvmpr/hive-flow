/**
 * Shared path/ID sanitization utilities.
 *
 * Provides a single canonical implementation for sanitizing IDs used in
 * file paths (agent IDs, hive IDs, task IDs) to prevent directory traversal
 * and other path-injection attacks.
 *
 * All call sites that previously had inline `.replace(/[/\\.]+/g, '_')` chains
 * should import `sanitizePathId` from this module instead.
 *
 * Security: Uses a whitelist pattern `[^A-Za-z0-9_-]` — only alphanumerics,
 * hyphens, and underscores survive. This is intentionally stricter than the
 * previous blacklist (`/[/\\.]+/g`) which could miss exotic path separators.
 */

/**
 * Sanitize an arbitrary string for safe use as a filesystem path component.
 *
 * @param id    - Raw identifier (agent ID, hive ID, task ID, etc.)
 * @param maxLen - Maximum length of the returned string (default: 128)
 * @returns Sanitized string safe for path construction, or empty string if input is invalid.
 */
export function sanitizePathId(id: unknown, maxLen = 128): string {
  if (id === null || id === undefined) return '';
  const str = typeof id === 'string' ? id : String(id);
  if (!str) return '';

  // Whitelist: keep only safe characters
  const sanitized = str
    .replace(/[^A-Za-z0-9_-]+/g, '_')  // Replace unsafe chars with underscore
    .replace(/^_+|_+$/g, '')           // Trim leading/trailing underscores
    .slice(0, maxLen);

  return sanitized;
}
