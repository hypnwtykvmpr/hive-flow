#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  FIXTURE="$REPO_ROOT/v3/tests/fixtures/hooks-modify-protocol.mjs"
}

@test "modify hook CLI protocol matches golden cases" {
  run node "$FIXTURE"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok": true'* ]]
  [[ "$output" == *'"agent-router-report-flag"'* ]]
  [[ "$output" == *'"malformed-stdin-fails-open"'* ]]
}

@test "modify hook golden fixture remains nuanced" {
  golden="$REPO_ROOT/v3/tests/fixtures/hooks-modify-protocol.golden.json"

  run node - "$golden" <<'NODE'
const { readFileSync } = require('node:fs');
const golden = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const required = new Set([
    'agent-router-report-flag',
    'agent-router-report-short-flag',
    'agent-router-report-verbose-no-noise',
    'agent-router-report-invalid-config-no-noise',
    'agent-router-report-stdin',
    'protected-settings-file',
    'protected-helper-file',
    'protected-enforcement-state-file',
    'protected-git-exclude-file',
    'protected-notebookedit-stdin',
    'agent-router-handoff-command',
    'agent-router-handoff-short-flag',
    'agent-router-handoff-stdin',
    'forced-stdout-suppressed',
    'protected-settings-shell-write',
    'destructive-rm-rf',
    'destructive-git-reset-hard',
    'destructive-git-clean-xdf',
    'malformed-scalar-stdin-fails-open',
    'malformed-array-stdin-fails-open',
    'malformed-stdin-explicit-protected-file-denies',
    'malformed-stdin-explicit-destructive-command-denies',
    'malformed-stdin-fails-open',
  ]);
for (const testCase of golden.cases || []) required.delete(testCase.name);
if (required.size > 0) {
  console.error(`missing golden cases: ${Array.from(required).join(', ')}`);
  process.exit(1);
}
NODE

  [ "$status" -eq 0 ]
}
