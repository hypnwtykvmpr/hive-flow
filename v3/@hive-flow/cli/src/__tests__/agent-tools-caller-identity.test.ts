/**
 * Regression tests for agent-tools fixes:
 *   d3-003 — CLAUDE_SESSION_ID must NOT appear in the agent-identity fallback chain
 *   d4-004 — Proxy env vars must be present in BRIDGE_BASE_ENV_KEYS
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const AGENT_TOOLS_PATH = resolve(
  __dirname,
  '../mcp-tools/agent-tools.ts',
);

const src = readFileSync(AGENT_TOOLS_PATH, 'utf-8');

// ── d3-003: caller-identity resolution ────────────────────────────────────────

describe('d3-003: callerAgentId fallback chain', () => {
  // Locate the agent_update handler — the callerAgentId assignment we care about
  // is scoped INSIDE that handler, not the unrelated helper at the top of the file.
  function getAgentUpdateCallerBlock(): string {
    const handlerStart = src.indexOf("name: 'agent_update'");
    if (handlerStart === -1) throw new Error("agent_update not found in source");

    // Find `const callerAgentId =` AFTER the handler opening
    const callerStart = src.indexOf('const callerAgentId =', handlerStart);
    if (callerStart === -1) throw new Error("callerAgentId not found inside agent_update");

    // The assignment ends at `|| null;`
    const nullTerminus = src.indexOf('|| null;', callerStart);
    if (nullTerminus === -1) throw new Error("|| null; terminator not found");

    return src.slice(callerStart, nullTerminus + '|| null;'.length);
  }

  it('does NOT include CLAUDE_SESSION_ID as a fallback for agent identity', () => {
    const callerAssignment = getAgentUpdateCallerBlock();

    // Must NOT use the session id as an agent id source
    expect(callerAssignment).not.toContain('CLAUDE_SESSION_ID');

    // Must still use the real agent-id env vars
    expect(callerAssignment).toContain('AGENTIC_FLOW_AGENT_ID');
    expect(callerAssignment).toContain('CLAUDE_AGENT_ID');
  });

  it('CLAUDE_SESSION_ID still appears in legitimate session-id usage elsewhere in the file', () => {
    // The session id is legitimately used for ownerSessionId — confirm it
    // still exists somewhere in the file so we did not accidentally remove all uses.
    const sessionUsage = src.indexOf('CLAUDE_SESSION_ID');
    expect(sessionUsage).toBeGreaterThan(-1);

    // Confirm the only surviving use is outside the callerAgentId block
    const callerAssignment = getAgentUpdateCallerBlock();
    expect(callerAssignment).not.toContain('CLAUDE_SESSION_ID');
  });
});

// ── d4-004: proxy keys in BRIDGE_BASE_ENV_KEYS ───────────────────────────────

describe('d4-004: BRIDGE_BASE_ENV_KEYS includes proxy env vars', () => {
  const REQUIRED_PROXY_KEYS = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ] as const;

  const FORBIDDEN_SECRET_PATTERNS = [
    /ANTHROPIC_API_KEY/,
    /OPENAI_API_KEY/,
    /GEMINI_API_KEY/,
    /GOOGLE_API_KEY/,
    /CODEX_API_KEY/,
    /CURSOR_API_KEY/,
    /CLAUDE_API_KEY/,
  ];

  it('has all six proxy env keys in the BRIDGE_BASE_ENV_KEYS set literal', () => {
    const setStart = src.indexOf('const BRIDGE_BASE_ENV_KEYS = new Set([');
    expect(setStart).toBeGreaterThan(-1);

    const setEnd = src.indexOf(']);', setStart);
    expect(setEnd).toBeGreaterThan(-1);

    const setLiteral = src.slice(setStart, setEnd + ']);'.length);

    for (const key of REQUIRED_PROXY_KEYS) {
      expect(setLiteral, `BRIDGE_BASE_ENV_KEYS must contain '${key}'`).toContain(
        `'${key}'`,
      );
    }
  });

  it('does NOT include provider secret/API-key env vars in BRIDGE_BASE_ENV_KEYS', () => {
    const setStart = src.indexOf('const BRIDGE_BASE_ENV_KEYS = new Set([');
    const setEnd = src.indexOf(']);', setStart);
    const setLiteral = src.slice(setStart, setEnd + ']);'.length);

    for (const pattern of FORBIDDEN_SECRET_PATTERNS) {
      expect(setLiteral).not.toMatch(pattern);
    }
  });
});
