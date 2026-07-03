#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "credential CLI surfaces are discoverable without touching secret material" {
  run node "$REPO_ROOT/cli/bin/cli.js" config
  [ "$status" -eq 0 ]
  [[ "$output" == *"key        - Manage provider keys in the credential store"* ]]
  [[ "$output" != *"API_KEY"* ]]

  run node "$REPO_ROOT/cli/bin/cli.js" setup
  [ "$status" -eq 0 ]
  [[ "$output" == *"global, credentials, providers, permission-guard"* ]]
  [[ "$output" != *"API_KEY"* ]]

  run node "$REPO_ROOT/cli/bin/cli.js" providers
  [ "$status" -eq 0 ]
  [[ "$output" == *"configure - Configure provider settings and API keys"* ]]
  [[ "$output" == *"test      - Test provider connectivity"* ]]
}

@test "config key set preserves blank no-op and vault enrollment consent-count contracts" {
  run npm --prefix "$REPO_ROOT/cli" exec vitest run \
    src/__tests__/credential-cli-surfaces.test.ts \
    src/credential-store/__tests__/holder-runtime.test.ts

  [ "$status" -eq 0 ]
  [[ "$output" == *"Test Files  2 passed"* ]]
  [[ "$output" == *"Tests  20 passed"* ]]
}
