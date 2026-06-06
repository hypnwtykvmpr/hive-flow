#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SCRIPT="$REPO_ROOT/.claude/helpers/compaction-recovery.cjs"
  PROJECT_DIR="$(mktemp -d)"
  DATA_DIR="$PROJECT_DIR/.hive-flow/data"
  FLAG="$DATA_DIR/compaction-recovery-required.json"
  ACK="$DATA_DIR/compaction-recovery-ack.json"
  HANDOFF="$DATA_DIR/compaction-handoff.md"
  STATE="$DATA_DIR/compaction-state.json"
  mkdir -p "$DATA_DIR"
}

teardown() {
  rm -rf "$PROJECT_DIR"
}

@test "recovery helper uses actual missing files even when the flag says they existed" {
  PROJECT_DIR="$PROJECT_DIR" FLAG="$FLAG" HANDOFF="$HANDOFF" STATE="$STATE" node <<'NODE'
const fs = require('fs');
fs.writeFileSync(process.env.FLAG, JSON.stringify({
  type: 'hive-flow.compaction-recovery-required',
  sessionId: 'bats-missing',
  recoveryNonce: 'bats-nonce',
  source: 'compact',
  handoffPath: process.env.HANDOFF,
  statePath: process.env.STATE,
  handoffExists: true,
  stateExists: true,
  createdAt: new Date().toISOString(),
}));
NODE

  run node "$SCRIPT" status --project-root "$PROJECT_DIR"
  [ "$status" -eq 0 ]
  [[ "$output" == *"--handoff-missing --state-missing"* ]]
  [[ "$output" == *"--objective \"null\" --next-step \"null\""* ]]

  run node "$SCRIPT" ack --project-root "$PROJECT_DIR" \
    --session bats-missing \
    --nonce bats-nonce \
    --handoff-missing \
    --state-missing \
    --git-status-reviewed \
    --objective null \
    --next-step null \
    --summary "No durable recovery files existed; checked live repository state before clearing."

  [ "$status" -eq 0 ]
  [ ! -f "$FLAG" ]
  [ -f "$ACK" ]
}

@test "recovery helper refuses null orientation when durable files are actually present" {
  echo "handoff exists" > "$HANDOFF"
  echo '{"objective":"known"}' > "$STATE"
  PROJECT_DIR="$PROJECT_DIR" FLAG="$FLAG" HANDOFF="$HANDOFF" STATE="$STATE" node <<'NODE'
const fs = require('fs');
fs.writeFileSync(process.env.FLAG, JSON.stringify({
  type: 'hive-flow.compaction-recovery-required',
  sessionId: 'bats-present',
  recoveryNonce: 'bats-present-nonce',
  source: 'compact',
  handoffPath: process.env.HANDOFF,
  statePath: process.env.STATE,
  handoffExists: false,
  stateExists: false,
  createdAt: new Date().toISOString(),
}));
NODE

  run node "$SCRIPT" status --project-root "$PROJECT_DIR"
  [ "$status" -eq 0 ]
  [[ "$output" == *"--handoff-reviewed --state-reviewed"* ]]

  run node "$SCRIPT" ack --project-root "$PROJECT_DIR" \
    --session bats-present \
    --nonce bats-present-nonce \
    --handoff-reviewed \
    --state-reviewed \
    --git-status-reviewed \
    --objective null \
    --next-step null \
    --summary "Could not determine the recovered objective despite present durable state."

  [ "$status" -ne 0 ]
  [[ "$output" == *"include verified handoff/state reviewed-or-missing evidence"* ]]
  [ -f "$FLAG" ]
}

@test "malformed recovery flag redirects to summary-only malformed-state escape" {
  printf '{not-json' > "$FLAG"

  run node "$SCRIPT" status --project-root "$PROJECT_DIR"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Recovery flag is malformed"* ]]

  run node "$SCRIPT" ack --project-root "$PROJECT_DIR" \
    --session bats-malformed \
    --summary "short"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Recovery flag is malformed"* ]]

  run node "$SCRIPT" ack --project-root "$PROJECT_DIR" \
    --session bats-malformed \
    --summary "Malformed recovery flag cleared after checking live repository state and next step."
  [ "$status" -eq 0 ]
  [ ! -f "$FLAG" ]
  [ -f "$ACK" ]
}
