#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "retired browser package directory is absent" {
  [ ! -e "$REPO_ROOT/v3/@hive-flow/browser" ]
}

@test "browser source, tests, docs, and docker assets live under cli" {
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/browser/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/browser/application/browser-service.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/browser/mcp-tools/index.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/src/browser/__tests__/browser-service.test.ts" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/docs/browser/README.md" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/docker/browser/Dockerfile" ]
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/docker/browser/test-fixtures/index.html" ]
}

@test "cli package publishes browser subpaths and owns agent-browser dependency" {
  run grep -F '"./browser"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./dist/src/browser/index.js"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./browser/mcp-tools"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./browser/skill"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"./browser/agent"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
  run grep -F '"agent-browser": "^0.6.0"' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
}

@test "root TypeScript projects no longer reference retired browser package" {
  run grep -F '@hive-flow/browser' "$REPO_ROOT/v3/tsconfig.json" "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
  run grep -F './@hive-flow/browser' "$REPO_ROOT/v3/tsconfig.json" "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
}

@test "lockfiles no longer declare retired browser workspace importer" {
  run grep -F 'v3/@hive-flow/browser:' "$REPO_ROOT/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
  run grep -F "'@hive-flow/browser':" "$REPO_ROOT/v3/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
}

@test "v3 package count reflects retired browser package" {
  count=0
  for package_file in "$REPO_ROOT"/v3/@hive-flow/*/package.json; do
    [ -e "$package_file" ] || continue
    count=$((count + 1))
  done

  [ "$count" -eq 3 ]
  run grep -F '3 packages' "$REPO_ROOT/v3/README.md"
  [ "$status" -eq 0 ]
}

@test "tracked docs and plugin manifests use cli browser canonical location" {
  run grep -R '@hive-flow/browser' \
    "$REPO_ROOT/README.md" \
    "$REPO_ROOT/v3/README.md" \
    "$REPO_ROOT/v3/@hive-flow/cli/README.md" \
    "$REPO_ROOT/v3/@hive-flow/cli/docs/browser/README.md" \
    "$REPO_ROOT/v3/plugins/agentic-qe/package.json" \
    "$REPO_ROOT/v3/plugins/agentic-qe/plugin.yaml" \
    "$REPO_ROOT/v3/plugins/agentic-qe/src/index.ts"
  [ "$status" -eq 1 ]

  run grep -F '@hive-flow/cli/browser' "$REPO_ROOT/v3/@hive-flow/cli/docs/browser/README.md"
  [ "$status" -eq 0 ]
  run grep -F './v3/@hive-flow/cli/docs/browser/README.md' "$REPO_ROOT/README.md"
  [ "$status" -eq 0 ]
}

@test "registered cli browser MCP tools are preserved separately from browser package subpath" {
  run grep -F "from './mcp-tools/browser-tools.js'" "$REPO_ROOT/v3/@hive-flow/cli/src/mcp-client.ts"
  [ "$status" -eq 0 ]
  run grep -F "name: 'browser_open'" "$REPO_ROOT/v3/@hive-flow/cli/src/mcp-tools/browser-tools.ts"
  [ "$status" -eq 0 ]
  run grep -F "name: 'browser/open'" "$REPO_ROOT/v3/@hive-flow/cli/src/mcp-tools/browser-tools.ts"
  [ "$status" -eq 1 ]
}
