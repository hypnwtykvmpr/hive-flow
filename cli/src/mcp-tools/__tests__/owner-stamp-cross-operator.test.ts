/**
 * Owner-stamp cross-operator anti-contamination tests.
 *
 * Two operators (e.g. Claude and Codex) sharing a machine/tmux environment
 * leak session markers (CODEX_THREAD_ID, CLAUDE_CODE_SESSION_ID, ...) into
 * each other's process trees. The owner-stamp resolution for
 * operator-originated MCP calls must never adopt a foreign operator's leaked
 * marker: the transport-classified client kind restricts which env markers
 * may resolve the session, and an env-attested kind that contradicts the
 * transport kind fails closed instead of laundering the wrong identity.
 */

import { describe, expect, it } from 'vitest';
import { resolveOwnerStampOrError } from '../session-id.js';

const MCP_TRANSPORT_ID = 'mcp-1790000000000-deadbeef';

describe('owner stamp cross-operator anti-contamination', () => {
  it('does not stamp a leaked foreign env session onto a classified transport (regression)', () => {
    const result = resolveOwnerStampOrError(
      {},
      { CODEX_THREAD_ID: 'codex-thread' },
      { sessionId: MCP_TRANSPORT_ID, clientKind: 'claude' },
      'agent_spawn',
    );
    expect(result).toEqual({
      success: false,
      code: 'missing-owner-session',
      error: expect.stringContaining('owner session id'),
    });
  });

  it('stamps kind-agreeing env markers even when a foreign marker is present', () => {
    const result = resolveOwnerStampOrError(
      {},
      { CODEX_THREAD_ID: 'codex-thread', CLAUDE_CODE_SESSION_ID: 'claude-code-session' },
      { sessionId: MCP_TRANSPORT_ID, clientKind: 'claude' },
      'agent_spawn',
    );
    expect(result).toEqual({
      success: true,
      ownerSessionId: 'claude-code-session',
      ownerClientKind: 'claude',
    });
  });

  it('keeps deliberate env-attested cross-lane assignment working (explicit target session)', () => {
    // A codex-classified caller may explicitly stamp ownership for a claude
    // session **when the environment attests that session id**. This is the
    // established cross-lane assignment contract (e.g. one operator routing
    // completions to the other's pane). It is NOT laundering: laundering is
    // an UNATTESTED claim, covered by the fail-closed negatives below.
    const result = resolveOwnerStampOrError(
      { session_id: 'claude-sess' },
      { CLAUDE_CODE_SESSION_ID: 'claude-sess' },
      { sessionId: MCP_TRANSPORT_ID, clientKind: 'codex' },
      'agent_spawn',
    );
    expect(result).toEqual({
      success: true,
      ownerSessionId: 'claude-sess',
      ownerClientKind: 'claude',
    });
  });

  it('refuses forged owner-kind labels without any attestation (no-laundering negative)', () => {
    const result = resolveOwnerStampOrError(
      { session_id: 'foreign-session', ownerClientKind: 'claude' },
      {},
      { sessionId: MCP_TRANSPORT_ID, clientKind: 'codex' },
      'agent_spawn',
    );
    expect(result).toEqual({
      success: false,
      code: 'missing-owner-client-kind',
      error: expect.stringContaining('owner client kind'),
    });
  });

  it('keeps a legitimate codex operator with its own env markers working', () => {
    const result = resolveOwnerStampOrError(
      {},
      { CODEX_THREAD_ID: 'codex-thread' },
      { sessionId: MCP_TRANSPORT_ID, clientKind: 'codex' },
      'agent_spawn',
    );
    expect(result).toEqual({
      success: true,
      ownerSessionId: 'codex-thread',
      ownerClientKind: 'codex',
    });
  });

  it('keeps kind-less context resolution backward compatible', () => {
    const result = resolveOwnerStampOrError(
      {},
      { CODEX_THREAD_ID: 'codex-thread' },
      { sessionId: 'context-session' },
      'agent_spawn',
    );
    expect(result).toEqual({
      success: true,
      ownerSessionId: 'codex-thread',
      ownerClientKind: 'codex',
    });
  });

  it('adopts the transport kind when the context session becomes the owner session', () => {
    const result = resolveOwnerStampOrError(
      {},
      { CODEX_THREAD_ID: 'codex-thread' },
      { sessionId: 'real-operator-session', clientKind: 'claude' },
      'agent_spawn',
    );
    expect(result).toEqual({
      success: true,
      ownerSessionId: 'real-operator-session',
      ownerClientKind: 'claude',
    });
  });

  it('fails closed on explicit session ids no trusted source can attest', () => {
    const result = resolveOwnerStampOrError(
      { session_id: 'unattested-session' },
      { CODEX_THREAD_ID: 'codex-thread' },
      { sessionId: MCP_TRANSPORT_ID, clientKind: 'claude' },
      'agent_spawn',
    );
    expect(result).toEqual({
      success: false,
      code: 'missing-owner-client-kind',
      error: expect.stringContaining('owner client kind'),
    });
  });
});
