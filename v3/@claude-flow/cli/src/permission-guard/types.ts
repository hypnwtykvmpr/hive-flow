/**
 * Permission Guard Types
 *
 * TypeScript type definitions for the Permission Guard system.
 * Ported from Python permission_gate.py / jury_verdict.py / vote_learner.py.
 */

// ---------------------------------------------------------------------------
// Decision & Verdict enums
// ---------------------------------------------------------------------------

export type PermissionDecision = 'allow' | 'deny' | 'escalate';

export type JuryVerdict = 'APPROVED' | 'DENIED' | 'TIMEOUT' | 'TIMEOUT_ALLOW' | 'TIMEOUT_DENY' | 'USER_APPROVED' | 'USER_DENIED';

// ---------------------------------------------------------------------------
// Risk classification types
// ---------------------------------------------------------------------------

export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

export interface DeepInspectResult {
  blocked: boolean;
  escalate: boolean;
  reason: string;
  technique: string;
  extractedCommands: string[];
  riskLevel: RiskLevel;
  depth: number;
}

export interface EvalResult {
  vote: 'allow' | 'deny';
  reason: string;
  confidence: number;
  riskLevel?: RiskLevel;
  warnings?: string[];
  ruleIds?: string[];
}

export interface JuryContext {
  toolName: string;
  toolInput: Record<string, string>;
  cwd: string;
  filePath?: string;
  agentRole?: string;
  recentTools?: string[];
  requestSource?: {
    type: 'single-agent' | 'hive-mind';
    consensusLevel?: 'unanimous' | 'majority' | 'split';
    agentCount?: number;
    sharedContext?: string;
  };
}

export interface RiskClassification {
  level: RiskLevel;
  category: string;
  timeoutBehavior: 'allow' | 'deny';
}

export interface InlineJuryResult {
  verdict: JuryVerdict;
  votes: Record<string, JuryVote | null>;
  reason: string;
}

export interface SignedPatternStore {
  version: 1;
  patterns: LearnedPatternStore;
  hmac: string;
}

// ---------------------------------------------------------------------------
// Gate types
// ---------------------------------------------------------------------------

export interface GateResult {
  decision: PermissionDecision;
  reason?: string;
  additionalContext?: string;
}

export interface HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd?: string;
  session_id?: string;
  transcript_path?: string;
}

export interface HookOutput {
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
    decision?: {
      behavior: string;
      message?: string;
    };
  };
  systemMessage?: string;
}

export interface EscalationContext {
  ts: string;
  escalation_id: string;
  status: 'jury_active' | 'resolved';
  tool_name: string;
  tool_input_summary: Record<string, string>;
  cwd: string;
  gate_reason: string;
  agent_description: string;
  file_path: string;
}

// ---------------------------------------------------------------------------
// Jury types
// ---------------------------------------------------------------------------

export interface JuryVote {
  ts: string;
  vote: 'allow' | 'deny';
  reason: string;
  escalation_id?: string;
}

export interface VerdictFile {
  ts: string;
  verdict: JuryVerdict;
  message: string;
  consumed: boolean;
}

export interface UserOverride {
  ts: string;
  decision: 'allow' | 'deny';
  reason?: string;
}

// ---------------------------------------------------------------------------
// Vote Learner types
// ---------------------------------------------------------------------------

export interface LearnedPattern {
  pattern: string;
  tool: string;
  approvals: number;
  last_seen: number;
}

export type LearnedPatternStore = Record<string, LearnedPattern>;

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

export interface DenyPatternEntry {
  pattern: string;
  feedback: string;
}

export type BashPatternEntry = string | DenyPatternEntry | { _comment: string };

export interface NotificationConfig {
  enabled: boolean;
  on_escalation: boolean;
  on_deny: boolean;
}

export interface PermissionConfig {
  always_allow_tools: string[];
  always_allow_tool_prefixes: string[];
  mcp_default_policy: 'allow' | 'deny' | 'escalate';
  mcp_deny_tool_prefixes: string[];
  mcp_escalate_tool_prefixes: string[];
  always_allow_bash_patterns: BashPatternEntry[];
  always_deny_bash_patterns: BashPatternEntry[];
  jury_escalation_bash_patterns: BashPatternEntry[];
  allowed_write_paths: string[];
  allow_paths_outside_working_directory: boolean;
  log_file: string;
  notifications: NotificationConfig;
}

// ---------------------------------------------------------------------------
// Audit log types
// ---------------------------------------------------------------------------

export interface AuditLogEntry {
  ts: string;
  tool: string;
  input_summary: string;
  decision: string;
  layer: string;
  reason: string;
  scale_position?: 'definite-deny' | 'judged-deny' | 'uncertainty' | 'judged-approve' | 'definite-allow';
  matched_pattern?: string;
  risk_level?: RiskLevel;
  jury_votes?: {
    goal: { vote: string; confidence: number; model: string } | null;
    safety: { vote: string; confidence: number; model: string } | null;
    convention: { vote: string; confidence: number; model: string } | null;
  };
  feedback_given?: string;
  session_id?: string;
  sequence_id?: number;
  juror_latency_ms?: number;
}

// ---------------------------------------------------------------------------
// LLM Jury types
// ---------------------------------------------------------------------------

export interface LLMJurorVote {
  role: 'goal' | 'safety' | 'convention';
  vote: 'allow' | 'deny';
  confidence: number;
  reason: string;
  model: string;
  latencyMs: number;
}

export interface LLMJuryResult {
  verdict: JuryVerdict;
  votes: LLMJurorVote[];
  reason: string;
  totalLatencyMs: number;
}
