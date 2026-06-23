#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "retired guidance package directory is absent" {
  [ ! -e "$REPO_ROOT/v3/@hive-flow/guidance" ]
}

@test "guidance source, tests, docs, script, and wasm assets live under cli" {
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/guidance/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/guidance/compiler.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/guidance/wasm-kernel.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/guidance/wasm-pkg/guidance_kernel.js" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/guidance/wasm-pkg/guidance_kernel_bg.wasm" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/guidance/__tests__/compiler.test.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/docs/guidance/README.md" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/scripts/guidance/analyze-claude-md.ts" ]
}

@test "cli publishes guidance subpath export and copies wasm assets during build" {
  run grep -F '"./guidance"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./dist/src/guidance/index.js"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"build:guidance-assets"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F 'copy-guidance-assets.mjs' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
}

@test "root packages no longer bundle or depend on retired guidance workspace" {
  run grep -F '@hive-flow/guidance' "$REPO_ROOT/package.json" "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 1 ]
}

@test "root TypeScript project no longer references retired guidance package" {
  run grep -F '@hive-flow/guidance' "$REPO_ROOT/v3/tsconfig.json" "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
  run grep -F './@hive-flow/guidance' "$REPO_ROOT/v3/tsconfig.json" "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
}

@test "lockfiles no longer declare the retired guidance workspace importer" {
  run grep -F 'v3/@hive-flow/guidance:' "$REPO_ROOT/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
  run grep -F "'@hive-flow/guidance':" "$REPO_ROOT/v3/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
}

@test "v3 package count reflects retired guidance package" {
  count=0
  for package_file in "$REPO_ROOT"/v3/@hive-flow/*/package.json; do
    [ -e "$package_file" ] || continue
    count=$((count + 1))
  done

  [ "$count" -eq 6 ]
  run grep -F '6 packages' "$REPO_ROOT/v3/README.md"
  [ "$status" -eq 0 ]
}

@test "tracked surfaces no longer reference retired guidance package" {
  run git -C "$REPO_ROOT" grep -n '@hive-flow/guidance' -- \
    . \
    ':!.hive-flow/**' \
    ':!**/node_modules/**' \
    ':!**/dist/**' \
    ':!v3/tests/bats/guidance-collapse-location.bats' \
    ':!pnpm-lock.yaml' \
    ':!v3/pnpm-lock.yaml'
  [ "$status" -eq 1 ]
}
