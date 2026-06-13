#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "provider bridge capability manifest derives default and strict tool sets" {
  run node "$REPO_ROOT/v3/tests/fixtures/provider-bridge-capability-manifest.mjs" "$REPO_ROOT"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"defaultNames":["read_file","write_file","edit_file","list_directory","grep","find_file","run_shell","web_fetch","web_search"]'* ]]
  [[ "$output" == *'"strictNames":["read_file","list_directory","grep","find_file","run_command"]'* ]]
  [[ "$output" == *'"writeFileStrict":false'* ]]
  [[ "$output" == *'"runCommandStrict":true'* ]]
  [[ "$output" != *'mcp__'* ]]
}
