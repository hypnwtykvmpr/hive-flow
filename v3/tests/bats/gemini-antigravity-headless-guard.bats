#!/usr/bin/env bats
#
# DO-NOT-REVERT GUARD — `gemini-cli` provider must drive Google's ANTIGRAVITY CLI (`agy`).
#
# Google deprecated/killed "Gemini CLI"; the dead `@google/gemini-cli` (`gemini`)
# binary's backend returns HTTP 404 for current models:
#
#     code: 404  ModelNotFoundError: Requested entity was not found.
#
# Antigravity (binary `agy`, a Go rewrite) is the live replacement and ships
# the Gemini 3.6 Flash family. The provider MUST resolve `agy` and build
# headless args with --prompt/--model/--dangerously-skip-permissions, NOT the
# dead gemini flags --output-format / --skip-trust (which agy rejects).
#
# These checks are intentionally REDUNDANT with the vitest guards in
# cli/packages/providers/src/__tests__/gemini-antigravity-guard.test.ts and
# cli-providers.test.ts. They assert the source-level invariant directly so a
# regression fails loudly even if the unit suite is skipped. Static (grep) by
# default; the final test is a LIVE smoke test that runs only if `agy` is present.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  PROVIDER_SRC="$REPO_ROOT/cli/packages/providers/src/gemini-cli-provider.ts"
  CONSTANTS_SRC="$REPO_ROOT/cli/packages/providers/src/gemini-cli-constants.ts"
  GATE_SRC="$REPO_ROOT/cli/src/mcp-tools/mcp-enforcement-gate.ts"
  # Isolated home so nothing in these tests touches the real state tree.
  export HIVE_FLOW_HOME="$BATS_TEST_TMPDIR/hive-home"
  mkdir -p "$HIVE_FLOW_HOME"
}

@test "gemini-cli provider source exists" {
  [ -f "$PROVIDER_SRC" ]
}

@test "provider resolves the Antigravity agy binary and never gemini" {
  # findBinary must look up 'agy'.
  run grep -F -- "execFile(cmd, ['agy']" "$PROVIDER_SRC"
  [ "$status" -eq 0 ]
  # It must NOT look up the dead 'gemini' binary (comment lines are stripped first).
  run bash -c "grep -vE '^\s*//|^\s*\*' \"$PROVIDER_SRC\" | grep -F -- \"execFile(cmd, ['gemini']\""
  [ "$status" -ne 0 ]
}

@test "provider builds Antigravity headless args (--dangerously-skip-permissions)" {
  run grep -F -- "'--dangerously-skip-permissions'" "$PROVIDER_SRC"
  [ "$status" -eq 0 ]
}

@test "provider never passes the dead gemini flags output-format or skip-trust" {
  # Strip comment lines (DO-NOT-REVERT notes mention the forbidden flags on purpose).
  run bash -c "grep -vE '^\s*//|^\s*\*' \"$PROVIDER_SRC\" | grep -F -- \"'--output-format'\""
  [ "$status" -ne 0 ]
  run bash -c "grep -vE '^\s*//|^\s*\*' \"$PROVIDER_SRC\" | grep -F -- \"'--skip-trust'\""
  [ "$status" -ne 0 ]
}

@test "install hints point at Antigravity, not @google/gemini-cli" {
  # No live code line should ADVISE INSTALLING the dead package. Deprecation
  # notices that merely name @google/gemini-cli as dead are allowed; an actual
  # "npm i -g @google/gemini-cli" install instruction is not.
  run bash -c "grep -vE '^\s*//|^\s*\*' \"$PROVIDER_SRC\" | grep -iE 'npm i.*@google/gemini-cli|install:?\s*@google/gemini-cli|npm install.*@google/gemini-cli'"
  [ "$status" -ne 0 ]
  # Antigravity must be referenced as the install/auth target.
  run grep -iF -- "antigravity" "$PROVIDER_SRC"
  [ "$status" -eq 0 ]
}

@test "model gate uses the canonical current Antigravity default" {
  [ -f "$GATE_SRC" ]
  run grep -F -- "normInput.model !== GEMINI_CLI_DEFAULT_MODEL" "$GATE_SRC"
  [ "$status" -eq 0 ]
  run grep -F -- "export const GEMINI_CLI_DEFAULT_MODEL = 'gemini-3.6-flash-high'" \
    "$REPO_ROOT/cli/packages/providers/src/model-alias-resolver.ts"
  [ "$status" -eq 0 ]
}

@test "DO-NOT-REVERT markers are present in provider and constants" {
  run grep -F -- "DO-NOT-REVERT" "$PROVIDER_SRC"
  [ "$status" -eq 0 ]
  run grep -F -- "DO-NOT-REVERT" "$CONSTANTS_SRC"
  [ "$status" -eq 0 ]
}

@test "LIVE: agy headless invocation returns a grounded response (opt-in, RUN_LIVE_AGY=1)" {
  # Opt-in only. The DEFAULT bats run must stay fully static/offline/sandbox-safe:
  # a real `agy -p` writes to ~/.gemini (denied under a normal sandbox) and needs
  # an authenticated login, so it hangs/errors otherwise. Gate it behind an env so
  # the default suite never spawns agy.
  if [ -z "${RUN_LIVE_AGY:-}" ]; then
    skip "live agy smoke gated behind RUN_LIVE_AGY=1"
  fi
  if ! command -v agy >/dev/null 2>&1; then
    skip "agy (Antigravity CLI) not installed"
  fi
  run timeout 120 agy -p "reply with the single word READY" --model gemini-3.6-flash-high
  [ "$status" -eq 0 ]
  [[ "$output" == *READY* ]]
}
