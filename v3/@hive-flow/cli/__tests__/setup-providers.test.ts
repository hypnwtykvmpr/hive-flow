import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('detects OpenRouter env and Gemini OAuth without exposing secret values', () => {
    const cwd = tempDir();
    const homeDir = tempDir();
    mkdirSync(join(homeDir, '.gemini'), { recursive: true });
    writeFileSync(join(homeDir, '.gemini', 'oauth_creds.json'), '{}\n', 'utf8');

    const report = inspectProviderSetup({
      cwd,
      homeDir,
      env: { OPENROUTER_API_KEY: 'or-secret-value' },
      versionRunner: () => ({ ok: true, version: 'Gemini CLI 1.2.3' }),
    });

    expect(report.providers.openrouter.configured).toBe(true);
    expect(report.providers.openrouter.checks.envPresent).toBe(true);
    expect(report.providers.gemini.configured).toBe(true);
    expect(report.providers.gemini.checks.oauthPresent).toBe(true);
    expect(JSON.stringify(report)).not.toContain('or-secret-value');
  });

  it('writes only non-secret credential references to project config', () => {
    const cwd = tempDir();
    const homeDir = tempDir();
    mkdirSync(join(homeDir, '.gemini'), { recursive: true });
    writeFileSync(join(homeDir, '.gemini', 'oauth_creds.json'), '{}\n', 'utf8');

    const report = inspectProviderSetup({
      cwd,
      homeDir,
      env: { OPENROUTER_API_KEY: 'or-secret-value' },
      versionRunner: () => ({ ok: true, version: 'Gemini CLI 1.2.3' }),
    });
    const configPath = writeProviderCredentialReferences(cwd, report);
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);

    expect(raw).not.toContain('or-secret-value');
    expect(parsed.values.openrouter.credentialSource).toBe('env:OPENROUTER_API_KEY');
    expect(parsed.values.gemini.credentialSource).toBe('oauth:~/.gemini/oauth_creds.json');
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
