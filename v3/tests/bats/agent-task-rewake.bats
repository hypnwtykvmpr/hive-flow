#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SCRIPT="$REPO_ROOT/.claude/helpers/agent-task-rewake.cjs"
  PROJECT_DIR="$(mktemp -d)"
  OWNER_ENV_UNSETS=(
    -u CODEX_SESSION_ID
    -u CODEX_THREAD_ID
    -u CLAUDE_SESSION_ID
    -u CLAUDE_CODE_SESSION_ID
    -u CLAUDE_CODE_ENTRYPOINT
    -u CLAUDECODE
    -u CLAUDE_CODE
    -u CLAUDE_PROJECT_DIR
    -u GEMINI_SESSION_ID
    -u GEMINI_THREAD_ID
    -u CURSOR_SESSION_ID
    -u CURSOR_THREAD_ID
    -u AGENT_SESSION_ID
    -u ANTIGRAVITY_SESSION_ID
    -u ANTIGRAVITY_THREAD_ID
    -u AGY_SESSION_ID
    -u AGY_THREAD_ID
    -u OPENCODE_SESSION_ID
    -u OPENCODE_THREAD_ID
    -u FORGECODE_SESSION_ID
    -u FORGECODE_THREAD_ID
    -u FORGE_CODE_SESSION_ID
    -u FORGE_SESSION_ID
    -u HIVE_FLOW_SESSION_ID
    -u HIVE_FLOW_CLIENT_KIND
  )
  export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
  mkdir -p "$PROJECT_DIR/.hive-flow/tasks"
}

teardown() {
  rm -rf "$PROJECT_DIR"
}

@test "agent-task-rewake exits 2 and emits TASK COMPLETE when result exists" {
  cat > "$PROJECT_DIR/.hive-flow/tasks/task-bats-1.result.json" <<'JSON'
{"success":true,"result":{"agentId":"agent-bats","content":"done"}}
JSON

  run node "$SCRIPT" <<'JSON'
{"tool_response":"{\"success\":true,\"taskId\":\"task-bats-1\",\"status\":\"running\"}"}
JSON

  [ "$status" -eq 2 ]
  [[ "$stderr" == *"[TASK COMPLETE: task-bats-1]"* ]]
  [ -f "$PROJECT_DIR/.hive-flow/data/pending-notifications.jsonl" ]
  [ -f "$PROJECT_DIR/.hive-flow/data/task-task-bats-1.notified" ]
}

@test "agent-task-rewake targets opencode parent from operator env" {
  cat > "$PROJECT_DIR/.hive-flow/tasks/task-opencode-parent.result.json" <<'JSON'
{"success":true,"result":{"agentId":"agent-bats","content":"done"}}
JSON

  run env "${OWNER_ENV_UNSETS[@]}" CLAUDE_PROJECT_DIR="$PROJECT_DIR" OPENCODE_SESSION_ID="opencode-bats-session" node "$SCRIPT" <<'JSON'
{"tool_response":"{\"success\":true,\"taskId\":\"task-opencode-parent\",\"status\":\"running\"}"}
JSON

  [ "$status" -eq 2 ]
  [[ "$stderr" == *"[TASK COMPLETE: task-opencode-parent]"* ]]
  run grep '"targetAgent":"opencode"' "$PROJECT_DIR/.hive-flow/data/pending-notifications.jsonl"
  [ "$status" -eq 0 ]
}

@test "agent-task-rewake no-ops for payloads without a task id" {
  run node "$SCRIPT" <<'JSON'
{"tool_response":"{\"success\":true,\"status\":\"running\"}"}
JSON

  [ "$status" -eq 0 ]
  [ "$output" = "" ]
  [ "$stderr" = "" ]
}
