/**
 * Deep Command Inspector — Recursive inner-command parser.
 * Extracts commands hidden inside bash -c, python3 -c, node -e, etc.
 * and inspects them against deny patterns.
 */

import type { DeepInspectResult, RiskLevel } from './types.js';

const MAX_DEPTH = 3;

// Layer A: Always-safe commands
const ALWAYS_SAFE: RegExp[] = [
  /^ls(\s|$)/, /^cat\s/, /^head\s/, /^tail\s/, /^wc\s/,
  /^echo\s/, /^printf\s/, /^pwd$/, /^whoami$/, /^date$/,
  /^git\s+(status|log|diff|branch|show|remote|tag|describe|rev-parse|ls-files)\b/,
  /^npm\s+(list|ls|view|info|outdated|audit|pack|run\s+(lint|test|build|check|format|typecheck))\b/,
  /^npx\s/, /^node\s+(--version|-p\s)/, /^tsc(\s|$)/, /^eslint\s/, /^prettier\s/,
  /^jest(\s|$)/, /^vitest(\s|$)/, /^cargo\s+(build|test|check|clippy|fmt|doc)\b/,
  /^go\s+(build|test|vet|fmt|mod)\b/, /^make(\s|$)/, /^cmake\s/,
  /^grep\s/, /^rg\s/, /^find\s/, /^sort\s/, /^uniq\s/, /^cut\s/, /^tr\s/,
  /^sed\s/, /^awk\s/, /^diff\s/, /^md5sum\s/, /^sha256sum\s/,
  /^stat\s/, /^file\s/, /^which\s/, /^type\s/, /^env$/, /^uname(\s|$)/,
  /^df(\s|$)/, /^du\s/, /^free(\s|$)/, /^curl\s.*(-I|--head)\b/,
];

function unquote(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length < 2) return trimmed;
  if ((trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') ||
      (trimmed[0] === "'" && trimmed[trimmed.length - 1] === "'")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("$'") && trimmed.endsWith("'")) {
    return trimmed.slice(2, -1);
  }
  return trimmed;
}

// Layer B: Shell runtime wrappers
const SHELL_WRAPPERS: Array<{ pattern: RegExp; lang: string; extractor: (m: RegExpMatchArray) => string }> = [
  { pattern: /^(?:bash|sh|zsh|dash|ksh)\s+-c\s+(.+)$/s, lang: 'bash', extractor: (m) => unquote(m[1]) },
  { pattern: /^(?:python3?|python3\.\d+)\s+-c\s+(.+)$/s, lang: 'python', extractor: (m) => unquote(m[1]) },
  { pattern: /^node\s+(?:(?:--input-type=\S+|--no-warnings|--experimental-\S+)\s+)*(?:-e|--eval)\s+(.+)$/s, lang: 'node', extractor: (m) => unquote(m[1]) },
  { pattern: /^ruby\s+-e\s+(.+)$/s, lang: 'ruby', extractor: (m) => unquote(m[1]) },
  { pattern: /^perl\s+-e\s+(.+)$/s, lang: 'perl', extractor: (m) => unquote(m[1]) },
  { pattern: /^env\s+(?:\S+=\S+\s+)*(?:bash|sh|zsh)\s+-c\s+(.+)$/s, lang: 'bash', extractor: (m) => unquote(m[1]) },
];

// Layer C: Pipe-to-shell
const PIPE_TO_SHELL = /\|\s*(?:bash|sh|zsh|python3?|node|ruby|perl)(?:\s|$)/;

// Layer D: Process substitution
const PROCESS_SUB = /(?:source|\.)\s+<\(|bash\s+<\s+<\(/;

// Layer E: Variable expansion (two-phase)
const VAR_ASSIGNMENT = /(?:^|\s|;)(\w+)=(["']?)([^"';\s]*)\2/g;
const DANGEROUS_CMD_NAMES = new Set(['rm', 'dd', 'mkfs', 'shred', 'chmod', 'chown', 'kill', 'reboot', 'shutdown', 'poweroff', 'halt']);

// Layer F: Eval
const EVAL_PATTERNS = [/\beval\s+/, /\beval\s+"?\$\(/, /\beval\s+`/];

// Layer G: xargs destructive
const XARGS_DANGEROUS = /\|\s*xargs\s+(?:-[^\s]*\s+)*(?:rm|chmod|chown|mv|dd|mkfs|shred)\b/;

// Layer H: Obfuscation
const OBFUSCATION: RegExp[] = [
  /\/(?:usr\/)?(?:s?bin|local\/bin)\/(?:rm|dd|mkfs|shred|chmod|chown|kill|reboot|shutdown)\b/,
  /\\r\\m\s/, /\\x72\\x6d\s/,
  /\$'\\x[0-9a-fA-F]+'/,
  /\bcommand\s+(?:-v\s+)?(?:rm|dd|mkfs|shred)\b/,
  /\bbuiltin\s+(?:rm|dd|mkfs|shred)\b/,
];

// Bash-level dangerous patterns
const BASH_DANGEROUS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive\s+--force|-rf|-fr)\b/,
  /\brm\s+-rf\s+\/\s*$/,
  /\bmkfs\b/, /\bdd\s+if=/, /\bshred\b/,
  /\b(?:reboot|shutdown|poweroff|halt)\b/,
  /\bcurl\s[^|]*\|\s*(?:bash|sh)\b/, /\bwget\s[^|]*\|\s*(?:bash|sh)\b/,
  /\bchmod\s+777\s/, /\bchmod\s+-R\s/,
  /\bsudo\s+rm\b/, /\bsudo\s+dd\b/, /\bsudo\s+mkfs\b/,
  />\s*\/dev\/sd[a-z]/, />\s*\/dev\/nvme/,
  /\bkillall\b/, /\bpkill\s+-9\b/,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;?\s*:/, // fork bomb
  /\bbash\s+-i\s+>&?\s*\/dev\/tcp/, // reverse shell via /dev/tcp
  /\bnc\s+-e\b/, // reverse shell via netcat
];

// Language-specific dangerous patterns
// NOTE: These regexes DETECT dangerous patterns in code strings.
// They do not invoke any dangerous operations themselves.
const PYTHON_DANGEROUS: RegExp[] = [
  /\bsubprocess\.(?:call|run|Popen|check_output|check_call)\b/,
  /\bos\.system\s*\(/, /\b__import__\s*\(\s*['"](?:os|subprocess|shutil)['"]/,
  /\bexec\s*\(/, /\beval\s*\(/,
];

const NODE_DANGEROUS: RegExp[] = [
  /\bchild_process\.(?:exec|execSync|spawn|spawnSync)\b/,
  /\brequire\s*\(\s*['"]child_process['"]\)/,
  /\brequire\s*\(\s*['"]child_['"].*['"]process['"]\)/, // string concatenation evasion
  /\.exec\s*\(/, // generic exec call on any object
];

const RUBY_DANGEROUS: RegExp[] = [
  /\bFile\.(?:delete|unlink)\b/, /\bFileUtils\.(?:rm_rf|rm_r|rm|remove)\b/,
  /\bsystem\s*\(/, /`[^`]+`/, /\bexec\s*\(/, /\bIO\.popen\b/,
];

const PERL_DANGEROUS: RegExp[] = [
  /\bunlink\b/, /\brmdir\b/, /\bsystem\s*\(/, /\bexec\s*\(/,
  /\bqx\s*[{(\[\/]/,
];

const LANG_PATTERNS: Record<string, RegExp[]> = {
  python: PYTHON_DANGEROUS,
  node: NODE_DANGEROUS,
  ruby: RUBY_DANGEROUS,
  perl: PERL_DANGEROUS,
};

const NODE_FS_MUTATION_CALL = /\bfs(?:\.promises)?\.(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|unlinkSync|unlink|rmSync|rm|rmdirSync|rmdir|renameSync|rename)\s*\(([^)]*)\)/g;
const PYTHON_OS_MUTATION_CALL = /\bos\.(remove|unlink|rmdir|removedirs|rename)\s*\(([^)]*)\)/g;
const PYTHON_SHUTIL_MUTATION_CALL = /\bshutil\.(rmtree|move)\s*\(([^)]*)\)/g;
const PYTHON_OPEN_CALL = /\bopen\s*\(([^)]*)\)/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseStaticStringConcat(expression: string): string | null {
  let rest = expression.trim();
  if (!rest) return null;
  let value = '';

  while (rest) {
    const quote = rest[0];
    if (quote !== '"' && quote !== "'") return null;
    let escaped = false;
    let piece = '';
    let end = -1;
    for (let i = 1; i < rest.length; i++) {
      const ch = rest[i];
      if (escaped) {
        piece += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        end = i;
        break;
      }
      piece += ch;
    }
    if (end < 0) return null;
    value += piece;
    rest = rest.slice(end + 1).trim();
    if (!rest) return value;
    if (!rest.startsWith('+')) return null;
    rest = rest.slice(1).trim();
  }

  return value;
}

function canonicalNodeFilesystemModule(expression: string): string | null {
  const value = parseStaticStringConcat(expression);
  if (value === 'fs' || value === 'node:fs') return 'fs';
  if (value === 'fs/promises' || value === 'node:fs/promises') return 'fs.promises';
  return null;
}

function canonicalPythonFilesystemModule(expression: string): string | null {
  const value = parseStaticStringConcat(expression);
  if (value === 'os' || value === 'shutil') return value;
  return null;
}

function canonicalPythonFilesystemFactory(expression: string, importlibAliases: string[] = []): string | null {
  const trimmed = expression.trim();
  const factoryPatterns = [
    /^\b__import__\s*\(\s*([^)]*?)\s*\)$/,
    /^\bimportlib\.import_module\s*\(\s*([^)]*?)\s*\)$/,
  ];
  for (const pattern of factoryPatterns) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    return canonicalPythonFilesystemModule(match[1]);
  }
  for (const alias of importlibAliases) {
    const escaped = escapeRegExp(alias);
    const match = trimmed.match(new RegExp(`^\\b${escaped}\\.import_module\\s*\\(\\s*([^)]*?)\\s*\\)$`));
    if (!match) continue;
    return canonicalPythonFilesystemModule(match[1]);
  }
  return null;
}

function canonicalNodeFilesystemFactory(expression: string): string | null {
  const trimmed = expression.trim();
  const factoryPatterns = [
    /^\brequire\s*\(\s*([^)]*?)\s*\)$/,
    /^\bprocess\.getBuiltinModule\s*\(\s*([^)]*?)\s*\)$/,
    /^\bprocess\.binding\s*\(\s*([^)]*?)\s*\)$/,
    /^\bmodule\.constructor\._load\s*\(\s*([^)]*?)\s*\)$/,
    /^\bcreateRequire\s*\([^)]*\)\s*\(\s*([^)]*?)\s*\)$/,
    /^\(?\s*await\s+import\s*\(\s*([^)]*?)\s*\)\s*\)?$/,
  ];
  for (const pattern of factoryPatterns) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    return canonicalNodeFilesystemModule(match[1]);
  }
  return null;
}

function replaceObjectAlias(code: string, alias: string, canonical: string): string {
  const escaped = escapeRegExp(alias);
  return code
    .replace(new RegExp(`(^|[^\\w$])${escaped}\\s*\\.`, 'g'), `$1${canonical}.`)
    .replace(new RegExp(`(^|[^\\w$])${escaped}\\s*\\[\\s*(['"])(${JS_IDENT})\\2\\s*\\]`, 'g'), `$1${canonical}.$3`);
}

function replaceCallAlias(code: string, alias: string, canonical: string): string {
  const escaped = escapeRegExp(alias);
  return code.replace(new RegExp(`(^|[^\\w$.])${escaped}\\s*\\(`, 'g'), `$1${canonical}(`);
}

const JS_IDENT = '[A-Za-z_$][\\w$]*';
const PY_IDENT = '[A-Za-z_]\\w*';

function replaceFactoryAccess(
  code: string,
  calleePattern: string,
  canonicalize: (expression: string) => string | null,
): string {
  let normalized = code.replace(new RegExp(`${calleePattern}\\s*\\(\\s*([^)]*?)\\s*\\)\\s*\\.`, 'g'), (match, spec: string) => {
    const canonical = canonicalize(spec);
    return canonical ? `${canonical}.` : match;
  });
  normalized = normalized.replace(new RegExp(`${calleePattern}\\s*\\(\\s*([^)]*?)\\s*\\)\\s*\\[\\s*(['"])(${JS_IDENT})\\2\\s*\\]`, 'g'), (match, spec: string, _quote: string, member: string) => {
    const canonical = canonicalize(spec);
    return canonical ? `${canonical}.${member}` : match;
  });
  return normalized;
}

function replaceNamedFactoryAccess(
  code: string,
  factoryName: string,
  canonicalize: (expression: string) => string | null,
): string {
  const escaped = escapeRegExp(factoryName);
  let normalized = code.replace(new RegExp(`(^|[^\\w$.])${escaped}\\s*\\(\\s*([^)]*?)\\s*\\)\\s*\\.`, 'g'), (match, prefix: string, spec: string) => {
    const canonical = canonicalize(spec);
    return canonical ? `${prefix}${canonical}.` : match;
  });
  normalized = normalized.replace(new RegExp(`(^|[^\\w$.])${escaped}\\s*\\(\\s*([^)]*?)\\s*\\)\\s*\\[\\s*(['"])(${JS_IDENT})\\3\\s*\\]`, 'g'), (match, prefix: string, spec: string, _quote: string, member: string) => {
    const canonical = canonicalize(spec);
    return canonical ? `${prefix}${canonical}.${member}` : match;
  });
  return normalized;
}

function replaceAwaitImportAccess(code: string): string {
  let normalized = code.replace(/\(\s*await\s+import\s*\(\s*([^)]*?)\s*\)\s*\)\s*\./g, (match, spec: string) => {
    const canonical = canonicalNodeFilesystemModule(spec);
    return canonical ? `${canonical}.` : match;
  });
  normalized = normalized.replace(new RegExp(`\\(\\s*await\\s+import\\s*\\(\\s*([^)]*?)\\s*\\)\\s*\\)\\s*\\[\\s*(['"])(${JS_IDENT})\\2\\s*\\]`, 'g'), (match, spec: string, _quote: string, member: string) => {
    const canonical = canonicalNodeFilesystemModule(spec);
    return canonical ? `${canonical}.${member}` : match;
  });
  return normalized;
}

function replaceRequireCacheExportsAccess(code: string): string {
  let normalized = code.replace(/\brequire\.cache\s*\[\s*require\.resolve\s*\(\s*([^)]*?)\s*\)\s*\]\s*\??\.\s*exports\s*\./g, (match, spec: string) => {
    const canonical = canonicalNodeFilesystemModule(spec);
    return canonical ? `${canonical}.` : match;
  });
  normalized = normalized.replace(new RegExp(`\\brequire\\.cache\\s*\\[\\s*require\\.resolve\\s*\\(\\s*([^)]*?)\\s*\\)\\s*\\]\\s*\\??\\.\\s*exports\\s*\\[\\s*(['"])(${JS_IDENT})\\2\\s*\\]`, 'g'), (match, spec: string, _quote: string, member: string) => {
    const canonical = canonicalNodeFilesystemModule(spec);
    return canonical ? `${canonical}.${member}` : match;
  });
  return normalized;
}

function normalizeCanonicalBracketAccess(code: string): string {
  return code.replace(new RegExp(`\\b(fs(?:\\.promises)?|os|shutil)\\s*\\[\\s*(['"])(${JS_IDENT})\\2\\s*\\]`, 'g'), '$1.$3');
}

function normalizeInlineFilesystemAliases(code: string): string {
  let normalized = code;
  const objectAliases: Array<{ alias: string; canonical: string }> = [];
  const callAliases: Array<{ alias: string; canonical: string }> = [];
  const requireFactoryAliases: string[] = [];
  const importlibModuleAliases: string[] = [];
  const importlibFactoryAliases: string[] = [];

  for (const match of normalized.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(${JS_IDENT})\\s*=\\s*([^;\\n]+)`, 'g'))) {
    const rhs = match[2].trim();
    const canonical = canonicalNodeFilesystemFactory(rhs);
    if (canonical) {
      objectAliases.push({ alias: match[1], canonical });
    } else if (/^createRequire\s*\(/.test(rhs)) {
      requireFactoryAliases.push(match[1]);
    }
  }

  for (const match of normalized.matchAll(new RegExp(`\\b(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*([^;\\n]+)`, 'g'))) {
    const canonicalRoot = canonicalNodeFilesystemFactory(match[2]);
    if (!canonicalRoot) continue;
    for (const rawPart of match[1].split(',')) {
      const part = rawPart.trim();
      const binding = part.match(new RegExp(`^(${JS_IDENT})(?:\\s*:\\s*(${JS_IDENT}))?$`));
      if (!binding) continue;
      const imported = binding[1];
      const local = binding[2] || imported;
      if (canonicalRoot === 'fs' && imported === 'promises') {
        objectAliases.push({ alias: local, canonical: 'fs.promises' });
      } else {
        callAliases.push({ alias: local, canonical: `${canonicalRoot}.${imported}` });
      }
    }
  }

  for (const match of normalized.matchAll(new RegExp(`\\bimport\\s+(${JS_IDENT})\\s+from\\s+((?:['"][^'"]*['"]))`, 'g'))) {
    const canonical = canonicalNodeFilesystemModule(match[2]);
    if (canonical) objectAliases.push({ alias: match[1], canonical });
  }
  for (const match of normalized.matchAll(new RegExp(`\\bimport\\s+\\*\\s+as\\s+(${JS_IDENT})\\s+from\\s+((?:['"][^'"]*['"]))`, 'g'))) {
    const canonical = canonicalNodeFilesystemModule(match[2]);
    if (canonical) objectAliases.push({ alias: match[1], canonical });
  }
  for (const match of normalized.matchAll(new RegExp(`\\bimport\\s*\\{([^}]+)\\}\\s*from\\s+((?:['"][^'"]*['"]))`, 'g'))) {
    const canonicalRoot = canonicalNodeFilesystemModule(match[2]);
    if (!canonicalRoot) continue;
    for (const rawPart of match[1].split(',')) {
      const part = rawPart.trim();
      const binding = part.match(new RegExp(`^(${JS_IDENT})(?:\\s+as\\s+(${JS_IDENT}))?$`));
      if (!binding) continue;
      const imported = binding[1];
      const local = binding[2] || imported;
      if (canonicalRoot === 'fs' && imported === 'promises') {
        objectAliases.push({ alias: local, canonical: 'fs.promises' });
      } else {
        callAliases.push({ alias: local, canonical: `${canonicalRoot}.${imported}` });
      }
    }
  }

  normalized = replaceFactoryAccess(normalized, '\\brequire', canonicalNodeFilesystemModule);
  normalized = replaceFactoryAccess(normalized, '\\bprocess\\.getBuiltinModule', canonicalNodeFilesystemModule);
  normalized = replaceFactoryAccess(normalized, '\\bprocess\\.binding', canonicalNodeFilesystemModule);
  normalized = replaceFactoryAccess(normalized, '\\bmodule\\.constructor\\._load', canonicalNodeFilesystemModule);
  normalized = replaceFactoryAccess(normalized, '\\bcreateRequire\\s*\\([^)]*\\)', canonicalNodeFilesystemModule);
  normalized = replaceAwaitImportAccess(normalized);
  normalized = replaceRequireCacheExportsAccess(normalized);
  normalized = replaceFactoryAccess(normalized, '\\b__import__', canonicalPythonFilesystemModule);
  normalized = replaceFactoryAccess(normalized, '\\bimportlib\\.import_module', canonicalPythonFilesystemModule);

  for (const alias of requireFactoryAliases) {
    normalized = replaceNamedFactoryAccess(normalized, alias, canonicalNodeFilesystemModule);
    const escaped = escapeRegExp(alias);
    for (const match of normalized.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(${JS_IDENT})\\s*=\\s*${escaped}\\s*\\(\\s*([^)]*?)\\s*\\)`, 'g'))) {
      const canonical = canonicalNodeFilesystemModule(match[2]);
      if (canonical) objectAliases.push({ alias: match[1], canonical });
    }
  }

  for (const match of normalized.matchAll(new RegExp(`\\bimport\\s+(os|shutil)\\s+as\\s+(${PY_IDENT})`, 'g'))) {
    objectAliases.push({ alias: match[2], canonical: match[1] });
  }
  for (const match of normalized.matchAll(new RegExp(`\\bimport\\s+importlib\\s+as\\s+(${PY_IDENT})`, 'g'))) {
    importlibModuleAliases.push(match[1]);
  }

  for (const match of normalized.matchAll(new RegExp(`\\bfrom\\s+(os|shutil)\\s+import\\s+([^;\\n]+)`, 'g'))) {
    const moduleName = match[1];
    for (const rawPart of match[2].split(',')) {
      const part = rawPart.trim();
      const binding = part.match(new RegExp(`^(${PY_IDENT})(?:\\s+as\\s+(${PY_IDENT}))?$`));
      if (!binding) continue;
      const imported = binding[1];
      const local = binding[2] || imported;
      callAliases.push({ alias: local, canonical: `${moduleName}.${imported}` });
    }
  }
  for (const match of normalized.matchAll(new RegExp(`\\bfrom\\s+importlib\\s+import\\s+([^;\\n]+)`, 'g'))) {
    for (const rawPart of match[1].split(',')) {
      const part = rawPart.trim();
      const binding = part.match(new RegExp(`^(import_module)(?:\\s+as\\s+(${PY_IDENT}))?$`));
      if (!binding) continue;
      importlibFactoryAliases.push(binding[2] || binding[1]);
    }
  }

  for (const alias of importlibFactoryAliases) {
    normalized = replaceNamedFactoryAccess(normalized, `${alias}`, canonicalPythonFilesystemModule);
  }
  for (const alias of importlibModuleAliases) {
    normalized = replaceFactoryAccess(normalized, `\\b${escapeRegExp(alias)}\\.import_module`, canonicalPythonFilesystemModule);
  }

  for (const { alias, canonical } of objectAliases) {
    normalized = replaceObjectAlias(normalized, alias, canonical);
  }

  for (const match of normalized.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(${JS_IDENT})\\s*=\\s*(fs(?:\\.promises)?)\\.(${JS_IDENT})`, 'g'))) {
    callAliases.push({ alias: match[1], canonical: `${match[2]}.${match[3]}` });
  }
  for (const match of normalized.matchAll(new RegExp(`(?:^|[;\\n])\\s*(${PY_IDENT})\\s*=\\s*([^;\\n]+)`, 'g'))) {
    const canonical = canonicalPythonFilesystemFactory(match[2], importlibModuleAliases);
    if (canonical) objectAliases.push({ alias: match[1], canonical });
  }
  for (const { alias, canonical } of objectAliases) {
    normalized = replaceObjectAlias(normalized, alias, canonical);
  }
  for (const match of normalized.matchAll(new RegExp(`(?:^|[;\\n])\\s*(${PY_IDENT})\\s*=\\s*(os|shutil)\\.(${PY_IDENT})`, 'g'))) {
    callAliases.push({ alias: match[1], canonical: `${match[2]}.${match[3]}` });
  }

  for (const { alias, canonical } of callAliases) {
    normalized = replaceCallAlias(normalized, alias, canonical);
  }

  return normalizeCanonicalBracketAccess(normalized);
}

function leadingStringLiteral(value: string): { matched: boolean; end: number } {
  const trimmed = value.trimStart();
  const leadingWhitespace = value.length - trimmed.length;
  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'") return { matched: false, end: 0 };
  let escaped = false;
  for (let i = 1; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === quote) {
      return { matched: true, end: leadingWhitespace + i + 1 };
    }
  }
  return { matched: false, end: 0 };
}

function literalArgAt(value: string, index: number): boolean {
  let rest = value;
  for (let i = 0; i <= index; i++) {
    const literal = leadingStringLiteral(rest);
    if (!literal.matched) return false;
    if (i === index) return true;
    rest = rest.slice(literal.end).trimStart();
    if (!rest.startsWith(',')) return false;
    rest = rest.slice(1);
  }
  return false;
}

function writeModeLiteral(value: string): boolean {
  const restStart = value.indexOf(',');
  if (restStart < 0) return false;
  const rest = value.slice(restStart + 1).trimStart();
  const literal = leadingStringLiteral(rest);
  if (!literal.matched) return false;
  const mode = rest.slice(0, literal.end);
  return /[wax+]/.test(mode);
}

function inspectNodeFilesystemMutation(inner: string): DeepInspectResult | null {
  let matched = false;
  const normalized = normalizeInlineFilesystemAliases(inner);
  for (const match of normalized.matchAll(NODE_FS_MUTATION_CALL)) {
    matched = true;
    const operation = match[1];
    const args = match[2] || '';
    const requiresTwoLiteralTargets = operation === 'rename' || operation === 'renameSync';
    const hasLiteralTargets = requiresTwoLiteralTargets
      ? literalArgAt(args, 0) && literalArgAt(args, 1)
      : literalArgAt(args, 0);
    if (!hasLiteralTargets) {
      return block('Node filesystem mutation has dynamic or non-literal target', 'node-filesystem-dynamic', 'critical', [inner]);
    }
  }
  return matched ? ok([inner]) : null;
}

function inspectPythonFilesystemMutation(inner: string): DeepInspectResult | null {
  let matched = false;
  const normalized = normalizeInlineFilesystemAliases(inner);

  for (const match of normalized.matchAll(PYTHON_OPEN_CALL)) {
    const args = match[1] || '';
    if (!writeModeLiteral(args)) continue;
    matched = true;
    if (!literalArgAt(args, 0)) {
      return block('Python file write has dynamic or non-literal target', 'python-filesystem-dynamic', 'critical', [inner]);
    }
  }

  for (const match of normalized.matchAll(PYTHON_OS_MUTATION_CALL)) {
    matched = true;
    const operation = match[1];
    const args = match[2] || '';
    const requiresTwoLiteralTargets = operation === 'rename';
    const hasLiteralTargets = requiresTwoLiteralTargets
      ? literalArgAt(args, 0) && literalArgAt(args, 1)
      : literalArgAt(args, 0);
    if (!hasLiteralTargets) {
      return block('Python os mutation has dynamic or non-literal target', 'python-filesystem-dynamic', 'critical', [inner]);
    }
  }

  for (const match of normalized.matchAll(PYTHON_SHUTIL_MUTATION_CALL)) {
    matched = true;
    const operation = match[1];
    const args = match[2] || '';
    const requiresTwoLiteralTargets = operation === 'move';
    const hasLiteralTargets = requiresTwoLiteralTargets
      ? literalArgAt(args, 0) && literalArgAt(args, 1)
      : literalArgAt(args, 0);
    if (!hasLiteralTargets) {
      return block('Python shutil mutation has dynamic or non-literal target', 'python-filesystem-dynamic', 'critical', [inner]);
    }
  }

  return matched ? ok([inner]) : null;
}

// Layer A2: AWK/SED dangerous patterns (must run before ALWAYS_SAFE)
const AWK_DANGEROUS: RegExp[] = [
  /\bawk\b.*\bsystem\s*\(/, // awk with system() call
  /\bawk\b.*\bgetline\b/, // awk with getline (can read files)
  /\bawk\b.*\"|.*\bpipe\b/, // awk piping to commands
];

const SED_DANGEROUS: RegExp[] = [
  /\bsed\b.*\/e['"]?\s/, // sed with /e execute flag (trailing space variant)
  /\bsed\b.*\/e['"]?\s*$/, // sed with /e execute flag (end of string)
  /\bsed\b.*'[^']*\/e'/, // sed with /e inside single-quoted expression
  /\bsed\b.*"[^"]*\/e"/, // sed with /e inside double-quoted expression
];

// Layer A3: Network exfiltration / attack tools
const NETWORK_ATTACK_TOOLS: RegExp[] = [
  /\bscp\b.*@/, // scp to a remote host
  /\brsync\b.*@/, // rsync to a remote host
  /\bsftp\b.*@/, // sftp to a remote host
  /\bnc\s+-e\b/, // netcat reverse shell (also in BASH_DANGEROUS)
  /\btftp\b/, // trivial FTP
];

function matchFirst(cmd: string, patterns: RegExp[]): RegExp | null {
  for (const p of patterns) {
    if (p.test(cmd)) return p;
  }
  return null;
}

function ok(extractedCommands: string[] = [], depth: number = 0): DeepInspectResult {
  return { blocked: false, escalate: false, reason: '', technique: '', extractedCommands, riskLevel: 'none', depth };
}

function block(reason: string, technique: string, riskLevel: RiskLevel, extractedCommands: string[] = [], depth: number = 0): DeepInspectResult {
  return { blocked: true, escalate: true, reason, technique, extractedCommands, riskLevel, depth };
}

export function deepInspect(command: string, depth: number = 0): DeepInspectResult {
  if (depth > MAX_DEPTH) {
    return block('Max recursion depth exceeded — possible evasion attempt', 'recursion-limit', 'high', [], depth);
  }

  const cmd = command.trim();
  if (!cmd) return ok([], depth);

  // Layer C: Pipe-to-shell (must run before ALWAYS_SAFE to catch e.g. `curl ... | bash`)
  if (PIPE_TO_SHELL.test(cmd)) {
    return block('Command pipes output to shell interpreter', 'pipe-to-shell', 'high', [cmd], depth);
  }

  // Layer G: xargs destructive (must run before ALWAYS_SAFE to catch e.g. `find . | xargs rm`)
  if (XARGS_DANGEROUS.test(cmd)) {
    return block('Dangerous command via xargs', 'xargs-destructive', 'critical', [cmd], depth);
  }

  // Layer A2: AWK/SED dangerous patterns (before ALWAYS_SAFE to catch dangerous variants)
  const awkMatch = matchFirst(cmd, AWK_DANGEROUS);
  if (awkMatch) return block(`Dangerous awk usage: ${awkMatch.source}`, 'awk-dangerous', 'critical', [cmd], depth);
  const sedMatch = matchFirst(cmd, SED_DANGEROUS);
  if (sedMatch) return block(`Dangerous sed usage: ${sedMatch.source}`, 'sed-dangerous', 'critical', [cmd], depth);

  // Layer A3: Network exfiltration tools (before ALWAYS_SAFE)
  const netMatch = matchFirst(cmd, NETWORK_ATTACK_TOOLS);
  if (netMatch) return block(`Network attack/exfiltration tool: ${netMatch.source}`, 'network-attack', 'critical', [cmd], depth);

  // Layer A: Always-safe short-circuit
  if (matchFirst(cmd, ALWAYS_SAFE)) return ok([], depth);

  // Layer H: Obfuscation (check early)
  const obf = matchFirst(cmd, OBFUSCATION);
  if (obf) return block(`Obfuscated command detected: ${obf.source}`, 'obfuscation', 'critical', [cmd], depth);

  // Layer B: Shell runtime extraction + recursive inspection
  for (const wrapper of SHELL_WRAPPERS) {
    const m = cmd.match(wrapper.pattern);
    if (m) {
      const inner = wrapper.extractor(m);
      const extracted = [inner];

      // Recurse into extracted command (for bash wrappers)
      if (wrapper.lang === 'bash') {
        const innerResult = deepInspect(inner, depth + 1);
        if (innerResult.blocked) {
          return { ...innerResult, extractedCommands: [...extracted, ...innerResult.extractedCommands], depth };
        }
        extracted.push(...innerResult.extractedCommands);
      }

      if (wrapper.lang === 'node') {
        const fsResult = inspectNodeFilesystemMutation(inner);
        if (fsResult?.blocked) {
          return { ...fsResult, extractedCommands: [...extracted, ...fsResult.extractedCommands], depth };
        }
        if (fsResult) extracted.push(...fsResult.extractedCommands);
      }

      if (wrapper.lang === 'python') {
        const fsResult = inspectPythonFilesystemMutation(inner);
        if (fsResult?.blocked) {
          return { ...fsResult, extractedCommands: [...extracted, ...fsResult.extractedCommands], depth };
        }
        if (fsResult) extracted.push(...fsResult.extractedCommands);
      }

      // Check language-specific patterns
      const langPatterns = LANG_PATTERNS[wrapper.lang];
      if (langPatterns) {
        const langMatch = matchFirst(inner, langPatterns);
        if (langMatch) {
          return block(
            `Dangerous ${wrapper.lang} code detected: ${langMatch.source}`,
            `${wrapper.lang}-dangerous`, 'critical', extracted, depth
          );
        }
      }

      // Also check bash-level dangerous in inner command
      const bashMatch = matchFirst(inner, BASH_DANGEROUS);
      if (bashMatch) {
        return block(`Dangerous command in ${wrapper.lang} wrapper: ${bashMatch.source}`, 'shell-wrapper-dangerous', 'critical', extracted, depth);
      }

      return ok(extracted, depth);
    }
  }

  // Layer D: Process substitution
  if (PROCESS_SUB.test(cmd)) {
    return block('Process substitution detected', 'process-substitution', 'high', [cmd], depth);
  }

  // Layer E: Variable expansion (two-phase)
  const assignments = new Map<string, string>();
  let assignMatch: RegExpExecArray | null;
  const varRegex = new RegExp(VAR_ASSIGNMENT.source, VAR_ASSIGNMENT.flags);
  while ((assignMatch = varRegex.exec(cmd)) !== null) {
    assignments.set(assignMatch[1], assignMatch[3] || '');
  }
  if (assignments.size > 0) {
    for (const [varName, value] of assignments) {
      if (DANGEROUS_CMD_NAMES.has(value)) {
        const expansionRegex = new RegExp(`\\$\\{?${varName}\\}?`);
        if (expansionRegex.test(cmd)) {
          return block(`Variable expansion evasion: ${varName}=${value} then $${varName}`, 'variable-expansion', 'critical', [cmd], depth);
        }
      }
    }
  }

  // Layer F: Eval
  const evalMatch = matchFirst(cmd, EVAL_PATTERNS);
  if (evalMatch) {
    return block(`Eval-based command execution: ${evalMatch.source}`, 'eval', 'high', [cmd], depth);
  }

  // Check bash-level dangerous patterns
  const dangerous = matchFirst(cmd, BASH_DANGEROUS);
  if (dangerous) {
    return block(`Dangerous command: ${dangerous.source}`, 'bash-dangerous', 'critical', [cmd], depth);
  }

  return ok([], depth);
}

export function extractAllCommands(command: string): string[] {
  const commands: string[] = [];
  const cmd = command.trim();
  if (!cmd) return commands;

  for (const wrapper of SHELL_WRAPPERS) {
    const m = cmd.match(wrapper.pattern);
    if (m) {
      const inner = wrapper.extractor(m);
      commands.push(inner);
      commands.push(...extractAllCommands(inner));
      break;
    }
  }

  return commands;
}

export function classifyCommandRisk(command: string): RiskLevel {
  const cmd = command.trim();
  if (!cmd) return 'none';
  if (PIPE_TO_SHELL.test(cmd)) return 'high';
  if (XARGS_DANGEROUS.test(cmd)) return 'critical';
  if (matchFirst(cmd, ALWAYS_SAFE)) return 'none';
  if (matchFirst(cmd, BASH_DANGEROUS) || matchFirst(cmd, OBFUSCATION)) return 'critical';
  if (matchFirst(cmd, EVAL_PATTERNS) || PROCESS_SUB.test(cmd)) return 'high';
  for (const wrapper of SHELL_WRAPPERS) {
    if (wrapper.pattern.test(cmd)) return 'medium';
  }
  return 'low';
}

export default deepInspect;
