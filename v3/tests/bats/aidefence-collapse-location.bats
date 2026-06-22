#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "retired @hive-flow/aidefence package metadata stays absent" {
  [ ! -e "$REPO_ROOT/v3/@hive-flow/aidefence/package.json" ]
  [ ! -e "$REPO_ROOT/v3/@hive-flow/aidefence/tsconfig.json" ]
  [ ! -e "$REPO_ROOT/v3/@hive-flow/aidefence/src/index.ts" ]
}

@test "aidefence source, tests, and docs live under cli" {
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/aidefence/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/aidefence/domain/services/threat-detection-service.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/aidefence/domain/services/threat-learning-service.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/aidefence/__tests__/threat-detection.test.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/docs/aidefence/README.md" ]
}

@test "cli package exports aidefence subpaths and no longer depends on retired package" {
  run grep -F '"./aidefence"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./dist/src/aidefence/index.js"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./aidefence/detection"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./aidefence/learning"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"@hive-flow/aidefence"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 1 ]
}

@test "security command and MCP tools load in-package aidefence" {
  run grep -F "import('../aidefence/index.js')" "$REPO_ROOT/v3/@hive-flow/cli/src/commands/security.ts"
  [ "$status" -eq 0 ]
  run grep -F "import('../aidefence/index.js')" "$REPO_ROOT/v3/@hive-flow/cli/src/mcp-tools/security-tools.ts"
  [ "$status" -eq 0 ]
  run grep -F '@hive-flow/aidefence' "$REPO_ROOT/v3/@hive-flow/cli/src/mcp-tools/security-tools.ts"
  [ "$status" -eq 1 ]
  run grep -F '@hive-flow/aidefence' "$REPO_ROOT/v3/@hive-flow/cli/src/commands/security.ts"
  [ "$status" -eq 1 ]
}

@test "optional installer and adjacent manifests no longer advertise retired aidefence package" {
  run grep -F '@hive-flow/aidefence' "$REPO_ROOT/v3/@hive-flow/cli/src/mcp-tools/auto-install.ts"
  [ "$status" -eq 1 ]
  run grep -F '@hive-flow/aidefence' "$REPO_ROOT/v3/plugins/prime-radiant/src/index.ts"
  [ "$status" -eq 1 ]
  run grep -F '@hive-flow/aidefence' "$REPO_ROOT/v3/plugins/prime-radiant/plugin.yaml"
  [ "$status" -eq 1 ]
  run grep -F '@hive-flow/cli' "$REPO_ROOT/v3/plugins/prime-radiant/plugin.yaml"
  [ "$status" -eq 0 ]
}

@test "root TypeScript projects no longer reference retired aidefence package" {
  run grep -F '@hive-flow/aidefence' "$REPO_ROOT/v3/tsconfig.json"
  [ "$status" -eq 1 ]
  run grep -F './@hive-flow/aidefence' "$REPO_ROOT/v3/tsconfig.json"
  [ "$status" -eq 1 ]
  run grep -F '@hive-flow/aidefence' "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
  run grep -F './@hive-flow/aidefence' "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
}

@test "tracked docs use cli aidefence subpath" {
  run grep -R '@hive-flow/aidefence' \
    "$REPO_ROOT/README.md" \
    "$REPO_ROOT/CLAUDE.md" \
    "$REPO_ROOT/v3/@hive-flow/cli/README.md" \
    "$REPO_ROOT/v3/@hive-flow/cli/docs/aidefence/README.md" \
    "$REPO_ROOT/v3/@hive-flow/cli/.claude/skills/aidefence-scan.md" \
    "$REPO_ROOT/v3/@hive-flow/cli/.claude/skills/secure-review.md"
  [ "$status" -eq 1 ]

  run grep -F '@hive-flow/cli/aidefence' "$REPO_ROOT/v3/@hive-flow/cli/docs/aidefence/README.md"
  [ "$status" -eq 0 ]
  run grep -F '@hive-flow/cli/aidefence' "$REPO_ROOT/v3/@hive-flow/cli/.claude/skills/aidefence-scan.md"
  [ "$status" -eq 0 ]
  run grep -F '@hive-flow/cli/aidefence' "$REPO_ROOT/v3/@hive-flow/cli/.claude/skills/secure-review.md"
  [ "$status" -eq 0 ]
}

@test "lockfiles no longer declare retired aidefence importer" {
  run grep -F 'v3/@hive-flow/aidefence:' "$REPO_ROOT/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
  run grep -F "  '@hive-flow/aidefence':" "$REPO_ROOT/v3/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
}

@test "v3 package count reflects retired aidefence package" {
  count=0
  for package_file in "$REPO_ROOT"/v3/@hive-flow/*/package.json; do
    [ -e "$package_file" ] || continue
    count=$((count + 1))
  done

  [ "$count" -eq 12 ]
  run grep -F '12 packages' "$REPO_ROOT/v3/README.md"
  [ "$status" -eq 0 ]
}
