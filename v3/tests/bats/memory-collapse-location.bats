#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "standalone memory package is retired" {
  [ ! -e "$REPO_ROOT/v3/@hive-flow/memory" ]

  run git -C "$REPO_ROOT" ls-files v3/@hive-flow/memory
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "memory source, tests, docs, and benchmarks live under cli" {
  [ -f "$REPO_ROOT/cli/src/memory/index.ts" ]
  [ -f "$REPO_ROOT/cli/src/memory/hnsw-index.ts" ]
  [ -f "$REPO_ROOT/cli/src/memory/hybrid-backend.ts" ]
  [ -f "$REPO_ROOT/cli/src/memory/database-provider.ts" ]
  [ -f "$REPO_ROOT/cli/src/memory/__tests__/hnsw-quantization.test.ts" ]
  [ -f "$REPO_ROOT/cli/docs/memory/README.md" ]
  [ -f "$REPO_ROOT/cli/docs/memory/examples/cross-platform-usage.ts" ]
  [ -f "$REPO_ROOT/cli/benchmarks/memory/benchmarks/vector-search.bench.ts" ]
}

@test "cli package owns memory export and runtime dependencies" {
  run node --input-type=module -e "import { readFileSync } from 'node:fs'; const pkg = JSON.parse(readFileSync('$REPO_ROOT/cli/package.json', 'utf8')); const exports = pkg.exports || {}; const requiredExports = ['./memory','./memory/application','./memory/domain','./memory/infrastructure','./memory/*']; if (requiredExports.some((key) => !exports[key]?.types || !exports[key]?.import)) process.exit(1); const fields = ['dependencies','devDependencies','optionalDependencies','peerDependencies']; if (fields.some((field) => pkg[field]?.['@hive-flow/memory'])) process.exit(2); const deps = pkg.dependencies || {}; if (!deps['sql.js']) process.exit(3); if (!deps.typescript) process.exit(4); if (!pkg.optionalDependencies?.['better-sqlite3']) process.exit(5);"
  [ "$status" -eq 0 ]
}

@test "root v3 TypeScript project no longer references standalone memory package" {
  run rg -n "@hive-flow/memory|./@hive-flow/memory" "$REPO_ROOT/v3/tsconfig.json" "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
}

@test "tracked source and package metadata no longer reference standalone memory package" {
  run git -C "$REPO_ROOT" grep -n -E "@hive-flow/memory|v3/@hive-flow/memory" -- ':!pnpm-lock.yaml' ':!v3/pnpm-lock.yaml' ':!v3/tests/bats/memory-collapse-location.bats' ':!v3/docs/design/**'
  [ "$status" -eq 1 ]
}

@test "lockfiles no longer include standalone memory importer or link" {
  run rg -n "('@hive-flow/memory':|@hive-flow/memory:|v3/@hive-flow/memory:|link:../memory)" "$REPO_ROOT/v3/pnpm-lock.yaml" "$REPO_ROOT/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
}

@test "v3 package count reflects retired memory package" {
  count=0
  for package_file in "$REPO_ROOT"/cli/package.json "$REPO_ROOT"/cli/packages/*/package.json; do
    [ -e "$package_file" ] || continue
    count=$((count + 1))
  done
  [ "$count" -eq 5 ]

  run grep -F '5 packages' "$REPO_ROOT/v3/README.md"
  [ "$status" -eq 0 ]
}
