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
process.stdout.write(JSON.stringify({
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { pre_tokens: 4321, trigger: 'manual' },
}) + '\n');
NODE
  chmod +x "$FAKE_CLAUDE"
  export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
  export CLAUDE_BIN="$FAKE_CLAUDE"
  export HF_FAKE_CLAUDE_ARGS="$FAKE_ARGS"
}

write_measured_context() {
  local session_id="$1"
  local percentage="$2"
  PROJECT_DIR="$PROJECT_DIR" SESSION_ID="$session_id" PERCENTAGE="$percentage" node <<'NODE'
const fs = require('fs');
const path = require('path');
const dataDir = path.join(process.env.PROJECT_DIR, '.hive-flow', 'data');
const percentage = Number(process.env.PERCENTAGE);
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'autopilot-state.json'), JSON.stringify({
  sessionId: process.env.SESSION_ID,
  lastPercentage: percentage,
  lastTokenEstimate: Math.round(percentage * 1000000),
  contextWindow: 1000000,
  lastCheck: Date.now(),
}));
NODE
}

teardown() {
  rm -rf "$PROJECT_DIR"
  unset CLAUDE_PROJECT_DIR
  unset CLAUDE_BIN
  unset HF_FAKE_CLAUDE_ARGS
}

@test "compact-now headless fails closed when context usage is unmeasurable" {
  run node "$SCRIPT" --mode headless --reason "bats compaction" --resume "bats-session" --next-step "continue after compact"

  [ "$status" -eq 1 ]
  [[ "$output" == *"unable to measure current context usage"* ]]
  [[ "$output" == *"50% compaction request floor cannot be verified"* ]]
  [[ "$output" == *"context measurement layer must be repaired"* ]]
  [ ! -f "$DATA_DIR/compaction-handoff.md" ]
  [ ! -f "$DATA_DIR/compact-request.json" ]
  [ ! -f "$FAKE_ARGS" ]
}

@test "compact-now headless writes handoff and invokes claude compact prompt with resume" {
  write_measured_context "bats-session" "0.60"

  run node "$SCRIPT" --mode headless --reason "bats compaction" --resume "bats-session" --next-step "continue after compact"

  [ "$status" -eq 0 ]
  [ -f "$DATA_DIR/compaction-handoff.md" ]
  [ -f "$DATA_DIR/compact-request.json" ]
  [ -f "$FAKE_ARGS" ]

  PROJECT_DIR="$PROJECT_DIR" FAKE_ARGS="$FAKE_ARGS" BATS_HELPER_OUTPUT="$output" node <<'NODE'
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const dataDir = path.join(process.env.PROJECT_DIR, '.hive-flow', 'data');
const request = JSON.parse(fs.readFileSync(path.join(dataDir, 'compact-request.json'), 'utf8'));
const args = JSON.parse(fs.readFileSync(process.env.FAKE_ARGS, 'utf8'));
const output = JSON.parse(process.env.BATS_HELPER_OUTPUT);
assert.equal(request.mode, 'headless');
assert.equal(request.reason, 'bats compaction');
assert.equal(request.resume, 'bats-session');
assert.match(request.preservationPrompt, /continue after compact/);
assert.deepEqual(args, [
  '--output-format',
  'stream-json',
  '--verbose',
  '-p',
  `/compact ${request.preservationPrompt}`,
  '--resume',
  'bats-session',
]);
assert.equal(output.headless.compacted, true);
assert.equal(output.headless.compactBoundary.compact_metadata.pre_tokens, 4321);
assert.ok(Date.parse(request.handoffWrittenAt) <= Date.parse(request.requestedAt));
NODE
}
