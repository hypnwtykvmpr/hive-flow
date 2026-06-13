#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "OpenRouter model pins do not revert" {
  run node "$REPO_ROOT/v3/tests/fixtures/provider-openrouter-model-pins.mjs" "$REPO_ROOT"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"miniMaxM3":"minimax/minimax-m3"'* ]]
  [[ "$output" == *'"qwenPlus":"qwen/qwen3.7-plus"'* ]]
  [[ "$output" == *'"grok43":"x-ai/grok-4.3"'* ]]
  [[ "$output" == *'"xiaomiMimo":"xiaomi/mimo-v2.5-pro"'* ]]
}
