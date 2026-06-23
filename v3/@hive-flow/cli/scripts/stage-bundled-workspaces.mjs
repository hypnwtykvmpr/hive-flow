#!/usr/bin/env node
/**
 * stage-bundled-workspaces.mjs
 *
 * Stages the unpublished runtime workspace packages that the installed CLI dist
 * imports as BARE workspace specifiers (e.g. `@hive-flow/providers`) into the umbrella
 * package's own `node_modules/@hive-flow/<pkg>`, so they resolve as real
 * dependencies once `hive-flow` is installed via `npm i -g`.
 *
 * Why: the umbrella ships `v3/@hive-flow/cli/dist`, whose modules import bare
 * `@hive-flow/*` specifiers. `workspace:*` specifiers do NOT resolve post-install,
 * and the sibling `v3/@hive-flow/*` dirs are not on Node's resolution path from
 * the nested cli dist. Bundling real `node_modules/@hive-flow/*` entries (via
 * package.json `bundledDependencies`) is the self-contained bridge that makes
 * `hive-flow --version` (and core commands) resolve without publishing the
 * subpackages to a registry.
 *
 * This script lives under the CLI package because the CLI owns the installable
 * runtime surface, but it is invoked from the root `prepack` lifecycle and
 * stages files into the umbrella package root. It is idempotent.
 *
 * Integration helpers now live inside the CLI package under the
 * `@hive-flow/cli/integration` subpath, so they are not staged as a separate
 * workspace dependency.
 *
 * Eager runtime closure (traced from bin/cli.js -> dist/src/index.js):
 *   - @hive-flow/providers    (/scripts/agent-task-journal.mjs)           REQUIRED for every command
 *   - guidance command code now lives inside @hive-flow/cli/dist/src/guidance
 *
 * Each package's own third-party deps (express, helmet, cors, ws, sql.js, zod,
 * etc.) are declared in the umbrella root `dependencies` so they install into
 * the root node_modules and resolve via Node's upward lookup from the bundled
 * package.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findUmbrellaRoot(startDir) {
  let current = resolve(startDir);
  for (;;) {
    const packageJsonPath = join(current, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        const bundled = Array.isArray(pkg.bundledDependencies)
          ? pkg.bundledDependencies
          : Array.isArray(pkg.bundleDependencies)
            ? pkg.bundleDependencies
            : [];
        if (pkg.name === 'hive-flow' && bundled.includes('@hive-flow/providers')) {
          return current;
        }
      } catch {
        // Keep walking; malformed package.json files are handled by normal build gates.
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error('[stage-bundled] unable to locate umbrella hive-flow package root');
    }
    current = parent;
  }
}

const repoRoot = findUmbrellaRoot(__dirname);
const wsRoot = join(repoRoot, 'v3', '@hive-flow');
const destRoot = join(repoRoot, 'node_modules', '@hive-flow');

// Packages on the eager / unguarded-command runtime path that must be bundled.
// `copy` lists the package-relative paths to stage (dist always; extra runtime
// assets as needed).
const BUNDLED = [
  { name: 'providers', copy: ['dist', 'scripts'] },
];

// Resolve a concrete version for an @hive-flow/* package from the source tree.
function versionOf(pkgName) {
  const short = pkgName.replace('@hive-flow/', '');
  const pj = join(wsRoot, short, 'package.json');
  if (!existsSync(pj)) return null;
  return JSON.parse(readFileSync(pj, 'utf8')).version || null;
}

// Rewrite any `workspace:*` (or workspace:^/~) specifiers to concrete versions
// so the staged package.json is installable. For @hive-flow/* deps we use the
// real source version; if a workspace dep is NOT part of the bundled set we drop
// it from `dependencies` into `optionalDependencies` (it is not on the eager
// path and is guarded at the import site) to avoid an unresolvable hard dep.
function sanitizePackageJson(raw) {
  const pkg = JSON.parse(raw);
  const bundledNames = new Set(BUNDLED.map((b) => `@hive-flow/${b.name}`));

  // CRITICAL: npm's `bundledDependencies` packer bundles each bundled package's
  // declared `dependencies` from the umbrella's root node_modules. If we leave
  // third-party deps (express, helmet, ws, ...) in the staged package.json, npm
  // pulls their entire transitive tree INTO the tarball — producing a bloated,
  // partially-deduped, broken node_modules (e.g. an empty `semver/`). To prevent
  // that, the staged package.json's runtime dep groups must reference ONLY the
  // co-bundled @hive-flow/* packages (which live side-by-side under
  // node_modules/@hive-flow and add nothing new to bundle).
  //
  // Third-party deps are NOT declared in the staged copy; they resolve at runtime
  // via Node's normal upward directory walk to the umbrella ROOT node_modules,
  // where they are installed because the umbrella ROOT package.json declares them.
  const keepOnlyBundledHive = (group) => {
    if (!pkg[group]) return;
    const kept = {};
    for (const dep of Object.keys(pkg[group])) {
      if (bundledNames.has(dep)) {
        const concrete = versionOf(dep) || '*';
        kept[dep] = concrete;
      }
      // else: drop (third-party -> resolved from root; unbundled @hive-flow/* ->
      // off the eager path and guarded at the import site).
    }
    if (Object.keys(kept).length) pkg[group] = kept;
    else delete pkg[group];
  };

  keepOnlyBundledHive('dependencies');
  // optional + peer dep groups are not needed in the bundled runtime copy and
  // can only cause npm to attempt extra (failing) fetches at install time.
  delete pkg.optionalDependencies;
  delete pkg.peerDependencies;

  // Strip dev-only noise that should never ship in a bundled runtime copy.
  delete pkg.devDependencies;
  delete pkg.scripts;
  return JSON.stringify(pkg, null, 2) + '\n';
}

// PACKAGING HYGIENE (slice A / DO-NOT-REVERT): predicate for paths that must NOT
// land in the staged bundled payload. Returns true to EXCLUDE:
//   - sourcemaps: any `*.js.map` / `*.d.ts.map` (and any other `*.map`),
//   - test dirs: any path with a `__tests__` segment (prunes the whole subtree).
// Rationale: bundledDependencies bypass the root `files` `!**/*.map` negation, so
// these would otherwise ship in the root tarball. See the cpSync filter call.
function shouldExcludeFromBundle(srcPath) {
  if (srcPath.endsWith('.map')) return true; // *.js.map, *.d.ts.map, ...
  // Match `__tests__` only as a full path segment (not a substring of a filename).
  if (/(^|[\\/])__tests__([\\/]|$)/.test(srcPath)) return true;
  return false;
}

function stageOne({ name, copy }) {
  const srcDir = join(wsRoot, name);
  const srcPkgJson = join(srcDir, 'package.json');
  if (!existsSync(srcPkgJson)) {
    throw new Error(`[stage-bundled] source package.json missing: ${srcPkgJson}`);
  }
  // dist is mandatory for every bundled package.
  const distDir = join(srcDir, 'dist');
  if (!existsSync(distDir)) {
    throw new Error(
      `[stage-bundled] ${name}/dist missing — build the workspace package before packing`,
    );
  }

  const destDir = join(destRoot, name);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });

  for (const rel of copy) {
    const from = join(srcDir, rel);
    if (!existsSync(from)) continue; // optional asset (e.g. wasm-pkg)
    // PACKAGING HYGIENE (slice A / DO-NOT-REVERT): exclude sourcemaps and test
    // dirs from the staged bundled payload. These packages are bundled via the
    // umbrella root `bundledDependencies`, and npm packs bundled deps by their
    // OWN rules — the root `files` `!**/*.map` negation does NOT reach into
    // bundled `node_modules/@hive-flow/*`. Without this filter the root tarball
    // ships 440 `.js.map`/`.d.ts.map` + 36 `__tests__/` from these copies. We
    // strip them at the copy step so the bundled payload carries only runtime
    // dist js/d.ts (+ sanitized package.json). Keep `*.js`/`*.d.ts` intact.
    cpSync(from, join(destDir, rel), {
      recursive: true,
      filter: (src) => !shouldExcludeFromBundle(src),
    });
  }

  const sanitized = sanitizePackageJson(readFileSync(srcPkgJson, 'utf8'));
  writeFileSync(join(destDir, 'package.json'), sanitized);

  return { name, version: versionOf(`@hive-flow/${name}`) };
}

// Guard: the umbrella ROOT package.json must declare each bundled package in
// `dependencies` at the SAME concrete version the source tree carries, and list
// it in `bundledDependencies`. If they drift, npm would try to fetch the
// (unpublished) package from the registry at install time and fail. Fail the
// prepack loudly instead of shipping a broken tarball.
function assertRootDeclarationsInSync() {
  const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const deps = rootPkg.dependencies || {};
  const bundled = new Set(rootPkg.bundledDependencies || rootPkg.bundleDependencies || []);
  const problems = [];
  for (const { name } of BUNDLED) {
    const full = `@hive-flow/${name}`;
    const srcVersion = versionOf(full);
    if (!bundled.has(full)) {
      problems.push(`${full} is not listed in root "bundledDependencies"`);
    }
    if (!deps[full]) {
      problems.push(`${full} is not declared in root "dependencies"`);
    } else if (deps[full] !== srcVersion) {
      problems.push(
        `${full} version drift: root dependencies="${deps[full]}" but source package.json="${srcVersion}" — update package.json to match`,
      );
    }
  }
  if (problems.length) {
    throw new Error(
      '[stage-bundled] root package.json is out of sync with bundled workspace packages:\n  - ' +
        problems.join('\n  - '),
    );
  }
}

function main() {
  assertRootDeclarationsInSync();
  mkdirSync(destRoot, { recursive: true });
  const staged = [];
  for (const entry of BUNDLED) {
    staged.push(stageOne(entry));
  }
  // Log to STDERR: this script runs in the `prepack` lifecycle, and
  // `npm pack --dry-run --json` emits machine-readable JSON on STDOUT.
  // Writing progress to stdout would corrupt that JSON for tooling/tests.
  // eslint-disable-next-line no-console
  console.error(
    '[stage-bundled] staged runtime workspace packages into node_modules/@hive-flow:',
  );
  for (const s of staged) {
    // eslint-disable-next-line no-console
    console.error(`  @hive-flow/${s.name}@${s.version}`);
  }
}

main();
