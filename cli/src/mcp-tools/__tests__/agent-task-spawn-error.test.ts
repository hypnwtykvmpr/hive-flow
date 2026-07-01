/**
 * d3-001 regression: agent_task detached spawn must attach an 'error' listener
 * before calling child.unref() so a spawn failure (e.g. ENOENT for a missing
 * bridge binary) writes a failed-task result file rather than emitting an
 * unhandled ChildProcess error that crashes the MCP server.
 *
 * This test validates the fix at the unit level by checking that the spawn
 * code path attaches an error handler.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Read the compiled source to verify the error listener is wired.
// This is a static-analysis style regression test — it checks that the
// source contains the fix rather than running the full MCP server.
const agentToolsSrc = readFileSync(
  join(import.meta.dirname, '..', 'agent-tools.ts'),
  'utf-8',
);

describe('agent_task spawn error handler (d3-001)', () => {
  it('source attaches child.on("error") listener before child.unref()', () => {
    // The fix must place the error listener BEFORE unref() so it is registered
    // before the process can detach and emit async spawn errors.
    const errorListenerIdx = agentToolsSrc.indexOf("child.on('error'");
    const unrefIdx = agentToolsSrc.indexOf('child.unref()');

    expect(errorListenerIdx, "child.on('error') not found in agent-tools.ts").toBeGreaterThan(-1);
    expect(unrefIdx, 'child.unref() not found in agent-tools.ts').toBeGreaterThan(-1);
    expect(errorListenerIdx).toBeLessThan(unrefIdx);
  });

  it('error handler writes a failed-task result file', () => {
    // Verify the error handler calls writeFileSync with a failure payload.
    // The handler must write a result file so agent_task_result can surface the error.
    expect(agentToolsSrc).toContain('spawn error:');
    expect(agentToolsSrc).toContain('success: false');
  });

  it('error handler resets agent to idle on spawn failure', () => {
    // The handler must call transitionAgent(agent, "idle") to avoid leaving
    // the agent stuck in "busy" state after a failed spawn.
    expect(agentToolsSrc).toContain("transitionAgent(agent, 'idle')");
  });
});
