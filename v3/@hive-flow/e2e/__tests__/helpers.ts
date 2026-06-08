import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export async function readJsonFixture<T>(relativePath: string): Promise<T> {
  const raw = await readFile(join(packageRoot, '__fixtures__', relativePath), 'utf8');
  return JSON.parse(raw) as T;
}

export function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableJson(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableJson(item)])
    );
  }
  return value;
}

export function compactTextResponse(response: unknown): unknown {
  const result = (response as { result?: { content?: Array<{ text?: string }> } }).result;
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    return response;
  }
  try {
    return {
      ...(response as Record<string, unknown>),
      result: JSON.parse(text),
    };
  } catch {
    return response;
  }
}
