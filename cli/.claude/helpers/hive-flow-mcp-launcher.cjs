#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const { requireHiveFlowCliFile } = require('./layout-paths.cjs');
const { mintMCPAttestation } = require('./mcp-attestation.cjs');

let entrypoint;
// Prefer the exact entrypoint the generated wrapper verified, so the resolved
// path cannot differ from the one setup checked. The layout resolver remains as
// a compatibility fallback for wrappers generated before a541.
const explicit = process.env.HIVE_FLOW_MCP_SERVER_ENTRYPOINT;
if (typeof explicit === 'string' && explicit.length > 0) {
  const path = require('node:path');
  const fs = require('node:fs');
  if (/[\u0000-\u001f\u007f]/.test(explicit)) {
    console.error('[hive-flow-mcp-launcher] HIVE_FLOW_MCP_SERVER_ENTRYPOINT contains control characters');
    process.exit(1);
  }
  if (!path.isAbsolute(explicit)) {
    console.error('[hive-flow-mcp-launcher] HIVE_FLOW_MCP_SERVER_ENTRYPOINT must be absolute');
    process.exit(1);
  }
  let valid = false;
  try {
    valid = fs.statSync(explicit).isFile();
    if (valid) fs.accessSync(explicit, fs.constants.R_OK);
  } catch {}
  if (!valid) {
    console.error('[hive-flow-mcp-launcher] HIVE_FLOW_MCP_SERVER_ENTRYPOINT is not a readable file');
    process.exit(1);
  }
  entrypoint = explicit;
} else {
  try {
    entrypoint = requireHiveFlowCliFile('bin/mcp-server.js', {
      env: process.env,
      cwd: process.cwd(),
      helperDir: __dirname,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const attestation = mintMCPAttestation({
  entrypoint: 'bin/mcp-server.js',
  pidMode: 'spawned-child',
  launcherPid: process.pid,
  entrypointPath: entrypoint,
  env: process.env,
  cwd: process.cwd(),
  helperDir: __dirname,
});

if (!attestation.success) {
  console.error(`[hive-flow-mcp-launcher] MCP operator attestation unavailable: ${attestation.error}`);
}

const child = spawn(process.execPath, [entrypoint, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: attestation.success
    ? {
      ...process.env,
      ...attestation.envPatch,
    }
    : process.env,
  stdio: 'inherit',
});

child.on('error', (error) => {
  if (attestation.success) attestation.cleanup();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (attestation.success) attestation.cleanup();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
