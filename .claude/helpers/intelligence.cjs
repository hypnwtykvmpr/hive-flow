#!/usr/bin/env node
/**
 * Intelligence Layer Stub (ADR-050)
 * Minimal fallback — full version is copied from package source.
 * Provides: init, getContext, recordEdit, feedback, consolidate
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(process.cwd(), '.claude-flow', 'data');
const STORE_PATH = path.join(DATA_DIR, 'auto-memory-store.json');
const RANKED_PATH = path.join(DATA_DIR, 'ranked-context.json');
const PENDING_PATH = path.join(DATA_DIR, 'pending-insights.jsonl');
const SESSION_DIR = path.join(process.cwd(), '.claude-flow', 'sessions');
const SESSION_FILE = path.join(SESSION_DIR, 'current.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(p) {
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : null; }
  catch { return null; }
}

function writeJSON(p, data) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

function sessionGet(key) {
  var session = readJSON(SESSION_FILE);
  if (!session) return null;
  return key ? (session.context || {})[key] : session.context;
}

function sessionSet(key, value) {
  var session = readJSON(SESSION_FILE);
  if (!session) return;
  if (!session.context) session.context = {};
  session.context[key] = value;
  writeJSON(SESSION_FILE, session);
}

function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(function(w) { return w.length > 2; });
}

function bootstrapFromMemoryFiles() {
  var entries = [];
  var candidates = [
    path.join(os.homedir(), ".claude", "projects"),
    path.join(process.cwd(), ".claude-flow", "memory"),
    path.join(process.cwd(), ".claude", "memory"),
  ];
  for (var i = 0; i < candidates.length; i++) {
    try {
      if (!fs.existsSync(candidates[i])) continue;
      var files = [];
      try {
        var items = fs.readdirSync(candidates[i], { withFileTypes: true, recursive: true });
        for (var j = 0; j < items.length; j++) {
          if (items[j].name === "MEMORY.md") {
            var fp = items[j].path ? path.join(items[j].path, items[j].name) : path.join(candidates[i], items[j].name);
            files.push(fp);
          }
        }
      } catch (e) { continue; }
      for (var k = 0; k < files.length; k++) {
        try {
          var content = fs.readFileSync(files[k], "utf-8");
          var sections = content.split(/^##\s+/m).filter(function(s) { return s.trim().length > 20; });
          for (var s = 0; s < sections.length; s++) {
            var lines = sections[s].split("\n");
            var title = lines[0] ? lines[0].trim() : "section-" + s;
            entries.push({
              id: "mem-" + entries.length,
              content: sections[s].substring(0, 500),
              summary: title.substring(0, 100),
              category: "memory",
              confidence: 0.5,
              sourceFile: files[k],
              words: tokenize(sections[s].substring(0, 500)),
            });
          }
        } catch (e) { /* skip */ }
      }
    } catch (e) { /* skip */ }
  }
  return entries;
}

function loadEntries() {
  var store = readJSON(STORE_PATH);
  if (store && store.entries && store.entries.length > 0) {
    return store.entries.map(function(e, i) {
      return {
        id: e.id || ("entry-" + i),
        content: e.content || e.value || "",
        summary: e.summary || e.key || "",
        category: e.category || e.namespace || "default",
        confidence: e.confidence || 0.5,
        sourceFile: e.sourceFile || "",
        words: tokenize((e.content || e.value || "") + " " + (e.summary || e.key || "")),
      };
    });
  }
  return bootstrapFromMemoryFiles();
}

function matchScore(promptWords, entryWords) {
  if (!promptWords.length || !entryWords.length) return 0;
  var entrySet = {};
  for (var i = 0; i < entryWords.length; i++) entrySet[entryWords[i]] = true;
  var overlap = 0;
  for (var j = 0; j < promptWords.length; j++) {
    if (entrySet[promptWords[j]]) overlap++;
  }
  var union = Object.keys(entrySet).length + promptWords.length - overlap;
  return union > 0 ? overlap / union : 0;
}

var cachedEntries = null;

module.exports = {
  init: function() {
    cachedEntries = loadEntries();
    var ranked = cachedEntries.map(function(e) {
      return { id: e.id, content: e.content, summary: e.summary, category: e.category, confidence: e.confidence, words: e.words };
    });
    writeJSON(RANKED_PATH, { version: 1, computedAt: Date.now(), entries: ranked });
    return { nodes: cachedEntries.length, edges: 0 };
  },

  getContext: function(prompt) {
    if (!prompt) return null;
    var ranked = readJSON(RANKED_PATH);
    var entries = (ranked && ranked.entries) || (cachedEntries || []);
    if (!entries.length) return null;
    var promptWords = tokenize(prompt);
    if (!promptWords.length) return null;
    var scored = entries.map(function(e) {
      return { entry: e, score: matchScore(promptWords, e.words || tokenize(e.content + " " + e.summary)) };
    }).filter(function(s) { return s.score > 0.05; });
    scored.sort(function(a, b) { return b.score - a.score; });
    var top = scored.slice(0, 5);
    if (!top.length) return null;
    var prevMatched = sessionGet("lastMatchedPatterns");
    var matchedIds = top.map(function(s) { return s.entry.id; });
    sessionSet("lastMatchedPatterns", matchedIds);
    var lines = ["[INTELLIGENCE] Relevant patterns for this task:"];
    for (var j = 0; j < top.length; j++) {
      var e = top[j];
      var conf = e.entry.confidence || 0.5;
      var summary = (e.entry.summary || e.entry.content || "").substring(0, 80);
      lines.push("  * (" + conf.toFixed(2) + ") " + summary);
    }
    return lines.join("\n");
  },

  recordEdit: function(file) {
    if (!file) return;
    ensureDir(DATA_DIR);
    var line = JSON.stringify({ type: "edit", file: file, timestamp: Date.now() }) + "\n";
    fs.appendFileSync(PENDING_PATH, line, "utf-8");
  },

  feedback: function(success) {
    // Record task outcome signal alongside edit logs.
    // Hardcoded true from Stop hook — see hook-handler.cjs comment.
    ensureDir(DATA_DIR);
    var line = JSON.stringify({ type: "feedback", success: !!success, timestamp: Date.now() }) + "\n";
    try { fs.appendFileSync(PENDING_PATH, line, "utf-8"); } catch (e) { /* non-fatal */ }
  },

  consolidate: function() {
    if (!fs.existsSync(PENDING_PATH)) return { entries: 0, edges: 0, newEntries: 0 };
    var content;
    try {
      content = fs.readFileSync(PENDING_PATH, "utf-8").trim();
    } catch (e) { return { entries: 0, edges: 0, newEntries: 0 }; }
    if (!content) return { entries: 0, edges: 0, newEntries: 0 };

    var lines = content.split("\n");
    var edits = [];
    var feedbackSignals = [];
    for (var i = 0; i < lines.length; i++) {
      try {
        var entry = JSON.parse(lines[i]);
        if (entry.type === "edit") edits.push(entry);
        else if (entry.type === "feedback") feedbackSignals.push(entry);
      } catch (e) { /* skip malformed */ }
    }

    // Clear pending file
    try { fs.writeFileSync(PENDING_PATH, "", "utf-8"); } catch (e) { /* skip */ }

    if (edits.length === 0) return { entries: lines.length, edges: 0, newEntries: 0 };

    // Synthesize patterns from edit clusters by directory
    var dirClusters = {};
    for (var j = 0; j < edits.length; j++) {
      var filePath = edits[j].file || "";
      // Extract meaningful directory (2 levels deep from src/)
      var parts = filePath.replace(/\\/g, "/").split("/");
      var srcIdx = parts.indexOf("src");
      var dirKey;
      if (srcIdx >= 0 && parts.length > srcIdx + 1) {
        dirKey = parts.slice(srcIdx, Math.min(srcIdx + 3, parts.length - 1)).join("/");
      } else {
        dirKey = parts.slice(Math.max(0, parts.length - 3), parts.length - 1).join("/");
      }
      if (!dirKey) dirKey = "root";
      if (!dirClusters[dirKey]) dirClusters[dirKey] = [];
      dirClusters[dirKey].push(edits[j]);
    }

    // Determine overall success from feedback signals
    var hasSuccess = feedbackSignals.some(function(f) { return f.success; });

    // Write synthesized patterns to auto-memory-store
    var storeWrapper;
    var store;
    try {
      storeWrapper = fs.existsSync(STORE_PATH) ? JSON.parse(fs.readFileSync(STORE_PATH, "utf-8")) : null;
      // Handle both formats: { entries: [...] } (from loadEntries) and plain array (legacy)
      if (storeWrapper && Array.isArray(storeWrapper.entries)) {
        store = storeWrapper.entries;
      } else if (Array.isArray(storeWrapper)) {
        store = storeWrapper;
      } else {
        store = [];
      }
    } catch (e) { store = []; }

    var newEntries = 0;
    var dirs = Object.keys(dirClusters);
    for (var k = 0; k < dirs.length; k++) {
      var cluster = dirClusters[dirs[k]];
      if (cluster.length < 2) continue; // Skip single-edit clusters — not a pattern

      var files = [];
      var seen = {};
      for (var m = 0; m < cluster.length; m++) {
        var basename = (cluster[m].file || "").split("/").pop() || "";
        if (basename && !seen[basename]) {
          seen[basename] = true;
          files.push(basename);
        }
      }

      var patternId = "pattern-" + dirs[k].replace(/[^a-z0-9]/gi, "-") + "-" + Date.now();
      var patternContent = "Edited " + files.length + " files in " + dirs[k] + ": " + files.slice(0, 5).join(", ") + (hasSuccess ? " (successful)" : "");

      // Dedup: skip if a similar pattern already exists (same directory, recent)
      var isDuplicate = store.some(function(e) {
        return e.namespace === "patterns" && e.key && e.key.indexOf(dirs[k].replace(/[^a-z0-9]/gi, "-")) >= 0
          && (Date.now() - (e.updatedAt || e.createdAt || 0)) < 3600000; // within 1 hour
      });
      if (isDuplicate) continue;

      store.push({
        id: patternId,
        key: patternId,
        namespace: "patterns",
        type: "procedural",
        content: patternContent,
        tags: ["auto-synthesized", dirs[k]],
        metadata: { fileCount: files.length, editCount: cluster.length, success: hasSuccess },
        confidence: hasSuccess ? 0.6 : 0.3,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      newEntries++;
    }

    if (newEntries > 0) {
      try { fs.writeFileSync(STORE_PATH, JSON.stringify({ entries: store }, null, 2), "utf-8"); } catch (e) { /* best effort */ }
    }

    return { entries: lines.length, edges: 0, newEntries: newEntries };
  },

  stats: function(json) {
    var ranked = readJSON(RANKED_PATH);
    var count = ranked && ranked.entries ? ranked.entries.length : 0;
    if (json) {
      console.log(JSON.stringify({ entries: count, computedAt: ranked ? ranked.computedAt : null }));
    } else {
      console.log('[INTELLIGENCE] Stats: ' + count + ' entries loaded');
    }
  },
};
