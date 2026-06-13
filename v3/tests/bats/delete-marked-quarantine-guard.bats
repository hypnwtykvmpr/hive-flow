#!/usr/bin/env bats
#
# DO-NOT-REVERT GUARD — human-marked DELETE_ files stay quarantined and dead.
#
# On 2026-06-13 the human prefixed 274 tracked paths with DELETE_ to mark them for
# deletion. They were git-mv'd out of their live locations into a tracked quarantine
# at TRASH/posture-20260613/delete-marked/ (see TRASH/posture-20260613/PROVENANCE.md).
#
# This static guard prevents silent regression. It asserts two invariants over the
# TRACKED tree (git ls-files), space-safe via -z:
#   (a) zero tracked files carry DELETE_ in a LIVE path — every DELETE_ path lives
#       only under TRASH/.
#   (b) no tracked runtime/build/CI source references a DELETE_ path (import, require,
#       glob, copy, or CI step). Known-benign mentions are explicitly excluded.
#
# Static (git/grep) only — no live state, isolated HIVE_FLOW_HOME.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  export HIVE_FLOW_HOME="$BATS_TEST_TMPDIR/hive-home"
  mkdir -p "$HIVE_FLOW_HOME"
  cd "$REPO_ROOT"
}

@test "no tracked file has DELETE_ in a live (non-TRASH) path" {
  # -z + tr keeps paths with spaces intact (e.g. 'DELETE_settings copy.json').
  live="$(git ls-files -z | tr '\0' '\n' | grep 'DELETE_' | grep -v '^TRASH/' || true)"
  if [ -n "$live" ]; then
    echo "LIVE DELETE_ paths still tracked outside TRASH/:" >&2
    echo "$live" >&2
  fi
  [ -z "$live" ]
}

@test "the quarantine provenance and rename map exist" {
  # Existence (not tracked-state): the human stages/commits the quarantine later.
  [ -f "$REPO_ROOT/TRASH/posture-20260613/PROVENANCE.md" ]
  [ -f "$REPO_ROOT/TRASH/posture-20260613/RENAME-MAP.txt" ]
}

@test "the quarantine actually holds the moved DELETE_ files" {
  count="$(git ls-files -z 'TRASH/posture-20260613/delete-marked/' | tr '\0' '\n' | grep -c 'DELETE_' || true)"
  # 274 files were moved; assert the bulk is present (>= 200 tolerates future curation).
  [ "$count" -ge 200 ]
}

@test "no tracked runtime/build/CI source references a DELETE_ path" {
  # Search every tracked file EXCEPT those under TRASH/ for the literal DELETE_,
  # then strip known-benign mentions that are NOT references into a DELETE_ path:
  # Benign categories excluded (these EXCLUDE/skip DELETE_, never reference into it):
  #   - .gitignore / .npmignore     : soft-delete ignore + quarantine guard rules
  #   - package.json !..DELETE_*    : files-allowlist NEGATIONS that exclude DELETE_
  #   - tsconfig exclude            : memory/neural exclude src/**/DELETE_*
  #   - this guard test             : documents DELETE_ on purpose
  #   - quarantine-delete-marked.sh : the one-time quarantine helper that git-mv'd
  #                                   the DELETE_ paths (operates on DELETE_ by design,
  #                                   does not reference a live DELETE_ dependency)
  #   - debrand-static-grep-zero    : guard asserting DELETE_ names are not shipped
  #   - agentdb-ripout.test         : dir-walk that SKIPS DELETE_ entries
  #   - ewc-architecture-honesty    : dir-walk that SKIPS DELETE_ entries
  #   - ca4-neural-honesty.test     : dir-walk that SKIPS DELETE_ segments
  #   - BEAD_DELETE_FAILED          : unrelated error constant (coincidental substring)
  # Portable (no mapfile/bash4): grep all tracked non-TRASH files via xargs -0.
  hits="$(git ls-files -z | grep -zv '^TRASH/' | xargs -0 grep -nI 'DELETE_' 2>/dev/null \
    | grep -vE '(^|/)\.gitignore:' \
    | grep -vE '(^|/)\.npmignore:' \
    | grep -vE '(^|/)package\.json:[0-9]+:[[:space:]]*"!' \
    | grep -vE '(^|/)tsconfig\.json:[0-9]+:.*"exclude"' \
    | grep -vE 'delete-marked-quarantine-guard\.bats:' \
    | grep -vE 'scripts/quarantine-delete-marked\.sh:' \
    | grep -vE 'debrand-static-grep-zero\.test\.ts:' \
    | grep -vE 'agentdb-ripout\.test\.ts:' \
    | grep -vE 'ewc-architecture-honesty\.test\.ts:' \
    | grep -vE 'ca4-neural-honesty\.test\.ts:' \
    | grep -vE 'BEAD_DELETE_FAILED|GT_BEAD_DELETE_FAILED' \
    || true)"
  if [ -n "$hits" ]; then
    echo "Unexpected DELETE_ reference(s) in tracked source:" >&2
    echo "$hits" >&2
  fi
  [ -z "$hits" ]
}

@test "memory and neural tsconfig still exclude DELETE_ TS from build" {
  run grep -F 'src/**/DELETE_*' "$REPO_ROOT/v3/@hive-flow/memory/tsconfig.json"
  [ "$status" -eq 0 ]
  run grep -F 'src/**/DELETE_*' "$REPO_ROOT/v3/@hive-flow/neural/tsconfig.json"
  [ "$status" -eq 0 ]
}
