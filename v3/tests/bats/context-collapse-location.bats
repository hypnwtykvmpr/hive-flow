#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "retired @hive-flow/context package metadata stays absent" {
  [ ! -e "$REPO_ROOT/v3/@hive-flow/context/package.json" ]
  [ ! -e "$REPO_ROOT/v3/@hive-flow/context/tsconfig.json" ]
}

@test "context assembly source lives under the cli package" {
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/context/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/context/LayeredAssembler.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/context/token-estimator.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/context/__tests__/context-assembly.test.ts" ]
}

@test "root TypeScript project no longer references retired context package" {
  run rg -n "@hive-flow/context|./@hive-flow/context" "$REPO_ROOT/v3/tsconfig.json"
  [ "$status" -eq 1 ]
}

@test "lockfiles no longer declare the retired context workspace importer" {
  run rg -n "^(  v3/@hive-flow/context:|  '@hive-flow/context':)" "$REPO_ROOT/pnpm-lock.yaml" "$REPO_ROOT/v3/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
}
