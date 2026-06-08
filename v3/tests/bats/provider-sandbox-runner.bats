#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "provider sandbox runner fail-closed result is machine-readable" {
  run node "$REPO_ROOT/v3/tests/fixtures/provider-sandbox-fail-closed.mjs"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":false'* ]]
  [[ "$output" == *'"status":"denied"'* ]]
  [[ "$output" == *'"denyReason":"sandbox-unavailable:no-verified-backend"'* ]]
  [[ "$output" == *'"verifiedBackend":null'* ]]
}

@test "provider sandbox runner scripts parse cleanly" {
  run node --check "$REPO_ROOT/v3/@hive-flow/providers/scripts/sandbox-runner.mjs"

  [ "$status" -eq 0 ]
}
