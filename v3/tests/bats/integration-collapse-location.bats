#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "retired @hive-flow/integration package metadata stays absent" {
  [ ! -e "$REPO_ROOT/v3/@hive-flow/integration/package.json" ]
  [ ! -e "$REPO_ROOT/v3/@hive-flow/integration/tsconfig.json" ]
  [ ! -e "$REPO_ROOT/v3/@hive-flow/integration/src/index.ts" ]
}

@test "integration source, tests, and docs live under cli" {
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/integration/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/integration/token-optimizer.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/integration/swarm-adapter.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/integration/__tests__/token-optimizer.test.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/docs/integration/README.md" ]
}

@test "cli package exports integration subpaths and no longer depends on retired package" {
  run grep -F '"./integration"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./dist/src/integration/index.js"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./integration/*"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"@hive-flow/integration"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 1 ]
}

@test "root package no longer bundles retired integration workspace" {
  run grep -F '"@hive-flow/integration"' "$REPO_ROOT/package.json"
  [ "$status" -eq 1 ]
  run grep -F "{ name: 'integration'" "$REPO_ROOT/v3/@hive-flow/cli/scripts/stage-bundled-workspaces.mjs"
  [ "$status" -eq 1 ]
}

@test "root TypeScript projects no longer reference retired integration package" {
  run grep -F '@hive-flow/integration' "$REPO_ROOT/tsconfig.json"
  [ "$status" -eq 1 ]
  run grep -F '@hive-flow/integration' "$REPO_ROOT/v3/tsconfig.json"
  [ "$status" -eq 1 ]
  run grep -F './@hive-flow/integration' "$REPO_ROOT/v3/tsconfig.json"
  [ "$status" -eq 1 ]
  run grep -F '@hive-flow/integration' "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
  run grep -F './@hive-flow/integration' "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
}

@test "adjacent packages and workers no longer point at retired integration package" {
  run grep -F '"@hive-flow/integration"' "$REPO_ROOT/v3/@hive-flow/embeddings/package.json"
  [ "$status" -eq 1 ]
  run grep -F "'@hive-flow/cli/integration'" "$REPO_ROOT/v3/@hive-flow/cli/src/hooks/workers/index.ts"
  [ "$status" -eq 0 ]
  run grep -F "path.join(v3Path, '@hive-flow/cli', 'src', 'integration')" "$REPO_ROOT/v3/@hive-flow/cli/src/hooks/workers/index.ts"
  [ "$status" -eq 0 ]
  run grep -F "path.join(v3Path, '@hive-flow/cli/src/integration')" "$REPO_ROOT/v3/@hive-flow/cli/src/hooks/workers/index.ts"
  [ "$status" -eq 1 ]
}

@test "tracked docs use cli integration subpath and real source location" {
  run grep -R '@hive-flow/integration' \
    "$REPO_ROOT/README.md" \
    "$REPO_ROOT/CLAUDE.md" \
    "$REPO_ROOT/v3/README.md" \
    "$REPO_ROOT/v3/@hive-flow/cli/README.md" \
    "$REPO_ROOT/v3/CHANGELOG.md" \
    "$REPO_ROOT/v3/@hive-flow/cli/docs/integration/README.md" \
    "$REPO_ROOT/v3/@hive-flow/shared/README.md" \
    "$REPO_ROOT/v3/@hive-flow/cli/docs/neural/README.md"
  [ "$status" -eq 1 ]

  run grep -F '@hive-flow/cli/integration' "$REPO_ROOT/v3/@hive-flow/cli/docs/integration/README.md"
  [ "$status" -eq 0 ]
  run grep -F './v3/@hive-flow/cli/src/integration/' "$REPO_ROOT/README.md"
  [ "$status" -eq 0 ]
  run grep -F './@hive-flow/cli/src/integration/' "$REPO_ROOT/v3/README.md"
  [ "$status" -eq 0 ]
  run grep -F './src/integration/' "$REPO_ROOT/v3/@hive-flow/cli/README.md"
  [ "$status" -eq 0 ]
}

@test "lockfiles no longer declare retired integration importer" {
  run grep -F 'v3/@hive-flow/integration:' "$REPO_ROOT/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
  run grep -F "  '@hive-flow/integration':" "$REPO_ROOT/v3/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
}

@test "v3 package count reflects retired integration package" {
  count=0
  for package_file in "$REPO_ROOT"/v3/@hive-flow/*/package.json; do
    [ -e "$package_file" ] || continue
    count=$((count + 1))
  done

  [ "$count" -eq 7 ]
  run grep -F '7 packages' "$REPO_ROOT/v3/README.md"
  [ "$status" -eq 0 ]
}
