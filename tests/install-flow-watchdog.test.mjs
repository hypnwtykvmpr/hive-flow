// hive-flow-8b69 (Option B, Slice 2): the install/generation path must copy the
// tracked canonical source to the runtime location idempotently, atomically, and
// project-root-aware, writing ONLY untracked runtime state under
// `.hive-flow/data/tmux-router/`.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const INSTALLER = join(here, '..', 'scripts', 'install-flow-watchdog.cjs');
const CANONICAL = join(here, '..', 'scripts', 'flow-watchdog.cjs');
const requireInstaller = createRequire(pathToFileURL(INSTALLER));
const { installFlowWatchdog, RUNTIME_REL } = requireInstaller(INSTALLER);

const RUNTIME_REL_EXPECTED = join('.hive-flow', 'data', 'tmux-router', 'flow-watchdog.cjs');

function listFilesRecursive(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(relative(root, p));
    }
  };
  walk(root);
  return out.sort();
}

describe('install-flow-watchdog (hive-flow-8b69 Slice 2)', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'flow-watchdog-install-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('exposes the expected runtime-relative path', () => {
    assert.equal(RUNTIME_REL, RUNTIME_REL_EXPECTED);
  });

  it('creates the runtime copy byte-identical to the canonical source', () => {
    const res = installFlowWatchdog({ projectRoot: root });
    assert.equal(res.changed, true);
    assert.equal(res.reason, 'created');
    const target = join(root, RUNTIME_REL_EXPECTED);
    assert.ok(existsSync(target), 'runtime copy should exist');
    assert.ok(readFileSync(target).equals(readFileSync(CANONICAL)), 'runtime copy equals canonical bytes');
  });

  it('creates missing parent directories', () => {
    const targetDir = dirname(join(root, RUNTIME_REL_EXPECTED));
    assert.ok(!existsSync(targetDir), 'target dir absent before install');
    installFlowWatchdog({ projectRoot: root });
    assert.ok(existsSync(targetDir), 'target dir created by install');
  });

  it('writes ONLY the runtime copy under .hive-flow/data/tmux-router/, no temp leftovers', () => {
    installFlowWatchdog({ projectRoot: root });
    assert.deepEqual(listFilesRecursive(root), [RUNTIME_REL_EXPECTED], 'only the runtime copy is written');
    const targetDir = dirname(join(root, RUNTIME_REL_EXPECTED));
    const stray = readdirSync(targetDir).filter((n) => n.endsWith('.tmp') || n.startsWith('.flow-watchdog.cjs.'));
    assert.deepEqual(stray, [], 'no temp files left behind (atomic temp+rename cleaned up)');
  });

  it('is idempotent: a second run makes no change', () => {
    assert.equal(installFlowWatchdog({ projectRoot: root }).changed, true);
    const second = installFlowWatchdog({ projectRoot: root });
    assert.equal(second.changed, false);
    assert.equal(second.reason, 'already up to date');
    const target = join(root, RUNTIME_REL_EXPECTED);
    assert.ok(readFileSync(target).equals(readFileSync(CANONICAL)));
    assert.deepEqual(listFilesRecursive(root), [RUNTIME_REL_EXPECTED], 'still exactly one file after re-run');
  });

  it('regenerates when the runtime copy has drifted or is corrupt', () => {
    installFlowWatchdog({ projectRoot: root });
    const target = join(root, RUNTIME_REL_EXPECTED);
    writeFileSync(target, '// tampered runtime copy\n');
    const res = installFlowWatchdog({ projectRoot: root });
    assert.equal(res.changed, true);
    assert.equal(res.reason, 'regenerated');
    assert.ok(readFileSync(target).equals(readFileSync(CANONICAL)), 'drifted copy restored to canonical bytes');
  });
});
