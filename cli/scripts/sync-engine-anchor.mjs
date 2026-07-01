#!/usr/bin/env node
/**
 * Sync the complete enforcement engine into the promoted hive-flow package anchor.
 *
 * This is intentionally build/global-install-time plumbing, not a publish hook:
 * npm publishing is not part of the current release path, but the installed CLI
 * still needs a complete, self-contained engine source.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findRepoRoot(startDir) {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, '.git')) && existsSync(join(current, 'cli', 'package.json'))) return current;

    const parent = dirname(current);
    if (parent === current) {
      throw new Error('[sync-engine-anchor] unable to locate Hive Flow repository root');
    }
    current = parent;
  }
}

const repoRoot = findRepoRoot(__dirname);
const cliRoot = join(repoRoot, 'cli');
const anchorDir = join(cliRoot, '.claude', 'helpers');
const packageJsonPath = join(cliRoot, 'package.json');

export const ENGINE_FILES = [
  ['.claude/helpers/layout-paths.cjs', 'layout-paths.cjs'],
  ['.claude/helpers/hive-flow-mcp-launcher.cjs', 'hive-flow-mcp-launcher.cjs'],
  ['.claude/helpers/enforcement.cjs', 'enforcement.cjs'],
  ['.claude/helpers/role-enforcement.cjs', 'role-enforcement.cjs'],
  ['.claude/helpers/hive-composition-gate.cjs', 'hive-composition-gate.cjs'],
  ['.claude/helpers/hook-handler.cjs', 'hook-handler.cjs'],
  ['.claude/helpers/settings-reconciler.cjs', 'settings-reconciler.cjs'],
  ['.claude/helpers/provider-tracker.cjs', 'provider-tracker.cjs'],
  ['.claude/helpers/client-kind.cjs', 'client-kind.cjs'],
  ['.claude/helpers/session-id.cjs', 'session-id.cjs'],
  ['.claude/helpers/statusline.cjs', 'statusline.cjs'],
  ['cli/src/permission-guard/protected-paths.cjs', 'protected-paths.cjs'],
  ['cli/src/permission-guard/protected-paths.policy.json', 'protected-paths.policy.json'],
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

  const packageJson = JSON.parse(readFileSync(join(root, 'cli', 'package.json'), 'utf8'));
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
