/**
 * V3 Codex CLI Subprocess Provider
 *
 * Wraps OpenAI's Codex CLI (Rust binary) as a subprocess provider.
 * Auth: ChatGPT subscription OAuth by default (no API key needed).
 * CI/headless auth via CODEX_API_KEY environment variable.
 *
 * @module @hive-flow/providers/codex-cli-provider
 */

import { spawn, ChildProcess, execFile } from 'child_process';
import { createInterface } from 'readline';
import { mkdtempSync, rmSync, readdirSync, lstatSync, statSync, copyFileSync, renameSync, realpathSync, constants as fsConstants } from 'fs';
import { tmpdir } from 'os';
import { join, relative, isAbsolute, sep } from 'path';
import { randomBytes } from 'crypto';
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import {
  LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent,
  LLMMessage, LLMTool, LLMToolCall,
  ModelInfo, ProviderCapabilities, HealthCheckResult, LLMProviderError,
  AuthenticationError, ProviderUnavailableError, RateLimitError,
} from './types.js';
import {
  parseToolCallsFromContent,
  formatToolInstructions,
  flushToolCallsFromBuffer,
} from './tool-call-utils.js';

// ===== JSONL Event Types =====

interface CodexEvent { type: string; [key: string]: unknown }
interface CodexItemCompleted extends CodexEvent {
  type: 'item.completed';
  item: { type: string; text?: string };
}
interface CodexTurnCompleted extends CodexEvent {
  type: 'turn.completed';
  usage?: { input_tokens?: number; output_tokens?: number };
}
interface CodexTurnFailed extends CodexEvent {
  type: 'turn.failed';
  error?: { message?: string; codexErrorInfo?: { type: string } };
}
interface CodexErrorEvent extends CodexEvent {
  type: 'error';
  message?: string;
  error?: { message?: string };
}

// ===== Static Data =====

const CODEX_MODELS: LLMModel[] = [
  'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-max',
  'gpt-5.1-codex', 'gpt-5-codex', 'gpt-5-codex-mini',
];

const MODEL_INFO: Record<string, { desc: string; ctx: number; out: number }> = {
  'gpt-5.5':           { desc: 'GPT-5.5 - Smartest flagship, best agentic coding',   ctx: 1050000, out: 128000 },
  'gpt-5.4':           { desc: 'GPT-5.4 - Previous flagship model',                  ctx: 1000000, out: 32768 },
  'gpt-5.3-codex':     { desc: 'GPT-5.3 Codex - High-capability code model',         ctx: 200000, out: 32768 },
  'gpt-5.2-codex':     { desc: 'GPT-5.2 Codex - Previous-generation flagship',      ctx: 200000, out: 32768 },
  'gpt-5.1-codex-max': { desc: 'GPT-5.1 Codex Max - Extended context and reasoning', ctx: 512000, out: 65536 },
  'gpt-5.1-codex':     { desc: 'GPT-5.1 Codex - High-capability code model',        ctx: 128000, out: 16384 },
  'gpt-5-codex':       { desc: 'GPT-5 Codex - Baseline code model',                  ctx: 128000, out: 16384 },
  'gpt-5-codex-mini':  { desc: 'GPT-5 Codex Mini - Fast and cost-effective',         ctx: 128000, out: 16384 },
};

const toRecord = (fn: (k: string) => number) =>
  Object.fromEntries(Object.keys(MODEL_INFO).map((k) => [k, fn(k)]));

const CODEX_ERROR_MAP: Record<string, { code: string; status: number; retryable: boolean }> = {
  ContextWindowExceeded:           { code: 'CONTEXT_EXCEEDED', status: 400, retryable: false },
  UsageLimitExceeded:              { code: 'RATE_LIMIT',       status: 429, retryable: true },
  HttpConnectionFailed:            { code: 'CONNECTION_FAILED', status: 503, retryable: true },
  ResponseStreamConnectionFailed:  { code: 'STREAM_FAILED',    status: 503, retryable: true },
  BadRequest:                      { code: 'BAD_REQUEST',      status: 400, retryable: false },
  Unauthorized:                    { code: 'AUTHENTICATION',   status: 401, retryable: false },
  SandboxError:                    { code: 'SANDBOX_ERROR',    status: 500, retryable: false },
  InternalServerError:             { code: 'INTERNAL_ERROR',   status: 500, retryable: true },
  Other:                           { code: 'UNKNOWN',          status: 500, retryable: true },
};

const RECONNECT_RE = /Reconnecting\.\.\.\s*\d+\/\d+/;

const FREE = { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' };

function calcCost(prompt: number, completion: number, pricing: { promptCostPer1k: number; completionCostPer1k: number }) {
  const p = (prompt / 1000) * pricing.promptCostPer1k;
  const c = (completion / 1000) * pricing.completionCostPer1k;
  return { promptCost: p, completionCost: c, totalCost: p + c, currency: 'USD' };
}

// ===== F0-A (hive-flow-9331) artifact copy-back =====

const ARTIFACT_ALLOWED_EXT = new Set(['.md', '.json']);
const ARTIFACT_COPY_MAX_FILES = 200;
const ARTIFACT_COPY_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Resolved codex sandbox plan for one spawn. For read-only-with-artifacts, codex
 * runs in a throwaway `tempDir` (its writable workspace) and conforming outputs
 * are promoted to the trusted `artifactDir` by copyCodexArtifactsBack().
 */
export interface CodexSandboxPlan {
  sandboxMode: 'read-only' | 'workspace-write';
  cwd?: string;
  tempDir?: string;
  artifactDir?: string;
}

export interface ArtifactCopyResult {
  copied: string[];
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * SECURITY BOUNDARY (F0-A / hive-flow-9331). codex's native OS sandbox is
 * directory-granular and cannot enforce the read-only-with-artifacts ".md/.json
 * only" contract, so codex writes freely inside a throwaway temp workspace and we
 * promote ONLY conforming files into the trusted, resolved artifactDir here.
 *
 * FLAT-only (Codex ruling): only top-level regular files are considered, each
 * re-validated — extension allowlist (lowercased .md/.json), no symlink source,
 * no write THROUGH a destination symlink, separator-aware containment as a direct
 * child of artifactDir, atomic temp+rename, and bounded file-count/bytes so a CLI
 * child cannot fill disk through this layer. Disallowed files are skipped with an
 * honest reason — never silently implied as persisted.
 */
export function copyCodexArtifactsBack(
  tempDir: string,
  artifactDir: string,
  // Seam for tests to force a temp-path collision. Production default is an
  // UNPREDICTABLE name; combined with exclusive create (below) it cannot be
  // pre-planted or written through.
  tempNameFor: (name: string) => string = (name) => `.hf-artifact-tmp-${randomBytes(12).toString('hex')}-${name}`,
): ArtifactCopyResult {
  const copied: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  // Resolve a real, trusted destination directory once.
  let realArtifactDir: string;
  try {
    realArtifactDir = realpathSync(artifactDir);
    if (!statSync(realArtifactDir).isDirectory()) return { copied, skipped };
  } catch {
    return { copied, skipped };
  }

  let entries: string[];
  try { entries = readdirSync(tempDir); } catch { return { copied, skipped }; }

  let totalBytes = 0;
  for (const name of entries) {
    if (copied.length >= ARTIFACT_COPY_MAX_FILES) { skipped.push({ name, reason: 'max-file-count' }); continue; }
    // FLAT: reject anything that is not a bare filename.
    if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) { skipped.push({ name, reason: 'non-flat-name' }); continue; }
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
    if (!ARTIFACT_ALLOWED_EXT.has(ext)) { skipped.push({ name, reason: 'disallowed-extension' }); continue; }

    const srcPath = join(tempDir, name);
    let srcStat;
    try { srcStat = lstatSync(srcPath); } catch { skipped.push({ name, reason: 'src-stat-failed' }); continue; }
    if (srcStat.isSymbolicLink()) { skipped.push({ name, reason: 'src-symlink' }); continue; }
    if (!srcStat.isFile()) { skipped.push({ name, reason: 'not-regular-file' }); continue; }
    if (totalBytes + srcStat.size > ARTIFACT_COPY_MAX_BYTES) { skipped.push({ name, reason: 'max-bytes' }); continue; }

    // Separator-aware containment: dest MUST be a direct child of artifactDir.
    const destPath = join(realArtifactDir, name);
    const rel = relative(realArtifactDir, destPath);
    if (rel !== name || rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)) {
      skipped.push({ name, reason: 'containment-failed' }); continue;
    }
    // Never write THROUGH a destination symlink.
    try { if (lstatSync(destPath).isSymbolicLink()) { skipped.push({ name, reason: 'dest-symlink' }); continue; } } catch { /* absent is fine */ }

    // Atomic write via a unique temp in the destination dir, then rename.
    // EXCLUSIVE CREATE (COPYFILE_EXCL => O_CREAT|O_EXCL): fails with EEXIST if the
    // temp path already exists as ANYTHING (including a pre-planted symlink), so we
    // can never write THROUGH an attacker-controlled temp-destination symlink.
    const tmpDest = join(realArtifactDir, tempNameFor(name));
    let createdTmp = false;
    try {
      copyFileSync(srcPath, tmpDest, fsConstants.COPYFILE_EXCL);
      createdTmp = true;
      renameSync(tmpDest, destPath);
      totalBytes += srcStat.size;
      copied.push(name);
    } catch (err) {
      // Only remove the temp file if WE created it — never unlink a pre-existing
      // path we refused to write through.
      if (createdTmp) { try { rmSync(tmpDest, { force: true }); } catch { /* best-effort */ } }
      const code = (err as NodeJS.ErrnoException)?.code;
      skipped.push({ name, reason: code === 'EEXIST' ? 'temp-dest-collision' : 'copy-failed' });
    }
  }
  return { copied, skipped };
}

export class CodexCLIProvider extends BaseProvider {
  readonly name: LLMProvider = 'codex-cli';
  readonly capabilities: ProviderCapabilities = {
    supportedModels: CODEX_MODELS,
    maxContextLength: toRecord((k) => MODEL_INFO[k].ctx),
    maxOutputTokens: toRecord((k) => MODEL_INFO[k].out),
    supportsStreaming: true, supportsToolCalling: true, supportsSystemMessages: true,
    supportsVision: false, supportsAudio: false, supportsFineTuning: false,
    supportsEmbeddings: false, supportsBatching: false,
    rateLimit: { requestsPerMinute: 60, tokensPerMinute: 1000000, concurrentRequests: 5 },
    pricing: {
      'gpt-5.4': FREE, 'gpt-5.3-codex': FREE, 'gpt-5.2-codex': FREE, 'gpt-5.1-codex-max': FREE,
      'gpt-5.1-codex': FREE, 'gpt-5-codex': FREE,
      'gpt-5-codex-mini': { promptCostPer1k: 0.0015, completionCostPer1k: 0.006, currency: 'USD' },
    },
  };

  private binaryPath: string | null = null;
  private activeProcesses: Set<ChildProcess> = new Set();
  private defaultTimeout: number;

  constructor(options: BaseProviderOptions) {
    super(options);
    this.defaultTimeout = options.config.timeout || 300000;
  }

  protected async doInitialize(): Promise<void> {
    this.binaryPath = await this.findBinary();
    if (!this.binaryPath) {
      this.logger.warn('Codex CLI binary not found in PATH. Install Codex CLI with your configured package manager.');
    } else {
      this.logger.info('Codex CLI binary found', { path: this.binaryPath });
    }
  }

  protected validateConfig(): void {
    // Do NOT call super.validateConfig() unconditionally: the base class rejects
    // a missing/undefined model, but CodexCLI legitimately omits --model to let
    // Codex fall back to its own config.toml default ('auto' is also handled below).
    // We still enforce the base temperature range check here explicitly.
    if (this.config.temperature !== undefined) {
      if (this.config.temperature < 0 || this.config.temperature > 2) {
        throw new Error('Temperature must be between 0 and 2');
      }
    }
    // Warn (not throw) when an explicit model is set that isn't in the supported list.
    // 'auto' is explicitly handled as "use default" in spawnCodex().
    if (this.config.model && this.config.model !== 'auto' && !this.validateModel(this.config.model)) {
      this.logger.warn(`Model ${this.config.model} may not be supported by codex-cli`);
    }
  }

  protected async doComplete(request: LLMRequest): Promise<LLMResponse> {
    this.ensureBinary();
    const model = request.model || this.config.model;
    const prompt = this.formatMessages(request.messages, request.tools);
    const plan = this.resolveCodexSandbox(request.cliSandbox);
    const child = this.spawnCodex(prompt, model, plan);
    const rl = createInterface({ input: child.stdout! });

    try {
      const response = await new Promise<LLMResponse>((resolve, reject) => {
      let responseText = '';
      let usage = { input: 0, output: 0 };
      let errorMsg = '';
      let turnFailed = false;
      let settled = false;

      const timeoutMs = request.timeout || this.defaultTimeout;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.terminateChild(child);
        this.activeProcesses.delete(child);
        reject(new LLMProviderError(`Request timed out after ${timeoutMs}ms`, 'TIMEOUT', 'codex-cli', undefined, true));
      }, timeoutMs);

      rl.on('line', (line) => {
        timer.refresh();
        const ev = this.parseLine(line);
        if (!ev) return;
        if (ev.type === 'item.completed') {
          const e = ev as CodexItemCompleted;
          if (e.item.type === 'agent_message' && e.item.text) responseText = e.item.text;
        } else if (ev.type === 'turn.completed') {
          const e = ev as CodexTurnCompleted;
          if (e.usage) { usage = { input: e.usage.input_tokens || 0, output: e.usage.output_tokens || 0 }; }
        } else if (ev.type === 'turn.failed') {
          const e = ev as CodexTurnFailed;
          turnFailed = true;
          const rawMsg = e.error?.message || 'Turn failed';
          errorMsg = this.parseNestedErrorMessage(rawMsg);
          const t = e.error?.codexErrorInfo?.type;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            this.activeProcesses.delete(child);
            rl.close();
            reject(t ? this.mapCodexError(errorMsg, t) : new LLMProviderError(errorMsg, 'EXECUTION_FAILED', 'codex-cli', undefined, true));
          }
        } else if (ev.type === 'error') {
          const e = ev as CodexErrorEvent;
          const m = e.message || e.error?.message || '';
          if (!RECONNECT_RE.test(m)) errorMsg = m || 'Unknown error';
        }
      });

      child.stderr?.on('data', (d: Buffer) => {
        const t = d.toString();
        if (!RECONNECT_RE.test(t)) this.logger.debug('codex stderr', { output: t });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        this.activeProcesses.delete(child);
        rl.close();
        if (settled) return;
        settled = true;
        if (turnFailed && !responseText) {
          reject(new LLMProviderError(errorMsg || 'Turn failed', 'EXECUTION_FAILED', 'codex-cli', undefined, true));
          return;
        }
        // SIGINT bug (#4721): exit code 0 on Ctrl+C -- don't rely on exit code alone
        if (!responseText && code !== 0) {
          reject(new LLMProviderError(errorMsg || `Exited with code ${code}`, 'EXECUTION_FAILED', 'codex-cli', undefined, true));
          return;
        }
        if (!responseText) {
          reject(new LLMProviderError('Codex returned empty response', 'EMPTY_RESPONSE', 'codex-cli', undefined, true));
          return;
        }
        const { contentWithoutToolCalls, toolCalls } = parseToolCallsFromContent(responseText, 'codex');
        if (!contentWithoutToolCalls && toolCalls.length === 0) {
          reject(new LLMProviderError('Codex returned empty response', 'EMPTY_RESPONSE', 'codex-cli', undefined, true));
          return;
        }
        resolve(this.buildResponse(
          contentWithoutToolCalls,
          model as LLMModel,
          usage.input,
          usage.output,
          toolCalls.length > 0 ? toolCalls : undefined,
          toolCalls.length > 0 ? 'tool_calls' : undefined
        ));
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        this.activeProcesses.delete(child);
        rl.close();
        if (settled) return;
        settled = true;
        reject(this.transformError(err));
      });
      });
      // F0-A: on SUCCESS only, promote allowed artifacts from the temp workspace.
      if (plan.tempDir && plan.artifactDir) {
        const copy = copyCodexArtifactsBack(plan.tempDir, plan.artifactDir);
        response.metadata = { ...(response.metadata || {}), artifactCopyBack: copy };
      }
      return response;
    } finally {
      // Clean up the private temp workspace on every path (success/failure/timeout/abort).
      if (plan.tempDir) { try { rmSync(plan.tempDir, { recursive: true, force: true }); } catch { /* best-effort */ } }
    }
  }

  protected async *doStreamComplete(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    this.ensureBinary();
    const model = request.model || this.config.model;
    const prompt = this.formatMessages(request.messages, request.tools);
    const plan = this.resolveCodexSandbox(request.cliSandbox);
    const child = this.spawnCodex(prompt, model, plan);
    const rl = createInterface({ input: child.stdout! });

    let sawTurnCompleted = false; // F0-A: copy back only after a genuine turn.completed
    const queue: string[] = [];
    let done = false;
    let notify: (() => void) | null = null;
    const wake = () => { if (notify) { notify(); notify = null; } };

    let spawnError: Error | null = null;
    rl.on('line', (line) => { queue.push(line); wake(); });
    child.on('close', () => { done = true; this.activeProcesses.delete(child); rl.close(); wake(); });
    child.on('error', (err) => { spawnError = err; done = true; this.activeProcesses.delete(child); rl.close(); wake(); });

    const streamTimeoutMs = request.timeout || this.defaultTimeout;
    const timer = setTimeout(() => { this.terminateChild(child); this.activeProcesses.delete(child); done = true; wake(); }, streamTimeoutMs);

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
        if (!line) continue;
        timer.refresh();
        const ev = this.parseLine(line);
        if (!ev) continue;

        if (ev.type === 'item.completed') {
          const e = ev as CodexItemCompleted;
          if (e.item.type === 'agent_message' && e.item.text) {
            contentBuffer += e.item.text;
            const flushed = flushToolCallsFromBuffer(contentBuffer, 'codex', streamToolCallCount);
            contentBuffer = flushed.remainingBuffer;
            streamToolCallCount = flushed.count;
            for (const event of flushed.events) {
              yield event;
            }
          }
        } else if (ev.type === 'turn.completed') {
          const e = ev as CodexTurnCompleted;
          sawTurnCompleted = true;
          if (contentBuffer.length > 0) {
            yield { type: 'content', delta: { content: contentBuffer } };
            contentBuffer = '';
          }
          const p = e.usage?.input_tokens || 0, c = e.usage?.output_tokens || 0;
          const pricing = this.capabilities.pricing[model] || FREE;
          yield { type: 'done', usage: { promptTokens: p, completionTokens: c, totalTokens: p + c }, cost: calcCost(p, c, pricing) };
        } else if (ev.type === 'turn.failed') {
          const e = ev as CodexTurnFailed;
          const msg = e.error?.message || 'Turn failed';
          const t = e.error?.codexErrorInfo?.type;
          yield { type: 'error', error: t ? this.mapCodexError(msg, t) : new Error(msg) };
        } else if (ev.type === 'error') {
          const e = ev as CodexErrorEvent;
          const m = e.message || e.error?.message || '';
          if (!RECONNECT_RE.test(m)) yield { type: 'error', error: new Error(m || 'Unknown error') };
        }
      }
      if (contentBuffer.length > 0) {
        yield { type: 'content', delta: { content: contentBuffer } };
      }
      // Surface spawn errors instead of silently completing
      if (spawnError) {
        yield { type: 'error', error: this.transformError(spawnError) };
        return;
      }
    } finally {
      clearTimeout(timer);
      rl.close();
      if (!done) { this.terminateChild(child); this.activeProcesses.delete(child); }
      // F0-A: promote allowed artifacts ONLY on a genuine turn.completed; always
      // clean up the private temp workspace (success/failure/timeout/abort).
      if (plan.tempDir) {
        if (sawTurnCompleted && plan.artifactDir) {
          const copy = copyCodexArtifactsBack(plan.tempDir, plan.artifactDir);
          if (copy.skipped.length) this.logger.debug('codex artifact copy-back skipped files', { skipped: copy.skipped });
        }
        try { rmSync(plan.tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  async listModels(): Promise<LLMModel[]> { return [...CODEX_MODELS]; }

  async getModelInfo(model: LLMModel): Promise<ModelInfo> {
    const pricing = this.capabilities.pricing[model];
    const info = MODEL_INFO[model];
    const features = ['chat', 'code-generation', 'subprocess'];
    if (!pricing || (pricing.promptCostPer1k === 0 && pricing.completionCostPer1k === 0)) {
      features.push('subscription-included');
    }
    return {
      model, name: model,
      description: info?.desc || 'Codex CLI model',
      contextLength: info?.ctx || 128000,
      maxOutputTokens: info?.out || 16384,
      supportedFeatures: features,
      pricing: pricing ? { ...pricing } : undefined,
    };
  }

  protected async doHealthCheck(): Promise<HealthCheckResult> {
    if (!this.binaryPath) {
      const found = await this.findBinary();
      if (found) this.binaryPath = found;
    }
    if (!this.binaryPath) {
      return { healthy: false, error: 'Codex CLI binary not found in PATH', timestamp: new Date(),
        details: { hint: 'Install Codex CLI with your configured package manager.' } };
    }
    return new Promise((resolve) => {
      execFile(this.binaryPath!, ['--version'], { timeout: 10000 }, (error, stdout) => {
        if (error) {
          resolve({ healthy: false, error: `codex --version failed: ${error.message}`, timestamp: new Date() });
          return;
        }
        const version = stdout.trim();
        const m = version.match(/(\d+)\.(\d+)\.(\d+)/);
        const ok = m !== null && (Number(m[1]) > 0 || Number(m[2]) > 87 || (Number(m[2]) === 87 && Number(m[3]) >= 0));
        resolve({ healthy: true, timestamp: new Date(),
          details: { version, binaryPath: this.binaryPath, versionOk: ok, ...(ok ? {} : { warning: 'Expected v0.87.0+' }) } });
      });
    });
  }

  destroy(): void {
    for (const p of this.activeProcesses) this.terminateChild(p);
    this.activeProcesses.clear();
    super.destroy();
  }

  // ===== Private Helpers =====

  private findBinary(): Promise<string | null> {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      execFile(cmd, ['codex'], (err, stdout) => {
        resolve(!err && stdout.trim() ? stdout.trim().split('\n')[0].trim() : null);
      });
    });
  }

  private ensureBinary(): void {
    if (!this.binaryPath) {
      throw new ProviderUnavailableError('codex-cli', {
        message: 'Codex CLI binary not found in PATH', hint: 'Install Codex CLI with your configured package manager.',
      });
    }
  }

  /**
   * F0-A (hive-flow-9331): map the agent's bridge mode to codex's NATIVE OS sandbox.
   *   full/undefined            -> workspace-write (writes in the project workspace)
   *   read-only                 -> read-only       (reads anywhere, NO writes)
   *   read-only-with-artifacts  -> workspace-write in a PRIVATE TEMP workspace
   *        (cwd=tempDir), then copyCodexArtifactsBack() promotes only .md/.json
   *        to the trusted artifactDir. codex's sandbox is directory-granular and
   *        cannot enforce the .md/.json contract natively, hence temp + copy-back.
   *   read-only-with-artifacts w/o a usable dir -> fail closed to read-only.
   */
  private resolveCodexSandbox(cliSandbox?: LLMRequest['cliSandbox']): CodexSandboxPlan {
    const mode = cliSandbox?.mode || 'full';
    if (mode === 'read-only') return { sandboxMode: 'read-only' };
    if (mode === 'read-only-with-artifacts') {
      const artifactDir = cliSandbox?.artifactDir;
      if (!artifactDir) return { sandboxMode: 'read-only' }; // fail closed: no writes
      const tempDir = mkdtempSync(join(tmpdir(), 'hf-codex-artifacts-'));
      return { sandboxMode: 'workspace-write', cwd: tempDir, tempDir, artifactDir };
    }
    return { sandboxMode: 'workspace-write' };
  }

  private spawnCodex(prompt: string, model: LLMModel, plan: CodexSandboxPlan): ChildProcess {
    // F0-A (hive-flow-9331): the previous hardcoded `--sandbox workspace-write`
    // let read-only / read-only-with-artifacts codex agents write anywhere in the
    // repo, because codex executes its own file tools which the bridge tool-gate
    // never sees. The sandbox mode + cwd now come from resolveCodexSandbox().
    // `danger-full-access` / `--dangerously-bypass-*` are NEVER emitted.
    // Pass prompt via stdin (not CLI arg) to avoid:
    //  1. OS ARG_MAX limits for large prompts
    //  2. Prompt text leaking into process listings (ps aux)
    const args = [
      'exec', '-', '--json',
      '--skip-git-repo-check',
      '--ignore-user-config',              // Don't read ~/.codex/config.toml — bridge uses isolated config
      '--ignore-rules',                    // Don't read CLAUDE.md/AGENTS.md — prevents hive-flow circularity
      '--sandbox', plan.sandboxMode,       // F0-A: derived from the agent's bridge mode
    ];
    // Only include --model if explicitly set (not 'auto' or undefined)
    // Omitting --model lets Codex use config.toml default (typically gpt-5.5)
    if (model && model !== 'auto') {
      args.push('--model', String(model));
    }

    const env: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      SHELL: process.env.SHELL,
      LANG: process.env.LANG,
      TERM: process.env.TERM,
      TMPDIR: process.env.TMPDIR,
      // Config discovery: Codex uses XDG and CODEX_HOME for config.toml
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      CODEX_HOME: process.env.CODEX_HOME,
      // Proxy: required for subscription auth through corporate proxies
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      NO_PROXY: process.env.NO_PROXY,
      http_proxy: process.env.http_proxy,
      https_proxy: process.env.https_proxy,
      no_proxy: process.env.no_proxy,
      ...(this.config.env || {}),
    };
    const apiKey = this.config.apiKey || process.env.CODEX_API_KEY;
    if (apiKey) env.CODEX_API_KEY = apiKey;
    // Also forward OPENAI_API_KEY for users who use that instead
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    // Windows: HOME is undefined; Codex needs USERPROFILE for config.toml discovery
    if (process.platform === 'win32') {
      env.USERPROFILE = process.env.USERPROFILE;
      env.APPDATA = process.env.APPDATA;
      env.LOCALAPPDATA = process.env.LOCALAPPDATA;
    }

    const child = spawn(this.binaryPath!, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      detached: process.platform !== 'win32',
      // F0-A: for read-only-with-artifacts, the writable workspace IS the private
      // temp dir (plan.cwd); copyCodexArtifactsBack() promotes only .md/.json out.
      ...(plan.cwd ? { cwd: plan.cwd } : {}),
    });
    this.activeProcesses.add(child);
    child.stdin.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        this.logger.warn('Codex stdin write error', { error: err.message });
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
    return child;
  }

  private terminateChild(child: ChildProcess): void {
    if (process.platform !== 'win32' && typeof child.pid === 'number') {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The process may already have exited; fall back to the direct handle.
      }
    }
    if (!child.killed) child.kill('SIGKILL');
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
      id: `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      model,
      provider: 'codex-cli',
      content,
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      cost: calcCost(promptTokens, completionTokens, pricing),
      finishReason: finishReason ?? 'stop',
    };
  }

  private parseNestedErrorMessage(message: string): string {
    try {
      const parsed = JSON.parse(message);
      if (typeof parsed === 'object' && parsed !== null) {
        return (parsed as Record<string, unknown>).detail as string
          || (parsed as Record<string, unknown>).message as string
          || (parsed as Record<string, unknown>).error as string
          || message;
      }
      return String(parsed);
    } catch {
      return message;
    }
  }

  private parseLine(line: string): CodexEvent | null {
    const t = line.trim();
    if (!t) return null;
    try { return JSON.parse(t) as CodexEvent; } catch { return null; }
  }

  private mapCodexError(message: string, errorType: string): LLMProviderError {
    if (errorType === 'Unauthorized') return new AuthenticationError(message, 'codex-cli');
    if (errorType === 'UsageLimitExceeded') return new RateLimitError(message, 'codex-cli');
    if (errorType === 'HttpConnectionFailed' || errorType === 'ResponseStreamConnectionFailed') {
      return new ProviderUnavailableError('codex-cli', { message, errorType });
    }
    const m = CODEX_ERROR_MAP[errorType] || CODEX_ERROR_MAP.Other;
    return new LLMProviderError(message, m.code, 'codex-cli', m.status, m.retryable, { errorType });
  }

  /**
   * Format LLMMessage[] into a single prompt string for the CLI.
   * System messages first, then user/assistant turns in order.
   * If tools are provided, appends a structured tool schema section and usage instructions.
   */
  private formatMessages(messages: LLMMessage[], tools?: LLMTool[]): string {
    const systemParts: string[] = [];
    const convParts: string[] = [];

    for (const msg of messages) {
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.filter((p) => p.type === 'text' && p.text).map((p) => p.text!).join('\n');

      if (msg.role === 'system') {
        systemParts.push(text);
      } else {
        const label = msg.role === 'assistant' ? 'Assistant' : 'User';
        convParts.push(`${label}: ${text}`);
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
