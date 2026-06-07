export interface ProhibitedPattern {
  readonly label: string;
  readonly pattern: RegExp;
}

export const CORE_PROHIBITED: readonly ProhibitedPattern[] = [
  { label: 'old GitHub org', pattern: /ruvnet\/hive-flow/i },
  { label: 'old container registry org', pattern: /ghcr\.io\/ruvnet\/hive-flow/i },
  { label: 'stale agentdb version', pattern: /2\.0\.0-alpha\.3\.4/ },
  { label: 'old RuVector brand', pattern: /\bRuVector\b/ },
];

export const PERF_CLAIM_PROHIBITED: readonly ProhibitedPattern[] = [
  { label: 'fictional HNSW speed multiplier', pattern: /\b(?:150\s*x|12,?500\s*x|150\s*x\s*(?:-|–|to|and)\s*12,?500\s*x)\b/i },
  { label: 'fictional Flash Attention speed range', pattern: /\b2\.49\s*x\s*(?:-|–|to)\s*7\.47\s*x\b/i },
  { label: 'fictional SWE-Bench solve rate', pattern: /\b84\.8\s*%/ },
  { label: 'fictional SONA adaptation latency', pattern: /(?:<\s*)?0\.05\s*ms/i },
  { label: 'old RuVector intelligence label', pattern: /RuVector Intelligence System/ },
];

export const DEBRAND_ASSERT_ZERO_PROHIBITED: readonly ProhibitedPattern[] = [
  ...CORE_PROHIBITED,
  ...PERF_CLAIM_PROHIBITED,
];
