import { describe, it, expect } from 'vitest';
import {
  analyze,
  benchmark,
  autoOptimize,
  formatReport,
  formatBenchmark,
} from '../src/analyzer.js';
import type {
  AnalysisResult,
  BenchmarkResult,
} from '../src/analyzer.js';

// ============================================================================
// Test Fixtures
// ============================================================================

const MINIMAL_CLAUDE_MD = `# My Project

Some basic info about the project.
`;

const WELL_STRUCTURED_CLAUDE_MD = `# My Project

This project uses TypeScript and follows strict conventions.

## Build & Test

Build: \`npm run build\`
Test: \`npm test\`
Lint: \`npm run lint\`

Run tests before committing. Run the build to catch type errors.

## Coding Standards

- NEVER use \`any\` type — use \`unknown\` when type is truly unknown
- ALWAYS add JSDoc to public functions
- ALWAYS handle errors explicitly — no silent catches
- Prefer composition over inheritance
- Use readonly arrays and objects where possible
- No console.log in production code

## Architecture

This project follows a layered architecture:

- \`src/\` — Source code
- \`tests/\` — Test files
- \`docs/\` — Documentation

Use barrel exports from each module.

## Security

- NEVER commit secrets, API keys, or credentials
- NEVER run destructive commands without confirmation
- Validate all external input at system boundaries
- Use parameterized queries for database operations
- Avoid eval() and dynamic code execution

## Git Practices

- MUST write descriptive commit messages
- MUST create a branch for each feature
- Run tests before creating a pull request
- Keep commits focused and atomic

## Domain Rules

- All API responses must include a requestId for tracing
- Database migrations must be backward-compatible
- Cache keys must include a version prefix
- Rate limiting is required on all public endpoints
`;

const POOR_CLAUDE_MD = `some rules
dont do bad stuff
be good
`;

const LOCAL_OVERLAY = `# Local Dev

- My API: http://localhost:3001
- Test DB: postgres://localhost:5432/mydb_test

## Preferences

- Prefer verbose error messages
- Show git diffs before committing
`;

// ============================================================================
// analyze()
// ============================================================================

describe('analyze', () => {
  describe('compositeScore', () => {
    it('returns a score between 0 and 100', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      expect(result.compositeScore).toBeGreaterThanOrEqual(0);
      expect(result.compositeScore).toBeLessThanOrEqual(100);
    });

    it('scores a well-structured file higher than a poor one', () => {
      const good = analyze(WELL_STRUCTURED_CLAUDE_MD);
      const bad = analyze(POOR_CLAUDE_MD);
      expect(good.compositeScore).toBeGreaterThan(bad.compositeScore);
    });

    it('scores a minimal file in the middle range', () => {
      const result = analyze(MINIMAL_CLAUDE_MD);
      expect(result.compositeScore).toBeLessThan(analyze(WELL_STRUCTURED_CLAUDE_MD).compositeScore);
      expect(result.compositeScore).toBeGreaterThan(analyze(POOR_CLAUDE_MD).compositeScore);
    });
  });

  describe('grade', () => {
    it('assigns A grade for score >= 90', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      if (result.compositeScore >= 90) {
        expect(result.grade).toBe('A');
      }
    });

    it('assigns F grade for very poor content', () => {
      const result = analyze(POOR_CLAUDE_MD);
      expect(result.grade).toBe('F');
    });

    it('grade is one of A, B, C, D, F', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      expect(['A', 'B', 'C', 'D', 'F']).toContain(result.grade);
    });
  });

  describe('dimensions', () => {
    it('returns exactly 6 dimensions', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      expect(result.dimensions).toHaveLength(6);
    });

    it('includes Structure, Coverage, Enforceability, Compilability, Clarity, Completeness', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      const names = result.dimensions.map(d => d.name);
      expect(names).toContain('Structure');
      expect(names).toContain('Coverage');
      expect(names).toContain('Enforceability');
      expect(names).toContain('Compilability');
      expect(names).toContain('Clarity');
      expect(names).toContain('Completeness');
    });

    it('each dimension has score, max, weight, and findings', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      for (const d of result.dimensions) {
        expect(d.score).toBeGreaterThanOrEqual(0);
        expect(d.max).toBe(100);
        expect(d.weight).toBeGreaterThan(0);
        expect(d.weight).toBeLessThanOrEqual(1);
        expect(Array.isArray(d.findings)).toBe(true);
      }
    });

    it('weights sum to 1.0', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      const totalWeight = result.dimensions.reduce((sum, d) => sum + d.weight, 0);
      expect(totalWeight).toBeCloseTo(1.0);
    });

    it('Structure scores high for well-organized content', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      const structure = result.dimensions.find(d => d.name === 'Structure')!;
      expect(structure.score).toBeGreaterThanOrEqual(50);
    });

    it('Coverage scores high when build, test, security, architecture present', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      const coverage = result.dimensions.find(d => d.name === 'Coverage')!;
      expect(coverage.score).toBeGreaterThanOrEqual(80);
    });

    it('Enforceability scores high with NEVER/ALWAYS/MUST statements', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      const enforceability = result.dimensions.find(d => d.name === 'Enforceability')!;
      expect(enforceability.score).toBeGreaterThanOrEqual(50);
    });

    it('Compilability scores high for content that compiles to a valid bundle', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      const compilability = result.dimensions.find(d => d.name === 'Compilability')!;
      expect(compilability.score).toBeGreaterThanOrEqual(50);
    });

    it('Clarity scores based on code blocks, tool mentions, and formatting', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      const clarity = result.dimensions.find(d => d.name === 'Clarity')!;
      // Fixture has inline code + tool mentions (npm, git) but no fenced code blocks or tables
      expect(clarity.score).toBeGreaterThanOrEqual(30);
    });

    it('Completeness scores low when missing many topics', () => {
      const result = analyze(POOR_CLAUDE_MD);
      const completeness = result.dimensions.find(d => d.name === 'Completeness')!;
      expect(completeness.score).toBeLessThanOrEqual(30);
    });
  });

  describe('metrics', () => {
    it('counts total lines correctly', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      expect(result.metrics.totalLines).toBeGreaterThan(10);
    });

    it('counts content lines (non-blank)', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      expect(result.metrics.contentLines).toBeLessThan(result.metrics.totalLines);
      expect(result.metrics.contentLines).toBeGreaterThan(0);
    });

    it('counts headings', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      expect(result.metrics.headingCount).toBeGreaterThanOrEqual(6); // H1 + H2s
    });

    it('counts H2 sections', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      expect(result.metrics.sectionCount).toBeGreaterThanOrEqual(5);
    });

    it('estimates constitution lines', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      expect(result.metrics.constitutionLines).toBeGreaterThan(0);
      expect(result.metrics.constitutionLines).toBeLessThan(result.metrics.totalLines);
    });

    it('counts rule statements', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      expect(result.metrics.ruleCount).toBeGreaterThan(5);
    });

    it('counts code blocks', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      expect(result.metrics.codeBlockCount).toBeGreaterThanOrEqual(0);
    });

    it('counts enforcement statements', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      expect(result.metrics.enforcementStatements).toBeGreaterThan(3);
    });

    it('detects build command', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      expect(result.metrics.hasBuildCommand).toBe(true);
    });

    it('detects test command', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      expect(result.metrics.hasTestCommand).toBe(true);
    });

    it('detects security section', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      expect(result.metrics.hasSecuritySection).toBe(true);
    });

    it('detects architecture section', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      expect(result.metrics.hasArchitectureSection).toBe(true);
    });

    it('detects @import directives', () => {
      const withImport = WELL_STRUCTURED_CLAUDE_MD + '\n@~/.claude/my_instructions.md\n';
      const result = analyze(withImport);
      expect(result.metrics.hasImports).toBe(true);
    });

    it('reports no imports when absent', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      expect(result.metrics.hasImports).toBe(false);
    });

    it('counts estimated shards', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      expect(result.metrics.estimatedShards).toBeGreaterThanOrEqual(5);
    });
  });

  describe('suggestions', () => {
    it('returns actionable suggestions for poor content', () => {
      const result = analyze(POOR_CLAUDE_MD);
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it('returns fewer suggestions for well-structured content', () => {
      const good = analyze(WELL_STRUCTURED_CLAUDE_MD);
      const bad = analyze(POOR_CLAUDE_MD);
      expect(good.suggestions.length).toBeLessThanOrEqual(bad.suggestions.length);
    });

    it('each suggestion has action, priority, dimension, description', () => {
      const result = analyze(POOR_CLAUDE_MD);
      for (const s of result.suggestions) {
        expect(['add', 'remove', 'restructure', 'split', 'strengthen']).toContain(s.action);
        expect(['high', 'medium', 'low']).toContain(s.priority);
        expect(s.dimension).toBeTruthy();
        expect(s.description).toBeTruthy();
        expect(s.estimatedImprovement).toBeGreaterThan(0);
      }
    });

    it('high-priority suggestions include patches when possible', () => {
      const result = analyze(POOR_CLAUDE_MD);
      const highPriority = result.suggestions.filter(s => s.priority === 'high');
      const withPatch = highPriority.filter(s => s.patch);
      expect(withPatch.length).toBeGreaterThan(0);
    });

    it('suggestions are sorted by estimated improvement descending', () => {
      const result = analyze(POOR_CLAUDE_MD);
      for (let i = 1; i < result.suggestions.length; i++) {
        expect(result.suggestions[i].estimatedImprovement)
          .toBeLessThanOrEqual(result.suggestions[i - 1].estimatedImprovement);
      }
    });
  });

  describe('local content overlay', () => {
    it('accepts optional local content', () => {
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD, LOCAL_OVERLAY);
      expect(result.compositeScore).toBeGreaterThan(0);
    });

    it('compilability dimension uses local overlay', () => {
      const withLocal = analyze(WELL_STRUCTURED_CLAUDE_MD, LOCAL_OVERLAY);
      const withoutLocal = analyze(WELL_STRUCTURED_CLAUDE_MD);
      // Both should compile; scores may differ slightly
      const compWithLocal = withLocal.dimensions.find(d => d.name === 'Compilability')!;
      const compWithoutLocal = withoutLocal.dimensions.find(d => d.name === 'Compilability')!;
      expect(compWithLocal.score).toBeGreaterThanOrEqual(30); // compiles
      expect(compWithoutLocal.score).toBeGreaterThanOrEqual(30); // compiles
    });
  });

  describe('timestamp', () => {
    it('includes analyzedAt timestamp', () => {
      const before = Date.now();
      const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
      const after = Date.now();
      expect(result.analyzedAt).toBeGreaterThanOrEqual(before);
      expect(result.analyzedAt).toBeLessThanOrEqual(after);
    });
  });
});

// ============================================================================
// benchmark()
// ============================================================================

describe('benchmark', () => {
  it('computes delta between before and after', () => {
    const result = benchmark(POOR_CLAUDE_MD, WELL_STRUCTURED_CLAUDE_MD);
    expect(result.delta).toBeGreaterThan(0);
  });

  it('returns before and after analysis results', () => {
    const result = benchmark(POOR_CLAUDE_MD, WELL_STRUCTURED_CLAUDE_MD);
    expect(result.before.compositeScore).toBeDefined();
    expect(result.after.compositeScore).toBeDefined();
    expect(result.after.compositeScore).toBeGreaterThan(result.before.compositeScore);
  });

  it('identifies improvements by dimension', () => {
    const result = benchmark(POOR_CLAUDE_MD, WELL_STRUCTURED_CLAUDE_MD);
    expect(result.improvements.length).toBeGreaterThan(0);
    for (const imp of result.improvements) {
      expect(imp.delta).toBeGreaterThan(0);
      expect(imp.after).toBeGreaterThan(imp.before);
    }
  });

  it('reports regressions when going from good to bad', () => {
    const result = benchmark(WELL_STRUCTURED_CLAUDE_MD, POOR_CLAUDE_MD);
    expect(result.delta).toBeLessThan(0);
    expect(result.regressions.length).toBeGreaterThan(0);
  });

  it('shows zero delta for identical content', () => {
    const result = benchmark(WELL_STRUCTURED_CLAUDE_MD, WELL_STRUCTURED_CLAUDE_MD);
    expect(result.delta).toBe(0);
    expect(result.improvements).toHaveLength(0);
    expect(result.regressions).toHaveLength(0);
  });

  it('accepts optional local content', () => {
    const result = benchmark(POOR_CLAUDE_MD, WELL_STRUCTURED_CLAUDE_MD, LOCAL_OVERLAY);
    expect(result.delta).toBeGreaterThan(0);
  });

  it('each dimension delta has correct fields', () => {
    const result = benchmark(POOR_CLAUDE_MD, WELL_STRUCTURED_CLAUDE_MD);
    for (const d of [...result.improvements, ...result.regressions]) {
      expect(d.dimension).toBeTruthy();
      expect(typeof d.before).toBe('number');
      expect(typeof d.after).toBe('number');
      expect(d.delta).toBe(d.after - d.before);
    }
  });
});

// ============================================================================
// autoOptimize()
// ============================================================================

describe('autoOptimize', () => {
  it('improves the score of poor content', () => {
    const result = autoOptimize(POOR_CLAUDE_MD);
    expect(result.benchmark.delta).toBeGreaterThan(0);
  });

  it('returns the optimized content', () => {
    const result = autoOptimize(POOR_CLAUDE_MD);
    expect(result.optimized).toBeTruthy();
    expect(result.optimized.length).toBeGreaterThan(POOR_CLAUDE_MD.length);
  });

  it('tracks applied suggestions', () => {
    const result = autoOptimize(POOR_CLAUDE_MD);
    expect(result.appliedSuggestions.length).toBeGreaterThan(0);
    for (const s of result.appliedSuggestions) {
      expect(s.patch).toBeTruthy();
    }
  });

  it('respects maxIterations', () => {
    const onePass = autoOptimize(POOR_CLAUDE_MD, undefined, 1);
    const threePasses = autoOptimize(POOR_CLAUDE_MD, undefined, 3);
    expect(threePasses.appliedSuggestions.length).toBeGreaterThanOrEqual(
      onePass.appliedSuggestions.length
    );
  });

  it('does not regress well-structured content', () => {
    const result = autoOptimize(WELL_STRUCTURED_CLAUDE_MD);
    expect(result.benchmark.delta).toBeGreaterThanOrEqual(0);
  });

  it('produces valid markdown', () => {
    const result = autoOptimize(POOR_CLAUDE_MD);
    // Should still start with original content
    expect(result.optimized).toContain('some rules');
    // Should have added sections
    expect(result.optimized).toContain('##');
  });

  it('auto-adds security section when missing', () => {
    const noSecurity = `# My Project\n\n## Build & Test\n\nBuild: \`npm run build\`\nTest: \`npm test\`\n`;
    const result = autoOptimize(noSecurity);
    const afterMetrics = analyze(result.optimized);
    // Should have added security-related content
    expect(result.optimized.toLowerCase()).toMatch(/security|secret|credential/);
  });

  it('auto-adds enforcement rules when few exist', () => {
    const weak = `# My Project\n\n## Guidelines\n\n- Try to write good code\n- Consider testing\n`;
    const result = autoOptimize(weak);
    expect(result.optimized).toMatch(/NEVER|ALWAYS|MUST/);
  });

  it('accepts local content overlay', () => {
    const result = autoOptimize(POOR_CLAUDE_MD, LOCAL_OVERLAY);
    expect(result.benchmark.delta).toBeGreaterThan(0);
  });
});

// ============================================================================
// formatReport()
// ============================================================================

describe('formatReport', () => {
  it('includes composite score and grade', () => {
    const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
    const report = formatReport(result);
    expect(report).toContain('Composite Score:');
    expect(report).toContain(`${result.compositeScore}/100`);
    expect(report).toContain(`(${result.grade})`);
  });

  it('includes all 6 dimensions', () => {
    const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
    const report = formatReport(result);
    expect(report).toContain('Structure');
    expect(report).toContain('Coverage');
    expect(report).toContain('Enforceability');
    expect(report).toContain('Compilability');
    expect(report).toContain('Clarity');
    expect(report).toContain('Completeness');
  });

  it('includes metrics section', () => {
    const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
    const report = formatReport(result);
    expect(report).toContain('Metrics:');
    expect(report).toContain('Lines:');
    expect(report).toContain('Sections:');
    expect(report).toContain('Rules:');
    expect(report).toContain('Enforcement statements:');
    expect(report).toContain('Estimated shards:');
  });

  it('includes suggestions for poor content', () => {
    const result = analyze(POOR_CLAUDE_MD);
    const report = formatReport(result);
    expect(report).toContain('Suggestions');
    expect(report).toContain('[!]'); // high priority marker
  });

  it('uses visual bars for dimension scores', () => {
    const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
    const report = formatReport(result);
    // Visual bars use █ and ░ characters
    expect(report).toMatch(/[█░]/);
  });

  it('shows weight percentages', () => {
    const result = analyze(WELL_STRUCTURED_CLAUDE_MD);
    const report = formatReport(result);
    expect(report).toContain('20%');
    expect(report).toContain('25%');
    expect(report).toContain('15%');
    expect(report).toContain('10%');
  });
});

// ============================================================================
// formatBenchmark()
// ============================================================================

describe('formatBenchmark', () => {
  it('shows before and after scores', () => {
    const result = benchmark(POOR_CLAUDE_MD, WELL_STRUCTURED_CLAUDE_MD);
    const report = formatBenchmark(result);
    expect(report).toContain(`${result.before.compositeScore}`);
    expect(report).toContain(`${result.after.compositeScore}`);
    expect(report).toContain('→');
  });

  it('shows grade transition', () => {
    const result = benchmark(POOR_CLAUDE_MD, WELL_STRUCTURED_CLAUDE_MD);
    const report = formatBenchmark(result);
    expect(report).toContain(result.before.grade);
    expect(report).toContain(result.after.grade);
  });

  it('lists improvements', () => {
    const result = benchmark(POOR_CLAUDE_MD, WELL_STRUCTURED_CLAUDE_MD);
    const report = formatBenchmark(result);
    expect(report).toContain('Improvements:');
  });

  it('lists regressions when applicable', () => {
    const result = benchmark(WELL_STRUCTURED_CLAUDE_MD, POOR_CLAUDE_MD);
    const report = formatBenchmark(result);
    expect(report).toContain('Regressions:');
  });

  it('shows delta with sign', () => {
    const result = benchmark(POOR_CLAUDE_MD, WELL_STRUCTURED_CLAUDE_MD);
    const report = formatBenchmark(result);
    expect(report).toContain('+'); // positive delta
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('edge cases', () => {
  it('handles empty string', () => {
    const result = analyze('');
    // Empty string still gets some base points from compiler succeeding and no-vague bonus
    expect(result.compositeScore).toBeLessThanOrEqual(30);
    expect(result.grade).toBe('F');
  });

  it('handles single line', () => {
    const result = analyze('# Title');
    expect(result.compositeScore).toBeGreaterThanOrEqual(0);
    expect(result.dimensions).toHaveLength(6);
  });

  it('handles content with only code blocks', () => {
    const md = '# Project\n\n```ts\nconst x = 1;\n```\n\n```ts\nconst y = 2;\n```\n\n```ts\nconst z = 3;\n```\n';
    const result = analyze(md);
    const clarity = result.dimensions.find(d => d.name === 'Clarity')!;
    expect(clarity.score).toBeGreaterThan(0); // code blocks boost clarity
  });

  it('handles very long content', () => {
    const lines = ['# Big Project\n'];
    for (let i = 0; i < 20; i++) {
      lines.push(`\n## Section ${i}\n`);
      for (let j = 0; j < 10; j++) {
        lines.push(`- ALWAYS follow rule ${i}-${j}`);
      }
    }
    const md = lines.join('\n');
    const result = analyze(md);
    expect(result.compositeScore).toBeGreaterThan(0);
    expect(result.metrics.sectionCount).toBe(20);
  });

  it('handles content with vague language', () => {
    const md = `# Project\n\n## Rules\n\n- Try to keep code clean\n- Should probably test things\n- Consider using types if possible\n- Might want to add docs when appropriate\n`;
    const result = analyze(md);
    const enforceability = result.dimensions.find(d => d.name === 'Enforceability')!;
    expect(enforceability.findings.some(f => f.includes('vague'))).toBe(true);
  });

  it('benchmark handles identical content correctly', () => {
    const result = benchmark(MINIMAL_CLAUDE_MD, MINIMAL_CLAUDE_MD);
    expect(result.delta).toBe(0);
    expect(result.improvements).toHaveLength(0);
    expect(result.regressions).toHaveLength(0);
  });

  it('autoOptimize handles already-optimal content gracefully', () => {
    // Even if content is already good, should not crash or regress
    const result = autoOptimize(WELL_STRUCTURED_CLAUDE_MD, undefined, 5);
    expect(result.benchmark.delta).toBeGreaterThanOrEqual(0);
    expect(result.optimized.length).toBeGreaterThanOrEqual(WELL_STRUCTURED_CLAUDE_MD.length);
  });
});
