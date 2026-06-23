#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "standalone codex package is retired" {
  [ ! -e "$REPO_ROOT/v3/@hive-flow/codex" ]

  run git -C "$REPO_ROOT" ls-files v3/@hive-flow/codex
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "codex adapter source, tests, docs, and compatibility bin live under cli" {
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/codex/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/codex/cli.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/codex/initializer.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/codex/generators/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/codex/templates/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/codex/migrations/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/codex/dual-mode/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/codex/__tests__/generators.test.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/docs/codex/README.md" ]
  [ -x "$REPO_ROOT/v3/@hive-flow/cli/bin/codex.js" ]
}

@test "cli package owns codex bin, exports, and runtime dependencies" {
  run node --input-type=module -e "import { readFileSync } from 'node:fs'; const pkg = JSON.parse(readFileSync('$REPO_ROOT/v3/@hive-flow/cli/package.json', 'utf8')); const exports = pkg.exports || {}; const requiredExports = ['./codex','./codex/generators','./codex/templates','./codex/migrations','./codex/dual-mode','./codex/*']; if (pkg.bin?.['hive-flow-codex'] !== './bin/codex.js') process.exit(1); if (requiredExports.some((key) => !exports[key]?.types || !exports[key]?.import)) process.exit(2); const fields = ['dependencies','devDependencies','optionalDependencies','peerDependencies']; if (fields.some((field) => pkg[field]?.['@hive-flow/codex'])) process.exit(3); const deps = pkg.dependencies || {}; for (const dep of ['commander','chalk','inquirer','yaml','toml']) { if (!deps[dep]) process.exit(4); }"
  [ "$status" -eq 0 ]
}

@test "root v3 TypeScript project no longer references standalone codex package" {
  run rg -n "@hive-flow/codex|./@hive-flow/codex" "$REPO_ROOT/v3/tsconfig.json"
  [ "$status" -eq 1 ]
}

@test "tracked source and docs no longer reference standalone codex package" {
  run git -C "$REPO_ROOT" grep -n -E "@hive-flow/codex|v3/@hive-flow/codex" -- ':!pnpm-lock.yaml' ':!v3/pnpm-lock.yaml' ':!v3/tests/bats/codex-collapse-location.bats'
  [ "$status" -eq 1 ]
}

@test "lockfiles no longer include standalone codex importer or link" {
  run rg -n "('@hive-flow/codex':|@hive-flow/codex:|v3/@hive-flow/codex:|link:../codex)" "$REPO_ROOT/v3/pnpm-lock.yaml" "$REPO_ROOT/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
}

@test "v3 package count reflects retired codex package" {
  run find "$REPO_ROOT/v3/@hive-flow" -maxdepth 2 -name package.json -print
  [ "$status" -eq 0 ]
  count=$(printf "%s\n" "$output" | sed '/^$/d' | wc -l | tr -d ' ')
  [ "$count" -eq 4 ]

  run grep -F '4 packages' "$REPO_ROOT/v3/README.md"
  [ "$status" -eq 0 ]
}
