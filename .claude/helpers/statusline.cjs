#!/usr/bin/env node
/**
 * Hive Flow statusline compatibility launcher.
 *
 * This file intentionally does not collect status data. It delegates to the
 * canonical @hive-flow/cli bin/statusline.js renderer so existing
 * "node .claude/helpers/statusline.cjs" settings keep working without a
 * second, stale statusboard implementation.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EMBEDDED_STATUSLINE_ENTRYPOINT = '';

function readStdin() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function parents(start) {
  const out = [];
  let current = path.resolve(start || process.cwd());
  for (let i = 0; i < 12; i++) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

function addCandidate(list, seen, candidate) {
  if (!candidate || typeof candidate !== 'string') return;
  const normalized = path.resolve(candidate);
  if (seen.has(normalized)) return;
  seen.add(normalized);
  list.push(normalized);
}

function statuslineCandidates() {
  const list = [];
  const seen = new Set();
  addCandidate(list, seen, EMBEDDED_STATUSLINE_ENTRYPOINT);
  addCandidate(list, seen, process.env.HIVE_FLOW_STATUSLINE_BIN);

  const roots = [
    process.cwd(),
    __dirname,
    ...parents(process.cwd()),
    ...parents(__dirname),
  ];

  for (const root of roots) {
    addCandidate(list, seen, path.join(root, 'cli', 'bin', 'statusline.js'));
    addCandidate(list, seen, path.join(root, 'v3', '@hive-flow', 'cli', 'bin', 'statusline.js'));
    addCandidate(list, seen, path.join(root, 'bin', 'statusline.js'));
    addCandidate(list, seen, path.join(root, 'node_modules', '@hive-flow', 'cli', 'bin', 'statusline.js'));
    addCandidate(list, seen, path.join(root, 'node_modules', 'hive-flow', 'v3', '@hive-flow', 'cli', 'bin', 'statusline.js'));
  }

  const hiveFlowHome = process.env.HIVE_FLOW_HOME || path.join(os.homedir(), '.hive-flow');
  addCandidate(
    list,
    seen,
    path.join(hiveFlowHome, 'bin', process.platform === 'win32' ? 'claude-code-statusline.cmd' : 'claude-code-statusline'),
  );
  return list.filter(fileExists);
}

function invoke(candidate, input) {
  const forwardedArgs = process.argv.slice(2);
  let command = candidate;
  let args = forwardedArgs;

  if (/\.m?js$/i.test(candidate)) {
    command = process.execPath;
    args = [candidate, ...forwardedArgs];
  } else if (process.platform === 'win32' && /\.cmd$/i.test(candidate)) {
    command = process.env.ComSpec || 'cmd.exe';
    args = ['/d', '/s', '/c', candidate, ...forwardedArgs];
  }

  return spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, HIVE_FLOW_STATUSLINE_HELPER_DELEGATED: '1' },
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}

function main() {
  const input = readStdin();
  for (const candidate of statuslineCandidates()) {
    const result = invoke(candidate, input);
    if (result.error || result.status !== 0) continue;
    if (typeof result.stdout === 'string') {
      process.stdout.write(result.stdout);
    }
    return;
  }
  process.stdout.write('');
}

main();
