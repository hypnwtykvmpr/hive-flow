import { existsSync as defaultExistsSync, readFileSync as defaultReadFileSync } from 'fs';
import { join } from 'path';

export const OPENROUTER_AUTH_MESSAGE =
  'OpenRouter credentials missing/invalid. Unlock the Hive Flow credential holder and retry; strict API keys must not be injected through env/config.';

export const GEMINI_AUTH_MESSAGE =
  'Gemini CLI requires sign-in. Run gemini in a terminal and complete Google OAuth (or set GEMINI_API_KEY/GOOGLE_API_KEY). Hive Flow reuses ~/.gemini/oauth_creds.json via HOME.';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readJsonConfig(cwd, fsApi) {
  const path = join(cwd || process.cwd(), '.hive-flow', 'config.json');
  try {
    if (!fsApi.existsSync(path)) return undefined;
    const parsed = JSON.parse(fsApi.readFileSync(path, 'utf8'));
    return asObject(parsed);
  } catch {
    return undefined;
  }
}

function resolveCredentialSource(source, env) {
  const value = stringValue(source);
  if (!value) return undefined;
  const match = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  if (!match) return undefined;
  return stringValue(env[match[1]]);
}

function resolveEnvReference(source, env) {
  const value = stringValue(source);
  if (!value) return undefined;
  return resolveCredentialSource(value, env)
    ?? (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? stringValue(env[value]) : undefined);
}

function providerEnvPrefix(providerName) {
  return String(providerName || '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function resolveProviderApiUrl(providerName, env) {
  const prefix = providerEnvPrefix(providerName);
  return stringValue(env[`${prefix}_API_URL`])
    ?? stringValue(env[`${prefix}_BASE_URL`]);
}

export function readOpenRouterCredentialFromConfig({
  cwd = process.cwd(),
  env = process.env,
  fs = { existsSync: defaultExistsSync, readFileSync: defaultReadFileSync },
} = {}) {
  void cwd;
  void env;
  void fs;
  return undefined;
}

export function buildProviderConfig({
  providerName,
  model,
  timeoutMs,
  agentToken,
  defaults,
  env = process.env,
  cwd = process.cwd(),
  fs,
}) {
  const childEnv = agentToken ? { HIVE_FLOW_AGENT_TOKEN: agentToken } : undefined;
  const config = {
    provider: providerName,
    model: model || defaults?.[providerName] || 'auto',
    timeout: timeoutMs || 300000,
    retryAttempts: 2,
    retryDelay: 1000,
    ...(childEnv ? { env: childEnv } : {}),
  };

  const apiUrl = resolveProviderApiUrl(providerName, env);
  if (apiUrl) config.apiUrl = apiUrl;

  if (providerName === 'openrouter') void readOpenRouterCredentialFromConfig({ cwd, env, fs });

  return config;
}

export function isProviderAuthError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  if (error?.code === 'AUTHENTICATION' || error?.statusCode === 401) return true;
  return msg.includes('auth')
    || msg.includes('401')
    || msg.includes('unauthorized')
    || msg.includes('invalid api key')
    || msg.includes('opening authentication page');
}

export function authMessageForProvider(providerName) {
  if (providerName === 'openrouter') return OPENROUTER_AUTH_MESSAGE;
  if (providerName === 'gemini-cli') return GEMINI_AUTH_MESSAGE;
  return `Provider credentials missing/invalid for ${providerName}. Reconfigure credentials and restart the hive-flow daemon/MCP server.`;
}

function redactReason(reason) {
  return String(reason || '')
    .replace(/or-[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/sk-[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');
}

export async function notifyProviderAuthRequired({ providerName, reason, callMCPTool }) {
  if (typeof callMCPTool !== 'function') return;
  try {
    await callMCPTool('hooks_notify', {
      message: authMessageForProvider(providerName),
      target: 'human',
      priority: 'high',
      data: {
        provider: providerName,
        category: 'provider-auth',
        reason: redactReason(reason),
      },
    });
  } catch {
    // Notification failures must never mask the provider auth failure.
  }
}
