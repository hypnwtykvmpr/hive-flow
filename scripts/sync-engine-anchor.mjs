#!/usr/bin/env node
/**
 * Sync the complete enforcement engine into the @hive-flow/cli package anchor.
 *
 * This is intentionally build/global-install-time plumbing, not a publish hook:
 * npm publishing is not part of the current release path, but the installed CLI
 * still needs require.resolve('@hive-flow/cli/package.json') to point at a
 * complete, self-contained engine source.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliRoot = join(repoRoot, 'v3', '@hive-flow', 'cli');
const anchorDir = join(cliRoot, '.claude', 'helpers');
const packageJsonPath = join(cliRoot, 'package.json');

export const ENGINE_FILES = [
  ['.claude/helpers/enforcement.cjs', 'enforcement.cjs'],
  ['.claude/helpers/role-enforcement.cjs', 'role-enforcement.cjs'],
  ['.claude/helpers/hive-composition-gate.cjs', 'hive-composition-gate.cjs'],
  ['.claude/helpers/hook-handler.cjs', 'hook-handler.cjs'],
  ['.claude/helpers/settings-reconciler.cjs', 'settings-reconciler.cjs'],
  ['.claude/helpers/provider-tracker.cjs', 'provider-tracker.cjs'],
  ['v3/@hive-flow/cli/src/permission-guard/protected-paths.cjs', 'protected-paths.cjs'],
  ['v3/@hive-flow/cli/src/permission-guard/protected-paths.policy.json', 'protected-paths.policy.json'],
];

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function syncEngineAnchor(options = {}) {
  const root = resolve(options.repoRoot || repoRoot);
  const targetDir = resolve(options.anchorDir || anchorDir);
  mkdirSync(targetDir, { recursive: true });

  const files = [];
  for (const [sourceRel, targetName] of ENGINE_FILES) {
    const sourcePath = join(root, sourceRel);
    const targetPath = join(targetDir, targetName);
    copyFileSync(sourcePath, targetPath);
    files.push({
      name: targetName,
      sha256: sha256(targetPath),
    });
  }

  const packageJson = JSON.parse(readFileSync(join(root, 'v3', '@hive-flow', 'cli', 'package.json'), 'utf8'));
  const manifestPath = join(targetDir, '.engine-manifest.json');
  let syncedAt = new Date().toISOString();
  if (existsSync(manifestPath)) {
    try {
      const existing = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (
        existing.version === packageJson.version &&
        JSON.stringify(existing.files) === JSON.stringify(files) &&
        typeof existing.syncedAt === 'string'
      ) {
        syncedAt = existing.syncedAt;
      }
    } catch {
      // Rewrite malformed manifests with a fresh timestamp.
    }
  }
  const manifest = {
    syncedAt,
    version: packageJson.version,
    files,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncEngineAnchor();
  process.stdout.write(`Synced ${ENGINE_FILES.length} enforcement engine files to ${anchorDir}\n`);
}
