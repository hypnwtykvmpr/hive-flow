#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "retired @hive-flow/performance package metadata stays absent" {
  [ ! -e "$REPO_ROOT/v3/@hive-flow/performance/package.json" ]
  [ ! -e "$REPO_ROOT/v3/@hive-flow/performance/tsconfig.json" ]
  [ ! -e "$REPO_ROOT/v3/@hive-flow/performance/src/index.ts" ]
}

@test "performance source, tests, benchmarks, and docs live under cli" {
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/performance/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/performance/framework/benchmark.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/performance/__tests__/attention.test.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/benchmarks/performance/attention/multi-head-attention.bench.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/docs/performance/README.md" ]
}

@test "cli package exports performance and owns benchmark scripts" {
  run grep -F '"./performance"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./dist/src/performance/index.js"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"bench:performance"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F 'pnpm --filter @hive-flow/cli bench:performance' "$REPO_ROOT/v3/package.json"
  [ "$status" -eq 0 ]
}

@test "root TypeScript projects no longer reference retired performance package" {
  run grep -F '@hive-flow/performance' "$REPO_ROOT/v3/tsconfig.json"
  [ "$status" -eq 1 ]
  run grep -F './@hive-flow/performance' "$REPO_ROOT/v3/tsconfig.json"
  [ "$status" -eq 1 ]
  run grep -F '@hive-flow/performance' "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
  run grep -F './@hive-flow/performance' "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
}

@test "registry and plugin help do not advertise retired performance package" {
  run grep -F '@hive-flow/performance' "$REPO_ROOT/CLAUDE.md"
  [ "$status" -eq 1 ]
  run grep -F '@hive-flow/performance' "$REPO_ROOT/v3/@hive-flow/cli/src/plugins/store/discovery.ts"
  [ "$status" -eq 1 ]
  run grep -F '@hive-flow/performance' "$REPO_ROOT/v3/@hive-flow/cli/scripts/publish-registry.ts"
  [ "$status" -eq 1 ]
  run grep -F '@hive-flow/performance' "$REPO_ROOT/v3/@hive-flow/cli/src/commands/plugins.ts"
  [ "$status" -eq 1 ]
  run grep -F '@hive-flow/plugin-perf-optimizer' "$REPO_ROOT/v3/@hive-flow/cli/src/commands/plugins.ts"
  [ "$status" -eq 0 ]
  run grep -F '@hive-flow/plugin-perf-optimizer' "$REPO_ROOT/CLAUDE.md"
  [ "$status" -eq 0 ]
}

@test "root and packaged metrics helpers use cli performance location" {
  run grep -F '@hive-flow/performance' "$REPO_ROOT/.claude/helpers/sync-v3-metrics.sh"
  [ "$status" -eq 1 ]
  run grep -F '@hive-flow/performance' "$REPO_ROOT/v3/@hive-flow/cli/.claude/helpers/sync-v3-metrics.sh"
  [ "$status" -eq 1 ]
  run grep -F '@hive-flow/cli/src/performance' "$REPO_ROOT/.claude/helpers/sync-v3-metrics.sh"
  [ "$status" -eq 0 ]
  run grep -F '@hive-flow/cli/src/performance' "$REPO_ROOT/v3/@hive-flow/cli/.claude/helpers/sync-v3-metrics.sh"
  [ "$status" -eq 0 ]
}

@test "tracked docs use cli performance subpath instead of retired package" {
  run grep -R '@hive-flow/performance' \
    "$REPO_ROOT/README.md" \
    "$REPO_ROOT/CLAUDE.md" \
    "$REPO_ROOT/v3/README.md" \
    "$REPO_ROOT/v3/@hive-flow/cli/README.md" \
    "$REPO_ROOT/v3/CHANGELOG.md" \
    "$REPO_ROOT/v3/@hive-flow/cli/docs/performance" \
    "$REPO_ROOT/v3/@hive-flow/shared/README.md" \
    "$REPO_ROOT/v3/@hive-flow/neural/README.md" \
    "$REPO_ROOT/v3/@hive-flow/integration/README.md"
  [ "$status" -eq 1 ]
}

@test "v3 package count remains current after later package collapses" {
  count=0
  for package_file in "$REPO_ROOT"/v3/@hive-flow/*/package.json; do
    [ -e "$package_file" ] || continue
    count=$((count + 1))
  done

  [ "$count" -eq 16 ]
  run grep -F '16 packages' "$REPO_ROOT/v3/README.md"
  [ "$status" -eq 0 ]
}
