/**
 * V3 Agentic Wrapper for External CLI Providers
 *
 * Wraps Codex, Gemini, and Cursor CLIs in their native agentic mode
 * (full tool execution handled by the provider). Manages subprocess
 * lifecycle, real-time event parsing, timing, and provider metrics.
 *
 * @module @hive-flow/providers/agentic-wrapper
 */

import { spawn, ChildProcess, execFile } from 'child_process';
import { createInterface } from 'readline';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';

// ===== Types =====

export type AgenticProvider = 'codex-cli' | 'gemini-cli' | 'cursor-cli';

export interface AgenticOptions {
  /** Timeout in milliseconds (default: 120_000, max: 600_000) */
  timeout?: number;
  /** Working directory for the subprocess */
  cwd?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Path to provider-usage.json (default: .hive-flow/metrics/provider-usage.json) */
  metricsPath?: string;
}

export interface AgenticToolEvent {
  tool: string;
  timestamp: number;
}

export interface AgenticResult {
  /** Final text content from the provider */
  content: string;
  /** Tools invoked by the provider during agentic execution */
  toolsUsed: AgenticToolEvent[];
  /** Token usage reported by the provider */
  tokens: { prompt: number; completion: number; total: number };
  /** Timing information */
  duration: { startMs: number; ttfbMs: number | null; totalMs: number };
  /** Subprocess exit code */
  exitCode: number | null;
}

interface ProviderMetrics {
  calls: number;
  tokens: number;
  ttfb_avg_ms: number;
  last_used: string;
}

type MetricsFile = Record<string, ProviderMetrics>;

// ===== Binary resolution =====

function whichBinary(name: string): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(cmd, [name], (err, stdout) => {
      resolve(!err && stdout.trim() ? stdout.trim().split('\n')[0].trim() : null);
    });
  });
}

async function resolveBinary(provider: AgenticProvider): Promise<string> {
  const names: Record<AgenticProvider, string[]> = {
    'codex-cli': ['codex'],
    // DO-NOT-REVERT (2026-06): `gemini-cli` resolves Google's ANTIGRAVITY binary
    // `agy`, NOT the dead `@google/gemini-cli` (`gemini`). The legacy `gemini`
    // binary's backend returns HTTP 404 ModelNotFoundError for current models
    // (e.g. gemini-3.5-flash). `agy` is the live Go rewrite. Reverting this to
    // `['gemini']` reintroduces the 404 regression. A stale `gemini` may still
    // exist on PATH (e.g. /opt/homebrew/bin/gemini) — listing it here would
    // resolve the WRONG CLI. MUST be `['agy']`.
    'gemini-cli': ['agy'],
    'cursor-cli': ['cursor-agent', 'cursor'],
  };
  for (const name of names[provider]) {
    const path = await whichBinary(name);
    if (path) return path;
  }
  throw new Error(`Binary not found for ${provider}. Searched: ${names[provider].join(', ')}`);
}

// ===== Minimal environment =====

function minimalEnv(extra?: Record<string, string>): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    SHELL: process.env.SHELL,
    LANG: process.env.LANG,
    TERM: process.env.TERM,
    TMPDIR: process.env.TMPDIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    // Auth keys (forwarded if present, never hardcoded)
    CODEX_API_KEY: process.env.CODEX_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    CURSOR_API_KEY: process.env.CURSOR_API_KEY,
    CODEX_HOME: process.env.CODEX_HOME,
    // Proxy
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    no_proxy: process.env.no_proxy,
    ...extra,
  };
}

// ===== Event parsing helpers =====

/** Detect tool usage from a parsed JSONL event object. */
function extractToolEvent(evt: Record<string, unknown>): AgenticToolEvent | null {
  // Codex: item.completed with item.type like "tool_call", "file_edit", "shell_command"
  if (evt.type === 'item.completed') {
    const item = evt.item as Record<string, unknown> | undefined;
    if (item && typeof item.type === 'string' && item.type !== 'agent_message') {
      return { tool: item.type, timestamp: Date.now() };
    }
  }
  // Gemini stream-json: type "tool_use" or "function_call"
  if (evt.type === 'tool_use' || evt.type === 'function_call') {
    const name = (evt as Record<string, unknown>).name as string || String(evt.type);
    return { tool: name, timestamp: Date.now() };
  }
  // Cursor: tool events
  if (evt.type === 'tool_call' || evt.type === 'tool_result') {
    const name = (evt as Record<string, unknown>).name as string || String(evt.type);
    return { tool: name, timestamp: Date.now() };
  }
  return null;
}

/** Extract token usage from a parsed event. */
function extractTokens(
  evt: Record<string, unknown>,
  current: { prompt: number; completion: number }
): { prompt: number; completion: number } {
  // Codex: turn.completed with usage
  if (evt.type === 'turn.completed') {
    const usage = evt.usage as Record<string, number> | undefined;
    if (usage) {
      return {
        prompt: usage.input_tokens || current.prompt,
        completion: usage.output_tokens || current.completion,
      };
    }
  }
  // Gemini: stats block
  if (evt.stats) {
    const models = (evt.stats as Record<string, unknown>).models as Record<string, Record<string, Record<string, number>>> | undefined;
    if (models) {
      const first = Object.values(models)[0];
      if (first?.tokens) {
        return {
          prompt: first.tokens.prompt || current.prompt,
          completion: first.tokens.candidates || current.completion,
        };
      }
    }
  }
  // Cursor: usage block
  if (evt.usage) {
    const u = evt.usage as Record<string, number>;
    return {
      prompt: u.input_tokens || u.prompt_tokens || current.prompt,
      completion: u.output_tokens || u.completion_tokens || current.completion,
    };
  }
  return current;
}

/** Extract content text from a parsed event. */
function extractContent(evt: Record<string, unknown>): string {
  // Codex: item.completed with agent_message
  if (evt.type === 'item.completed') {
    const item = evt.item as Record<string, unknown> | undefined;
    if (item?.type === 'agent_message' && typeof item.text === 'string') {
      return item.text;
    }
  }
  // Gemini: response field or message.content
  if (typeof evt.response === 'string') return evt.response;
  if (evt.type === 'message') {
    const msg = evt.message as Record<string, unknown> | undefined;
    const c = msg?.content ?? evt.content;
    if (typeof c === 'string') return c;
  }
  if (typeof evt.content === 'string') return evt.content;
  // Cursor: result field
  if (typeof evt.result === 'string') return evt.result;
  return '';
}

// ===== AgenticWrapper =====

export class AgenticWrapper {
  private activeProcesses: Set<ChildProcess> = new Set();

  /**
   * Run a provider in full agentic mode (provider handles its own tool execution).
   */
  async runAgentic(
    provider: AgenticProvider,
    task: string,
    options?: AgenticOptions
  ): Promise<AgenticResult> {
    const timeout = Math.min(Math.max(options?.timeout ?? 120_000, 1000), 600_000);
    const binary = await resolveBinary(provider);
    const args = this.buildArgs(provider, task);
    const startMs = Date.now();

    const child = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options?.cwd,
      env: minimalEnv(options?.env),
    });
    this.activeProcesses.add(child);

    // All providers receive prompt via stdin
    child.stdin.on('error', () => { /* EPIPE — child exited before read */ });
    child.stdin.write(task);
    child.stdin.end();

    const rl = createInterface({ input: child.stdout! });
    const toolsUsed: AgenticToolEvent[] = [];
    let tokens = { prompt: 0, completion: 0 };
    let content = '';
    let ttfbMs: number | null = null;
    let exitCode: number | null = null;

    return new Promise<AgenticResult>((res, rej) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        this.activeProcesses.delete(child);
        rl.close();
        rej(new Error(`Agentic execution timed out after ${timeout}ms (provider: ${provider})`));
      }, timeout);

      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let evt: Record<string, unknown>;
        try { evt = JSON.parse(trimmed); } catch { return; }

        // Track TTFB on first parseable event
        if (ttfbMs === null) ttfbMs = Date.now() - startMs;

        const text = extractContent(evt);
        if (text) content = text; // Last content wins (matches codex/gemini pattern)

        const toolEvt = extractToolEvent(evt);
        if (toolEvt) toolsUsed.push(toolEvt);

        tokens = extractTokens(evt, tokens);
      });

      child.stderr?.on('data', () => { /* swallow stderr */ });

      child.on('close', (code) => {
        clearTimeout(timer);
        this.activeProcesses.delete(child);
        rl.close();
        if (settled) return;
        settled = true;
        exitCode = code;
        const totalMs = Date.now() - startMs;

        const result: AgenticResult = {
          content,
          toolsUsed,
          tokens: { prompt: tokens.prompt, completion: tokens.completion, total: tokens.prompt + tokens.completion },
          duration: { startMs, ttfbMs, totalMs },
          exitCode,
        };

        // Fire-and-forget metrics update
        this.updateMetrics(provider, result, options?.metricsPath).catch((e: unknown) => { console.warn('[AgenticWrapper] non-fatal error:', e); });

        res(result);
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        this.activeProcesses.delete(child);
        rl.close();
        if (settled) return;
        settled = true;
        rej(new Error(`Failed to spawn ${provider}: ${err.message}`));
      });
    });
  }

  /** Kill all active subprocesses. */
  destroy(): void {
    for (const p of this.activeProcesses) {
      try { p.kill('SIGKILL'); } catch { /* already dead */ }
    }
    this.activeProcesses.clear();
  }

  // ===== Private helpers =====

  private buildArgs(provider: AgenticProvider, task: string): string[] {
    switch (provider) {
      case 'codex-cli':
        // Prompt is passed via stdin; flags only here
        return ['exec', '--full-auto', '--json', '--ephemeral', '--skip-git-repo-check'];
      case 'gemini-cli':
        // DO-NOT-REVERT (2026-06): ANTIGRAVITY (`agy`) headless flags, NOT the
        // dead `gemini` flags. `agy` does NOT support `--output-format` /
        // `--yolo` (errors "flags provided but not defined") and emits PLAIN
        // TEXT. Prompt is passed via stdin (empty `--prompt`).
        // `--dangerously-skip-permissions` is agy's headless auto-approve.
        return ['--dangerously-skip-permissions', '--prompt', ''];
      case 'cursor-cli':
        // Prompt is passed via stdin; flags only here
        return ['--print', '--trust', '--force'];
    }
  }

  private async updateMetrics(
    provider: AgenticProvider,
    result: AgenticResult,
    metricsPath?: string
  ): Promise<void> {
    const filePath = resolve(metricsPath || '.hive-flow/metrics/provider-usage.json');
    let data: MetricsFile = {};

    try {
      const raw = await readFile(filePath, 'utf-8');
      data = JSON.parse(raw) as MetricsFile;
    } catch {
      // File doesn't exist or is malformed — start fresh
    }

    const existing = data[provider] || { calls: 0, tokens: 0, ttfb_avg_ms: 0, last_used: '' };
    const newTtfb = result.duration.ttfbMs ?? 0;
    // Rolling average for TTFB
    const avgTtfb = existing.calls === 0
      ? newTtfb
      : Math.round((existing.ttfb_avg_ms * existing.calls + newTtfb) / (existing.calls + 1));

    data[provider] = {
      calls: existing.calls + 1,
      tokens: existing.tokens + result.tokens.total,
      ttfb_avg_ms: avgTtfb,
      last_used: new Date().toISOString(),
    };

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
