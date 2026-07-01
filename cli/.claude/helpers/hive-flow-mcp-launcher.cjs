#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const { requireHiveFlowCliFile } = require('./layout-paths.cjs');

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

const child = spawn(process.execPath, [entrypoint, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
