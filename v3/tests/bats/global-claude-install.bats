#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  WORK_DIR="$(mktemp -d)"
  HOME_DIR="$WORK_DIR/home"
  PROJECT_ROOT="$WORK_DIR/project"
  SETTINGS_PATH="$HOME_DIR/.claude/settings.json"
  mkdir -p "$HOME_DIR/.claude" "$PROJECT_ROOT/.claude/helpers" "$PROJECT_ROOT/cli/src/permission-guard" "$PROJECT_ROOT/cli/bin"
  printf '{"statusLine":{"type":"command","command":"printf CUSTOM","padding":1}}\n' > "$SETTINGS_PATH"
  printf '#!/usr/bin/env node\nprocess.stdout.write("HF_BOARD\\\\n");\n' > "$PROJECT_ROOT/cli/bin/statusline.js"
  for helper in hive-composition-gate role-enforcement enforcement hook-handler settings-reconciler provider-tracker session-id; do
    printf 'console.log("%s")\n' "$helper" > "$PROJECT_ROOT/.claude/helpers/$helper.cjs"
  done
  printf 'module.exports = {};\n' > "$PROJECT_ROOT/cli/src/permission-guard/protected-paths.cjs"
  printf '{}\n' > "$PROJECT_ROOT/cli/src/permission-guard/protected-paths.policy.json"
}

teardown() {
  rm -rf "$WORK_DIR"
}

managed_tree() {
  find "$HOME_DIR/.claude" "$HOME_DIR/.hive-flow/enforcement/bin" "$HOME_DIR/.hive-flow/bin" "$HOME_DIR/.hive-flow/integrations" -type f \
    ! -name '*.hive-flow.bak' \
    ! -name '*.hive-flow-backup-*' \
    | sed "s|$WORK_DIR/||" \
    | sort
}

@test "init --global --claude-code installs the managed global statusline/enforcement tree idempotently" {
  run node "$REPO_ROOT/cli/bin/cli.js" init --global --claude-code --yes --home "$HOME_DIR" --user-settings "$SETTINGS_PATH" --project-root "$PROJECT_ROOT" --format json
  [ "$status" -eq 0 ]
  [[ "$output" == *"Installed global statusline launcher"* ]]

  expected="$(sort "$REPO_ROOT/v3/tests/fixtures/global-claude-install-tree.golden")"
  actual="$(managed_tree)"
  [ "$actual" = "$expected" ]

  run "$HOME_DIR/.hive-flow/bin/claude-code-statusline" < /dev/null
  [ "$status" -eq 0 ]
  [[ "$output" == *"hive-flow"* ]]
  [[ "$output" != *"CUSTOM"* ]]

  run env HIVE_FLOW_STATUSLINE_CHAIN_PREVIOUS=1 "$HOME_DIR/.hive-flow/bin/claude-code-statusline" < /dev/null
  [ "$status" -eq 0 ]
  [[ "$output" == *"hive-flow"* ]]
  [[ "$output" == *"CUSTOM"* ]]

  run node "$REPO_ROOT/cli/bin/cli.js" init --global --claude-code --yes --home "$HOME_DIR" --user-settings "$SETTINGS_PATH" --project-root "$PROJECT_ROOT" --format json
  [ "$status" -eq 0 ]

  run "$HOME_DIR/.hive-flow/bin/claude-code-statusline" < /dev/null
  [ "$status" -eq 0 ]
  [[ "$output" == *"hive-flow"* ]]
  [[ "$output" != *"CUSTOM"* ]]
  count="$(printf '%s\n' "$output" | grep -c 'hive-flow')"
  [ "$count" -eq 1 ]
}
