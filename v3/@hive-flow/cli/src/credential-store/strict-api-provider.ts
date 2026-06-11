import { existsSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  CredentialHolderService,
  pingCredentialHolder,
  sendCredentialHolderCommand,
  type CredentialHolderServiceOptions,
  type ProviderUseHandlerInput,
} from './holder.js';
import { createPeerCredentialResolver, type PeerCredentialResolver } from './peer-credentials.js';
import { redactCredentialMaterial } from './safe-serialization.js';

export const STRICT_API_PROVIDERS = new Set(['openrouter', 'deepseek', 'openai', 'qwen']);
export const ENV_ONLY_CLI_PROVIDERS = new Set(['codex-cli', 'gemini-cli', 'cursor-cli', 'anthropic-cli']);

export interface CredentialHolderProbeStatus {
  available: boolean;
  socketPath?: string;
  pid?: number;
  reason?: string;
}

export interface CompleteStrictApiProviderInput {
  provider: string;
  resolvedModel?: string;
  prompt: string;
  systemPrompt?: string;
  tools?: unknown[];
  toolChoice?: unknown;
  timeoutMs: number;
}

export interface StrictApiProviderCompletion {
  content: string;
  model?: string;
  toolCalls?: unknown[];
  finishReason?: string;
  reasoningContent?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  cost?: unknown;
}

interface StrictApiCompletionPayload {
  action: 'complete';
  payload: {
    messages: Array<Record<string, unknown>>;
    model?: string;
    tools?: unknown[];
    toolChoice?: unknown;
    tool_choice?: unknown;
    timeout: number;
  };
}

interface StrictApiInvokeRequest {
  action?: unknown;
  payload?: unknown;
}

export function isStrictApiProvider(provider: string | undefined): boolean {
  return STRICT_API_PROVIDERS.has(String(provider || '').trim().toLowerCase());
}

export function isEnvOnlyCliProvider(provider: string | undefined): boolean {
  return ENV_ONLY_CLI_PROVIDERS.has(String(provider || '').trim().toLowerCase());
}

export function defaultCredentialHolderSocketPath(env: Record<string, unknown> = process.env): string {
  const explicit = typeof env.HIVE_FLOW_CREDENTIAL_HOLDER_SOCKET === 'string'
    ? env.HIVE_FLOW_CREDENTIAL_HOLDER_SOCKET.trim()
    : '';
  if (explicit) return explicit;
  if (process.platform === 'win32') {
    const user = String(env.USERNAME || env.USER || 'user').replace(/[^A-Za-z0-9._-]+/g, '-');
    return `\\\\.\\pipe\\hive-flow-credential-holder-${user}`;
  }
  let runtimeDir: string;
  if (typeof env.XDG_RUNTIME_DIR === 'string' && env.XDG_RUNTIME_DIR.trim()) {
    runtimeDir = env.XDG_RUNTIME_DIR.trim();
  } else if (typeof env.HIVE_FLOW_HOME === 'string' && env.HIVE_FLOW_HOME.trim()) {
    runtimeDir = join(env.HIVE_FLOW_HOME.trim(), 'run');
  } else {
    const home = typeof env.HOME === 'string' && env.HOME.trim() ? env.HOME.trim() : homedir();
    runtimeDir = join(home, '.hive-flow', 'run');
  }
  return join(runtimeDir, 'credential-holder.sock');
}

export async function probeCredentialHolderStatus(
  env: Record<string, unknown> = process.env,
  socketPath = defaultCredentialHolderSocketPath(env),
): Promise<CredentialHolderProbeStatus> {
  if (process.platform === 'win32') {
    const explicit = typeof env.HIVE_FLOW_CREDENTIAL_HOLDER_SOCKET === 'string'
      && env.HIVE_FLOW_CREDENTIAL_HOLDER_SOCKET.trim().length > 0;
    if (!explicit) return { available: false, socketPath, reason: 'credential holder named pipe is not configured' };
    return socketPath.startsWith('\\\\.\\pipe\\')
      ? { available: true, socketPath }
      : { available: false, socketPath, reason: 'credential holder named pipe path is not configured' };
  }
  try {
    if (!existsSync(socketPath)) return { available: false, socketPath, reason: 'credential holder socket is missing' };
    const stat = lstatSync(socketPath);
    if (!stat.isSocket()) return { available: false, socketPath, reason: 'credential holder path is not a socket' };
    if (process.getuid && stat.uid !== process.getuid()) {
      return { available: false, socketPath, reason: 'credential holder socket owner does not match current user' };
    }
    if ((stat.mode & 0o077) !== 0) {
      return { available: false, socketPath, reason: 'credential holder socket grants group/other access' };
    }
    const liveness = await pingCredentialHolder(socketPath, { timeoutMs: 750 });
    return liveness.available
      ? { available: true, socketPath, pid: liveness.pid }
      : { available: false, socketPath, reason: liveness.reason || 'credential holder is not responding' };
  } catch (error) {
    return { available: false, socketPath, reason: (error as Error).message };
  }
}

export async function completeStrictApiProviderViaHolder(
  input: CompleteStrictApiProviderInput,
  env: Record<string, unknown> = process.env,
): Promise<StrictApiProviderCompletion> {
  const provider = String(input.provider || '').trim().toLowerCase();
  if (!isStrictApiProvider(provider)) throw new Error(`provider ${input.provider} is not a strict API provider`);
  const socketPath = defaultCredentialHolderSocketPath(env);
  const messages: StrictApiCompletionPayload['payload']['messages'] = [];
  if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt });
  messages.push({ role: 'user', content: input.prompt });
  const command = {
    action: 'provider_call' as const,
    taskId: `provider-complete-${randomUUID()}`,
    provider,
    request: {
      action: 'complete',
      payload: {
        messages,
        model: input.resolvedModel,
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.toolChoice !== undefined ? { toolChoice: input.toolChoice } : {}),
        timeout: input.timeoutMs,
      },
    } satisfies StrictApiCompletionPayload,
  };
  const response = await sendCredentialHolderCommand(socketPath, command);
  if (!response.ok) {
    throw new Error(`credential holder provider_call failed: ${String(response.error)}`);
  }
  return normalizeStrictApiCompletion(redactCredentialMaterial(response.response));
}

export function createStrictApiProviderInvoker(options: {
  fetchImpl?: typeof fetch;
  baseUrls?: Partial<Record<string, string>>;
} = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async function strictApiProviderInvoker(input: ProviderUseHandlerInput): Promise<StrictApiProviderCompletion> {
    const provider = String(input.provider || '').trim().toLowerCase();
    if (!isStrictApiProvider(provider)) throw new Error(`provider ${input.provider} is not a strict API provider`);
    const request = asStrictApiInvokeRequest(input.request);
    if (request.action !== 'complete') throw new Error(`unsupported strict API holder action: ${String(request.action)}`);
    const payload = asStrictCompletionPayload(request.payload);
    const baseUrl = (options.baseUrls?.[provider] || defaultStrictApiBaseUrl(provider)).replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), payload.timeout);
    try {
      const secret = input.secret.toString('utf8');
      const body: Record<string, unknown> = {
        model: payload.model || defaultStrictApiModel(provider),
        messages: payload.messages,
      };
      if (payload.tools?.length) body.tools = payload.tools;
      if (payload.tool_choice !== undefined) body.tool_choice = payload.tool_choice;
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`${provider} API request failed (${response.status}): ${redactErrorText(text)}`);
      }
      const data = await response.json();
      return normalizeOpenAiCompatibleResponse(provider, data, payload.model);
    } catch (error) {
      clearTimeout(timer);
      throw new Error(redactErrorText((error as Error).message));
    }
  };
}

export function createProductionCredentialHolderService(options: {
  socketPath?: string;
  peerHelperCommand?: string;
  peerCredentialResolver?: PeerCredentialResolver['lookup'];
  fetchImpl?: typeof fetch;
  baseUrls?: Partial<Record<string, string>>;
} = {}): CredentialHolderService {
  return new CredentialHolderService({
    socketPath: options.socketPath ?? defaultCredentialHolderSocketPath(),
    peerCredentialResolver: options.peerCredentialResolver ?? createPeerCredentialResolver({
      helperCommand: options.peerHelperCommand,
    }).lookup,
    providerInvoker: createStrictApiProviderInvoker({
      fetchImpl: options.fetchImpl,
      baseUrls: options.baseUrls,
    }),
  });
}

function defaultStrictApiBaseUrl(provider: string): string {
  switch (provider) {
    case 'openrouter':
      return 'https://openrouter.ai/api/v1';
    case 'deepseek':
      return 'https://api.deepseek.com/v1';
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'qwen':
      return 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    default:
      throw new Error(`unsupported strict API provider: ${provider}`);
  }
}

function defaultStrictApiModel(provider: string): string {
  switch (provider) {
    case 'openrouter':
      return 'auto';
    case 'deepseek':
      return 'deepseek-v4-pro';
    case 'openai':
      return 'gpt-5';
    case 'qwen':
      return 'qwen-plus';
    default:
      return 'auto';
  }
}

function asStrictApiInvokeRequest(value: unknown): StrictApiInvokeRequest {
  if (!value || typeof value !== 'object') throw new Error('strict API provider_call request must be an object');
  return value as StrictApiInvokeRequest;
}

function asStrictCompletionPayload(value: unknown): StrictApiCompletionPayload['payload'] {
  if (!value || typeof value !== 'object') throw new Error('strict API completion payload must be an object');
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, 'apiUrl')) {
    throw new Error('strict API completion payload cannot override apiUrl; endpoint is holder-owned');
  }
  const messages = Array.isArray(record.messages) ? record.messages : [];
  if (messages.length === 0) throw new Error('strict API completion payload requires messages');
  const normalizedMessages = messages.map((message) => {
    if (!message || typeof message !== 'object') throw new Error('strict API message must be an object');
    const m = message as Record<string, unknown>;
    const role = typeof m.role === 'string' ? m.role : 'user';
    const content = typeof m.content === 'string'
      ? m.content
      : m.content === null
        ? null
        : JSON.stringify(m.content ?? '');
    const normalized: Record<string, unknown> = { role, content };
    const toolCalls = Array.isArray(m.tool_calls)
      ? m.tool_calls
      : Array.isArray(m.toolCalls)
        ? m.toolCalls
        : undefined;
    if (toolCalls) normalized.tool_calls = toolCalls;
    const toolCallId = typeof m.tool_call_id === 'string'
      ? m.tool_call_id
      : typeof m.toolCallId === 'string'
        ? m.toolCallId
        : undefined;
    if (toolCallId) normalized.tool_call_id = toolCallId;
    if (typeof m.name === 'string' && m.name.trim()) normalized.name = m.name.trim();
    return normalized;
  });
  let tools: unknown[] | undefined;
  if (Object.prototype.hasOwnProperty.call(record, 'tools')) {
    if (!Array.isArray(record.tools)) throw new Error('strict API completion payload tools must be an array');
    tools = record.tools;
  }
  const toolChoice = Object.prototype.hasOwnProperty.call(record, 'tool_choice')
    ? record.tool_choice
    : record.toolChoice;
  if (
    toolChoice !== undefined &&
    typeof toolChoice !== 'string' &&
    !(toolChoice && typeof toolChoice === 'object')
  ) {
    throw new Error('strict API completion payload tool_choice must be a string or object');
  }
  const timeout = typeof record.timeout === 'number' && Number.isFinite(record.timeout) && record.timeout > 0
    ? record.timeout
    : 30000;
  return {
    messages: normalizedMessages,
    model: typeof record.model === 'string' && record.model.trim() ? record.model.trim() : undefined,
    ...(tools?.length ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    timeout,
  };
}

function normalizeOpenAiCompatibleResponse(
  provider: string,
  data: unknown,
  requestedModel?: string,
): StrictApiProviderCompletion {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0] && typeof choices[0] === 'object' ? choices[0] as Record<string, unknown> : {};
  const message = first.message && typeof first.message === 'object' ? first.message as Record<string, unknown> : {};
  const content = typeof message.content === 'string' ? message.content : '';
  const usage = record.usage && typeof record.usage === 'object' ? record.usage as Record<string, unknown> : {};
  return {
    content,
    model: typeof record.model === 'string' ? record.model : requestedModel,
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : undefined,
    finishReason: typeof first.finish_reason === 'string' ? first.finish_reason : undefined,
    usage: {
      promptTokens: numberValue(usage.prompt_tokens),
      completionTokens: numberValue(usage.completion_tokens),
      totalTokens: numberValue(usage.total_tokens),
    },
    cost: undefined,
  };
}

function normalizeStrictApiCompletion(value: unknown): StrictApiProviderCompletion {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    content: typeof record.content === 'string' ? record.content : String(record.text || ''),
    model: typeof record.model === 'string' ? record.model : undefined,
    toolCalls: Array.isArray(record.toolCalls) ? record.toolCalls : undefined,
    finishReason: typeof record.finishReason === 'string' ? record.finishReason : undefined,
    reasoningContent: typeof record.reasoningContent === 'string' ? record.reasoningContent : undefined,
    usage: record.usage && typeof record.usage === 'object'
      ? record.usage as StrictApiProviderCompletion['usage']
      : undefined,
    cost: record.cost,
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function redactErrorText(value: string): string {
  return String(redactCredentialMaterial(value));
}
