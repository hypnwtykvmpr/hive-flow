#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(packageRoot, 'src', 'credential-store', 'helpers');
const targetDir = join(packageRoot, 'dist', 'credential-store', 'helpers');

function copyRecursive(source, target) {
  if (source.split(/[\\/]/).includes('.hive-flow')) return;
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
  throw new Error(`helper source dir not found: ${sourceDir}`);
}

rmSync(targetDir, { recursive: true, force: true });
copyRecursive(sourceDir, targetDir);

// hive-flow-8b69 Slice 3: non-.ts source files that tsc does not emit but that the
// compiled dist must contain at runtime. The shared CommonJS liveness source of truth
// backs the ESM re-export in `progress-authority-classifier.js`
// (`export { ... } from './hiveflow-task-liveness.cjs'`), so it must sit next to the
// compiled classifier under `dist/src/progress/`.
const extraFileCopies = [
  ['src/progress/hiveflow-task-liveness.cjs', 'dist/src/progress/hiveflow-task-liveness.cjs'],
];
for (const [sourceRel, targetRel] of extraFileCopies) {
  const source = join(packageRoot, sourceRel);
  const target = join(packageRoot, targetRel);
  if (!existsSync(source)) {
    throw new Error(`extra build source not found: ${source}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
