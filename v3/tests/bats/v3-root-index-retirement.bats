#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "retired v3 aggregate entrypoint stays absent" {
  [ ! -e "$REPO_ROOT/v3/index.ts" ]
}

@test "docs no longer advertise non-existent @hive-flow/v3 package" {
  run rg -n "@hive-flow/v3['\";[:space:]]|initializeV3Swarm|import \\* as hiveFlow" "$REPO_ROOT/v3/README.md"
  [ "$status" -eq 1 ]
}

@test "shipped-surface scanner does not include retired v3/index.ts" {
  run rg -n "'v3/index\\.ts'" "$REPO_ROOT/v3/@hive-flow/cli/src/init/__tests__/debrand-static-scope.ts"
  [ "$status" -eq 1 ]
}
