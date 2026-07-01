#!/usr/bin/env node
// Guard: v3 uses workspace:* protocol — incompatible with npm/yarn
var _agent = process.env.npm_config_user_agent || '';
if (_agent && !_agent.startsWith('pnpm')) {
  console.error('\n\u26d4  Wrong package manager detected.');
  console.error('   Hive Flow V3 requires pnpm (workspace:* protocol).');
  console.error('   Run: pnpm install\n');
  process.exit(1);
}

/**
 * Preinstall hook: repairs npm/npx cache to prevent ENOTEMPTY and ECOMPROMISED.
 *
 * Handles two common npm bugs in remote/CI/Codespaces environments:
 *   - ENOTEMPTY: leftover .package-XxXxXxXx dirs from interrupted atomic renames
 *   - ECOMPROMISED: corrupted integrity manifests in _cacache
 *
 * Works on Windows, macOS, and Linux. Uses only Node.js built-ins (CJS).
 * Intentionally uses var/ES5 for maximum Node.js compatibility (14+).
 */
var fs = require('fs');
var path = require('path');
var os = require('os');

var npmDir = path.join(os.homedir(), '.npm');

/**
 * Anchored predicate: true only when a single cacache JSONL line's `key` field
 * matches the real `hive-flow` package or the `@hive-flow/*` scope.
 *
 * Mirrors ./npx-repair.js#isHiveFlowCacheIndexEntry — kept in sync so the
 * two repair paths behave identically.  A raw substring match on the full file
 * content is deliberately avoided because it would evict unrelated packages
 * that merely mention "hive-flow" in description/peer-dep fields.
 */
function isHiveFlowCacheIndexEntry(line) {
  var str = String(line || '');
  // Fast-path: reject lines that don't mention hive-flow at all.
  if (str.indexOf('hive-flow') === -1) return false;

  // Extract the JSON portion (everything after the first tab).
  var tabIdx = str.indexOf('\t');
  var jsonStr = tabIdx !== -1 ? str.slice(tabIdx + 1) : str;

  var key = null;
  try {
    var parsed = JSON.parse(jsonStr);
    if (parsed && typeof parsed.key === 'string') key = parsed.key;
  } catch (e) { /* non-JSON — fall through to URL pattern check */ }

  if (key !== null) {
    // Match only the real hive-flow package and @hive-flow/* scope.
    // A trailing [/?#] or end-of-string prevents matching `hive-flow-unrelated`.
    return (
      /registry\.npmjs\.org\/hive-flow(?:[/?#]|$)/.test(key) ||
      /registry\.npmjs\.org\/@hive-flow(?:\/|%2[fF])/.test(key)
    );
  }

  // Fallback for non-JSON: require the anchored registry URL patterns.
  return (
    /registry\.npmjs\.org\/hive-flow(?:[/?#]|$)/.test(str) ||
    /registry\.npmjs\.org\/@hive-flow(?:\/|%2[fF])/.test(str)
  );
}

/**
 * Process a single cacache bucket file: drop hive-flow JSONL lines, keep the
 * rest.  Returns true when the file was modified.
 */
function pruneOrDeleteCacheBucket(fp) {
  try {
    var content = fs.readFileSync(fp, 'utf-8');
    var lines = content.split('\n');
    var keep = [];
    var removed = 0;
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (line.trim() !== '' && isHiveFlowCacheIndexEntry(line)) {
        removed++;
      } else {
        keep.push(line);
      }
    }
    if (removed === 0) return false;
    var survivors = keep.join('\n');
    if (survivors.trim() === '') {
      fs.unlinkSync(fp);
    } else {
      fs.writeFileSync(fp, survivors, 'utf-8');
    }
    return true;
  } catch (e) { /* skip unreadable */ }
  return false;
}

// 1. Clean stale rename artifacts from npx cache (fixes ENOTEMPTY)
try {
  var npxRoot = path.join(npmDir, '_npx');
  if (fs.existsSync(npxRoot)) {
    var dirs = fs.readdirSync(npxRoot);
    for (var i = 0; i < dirs.length; i++) {
      var nm = path.join(npxRoot, dirs[i], 'node_modules');
      if (fs.existsSync(nm) === false) continue;

      try {
        var entries = fs.readdirSync(nm);
        for (var k = 0; k < entries.length; k++) {
          var entry = entries[k];
          // Stale rename targets: .package-name-XxXxXxXx (dot prefix, dash, 8+ alpha suffix)
          if (entry.charAt(0) === '.' && entry.indexOf('-') > 0 && /[A-Za-z]{8}$/.test(entry)) {
            try {
              var p = path.join(nm, entry);
              var stat = fs.statSync(p);
              if (stat.isDirectory()) {
                fs.rmSync(p, { recursive: true, force: true });
              }
            } catch (e) { /* ignore individual failures */ }
          }
        }
      } catch (e) { /* can't read dir, skip */ }
    }
  }
} catch (e) { /* non-fatal */ }

// 2. Remove corrupted integrity entries from _cacache (fixes ECOMPROMISED)
//    Scans index-v5 hash buckets for lines referencing hive-flow packages and
//    prunes them using the anchored per-line predicate so unrelated packages
//    that happen to mention "hive-flow" in their metadata are NOT evicted.
try {
  var cacheIndex = path.join(npmDir, '_cacache', 'index-v5');
  if (fs.existsSync(cacheIndex)) {
    // Walk the two-level (or three-level) hash bucket structure.
    var buckets = fs.readdirSync(cacheIndex);
    for (var bi = 0; bi < buckets.length; bi++) {
      var bucketPath = path.join(cacheIndex, buckets[bi]);
      try {
        var bStat = fs.statSync(bucketPath);
        if (!bStat.isDirectory()) continue;
        var subBuckets = fs.readdirSync(bucketPath);
        for (var si = 0; si < subBuckets.length; si++) {
          var subPath = path.join(bucketPath, subBuckets[si]);
          try {
            var subStat = fs.statSync(subPath);
            if (subStat.isDirectory()) {
              // Third level
              var files = fs.readdirSync(subPath);
              for (var fi = 0; fi < files.length; fi++) {
                pruneOrDeleteCacheBucket(path.join(subPath, files[fi]));
              }
            } else {
              pruneOrDeleteCacheBucket(subPath);
            }
          } catch (e2) { /* skip */ }
        }
      } catch (e2) { /* skip unreadable bucket */ }
    }
  }
} catch (e) { /* non-fatal */ }

// 3. Remove stale package-lock.json files from npx cache entries
try {
  if (fs.existsSync(npxRoot)) {
    var cDirs = fs.readdirSync(npxRoot);
    for (var j = 0; j < cDirs.length; j++) {
      var lockFile = path.join(npxRoot, cDirs[j], 'package-lock.json');
      try {
        if (fs.existsSync(lockFile)) {
          var lockStat = fs.statSync(lockFile);
          // Remove lock files older than 1 hour (likely stale)
          var ageMs = Date.now() - lockStat.mtimeMs;
          if (ageMs > 3600000) {
            fs.unlinkSync(lockFile);
          }
        }
      } catch (e) { /* ignore */ }
    }
  }
} catch (e) { /* non-fatal */ }
