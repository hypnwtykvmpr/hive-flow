#!/usr/bin/env node
/**
 * @claude-flow/cli - CLI Entry Point
 *
 * Claude Flow V3 Command Line Interface
 */

import { CLI } from '../dist/src/index.js';

const cli = new CLI();
cli.run().catch((error) => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});
