#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "provider bridge subprocess contract covers fs, shell, and web without public network" {
  run node "$REPO_ROOT/v3/tests/fixtures/provider-bridge-contract.mjs" all "$REPO_ROOT"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"readFile":"bats bridge read'* ]]
  [[ "$output" == *'"runShellDenied":"sandbox-unavailable:no-verified-backend"'* ]]
  [[ "$output" == *'"webDenied":"allowlist-denied"'* ]]
  [[ "$output" == *'"webSearch":"web-search-unsupported"'* ]]
  [[ "$output" == *'"publicNetwork":false'* ]]
}
