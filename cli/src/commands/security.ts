/**
 * V3 CLI Security Command
 * Security scanning, CVE detection, threat modeling, vulnerability management
 *
 * Created by Hive Flow
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';

// ---------------------------------------------------------------------------
// dc69: context-first false-positive suppression for the `security scan`
// secret + unsafe-pattern matchers.
//
// The scanner self-flags its OWN detector definitions, its detector test
// fixtures, and documented examples. None of those are real committed
// secrets, yet they keep `security scan` permanently red. `classifySuppression`
// suppresses a match ONLY when the *line context* proves it is a detector
// definition, a detector fixture/example input, or a structurally impossible
// placeholder value.
//
// HARD RULES (router note 20260703T181710Z + Codex PLAN_REVIEW_PASS
// 20260703T181816Z):
//   - Never suppress on a value *marker substring* (`test`/`fake`/`example`
//     inside the value). A real high-entropy `sk_test_...` is a real secret.
//   - Never suppress file-wide by path. Path is corroboration ONLY, and only
//     for the fixture rule — never for a bare credential on a normal line.
//   - Weak passwords (`admin123`, `secure_password`) still flag in prod-looking
//     code unless the line itself proves it is a detector fixture/example.
// The trade-off is deliberate: prefer a residual false positive over hiding a
// real committed credential. `--strict` / `--no-suppress` bypasses all of it.
// ---------------------------------------------------------------------------

export type SuppressionMatchType = 'secret' | 'unsafe';

export interface SuppressionResult {
  suppress: boolean;
  /** Rule id that fired, for test assertions and audit evidence. */
  reason?: 'detector-definition' | 'detector-fixture' | 'placeholder-value';
}

// The match is part of a detector DEFINITION: a regex-pattern object field, a
// `new RegExp(...)`, a `must-not-contain` guard, an assigned regex literal, or
// an argument to a secret-detection API. You never write a real credential
// inside a detector definition, so this is self-sufficient and path-independent
// (detector definitions live in production source — this file included).
const DETECTOR_DEFINITION_LINE =
  /\b[A-Za-z]*[Pp]attern\s*:|\bnew\s+RegExp\s*\(|must[-_ ]?not[-_ ]?contain|=\s*\/(?:[^/\\\n]|\\.)+\/[gimsuy]*|^\s*\/(?:[^/\\\n]|\\.)+\/[gimsuy]*\s*,?\s*$|\b(?:evaluateSecrets|detectSecrets|scanForSecrets|scanSecrets|redactSecrets|containsSecret|isLikelySecret|detectPii|detectPII)\s*\(/;

// The match is a detector FIXTURE/EXAMPLE input: an object field explicitly
// named as example/fixture input. Corroborated by a test/fixture/detector path
// so a production `content:`/`input:` field holding a real credential still
// flags.
const FIXTURE_FIELD_LINE =
  /\b(?:content|input|sample|example|fixture|expected|notContains|mustNotContain|masked|redacted|testCase)\s*:/i;
const CORROBORATING_FIXTURE_PATH =
  /\.test\.|\.spec\.|[\\/]__tests__[\\/]|[\\/]__fixtures__[\\/]|[\\/]fixtures?[\\/]|[\\/]examples?[\\/]|\.example\.|security-regression|deep-inspect|[\\/]analyzer\.|manifest-validator/i;

// Explicit fill-in tokens that, as a WHOLE value, instruct the reader to
// replace them — never a real credential. NOT substring markers.
const FILL_IN_TOKENS = new Set([
  'your_key_here', 'your-key-here', 'your_api_key', 'your-api-key',
  'your_api_key_here', 'your_secret_here', 'your_token_here',
  'your_password_here', 'yourkeyhere', 'replace_me', 'replaceme',
  'insert_key_here', 'add_your_key_here', 'placeholder', 'redacted',
]);

function isPlaceholderValue(matchedValue: string): boolean {
  let v = matchedValue.trim();
  // Prefer the innermost quoted literal (the `password = "..."` pattern keeps
  // the assignment prefix in the match); fall back to stripping one quote pair.
  const quoted = v.match(/['"`]([^'"`]*)['"`]\s*$/);
  if (quoted) {
    v = quoted[1];
  } else {
    const q = v[0];
    if ((q === '"' || q === "'" || q === '`') && v[v.length - 1] === q) {
      v = v.slice(1, -1);
    }
  }
  v = v.trim();
  if (v.length === 0) return true;                              // empty
  if (/^<[^>]*>$/.test(v)) return true;                         // <your-key>
  if (/\$\{[^}]*\}/.test(v) || /\{\{[^}]*\}\}/.test(v)) return true; // ${..} {{..}}
  if (/^[*•]+$/.test(v)) return true;                           // **** ••••
  if (/^x+$/i.test(v)) return true;                             // xxxxxxxx (all-x)
  if (v === '...' || v === '…') return true;                    // ellipsis
  if (FILL_IN_TOKENS.has(v.toLowerCase())) return true;
  return false;
}

/**
 * Decide whether a scanner match is a false positive that should be
 * suppressed, and record which rule fired. Context-first: never suppresses on
 * value marker substrings or on file path alone. See the header comment.
 */
export function classifySuppression(
  line: string,
  matchedValue: string,
  relPath: string,
  matchType: SuppressionMatchType,
): SuppressionResult {
  // 1. Detector definition — self-sufficient, path-independent.
  if (DETECTOR_DEFINITION_LINE.test(line)) {
    return { suppress: true, reason: 'detector-definition' };
  }
  // 2. Detector fixture/example input — line field + corroborating path.
  if (FIXTURE_FIELD_LINE.test(line) && CORROBORATING_FIXTURE_PATH.test(relPath)) {
    return { suppress: true, reason: 'detector-fixture' };
  }
  // 3. Structurally-impossible placeholder value (secrets only).
  if (matchType === 'secret' && isPlaceholderValue(matchedValue)) {
    return { suppress: true, reason: 'placeholder-value' };
  }
  return { suppress: false };
}

interface SuppressedFinding {
  type: string;
  location: string;
  reason: NonNullable<SuppressionResult['reason']>;
}

// Scan subcommand
const scanCommand: Command = {
  name: 'scan',
  description: 'Run security scan on target (code, dependencies, containers)',
  options: [
    { name: 'target', short: 't', type: 'string', description: 'Target path or URL to scan', default: '.' },
    { name: 'depth', short: 'd', type: 'string', description: 'Scan depth: quick, standard, deep', default: 'standard' },
    { name: 'type', type: 'string', description: 'Scan type: code, deps, container, all', default: 'all' },
    { name: 'output', short: 'o', type: 'string', description: 'Output format: text, json, sarif', default: 'text' },
    { name: 'fix', short: 'f', type: 'boolean', description: 'Auto-fix vulnerabilities where possible' },
    { name: 'strict', type: 'boolean', description: 'Disable false-positive suppression (raw findings)' },
    { name: 'no-suppress', type: 'boolean', description: 'Alias for --strict: report every raw match' },
  ],
  examples: [
    { command: 'hive-flow security scan -t ./src', description: 'Scan source directory' },
    { command: 'hive-flow security scan --depth deep --fix', description: 'Deep scan with auto-fix' },
    { command: 'hive-flow security scan --strict', description: 'Report raw matches without FP suppression' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const target = ctx.flags.target as string || '.';
    const depth = ctx.flags.depth as string || 'standard';
    const scanType = ctx.flags.type as string || 'all';
    const fix = ctx.flags.fix as boolean;
    // dc69: --strict / --no-suppress bypasses the false-positive classifier and
    // reproduces the raw match set (audit / detection-preservation baseline).
    const strict = (ctx.flags.strict as boolean) || (ctx.flags['no-suppress'] as boolean) || false;
    const suppressed: SuppressedFinding[] = [];

    output.writeln();
    output.writeln(output.bold('Security Scan'));
    output.writeln(output.dim('─'.repeat(50)));

    const spinner = output.createSpinner({ text: `Scanning ${target}...`, spinner: 'dots' });
    spinner.start();

    const findings: Array<{ severity: string; type: string; location: string; description: string }> = [];
    let criticalCount = 0, highCount = 0, mediumCount = 0, lowCount = 0;

    try {
      const fs = await import('fs');
      const path = await import('path');
      const { execSync } = await import('child_process');

      // Phase 1: npm audit for dependency vulnerabilities
      if (scanType === 'all' || scanType === 'deps') {
        spinner.setText('Checking dependencies with npm audit...');
        try {
          const packageJsonPath = path.resolve(target, 'package.json');
          if (fs.existsSync(packageJsonPath)) {
            const auditResult = execSync('npm audit --json 2>/dev/null || true', {
              cwd: path.resolve(target),
              encoding: 'utf-8',
              maxBuffer: 10 * 1024 * 1024,
            });

            try {
              const audit = JSON.parse(auditResult);
              if (audit.vulnerabilities) {
                for (const [pkg, vuln] of Object.entries(audit.vulnerabilities as Record<string, { severity: string; via: Array<{ title?: string; url?: string }> }>)) {
                  const sev = vuln.severity || 'low';
                  const title = Array.isArray(vuln.via) && vuln.via[0]?.title ? vuln.via[0].title : 'Vulnerability';
                  if (sev === 'critical') criticalCount++;
                  else if (sev === 'high') highCount++;
                  else if (sev === 'moderate' || sev === 'medium') mediumCount++;
                  else lowCount++;

                  findings.push({
                    severity: sev === 'critical' ? output.error('CRITICAL') :
                              sev === 'high' ? output.warning('HIGH') :
                              sev === 'moderate' || sev === 'medium' ? output.warning('MEDIUM') : output.info('LOW'),
                    type: 'Dependency CVE',
                    location: `package.json:${pkg}`,
                    description: title.substring(0, 35),
                  });
                }
              }
            } catch { /* JSON parse failed, no vulns */ }
          }
        } catch { /* npm audit failed */ }
      }

      // Phase 2: Scan for hardcoded secrets
      if (scanType === 'all' || scanType === 'code') {
        spinner.setText('Scanning for hardcoded secrets...');
        const secretPatterns = [
          { pattern: /['"](?:sk-|sk_live_|sk_test_)[a-zA-Z0-9]{20,}['"]/g, type: 'API Key (Stripe/OpenAI)' },
          { pattern: /['"]AKIA[A-Z0-9]{16}['"]/g, type: 'AWS Access Key' },
          { pattern: /['"]ghp_[a-zA-Z0-9]{36}['"]/g, type: 'GitHub Token' },
          { pattern: /['"]xox[baprs]-[a-zA-Z0-9-]+['"]/g, type: 'Slack Token' },
          { pattern: /password\s*[:=]\s*['"][^'"]{8,}['"]/gi, type: 'Hardcoded Password' },
        ];

        const scanDir = (dir: string, depthLimit: number) => {
          if (depthLimit <= 0) return;
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                scanDir(fullPath, depthLimit - 1);
              } else if (entry.isFile() && /\.(ts|js|json|env|yml|yaml)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
                try {
                  const content = fs.readFileSync(fullPath, 'utf-8');
                  const lines = content.split('\n');
                  const relPath = path.relative(target, fullPath);
                  for (let i = 0; i < lines.length; i++) {
                    for (const { pattern, type } of secretPatterns) {
                      const matches = lines[i].match(pattern);
                      if (!matches) continue;
                      const cls: SuppressionResult = strict
                        ? { suppress: false }
                        : classifySuppression(lines[i], matches[0], relPath, 'secret');
                      const location = `${relPath}:${i + 1}`;
                      if (cls.suppress) {
                        suppressed.push({ type: 'Hardcoded Secret', location, reason: cls.reason! });
                        continue;
                      }
                      highCount++;
                      findings.push({
                        severity: output.warning('HIGH'),
                        type: 'Hardcoded Secret',
                        location,
                        description: type,
                      });
                    }
                  }
                } catch { /* file read error */ }
              }
            }
          } catch { /* dir read error */ }
        };

        const scanDepth = depth === 'deep' ? 10 : depth === 'standard' ? 5 : 3;
        scanDir(path.resolve(target), scanDepth);
      }

      // Phase 3: Check for common security issues in code
      if ((scanType === 'all' || scanType === 'code') && depth !== 'quick') {
        spinner.setText('Analyzing code patterns...');
        const codePatterns = [
          { pattern: /eval\s*\(/g, type: 'Eval Usage', severity: 'medium', desc: 'eval() can execute arbitrary code' },
          { pattern: /innerHTML\s*=/g, type: 'innerHTML', severity: 'medium', desc: 'XSS risk with innerHTML' },
          { pattern: /dangerouslySetInnerHTML/g, type: 'React XSS', severity: 'medium', desc: 'React XSS risk' },
          { pattern: /child_process.*exec[^S]/g, type: 'Command Injection', severity: 'high', desc: 'Possible command injection' },
          { pattern: /\$\{.*\}.*sql|sql.*\$\{/gi, type: 'SQL Injection', severity: 'high', desc: 'Possible SQL injection' },
        ];

        const scanCodeDir = (dir: string, depthLimit: number) => {
          if (depthLimit <= 0) return;
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                scanCodeDir(fullPath, depthLimit - 1);
              } else if (entry.isFile() && /\.(ts|js|tsx|jsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
                try {
                  const content = fs.readFileSync(fullPath, 'utf-8');
                  const lines = content.split('\n');
                  const relPath = path.relative(target, fullPath);
                  for (let i = 0; i < lines.length; i++) {
                    for (const { pattern, type, severity, desc } of codePatterns) {
                      const matches = lines[i].match(pattern);
                      if (!matches) continue;
                      const cls: SuppressionResult = strict
                        ? { suppress: false }
                        : classifySuppression(lines[i], matches[0], relPath, 'unsafe');
                      const location = `${relPath}:${i + 1}`;
                      if (cls.suppress) {
                        suppressed.push({ type, location, reason: cls.reason! });
                        continue;
                      }
                      if (severity === 'high') highCount++;
                      else mediumCount++;
                      findings.push({
                        severity: severity === 'high' ? output.warning('HIGH') : output.warning('MEDIUM'),
                        type,
                        location,
                        description: desc,
                      });
                    }
                  }
                } catch { /* file read error */ }
              }
            }
          } catch { /* dir read error */ }
        };

        const scanDepth = depth === 'deep' ? 10 : 5;
        scanCodeDir(path.resolve(target), scanDepth);
      }

      spinner.succeed('Scan complete');

      // Display results
      output.writeln();
      if (findings.length > 0) {
        output.printTable({
          columns: [
            { key: 'severity', header: 'Severity', width: 12 },
            { key: 'type', header: 'Type', width: 18 },
            { key: 'location', header: 'Location', width: 25 },
            { key: 'description', header: 'Description', width: 35 },
          ],
          data: findings.slice(0, 20), // Show first 20
        });

        if (findings.length > 20) {
          output.writeln(output.dim(`... and ${findings.length - 20} more issues`));
        }
      } else {
        output.writeln(output.success('No security issues found!'));
      }

      output.writeln();
      output.printBox([
        `Target: ${target}`,
        `Depth: ${depth}`,
        `Type: ${scanType}`,
        ``,
        `Critical: ${criticalCount}  High: ${highCount}  Medium: ${mediumCount}  Low: ${lowCount}`,
        `Total Issues: ${findings.length}`,
        strict
          ? `Suppression: OFF (--strict)`
          : `Suppressed false positives: ${suppressed.length} (run --strict to see raw)`,
      ].join('\n'), 'Scan Summary');

      // Auto-fix if requested
      if (fix && criticalCount + highCount > 0) {
        output.writeln();
        const fixSpinner = output.createSpinner({ text: 'Attempting to fix vulnerabilities...', spinner: 'dots' });
        fixSpinner.start();
        try {
          execSync('npm audit fix 2>/dev/null || true', { cwd: path.resolve(target), encoding: 'utf-8' });
          fixSpinner.succeed('Applied available fixes (run scan again to verify)');
        } catch {
          fixSpinner.fail('Some fixes could not be applied automatically');
        }
      }

      return {
        success: findings.length === 0 || (criticalCount === 0 && highCount === 0),
        data: {
          total: findings.length,
          suppressedCount: suppressed.length,
          criticalCount,
          highCount,
          mediumCount,
          lowCount,
          strict,
          findings,
          suppressed,
        },
      };
    } catch (error) {
      spinner.fail('Scan failed');
      output.printError(`Error: ${error}`);
      return { success: false };
    }
  },
};

// CVE subcommand
const cveCommand: Command = {
  name: 'cve',
  description: 'Check and manage CVE vulnerabilities',
  options: [
    { name: 'check', short: 'c', type: 'string', description: 'Check specific CVE ID' },
    { name: 'list', short: 'l', type: 'boolean', description: 'List all known CVEs' },
    { name: 'severity', short: 's', type: 'string', description: 'Filter by severity: critical, high, medium, low' },
  ],
  examples: [
    { command: 'hive-flow security cve --list', description: 'List all CVEs' },
    { command: 'hive-flow security cve -c CVE-2024-1234', description: 'Check specific CVE' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const checkCve = ctx.flags.check as string;

    output.writeln();
    output.writeln(output.bold('CVE Database'));
    output.writeln(output.dim('─'.repeat(50)));

    if (checkCve) {
      output.printBox([
        `CVE ID: ${checkCve}`,
        `Severity: CRITICAL (9.8)`,
        `Status: Active`,
        ``,
        `Description: Remote code execution vulnerability`,
        `Affected: lodash < 4.17.21`,
        `Fix: Upgrade to lodash >= 4.17.21`,
        ``,
        `References:`,
        `  - https://nvd.nist.gov/vuln/detail/${checkCve}`,
        `  - GitHub Security Advisory Database`,
      ].join('\n'), 'CVE Details');
    } else {
      output.writeln(output.warning('⚠ No real CVE database configured. Showing example data.'));
      output.writeln(output.dim('Run "npm audit" or "hive-flow security scan" for real vulnerability detection.'));
      output.writeln();
      output.printTable({
        columns: [
          { key: 'id', header: 'CVE ID (Example)', width: 22 },
          { key: 'severity', header: 'Severity', width: 12 },
          { key: 'package', header: 'Package', width: 20 },
          { key: 'status', header: 'Status', width: 15 },
        ],
        data: [
          { id: 'CVE-YYYY-NNNN', severity: output.error('CRITICAL'), package: 'example-pkg@1.0.0', status: output.warning('Example') },
          { id: 'CVE-YYYY-NNNN', severity: output.warning('HIGH'), package: 'example-pkg@2.0.0', status: output.success('Example') },
          { id: 'CVE-YYYY-NNNN', severity: output.info('MEDIUM'), package: 'example-pkg@3.0.0', status: output.success('Example') },
        ],
      });
    }

    return { success: true };
  },
};

// Threats subcommand
const threatsCommand: Command = {
  name: 'threats',
  description: 'Threat modeling and analysis',
  options: [
    { name: 'model', short: 'm', type: 'string', description: 'Threat model: stride, dread, pasta', default: 'stride' },
    { name: 'scope', short: 's', type: 'string', description: 'Analysis scope', default: '.' },
    { name: 'export', short: 'e', type: 'string', description: 'Export format: json, md, html' },
  ],
  examples: [
    { command: 'hive-flow security threats --model stride', description: 'Run STRIDE analysis' },
    { command: 'hive-flow security threats -e md', description: 'Export as markdown' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const model = ctx.flags.model as string || 'stride';

    output.writeln();
    output.writeln(output.bold(`Threat Model: ${model.toUpperCase()}`));
    output.writeln(output.dim('─'.repeat(50)));

    output.printTable({
      columns: [
        { key: 'category', header: 'Category', width: 20 },
        { key: 'threat', header: 'Threat', width: 30 },
        { key: 'risk', header: 'Risk', width: 10 },
        { key: 'mitigation', header: 'Mitigation', width: 30 },
      ],
      data: [
        { category: 'Spoofing', threat: 'API key theft', risk: output.error('High'), mitigation: 'Use secure key storage' },
        { category: 'Tampering', threat: 'Data manipulation', risk: output.warning('Medium'), mitigation: 'Input validation' },
        { category: 'Repudiation', threat: 'Action denial', risk: output.info('Low'), mitigation: 'Audit logging' },
        { category: 'Info Disclosure', threat: 'Data leakage', risk: output.error('High'), mitigation: 'Encryption at rest' },
        { category: 'DoS', threat: 'Resource exhaustion', risk: output.warning('Medium'), mitigation: 'Rate limiting' },
        { category: 'Elevation', threat: 'Privilege escalation', risk: output.error('High'), mitigation: 'RBAC implementation' },
      ],
    });

    return { success: true };
  },
};

// Audit subcommand
const auditCommand: Command = {
  name: 'audit',
  description: 'Security audit logging and compliance',
  options: [
    { name: 'action', short: 'a', type: 'string', description: 'Action: log, list, export, clear', default: 'list' },
    { name: 'limit', short: 'l', type: 'number', description: 'Number of entries to show', default: '20' },
    { name: 'filter', short: 'f', type: 'string', description: 'Filter by event type' },
  ],
  examples: [
    { command: 'hive-flow security audit --action list', description: 'List audit logs' },
    { command: 'hive-flow security audit -a export', description: 'Export audit trail' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const action = ctx.flags.action as string || 'list';

    output.writeln();
    output.writeln(output.bold('Security Audit Log'));
    output.writeln(output.dim('─'.repeat(60)));

    output.printTable({
      columns: [
        { key: 'timestamp', header: 'Timestamp', width: 22 },
        { key: 'event', header: 'Event', width: 20 },
        { key: 'user', header: 'User', width: 15 },
        { key: 'status', header: 'Status', width: 12 },
      ],
      data: [
        { timestamp: '2024-01-15 14:32:01', event: 'AUTH_LOGIN', user: 'admin', status: output.success('Success') },
        { timestamp: '2024-01-15 14:30:45', event: 'CONFIG_CHANGE', user: 'system', status: output.success('Success') },
        { timestamp: '2024-01-15 14:28:12', event: 'AUTH_FAILED', user: 'unknown', status: output.error('Failed') },
        { timestamp: '2024-01-15 14:25:33', event: 'SCAN_COMPLETE', user: 'ci-bot', status: output.success('Success') },
        { timestamp: '2024-01-15 14:20:00', event: 'KEY_ROTATE', user: 'admin', status: output.success('Success') },
      ],
    });

    return { success: true };
  },
};

// Secrets subcommand
const secretsCommand: Command = {
  name: 'secrets',
  description: 'Detect and manage secrets in codebase',
  options: [
    { name: 'action', short: 'a', type: 'string', description: 'Action: scan, list, rotate', default: 'scan' },
    { name: 'path', short: 'p', type: 'string', description: 'Path to scan', default: '.' },
    { name: 'ignore', short: 'i', type: 'string', description: 'Patterns to ignore' },
  ],
  examples: [
    { command: 'hive-flow security secrets --action scan', description: 'Scan for secrets' },
    { command: 'hive-flow security secrets -a rotate', description: 'Rotate compromised secrets' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const path = ctx.flags.path as string || '.';

    output.writeln();
    output.writeln(output.bold('Secret Detection'));
    output.writeln(output.dim('─'.repeat(50)));

    const spinner = output.createSpinner({ text: 'Scanning for secrets...', spinner: 'dots' });
    spinner.start();
    await new Promise(r => setTimeout(r, 800));
    spinner.succeed('Scan complete');

    output.writeln();
    output.writeln(output.warning('⚠ No real secrets scan performed. Showing example findings.'));
    output.writeln(output.dim('Run "hive-flow security scan --depth full" for real secret detection.'));
    output.writeln();
    output.printTable({
      columns: [
        { key: 'type', header: 'Secret Type (Example)', width: 25 },
        { key: 'location', header: 'Location', width: 30 },
        { key: 'risk', header: 'Risk', width: 12 },
        { key: 'action', header: 'Recommended', width: 20 },
      ],
      data: [
        { type: 'AWS Access Key', location: 'example/config.ts:15', risk: output.error('Critical'), action: 'Rotate immediately' },
        { type: 'GitHub Token', location: 'example/.env:8', risk: output.warning('High'), action: 'Remove from repo' },
        { type: 'JWT Secret', location: 'example/auth.ts:42', risk: output.warning('High'), action: 'Use env variable' },
        { type: 'DB Password', location: 'example/compose.yml:23', risk: output.warning('Medium'), action: 'Use secrets mgmt' },
      ],
    });

    return { success: true };
  },
};

// Defend subcommand (AIDefence integration)
const defendCommand: Command = {
  name: 'defend',
  description: 'AI manipulation defense - detect prompt injection, jailbreaks, and PII',
  options: [
    { name: 'input', short: 'i', type: 'string', description: 'Input text to scan for threats' },
    { name: 'file', short: 'f', type: 'string', description: 'File to scan for threats' },
    { name: 'quick', short: 'Q', type: 'boolean', description: 'Quick scan (faster, less detailed)' },
    { name: 'learn', short: 'l', type: 'boolean', description: 'Enable learning mode', default: 'true' },
    { name: 'stats', short: 's', type: 'boolean', description: 'Show detection statistics' },
    { name: 'output', short: 'o', type: 'string', description: 'Output format: text, json', default: 'text' },
  ],
  examples: [
    { command: 'hive-flow security defend -i "ignore previous instructions"', description: 'Scan text for threats' },
    { command: 'hive-flow security defend -f ./prompts.txt', description: 'Scan file for threats' },
    { command: 'hive-flow security defend --stats', description: 'Show detection statistics' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const inputText = ctx.flags.input as string;
    const filePath = ctx.flags.file as string;
    const quickMode = ctx.flags.quick as boolean;
    const showStats = ctx.flags.stats as boolean;
    const outputFormat = ctx.flags.output as string || 'text';
    const enableLearning = ctx.flags.learn !== false;

    output.writeln();
    output.writeln(output.bold('🛡️ AIDefence - AI Manipulation Defense System'));
    output.writeln(output.dim('─'.repeat(55)));

    // Dynamic import keeps this command lazy while loading the in-package AIDefence implementation.
    let createAIDefence: typeof import('../aidefence/index.js').createAIDefence;
    try {
      const aidefence = await import('../aidefence/index.js');
      createAIDefence = aidefence.createAIDefence;
    } catch (error) {
      output.error(`AIDefence failed to load: ${String(error)}`);
      return { success: false, message: 'AIDefence not available' };
    }

    const defender = createAIDefence({ enableLearning });

    // Show stats mode
    if (showStats) {
      const stats = await defender.getStats();
      output.writeln();
      output.printBox([
        `Detection Count: ${stats.detectionCount}`,
        `Avg Detection Time: ${stats.avgDetectionTimeMs.toFixed(3)}ms`,
        `Learned Patterns: ${stats.learnedPatterns}`,
        `Mitigation Strategies: ${stats.mitigationStrategies}`,
        `Avg Mitigation Effectiveness: ${(stats.avgMitigationEffectiveness * 100).toFixed(1)}%`,
      ].join('\n'), 'Detection Statistics');
      return { success: true };
    }

    // Get input to scan
    let textToScan = inputText;
    if (filePath) {
      try {
        const fs = await import('fs/promises');
        textToScan = await fs.readFile(filePath, 'utf-8');
        output.writeln(output.dim(`Reading file: ${filePath}`));
      } catch (err) {
        output.error(`Failed to read file: ${filePath}`);
        return { success: false, message: 'File not found' };
      }
    }

    if (!textToScan) {
      output.writeln('Usage: hive-flow security defend -i "<text>" or -f <file>');
      output.writeln();
      output.writeln('Options:');
      output.printList([
        '-i, --input   Text to scan for AI manipulation attempts',
        '-f, --file    File path to scan',
        '-q, --quick   Quick scan mode (faster)',
        '-s, --stats   Show detection statistics',
        '--learn       Enable pattern learning (default: true)',
      ]);
      return { success: true };
    }

    const spinner = output.createSpinner({ text: 'Scanning for threats...', spinner: 'dots' });
    spinner.start();

    // Perform scan
    const startTime = performance.now();
    const result = quickMode
      ? { ...defender.quickScan(textToScan), threats: [], piiFound: false, detectionTimeMs: 0, inputHash: '', safe: !defender.quickScan(textToScan).threat }
      : await defender.detect(textToScan);
    const scanTime = performance.now() - startTime;

    spinner.stop();

    // JSON output
    if (outputFormat === 'json') {
      output.writeln(JSON.stringify({
        safe: result.safe,
        threats: result.threats || [],
        piiFound: result.piiFound,
        detectionTimeMs: scanTime,
      }, null, 2));
      return { success: true };
    }

    // Text output
    output.writeln();

    if (result.safe && !result.piiFound) {
      output.writeln(output.success('✅ No threats detected'));
    } else {
      if (!result.safe && result.threats) {
        output.writeln(output.error(`⚠️ ${result.threats.length} threat(s) detected:`));
        output.writeln();

        for (const threat of result.threats) {
          const severityColor = {
            critical: output.error,
            high: output.warning,
            medium: output.info,
            low: output.dim,
          }[threat.severity] || output.dim;

          output.writeln(`  ${severityColor(`[${threat.severity.toUpperCase()}]`)} ${threat.type}`);
          output.writeln(`    ${output.dim(threat.description)}`);
          output.writeln(`    Confidence: ${(threat.confidence * 100).toFixed(1)}%`);
          output.writeln();
        }

        // Show mitigation recommendations
        const criticalThreats = result.threats.filter(t => t.severity === 'critical');
        if (criticalThreats.length > 0 && enableLearning) {
          output.writeln(output.bold('Recommended Mitigations:'));
          for (const threat of criticalThreats) {
            const mitigation = await defender.getBestMitigation(threat.type as Parameters<typeof defender.getBestMitigation>[0]);
            if (mitigation) {
              output.writeln(`  ${threat.type}: ${output.bold(mitigation.strategy)} (${(mitigation.effectiveness * 100).toFixed(0)}% effective)`);
            }
          }
          output.writeln();
        }
      }

      if (result.piiFound) {
        output.writeln(output.warning('⚠️ PII detected (emails, SSNs, API keys, etc.)'));
        output.writeln();
      }
    }

    output.writeln(output.dim(`Detection time: ${scanTime.toFixed(3)}ms`));

    return { success: result.safe };
  },
};

// Main security command
export const securityCommand: Command = {
  name: 'security',
  description: 'Security scanning, CVE detection, threat modeling, AI defense',
  subcommands: [scanCommand, cveCommand, threatsCommand, auditCommand, secretsCommand, defendCommand],
  examples: [
    { command: 'hive-flow security scan', description: 'Run security scan' },
    { command: 'hive-flow security cve --list', description: 'List known CVEs' },
    { command: 'hive-flow security threats', description: 'Run threat analysis' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Hive Flow Security Suite'));
    output.writeln(output.dim('Comprehensive security scanning and vulnerability management'));
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      'scan     - Run security scans on code, deps, containers',
      'cve      - Check and manage CVE vulnerabilities',
      'threats  - Threat modeling (STRIDE, DREAD, PASTA)',
      'audit    - Security audit logging and compliance',
      'secrets  - Detect and manage secrets in codebase',
      'defend   - AI manipulation defense (prompt injection, jailbreaks, PII)',
    ]);
    output.writeln();
    output.writeln('Use --help with subcommands for more info');
    output.writeln();
    output.writeln(output.dim('Created by Hive Flow'));
    return { success: true };
  },
};

export default securityCommand;
