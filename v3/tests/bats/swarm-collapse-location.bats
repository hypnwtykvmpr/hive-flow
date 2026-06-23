#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "retired @hive-flow/swarm package metadata stays absent" {
  [ ! -e "$REPO_ROOT/v3/@hive-flow/swarm/package.json" ]
  [ ! -e "$REPO_ROOT/v3/@hive-flow/swarm/tsconfig.json" ]
  [ ! -e "$REPO_ROOT/v3/@hive-flow/swarm/src/index.ts" ]
}

@test "swarm source, tests, and docs live under cli" {
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/swarm/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/swarm/unified-coordinator.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/swarm/consensus/raft.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/swarm/__tests__/coordinator.test.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/docs/swarm/README.md" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/docs/swarm/MIGRATION.md" ]
}

@test "tracked generated swarm artifacts are not canonical cli source" {
  run find "$REPO_ROOT/v3/@hive-flow/cli/src/swarm" \
    \( -name '*.js' -o -name '*.d.ts' -o -name '*.map' \)
  [ "$status" -eq 0 ]
  [ "$output" = "" ]
}

@test "cli package exports swarm subpaths and no longer depends on retired package" {
  run grep -F '"./swarm"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./dist/src/swarm/index.js"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"@hive-flow/swarm"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 1 ]
}

@test "runtime and testing imports use in-package swarm source" {
  run grep -F "from '@hive-flow/cli/swarm'" "$REPO_ROOT/v3/@hive-flow/cli/e2e/__tests__/swarm.e2e.test.ts"
  [ "$status" -eq 0 ]
  run grep -F "import('../../swarm/index.js')" "$REPO_ROOT/v3/@hive-flow/cli/src/testing/regression/integration-regression.ts"
  [ "$status" -eq 0 ]
  run grep -F "../swarm/domain/entities/agent.js" "$REPO_ROOT/v3/@hive-flow/cli/src/infrastructure/in-memory-repositories.ts"
  [ "$status" -eq 0 ]
  run grep -R "../src/" "$REPO_ROOT/v3/@hive-flow/cli/src/swarm/__tests__"
  [ "$status" -eq 1 ]
}

@test "root TypeScript projects no longer reference retired swarm package" {
  run grep -F '@hive-flow/swarm' "$REPO_ROOT/v3/tsconfig.json"
  [ "$status" -eq 1 ]
  run grep -F './@hive-flow/swarm' "$REPO_ROOT/v3/tsconfig.json"
  [ "$status" -eq 1 ]
  run grep -F '@hive-flow/swarm' "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
  run grep -F './@hive-flow/swarm' "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
  run grep -F 'pnpm --filter @hive-flow/cli exec vitest run src/swarm/__tests__' "$REPO_ROOT/v3/package.json"
  [ "$status" -eq 0 ]
}

@test "tracked docs use cli swarm subpath and real source location" {
  run grep -R '@hive-flow/swarm' \
    "$REPO_ROOT/README.md" \
    "$REPO_ROOT/v3/README.md" \
    "$REPO_ROOT/v3/@hive-flow/cli/README.md" \
    "$REPO_ROOT/v3/@hive-flow/cli/docs/swarm/README.md" \
    "$REPO_ROOT/v3/@hive-flow/cli/docs/swarm/MIGRATION.md" \
    "$REPO_ROOT/v3/CHANGELOG.md"
  [ "$status" -eq 1 ]

  run grep -F '@hive-flow/cli/swarm' "$REPO_ROOT/v3/@hive-flow/cli/docs/swarm/README.md"
  [ "$status" -eq 0 ]
  run grep -F './v3/@hive-flow/cli/src/swarm/' "$REPO_ROOT/README.md"
  [ "$status" -eq 0 ]
  run grep -F './@hive-flow/cli/src/swarm/' "$REPO_ROOT/v3/README.md"
  [ "$status" -eq 0 ]
  run grep -F './src/swarm/' "$REPO_ROOT/v3/@hive-flow/cli/README.md"
  [ "$status" -eq 0 ]
}

@test "lockfiles no longer declare retired swarm importer" {
  run grep -F 'v3/@hive-flow/swarm:' "$REPO_ROOT/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
  run grep -F "  '@hive-flow/swarm':" "$REPO_ROOT/v3/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
}

@test "v3 package count reflects retired swarm package" {
  count=0
  for package_file in "$REPO_ROOT"/v3/@hive-flow/*/package.json; do
    [ -e "$package_file" ] || continue
    count=$((count + 1))
  done

  [ "$count" -eq 4 ]
  run grep -F '4 packages' "$REPO_ROOT/v3/README.md"
  [ "$status" -eq 0 ]
}
