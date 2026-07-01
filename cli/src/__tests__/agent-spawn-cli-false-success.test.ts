/**
 * CLI `agent spawn` false-success bug regression tests.
 *
 * Verifies that when `callMCPTool('agent_spawn', ...)` returns a failure
 * envelope { success: false, error: "..." }, the CLI:
 *   - prints an error, not a success table
 *   - returns exitCode 1 / success false
 *   - does NOT print "[OK] ... spawned successfully"
 *   - in JSON mode, outputs the raw failure envelope (preserves error field)
 *
 * Also verifies the positive path: a successful deepseek result still prints
 * provider / resolvedModel correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module-level mocks (hoisted) ─────────────────────────────────────────────

vi.mock('../mcp-client.js', () => ({
  callMCPTool: vi.fn(),
  MCPClientError: class MCPClientError extends Error {
    constructor(public message: string, public toolName: string) {
      super(message);
      this.name = 'MCPClientError';
    }
  },
}));

vi.mock('../agents/roster.js', () => ({
  CANONICAL_AGENT_TYPES: ['tester', 'coder', 'researcher'],
  isCanonicalAgentType: (t: string) => ['tester', 'coder', 'researcher'].includes(t),
  loadCanonicalRoster: () => [
    { type: 'tester', description: 'Test agent', capabilities: ['test', 'verify'] },
    { type: 'coder', description: 'Code agent', capabilities: ['code', 'implement'] },
    { type: 'researcher', description: 'Research agent', capabilities: ['research'] },
  ],
}));

vi.mock('../output.js', () => {
  const lines: string[] = [];
  const errors: string[] = [];
  const successes: string[] = [];
  const jsons: unknown[] = [];
  const tables: unknown[] = [];

  return {
    output: {
      printInfo: vi.fn((msg: string) => lines.push(`[INFO] ${msg}`)),
      printError: vi.fn((msg: string) => errors.push(msg)),
      printSuccess: vi.fn((msg: string) => successes.push(msg)),
      printJson: vi.fn((data: unknown) => jsons.push(data)),
      printTable: vi.fn((opts: unknown) => tables.push(opts)),
      printBox: vi.fn(),
      printList: vi.fn(),
      writeln: vi.fn(),
      bold: (s: string) => s,
      highlight: (s: string) => s,
      dim: (s: string) => s,
      success: (s: string) => s,
      warning: (s: string) => s,
      error: (s: string) => s,
      _lines: lines,
      _errors: errors,
      _successes: successes,
      _jsons: jsons,
      _tables: tables,
    },
  };
});

vi.mock('../prompt.js', () => ({
  select: vi.fn(),
  confirm: vi.fn(),
  input: vi.fn(),
}));

import { callMCPTool } from '../mcp-client.js';
import { output } from '../output.js';
import { agentCommand } from '../commands/agent.js';

// Pull the spawn subcommand out of the registered subcommands
const spawnCmd = agentCommand.subcommands!.find((c) => c.name === 'spawn')!;

/** Build a minimal CommandContext for the spawn action. */
function makeCtx(overrides: {
  type?: string;
  name?: string;
  provider?: string;
  model?: string;
  format?: string;
  interactive?: boolean;
} = {}) {
  return {
    args: [],
    flags: {
      type: overrides.type ?? 'tester',
      name: overrides.name ?? 'test-agent',
      provider: overrides.provider ?? 'deepseek',
      model: overrides.model ?? 'deepseek-v4-pro',
      format: overrides.format,
      timeout: 300,
      autoTools: true,
    },
    interactive: overrides.interactive ?? false,
    command: spawnCmd,
  } as unknown as Parameters<typeof spawnCmd.action>[0];
}

/** Shared reset before each test */
function resetOutputMocks() {
  (output._errors as string[]).length = 0;
  (output._successes as string[]).length = 0;
  (output._jsons as unknown[]).length = 0;
  (output._tables as unknown[]).length = 0;
  (output._lines as string[]).length = 0;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('agent spawn CLI — false-success envelope handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOutputMocks();
  });

  // ── Negative path 1: holder socket missing (deepseek strict) ──────────────
  it('returns exitCode 1 and prints error when agent_spawn returns {success:false, error:"holder missing"}', async () => {
    (callMCPTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: 'deepseek strict API provider requires an available credential holder ... socket is missing',
    });

    const result = await spawnCmd.action(makeCtx());

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);

    // Must print an error containing the message from the envelope
    expect(output.printError).toHaveBeenCalledTimes(1);
    const errCall = (output.printError as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(errCall).toContain('credential holder');

    // Must NOT claim success
    expect(output.printSuccess).not.toHaveBeenCalled();

    // Must NOT render the agent table
    expect(output.printTable).not.toHaveBeenCalled();
  });

  // ── Negative path 2: EPERM on holder socket ──────────────────────────────
  it('returns exitCode 1 when agent_spawn returns {success:false, error:"connect EPERM ...sock"}', async () => {
    (callMCPTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: 'connect EPERM /home/user/.hive-flow/run/credential-holder.sock',
    });

    const result = await spawnCmd.action(makeCtx());

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(output.printSuccess).not.toHaveBeenCalled();
    expect(output.printTable).not.toHaveBeenCalled();
    const errCall = (output.printError as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(errCall).toContain('EPERM');
  });

  // ── Negative path 3: no agentId in result (implicit failure) ─────────────
  it('returns exitCode 1 when agent_spawn returns an object without agentId', async () => {
    (callMCPTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      // success not explicitly false, but no agentId — treated as failure
      provider: 'anthropic',
      model: 'default',
    });

    const result = await spawnCmd.action(makeCtx());

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(output.printSuccess).not.toHaveBeenCalled();
  });

  // ── Negative path 4: JSON mode preserves failure envelope ────────────────
  it('in JSON mode, outputs the raw failure envelope (preserves error field) on failure', async () => {
    const failureEnvelope = {
      success: false,
      error: 'holder missing',
      provider: 'deepseek',
    };
    (callMCPTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce(failureEnvelope);

    await spawnCmd.action(makeCtx({ format: 'json' }));

    // printJson must be called once with the failure envelope
    expect(output.printJson).toHaveBeenCalledTimes(1);
    const jsonArg = (output.printJson as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(jsonArg).toMatchObject({ success: false, error: 'holder missing' });

    // Must NOT print success table
    expect(output.printTable).not.toHaveBeenCalled();
    expect(output.printSuccess).not.toHaveBeenCalled();
  });

  // ── Positive path: successful deepseek spawn ──────────────────────────────
  it('prints success table with provider and resolvedModel for a successful deepseek spawn', async () => {
    const successEnvelope = {
      success: true,
      agentId: 'agent-abc-123',
      agentType: 'tester',
      status: 'idle',
      createdAt: '2026-06-19T01:00:00Z',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      resolvedModel: 'deepseek-v4-pro',
    };
    (callMCPTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce(successEnvelope);

    const result = await spawnCmd.action(makeCtx({ provider: 'deepseek', model: 'deepseek-v4-pro', name: 'my-agent' }));

    expect(result.success).toBe(true);

    // Must print success message
    expect(output.printSuccess).toHaveBeenCalledTimes(1);
    const successMsg = (output.printSuccess as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(successMsg).toContain('spawned successfully');

    // Must render a table
    expect(output.printTable).toHaveBeenCalledTimes(1);

    // Table data must include correct provider and resolvedModel
    const tableOpts = (output.printTable as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      data: Array<{ property: string; value: string }>;
    };
    const providerRow = tableOpts.data.find((r) => r.property === 'Provider');
    const resolvedModelRow = tableOpts.data.find((r) => r.property === 'Resolved Model');
    expect(providerRow?.value).toBe('deepseek');
    expect(resolvedModelRow?.value).toBe('deepseek-v4-pro');

    // Must NOT print error
    expect(output.printError).not.toHaveBeenCalled();
  });

  // ── Positive path JSON mode: success envelope output ─────────────────────
  it('in JSON mode, outputs the success envelope (not failure shape) on success', async () => {
    const successEnvelope = {
      success: true,
      agentId: 'agent-xyz',
      agentType: 'tester',
      status: 'idle',
      createdAt: '2026-06-19T01:00:00Z',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      resolvedModel: 'deepseek-v4-pro',
    };
    (callMCPTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce(successEnvelope);

    await spawnCmd.action(makeCtx({ format: 'json', provider: 'deepseek' }));

    expect(output.printJson).toHaveBeenCalledTimes(1);
    const jsonArg = (output.printJson as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect((jsonArg as Record<string, unknown>).agentId).toBe('agent-xyz');
    expect((jsonArg as Record<string, unknown>).provider).toBe('deepseek');
  });
});
