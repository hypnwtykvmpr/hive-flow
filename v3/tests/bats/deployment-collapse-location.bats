#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "retired @hive-flow/deployment package metadata stays absent" {
  [ ! -e "$REPO_ROOT/v3/@hive-flow/deployment/package.json" ]
  [ ! -e "$REPO_ROOT/v3/@hive-flow/deployment/tsconfig.json" ]
  [ ! -e "$REPO_ROOT/v3/@hive-flow/deployment/src/index.ts" ]
}

@test "deployment helper source lives under the cli package" {
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/deployment/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/deployment/release-manager.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/deployment/publisher.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/deployment/validator.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/deployment/types.ts" ]
}

@test "cli package exports the replacement deployment subpath" {
  run grep -F '"./deployment"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./dist/src/deployment/index.js"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
}

@test "root TypeScript projects no longer reference retired deployment package" {
  run grep -F '@hive-flow/deployment' "$REPO_ROOT/v3/tsconfig.json"
  [ "$status" -eq 1 ]
  run grep -F './@hive-flow/deployment' "$REPO_ROOT/v3/tsconfig.json"
  [ "$status" -eq 1 ]
  run grep -F '@hive-flow/deployment' "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
  run grep -F './@hive-flow/deployment' "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
}

@test "lockfiles no longer declare the retired deployment workspace importer" {
  run grep -F 'v3/@hive-flow/deployment:' "$REPO_ROOT/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
  run grep -F "'@hive-flow/deployment':" "$REPO_ROOT/v3/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
}

@test "tracked docs use the cli deployment subpath instead of the retired package" {
  run grep -R '@hive-flow/deployment' \
    "$REPO_ROOT/README.md" \
    "$REPO_ROOT/v3/README.md" \
    "$REPO_ROOT/v3/@hive-flow/cli/README.md" \
    "$REPO_ROOT/v3/CHANGELOG.md" \
    "$REPO_ROOT/v3/@hive-flow/shared/README.md"
  [ "$status" -eq 1 ]
}
