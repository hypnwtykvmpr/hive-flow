#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "retired neural package directory is absent" {
  [ ! -e "$REPO_ROOT/v3/@hive-flow/neural" ]
}

@test "neural source and docs live under cli" {
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/neural/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/neural/reasoning-bank.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/neural/__tests__/sona.test.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/docs/neural/README.md" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/docs/neural/SONA_INTEGRATION.md" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/docs/neural/SONA_QUICKSTART.md" ]
}

@test "cli publishes neural subpath export" {
  run grep -F '"./neural"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./dist/src/neural/index.js"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
}

@test "memory bridge loads neural through cli subpath" {
  run grep -F "import('@hive-flow/cli/neural' as string)" "$REPO_ROOT/v3/@hive-flow/cli/src/memory/learning-bridge.ts"
  [ "$status" -eq 0 ]
}

@test "root tsconfigs no longer reference retired neural package" {
  run grep -F '@hive-flow/neural' "$REPO_ROOT/v3/tsconfig.json" "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
}

@test "v3 package count reflects retired neural package" {
  count=0
  for package_file in "$REPO_ROOT"/v3/@hive-flow/*/package.json; do
    [ -e "$package_file" ] || continue
    count=$((count + 1))
  done

  [ "$count" -eq 3 ]
  run grep -F '3 packages' "$REPO_ROOT/v3/README.md"
  [ "$status" -eq 0 ]
}

@test "tracked surfaces no longer reference retired neural package" {
  run git -C "$REPO_ROOT" grep -n '@hive-flow/neural' -- \
    . \
    ':!.hive-flow/**' \
    ':!**/node_modules/**' \
    ':!**/dist/**' \
    ':!v3/tests/bats/neural-collapse-location.bats' \
    ':!pnpm-lock.yaml' \
    ':!v3/pnpm-lock.yaml'
  [ "$status" -eq 1 ]
}
