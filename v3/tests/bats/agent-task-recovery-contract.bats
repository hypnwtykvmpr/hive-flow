#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "agent task recovery contract fixture runs in isolated state" {
  run node "$REPO_ROOT/v3/tests/fixtures/agent-task-recovery-contract.mjs" matrix

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"isolated":true'* ]]
  [[ "$output" == *'"result-json-terminal-authority"'* ]]
  [[ "$output" == *'"esrch-only-proven-dead"'* ]]
}
