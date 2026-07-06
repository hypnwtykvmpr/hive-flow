#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const { requireHiveFlowCliFile } = require('./layout-paths.cjs');
const { mintMCPAttestation } = require('./mcp-attestation.cjs');

let entrypoint;
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
