// Shared property-run count resolver for CLI property-based suites.
//
// Mirrors `propertyRunsFromEnv` in @hive-flow/testing (helpers/hardening.ts).
// Defined locally because @hive-flow/cli does not depend on @hive-flow/testing.
//
// Reads HIVE_FLOW_PROPERTY_RUNS / HF_PROPERTY_RUNS so that `test:hardening:deep`
// (which sets HIVE_FLOW_PROPERTY_RUNS=1000) actually raises run counts for the
// CLI sentinel / property / enforcement-security suites instead of being a no-op.

/**
 * Resolve the fast-check `numRuns` for a property suite from the environment.
 *
 * @param fallback Default run count when no env override is present.
 * @param env      Environment to read (defaults to process.env; injectable for tests).
 */
export function propertyRunsFromEnv(fallback = 100, env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.HIVE_FLOW_PROPERTY_RUNS ?? env.HF_PROPERTY_RUNS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}
