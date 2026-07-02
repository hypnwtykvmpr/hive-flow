#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// install-flow-watchdog — idempotent install/generation path (hive-flow-8b69, Slice 2)
//
// Generates the LIVE runtime copy of the flow-watchdog by copying the tracked
// canonical source (`scripts/flow-watchdog.cjs`, alongside this installer) to
// `<projectRoot>/.hive-flow/data/tmux-router/flow-watchdog.cjs`.
//
// Contract:
//   - Project-root aware: the target root is derived from THIS file's location
//     (`<root>/scripts/` → `<root>`), never from an absolute machine path or a
//     brittle cwd. Overridable via `--project-root <path>` or
//     `HIVE_FLOW_PROJECT_ROOT` (used by tests and non-standard checkouts).
//   - Idempotent: if the runtime copy already equals the canonical bytes, it does
//     nothing (reports `already up to date`); re-running never duplicates or errors.
//   - Atomic: writes to a uniquely-named temp file IN THE TARGET DIR, then
//     `rename()`s it over the target (atomic on the same filesystem). The temp file
//     is always cleaned up.
//   - Writes ONLY untracked runtime state under `.hive-flow/data/tmux-router/`
//     (the whole `.hive-flow/` tree is git-ignored). Never writes tracked files.
//
// The generated runtime copy is byte-for-byte the canonical source (including the
// canonical's provenance header). The header is an inert comment and does not
// change runtime semantics.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Canonical tracked source lives alongside this installer in `scripts/`. */
const CANONICAL_PATH = path.join(__dirname, 'flow-watchdog.cjs');
/** Runtime copy location, relative to the project root. */
const RUNTIME_REL = path.join('.hive-flow', 'data', 'tmux-router', 'flow-watchdog.cjs');
/** Default project root: the parent of `scripts/` (i.e. the repo root). */
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Install (generate) the runtime flow-watchdog copy from the tracked canonical
 * source. Pure w.r.t. the tracked tree — only ever writes under
 * `<projectRoot>/.hive-flow/data/tmux-router/`.
 *
 * @returns {{ projectRoot: string, canonicalPath: string, targetPath: string,
 *             changed: boolean, reason: 'already up to date'|'created'|'regenerated' }}
 */
function installFlowWatchdog(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || DEFAULT_PROJECT_ROOT);
  const canonicalPath = path.resolve(options.canonicalPath || CANONICAL_PATH);

  let canonical;
  try {
    canonical = fs.readFileSync(canonicalPath); // Buffer — byte-faithful copy.
  } catch (err) {
    throw new Error(`canonical source not readable at ${canonicalPath}: ${err && err.message ? err.message : err}`);
  }

  const targetPath = path.join(projectRoot, RUNTIME_REL);
  const targetDir = path.dirname(targetPath);

  // Idempotent: skip the write when the runtime copy already matches the canonical.
  let existing = null;
  try {
    existing = fs.readFileSync(targetPath);
  } catch {
    existing = null; // absent — will be created.
  }
  if (existing && existing.equals(canonical)) {
    return { projectRoot, canonicalPath, targetPath, changed: false, reason: 'already up to date' };
  }

  fs.mkdirSync(targetDir, { recursive: true });

  // Atomic temp+rename in the target dir (same filesystem → rename is atomic).
  const tmpPath = path.join(targetDir, `.flow-watchdog.cjs.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmpPath, canonical, { mode: 0o755 });
    fs.renameSync(tmpPath, targetPath); // atomically replaces any existing target.
  } finally {
    // If rename succeeded the temp is gone; otherwise remove the partial temp.
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* nothing to clean */ }
  }

  return {
    projectRoot,
    canonicalPath,
    targetPath,
    changed: true,
    reason: existing ? 'regenerated' : 'created',
  };
}

/** Resolve the project root from CLI args / env, defaulting to the repo root. */
function resolveCliProjectRoot(argv, env = process.env) {
  const flagIdx = argv.indexOf('--project-root');
  if (flagIdx !== -1 && typeof argv[flagIdx + 1] === 'string' && argv[flagIdx + 1].trim()) {
    return path.resolve(argv[flagIdx + 1].trim());
  }
  if (typeof env.HIVE_FLOW_PROJECT_ROOT === 'string' && env.HIVE_FLOW_PROJECT_ROOT.trim()) {
    return path.resolve(env.HIVE_FLOW_PROJECT_ROOT.trim());
  }
  return DEFAULT_PROJECT_ROOT;
}

module.exports = {
  installFlowWatchdog,
  resolveCliProjectRoot,
  CANONICAL_PATH,
  RUNTIME_REL,
  DEFAULT_PROJECT_ROOT,
};

if (require.main === module) {
  try {
    const projectRoot = resolveCliProjectRoot(process.argv.slice(2));
    const result = installFlowWatchdog({ projectRoot });
    process.stdout.write(`[install-flow-watchdog] ${result.reason}: ${result.targetPath}\n`);
  } catch (err) {
    process.stderr.write(`[install-flow-watchdog] failed: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
