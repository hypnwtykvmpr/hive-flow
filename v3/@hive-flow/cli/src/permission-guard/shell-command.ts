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
  envAssignments: Record<string, string>;
}

export const INLINE_EVAL_DENIAL =
  'Inline code execution is blocked because file effects cannot be verified reliably. Instead: use Read, Write, or Edit for files; write a script file in the project and run it normally for programs.';

function normalizeLineContinuations(command: string): string {
  let normalized = '';
  let quote: string | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      if (!quote && ch === '\r' && command[i + 1] === '\n') {
        normalized += '\n';
        i++;
      } else if (!quote && ch === '\n') {
        normalized += '\n';
      } else {
        normalized += `\\${ch}`;
      }
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      normalized += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      normalized += ch;
      continue;
    }
    normalized += ch;
  }

  if (escaped) normalized += '\\';
  return normalized;
}

function stripHeredocBodies(command: string): string {
  const lines = String(command || '').split(/\r?\n/);
  const output: string[] = [];
  const markers: string[] = [];

  for (const line of lines) {
    if (markers.length) {
      if (line.trim() === markers[0]) {
        markers.shift();
      }
      continue;
    }

    output.push(line);
    const heredoc = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (heredoc) markers.push(heredoc[2]);
  }

  return output.join('\n');
}

function isHorizontalWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\v' || ch === '\f';
}

function isCommandBoundary(ch: string | undefined): boolean {
  return ch === '\n' || ch === '\r' || ch === '|' || ch === ';' || ch === '&' ||
    ch === '<' || ch === '>' || ch === '(' || ch === ')' || ch === '{' || ch === '}';
}

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

function normalizeShellWord(token: string): string {
  const trimmed = stripShellQuotes(token);
  let normalized = '';
  let quote: string | null = null;
  let escaped = false;

  for (const ch of trimmed) {
    if (escaped) {
      normalized += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else normalized += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    normalized += ch;
  }

  if (escaped) normalized += '\\';
  return normalized;
}

function readShellToken(command: string, startIndex: number): { token: string; raw: string; quoted: boolean; end: number } {
  let i = startIndex;
  while (i < command.length && isHorizontalWhitespace(command[i])) i++;
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
    if (/\s/.test(ch) || isCommandBoundary(ch)) {
      break;
    }
    token += ch;
    i++;
  }

  return { token: normalizeShellWord(token), raw: token, quoted, end: i };
}

export function shellTokens(command: string): ShellToken[] {
  command = normalizeLineContinuations(command);
  const tokens: ShellToken[] = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && isHorizontalWhitespace(command[i])) i++;
    if (i >= command.length) break;

    const ch = command[i];
    if (ch === '\r' || ch === '\n') {
      const raw = ch === '\r' && command[i + 1] === '\n' ? '\r\n' : ch;
      tokens.push({ text: '\n', raw, quoted: false, operator: true });
      i += raw.length;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      tokens.push({ text: ch, raw: ch, quoted: false, operator: true });
      i++;
      continue;
    }
    if (ch === '<' || ch === '>') {
      const pair = command[i + 1] === ch ? ch + ch : ch;
      tokens.push({ text: pair, raw: pair, quoted: false, operator: true });
      i += pair.length;
      continue;
    }
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
  command = normalizeLineContinuations(command);
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
    if (ch === ';' || ch === '\n' || ch === '\r') {
      if (current.trim()) subCommands.push(current);
      current = '';
      if (ch === '\r' && command[i + 1] === '\n') i++;
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

function assignmentParts(token: ShellToken | undefined): { name: string; value: string } | null {
  const match = String(token?.text || '').match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  return match ? { name: match[1], value: match[2] } : null;
}

function isShellAssignmentToken(token: ShellToken | undefined): boolean {
  return assignmentParts(token) !== null;
}

function splitTokenSegments(tokens: ShellToken[]): ShellToken[][] {
  const segments: ShellToken[][] = [];
  let current: ShellToken[] = [];
  const reservedWords = new Set([
    'if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done',
    'case', 'esac', 'in', '!', 'select',
  ]);

  for (const token of tokens) {
    if (token.operator || (!token.quoted && reservedWords.has(token.text))) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }

  if (current.length) segments.push(current);
  return segments;
}

function commandBasename(command: string): string {
  const normalized = normalizeShellWord(command).replace(/\\/g, '/');
  return normalized.split('/').pop() || normalized;
}

const LAUNCHER_VALUE_FLAGS = new Map<string, Set<string>>([
  ['exec', new Set(['-a'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['timeout', new Set(['-k', '--kill-after'])],
  ['time', new Set(['-f', '-o', '--format', '--output'])],
  ['ionice', new Set(['-c', '-n', '-p'])],
]);

function skipSimpleOptions(tokens: ShellToken[], index: number, valueFlags = new Set<string>()): number {
  while (index < tokens.length) {
    const word = tokens[index].text || '';
    if (word === '--') return index + 1;
    if (!word.startsWith('-')) break;
    const flagName = word.split('=', 1)[0];
    if (valueFlags.has(word) || valueFlags.has(flagName)) {
      index += word.includes('=') ? 1 : 2;
      continue;
    }
    index++;
  }
  return index;
}

function isCoprocNameToken(token?: ShellToken): boolean {
  return Boolean(token && !token.operator && /^[A-Za-z_]\w*$/.test(token.text || ''));
}

function isCoprocCommandToken(token?: ShellToken): boolean {
  return Boolean(token && !token.operator && token.text !== '{' && token.text !== '(' && !(token.text || '').startsWith('-'));
}

function skipCoprocLauncher(tokens: ShellToken[], index: number): number {
  let next = index + 1;
  if (!tokens[next]) return next;

  if (isCoprocNameToken(tokens[next]) && isCoprocCommandToken(tokens[next + 1])) {
    next++;
  }

  return next;
}

function skipTransparentLauncher(tokens: ShellToken[], index: number): number {
  const base = commandBasename(tokens[index]?.text || '').toLowerCase();
  let next = index + 1;

  if (base === 'coproc') {
    return skipCoprocLauncher(tokens, index);
  }

  if (['command', 'builtin', 'nohup', 'setsid'].includes(base)) {
    return skipSimpleOptions(tokens, next);
  }

  if (['exec', 'nice', 'time', 'stdbuf', 'ionice'].includes(base)) {
    return skipSimpleOptions(tokens, next, LAUNCHER_VALUE_FLAGS.get(base) || new Set());
  }

  if (base === 'timeout') {
    next = skipSimpleOptions(tokens, next, LAUNCHER_VALUE_FLAGS.get(base) || new Set());
    return tokens[next] ? next + 1 : next;
  }

  if (base === 'taskset') {
    next = skipSimpleOptions(tokens, next, new Set(['-p', '--pid']));
    return tokens[next] ? next + 1 : next;
  }

  return index;
}

function commandExecutionFromTokens(tokens: ShellToken[]): Omit<ShellExecution, 'depth' | 'subCommand'> | null {
  let index = 0;
  const envAssignments: Record<string, string> = {};

  while (index < tokens.length) {
    while (index < tokens.length && isShellAssignmentToken(tokens[index])) {
      const assignment = assignmentParts(tokens[index]);
      if (assignment) envAssignments[assignment.name] = assignment.value;
      index++;
    }
    if (!tokens[index]) return null;

    if (commandBasename(tokens[index].text).toLowerCase() === 'env') {
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
        if (isShellAssignmentToken(tokens[index])) {
          const assignment = assignmentParts(tokens[index]);
          if (assignment) envAssignments[assignment.name] = assignment.value;
          index++;
          continue;
        }
        break;
      }
      continue;
    }

    const launcherIndex = skipTransparentLauncher(tokens, index);
    if (launcherIndex !== index) {
      index = launcherIndex;
      continue;
    }

    break;
  }

  if (!tokens[index]) return null;

  return {
    command: tokens[index].text,
    commandToken: tokens[index],
    args: tokens.slice(index + 1).map(token => token.text),
    argTokens: tokens.slice(index + 1),
    tokens,
    envAssignments,
  };
}

function shellCommandBody(execution: ShellExecution): string | null {
  const base = commandBasename(execution.command).toLowerCase();
  let args = execution.argTokens;

  if (base === 'busybox' && /^(?:bash|sh|zsh|dash|ksh|fish|csh|tcsh)$/.test(args[0]?.text || '')) {
    args = args.slice(1);
  } else if (!/^(?:bash|sh|zsh|dash|ksh|fish|csh|tcsh)$/.test(base)) {
    return null;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i].text || '';
    if (arg === '-c' || (/^-[A-Za-z]+$/.test(arg) && arg.includes('c'))) {
      const body = args[i + 1];
      return body ? stripShellQuotes(body.raw || body.text) : null;
    }
  }

  return null;
}

function xargsCommandBody(execution: ShellExecution): string | null {
  if (commandBasename(execution.command).toLowerCase() !== 'xargs') return null;
  let index = 0;
  const valueFlags = new Set(['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-i', '-L', '-l', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars']);
  while (index < execution.argTokens.length) {
    const word = execution.argTokens[index].text || '';
    if (word === '--') {
      index++;
      break;
    }
    if (word.startsWith('-')) {
      const flagName = word.split('=', 1)[0];
      index += valueFlags.has(word) || valueFlags.has(flagName) ? (word.includes('=') ? 1 : 2) : 1;
      continue;
    }
    break;
  }
  return execution.argTokens[index]
    ? execution.argTokens.slice(index).map(token => token.raw).join(' ')
    : null;
}

function findExecCommandBodies(execution: ShellExecution): string[] {
  if (commandBasename(execution.command).toLowerCase() !== 'find') return [];
  const bodies: string[] = [];
  for (let i = 0; i < execution.argTokens.length; i++) {
    const word = execution.argTokens[i].text || '';
    if (word !== '-exec' && word !== '-execdir') continue;
    const parts: ShellToken[] = [];
    for (let j = i + 1; j < execution.argTokens.length; j++) {
      const part = execution.argTokens[j];
      if (part.text === ';' || part.text === '+') {
        i = j;
        break;
      }
      parts.push(part);
    }
    if (parts.length) bodies.push(parts.map(token => token.raw).join(' '));
  }
  return bodies;
}

function findMatchingParen(command: string, startIndex: number): number {
  let quote: string | null = null;
  let escaped = false;
  let depth = 1;

  for (let i = startIndex; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function findMatchingBacktick(command: string, startIndex: number): number {
  let escaped = false;
  for (let i = startIndex; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '`') return i;
  }
  return -1;
}

function extractCommandSubstitutions(command: string): string[] {
  const bodies: string[] = [];
  let quote: string | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '$' && command[i + 1] === '(') {
      const end = findMatchingParen(command, i + 2);
      if (end !== -1) {
        bodies.push(command.slice(i + 2, end));
        i = end;
      }
      continue;
    }
    if (ch === '`') {
      const end = findMatchingBacktick(command, i + 1);
      if (end !== -1) {
        bodies.push(command.slice(i + 1, end));
        i = end;
      }
    }
  }

  return bodies;
}

export function collectShellCommandExecutions(command: string, depth = 0): ShellExecution[] {
  if (depth > 4) return [];

  const executions: ShellExecution[] = [];
  const normalizedCommand = normalizeLineContinuations(stripHeredocBodies(String(command || '')));
  for (const substitution of extractCommandSubstitutions(normalizedCommand)) {
    executions.push(...collectShellCommandExecutions(substitution, depth + 1));
  }
  for (const subCommand of splitShellSubcommands(normalizedCommand)) {
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
      const xargsBody = xargsCommandBody(fullExecution);
      if (xargsBody) executions.push(...collectShellCommandExecutions(xargsBody, depth + 1));
      for (const execBody of findExecCommandBodies(fullExecution)) {
        executions.push(...collectShellCommandExecutions(execBody, depth + 1));
      }
    }
  }
  return executions;
}

function hasAnyArg(args: string[], names: string[]): boolean {
  return args.some(arg => names.includes(arg));
}

function hasFlagArg(args: string[], names: string[]): boolean {
  return args.some(arg => names.some(name => arg === name || arg.startsWith(`${name}=`)));
}

function hasShortFlagArg(args: string[], flags: string[]): boolean {
  return args.some(arg => flags.some(flag => arg === flag || (arg.startsWith(flag) && !arg.startsWith('--'))));
}

function hasNodeEvalArg(args: string[]): boolean {
  return hasFlagArg(args, ['--eval', '--print', '--require', '--import', '--loader', '--experimental-loader']) ||
    hasShortFlagArg(args, ['-e', '-p', '-r']);
}

function isNodeCommand(base: string): boolean {
  return /^node(?:js|\d+)?$/.test(base);
}

function isPythonCommand(base: string): boolean {
  return /^(?:python|pypy)(?:\d+(?:\.\d+)?)?$/.test(base);
}

const PYTHON_INLINE_MODULES = new Set(['runpy']);

function hasPythonInlineArg(args: string[]): boolean {
  if (hasAnyArg(args, ['-c'])) return true;
  const moduleIndex = args.indexOf('-m');
  if (moduleIndex === -1) return false;
  const moduleName = args[moduleIndex + 1];
  if (!moduleName) return true;
  return PYTHON_INLINE_MODULES.has(moduleName.toLowerCase());
}

function hasRubyInlineArg(args: string[]): boolean {
  const hasRunStartup = args.includes('-run');
  for (const arg of args) {
    if (arg === '-e') {
      if (hasRunStartup) continue;
      return true;
    }
    if (arg === '-r') return true;
    if (arg.startsWith('-r') && arg !== '-run' && arg !== '-rubygems') return true;
  }
  return false;
}

function unseparatedArgs(args: string[]): string[] {
  return args[0] === '--' ? args.slice(1) : args;
}

function isInlineEvalCommand(command: string, args: string[]): boolean {
  const base = commandBasename(command).toLowerCase();
  const effectiveArgs = unseparatedArgs(args);

  if (isNodeCommand(base)) return hasNodeEvalArg(effectiveArgs);
  if (isPythonCommand(base)) return hasPythonInlineArg(effectiveArgs);
  if (base === 'ruby') return hasRubyInlineArg(effectiveArgs);
  if (base === 'perl') return hasAnyArg(effectiveArgs, ['-e', '-E']) || hasFlagArg(effectiveArgs, ['-M']);
  if (base === 'deno') return effectiveArgs[0] === 'eval' || (effectiveArgs[0] === 'run' && effectiveArgs.some(arg => arg === '-' || arg === '/dev/stdin'));
  if (base === 'bun') return hasAnyArg(effectiveArgs, ['-e']) || hasFlagArg(effectiveArgs, ['--eval']);
  if (base === 'php') return hasAnyArg(effectiveArgs, ['-r', '-R']);
  if (base === 'osascript') return hasAnyArg(effectiveArgs, ['-e']);
  if (/^(?:tsx|ts-node|ts-node-esm|zx)$/.test(base)) return hasAnyArg(effectiveArgs, ['-e']) || hasFlagArg(effectiveArgs, ['--eval']);
  if (/^(?:lua|lua\d+(?:\.\d+)?)$/.test(base)) return hasAnyArg(effectiveArgs, ['-e']);
  if (/^(?:r|rscript)$/i.test(base)) return hasAnyArg(effectiveArgs, ['-e']);

  return false;
}

const RUNNER_OPTION_VALUE_FLAGS = new Set([
  '-C',
  '-p',
  '--cache',
  '--cwd',
  '--dir',
  '--filter',
  '--package',
  '--prefix',
  '--registry',
  '--userconfig',
  '--workspace',
]);

function skipRunnerOptions(args: string[], startIndex: number): number {
  let index = startIndex;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--') {
      return index + 1;
    }
    if (RUNNER_OPTION_VALUE_FLAGS.has(arg)) {
      index += 2;
      continue;
    }
    if ([...RUNNER_OPTION_VALUE_FLAGS].some(flag => arg.startsWith(`${flag}=`))) {
      index++;
      continue;
    }
    if (arg.startsWith('-')) {
      index++;
      continue;
    }
    break;
  }
  return index;
}

function firstRunnerCommand(args: string[], startIndex: number): { command: string; args: string[] } | null {
  const index = skipRunnerOptions(args, startIndex);
  if (!args[index]) return null;
  return { command: args[index], args: args.slice(index + 1) };
}

function findRunnerSubcommand(args: string[], subcommands: Set<string>): number | null {
  let index = 0;
  while (index < args.length) {
    index = skipRunnerOptions(args, index);
    const arg = args[index];
    if (!arg) return null;
    if (subcommands.has(arg)) return index;
    if (arg.startsWith('-')) {
      index++;
      continue;
    }
    return null;
  }
  return null;
}

function isPackageRunnerInlineEval(command: string, args: string[]): boolean {
  const base = commandBasename(command).toLowerCase();

  if (base === 'npx' || base === 'bunx') {
    const target = firstRunnerCommand(args, 0);
    return target ? isInlineEvalCommand(target.command, target.args) || isPackageRunnerInlineEval(target.command, target.args) : false;
  }

  if (base === 'pnpm') {
    const subcommand = findRunnerSubcommand(args, new Set(['exec', 'dlx']));
    const target = subcommand === null ? null : firstRunnerCommand(args, subcommand + 1);
    return target ? isInlineEvalCommand(target.command, target.args) || isPackageRunnerInlineEval(target.command, target.args) : false;
  }

  if (base === 'npm') {
    const subcommand = findRunnerSubcommand(args, new Set(['exec']));
    const target = subcommand === null ? null : firstRunnerCommand(args, subcommand + 1);
    return target ? isInlineEvalCommand(target.command, target.args) || isPackageRunnerInlineEval(target.command, target.args) : false;
  }

  if (base === 'yarn') {
    const subcommand = findRunnerSubcommand(args, new Set(['dlx', 'exec']));
    const target = subcommand === null ? firstRunnerCommand(args, 0) : firstRunnerCommand(args, subcommand + 1);
    return target ? isInlineEvalCommand(target.command, target.args) || isPackageRunnerInlineEval(target.command, target.args) : false;
  }

  if (base === 'corepack') {
    const target = firstRunnerCommand(args, 0);
    return target ? isPackageRunnerInlineEval(target.command, target.args) || isInlineEvalCommand(target.command, target.args) : false;
  }

  return false;
}

function hasInlineEvalEnvAssignment(execution: ShellExecution): boolean {
  const env = execution.envAssignments || {};
  if (/(?:^|\s)(?:--require|-r\b|--import|--loader|--experimental-loader|--eval|--print)(?:\b|=|\s)/.test(env.NODE_OPTIONS || '')) return true;
  if (env.PYTHONSTARTUP || env.PYTHONINSPECT) return true;
  if (/\B-r|\B-e|--enable/.test(env.RUBYOPT || '')) return true;
  if (env.PERL5OPT) return true;
  return false;
}

function isInterpreterCommand(command: string): boolean {
  const base = commandBasename(command).toLowerCase();
  return isNodeCommand(base) ||
    isPythonCommand(base) ||
    ['ruby', 'perl', 'deno', 'bun', 'php', 'osascript', 'tsx', 'ts-node', 'ts-node-esm', 'zx'].includes(base) ||
    /^(?:lua|lua\d+(?:\.\d+)?)$/.test(base) ||
    /^(?:r|rscript)$/i.test(base);
}

function hasStdinArg(args: string[]): boolean {
  return args.some(arg => arg === '-' || arg === '/dev/stdin');
}

const SCRIPT_VALUE_FLAGS = new Set([
  '-e',
  '-p',
  '-r',
  '-c',
  '-m',
  '--eval',
  '--print',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
]);

function hasScriptFileArg(execution: ShellExecution): boolean {
  const base = commandBasename(execution.command).toLowerCase();
  const args = unseparatedArgs(execution.args || []);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg || arg === '-' || arg === '/dev/stdin') return false;
    if (arg === '--') continue;
    if (arg === '-m' && isPythonCommand(base)) {
      const moduleName = args[i + 1];
      return Boolean(moduleName && !PYTHON_INLINE_MODULES.has(moduleName.toLowerCase()));
    }
    const flagName = arg.split('=', 1)[0];
    if (SCRIPT_VALUE_FLAGS.has(arg) || SCRIPT_VALUE_FLAGS.has(flagName)) {
      i += arg.includes('=') ? 0 : 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return true;
  }
  return false;
}

function commandPipesIntoExecution(command: string, execution: ShellExecution): boolean {
  const sub = execution.subCommand.trim();
  return sub.length > 0 && (command.includes(`| ${sub}`) || command.includes(`|\t${sub}`) || command.includes(`|${sub}`));
}

function commandRedirectsIntoExecution(command: string, execution: ShellExecution): boolean {
  const index = command.indexOf(execution.subCommand.trim());
  if (index < 0) return false;
  const after = command.slice(index + execution.subCommand.trim().length);
  return /^\s*(?:<<|<\(|<\s*\/dev\/stdin\b)/.test(after);
}

function isInlineStdinExecution(command: string, execution: ShellExecution): boolean {
  if (!isInterpreterCommand(execution.command)) return false;
  if (hasStdinArg(execution.args)) return true;
  if (hasScriptFileArg(execution)) return false;
  return commandPipesIntoExecution(command, execution) || commandRedirectsIntoExecution(command, execution);
}

function commandHasInterpreterInputRedirect(command: string): boolean {
  const interpreter = String.raw`(?:node(?:js|\d+)?|(?:python|pypy)\d*(?:\.\d+)?|ruby|perl|deno|bun|php|osascript|tsx|ts-node|ts-node-esm|zx|lua\d*(?:\.\d+)?|R|Rscript)`;
  return new RegExp(String.raw`\b${interpreter}\b[^;&|]*(?:<<|<\(|<\s*/dev/stdin\b)`, 'i').test(command);
}

export function isInlineEvalExecution(execution: ShellExecution): boolean {
  const command = commandBasename(execution.command);
  const args = execution.args;

  return hasInlineEvalEnvAssignment(execution) || isInlineEvalCommand(command, args) || isPackageRunnerInlineEval(command, args);
}

export function findInlineEvalInvocation(command: string): ShellExecution | null {
  const commandStream = stripHeredocBodies(command);
  const executions = collectShellCommandExecutions(commandStream);
  const redirectExecution = commandHasInterpreterInputRedirect(commandStream)
    ? executions.find(execution => isInterpreterCommand(execution.command) && !hasScriptFileArg(execution))
    : null;
  return executions.find(isInlineEvalExecution) || executions.find(execution => isInlineStdinExecution(commandStream, execution)) || redirectExecution || null;
}

export function hasInlineEvalInvocation(command: string): boolean {
  return findInlineEvalInvocation(command) !== null;
}
