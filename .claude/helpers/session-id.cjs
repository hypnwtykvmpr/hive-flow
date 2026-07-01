#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { envSessionValue } = require('./client-kind.cjs');

const { loadProtectedPathPolicyModule } = require('./layout-paths.cjs');

const protectedPathPolicy = loadProtectedPathPolicyModule({ env: process.env, cwd: process.cwd(), helperDir: __dirname });

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function sanitizeSessionId(value) {
  const sanitized = protectedPathPolicy.sanitizeScopeId(value, '', 64);
  return sanitized || null;
}

function asOperatorContextSessionId(value) {
  const raw = asNonEmptyString(value);
  if (!raw) return null;
  if (/^mcp-\d+-[a-z0-9]+$/i.test(raw.trim())) return null;
  return raw;
}

function resolveSessionId(input = null, env = process.env, context = null) {
  const source =
    asNonEmptyString(input && input.session_id)
    || asNonEmptyString(input && input.sessionId)
    || envSessionValue(env)
    || asOperatorContextSessionId(context && context.session_id)
    || asOperatorContextSessionId(context && context.sessionId);

  return source ? sanitizeSessionId(source) : null;
}

module.exports = {
  resolveSessionId,
  sanitizeSessionId,
};
