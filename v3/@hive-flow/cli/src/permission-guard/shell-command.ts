export interface ShellToken {
  text: string;
  raw: string;
  quoted: boolean;
  operator: boolean;
}

export interface ShellExecution {
  command: string;
  commandToken: ShellToken;
  args: string[];
  argTokens: ShellToken[];
  tokens: ShellToken[];
  depth: number;
  subCommand: string;
}

export const INLINE_EVAL_DENIAL =
  'Inline code execution is blocked because file effects cannot be verified reliably. Instead: use Read, Write, or Edit for files; write a script file in the project and run it normally for programs.';

function stripShellQuotes(token: string): string {
  const trimmed = String(token || '').trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function readShellToken(command: string, startIndex: number): { token: string; raw: string; quoted: boolean; end: number } {
  let i = startIndex;
  while (i < command.length && /\s/.test(command[i])) i++;
  let token = '';
  let quote: string | null = null;
  let quoted = false;

  while (i < command.length) {
    const ch = command[i];
    if (quote) {
      token += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        token += command[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      token += ch;
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      token += ch + command[i + 1];
      i += 2;
      continue;
    }
    if (/\s/.test(ch) || ch === '|' || ch === ';' || ch === '&' || ch === '<' || ch === '>') {
      break;
    }
    token += ch;
    i++;
  }

  return { token: stripShellQuotes(token), raw: token, quoted, end: i };
}

export function shellTokens(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && /\s/.test(command[i])) i++;
    if (i >= command.length) break;

    const ch = command[i];
    if (ch === '|' || ch === ';' || ch === '&') {
      const pair = command[i + 1] === ch ? ch + ch : ch;
      tokens.push({ text: pair, raw: pair, quoted: false, operator: true });
      i += pair.length;
      continue;
    }

    const read = readShellToken(command, i);
    if (read.token) {
      tokens.push({ text: read.token, raw: read.raw, quoted: read.quoted, operator: false });
    }
    i = read.end > i ? read.end : i + 1;
  }
  return tokens;
}

export function splitShellSubcommands(command: string): string[] {
  const subCommands: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';') {
      if (current.trim()) subCommands.push(current);
      current = '';
      continue;
    }
    if ((ch === '&' || ch === '|') && command[i + 1] === ch) {
      if (current.trim()) subCommands.push(current);
      current = '';
      i++;
      continue;
    }
    current += ch;
  }

  if (current.trim()) subCommands.push(current);
  return subCommands;
}

function isShellAssignmentToken(token: ShellToken | undefined): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token?.text || '');
}

function splitTokenSegments(tokens: ShellToken[]): ShellToken[][] {
  const segments: ShellToken[][] = [];
  let current: ShellToken[] = [];

  for (const token of tokens) {
    if (token.operator) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }

  if (current.length) segments.push(current);
  return segments;
}

function commandExecutionFromTokens(tokens: ShellToken[]): Omit<ShellExecution, 'depth' | 'subCommand'> | null {
  let index = 0;
  while (index < tokens.length && !tokens[index].quoted && isShellAssignmentToken(tokens[index])) index++;
  if (!tokens[index]) return null;

  if (tokens[index].text === 'env') {
    index++;
    while (index < tokens.length) {
      const word = tokens[index].text || '';
      if (word === '--') {
        index++;
        break;
      }
      if (word.startsWith('-')) {
        index++;
        continue;
      }
      if (!tokens[index].quoted && isShellAssignmentToken(tokens[index])) {
        index++;
        continue;
      }
      break;
    }
  }

  if (tokens[index]?.text === 'command') index++;
  if (!tokens[index]) return null;

  return {
    command: tokens[index].text,
    commandToken: tokens[index],
    args: tokens.slice(index + 1).map(token => token.text),
    argTokens: tokens.slice(index + 1),
    tokens,
  };
}

function shellCommandBody(execution: ShellExecution): string | null {
  if (!/^(?:bash|sh|zsh|dash|ksh)$/.test(execution.command)) return null;

  for (let i = 0; i < execution.argTokens.length; i++) {
    const arg = execution.argTokens[i].text || '';
    if (arg === '-c' || (/^-[A-Za-z]+$/.test(arg) && arg.includes('c'))) {
      return execution.argTokens[i + 1]?.text || null;
    }
  }

  return null;
}

export function collectShellCommandExecutions(command: string, depth = 0): ShellExecution[] {
  if (depth > 4) return [];

  const executions: ShellExecution[] = [];
  for (const subCommand of splitShellSubcommands(String(command || ''))) {
    const tokens = shellTokens(subCommand);
    for (const segment of splitTokenSegments(tokens)) {
      const execution = commandExecutionFromTokens(segment);
      if (!execution) continue;

      const fullExecution: ShellExecution = {
        ...execution,
        depth,
        subCommand: segment.map(token => token.raw).join(' '),
      };
      executions.push(fullExecution);

      const body = shellCommandBody(fullExecution);
      if (body) executions.push(...collectShellCommandExecutions(body, depth + 1));
    }
  }
  return executions;
}

function commandBasename(command: string): string {
  return command.replace(/\\/g, '/').split('/').pop() || command;
}

function hasAnyArg(args: string[], names: string[]): boolean {
  return args.some(arg => names.includes(arg));
}

export function isInlineEvalExecution(execution: ShellExecution): boolean {
  const command = commandBasename(execution.command);
  const args = execution.args;

  if (command === 'node') {
    return args.some(arg =>
      arg === '-e' ||
      arg === '--eval' ||
      arg === '-p' ||
      arg === '--print' ||
      (/^-[^-]/.test(arg) && arg.includes('e')) ||
      (/^-[^-]/.test(arg) && arg.includes('p'))
    );
  }

  if (/^(?:python|python3|python3\.\d+)$/.test(command)) return hasAnyArg(args, ['-c']);
  if (command === 'ruby') return hasAnyArg(args, ['-e', '-E']);
  if (command === 'perl') return hasAnyArg(args, ['-e', '-E']);
  if (command === 'deno') return args[0] === 'eval';
  if (command === 'bun') return hasAnyArg(args, ['-e']);
  if (command === 'php') return hasAnyArg(args, ['-r', '-R']);

  return false;
}

export function findInlineEvalInvocation(command: string): ShellExecution | null {
  return collectShellCommandExecutions(command).find(isInlineEvalExecution) || null;
}

export function hasInlineEvalInvocation(command: string): boolean {
  return findInlineEvalInvocation(command) !== null;
}
