/**
 * V3 Cursor CLI Subprocess Provider
 *
 * Wraps the `cursor-agent` binary (falling back to `cursor agent` subcommand) as a subprocess provider.
 * Uses --print flag for non-interactive mode (resolves TTY requirement).
 * Auth: CURSOR_API_KEY environment variable or --api-key flag.
 *
 * Invocation patterns (prompt piped via stdin):
 * - Non-streaming: echo "prompt" | cursor --print --output-format json --model <model>
 * - Streaming:     echo "prompt" | cursor --print --output-format stream-json --stream-partial-output --model <model>
 *
 * @module @hive-flow/providers/cursor-cli-provider
 */

import { spawn, ChildProcess, execFile, execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { createInterface } from 'readline';
import { EventEmitter } from 'events';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import {
  LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent,
  LLMMessage, LLMTool, LLMToolCall, ModelInfo, ProviderCapabilities, HealthCheckResult,
  LLMProviderError, ProviderUnavailableError,
} from './types.js';
import { parseToolCallsFromContent, formatToolInstructions, flushToolCallsFromBuffer } from './tool-call-utils.js';

const CURSOR_MODELS: LLMModel[] = [
  'auto',
  'composer-2.5', 'composer-2.5-fast',
  'composer-2', 'composer-2-fast', 'composer-1.5', 'composer-1',
  'claude-fable-5-high', 'claude-fable-5-thinking-high',
  'claude-opus-4-8-high', 'claude-opus-4-8-thinking-high',
  'claude-sonnet-5-high', 'claude-sonnet-5-thinking-high',
  'gpt-5.5-high', 'gpt-5.5-medium',
  'gpt-5.4-high', 'gpt-5.4-medium',
  'gemini-3.1-pro', 'gemini-3-flash', 'gemini-3.5-flash',
  'gpt-5.3-codex-xhigh', 'gpt-5.3-codex-xhigh-fast',
  'gpt-5.3-codex-high', 'gpt-5.3-codex-high-fast',
  'gpt-5.3-codex', 'gpt-5.3-codex-fast',
  'gpt-5.3-codex-low', 'gpt-5.3-codex-low-fast',
  'gpt-5.3-codex-spark-preview', 'gpt-5.3-codex-spark-preview-xhigh',
  'gpt-5.3-codex-spark-preview-high', 'gpt-5.3-codex-spark-preview-low',
  'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.2-codex-low',
];

const MODEL_DESC: Record<string, string> = {
  'auto': 'Auto - Cursor selects optimal model',
  'composer-2.5': 'Composer 2.5 - Latest Cursor-native model',
  'composer-2.5-fast': 'Composer 2.5 Fast - Fast Cursor-native model',
  'composer-2': 'Composer 2 - Legacy Cursor-native model',
  'composer-2-fast': 'Composer 2 Fast - Legacy fast Cursor-native model',
  'composer-1.5': 'Composer 1.5 - Previous Cursor-native model',
  'composer-1': 'Composer 1 - Legacy Cursor-native model',
  'claude-fable-5-high': 'Claude Fable 5 via Cursor - high capability',
  'claude-fable-5-thinking-high': 'Claude Fable 5 Thinking via Cursor - high capability',
  'claude-opus-4-8-high': 'Claude Opus 4.8 via Cursor - high capability',
  'claude-opus-4-8-thinking-high': 'Claude Opus 4.8 Thinking via Cursor - high capability',
  'claude-sonnet-5-high': 'Claude Sonnet 5 via Cursor - balanced agentic work',
  'claude-sonnet-5-thinking-high': 'Claude Sonnet 5 Thinking via Cursor - balanced agentic work',
  'gpt-5.5-high': 'GPT-5.5 via Cursor - high reasoning',
  'gpt-5.5-medium': 'GPT-5.5 via Cursor - balanced reasoning',
  'gpt-5.4-high': 'GPT-5.4 via Cursor - high reasoning',
  'gpt-5.4-medium': 'GPT-5.4 via Cursor - balanced reasoning',
  'gemini-3.1-pro': 'Gemini 3.1 Pro via Cursor',
  'gemini-3-flash': 'Gemini 3 Flash via Cursor',
  'gemini-3.5-flash': 'Gemini 3.5 Flash via Cursor',
  'gpt-5.3-codex-xhigh': 'GPT-5.3 Codex XHigh via Cursor - Max reasoning',
  'gpt-5.3-codex-xhigh-fast': 'GPT-5.3 Codex XHigh Fast via Cursor',
  'gpt-5.3-codex-high': 'GPT-5.3 Codex High via Cursor - Strong reasoning',
  'gpt-5.3-codex-high-fast': 'GPT-5.3 Codex High Fast via Cursor',
  'gpt-5.3-codex': 'GPT-5.3 Codex via Cursor - Balanced',
  'gpt-5.3-codex-fast': 'GPT-5.3 Codex Fast via Cursor',
  'gpt-5.3-codex-low': 'GPT-5.3 Codex Low via Cursor - Cost-efficient',
  'gpt-5.3-codex-low-fast': 'GPT-5.3 Codex Low Fast via Cursor',
  'gpt-5.3-codex-spark-preview': 'GPT-5.3 Codex Spark via Cursor',
  'gpt-5.3-codex-spark-preview-xhigh': 'GPT-5.3 Codex Spark XHigh via Cursor',
  'gpt-5.3-codex-spark-preview-high': 'GPT-5.3 Codex Spark High via Cursor',
  'gpt-5.3-codex-spark-preview-low': 'GPT-5.3 Codex Spark Low via Cursor',
  'gpt-5.2': 'GPT-5.2 via Cursor - General purpose',
  'gpt-5.2-codex': 'GPT-5.2 Codex via Cursor - Code-focused',
  'gpt-5.2-codex-low': 'GPT-5.2 Codex Low via Cursor - Lightweight',
};

const FREE = { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' };

/** Safety limit to prevent unbounded stdout accumulation */
const MAX_STDOUT_BYTES = 50 * 1024 * 1024; // 50 MB

// F0-A (hive-flow-9331) Slice B: cursor has no proven OS write-confinement, so
// read-only-with-artifacts fails closed to no-edit plan mode. This honest note is
// surfaced (metadata / debug log) so callers never assume artifacts were persisted.
export const CURSOR_ARTIFACT_DISABLED_REASON =
  'cursor read-only-with-artifacts: artifact writes are DISABLED (fail-closed to plan mode). cursor has no proven sandbox write-confinement; use an API provider or codex for artifact-producing tasks. See hive-flow-9331.';

// ============================================================================
// slice 5 / cursor timeout-budget — PROMPT-SIZE-AWARE TIMEOUT
//
// WHY: cursor's timeout used to be a FLAT 120s (CURSOR_BASE_TIMEOUT_MS) for
// every request, and the agentic path was hard-clamped to a 600s ceiling.
// Large cursor prompts (~66K+ chars baseline; some workflows push 200K) routinely
// exceed 120s and can hit the 600s ceiling, causing SPURIOUS timeouts on prompts
// that would otherwise succeed. We scale the budget with prompt size, mirroring
// the gemini GEMINI_STDIN_PROMPT_THRESHOLD size-threshold pattern.
//
// DO-NOT-REVERT to a flat 120s/600s without revisiting slice 5. The dispatch
// layer (agent-tools.ts) already permits up to 3_600_000ms (60min); the real
// bottleneck was these provider/wrapper clamps, not dispatch.
// ============================================================================

/**
 * Prompt length (chars) at/above which the timeout budget starts scaling.
 * Aligned with gemini's GEMINI_STDIN_PROMPT_THRESHOLD (24_000) so both CLI
 * providers treat "large prompt" identically. Below this, behavior is unchanged
 * (flat base budget).
 */
export const CURSOR_LARGE_PROMPT_THRESHOLD = 24_000;

/** Base timeout (ms) for small prompts — preserves the historical flat default. */
export const CURSOR_BASE_TIMEOUT_MS = 120_000;

/**
 * Extra budget (ms) granted per 1K chars of prompt ABOVE the threshold.
 * Tuned so a ~66K prompt (~42K over threshold) gets ~120s + 42*1.5s ≈ 183s,
 * and a 200K prompt (~176K over) gets ~120s + 176*1.5s ≈ 384s — comfortably
 * under the raised ceiling while well above the old flat 120s that was timing out.
 */
export const CURSOR_TIMEOUT_PER_KCHAR_MS = 1_500;

/**
 * Raised ceiling (ms) for the scaled budget. 900s (15min) is a sane upper bound:
 * it is >= what very large prompts realistically need, stays under the dispatch
 * cap of 3_600_000ms, and is shared with the agentic-wrapper large-prompt clamp
 * (single source of truth — see agentic-wrapper.ts import).
 */
export const CURSOR_MAX_TIMEOUT_MS = 900_000;

/**
 * Hard ceiling (ms) for the streaming / FIFO budget. The streaming and tmux-FIFO
 * paths legitimately run longer than a direct completion, so their scaled budget
 * is multiplied (see CURSOR_STREAM_MULTIPLIER) — but the result is RE-CLAMPED to
 * this ceiling so a 200K prompt can never blow past a sane upper bound (F2).
 * Set to CURSOR_MAX_TIMEOUT_MS so streaming shares the same single ceiling as the
 * direct path and the agentic-wrapper clamp.
 */
export const CURSOR_STREAM_MAX_TIMEOUT_MS = CURSOR_MAX_TIMEOUT_MS;

/** Multiplier applied to the SCALED budget for streaming / FIFO paths only. */
export const CURSOR_STREAM_MULTIPLIER = 2;

/**
 * Pure, prompt-size-aware timeout helper for cursor.
 *
 * - If `explicit` is provided (caller-supplied `request.timeout`), it is returned
 *   verbatim — caller override always wins (slice 5 contract). NaN/negative
 *   explicit values are ignored (treated as "no override") so a malformed caller
 *   value can never zero-out or NaN the timer (F4).
 * - Otherwise: BASE for prompts below the threshold, then a linear ramp of
 *   CURSOR_TIMEOUT_PER_KCHAR_MS per 1K chars above the threshold, clamped to
 *   [BASE, MAX]. Monotonically non-decreasing in promptChars. A NaN/negative
 *   promptChars is floored to 0 (F4).
 *
 * Exported for deterministic unit testing (no fake timers needed).
 */
export function computeCursorTimeout(promptChars: number, explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) return explicit;
  const chars = Number.isFinite(promptChars) && promptChars > 0 ? promptChars : 0;
  const overThreshold = Math.max(0, chars - CURSOR_LARGE_PROMPT_THRESHOLD);
  const scaled = CURSOR_BASE_TIMEOUT_MS + (overThreshold / 1000) * CURSOR_TIMEOUT_PER_KCHAR_MS;
  return Math.min(Math.max(scaled, CURSOR_BASE_TIMEOUT_MS), CURSOR_MAX_TIMEOUT_MS);
}

/**
 * Streaming / FIFO budget helper (F2 + F3).
 *
 * Precedence (shared with the direct path): explicit request.timeout > config
 * fallback > scaled computeCursorTimeout(promptChars).
 *
 * - An EXPLICIT request.timeout (or config fallback) is honored VERBATIM and is
 *   NEVER silently doubled — the documented verbatim-honor contract (F2). The
 *   caller owns that value; we do not breach it in either direction.
 * - Only the SCALED default (no explicit/config value) gets the streaming
 *   multiplier, and the multiplied result is RE-CLAMPED to
 *   CURSOR_STREAM_MAX_TIMEOUT_MS so it cannot exceed the shared ceiling (F2).
 */
export function computeCursorStreamTimeout(
  promptChars: number,
  explicit?: number,
): number {
  // Explicit/config value wins verbatim — honored, not doubled.
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) return explicit;
  const scaled = computeCursorTimeout(promptChars);
  const multiplied = scaled * CURSOR_STREAM_MULTIPLIER;
  return Math.min(Math.max(multiplied, CURSOR_BASE_TIMEOUT_MS), CURSOR_STREAM_MAX_TIMEOUT_MS);
}

/**
 * stderr patterns that indicate cursor-cli requires a real TTY and cannot
 * operate in non-interactive pipe mode. When matched, the tmux fallback is
 * attempted.
 */
const TTY_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /not a tty/i,
  /no tty/i,
  /tty.*required/i,
  /requires.*tty/i,
  /inappropriate ioctl for device/i,
  /isatty/i,
  /stdin.*interactive/i,
  /interactive.*stdin/i,
];

function calcCost(prompt: number, completion: number, pricing: { promptCostPer1k: number; completionCostPer1k: number }) {
  const p = (prompt / 1000) * pricing.promptCostPer1k;
  const c = (completion / 1000) * pricing.completionCostPer1k;
  return { promptCost: p, completionCost: c, totalCost: p + c, currency: 'USD' };
}

export class CursorCLIProvider extends BaseProvider {
  readonly name: LLMProvider = 'cursor-cli';
  readonly capabilities: ProviderCapabilities = {
    supportedModels: CURSOR_MODELS,
    maxContextLength: {
      'auto': 200000,
      'composer-2.5': 200000, 'composer-2.5-fast': 200000,
      'composer-2': 200000, 'composer-2-fast': 200000,
      'composer-1.5': 200000, 'composer-1': 200000,
      'claude-fable-5-high': 1000000, 'claude-fable-5-thinking-high': 1000000,
      'claude-opus-4-8-high': 1000000, 'claude-opus-4-8-thinking-high': 1000000,
      'claude-sonnet-5-high': 1000000, 'claude-sonnet-5-thinking-high': 1000000,
      'gpt-5.5-high': 1000000, 'gpt-5.5-medium': 1000000,
      'gpt-5.4-high': 1000000, 'gpt-5.4-medium': 1000000,
      'gemini-3.1-pro': 1000000, 'gemini-3-flash': 1000000, 'gemini-3.5-flash': 1000000,
      'gpt-5.3-codex-xhigh': 200000, 'gpt-5.3-codex-xhigh-fast': 200000,
      'gpt-5.3-codex-high': 200000, 'gpt-5.3-codex-high-fast': 200000,
      'gpt-5.3-codex': 200000, 'gpt-5.3-codex-fast': 200000,
      'gpt-5.3-codex-low': 200000, 'gpt-5.3-codex-low-fast': 200000,
      'gpt-5.3-codex-spark-preview': 200000, 'gpt-5.3-codex-spark-preview-xhigh': 200000,
      'gpt-5.3-codex-spark-preview-high': 200000, 'gpt-5.3-codex-spark-preview-low': 200000,
      'gpt-5.2': 200000, 'gpt-5.2-codex': 200000, 'gpt-5.2-codex-low': 200000,
    },
    maxOutputTokens: {
      'auto': 32768,
      'composer-2.5': 32768, 'composer-2.5-fast': 32768,
      'composer-2': 32768, 'composer-2-fast': 32768,
      'composer-1.5': 32768, 'composer-1': 16384,
      'claude-fable-5-high': 131072, 'claude-fable-5-thinking-high': 131072,
      'claude-opus-4-8-high': 131072, 'claude-opus-4-8-thinking-high': 131072,
      'claude-sonnet-5-high': 131072, 'claude-sonnet-5-thinking-high': 131072,
      'gpt-5.5-high': 128000, 'gpt-5.5-medium': 128000,
      'gpt-5.4-high': 128000, 'gpt-5.4-medium': 128000,
      'gemini-3.1-pro': 65536, 'gemini-3-flash': 65536, 'gemini-3.5-flash': 65536,
      'gpt-5.3-codex-xhigh': 65536, 'gpt-5.3-codex-xhigh-fast': 65536,
      'gpt-5.3-codex-high': 32768, 'gpt-5.3-codex-high-fast': 32768,
      'gpt-5.3-codex': 32768, 'gpt-5.3-codex-fast': 32768,
      'gpt-5.3-codex-low': 16384, 'gpt-5.3-codex-low-fast': 16384,
      'gpt-5.3-codex-spark-preview': 65536, 'gpt-5.3-codex-spark-preview-xhigh': 65536,
      'gpt-5.3-codex-spark-preview-high': 32768, 'gpt-5.3-codex-spark-preview-low': 16384,
      'gpt-5.2': 16384, 'gpt-5.2-codex': 32768, 'gpt-5.2-codex-low': 16384,
    },
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsSystemMessages: true,
    supportsVision: false,
    supportsAudio: false,
    supportsFineTuning: false,
    supportsEmbeddings: false,
    supportsBatching: false,
    rateLimit: { requestsPerMinute: 60, tokensPerMinute: 1000000, concurrentRequests: 5 },
    pricing: {
      'auto': FREE,
      'composer-2.5': FREE, 'composer-2.5-fast': FREE,
      'composer-2': FREE, 'composer-2-fast': FREE,
      'composer-1.5': FREE, 'composer-1': FREE,
      'claude-fable-5-high': FREE, 'claude-fable-5-thinking-high': FREE,
      'claude-opus-4-8-high': FREE, 'claude-opus-4-8-thinking-high': FREE,
      'claude-sonnet-5-high': FREE, 'claude-sonnet-5-thinking-high': FREE,
      'gpt-5.5-high': FREE, 'gpt-5.5-medium': FREE,
      'gpt-5.4-high': FREE, 'gpt-5.4-medium': FREE,
      'gemini-3.1-pro': FREE, 'gemini-3-flash': FREE, 'gemini-3.5-flash': FREE,
      'gpt-5.3-codex-xhigh': FREE, 'gpt-5.3-codex-xhigh-fast': FREE,
      'gpt-5.3-codex-high': FREE, 'gpt-5.3-codex-high-fast': FREE,
      'gpt-5.3-codex': FREE, 'gpt-5.3-codex-fast': FREE,
      'gpt-5.3-codex-low': FREE, 'gpt-5.3-codex-low-fast': FREE,
      'gpt-5.3-codex-spark-preview': FREE, 'gpt-5.3-codex-spark-preview-xhigh': FREE,
      'gpt-5.3-codex-spark-preview-high': FREE, 'gpt-5.3-codex-spark-preview-low': FREE,
      'gpt-5.2': FREE, 'gpt-5.2-codex': FREE, 'gpt-5.2-codex-low': FREE,
    },
  };

  private binaryPath: string | null = null;
  private activeProcesses: Set<ChildProcess> = new Set();
  private defaultTimeout: number;

  /**
   * User-configured `config.timeout`, captured at construction. Distinguished
   * from CURSOR_BASE_TIMEOUT_MS so the config fallback only kicks in when the
   * user actually set one (F1). `null` means "no config timeout configured" —
   * fall through to the scaled prompt-size-aware default.
   */
  private readonly configTimeout: number | null;

  constructor(options: BaseProviderOptions) {
    super(options);
    // slice 5 / cursor timeout-budget: base falls back to CURSOR_BASE_TIMEOUT_MS
    // (120s). This is only the SMALL-prompt floor; computeCursorTimeout() scales
    // it up for large prompts at each call site (doComplete/doStream/FIFO).
    this.defaultTimeout = options.config.timeout || CURSOR_BASE_TIMEOUT_MS;
    // F1: honor an explicitly configured config.timeout as the precedence-2
    // fallback (explicit request.timeout > config.timeout > scaled default).
    // Only a finite, positive configured value counts; otherwise null so the
    // scaled prompt-size-aware default applies.
    const cfg = options.config.timeout;
    this.configTimeout = typeof cfg === 'number' && Number.isFinite(cfg) && cfg > 0 ? cfg : null;
  }

  /**
   * Precedence resolver for the timeout "explicit" arg threaded into
   * computeCursorTimeout / computeCursorStreamTimeout (F1/F3):
   *   explicit request.timeout > config.timeout > undefined (=> scaled default).
   * Returns `undefined` when neither is set so the pure helpers fall through to
   * their prompt-size-aware scaling.
   */
  private resolveExplicitTimeout(requestTimeout?: number): number | undefined {
    if (requestTimeout !== undefined && Number.isFinite(requestTimeout) && requestTimeout >= 0) {
      return requestTimeout;
    }
    return this.configTimeout ?? undefined;
  }

  protected validateConfig(): void {
    if (!this.config.model) this.config.model = 'auto';
    if (!this.validateModel(this.config.model)) {
      this.logger.warn(`Model ${this.config.model} may not be supported by ${this.name}`);
    }
  }

  protected async doInitialize(): Promise<void> {
    this.binaryPath = await this.findBinary();
    if (!this.binaryPath) {
      this.logger.warn('Cursor Agent CLI not found. Ensure `cursor-agent` or `cursor` is on PATH.');
    } else {
      this.logger.info('Cursor Agent CLI found', { path: this.binaryPath });
    }
    const apiKey = this.config.apiKey || process.env.CURSOR_API_KEY;
    if (!apiKey) {
      this.logger.warn('CURSOR_API_KEY not set. Some models may require authentication.');
    }
  }

  protected async doComplete(request: LLMRequest): Promise<LLMResponse> {
    this.ensureBinary();
    const model = request.model || this.config.model;
    const prompt = this.formatMessages(request.messages, request.tools);
    const child = this.spawnCursor(prompt, model, false, this.resolveExplicitTimeout(request.timeout), request.cliSandbox);

    return new Promise<LLMResponse>((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';

      // Declare timer before listeners that reference it.
      // slice 5 / cursor timeout-budget: scale by prompt size. Precedence (F1):
      // explicit request.timeout > config.timeout > scaled default.
      const timeoutMs = computeCursorTimeout(prompt.length, this.resolveExplicitTimeout(request.timeout));
      const timer = setTimeout(() => {
        if (settled) return;
        child.kill('SIGKILL');
        this.activeProcesses.delete(child);

        // F5: If stderr shows TTY patterns and this isn't already a retry,
        // re-invoke doComplete. The new spawnChild will hit the same TTY error
        // but catch it via close handler → tmux retry (before timeout fires).
        const isTtyHang = TTY_ERROR_PATTERNS.some((re) => re.test(stderr));
        if (isTtyHang && !(request as unknown as Record<string, unknown>)._tmuxRetried) {
          this.logger.warn('cursor-cli timed out with TTY patterns in stderr; retrying', {
            stderr: stderr.slice(-500),
          });
          settled = true;
          const retryReq = Object.assign({}, request, { _tmuxRetried: true });
          this.doComplete(retryReq).then(resolve, reject);
          return;
        }

        settled = true;
        reject(new LLMProviderError(`Request timed out after ${timeoutMs}ms`, 'TIMEOUT', 'cursor-cli', undefined, true));
      }, timeoutMs);

      child.stdout!.on('data', (d: Buffer) => {
        stdout += d.toString();
        if (stdout.length > MAX_STDOUT_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill('SIGKILL');
          this.activeProcesses.delete(child);
          reject(new LLMProviderError(
            'Response exceeded maximum size (50MB)', 'RESPONSE_TOO_LARGE', 'cursor-cli', undefined, false
          ));
        }
      });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.on('close', (code) => {
        clearTimeout(timer);
        this.activeProcesses.delete(child);
        if (settled) return;
        settled = true;
        if (code !== 0 && !stdout.trim()) {
          reject(new LLMProviderError(
            stderr.trim() || `Exited with code ${code}`, 'EXECUTION_FAILED', 'cursor-cli', undefined, true
          ));
          return;
        }
        if (code !== 0 && stdout.trim()) {
          this.logger.warn('Cursor CLI exited with non-zero code but returned stdout; parsing response', { code, stderr: stderr.slice(-500) });
        }
        try {
          const parsed = this.parseJsonOutput(stdout, model);
          // F0-A: cursor artifact mode is fail-closed (plan/no-edit). Be HONEST that
          // no artifacts were persisted — never imply write capability we disabled.
          if (request.cliSandbox?.mode === 'read-only-with-artifacts') {
            parsed.metadata = {
              ...(parsed.metadata || {}),
              cliSandbox: { mode: 'read-only-with-artifacts', artifactWritesDisabled: true, reason: CURSOR_ARTIFACT_DISABLED_REASON },
            };
          }
          resolve(parsed);
        } catch (e) {
          reject(this.transformError(e instanceof Error ? e : new Error(String(e))));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        this.activeProcesses.delete(child);
        if (settled) return;
        settled = true;
        reject(this.transformError(err));
      });
    });
  }

  protected async *doStreamComplete(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    this.ensureBinary();
    const model = request.model || this.config.model;
    const prompt = this.formatMessages(request.messages, request.tools);
    if (request.cliSandbox?.mode === 'read-only-with-artifacts') {
      this.logger.debug(CURSOR_ARTIFACT_DISABLED_REASON);
    }
    const child = this.spawnCursor(prompt, model, true, this.resolveExplicitTimeout(request.timeout), request.cliSandbox);
    const rl = createInterface({ input: child.stdout! });

    const queue: string[] = [];
    let done = false;
    let spawnError: Error | null = null;
    let notify: (() => void) | null = null;
    const wake = () => { if (notify) { notify(); notify = null; } };

    rl.on('line', (line) => { queue.push(line); wake(); });
    child.on('close', () => { done = true; this.activeProcesses.delete(child); rl.close(); wake(); });
    child.on('error', (err) => { spawnError = err; done = true; this.activeProcesses.delete(child); rl.close(); wake(); });

    // slice 5 / cursor timeout-budget: scale base by prompt size, apply the
    // streaming multiplier (streaming legitimately runs longer), and RE-CLAMP to
    // the shared ceiling (F2). Precedence (F1): explicit request.timeout >
    // config.timeout > scaled default; an explicit/config value is honored
    // VERBATIM (never silently doubled past intent).
    const streamTimeoutMs = computeCursorStreamTimeout(
      prompt.length,
      this.resolveExplicitTimeout(request.timeout),
    );
    let streamTimedOut = false;
    const timer = setTimeout(() => {
      // F7: surface stream timeouts as an error (mirrors doComplete's TIMEOUT),
      // rather than swallowing them as a silent "done".
      streamTimedOut = true;
      child.kill('SIGKILL');
      done = true;
      wake();
    }, streamTimeoutMs);

    let promptTokens = 0;
    let completionTokens = 0;

    // Buffer for tool_call detection: emit content and tool_call events as complete blocks appear
    let contentBuffer = '';
    let streamToolCallCount = 0;

    try {
      while (!done || queue.length > 0) {
        if (queue.length === 0 && !done) {
          await new Promise<void>((r) => { notify = r; });
          continue;
        }
        const line = queue.shift();
        if (!line?.trim()) continue;

        try {
          const evt = JSON.parse(line) as Record<string, unknown>;

          // Content delta events
          if (evt.type === 'assistant' && evt.message) {
            const msg = evt.message as Record<string, unknown>;
            const content = msg.content;
            const text = Array.isArray(content)
              ? (content as Array<{ text?: string }>).map((p) => p.text || '').join('')
              : typeof content === 'string' ? content : '';
            if (text) {
              contentBuffer += text;
              const flushed = flushToolCallsFromBuffer(contentBuffer, 'cursor', streamToolCallCount);
              contentBuffer = flushed.remainingBuffer;
              streamToolCallCount = flushed.count;
              for (const event of flushed.events) {
                yield event;
              }
            }
            const usage = msg.usage as Record<string, number> | undefined;
            if (usage) {
              promptTokens = usage.inputTokens || usage.input_tokens || 0;
              completionTokens = usage.outputTokens || usage.output_tokens || 0;
            }
          }

          // Direct content delta
          if (evt.content && typeof evt.content === 'string') {
            contentBuffer += evt.content;
            const flushed = flushToolCallsFromBuffer(contentBuffer, 'cursor', streamToolCallCount);
            contentBuffer = flushed.remainingBuffer;
            streamToolCallCount = flushed.count;
            for (const event of flushed.events) {
              yield event;
            }
          }

          // Result/completion event
          if (evt.type === 'result') {
            const usage = evt.usage as Record<string, number> | undefined;
            if (usage) {
              promptTokens = usage.inputTokens || usage.input_tokens || usage.prompt_tokens || promptTokens;
              completionTokens = usage.outputTokens || usage.output_tokens || usage.completion_tokens || completionTokens;
            }
          }
        } catch { /* non-JSON line */ }
      }

      // Emit any remaining buffer as content
      if (contentBuffer.length > 0) {
        yield { type: 'content', delta: { content: contentBuffer } };
      }

      // F7: a stream timeout must surface as an error (consistent with
      // doComplete's TIMEOUT), not be swallowed as a silent successful "done".
      if (streamTimedOut) {
        yield {
          type: 'error',
          error: new LLMProviderError(
            `Stream timed out after ${streamTimeoutMs}ms`, 'TIMEOUT', 'cursor-cli', undefined, true
          ),
        };
        return;
      }

      // Surface spawn errors instead of silently completing
      if (spawnError) {
        yield { type: 'error', error: this.transformError(spawnError) };
        return;
      }

      const pricing = this.capabilities.pricing[model] || FREE;
      yield {
        type: 'done',
        usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
        cost: calcCost(promptTokens, completionTokens, pricing),
      };
    } finally {
      clearTimeout(timer);
      rl.close();
      if (!done) { child.kill('SIGKILL'); this.activeProcesses.delete(child); }
    }
  }

  async listModels(): Promise<LLMModel[]> { return [...CURSOR_MODELS]; }

  async getModelInfo(model: LLMModel): Promise<ModelInfo> {
    const pricing = this.capabilities.pricing[model];
    return {
      model, name: model,
      description: MODEL_DESC[model] || 'Cursor Agent model',
      contextLength: this.capabilities.maxContextLength[model] || 200000,
      maxOutputTokens: this.capabilities.maxOutputTokens[model] || 32768,
      supportedFeatures: ['chat', 'code-generation', 'cli-subprocess'],
      pricing: pricing ? { ...pricing } : undefined,
    };
  }

  protected async doHealthCheck(): Promise<HealthCheckResult> {
    if (!this.binaryPath) {
      const found = await this.findBinary();
      if (found) this.binaryPath = found;
    }
    if (!this.binaryPath) {
      return { healthy: false, error: 'Cursor Agent CLI binary not found', timestamp: new Date(),
        details: { hint: 'Install Cursor Agent from Cursor installation documentation' } };
    }
    return new Promise((resolve) => {
      execFile(this.binaryPath!, ['--version'], { timeout: 10000 }, (error, stdout) => {
        if (error) {
          resolve({ healthy: false, error: `cursor --version failed: ${error.message}`, timestamp: new Date() });
          return;
        }
        const version = stdout.trim();
        resolve({ healthy: true, timestamp: new Date(),
          details: { version, binaryPath: this.binaryPath, authMethod: 'cursor-api-key' } });
      });
    });
  }

  destroy(): void {
    for (const p of this.activeProcesses) { try { p.kill('SIGKILL'); } catch { /* already dead */ } }
    this.activeProcesses.clear();
    super.destroy();
  }

  // -- Private helpers -------------------------------------------------------

  private async findBinary(): Promise<string | null> {
    // DO-NOT-REVERT: `cursor-agent` (the standalone headless CLI) MUST be preferred.
    // `cursor` is only a fallback launcher whose `agent` subcommand reaches the SAME
    // headless CLI. This order must never be flipped, and no Cursor IDE / Background
    // Agents path may be added here — see spawnCursor() for the failure mode (300s hang).
    for (const name of ['cursor-agent', 'cursor']) {
      const found = await this.whichBinary(name);
      if (found) return found;
    }
    return null;
  }

  private whichBinary(name: string): Promise<string | null> {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      execFile(cmd, [name], (err, stdout) => {
        resolve(!err && stdout.trim() ? stdout.trim().split('\n')[0].trim() : null);
      });
    });
  }

  private ensureBinary(): void {
    if (!this.binaryPath) {
      throw new ProviderUnavailableError('cursor-cli', {
        message: 'Cursor Agent CLI not found on PATH',
        hint: 'Install `cursor-agent` or Cursor IDE (which provides `cursor agent` subcommand)',
      });
    }
  }

  private spawnCursor(
    prompt: string,
    model: LLMModel,
    stream: boolean,
    explicitTimeout?: number,
    cliSandbox?: LLMRequest['cliSandbox'],
  ): ChildProcess {
    const trimmed = prompt.trim();
    if (!trimmed) {
      throw new LLMProviderError(
        'Prompt is empty after formatting messages',
        'INVALID_REQUEST',
        'cursor-cli',
        400,
        false
      );
    }

    // Pass prompt via stdin (not CLI arg) to avoid:
    //  1. OS ARG_MAX limits for large prompts
    //  2. Prompt text leaking into process listings (ps aux)
    // cursor-agent takes flags directly; cursor (IDE binary) needs 'agent' subcommand
    //
    // ⚠️ DO-NOT-REVERT — HEADLESS CURSOR CLI INVARIANT ⚠️
    // This provider MUST drive the headless `cursor-agent` CLI binary (installed via
    // `curl https://cursor.com/install`) using `--print` (headless/non-interactive) and
    // `--force` (allow tool/file actions in --print mode). The `cursor` launcher binary
    // is ONLY a last-resort fallback and is invoked via its `agent` subcommand — which is
    // still the SAME headless CLI agent, NOT the Cursor IDE.
    //
    // NEVER route this to the Cursor IDE / "Background Agents" (the cloud-VM GUI feature
    // embedded in the Cursor editor). That feature is not headless: it opens an editor /
    // remote VM session and BLOCKS indefinitely with no stdout, which surfaces here as a
    // hard ~300s caller timeout (SIGKILL) with an empty response. The correct headless
    // path returns a JSON result object on stdout in seconds-to-minutes.
    //
    // Required headless flags below (--print + --force) and the cursor-agent-first binary
    // resolution in findBinary() are load-bearing. Do not drop them, do not reorder the
    // binary preference, and do not add any `background-agent` / IDE-launch path.
    const isCursorIDE = this.binaryPath!.endsWith('/cursor') || this.binaryPath!.endsWith('\\cursor');
    // F0-A (hive-flow-9331) Slice B: map the agent's bridge mode to cursor's native
    // read-only mode. `--force`/`--yolo` (run-everything) is the Phase 0 write-escape
    // and has NO OS write-confinement, so restricted modes DROP it and use `--mode
    // plan` (analyze/propose, no edits). cursor has no proven cwd-confinement, so
    // read-only-with-artifacts FAILS CLOSED to the same no-edit mode (artifact writes
    // disabled — honest note at the call site) rather than temp+copy-back. full mode
    // keeps `--force` (DO-NOT-REVERT: required for writes in --print). `--yolo` /
    // bypass flags are never emitted in restricted modes.
    const sandboxMode = cliSandbox?.mode || 'full';
    const restricted = sandboxMode === 'read-only' || sandboxMode === 'read-only-with-artifacts';
    const args = [
      ...(isCursorIDE ? ['agent'] : []),
      '--print',  // DO-NOT-REVERT: headless/non-interactive mode (no TTY, prints to stdout)
      '--trust',  // Prevent workspace trust prompt blocking non-interactive mode
      ...(restricted ? ['--mode', 'plan'] : ['--force']),  // F0-A: read-only plan mode vs full write
      '--output-format', stream ? 'stream-json' : 'json',
      '--model', String(model),
      ...(stream ? ['--stream-partial-output'] : []),
    ];

    const env: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      SHELL: process.env.SHELL,
      LANG: process.env.LANG,
      TERM: process.env.TERM,
      TMPDIR: process.env.TMPDIR,
      // Config discovery
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      // Proxy: required for subscription auth through corporate proxies
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      NO_PROXY: process.env.NO_PROXY,
      http_proxy: process.env.http_proxy,
      https_proxy: process.env.https_proxy,
      no_proxy: process.env.no_proxy,
      ...(this.config.env || {}),
    };
    // Windows requires these for Cursor to find config/auth
    if (process.platform === 'win32') {
      env.APPDATA = process.env.APPDATA;
      env.LOCALAPPDATA = process.env.LOCALAPPDATA;
      env.USERPROFILE = process.env.USERPROFILE;
      env.SystemRoot = process.env.SystemRoot;
      env.TEMP = process.env.TEMP;
    }
    const apiKey = this.config.apiKey || process.env.CURSOR_API_KEY;
    if (apiKey) {
      env.CURSOR_API_KEY = apiKey;  // Pass via env var, not CLI args (security: --api-key visible in ps)
    }

    const child = spawn(this.binaryPath!, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.activeProcesses.add(child);
    child.stdin.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        this.logger.warn('Cursor stdin write error', { error: err.message });
      }
    });
    child.stdin.write(trimmed);
    child.stdin.end();

    // TTY-fallback: if the process exits with a TTY-related error, retry via
    // tmux so cursor-cli gets a pseudo-terminal to satisfy its isatty() check.
    // We wrap the original child in a proxy EventEmitter that intercepts the
    // initial close/error events and replaces streams with those from the retry.
    const proxy = new EventEmitter() as ChildProcess;
    // Mirror the minimum ChildProcess surface used by callers.
    (proxy as unknown as Record<string, unknown>).stdout = child.stdout;
    (proxy as unknown as Record<string, unknown>).stderr = child.stderr;
    (proxy as unknown as Record<string, unknown>).stdin = child.stdin;
    (proxy as unknown as Record<string, unknown>).pid = child.pid;
    (proxy as unknown as Record<string, unknown>).kill = (sig?: NodeJS.Signals | number) => child.kill(sig);

    let stderrAccum = '';
    child.stderr?.on('data', (d: Buffer) => { stderrAccum += d.toString(); });

    child.on('close', (code, signal) => {
      this.activeProcesses.delete(child);

      // Detect TTY-related exit: non-zero code AND stderr matches a TTY pattern.
      const isTtyError = code !== 0 && TTY_ERROR_PATTERNS.some((re) => re.test(stderrAccum));

      if (!isTtyError) {
        proxy.emit('close', code, signal);
        return;
      }

      this.logger.warn('cursor-cli exited with TTY error; attempting tmux fallback', {
        code,
        stderr: stderrAccum.slice(-500),
      });

      // Locate tmux without shell interpolation.
      let tmuxPath: string | null = null;
      try {
        tmuxPath = execFileSync(
          process.platform === 'win32' ? 'where' : 'which',
          ['tmux'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim().split('\n')[0].trim() || null;
      } catch {
        tmuxPath = null;
      }

      if (!tmuxPath) {
        proxy.emit('error', new ProviderUnavailableError('cursor-cli', {
          message: 'cursor-cli requires a TTY but tmux was not found on PATH',
          hint: 'Install tmux to enable the TTY fallback: brew install tmux',
        }));
        return;
      }

      try {
        const tmuxChild = this.spawnInTmux(trimmed, args, env as NodeJS.ProcessEnv, tmuxPath, explicitTimeout);
        this.activeProcesses.add(tmuxChild);

        (proxy as unknown as Record<string, unknown>).stdout = tmuxChild.stdout;
        (proxy as unknown as Record<string, unknown>).stderr = tmuxChild.stderr;
        (proxy as unknown as Record<string, unknown>).stdin = tmuxChild.stdin;
        (proxy as unknown as Record<string, unknown>).pid = tmuxChild.pid;
        (proxy as unknown as Record<string, unknown>).kill = (sig?: NodeJS.Signals | number) => tmuxChild.kill(sig);

        tmuxChild.stdout?.on('data', (d: Buffer) => proxy.emit('data', d));
        tmuxChild.stderr?.on('data', (d: Buffer) => {
          if (proxy.rawListeners('stderr').length > 0) proxy.emit('stderr', d);
        });
        tmuxChild.on('close', (c, s) => { this.activeProcesses.delete(tmuxChild); proxy.emit('close', c, s); });
        tmuxChild.on('error', (err) => { this.activeProcesses.delete(tmuxChild); proxy.emit('error', err); });
      } catch (spawnErr) {
        proxy.emit('error', spawnErr instanceof Error ? spawnErr : new Error(String(spawnErr)));
      }
    });

    child.on('error', (err) => {
      this.activeProcesses.delete(child);
      proxy.emit('error', err);
    });

    return proxy;
  }

  /**
   * Spawns cursor-cli inside a detached tmux session so the process gets a
   * pseudo-TTY. The prompt is written to a temp file (never shell-interpolated).
   * Output is captured via a named FIFO written by `tmux pipe-pane`.
   *
   * All tmux calls use execFileSync with argument arrays — no shell invocation.
   *
   * Returns a ChildProcess-compatible shim whose stdout stream carries the
   * captured output.
   */
  private spawnInTmux(
    prompt: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    tmuxBin: string,
    explicitTimeout?: number,
  ): ChildProcess {
    const sessionId = `hive-cursor-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const pipePath = path.join(os.tmpdir(), `${sessionId}.pipe`);
    // Write prompt to a temp file so it is never passed through any shell.
    const promptFile = path.join(os.tmpdir(), `${sessionId}.prompt`);
    fs.writeFileSync(promptFile, prompt, { encoding: 'utf8', mode: 0o600 });

    // Create FIFO — execFileSync with argument array (no shell).
    try {
      execFileSync('mkfifo', [pipePath], { stdio: 'ignore' });
    } catch {
      try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
      throw new ProviderUnavailableError('cursor-cli', {
        message: 'tmux fallback failed: could not create named pipe via mkfifo',
        hint: 'Ensure mkfifo is available and the temp directory is writable',
      });
    }

    // All tmux setup wrapped in try-catch: if anything after mkfifo fails,
    // clean up the tmux session + temp files to prevent leaks.
    let tmuxSessionStarted = false;
    try {
      // Start detached tmux session — all args are separate array elements.
      execFileSync(tmuxBin, ['new-session', '-d', '-s', sessionId, '-x', '220', '-y', '50'], {
        env,
        stdio: 'ignore',
      });
      tmuxSessionStarted = true;

      // Redirect pane output to FIFO via pipe-pane.
      // Single-quote the pipePath for defense-in-depth even though it's auto-generated.
      const qPath = `'${pipePath.replace(/'/g, "'\\''")}'`;
      execFileSync(tmuxBin, ['pipe-pane', '-t', sessionId, `cat >> ${qPath}`], {
        env,
        stdio: 'ignore',
      });

      // Build the pane command: `cat <promptFile> | <cursorBin> <args...>; tmux kill-session -t <session>`.
      // All tokens are individually single-quote-escaped so shell word-splitting
      // cannot alter them inside the tmux pane shell.
      const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const paneCmd = [
        'cat', q(promptFile), '|',
        q(this.binaryPath!), ...args.map(q),
        ';', tmuxBin, 'kill-session', '-t', sessionId,
      ].join(' ');

      execFileSync(tmuxBin, ['send-keys', '-t', sessionId, paneCmd, 'Enter'], {
        env,
        stdio: 'ignore',
      });
    } catch (tmuxErr) {
      // Clean up on failure: kill tmux session + remove temp files
      if (tmuxSessionStarted) {
        try { execFileSync(tmuxBin, ['kill-session', '-t', sessionId], { stdio: 'ignore' }); } catch { /* already gone */ }
      }
      try { fs.unlinkSync(pipePath); } catch { /* already removed */ }
      try { fs.unlinkSync(promptFile); } catch { /* already removed */ }
      throw tmuxErr;
    }

    // Open the FIFO for reading with a timeout to prevent indefinite blocking.
    const fifoStream = fs.createReadStream(pipePath);
    // slice 5 / cursor timeout-budget: scale the FIFO read budget by prompt size,
    // apply the streaming/FIFO multiplier, and RE-CLAMP to the shared ceiling (F2).
    // F3: thread the caller's explicit request.timeout / config fallback so the
    // FIFO (tmux/TTY) path honors a caller override instead of dropping it; an
    // explicit value is honored verbatim (not multiplied), matching doStream.
    const fifoTimeoutMs = computeCursorStreamTimeout(prompt.length, explicitTimeout);
    const fifoTimer = setTimeout(() => {
      fifoStream.destroy(new Error(`FIFO read timed out after ${fifoTimeoutMs}ms`));
      try { execFileSync(tmuxBin, ['kill-session', '-t', sessionId], { stdio: 'ignore' }); } catch { /* already gone */ }
    }, fifoTimeoutMs);

    const stderrPass = new PassThrough();
    const shim = new EventEmitter() as ChildProcess;
    (shim as unknown as Record<string, unknown>).stdout = fifoStream;
    (shim as unknown as Record<string, unknown>).stderr = stderrPass;
    (shim as unknown as Record<string, unknown>).stdin = new PassThrough();
    (shim as unknown as Record<string, unknown>).pid = undefined;
    (shim as unknown as Record<string, unknown>).kill = (_sig?: NodeJS.Signals | number) => {
      try { execFileSync(tmuxBin, ['kill-session', '-t', sessionId], { stdio: 'ignore' }); } catch { /* already gone */ }
      try { fs.unlinkSync(pipePath); } catch { /* already removed */ }
      try { fs.unlinkSync(promptFile); } catch { /* already removed */ }
    };

    const cleanup = () => {
      clearTimeout(fifoTimer);
      try { fs.unlinkSync(pipePath); } catch { /* already removed */ }
      try { fs.unlinkSync(promptFile); } catch { /* already removed */ }
    };
    fifoStream.on('end', () => { cleanup(); stderrPass.end(); shim.emit('close', 0, null); });
    fifoStream.on('error', (err: Error) => { cleanup(); shim.emit('error', err); });

    return shim;
  }

  private parseJsonOutput(stdout: string, model: LLMModel): LLMResponse {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      this.logger.warn('Cursor Agent returned non-JSON output; using raw text');
      const content = stdout.trim();
      if (!content) {
        throw new LLMProviderError('Cursor Agent returned empty output', 'EMPTY_RESPONSE', 'cursor-cli', undefined, true);
      }
      const { contentWithoutToolCalls, toolCalls } = parseToolCallsFromContent(content, 'cursor');
      return this.buildResponse(
        contentWithoutToolCalls, model, 0, 0,
        toolCalls.length > 0 ? toolCalls : undefined,
        toolCalls.length > 0 ? 'tool_calls' : undefined
      );
    }

    const raw = parsed.result ?? parsed.response ?? parsed.content ?? '';
    const content = (typeof raw === 'string' ? raw : String(raw)).trim();
    if (!content) {
      throw new LLMProviderError('Cursor Agent returned empty response', 'EMPTY_RESPONSE', 'cursor-cli', undefined, true);
    }
    const { contentWithoutToolCalls, toolCalls } = parseToolCallsFromContent(content, 'cursor');
    if (!contentWithoutToolCalls && toolCalls.length === 0) {
      throw new LLMProviderError('Cursor Agent returned empty response', 'EMPTY_RESPONSE', 'cursor-cli', undefined, true);
    }

    const usage = (parsed.usage ?? {}) as Record<string, number>;
    const promptTokens = usage.inputTokens || usage.input_tokens || usage.prompt_tokens || 0;
    const completionTokens = usage.outputTokens || usage.output_tokens || usage.completion_tokens || 0;

    return this.buildResponse(
      contentWithoutToolCalls, model, promptTokens, completionTokens,
      toolCalls.length > 0 ? toolCalls : undefined,
      toolCalls.length > 0 ? 'tool_calls' : undefined
    );
  }

  private buildResponse(
    content: string,
    model: LLMModel,
    promptTokens: number,
    completionTokens: number,
    toolCalls?: LLMToolCall[],
    finishReason?: LLMResponse['finishReason']
  ): LLMResponse {
    const pricing = this.capabilities.pricing[model] || FREE;
    return {
      id: `cursor-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      model, provider: 'cursor-cli', content,
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      cost: calcCost(promptTokens, completionTokens, pricing),
      finishReason: finishReason || 'stop',
    };
  }

  private formatMessages(messages: LLMMessage[], tools?: LLMTool[]): string {
    const systemParts: string[] = [];
    const convParts: string[] = [];
    for (const msg of messages) {
      const content = msg.content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter((p) => p.type === 'text' && p.text).map((p) => p.text!).join('\n')
            : '';
      if (msg.role === 'system') {
        systemParts.push(text);
      } else {
        convParts.push(`${msg.role === 'assistant' ? 'Assistant' : 'User'}: ${text}`);
      }
    }
    const parts: string[] = [];
    if (systemParts.length > 0) parts.push(`System: ${systemParts.join('\n')}`);
    if (convParts.length > 0) parts.push(convParts.join('\n'));

    if (tools && tools.length > 0) {
      parts.push(...formatToolInstructions(tools));
    }

    return parts.join('\n\n');
  }

}
