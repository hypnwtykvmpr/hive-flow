#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function addUnique(list, seen, candidate) {
  if (!candidate || typeof candidate !== 'string') return;
  const resolved = path.resolve(candidate);
  if (seen.has(resolved)) return;
  seen.add(resolved);
  list.push(resolved);
}

function projectRootCandidates(options = {}) {
  const env = options.env || process.env;
  const helperDir = options.helperDir || __dirname;
  const cwd = options.cwd || process.cwd();
  const list = [];
  const seen = new Set();

  addUnique(list, seen, env.HIVE_FLOW_PROJECT_ROOT);
  addUnique(list, seen, env.CLAUDE_PROJECT_DIR);
  addUnique(list, seen, cwd);
  addUnique(list, seen, path.resolve(helperDir, '..', '..'));

  let current = path.resolve(helperDir);
  for (let depth = 0; depth < 8; depth += 1) {
    addUnique(list, seen, current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return list;
}

function hiveFlowCliRootCandidates(options = {}) {
  const roots = projectRootCandidates(options);
  const list = [];
  const seen = new Set();

  for (const root of roots) {
    addUnique(list, seen, path.join(root, 'cli'));
    if (path.basename(root) === 'cli') addUnique(list, seen, root);
  }

  return list;
}

function resolveHiveFlowCliFile(relativePath, options = {}) {
  for (const cliRoot of hiveFlowCliRootCandidates(options)) {
    const candidate = path.join(cliRoot, relativePath);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function requireHiveFlowCliFile(relativePath, options = {}) {
  const resolved = resolveHiveFlowCliFile(relativePath, options);
  if (resolved) return resolved;
  const tried = hiveFlowCliRootCandidates(options).map((root) => path.join(root, relativePath));
  throw new Error(`Hive Flow CLI artifact not found for ${relativePath}; tried: ${tried.join(', ')}`);
}

function loadProtectedPathPolicyModule(options = {}) {
  const localHelper = path.join(options.helperDir || __dirname, 'protected-paths.cjs');
  const candidates = [
    ...hiveFlowCliRootCandidates(options).map((root) => path.join(root, 'src', 'permission-guard', 'protected-paths.cjs')),
    localHelper,
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return require(candidate);
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(`Hive Flow protected-paths policy not found; tried: ${candidates.join(', ')}`);
}

module.exports = {
  hiveFlowCliRootCandidates,
  loadProtectedPathPolicyModule,
  projectRootCandidates,
  requireHiveFlowCliFile,
  resolveHiveFlowCliFile,
};
