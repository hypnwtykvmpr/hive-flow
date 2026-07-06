#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "retired hooks package directory is absent" {
  [ ! -e "$REPO_ROOT/v3/@hive-flow/hooks" ]
}

@test "hooks source, tests, docs, and bins live under cli" {
  [ -f "$REPO_ROOT/cli/src/hooks/index.ts" ]
  [ -f "$REPO_ROOT/cli/src/hooks/registry/index.ts" ]
  [ -f "$REPO_ROOT/cli/src/hooks/executor/index.ts" ]
  [ -f "$REPO_ROOT/cli/src/hooks/workers/index.ts" ]
  [ -f "$REPO_ROOT/cli/src/hooks/__tests__/hooks.test.ts" ]
  [ -f "$REPO_ROOT/cli/src/hooks/__tests__/workers.test.ts" ]
  [ -f "$REPO_ROOT/cli/docs/hooks/README.md" ]
  [ -f "$REPO_ROOT/cli/bin/hooks-daemon.js" ]
  [ -f "$REPO_ROOT/cli/bin/hooks-statusline.js" ]
}

@test "cli publishes hooks subpaths and non-conflicting bins" {
  run grep -F '"./hooks"' "$REPO_ROOT/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./dist/src/hooks/index.js"' "$REPO_ROOT/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./hooks/registry"' "$REPO_ROOT/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"hooks-daemon": "./bin/hooks-daemon.js"' "$REPO_ROOT/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"hooks-statusline": "./bin/hooks-statusline.js"' "$REPO_ROOT/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"statusline": "./bin/hooks-statusline.js"' "$REPO_ROOT/cli/package.json"
  [ "$status" -eq 1 ]
}

@test "cli no longer depends on retired hooks workspace" {
  run grep -F '"@hive-flow/hooks"' "$REPO_ROOT/cli/package.json"
  [ "$status" -eq 1 ]
}

@test "root TypeScript projects no longer reference retired hooks package" {
  run grep -F '@hive-flow/hooks' "$REPO_ROOT/v3/tsconfig.json" "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
  run grep -F './@hive-flow/hooks' "$REPO_ROOT/v3/tsconfig.json" "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
}

@test "lockfiles no longer declare the retired hooks workspace importer" {
  run grep -F 'v3/@hive-flow/hooks:' "$REPO_ROOT/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
  run grep -F "'@hive-flow/hooks':" "$REPO_ROOT/v3/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
}

@test "v3 package count reflects retired hooks package" {
  count=0
  for package_file in "$REPO_ROOT"/cli/package.json "$REPO_ROOT"/cli/packages/*/package.json; do
    [ -e "$package_file" ] || continue
    count=$((count + 1))
  done

  [ "$count" -eq 5 ]
  run grep -F '5 packages' "$REPO_ROOT/v3/README.md"
  [ "$status" -eq 0 ]
}

@test "tracked source and docs use cli hooks canonical location" {
  run grep -R '@hive-flow/hooks' \
    "$REPO_ROOT/README.md" \
    "$REPO_ROOT/CLAUDE.md" \
    "$REPO_ROOT/v3/README.md" \
    "$REPO_ROOT/v3/CLAUDE.md" \
    "$REPO_ROOT/cli/README.md" \
    "$REPO_ROOT/cli/src" \
    "$REPO_ROOT/cli/docs/hooks/README.md" \
    "$REPO_ROOT/cli/docs/memory/README.md" \
    "$REPO_ROOT/cli/docs/shared/README.md"
  [ "$status" -eq 1 ]

  run grep -F '@hive-flow/cli/hooks' "$REPO_ROOT/cli/docs/hooks/README.md"
  [ "$status" -eq 0 ]
}
