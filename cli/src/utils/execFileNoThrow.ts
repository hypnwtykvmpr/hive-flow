import { execFile } from 'node:child_process';

export interface ExecFileNoThrowOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: Uint8Array | string;
  timeout?: number;
  windowsHide?: boolean;
}

export interface ExecFileNoThrowResult {
  code: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export function execFileNoThrow(
  file: string,
  args: readonly string[] = [],
  options: ExecFileNoThrowOptions = {},
): Promise<ExecFileNoThrowResult> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        file,
        [...args],
        {
          cwd: options.cwd,
          env: options.env,
          encoding: 'utf8',
          timeout: options.timeout,
          windowsHide: options.windowsHide ?? true,
        },
        (error, stdout, stderr) => {
          const anyError = error as NodeJS.ErrnoException & {
            code?: number | string | null;
            signal?: NodeJS.Signals | null;
          } | null;
          const rawCode = anyError?.code;
          const code = typeof rawCode === 'number'
            ? rawCode
            : error
              ? 1
              : 0;
          resolve({
            code,
            signal: anyError?.signal ?? null,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            error: error ? error.message : undefined,
          });
        },
      );
      if (options.input !== undefined) {
        child.stdin?.end(options.input);
      }
    } catch (error) {
      resolve({
        code: 1,
        signal: null,
        stdout: '',
        stderr: '',
        error: (error as Error).message,
      });
    }
  });
}
