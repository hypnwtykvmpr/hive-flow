#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "progress authority classifier source fixture pins mandatory invariants" {
  run node "$REPO_ROOT/v3/tests/fixtures/progress-authority-classifier.mjs"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"pure-clock"'* ]]
  [[ "$output" == *'"secret-redaction-property"'* ]]
  [[ "$output" == *'"read-only-guard-test"'* ]]
}

@test "progress authority classifier focused vitest suite passes against source" {
  run npm --prefix "$REPO_ROOT/v3/@hive-flow/cli" exec vitest run src/progress/__tests__/progress-authority-classifier.test.ts

  [ "$status" -eq 0 ]
  [[ "$output" == *'progress-authority-classifier.test.ts'* ]]
}
