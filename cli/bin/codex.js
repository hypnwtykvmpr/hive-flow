#!/usr/bin/env node
/**
 * hive-flow-codex compatibility entrypoint.
 *
 * The Codex adapter now ships inside @hive-flow/cli under dist/src/codex.
 */

await import('../dist/src/codex/cli.js');
