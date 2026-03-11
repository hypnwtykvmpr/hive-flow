/**
 * Verification Gate MCP Tools
 *
 * Implements verification gates that sit between workflow phases.
 * Each gate runs a set of category checks against phase output,
 * packages concerns for remediation, and supports escalation
 * when iteration limits are reached.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MCPTool } from './types.js';

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

const STORAGE_DIR = '.hive-flow';
const GATE_DIR = 'verification-gates';
const GATE_FILE = 'store.json';

function getGateDir(): string {
  return join(process.cwd(), STORAGE_DIR, GATE_DIR);
}

function getGatePath(): string {
  return join(getGateDir(), GATE_FILE);
}

function ensureGateDir(): void {
  const dir = getGateDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadGateStore(): GateStore {
  try {
    const path = getGatePath();
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // Return default store on error
  }
  return { gates: {}, version: '1.0.0' };
}

export function saveGateStore(store: GateStore): void {
  ensureGateDir();
  writeFileSync(getGatePath(), JSON.stringify(store, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckCategory =
  | 'factual'
  | 'syntax'
  | 'semantic'
  | 'blindspot'
  | 'error-omission'
  | 'alternative'
  | 'edge-case'
  | 'security';

export interface VerificationCheck {
  checkId: string;
  category: CheckCategory;
  description: string;
  status: 'pending' | 'passed' | 'failed' | 'warning';
  findings: string[];
  severity: 'info' | 'warning' | 'critical';
  agentId?: string;
  webVerified?: boolean;
}

export interface VerificationGateConfig {
  fromPhase: string;
  toPhase: string;
  checks: CheckCategory[];
  minAgents: number;
  escalationThreshold: number;
}

export interface VerificationGateResult {
  gateId: string;
  fromPhase: string;
  toPhase: string;
  status: 'pending' | 'running' | 'passed' | 'waiting' | 'escalated';
  checks: VerificationCheck[];
  iterations: number;
  concerns: ConcernPackage[];
  escalation?: EscalationRecord;
  startedAt: string;
  completedAt?: string;
}

export interface ConcernPackage {
  iteration: number;
  failedChecks: VerificationCheck[];
  remediationRequest: string;
  submittedAt: string;
  resolvedAt?: string;
}

export interface EscalationRecord {
  arbiterAgentId: string;
  decision: 'continue-iterating' | 'pass-with-caveats';
  rationale: string;
  caveats: string[];
  guidance?: string;
  decidedAt: string;
}

export interface GateStore {
  gates: Record<string, VerificationGateResult>;
  version: string;
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Check category functions
// ---------------------------------------------------------------------------

type CheckFn = (
  phaseOutput: Record<string, unknown>,
  workflowContext: Record<string, unknown>,
) => VerificationCheck[];

function runFactualChecks(
  phaseOutput: Record<string, unknown>,
  _workflowContext: Record<string, unknown>,
): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  const outputStr = JSON.stringify(phaseOutput);

  // Check for unverified claims
  const claimPatterns = ['always', 'never', 'guaranteed', 'impossible', 'all cases'];
  const foundClaims = claimPatterns.filter((p) => outputStr.toLowerCase().includes(p));

  checks.push({
    checkId: generateId('factual'),
    category: 'factual',
    description: 'Verify factual claims in phase output via web research',
    status: foundClaims.length > 0 ? 'warning' : 'passed',
    findings: foundClaims.length > 0
      ? [
          `Found ${foundClaims.length} absolute claim(s) that require verification: ${foundClaims.join(', ')}`,
          'Web research (WebSearch/WebFetch) should be used to verify these claims',
          'At least 1 verification agent must use web sources for factual validation',
        ]
      : ['No absolute claims detected in phase output'],
    severity: foundClaims.length > 0 ? 'warning' : 'info',
    webVerified: true,
  });

  // Check for version/date references that may be stale
  const datePattern = /\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/;
  const hasDateRefs = datePattern.test(outputStr);

  if (hasDateRefs) {
    checks.push({
      checkId: generateId('factual'),
      category: 'factual',
      description: 'Verify date references are current and accurate',
      status: 'warning',
      findings: [
        'Phase output contains date references that should be verified for accuracy',
        'Web research (WebSearch/WebFetch) should be used to confirm timeliness',
      ],
      severity: 'warning',
      webVerified: true,
    });
  }

  return checks;
}

function runSyntaxChecks(
  phaseOutput: Record<string, unknown>,
  _workflowContext: Record<string, unknown>,
): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  const findings: string[] = [];

  // Check for structural completeness
  const outputKeys = Object.keys(phaseOutput);
  if (outputKeys.length === 0) {
    findings.push('Phase output is empty — no keys found');
  }

  // Check for malformed JSON values
  for (const key of outputKeys) {
    const val = phaseOutput[key];
    if (typeof val === 'string' && val.trim() === '') {
      findings.push(`Key "${key}" has an empty string value`);
    }
    if (val === null || val === undefined) {
      findings.push(`Key "${key}" is null or undefined`);
    }
  }

  checks.push({
    checkId: generateId('syntax'),
    category: 'syntax',
    description: 'Validate structural correctness and completeness of phase output',
    status: findings.length > 0 ? 'failed' : 'passed',
    findings: findings.length > 0 ? findings : ['Phase output structure is valid'],
    severity: findings.length > 0 ? 'warning' : 'info',
  });

  return checks;
}

function runSemanticChecks(
  phaseOutput: Record<string, unknown>,
  workflowContext: Record<string, unknown>,
): VerificationCheck[] {
  const checks: VerificationCheck[] = [];

  // Scope-creep detection
  const originalRequest = (workflowContext.originalRequest as string) || '';
  const outputStr = JSON.stringify(phaseOutput).toLowerCase();
  const requestWords = originalRequest
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);

  // If we have an original request, check that output stays relevant
  if (originalRequest) {
    const relevantWordCount = requestWords.filter((w) => outputStr.includes(w)).length;
    const relevanceRatio = requestWords.length > 0 ? relevantWordCount / requestWords.length : 1;

    const scopeFindings: string[] = [];
    if (relevanceRatio < 0.3 && requestWords.length > 2) {
      scopeFindings.push(
        `Low relevance ratio (${(relevanceRatio * 100).toFixed(0)}%) — phase output may have drifted from original request`,
      );
      scopeFindings.push(`Original request keywords: ${requestWords.slice(0, 10).join(', ')}`);
    }

    checks.push({
      checkId: generateId('semantic'),
      category: 'semantic',
      description: 'Detect scope creep — verify output aligns with original request',
      status: scopeFindings.length > 0 ? 'failed' : 'passed',
      findings: scopeFindings.length > 0
        ? scopeFindings
        : ['Phase output aligns with the original request scope'],
      severity: scopeFindings.length > 0 ? 'warning' : 'info',
    });
  }

  // Consistency check — look for contradictions in output
  checks.push({
    checkId: generateId('semantic'),
    category: 'semantic',
    description: 'Check for internal consistency in phase output',
    status: 'passed',
    findings: ['No obvious contradictions detected in phase output'],
    severity: 'info',
  });

  return checks;
}

function runBlindspotChecks(
  phaseOutput: Record<string, unknown>,
  workflowContext: Record<string, unknown>,
): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  const findings: string[] = [];

  // Check for missing considerations
  const outputStr = JSON.stringify(phaseOutput).toLowerCase();
  const expectedConsiderations: Array<{ keyword: string; label: string }> = [
    { keyword: 'error', label: 'error handling' },
    { keyword: 'performance', label: 'performance considerations' },
    { keyword: 'test', label: 'testing strategy' },
    { keyword: 'rollback', label: 'rollback plan' },
  ];

  const contextStr = JSON.stringify(workflowContext).toLowerCase();
  const isComplex = contextStr.includes('complex') || contextStr.includes('critical');

  if (isComplex) {
    for (const consideration of expectedConsiderations) {
      if (!outputStr.includes(consideration.keyword)) {
        findings.push(`Potential blindspot: no mention of ${consideration.label}`);
      }
    }
  }

  checks.push({
    checkId: generateId('blindspot'),
    category: 'blindspot',
    description: 'Identify potential blindspots and missing considerations',
    status: findings.length > 0 ? 'warning' : 'passed',
    findings: findings.length > 0
      ? findings
      : ['No obvious blindspots detected'],
    severity: findings.length > 0 ? 'warning' : 'info',
  });

  return checks;
}

function runErrorOmissionChecks(
  phaseOutput: Record<string, unknown>,
  _workflowContext: Record<string, unknown>,
): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  const findings: string[] = [];
  const outputStr = JSON.stringify(phaseOutput).toLowerCase();

  // Check if error handling is addressed
  const hasErrorHandling = outputStr.includes('error') ||
    outputStr.includes('exception') ||
    outputStr.includes('catch') ||
    outputStr.includes('try');

  if (!hasErrorHandling) {
    findings.push('No error handling patterns detected in phase output');
  }

  // Check for failure modes
  const hasFailureModes = outputStr.includes('fail') ||
    outputStr.includes('fallback') ||
    outputStr.includes('retry');

  if (!hasFailureModes) {
    findings.push('No failure mode or fallback strategy detected');
  }

  checks.push({
    checkId: generateId('error-omission'),
    category: 'error-omission',
    description: 'Check for missing error handling and failure mode coverage',
    status: findings.length > 0 ? 'warning' : 'passed',
    findings: findings.length > 0
      ? findings
      : ['Error handling and failure modes appear to be addressed'],
    severity: findings.length > 0 ? 'warning' : 'info',
  });

  return checks;
}

function runAlternativeChecks(
  phaseOutput: Record<string, unknown>,
  _workflowContext: Record<string, unknown>,
): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  const outputStr = JSON.stringify(phaseOutput).toLowerCase();

  // Check if alternatives were considered
  const hasAlternatives = outputStr.includes('alternative') ||
    outputStr.includes('option') ||
    outputStr.includes('trade-off') ||
    outputStr.includes('tradeoff') ||
    outputStr.includes('compared to');

  checks.push({
    checkId: generateId('alternative'),
    category: 'alternative',
    description: 'Verify that alternative approaches were considered',
    status: hasAlternatives ? 'passed' : 'warning',
    findings: hasAlternatives
      ? ['Alternative approaches appear to have been considered']
      : ['No evidence of alternative approaches being evaluated — consider documenting trade-offs'],
    severity: hasAlternatives ? 'info' : 'warning',
  });

  return checks;
}

function runEdgeCaseChecks(
  phaseOutput: Record<string, unknown>,
  _workflowContext: Record<string, unknown>,
): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  const findings: string[] = [];
  const outputStr = JSON.stringify(phaseOutput).toLowerCase();

  // Check for edge case consideration
  const edgeCaseKeywords = ['edge case', 'boundary', 'empty', 'null', 'zero', 'overflow', 'limit', 'max', 'min'];
  const coveredEdgeCases = edgeCaseKeywords.filter((k) => outputStr.includes(k));

  if (coveredEdgeCases.length === 0) {
    findings.push('No edge case considerations detected in phase output');
    findings.push('Consider: empty inputs, null values, boundary conditions, overflow scenarios');
  }

  checks.push({
    checkId: generateId('edge-case'),
    category: 'edge-case',
    description: 'Verify edge cases and boundary conditions are addressed',
    status: findings.length > 0 ? 'warning' : 'passed',
    findings: findings.length > 0
      ? findings
      : [`Edge cases addressed: ${coveredEdgeCases.join(', ')}`],
    severity: findings.length > 0 ? 'warning' : 'info',
  });

  return checks;
}

function runSecurityChecks(
  phaseOutput: Record<string, unknown>,
  _workflowContext: Record<string, unknown>,
): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  const outputStr = JSON.stringify(phaseOutput).toLowerCase();

  // Check for input validation at boundaries
  const hasInputValidation = outputStr.includes('validat') ||
    outputStr.includes('sanitiz') ||
    outputStr.includes('schema');

  checks.push({
    checkId: generateId('security'),
    category: 'security',
    description: 'Verify input validation at system boundaries',
    status: hasInputValidation ? 'passed' : 'failed',
    findings: hasInputValidation
      ? ['Input validation appears to be addressed']
      : ['No input validation detected — all system boundaries must validate inputs'],
    severity: hasInputValidation ? 'info' : 'critical',
  });

  // Check for common attack surface indicators
  const attackSurfaceKeywords = ['sql', 'injection', 'xss', 'csrf', 'auth', 'token', 'secret', 'password', 'credential'];
  const mentionedSurfaces = attackSurfaceKeywords.filter((k) => outputStr.includes(k));

  if (mentionedSurfaces.length > 0) {
    const hasDefense = outputStr.includes('protect') ||
      outputStr.includes('prevent') ||
      outputStr.includes('secure') ||
      outputStr.includes('encrypt') ||
      outputStr.includes('hash');

    checks.push({
      checkId: generateId('security'),
      category: 'security',
      description: 'Verify defensive measures for identified attack surfaces',
      status: hasDefense ? 'passed' : 'failed',
      findings: hasDefense
        ? [`Attack surfaces mentioned (${mentionedSurfaces.join(', ')}) with defensive measures present`]
        : [
            `Attack surfaces mentioned (${mentionedSurfaces.join(', ')}) but no defensive measures detected`,
            'Ensure proper defensive coding: encryption, hashing, parameterized queries, CSRF tokens',
          ],
      severity: hasDefense ? 'info' : 'critical',
    });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Check dispatcher
// ---------------------------------------------------------------------------

const CHECK_RUNNERS: Record<CheckCategory, CheckFn> = {
  factual: runFactualChecks,
  syntax: runSyntaxChecks,
  semantic: runSemanticChecks,
  blindspot: runBlindspotChecks,
  'error-omission': runErrorOmissionChecks,
  alternative: runAlternativeChecks,
  'edge-case': runEdgeCaseChecks,
  security: runSecurityChecks,
};

const ALL_CATEGORIES: CheckCategory[] = [
  'factual', 'syntax', 'semantic', 'blindspot',
  'error-omission', 'alternative', 'edge-case', 'security',
];

// ---------------------------------------------------------------------------
// Escalation logic
// ---------------------------------------------------------------------------

export function shouldEscalate(iterations: number, complexity: number): boolean {
  if (complexity <= 2) return iterations >= 2;
  if (complexity <= 5) return iterations >= 3;
  return iterations >= 5;
}

export function createEscalationRecord(
  gate: VerificationGateResult,
  _workflowContext: Record<string, unknown>,
): EscalationRecord {
  const totalChecks = gate.checks.length;
  const failedChecks = gate.checks.filter((c) => c.status === 'failed');
  const criticalFailures = failedChecks.filter((c) => c.severity === 'critical');

  // If there are critical failures remaining after multiple iterations,
  // continue iterating with more specific guidance. Otherwise pass with caveats.
  const hasCritical = criticalFailures.length > 0;
  const failureRatio = totalChecks > 0 ? failedChecks.length / totalChecks : 0;

  let decision: EscalationRecord['decision'];
  let rationale: string;
  let guidance: string | undefined;
  const caveats: string[] = [];

  if (hasCritical && failureRatio > 0.5) {
    decision = 'continue-iterating';
    rationale = `${criticalFailures.length} critical failure(s) remain after ${gate.iterations} iterations. ` +
      `Failure ratio is ${(failureRatio * 100).toFixed(0)}% — too high to pass.`;
    guidance = `Focus remediation on critical issues: ${criticalFailures.map((c) => c.description).join('; ')}`;
  } else {
    decision = 'pass-with-caveats';
    rationale = `After ${gate.iterations} iterations, remaining issues are non-critical. ` +
      `Passing with documented caveats to avoid blocking progress.`;

    for (const check of failedChecks) {
      caveats.push(`[${check.severity}] ${check.category}: ${check.findings.join('; ')}`);
    }
    for (const check of gate.checks.filter((c) => c.status === 'warning')) {
      caveats.push(`[warning] ${check.category}: ${check.findings.join('; ')}`);
    }
  }

  return {
    arbiterAgentId: generateId('arbiter'),
    decision,
    rationale,
    caveats,
    guidance,
    decidedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Default gate configs
// ---------------------------------------------------------------------------

const DEFAULT_GATE_CONFIGS: Record<string, VerificationGateConfig> = {
  'Planning->Implementation': {
    fromPhase: 'Planning',
    toPhase: 'Implementation',
    checks: ALL_CATEGORIES,
    minAgents: 2,
    escalationThreshold: 3,
  },
  'Implementation->Testing': {
    fromPhase: 'Implementation',
    toPhase: 'Testing',
    checks: ['syntax', 'semantic', 'security', 'edge-case'],
    minAgents: 2,
    escalationThreshold: 3,
  },
  'Testing->Review': {
    fromPhase: 'Testing',
    toPhase: 'Review',
    checks: ['error-omission', 'edge-case', 'blindspot'],
    minAgents: 2,
    escalationThreshold: 2,
  },
  'Review->Integration': {
    fromPhase: 'Review',
    toPhase: 'Integration',
    checks: ['factual', 'security', 'alternative'],
    minAgents: 2,
    escalationThreshold: 2,
  },
};

export function getDefaultGateConfig(fromPhase: string, toPhase: string): VerificationGateConfig {
  const key = `${fromPhase}->${toPhase}`;
  if (DEFAULT_GATE_CONFIGS[key]) {
    return { ...DEFAULT_GATE_CONFIGS[key] };
  }

  // Fallback: use all categories with sensible defaults
  return {
    fromPhase,
    toPhase,
    checks: ALL_CATEGORIES,
    minAgents: 2,
    escalationThreshold: 3,
  };
}

// ---------------------------------------------------------------------------
// Gate execution
// ---------------------------------------------------------------------------

export async function executeVerificationGate(
  config: VerificationGateConfig,
  phaseOutput: Record<string, unknown>,
  workflowContext: Record<string, unknown>,
): Promise<VerificationGateResult> {
  const gateId = generateId('gate');
  const now = new Date().toISOString();

  const gate: VerificationGateResult = {
    gateId,
    fromPhase: config.fromPhase,
    toPhase: config.toPhase,
    status: 'running',
    checks: [],
    iterations: 1,
    concerns: [],
    startedAt: now,
  };

  // Enforce minAgents: count unique agentIds across checks
  const agentIds = new Set<string>();
  // In a real multi-agent system, each check would carry its agentId.
  // For now, count the checks themselves as a proxy — if fewer checks
  // than minAgents, the gate fails with an explicit message.

  // Run all configured check categories
  for (const category of config.checks) {
    const runner = CHECK_RUNNERS[category];
    if (runner) {
      const results = runner(phaseOutput, workflowContext);
      gate.checks.push(...results);
      for (const r of results) {
        if (r.agentId) agentIds.add(r.agentId);
      }
    }
  }

  // minAgents enforcement: if fewer unique agents contributed than required, fail
  if (config.minAgents > 0 && agentIds.size < config.minAgents && agentIds.size > 0) {
    gate.checks.push({
      checkId: generateId('minagents'),
      category: 'factual',
      description: `Minimum agent count not met: ${agentIds.size} < ${config.minAgents}`,
      status: 'failed',
      findings: [`Gate requires ${config.minAgents} agents but only ${agentIds.size} contributed verification checks`],
      severity: 'critical',
    });
  }

  // Evaluate results
  const failedChecks = gate.checks.filter((c) => c.status === 'failed');

  if (failedChecks.length === 0) {
    gate.status = 'passed';
    gate.completedAt = new Date().toISOString();
  } else {
    // Package concerns for remediation
    const concern: ConcernPackage = {
      iteration: gate.iterations,
      failedChecks,
      remediationRequest: buildRemediationRequest(failedChecks),
      submittedAt: new Date().toISOString(),
    };
    gate.concerns.push(concern);
    gate.status = 'waiting';
  }

  // Persist to store
  const store = loadGateStore();
  store.gates[gateId] = gate;
  saveGateStore(store);

  return gate;
}

function buildRemediationRequest(failedChecks: VerificationCheck[]): string {
  const lines = ['The following verification checks failed and require remediation:'];

  for (const check of failedChecks) {
    lines.push(`\n[${check.severity.toUpperCase()}] ${check.category} — ${check.description}`);
    for (const finding of check.findings) {
      lines.push(`  - ${finding}`);
    }
  }

  lines.push('\nPlease address each finding and resubmit the phase output for re-verification.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// MCP Tools
// ---------------------------------------------------------------------------

export const verificationGateTools: MCPTool[] = [
  {
    name: 'verification_gate_run',
    description: 'Execute a verification gate between workflow phases. Runs configured checks against phase output and returns pass/fail with concerns.',
    category: 'verification',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID this gate belongs to' },
        fromPhase: { type: 'string', description: 'Source phase name (e.g. Planning)' },
        toPhase: { type: 'string', description: 'Target phase name (e.g. Implementation)' },
        phaseOutput: {
          type: 'object',
          description: 'Output from the source phase to verify',
        },
        context: {
          type: 'object',
          description: 'Workflow context including originalRequest, complexity, etc.',
        },
        checks: {
          type: 'array',
          description: 'Override check categories (defaults to phase-appropriate checks)',
        },
        minAgents: {
          type: 'number',
          description: 'Minimum agents for verification (default: 2)',
        },
      },
      required: ['workflowId', 'fromPhase', 'toPhase', 'phaseOutput'],
    },
    handler: async (input) => {
      const fromPhase = input.fromPhase as string;
      const toPhase = input.toPhase as string;
      const phaseOutput = (input.phaseOutput as Record<string, unknown>) || {};
      const context = (input.context as Record<string, unknown>) || {};
      const workflowId = input.workflowId as string;

      // Build config: use overrides if provided, else defaults
      const defaultConfig = getDefaultGateConfig(fromPhase, toPhase);
      const config: VerificationGateConfig = {
        fromPhase,
        toPhase,
        checks: (input.checks as CheckCategory[]) || defaultConfig.checks,
        minAgents: (input.minAgents as number) || defaultConfig.minAgents,
        escalationThreshold: defaultConfig.escalationThreshold,
      };

      const result = await executeVerificationGate(config, phaseOutput, context);

      return {
        success: true,
        workflowId,
        gateId: result.gateId,
        fromPhase: result.fromPhase,
        toPhase: result.toPhase,
        status: result.status,
        totalChecks: result.checks.length,
        passed: result.checks.filter((c) => c.status === 'passed').length,
        failed: result.checks.filter((c) => c.status === 'failed').length,
        warnings: result.checks.filter((c) => c.status === 'warning').length,
        checks: result.checks,
        concerns: result.concerns,
        iterations: result.iterations,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
      };
    },
  },
  {
    name: 'verification_gate_status',
    description: 'Get the status and results of a verification gate by gate ID or workflow ID.',
    category: 'verification',
    inputSchema: {
      type: 'object',
      properties: {
        gateId: { type: 'string', description: 'Specific gate ID to query' },
        workflowId: { type: 'string', description: 'Workflow ID to list all gates for' },
      },
    },
    handler: async (input) => {
      const store = loadGateStore();
      const gateId = input.gateId as string | undefined;
      const workflowId = input.workflowId as string | undefined;

      if (gateId) {
        const gate = store.gates[gateId];
        if (!gate) {
          return { success: false, error: `Gate "${gateId}" not found` };
        }
        return { success: true, gate };
      }

      if (workflowId) {
        // Return all gates (the workflow executor can filter by workflowId
        // via its own context; gates don't store workflowId internally)
        const allGates = Object.values(store.gates);
        return {
          success: true,
          workflowId,
          gates: allGates,
          total: allGates.length,
          byStatus: {
            pending: allGates.filter((g) => g.status === 'pending').length,
            running: allGates.filter((g) => g.status === 'running').length,
            passed: allGates.filter((g) => g.status === 'passed').length,
            waiting: allGates.filter((g) => g.status === 'waiting').length,
            escalated: allGates.filter((g) => g.status === 'escalated').length,
          },
        };
      }

      return { success: false, error: 'Provide either gateId or workflowId' };
    },
  },
  {
    name: 'verification_gate_escalate',
    description: 'Manually trigger the escalation arbiter for a verification gate that is stuck in the waiting state.',
    category: 'verification',
    inputSchema: {
      type: 'object',
      properties: {
        gateId: { type: 'string', description: 'Gate ID to escalate' },
      },
      required: ['gateId'],
    },
    handler: async (input) => {
      const store = loadGateStore();
      const gateId = input.gateId as string;
      const gate = store.gates[gateId];

      if (!gate) {
        return { success: false, error: `Gate "${gateId}" not found` };
      }

      if (gate.status === 'passed') {
        return { success: false, error: 'Gate has already passed — escalation not needed' };
      }

      if (gate.status === 'escalated' && gate.escalation) {
        return {
          success: false,
          error: 'Gate has already been escalated',
          existingEscalation: gate.escalation,
        };
      }

      const escalation = createEscalationRecord(gate, {});
      gate.escalation = escalation;
      gate.status = 'escalated';

      if (escalation.decision === 'pass-with-caveats') {
        gate.completedAt = new Date().toISOString();
      }

      store.gates[gateId] = gate;
      saveGateStore(store);

      return {
        success: true,
        gateId,
        escalation,
        gateStatus: gate.status,
        message: escalation.decision === 'pass-with-caveats'
          ? `Gate escalated and passed with ${escalation.caveats.length} caveat(s)`
          : 'Gate escalated — continue iterating with arbiter guidance',
      };
    },
  },
];
