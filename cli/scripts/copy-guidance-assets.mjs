#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(packageRoot, 'src', 'guidance', 'wasm-pkg');
const targetDir = join(packageRoot, 'dist', 'src', 'guidance', 'wasm-pkg');

function copyRecursive(source, target) {
  const stat = statSync(source);
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source)) {
      copyRecursive(join(source, entry), join(target, entry));
    }
    return;
  }
  if (stat.isFile()) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

if (!existsSync(sourceDir)) {
  throw new Error(`guidance WASM asset dir not found: ${sourceDir}`);
}

rmSync(targetDir, { recursive: true, force: true });
copyRecursive(sourceDir, targetDir);
