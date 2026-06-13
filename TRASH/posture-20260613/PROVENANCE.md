# TRASH Quarantine — Human-Marked `DELETE_` Files

**Date:** 2026-06-13
**Posture:** `posture-20260613`
**Quarantine dir:** `TRASH/posture-20260613/delete-marked/`

## Purpose

The human prefixed 274 tracked paths with `DELETE_` (directories `DELETE_workflows`,
`DELETE_agents`, and singleton `DELETE_*.ts` / `DELETE_*.md` files) to mark them for
deletion. This quarantine MOVES every such path out of its live location into a tracked
`TRASH/` directory via `git mv`, preserving git history and the original relative path.

This is a **reversible quarantine**. Nothing here is hard-deleted. Nothing here ships in any
npm package. The human performs final destruction later.

## Pre-Move SHA

```
347788e1bcc0c1f1b37bc9d2c0b37e6102c6233e
```

(`git rev-parse HEAD` immediately before the move. Use this to diff/restore.)

## What Moved — Count & Rule

- **274 files moved.** All were `DELETE_`-prefixed and tracked.
- **Rule:** every tracked path matching `DELETE_` in any path segment was moved from
  `<path>` to `TRASH/posture-20260613/delete-marked/<path>` (original relative path
  preserved verbatim under the quarantine dir).
- All 274 staged changes are pure renames (`git diff --cached --name-status` reports
  `R100` for every entry — 100% content similarity, history-preserving).
- No non-`DELETE_` file was touched by the move.

The full original -> new path list is in `RENAME-MAP.txt` (sibling of this file).

## Prove-Dead Evidence (ran BEFORE the move)

Goal: confirm no live runtime/build/CI source imports, requires, globs, copies, or
CI-steps INTO a `DELETE_` path. The `DELETE_` rename had already broken all references.

Commands run (over tracked files, excluding the `DELETE_` paths themselves):

1. **Literal `DELETE_` references in non-DELETE tracked files:**
   ```
   rg -n 'DELETE_' $(git ls-files | grep -v 'DELETE_')
   ```
   Hits (all benign — none resolve a DELETE_ path):
   - `.gitignore:192-194` — the soft-delete ignore rule itself (`DELETE_*`, `**/DELETE_*`).
   - `v3/@hive-flow/cli/src/init/__tests__/debrand-static-grep-zero.test.ts` — a guard test
     asserting neural docs do NOT ship `DELETE_` names.
   - `v3/@hive-flow/memory/src/agentdb-ripout.test.ts` and
     `v3/@hive-flow/memory/src/ewc-architecture-honesty.test.ts` — dir-walk tests that
     **skip** entries whose name starts with `DELETE_` (exclusion, not reference).
   - `v3/plugins/gastown-bridge/src/errors.ts` — `BEAD_DELETE_FAILED` /
     `GT_BEAD_DELETE_FAILED` error constant (coincidental substring, unrelated).

2. **Imports of the singleton TS modules** (both `DELETE_`-prefixed and original basenames):
   ```
   rg -n "['\"/](DELETE_persistent-sona|DELETE_rvf-learning-store|DELETE_sona-usage|persistent-sona|rvf-learning-store|sona-usage)['\"]" $(git ls-files | grep -v DELETE_)
   ```
   Result: **zero hits.** No module imports these.

3. **Directory references** `DELETE_workflows`, `DELETE_agents`:
   ```
   rg -n 'DELETE_workflows|DELETE_agents' $(git ls-files | grep -v DELETE_)
   ```
   Result: **zero hits.**

4. **CI workflows:** only `.github/workflows/credential-backends.yml` is live; it does not
   reference any `DELETE_workflows` filename.

5. **Build/publish scripts:** `v3/@hive-flow/cli/scripts/publish.sh` copies `dist bin src
   package.json README.md` — no `.claude` and no `DELETE_` paths. CLI `init` source
   references live `agents/` (which has 0 tracked entries under cli `.claude/agents`), never
   `DELETE_agents/`.

6. **Build excludes already drop DELETE_ TS:** `v3/@hive-flow/memory/tsconfig.json` and
   `v3/@hive-flow/neural/tsconfig.json` both carry `exclude: [..., "src/**/DELETE_*"]`, so
   the singleton TS files were already excluded from compilation.

**Conclusion:** No live reference resolves into any `DELETE_` path. All 274 are dead. None
were withheld from the move.

## Packaging Safety

`TRASH/` is NOT shipped:
- Root `package.json` `files` uses explicit `dist/**/*.js` + `.claude/**` globs — no `TRASH`.
- `v3/@hive-flow/cli/package.json` `files` = `["dist","bin",".claude","README.md"]` — no `TRASH`.
- An explicit guard line `TRASH/` was added to `.npmignore` files as defense-in-depth.
- `npm pack --dry-run` (isolated cache) for both root and CLI confirms no `TRASH/` or
  `DELETE_` path is included (see report alongside this provenance / the verification log).

`TRASH/` is deliberately NOT added to `.gitignore` — it must stay **tracked** for
reviewability and restore.

## Restore Instructions

> **The human owns final destruction of `TRASH/`.**
> Restore any file by reversing the `git mv` back to its original path, e.g.:
> ```
> git mv TRASH/posture-20260613/delete-marked/<path> <path>
> ```
> The original `<path>` for every file is recorded in `RENAME-MAP.txt`.

---

# Dependabot Posture (slice 3) — Dead Root npm Lockfile Retirement

**Date:** 2026-06-13
**Quarantine path:** `TRASH/posture-20260613/dependabot/package-lock.json`
**Pre-move SHA:** `d99de9a2a4f7dc923e219edfe6f014afd9e5cc14` (`git rev-parse HEAD` immediately before the move)

## What & Why-Dead

Moved root `package-lock.json` -> `TRASH/posture-20260613/dependabot/package-lock.json`
via `git mv` (history-preserving rename).

The repo is **pnpm-canonical** (`package.json` `packageManager: pnpm@9.15.9`; canonical
lockfile `pnpm-lock.yaml`). The root npm `package-lock.json` was a stale, unconsumed
artifact and the single largest Dependabot alert source: **73 open alerts** point at
`package-lock.json` (confirmed via the Dependabot API, grouped by `manifest_path`).
Retiring it retires those 73 alerts. It already did not ship in any npm package
(`npm pack --dry-run` clean before and after), so the move is purely an alert-surface
and tree-hygiene win with zero runtime/packaging impact.

## Prove-Dead Evidence (ran BEFORE the move)

Goal: confirm nothing in the live install/build/test/CI flow consumes the root
`package-lock.json` (i.e. no `npm ci` / repo-root `npm install`).

1. **`npm ci` across the repo** (`*.yml/yaml/json/sh/mjs/cjs/js/md`, excluding
   `node_modules`, `/TRASH/`, `/.git/`):
   ```
   grep -rn "npm ci" . --include=... | grep -v node_modules | grep -v /TRASH/ | grep -v /.git/
   ```
   Hits: **only docs/skills/worktrees** (`.agents/skills/*`, `.claude/worktrees/*`,
   `v2/docs/*`). **Zero** `npm ci` in any live root build/CI/install path.

2. **`npm install` / `npm i` in real paths** (`scripts/`, `.github/`, root `package.json`):
   ```
   grep -rnE "npm (ci|install|i)\b" scripts/ .github/ package.json
   ```
   Hits are all **global registry installs** (`npm install -g hive-flow` /
   `npm install -g @anthropic-ai/claude-code` in `scripts/install.sh`; a comment in
   `scripts/stage-bundled-workspaces.mjs`). **None** runs `npm install` in the repo root,
   so none consumes the root `package-lock.json`.

3. **`package-lock` references in real source** (excluding docs/worktrees/v2/.agents/.claude):
   - `.claude/helpers/security-scanner.sh:61` — `if [ -f package-lock.json ]` then `echo "0"`
     in **both** branches: a pure no-op, never installs.
   - `v3/@hive-flow/cli/bin/preinstall.cjs:106-123` — deletes stale lockfiles in the **npx
     cache** (`~/.npm/_npx/*/package-lock.json`), not the repo root.
   - `v3/@hive-flow/guidance/src/ledger.ts:138` — filename classifier flagging package files
     for manual review; does not install or require the lockfile.

4. **CI:** the only live workflow `.github/workflows/credential-backends.yml` installs with
   `pnpm install --frozen-lockfile` (lines 43-44) — pnpm, never npm.

5. **No `scripts/install.sh` repo-root npm install:** it only offers a global package install
   (`npm install -g hive-flow`), which pulls from the npm registry and never reads the repo's
   root lockfile.

**Conclusion:** The root `package-lock.json` is consumed by **nothing** in the
pnpm-canonical flow. Dead. Moved.

## Packaging Safety

`TRASH/**` is already excluded from npm pack (root `files` allowlist negation `"!TRASH/**"`
+ `.npmignore` guard). `npm pack --dry-run` filtered for `package-lock|TRASH` was **CLEAN
before and after** the move — no `package-lock.json` or `TRASH/` path ships.

## Restore

```
git mv TRASH/posture-20260613/dependabot/package-lock.json package-lock.json
```

---

# v2 Legacy Tree Retirement (slice 4) — Entire `v2/` Quarantined

**Date:** 2026-06-13
**Original path:** `v2/` (the entire legacy v2 tree)
**Quarantine path:** `TRASH/posture-20260613/v2/`
**Pre-move SHA:** `dc859cb359496319e5eee241dbed0ddb4bcd120c` (`git rev-parse HEAD` immediately before the move)

## What Moved — Count & Rule

- **6413 tracked files moved** — the complete legacy `v2/` tree, including
  `v2/package-lock.json` (~100 of the moved files are nested lockfiles/node artifacts).
- **Rule:** `git mv v2 TRASH/posture-20260613/v2` — every tracked `v2/<path>` relocated to
  `TRASH/posture-20260613/v2/<path>`, original relative path preserved verbatim.
- All 6413 staged changes are pure renames (`git diff --cached --name-status` reports
  `R100` for every entry — 100% content similarity, history-preserving). Zero non-R100.
- Live `v2/` no longer exists in the tracked tree (`git ls-files | grep '^v2/'` = 0).
- No non-`v2` file was touched by the move itself.

## Why Dead

The v3 packages have **zero v3->v2 runtime imports** (coordinator-verified prove-dead). The
only live references into `v2/` were documentation links, a cleanup script path, an
`.npmignore` comment, and two provenance-only `affectedFiles` strings in the CVE registry —
all of which were migrated (see below). Every remaining `v2` grep hit across the repo is an
API-version / version-string **false positive**, not a path reference:
`all-MiniLM-L6-v2`, `Claude Code v2.1.19`, `oauth2/v2/auth`, `migrate --from v2`,
`/v1/, /v2/ prefix`, etc. — these were deliberately **not** touched.

## Reference Migrations (the only live refs into `v2/`, all moved off it)

1. **`.npmignore`** — comment-only update above the existing `v2/` ignore rule:
   `# V2 legacy (not needed in npm package)` ->
   `# V2 legacy retired to TRASH/posture-20260613/v2/ (quarantined; covered by TRASH/ rules below)`.
   (The `v2/` ignore line itself is retained as defense-in-depth.)
2. **`README.md`** — removed 3 dead relative links under "Additional Resources":
   `- [V2 Documentation](./v2/README.md)`, `- [API Reference](./v2/docs/technical/)`,
   `- [Examples](./v2/examples/)`.
3. **`v3/@hive-flow/cli/README.md`** — removed 2 dead relative links:
   `- [API Reference](./v2/docs/technical/)`, `- [Examples](./v2/examples/)`.
4. **`scripts/cleanup-v3.sh`** — Step 1 artifact path:
   `v2/dist-cjs` -> `TRASH/posture-20260613/v2/dist-cjs` (both the `[ -d ... ]` test and the
   `remove_from_git` call, with the descriptive label reworded to drop the bare live `v2/`
   token and point at the quarantine path instead).
5. **`v3/@hive-flow/security/src/CVE-REMEDIATION.ts`** — two `affectedFiles` entries:
   `v2/src/api/auth-service.ts:580-588` -> `TRASH/posture-20260613/v2/src/api/auth-service.ts:580-588`
   and `v2/src/api/auth-service.ts:602-643` -> `TRASH/posture-20260613/v2/src/api/auth-service.ts:602-643`,
   each with a `// Legacy v2 surface retired ...; path kept for provenance.` comment.

## Prove-Dead Evidence (coordinator-verified, BEFORE the move)

- **Zero v3->v2 runtime imports / requires / globs / copies.** No v3 package or build/CI path
  resolves into `v2/`.
- The five reference migrations above were the **only** live (non-false-positive) references
  into `v2/`; all were migrated off the live path.
- Remaining `v2` grep hits are version-string / API-version false positives (enumerated
  above) and resolve to **no** filesystem path under `v2/`.

## Verification Performed

- All 6413 staged changes are `R100` (lossless, history-preserving renames). Zero non-R100.
- `git ls-files | grep '^v2/'` returns **0** (no live `v2/` tracked path remains).
- `git ls-files TRASH/posture-20260613/v2/ | wc -l` is **> 0** (quarantine populated).
- The 5 reference migrations verified surgical (doc-link removals + path rewrites + comments).
- A static guard, `v3/tests/bats/v2-retirement-guard.bats`, asserts these invariants and
  guards against silent regression.

## Packaging Safety

`TRASH/**` is already excluded from npm pack (root `files` allowlist negation `"!TRASH/**"`
+ `.npmignore` guard; the retained `v2/` ignore line is additional defense-in-depth).
`npm pack --dry-run` filtered for `v2/|TRASH/` is **CLEAN** — no `v2/` or `TRASH/` path ships
in the tarball (root and `@hive-flow/cli`).

## Expected Dependabot Impact

Retiring the v2 tree removes ~**173** open alerts that pointed at v2 manifests/lockfiles
(including ~100 from `v2/package-lock.json` and its nested lockfiles), on top of the slice-3
root-lockfile retirement.

## Restore

```
git mv TRASH/posture-20260613/v2 v2
```

---

# Stale Untracked Guard Quarantine (slice B) — `v2-retirement-quarantine-guard.bats`

**Date:** 2026-06-13
**Original path:** `v3/tests/bats/v2-retirement-quarantine-guard.bats` (UNTRACKED)
**Quarantine path:** `TRASH/posture-20260613/stale-untracked-tests/v2-retirement-quarantine-guard.bats`

## What & Why-Stale

`v3/tests/bats/v2-retirement-quarantine-guard.bats` was an UNTRACKED stale near-duplicate
of the tracked canonical guard `v3/tests/bats/v2-retirement-guard.bats`. Because
`v3/scripts/run-bats.sh` globs the entire `v3/tests/bats` directory, the untracked draft
RAN in the local `pnpm test:bats` lane — but not in CI fresh-clones (file untracked), a
local/CI discrepancy. Worse, its test 4 used a broad `grep 'v2/'` that false-failed against
benign mentions, where the canonical guard uses a narrow+strip approach that passes.

It carried 2 genuine extras the canonical guard lacked. Those were PORTED into
`v3/tests/bats/v2-retirement-guard.bats` before this quarantine:
  - **(i) zero v3->v2 runtime import check** — ported verbatim as
    `@test "zero v3-to-v2 runtime imports in tracked source"`.
  - **(ii) npm-pack-clean invariant** — ported as
    `@test "npm pack ships zero v2 or TRASH paths"`, but re-implemented in
    ISOLATED-CACHE (`NPM_CONFIG_CACHE`) packaging-proof style (the duplicate's raw
    `npm pack` fails in shared-cache CI), gated behind `RUN_PACK_CHECK=1`.

With both extras ported, this draft is fully superseded. It is relocated here (NOT deleted)
so the human owns final destruction. It was UNTRACKED, so the relocation is a plain `mv`
into `TRASH/` + `git add` of the new path (git mv refuses untracked sources).

## Restore

```
git mv TRASH/posture-20260613/stale-untracked-tests/v2-retirement-quarantine-guard.bats v3/tests/bats/v2-retirement-quarantine-guard.bats
```
