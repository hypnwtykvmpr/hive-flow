/**
 * Diff Classifier Tests
 *
 * Tests for the diff classification functionality.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DiffClassifier, createDiffClassifier, type DiffAnalysis, type FileDiff } from '../../src/ruvector/diff-classifier';

// Mock the @ruvector/diff module
vi.mock('@ruvector/diff', () => ({
  createDiffClassifier: vi.fn(() => null),
}));

describe('DiffClassifier', () => {
  let classifier: DiffClassifier;

  beforeEach(() => {
    classifier = new DiffClassifier();
  });

  afterEach(() => {
    classifier.clearCache();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create classifier with default config', () => {
      const stats = classifier.getStats();
      expect(stats.cacheSize).toBe(0);
      expect(stats.useNative).toBe(false);
    });

    it('should create classifier with custom config', () => {
      const customClassifier = new DiffClassifier({
        maxDiffSize: 5000,
        detectRefactoring: false,
        minConfidence: 0.8,
      });
      expect(customClassifier).toBeInstanceOf(DiffClassifier);
    });
  });

  describe('initialize', () => {
    it('should initialize without ruvector (fallback mode)', async () => {
      await classifier.initialize();
      const stats = classifier.getStats();
      expect(stats.useNative).toBe(false);
    });
  });

  describe('parseDiff', () => {
    const sampleDiff = `diff --git a/src/utils.ts b/src/utils.ts
index 1234567..abcdefg 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,5 +1,7 @@
 import { foo } from 'foo';
 
+import { bar } from 'bar';
+
 export function helper() {
-  return null;
+  return 'hello';
 }
`;

    it('should parse diff into FileDiff array', () => {
      const files = classifier.parseDiff(sampleDiff);
      expect(Array.isArray(files)).toBe(true);
      expect(files.length).toBe(1);
    });

    it('should extract file path', () => {
      const files = classifier.parseDiff(sampleDiff);
      expect(files[0].path).toBe('src/utils.ts');
    });

    it('should count additions and deletions', () => {
      const files = classifier.parseDiff(sampleDiff);
      expect(files[0].additions).toBeGreaterThan(0);
      expect(files[0].deletions).toBeGreaterThan(0);
    });

    it('should parse hunks', () => {
      const files = classifier.parseDiff(sampleDiff);
      expect(files[0].hunks.length).toBeGreaterThan(0);
      expect(files[0].hunks[0]).toHaveProperty('oldStart');
      expect(files[0].hunks[0]).toHaveProperty('newStart');
      expect(files[0].hunks[0]).toHaveProperty('changes');
    });

    it('should generate classification for each file', () => {
      const files = classifier.parseDiff(sampleDiff);
      expect(files[0].classification).toHaveProperty('primary');
      expect(files[0].classification).toHaveProperty('confidence');
      expect(files[0].classification).toHaveProperty('impactLevel');
    });

    it('should handle empty diff', () => {
      const files = classifier.parseDiff('');
      expect(files).toEqual([]);
    });

    it('should handle multi-file diff', () => {
      const multiDiff = `diff --git a/file1.ts b/file1.ts
--- a/file1.ts
+++ b/file1.ts
@@ -1 +1 @@
-old
+new
diff --git a/file2.ts b/file2.ts
--- a/file2.ts
+++ b/file2.ts
@@ -1 +1 @@
-old
+new
`;
      const files = classifier.parseDiff(multiDiff);
      expect(files.length).toBe(2);
    });
  });

  describe('classify', () => {
    it('should return DiffAnalysis', () => {
      const files: FileDiff[] = [{
        path: 'src/feature.ts',
        hunks: [],
        additions: 10,
        deletions: 2,
        classification: {
          primary: 'feature',
          secondary: [],
          confidence: 0.8,
          impactLevel: 'medium',
          suggestedReviewers: [],
          testingStrategy: [],
          riskFactors: [],
        },
      }];
      
      const analysis = classifier.classify(files);
      expect(analysis).toHaveProperty('files');
      expect(analysis).toHaveProperty('overall');
      expect(analysis).toHaveProperty('stats');
      expect(analysis).toHaveProperty('timestamp');
    });

    it('should calculate overall stats', () => {
      const files: FileDiff[] = [
        { path: 'a.ts', hunks: [], additions: 10, deletions: 5, classification: { primary: 'feature', secondary: [], confidence: 0.8, impactLevel: 'low', suggestedReviewers: [], testingStrategy: [], riskFactors: [] } },
        { path: 'b.ts', hunks: [], additions: 20, deletions: 3, classification: { primary: 'feature', secondary: [], confidence: 0.9, impactLevel: 'medium', suggestedReviewers: [], testingStrategy: [], riskFactors: [] } },
      ];
      
      const analysis = classifier.classify(files);
      expect(analysis.stats.totalAdditions).toBe(30);
      expect(analysis.stats.totalDeletions).toBe(8);
      expect(analysis.stats.filesChanged).toBe(2);
    });

    it('should compute average confidence', () => {
      const files: FileDiff[] = [
        { path: 'a.ts', hunks: [], additions: 1, deletions: 1, classification: { primary: 'feature', secondary: [], confidence: 0.8, impactLevel: 'low', suggestedReviewers: [], testingStrategy: [], riskFactors: [] } },
        { path: 'b.ts', hunks: [], additions: 1, deletions: 1, classification: { primary: 'bugfix', secondary: [], confidence: 0.6, impactLevel: 'low', suggestedReviewers: [], testingStrategy: [], riskFactors: [] } },
      ];
      
      const analysis = classifier.classify(files);
      expect(analysis.stats.avgConfidence).toBe(0.7);
    });

    it('should determine overall primary classification by majority', () => {
      const files: FileDiff[] = [
        { path: 'a.ts', hunks: [], additions: 1, deletions: 1, classification: { primary: 'bugfix', secondary: [], confidence: 0.8, impactLevel: 'low', suggestedReviewers: [], testingStrategy: [], riskFactors: [] } },
        { path: 'b.ts', hunks: [], additions: 1, deletions: 1, classification: { primary: 'bugfix', secondary: [], confidence: 0.8, impactLevel: 'low', suggestedReviewers: [], testingStrategy: [], riskFactors: [] } },
        { path: 'c.ts', hunks: [], additions: 1, deletions: 1, classification: { primary: 'feature', secondary: [], confidence: 0.8, impactLevel: 'low', suggestedReviewers: [], testingStrategy: [], riskFactors: [] } },
      ];
      
      const analysis = classifier.classify(files);
      expect(analysis.overall.primary).toBe('bugfix');
    });

    it('should use maximum impact level', () => {
      const files: FileDiff[] = [
        { path: 'a.ts', hunks: [], additions: 1, deletions: 1, classification: { primary: 'feature', secondary: [], confidence: 0.8, impactLevel: 'low', suggestedReviewers: [], testingStrategy: [], riskFactors: [] } },
        { path: 'b.ts', hunks: [], additions: 1, deletions: 1, classification: { primary: 'feature', secondary: [], confidence: 0.8, impactLevel: 'critical', suggestedReviewers: [], testingStrategy: [], riskFactors: [] } },
      ];
      
      const analysis = classifier.classify(files);
      expect(analysis.overall.impactLevel).toBe('critical');
    });

    it('should handle empty files array', () => {
      const analysis = classifier.classify([]);
      expect(analysis.overall.primary).toBe('unknown');
      expect(analysis.stats.filesChanged).toBe(0);
    });
  });

  describe('classifyCommitMessage', () => {
    it('should classify feature commits', () => {
      expect(classifier.classifyCommitMessage('feat: add new login feature')).toBe('feature');
      expect(classifier.classifyCommitMessage('implement user dashboard')).toBe('feature');
    });

    it('should classify bugfix commits', () => {
      expect(classifier.classifyCommitMessage('fix: resolve login bug')).toBe('bugfix');
      expect(classifier.classifyCommitMessage('hotfix: critical security patch')).toBe('bugfix');
    });

    it('should classify refactor commits', () => {
      expect(classifier.classifyCommitMessage('refactor: restructure auth module')).toBe('refactor');
      expect(classifier.classifyCommitMessage('cleanup: remove dead code')).toBe('refactor');
    });

    it('should classify docs commits', () => {
      expect(classifier.classifyCommitMessage('docs: update README')).toBe('docs');
      expect(classifier.classifyCommitMessage('add documentation for API')).toBe('docs');
    });

    it('should classify test commits', () => {
      expect(classifier.classifyCommitMessage('test: add unit tests')).toBe('test');
    });

    it('should classify config commits', () => {
      expect(classifier.classifyCommitMessage('config: update tsconfig')).toBe('config');
    });

    it('should classify style commits', () => {
      expect(classifier.classifyCommitMessage('style: format code')).toBe('style');
    });

    it('should return unknown for unclassified commits', () => {
      expect(classifier.classifyCommitMessage('random commit message')).toBe('unknown');
    });
  });

  describe('classification by file path', () => {
    it('should classify test files', () => {
      const diff = `diff --git a/src/__tests__/foo.test.ts b/src/__tests__/foo.test.ts
--- a/src/__tests__/foo.test.ts
+++ b/src/__tests__/foo.test.ts
@@ -1 +1 @@
-test
+test2
`;
      const files = classifier.parseDiff(diff);
      expect(files[0].classification.primary).toBe('test');
    });

    it('should classify config files', () => {
      const diff = `diff --git a/tsconfig.json b/tsconfig.json
--- a/tsconfig.json
+++ b/tsconfig.json
@@ -1 +1 @@
-{}
+{"compilerOptions": {}}
`;
      const files = classifier.parseDiff(diff);
      expect(files[0].classification.primary).toBe('config');
    });

    it('should classify documentation files', () => {
      const diff = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new
`;
      const files = classifier.parseDiff(diff);
      expect(files[0].classification.primary).toBe('docs');
    });
  });

  describe('impact level detection', () => {
    it('should detect critical impact for security files', () => {
      const diff = `diff --git a/src/security/auth.ts b/src/security/auth.ts
--- a/src/security/auth.ts
+++ b/src/security/auth.ts
@@ -1,100 +1,100 @@
` + Array(100).fill('+new line').join('\n');
      
      const files = classifier.parseDiff(diff);
      expect(files[0].classification.impactLevel).toBe('critical');
    });

    it('should detect low impact for test files', () => {
      const diff = `diff --git a/test/foo.test.ts b/test/foo.test.ts
--- a/test/foo.test.ts
+++ b/test/foo.test.ts
@@ -1 +1 @@
-test
+test2
`;
      const files = classifier.parseDiff(diff);
      expect(files[0].classification.impactLevel).toBe('low');
    });
  });

  describe('reviewer suggestions', () => {
    it('should suggest reviewers based on classification', () => {
      const diff = `diff --git a/src/feature.ts b/src/feature.ts
--- a/src/feature.ts
+++ b/src/feature.ts
@@ -1,10 +1,15 @@
+new feature code
`;
      const files = classifier.parseDiff(diff);
      const analysis = classifier.classify(files);
      expect(analysis.overall.suggestedReviewers.length).toBeGreaterThan(0);
    });

    it('should suggest security reviewer for high impact', () => {
      const files: FileDiff[] = [{
        path: 'src/auth/login.ts',
        hunks: [],
        additions: 100,
        deletions: 50,
        classification: {
          primary: 'feature',
          secondary: [],
          confidence: 0.8,
          impactLevel: 'critical',
          suggestedReviewers: ['security-reviewer'],
          testingStrategy: [],
          riskFactors: [],
        },
      }];
      
      const analysis = classifier.classify(files);
      expect(analysis.overall.suggestedReviewers).toContain('security-reviewer');
    });
  });

  describe('testing strategy', () => {
    it('should recommend unit tests for non-test files', () => {
      const diff = `diff --git a/src/utils.ts b/src/utils.ts
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1 +1 @@
-old
+new
`;
      const files = classifier.parseDiff(diff);
      expect(files[0].classification.testingStrategy).toContain('unit-tests');
    });

    it('should recommend integration tests for features', () => {
      const files: FileDiff[] = [{
        path: 'src/feature.ts',
        hunks: [],
        additions: 50,
        deletions: 0,
        classification: {
          primary: 'feature',
          secondary: [],
          confidence: 0.8,
          impactLevel: 'medium',
          suggestedReviewers: [],
          testingStrategy: ['unit-tests', 'integration-tests'],
          riskFactors: [],
        },
      }];
      
      const analysis = classifier.classify(files);
      expect(analysis.overall.testingStrategy).toContain('integration-tests');
    });
  });

  describe('risk factors', () => {
    it('should identify security risk for auth files', () => {
      const diff = `diff --git a/src/auth/verify.ts b/src/auth/verify.ts
--- a/src/auth/verify.ts
+++ b/src/auth/verify.ts
@@ -1 +1 @@
-old
+new
`;
      const files = classifier.parseDiff(diff);
      expect(files[0].classification.riskFactors.some(r => r.includes('Security'))).toBe(true);
    });
  });

  describe('caching', () => {
    it('should cache classification results', () => {
      const diff = `diff --git a/src/file.ts b/src/file.ts
--- a/src/file.ts
+++ b/src/file.ts
@@ -1 +1 @@
-old
+new
`;
      classifier.parseDiff(diff);
      const stats1 = classifier.getStats();
      
      classifier.parseDiff(diff);
      const stats2 = classifier.getStats();
      
      expect(stats2.cacheSize).toBeGreaterThanOrEqual(stats1.cacheSize);
    });

    it('should clear cache', () => {
      const diff = `diff --git a/src/file.ts b/src/file.ts
--- a/src/file.ts
+++ b/src/file.ts
@@ -1 +1 @@
-old
+new
`;
      classifier.parseDiff(diff);
      expect(classifier.getStats().cacheSize).toBeGreaterThan(0);
      
      classifier.clearCache();
      expect(classifier.getStats().cacheSize).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle diff without hunks', () => {
      const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
`;
      const files = classifier.parseDiff(diff);
      expect(files.length).toBe(1);
      expect(files[0].hunks.length).toBe(0);
    });

    it('should handle binary files', () => {
      const diff = `diff --git a/image.png b/image.png
Binary files differ
`;
      const files = classifier.parseDiff(diff);
      // Binary files may or may not be parsed depending on implementation
      expect(files.length).toBeLessThanOrEqual(1);
    });
  });
});

describe('createDiffClassifier', () => {
  it('should create classifier instance', () => {
    const classifier = createDiffClassifier();
    expect(classifier).toBeInstanceOf(DiffClassifier);
  });

  it('should accept config', () => {
    const classifier = createDiffClassifier({ maxDiffSize: 5000 });
    expect(classifier).toBeInstanceOf(DiffClassifier);
  });
});
