#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('hive-flow/package.json'));
await import(pathToFileURL(join(packageRoot, 'bin/codex.js')).href);
