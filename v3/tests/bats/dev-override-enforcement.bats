#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  PROJECT_DIR="$(mktemp -d)"
  SCRIPT="$PROJECT_DIR/.claude/helpers/enforcement.cjs"
  mkdir -p "$PROJECT_DIR/.claude/helpers" "$PROJECT_DIR/.hive-flow/enforcement"
  cp "$REPO_ROOT/.claude/helpers/enforcement.cjs" "$SCRIPT"
  unset CLAUDE_SESSION_ID
  unset AGENTIC_FLOW_AGENT_ID
  unset CLAUDE_AGENT_ID
  unset CLAUDE_PARENT_AGENT_ID
  unset HIVE_FLOW_DEV_OVERRIDE_TOKEN
}

teardown() {
  rm -rf "$PROJECT_DIR"
  unset CLAUDE_SESSION_ID
  unset AGENTIC_FLOW_AGENT_ID
  unset CLAUDE_AGENT_ID
  unset CLAUDE_PARENT_AGENT_ID
  unset HIVE_FLOW_DEV_OVERRIDE_TOKEN
}

enable_dev_override() {
  printf 'HIVE_FLOW_DEV_OVERRIDE=on\n' > "$PROJECT_DIR/.hive-flow/enforcement/dev-override.conf"
}

root_override_token() {
  PROJECT_DIR="$PROJECT_DIR" node - <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const projectDir = process.env.PROJECT_DIR;
const keyPath = path.join(projectDir, '.hive-flow', 'enforcement', '.hmac-key');
fs.mkdirSync(path.dirname(keyPath), { recursive: true });
const key = 'bats-dev-override-root-key';
fs.writeFileSync(keyPath, key);
const body = Buffer.from(JSON.stringify({
  kind: 'hive-flow-dev-override-root',
  projectDir,
  issuedAt: Date.now(),
  expiresAt: Date.now() + 60000,
  nonce: 'bats-root-token',
})).toString('base64url');
const hmac = crypto.createHmac('sha256', key).update(body).digest('hex');
process.stdout.write(`${body}.${hmac}`);
NODE
}

issue_root_override_token() {
  HIVE_FLOW_DEV_OVERRIDE_TOKEN="$(root_override_token)"
  export HIVE_FLOW_DEV_OVERRIDE_TOKEN
}

write_root_override_token_to_config() {
  token="$(root_override_token)"
  printf 'HIVE_FLOW_DEV_OVERRIDE=on\nHIVE_FLOW_DEV_OVERRIDE_TOKEN=%s\n' "$token" > "$PROJECT_DIR/.hive-flow/enforcement/dev-override.conf"
}

@test "dev override CLI hook denies toggle-only protected config edit" {
  enable_dev_override

  run node "$SCRIPT" <<'JSON'
{"tool_name":"Write","tool_input":{"file_path":".claude/settings.json"}}
JSON

  [ "$status" -eq 0 ]
  [[ "$output" == *'"permissionDecision":"deny"'* ]]
  [[ "$output" == *"protected path"* ]]
}

@test "dev override CLI hook allows signed root token to edit grantable protected config" {
  enable_dev_override
  issue_root_override_token

  run node "$SCRIPT" <<'JSON'
{"tool_name":"Write","tool_input":{"file_path":".claude/settings.json"}}
JSON

  [ "$status" -eq 0 ]
  [ "$output" = "{}" ]
}

@test "dev override CLI hook allows config-file signed root token without env token" {
  write_root_override_token_to_config
  unset HIVE_FLOW_DEV_OVERRIDE_TOKEN

  run node "$SCRIPT" <<'JSON'
{"tool_name":"Write","tool_input":{"file_path":".claude/settings.json"}}
JSON

  [ "$status" -eq 0 ]
  [ "$output" = "{}" ]
}

@test "dev override CLI hook keeps subagents blocked" {
  enable_dev_override
  issue_root_override_token
  export AGENTIC_FLOW_AGENT_ID="worker-bats"

  run node "$SCRIPT" <<'JSON'
{"tool_name":"Write","tool_input":{"file_path":".claude/settings.json"}}
JSON

  [ "$status" -eq 0 ]
  [[ "$output" == *'"permissionDecision":"deny"'* ]]
  [[ "$output" == *"protected path"* ]]
}

@test "dev override CLI hook keeps absolute-deny floor blocked" {
  enable_dev_override
  issue_root_override_token

  run node "$SCRIPT" <<'JSON'
{"tool_name":"Write","tool_input":{"file_path":".hive-flow/enforcement/dev-override.conf"}}
JSON

  [ "$status" -eq 0 ]
  [[ "$output" == *'"permissionDecision":"deny"'* ]]
  [[ "$output" == *"protected path"* ]]
}
