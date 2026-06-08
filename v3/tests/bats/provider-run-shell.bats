#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "provider run_shell fails closed when sandbox is unavailable" {
  run node "$REPO_ROOT/v3/tests/fixtures/provider-run-shell-contract.mjs" fail-closed "$REPO_ROOT"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"status":"denied"'* ]]
  [[ "$output" == *'"exitCode":null'* ]]
  [[ "$output" == *'"denyReason":"sandbox-unavailable:no-verified-backend"'* ]]
  [[ "$output" == *'"sandboxBackend":null'* ]]
}

@test "provider run_shell denies inline execution through the shell guard" {
  run node "$REPO_ROOT/v3/tests/fixtures/provider-run-shell-contract.mjs" attack "$REPO_ROOT"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"status":"denied"'* ]]
  [[ "$output" == *'"exitCode":null'* ]]
  [[ "$output" == *'"denyReason":"bash-gate-denied"'* ]]
  [[ "$output" != *'"denyReason":"unknown-tool"'* ]]
}

@test "provider run_shell denies when write is restricted" {
  run node "$REPO_ROOT/v3/tests/fixtures/provider-run-shell-contract.mjs" restricted "$REPO_ROOT"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"status":"denied"'* ]]
  [[ "$output" == *'"exitCode":null'* ]]
  [[ "$output" == *'"denyReason":"restricted-exec-or-write"'* ]]
}
