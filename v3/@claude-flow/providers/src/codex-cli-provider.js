/**
 * V3 Codex CLI Subprocess Provider
 *
 * Wraps OpenAI's Codex CLI (Rust binary) as a subprocess provider.
 * Auth: ChatGPT subscription OAuth by default (no API key needed).
 * CI/headless auth via CODEX_API_KEY environment variable.
 *
 * @module @claude-flow/providers/codex-cli-provider
 */
import { spawn, execFile } from 'child_process';
import { createInterface } from 'readline';
import { BaseProvider } from './base-provider.js';
import { LLMProviderError, AuthenticationError, ProviderUnavailableError, RateLimitError, } from './types.js';
// ===== Static Data =====
const CODEX_MODELS = [
    'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-max',
    'gpt-5.1-codex', 'gpt-5-codex', 'gpt-5-codex-mini',
];
const MODEL_INFO = {
    'gpt-5.3-codex': { desc: 'GPT-5.3 Codex - Latest flagship code model', ctx: 200000, out: 32768 },
    'gpt-5.2-codex': { desc: 'GPT-5.2 Codex - Previous-generation flagship', ctx: 200000, out: 32768 },
    'gpt-5.1-codex-max': { desc: 'GPT-5.1 Codex Max - Extended context and reasoning', ctx: 512000, out: 65536 },
    'gpt-5.1-codex': { desc: 'GPT-5.1 Codex - High-capability code model', ctx: 128000, out: 16384 },
    'gpt-5-codex': { desc: 'GPT-5 Codex - Baseline code model', ctx: 128000, out: 16384 },
    'gpt-5-codex-mini': { desc: 'GPT-5 Codex Mini - Fast and cost-effective', ctx: 128000, out: 16384 },
};
const toRecord = (fn) => Object.fromEntries(Object.keys(MODEL_INFO).map((k) => [k, fn(k)]));
const CODEX_ERROR_MAP = {
    ContextWindowExceeded: { code: 'CONTEXT_EXCEEDED', status: 400, retryable: false },
    UsageLimitExceeded: { code: 'RATE_LIMIT', status: 429, retryable: true },
    HttpConnectionFailed: { code: 'CONNECTION_FAILED', status: 503, retryable: true },
    ResponseStreamConnectionFailed: { code: 'STREAM_FAILED', status: 503, retryable: true },
    BadRequest: { code: 'BAD_REQUEST', status: 400, retryable: false },
    Unauthorized: { code: 'AUTHENTICATION', status: 401, retryable: false },
    SandboxError: { code: 'SANDBOX_ERROR', status: 500, retryable: false },
    InternalServerError: { code: 'INTERNAL_ERROR', status: 500, retryable: true },
    Other: { code: 'UNKNOWN', status: 500, retryable: true },
};
const RECONNECT_RE = /Reconnecting\.\.\.\s*\d+\/\d+/;
const FREE = { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' };
function calcCost(prompt, completion, pricing) {
    const p = (prompt / 1000) * pricing.promptCostPer1k;
    const c = (completion / 1000) * pricing.completionCostPer1k;
    return { promptCost: p, completionCost: c, totalCost: p + c, currency: 'USD' };
}
export class CodexCLIProvider extends BaseProvider {
    name = 'codex-cli';
    capabilities = {
        supportedModels: CODEX_MODELS,
        maxContextLength: toRecord((k) => MODEL_INFO[k].ctx),
        maxOutputTokens: toRecord((k) => MODEL_INFO[k].out),
        supportsStreaming: true, supportsToolCalling: false, supportsSystemMessages: true,
        supportsVision: false, supportsAudio: false, supportsFineTuning: false,
        supportsEmbeddings: false, supportsBatching: false,
        rateLimit: { requestsPerMinute: 60, tokensPerMinute: 1000000, concurrentRequests: 5 },
        pricing: {
            'gpt-5.3-codex': FREE, 'gpt-5.2-codex': FREE, 'gpt-5.1-codex-max': FREE,
            'gpt-5.1-codex': FREE, 'gpt-5-codex': FREE,
            'gpt-5-codex-mini': { promptCostPer1k: 0.0015, completionCostPer1k: 0.006, currency: 'USD' },
        },
    };
    binaryPath = null;
    activeProcesses = new Set();
    defaultTimeout;
    constructor(options) {
        super(options);
        this.defaultTimeout = options.config.timeout || 120000;
    }
    async doInitialize() {
        this.binaryPath = await this.findBinary();
        if (!this.binaryPath) {
            this.logger.warn('Codex CLI binary not found in PATH. Install: npm install -g @openai/codex');
        }
        else {
            this.logger.info('Codex CLI binary found', { path: this.binaryPath });
        }
    }
    validateConfig() {
        // Don't set default model - omitting --model flag lets Codex use config.toml default
        // 'auto' is explicitly handled as "use default" in spawnCodex()
        if (this.config.model && this.config.model !== 'auto' && !this.validateModel(this.config.model)) {
            this.logger.warn(`Model ${this.config.model} may not be supported by codex-cli`);
        }
    }
    async doComplete(request) {
        this.ensureBinary();
        const model = request.model || this.config.model;
        const child = this.spawnCodex(request, model);
        const rl = createInterface({ input: child.stdout });
        return new Promise((resolve, reject) => {
            let responseText = '';
            let usage = { input: 0, output: 0 };
            let errorMsg = '';
            let turnFailed = false;
            let settled = false;
            const timer = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                child.kill('SIGKILL');
                this.activeProcesses.delete(child);
                reject(new LLMProviderError('Request timed out', 'TIMEOUT', 'codex-cli', undefined, true));
            }, this.defaultTimeout);
            rl.on('line', (line) => {
                const ev = this.parseLine(line);
                if (!ev)
                    return;
                if (ev.type === 'item.completed') {
                    const e = ev;
                    if (e.item.type === 'agent_message' && e.item.text)
                        responseText = e.item.text;
                }
                else if (ev.type === 'turn.completed') {
                    const e = ev;
                    if (e.usage) {
                        usage = { input: e.usage.input_tokens || 0, output: e.usage.output_tokens || 0 };
                    }
                }
                else if (ev.type === 'turn.failed') {
                    const e = ev;
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
                }
                else if (ev.type === 'error') {
                    const e = ev;
                    const m = e.message || e.error?.message || '';
                    if (!RECONNECT_RE.test(m))
                        errorMsg = m || 'Unknown error';
                }
            });
            child.stderr?.on('data', (d) => {
                const t = d.toString();
                if (!RECONNECT_RE.test(t))
                    this.logger.debug('codex stderr', { output: t });
            });
            child.on('close', (code) => {
                clearTimeout(timer);
                this.activeProcesses.delete(child);
                rl.close();
                if (settled)
                    return;
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
                const pricing = this.capabilities.pricing[model] || FREE;
                resolve({
                    id: `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    model: model, provider: 'codex-cli', content: responseText,
                    usage: { promptTokens: usage.input, completionTokens: usage.output, totalTokens: usage.input + usage.output },
                    cost: calcCost(usage.input, usage.output, pricing),
                    finishReason: 'stop',
                });
            });
            child.on('error', (err) => {
                clearTimeout(timer);
                this.activeProcesses.delete(child);
                rl.close();
                if (settled)
                    return;
                settled = true;
                reject(this.transformError(err));
            });
        });
    }
    async *doStreamComplete(request) {
        this.ensureBinary();
        const model = request.model || this.config.model;
        const child = this.spawnCodex(request, model);
        const rl = createInterface({ input: child.stdout });
        const queue = [];
        let done = false;
        let notify = null;
        const wake = () => { if (notify) {
            notify();
            notify = null;
        } };
        let spawnError = null;
        rl.on('line', (line) => { queue.push(line); wake(); });
        child.on('close', () => { done = true; this.activeProcesses.delete(child); rl.close(); wake(); });
        child.on('error', (err) => { spawnError = err; done = true; this.activeProcesses.delete(child); rl.close(); wake(); });
        const timer = setTimeout(() => { child.kill('SIGKILL'); this.activeProcesses.delete(child); done = true; wake(); }, this.defaultTimeout);
        try {
            while (!done || queue.length > 0) {
                if (queue.length === 0 && !done) {
                    await new Promise((r) => { notify = r; });
                    continue;
                }
                const line = queue.shift();
                if (!line)
                    continue;
                const ev = this.parseLine(line);
                if (!ev)
                    continue;
                if (ev.type === 'item.completed') {
                    const e = ev;
                    if (e.item.type === 'agent_message' && e.item.text) {
                        yield { type: 'content', delta: { content: e.item.text } };
                    }
                }
                else if (ev.type === 'turn.completed') {
                    const e = ev;
                    const p = e.usage?.input_tokens || 0, c = e.usage?.output_tokens || 0;
                    const pricing = this.capabilities.pricing[model] || FREE;
                    yield { type: 'done', usage: { promptTokens: p, completionTokens: c, totalTokens: p + c }, cost: calcCost(p, c, pricing) };
                }
                else if (ev.type === 'turn.failed') {
                    const e = ev;
                    const msg = e.error?.message || 'Turn failed';
                    const t = e.error?.codexErrorInfo?.type;
                    yield { type: 'error', error: t ? this.mapCodexError(msg, t) : new Error(msg) };
                }
                else if (ev.type === 'error') {
                    const e = ev;
                    const m = e.message || e.error?.message || '';
                    if (!RECONNECT_RE.test(m))
                        yield { type: 'error', error: new Error(m || 'Unknown error') };
                }
            }
            // Surface spawn errors instead of silently completing
            if (spawnError) {
                yield { type: 'error', error: this.transformError(spawnError) };
                return;
            }
        }
        finally {
            clearTimeout(timer);
            rl.close();
            if (!done) {
                child.kill('SIGKILL');
                this.activeProcesses.delete(child);
            }
        }
    }
    async listModels() { return [...CODEX_MODELS]; }
    async getModelInfo(model) {
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
    async doHealthCheck() {
        if (!this.binaryPath) {
            const found = await this.findBinary();
            if (found)
                this.binaryPath = found;
        }
        if (!this.binaryPath) {
            return { healthy: false, error: 'Codex CLI binary not found in PATH', timestamp: new Date(),
                details: { hint: 'Install: npm install -g @openai/codex' } };
        }
        return new Promise((resolve) => {
            execFile(this.binaryPath, ['--version'], { timeout: 10000 }, (error, stdout) => {
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
    destroy() {
        for (const p of this.activeProcesses) {
            try {
                p.kill('SIGKILL');
            }
            catch { /* already dead */ }
        }
        this.activeProcesses.clear();
        super.destroy();
    }
    // ===== Private Helpers =====
    findBinary() {
        return new Promise((resolve) => {
            const cmd = process.platform === 'win32' ? 'where' : 'which';
            execFile(cmd, ['codex'], (err, stdout) => {
                resolve(!err && stdout.trim() ? stdout.trim().split('\n')[0].trim() : null);
            });
        });
    }
    ensureBinary() {
        if (!this.binaryPath) {
            throw new ProviderUnavailableError('codex-cli', {
                message: 'Codex CLI binary not found in PATH', hint: 'Install: npm install -g @openai/codex',
            });
        }
    }
    spawnCodex(request, model) {
        const prompt = request.messages.map((msg) => {
            const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
            const text = typeof msg.content === 'string' ? msg.content : msg.content.map((p) => p.text || '').join('');
            return `${role}: ${text}`;
        }).join('\n\n');
        // Guard against ARG_MAX: measure byte length (UTF-8) not JS character count
        // to handle multi-byte Unicode correctly. Limit to 200KB to stay well under
        // typical ARG_MAX of 1MB (leaving room for env vars and other args).
        const promptBytes = Buffer.byteLength(prompt, 'utf8');
        if (promptBytes > 200_000) {
            throw new LLMProviderError(`Prompt too long for CLI argument (${promptBytes} bytes, max ~200KB). Reduce prompt size.`, 'INPUT_TOO_LARGE', 'codex-cli', 400, false);
        }
        const args = ['exec', prompt, '--json', '--ephemeral', '--skip-git-repo-check'];
        // Only include --model if explicitly set (not 'auto' or undefined)
        // Omitting --model lets Codex use config.toml default (typically gpt-5.3-codex)
        if (model && model !== 'auto') {
            args.push('--model', String(model));
        }
        const env = {
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
        };
        const apiKey = this.config.apiKey || process.env.CODEX_API_KEY;
        if (apiKey)
            env.CODEX_API_KEY = apiKey;
        // Also forward OPENAI_API_KEY for users who use that instead
        if (process.env.OPENAI_API_KEY)
            env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
        // Windows: HOME is undefined; Codex needs USERPROFILE for config.toml discovery
        if (process.platform === 'win32') {
            env.USERPROFILE = process.env.USERPROFILE;
            env.APPDATA = process.env.APPDATA;
            env.LOCALAPPDATA = process.env.LOCALAPPDATA;
        }
        const child = spawn(this.binaryPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
        this.activeProcesses.add(child);
        child.stdin.end(); // CRITICAL: prevent hang — stdin must be closed
        return child;
    }
    parseNestedErrorMessage(message) {
        try {
            const parsed = JSON.parse(message);
            if (typeof parsed === 'object' && parsed !== null) {
                return parsed.detail
                    || parsed.message
                    || parsed.error
                    || message;
            }
            return String(parsed);
        }
        catch {
            return message;
        }
    }
    parseLine(line) {
        const t = line.trim();
        if (!t)
            return null;
        try {
            return JSON.parse(t);
        }
        catch {
            return null;
        }
    }
    mapCodexError(message, errorType) {
        if (errorType === 'Unauthorized')
            return new AuthenticationError(message, 'codex-cli');
        if (errorType === 'UsageLimitExceeded')
            return new RateLimitError(message, 'codex-cli');
        if (errorType === 'HttpConnectionFailed' || errorType === 'ResponseStreamConnectionFailed') {
            return new ProviderUnavailableError('codex-cli', { message, errorType });
        }
        const m = CODEX_ERROR_MAP[errorType] || CODEX_ERROR_MAP.Other;
        return new LLMProviderError(message, m.code, 'codex-cli', m.status, m.retryable, { errorType });
    }
}
//# sourceMappingURL=codex-cli-provider.js.map