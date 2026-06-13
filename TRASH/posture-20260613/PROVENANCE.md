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
