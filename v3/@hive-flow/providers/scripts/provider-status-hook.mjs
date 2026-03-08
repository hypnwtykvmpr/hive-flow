#!/usr/bin/env node
/**
 * Provider Status Hook — SessionStart
 *
 * Runs once when a Claude Code session starts. Detects installed
 * provider binaries, caches results, and outputs availability summary.
 *
 * Hook protocol:
 * - stdin: JSON session data (ignored)
 * - stdout: user-visible provider status line
 * - stderr: debug logs
 * - exit 0: always (never block session start)
 *
 * @module @hive-flow/providers/scripts/provider-status-hook
 */

import { execSync } from 'child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { join } from 'path';

// ===== Constants =====

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

const PROVIDERS = [
  { name: 'gemini-cli', binary: 'gemini' },
  { name: 'codex-cli', binary: 'codex' },
  { name: 'cursor-cli', binary: 'cursor-agent', fallback: 'cursor' },
];

// ===== Binary Detection =====

function detectBinary(binary, fallback) {
  try {
    execSync(`which ${binary}`, { stdio: 'pipe', timeout: 5000 });
  } catch {
    // Primary binary not found — try fallback if available
    if (fallback) {
      const fallbackResult = detectBinary(fallback);
      if (fallbackResult.found) return fallbackResult;
    }
    return { found: false, version: null };
  }

  try {
    const output = execSync(`${binary} --version`, {
      stdio: 'pipe',
      timeout: 10000,
      encoding: 'utf-8',
    }).trim();
    const version = output.split('\n')[0].slice(0, 80);
    return { found: true, version };
  } catch {
    return { found: true, version: 'unknown' };
  }
}

// ===== Cache =====

function getCacheDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return join(home, '.hive-flow');
}

function getCachePath() {
  return join(getCacheDir(), 'provider-status-cache.json');
}

function readCache() {
  const cachePath = getCachePath();
  if (!existsSync(cachePath)) return null;

  try {
    const data = JSON.parse(readFileSync(cachePath, 'utf-8'));
    const age = Date.now() - (data.timestamp || 0);
    if (age > CACHE_TTL) return null; // Expired
    return data;
  } catch {
    return null;
  }
}

function writeCache(data) {
  const cacheDir = getCacheDir();
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = getCachePath();
  const tmpPath = cachePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, cachePath);
}

// ===== Main =====

function main() {
  // Drain stdin (hook protocol requires reading it)
  try { readFileSync(0, 'utf-8'); } catch { /* no stdin is fine */ }

  // Check cache first
  const cached = readCache();
  if (cached) {
    outputStatus(cached.providers);
    return;
  }

  // Detect providers
  const providers = {};
  for (const { name, binary, fallback } of PROVIDERS) {
    const result = detectBinary(binary, fallback);
    providers[name] = {
      found: result.found,
      version: result.version,
      binary,
      timestamp: Date.now(),
    };
  }

  // Cache results
  writeCache({ providers, timestamp: Date.now() });

  // Output status
  outputStatus(providers);
}

function outputStatus(providers) {
  const parts = [];
  for (const { name } of PROVIDERS) {
    const info = providers[name];
    if (!info) {
      parts.push(`${name}: unknown`);
    } else if (info.found) {
      parts.push(`${name}: ${info.version || 'installed'}`);
    } else {
      parts.push(`${name}: not found`);
    }
  }

  const foundCount = Object.values(providers).filter((p) => p.found).length;
  if (foundCount > 0) {
    process.stdout.write(`[PROVIDERS] ${parts.join(', ')}\n`);
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`[provider-status-hook] Error: ${err.message}\n`);
}
process.exit(0);
