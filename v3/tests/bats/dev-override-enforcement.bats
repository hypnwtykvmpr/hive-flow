#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  PROJECT_DIR="$(mktemp -d)"
  SCRIPT="$PROJECT_DIR/.claude/helpers/enforcement.cjs"
  mkdir -p "$PROJECT_DIR/.claude/helpers" "$PROJECT_DIR/.hive-flow/enforcement"
  cp "$REPO_ROOT/.claude/helpers/enforcement.cjs" "$SCRIPT"
  mkdir -p "$PROJECT_DIR/v3/@hive-flow/cli/src/permission-guard"
  cp "$REPO_ROOT/v3/@hive-flow/cli/src/permission-guard/protected-paths.cjs" "$PROJECT_DIR/v3/@hive-flow/cli/src/permission-guard/protected-paths.cjs"
  cp "$REPO_ROOT/v3/@hive-flow/cli/src/permission-guard/protected-paths.policy.json" "$PROJECT_DIR/v3/@hive-flow/cli/src/permission-guard/protected-paths.policy.json"
  export HIVE_FLOW_PROJECT_ROOT="$PROJECT_DIR"
  export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
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
  unset HIVE_FLOW_PROJECT_ROOT
  unset CLAUDE_PROJECT_DIR
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
const keyId = crypto.createHash('sha256')
  .update('hive-flow-dev-override-key-id\0')
  .update(key)
  .digest('hex')
  .slice(0, 16);
const body = Buffer.from(JSON.stringify({
  kind: 'hive-flow-dev-override-root',
  version: 1,
  keyId,
  projectDir,
  issuedAt: Date.now(),
  expiresAt: Date.now() + 60000,
  nonce: 'bats-root-token',
})).toString('base64url');
const hmac = crypto.createHmac('sha256', key).update(body).digest('hex');
process.stdout.write(`${body}.${hmac}`);
NODE
}

root_override_token_with_offset() {
  local issued_offset_ms="$1"
  local ttl_ms="$2"
  PROJECT_DIR="$PROJECT_DIR" ISSUED_OFFSET_MS="$issued_offset_ms" TTL_MS="$ttl_ms" node - <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const projectDir = process.env.PROJECT_DIR;
const keyPath = path.join(projectDir, '.hive-flow', 'enforcement', '.hmac-key');
fs.mkdirSync(path.dirname(keyPath), { recursive: true });
const key = 'bats-dev-override-root-key';
fs.writeFileSync(keyPath, key);
const issuedAt = Date.now() + Number(process.env.ISSUED_OFFSET_MS);
const keyId = crypto.createHash('sha256')
  .update('hive-flow-dev-override-key-id\0')
  .update(key)
  .digest('hex')
  .slice(0, 16);
const body = Buffer.from(JSON.stringify({
  kind: 'hive-flow-dev-override-root',
  version: 1,
  keyId,
  projectDir,
  issuedAt,
  expiresAt: issuedAt + Number(process.env.TTL_MS),
  nonce: 'bats-root-token-offset',
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

write_expired_root_override_token_to_config() {
  token="$(root_override_token_with_offset -120000 60000)"
  printf 'HIVE_FLOW_DEV_OVERRIDE=on\nHIVE_FLOW_DEV_OVERRIDE_TOKEN=%s\n' "$token" > "$PROJECT_DIR/.hive-flow/enforcement/dev-override.conf"
}

write_forged_root_override_token_to_config() {
  token="$(root_override_token)"
  last="${token: -1}"
  if [ "$last" = "0" ]; then
    token="${token%?}1"
  else
    token="${token%?}0"
  fi
  printf 'HIVE_FLOW_DEV_OVERRIDE=on\nHIVE_FLOW_DEV_OVERRIDE_TOKEN=%s\n' "$token" > "$PROJECT_DIR/.hive-flow/enforcement/dev-override.conf"
}

copy_reconciler_fixture() {
  cp "$REPO_ROOT/.claude/helpers/settings-reconciler.cjs" "$PROJECT_DIR/.claude/helpers/settings-reconciler.cjs"
  cp "$REPO_ROOT/.claude/settings.json" "$PROJECT_DIR/.claude/settings.json"
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
{"tool_name":"Write","tool_input":{"file_path":".git/info/exclude"}}
JSON

  [ "$status" -eq 0 ]
  [ "$output" = "{}" ]
}

@test "dev override CLI hook allows config-file signed root token without env token" {
  write_root_override_token_to_config
  unset HIVE_FLOW_DEV_OVERRIDE_TOKEN

  run node "$SCRIPT" <<'JSON'
{"tool_name":"Write","tool_input":{"file_path":".git/info/exclude"}}
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

@test "dev override minter denies when no human tty is available" {
  run node "$REPO_ROOT/scripts/permission-guard-setup.mjs" mint-dev-override --project-root "$PROJECT_DIR" --ttl 1m

  [ "$status" -ne 0 ]
  [ ! -f "$PROJECT_DIR/.hive-flow/enforcement/dev-override.conf" ]
}

@test "dev override minter refuses subagent environments before tty prompt" {
  run env CLAUDE_AGENT_ID="worker-bats" HIVE_FLOW_PROJECT_ROOT="$PROJECT_DIR" node "$REPO_ROOT/scripts/permission-guard-setup.mjs" mint-dev-override --project-root "$PROJECT_DIR" --ttl 1m

  [ "$status" -eq 1 ]
  [[ "$output" == *"Refusing to mint dev override from a subagent environment"* ]]
}

@test "dev override CLI hook rejects forged and expired config tokens" {
  write_forged_root_override_token_to_config

  run node "$SCRIPT" <<'JSON'
{"tool_name":"Write","tool_input":{"file_path":".git/info/exclude"}}
JSON

  [ "$status" -eq 0 ]
  [[ "$output" == *'"permissionDecision":"deny"'* ]]

  write_expired_root_override_token_to_config

  run node "$SCRIPT" <<'JSON'
{"tool_name":"Write","tool_input":{"file_path":".git/info/exclude"}}
JSON

  [ "$status" -eq 0 ]
  [[ "$output" == *'"permissionDecision":"deny"'* ]]
}

@test "dev override CLI hook blocks minter oracle attempts from Bash" {
  enable_dev_override
  issue_root_override_token

  run node "$SCRIPT" <<'JSON'
{"tool_name":"Bash","tool_input":{"command":"node scripts/permission-guard-setup.mjs mint-dev-override --ttl 1h"}}
JSON

  [ "$status" -eq 0 ]
  [[ "$output" == *'"permissionDecision":"deny"'* ]]
  [[ "$output" == *"dev-override minter"* ]]
}

@test "settings reconciler reinjects missing hooks and is idempotent" {
  copy_reconciler_fixture
  printf '{"hooks":{},"permissions":{"allow":[]}}\n' > "$PROJECT_DIR/.claude/settings.json"

  run env CLAUDE_PROJECT_DIR="$PROJECT_DIR" HIVE_FLOW_PROJECT_ROOT="$PROJECT_DIR" node "$PROJECT_DIR/.claude/helpers/settings-reconciler.cjs"

  [ "$status" -eq 0 ]
  first="$(node -e "const fs=require('fs'); const p=process.argv[1]; const s=fs.readFileSync(p,'utf8'); const j=JSON.parse(s); if (!Array.isArray(j.hooks.PreToolUse) || j.hooks.PreToolUse.length === 0) process.exit(1); process.stdout.write(s)" "$PROJECT_DIR/.claude/settings.json")"

  run env CLAUDE_PROJECT_DIR="$PROJECT_DIR" HIVE_FLOW_PROJECT_ROOT="$PROJECT_DIR" node "$PROJECT_DIR/.claude/helpers/settings-reconciler.cjs"

  [ "$status" -eq 0 ]
  second="$(cat "$PROJECT_DIR/.claude/settings.json")"
  [ "$first" = "$second" ]
}

@test "relocated engine resolves project root from HIVE_FLOW_PROJECT_ROOT" {
  relocated_dir="$(mktemp -d)"
  mkdir -p "$relocated_dir"
  cp "$SCRIPT" "$relocated_dir/enforcement.cjs"

  run env HIVE_FLOW_PROJECT_ROOT="$PROJECT_DIR" node "$relocated_dir/enforcement.cjs" <<'JSON'
{"tool_name":"Write","tool_input":{"file_path":".claude/settings.json"}}
JSON

  rm -rf "$relocated_dir"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"permissionDecision":"deny"'* ]]
  [[ "$output" == *"protected path"* ]]
}

@test "inline require fs protected write is denied while benign project write is allowed" {
  run node "$SCRIPT" <<'JSON'
{"tool_name":"Bash","tool_input":{"command":"node -e \"require('fs').writeFileSync('.claude/settings.json','{}')\""}}
JSON

  [ "$status" -eq 0 ]
  [[ "$output" == *'"permissionDecision":"deny"'* ]]
  [[ "$output" == *"protected path"* ]]

  run node "$SCRIPT" <<'JSON'
{"tool_name":"Bash","tool_input":{"command":"node -e \"require('fs').writeFileSync('src/generated.txt','ok')\""}}
JSON

  [ "$status" -eq 0 ]
  [ "$output" = "{}" ]
}

@test "subagent trip leaves coordinator benign in-project writes allowed" {
  export AGENTIC_FLOW_AGENT_ID="grep-worker-bats"

  run node "$SCRIPT" <<'JSON'
{"tool_name":"Bash","tool_input":{"command":"grep 'enforcement-reset' v3/docs/design/notes.md"}}
JSON

  [ "$status" -eq 0 ]
  [[ "$output" == *'"permissionDecision":"deny"'* ]]

  unset AGENTIC_FLOW_AGENT_ID

  run node "$SCRIPT" <<'JSON'
{"tool_name":"Write","tool_input":{"file_path":"v3/docs/design/benign-plan.md"}}
JSON

  [ "$status" -eq 0 ]
  [ "$output" = "{}" ]
}
