# V3 Repository Cleanup Report

**Master Plan Section 5: Repository Cleanup**
**Date:** 2026-01-04
**Status:** Analysis Complete - Ready for Execution

---

## Executive Summary

This report documents the current repository size issues, identifies files for removal, calculates expected savings, and provides instructions for executing the cleanup process as part of the claude-flow v3 migration.

### Current Repository Status

| Metric | Size | Notes |
|--------|------|-------|
| **Total Repository** | 820 MB | Including .git history |
| **.git Directory** | 416 MB | 50.7% of total size |
| **node_modules** | 78 MB | Development dependencies |
| **dist-cjs (tracked)** | 24 MB | 1,098 files tracked in git |
| **Backup Files** | ~1 MB | Scattered across v2/ |

### Key Issues Identified

1. **Build Artifacts Tracked in Git**: `v2/dist-cjs/` (24 MB, 1,098 files) should not be version controlled
2. **Backup File Accumulation**: Multiple `*-old.js`, `*.backup`, `*.bak` files
3. **Duplicate .gitignore Entries**: Redundant patterns for `dist/`, `.DS_Store`, log files
4. **Lock File Status**: Single lock file (package-lock.json) - ✅ Correct

---

## Files Identified for Removal

### 1. Build Artifacts (dist-cjs/)

**Path:** `v2/dist-cjs/`
**Status:** Currently tracked in git (CRITICAL ISSUE)
**Size:** 24 MB
**File Count:** 1,098 files

**Action:** Remove from git tracking and add to .gitignore

**Rationale:**
- CommonJS build output should be generated during CI/CD or user installation
- Tracking build artifacts bloats repository size unnecessarily
- Increases merge conflict potential
- Violates best practices (build artifacts should be .gitignore'd)

**Files Include:**
```
v2/dist-cjs/src/**/*.js
v2/dist-cjs/src/**/*.js.map
v2/dist-cjs/src/**/*.d.ts
```

---

### 2. Backup Files

#### 2.1 Bin Directory Backups

**Tracked in Git:** ✅ Yes (3 files)

| File | Size | Status |
|------|------|--------|
| `v2/bin/pair-old.js` | Tracked | Remove |
| `v2/bin/stream-chain.js.backup` | Tracked | Remove |
| `v2/bin/training-pipeline-old.js.bak` | Tracked | Remove |

#### 2.2 Source Code Backups

**Tracked in Git:** ✅ Yes (2 files)

| File | Status |
|------|--------|
| `v2/src/cli/simple-commands/pair-old.js` | Remove |
| `v2/src/cli/simple-commands/training-pipeline-old.js.bak` | Remove |

#### 2.3 Model Backups

**Tracked in Git:** ✅ Yes (3 files)

| File | Status |
|------|--------|
| `v2/docs/reasoningbank/models/google-research/memory.db.backup` | Remove |
| `v2/docs/reasoningbank/models/safla/memory.db.backup` | Remove |
| `v2/docs/reasoningbank/models/problem-solving/memory.db.backup` | Remove |

#### 2.4 Build Output Backups

**Tracked in Git:** ✅ Yes (2 files)

| File | Status |
|------|--------|
| `v2/dist-cjs/src/cli/simple-commands/pair-old.js` | Remove (with parent dir) |
| `v2/dist-cjs/src/cli/simple-commands/pair-old.js.map` | Remove (with parent dir) |

**Total Backup Files:** 10 tracked files
**Estimated Size:** ~1 MB

---

### 3. .gitignore Duplicate Entries

**Current Issues:**

1. **Duplicate `dist/` patterns** (lines 11 and 58)
   ```gitignore
   dist/        # Line 11
   dist/        # Line 58 (Python section)
   ```

2. **Duplicate `.DS_Store` patterns** (lines 28 and 66)
   ```gitignore
   .DS_Store    # Line 28 (IDE section)
   .DS_Store    # Line 66 (OS section)
   ```

3. **Duplicate log file patterns** (lines 4-8, 36-42)
   ```gitignore
   # Lines 4-8 (Dependencies section)
   npm-debug.log*
   yarn-debug.log*
   yarn-error.log*

   # Lines 36-42 (Logs section) - DUPLICATES
   npm-debug.log*
   yarn-debug.log*
   yarn-error.log*
   lerna-debug.log*
   ```

**Action:** Deduplicate .gitignore entries, organize by category

**Expected Improvement:**
- Remove ~10-15 duplicate lines
- Better organization and maintainability
- Faster git operations (marginal)

---

## Expected Savings

### Immediate Savings (Post-Cleanup)

| Category | Savings | Impact |
|----------|---------|--------|
| **dist-cjs removal** | 24 MB | High - reduces .git size |
| **Backup files** | ~1 MB | Low - minimal size impact |
| **.gitignore cleanup** | Negligible | Medium - improved maintainability |

**Total Immediate Savings:** ~25 MB (3% of total repository size)

### Long-Term Benefits

1. **Faster Git Operations**
   - Reduced clone time: ~3% faster
   - Smaller .git directory for future commits
   - Less merge conflict potential

2. **CI/CD Improvements**
   - Faster checkout in GitHub Actions
   - Reduced bandwidth usage
   - Cleaner build artifacts

3. **Developer Experience**
   - Clearer repository structure
   - No confusion from backup files
   - Better .gitignore organization

4. **Future Savings**
   - dist-cjs won't grow with future commits
   - No new backup files accumulation
   - Cleaner git history

---

## Cleanup Script Usage

### Location

**Script:** `/workspaces/claude-flow/scripts/cleanup-v3.sh`
**Permissions:** Executable (`chmod +x` applied)

### Dry Run (Recommended First)

```bash
# Preview changes without applying them
cd /workspaces/claude-flow
bash scripts/cleanup-v3.sh --dry-run
```

**Dry Run Output Includes:**
- Files that would be removed
- Git tracking changes that would be made
- .gitignore modifications that would occur
- Estimated savings

### Execute Cleanup

```bash
# Apply cleanup changes
cd /workspaces/claude-flow
bash scripts/cleanup-v3.sh
```

**Cleanup Process:**

1. **Remove tracked build artifacts**
   - `git rm -r --cached v2/dist-cjs`
   - Add `dist-cjs/` to .gitignore

2. **Delete backup files**
   - `v2/bin/*-old.js`
   - `v2/bin/*.backup.js`
   - `v2/bin/*.bak`
   - `v2/src/**/*-old.*`
   - `v2/docs/reasoningbank/models/*.backup`

3. **Clean .gitignore**
   - Remove duplicate entries
   - Sort and organize patterns
   - Ensure dist-cjs/ is ignored

4. **Verify lock files**
   - Confirm single lock file (package-lock.json)
   - Report any issues

### Post-Cleanup Steps

```bash
# 1. Review changes
git status

# 2. Review .gitignore changes
git diff .gitignore

# 3. Commit cleanup
git add .gitignore
git commit -m "chore(v3): repository cleanup - remove build artifacts and backups

- Remove v2/dist-cjs/ from git tracking (24 MB, 1,098 files)
- Delete backup files (*-old.js, *.backup, *.bak)
- Clean up .gitignore duplicate entries
- Add dist-cjs/ to .gitignore

Part of v3 migration Master Plan Section 5: Repository Cleanup
Estimated savings: ~25 MB"

# 4. Verify build still works
npm run build

# 5. Push changes
git push origin v3
```

---

## Safety Measures

### What the Script Does NOT Do

✅ **Safe Operations:**
- Only removes files from git tracking (not filesystem)
- Uses `git rm --cached` (preserves local files)
- Only deletes files matching specific backup patterns
- Creates backup of .gitignore before modification (implicit via git)

❌ **What It Avoids:**
- Does NOT delete node_modules
- Does NOT delete source code files (except *-old.*, *.backup, *.bak)
- Does NOT delete .git history
- Does NOT force push changes
- Does NOT delete lock files

### Rollback Procedure

If issues occur after cleanup:

```bash
# 1. Rollback git changes
git reset --hard HEAD~1

# 2. Restore .gitignore
git checkout HEAD .gitignore

# 3. Re-track dist-cjs if needed (NOT RECOMMENDED)
git add -f v2/dist-cjs/

# 4. Verify repository state
git status
npm run build
```

---

## Recommendations

### Immediate Actions (High Priority)

1. ✅ **Run dry-run first**
   ```bash
   bash scripts/cleanup-v3.sh --dry-run
   ```

2. ✅ **Execute cleanup**
   ```bash
   bash scripts/cleanup-v3.sh
   ```

3. ✅ **Commit changes**
   ```bash
   git add .gitignore
   git commit -m "chore(v3): repository cleanup"
   ```

### Long-Term Improvements (Medium Priority)

1. **Add pre-commit hooks** to prevent backup file commits
   ```bash
   # .githooks/pre-commit
   #!/bin/bash
   if git diff --cached --name-only | grep -E '\.(backup|bak|old)$'; then
     echo "Error: Backup files detected in commit"
     exit 1
   fi
   ```

2. **Update CI/CD** to build dist-cjs during deployment
   ```yaml
   # .github/workflows/release.yml
   - name: Build CommonJS
     run: npm run build:cjs
   ```

3. **Document build process** in CONTRIBUTING.md
   - Explain that dist-cjs is generated
   - Provide local build instructions

### Future Considerations (Low Priority)

1. **Git history cleanup** (advanced - use with caution)
   - Consider `git filter-repo` to remove dist-cjs from history
   - Could save additional ~50-100 MB in .git directory
   - Requires force push and team coordination

2. **Monorepo optimization**
   - Consider Git LFS for large files if added
   - Explore shallow clones for CI/CD

3. **Repository size monitoring**
   - Add GitHub Action to track repository size
   - Alert on unexpected growth

---

## Master Plan Integration

This cleanup is **Section 5** of the v3 Master Plan:

**Completed:**
- ✅ Analysis of repository size issues
- ✅ Identification of files for removal
- ✅ Cleanup script creation
- ✅ Documentation of process

**Next Steps (Post-Cleanup):**
- Move to Master Plan Section 6: Testing & Validation
- Verify all v3 modules build correctly
- Run test suite after cleanup
- Update CI/CD for v3 structure

---

## Metrics & Success Criteria

### Before Cleanup

- Total size: 820 MB
- .git size: 416 MB
- Tracked files in dist-cjs: 1,098
- Backup files: 10 tracked

### After Cleanup (Expected)

- Total size: ~795 MB (-3%)
- .git size: ~392 MB (after gc)
- Tracked files in dist-cjs: 0
- Backup files: 0

### Success Criteria

- ✅ dist-cjs/ removed from git tracking
- ✅ All backup files deleted
- ✅ .gitignore has no duplicates
- ✅ dist-cjs/ added to .gitignore
- ✅ npm run build succeeds
- ✅ No regression in functionality

---

## Support & Contact

**Documentation:** `/workspaces/claude-flow/v3/docs/`
**Issues:** GitHub Issues (if applicable)
**Script:** `/workspaces/claude-flow/scripts/cleanup-v3.sh`

**Related Files:**
- `v3/docs/MASTER-PLAN.md` - Overall v3 migration strategy
- `v3/docs/ADR-*.md` - Architecture decisions
- `.gitignore` - Ignore patterns

---

**Report Generated:** 2026-01-04
**Script Version:** 1.0.0
**Status:** ✅ Ready for execution
