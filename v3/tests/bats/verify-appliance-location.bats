#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "appliance verification script lives under the canonical CLI package path" {
  [ -f "$REPO_ROOT/cli/scripts/verify-appliance.sh" ]
  [ ! -e "$REPO_ROOT/scripts/verify-appliance.sh" ]
}

@test "CLI package ships the appliance verification script" {
  run node -e '
    const { readFileSync } = require("node:fs");
    const pkg = JSON.parse(readFileSync(process.argv[1], "utf8"));
    if (!pkg.files?.includes("scripts/verify-appliance.sh")) {
      console.error(JSON.stringify(pkg.files, null, 2));
      process.exit(1);
    }
  ' "$REPO_ROOT/cli/package.json"
  [ "$status" -eq 0 ]
}

@test "appliance builder no longer references the retired root script path" {
  run node -e '
    const { readFileSync } = require("node:fs");
    const src = readFileSync(process.argv[1], "utf8");
    if (src.includes("../../../../scripts/verify-appliance.sh")) process.exit(1);
    if (!src.includes("resolveVerifyApplianceScript")) process.exit(1);
  ' "$REPO_ROOT/cli/src/appliance/appliance-builder.ts"
  [ "$status" -eq 0 ]
}

@test "canonical appliance verification script is syntactically valid" {
  run sh -n "$REPO_ROOT/cli/scripts/verify-appliance.sh"
  [ "$status" -eq 0 ]
}
