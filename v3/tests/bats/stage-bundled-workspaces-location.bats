#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "bundled workspace staging script lives under the canonical CLI package path" {
  [ -f "$REPO_ROOT/cli/scripts/stage-bundled-workspaces.mjs" ]
  [ ! -e "$REPO_ROOT/scripts/stage-bundled-workspaces.mjs" ]
}

@test "cli package prepack invokes the canonical package-local staging script" {
  run node -e '
    const { readFileSync } = require("node:fs");
    const pkg = JSON.parse(readFileSync(process.argv[1], "utf8"));
    if (pkg.scripts?.prepack !== "node scripts/stage-bundled-workspaces.mjs") {
      console.error(pkg.scripts?.prepack);
      process.exit(1);
    }
  ' "$REPO_ROOT/cli/package.json"
  [ "$status" -eq 0 ]
}

@test "canonical staging script is syntactically valid from its nested location" {
  run node --check "$REPO_ROOT/cli/scripts/stage-bundled-workspaces.mjs"
  [ "$status" -eq 0 ]
}
