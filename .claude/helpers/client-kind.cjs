#!/usr/bin/env node
'use strict';

function stringValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const CLIENT_KIND_ALIASES = Object.freeze({
  claude: ['claude', 'claude-code', 'anthropic-cli'],
  codex: ['codex', 'codex-cli'],
  gemini: ['gemini', 'gemini-cli'],
  cursor: ['cursor', 'cursor-cli', 'cursor-agent', 'agent'],
  antigravity: ['antigravity', 'antigravity-cli', 'agy'],
  opencode: ['opencode', 'open-code'],
  forgecode: ['forgecode', 'forge-code', 'forge'],
});

const CLIENT_KIND_BY_ALIAS = new Map();
for (const [kind, aliases] of Object.entries(CLIENT_KIND_ALIASES)) {
  for (const alias of aliases) CLIENT_KIND_BY_ALIAS.set(alias, kind);
}

const SESSION_ENV_KEYS_BY_KIND = Object.freeze({
  codex: ['CODEX_SESSION_ID', 'CODEX_THREAD_ID'],
  claude: ['CLAUDE_SESSION_ID'],
  gemini: ['GEMINI_SESSION_ID', 'GEMINI_THREAD_ID'],
  cursor: ['CURSOR_SESSION_ID', 'CURSOR_THREAD_ID', 'AGENT_SESSION_ID'],
  antigravity: ['ANTIGRAVITY_SESSION_ID', 'ANTIGRAVITY_THREAD_ID', 'AGY_SESSION_ID', 'AGY_THREAD_ID'],
  opencode: ['OPENCODE_SESSION_ID', 'OPENCODE_THREAD_ID'],
  forgecode: ['FORGECODE_SESSION_ID', 'FORGECODE_THREAD_ID', 'FORGE_CODE_SESSION_ID', 'FORGE_SESSION_ID'],
});

const SESSION_ENV_KEY_PRIORITY = Object.freeze([
  ['CODEX_SESSION_ID', 'codex'],
  ['CODEX_THREAD_ID', 'codex'],
  ['OPENCODE_SESSION_ID', 'opencode'],
  ['OPENCODE_THREAD_ID', 'opencode'],
  ['FORGECODE_SESSION_ID', 'forgecode'],
  ['FORGECODE_THREAD_ID', 'forgecode'],
  ['FORGE_CODE_SESSION_ID', 'forgecode'],
  ['FORGE_SESSION_ID', 'forgecode'],
  ['ANTIGRAVITY_SESSION_ID', 'antigravity'],
  ['ANTIGRAVITY_THREAD_ID', 'antigravity'],
  ['AGY_SESSION_ID', 'antigravity'],
  ['AGY_THREAD_ID', 'antigravity'],
  ['GEMINI_SESSION_ID', 'gemini'],
  ['GEMINI_THREAD_ID', 'gemini'],
  ['CURSOR_SESSION_ID', 'cursor'],
  ['CURSOR_THREAD_ID', 'cursor'],
  ['CLAUDE_SESSION_ID', 'claude'],
  ['AGENT_SESSION_ID', 'cursor'],
]);

const OPERATOR_CLIENT_KINDS = Object.freeze([
  'codex',
  'claude',
  'gemini',
  'cursor',
  'antigravity',
  'opencode',
  'forgecode',
]);

function normalizeClientKind(value) {
  const raw = stringValue(value);
  if (!raw) return null;
  return CLIENT_KIND_BY_ALIAS.get(raw.toLowerCase()) || null;
}

function operatorSessionEnvKeys(kind = null) {
  const normalized = normalizeClientKind(kind) || kind;
  if (normalized && SESSION_ENV_KEYS_BY_KIND[normalized]) {
    return SESSION_ENV_KEYS_BY_KIND[normalized].slice();
  }
  return [
    ...SESSION_ENV_KEY_PRIORITY.map(([key]) => key),
    'HIVE_FLOW_SESSION_ID',
  ];
}

function envSessionValue(env = process.env) {
  for (const key of operatorSessionEnvKeys()) {
    const value = stringValue(env && env[key]);
    if (value) return value;
  }
  return null;
}

function clientKindFromEnv(env = process.env) {
  const explicit = normalizeClientKind(env && env.HIVE_FLOW_CLIENT_KIND);
  if (explicit) {
    const explicitHasSession = operatorSessionEnvKeys(explicit)
      .some((key) => Boolean(stringValue(env && env[key])));
    if (explicitHasSession || stringValue(env && env.HIVE_FLOW_SESSION_ID)) return explicit;

    const sessionKinds = new Set();
    for (const [key, kind] of SESSION_ENV_KEY_PRIORITY) {
      if (stringValue(env && env[key])) sessionKinds.add(kind);
    }
    if (sessionKinds.size === 1) return Array.from(sessionKinds)[0] || explicit;
    return explicit;
  }
  for (const [key, kind] of SESSION_ENV_KEY_PRIORITY) {
    if (stringValue(env && env[key])) return kind;
  }
  if (stringValue(env && env.CLAUDE_PROJECT_DIR)) return 'claude';
  return null;
}

function targetAgentFromClientKind(kind) {
  return normalizeClientKind(kind);
}

function wakeClientKind(kind) {
  const normalized = normalizeClientKind(kind);
  if (normalized === 'claude') return 'claude-code';
  return normalized || null;
}

function defaultClientKind(env = process.env) {
  return clientKindFromEnv(env) || 'claude';
}

module.exports = {
  CLIENT_KIND_ALIASES,
  OPERATOR_CLIENT_KINDS,
  stringValue,
  normalizeClientKind,
  operatorSessionEnvKeys,
  envSessionValue,
  clientKindFromEnv,
  targetAgentFromClientKind,
  wakeClientKind,
  defaultClientKind,
};
