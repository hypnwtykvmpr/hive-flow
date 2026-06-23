#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "standalone plugins package is retired" {
  [ ! -e "$REPO_ROOT/v3/@hive-flow/plugins" ]

  run git -C "$REPO_ROOT" ls-files v3/@hive-flow/plugins
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "plugin sdk source, tests, examples, and docs live under cli" {
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/plugin-sdk/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/plugin-sdk/core/plugin-interface.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/plugin-sdk/sdk/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/plugin-sdk/__tests__/plugin-registry.test.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/plugin-sdk/examples/plugin-creator/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/docs/plugin-sdk/README.md" ]
}

@test "cli package exports plugin-sdk subpaths and does not depend on retired plugins package" {
  run node --input-type=module -e "import { readFileSync } from 'node:fs'; const pkg = JSON.parse(readFileSync('$REPO_ROOT/v3/@hive-flow/cli/package.json', 'utf8')); const exports = pkg.exports || {}; const required = ['./plugin-sdk','./plugin-sdk/sdk','./plugin-sdk/workers','./plugin-sdk/hooks','./plugin-sdk/providers','./plugin-sdk/examples/plugin-creator','./plugin-sdk/*']; if (required.some((key) => !exports[key]?.types || !exports[key]?.import)) process.exit(1); const fields = ['dependencies','devDependencies','optionalDependencies','peerDependencies']; if (fields.some((field) => pkg[field]?.['@hive-flow/plugins'])) process.exit(2);"
  [ "$status" -eq 0 ]
}

@test "root v3 config no longer references standalone plugins package" {
  run rg -n "@hive-flow/plugins|./@hive-flow/plugins" "$REPO_ROOT/v3/package.json" "$REPO_ROOT/v3/tsconfig.json" "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
}

@test "tracked source and docs no longer reference standalone plugins package" {
  run git -C "$REPO_ROOT" grep -n -E "@hive-flow/plugins|v3/@hive-flow/plugins" -- ':!v3/pnpm-lock.yaml' ':!pnpm-lock.yaml' ':!v3/tests/bats/plugin-sdk-collapse-location.bats'
  [ "$status" -eq 1 ]
}

@test "lockfiles no longer include standalone plugins importer" {
  run rg -n "['\"]?@hive-flow/plugins['\"]?:|v3/@hive-flow/plugins:" "$REPO_ROOT/v3/pnpm-lock.yaml" "$REPO_ROOT/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
}

@test "v3 package count reflects retired plugins package" {
  run find "$REPO_ROOT/v3/@hive-flow" -maxdepth 2 -name package.json -print
  [ "$status" -eq 0 ]
  count=$(printf "%s\n" "$output" | sed '/^$/d' | wc -l | tr -d ' ')
  [ "$count" -eq 4 ]

  run grep -F '4 packages' "$REPO_ROOT/v3/README.md"
  [ "$status" -eq 0 ]
}
