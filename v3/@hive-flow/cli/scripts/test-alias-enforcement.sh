#!/usr/bin/env bash
# End-to-end smoke test for alias resolution + enforcement gate.
#
# Spawns agents via the CLI for every (provider x alias) combination and
# asserts the gate accepts/rejects correctly. NOT a unit test.
#
# WARNING: This script has side effects. It will write to
# .hive-flow/agents/store.json (or equivalent) for every successful spawn.
# Run in a scratch directory or be prepared to clean up afterwards.

set -uo pipefail

CLI=v3/@hive-flow/cli/bin/cli.js
PASS=0
FAIL=0
FAILS_LOG=$(mktemp)

assert_spawn_succeeds() {
  local desc="$1" provider="$2" model="$3"
  if node "$CLI" agent spawn -t coder --provider "$provider" --model "$model" >/dev/null 2>&1; then
    echo "PASS: $desc"
    PASS=$((PASS+1))
  else
    echo "FAIL: $desc - spawn unexpectedly failed"
    FAIL=$((FAIL+1))
    echo "$desc" >> "$FAILS_LOG"
  fi
}

assert_spawn_blocked() {
  local desc="$1" provider="$2" model="$3"
  if node "$CLI" agent spawn -t coder --provider "$provider" --model "$model" >/dev/null 2>&1; then
    echo "FAIL: $desc - spawn unexpectedly succeeded"
    FAIL=$((FAIL+1))
    echo "$desc" >> "$FAILS_LOG"
  else
    echo "PASS: $desc (blocked as expected)"
    PASS=$((PASS+1))
  fi
}

# Positive smoke tests - all 4 valid aliases for all providers
for provider in anthropic-cli gemini-cli codex-cli cursor-cli deepseek openrouter; do
  for model in opus sonnet mini inherit; do
    assert_spawn_succeeds "$provider + $model" "$provider" "$model"
  done
done

# Negative - haiku always blocked (Rule 1: Haiku strictly forbidden)
for provider in anthropic-cli gemini-cli codex-cli cursor-cli deepseek; do
  assert_spawn_blocked "$provider + haiku (Rule 1)" "$provider" "haiku"
done

# Negative - gpt-5.4 for codex-cli (rollout exception removed)
assert_spawn_blocked "codex-cli + gpt-5.4 (rollout removed)" "codex-cli" "gpt-5.4"

# Negative - gpt-4o for codex-cli
assert_spawn_blocked "codex-cli + gpt-4o (wrong provider)" "codex-cli" "gpt-4o"

# Negative - non-canonical gemini model
assert_spawn_blocked "gemini-cli + gpt-5.5 (wrong provider)" "gemini-cli" "gpt-5.5"

# Negative - openrouter with no model
if node "$CLI" agent spawn -t coder --provider openrouter >/dev/null 2>&1; then
  echo "FAIL: openrouter + no model - spawn unexpectedly succeeded"
  FAIL=$((FAIL+1))
else
  echo "PASS: openrouter + no model (blocked as expected)"
  PASS=$((PASS+1))
fi

echo ""
echo "Summary: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "Failures:"
  cat "$FAILS_LOG"
  exit 1
fi
exit 0
