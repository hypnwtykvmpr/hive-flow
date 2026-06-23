#!/usr/bin/env bats
#
# DO-NOT-REVERT GUARD — human-marked DELETE_ files stay destroyed and dead.
#
# On 2026-06-13 the human prefixed 274 tracked paths with DELETE_ to mark them for
# deletion. They were git-mv'd out of their live locations into a tracked quarantine
# at TRASH/posture-20260613/delete-marked/ (see TRASH/posture-20260613/PROVENANCE.md).
# On 2026-06-13/14 the human approved final destruction of TRASH; this guard now
# proves the deleted files do not re-enter the tracked tree or package/runtime refs.
#
# This static guard prevents silent regression. It asserts two invariants over the
# TRACKED tree (git ls-files), space-safe via -z:
#   (a) zero tracked files carry DELETE_ in any path — the deletion is final.
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

@test "no tracked file has DELETE_ in its path" {
  # -z + tr keeps paths with spaces intact (e.g. 'DELETE_settings copy.json').
  live="$(git ls-files -z | tr '\0' '\n' | grep 'DELETE_' || true)"
  if [ -n "$live" ]; then
    echo "DELETE_ paths still tracked after final destruction:" >&2
    echo "$live" >&2
  fi
  [ -z "$live" ]
}

@test "the final TRASH destruction removed the quarantine from disk and git" {
  tracked="$(git ls-files -z 'TRASH/**' | tr '\0' '\n' || true)"
  if [ -n "$tracked" ]; then
    echo "TRASH paths are still tracked after final destruction:" >&2
    echo "$tracked" >&2
  fi
  [ -z "$tracked" ]
  [ ! -e "$REPO_ROOT/TRASH" ]
}

@test "the destroyed DELETE_ quarantine cannot leak through live git status paths" {
  status_paths="$(git status --short --porcelain=v1 \
    | awk '{print $2}' \
    | grep 'DELETE_' \
    | grep -v '^TRASH/' \
    || true)"
  if [ -n "$status_paths" ]; then
    echo "Live DELETE_ path still appears in git status after final destruction:" >&2
    echo "$status_paths" >&2
  fi
  [ -z "$status_paths" ]
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
  #   - hivememory-ripout.test         : dir-walk that SKIPS DELETE_ entries
  #   - ewc-architecture-honesty    : dir-walk that SKIPS DELETE_ entries
  #   - ca4-neural-honesty.test     : dir-walk that SKIPS DELETE_ segments
  #   - BEAD_DELETE_FAILED          : unrelated error constant (coincidental substring)
  #   - packaging-proof.test.mjs    : the packaging junk-guard that ASSERTS the
  #                                   DELETE_ pattern is ABSENT from packs (its
  #                                   JUNK_PATTERNS names DELETE_ to enforce its
  #                                   exclusion — a legitimate mention, not a leak).
  # Portable (no mapfile/bash4): grep all tracked non-TRASH files via xargs -0.
  hits="$(git ls-files -z | grep -zv '^TRASH/' | xargs -0 grep -nI 'DELETE_' 2>/dev/null \
    | grep -vE '(^|/)\.gitignore:' \
    | grep -vE '(^|/)\.npmignore:' \
    | grep -vE '(^|/)package\.json:[0-9]+:[[:space:]]*"!' \
    | grep -vE '(^|/)tsconfig\.json:[0-9]+:.*"exclude"' \
    | grep -vE '(^|/)packaging-proof\.test\.mjs:' \
    | grep -vE 'delete-marked-quarantine-guard\.bats:' \
    | grep -vE 'scripts/quarantine-delete-marked\.sh:' \
    | grep -vE 'debrand-static-grep-zero\.test\.ts:' \
    | grep -vE 'hivememory-ripout\.test\.ts:' \
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

@test "memory tsconfig still excludes DELETE_ TS from build" {
  run grep -F 'src/**/DELETE_*' "$REPO_ROOT/v3/@hive-flow/cli/tsconfig.json"
  [ "$status" -eq 0 ]
}
