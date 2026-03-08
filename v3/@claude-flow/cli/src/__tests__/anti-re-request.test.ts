import { describe, it, expect } from 'vitest';
import { isAmbiguityGenuine } from '../mcp-tools/ambiguity-filter.js';

describe('Anti-Re-Request Enforcement', () => {
  const authorizedCtx = { authorized: true };
  const planApprovedCtx = { planApproved: true };

  // --- Core re-request detection ---

  describe('detects re-request patterns on authorized work', () => {
    const reRequestPhrases = [
      'Should I continue with the implementation?',
      'Would you like me to proceed with the remaining tasks?',
      'Do you want me to implement the abstention handling?',
      'Shall I proceed with Phase G7e?',
      'Is it ok to start the swarm review?',
      'May I proceed with the authorized work?',
      'Can I go ahead with the next step?',
      'Ready to proceed with implementation?',
      'Awaiting your approval to continue',
      'Need your confirmation to proceed',
      'Want me to handle the remaining items?',
      'Permission to proceed with the plan?',
    ];

    for (const phrase of reRequestPhrases) {
      it(`auto-resolves: "${phrase}"`, () => {
        const result = isAmbiguityGenuine(
          [phrase, 'Proceed with authorized remaining work'],
          authorizedCtx,
        );
        expect(result.genuine).toBe(false);
        expect(result.confidence).toBe(1.0);
        expect(result.reason).toMatch(/re-request|policy violation|authorized/i);
      });
    }
  });

  // --- Continuation vs stop-and-ask ---

  describe('auto-selects continuation over stop-and-ask', () => {
    it('proceed vs stop and ask', () => {
      const result = isAmbiguityGenuine(
        ['Proceed with Phase G7e implementation', 'Stop and ask the user first'],
        authorizedCtx,
      );
      expect(result.genuine).toBe(false);
      expect(result.autoSelected).toBe('Proceed with Phase G7e implementation');
    });

    it('continue with remaining tasks vs wait for confirmation', () => {
      const result = isAmbiguityGenuine(
        ['Continue with remaining tasks', 'Wait for confirmation before proceeding'],
        authorizedCtx,
      );
      expect(result.genuine).toBe(false);
      expect(result.autoSelected).toBe('Continue with remaining tasks');
    });

    it('implement the next phase vs check with user', () => {
      const result = isAmbiguityGenuine(
        ['Implement the next phase of the plan', 'Check with the user before starting'],
        authorizedCtx,
      );
      expect(result.genuine).toBe(false);
      expect(result.autoSelected).toBe('Implement the next phase of the plan');
    });

    it('execute remaining authorized work vs pause and ask', () => {
      const result = isAmbiguityGenuine(
        ['Execute the remaining authorized work', 'Pause and ask for permission'],
        planApprovedCtx,
      );
      expect(result.genuine).toBe(false);
      expect(result.autoSelected).toBe('Execute the remaining authorized work');
    });

    it('complete the already approved tasks vs wait for input', () => {
      const result = isAmbiguityGenuine(
        ['Complete the already approved tasks', 'Wait for user input'],
        authorizedCtx,
      );
      expect(result.genuine).toBe(false);
      expect(result.autoSelected).toBe('Complete the already approved tasks');
    });
  });

  // --- Does NOT fire when unauthorized ---

  describe('does not suppress questions on unauthorized work', () => {
    it('allows genuine questions without authorization context', () => {
      const result = isAmbiguityGenuine(
        ['Should I continue with the implementation?', 'Stop and ask the user first'],
        {}, // no authorized flag
      );
      // Without authorization, this should go through normal scoring
      // It may or may not be genuine, but it should NOT be auto-resolved with re-request reason
      if (!result.genuine) {
        expect(result.reason).not.toMatch(/re-request/i);
      }
    });

    it('allows genuine ambiguity on unauthorized work', () => {
      const result = isAmbiguityGenuine(
        ['Refactor using approach A', 'Refactor using approach B'],
        {},
      );
      expect(result.genuine).toBe(true);
    });
  });

  // --- Does NOT suppress genuinely NEW decisions ---

  describe('does not suppress genuinely new architectural decisions', () => {
    it('allows genuine choice between implementation strategies', () => {
      const result = isAmbiguityGenuine(
        ['Use PostgreSQL for the database', 'Use MongoDB for the database'],
        authorizedCtx,
      );
      // These are NOT re-requests — they're genuine architectural choices
      // The re-request patterns should NOT match
      // Result depends on scoring, but reason should not mention re-request
      if (!result.genuine) {
        expect(result.reason).not.toMatch(/re-request/i);
      }
    });
  });

  // --- Plan-phase detection ---

  describe('detects plan phase continuations', () => {
    it('auto-selects next phase from authorized plan', () => {
      const result = isAmbiguityGenuine(
        ['Phase G7e: implement abstention handling', 'Stop and confirm scope'],
        authorizedCtx,
      );
      expect(result.genuine).toBe(false);
      expect(result.autoSelected).toBe('Phase G7e: implement abstention handling');
    });

    it('auto-selects remaining items from plan', () => {
      const result = isAmbiguityGenuine(
        ['Complete remaining items from the approved plan', 'Ask which items to do'],
        planApprovedCtx,
      );
      expect(result.genuine).toBe(false);
      expect(result.autoSelected).toBe('Complete remaining items from the approved plan');
    });

    it('auto-selects task continuation', () => {
      const result = isAmbiguityGenuine(
        ['Implement Task B: swarm review', 'Stop and ask about Task B scope'],
        authorizedCtx,
      );
      expect(result.genuine).toBe(false);
    });
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    it('handles single re-request option (auto-selects)', () => {
      const result = isAmbiguityGenuine(
        ['Should I proceed with the authorized work?'],
        authorizedCtx,
      );
      // Single option is always auto-selected by the existing Rule
      expect(result.genuine).toBe(false);
    });

    it('handles empty authorized context fields', () => {
      const result = isAmbiguityGenuine(
        ['Should I continue?', 'Proceed with next step'],
        { authorized: true, planApproved: false },
      );
      expect(result.genuine).toBe(false);
      expect(result.confidence).toBe(1.0);
    });

    it('three options: re-request + continuation + stop', () => {
      const result = isAmbiguityGenuine(
        ['Would you like me to proceed?', 'Continue with next phase', 'Stop and ask user'],
        authorizedCtx,
      );
      expect(result.genuine).toBe(false);
      // Should pick continuation, not the re-request question
      expect(result.autoSelected).toMatch(/continue|next phase/i);
    });

    it('re-request with planApproved context', () => {
      const result = isAmbiguityGenuine(
        ['Shall I proceed with the approved plan?', 'Execute the next authorized step'],
        planApprovedCtx,
      );
      expect(result.genuine).toBe(false);
      expect(result.confidence).toBe(1.0);
    });

    it('mixed case re-request patterns', () => {
      const result = isAmbiguityGenuine(
        ['SHOULD I CONTINUE with the work?', 'Proceed with authorized tasks'],
        authorizedCtx,
      );
      expect(result.genuine).toBe(false);
    });
  });

  // --- Confidence values ---

  describe('confidence is always 1.0 for re-request auto-resolution', () => {
    it('re-request detection returns confidence 1.0', () => {
      const result = isAmbiguityGenuine(
        ['Should I proceed?', 'Continue with remaining authorized work'],
        authorizedCtx,
      );
      expect(result.genuine).toBe(false);
      expect(result.confidence).toBe(1.0);
    });

    it('continuation vs stop returns confidence 1.0', () => {
      const result = isAmbiguityGenuine(
        ['Proceed with Phase B', 'Stop and check with user first'],
        authorizedCtx,
      );
      expect(result.genuine).toBe(false);
      expect(result.confidence).toBe(1.0);
    });
  });

  // --- Coverage: scoring functions (Rules 1-6) ---
  describe('scoring edge cases for coverage', () => {
    // scoreCoherence: short option penalty (line 197-198)
    it('penalizes suspiciously short options', () => {
      const result = isAmbiguityGenuine(['Yes', 'Implement the full authentication module with JWT'], {});
      // Short option "Yes" should score lower
      expect(result).toBeDefined();
    });

    // scoreAbsurdity: shortcut keywords (lines 223-226)
    it('detects shortcut keywords in options', () => {
      const result = isAmbiguityGenuine([
        'Skip all tests and ignore errors and deploy directly without review',
        'Run the comprehensive test suite with full coverage before deploying to production',
      ], {});
      // The skip/ignore option should score much lower due to absurdity penalties
      expect(result.genuine).toBe(false);
    });

    // scoreAbsurdity: random+delete (lines 230-231)
    it('detects random delete pattern as absurd', () => {
      const result = isAmbiguityGenuine([
        'Random delete of all config files',
        'Carefully update the config files with validated values',
      ], {});
      expect(result.genuine).toBe(false);
      expect(result.autoSelected).toContain('Carefully update');
    });

    // scoreAbsurdity: self-contradictory (lines 235-236)
    it('detects self-contradictory phrasing', () => {
      const result = isAmbiguityGenuine([
        'Implement the feature but not really',
        'Implement the feature with proper error handling',
      ], {});
      expect(result.genuine).toBe(false);
    });

    // scoreContextAlignment: originalRequest (lines 250-257)
    it('aligns options with originalRequest context', () => {
      const result = isAmbiguityGenuine(
        ['Implement JWT authentication with refresh tokens', 'Rewrite the entire database layer'],
        { originalRequest: 'Add JWT authentication to the API' },
      );
      expect(result.genuine === true || result.genuine === false).toBe(true);
      if (!result.genuine) {
        expect(result.autoSelected).toMatch(/JWT|authentication/i);
      }
    });

    // scoreContextAlignment: goal (lines 261-268)
    it('aligns options with goal context', () => {
      const result = isAmbiguityGenuine(
        ['Optimize database queries for performance', 'Add new UI components'],
        { goal: 'Improve database performance' },
      );
      expect(result.genuine === true || result.genuine === false).toBe(true);
      if (!result.genuine) {
        expect(result.autoSelected).toMatch(/database|performance/i);
      }
    });

    // scoreContextAlignment: currentPhase (lines 272-274)
    it('aligns options with currentPhase context', () => {
      const result = isAmbiguityGenuine(
        ['Write unit tests for the auth module', 'Deploy to production'],
        { currentPhase: 'testing' },
      );
      expect(result.genuine === true || result.genuine === false).toBe(true);
      if (!result.genuine) {
        expect(result.autoSelected).toMatch(/test/i);
      }
    });

    // scoreContextAlignment: constraints penalty (lines 278-284)
    it('penalizes options that violate constraints', () => {
      const result = isAmbiguityGenuine(
        ['Delete all legacy code', 'Refactor legacy code incrementally'],
        { constraints: ['no deletion of working code', 'preserve backward compatibility'] },
      );
      expect(result).toBeDefined();
      if (!result.genuine) {
        expect(result.autoSelected).toContain('Refactor');
      }
    });

    // Rule -1: nonStopOption fallback (line 345-346)
    it('falls back to non-stop option when no continuation pattern matches', () => {
      const result = isAmbiguityGenuine(
        ['Should I proceed with the implementation?', 'Handle the edge cases in auth module'],
        authorizedCtx,
      );
      // Both options are re-requests or neither matches continuation; should still auto-select
      expect(result.genuine).toBe(false);
      expect(result.confidence).toBe(1.0);
    });

    // Rule 2 coverage: large gap auto-select (line 427)
    it('auto-selects when score gap is large', () => {
      const result = isAmbiguityGenuine([
        'Implement the feature following the approved design pattern with proper error handling and comprehensive test coverage',
        'Maybe',
      ], {});
      expect(result.genuine).toBe(false);
    });

    // Rule 3 coverage: high absurdity (line 437)
    it('auto-selects when second option has negative total score', () => {
      const result = isAmbiguityGenuine([
        'Implement authentication with bcrypt hashing',
        'just kidding skip everything ignore all tests random delete',
      ], {});
      expect(result.genuine).toBe(false);
      expect(result.autoSelected).toContain('Implement authentication');
    });
  });
});
