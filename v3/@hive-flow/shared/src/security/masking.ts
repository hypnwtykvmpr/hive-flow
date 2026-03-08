/**
 * Sensitive Data Masking Utility
 *
 * Redacts sensitive information from objects, strings, and logs.
 *
 * @module v3/shared/security/masking
 */

/**
 * List of keys that are considered sensitive and should be masked
 */
export const SENSITIVE_KEYS = [
  'token',
  'password',
  'secret',
  'apiKey',
  'api_key',
  'authorization',
  'auth',
  'credential',
  'credentials',
  'privateKey',
  'private_key',
  'secretKey',
  'secret_key',
  'access_token',
  'refresh_token',
  'session_id',
  'cookie',
  'jwt',
  'passphrase',
  'client_secret',
  'otp',
  'pin',
];

/**
 * Mask value for redacted data
 */
export const MASK_VALUE = '[MASKED]';

/**
 * Masks sensitive data in an object or string
 * @param data Data to mask (object, array, or string)
 * @returns Masked data
 */
export function maskSensitiveData<T>(data: T, _seen = new WeakSet()): T {
  if (data === null || data === undefined) {
    return data;
  }

  // Handle string
  if (typeof data === 'string') {
    return maskString(data) as unknown as T;
  }

  // Handle array
  if (Array.isArray(data)) {
    if (_seen.has(data)) {
      return '[Circular]' as unknown as T;
    }
    _seen.add(data);
    return data.map((item) => maskSensitiveData(item, _seen)) as unknown as T;
  }

  // Handle object
  if (typeof data === 'object') {
    if (_seen.has(data as object)) {
      return '[Circular]' as unknown as T;
    }
    _seen.add(data as object);
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        result[key] = MASK_VALUE;
      } else {
        result[key] = maskSensitiveData(value, _seen);
      }
    }
    return result as unknown as T;
  }

  return data;
}

/**
 * Checks if a key is sensitive
 * @param key Key to check
 * @returns True if sensitive
 */
function isSensitiveKey(key: string): boolean {
  const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');
  return SENSITIVE_KEYS.some((sensitive) => {
    const normalizedSensitive = sensitive.toLowerCase().replace(/[-_]/g, '');
    return normalizedKey.includes(normalizedSensitive);
  });
}

/**
 * Masks sensitive patterns in a string (e.g., Bearer tokens)
 * @param input String to mask
 * @returns Masked string
 */
function maskString(input: string): string {
  let masked = input;

  // Mask Bearer tokens
  masked = masked.replace(/Bearer\s+[a-zA-Z0-9._~+/-]+=*/gi, `Bearer ${MASK_VALUE}`);

  // Mask Basic auth
  masked = masked.replace(/Basic\s+[a-zA-Z0-9._~+/-]+=*/gi, `Basic ${MASK_VALUE}`);

  // Mask potential API keys in URLs
  masked = masked.replace(/(api[_-]?key=)[a-zA-Z0-9._~+/-]+/gi, `$1${MASK_VALUE}`);
  masked = masked.replace(/(token=)[a-zA-Z0-9._~+/-]+/gi, `$1${MASK_VALUE}`);

  return masked;
}
