/**
 * Ambiguity Filter - Shared utility for all agents
 *
 * Before asking a user a question, run options through this filter.
 * If the answer is logically obvious (one option sensible, others absurd),
 * auto-select the sensible option without bothering the user.
 *
 * @module @claude-flow/cli/mcp-tools/ambiguity-filter
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AmbiguityAssessment {
  genuine: boolean;       // true = real ambiguity, ask the user
  autoSelected?: string;  // the option auto-selected (if not genuine)
  reason: string;         // explanation of the decision
  confidence: number;     // 0-1, how confident the filter is
  auditRequired?: boolean; // true = needs dual-agent intent audit before escalating
}

/**
 * Result from a single agent's intent audit of an interpretation.
 */
export interface IntentAuditScore {
  interpretation: string;
  promptIntentConfidence: number;  // 0-1, how well this matches the original prompt's intent
  planIntentConfidence: number;    // 0-1, how well this matches the plan's apparent intent
  reasoning: string;
}

/**
 * Full result from the dual-agent intent audit protocol.
 */
export interface IntentAuditResult {
  resolved: boolean;               // true = an interpretation was auto-selected
  selectedInterpretation?: string;  // the winning interpretation (if resolved)
  escalateToHuman: boolean;         // true = no interpretation reached 95% from both agents
  agentScores: {
    agent1: IntentAuditScore[];
    agent2: IntentAuditScore[];
  };
  reason: string;
}

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

/** Patterns indicating options are sequential phases of authorized work (not genuine choices) */
const SEQUENTIAL_PHASE_PATTERNS = [
  /^phase\s+[a-z0-9]/i,
  /^step\s+\d/i,
  /^then\s+/i,
  /^next[:\s]/i,
  /^proceed\s+(to|with)/i,
  /^continue\s+(to|with)/i,
];

/** Keywords that reduce coherence (shortcuts, laziness, nonsensical) */
const INCOHERENT_KEYWORDS: Array<{ pattern: string; penalty: number }> = [
  { pattern: 'skip', penalty: -2 },
  { pattern: 'ignore', penalty: -2 },
  { pattern: "don't bother", penalty: -3 },
  { pattern: 'skip everything', penalty: -4 },
  { pattern: 'ignore all', penalty: -4 },
  { pattern: 'random', penalty: -1 },
  { pattern: 'whatever', penalty: -2 },
  { pattern: 'just wing it', penalty: -3 },
  { pattern: 'yolo', penalty: -3 },
  { pattern: 'who cares', penalty: -3 },
  { pattern: 'not important', penalty: -2 },
];

/** Keywords that increase coherence (constructive, thoughtful) */
const COHERENT_KEYWORDS: Array<{ pattern: string; bonus: number }> = [
  { pattern: 'implement', bonus: 2 },
  { pattern: 'create', bonus: 2 },
  { pattern: 'fix', bonus: 2 },
  { pattern: 'test', bonus: 2 },
  { pattern: 'verify', bonus: 2 },
  { pattern: 'validate', bonus: 2 },
  { pattern: 'refactor', bonus: 1 },
  { pattern: 'improve', bonus: 1 },
  { pattern: 'optimize', bonus: 1 },
  { pattern: 'review', bonus: 1 },
  { pattern: 'analyze', bonus: 1 },
  { pattern: 'design', bonus: 1 },
  { pattern: 'research', bonus: 1 },
  { pattern: 'document', bonus: 1 },
];

/** Keywords that indicate a shortcut skipping important work */
const SHORTCUT_KEYWORDS = [
  'skip tests',
  'skip testing',
  'skip validation',
  'skip review',
  'no tests',
  'without tests',
  'without review',
  'without validation',
  'skip security',
  'ignore errors',
  'ignore warnings',
];

/** Patterns indicating a re-request for already-authorized work */
const RE_REQUEST_PATTERNS: RegExp[] = [
  // --- Direct permission seeking (consolidated) ---
  /\b(?:should|shall|may|can)\s+i\s+(?:continue|proceed|go\s+ahead|start|begin|do)\b/i,
  /\b(?:would\s+you\s+like|do\s+you\s+want)\s+(?:me\s+to|to)\b/i,
  /\bis\s+(?:it|that)\s+ok\s+(?:to|if)\b/i,
  /\b(?:ready|permission)\s+to\s+(?:proceed|continue|start)\b/i,
  /\bawait(?:ing)?\s+(?:your\s+)?(?:approval|confirmation|permission|go-ahead)\b/i,
  /\b(?:need|want)\s+(?:your\s+)?(?:me\s+to\s+)?(?:approval|confirmation|permission|handle|tackle|work\s+on|implement|fix|complete)\b/i,
  // --- Passive voice / hedged suggestions ---
  /\bit\s+(?:might|could|would)\s+be\s+(?:worth|beneficial|helpful|advisable)\s+(?:to\s+)?(?:check|verify|confirm|review)/i,
  /\b(?:perhaps|maybe)\s+(?:it\s+)?(?:would|could)\s+be\s+(?:prudent|wise|good|helpful)\s+to\s+(?:verify|check|confirm)/i,
  /\bone\s+might\s+(?:consider|want\s+to|ask\s+(?:if|whether))\b/i,
  /\bit\s+bears\s+mentioning\s+that\s+(?:confirm|verif|check)/i,
  // --- Conditional / hedging ---
  /\bif\s+you(?:'d)?\s+(?:prefer|would\s+rather),?\s+i\s+could/i,
  /\b(?:alternatively|otherwise),?\s+if\s+you\s+(?:think|feel)\s+(?:it\s+)?(?:best|better)/i,
  /\bshould\s+you\s+wish,?\s+i\s+(?:can|could|will)/i,
  // --- Embedded question / false choice ---
  /\bone\s+(?:approach|option|path)\s+would\s+be.*another\s+(?:would|is)\s+(?:be\s+)?to\s+(?:verify|check|get\s+your)/i,
  /\b(?:tradeoffs?|trade[\s-]offs?)\s+suggest\s+(?:either\s+)?(?:proceed|continu|paus)/i,
  /\boptions?\s+on\s+the\s+table\b.*(?:let\s+me\s+know|your\s+preference)/i,
  /\b(?:option\s+[ab]:.*?){2}.*(?:your\s+(?:call|choice|preference))/i,
  /\bwe\s+could\s+\w+.*(?:\((?:recommended|your\s+call|up\s+to\s+you)\)|\bor\s+(?:i\s+could\s+)?wait\s+for\s+your\s+(?:direction|input|decision))/i,
  // --- Rhetorical / wondering ---
  /\bi\s+wonder\s+(?:if|whether)\s+we\s+should\s+(?:reconsider|revisit|rethink|re-?evaluate)/i,
  // --- Deferential ---
  /\bi\s+defer\s+to\s+your\s+(?:judgment|expertise|guidance|wisdom)/i,
  /\byour\s+(?:guidance|expertise)\s+would\s+(?:be\s+)?(?:valuable|helpful|appreciated)/i,
  // --- Meta-question / alignment check ---
  /\bbefore\s+(?:(?:i|we)\s+)?(?:continu|proceed|div(?:e|ing)|go(?:ing)?).*is\s+there\s+anything/i,
  /\bjust\s+to\s+(?:make\s+sure|ensure|confirm)\s+we\s+(?:are|'re)\s+(?:aligned|on\s+the\s+same\s+page)/i,
  // --- Scope expansion ---
  /\bthis\s+(?:also\s+)?(?:touches|affects|impacts).*should\s+(?:i|we)\s+(?:include|extend|expand)/i,
  /\bwhile\s+(?:i(?:'m|\s+am)?|we(?:'re)?)\s+(?:here|at\s+it).*should\s+(?:i|we)\s+(?:also|additionally)/i,
  // --- Risk flagging ---
  /\bthis\s+(?:could|might)\s+be\s+risky.*(?:shall|should)\s+(?:i|we)/i,
  /\bgiven\s+the\s+(?:blast\s+radius|impact|risk|scope).*(?:would|should)\s+(?:you|we)\s+prefer/i,
  // --- Implicit pause ---
  /\bi(?:'ve| have)\s+(?:completed|finished)\s+(?:step|phase|part)\s+\d+\.\s*$/im,
  // --- Just checking / confirming ---
  /\bjust\s+(?:(?:wanted|wanting)\s+to\s+)?(?:to\s+)?(?:check|confirm|verify|mak(?:e|ing)\s+sure|double[\s-]check|verif(?:y|ying))/i,
  /\bquick\s+(?:sanity\s+check|double[\s-]check|check|question|confirmation)/i,
  // --- Thought leader / opinion-wrapped permission ---
  /\bi\s+(?:think|believe|feel)\s+(?:it\s+)?(?:might|would|could)\s+be\s+(?:best|better|wise|prudent|safer)\s+to\s+(?:check|ask|confirm|pause|wait)/i,
  // --- Parking / flagging / noting ---
  /\bparking\s+this\s+(?:here\s+)?for\s+your\s+(?:review|input|consideration)/i,
  /\bflagging\s+this\s+(?:decision|choice)\s+(?:point\s+)?for\s+(?:visibility|your\s+attention)/i,
  /\bnoting\s+(?:that\s+)?this\s+is\s+a\s+(?:fork|decision\s+point|crossroads)/i,
];

/** Patterns indicating the option IS the authorized next step */
const AUTHORIZED_CONTINUATION_PATTERNS: RegExp[] = [
  /\b(proceed|continue)\s+with\b/i,
  /\b(implement|complete|finish|execute)\s+(the\s+)?(remaining|next|authorized)\b/i,
  /\b(phase|step|task)\s+[A-Z0-9]/i,
  /\bremaining\s+(items?|tasks?|work)\b/i,
  /\bnext\s+(step|phase|item|task)\b/i,
  /\balready\s+(authorized|approved|planned)\b/i,
  /\b(?:resume|carry\s+on|keep\s+going|move\s+forward)\s+with\b/i,
  /\bcomplete\s+(?:all\s+)?(?:the\s+)?(?:outstanding|open|pending)\b/i,
];

/** Patterns indicating "stop and ask" (the anti-pattern we want to suppress) */
const STOP_AND_ASK_PATTERNS: RegExp[] = [
  /\bstop\s+(and\s+)?(ask|check|confirm|wait)\b/i,
  /\bask\s+(the\s+)?(user|human|you)\s+(first|before)\b/i,
  /\bask\s+which\b/i,
  /\bask\s+(about|for)\b/i,
  /\bwait\s+for\s+(\w+\s+)?(confirmation|approval|permission|input)\b/i,
  /\bpause\s+(and\s+)?(ask|wait|check)\b/i,
  /\bcheck\s+with\s+(the\s+)?(user|human)\b/i,
  /\blet\s+me\s+know\s+(?:if|whether|what|how)/i,
  /\byour\s+(?:thoughts|input|feedback|take)\s+(?:on|about|regarding|would\s+be)/i,
  /\bwhat\s+(?:do\s+you\s+think|are\s+your\s+thoughts|would\s+you\s+(?:suggest|recommend))/i,
  /\bi'?ll\s+wait\s+(?:for|until)\s+(?:your|you)/i,
  /\bstanding\s+by\s+(?:for|until)/i,
];

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

function scoreCoherence(option: string): number {
  const lower = option.toLowerCase();
  let score = 0;

  // Penalize suspiciously short options
  if (option.trim().length < 5) {
    score -= 2;
  }

  // Check incoherent keywords
  for (const { pattern, penalty } of INCOHERENT_KEYWORDS) {
    if (lower.includes(pattern)) {
      score += penalty;
    }
  }

  // Check coherent keywords
  for (const { pattern, bonus } of COHERENT_KEYWORDS) {
    if (lower.includes(pattern)) {
      score += bonus;
    }
  }

  return score;
}

function scoreAbsurdity(option: string): number {
  const lower = option.toLowerCase();
  let absurdity = 0;

  // Shortcut detection: options that skip important work
  for (const shortcut of SHORTCUT_KEYWORDS) {
    if (lower.includes(shortcut)) {
      absurdity += 3;
    }
  }

  // Contradictory patterns (e.g., "random delete")
  if (lower.includes('random') && lower.includes('delete')) {
    absurdity += 5;
  }

  // Self-contradictory phrasing
  if (lower.includes('but not really') || lower.includes('just kidding')) {
    absurdity += 4;
  }

  return absurdity;
}

function scoreContextAlignment(
  option: string,
  context: Record<string, unknown>,
): number {
  const lower = option.toLowerCase();
  let score = 0;

  // Align with originalRequest
  if (context.originalRequest && typeof context.originalRequest === 'string') {
    const reqWords = (context.originalRequest as string)
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3);
    for (const word of reqWords) {
      if (lower.includes(word)) score += 1;
    }
  }

  // Align with goal
  if (context.goal && typeof context.goal === 'string') {
    const goalWords = (context.goal as string)
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3);
    for (const word of goalWords) {
      if (lower.includes(word)) score += 1;
    }
  }

  // Align with currentPhase
  if (context.currentPhase && typeof context.currentPhase === 'string') {
    const phase = (context.currentPhase as string).toLowerCase();
    if (lower.includes(phase)) score += 1;
  }

  // Penalize if option contradicts constraints
  if (context.constraints && Array.isArray(context.constraints)) {
    for (const constraint of context.constraints as string[]) {
      const cLower = constraint.toLowerCase();
      // If constraint says "no X" and option includes "X", penalize
      const negMatch = cLower.match(/(?:no|without|never)\s+(\w+)/);
      if (negMatch && lower.includes(negMatch[1])) {
        score -= 3;
      }
    }
  }

  return score;
}

// ---------------------------------------------------------------------------
// Main filter function
// ---------------------------------------------------------------------------

/**
 * Assess whether ambiguity between options is genuine or if one option
 * is clearly the right choice.
 *
 * Rules:
 * 1. If one option is logically coherent and others are absurd -> auto-select coherent
 * 2. If one option aligns with context and others contradict it -> auto-select aligned
 * 3. If one option is a "shortcut" that skips important work -> reject the shortcut
 * 4. If multiple options are equally reasonable -> genuine ambiguity, ask user
 * 5. Don't bother the user with questions where the answer is obvious
 */
export function isAmbiguityGenuine(
  options: string[],
  context: Record<string, unknown>,
): AmbiguityAssessment {
  if (options.length === 0) {
    return {
      genuine: false,
      reason: 'No options provided — nothing to decide.',
      confidence: 1.0,
    };
  }

  if (options.length === 1) {
    return {
      genuine: false,
      autoSelected: options[0],
      reason: 'Only one option available — auto-selected.',
      confidence: 1.0,
    };
  }

  // Determine authorization status early — used by Rule -1 and later rules.
  const isAuthorized = context.authorized === true || context.planApproved === true;

  // Rule -1: Re-request detection.
  // If the "question" is really asking for permission to do already-authorized work,
  // auto-select the continuation option. This MUST fire before any scoring.
  if (isAuthorized) {
    const reRequestDetected = options.some(opt =>
      RE_REQUEST_PATTERNS.some(re => re.test(opt)),
    );

    if (reRequestDetected) {
      // Find the option that continues authorized work
      const continuationOption = options.find(opt =>
        AUTHORIZED_CONTINUATION_PATTERNS.some(re => re.test(opt)),
      );
      // Or find ANY option that isn't "stop and ask"
      const nonStopOption = continuationOption || options.find(opt =>
        !STOP_AND_ASK_PATTERNS.some(re => re.test(opt)),
      );

      if (nonStopOption) {
        return {
          genuine: false,
          autoSelected: nonStopOption,
          reason: 'Re-request for already-authorized work detected. Auto-proceeding — re-requesting permission for authorized work is a policy violation.',
          confidence: 1.0,
        };
      }
    }

    // Also catch when ONE option is a continuation and another is "stop and ask"
    const hasContinuation = options.some(opt =>
      AUTHORIZED_CONTINUATION_PATTERNS.some(re => re.test(opt)),
    );
    const hasStopAndAsk = options.some(opt =>
      STOP_AND_ASK_PATTERNS.some(re => re.test(opt)),
    );
    if (hasContinuation && hasStopAndAsk) {
      const continuation = options.find(opt =>
        AUTHORIZED_CONTINUATION_PATTERNS.some(re => re.test(opt)),
      )!;
      return {
        genuine: false,
        autoSelected: continuation,
        reason: 'Continuation vs stop-and-ask on authorized work — auto-selected continuation. Stopping to ask for already-granted permission is prohibited.',
        confidence: 1.0,
      };
    }
  }

  // Rule 0: Sequential phases are directives, not choices.
  // If all options look like sequential phases of a plan (e.g., "Phase B2", "Phase C"),
  // auto-select the first option (the next phase in sequence).
  // NOTE: Authorized non-sequential work flows through scoring so that genuine
  // ambiguity can trigger the dual-agent intent audit (auditRequired) path.
  const allSequential = options.every(opt =>
    SEQUENTIAL_PHASE_PATTERNS.some(re => re.test(opt.trim())),
  );

  if (allSequential) {
    return {
      genuine: false,
      autoSelected: options[0],
      reason: 'Options are sequential phases of a plan — auto-selected next phase.',
      confidence: 1.0,
    };
  }

  // Score each option
  const scored = options.map(opt => {
    const coherence = scoreCoherence(opt);
    const absurdity = scoreAbsurdity(opt);
    const alignment = scoreContextAlignment(opt, context);
    const total = coherence - absurdity + alignment;

    return { option: opt, coherence, absurdity, alignment, total };
  });

  // Sort descending by total score
  scored.sort((a, b) => b.total - a.total);

  const best = scored[0];
  const secondBest = scored[1];
  const gap = best.total - secondBest.total;

  // Rule 1 & 2: Large gap means clear winner
  if (gap >= 3) {
    const confidence = Math.min(1.0, 0.7 + gap * 0.05);
    return {
      genuine: false,
      autoSelected: best.option,
      reason: `Auto-selected "${best.option}" — other options scored significantly lower (gap: ${gap}).`,
      confidence: Math.round(confidence * 100) / 100,
    };
  }

  // Rule 3: If second best has high absurdity, auto-select best
  if (secondBest.absurdity > 2 && best.absurdity === 0) {
    return {
      genuine: false,
      autoSelected: best.option,
      reason: `Auto-selected "${best.option}" — alternative options appear to skip important work or are incoherent.`,
      confidence: 0.85,
    };
  }

  // If second option has a negative score and best is non-negative
  if (secondBest.total < 0 && best.total >= 0) {
    return {
      genuine: false,
      autoSelected: best.option,
      reason: `Auto-selected "${best.option}" — alternative options appear incoherent.`,
      confidence: 0.8,
    };
  }

  // Rule 4: Genuine ambiguity — scores are close.
  // If the work is authorized, flag for dual-agent intent audit INSTEAD of escalating.
  const maxScore = Math.max(Math.abs(best.total), Math.abs(secondBest.total), 1);
  const normalizedGap = gap / maxScore;
  const confidence = Math.max(0.3, Math.min(0.7, 0.5 + normalizedGap));

  if (isAuthorized) {
    // Authorized work with genuine ambiguity: don't escalate yet.
    // Flag for dual-agent intent audit (caller invokes resolveAuthorizedAmbiguity).
    return {
      genuine: true,
      auditRequired: true,
      reason: `Authorized work has ambiguous options (top: ${best.total}, second: ${secondBest.total}). Dual-agent intent audit required before escalating.`,
      confidence: Math.round(confidence * 100) / 100,
    };
  }

  return {
    genuine: true,
    reason: `Multiple viable options with similar scores (top: ${best.total}, second: ${secondBest.total}). User clarification needed.`,
    confidence: Math.round(confidence * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// Dual-agent intent audit protocol
// ---------------------------------------------------------------------------

/** Confidence threshold: both agents must reach this on both intents */
const INTENT_CONFIDENCE_THRESHOLD = 0.95;

/**
 * Resolve ambiguity on authorized work via dual-agent intent audit.
 *
 * Protocol:
 * 1. Two independent agents each score every interpretation against:
 *    - The INTENT of the original user prompt
 *    - The apparent INTENT of the approved plan
 * 2. An interpretation is viable if BOTH agents score it ≥95% on BOTH intents.
 * 3. If any viable interpretation exists, auto-select the highest-rated one.
 * 4. If NO interpretation reaches 95% from both agents on both intents,
 *    escalate to the human for clarification.
 *
 * @param interpretations - The ambiguous options/interpretations
 * @param promptIntent - The original user request/prompt
 * @param planIntent - The approved plan text or summary
 * @param auditFn - Function that scores an interpretation (called for each agent).
 *   Must return { promptIntentConfidence, planIntentConfidence, reasoning }.
 *   Called twice per interpretation (once per agent). Implementations MUST
 *   ensure independence between agent calls — use separate LLM invocations,
 *   separate agent contexts, or separate provider instances. Sharing context
 *   between the two calls defeats the dual-agent verification guarantee.
 */
export async function resolveAuthorizedAmbiguity(
  interpretations: string[],
  promptIntent: string,
  planIntent: string,
  auditFn: (
    interpretation: string,
    promptIntent: string,
    planIntent: string,
    agentIndex: number,
  ) => Promise<{ promptIntentConfidence: number; planIntentConfidence: number; reasoning: string }>,
): Promise<IntentAuditResult> {
  const agent1Scores: IntentAuditScore[] = [];
  const agent2Scores: IntentAuditScore[] = [];

  // Run both agents on all interpretations
  for (const interp of interpretations) {
    const [a1, a2] = await Promise.all([
      auditFn(interp, promptIntent, planIntent, 0),
      auditFn(interp, promptIntent, planIntent, 1),
    ]);

    agent1Scores.push({ interpretation: interp, ...a1 });
    agent2Scores.push({ interpretation: interp, ...a2 });
  }

  // Find interpretations where BOTH agents score ≥95% on BOTH intents
  const viable: Array<{ interpretation: string; combinedScore: number }> = [];

  for (let i = 0; i < interpretations.length; i++) {
    const a1 = agent1Scores[i];
    const a2 = agent2Scores[i];

    const a1PassesPrompt = a1.promptIntentConfidence >= INTENT_CONFIDENCE_THRESHOLD;
    const a1PassesPlan = a1.planIntentConfidence >= INTENT_CONFIDENCE_THRESHOLD;
    const a2PassesPrompt = a2.promptIntentConfidence >= INTENT_CONFIDENCE_THRESHOLD;
    const a2PassesPlan = a2.planIntentConfidence >= INTENT_CONFIDENCE_THRESHOLD;

    if (a1PassesPrompt && a1PassesPlan && a2PassesPrompt && a2PassesPlan) {
      // Combined score = average of all 4 confidence values
      const combinedScore = (
        a1.promptIntentConfidence + a1.planIntentConfidence +
        a2.promptIntentConfidence + a2.planIntentConfidence
      ) / 4;
      viable.push({ interpretation: interpretations[i], combinedScore });
    }
  }

  if (viable.length > 0) {
    // Auto-select the highest-rated viable interpretation
    viable.sort((a, b) => b.combinedScore - a.combinedScore);
    return {
      resolved: true,
      selectedInterpretation: viable[0].interpretation,
      escalateToHuman: false,
      agentScores: { agent1: agent1Scores, agent2: agent2Scores },
      reason: `Auto-resolved: "${viable[0].interpretation}" passed both agents at ≥95% confidence on both prompt and plan intent (combined: ${(viable[0].combinedScore * 100).toFixed(1)}%).`,
    };
  }

  // No interpretation reached threshold — escalate to human
  return {
    resolved: false,
    escalateToHuman: true,
    agentScores: { agent1: agent1Scores, agent2: agent2Scores },
    reason: `No interpretation reached ≥${INTENT_CONFIDENCE_THRESHOLD * 100}% confidence from both agents on both prompt and plan intent. Human clarification required.`,
  };
}
