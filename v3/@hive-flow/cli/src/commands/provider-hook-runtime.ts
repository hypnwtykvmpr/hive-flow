import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const CACHE_TTL = 30 * 60 * 1000;

const PROVIDER_PATTERNS = [
  {
    provider: 'gemini-cli',
    model: 'gemini-3.5-flash',
    patterns: [
      /\buse\s+gemini\b/i,
      /\bask\s+gemini\b/i,
      /\bgemini[\s-]cli\b/i,
      /\bgemini\s+agent\b/i,
      /\bgemini[\s-]researcher\b/i,
    ],
  },
  {
    provider: 'codex-cli',
    model: 'gpt-5.5',
    patterns: [
      /\buse\s+codex\b/i,
      /\bask\s+codex\b/i,
      /\bcodex[\s-]cli\b/i,
      /\bcodex\s+agent\b/i,
      /\bcodex[\s-]researcher\b/i,
    ],
  },
  {
    provider: 'cursor-cli',
    model: 'auto',
    patterns: [
      /\buse\s+cursor\b/i,
      /\bcursor\s+agent\b/i,
      /\bcursor[\s-]cli\b/i,
      /\bcursor[\s-]researcher\b/i,
    ],
  },
];

type ProviderName = 'gemini-cli' | 'codex-cli' | 'cursor-cli';

interface ProviderSpec {
  name: ProviderName;
  binary: string;
  fallback?: string;
}

const PROVIDERS: ProviderSpec[] = [
  { name: 'gemini-cli', binary: 'agy' },
  { name: 'codex-cli', binary: 'codex' },
  { name: 'cursor-cli', binary: 'cursor-agent', fallback: 'cursor' },
];

interface ProviderStatus {
  found: boolean;
  version: string | null;
  binary: string;
  timestamp: number;
}

type ProviderStatusMap = Partial<Record<ProviderName, ProviderStatus>>;

export interface ProviderHookRuntime {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  stdin?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  execFile?: typeof execFileSync;
}

function runtimeEnv(runtime: ProviderHookRuntime): NodeJS.ProcessEnv {
  return runtime.env ?? process.env;
}

function runtimeNow(runtime: ProviderHookRuntime): number {
  return runtime.now?.() ?? Date.now();
}

function getHome(runtime: ProviderHookRuntime): string {
  const env = runtimeEnv(runtime);
  return env.HOME || env.USERPROFILE || '/tmp';
}

function getCacheDir(runtime: ProviderHookRuntime): string {
  return join(getHome(runtime), '.hive-flow');
}

function getCachePath(runtime: ProviderHookRuntime): string {
  return join(getCacheDir(runtime), 'provider-status-cache.json');
}

function readStdin(runtime: ProviderHookRuntime): string | null {
  if (runtime.stdin !== undefined) return runtime.stdin;
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return null;
  }
}

export function parseProviderHookPrompt(input: string): string {
  if (!input.trim()) return '';

  try {
    const data = JSON.parse(input);
    return data?.message?.content || data?.prompt || '';
  } catch {
    return input;
  }
}

function readCache(runtime: ProviderHookRuntime): { providers?: ProviderStatusMap; timestamp?: number } | null {
  const cachePath = getCachePath(runtime);
  if (!existsSync(cachePath)) return null;

  try {
    const data = JSON.parse(readFileSync(cachePath, 'utf-8'));
    const age = runtimeNow(runtime) - (data.timestamp || 0);
    if (age > CACHE_TTL) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(runtime: ProviderHookRuntime, providers: ProviderStatusMap): void {
  const cacheDir = getCacheDir(runtime);
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = getCachePath(runtime);
  const tmpPath = `${cachePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({ providers, timestamp: runtimeNow(runtime) }, null, 2));
  renameSync(tmpPath, cachePath);
}

function getProviderVersion(provider: string, runtime: ProviderHookRuntime): string | null {
  const cache = readCache(runtime);
  const entry = cache?.providers?.[provider as ProviderName];
  if (!entry || !entry.found) return null;
  return entry.version || 'installed';
}

export function renderProviderRouteHook(input: string, runtime: ProviderHookRuntime = {}): string {
  const prompt = parseProviderHookPrompt(input);
  if (!prompt || typeof prompt !== 'string') return '';

  for (const { provider, model, patterns } of PROVIDER_PATTERNS) {
    if (!patterns.some((re) => re.test(prompt))) continue;

    const version = getProviderVersion(provider, runtime);
    const versionStr = version ? ` (${version})` : '';
    return (
      `[PROVIDER_SUGGESTION] ${provider} available${versionStr}. ` +
      `Use: agent_spawn { provider: "${provider}", model: "${model}", task: "..." }\n`
    );
  }

  return '';
}

function detectBinary(
  binary: string,
  runtime: ProviderHookRuntime,
  fallback?: string,
): { found: boolean; version: string | null } {
  const execFile = runtime.execFile ?? execFileSync;

  try {
    execFile('which', [binary], { stdio: 'pipe', timeout: 5000 });
  } catch {
    if (fallback) {
      const fallbackResult = detectBinary(fallback, runtime);
      if (fallbackResult.found) return fallbackResult;
    }
    return { found: false, version: null };
  }

  try {
    const output = String(execFile(binary, ['--version'], {
      stdio: 'pipe',
      timeout: 10000,
      encoding: 'utf-8',
    })).trim();
    return { found: true, version: output.split('\n')[0].slice(0, 80) };
  } catch {
    return { found: true, version: 'unknown' };
  }
}

export function collectProviderStatuses(runtime: ProviderHookRuntime = {}): ProviderStatusMap {
  const cached = readCache(runtime);
  if (cached?.providers) return cached.providers;

  const providers: ProviderStatusMap = {};
  for (const { name, binary, fallback } of PROVIDERS) {
    const result = detectBinary(binary, runtime, fallback);
    providers[name] = {
      found: result.found,
      version: result.version,
      binary,
      timestamp: runtimeNow(runtime),
    };
  }

  writeCache(runtime, providers);
  return providers;
}

export function renderProviderStatusHook(providers: ProviderStatusMap): string {
  const parts: string[] = [];
  for (const { name } of PROVIDERS) {
    const info = providers[name];
    if (!info) {
      parts.push(`${name}: unknown`);
    } else if (info.found) {
      parts.push(`${name}: ${info.version || 'installed'}`);
    } else {
      parts.push(`${name}: not found`);
    }
  }

  const foundCount = Object.values(providers).filter((p) => p?.found).length;
  return foundCount > 0 ? `[PROVIDERS] ${parts.join(', ')}\n` : '';
}

export async function runProviderRouteHook(runtime: ProviderHookRuntime = {}): Promise<void> {
  try {
    const input = readStdin(runtime);
    if (input === null) return;
    const output = renderProviderRouteHook(input, runtime);
    if (output) (runtime.stdout ?? process.stdout.write.bind(process.stdout))(output);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    (runtime.stderr ?? process.stderr.write.bind(process.stderr))(`[provider-route-hook] Error: ${message}\n`);
  }
}

export async function runProviderStatusHook(runtime: ProviderHookRuntime = {}): Promise<void> {
  try {
    readStdin(runtime);
    const output = renderProviderStatusHook(collectProviderStatuses(runtime));
    if (output) (runtime.stdout ?? process.stdout.write.bind(process.stdout))(output);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    (runtime.stderr ?? process.stderr.write.bind(process.stderr))(`[provider-status-hook] Error: ${message}\n`);
  }
}
