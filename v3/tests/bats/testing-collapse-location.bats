#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "retired @hive-flow/testing package metadata stays absent" {
  [ ! -e "$REPO_ROOT/v3/@hive-flow/testing/package.json" ]
  [ ! -e "$REPO_ROOT/v3/@hive-flow/testing/tsconfig.json" ]
  [ ! -e "$REPO_ROOT/v3/@hive-flow/testing/src/index.ts" ]
}

@test "testing source, tests, and docs live under cli" {
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/testing/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/testing/helpers/hardening.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/testing/fixtures/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/testing/mocks/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/testing/__tests__/hardening.test.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/docs/testing/README.md" ]
}

@test "cli package exports testing subpaths and owns shipped testing dependencies" {
  run grep -F '"./testing"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./testing/helpers"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./testing/fixtures"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./testing/mocks"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./testing/setup"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./testing/v2-compat"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"fast-check": "^4.8.0"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"vitest": "^4.0.16"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"@hive-flow/swarm": "workspace:*"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 1 ]
  run grep -F '"test:testing"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
}

@test "providers hardening test rewires to cli testing source" {
  run grep -F "@hive-flow/testing" "$REPO_ROOT/v3/@hive-flow/providers/src/__tests__/openrouter-hardening.test.ts"
  [ "$status" -eq 1 ]
  run grep -F "../../../cli/src/testing/helpers/hardening.js" "$REPO_ROOT/v3/@hive-flow/providers/src/__tests__/openrouter-hardening.test.ts"
  [ "$status" -eq 0 ]
  run grep -F '"@hive-flow/testing"' "$REPO_ROOT/v3/@hive-flow/providers/package.json"
  [ "$status" -eq 1 ]
}

@test "claims tests use in-package testing helpers" {
  run grep -R '../../../../testing/src' "$REPO_ROOT/v3/@hive-flow/cli/src/claims/__tests__"
  [ "$status" -eq 1 ]
  run grep -R '../../testing/helpers/create-mock.js' "$REPO_ROOT/v3/@hive-flow/cli/src/claims/__tests__"
  [ "$status" -eq 0 ]
}

@test "root TypeScript projects no longer reference retired testing package" {
  run grep -F '@hive-flow/testing' "$REPO_ROOT/v3/tsconfig.json"
  [ "$status" -eq 1 ]
  run grep -F './@hive-flow/testing' "$REPO_ROOT/v3/tsconfig.json"
  [ "$status" -eq 1 ]
  run grep -F '@hive-flow/testing' "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
  run grep -F './@hive-flow/testing' "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
  run grep -F '"@hive-flow/cli/*"' "$REPO_ROOT/v3/tsconfig.json"
  [ "$status" -eq 0 ]
  run grep -F '"@hive-flow/cli/*"' "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 0 ]
  run grep -F 'pnpm --filter @hive-flow/cli test:testing' "$REPO_ROOT/v3/package.json"
  [ "$status" -eq 0 ]
}

@test "tracked docs use cli testing subpath and real source location" {
  run grep -R '@hive-flow/testing' \
    "$REPO_ROOT/README.md" \
    "$REPO_ROOT/v3/README.md" \
    "$REPO_ROOT/v3/@hive-flow/cli/README.md" \
    "$REPO_ROOT/v3/CHANGELOG.md" \
    "$REPO_ROOT/v3/@hive-flow/cli/docs/testing/README.md" \
    "$REPO_ROOT/v3/@hive-flow/shared/README.md"
  [ "$status" -eq 1 ]

  run grep -F '@hive-flow/cli/testing' "$REPO_ROOT/v3/@hive-flow/cli/docs/testing/README.md"
  [ "$status" -eq 0 ]
  run grep -F './v3/@hive-flow/cli/src/testing/' "$REPO_ROOT/README.md"
  [ "$status" -eq 0 ]
  run grep -F './@hive-flow/cli/src/testing/' "$REPO_ROOT/v3/README.md"
  [ "$status" -eq 0 ]
  run grep -F './src/testing/' "$REPO_ROOT/v3/@hive-flow/cli/README.md"
  [ "$status" -eq 0 ]
}

@test "lockfiles no longer declare retired testing importer" {
  run grep -F 'v3/@hive-flow/testing:' "$REPO_ROOT/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
  run grep -F "  '@hive-flow/testing':" "$REPO_ROOT/v3/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
}

@test "v3 package count reflects retired testing package" {
  count=0
  for package_file in "$REPO_ROOT"/v3/@hive-flow/*/package.json; do
    [ -e "$package_file" ] || continue
    count=$((count + 1))
  done

  [ "$count" -eq 4 ]
  run grep -F '4 packages' "$REPO_ROOT/v3/README.md"
  [ "$status" -eq 0 ]
}
