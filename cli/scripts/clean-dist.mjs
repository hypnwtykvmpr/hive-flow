import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, '..');
const distDir = resolve(packageRoot, 'dist');

if (!distDir.startsWith(packageRoot)) {
  throw new Error(`Refusing to clean path outside package root: ${distDir}`);
}

await rm(distDir, { recursive: true, force: true });
