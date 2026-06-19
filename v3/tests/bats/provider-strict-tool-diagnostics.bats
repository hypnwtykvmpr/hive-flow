#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SCRIPT="$REPO_ROOT/v3/@hive-flow/providers/scripts/diagnose-strict-provider-tools.mjs"
}

@test "strict provider diagnostic script documents the live-only contract" {
  run node "$SCRIPT" --help

  [ "$status" -eq 0 ]
  [[ "$output" == *"--live"* ]]
  [[ "$output" == *"openrouter"* ]]
  [[ "$output" == *"deepseek"* ]]
  [[ "$output" == *"write_file"* ]]
  [[ "$output" == *"edit_file"* ]]
  [[ "$output" == *"web_fetch"* ]]
  [[ "$output" == *"web_search"* ]]
  [[ "$output" == *"--project-root"* ]]
}

@test "strict provider diagnostic script refuses accidental quota use without --live" {
  run node "$SCRIPT" --provider openrouter --tool web_fetch --json

  [ "$status" -ne 0 ]
  [[ "$output" == *"Refusing to run provider diagnostics without --live"* ]]
}
