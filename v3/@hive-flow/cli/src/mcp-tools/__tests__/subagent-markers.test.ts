import { describe, expect, it } from 'vitest';
import { assertSubagentIdentityMarker, hasSubagentIdentityMarker } from '../subagent-markers.js';

describe('subagent marker invariant', () => {
  it('accepts every hook-derived subagent marker', () => {
    for (const marker of ['HIVE_FLOW_AGENT_ID', 'CLAUDE_AGENT_ID', 'CLAUDE_PARENT_AGENT_ID'] as const) {
      expect(hasSubagentIdentityMarker({ [marker]: 'worker-1' }), marker).toBe(true);
    }
  });

  it('rejects child environments without a subagent marker before spawn', () => {
    expect(() => assertSubagentIdentityMarker({ PATH: '/usr/bin' }, 'provider bridge')).toThrow(
      /without subagent identity marker/
    );
  });
});
