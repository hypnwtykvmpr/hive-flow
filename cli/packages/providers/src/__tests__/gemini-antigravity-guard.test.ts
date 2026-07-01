/**
 * ============================================================================
 * DO-NOT-REVERT GUARD — Antigravity (`agy`) is the gemini-cli backend.
 *
 * These tests are INTENTIONALLY REDUNDANT with cli-providers.test.ts. They exist
 * to fail loudly if anyone regresses the `gemini-cli` provider back toward the
 * dead `@google/gemini-cli` (`gemini`) binary. That regression has recurred
 * multiple times and surfaces in production as:
 *
 *     code: 404  ModelNotFoundError: Requested entity was not found.
 *
 * Google replaced "Gemini CLI" with ANTIGRAVITY (binary `agy`, a Go rewrite).
 * The provider MUST:
 *   - resolve the `agy` binary (NOT `gemini`)
 *   - build headless args with `--prompt`/`--model`/`--dangerously-skip-permissions`
 *     (NOT `--output-format` / `--skip-trust`, which `agy` rejects)
 *
 * If these assertions fail, DO NOT "fix" them by reverting to gemini — fix the
 * provider so it uses Antigravity again.
 * ============================================================================
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
}));

import { spawn, execFile } from 'child_process';
import { EventEmitter } from 'events';
import { GeminiCLIProvider } from '../gemini-cli-provider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __tests__ lives in providers/src/__tests__ → package root is two levels up.
const PROVIDERS_ROOT = join(__dirname, '..', '..');
const CLI_ROOT = join(PROVIDERS_ROOT, '..', '..');

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;
const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrivateAccess = any;

function createMockChild() {
  const child = new EventEmitter() as PrivateAccess;
  child.killed = false;
  child.pid = 4242;
  const stdout = new EventEmitter();
  const stderr = Object.assign(new EventEmitter(), { resume: vi.fn() });
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  child.kill = vi.fn(() => { child.killed = true; return true; });
  return child;
}

/** which/where resolves the requested binary name, --version returns a value. */
function mockBinary(name: string) {
  mockExecFile.mockImplementation(
    (_cmd: string, args: string[], optOrCb: PrivateAccess, cb?: PrivateAccess) => {
      if (typeof optOrCb === 'function') {
        if (args[0] === name) optOrCb(null, `/usr/local/bin/${name}\n`, '');
        else optOrCb(new Error('not found'), '', '');
      } else {
        cb!(null, '1.0.7', '');
      }
    },
  );
}

describe('gemini-cli provider — Antigravity (agy) DO-NOT-REVERT guard', () => {
  let provider: GeminiCLIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GeminiCLIProvider({
      config: { provider: 'gemini-cli', model: 'gemini-3.5-flash' },
      logger: noopLogger,
    });
  });

  afterEach(() => provider.destroy());

  it('resolves the `agy` binary via which/where (NEVER `gemini`)', async () => {
    mockBinary('agy');
    await provider.initialize();

    // The first execFile call is the binary lookup. Its args[0] is the binary name.
    const lookupCalls = mockExecFile.mock.calls.filter(
      (c: PrivateAccess) => Array.isArray(c[1]) && typeof c[2] === 'function',
    );
    expect(lookupCalls.length).toBeGreaterThan(0);
    const lookedUp = lookupCalls.map((c: PrivateAccess) => c[1][0]);
    expect(lookedUp).toContain('agy');
    expect(lookedUp).not.toContain('gemini');
  });

  it('does NOT resolve a binary when only `gemini` is present (dead binary)', async () => {
    // Only `gemini` resolves; `agy` is absent → provider must treat as unavailable.
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], optOrCb: PrivateAccess, cb?: PrivateAccess) => {
        if (typeof optOrCb === 'function') {
          if (args[0] === 'gemini') optOrCb(null, '/opt/homebrew/bin/gemini\n', '');
          else optOrCb(new Error('not found'), '', '');
        } else {
          cb!(new Error('not found'), '', '');
        }
      },
    );
    await provider.initialize();
    // ensureBinary throws ProviderUnavailableError when no agy binary was found.
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/agy|Antigravity/i);
  });

  it('builds Antigravity headless args, never the dead gemini flags', async () => {
    mockBinary('agy');
    await provider.initialize();

    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    provider.complete({ messages: [{ role: 'user', content: 'guard prompt' }] });

    const argv = mockSpawn.mock.calls[0][1] as string[];
    // Must use Antigravity headless auto-approve + prompt + model.
    expect(argv).toContain('--dangerously-skip-permissions');
    expect(argv).toContain('--prompt');
    expect(argv).toContain('--model');
    expect(argv[argv.indexOf('--model') + 1]).toBe('gemini-3.5-flash');
    // Must NOT use the dead gemini flags that cause the 404 regression.
    expect(argv).not.toContain('--output-format');
    expect(argv).not.toContain('--skip-trust');

    child.stdout.emit('data', Buffer.from('OK'));
    child.emit('close', 0);
  });

  it('parses plain-text output from agy (no JSON) as content', async () => {
    mockBinary('agy');
    await provider.initialize();

    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const completePromise = provider.complete({
      messages: [{ role: 'user', content: 'say hi' }],
    });

    // agy -p emits PLAIN TEXT, not JSON.
    child.stdout.emit('data', Buffer.from('Hello from Antigravity'));
    child.emit('close', 0);

    const result = await completePromise;
    expect(result.content).toBe('Hello from Antigravity');
    expect(result.provider).toBe('gemini-cli');
  });
});

/**
 * ============================================================================
 * STATIC SOURCE-SURFACE GUARD — no `gemini-cli` → `gemini` binary map anywhere.
 *
 * Beyond the provider's findBinary(), several auxiliary surfaces (the agentic
 * wrapper, provider setup script, and provider status hook) historically mapped
 * the `gemini-cli` provider to the DEAD `gemini` executable. A stale
 * `/opt/homebrew/bin/gemini` on PATH means any such residual map silently
 * resolves the wrong (404-ing) CLI. This guard greps the source files OFFLINE
 * (no agy/gemini ever spawned) and fails if a `gemini-cli` provider is wired to
 * the literal `gemini` binary. It must always point at ANTIGRAVITY (`agy`).
 * ============================================================================
 */
describe('gemini-cli binary-surface guard (static / offline)', () => {
  /** Strip line/block comments so DO-NOT-REVERT notes (which name `gemini`) don't trip the grep. */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l)) // line + jsdoc-continuation
      .join('\n');
  }

  function readSource(relPath: string): string {
    return stripComments(readFileSync(join(PROVIDERS_ROOT, relPath), 'utf-8'));
  }

  function readCliSource(relPath: string): string {
    return stripComments(readFileSync(join(CLI_ROOT, relPath), 'utf-8'));
  }

  it('agentic-wrapper resolves agy for gemini-cli, never the dead gemini binary', () => {
    const src = readSource(join('src', 'agentic-wrapper.ts'));
    // The gemini-cli binary resolution list must be ['agy'] (not ['gemini']).
    expect(src).toMatch(/'gemini-cli':\s*\['agy'\]/);
    expect(src).not.toMatch(/'gemini-cli':\s*\[\s*'gemini'/);
  });

  it('provider setup script maps gemini-cli to agy, never gemini', () => {
    const src = readSource(join('scripts', 'setup-provider-agents.ts'));
    expect(src).toMatch(/name:\s*'gemini-cli',\s*binary:\s*'agy'/);
    expect(src).not.toMatch(/name:\s*'gemini-cli',\s*binary:\s*'gemini'/);
  });

  it('provider hook runtime maps gemini-cli to agy, never gemini', () => {
    const src = readCliSource(join('src', 'commands', 'provider-hook-runtime.ts'));
    expect(src).toMatch(/name:\s*'gemini-cli',\s*binary:\s*'agy'/);
    expect(src).not.toMatch(/name:\s*'gemini-cli',\s*binary:\s*'gemini'/);
  });

  it('provider auth guidance points agents at agy, not the dead gemini OAuth path', () => {
    const src = readSource(join('scripts', 'provider-auth-helpers.mjs'));
    expect(src).toContain('Run/repair agy in a real terminal or the Antigravity app');
    expect(src).not.toMatch(/Run gemini|oauth_creds|~\/\.gemini/);
  });

  it('no providers source file wires a gemini-cli provider to the literal `gemini` binary', () => {
    // Belt-and-suspenders across every known binary-resolution surface. If a new
    // surface adds `gemini-cli -> gemini`, this fails so it cannot silently revert.
    const surfaces = [
      { label: 'providers/src/agentic-wrapper.ts', src: readSource(join('src', 'agentic-wrapper.ts')) },
      { label: 'providers/scripts/setup-provider-agents.ts', src: readSource(join('scripts', 'setup-provider-agents.ts')) },
      { label: 'cli/src/commands/provider-hook-runtime.ts', src: readCliSource(join('src', 'commands', 'provider-hook-runtime.ts')) },
    ];
    for (const { label, src } of surfaces) {
      // Forbid: a gemini-cli entry whose binary/resolution is the bare `gemini`.
      expect(src, `${label} must not map gemini-cli to the dead 'gemini' binary`).not.toMatch(
        /'gemini-cli':\s*\[\s*'gemini'|name:\s*'gemini-cli',\s*binary:\s*'gemini'/,
      );
    }
  });
});
