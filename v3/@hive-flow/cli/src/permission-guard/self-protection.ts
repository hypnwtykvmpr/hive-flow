/**
 * Self-Protection Layer — Prevents agents from modifying Permission Guard files.
 *
 * Two protection levels:
 * 1. Write/Edit path check: Blocks Write/Edit/MultiEdit tool calls targeting
 *    guard-related files (settings.json, hook-handler, guard source, config).
 * 2. Bash command analysis: Detects file-modifying shell commands (mv, cp,
 *    echo >, sed -i, tee, etc.) targeting protected paths.
 *
 * A cryptographic biometric override (Ed25519 challenge-response) allows a
 * human operator to temporarily bypass protection. See biometric-override.ts.
 */

import { resolve, relative, normalize, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { hasActiveOverride } from './biometric-override.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProtectionResult {
  blocked: boolean;
  reason: string;
  protectedPath?: string;
}

export interface IntegritySnapshot {
  ts: string;
  hashes: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Protected path definitions
// ---------------------------------------------------------------------------

const HOME = homedir();

/**
 * Paths that agents must never modify. Each entry is either an exact file
 * or a directory prefix (trailing slash means "everything under here").
 *
 * ${CWD} and ${HOME} are resolved at evaluation time so the patterns work
 * across different working directories and user accounts.
 */
const PROTECTED_PATH_TEMPLATES: string[] = [
  // Hook configuration — disabling hooks disables the entire guard
  '${CWD}/.claude/settings.json',

  // Hook dispatcher — replacing the handler bypasses permission checks
  '${CWD}/.claude/helpers/hook-handler.cjs',

  // Helper modules — corrupting these breaks routing, session, memory
  '${CWD}/.claude/helpers/',

  // Guard TypeScript source — modifying security logic
  '${CWD}/v3/@hive-flow/cli/src/permission-guard/',

  // Compiled guard — modifying runtime behavior directly
  '${CWD}/v3/@hive-flow/cli/dist/src/permission-guard/',

  // Guard runtime config — weakening patterns or disabling features
  '${HOME}/.hive-flow/permission-guard/',

  // Standalone setup script — modifying it could weaken initial guard installation
  '${CWD}/scripts/permission-guard-setup.mjs',
];

/**
 * Files that the build system must be allowed to write. These are
 * exempted from protection so `tsc` can compile TypeScript to dist/.
 * The exemption only applies when the operation comes from a Bash
 * command that looks like a build invocation (npm run build, tsc, etc.).
 */
const BUILD_OUTPUT_GLOBS = [
  '/v3/@hive-flow/cli/dist/',
];

/**
 * Bash command prefixes that indicate a build system invocation.
 * When a Bash command matches one of these AND targets a BUILD_OUTPUT_GLOB,
 * the protection is relaxed to allow the build to proceed.
 */
const BUILD_COMMAND_PATTERNS: RegExp[] = [
  /^(?:npm\s+run\s+(?:build|compile|dist))/i,
  /^(?:npx\s+tsc)\b/i,
  /^(?:tsc)\b/i,
  /^(?:node\s+.*(?:esbuild|rollup|webpack|vite))\b/i,
  /^(?:pnpm\s+(?:build|compile))/i,
  /^(?:yarn\s+(?:build|compile))/i,
  /^(?:make\s+(?:build|dist|all))/i,
];

// ---------------------------------------------------------------------------
// Path resolution and matching
// ---------------------------------------------------------------------------

function resolveTemplate(template: string, cwd: string): string {
  return template
    .replace('${HOME}', HOME)
    .replace('${CWD}', cwd);
}

/**
 * Normalize a file path for consistent comparison. Resolves to absolute,
 * removes trailing slashes (except root), and normalizes separators.
 */
function normalizePath(filePath: string): string {
  try {
    const abs = resolve(filePath);
    // Remove trailing separator unless it IS the root
    if (abs.length > 1 && abs.endsWith(sep)) {
      return abs.slice(0, -1).toLowerCase();
    }
    return abs.toLowerCase();
  } catch {
    return filePath.toLowerCase();
  }
}

/**
 * Check if a target path falls within or matches a protected path.
 * - If the protected path ends with '/', it is a directory prefix:
 *   any file under it is protected.
 * - Otherwise it is an exact file match.
 */
function matchesProtectedPattern(target: string, pattern: string): boolean {
  const normalizedTarget = normalizePath(target);
  const normalizedPattern = normalizePath(pattern);

  // Directory prefix match (pattern originally ended with /)
  if (pattern.endsWith('/')) {
    const dir = normalizedPattern;
    // Target is inside the directory if the relative path does not escape
    const rel = relative(dir, normalizedTarget);
    return !rel.startsWith('..') && !rel.startsWith(sep);
  }

  // Exact file match
  return normalizedTarget === normalizedPattern;
}

/**
 * Determine whether a file path targets a protected location.
 *
 * @param filePath - The absolute or relative path being written to
 * @param cwd - The current working directory for resolving ${CWD}
 * @returns ProtectionResult with blocked=true if protected
 */
export function isProtectedPath(filePath: string, cwd: string): ProtectionResult {
  if (!filePath) {
    return { blocked: false, reason: '' };
  }

  // Resolve the target to an absolute path
  const absoluteTarget = resolve(cwd, filePath);

  for (const template of PROTECTED_PATH_TEMPLATES) {
    const resolved = resolveTemplate(template, cwd);
    if (matchesProtectedPattern(absoluteTarget, resolved)) {
      return {
        blocked: true,
        reason: `DENIED: This file is part of the Permission Guard security system and cannot be modified by agents. Request human assistance if changes are needed. To grant a temporary override, run: node scripts/permission-guard-setup.mjs override`,
        protectedPath: resolved,
      };
    }
  }

  return { blocked: false, reason: '' };
}

// ---------------------------------------------------------------------------
// Build system exemption
// ---------------------------------------------------------------------------

/**
 * Check whether a Bash command looks like a build system invocation.
 */
function isBuildCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  return BUILD_COMMAND_PATTERNS.some(p => p.test(trimmed));
}

/**
 * Check whether a file path is a build output that should be exempted
 * when the operation is triggered by a build command.
 */
function isBuildOutput(filePath: string, cwd: string): boolean {
  const abs = resolve(cwd, filePath);
  const rel = relative(cwd, abs);
  const normalized = '/' + rel.replace(/\\/g, '/');
  return BUILD_OUTPUT_GLOBS.some(glob => normalized.startsWith(glob));
}

// ---------------------------------------------------------------------------
// Bash command analysis for file-modifying operations
// ---------------------------------------------------------------------------

/**
 * Shell commands that can modify file contents or metadata.
 * Each entry maps a command name to a function that extracts the target
 * file path(s) from the command arguments.
 */
const FILE_MODIFYING_COMMANDS: Array<{
  pattern: RegExp;
  name: string;
  extractTargets: (match: RegExpMatchArray, fullCmd: string) => string[];
}> = [
  // rm — deleting protected files/directories disables or corrupts the guard.
  {
    pattern: /\brm\s+(?:-[a-zA-Z]+\s+)*(.+)/,
    name: 'rm',
    extractTargets: (_m, fullCmd) => {
      const args = extractArguments(fullCmd, 'rm');
      return args.length >= 1 ? args : [];
    },
  },
  // mkdir — creating inside protected helper/config directories can plant code/config.
  {
    pattern: /\bmkdir\s+(?:-[a-zA-Z]+\s+)*(.+)/,
    name: 'mkdir',
    extractTargets: (_m, fullCmd) => {
      const args = extractArguments(fullCmd, 'mkdir');
      return args.length >= 1 ? args : [];
    },
  },
  // mv — check ALL arguments (source AND destination): `mv .claude/settings.json /tmp/` must be caught
  // even if /tmp/ is not a protected path, because the SOURCE is protected.
  {
    pattern: /\bmv\s+(?:-[a-zA-Z]+\s+)*(.+)/,
    name: 'mv',
    extractTargets: (_m, fullCmd) => {
      const args = extractArguments(fullCmd, 'mv');
      // Return all args so both source and destination are checked
      return args.length >= 2 ? args : [];
    },
  },
  // cp — check ALL arguments (source AND destination)
  {
    pattern: /\bcp\s+(?:-[a-zA-Z]+\s+)*(.+)/,
    name: 'cp',
    extractTargets: (_m, fullCmd) => {
      const args = extractArguments(fullCmd, 'cp');
      return args.length >= 2 ? args : [];
    },
  },
  // echo/printf with output redirection
  {
    pattern: /(?:echo|printf)\s+.*>\s*(.+)/,
    name: 'echo/printf redirect',
    extractTargets: (m) => {
      const target = m[1].trim().replace(/^['"]|['"]$/g, '');
      return [target];
    },
  },
  // Generic output redirection (covers >, >>)
  {
    pattern: /(?:>>?)\s*([^\s;|&]+)/,
    name: 'output redirect',
    extractTargets: (m) => {
      const target = m[1].trim().replace(/^['"]|['"]$/g, '');
      return [target];
    },
  },
  // sed -i (in-place edit)
  {
    pattern: /\bsed\s+(?:--in-place|-i)\b.*?(?:\s+)([^\s;|&]+)\s*$/,
    name: 'sed -i',
    extractTargets: (m) => {
      const target = m[1].trim().replace(/^['"]|['"]$/g, '');
      return [target];
    },
  },
  // tee — writes to the file argument(s)
  {
    pattern: /\btee\s+(?:-[a-zA-Z]+\s+)*(.+)/,
    name: 'tee',
    extractTargets: (m) => {
      return m[1].trim().split(/\s+/).map(t => t.replace(/^['"]|['"]$/g, ''));
    },
  },
  // perl -i (in-place)
  {
    pattern: /\bperl\s+-[a-zA-Z]*i[a-zA-Z]*\b.*?([^\s;|&]+)\s*$/,
    name: 'perl -i',
    extractTargets: (m) => {
      const target = m[1].trim().replace(/^['"]|['"]$/g, '');
      return [target];
    },
  },
  // truncate
  {
    pattern: /\btruncate\s+.*?(?:-s\s+\d+\s+)?([^\s;|&]+)/,
    name: 'truncate',
    extractTargets: (m) => {
      const target = m[1].trim().replace(/^['"]|['"]$/g, '');
      return [target];
    },
  },
  // dd with of= target
  {
    pattern: /\bdd\b.*?\bof=([^\s;|&]+)/,
    name: 'dd',
    extractTargets: (m) => {
      const target = m[1].trim().replace(/^['"]|['"]$/g, '');
      return [target];
    },
  },
  // install (can copy files)
  {
    pattern: /\binstall\s+(?:-[a-zA-Z]+\s+)*(.+)/,
    name: 'install',
    extractTargets: (_m, fullCmd) => {
      const args = extractArguments(fullCmd, 'install');
      return args.length >= 2 ? [args[args.length - 1]] : [];
    },
  },
  // ln -sf (can replace a target with a symlink) — check ALL arguments
  {
    pattern: /\bln\s+(?:-[a-zA-Z]+\s+)*(.+)/,
    name: 'ln',
    extractTargets: (_m, fullCmd) => {
      const args = extractArguments(fullCmd, 'ln');
      return args.length >= 2 ? args : [];
    },
  },
  // cat > file (heredoc or redirect)
  {
    pattern: /\bcat\s+(?:<<\S*\s+)?.*?>\s*([^\s;|&]+)/,
    name: 'cat redirect',
    extractTargets: (m) => {
      const target = m[1].trim().replace(/^['"]|['"]$/g, '');
      return [target];
    },
  },
  // chmod — target is the last argument
  {
    pattern: /\bchmod\s+(?:-[a-zA-Z]+\s+)*(.+)/,
    name: 'chmod',
    extractTargets: (_m, fullCmd) => {
      const args = extractArguments(fullCmd, 'chmod');
      return args.length >= 2 ? [args[args.length - 1]] : [];
    },
  },
  // chown — target is the last argument
  {
    pattern: /\bchown\s+(?:-[a-zA-Z]+\s+)*(.+)/,
    name: 'chown',
    extractTargets: (_m, fullCmd) => {
      const args = extractArguments(fullCmd, 'chown');
      return args.length >= 2 ? [args[args.length - 1]] : [];
    },
  },
];

/**
 * Extract non-flag arguments from a command string after the command name.
 * Handles basic quoting (single and double quotes).
 */
function extractArguments(cmd: string, cmdName: string): string[] {
  // Find the command name and extract everything after it
  const cmdIdx = cmd.indexOf(cmdName);
  if (cmdIdx < 0) return [];
  const rest = cmd.slice(cmdIdx + cmdName.length).trim();

  const args: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === ' ' && !inSingle && !inDouble) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) args.push(current);

  // Filter out flags (arguments starting with -)
  return args.filter(a => !a.startsWith('-'));
}

/**
 * Analyze a Bash command to detect file-modifying operations targeting
 * protected paths. Splits on chain operators (;, &&, ||) and checks
 * each sub-command independently.
 *
 * @param cmd - The raw Bash command string
 * @param cwd - Current working directory
 * @returns ProtectionResult if a protected path is targeted, or null
 */
export function checkBashSelfProtection(
  cmd: string,
  cwd: string,
): ProtectionResult | null {
  if (!cmd || !cmd.trim()) return null;

  // Quote-aware sub-command splitting
  const subCommands: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (const ch of cmd) {
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === '\\') { current += ch; escaped = true; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
    if (!inSingle && !inDouble) {
      if (ch === ';') { subCommands.push(current); current = ''; continue; }
      if (ch === '&' && current.endsWith('&')) { subCommands.push(current.slice(0, -1)); current = ''; continue; }
      if (ch === '|' && current.endsWith('|')) { subCommands.push(current.slice(0, -1)); current = ''; continue; }
    }
    current += ch;
  }
  if (current.trim()) subCommands.push(current);

  for (const sub of subCommands) {
    const trimmed = sub.trim();
    if (!trimmed) continue;

    // Build system exemption — only for this specific sub-command
    if (isBuildCommand(trimmed)) continue;

    for (const modifier of FILE_MODIFYING_COMMANDS) {
      const match = trimmed.match(modifier.pattern);
      if (!match) continue;

      const targets = modifier.extractTargets(match, trimmed);
      for (const target of targets) {
        if (!target) continue;

        const protection = isProtectedPath(target, cwd);
        if (protection.blocked) {
          return {
            blocked: true,
            reason: `DENIED: Bash command '${modifier.name}' targets protected Permission Guard file. ${protection.reason}`,
            protectedPath: protection.protectedPath,
          };
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Settings.json structural validation
// ---------------------------------------------------------------------------

/**
 * Required structure of settings.json hooks section.
 * If any of these are missing or malformed after a write, the guard
 * has been tampered with.
 */
interface SettingsHooksSection {
  PreToolUse?: Array<{
    matcher?: string;
    hooks?: Array<{
      type: string;
      command: string;
      timeout?: number;
    }>;
  }>;
}

/**
 * Validate that settings.json contains a properly structured hooks
 * section with the Permission Guard hook registered.
 *
 * @param settingsPath - Absolute path to settings.json
 * @returns true if the hook structure is valid
 */
export function validateSettingsStructure(settingsPath: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  try {
    const content = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content);

    // Must have hooks section
    if (!settings.hooks) {
      errors.push('Missing "hooks" section');
      return { valid: false, errors };
    }

    // Must have PreToolUse
    const preToolUse = settings.hooks.PreToolUse;
    if (!Array.isArray(preToolUse) || preToolUse.length === 0) {
      errors.push('Missing or empty "hooks.PreToolUse" array');
      return { valid: false, errors };
    }

    // Must have a permission-guard hook in PreToolUse
    let hasPermissionGuard = false;
    for (const entry of preToolUse) {
      if (!entry.hooks || !Array.isArray(entry.hooks)) continue;
      for (const hook of entry.hooks) {
        if (
          hook.type === 'command' &&
          typeof hook.command === 'string' &&
          hook.command.includes('permission-guard')
        ) {
          hasPermissionGuard = true;
        }
      }
    }

    if (!hasPermissionGuard) {
      errors.push('No permission-guard hook found in PreToolUse — guard may have been disabled');
    }

    // Verify the matcher covers Write, Edit, and Bash
    const requiredTools = ['Bash', 'Write', 'Edit'];
    for (const entry of preToolUse) {
      if (!entry.matcher) continue;
      const matcher = entry.matcher;
      const missingTools = requiredTools.filter(t => !matcher.includes(t));
      if (entry.hooks?.some((h: { command?: string }) => h.command?.includes('permission-guard')) && missingTools.length > 0) {
        errors.push(`Permission guard matcher missing tools: ${missingTools.join(', ')}`);
      }
    }

    return { valid: errors.length === 0, errors };
  } catch (err) {
    errors.push(`Failed to read or parse settings.json: ${err instanceof Error ? err.message : String(err)}`);
    return { valid: false, errors };
  }
}

// ---------------------------------------------------------------------------
// SHA-256 integrity monitoring
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hash of a file's contents.
 * Returns null if the file cannot be read (missing, permission error, etc.).
 */
function hashFile(filePath: string): string | null {
  try {
    const content = readFileSync(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Capture integrity hashes of all protected files.
 * Call this at session start to establish the baseline.
 *
 * @param cwd - Current working directory for resolving ${CWD} templates
 * @returns A snapshot mapping absolute paths to their SHA-256 hashes
 */
export function captureIntegritySnapshot(cwd: string): IntegritySnapshot {
  const hashes: Record<string, string> = {};

  for (const template of PROTECTED_PATH_TEMPLATES) {
    const resolved = resolveTemplate(template, cwd);

    // For directory templates, hash all files found inside
    if (template.endsWith('/')) {
      try {
        const { readdirSync } = require('node:fs');
        const entries = readdirSync(resolved, { recursive: true, withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            const fullPath = resolve(entry.parentPath || entry.path || resolved, entry.name);
            const hash = hashFile(fullPath);
            if (hash) {
              hashes[fullPath] = hash;
            }
          }
        }
      } catch {
        // Directory might not exist yet — skip
      }
    } else {
      // Exact file
      const hash = hashFile(resolved);
      if (hash) {
        hashes[resolved] = hash;
      }
    }
  }

  return {
    ts: new Date().toISOString(),
    hashes,
  };
}

/**
 * Verify current file hashes against a previously captured snapshot.
 *
 * @param snapshot - The baseline snapshot from captureIntegritySnapshot()
 * @returns Array of files that have changed or been deleted
 */
export function verifyIntegrity(snapshot: IntegritySnapshot): Array<{
  path: string;
  status: 'modified' | 'deleted';
  expectedHash: string;
  actualHash: string | null;
}> {
  const violations: Array<{
    path: string;
    status: 'modified' | 'deleted';
    expectedHash: string;
    actualHash: string | null;
  }> = [];

  for (const [filePath, expectedHash] of Object.entries(snapshot.hashes)) {
    const actualHash = hashFile(filePath);
    if (actualHash === null) {
      violations.push({ path: filePath, status: 'deleted', expectedHash, actualHash: null });
    } else if (actualHash !== expectedHash) {
      violations.push({ path: filePath, status: 'modified', expectedHash, actualHash });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Unified evaluation entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a Write/Edit/Bash operation should be blocked by
 * self-protection. This is the single entry point called from gate.ts.
 *
 * Returns null if the operation is not targeting protected paths (gate.ts
 * should continue with normal evaluation). Returns a ProtectionResult
 * with blocked=true if the operation must be denied.
 *
 * @param toolName - The tool being invoked (Write, Edit, MultiEdit, Bash)
 * @param toolInput - The tool's input parameters
 * @param cwd - Current working directory
 * @param sessionId - Current session ID (retained for API compatibility, unused)
 */
export function evaluateSelfProtection(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
  sessionId?: string,
): ProtectionResult | null {
  void sessionId; // retained for API compatibility

  // If an active cryptographic override exists, skip self-protection entirely
  if (hasActiveOverride()) {
    return null;
  }

  // Level 1: Write/Edit/MultiEdit/NotebookEdit path check
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    const filePath = (toolInput.file_path as string)
      || (toolInput.notebook_path as string)
      || (toolInput.path as string)
      || '';
    if (!filePath) return null;

    const protection = isProtectedPath(filePath, cwd);
    if (protection.blocked) {
      return protection;
    }
  }

  // Level 2: Bash command analysis
  if (toolName === 'Bash') {
    const cmd = (toolInput.command as string) || '';
    if (!cmd.trim()) return null;

    const bashResult = checkBashSelfProtection(cmd, cwd);
    if (bashResult) {
      return bashResult;
    }
  }

  return null;
}
