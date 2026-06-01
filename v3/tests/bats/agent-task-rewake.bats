#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SCRIPT="$REPO_ROOT/.claude/helpers/agent-task-rewake.cjs"
  PROJECT_DIR="$(mktemp -d)"
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

@test "agent-task-rewake no-ops for payloads without a task id" {
  run node "$SCRIPT" <<'JSON'
{"tool_response":"{\"success\":true,\"status\":\"running\"}"}
JSON

  [ "$status" -eq 0 ]
  [ "$output" = "" ]
  [ "$stderr" = "" ]
}
