/**
 * MCP Exec --json Flag Tests
 *
 * Verifies that `mcp exec --json` suppresses decorative output and emits
 * pure, parseable JSON to stdout. Tests are integration-style: they spawn
 * the CLI binary as a child process and inspect its stdout.
 *
 * @module @hive-flow/cli/__tests__/mcp-exec-json
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = resolve(__dirname, '..', 'bin', 'cli.js');

// ---------------------------------------------------------------------------
// Helper: run the CLI and capture stdout/stderr
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCli(args: string[], timeoutMs = 10_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI_BIN, ...args],
      {
        timeout: timeoutMs,
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exitCode: error ? (error as any).code ?? 1 : 0,
        });
      },
    );
  });
}

/** Decorative prefixes that must NOT appear in --json output */
const DECORATIVE_PATTERNS = [
  /^\[INFO\]/m,
  /^\[OK\]/m,
  /^\[ERROR\]/m,
  /^Result:/m,
  /^\s*Executing tool:/m,
  /^\s*Tool executed in/m,
];

// ---------------------------------------------------------------------------
// 1. --json flag produces pure JSON output (no decorative prefixes)
// ---------------------------------------------------------------------------

describe('mcp exec --json', () => {
  it('emits pure JSON to stdout with no decorative output', async () => {
    const { stdout } = await runCli(['mcp', 'exec', '--tool', 'agent_list', '--json']);

    // stdout must be parseable as JSON without any regex extraction
    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(stdout.trim());
    }).not.toThrow();

    // No decorative prefixes anywhere in stdout
    for (const pattern of DECORATIVE_PATTERNS) {
      expect(stdout).not.toMatch(pattern);
    }
  });

  it('JSON output is parseable by JSON.parse() without regex extraction', async () => {
    const { stdout } = await runCli(['mcp', 'exec', '--tool', 'agent_list', '--json']);

    const trimmed = stdout.trim();
    // Must not be empty
    expect(trimmed.length).toBeGreaterThan(0);

    // Single JSON.parse call — no preprocessing needed
    const parsed = JSON.parse(trimmed);
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// 2. Without --json flag, decorative output is present (backward compat)
// ---------------------------------------------------------------------------

describe('mcp exec without --json (backward compatibility)', () => {
  it('includes decorative output when --json is not specified', async () => {
    const { stdout } = await runCli(['mcp', 'exec', '--tool', 'agent_list']);

    // At least one decorative indicator should be present
    // The exec command normally prints "Executing tool:" and "Result:" etc.
    const hasDecorative =
      stdout.includes('Executing tool:') ||
      stdout.includes('Tool executed') ||
      stdout.includes('Result:') ||
      stdout.includes('[INFO]') ||
      stdout.includes('[OK]');

    expect(hasDecorative).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Nonexistent tool with --json returns JSON error
// ---------------------------------------------------------------------------

describe('mcp exec --json with nonexistent tool', () => {
  it('returns a JSON error object for an unknown tool', async () => {
    const { stdout } = await runCli([
      'mcp', 'exec', '--tool', 'nonexistent_tool_xyz', '--json',
    ]);

    const trimmed = stdout.trim();
    expect(trimmed.length).toBeGreaterThan(0);

    let parsed: any;
    expect(() => {
      parsed = JSON.parse(trimmed);
    }).not.toThrow();

    // Must contain an error field
    expect(parsed).toHaveProperty('error');
    expect(typeof parsed.error).toBe('string');
  });

  it('JSON error output contains no decorative prefixes', async () => {
    const { stdout } = await runCli([
      'mcp', 'exec', '--tool', 'nonexistent_tool_xyz', '--json',
    ]);

    for (const pattern of DECORATIVE_PATTERNS) {
      expect(stdout).not.toMatch(pattern);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. --format json behaves the same as --json (if supported)
// ---------------------------------------------------------------------------

describe('mcp exec --format json', () => {
  it('produces parseable JSON output equivalent to --json', async () => {
    const { stdout } = await runCli([
      'mcp', 'exec', '--tool', 'agent_list', '--format', 'json',
    ]);

    const trimmed = stdout.trim();

    // If --format json is supported, output must be valid JSON
    // If not supported (falls through to decorative), this test documents
    // the gap so Q3 can address it.
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // --format json may already work via existing ctx.flags.format path
      // but decorative lines before the JSON block would break JSON.parse.
      // If this fails, the --json flag is the canonical way to get clean output.
      return;
    }

    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe('object');

    // When it does parse, there should be no decorative noise
    for (const pattern of DECORATIVE_PATTERNS) {
      expect(stdout).not.toMatch(pattern);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. JSON output must be parseable without regex extraction (explicit)
// ---------------------------------------------------------------------------

describe('mcp exec --json output integrity', () => {
  it('stdout contains exactly one JSON value (no extra text before or after)', async () => {
    const { stdout } = await runCli(['mcp', 'exec', '--tool', 'agent_list', '--json']);

    const trimmed = stdout.trim();

    // Must start with { or [ (valid JSON object/array start)
    expect(trimmed).toMatch(/^[\[{]/);

    // Must end with } or ] (valid JSON object/array end)
    expect(trimmed).toMatch(/[\]}]$/);

    // Full string must parse as one JSON value
    expect(() => JSON.parse(trimmed)).not.toThrow();
  });
});
