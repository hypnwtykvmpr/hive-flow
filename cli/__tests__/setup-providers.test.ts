import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  inspectProviderSetup,
  setupCommand,
  writeProviderCredentialReferences,
} from '../src/commands/setup.js';
import { commands, getCommand } from '../src/commands/index.js';
import type { CommandContext } from '../src/types.js';

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hf-provider-setup-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('setup providers', () => {
  it('is exposed as an installable setup subcommand', () => {
    expect(setupCommand.subcommands?.some(c => c.name === 'providers')).toBe(true);
  });

  it('registers setup synchronously so setup providers is not parsed as top-level providers', () => {
    expect(commands.some(c => c.name === 'setup')).toBe(true);
    expect(getCommand('setup')?.subcommands?.some(c => c.name === 'providers')).toBe(true);
  });

  it('detects Antigravity agy and treats ambient OpenRouter env as a legacy ignored signal (holder-governed)', async () => {
    const cwd = tempDir();
    const checkedBins: string[] = [];

    // Strict-provider security contract: OPENROUTER_API_KEY in the ambient env is
    // a STRICT API provider credential and must NOT configure the provider. Only
    // an available credential holder (or a non-secret config reference) does.
    // Here the holder is unavailable, so openrouter is NOT configured and the
    // env presence is recorded only as a legacy-ignored signal.
    const report = await inspectProviderSetup({
      cwd,
      env: { OPENROUTER_API_KEY: 'or-secret-value' },
      versionRunner: (bin) => {
        checkedBins.push(bin);
        return bin === 'agy' ? { ok: true, version: 'agy version 1.2.3' } : { ok: false };
      },
      holderStatus: { available: false, socketPath: '/tmp/missing.sock', reason: 'missing' },
    });

    // OpenRouter env is NOT a credential boundary — it must not mark configured.
    expect(report.providers.openrouter.configured).toBe(false);
    expect(report.providers.openrouter.checks.legacyEnvPresentIgnored).toBe(true);
    expect(report.providers.openrouter.checks.credentialHolderAvailable).toBe(false);
    expect(report.providers.openrouter.action).toMatch(/credential holder/i);
    // Antigravity is configured when agy exists; cached OAuth is verified by the live worker canary.
    expect(report.providers.gemini.configured).toBe(true);
    expect(report.providers.gemini.checks.binary).toBe('agy');
    expect(report.providers.gemini.checks.authVerification).toBe('live-agent-task-required');
    expect(checkedBins).toContain('agy');
    expect(checkedBins).not.toContain('gemini');
    // The raw secret must never appear anywhere in the serialized report.
    expect(JSON.stringify(report)).not.toContain('or-secret-value');
  });

  it('writes only non-secret credential references to project config (holder reference, never env secret)', async () => {
    const cwd = tempDir();

    // With the credential holder available, OpenRouter is configured via the
    // holder. The persisted credential reference is the non-secret holder
    // pointer — never the ambient env key (which the holder owns instead).
    const report = await inspectProviderSetup({
      cwd,
      env: { OPENROUTER_API_KEY: 'or-secret-value' },
      versionRunner: (bin) => bin === 'agy'
        ? { ok: true, version: 'agy version 1.2.3' }
        : { ok: false },
      holderStatus: { available: true, socketPath: '/tmp/hive-flow-holder.sock' },
    });
    const configPath = writeProviderCredentialReferences(cwd, report);
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);

    // SECURITY INVARIANT: the secret and any env-based reference must never be
    // written to project config — only the holder pointer.
    expect(raw).not.toContain('or-secret-value');
    expect(raw).not.toContain('env:OPENROUTER_API_KEY');
    expect(raw).not.toContain('~/.gemini/oauth_creds.json');
    expect(parsed.values.openrouter.credentialSource).toBe('holder:openrouter');
    expect(parsed.values.gemini.credentialSource).toBe('antigravity-oauth:agy');
  });

  it('prints only parseable JSON in --format json mode', async () => {
    const cwd = tempDir();
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      const providers = setupCommand.subcommands?.find(command => command.name === 'providers');
      expect(providers?.action).toBeTypeOf('function');

      await providers?.action?.({
        cwd,
        args: [],
        flags: { format: 'json' },
      } as CommandContext);
    } finally {
      stdout.mockRestore();
    }

    const text = writes.join('').trim();
    const parsed = JSON.parse(text);
    expect(parsed.providers.openrouter.provider).toBe('openrouter');
    expect(text).not.toContain('Provider Setup');
    expect(text).not.toContain('action needed');
  });
});
