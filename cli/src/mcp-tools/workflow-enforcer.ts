/**
 * Workflow Enforcer MCP Tools
 *
 * Complexity-proportional workflow enforcement system. Assesses task complexity
 * and forces proportional use of planning subflows, verification gates,
 * ambiguity filters, and dual-agent audits. Simple tasks get the fast path;
 * complex tasks are channeled through the full verified workflow.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MCPTool } from './types.js';
import type { AgentProvider } from './agent-tools.js';

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const STORAGE_DIR = '.hive-flow';
const ENFORCEMENT_DIR = 'enforcement';
const STATE_FILE = 'current.json';
const AUDIT_FILE = 'audit.jsonl';

function getEnforcementDir(): string {
  return join(process.cwd(), STORAGE_DIR, ENFORCEMENT_DIR);
}

function getStatePath(): string {
  return join(getEnforcementDir(), STATE_FILE);
}

function getAuditPath(): string {
  return join(getEnforcementDir(), AUDIT_FILE);
}

function ensureEnforcementDir(): void {
  const dir = getEnforcementDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComplexityLevel = 'SIMPLE' | 'MODERATE' | 'COMPLEX';

export interface ComplexitySignal {
  category: 'file-count' | 'keyword' | 'multi-module' | 'security' | 'scope';
  description: string;
  points: number;
}

export type AgentModelTier = 'opus' | 'sonnet' | 'mini' | 'inherit';

export interface FlowComponentConfig {
  enabled: boolean;
  agentCount: number;
  modelPreference: AgentModelTier;
  providerPreference?: AgentProvider;
  variant: 'lightweight' | 'standard' | 'advanced' | 'full';
}

export interface PlanningSubflowConfig extends FlowComponentConfig {
  /** Whether agents may silently opt out. Never surfaced to agents. */
  optOutAllowed: boolean;
}

export interface VerificationGatesConfig extends FlowComponentConfig {
  categories: string[];
}

export interface AmbiguityFilterConfig extends FlowComponentConfig {
  /** Extra agents for codebase semantic/continuity exploration (COMPLEX only) */
  explorationAgents: number;
  /** Deep analysis agent for additional context on interpretations */
  deepAnalysis: boolean;
}

export interface DualAgentAuditConfig extends FlowComponentConfig {
  /** Use hive-mind configuration for multi-agent audit (COMPLEX only) */
  hiveMind: boolean;
}

export interface RequiredFlow {
  planningSubflow: PlanningSubflowConfig;
  verificationGates: VerificationGatesConfig;
  ambiguityFilter: AmbiguityFilterConfig;
  dualAgentAudit: DualAgentAuditConfig;
  postTaskVerification: FlowComponentConfig;
}

export interface ComplexityAssessment {
  score: number;
  level: ComplexityLevel;
  signals: ComplexitySignal[];
  requiredFlow: RequiredFlow;
  dismissalAllowed: boolean;
  assessedAt: string;
}

export interface EnforcementOverride {
  type: 'emergency' | 'reclassify';
  reason: string;
  overriddenBy: string;
  originalLevel: ComplexityLevel;
  effectiveLevel: ComplexityLevel;
  timestamp: string;
}

export interface EnforcementState {
  assessment: ComplexityAssessment;
  planRequired: boolean;
  planCreated: boolean;
  moderatePlanOptOut?: boolean;
  moderatePlanOptOutAt?: string;
  override?: EnforcementOverride;
  sessionHighScore: number;
  authorized: boolean;
  planApproved: boolean;
}

export interface EnforcementAuditEntry {
  timestamp: string;
  event: 'assessment' | 'override' | 'gate-pass' | 'gate-fail' | 'plan-required' | 'plan-created' | 'dismissal';
  taskDescription: string;
  score: number;
  level: ComplexityLevel;
  override?: EnforcementOverride;
  gateResult?: { gateId: string; status: string; failedChecks: number };
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIGH_KEYWORDS = [
  'refactor', 'migrate', 'architecture', 'security', 'auth',
  'performance', 'optimize', 'database schema', 'breaking change',
];
const MEDIUM_KEYWORDS = [
  'api', 'test', 'integration', 'deploy', 'multi-file', 'cross-module',
];
const LOW_KEYWORDS = [
  'fix typo', 'update config', 'bump version', 'rename',
  'comment', 'formatting', 'lint', 'doc update',
];
const SECURITY_KEYWORDS = [
  'secret', 'credential', 'token', 'password', 'auth',
  'permission', 'encryption', 'cve', 'vulnerability',
  'injection', 'traversal',
];
const MONOREPO_PACKAGES = [
  '@hive-flow/cli', '@hive-flow/cli/hooks', '@hive-flow/cli/memory',
  '@hive-flow/cli/security', '@hive-flow/cli/guidance', '../shared/index.js',
  '@hive-flow/cli/codex', '@hive-flow/providers',
];

const FILE_PATH_REGEX = /[\w/.-]+\.\w{1,4}/g;

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

function scoreFileCount(
  taskDescription: string,
  filesAffected?: string[],
): { points: number; signals: ComplexitySignal[] } {
  const signals: ComplexitySignal[] = [];
  const parsed = taskDescription.match(FILE_PATH_REGEX) || [];
  const allFiles = new Set([...parsed, ...(filesAffected || [])]);
  const count = allFiles.size;

  let points = 0;
  if (count >= 7) points = 30;
  else if (count >= 4) points = 20;
  else if (count >= 2) points = 10;

  if (points > 0) {
    signals.push({
      category: 'file-count',
      description: `${count} file(s) detected`,
      points,
    });
  }
  return { points, signals };
}

function scoreKeywords(taskDescription: string): { points: number; signals: ComplexitySignal[] } {
  const signals: ComplexitySignal[] = [];
  const lower = taskDescription.toLowerCase();

  let highTotal = 0;
  for (const kw of HIGH_KEYWORDS) {
    if (lower.includes(kw)) {
      const pts = Math.min(10, 30 - highTotal);
      if (pts <= 0) break;
      highTotal += pts;
      signals.push({ category: 'keyword', description: `High keyword: "${kw}"`, points: pts });
    }
  }

  let medTotal = 0;
  for (const kw of MEDIUM_KEYWORDS) {
    if (lower.includes(kw)) {
      const pts = Math.min(5, 15 - medTotal);
      if (pts <= 0) break;
      medTotal += pts;
      signals.push({ category: 'keyword', description: `Medium keyword: "${kw}"`, points: pts });
    }
  }

  for (const kw of LOW_KEYWORDS) {
    if (lower.includes(kw)) {
      signals.push({ category: 'keyword', description: `Low keyword: "${kw}" (no score impact)`, points: 0 });
    }
  }

  const total = Math.min(highTotal + medTotal, 35);
  return { points: total, signals };
}

function scoreMultiModule(taskDescription: string): { points: number; signals: ComplexitySignal[] } {
  const signals: ComplexitySignal[] = [];
  const lower = taskDescription.toLowerCase();

  const mentioned = MONOREPO_PACKAGES.filter(pkg => lower.includes(pkg.toLowerCase()));
  if (mentioned.length >= 2) {
    signals.push({
      category: 'multi-module',
      description: `${mentioned.length} monorepo packages: ${mentioned.join(', ')}`,
      points: 15,
    });
    return { points: 15, signals };
  }

  // Cross-cutting heuristic: mentions src + tests in different modules
  if (
    (lower.includes('src/') && lower.includes('test')) ||
    (lower.includes('cross-cutting') || lower.includes('cross-module'))
  ) {
    signals.push({
      category: 'multi-module',
      description: 'Cross-cutting change detected',
      points: 10,
    });
    return { points: 10, signals };
  }

  return { points: 0, signals };
}

function scoreSecurity(taskDescription: string): { points: number; signals: ComplexitySignal[] } {
  const signals: ComplexitySignal[] = [];
  const lower = taskDescription.toLowerCase();

  for (const kw of SECURITY_KEYWORDS) {
    if (lower.includes(kw)) {
      signals.push({
        category: 'security',
        description: `Security keyword: "${kw}"`,
        points: 20,
      });
      return { points: 20, signals };
    }
  }
  return { points: 0, signals };
}

// ---------------------------------------------------------------------------
// Flow mapping
// ---------------------------------------------------------------------------

export function mapLevelToFlow(level: ComplexityLevel): RequiredFlow {
  switch (level) {
    case 'SIMPLE':
      return {
        planningSubflow: { enabled: false, agentCount: 0, modelPreference: 'sonnet', variant: 'lightweight', optOutAllowed: false },
        verificationGates: { enabled: false, agentCount: 0, modelPreference: 'sonnet', variant: 'lightweight', categories: [] },
        ambiguityFilter: { enabled: true, agentCount: 1, modelPreference: 'opus', providerPreference: 'gemini-cli', variant: 'lightweight', explorationAgents: 0, deepAnalysis: false },
        dualAgentAudit: { enabled: true, agentCount: 1, modelPreference: 'opus', providerPreference: 'codex-cli', variant: 'lightweight', hiveMind: false },
        postTaskVerification: { enabled: true, agentCount: 1, modelPreference: 'sonnet', providerPreference: 'gemini-cli', variant: 'lightweight' },
      };
    case 'MODERATE':
      return {
        planningSubflow: { enabled: true, agentCount: 1, modelPreference: 'sonnet', providerPreference: 'gemini-cli', variant: 'standard', optOutAllowed: true },
        verificationGates: { enabled: true, agentCount: 1, modelPreference: 'opus', providerPreference: 'gemini-cli', variant: 'standard', categories: ['syntax', 'semantic', 'security'] },
        ambiguityFilter: { enabled: true, agentCount: 1, modelPreference: 'opus', providerPreference: 'codex-cli', variant: 'standard', explorationAgents: 0, deepAnalysis: false },
        dualAgentAudit: { enabled: true, agentCount: 2, modelPreference: 'opus', providerPreference: 'gemini-cli', variant: 'standard', hiveMind: false },
        postTaskVerification: { enabled: true, agentCount: 1, modelPreference: 'sonnet', providerPreference: 'codex-cli', variant: 'standard' },
      };
    case 'COMPLEX':
      return {
        planningSubflow: { enabled: true, agentCount: 2, modelPreference: 'opus', providerPreference: 'gemini-cli', variant: 'full', optOutAllowed: false },
        verificationGates: { enabled: true, agentCount: 2, modelPreference: 'opus', providerPreference: 'gemini-cli', variant: 'full', categories: ['factual', 'syntax', 'semantic', 'blindspot', 'error-omission', 'alternative', 'edge-case', 'security'] },
        ambiguityFilter: { enabled: true, agentCount: 2, modelPreference: 'opus', providerPreference: 'codex-cli', variant: 'advanced', explorationAgents: 2, deepAnalysis: true },
        dualAgentAudit: { enabled: true, agentCount: 5, modelPreference: 'opus', providerPreference: 'openrouter', variant: 'full', hiveMind: true },
        postTaskVerification: { enabled: true, agentCount: 2, modelPreference: 'opus', providerPreference: 'cursor-cli', variant: 'full' },
      };
  }
}

function scoreToLevel(score: number): ComplexityLevel {
  if (score <= 25) return 'SIMPLE';
  if (score <= 60) return 'MODERATE';
  return 'COMPLEX';
}

// ---------------------------------------------------------------------------
// Core assessment
// ---------------------------------------------------------------------------

export function assessComplexity(
  taskDescription: string,
  context?: {
    filesAffected?: string[];
    currentPhase?: string;
    priorAssessment?: ComplexityAssessment;
  },
): ComplexityAssessment {
  const allSignals: ComplexitySignal[] = [];

  const fileResult = scoreFileCount(taskDescription, context?.filesAffected);
  const keywordResult = scoreKeywords(taskDescription);
  const multiModuleResult = scoreMultiModule(taskDescription);
  const securityResult = scoreSecurity(taskDescription);

  allSignals.push(...fileResult.signals);
  allSignals.push(...keywordResult.signals);
  allSignals.push(...multiModuleResult.signals);
  allSignals.push(...securityResult.signals);

  // Re-request detection: flag in signals for audit trail visibility
  const reRequestPatterns = [
    /should\s+i\s+(continue|proceed)/i,
    /would\s+you\s+like\s+me\s+to/i,
    /shall\s+i\s+proceed/i,
    /permission\s+to\s+(proceed|continue)/i,
  ];
  for (const re of reRequestPatterns) {
    if (re.test(taskDescription)) {
      allSignals.push({ category: 'scope' as ComplexitySignal['category'], description: 'Re-request pattern detected — task may be requesting already-authorized permission', points: 0 });
      break;
    }
  }

  const rawScore =
    fileResult.points +
    keywordResult.points +
    multiModuleResult.points +
    securityResult.points;

  // Clamp to 0-100
  let score = Math.max(0, Math.min(100, rawScore));

  // Re-assessment: use max of prior and current (never auto-downgrade)
  if (context?.priorAssessment) {
    score = Math.max(score, context.priorAssessment.score);
  }

  const level = scoreToLevel(score);
  const requiredFlow = mapLevelToFlow(level);

  return {
    score,
    level,
    signals: allSignals,
    requiredFlow,
    dismissalAllowed: level === 'SIMPLE',
    assessedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// HMAC helpers (mirrors enforcement.cjs scheme)
// ---------------------------------------------------------------------------

function getHmacKeyPath(): string {
  return join(getEnforcementDir(), '.hmac-key');
}

export function getOrCreateHmacKey(): string {
  const keyPath = getHmacKeyPath();
  if (existsSync(keyPath)) {
    return readFileSync(keyPath, 'utf-8').trim();
  }
  // Generate a new key if none exists
  ensureEnforcementDir();
  const key = randomBytes(32).toString('hex');
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

export function signPayload(payload: unknown, key: string): string {
  return createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex');
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

export function loadEnforcementState(): EnforcementState | null {
  try {
    const path = getStatePath();
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));

      // Handle HMAC-signed envelope { payload, signature }
      let state: EnforcementState;
      if (raw?.payload !== undefined && typeof raw?.signature === 'string') {
        // A5: Verify HMAC signature before trusting payload
        const key = getOrCreateHmacKey();
        const expected = signPayload(raw.payload, key);
        const expectedBuf = Buffer.from(expected, 'hex');
        const actualBuf = Buffer.from(String(raw.signature), 'hex');
        if (expectedBuf.length !== actualBuf.length) return null; // Tampered — reject
        if (!timingSafeEqual(expectedBuf, actualBuf)) return null; // Tampered — reject
        state = raw.payload as EnforcementState;
      } else {
        // A5: Reject unsigned state — no legacy migration path (fail-closed)
        return null;
      }

      // Migrate old boolean RequiredFlow to new shape
      if (state?.assessment?.requiredFlow) {
        const flow = state.assessment.requiredFlow;
        if (typeof (flow as unknown as Record<string, unknown>).planningSubflow === 'boolean' ||
            typeof (flow as unknown as Record<string, unknown>).ambiguityFilter === 'boolean') {
          state.assessment.requiredFlow = mapLevelToFlow(state.assessment.level);
        }
      }
      // Migrate: add authorized/planApproved if missing
      if (state && state.authorized === undefined) {
        state.authorized = state.planCreated || false;
      }
      if (state && state.planApproved === undefined) {
        state.planApproved = state.planCreated || false;
      }
      return state;
    }
  } catch { /* Return null on error */ }
  return null;
}

export function saveEnforcementState(state: EnforcementState): void {
  // Auto-derive authorization from plan state
  state.authorized = state.planCreated || state.authorized || false;
  state.planApproved = state.planCreated || state.planApproved || false;
  ensureEnforcementDir();
  // Write HMAC-signed envelope { payload, signature } matching enforcement.cjs scheme
  const key = getOrCreateHmacKey();
  const envelope = { payload: state, signature: signPayload(state, key) };
  // Atomic write — tmp+rename to prevent partial writes on crash (matches enforcement.cjs writeJsonAtomic)
  const statePath = getStatePath();
  const tmpPath = `${statePath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), 'utf-8');
    renameSync(tmpPath, statePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

export function appendAuditEntry(entry: EnforcementAuditEntry): void {
  ensureEnforcementDir();
  appendFileSync(getAuditPath(), JSON.stringify(entry) + '\n', 'utf-8');
}

export function loadAuditEntries(limit?: number): EnforcementAuditEntry[] {
  try {
    const path = getAuditPath();
    if (!existsSync(path)) return [];
    const data = readFileSync(path, 'utf-8');
    const lines = data.trim().split('\n').filter(Boolean);
    const entries = lines.map(line => JSON.parse(line) as EnforcementAuditEntry);
    if (limit && limit > 0) return entries.slice(-limit);
    return entries;
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Override validation
// ---------------------------------------------------------------------------

export function validateOverride(
  current: EnforcementState,
  effectiveLevel: ComplexityLevel,
  reason: string,
): { valid: boolean; error?: string } {
  if (!reason || reason.trim().length === 0) {
    return { valid: false, error: 'Override reason is required' };
  }

  // Cannot override to a higher level (that requires re-assessment)
  const levelOrder: Record<ComplexityLevel, number> = { SIMPLE: 0, MODERATE: 1, COMPLEX: 2 };
  if (levelOrder[effectiveLevel] >= levelOrder[current.assessment.level]) {
    return { valid: false, error: `Cannot override to same or higher level (current: ${current.assessment.level}, requested: ${effectiveLevel}). Use re-assessment instead.` };
  }

  // Security floor: cannot override security-flagged tasks below MODERATE
  const hasSecuritySignal = current.assessment.signals.some(s => s.category === 'security');
  if (hasSecuritySignal && effectiveLevel === 'SIMPLE') {
    return { valid: false, error: 'Cannot override security-flagged task below MODERATE' };
  }

  return { valid: true };
}

export function validateOptOut(state: EnforcementState): { allowed: boolean; reason: string } {
  if (!state.assessment) return { allowed: false, reason: 'No assessment' };
  if (state.assessment.level === 'COMPLEX') return { allowed: false, reason: 'COMPLEX tasks cannot opt out of planning' };
  if (state.assessment.level !== 'MODERATE') return { allowed: false, reason: 'Opt-out only applies to MODERATE tasks' };
  return { allowed: true, reason: 'MODERATE opt-out permitted' };
}

// ---------------------------------------------------------------------------
// MCP Tools
// ---------------------------------------------------------------------------

const assessTool: MCPTool = {
  name: 'workflow_enforcer_assess',
  description: 'Assess task complexity and determine required workflow enforcement level',
  inputSchema: {
    type: 'object',
    properties: {
      taskDescription: { type: 'string', description: 'Description of the task to assess' },
      filesAffected: {
        type: 'array',
        description: 'List of files affected by the task',
      },
      currentPhase: { type: 'string', description: 'Current workflow phase' },
    },
    required: ['taskDescription'],
  },
  category: 'workflow',
  tags: ['enforcement', 'complexity', 'workflow'],
  handler: async (input) => {
    const taskDescription = input.taskDescription as string;
    const filesAffected = input.filesAffected as string[] | undefined;
    const currentPhase = input.currentPhase as string | undefined;

    // Load prior state for re-assessment
    const priorState = loadEnforcementState();
    const priorAssessment = priorState?.assessment;

    const assessment = assessComplexity(taskDescription, {
      filesAffected,
      currentPhase,
      priorAssessment,
    });

    const state: EnforcementState = {
      assessment,
      planRequired: assessment.level === 'COMPLEX' || assessment.level === 'MODERATE',
      planCreated: priorState?.planCreated ?? false,
      override: priorState?.override,
      sessionHighScore: Math.max(assessment.score, priorState?.sessionHighScore ?? 0),
      authorized: priorState?.authorized ?? false,
      planApproved: priorState?.planApproved ?? false,
    };

    saveEnforcementState(state);

    appendAuditEntry({
      timestamp: new Date().toISOString(),
      event: 'assessment',
      taskDescription,
      score: assessment.score,
      level: assessment.level,
    });

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(assessment, null, 2) }],
    };
  },
};

const overrideTool: MCPTool = {
  name: 'workflow_enforcer_override',
  description: 'Override the current enforcement level (audited, with security floor)',
  inputSchema: {
    type: 'object',
    properties: {
      effectiveLevel: {
        type: 'string',
        enum: ['SIMPLE', 'MODERATE'],
        description: 'Target enforcement level',
      },
      reason: { type: 'string', description: 'Mandatory reason for override' },
      overrideType: {
        type: 'string',
        enum: ['emergency', 'reclassify'],
        description: 'Type of override',
      },
      overriddenBy: { type: 'string', description: 'Agent or user performing override' },
    },
    required: ['effectiveLevel', 'reason'],
  },
  category: 'workflow',
  tags: ['enforcement', 'override'],
  handler: async (input) => {
    const effectiveLevel = input.effectiveLevel as ComplexityLevel;
    const reason = input.reason as string;
    const overrideType = (input.overrideType as 'emergency' | 'reclassify') || 'reclassify';
    const overriddenBy = (input.overriddenBy as string) || 'unknown';

    const current = loadEnforcementState();
    if (!current) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'No enforcement state found. Run assessment first.' }) }],
        isError: true,
      };
    }

    const validation = validateOverride(current, effectiveLevel, reason);
    if (!validation.valid) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: validation.error }) }],
        isError: true,
      };
    }

    const override: EnforcementOverride = {
      type: overrideType,
      reason,
      overriddenBy,
      originalLevel: current.assessment.level,
      effectiveLevel,
      timestamp: new Date().toISOString(),
    };

    // Update assessment level and flow
    current.override = override;
    current.assessment.level = effectiveLevel;
    current.assessment.requiredFlow = mapLevelToFlow(effectiveLevel);
    current.assessment.dismissalAllowed = effectiveLevel === 'SIMPLE';
    current.planRequired = effectiveLevel === 'COMPLEX' || effectiveLevel === 'MODERATE';

    saveEnforcementState(current);

    appendAuditEntry({
      timestamp: new Date().toISOString(),
      event: 'override',
      taskDescription: 'Override applied',
      score: current.assessment.score,
      level: effectiveLevel,
      override,
    });

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true, override, effectiveFlow: current.assessment.requiredFlow }, null, 2) }],
    };
  },
};

const statusTool: MCPTool = {
  name: 'workflow_enforcer_status',
  description: 'Return current enforcement state and optional recent audit entries',
  inputSchema: {
    type: 'object',
    properties: {
      includeAudit: { type: 'boolean', description: 'Include recent audit entries' },
      auditLimit: { type: 'number', description: 'Number of recent audit entries to include (default 10)' },
    },
  },
  category: 'workflow',
  tags: ['enforcement', 'status'],
  handler: async (input) => {
    const includeAudit = input.includeAudit as boolean | undefined;
    const auditLimit = (input.auditLimit as number) || 10;

    const state = loadEnforcementState();
    const result: Record<string, unknown> = {
      hasState: !!state,
      state: state || null,
    };

    if (includeAudit) {
      result.recentAudit = loadAuditEntries(auditLimit);
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const workflowEnforcerTools: MCPTool[] = [assessTool, overrideTool, statusTool];
