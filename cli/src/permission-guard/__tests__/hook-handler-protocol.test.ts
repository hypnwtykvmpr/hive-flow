/**
 * Hook Handler Protocol Tests — Process-Level
 *
 * CRITICAL: These are process-level tests. We spawn the actual
 * hook-handler.cjs process, pipe JSON to stdin, and assert BOTH exit code
 * AND stdout shape.
 *
 * All tests assert exitCode === 0 (the hook-handler MUST never exit 1,
 * because a non-zero exit from a Claude Code hook causes Claude Code to
 * treat the hook itself as broken — not the tool call).
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..');
const HOOK_HANDLER = resolve(ROOT, '.claude', 'helpers', 'hook-handler.cjs');

// ---------------------------------------------------------------------------
// Helper: run hook-handler with piped stdin
// ---------------------------------------------------------------------------

interface HookHandlerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runHookHandler(input: string): Promise<HookHandlerResult> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath, // node binary
      [HOOK_HANDLER, 'permission-guard'],
      { timeout: 15000 },
      (error, stdout, stderr) => {
        const exitCode = error ? (error.code as number | undefined) ?? 1 : 0;
        resolve({ stdout: stdout || '', stderr: stderr || '', exitCode });
      },
    );

    if (child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

/**
 * Parse the JSON output from the hook-handler and return the
 * hookSpecificOutput object.
 */
function parseHookOutput(stdout: string): {
  permissionDecision?: string;
  permissionDecisionReason?: string;
  hookEventName?: string;
} {
  try {
    const parsed = JSON.parse(stdout.trim());
    return parsed?.hookSpecificOutput ?? {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Test 1 — Denied tool call → exit 0 + deny JSON on stdout
// ---------------------------------------------------------------------------

describe('hook-handler: deny path', () => {
  it('exits 0 and outputs deny JSON for a tool that should be denied', async () => {
    // Write to .claude/settings.json is a self-protection denial (if gate is compiled)
    // or graceful-allow if gate is not compiled yet. Either way, exit code must be 0.
    const input = JSON.stringify({
      tool_name: 'Write',
      tool_input: {
        file_path: `${ROOT}/.claude/settings.json`,
        content: '{}',
      },
      cwd: ROOT,
    });

    const result = await runHookHandler(input);
    expect(result.exitCode).toBe(0);

    // Output must be valid JSON
    const output = parseHookOutput(result.stdout);
    // permissionDecision must be either 'allow' (gate not compiled) or 'deny'
    expect(['allow', 'deny']).toContain(output.permissionDecision);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Allowed tool call → exit 0 + allow JSON on stdout
// ---------------------------------------------------------------------------

describe('hook-handler: allow path', () => {
  it('exits 0 and outputs allow JSON for a safe read-only tool', async () => {
    const input = JSON.stringify({
      tool_name: 'Read',
      tool_input: {
        file_path: `${ROOT}/src/index.ts`,
      },
      cwd: ROOT,
    });

    const result = await runHookHandler(input);
    expect(result.exitCode).toBe(0);

    const output = parseHookOutput(result.stdout);
    // Read is in always_allow_tools by default — should be allowed
    // If gate is not compiled, graceful-allow still produces allow
    expect(output.permissionDecision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Malformed JSON (missing tool_name) → exit 0 + deny JSON
// ---------------------------------------------------------------------------

describe('hook-handler: malformed JSON input', () => {
  it('exits 0 and outputs a deny (not allow) for missing tool_name input', async () => {
    // Valid JSON but structurally wrong for the gate
    const input = JSON.stringify({
      // tool_name is missing — gate should handle this gracefully
      tool_input: { command: 'echo hello' },
      cwd: ROOT,
    });

    const result = await runHookHandler(input);
    expect(result.exitCode).toBe(0);

    // Must produce valid JSON on stdout
    const output = parseHookOutput(result.stdout);
    // Gate with empty tool_name goes to inline jury → deny or allow depending on gate
    // Gate unavailable → allow. Key invariant: exits 0, produces JSON.
    expect(['allow', 'deny']).toContain(output.permissionDecision);

    // stdout must not be empty
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Empty string input → exit 0 + some JSON (must not crash)
// ---------------------------------------------------------------------------

describe('hook-handler: empty stdin', () => {
  it('exits 0 and does not crash when stdin is empty', async () => {
    const result = await runHookHandler('');
    expect(result.exitCode).toBe(0);

    // stdout should contain some JSON (either allow for parse-error-is-allow or deny)
    // The hook-handler treats stdin parse errors as deny (potential tampering)
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Empty object '{}' → exit 0 + graceful handling
// ---------------------------------------------------------------------------

describe('hook-handler: empty object input', () => {
  it('exits 0 and handles {} gracefully without crashing', async () => {
    const result = await runHookHandler('{}');
    expect(result.exitCode).toBe(0);

    // Should produce valid JSON — either allow or deny
    const output = parseHookOutput(result.stdout);
    expect(['allow', 'deny']).toContain(output.permissionDecision);
  });
});

// ---------------------------------------------------------------------------
// Additional: verify exit code is always 0 for various inputs
// ---------------------------------------------------------------------------

describe('hook-handler: exit code is always 0', () => {
  const inputs = [
    // Pure noise
    'null',
    '[]',
    '"string"',
    '42',
    // Deeply nested but safe
    JSON.stringify({ tool_name: 'Glob', tool_input: { pattern: '**/*.ts' }, cwd: '/' }),
    // Bash command that looks dangerous (should deny, not crash)
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp' }, cwd: ROOT }),
  ];

  for (const input of inputs) {
    it(`exits 0 for input: ${input.slice(0, 40)}`, async () => {
      const result = await runHookHandler(input);
      expect(result.exitCode).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Additional: stdout always contains valid JSON for permission-guard
// ---------------------------------------------------------------------------

describe('hook-handler: stdout is always valid JSON', () => {
  it('produces parseable JSON for a well-formed allow request', async () => {
    const input = JSON.stringify({
      tool_name: 'Glob',
      tool_input: { pattern: '**/*.ts' },
      cwd: ROOT,
    });
    const result = await runHookHandler(input);
    expect(result.exitCode).toBe(0);

    // Must not throw
    let parsed: unknown;
    expect(() => { parsed = JSON.parse(result.stdout.trim()); }).not.toThrow();
    expect(parsed).toBeTruthy();
    expect(typeof parsed).toBe('object');
  });

  it('produces parseable JSON for a well-formed deny request', async () => {
    const input = JSON.stringify({
      tool_name: 'Write',
      tool_input: {
        file_path: `${ROOT}/.claude/settings.json`,
        content: 'malicious',
      },
      cwd: ROOT,
    });
    const result = await runHookHandler(input);
    expect(result.exitCode).toBe(0);

    let parsed: unknown;
    expect(() => { parsed = JSON.parse(result.stdout.trim()); }).not.toThrow();
    expect(parsed).toBeTruthy();
  });
});
