#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SCRIPT="$REPO_ROOT/.claude/helpers/compact-now.cjs"
  PROJECT_DIR="$(mktemp -d)"
  DATA_DIR="$PROJECT_DIR/.hive-flow/data"
  FAKE_CLAUDE="$PROJECT_DIR/fake-claude.cjs"
  FAKE_ARGS="$DATA_DIR/fake-claude-args.json"
  mkdir -p "$DATA_DIR"
  cat > "$FAKE_CLAUDE" <<'NODE'
#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(process.env.HF_FAKE_CLAUDE_ARGS, JSON.stringify(process.argv.slice(2)));
NODE
  chmod +x "$FAKE_CLAUDE"
  export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
  export CLAUDE_BIN="$FAKE_CLAUDE"
  export HF_FAKE_CLAUDE_ARGS="$FAKE_ARGS"
  export HIVE_FLOW_COMPACT_HEADLESS_SYNC=1
}

teardown() {
  rm -rf "$PROJECT_DIR"
  unset CLAUDE_PROJECT_DIR
  unset CLAUDE_BIN
  unset HF_FAKE_CLAUDE_ARGS
  unset HIVE_FLOW_COMPACT_HEADLESS_SYNC
}

@test "compact-now headless writes handoff and invokes claude compact prompt with resume" {
  run node "$SCRIPT" --mode headless --reason "bats compaction" --resume "bats-session" --next-step "continue after compact"

  [ "$status" -eq 0 ]
  [ -f "$DATA_DIR/compaction-handoff.md" ]
  [ -f "$DATA_DIR/compact-request.json" ]
  [ -f "$FAKE_ARGS" ]

  PROJECT_DIR="$PROJECT_DIR" FAKE_ARGS="$FAKE_ARGS" node <<'NODE'
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const dataDir = path.join(process.env.PROJECT_DIR, '.hive-flow', 'data');
const request = JSON.parse(fs.readFileSync(path.join(dataDir, 'compact-request.json'), 'utf8'));
const args = JSON.parse(fs.readFileSync(process.env.FAKE_ARGS, 'utf8'));
assert.equal(request.mode, 'headless');
assert.equal(request.reason, 'bats compaction');
assert.equal(request.resume, 'bats-session');
assert.match(request.preservationPrompt, /continue after compact/);
assert.deepEqual(args, ['-p', `/compact ${request.preservationPrompt}`, '--resume', 'bats-session']);
assert.ok(Date.parse(request.handoffWrittenAt) <= Date.parse(request.requestedAt));
NODE
}
