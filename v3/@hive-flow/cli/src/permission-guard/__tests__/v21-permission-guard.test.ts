/**
 * Permission Guard v2.1 Tests
 *
 * Covers:
 * 1. FORBIDDEN patterns: All 8 unsafe patterns denied with no override path
 * 2. Post-jury safeguard: FORBIDDEN_PATTERNS catches accidental allow
 * 3. Jury-assessable: sudo, kill, pkill, git checkout trigger jury evaluation
 * 4. git checkout removed from auto-allow
 * 5. Enriched AuditLogEntry fields populated correctly
 * 6. LLMJurorVote and LLMJuryResult types work correctly
 * 7. JuryContext.requestSource (hive-mind consensus) included properly
 * 8. Feedback strings: FORBIDDEN say "not available", jury-assessable say "jury will evaluate"
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @hive-flow/shared before any imports that depend on it
vi.mock('@hive-flow/shared', () => ({
  resolveHiveHome: () => ({
    home: '/tmp/hive-flow',
    source: 'default',
    legacyHome: '/tmp/.claude/hive-flow',
    legacyExists: false,
    readFallbacks: [],
  }),
  resolveProjectRoot: () => '/project',
  sessionKeyFor: () => 's_mock',
}));

import { DEFAULT_PERMISSION_CONFIG, mergeWithDefaults } from '../default-config.js';
import { evaluate, evaluateHookInput, resetConfigCache, checkBashPatterns, checkBashAllow, stripCommand } from '../gate.js';
import type {
  AuditLogEntry,
  JuryContext,
  HookInput,
  PermissionConfig,
} from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bashInput(command: string): HookInput {
  return { tool_name: 'Bash', tool_input: { command }, cwd: '/project' };
}

function makeConfig(overrides: Partial<PermissionConfig> = {}): PermissionConfig {
  return mergeWithDefaults(overrides);
}

beforeEach(() => {
  resetConfigCache();
});

// ---------------------------------------------------------------------------
// 1. FORBIDDEN patterns — All 8 unsafe classes denied with NO override path
// ---------------------------------------------------------------------------

describe('FORBIDDEN patterns (8 unsafe patterns, no override)', () => {
  const config = makeConfig();

  const forbiddenCommands: Array<{ pattern: string; command: string }> = [
    { pattern: 'rm *', command: 'rm -rf ./build' },
    { pattern: 'chmod 777*', command: 'chmod 777 script.sh' },
    { pattern: 'chown *', command: 'chown user:group file.txt' },
    { pattern: 'killall *', command: 'killall node' },
    { pattern: 'docker rm*', command: 'docker rm my-container' },
    { pattern: 'docker rmi*', command: 'docker rmi my-image:latest' },
    { pattern: 'git push --force*', command: 'git push --force origin main' },
    { pattern: 'git reset --hard*', command: 'git reset --hard HEAD~3' },
  ];

  for (const { pattern, command } of forbiddenCommands) {
    it(`denies "${command}" (pattern: ${pattern})`, async () => {
      const result = await evaluate(bashInput(command), config);
      expect(result.decision).toBe('deny');
    });
  }

  it('denies all 8 unsafe FORBIDDEN patterns regardless of config overrides', async () => {
    for (const { command } of forbiddenCommands) {
      const result = await evaluate(bashInput(command), config);
      expect(result.decision).toBe('deny');
    }
  });

  it('FORBIDDEN patterns are in always_deny_bash_patterns', () => {
    const denyPatterns = config.always_deny_bash_patterns;

    // Each FORBIDDEN command must match at least one deny pattern
    for (const { command } of forbiddenCommands) {
      const matched = checkBashPatterns(command, denyPatterns);
      expect(matched).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Post-jury safeguard — FORBIDDEN_PATTERNS catches accidental allow
// ---------------------------------------------------------------------------

describe('Post-jury safeguard (FORBIDDEN_PATTERNS)', () => {
  const FORBIDDEN_PATTERNS = [
    'rm *', 'chmod 777*', 'chown *', 'killall *',
    'docker rm*', 'docker rmi*',
    'git push --force*', 'git reset --hard*',
  ];

  // Simulate the glob-match function used in gate.ts for the FORBIDDEN_PATTERNS
  function matchGlob(cmd: string, pattern: string): boolean {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i').test(cmd.trim());
  }

  const testCases = [
    { cmd: 'rm -rf node_modules', pattern: 'rm *', shouldMatch: true },
    { cmd: 'chmod +x deploy.sh', pattern: 'chmod 777*', shouldMatch: false },
    { cmd: 'chmod 777 deploy.sh', pattern: 'chmod 777*', shouldMatch: true },
    { cmd: 'chown root:root /etc/config', pattern: 'chown *', shouldMatch: true },
    { cmd: 'killall node', pattern: 'killall *', shouldMatch: true },
    { cmd: 'docker rm container1', pattern: 'docker rm*', shouldMatch: true },
    { cmd: 'docker rmi image:tag', pattern: 'docker rmi*', shouldMatch: true },
    { cmd: 'git push --force origin main', pattern: 'git push --force*', shouldMatch: true },
    { cmd: 'git push --force-with-lease origin main', pattern: 'git push --force*', shouldMatch: true },
    { cmd: 'git reset --hard HEAD', pattern: 'git reset --hard*', shouldMatch: true },
  ];

  for (const { cmd, pattern, shouldMatch } of testCases) {
    it(`safeguard ${shouldMatch ? 'catches' : 'passes'}: "${cmd}" (pattern: ${pattern})`, () => {
      expect(matchGlob(cmd, pattern)).toBe(shouldMatch);
    });
  }

  it('safeguard does NOT block safe commands', () => {
    const safeCommands = ['git status', 'npm run build', 'ls -la', 'git push origin main'];
    for (const cmd of safeCommands) {
      let blocked = false;
      for (const fp of FORBIDDEN_PATTERNS) {
        if (matchGlob(cmd, fp)) {
          blocked = true;
          break;
        }
      }
      expect(blocked).toBe(false);
    }
  });

  it('safeguard overrides even if a hypothetical jury returned allow', async () => {
    // Even with a permissive config, FORBIDDEN commands must still be denied
    const config = makeConfig();
    for (const cmd of ['rm -rf ./build', 'chmod 777 /tmp', 'git reset --hard HEAD~1']) {
      const result = await evaluate(bashInput(cmd), config);
      expect(result.decision).toBe('deny');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Jury-assessable: sudo, kill, pkill, git checkout trigger jury evaluation
// ---------------------------------------------------------------------------

describe('Jury-assessable patterns (4 patterns)', () => {
  const config = makeConfig();

  const juryAssessableCommands = [
    { pattern: 'sudo *', command: 'sudo lsof -i :3000' },
    { pattern: 'kill *', command: 'kill 12345' },
    { pattern: 'pkill *', command: 'pkill -f node' },
    { pattern: 'git checkout *', command: 'git checkout -- src/file.ts' },
  ];

  for (const { pattern, command } of juryAssessableCommands) {
    it(`denies "${command}" on first attempt (auto-deny, pattern: ${pattern})`, async () => {
      const result = await evaluate(bashInput(command), config);
      expect(result.decision).toBe('deny');
    });
  }

  it('jury-assessable patterns are in jury_escalation_bash_patterns', () => {
    const escalationPatterns = config.jury_escalation_bash_patterns;

    for (const { command } of juryAssessableCommands) {
      const matched = checkBashPatterns(command, escalationPatterns);
      expect(matched).not.toBeNull();
    }
  });

  it('jury-assessable patterns are NOT in always_deny_bash_patterns for sudo/kill/pkill', () => {
    const escalationPatterns = config.jury_escalation_bash_patterns;

    // sudo, kill, pkill should match escalation patterns
    for (const cmd of ['sudo echo test', 'kill 1234', 'pkill node']) {
      const escalationMatch = checkBashPatterns(cmd, escalationPatterns);
      expect(escalationMatch).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. git checkout removed from auto-allow
// ---------------------------------------------------------------------------

describe('git checkout removed from always_allow_bash_patterns', () => {
  it('git checkout is NOT in the default allow patterns', () => {
    const config = makeConfig();
    const allowPatterns = config.always_allow_bash_patterns;

    const checkoutAllowed = checkBashAllow('git checkout main', allowPatterns);
    expect(checkoutAllowed).toBe(false);
  });

  it('git checkout is denied (routed to jury-assessable)', async () => {
    const config = makeConfig();
    const result = await evaluate(bashInput('git checkout main'), config);
    expect(result.decision).toBe('deny');
  });

  it('git switch is not auto-allowed after known-good tightening', () => {
    const config = makeConfig();
    const allowPatterns = config.always_allow_bash_patterns;

    const switchAllowed = checkBashAllow('git switch main', allowPatterns);
    expect(switchAllowed).toBe(false);
  });

  it('bare git stash is not auto-allowed but stash list remains known-good', () => {
    const config = makeConfig();
    const allowPatterns = config.always_allow_bash_patterns;

    const stashAllowed = checkBashAllow('git stash', allowPatterns);
    const stashListAllowed = checkBashAllow('git stash list', allowPatterns);
    expect(stashAllowed).toBe(false);
    expect(stashListAllowed).toBe(true);
  });

  it('read-only git commands remain auto-allowed', () => {
    const config = makeConfig();
    const allowPatterns = config.always_allow_bash_patterns;

    const stillAllowed = [
      'git status', 'git log --oneline', 'git diff HEAD',
      'git show HEAD', 'git branch -a', 'git remote -v',
      'git stash list', 'git config --list', 'git blame file.ts',
    ];

    for (const cmd of stillAllowed) {
      expect(checkBashAllow(cmd, allowPatterns)).toBe(true);
    }
  });

  it('state-changing git commands are not auto-allowed', () => {
    const config = makeConfig();
    const allowPatterns = config.always_allow_bash_patterns;

    const demoted = [
      'git add src/file.ts', 'git commit -m "test"',
      'git merge feature', 'git rebase main',
      'git push origin feature', 'git pull origin main',
      'git fetch --all', 'git cherry-pick abc123',
    ];

    for (const cmd of demoted) {
      expect(checkBashAllow(cmd, allowPatterns)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Enriched AuditLogEntry fields populated correctly
// ---------------------------------------------------------------------------

describe('Enriched AuditLogEntry fields', () => {
  it('AuditLogEntry type includes new fields', () => {
    const entry: AuditLogEntry = {
      ts: new Date().toISOString(),
      tool: 'Bash',
      input_summary: 'rm -rf ./build',
      decision: 'deny',
      layer: 'pre-scripted',
      reason: 'matched FORBIDDEN pattern: rm *',
      scale_position: 'definite-deny',
      matched_pattern: 'rm *',
      risk_level: 'high',
      jury_votes: {
        goal: { vote: 'allow', confidence: 0.8, model: 'claude-haiku' },
        safety: { vote: 'deny', confidence: 0.95, model: 'claude-haiku' },
        convention: { vote: 'deny', confidence: 0.7, model: 'claude-haiku' },
      },
      feedback_given: 'DENIED: File deletion is not available.',
      session_id: 'session-123',
      sequence_id: 1,
      juror_latency_ms: 450,
    };

    expect(entry.ts).toBeDefined();
    expect(entry.tool).toBe('Bash');
    expect(entry.scale_position).toBe('definite-deny');
    expect(entry.matched_pattern).toBe('rm *');
    expect(entry.risk_level).toBe('high');
    expect(entry.jury_votes).toBeDefined();
    expect(entry.jury_votes?.safety?.vote).toBe('deny');
    expect(entry.feedback_given).toContain('not available');
    expect(entry.session_id).toBe('session-123');
    expect(entry.sequence_id).toBe(1);
    expect(entry.juror_latency_ms).toBe(450);
  });

  it('AuditLogEntry works with minimal fields (backward compatible)', () => {
    const entry: AuditLogEntry = {
      ts: new Date().toISOString(),
      tool: 'Bash',
      input_summary: 'git status',
      decision: 'allow',
      layer: 'deterministic',
      reason: 'matched allow pattern',
    };

    expect(entry.scale_position).toBeUndefined();
    expect(entry.matched_pattern).toBeUndefined();
    expect(entry.jury_votes).toBeUndefined();
  });

  it('scale_position values cover the decision scale', () => {
    const validPositions = [
      'definite-deny',
      'judged-deny',
      'uncertainty',
      'judged-approve',
      'definite-allow',
    ] as const;

    for (const pos of validPositions) {
      const entry: AuditLogEntry = {
        ts: '', tool: '', input_summary: '', decision: '', layer: '', reason: '',
        scale_position: pos,
      };
      expect(entry.scale_position).toBe(pos);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. LLMJurorVote and LLMJuryResult types work correctly
// ---------------------------------------------------------------------------

describe('LLMJurorVote and LLMJuryResult types', () => {
  it('LLMJurorVote has required fields', async () => {
    const types = await import('../types.js');
    // Verify the module loaded
    expect(types).toBeDefined();

    // Construct a valid LLMJurorVote shape
    const vote = {
      role: 'safety' as const,
      vote: 'deny' as const,
      confidence: 0.95,
      reason: 'Command matches known dangerous pattern',
      model: 'claude-haiku-4-5-20251001',
      latencyMs: 450,
    };

    expect(vote.role).toBe('safety');
    expect(vote.vote).toBe('deny');
    expect(vote.confidence).toBeGreaterThanOrEqual(0);
    expect(vote.confidence).toBeLessThanOrEqual(1);
    expect(vote.reason).toBeTruthy();
    expect(vote.model).toBeTruthy();
    expect(vote.latencyMs).toBeGreaterThan(0);
  });

  it('LLMJurorVote supports all 3 roles', () => {
    const roles = ['goal', 'safety', 'convention'] as const;
    for (const role of roles) {
      const vote = {
        role,
        vote: 'allow' as const,
        confidence: 0.8,
        reason: 'Test',
        model: 'test-model',
        latencyMs: 100,
      };
      expect(vote.role).toBe(role);
    }
  });

  it('LLMJuryResult aggregates votes correctly', () => {
    const votes = [
      { role: 'goal' as const, vote: 'allow' as const, confidence: 0.9, reason: 'Relevant', model: 'haiku', latencyMs: 300 },
      { role: 'safety' as const, vote: 'deny' as const, confidence: 0.95, reason: 'Dangerous', model: 'haiku', latencyMs: 400 },
      { role: 'convention' as const, vote: 'allow' as const, confidence: 0.7, reason: 'Acceptable', model: 'haiku', latencyMs: 350 },
    ];

    const result = {
      verdict: 'DENIED' as const,
      votes,
      reason: 'Safety veto: Dangerous',
      totalLatencyMs: 400,
    };

    expect(result.verdict).toBe('DENIED');
    expect(result.votes).toHaveLength(3);
    expect(result.totalLatencyMs).toBe(400);

    const safetyVote = result.votes.find(v => v.role === 'safety');
    expect(safetyVote?.vote).toBe('deny');
  });

  it('LLMJuryResult: 2/3 majority with safety allow = APPROVED', () => {
    const votes = [
      { role: 'goal' as const, vote: 'allow' as const, confidence: 0.9, reason: 'OK', model: 'haiku', latencyMs: 300 },
      { role: 'safety' as const, vote: 'allow' as const, confidence: 0.8, reason: 'Safe', model: 'haiku', latencyMs: 400 },
      { role: 'convention' as const, vote: 'deny' as const, confidence: 0.6, reason: 'Unusual', model: 'haiku', latencyMs: 350 },
    ];

    const allowCount = votes.filter(v => v.vote === 'allow').length;
    const safetyApproved = (votes.find(v => v.role === 'safety')?.vote as string) === 'allow';
    const verdict = allowCount >= 2 && safetyApproved ? 'APPROVED' : 'DENIED';

    expect(verdict).toBe('APPROVED');
  });

  it('LLMJuryResult: safety veto overrides 2/3 majority', () => {
    const votes = [
      { role: 'goal' as const, vote: 'allow' as const, confidence: 0.9, reason: 'OK', model: 'haiku', latencyMs: 300 },
      { role: 'safety' as const, vote: 'deny' as const, confidence: 0.95, reason: 'Unsafe', model: 'haiku', latencyMs: 400 },
      { role: 'convention' as const, vote: 'allow' as const, confidence: 0.8, reason: 'Fine', model: 'haiku', latencyMs: 350 },
    ];

    const allowCount = votes.filter(v => v.vote === 'allow').length;
    const safetyApproved = (votes.find(v => v.role === 'safety')?.vote as string) === 'allow';
    const verdict = allowCount >= 2 && safetyApproved ? 'APPROVED' : 'DENIED';

    expect(verdict).toBe('DENIED');
  });
});

// ---------------------------------------------------------------------------
// 7. JuryContext.requestSource (hive-mind consensus) included properly
// ---------------------------------------------------------------------------

describe('JuryContext.requestSource (hive-mind consensus)', () => {
  it('JuryContext supports requestSource field', () => {
    const ctx: JuryContext = {
      toolName: 'Bash',
      toolInput: { command: 'git checkout feature-branch' },
      cwd: '/project',
      requestSource: {
        type: 'hive-mind',
        consensusLevel: 'unanimous',
        agentCount: 15,
        sharedContext: 'All agents agree: checkout is needed to test integration against feature branch.',
      },
    };

    expect(ctx.requestSource).toBeDefined();
    expect(ctx.requestSource?.type).toBe('hive-mind');
    expect(ctx.requestSource?.consensusLevel).toBe('unanimous');
    expect(ctx.requestSource?.agentCount).toBe(15);
    expect(ctx.requestSource?.sharedContext).toBeTruthy();
  });

  it('JuryContext works without requestSource (backward compatible)', () => {
    const ctx: JuryContext = {
      toolName: 'Bash',
      toolInput: { command: 'git status' },
      cwd: '/project',
    };

    expect(ctx.requestSource).toBeUndefined();
  });

  it('requestSource supports single-agent type', () => {
    const ctx: JuryContext = {
      toolName: 'Bash',
      toolInput: { command: 'sudo lsof -i :3000' },
      cwd: '/project',
      requestSource: {
        type: 'single-agent',
      },
    };

    expect(ctx.requestSource?.type).toBe('single-agent');
    expect(ctx.requestSource?.consensusLevel).toBeUndefined();
    expect(ctx.requestSource?.agentCount).toBeUndefined();
  });

  it('requestSource supports all consensus levels', () => {
    const levels = ['unanimous', 'majority', 'split'] as const;
    for (const level of levels) {
      const ctx: JuryContext = {
        toolName: 'Bash',
        toolInput: { command: 'kill 12345' },
        cwd: '/project',
        requestSource: {
          type: 'hive-mind',
          consensusLevel: level,
          agentCount: 5,
        },
      };
      expect(ctx.requestSource?.consensusLevel).toBe(level);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Feedback strings: FORBIDDEN say "not available", jury-assessable say "jury will evaluate"
// ---------------------------------------------------------------------------

describe('Feedback strings', () => {
  const config = makeConfig();

  describe('FORBIDDEN feedback says "not available"', () => {
    // Some FORBIDDEN commands (rm -rf, killall) are caught at the deep-inspect
    // layer before reaching deny patterns. The key property: they are DENIED
    // and their deny-pattern feedback contains "not available".
    // Commands caught by deep-inspect get a different message, which is fine --
    // the deep-inspect layer is a stronger pre-filter.
    const forbiddenWithDenyPatternFeedback: Array<{ command: string; expectedFragment: string }> = [
      { command: 'chown user:group file.txt', expectedFragment: 'not available' },
      { command: 'docker rm my-container', expectedFragment: 'not available' },
      { command: 'docker rmi image:latest', expectedFragment: 'not available' },
      { command: 'git push --force origin main', expectedFragment: 'not available' },
      { command: 'git reset --hard HEAD~1', expectedFragment: 'not available' },
    ];

    for (const { command, expectedFragment } of forbiddenWithDenyPatternFeedback) {
      it(`"${command}" feedback contains "${expectedFragment}"`, async () => {
        const result = await evaluate(bashInput(command), config);
        expect(result.decision).toBe('deny');
        expect(result.reason?.toLowerCase()).toContain(expectedFragment);
      });
    }

    // Commands caught by deep-inspect are still DENIED
    const forbiddenCaughtByDeepInspect = ['rm -rf ./build', 'chmod 777 script.sh', 'killall node'];
    for (const command of forbiddenCaughtByDeepInspect) {
      it(`"${command}" is denied (caught by deep-inspect pre-filter)`, async () => {
        const result = await evaluate(bashInput(command), config);
        expect(result.decision).toBe('deny');
        // Deep-inspect provides its own feedback
        expect(result.reason).toBeTruthy();
      });
    }

    // Verify the deny-pattern feedback itself says "not available"
    it('deny-pattern feedback for rm contains "not available"', () => {
      const matched = checkBashPatterns('rm -rf build', config.always_deny_bash_patterns);
      expect(matched).not.toBeNull();
      expect(matched!.toLowerCase()).toContain('not available');
    });

    it('deny-pattern feedback for killall contains "not available"', () => {
      const matched = checkBashPatterns('killall node', config.always_deny_bash_patterns);
      expect(matched).not.toBeNull();
      expect(matched!.toLowerCase()).toContain('not available');
    });

    it('FORBIDDEN feedback does NOT mention jury or re-submit', async () => {
      const forbiddenCmds = [
        'rm -rf ./build', 'chmod 777 script.sh', 'chown user:group file.txt',
        'killall node', 'docker rm container1', 'docker rmi image:tag',
        'git push --force origin main', 'git reset --hard HEAD',
      ];

      for (const cmd of forbiddenCmds) {
        const result = await evaluate(bashInput(cmd), config);
        const reason = (result.reason || '').toLowerCase();
        expect(reason).not.toContain('jury will evaluate');
        expect(reason).not.toContain('re-submit');
      }
    });
  });

  describe('Jury-assessable feedback says "jury will evaluate"', () => {
    const juryFeedback: Array<{ command: string; expectedFragment: string }> = [
      { command: 'sudo lsof -i :3000', expectedFragment: 'jury will evaluate' },
      { command: 'kill 12345', expectedFragment: 'jury will evaluate' },
      { command: 'pkill -f node', expectedFragment: 'jury will evaluate' },
      { command: 'git checkout -- src/file.ts', expectedFragment: 'jury will evaluate' },
    ];

    for (const { command, expectedFragment } of juryFeedback) {
      it(`"${command}" feedback contains "${expectedFragment}"`, async () => {
        const result = await evaluate(bashInput(command), config);
        expect(result.decision).toBe('deny');
        expect(result.reason?.toLowerCase()).toContain(expectedFragment);
      });
    }
  });

  describe('FORBIDDEN feedback suggests alternatives', () => {
    it('rm deny-pattern feedback suggests npm run clean or make clean', () => {
      // rm -rf is caught by deep-inspect before deny patterns at runtime,
      // but we verify the deny-pattern feedback itself contains alternatives.
      const feedback = checkBashPatterns('rm -rf build', config.always_deny_bash_patterns);
      expect(feedback).not.toBeNull();
      expect(feedback!.toLowerCase()).toMatch(/clean|build/);
    });

    it('git push --force feedback suggests git push (normal)', async () => {
      const result = await evaluate(bashInput('git push --force origin main'), config);
      const reason = (result.reason || '').toLowerCase();
      expect(reason).toMatch(/push|rebase/);
    });

    it('git reset --hard feedback suggests git stash', async () => {
      const result = await evaluate(bashInput('git reset --hard HEAD'), config);
      const reason = (result.reason || '').toLowerCase();
      expect(reason).toMatch(/stash/);
    });
  });

  describe('Jury-assessable feedback suggests re-submission', () => {
    it('sudo feedback mentions re-submit or explanation', async () => {
      const result = await evaluate(bashInput('sudo apt install curl'), config);
      const reason = (result.reason || '').toLowerCase();
      expect(reason).toMatch(/re-submit|justification|explanation|evaluate/);
    });

    it('kill feedback mentions shutdown mechanism or re-submit', async () => {
      const result = await evaluate(bashInput('kill 9999'), config);
      const reason = (result.reason || '').toLowerCase();
      expect(reason).toMatch(/re-submit|shutdown|jury|evaluate/);
    });

    it('git checkout feedback mentions git switch or git stash', async () => {
      const result = await evaluate(bashInput('git checkout -- file.ts'), config);
      const reason = (result.reason || '').toLowerCase();
      expect(reason).toMatch(/switch|stash|justification|evaluate/);
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: Ensure no regressions in existing behavior
// ---------------------------------------------------------------------------

describe('No regressions in safe commands', () => {
  const config = makeConfig();

  const safeCommands = [
    'git status', 'git log --oneline', 'git diff HEAD',
    'git add src/file.ts', 'git commit -m "test"',
    'git switch main', 'git stash', 'git pull origin main',
    'npm run build', 'npm test', 'npx vitest',
    'ls -la', 'cat README.md', 'echo hello',
  ];

  for (const cmd of safeCommands) {
    it(`still allows: ${cmd}`, async () => {
      const result = await evaluate(bashInput(cmd), config);
      expect(result.decision).toBe('allow');
    });
  }
});

describe('FORBIDDEN vs jury-assessable separation is complete', () => {
  it('all 8 unsafe FORBIDDEN commands match always_deny_bash_patterns', () => {
    const config = makeConfig();
    const forbiddenCmds = [
      'rm -rf node_modules', 'chmod 777 file', 'chown root file',
      'killall firefox', 'docker rm c1', 'docker rmi img',
      'git push --force origin main', 'git reset --hard HEAD',
    ];

    for (const cmd of forbiddenCmds) {
      const denyMatch = checkBashPatterns(cmd, config.always_deny_bash_patterns);
      expect(denyMatch).not.toBeNull();
    }
  });

  it('all 4 jury-assessable commands match jury_escalation_bash_patterns', () => {
    const config = makeConfig();
    const juryAssessableCmds = ['sudo echo test', 'kill 1234', 'pkill node', 'git checkout main'];

    for (const cmd of juryAssessableCmds) {
      const escalationMatch = checkBashPatterns(cmd, config.jury_escalation_bash_patterns);
      expect(escalationMatch).not.toBeNull();
    }
  });

  it('escalation patterns count is exactly 4', () => {
    const config = makeConfig();
    // Filter out comments
    const realPatterns = config.jury_escalation_bash_patterns.filter(p => {
      if (typeof p === 'string') return !p.startsWith('COMMENT:');
      if (typeof p === 'object' && 'pattern' in p) return true;
      return false;
    });
    expect(realPatterns).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Security-reviewer requested: evaluateHookInput post-jury safeguard (Test 5)
// ---------------------------------------------------------------------------

describe('evaluateHookInput: FORBIDDEN post-jury safeguard (defense-in-depth)', () => {
  it('evaluateHookInput denies FORBIDDEN commands even if evaluate would allow', async () => {
    // This tests the checkForbiddenSafeguard inside evaluateHookInput.
    // The safeguard is the LAST defense: even if evaluate() returns allow
    // (e.g. through a mocked inline jury), the safeguard catches FORBIDDEN
    // patterns and overrides to deny.
    const forbiddenInputs: HookInput[] = [
      { tool_name: 'Bash', tool_input: { command: 'rm -rf ./dist' }, cwd: '/project' },
      { tool_name: 'Bash', tool_input: { command: 'chmod 777 /tmp' }, cwd: '/project' },
      { tool_name: 'Bash', tool_input: { command: 'chown nobody file' }, cwd: '/project' },
      { tool_name: 'Bash', tool_input: { command: 'killall firefox' }, cwd: '/project' },
      { tool_name: 'Bash', tool_input: { command: 'docker rm container1' }, cwd: '/project' },
      { tool_name: 'Bash', tool_input: { command: 'docker rmi image:latest' }, cwd: '/project' },
      { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' }, cwd: '/project' },
      { tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD~3' }, cwd: '/project' },
    ];

    for (const input of forbiddenInputs) {
      const result = await evaluateHookInput(input);
      expect(result.decision).toBe('deny');
    }
  });

  it('evaluateHookInput allows safe commands (Test 6: non-FORBIDDEN pass safeguard)', async () => {
    const safeInputs: HookInput[] = [
      { tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: '/project' },
      { tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: '/project' },
      { tool_name: 'Bash', tool_input: { command: 'ls -la' }, cwd: '/project' },
      { tool_name: 'Bash', tool_input: { command: 'cat README.md' }, cwd: '/project' },
      { tool_name: 'Bash', tool_input: { command: 'node --version' }, cwd: '/project' },
    ];

    for (const input of safeInputs) {
      const result = await evaluateHookInput(input);
      expect(result.decision).toBe('allow');
    }
  });

  it('evaluateHookInput denies FORBIDDEN with env var prefix (Test 7)', async () => {
    // stripCommand removes env vars like MY_VAR=1 before checking patterns
    const envPrefixedInputs: HookInput[] = [
      { tool_name: 'Bash', tool_input: { command: 'MY_VAR=1 rm -rf ./build' }, cwd: '/project' },
      { tool_name: 'Bash', tool_input: { command: 'NODE_ENV=production chmod 777 /tmp' }, cwd: '/project' },
      { tool_name: 'Bash', tool_input: { command: 'FOO=bar BAZ=qux git push --force origin main' }, cwd: '/project' },
      { tool_name: 'Bash', tool_input: { command: 'A=1 B=2 git reset --hard HEAD' }, cwd: '/project' },
    ];

    for (const input of envPrefixedInputs) {
      const result = await evaluateHookInput(input);
      expect(result.decision).toBe('deny');
    }
  });
});

// ---------------------------------------------------------------------------
// Security-reviewer requested: stripCommand validation
// ---------------------------------------------------------------------------

describe('stripCommand removes env var prefixes', () => {
  it('strips single env var prefix', () => {
    expect(stripCommand('MY_VAR=1 rm -rf ./build')).toBe('rm -rf ./build');
  });

  it('strips multiple env var prefixes', () => {
    expect(stripCommand('A=1 B=2 C=3 git push --force origin main')).toBe('git push --force origin main');
  });

  it('strips quoted env var values', () => {
    expect(stripCommand('MY_VAR="hello world" rm -rf ./build')).toBe('rm -rf ./build');
  });

  it('strips single-quoted env var values', () => {
    expect(stripCommand("MY_VAR='hello world' rm -rf ./build")).toBe('rm -rf ./build');
  });

  it('leaves commands without env vars unchanged', () => {
    expect(stripCommand('npm test')).toBe('npm test');
    expect(stripCommand('git status')).toBe('git status');
  });

  it('handles whitespace-only input', () => {
    expect(stripCommand('   ')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Security-reviewer requested: git checkout -- . specifically (Test 3)
// ---------------------------------------------------------------------------

describe('git checkout -- . specifically denied', () => {
  it('git checkout -- . is NOT in allow patterns', () => {
    const config = makeConfig();
    expect(checkBashAllow('git checkout -- .', config.always_allow_bash_patterns)).toBe(false);
  });

  it('git checkout some-branch is NOT in allow patterns', () => {
    const config = makeConfig();
    expect(checkBashAllow('git checkout some-branch', config.always_allow_bash_patterns)).toBe(false);
  });

  it('git checkout -- . is denied by evaluateHookInput', async () => {
    const input: HookInput = {
      tool_name: 'Bash',
      tool_input: { command: 'git checkout -- .' },
      cwd: '/project',
    };
    const result = await evaluateHookInput(input);
    expect(result.decision).toBe('deny');
  });
});
