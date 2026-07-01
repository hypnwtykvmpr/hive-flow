#!/usr/bin/env node
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const compatRoot = resolve(scriptDir, '..');
const canonicalRoot = resolve(compatRoot, '../..');
const canonicalPackagePath = join(canonicalRoot, 'package.json');
const compatPackagePath = join(compatRoot, 'package.json');
const exportsRoot = join(compatRoot, 'exports');
const binRoot = join(compatRoot, 'bin');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function posixPath(path) {
  return path.split(sep).join('/');
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function removeGenerated() {
  rmSync(exportsRoot, { recursive: true, force: true });
  rmSync(binRoot, { recursive: true, force: true });
  ensureDir(exportsRoot);
  ensureDir(binRoot);
}

function exportKeyToSpecifier(key) {
  if (key === '.') return 'hive-flow';
  return `hive-flow/${key.slice(2)}`;
}

function exportKeyToOutputStem(key) {
  if (key === '.') return 'index';
  return key.slice(2);
}

function wildcardPrefix(key) {
  return key.slice(2, -1);
}

function writeStub(stem, specifier) {
  const outputStem = join(exportsRoot, stem);
  ensureDir(dirname(outputStem));
  writeFileSync(`${outputStem}.js`, `export * from '${specifier}';\n`, 'utf8');
  writeFileSync(`${outputStem}.d.ts`, `export * from '${specifier}';\n`, 'utf8');
}

function shouldSkipSourcePath(absPath) {
  const rel = posixPath(relative(canonicalRoot, absPath));
  const name = rel.split('/').pop() ?? '';
  if (rel.includes('/__tests__/')) return true;
  if (rel.includes('/test-fixtures/')) return true;
  if (name.endsWith('.test.ts') || name.endsWith('.test.js')) return true;
  if (name.endsWith('.spec.ts') || name.endsWith('.spec.js')) return true;
  if (name.endsWith('.d.ts')) return true;
  if (name.startsWith('DELETE_')) return true;
  return false;
}

function collectSourceFiles(baseDir) {
  const files = [];
  if (!existsSync(baseDir)) return files;

  function walk(current) {
    const stat = statSync(current);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current)) {
        walk(join(current, entry));
      }
      return;
    }
    if (!stat.isFile() || shouldSkipSourcePath(current)) return;
    if (!/\.(ts|js|mjs|cjs)$/.test(current)) return;
    files.push(current);
  }

  walk(baseDir);
  return files;
}

function sourceBaseFromWildcardExport(value) {
  const importTarget = typeof value === 'object' && value !== null ? value.import : undefined;
  if (typeof importTarget !== 'string' || !importTarget.includes('*')) return null;
  const beforeStar = importTarget.slice(0, importTarget.indexOf('*'));
  if (!beforeStar.startsWith('./dist/src/')) return null;
  return resolve(canonicalRoot, beforeStar.replace(/^\.\//, '').replace(/^dist\/src\//, 'src/'));
}

function stripSourceExtension(path) {
  return path.replace(/\.(ts|js|mjs|cjs)$/, '');
}

function generateWildcardStubs(key, value) {
  const prefix = wildcardPrefix(key);
  const baseDir = sourceBaseFromWildcardExport(value);
  if (!baseDir) return;

  const seen = new Set();
  for (const file of collectSourceFiles(baseDir)) {
    const relStem = stripSourceExtension(posixPath(relative(baseDir, file)));
    if (!relStem || seen.has(relStem)) continue;
    seen.add(relStem);
    writeStub(`${prefix}${relStem}`, `hive-flow/${prefix}${relStem}`);
  }
}

function transformedExportValue(key, value) {
  if (key === './package.json') return './package.json';
  const stem = exportKeyToOutputStem(key);
  if (key.includes('*')) {
    const prefix = wildcardPrefix(key);
    return {
      types: `./exports/${prefix}*.d.ts`,
      import: `./exports/${prefix}*.js`,
    };
  }
  return {
    types: `./exports/${stem}.d.ts`,
    import: `./exports/${stem}.js`,
  };
}

function generateExportStubs(canonicalPackage) {
  const transformed = {};
  for (const [key, value] of Object.entries(canonicalPackage.exports ?? {})) {
    transformed[key] = transformedExportValue(key, value);
    if (key === './package.json') continue;
    if (key.includes('*')) {
      generateWildcardStubs(key, value);
      continue;
    }
    writeStub(exportKeyToOutputStem(key), exportKeyToSpecifier(key));
  }
  return transformed;
}

function binWrapperSource(target) {
  return `#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('hive-flow/package.json'));
await import(pathToFileURL(join(packageRoot, '${target.replace(/^\.\//, '')}')).href);
`;
}

function generateBinWrappers(canonicalPackage) {
  const bin = {};
  for (const [name, target] of Object.entries(canonicalPackage.bin ?? {})) {
    const wrapperPath = join(binRoot, `${name}.js`);
    writeFileSync(wrapperPath, binWrapperSource(target), 'utf8');
    chmodSync(wrapperPath, 0o755);
    bin[name] = `./bin/${name}.js`;
  }
  return bin;
}

function syncLicense() {
  const canonicalLicense = join(canonicalRoot, 'LICENSE');
  const compatLicense = join(compatRoot, 'LICENSE');
  if (existsSync(canonicalLicense)) {
    writeFileSync(compatLicense, readFileSync(canonicalLicense));
  }
}

function main() {
  const canonicalPackage = readJson(canonicalPackagePath);
  const compatPackage = readJson(compatPackagePath);
  removeGenerated();

  compatPackage.version = canonicalPackage.version;
  compatPackage.main = './exports/index.js';
  compatPackage.types = './exports/index.d.ts';
  compatPackage.bin = generateBinWrappers(canonicalPackage);
  compatPackage.exports = generateExportStubs(canonicalPackage);
  compatPackage.dependencies = {
    'hive-flow': 'workspace:*',
  };
  compatPackage.license = canonicalPackage.license ?? compatPackage.license;
  compatPackage.packageManager = canonicalPackage.packageManager ?? compatPackage.packageManager;

  writeJson(compatPackagePath, compatPackage);
  syncLicense();
}

main();
