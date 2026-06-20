#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  PROJECT_DIR="$(mktemp -d)"
  SCRIPT="$PROJECT_DIR/.claude/helpers/enforcement.cjs"
  mkdir -p "$PROJECT_DIR/.claude/helpers" "$PROJECT_DIR/.hive-flow/enforcement"
  export HIVE_FLOW_HOME="$PROJECT_DIR/global-hive-home"
  cp "$REPO_ROOT/.claude/helpers/enforcement.cjs" "$SCRIPT"
  mkdir -p "$PROJECT_DIR/v3/@hive-flow/cli/src/permission-guard"
  cp "$REPO_ROOT/v3/@hive-flow/cli/src/permission-guard/protected-paths.cjs" "$PROJECT_DIR/v3/@hive-flow/cli/src/permission-guard/protected-paths.cjs"
  cp "$REPO_ROOT/v3/@hive-flow/cli/src/permission-guard/protected-paths.policy.json" "$PROJECT_DIR/v3/@hive-flow/cli/src/permission-guard/protected-paths.policy.json"
  export HIVE_FLOW_PROJECT_ROOT="$PROJECT_DIR"
  export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
}

teardown() {
  rm -rf "$PROJECT_DIR"
  unset HIVE_FLOW_PROJECT_ROOT
  unset CLAUDE_PROJECT_DIR
  unset HIVE_FLOW_HOME
  unset HIVE_FLOW_AGENT_ID
}

write_restricted_state() {
  SCRIPT="$SCRIPT" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const enf = require(process.env.SCRIPT);
const state = {
  level: enf.LEVELS.RESTRICTED,
  violations: 2,
  consecutiveDenials: 0,
  lastActivity: new Date(0).toISOString(),
  restrictedGroups: ['write'],
  history: [],
  resetAt: null,
  integrityCompromised: false,
};
fs.mkdirSync(path.dirname(enf.getStateFile()), { recursive: true });
fs.writeFileSync(enf.getStateFile(), JSON.stringify(enf.signState(state)));
NODE
}

read_state_summary() {
  SCRIPT="$SCRIPT" node - <<'NODE'
const fs = require('fs');
const enf = require(process.env.SCRIPT);
const parsed = JSON.parse(fs.readFileSync(enf.getStateFile(), 'utf8'));
process.stdout.write(`${parsed.state.level}:${parsed.state.violations}`);
NODE
}

@test "secret set-check output is allowed but value fallback is denied" {
  run node "$SCRIPT" <<'JSON'
{"tool_name":"Bash","tool_input":{"command":"echo \"${OPENROUTER_API_KEY:+YES}\""}}
JSON

  [ "$status" -eq 0 ]
  [ "$output" = "{}" ]

  run node "$SCRIPT" <<'JSON'
{"tool_name":"Bash","tool_input":{"command":"echo \"${OPENROUTER_API_KEY:-}\""}}
JSON

  [ "$status" -eq 0 ]
  [[ "$output" == *'"permissionDecision":"deny"'* ]]
  [[ "$output" == *"Attempted to expose secret environment variable OPENROUTER_API_KEY"* ]]
}

@test "write-restricted tmux helper is allowed and arbitrary script denial does not escalate" {
  write_restricted_state

  run node "$SCRIPT" <<'JSON'
{"tool_name":"Bash","tool_input":{"command":"timeout 25 .audit/scripts/hf-tmux-control.sh send-codex \"probe\""}}
JSON

  [ "$status" -eq 0 ]
  [ "$output" = "{}" ]

  run node "$SCRIPT" <<'JSON'
{"tool_name":"Bash","tool_input":{"command":"node ./random-script.js"}}
JSON

  [ "$status" -eq 0 ]
  [[ "$output" == *'"permissionDecision":"deny"'* ]]
  [[ "$output" == *"write-restricted"* ]]
  [ "$(read_state_summary)" = "2:2" ]
}

@test "reset instructions do not tell agents to read protected state" {
  run grep -n "Confirm reset was successful by reading" "$REPO_ROOT/.claude/commands/reset-enforcement.md"
  [ "$status" -eq 1 ]

  run grep -n "Do not read .*\\.hive-flow/enforcement/state\\.json" "$REPO_ROOT/.claude/commands/reset-enforcement.md"
  [ "$status" -eq 0 ]
}
