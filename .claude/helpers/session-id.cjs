#!/usr/bin/env node
'use strict';

const path = require('node:path');

function loadProtectedPathPolicyModule() {
  const projectRoot = path.resolve(__dirname, '..', '..');
  const candidates = [
    path.join(projectRoot, 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'),
    path.join(path.resolve(process.cwd()), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'),
  ];

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try the next candidate.
    }
  }

  return {
    sanitizeScopeId(id, fallback = '', maxLen = 64) {
      if (typeof id !== 'string' || !id.trim()) return fallback;
      const sanitized = id.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, maxLen);
      return sanitized || fallback;
    },
  };
}

const protectedPathPolicy = loadProtectedPathPolicyModule();

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function sanitizeSessionId(value) {
  const sanitized = protectedPathPolicy.sanitizeScopeId(value, '', 64);
  return sanitized || null;
}

function resolveSessionId(input = null, env = process.env, context = null) {
  const source =
    asNonEmptyString(input && input.session_id)
    || asNonEmptyString(input && input.sessionId)
    || asNonEmptyString(env && env.CODEX_SESSION_ID)
    || asNonEmptyString(env && env.CLAUDE_SESSION_ID)
    || asNonEmptyString(env && env.HIVE_FLOW_SESSION_ID)
    || asNonEmptyString(context && context.session_id)
    || asNonEmptyString(context && context.sessionId);

  return source ? sanitizeSessionId(source) : null;
}

module.exports = {
  resolveSessionId,
  sanitizeSessionId,
};
