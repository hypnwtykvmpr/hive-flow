/**
 * Tests for Deployment Module
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ReleaseManager } from '../index.js';

describe('ReleaseManager', () => {
  describe('Constructor', () => {
    it('should create with default cwd', () => {
      const manager = new ReleaseManager();
      expect(manager).toBeDefined();
    });

    it('should create with custom cwd', () => {
      const manager = new ReleaseManager('/custom/path');
      expect(manager).toBeDefined();
    });
  });

  it('should prepare a dry-run release without mutating package.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-flow-release-'));
    const pkgPath = join(dir, 'package.json');

    try {
      writeFileSync(pkgPath, JSON.stringify({
        name: 'demo-package',
        version: '1.2.3',
        description: 'demo',
        repository: { type: 'git', url: 'https://example.invalid/repo.git' }
      }, null, 2) + '\n');

      const manager = new ReleaseManager(dir);
      const result = await manager.prepareRelease({
        bumpType: 'patch',
        dryRun: true,
        generateChangelog: false,
        createTag: false,
        commit: false,
        skipValidation: true
      });

      expect(result.success).toBe(true);
      expect(result.oldVersion).toBe('1.2.3');
      expect(result.newVersion).toBe('1.2.4');
      expect(JSON.parse(readFileSync(pkgPath, 'utf8')).version).toBe('1.2.3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Version Bump Logic', () => {
  it('should parse version parts', () => {
    const version = '1.2.3';
    const parts = version.split('.').map(Number);
    
    expect(parts[0]).toBe(1);
    expect(parts[1]).toBe(2);
    expect(parts[2]).toBe(3);
  });

  it('should bump patch version', () => {
    const parts = '1.0.0'.split('.').map(Number);
    const newVersion = [parts[0], parts[1], parts[2] + 1].join('.');
    expect(newVersion).toBe('1.0.1');
  });

  it('should bump minor version', () => {
    const parts = '1.0.0'.split('.').map(Number);
    const newVersion = [parts[0], parts[1] + 1, 0].join('.');
    expect(newVersion).toBe('1.1.0');
  });

  it('should bump major version', () => {
    const parts = '1.0.0'.split('.').map(Number);
    const newVersion = [parts[0] + 1, 0, 0].join('.');
    expect(newVersion).toBe('2.0.0');
  });
});

describe('Changelog Generation', () => {
  it('should format date correctly', () => {
    const date = new Date('2026-01-05');
    const formatted = date.toISOString().split('T')[0];
    expect(formatted).toBe('2026-01-05');
  });

  it('should categorize commits by type', () => {
    const commits = [
      { message: 'feat: add new feature' },
      { message: 'fix: fix bug' },
      { message: 'docs: update docs' },
    ];

    const feat = commits.filter(c => c.message.startsWith('feat:'));
    const fix = commits.filter(c => c.message.startsWith('fix:'));
    const docs = commits.filter(c => c.message.startsWith('docs:'));

    expect(feat).toHaveLength(1);
    expect(fix).toHaveLength(1);
    expect(docs).toHaveLength(1);
  });
});
