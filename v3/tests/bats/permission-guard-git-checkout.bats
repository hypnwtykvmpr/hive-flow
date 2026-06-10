#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  FIXTURE="$REPO_ROOT/v3/tests/fixtures/permission-guard-git-checkout-policy.mjs"
  RESOLVER_FIXTURE="$REPO_ROOT/v3/tests/fixtures/permission-resolver-layering.mjs"
}

@test "permission guard checkout simulation matches golden policy" {
  run node "$FIXTURE" "$REPO_ROOT"

  [ "$status" -eq 0 ]

  BATS_CHECKOUT_OUTPUT="$output" node <<'NODE'
const assert = require('assert');
const summary = JSON.parse(process.env.BATS_CHECKOUT_OUTPUT);
assert.equal(summary.ok, true);
assert.deepEqual(summary.failures, []);
assert.deepEqual(summary.counts.trustedRootBranchSwitches, {
  total: 4,
  allow: 4,
  deny: 0,
  inlineJury: 4,
  autoDeny: 0,
});
assert.deepEqual(summary.counts.pathRestores, {
  total: 4,
  allow: 0,
  deny: 4,
  inlineJury: 0,
  autoDeny: 4,
});
assert.deepEqual(summary.counts.dangerousOrAmbiguous, {
  total: 18,
  allow: 0,
  deny: 18,
  inlineJury: 0,
  autoDeny: 18,
});
assert.deepEqual(summary.counts.subagentBranchSwitch, {
  total: 1,
  allow: 0,
  deny: 1,
  inlineJury: 0,
  autoDeny: 1,
});
NODE
}

@test "permission resolver layering fixture preserves project writes and control-plane denials" {
  run node "$RESOLVER_FIXTURE" "$REPO_ROOT"

  [ "$status" -eq 0 ]

  BATS_RESOLVER_OUTPUT="$output" node <<'NODE'
const assert = require('assert');
const summary = JSON.parse(process.env.BATS_RESOLVER_OUTPUT);
assert.equal(summary.ok, true);
assert.deepEqual(summary.failures, []);
assert.deepEqual(summary.counts, {
  total: 4,
  allow: 3,
  deny: 1,
});
assert.equal(summary.layerPaths.sessionGrantsUnderHiveHome, true);
NODE
}
