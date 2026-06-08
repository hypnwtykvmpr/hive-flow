import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AntiMockViolation {
  file: string;
  line: number;
  label: string;
  text: string;
}

interface ForbiddenPattern {
  label: string;
  pattern: RegExp;
}

const forbiddenWord = (...parts: string[]): RegExp => new RegExp(`\\b${parts.join('')}\\b`);

const FORBIDDEN_PATTERNS: ForbiddenPattern[] = [
  { label: 'vitest function mock', pattern: /\bvi\s*\.\s*fn\s*\(/ },
  { label: 'vitest module mock', pattern: /\bvi\s*\.\s*mock\s*\(/ },
  { label: 'phantom root source import', pattern: /(?:\.\.\/){2,}src\b/ },
  { label: 'phantom source import', pattern: /\bv3\/src\b/ },
  { label: 'forbidden memory method', pattern: forbiddenWord('vector', 'Search') },
  { label: 'forbidden memory method', pattern: forbiddenWord('clear', 'Agent') },
  { label: 'forbidden swarm method', pattern: forbiddenWord('get', 'SwarmState') },
  { label: 'forbidden swarm method', pattern: forbiddenWord('distribute', 'Tasks') },
  { label: 'forbidden swarm method', pattern: forbiddenWord('execute', 'Task') },
  { label: 'forbidden swarm method', pattern: forbiddenWord('scale', 'Agents') },
  { label: 'forbidden swarm method', pattern: forbiddenWord('reach', 'Consensus') },
  { label: 'forbidden swarm method', pattern: forbiddenWord('re', 'configure') },
  { label: 'forbidden workflow class', pattern: forbiddenWord('Workflow', 'Engine') },
  { label: 'forbidden plugin method', pattern: forbiddenWord('get', 'ExtensionPoints') },
  { label: 'constructor-injected MCP tools', pattern: /new\s+MCPServer\s*\(\s*\{\s*tools\s*:/ },
  { label: 'test fixture mock import', pattern: /(?:__mocks__|mock-services|testing\/fixtures)/i },
];

export function scanE2eSources(rootDir: string): AntiMockViolation[] {
  const testDir = join(rootDir, '__tests__');
  if (!existsSync(testDir)) {
    return [];
  }

  const violations: AntiMockViolation[] = [];
  for (const file of collectTypeScriptFiles(testDir)) {
    const rel = relative(rootDir, file);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const { label, pattern } of FORBIDDEN_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(line)) {
          violations.push({
            file: rel,
            line: index + 1,
            label,
            text: line.trim(),
          });
        }
      }
    });
  }

  return violations;
}

export function formatViolations(violations: AntiMockViolation[]): string {
  return violations
    .map((v) => `${v.file}:${v.line} ${v.label}: ${v.text}`)
    .join('\n');
}

function collectTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(path));
    } else if (entry.isFile() && extname(entry.name) === '.ts') {
      files.push(path);
    }
  }
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.argv[2] ?? process.cwd();
  const violations = scanE2eSources(root);
  if (violations.length > 0) {
    console.error(formatViolations(violations));
    process.exit(1);
  }
}
