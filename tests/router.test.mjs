/**
 * Tests for .claude/helpers/router.cjs
 * COV-006 — node:test suite
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { routeTask, AGENT_CAPABILITIES, TASK_PATTERNS } = require('../.claude/helpers/router.cjs');

describe('router.cjs', () => {
  test('exports routeTask, AGENT_CAPABILITIES, and TASK_PATTERNS', () => {
    assert.strictEqual(typeof routeTask, 'function');
    assert.strictEqual(typeof AGENT_CAPABILITIES, 'object');
    assert.strictEqual(typeof TASK_PATTERNS, 'object');
  });

  test('routes code generation tasks to coder', () => {
    const result = routeTask('implement a new feature for user login');
    assert.strictEqual(result.agent, 'coder');
    assert.ok(result.confidence >= 0.5);
    assert.ok(typeof result.reason === 'string');
  });

  test('routes test-related tasks to tester', () => {
    const result = routeTask('write unit tests for authentication module');
    assert.strictEqual(result.agent, 'tester');
    assert.ok(result.confidence >= 0.5);
  });

  test('routes review tasks to reviewer', () => {
    const result = routeTask('review the security audit results');
    assert.strictEqual(result.agent, 'reviewer');
  });

  test('routes research tasks to researcher', () => {
    const result = routeTask('research documentation for the new API');
    assert.strictEqual(result.agent, 'researcher');
  });

  test('routes design tasks to architect', () => {
    const result = routeTask('design the system architecture for microservices');
    assert.strictEqual(result.agent, 'architect');
  });

  test('routes API/backend tasks to backend-dev', () => {
    const result = routeTask('set up the backend server with database connection');
    assert.strictEqual(result.agent, 'backend-dev');
  });

  test('routes UI tasks to frontend-dev', () => {
    const result = routeTask('style the frontend component with CSS for the ui page');
    assert.strictEqual(result.agent, 'frontend-dev');
  });

  test('routes deployment tasks to devops', () => {
    const result = routeTask('set up docker pipeline for CI/CD deployment');
    assert.strictEqual(result.agent, 'devops');
  });

  test('returns default coder agent for unmatched tasks', () => {
    const result = routeTask('do something completely unrelated xyzzy');
    assert.strictEqual(result.agent, 'coder');
    assert.strictEqual(result.confidence, 0.5);
    assert.ok(result.reason.includes('Default'));
  });

  test('result always has agent, confidence, and reason fields', () => {
    const result = routeTask('any task whatsoever');
    assert.ok('agent' in result);
    assert.ok('confidence' in result);
    assert.ok('reason' in result);
  });

  test('AGENT_CAPABILITIES contains known agent types', () => {
    const agents = Object.keys(AGENT_CAPABILITIES);
    assert.ok(agents.includes('coder'));
    assert.ok(agents.includes('tester'));
    assert.ok(agents.includes('reviewer'));
    assert.ok(agents.includes('architect'));
  });

  test('AGENT_CAPABILITIES values are arrays', () => {
    for (const [, caps] of Object.entries(AGENT_CAPABILITIES)) {
      assert.ok(Array.isArray(caps), 'capabilities should be arrays');
      assert.ok(caps.length > 0, 'capabilities array should not be empty');
    }
  });
});
