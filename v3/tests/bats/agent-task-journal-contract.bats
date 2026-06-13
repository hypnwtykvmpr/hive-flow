#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "agent task journal fixture is isolated, redacted, and replayable" {
  run node "$REPO_ROOT/v3/tests/fixtures/agent-task-journal-contract.mjs"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"terminalCount":1'* ]]
  [[ "$output" == *'"isolated":true'* ]]
}
