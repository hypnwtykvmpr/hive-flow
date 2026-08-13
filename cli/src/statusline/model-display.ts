/**
 * model-display.ts — synchronous model display resolver
 *
 * Source priority (runbook §4.2):
 *   1. stdin  → stdinData.model.display_name / displayName  (freshness: 'live')
 *   2. No source found                                       (freshness: 'unknown', confidence: 0)
 *
 * NEVER returns a hardcoded fallback string.  If no data is available the
 * value.modelDisplay is '' and the renderer must omit the row.
 *
 * 1M-context detection: when the resolved modelId contains the substring
 * "[1m]" (case-insensitive) and the display string does not already include
 * "1M", append " 1M" to the display string.
 */

export interface ModelDisplayInput {
  /** Raw object piped via stdin (e.g. the Claude Code status payload). */
  stdinData?: Record<string, unknown>;
  /** Agent identifier — reserved for future env / config fallback. */
  agentId?: string;
  /** ISO timestamp of session start — reserved for staleness calculation. */
  sessionStartTime?: string;
}

export interface ModelDisplayResult {
  value: {
    /** Human-readable model label, e.g. "Opus 5" or "Opus 5 1M".
     *  Empty string when no source is available — renderer must omit row. */
    modelDisplay: string;
    /** Raw model id as reported by the source, e.g. "claude-opus-5". */
    id?: string;
  };
  /** 'live'   — resolved directly from stdin data present in this invocation.
   *  'stale'  — resolved from a secondary source with potential drift.
   *  'unknown'— no source was available; renderer should omit the row. */
  freshness: 'live' | 'stale' | 'unknown';
  /** Confidence in [0, 1].  1 = direct read from authoritative source. */
  confidence: number;
}

/**
 * Synchronously resolve the model display string.
 *
 * Reads stdin data FIRST.  Does NOT fall back to any hardcoded string.
 *
 * @param stdinData  - Parsed stdin payload (may be undefined / null).
 * @param agentId    - Agent identifier (reserved; not used in current logic).
 * @param sessionStartTime - ISO start timestamp (reserved; not used currently).
 */
export function resolveModelDisplay(
  stdinData?: Record<string, unknown>,
  agentId?: string,
  sessionStartTime?: string,
): ModelDisplayResult {
  // ── stdin path ────────────────────────────────────────────────────────────
  if (stdinData != null) {
    const model = stdinData['model'] as Record<string, unknown> | undefined;
    if (model != null && typeof model === 'object') {
      // Prefer display_name, fall back to displayName (camelCase variant)
      const rawDisplay =
        typeof model['display_name'] === 'string'
          ? model['display_name']
          : typeof model['displayName'] === 'string'
          ? model['displayName']
          : undefined;

      const rawId =
        typeof model['id'] === 'string'
          ? model['id']
          : typeof model['model_id'] === 'string'
          ? model['model_id']
          : undefined;

      // Resolve the final display string
      let display: string | undefined = rawDisplay;

      // Append " 1M" when the model id encodes [1m] and display doesn't already say so
      if (display && rawId && !display.includes('1M') && /\[?1m\]?/i.test(rawId)) {
        display = `${display} 1M`;
      }

      // If no display_name but we have an id, surface the id so the renderer
      // can choose to show it rather than omit the row entirely.
      if (!display && rawId) {
        display = rawId;
      }

      if (display) {
        return {
          value: { modelDisplay: display, id: rawId },
          freshness: 'live',
          confidence: 1,
        };
      }
    }
  }

  // ── no source available ───────────────────────────────────────────────────
  // Do NOT emit a fictional fallback string. Return empty; renderer omits row.
  return {
    value: { modelDisplay: '' },
    freshness: 'unknown',
    confidence: 0,
  };
}
