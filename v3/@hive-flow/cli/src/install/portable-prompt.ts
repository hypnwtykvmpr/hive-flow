import { createReadStream, createWriteStream } from 'node:fs';
import { existsSync } from 'node:fs';
import readline from 'node:readline';

export interface PortableConfirmOptions {
  yes?: boolean;
  headlessDefault?: boolean;
  platform?: NodeJS.Platform;
  stdinIsTTY?: boolean;
  ttyAvailable?: boolean;
  confirmText?: string | RegExp;
  ask?: (question: string, source: 'tty' | 'stdin') => Promise<string>;
}

export interface ReadSecretOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export interface ReadRequiredSecretOptions extends ReadSecretOptions {
  purpose?: string;
}

function defaultConfirmMatcher(answer: string, confirmText?: string | RegExp): boolean {
  const trimmed = answer.trim();
  if (confirmText instanceof RegExp) return confirmText.test(trimmed);
  if (typeof confirmText === 'string') return trimmed === confirmText;
  return /^(y|yes)$/i.test(trimmed);
}

async function askReadline(question: string, source: 'tty' | 'stdin'): Promise<string> {
  if (source === 'tty') {
    const ttyIn = createReadStream('/dev/tty');
    const ttyOut = createWriteStream('/dev/tty');
    const rl = readline.createInterface({ input: ttyIn, output: ttyOut });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (answer = '') => {
        if (settled) return;
        settled = true;
        rl.close();
        ttyIn.destroy();
        ttyOut.destroy();
        resolve(answer);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        rl.close();
        ttyIn.destroy();
        ttyOut.destroy();
        reject(error);
      };
      ttyIn.on('error', fail);
      ttyOut.on('error', fail);
      rl.on('error', fail);
      rl.question(question, finish);
    });
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function isTtyUnavailableError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : '';
  return ['ENXIO', 'ENODEV', 'ENOTTY', 'EIO'].includes(code);
}

export async function portableConfirm(question: string, options: PortableConfirmOptions = {}): Promise<boolean> {
  if (options.yes === true) return true;

  const platform = options.platform || process.platform;
  const ttyAvailable = options.ttyAvailable ?? (platform !== 'win32' && existsSync('/dev/tty'));
  const stdinIsTTY = options.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const ask = options.ask || askReadline;

  if (platform !== 'win32' && ttyAvailable) {
    try {
      return defaultConfirmMatcher(await ask(question, 'tty'), options.confirmText);
    } catch (error) {
      if (!isTtyUnavailableError(error)) throw error;
      if (!stdinIsTTY) return options.headlessDefault === true;
    }
  }

  if (stdinIsTTY) {
    return defaultConfirmMatcher(await ask(question, 'stdin'), options.confirmText);
  }

  return options.headlessDefault === true;
}

export async function readSecret(prompt: string, options: ReadSecretOptions = {}): Promise<string> {
  const input = options.input || process.stdin;
  const output = options.output || process.stderr;
  if (!input.isTTY) return '';

  output.write(prompt);
  const chunks: string[] = [];
  const wasRaw = Boolean(input.isRaw);
  input.setRawMode(true);
  input.resume();

  return new Promise((resolve) => {
    const finish = (value: string) => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      output.write('\n');
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const char of text) {
        if (char === '\u0003') finish('');
        else if (char === '\r' || char === '\n') finish(chunks.join(''));
        else if (char === '\u007f') chunks.pop();
        else chunks.push(char);
      }
    };
    input.on('data', onData);
  });
}

export async function readRequiredSecret(prompt: string, options: ReadRequiredSecretOptions = {}): Promise<string> {
  const value = await readSecret(prompt, options);
  if (!value) {
    const purpose = options.purpose || 'secret prompt';
    throw new Error(`${purpose} refused empty secret in non-interactive or cancelled input`);
  }
  return value;
}
