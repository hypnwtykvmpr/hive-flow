import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { platform } from 'node:process';
import {
  findProtectedReadPath,
  findProtectedWritePath,
  getProtectedWriteScope,
  isDevOverrideFloorPath,
  isGuardedSettingsPath,
  isProtectedReadPath,
  isProtectedWritePath,
  loadPolicy,
  sanitizeScopeId,
} from '../protected-paths.js';

const require = createRequire(import.meta.url);
const cjsPolicy = require('../protected-paths.cjs') as typeof import('../protected-paths.js');

function tmpProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'protected-paths-policy-'));
  mkdirSync(join(root, '.claude', 'helpers'), { recursive: true });
  mkdirSync(join(root, '.hive-flow', 'enforcement'), { recursive: true });
  writeFileSync(join(root, '.claude', 'settings.json'), '{}');
  writeFileSync(join(root, '.claude', 'settings.local.json'), '{}');
  writeFileSync(join(root, '.hive-flow', 'enforcement', '.hmac-key'), 'secret');
  writeFileSync(join(root, '.hive-flow', 'enforcement', 'state.json'), '{}');
  writeFileSync(join(root, '.env'), 'OPENROUTER_API_KEY=x');
  return root;
}

describe('shared protected-path policy matcher', () => {
  it('protects settings.local.json in both TS and CJS matchers', () => {
    const root = tmpProject();
    try {
      const target = join(root, '.claude', 'settings.local.json');
      expect(isProtectedWritePath(target, root)).toBe(true);
      expect(cjsPolicy.isProtectedWritePath(target, root)).toBe(true);
      expect(getProtectedWriteScope(target, root)).toBe('global');
      expect(cjsPolicy.getProtectedWriteScope(target, root)).toBe('global');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('tracks guarded settings paths in both the embedded and on-disk policies', () => {
    const root = tmpProject();
    try {
      const policy = loadPolicy();
      for (const entry of [
        '.claude/settings.json',
        '.claude/settings.local.json',
        '${HOME}/.claude/settings.json',
        '${HOME}/.claude/settings.local.json',
      ]) {
        expect(policy.guardedSettings).toContain(entry);
      }
      for (const target of [
        join(root, '.claude', 'settings.json'),
        join(root, '.claude', 'settings.local.json'),
        join(homedir(), '.claude', 'settings.json'),
        join(homedir(), '.claude', 'settings.local.json'),
      ]) {
        expect(isGuardedSettingsPath(target, root)).toBe(true);
        expect(cjsPolicy.isGuardedSettingsPath(target, root)).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('protects relocated user-level enforcement bin and Claude trigger paths', () => {
    const root = tmpProject();
    try {
      for (const target of [
        join(homedir(), '.claude', 'settings.json'),
        join(homedir(), '.claude', 'settings.local.json'),
        join(homedir(), '.hive-flow', 'enforcement', 'bin', 'enforcement.cjs'),
      ]) {
        expect(isProtectedWritePath(target, root)).toBe(true);
        expect(cjsPolicy.isProtectedWritePath(target, root)).toBe(true);
        expect(getProtectedWriteScope(target, root)).toBe('global');
        expect(cjsPolicy.getProtectedWriteScope(target, root)).toBe('global');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('protects relocated user-level enforcement state, ledger, pipeline, and key paths', () => {
    const root = tmpProject();
    try {
      for (const target of [
        join(homedir(), '.hive-flow', 'enforcement', 'global', 'state.json'),
        join(homedir(), '.hive-flow', 'enforcement', 'global', 'denial-ledger.json'),
        join(homedir(), '.hive-flow', 'enforcement', 'pipeline-state.json'),
        join(homedir(), '.hive-flow', 'enforcement', '.hmac-key'),
      ]) {
        expect(isProtectedWritePath(target, root), target).toBe(true);
        expect(cjsPolicy.isProtectedWritePath(target, root), target).toBe(true);
        expect(getProtectedWriteScope(target, root), target).toBe('global');
        expect(cjsPolicy.getProtectedWriteScope(target, root), target).toBe('global');
        expect(isProtectedReadPath(target, root), target).toBe(true);
        expect(cjsPolicy.isProtectedReadPath(target, root), target).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('protects credential vault wildcard entries in both TS and CJS matchers', () => {
    const root = tmpProject();
    try {
      for (const target of [
        join(homedir(), '.hive-flow', 'credential-vault.json.gcm'),
        join(homedir(), '.hive-flow', 'credential-vault.sqlite.gcm'),
        join(homedir(), '.hive-flow', 'credentials', 'openrouter.json'),
        join(homedir(), '.hive-flow', 'credentials-v2.json'),
        join(homedir(), '.hive-flow', 'run', 'credential-holder.sock'),
      ]) {
        expect(isProtectedWritePath(target, root), target).toBe(true);
        expect(cjsPolicy.isProtectedWritePath(target, root), target).toBe(true);
        expect(isProtectedReadPath(target, root), target).toBe(true);
        expect(cjsPolicy.isProtectedReadPath(target, root), target).toBe(true);
        expect(getProtectedWriteScope(target, root), target).toBe('global');
        expect(cjsPolicy.getProtectedWriteScope(target, root), target).toBe('global');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('protects the relocation installer script itself', () => {
    const root = tmpProject();
    try {
      const target = join(root, 'scripts', 'install-enforcement.mjs');
      expect(isProtectedWritePath(target, root)).toBe(true);
      expect(cjsPolicy.isProtectedWritePath(target, root)).toBe(true);
      expect(getProtectedWriteScope(target, root)).toBe('global');
      expect(cjsPolicy.getProtectedWriteScope(target, root)).toBe('global');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses exact and directory-boundary matching, not substring matching', () => {
    const root = tmpProject();
    try {
      expect(findProtectedWritePath(join(root, '.claude', 'settings.json.bak'), root)).toBeNull();
      expect(findProtectedWritePath(join(root, '.claude', 'settings.local.json.bak'), root)).toBeNull();
      expect(findProtectedReadPath(join(root, '.env.example'), root)).toBeNull();
      expect(findProtectedReadPath(join(root, '.hive-flow', 'enforcement-old', 'state.json'), root)).toBeNull();
      expect(findProtectedReadPath(join(root, '.hive-flow', 'enforcement', 'state.json'), root)).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('follows symlink leaves for read protection', () => {
    if (platform === 'win32') return;
    const root = tmpProject();
    try {
      mkdirSync(join(root, 'tmp'), { recursive: true });
      symlinkSync(join(root, '.hive-flow', 'enforcement', '.hmac-key'), join(root, 'tmp', 'key-link'));
      expect(isProtectedReadPath(join(root, 'tmp', 'key-link'), root)).toBe(true);
      expect(cjsPolicy.isProtectedReadPath(join(root, 'tmp', 'key-link'), root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the dev-override absolute floor above protected-write grants', () => {
    const root = tmpProject();
    try {
      expect(isDevOverrideFloorPath(join(root, '.hive-flow', 'enforcement', 'dev-override.conf'), root)).toBe(true);
      expect(isDevOverrideFloorPath(join(homedir(), '.hive-flow', 'enforcement', 'dev-override.conf'), root)).toBe(true);
      expect(isDevOverrideFloorPath(join(homedir(), '.hive-flow', 'enforcement', 'global', 'state.json'), root)).toBe(true);
      expect(isDevOverrideFloorPath(join(root, '.claude', 'helpers', 'enforcement.cjs'), root)).toBe(true);
      expect(isDevOverrideFloorPath(join(root, '.git', 'info', 'exclude'), root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('standardizes scope ids with the whitelist sanitizer', () => {
    expect(sanitizeScopeId('worker/../α + beta', '', 64)).toBe('worker_beta');
    expect(cjsPolicy.sanitizeScopeId('worker/../alpha + beta', '', 64)).toBe('worker_alpha_beta');
  });
});
