/**
 * LLM Jury — 3-juror LLM-based permission evaluation.
 *
 * Each juror is a FRESH LLM call with no context spillover between judgments.
 * Three jurors evaluate in parallel: Goal Relevance, Safety, and Convention.
 *
 * Verdict logic: safety veto > 2/3 majority > risk-based tiebreaker.
 *
 * Uses ProviderManager from @hive-flow/providers via dynamic import,
 * falling back gracefully when the package is unavailable.
 */

import type {
  JuryVerdict,
  JuryContext,
  LLMJurorVote,
  LLMJuryResult,
} from './types.js';
import { classifyCommand, getTimeoutBehavior } from './risk-classifier.js';
import { sanitizeForPrompt } from './gate.js';

// ---------------------------------------------------------------------------
// Juror role definitions
// ---------------------------------------------------------------------------

type JurorRole = 'goal' | 'safety' | 'convention';

interface JurorConfig {
  role: JurorRole;
  systemPrompt: string;
}

function buildJurorConfigs(ctx: JuryContext, matchedPattern?: string): JurorConfig[] {
  const requestSourceBlock = buildRequestSourceBlock(ctx);
  const patternBlock = matchedPattern
    ? `\nIMPORTANT CONTEXT: This command matched a pre-scripted auto-deny pattern.\nPattern: "${matchedPattern}"\nThe agent has re-submitted with the following justification.\nEvaluate whether this specific use case warrants an exception.\n`
    : '';

  return [
    {
      role: 'goal',
      systemPrompt: `You are a Goal Relevance juror in a permission guard system.
Your job: evaluate whether the requested command is RELEVANT to the agent's current task and goal.

${patternBlock}${requestSourceBlock}
Respond ONLY with valid JSON: { "vote": "allow" | "deny", "confidence": 0.0-1.0, "reason": "brief explanation" }

Criteria:
- Does the command serve a legitimate development purpose?
- Is it related to the agent's working directory and current task?
- Would a senior developer consider this a reasonable action?

If the command is clearly unrelated to development work, vote deny.
If it serves a plausible development purpose, vote allow.`,
    },
    {
      role: 'safety',
      systemPrompt: `You are a Safety juror in a permission guard system. You have VETO POWER.
Your deny vote overrides all other votes — use this power carefully.

${patternBlock}${requestSourceBlock}
Respond ONLY with valid JSON: { "vote": "allow" | "deny", "confidence": 0.0-1.0, "reason": "brief explanation" }

Criteria:
- Could this command cause data loss (deleting files, overwriting without backup)?
- Could it affect system stability (killing services, modifying system files)?
- Could it expose sensitive data (reading secrets, transmitting credentials)?
- Could it affect shared resources (force-pushing, modifying shared branches)?

If there is significant risk of harm, vote deny.
If the risk is manageable and the command is bounded in scope, vote allow.`,
    },
    {
      role: 'convention',
      systemPrompt: `You are a Convention juror in a permission guard system.
Your job: evaluate whether the command follows development best practices and team conventions.

${patternBlock}${requestSourceBlock}
Respond ONLY with valid JSON: { "vote": "allow" | "deny", "confidence": 0.0-1.0, "reason": "brief explanation" }

Criteria:
- Does the command follow standard development workflows?
- Are there safer alternatives that achieve the same goal?
- Does it respect version control best practices?
- Would this command be acceptable in a CI/CD pipeline?

If the command follows conventions or has no safer alternative, vote allow.
If there is a clearly better approach, vote deny and explain the alternative.`,
    },
  ];
}

function buildRequestSourceBlock(ctx: JuryContext): string {
  if (!ctx.requestSource) return '';
  const src = ctx.requestSource;
  if (src.type === 'hive-mind') {
    const parts = [`REQUEST SOURCE: Hive-mind swarm`];
    if (src.agentCount) parts[0] += ` (${src.agentCount} agents`;
    if (src.consensusLevel) parts[0] += `, ${src.consensusLevel} consensus`;
    if (src.agentCount) parts[0] += ')';
    if (src.sharedContext) parts.push(`Swarm justification: ${sanitizeForPrompt(src.sharedContext)}`);
    return parts.join('\n') + '\n';
  }
  return 'REQUEST SOURCE: Single agent\n';
}

function buildUserMessage(ctx: JuryContext): string {
  const parts = [
    `Tool: ${ctx.toolName}`,
    `Command: ${sanitizeForPrompt(ctx.toolInput.command || JSON.stringify(ctx.toolInput))}`,
    `Working directory: ${ctx.cwd}`,
  ];
  if (ctx.filePath) parts.push(`File path: ${sanitizeForPrompt(ctx.filePath)}`);
  if (ctx.agentRole) parts.push(`Agent role: ${sanitizeForPrompt(ctx.agentRole)}`);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// LLM provider interaction
// ---------------------------------------------------------------------------

interface ProviderModule {
  createProviderManager: (config: unknown) => Promise<{
    complete: (request: unknown) => Promise<{ content: string; model: string; latency?: number }>;
    destroy: () => void;
  }>;
}

function getAnthropicApiKey(): string | null {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
  const trimmed = key.trim();
  return trimmed ? trimmed : null;
}

async function loadProviders(): Promise<ProviderModule | null> {
  try {
    return await import('@hive-flow/providers') as unknown as ProviderModule;
  } catch {
    return null;
  }
}

async function callJuror(
  config: JurorConfig,
  userMessage: string,
  providerModule: ProviderModule,
  apiKey: string,
  modelId?: string,
): Promise<LLMJurorVote> {
  const start = performance.now();
  const defaultModel = modelId || 'claude-sonnet-4-6';

  const manager = await providerModule.createProviderManager({
    providers: [{
      provider: 'anthropic',
      model: defaultModel,
      apiKey,
      maxTokens: 256,
      temperature: 0,
    }],
  });

  try {
    const response = await manager.complete({
      messages: [
        { role: 'system', content: config.systemPrompt },
        { role: 'user', content: userMessage },
      ],
      model: defaultModel,
      maxTokens: 256,
      temperature: 0,
    });

    const latencyMs = performance.now() - start;
    const parsed = parseJurorResponse(response.content);

    return {
      role: config.role,
      vote: parsed.vote,
      confidence: parsed.confidence,
      reason: parsed.reason,
      model: String(response.model || defaultModel),
      latencyMs,
    };
  } finally {
    manager.destroy();
  }
}

function parseJurorResponse(content: string): { vote: 'allow' | 'deny'; confidence: number; reason: string } {
  try {
    // Extract JSON from response (may be wrapped in markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { vote: 'deny', confidence: 0.5, reason: 'Failed to parse juror response — defaulting to deny' };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      vote: parsed.vote === 'allow' ? 'allow' : 'deny',
      confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
      reason: String(parsed.reason || 'No reason provided'),
    };
  } catch {
    return { vote: 'deny', confidence: 0.5, reason: 'Failed to parse juror response — defaulting to deny' };
  }
}

// ---------------------------------------------------------------------------
// Verdict logic
// ---------------------------------------------------------------------------

function computeVerdict(votes: LLMJurorVote[]): { verdict: JuryVerdict; reason: string } {
  const safetyVote = votes.find(v => v.role === 'safety');
  const goalVote = votes.find(v => v.role === 'goal');
  const conventionVote = votes.find(v => v.role === 'convention');

  // Safety veto: if safety denies, overall deny regardless of others
  if (safetyVote && safetyVote.vote === 'deny') {
    return {
      verdict: 'DENIED',
      reason: `[SAFETY VETO] ${safetyVote.reason}`,
    };
  }

  // Count allow/deny votes
  const allowCount = votes.filter(v => v.vote === 'allow').length;
  const denyCount = votes.filter(v => v.vote === 'deny').length;

  // 2/3 majority for approval
  if (allowCount >= 2) {
    const reasons = votes
      .filter(v => v.vote === 'allow')
      .map(v => `${v.role}: ${v.reason}`)
      .join('; ');
    return { verdict: 'APPROVED', reason: reasons };
  }

  // 2/3 majority for denial
  if (denyCount >= 2) {
    const reasons = votes
      .filter(v => v.vote === 'deny')
      .map(v => `${v.role}: ${v.reason}`)
      .join('; ');
    return { verdict: 'DENIED', reason: reasons };
  }

  // Split vote (1 allow, 1 deny, 1 may be missing) — default to deny
  const reasons = votes.map(v => `${v.role}: ${v.vote} (${v.reason})`).join('; ');
  return { verdict: 'DENIED', reason: `Split verdict — defaulting to deny. ${reasons}` };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate a permission request using 3 parallel LLM jurors.
 *
 * Returns null if the LLM provider infrastructure is unavailable,
 * allowing the caller to fall back to deterministic evaluation.
 */
export async function evaluateLLMJury(
  ctx: JuryContext,
  options?: {
    matchedPattern?: string;
    modelId?: string;
    timeoutMs?: number;
  },
): Promise<LLMJuryResult | null> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) return null;

  const providerModule = await loadProviders();
  if (!providerModule) return null;

  const configs = buildJurorConfigs(ctx, options?.matchedPattern);
  const userMessage = buildUserMessage(ctx);
  const timeoutMs = options?.timeoutMs ?? 12_000;

  const start = performance.now();

  // Dispatch all 3 jurors in parallel with timeout
  const jurorPromises = configs.map(config =>
    callJuror(config, userMessage, providerModule, apiKey, options?.modelId),
  );

  const timeoutPromise = new Promise<'timeout'>(resolve =>
    setTimeout(() => resolve('timeout'), timeoutMs),
  );

  const results = await Promise.race([
    Promise.allSettled(jurorPromises),
    timeoutPromise,
  ]);

  const totalLatencyMs = performance.now() - start;

  // Handle timeout
  if (results === 'timeout') {
    const cmd = ctx.toolInput.command || '';
    const risk = classifyCommand(cmd);
    const behavior = getTimeoutBehavior(risk.level);
    const verdict: JuryVerdict = behavior === 'allow' ? 'TIMEOUT_ALLOW' : 'TIMEOUT_DENY';
    return {
      verdict,
      votes: [],
      reason: `LLM jury timed out after ${timeoutMs}ms — risk-based auto-${behavior} (${risk.level} risk, ${risk.category})`,
      totalLatencyMs,
    };
  }

  // Collect successful votes
  const votes: LLMJurorVote[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      votes.push(result.value);
    }
  }

  // If no votes at all, treat as timeout
  if (votes.length === 0) {
    const cmd = ctx.toolInput.command || '';
    const risk = classifyCommand(cmd);
    const behavior = getTimeoutBehavior(risk.level);
    const verdict: JuryVerdict = behavior === 'allow' ? 'TIMEOUT_ALLOW' : 'TIMEOUT_DENY';
    return {
      verdict,
      votes: [],
      reason: `All jurors failed — risk-based auto-${behavior} (${risk.level} risk)`,
      totalLatencyMs,
    };
  }

  const { verdict, reason } = computeVerdict(votes);

  return {
    verdict,
    votes,
    reason,
    totalLatencyMs,
  };
}
