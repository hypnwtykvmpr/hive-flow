#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "engine sync script lives under the canonical CLI package path" {
  [ -f "$REPO_ROOT/v3/@hive-flow/cli/scripts/sync-engine-anchor.mjs" ]
  [ ! -e "$REPO_ROOT/scripts/sync-engine-anchor.mjs" ]
}

@test "CLI build scripts invoke the canonical engine sync script" {
  run node -e '
    const { readFileSync } = require("node:fs");
    const pkg = JSON.parse(readFileSync(process.argv[1], "utf8"));
    if (!pkg.scripts?.build?.includes("node scripts/sync-engine-anchor.mjs")) {
      console.error(pkg.scripts?.build);
      process.exit(1);
    }
    if (pkg.scripts?.["sync:engine"] !== "node scripts/sync-engine-anchor.mjs") {
      console.error(pkg.scripts?.["sync:engine"]);
      process.exit(1);
    }
  ' "$REPO_ROOT/v3/@hive-flow/cli/package.json"
  [ "$status" -eq 0 ]
}

@test "canonical engine sync script is syntactically valid from its nested location" {
  run node --check "$REPO_ROOT/v3/@hive-flow/cli/scripts/sync-engine-anchor.mjs"
  [ "$status" -eq 0 ]
}
