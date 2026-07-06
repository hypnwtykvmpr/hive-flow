#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "retired @hive-flow/e2e package metadata stays absent" {
  [ ! -e "$REPO_ROOT/v3/@hive-flow/e2e/package.json" ]
}

@test "e2e tests and fixtures live under the cli package" {
  [ -f "$REPO_ROOT/cli/e2e/__tests__/mcp.e2e.test.ts" ]
  [ -f "$REPO_ROOT/cli/e2e/__tests__/helpers.ts" ]
  [ -f "$REPO_ROOT/cli/e2e/__fixtures__/mcp-wire/initialize-response.json" ]
  [ -f "$REPO_ROOT/cli/e2e/src/anti-mock-theater.ts" ]
}

@test "integration scripts target cli e2e instead of retired package" {
  run rg -n "@hive-flow/e2e|--filter @hive-flow/e2e" "$REPO_ROOT/v3/package.json" "$REPO_ROOT/cli/package.json"
  [ "$status" -eq 1 ]

  run rg -n "test:e2e|e2e/vitest.config.ts" "$REPO_ROOT/v3/package.json" "$REPO_ROOT/cli/package.json"
  [ "$status" -eq 0 ]
}

@test "lockfiles no longer declare the retired e2e workspace importer" {
  run rg -n "^(  v3/@hive-flow/e2e:|  '@hive-flow/e2e':)" "$REPO_ROOT/pnpm-lock.yaml" "$REPO_ROOT/v3/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
}

@test "moved e2e config resolves the v3 base config" {
  run rg -n "\"extends\": \"../../../tsconfig.base.json\"" "$REPO_ROOT/cli/e2e/tsconfig.json"
  [ "$status" -eq 0 ]
}
