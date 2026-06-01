import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import fc, { type IRawProperty, type Parameters as FastCheckParameters } from 'fast-check';

export interface SeededPropertyOptions extends FastCheckParameters<unknown> {
  readonly seed: number;
  readonly numRuns?: number;
}

export function propertyRunsFromEnv(env: NodeJS.ProcessEnv = process.env, fallback = 100): number {
  const raw = Number(env.HIVE_FLOW_PROPERTY_RUNS ?? env.HF_PROPERTY_RUNS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function seededPropertyConfig(opts: SeededPropertyOptions): FastCheckParameters<unknown> {
  return {
    ...opts,
    numRuns: opts.numRuns ?? propertyRunsFromEnv(),
    seed: opts.seed,
  };
}

export function assertSeededProperty<Ts extends [unknown, ...unknown[]]>(
  property: IRawProperty<Ts>,
  opts: SeededPropertyOptions,
): void {
  fc.assert(property, seededPropertyConfig(opts));
}

export interface TempProject {
  readonly root: string;
  cleanup(): void;
}

export function createTempProject(prefix = 'hive-flow-test-'): TempProject {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface RunProcessOptions extends SpawnOptionsWithoutStdio {
  readonly input?: string;
  readonly timeoutMs?: number;
}

export interface RunProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export function runProcess(command: string, args: readonly string[], opts: RunProcessOptions = {}): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      ...opts,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timeout = opts.timeoutMs
      ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, opts.timeoutMs)
      : null;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      if (timeout) clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on('close', (exitCode, signal) => {
      if (timeout) clearTimeout(timeout);
      if (!settled) {
        settled = true;
        resolve({ exitCode, signal, stdout, stderr, timedOut });
      }
    });
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    } else {
      child.stdin?.end();
    }
  });
}

export type FakeHttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) => void | Promise<void>;

export interface FakeHttpServer {
  readonly origin: string;
  readonly server: Server;
  close(): Promise<void>;
}

export async function createFakeHttpServer(handler: FakeHttpHandler): Promise<FakeHttpServer> {
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        await handler(req, res, body);
      } catch (err) {
        res.statusCode = 500;
        res.end(err instanceof Error ? err.message : 'handler failed');
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('createFakeHttpServer: failed to bind TCP port');
  }

  return {
    origin: `http://127.0.0.1:${addr.port}`,
    server,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /OPENROUTER_API_KEY\s*=\s*[A-Za-z0-9._-]+/i,
  /(?:sk-or|sk-ant|AIza)[A-Za-z0-9._-]{12,}/,
  /Bearer\s+[A-Za-z0-9._-]{12,}/i,
];

export function findSecretLeak(text: string, extraPatterns: ReadonlyArray<RegExp> = []): string | undefined {
  const patterns = [...SECRET_PATTERNS, ...extraPatterns];
  return patterns.find((pattern) => pattern.test(text))?.source;
}

export function assertNoSecretLeak(text: string, extraPatterns: ReadonlyArray<RegExp> = []): void {
  const leaked = findSecretLeak(text, extraPatterns);
  if (leaked) {
    throw new Error(`Secret-like value leaked in test output (matched /${leaked}/)`);
  }
}
