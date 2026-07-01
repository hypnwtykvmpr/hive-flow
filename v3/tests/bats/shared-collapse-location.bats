#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "retired @hive-flow/shared package metadata stays absent" {
  [ ! -e "$REPO_ROOT/v3/@hive-flow/shared/package.json" ]
  [ ! -e "$REPO_ROOT/v3/@hive-flow/shared/tsconfig.json" ]
  [ ! -e "$REPO_ROOT/v3/@hive-flow/shared/src/index.ts" ]
}

@test "shared source and docs live under the cli package" {
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/shared/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/shared/core/config/defaults.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/shared/events/binary-event-log.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/shared/workflow/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/docs/shared/README.md" ]
}

@test "cli package exports the replacement shared subpaths" {
  run node --input-type=module -e "import { readFileSync } from 'node:fs'; const pkg = JSON.parse(readFileSync('$REPO_ROOT/v3/@hive-flow/cli/package.json', 'utf8')); const exports = pkg.exports || {}; const required = ['./shared','./shared/types','./shared/core','./shared/core/config/defaults','./shared/events','./shared/hooks','./shared/mcp','./shared/security','./shared/resilience','./shared/utils/*','./shared/workflow']; if (required.some((key) => !exports[key]?.types || !exports[key]?.import)) process.exit(1); const depFields = ['dependencies','devDependencies','optionalDependencies','peerDependencies']; if (depFields.some((field) => pkg[field]?.['@hive-flow/shared'])) process.exit(2);"
  [ "$status" -eq 0 ]
}

@test "root and embeddings packages no longer depend on retired shared package" {
  run node --input-type=module -e "import { readFileSync } from 'node:fs'; const root = JSON.parse(readFileSync('$REPO_ROOT/package.json', 'utf8')); const emb = JSON.parse(readFileSync('$REPO_ROOT/cli/packages/embeddings/package.json', 'utf8')); if (root.dependencies?.['@hive-flow/shared']) process.exit(1); if ((root.bundledDependencies || []).includes('@hive-flow/shared')) process.exit(2); if ((root.files || []).some((entry) => entry.includes('v3/@hive-flow/shared'))) process.exit(3); if (emb.dependencies?.['@hive-flow/shared']) process.exit(4);"
  [ "$status" -eq 0 ]
}

@test "root TypeScript projects no longer reference retired shared package" {
  run grep -F '@hive-flow/shared' "$REPO_ROOT/v3/tsconfig.json" "$REPO_ROOT/v3/tsconfig.vitest-temp.json" "$REPO_ROOT/cli/packages/embeddings/tsconfig.json"
  [ "$status" -eq 1 ]
  run grep -F './@hive-flow/shared' "$REPO_ROOT/v3/tsconfig.json" "$REPO_ROOT/v3/tsconfig.vitest-temp.json" "$REPO_ROOT/cli/packages/embeddings/tsconfig.json"
  [ "$status" -eq 1 ]
}

@test "lockfiles no longer declare the retired shared workspace importer" {
  run rg -n "('@hive-flow/shared':|@hive-flow/shared:|v3/@hive-flow/shared:|link:../shared|link:v3/@hive-flow/shared)" "$REPO_ROOT/v3/pnpm-lock.yaml" "$REPO_ROOT/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
}

@test "tracked files no longer reference retired shared package paths or specifiers" {
  run git -C "$REPO_ROOT" grep -n -E "@hive-flow/shared|v3/@hive-flow/shared" -- \
    ':!v3/tests/bats/shared-collapse-location.bats'
  [ "$status" -eq 1 ]
}

@test "embeddings package remains independent from cli/shared cycle" {
  run rg -n "@hive-flow/(shared|cli/shared)" "$REPO_ROOT/cli/packages/embeddings/src" "$REPO_ROOT/cli/packages/embeddings/package.json" "$REPO_ROOT/cli/packages/embeddings/tsconfig.json"
  [ "$status" -eq 1 ]
  run grep -F "function generateSecureId(prefix?: string, length = 12): string" "$REPO_ROOT/cli/packages/embeddings/src/binary-embedding-cache.ts"
  [ "$status" -eq 0 ]
}

@test "v3 package count reflects retired shared package" {
  run find "$REPO_ROOT/v3/@hive-flow" -maxdepth 2 -name package.json -print
  [ "$status" -eq 0 ]
  count=$(printf "%s\n" "$output" | sed '/^$/d' | wc -l | tr -d ' ')
  [ "$count" -eq 3 ]

  run grep -F '3 packages' "$REPO_ROOT/v3/README.md"
  [ "$status" -eq 0 ]
}
