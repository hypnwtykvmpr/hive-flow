/**
 * Type definitions for Security Enforcement System
 */

export interface SecurityConfig {
  totalNodes: number;
  threshold: number;
  rateLimits: {
    perSecond: number;
    perMinute: number;
    perHour: number;
    perDay: number;
  };
  byzantineTolerance: {
    suspicionThreshold: number;
    consensusThreshold: number;
    heartbeatInterval: number;
  };
  cryptography: {
    keySize: number;
    algorithm: string;
    hashAlgorithm: string;
  };
}

export interface ThreatLevel {
  level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  score: number;
  indicators: string[];
  mitigationActions: string[];
}

export interface SecurityEvent {
  eventId: string;
  timestamp: Date;
  type: 'AUTHENTICATION' | 'AUTHORIZATION' | 'BYZANTINE' | 'RATE_LIMIT' | 'CRYPTOGRAPHIC';
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  agentId: string;
  details: any;
  resolved: boolean;
}

export interface ComplianceReport {
  reportId: string;
  generatedAt: Date;
  period: { from: Date; to: Date };
  totalTransactions: number;
  securityEvents: SecurityEvent[];
  auditTrailIntegrity: boolean;
  complianceScore: number;
  recommendations: string[];
}

export interface AttackPattern {
  patternId: string;
  name: string;
  description: string;
  indicators: string[];
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  mitigation: string[];
  frequency: number;
}

export interface AgentBehaviorProfile {
  agentId: string;
  profileCreated: Date;
  lastUpdated: Date;
  requestPatterns: {
    averageRequestsPerMinute: number;
    peakRequestTimes: Date[];
    requestTypes: Map<string, number>;
  };
  behaviorScore: number;
  anomalies: string[];
  trustLevel: number;
}

export interface ConsensusState {
  roundId: string;
  proposalId: string;
  participants: string[];
  votes: Map<string, boolean>;
  consensusReached: boolean;
  result: boolean | null;
  byzantineNodes: string[];
  timestamp: Date;
}

export interface ZKProofChallenge {
  challengeId: string;
  challenger: string;
  challenged: string;
  proofType: 'KNOWLEDGE' | 'RANGE' | 'MEMBERSHIP' | 'STATEMENT';
  challenge: string;
  timestamp: Date;
  expiresAt: Date;
}

export interface ThresholdSignatureState {
  signatureId: string;
  message: any;
  requiredSignatures: number;
  currentSignatures: number;
  signatories: string[];
  partialSignatures: Map<string, string>;
  completed: boolean;
  finalSignature?: string;
}

export interface RateLimitWindow {
  windowStart: Date;
  windowEnd: Date;
  requestCount: number;
  limit: number;
  violations: number;
}

export interface SecurityAlert {
  alertId: string;
  timestamp: Date;
  type: 'BREACH_ATTEMPT' | 'BYZANTINE_BEHAVIOR' | 'RATE_LIMIT_EXCEEDED' | 'AUTH_FAILURE' | 'SIGNATURE_INVALID';
  agentId: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  evidence: any;
  automaticResponse: string[];
  requiresManualIntervention: boolean;
}

export interface VerificationChain {
  chainId: string;
  startedBy: string;
  truthClaim: any;
  verificationSteps: Array<{
    stepId: string;
    verifiedBy: string;
    timestamp: Date;
    result: boolean;
    evidence: any[];
    signature: string;
  }>;
  finalResult: boolean;
  confidence: number;
  chainIntegrity: boolean;
}

export interface CryptographicEvidence {
  evidenceId: string;
  type: 'SIGNATURE' | 'HASH' | 'PROOF' | 'CERTIFICATE';
  data: string;
  algorithm: string;
  timestamp: Date;
  verifiable: boolean;
  relatedAgents: string[];
}

export interface SecureCommunicationChannel {
  channelId: string;
  participants: string[];
  encryptionKey: string;
  established: Date;
  lastActivity: Date;
  messageCount: number;
  integrityVerified: boolean;
}

export interface FraudDetectionResult {
  scanId: string;
  timestamp: Date;
  agentId: string;
  suspiciousActivities: Array<{
    activity: string;
    riskScore: number;
    indicators: string[];
  }>;
  overallRiskScore: number;
  recommendedActions: string[];
  escalationRequired: boolean;
}

export interface BackupSecurityState {
  backupId: string;
  timestamp: Date;
  securityHash: string;
  agentStates: Map<string, any>;
  auditTrail: any[];
  cryptographicKeys: Map<string, string>;
  configurationSnapshot: any;
  integrityProof: string;
}

export interface SecurityPolicy {
  policyId: string;
  name: string;
  description: string;
  enforcementLevel: 'ADVISORY' | 'MANDATORY' | 'CRITICAL';
  rules: Array<{
    ruleId: string;
    condition: string;
    action: string;
    parameters: any;
  }>;
  applicableAgents: string[];
  createdAt: Date;
  lastModified: Date;
  active: boolean;
}

// Utility types for enhanced type safety
export type SecurityOperation = 
  | 'REGISTER_AGENT'
  | 'AUTHENTICATE_AGENT'
  | 'VERIFY_TRUTH_CLAIM'
  | 'SIGN_RESULT'
  | 'AUDIT_TRAIL'
  | 'RATE_LIMIT_CHECK'
  | 'BYZANTINE_DETECTION'
  | 'CONSENSUS_PARTICIPATION'
  | 'EMERGENCY_SHUTDOWN'
  | 'BACKUP_CREATION'
  | 'RESTORE_STATE';

export type ThreatVector = 
  | 'SYBIL_ATTACK'
  | 'BYZANTINE_ATTACK'
  | 'ECLIPSE_ATTACK'
  | 'DOS_ATTACK'
  | 'REPLAY_ATTACK'
  | 'MAN_IN_MIDDLE'
  | 'SIGNATURE_FORGERY'
  | 'COLLUSION_ATTACK'
  | 'TIMING_ATTACK'
  | 'SOCIAL_ENGINEERING';

export type CryptographicPrimitive = 
  | 'RSA_SIGNATURE'
  | 'ECDSA_SIGNATURE'
  | 'THRESHOLD_SIGNATURE'
  | 'ZERO_KNOWLEDGE_PROOF'
  | 'HASH_FUNCTION'
  | 'SYMMETRIC_ENCRYPTION'
  | 'ASYMMETRIC_ENCRYPTION'
  | 'MERKLE_TREE'
  | 'COMMITMENT_SCHEME'
  | 'SECRET_SHARING';

export type AuditEventType = 
  | 'SYSTEM_START'
  | 'SYSTEM_SHUTDOWN'
  | 'AGENT_REGISTRATION'
  | 'AGENT_DEREGISTRATION'
  | 'VERIFICATION_REQUEST'
  | 'VERIFICATION_RESULT'
  | 'SIGNATURE_CREATION'
  | 'SIGNATURE_VERIFICATION'
  | 'CONSENSUS_ROUND'
  | 'THREAT_DETECTED'
  | 'POLICY_VIOLATION'
  | 'EMERGENCY_ACTION';

// Generic interfaces for extensibility
export interface SecurityExtension<T = any> {
  name: string;
  version: string;
  initialize(): Promise<void>;
  process(input: T): Promise<any>;
  cleanup(): Promise<void>;
}

export interface SecurityMiddleware {
  name: string;
  priority: number;
  beforeVerification?(request: any): Promise<void>;
  afterVerification?(result: any): Promise<void>;
  onError?(error: Error): Promise<void>;
}

export interface SecurityMetricsCollector {
  collect(): Promise<Map<string, number>>;
  reset(): Promise<void>;
  export(format: 'json' | 'csv' | 'prometheus'): Promise<string>;
}

// Constants for security configuration
export const SECURITY_CONSTANTS = {
  DEFAULT_KEY_SIZE: 4096,
  DEFAULT_HASH_ALGORITHM: 'sha256',
  DEFAULT_SIGNATURE_ALGORITHM: 'rsa',
  DEFAULT_ENCRYPTION_ALGORITHM: 'aes-256-gcm',
  MINIMUM_CONSENSUS_THRESHOLD: 0.67,
  MAXIMUM_BYZANTINE_TOLERANCE: 0.33,
  DEFAULT_RATE_LIMITS: {
    perSecond: 10,
    perMinute: 100,
    perHour: 1000,
    perDay: 10000
  },
  REPUTATION_THRESHOLDS: {
    MINIMUM_FOR_VERIFICATION: 50,
    MINIMUM_FOR_CONSENSUS: 70,
    MAXIMUM_REPUTATION: 100,
    MINIMUM_REPUTATION: 0
  },
  AUDIT_RETENTION: {
    DAYS: 365,
    MAX_ENTRIES: 1000000
  }
} as const;

// Error types for better error handling
export class SecurityError extends Error {
  constructor(
    message: string,
    public code: string,
    public agentId?: string,
    public details?: any
  ) {
    super(message);
    this.name = 'SecurityError';
  }
}

export class AuthenticationError extends SecurityError {
  constructor(message: string, agentId?: string, details?: any) {
    super(message, 'AUTH_ERROR', agentId, details);
    this.name = 'AuthenticationError';
  }
}

export class ByzantineError extends SecurityError {
  constructor(message: string, agentId: string, details?: any) {
    super(message, 'BYZANTINE_ERROR', agentId, details);
    this.name = 'ByzantineError';
  }
}

export class CryptographicError extends SecurityError {
  constructor(message: string, details?: any) {
    super(message, 'CRYPTO_ERROR', undefined, details);
    this.name = 'CryptographicError';
  }
}

export class RateLimitError extends SecurityError {
  constructor(message: string, agentId: string, retryAfter?: number) {
    super(message, 'RATE_LIMIT_ERROR', agentId, { retryAfter });
    this.name = 'RateLimitError';
  }
}