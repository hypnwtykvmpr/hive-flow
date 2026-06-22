#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "retired @hive-flow/claims package metadata stays absent" {
  [ ! -e "$REPO_ROOT/v3/@hive-flow/claims/package.json" ]
  [ ! -e "$REPO_ROOT/v3/@hive-flow/claims/tsconfig.json" ]
  [ ! -e "$REPO_ROOT/v3/@hive-flow/claims/src/index.ts" ]
}

@test "claims source, tests, and docs live under cli" {
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/claims/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/claims/application/claim-service.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/claims/api/mcp-tools.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/claims/__tests__/domain.test.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/docs/claims/README.md" ]
}

@test "cli package exports claims and declares zod for preserved schemas" {
  run grep -F '"./claims"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./dist/src/claims/index.js"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"zod": "^3.25.0"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
}

@test "root TypeScript projects no longer reference retired claims package" {
  run grep -F '@hive-flow/claims' "$REPO_ROOT/v3/tsconfig.json"
  [ "$status" -eq 1 ]
  run grep -F './@hive-flow/claims' "$REPO_ROOT/v3/tsconfig.json"
  [ "$status" -eq 1 ]
  run grep -F '@hive-flow/claims' "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
  run grep -F './@hive-flow/claims' "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
}

@test "registry and plugin help do not advertise retired claims package" {
  run grep -F '@hive-flow/claims' "$REPO_ROOT/v3/@hive-flow/cli/src/plugins/store/discovery.ts"
  [ "$status" -eq 1 ]
  run grep -F '@hive-flow/claims' "$REPO_ROOT/v3/@hive-flow/cli/scripts/publish-registry.ts"
  [ "$status" -eq 1 ]
  run grep -F '@hive-flow/claims' "$REPO_ROOT/v3/@hive-flow/cli/src/commands/plugins.ts"
  [ "$status" -eq 1 ]
}

@test "tracked docs use cli claims subpath instead of retired package" {
  run grep -R '@hive-flow/claims' \
    "$REPO_ROOT/CLAUDE.md" \
    "$REPO_ROOT/v3/@hive-flow/cli/docs/claims/README.md"
  [ "$status" -eq 1 ]

  run grep -F '@hive-flow/cli/claims' "$REPO_ROOT/CLAUDE.md"
  [ "$status" -eq 0 ]
  run grep -F '@hive-flow/cli/claims' "$REPO_ROOT/v3/@hive-flow/cli/docs/claims/README.md"
  [ "$status" -eq 0 ]
}

@test "lockfiles no longer declare retired claims importer and cli owns zod" {
  run grep -F 'v3/@hive-flow/claims:' "$REPO_ROOT/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
  run grep -F "  '@hive-flow/claims':" "$REPO_ROOT/v3/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
  run grep -F '      zod:' "$REPO_ROOT/pnpm-lock.yaml"
  [ "$status" -eq 0 ]
  run grep -F '      zod:' "$REPO_ROOT/v3/pnpm-lock.yaml"
  [ "$status" -eq 0 ]
}

@test "v3 package count reflects retired claims package" {
  count=0
  for package_file in "$REPO_ROOT"/v3/@hive-flow/*/package.json; do
    [ -e "$package_file" ] || continue
    count=$((count + 1))
  done

  [ "$count" -eq 9 ]
  run grep -F '9 packages' "$REPO_ROOT/v3/README.md"
  [ "$status" -eq 0 ]
}
