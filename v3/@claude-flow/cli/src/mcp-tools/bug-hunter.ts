/**
 * Bug Hunter MCP Tools
 *
 * A dedicated bug-hunting agent that finds and reports bugs but NEVER fixes them.
 * Runs as a parallel companion alongside implementation, testing, and review phases.
 * Bug reports are forwarded to phase teams (coder/tester/reviewer) to address.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MCPTool } from './types.js';

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const STORAGE_DIR = '.claude-flow';
const HUNTER_DIR = 'bug-hunter';
const HUNTER_FILE = 'reports.json';

function getHunterDir(): string {
  return join(process.cwd(), STORAGE_DIR, HUNTER_DIR);
}

function getHunterPath(): string {
  return join(getHunterDir(), HUNTER_FILE);
}

function ensureHunterDir(): void {
  const dir = getHunterDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BugCategory =
  | 'logic-error'
  | 'null-safety'
  | 'type-mismatch'
  | 'race-condition'
  | 'resource-leak'
  | 'security-vuln'
  | 'edge-case'
  | 'regression';

export type BugSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface BugReport {
  bugId: string;
  category: BugCategory;
  severity: BugSeverity;
  title: string;
  description: string;
  location: {
    file: string;
    line?: number;
    function?: string;
  };
  reproduction: string;
  suggestedFix: string;
  evidence: string[];
  detectedAt: string;
  phase: string;
}

export interface BugHunterConfig {
  targetPhase: 'implementation' | 'testing' | 'review';
  scanScope: string[];
  activeScan: boolean;
  categories?: BugCategory[];
}

export interface BugHunterResult {
  huntId: string;
  workflowId?: string;
  phase: string;
  bugs: BugReport[];
  scannedFiles: string[];
  coverageGaps: CoverageGap[];
  summary: {
    total: number;
    bySeverity: Record<BugSeverity, number>;
    byCategory: Record<BugCategory, number>;
  };
  startedAt: string;
  completedAt: string;
}

export interface CoverageGap {
  file: string;
  uncoveredLines: number;
  uncoveredFunctions: string[];
  priority: 'low' | 'medium' | 'high';
  suggestedTests: string[];
}

interface HunterStore {
  reports: Record<string, BugHunterResult>;
  version: string;
}

// ---------------------------------------------------------------------------
// Store helpers (exported for testability)
// ---------------------------------------------------------------------------

export function loadHunterStore(): HunterStore {
  try {
    const path = getHunterPath();
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // Return empty store on corruption / read error
  }
  return { reports: {}, version: '3.0.0' };
}

export function saveHunterStore(store: HunterStore): void {
  ensureHunterDir();
  writeFileSync(getHunterPath(), JSON.stringify(store, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_CATEGORIES: BugCategory[] = [
  'logic-error',
  'null-safety',
  'type-mismatch',
  'race-condition',
  'resource-leak',
  'security-vuln',
  'edge-case',
  'regression',
];

const CATEGORY_DEFAULT_SEVERITY: Record<BugCategory, BugSeverity> = {
  'security-vuln': 'high',
  'race-condition': 'high',
  'logic-error': 'medium',
  'null-safety': 'medium',
  'resource-leak': 'medium',
  'type-mismatch': 'low',
  'edge-case': 'low',
  'regression': 'low',
};

function generateBugId(): string {
  const rand = Math.random().toString(36).substring(2, 8);
  return `bug-${Date.now()}-${rand}`;
}

function generateHuntId(): string {
  const rand = Math.random().toString(36).substring(2, 8);
  return `hunt-${Date.now()}-${rand}`;
}

/**
 * Safely read a file's contents. Returns null when the file cannot be read.
 */
function safeReadFile(filePath: string): string | null {
  try {
    if (existsSync(filePath)) {
      return readFileSync(filePath, 'utf-8');
    }
  } catch {
    // Silently skip unreadable files
  }
  return null;
}

/**
 * Extract top-level function / method names from source text (best-effort).
 */
function extractFunctionNames(source: string): string[] {
  const names: string[] = [];
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
    /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(/g,
    /(\w+)\s*\([^)]*\)\s*(?::\s*\S+\s*)?\{/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1] && !names.includes(match[1])) {
        names.push(match[1]);
      }
    }
  }
  return names;
}

/**
 * Derive the expected test file path for a given source file.
 */
function expectedTestPath(file: string): string {
  const ext = file.endsWith('.tsx') ? '.tsx' : file.endsWith('.jsx') ? '.jsx' : '.ts';
  const base = file.replace(/\.(ts|tsx|js|jsx)$/, '');
  return `${base}.test${ext}`;
}

// ---------------------------------------------------------------------------
// Category scanners
// ---------------------------------------------------------------------------

function scanForLogicErrors(files: string[], context: Record<string, unknown>): BugReport[] {
  const bugs: BugReport[] = [];
  const phase = (context.phase as string) ?? 'unknown';

  for (const file of files) {
    const source = safeReadFile(file);
    if (!source) continue;

    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Assignment inside condition (common logic error)
      if (/if\s*\([^=!<>]*[^=!<>]=[^=][^=]/.test(line) && !/===|!==|==|!=|<=|>=/.test(line)) {
        bugs.push({
          bugId: generateBugId(),
          category: 'logic-error',
          severity: CATEGORY_DEFAULT_SEVERITY['logic-error'],
          title: 'Possible assignment inside condition',
          description: `Line ${i + 1} contains what appears to be an assignment (=) inside a conditional expression instead of a comparison (=== or ==).`,
          location: { file, line: i + 1 },
          reproduction: `Review the conditional on line ${i + 1} and verify intent.`,
          suggestedFix: 'Replace the single = with === (strict equality) if a comparison was intended.',
          evidence: [line.trim()],
          detectedAt: new Date().toISOString(),
          phase,
        });
      }

      // Off-by-one: array.length used with <= in loop bound
      if (/for\s*\(.*;\s*\w+\s*<=\s*\w+\.length\s*;/.test(line)) {
        bugs.push({
          bugId: generateBugId(),
          category: 'logic-error',
          severity: CATEGORY_DEFAULT_SEVERITY['logic-error'],
          title: 'Potential off-by-one error in loop bound',
          description: `Line ${i + 1} uses <= array.length which will access one index beyond the last element.`,
          location: { file, line: i + 1 },
          reproduction: 'Run the loop to its final iteration and check for out-of-bounds access.',
          suggestedFix: 'Use < instead of <= when comparing against .length.',
          evidence: [line.trim()],
          detectedAt: new Date().toISOString(),
          phase,
        });
      }
    }
  }

  return bugs;
}

function scanForNullSafety(files: string[], context: Record<string, unknown>): BugReport[] {
  const bugs: BugReport[] = [];
  const phase = (context.phase as string) ?? 'unknown';

  for (const file of files) {
    const source = safeReadFile(file);
    if (!source) continue;

    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Chained property access without optional chaining on potentially null values
      if (/\w+\.\w+\.\w+\.\w+/.test(line) && !line.includes('?.')) {
        bugs.push({
          bugId: generateBugId(),
          category: 'null-safety',
          severity: CATEGORY_DEFAULT_SEVERITY['null-safety'],
          title: 'Deeply chained property access without null guards',
          description: `Line ${i + 1} accesses a deeply nested property chain without optional chaining (?.). If any intermediate value is null or undefined, this will throw a TypeError.`,
          location: { file, line: i + 1 },
          reproduction: 'Pass an object where one of the intermediate properties is undefined.',
          suggestedFix: 'Add optional chaining (?.) at each uncertain level, or validate the chain beforehand.',
          evidence: [line.trim()],
          detectedAt: new Date().toISOString(),
          phase,
        });
      }

      // JSON.parse without try/catch (within a non-try block)
      if (/JSON\.parse\(/.test(line)) {
        const lookback = lines.slice(Math.max(0, i - 10), i).join('\n');
        if (!/\btry\s*\{/.test(lookback)) {
          bugs.push({
            bugId: generateBugId(),
            category: 'null-safety',
            severity: 'high',
            title: 'JSON.parse without error handling',
            description: `Line ${i + 1} calls JSON.parse() without a surrounding try/catch. Invalid JSON input will throw a SyntaxError.`,
            location: { file, line: i + 1 },
            reproduction: 'Provide malformed JSON input to the function containing this call.',
            suggestedFix: 'Wrap JSON.parse() in a try/catch block and handle the parse failure gracefully.',
            evidence: [line.trim()],
            detectedAt: new Date().toISOString(),
            phase,
          });
        }
      }
    }
  }

  return bugs;
}

function scanForTypeMismatch(files: string[], context: Record<string, unknown>): BugReport[] {
  const bugs: BugReport[] = [];
  const phase = (context.phase as string) ?? 'unknown';

  for (const file of files) {
    const source = safeReadFile(file);
    if (!source) continue;

    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Loose equality with null / undefined
      if (/[^!=]==[^=]\s*(null|undefined)/.test(line) || /(null|undefined)\s*==[^=]/.test(line)) {
        bugs.push({
          bugId: generateBugId(),
          category: 'type-mismatch',
          severity: CATEGORY_DEFAULT_SEVERITY['type-mismatch'],
          title: 'Loose equality comparison with null/undefined',
          description: `Line ${i + 1} uses == instead of === when comparing with null or undefined.`,
          location: { file, line: i + 1 },
          reproduction: 'Compare a value that is 0, false, or empty string against null using ==.',
          suggestedFix: 'Use strict equality (===) for explicit null/undefined checks.',
          evidence: [line.trim()],
          detectedAt: new Date().toISOString(),
          phase,
        });
      }

      // parseInt without radix
      if (/parseInt\(\s*[^,)]+\)/.test(line) && !/parseInt\([^,]+,/.test(line)) {
        bugs.push({
          bugId: generateBugId(),
          category: 'type-mismatch',
          severity: 'info',
          title: 'parseInt called without radix parameter',
          description: `Line ${i + 1} calls parseInt() without specifying a radix.`,
          location: { file, line: i + 1 },
          reproduction: 'Call the function with a string like "010" and observe the result.',
          suggestedFix: 'Always pass 10 as the second argument: parseInt(value, 10).',
          evidence: [line.trim()],
          detectedAt: new Date().toISOString(),
          phase,
        });
      }
    }
  }

  return bugs;
}

function scanForRaceConditions(files: string[], context: Record<string, unknown>): BugReport[] {
  const bugs: BugReport[] = [];
  const phase = (context.phase as string) ?? 'unknown';

  for (const file of files) {
    const source = safeReadFile(file);
    if (!source) continue;

    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check-then-act on filesystem (TOCTOU)
      if (/existsSync\(/.test(line)) {
        const nextLines = lines.slice(i + 1, i + 5).join('\n');
        if (/readFileSync|writeFileSync|unlinkSync|mkdirSync/.test(nextLines)) {
          bugs.push({
            bugId: generateBugId(),
            category: 'race-condition',
            severity: CATEGORY_DEFAULT_SEVERITY['race-condition'],
            title: 'TOCTOU race condition on filesystem operation',
            description: `Line ${i + 1} checks file existence then operates on it. Another process could modify the file between check and operation.`,
            location: { file, line: i + 1 },
            reproduction: 'Run two concurrent processes that check and modify the same file.',
            suggestedFix: 'Use a try/catch around the operation instead of pre-checking existence, or use file locking.',
            evidence: [line.trim(), nextLines.trim().split('\n')[0]],
            detectedAt: new Date().toISOString(),
            phase,
          });
        }
      }

      // Shared mutable state without synchronisation
      if (/^let\s+\w+\s*=/.test(line.trim()) && i < 5) {
        const varName = line.trim().match(/let\s+(\w+)/)?.[1];
        if (varName) {
          const usages = source.match(new RegExp(`\\b${varName}\\b`, 'g'));
          if (usages && usages.length > 3) {
            bugs.push({
              bugId: generateBugId(),
              category: 'race-condition',
              severity: CATEGORY_DEFAULT_SEVERITY['race-condition'],
              title: 'Module-level mutable variable with multiple access sites',
              description: `A module-level let variable declared near line ${i + 1} is referenced ${usages.length} times. In concurrent environments this can cause race conditions.`,
              location: { file, line: i + 1 },
              reproduction: 'Access this module from multiple async contexts simultaneously.',
              suggestedFix: 'Consider making the variable const, or encapsulate it within a class or closure with controlled access.',
              evidence: [line.trim()],
              detectedAt: new Date().toISOString(),
              phase,
            });
          }
        }
      }
    }
  }

  return bugs;
}

function scanForResourceLeaks(files: string[], context: Record<string, unknown>): BugReport[] {
  const bugs: BugReport[] = [];
  const phase = (context.phase as string) ?? 'unknown';

  for (const file of files) {
    const source = safeReadFile(file);
    if (!source) continue;

    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // setInterval without clearInterval
      if (/setInterval\(/.test(line) && !source.includes('clearInterval')) {
        bugs.push({
          bugId: generateBugId(),
          category: 'resource-leak',
          severity: CATEGORY_DEFAULT_SEVERITY['resource-leak'],
          title: 'setInterval without corresponding clearInterval',
          description: `Line ${i + 1} creates an interval timer but no clearInterval call was found in the file.`,
          location: { file, line: i + 1 },
          reproduction: 'Start the code and monitor memory / timer count over time.',
          suggestedFix: 'Store the interval ID and call clearInterval() during cleanup or teardown.',
          evidence: [line.trim()],
          detectedAt: new Date().toISOString(),
          phase,
        });
      }

      // Event listener without removeEventListener
      if (/addEventListener\(/.test(line) && !source.includes('removeEventListener')) {
        bugs.push({
          bugId: generateBugId(),
          category: 'resource-leak',
          severity: CATEGORY_DEFAULT_SEVERITY['resource-leak'],
          title: 'addEventListener without removeEventListener',
          description: `Line ${i + 1} adds an event listener but no removeEventListener was found.`,
          location: { file, line: i + 1 },
          reproduction: 'Repeatedly mount/unmount the component or module and observe memory growth.',
          suggestedFix: 'Store a reference to the handler and call removeEventListener during cleanup.',
          evidence: [line.trim()],
          detectedAt: new Date().toISOString(),
          phase,
        });
      }

      // Stream without error handling
      if (/create(Read|Write)Stream\(/.test(line)) {
        const nearby = lines.slice(i, Math.min(i + 10, lines.length)).join('\n');
        if (!nearby.includes('.on(\'error') && !nearby.includes('.on("error')) {
          bugs.push({
            bugId: generateBugId(),
            category: 'resource-leak',
            severity: CATEGORY_DEFAULT_SEVERITY['resource-leak'],
            title: 'Stream created without error handler',
            description: `Line ${i + 1} creates a stream but no .on('error') handler was found nearby.`,
            location: { file, line: i + 1 },
            reproduction: 'Trigger the stream with an invalid path or permissions issue.',
            suggestedFix: "Attach an error handler: stream.on('error', handleError).",
            evidence: [line.trim()],
            detectedAt: new Date().toISOString(),
            phase,
          });
        }
      }
    }
  }

  return bugs;
}

function scanForSecurityVulns(files: string[], context: Record<string, unknown>): BugReport[] {
  const bugs: BugReport[] = [];
  const phase = (context.phase as string) ?? 'unknown';

  for (const file of files) {
    const source = safeReadFile(file);
    if (!source) continue;

    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Hardcoded secrets / API keys
      if (/(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(line)) {
        bugs.push({
          bugId: generateBugId(),
          category: 'security-vuln',
          severity: 'critical',
          title: 'Potential hardcoded secret or credential',
          description: `Line ${i + 1} appears to contain a hardcoded secret, API key, or credential.`,
          location: { file, line: i + 1 },
          reproduction: 'Search the codebase for the secret value; it may be exposed in version control.',
          suggestedFix: 'Move the secret to an environment variable or a secrets manager and read it at runtime.',
          evidence: [line.trim().replace(/(['"])[^'"]{4}[^'"]*\1/, '$1****$1')],
          detectedAt: new Date().toISOString(),
          phase,
        });
      }

      // Dangerous eval() usage
      if (/\beval\s*\(/.test(line)) {
        bugs.push({
          bugId: generateBugId(),
          category: 'security-vuln',
          severity: CATEGORY_DEFAULT_SEVERITY['security-vuln'],
          title: 'Use of eval()',
          description: `Line ${i + 1} uses eval() which can run arbitrary code and is a common injection vector.`,
          location: { file, line: i + 1 },
          reproduction: 'Pass user-controlled input through the eval call path.',
          suggestedFix: 'Replace eval() with a safe alternative such as JSON.parse() or a parser library.',
          evidence: [line.trim()],
          detectedAt: new Date().toISOString(),
          phase,
        });
      }

      // Unsanitised path join from user input
      if (/join\(.*req\.(params|query|body)/.test(line) || /join\(.*input/.test(line)) {
        const preceding = lines.slice(Math.max(0, i - 3), i).join('\n');
        if (!/sanitize|validate|normalize|resolve/.test(preceding)) {
          bugs.push({
            bugId: generateBugId(),
            category: 'security-vuln',
            severity: CATEGORY_DEFAULT_SEVERITY['security-vuln'],
            title: 'Potential path traversal vulnerability',
            description: `Line ${i + 1} constructs a file path using external input without visible sanitisation.`,
            location: { file, line: i + 1 },
            reproduction: 'Provide a path like "../../etc/passwd" as input.',
            suggestedFix: 'Validate and sanitise the input using path.resolve() with a base directory check.',
            evidence: [line.trim()],
            detectedAt: new Date().toISOString(),
            phase,
          });
        }
      }
    }
  }

  return bugs;
}

function scanForEdgeCases(files: string[], context: Record<string, unknown>): BugReport[] {
  const bugs: BugReport[] = [];
  const phase = (context.phase as string) ?? 'unknown';

  for (const file of files) {
    const source = safeReadFile(file);
    if (!source) continue;

    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Array index access without length check
      if (/\w+\[\s*0\s*\]/.test(line) && !/['"`]/.test(line.split('[')[0])) {
        const precedingBlock = lines.slice(Math.max(0, i - 3), i).join('\n');
        if (!/\.length/.test(precedingBlock)) {
          bugs.push({
            bugId: generateBugId(),
            category: 'edge-case',
            severity: CATEGORY_DEFAULT_SEVERITY['edge-case'],
            title: 'Array first-element access without empty check',
            description: `Line ${i + 1} accesses [0] on an array without a preceding length check.`,
            location: { file, line: i + 1 },
            reproduction: 'Call the function with an empty array and observe the return value.',
            suggestedFix: 'Check that the array has at least one element before accessing index 0.',
            evidence: [line.trim()],
            detectedAt: new Date().toISOString(),
            phase,
          });
        }
      }

      // Division without zero check
      if (/\/\s*\w+/.test(line) && !/\/\/|\/\*|\*\//.test(line)) {
        const divisorMatch = line.match(/\/\s*(\w+)/);
        if (divisorMatch && /^[a-z]/i.test(divisorMatch[1])) {
          const precedingBlock = lines.slice(Math.max(0, i - 5), i).join('\n');
          const hasGuard = new RegExp(`${divisorMatch[1]}\\s*[!=]==?\\s*0`).test(precedingBlock);
          if (!hasGuard && !/if\s*\(/.test(precedingBlock)) {
            bugs.push({
              bugId: generateBugId(),
              category: 'edge-case',
              severity: CATEGORY_DEFAULT_SEVERITY['edge-case'],
              title: 'Potential division by zero',
              description: `Line ${i + 1} divides by variable '${divisorMatch[1]}' without a visible zero-check.`,
              location: { file, line: i + 1 },
              reproduction: `Set '${divisorMatch[1]}' to 0 and observe the result (Infinity or NaN).`,
              suggestedFix: `Add a guard: if (${divisorMatch[1]} === 0) return a default value or throw.`,
              evidence: [line.trim()],
              detectedAt: new Date().toISOString(),
              phase,
            });
          }
        }
      }
    }
  }

  return bugs;
}

function scanForRegressions(files: string[], context: Record<string, unknown>): BugReport[] {
  const bugs: BugReport[] = [];
  const phase = (context.phase as string) ?? 'unknown';

  for (const file of files) {
    const source = safeReadFile(file);
    if (!source) continue;

    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // TODO/FIXME/HACK/XXX markers
      if (/\/\/\s*(TODO|FIXME|HACK|XXX|BUG)\b/i.test(line)) {
        const marker = line.match(/\/\/\s*(TODO|FIXME|HACK|XXX|BUG)/i)?.[1] ?? 'TODO';
        const severity: BugSeverity = /FIXME|BUG/i.test(marker) ? 'medium' : 'low';
        bugs.push({
          bugId: generateBugId(),
          category: 'regression',
          severity,
          title: `Unresolved ${marker} comment`,
          description: `Line ${i + 1} contains a ${marker} marker that may indicate an incomplete fix or known issue.`,
          location: { file, line: i + 1 },
          reproduction: 'Review the surrounding code to determine if the issue described in the comment still exists.',
          suggestedFix: `Address the ${marker} and remove the marker once resolved.`,
          evidence: [line.trim()],
          detectedAt: new Date().toISOString(),
          phase,
        });
      }

      // Commented-out code blocks (3+ consecutive comment lines that look like code)
      if (/^\s*\/\/\s*(if|for|while|return|const|let|var|function|class|import|export)\b/.test(line)) {
        let consecutive = 1;
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          if (/^\s*\/\//.test(lines[j])) {
            consecutive++;
          } else {
            break;
          }
        }
        if (consecutive >= 3) {
          bugs.push({
            bugId: generateBugId(),
            category: 'regression',
            severity: 'info',
            title: 'Commented-out code block',
            description: `Lines ${i + 1}-${i + consecutive} contain commented-out code that may mask regressions.`,
            location: { file, line: i + 1 },
            reproduction: 'Review whether the commented code is still needed or should be removed.',
            suggestedFix: 'Remove dead code or extract it to a separate branch if it might be needed later.',
            evidence: lines.slice(i, i + Math.min(consecutive, 3)).map((l) => l.trim()),
            detectedAt: new Date().toISOString(),
            phase,
          });
        }
      }
    }
  }

  return bugs;
}

// ---------------------------------------------------------------------------
// Scanner registry
// ---------------------------------------------------------------------------

const SCANNERS: Record<BugCategory, (files: string[], ctx: Record<string, unknown>) => BugReport[]> = {
  'logic-error': scanForLogicErrors,
  'null-safety': scanForNullSafety,
  'type-mismatch': scanForTypeMismatch,
  'race-condition': scanForRaceConditions,
  'resource-leak': scanForResourceLeaks,
  'security-vuln': scanForSecurityVulns,
  'edge-case': scanForEdgeCases,
  'regression': scanForRegressions,
};

// ---------------------------------------------------------------------------
// Coverage gap analysis
// ---------------------------------------------------------------------------

function analyzeCoverageGaps(files: string[], _context: Record<string, unknown>): CoverageGap[] {
  const gaps: CoverageGap[] = [];

  for (const file of files) {
    // Only analyse source files, not test files
    if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(file)) continue;
    if (/__tests__/.test(file)) continue;

    const testPath = expectedTestPath(file);
    const testExists = existsSync(testPath);

    const source = safeReadFile(file);
    if (!source) continue;

    const functions = extractFunctionNames(source);
    const lineCount = source.split('\n').length;

    if (!testExists) {
      gaps.push({
        file,
        uncoveredLines: lineCount,
        uncoveredFunctions: functions,
        priority: functions.length > 5 ? 'high' : functions.length > 2 ? 'medium' : 'low',
        suggestedTests: functions.map((fn) => `Test '${fn}' with typical inputs and edge cases`),
      });
    } else {
      const testSource = safeReadFile(testPath);
      if (testSource) {
        const uncovered = functions.filter((fn) => !testSource.includes(fn));
        if (uncovered.length > 0) {
          gaps.push({
            file,
            uncoveredLines: 0,
            uncoveredFunctions: uncovered,
            priority: uncovered.length > 3 ? 'high' : uncovered.length > 1 ? 'medium' : 'low',
            suggestedTests: uncovered.map((fn) => `Add test coverage for '${fn}'`),
          });
        }
      }
    }
  }

  return gaps;
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(bugs: BugReport[]): BugHunterResult['summary'] {
  const bySeverity: Record<BugSeverity, number> = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  const byCategory: Record<BugCategory, number> = {
    'logic-error': 0,
    'null-safety': 0,
    'type-mismatch': 0,
    'race-condition': 0,
    'resource-leak': 0,
    'security-vuln': 0,
    'edge-case': 0,
    'regression': 0,
  };

  for (const bug of bugs) {
    bySeverity[bug.severity]++;
    byCategory[bug.category]++;
  }

  return { total: bugs.length, bySeverity, byCategory };
}

// ---------------------------------------------------------------------------
// Main scan executor
// ---------------------------------------------------------------------------

export async function executeBugHunterScan(
  config: BugHunterConfig,
  workflowContext: Record<string, unknown>,
): Promise<BugHunterResult> {
  const startedAt = new Date().toISOString();
  const huntId = generateHuntId();
  const categories = config.categories ?? ALL_CATEGORIES;

  const context: Record<string, unknown> = {
    ...workflowContext,
    phase: config.targetPhase,
  };

  // Resolve files that actually exist
  const scannedFiles = config.scanScope.filter((f) => existsSync(f));

  // Run applicable scanners
  const bugs: BugReport[] = [];
  for (const category of categories) {
    const scanner = SCANNERS[category];
    if (scanner) {
      const found = scanner(scannedFiles, context);
      bugs.push(...found);
    }
  }

  // Analyse coverage gaps
  const coverageGaps = analyzeCoverageGaps(scannedFiles, context);

  const result: BugHunterResult = {
    huntId,
    workflowId: workflowContext.workflowId as string | undefined,
    phase: config.targetPhase,
    bugs,
    scannedFiles,
    coverageGaps,
    summary: buildSummary(bugs),
    startedAt,
    completedAt: new Date().toISOString(),
  };

  // Persist
  const store = loadHunterStore();
  store.reports[huntId] = result;
  saveHunterStore(store);

  return result;
}

// ---------------------------------------------------------------------------
// MCP Tools
// ---------------------------------------------------------------------------

export const bugHunterTools: MCPTool[] = [
  {
    name: 'bug_hunter_scan',
    description:
      'Run a bug-hunting scan on specified files. The bug hunter finds and reports bugs but NEVER fixes them. Reports are sent to phase teams (coder/tester/reviewer) to address.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: {
          type: 'string',
          description: 'Optional workflow ID to associate the scan with',
        },
        phase: {
          type: 'string',
          enum: ['implementation', 'testing', 'review'],
          description: 'The workflow phase during which this scan is running',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to scan for bugs',
        },
        categories: {
          type: 'array',
          items: {
            type: 'string',
            enum: ALL_CATEGORIES,
          },
          description: 'Bug categories to focus on (default: all categories)',
        },
      },
      required: ['phase', 'files'],
    },
    category: 'bug-hunter',
    handler: async (input: Record<string, unknown>): Promise<unknown> => {
      const phase = input.phase as BugHunterConfig['targetPhase'];
      const files = input.files as string[];
      const categories = input.categories as BugCategory[] | undefined;
      const workflowId = input.workflowId as string | undefined;

      if (!phase || !files || !Array.isArray(files) || files.length === 0) {
        return { error: 'Missing required fields: phase (string) and files (non-empty string[])' };
      }

      const validPhases = ['implementation', 'testing', 'review'];
      if (!validPhases.includes(phase)) {
        return { error: `Invalid phase '${phase}'. Must be one of: ${validPhases.join(', ')}` };
      }

      if (categories) {
        const invalid = categories.filter((c) => !ALL_CATEGORIES.includes(c));
        if (invalid.length > 0) {
          return { error: `Invalid categories: ${invalid.join(', ')}. Valid: ${ALL_CATEGORIES.join(', ')}` };
        }
      }

      const config: BugHunterConfig = {
        targetPhase: phase,
        scanScope: files,
        activeScan: false,
        categories,
      };

      const workflowContext: Record<string, unknown> = {};
      if (workflowId) workflowContext.workflowId = workflowId;

      const result = await executeBugHunterScan(config, workflowContext);

      return {
        huntId: result.huntId,
        workflowId: result.workflowId,
        phase: result.phase,
        bugsFound: result.summary.total,
        summary: result.summary,
        bugs: result.bugs,
        coverageGaps: result.coverageGaps,
        scannedFiles: result.scannedFiles,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
      };
    },
  },
  {
    name: 'bug_hunter_report',
    description:
      'Retrieve bug hunt report(s) by hunt ID or workflow ID. Returns previously stored scan results.',
    inputSchema: {
      type: 'object',
      properties: {
        huntId: {
          type: 'string',
          description: 'Specific hunt ID to retrieve',
        },
        workflowId: {
          type: 'string',
          description: 'Workflow ID to retrieve all associated hunt results',
        },
      },
    },
    category: 'bug-hunter',
    handler: async (input: Record<string, unknown>): Promise<unknown> => {
      const huntId = input.huntId as string | undefined;
      const workflowId = input.workflowId as string | undefined;

      if (!huntId && !workflowId) {
        return { error: 'Provide either huntId or workflowId to retrieve reports' };
      }

      const store = loadHunterStore();

      if (huntId) {
        const report = store.reports[huntId];
        if (!report) {
          return { error: `No report found for huntId '${huntId}'` };
        }
        return report;
      }

      // Filter by workflowId
      const matching = Object.values(store.reports).filter((r) => r.workflowId === workflowId);
      if (matching.length === 0) {
        return { error: `No reports found for workflowId '${workflowId}'` };
      }

      return {
        workflowId,
        totalHunts: matching.length,
        reports: matching,
      };
    },
  },
];
