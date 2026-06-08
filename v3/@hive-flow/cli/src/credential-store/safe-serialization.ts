const REDACTED = '[REDACTED]';

const SECRET_KEY_NAMES = /^(?:api[_-]?key|authorization|cookie|token|secret|password)$/i;
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bor-[A-Za-z0-9._-]+/g,
  /\bsk-[A-Za-z0-9._-]+/g,
  /\bsk-ant-[A-Za-z0-9._-]+/g,
  /\bBearer\s+[A-Za-z0-9._-]+/gi,
  /\bAIza[A-Za-z0-9._-]+/g,
  /\bCURSOR[A-Za-z0-9._-]*/g,
];

function redactString(value: string): string {
  let rendered = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    rendered = rendered.replace(pattern, REDACTED);
  }
  return rendered;
}

export function redactCredentialMaterial<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map(entry => redactCredentialMaterial(entry)) as T;
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_NAMES.test(key)) {
      result[key] = REDACTED;
      continue;
    }
    if (key === 'env' && entry && typeof entry === 'object') {
      const env: Record<string, unknown> = {};
      for (const [envKey, envValue] of Object.entries(entry as Record<string, unknown>)) {
        env[envKey] = /(?:API_KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|CURSOR|QWEN|DASHSCOPE)/i.test(envKey)
          ? REDACTED
          : redactCredentialMaterial(envValue);
      }
      result[key] = env;
      continue;
    }
    result[key] = redactCredentialMaterial(entry);
  }
  return result as T;
}

export function serializeCredentialSafeJson(value: unknown): string {
  return JSON.stringify(redactCredentialMaterial(value), null, 2);
}
