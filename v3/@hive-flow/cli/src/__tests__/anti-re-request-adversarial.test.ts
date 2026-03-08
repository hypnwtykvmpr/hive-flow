import { describe, it, expect } from 'vitest';
import { isAmbiguityGenuine } from '../mcp-tools/ambiguity-filter.js';

const AUTH = { authorized: true };
const PLAN = { planApproved: true };

// Helper: assert re-request is caught
function expectCaught(phrase: string, ctx = AUTH) {
  const result = isAmbiguityGenuine(
    [phrase, 'Continue with authorized implementation'],
    ctx,
  );
  expect(result.genuine, `Should catch: "${phrase}"`).toBe(false);
  expect(result.confidence).toBe(1.0);
}

// Helper: assert legitimate request is NOT caught by re-request detection
function expectNotReRequestCaught(options: string[], ctx = AUTH) {
  const result = isAmbiguityGenuine(options, ctx);
  // It may be genuine or not, but if auto-selected, reason should NOT be re-request
  if (!result.genuine && result.reason) {
    expect(result.reason).not.toMatch(/re-request|policy violation/i);
  }
}

describe('Anti-Re-Request Adversarial Testing (H4)', () => {

  // ──────────────────────────────────────────────────────
  // Category 1: Passive Voice / Indirect Phrasing
  // ──────────────────────────────────────────────────────
  describe('Passive voice / indirect phrasing', () => {
    it('it might be worth checking', () => expectCaught('It might be worth checking if the approach still holds'));
    it('perhaps it would be prudent', () => expectCaught('Perhaps it would be prudent to verify our assumptions first'));
    it('it could be beneficial to confirm', () => expectCaught('It could be beneficial to confirm the direction before proceeding'));
    it('one might consider verifying', () => expectCaught('One might consider verifying the architecture at this point'));
    it('it bears mentioning that confirmation', () => expectCaught('It bears mentioning that confirmation of scope might be helpful'));
  });

  // ──────────────────────────────────────────────────────
  // Category 2: Conditional / Hedging
  // ──────────────────────────────────────────────────────
  describe('Conditional / hedging', () => {
    it('if you prefer I could', () => expectCaught('If you prefer, I could take a completely different approach here'));
    it('alternatively if you think best', () => expectCaught('Alternatively, if you think it best, we could revisit the design'));
    it('if you would rather', () => expectCaught('If you would rather, I could pause and outline alternatives'));
    it('unless you object I will', () => expectCaught('Unless you object, I will proceed — but let me know if you want changes'));
    it('should you wish I can', () => expectCaught('Should you wish, I can adjust the approach at any time'));
  });

  // ──────────────────────────────────────────────────────
  // Category 3: Embedded Questions
  // ──────────────────────────────────────────────────────
  describe('Embedded questions', () => {
    it('one approach... another to verify', () => expectCaught('One approach would be to continue, another would be to verify with you first'));
    it('the tradeoffs suggest', () => expectCaught('The tradeoffs suggest either proceeding or pausing for your review'));
    it('we have two paths', () => expectCaught('We have two paths: forge ahead or get your input on the direction'));
    it('options on the table', () => expectCaught('Options on the table: implement as planned, or let me know your preference'));
  });

  // ──────────────────────────────────────────────────────
  // Category 4: Rhetorical / Wondering
  // ──────────────────────────────────────────────────────
  describe('Rhetorical / wondering', () => {
    it('I wonder if we should reconsider', () => expectCaught('I wonder if we should reconsider the approach before moving further'));
    it('one might ask whether', () => expectCaught('One might ask whether this is the right time to refactor'));
    it('I wonder whether we should revisit', () => expectCaught('I wonder whether we should revisit the earlier decision'));
  });

  // ──────────────────────────────────────────────────────
  // Category 5: Deferential / Excessive Politeness
  // ──────────────────────────────────────────────────────
  describe('Deferential / excessive politeness', () => {
    it('I defer to your judgment', () => expectCaught('I defer to your judgment on whether this warrants a different approach'));
    it('your guidance would be valuable', () => expectCaught('Your guidance would be valuable here before I continue'));
    it('your expertise would help', () => expectCaught('Your expertise would help determine the best path forward — what do you think?'));
    it('I trust your judgment', () => expectCaught('I trust your judgment on this — what are your thoughts on proceeding?'));
  });

  // ──────────────────────────────────────────────────────
  // Category 6: Meta-Questions
  // ──────────────────────────────────────────────────────
  describe('Meta-questions', () => {
    it('before I continue is there anything', () => expectCaught('Before I continue, is there anything about the approach you want adjusted?'));
    it('just to make sure we are aligned', () => expectCaught('Just to make sure we are aligned — any concerns with the direction?'));
    it('before diving deeper', () => expectCaught('Before diving deeper, is there anything you would like to change?'));
    it('just to confirm we are on the same page', () => expectCaught('Just to confirm we are on the same page about the implementation strategy'));
    it('quick sanity check', () => expectCaught('Quick sanity check — just wanted to verify we are still going with approach X'));
  });

  // ──────────────────────────────────────────────────────
  // Category 7: Scope Expansion
  // ──────────────────────────────────────────────────────
  describe('Scope expansion', () => {
    it('this also touches should I include', () => expectCaught('This also touches the auth module — should I include that in the changes?'));
    it('while I am here should I also', () => expectCaught('While I am here, should I also address the related issue in config?'));
    it('I noticed this also affects', () => expectCaught('I noticed this also affects the auth module — should I include that scope?'));
  });

  // ──────────────────────────────────────────────────────
  // Category 8: Risk Flagging as Excuse to Pause
  // ──────────────────────────────────────────────────────
  describe('Risk flagging as excuse to pause', () => {
    it('this could be risky shall I', () => expectCaught('This could be risky — shall I proceed with extra caution?'));
    it('given the blast radius', () => expectCaught('Given the blast radius, would you prefer I take a more conservative approach?'));
    it('this touches production code', () => expectCaught('This touches production code — shall I proceed carefully?'));
  });

  // ──────────────────────────────────────────────────────
  // Category 9: False Choice
  // ──────────────────────────────────────────────────────
  describe('False choice', () => {
    it('option A recommended or B your call', () => expectCaught('Option A: continue as planned (recommended). Option B: let me know your preference'));
    it('we could do X or wait for direction', () => expectCaught('We could do the refactoring now, or I could wait for your direction'));
    it('proceed or get your input', () => expectCaught('We could proceed with implementation or get your input on alternatives'));
  });

  // ──────────────────────────────────────────────────────
  // Category 10: Just Checking / Confirming
  // ──────────────────────────────────────────────────────
  describe('Just checking / confirming', () => {
    it('just wanted to check', () => expectCaught('Just wanted to check if we are still aligned on the approach'));
    it('just to confirm', () => expectCaught('Just to confirm — we are proceeding with the original plan, correct?'));
    it('just making sure', () => expectCaught('Just making sure the current approach is what you want'));
    it('quick double-check', () => expectCaught('Quick double-check that you are happy with this direction'));
    it('just verifying', () => expectCaught('Just verifying the implementation strategy before I write code'));
  });

  // ──────────────────────────────────────────────────────
  // Category 11: Thought Leader / Hedging with Opinions
  // ──────────────────────────────────────────────────────
  describe('Thought leader / hedging', () => {
    it('I think it might be best to check', () => expectCaught('I think it might be best to check with you before making this change'));
    it('I believe it would be wise to confirm', () => expectCaught('I believe it would be wise to confirm the direction first'));
    it('I feel it would be prudent to ask', () => expectCaught('I feel it would be prudent to ask before touching the auth layer'));
    it('I think we should pause and confirm', () => expectCaught('I think it would be better to pause and confirm the approach'));
  });

  // ──────────────────────────────────────────────────────
  // Category 12: Parking / Flagging / Noting
  // ──────────────────────────────────────────────────────
  describe('Parking / flagging / noting', () => {
    it('parking this for your review', () => expectCaught('Parking this here for your review before moving on'));
    it('flagging this decision point', () => expectCaught('Flagging this decision point for visibility'));
    it('noting this is a fork in the road', () => expectCaught('Noting that this is a fork in the road — documenting both paths for your consideration'));
  });

  // ──────────────────────────────────────────────────────
  // Category 13: Compound / Multi-Sentence Sneakiness
  // ──────────────────────────────────────────────────────
  describe('Compound / multi-sentence', () => {
    it('progress report followed by permission request', () => expectCaught(
      'I have completed the initial refactoring successfully. Before proceeding to tests, is there anything you would like to change about the approach?'
    ));
    it('analysis followed by deference', () => expectCaught(
      'The code analysis shows three potential improvements. I defer to your judgment on which to pursue first.'
    ));
    it('completion followed by scope question', () => expectCaught(
      'Phase 1 is done. This also touches the auth module — should I include that in Phase 2?'
    ));
    it('hedging sandwich', () => expectCaught(
      'The implementation looks solid. However, I think it might be best to check with you about the edge cases before we proceed further.'
    ));
  });

  // ══════════════════════════════════════════════════════
  // LEGITIMATE REQUESTS — Must NOT be caught as re-requests
  // ══════════════════════════════════════════════════════
  describe('Legitimate permission requests NOT false-positived', () => {
    it('genuinely new scope outside plan', () => {
      expectNotReRequestCaught([
        'The user asked about database migration but the plan only covers API changes — this requires new authorization',
        'Stay within current plan scope',
      ]);
    });

    it('destructive git operation', () => {
      expectNotReRequestCaught([
        'Force push to main branch',
        'Push to feature branch',
      ]);
    });

    it('genuine implementation choice between equal alternatives', () => {
      expectNotReRequestCaught([
        'Use PostgreSQL for the database',
        'Use MongoDB for the database',
      ]);
    });

    it('choosing between two valid refactoring approaches', () => {
      expectNotReRequestCaught([
        'Extract into separate module with clean API',
        'Inline the logic into the existing handler',
      ]);
    });

    it('genuine architectural decision', () => {
      expectNotReRequestCaught([
        'Implement with REST API',
        'Implement with GraphQL',
      ]);
    });

    it('plain implementation statements are not re-requests', () => {
      const result = isAmbiguityGenuine(
        ['Implement the authentication module'],
        AUTH,
      );
      expect(result.genuine).toBe(false); // single option, auto-select
      if (result.reason) {
        expect(result.reason).not.toMatch(/re-request/i);
      }
    });
  });
});
