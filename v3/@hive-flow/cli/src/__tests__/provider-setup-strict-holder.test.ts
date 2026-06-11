import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  inspectProviderSetup,
  writeProviderCredentialReferences,
} from '../commands/setup.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hive-flow-provider-setup-'));
  roots.push(root);
  return root;
}

const noGemini = () => ({ ok: false });

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('provider setup strict API credential holder boundary', () => {
  it('ignores ambient OpenRouter env and does not write env credential references', async () => {
    const root = makeRoot();
    const report = await inspectProviderSetup({
      cwd: root,
      env: { OPENROUTER_API_KEY: 'or-secret-that-must-not-be-used' },
      versionRunner: noGemini,
      holderStatus: { available: false, socketPath: '/tmp/missing.sock', reason: 'missing' },
    });

    expect(report.providers.openrouter.configured).toBe(false);
    expect(report.providers.openrouter.action).toMatch(/credential holder/i);
    expect(JSON.stringify(report)).not.toContain('or-secret-that-must-not-be-used');

    const configPath = writeProviderCredentialReferences(root, report);
    const configText = readFileSync(configPath, 'utf8');

    expect(configText).not.toContain('OPENROUTER_API_KEY');
    expect(configText).not.toContain('env:');
    expect(JSON.parse(configText).values.openrouter).toBeUndefined();
  });

  it('writes a non-secret holder reference when the credential holder is available', async () => {
    const root = makeRoot();
    const report = await inspectProviderSetup({
      cwd: root,
      env: {},
      versionRunner: noGemini,
      holderStatus: { available: true, socketPath: '/tmp/hive-flow-holder.sock' },
    });

    const configPath = writeProviderCredentialReferences(root, report);
    const configText = readFileSync(configPath, 'utf8');

    expect(JSON.parse(configText).values.openrouter).toEqual({
      credentialSource: 'holder:openrouter',
    });
    expect(configText).not.toContain('OPENROUTER_API_KEY');
    expect(configText).not.toContain('/tmp/hive-flow-holder.sock');
  });

  it('recognizes an existing holder reference without requiring env', async () => {
    const root = makeRoot();
    const first = await inspectProviderSetup({
      cwd: root,
      env: {},
      versionRunner: noGemini,
      holderStatus: { available: true },
    });
    writeProviderCredentialReferences(root, first);

    const second = await inspectProviderSetup({
      cwd: root,
      env: {},
      versionRunner: noGemini,
      holderStatus: { available: false, reason: 'not running during dry-run' },
    });

    expect(second.providers.openrouter).toMatchObject({
      configured: true,
      checks: {
        configReferencePresent: true,
      },
    });
  });

  it('never serializes OpenRouter env references across arbitrary ambient env values', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 80 }), async (secret) => {
        const root = makeRoot();
        const report = await inspectProviderSetup({
          cwd: root,
          env: { OPENROUTER_API_KEY: secret },
          versionRunner: noGemini,
          holderStatus: { available: false, reason: 'property-test unavailable' },
        });
        const configPath = writeProviderCredentialReferences(root, report);
        const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';

        expect(configText).not.toContain('OPENROUTER_API_KEY');
        expect(configText).not.toContain('env:');
      }),
      { numRuns: 50 },
    );
  });
});
