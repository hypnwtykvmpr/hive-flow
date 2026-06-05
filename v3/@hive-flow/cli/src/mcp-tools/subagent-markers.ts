export const SUBAGENT_IDENTITY_MARKERS = [
  'AGENTIC_FLOW_AGENT_ID',
  'CLAUDE_AGENT_ID',
  'CLAUDE_PARENT_AGENT_ID',
] as const;

export type SubagentIdentityMarker = typeof SUBAGENT_IDENTITY_MARKERS[number];

export function hasSubagentIdentityMarker(env: Record<string, string | undefined>): boolean {
  return SUBAGENT_IDENTITY_MARKERS.some((marker) => {
    const value = env[marker];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

export function assertSubagentIdentityMarker(
  env: Record<string, string | undefined>,
  context: string
): void {
  if (hasSubagentIdentityMarker(env)) return;
  throw new Error(`[enforcement] Refusing to spawn ${context} without subagent identity marker`);
}
