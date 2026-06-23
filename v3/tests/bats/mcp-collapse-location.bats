#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "retired mcp package directory is absent" {
  [ ! -e "$REPO_ROOT/v3/@hive-flow/mcp" ]
}

@test "mcp source, tests, and docs live under cli" {
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/mcp/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/mcp/server.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/mcp/transport/http.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/mcp/__tests__/mcp.test.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/mcp/__tests__/integration.test.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/docs/mcp/README.md" ]
}

@test "cli publishes mcp subpath export" {
  run grep -F '"./mcp"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./dist/src/mcp/index.js"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
}

@test "cli http transport loads local mcp implementation" {
  run grep -F "import('./mcp/index.js')" "$REPO_ROOT/v3/@hive-flow/cli/src/mcp-server.ts"
  [ "$status" -eq 0 ]
  run grep -F "import('@hive-flow/mcp')" "$REPO_ROOT/v3/@hive-flow/cli/src/mcp-server.ts"
  [ "$status" -eq 1 ]
}

@test "root tsconfig no longer references retired mcp package" {
  run grep -F '@hive-flow/mcp' "$REPO_ROOT/v3/tsconfig.json" "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
}

@test "v3 package count reflects retired mcp package" {
  count=0
  for package_file in "$REPO_ROOT"/v3/@hive-flow/*/package.json; do
    [ -e "$package_file" ] || continue
    count=$((count + 1))
  done

  [ "$count" -eq 5 ]
  run grep -F '5 packages' "$REPO_ROOT/v3/README.md"
  [ "$status" -eq 0 ]
}

@test "tracked surfaces no longer reference retired mcp package" {
  run git -C "$REPO_ROOT" grep -n '@hive-flow/mcp' -- \
    . \
    ':!.hive-flow/**' \
    ':!**/node_modules/**' \
    ':!**/dist/**' \
    ':!v3/tests/bats/mcp-collapse-location.bats' \
    ':!pnpm-lock.yaml' \
    ':!v3/pnpm-lock.yaml'
  [ "$status" -eq 1 ]
}
