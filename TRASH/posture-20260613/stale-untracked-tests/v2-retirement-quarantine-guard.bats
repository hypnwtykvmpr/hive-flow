#!/usr/bin/env bats
#
# DO-NOT-REVERT GUARD — the legacy v2 surface stays retired, quarantined, and dead.
#
# On 2026-06-13 the cannibalized "claude flow" fork at v2/ (~6413 tracked files, incl.
# v2/package-lock.json carrying ~100 Dependabot alerts) was git-mv'd out of its live
# location into a tracked quarantine at TRASH/posture-20260613/v2/ (see
# TRASH/posture-20260613/PROVENANCE.md). It was proven dead first: ZERO v3 to v2 runtime
# imports, and the only TS reference (security CVE-REMEDIATION) is an inert provenance
# string, not an import.
#
# This static guard prevents silent regression. It asserts, over the TRACKED tree
# (git ls-files, space-safe via -z):
#   (a) zero tracked files live under a top-level v2/ path — every v2 path lives only
#       under TRASH/.
#   (b) the quarantine actually holds the moved v2 tree (bulk present).
#   (c) no tracked runtime/build/CI source imports/requires INTO the live v2/ tree.
#       Known-benign mentions (v2-compat shims, REST api/v2 examples, oauth2/v2 URLs,
#       README/CVE provenance, this guard) are explicitly excluded.
#   (d) the npm pack tarball ships ZERO v2/ or TRASH/ paths (gated behind RUN_PACK_CHECK
#       because npm pack --dry-run is slow / network-touching).
#   (e) the restore command is documented in PROVENANCE.md.
#
# Static (git/grep) only by default — no live state, isolated HIVE_FLOW_HOME.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  export HIVE_FLOW_HOME="$BATS_TEST_TMPDIR/hive-home"
  mkdir -p "$HIVE_FLOW_HOME"
  cd "$REPO_ROOT"
}

@test "no tracked file lives under a live (non-TRASH) top-level v2 path" {
  # -z + tr keeps paths with spaces intact. Match only the top-level v2/ dir, not
  # substrings like api/v2 or v2-compat.
  live="$(git ls-files -z | tr '\0' '\n' | grep '^v2/' || true)"
  if [ -n "$live" ]; then
    echo "LIVE v2/ paths still tracked outside TRASH/:" >&2
    echo "$live" | head -20 >&2
  fi
  [ -z "$live" ]
}

@test "the quarantine holds the moved v2 tree" {
  count="$(git ls-files -z 'TRASH/posture-20260613/v2/' | tr '\0' '\n' | grep -c '.' || true)"
  # ~6413 files were moved; assert the bulk is present (>= 5000 tolerates future curation).
  [ "$count" -ge 5000 ]
}

@test "zero v3-to-v2 runtime imports in tracked source" {
  # The hard invariant: no import/require/from string resolves INTO the top-level v2/ tree.
  # v2-compat* are v3-internal protocol shims (sibling files), NOT the v2/ tree, so exclude.
  # api/v2 (REST route example) and oauth2/v2 (google URL) are not filesystem paths.
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

@test "no tracked runtime/build/CI source references the live v2 tree" {
  # Search every tracked file EXCEPT those under TRASH/ or v2/ for a v2/ path token,
  # then strip known-benign mentions that are NOT references into the live v2/ tree:
  #   - v2-compat                : v3-internal protocol-compat shims (sibling files)
  #   - api/v2                   : REST route prefix in diff-classifier test fixture
  #   - oauth2/v2                : google oauth endpoint URL
  #   - /v1/, /v2/ + v1/, $v2/   : SKILL.md API-versioning suggestion strings
  #   - .npmignore               : the v2/ ignore rule itself
  #   - README.md                : (none expected post-edit; tolerated as doc text)
  #   - CVE-REMEDIATION.ts       : provenance strings now point at TRASH/...v2 (excluded)
  #   - this guard test          : documents v2/ on purpose
  hits="$(git ls-files -z | grep -zv '^TRASH/' | grep -zv '^v2/' \
    | xargs -0 grep -nI 'v2/' 2>/dev/null \
    | grep -vE 'v2-compat' \
    | grep -vE 'api/v2' \
    | grep -vE 'oauth2/v2' \
    | grep -vE '/v1/, /v2/|v1/, \$v2/' \
    | grep -vE '(^|/)\.npmignore:' \
    | grep -vE 'CVE-REMEDIATION\.ts:[0-9]+:.*TRASH/posture-20260613/v2/' \
    | grep -vE 'v2-retirement-quarantine-guard\.bats:' \
    || true)"
  if [ -n "$hits" ]; then
    echo "Unexpected live v2/ reference(s) in tracked source:" >&2
    echo "$hits" >&2
  fi
  [ -z "$hits" ]
}

@test "PROVENANCE documents the v2 restore command" {
  prov="$REPO_ROOT/TRASH/posture-20260613/PROVENANCE.md"
  [ -f "$prov" ]
  run grep -F 'git mv TRASH/posture-20260613/v2 v2' "$prov"
  [ "$status" -eq 0 ]
}

@test "npm pack ships zero v2/ or TRASH/ paths" {
  # Slow / may touch network — gate behind an explicit opt-in flag.
  if [ "${RUN_PACK_CHECK:-0}" != "1" ]; then
    skip "set RUN_PACK_CHECK=1 to run the npm pack tarball check"
  fi
  cd "$REPO_ROOT"
  run npm pack --dry-run --json
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
