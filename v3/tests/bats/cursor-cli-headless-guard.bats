#!/usr/bin/env bats
#
# DO-NOT-REVERT GUARD — Cursor provider must use the headless `cursor-agent` CLI.
#
# The cursor provider regressed in the past toward the Cursor IDE / "Background
# Agents" path, which is NOT headless: it blocks indefinitely with no stdout and
# surfaces as a hard ~300s caller timeout (SIGKILL) with an empty response.
#
# These checks are intentionally REDUNDANT with the vitest argv-guard tests in
# cli/packages/providers/src/__tests__/cli-providers.test.ts. They assert the
# source-level invariant directly so a regression fails loudly even if the unit
# suite is skipped. Static (grep) only — no live cursor-agent API calls.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  PROVIDER_SRC="$REPO_ROOT/cli/packages/providers/src/cursor-cli-provider.ts"
  AGENTIC_WRAPPER="$REPO_ROOT/cli/packages/providers/src/agentic-wrapper.ts"
  # Isolated home so nothing in these tests touches the real state tree.
  export HIVE_FLOW_HOME="$BATS_TEST_TMPDIR/hive-home"
  mkdir -p "$HIVE_FLOW_HOME"
}

@test "cursor provider source exists" {
  [ -f "$PROVIDER_SRC" ]
}

@test "cursor provider builds headless argv with --print and --force" {
  run grep -F -- "'--print'" "$PROVIDER_SRC"
  [ "$status" -eq 0 ]
  run grep -F -- "'--force'" "$PROVIDER_SRC"
  [ "$status" -eq 0 ]
}

@test "cursor provider prefers the cursor-agent CLI binary first" {
  # findBinary must list cursor-agent before the cursor launcher fallback.
  run grep -F -- "['cursor-agent', 'cursor']" "$PROVIDER_SRC"
  [ "$status" -eq 0 ]
}

@test "cursor provider NEVER invokes the Cursor IDE / Background Agents path" {
  # No background-agent / IDE-launch invocation may appear in CODE (comment lines,
  # which legitimately mention the forbidden path in DO-NOT-REVERT warnings, are
  # stripped before matching).
  run bash -c "grep -vE '^\s*//|^\s*\*' \"$PROVIDER_SRC\" | grep -iE 'background-agent|background_agent|--background|--gui|--editor'"
  [ "$status" -ne 0 ]
}

@test "agentic-wrapper cursor argv is the headless CLI (--print --trust --force)" {
  [ -f "$AGENTIC_WRAPPER" ]
  run grep -F -- "['--print', '--trust', '--force']" "$AGENTIC_WRAPPER"
  [ "$status" -eq 0 ]
}

@test "agentic-wrapper resolves cursor-agent before the cursor fallback" {
  run grep -F -- "'cursor-cli': ['cursor-agent', 'cursor']" "$AGENTIC_WRAPPER"
  [ "$status" -eq 0 ]
}

@test "DO-NOT-REVERT marker is present in the cursor provider" {
  run grep -F -- "DO-NOT-REVERT" "$PROVIDER_SRC"
  [ "$status" -eq 0 ]
}

@test "no Cursor IDE / Background Agents path exists across the providers package" {
  # Repo-wide guard over source (excludes build output, deps, comment lines, and
  # the guard test file itself which references the forbidden strings on purpose).
  run bash -c "grep -rIn --include='*.ts' --include='*.mjs' --include='*.cjs' -E 'background-agent|background_agent' \"$REPO_ROOT/cli/packages/providers/src\" \"$REPO_ROOT/cli/packages/providers/scripts\" 2>/dev/null | grep -vE ':\s*//|:\s*\*|not\.toContain|cli-providers\.test\.ts'"
  [ -z "$output" ]
}
