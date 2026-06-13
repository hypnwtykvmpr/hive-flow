#!/usr/bin/env bats
#
# DO-NOT-REVERT GUARD — the legacy v2 tree stays retired and quarantined.
#
# On 2026-06-13 the entire tracked v2/ tree (6413 files incl v2/package-lock.json) was
# git-mv'd into a tracked quarantine at TRASH/posture-20260613/v2/ (see
# TRASH/posture-20260613/PROVENANCE.md, slice 4). Prove-dead: zero v3 to v2 runtime
# imports; only doc/script/comment refs existed and were migrated; remaining v2 grep
# hits are API-version / version-string false positives.
#
# This static guard prevents silent regression. It asserts three invariants over the
# TRACKED tree (git ls-files), run from repo root:
#   (a) zero tracked paths live under v2/ — the live tree is gone.
#   (b) the quarantine TRASH/posture-20260613/v2/ is present and tracked.
#   (c) no tracked non-TRASH file carries a dead relative LINK or filesystem path into
#       v2/ — precise patterns only, so API-version false positives do NOT trip it.
#
# Static (git/grep) only — no live state, isolated HIVE_FLOW_HOME.

setup() {
  REPO_ROOT="$(git rev-parse --show-toplevel)"
  export HIVE_FLOW_HOME="$BATS_TEST_TMPDIR/hive-home"
  mkdir -p "$HIVE_FLOW_HOME"
  cd "$REPO_ROOT"
}

@test "no tracked file lives under the legacy v2 path" {
  live="$(git ls-files -z | tr '\0' '\n' | grep '^v2/' || true)"
  if [ -n "$live" ]; then
    echo "Tracked paths still live under v2/ (should be quarantined under TRASH/):" >&2
    echo "$live" >&2
  fi
  [ -z "$live" ]
}

@test "the quarantined v2 tree is present and tracked" {
  count="$(git ls-files -z 'TRASH/posture-20260613/v2/' | tr '\0' '\n' | grep -c . || true)"
  if [ "$count" -le 0 ]; then
    echo "Quarantine TRASH/posture-20260613/v2/ is empty or untracked." >&2
  fi
  [ "$count" -gt 0 ]
}

@test "the slice-4 v2 provenance entry exists" {
  [ -f "$REPO_ROOT/TRASH/posture-20260613/PROVENANCE.md" ]
  run grep -F 'v2 Legacy Tree Retirement (slice 4)' "$REPO_ROOT/TRASH/posture-20260613/PROVENANCE.md"
  [ "$status" -eq 0 ]
}

@test "zero v3-to-v2 runtime imports in tracked source" {
  # Ported extra (slice B): the hard runtime invariant — no import/require/from
  # string resolves INTO the top-level v2/ tree. v2-compat* are v3-internal
  # protocol shims (sibling files), NOT the v2/ tree, so exclude. api/v2 (REST
  # route example) and oauth2/v2 (google URL) are not filesystem paths.
  hits="$(git ls-files -z | grep -zv '^TRASH/' | grep -zv '^v2/' \
    | xargs -0 grep -nIE "(from|require|import)[[:space:]]*[(]?['\"][^'\"]*v2/" 2>/dev/null \
    | grep -vE 'v2-compat' \
    | grep -vE 'api/v2' \
    | grep -vE 'oauth2/v2' \
    || true)"
  if [ -n "$hits" ]; then
    echo "Unexpected v3-to-v2 runtime import(s) in tracked source:" >&2
    echo "$hits" >&2
  fi
  [ -z "$hits" ]
}

@test "npm pack ships zero v2 or TRASH paths" {
  # Ported extra (slice B): the npm-pack-clean invariant. Implemented in
  # ISOLATED-CACHE style (NPM_CONFIG_CACHE) — NOT the raw `npm pack` the stale
  # duplicate used, which fails in shared-cache CI environments. Mirrors
  # tests/packaging-proof.test.mjs. Slow / runs the prepack staging hook, so it
  # is gated behind the same RUN_PACK_CHECK opt-in this lane already uses.
  if [ "${RUN_PACK_CHECK:-0}" != "1" ]; then
    skip "set RUN_PACK_CHECK=1 to run the npm pack tarball check"
  fi
  cd "$REPO_ROOT"
  isolated_cache="$BATS_TEST_TMPDIR/npm-cache"
  mkdir -p "$isolated_cache"
  run env NPM_CONFIG_CACHE="$isolated_cache" npm pack --dry-run --json
  [ "$status" -eq 0 ]
  echo "$output" | grep -qE '"path":[[:space:]]*"v2/' && {
    echo "v2/ path leaked into npm pack tarball" >&2
    return 1
  }
  echo "$output" | grep -qE '"path":[[:space:]]*"TRASH/' && {
    echo "TRASH/ path leaked into npm pack tarball" >&2
    return 1
  }
  return 0
}

@test "no tracked non-TRASH file references a dead relative link or path into v2" {
  # Search every tracked file EXCEPT those under TRASH/ for precise v2/ path forms.
  # Patterns are anchored so version-strings / API false positives do NOT match:
  #   - all-MiniLM-L6-v2, Claude Code v2.1.19  : '-v2' / ' v2.' — no trailing '/...'
  #   - oauth2/v2/auth, /v1/, /v2/ prefix      : preceding char is a digit or slash
  #   - migrate --from v2                       : bare token, no path segment
  # Matched (dead) forms — a relative LINK or a v2/<known-subdir> filesystem path:
  #   markdown links:  ](./v2/   ](v2/
  #   quoted paths:    "v2/      'v2/
  #   fs subpaths:     v2/dist   v2/src   v2/docs   v2/examples
  # Each fs-subpath pattern requires v2 to NOT be preceded by an alnum or '/'
  # (so 'oauth2/v2/' and '-v2' are excluded), via a leading (^|[^A-Za-z0-9/]) guard.
  # The guard test itself and PROVENANCE.md are excluded (they document v2/ on purpose).
  # The migrated quarantine prefix 'TRASH/posture-20260613/v2/' is stripped from each
  # line first, so a legitimately-migrated path (e.g. cleanup-v3.sh's
  # 'TRASH/posture-20260613/v2/dist-cjs') is NOT mistaken for a dead live 'v2/' ref.
  hits="$(git ls-files -z | grep -zv '^TRASH/' | xargs -0 grep -nIE \
    '\]\(\.?/?v2/|"v2/|'"'"'v2/|(^|[^A-Za-z0-9/])v2/(dist|src|docs|examples)' 2>/dev/null \
    | sed 's#TRASH/posture-20260613/v2/##g' \
    | grep -E '\]\(\.?/?v2/|"v2/|'"'"'v2/|(^|[^A-Za-z0-9/])v2/(dist|src|docs|examples)' \
    | grep -vE 'v2-retirement-guard\.bats:' \
    | grep -vE '(^|/)PROVENANCE\.md:' \
    || true)"
  if [ -n "$hits" ]; then
    echo "Dead v2/ link or path reference(s) in tracked non-TRASH source:" >&2
    echo "$hits" >&2
  fi
  [ -z "$hits" ]
}
