/**
 * AST Analyzer for Code Analysis
 *
 * Analyzes Abstract Syntax Trees for code understanding
 * and intelligent routing decisions.
 *
 * @module ast-analyzer
 */

import { Lang, kind, parse, type SgNode } from '@ast-grep/napi';

export interface ASTAnalyzerConfig {
  maxFileSize: number;
  languages: string[];
  includeComments: boolean;
  extractTypes: boolean;
  maxDepth: number;
}

export interface ASTNode {
  type: string;
  name: string;
  startLine: number;
  endLine: number;
  children: ASTNode[];
  metadata?: Record<string, unknown>;
}

export interface ASTAnalysis {
  filePath: string;
  language: string;
  root: ASTNode;
  functions: ASTNode[];
  classes: ASTNode[];
  imports: string[];
  exports: string[];
  complexity: {
    cyclomatic: number;
    cognitive: number;
    loc: number;
    commentDensity: number;
  };
  timestamp: number;
  durationMs: number;
}

interface AstGrepEntry {
  source: SgNode;
  ast: ASTNode;
}

const DEFAULT_CONFIG: ASTAnalyzerConfig = {
  maxFileSize: 1024 * 1024,
  languages: ['typescript', 'javascript', 'python', 'rust', 'go'],
  includeComments: true,
  extractTypes: true,
  maxDepth: 20,
};

const LANGUAGE_PATTERNS: Record<string, RegExp[]> = {
  typescript: [/\.tsx?$/, /^import\s+.*from\s+['"]/, /:\s*(string|number|boolean|void)/],
  javascript: [/\.jsx?$/, /^(const|let|var)\s+\w+\s*=/, /module\.exports/],
  python: [/\.py$/, /^(def|class|import|from)\s+/, /^#!/],
  rust: [/\.rs$/, /^(fn|struct|impl|use)\s+/, /^(pub\s+)?mod\s+/],
  go: [/\.go$/, /^package\s+/, /^func\s+/],
};

export class ASTAnalyzer {
  private config: ASTAnalyzerConfig;
  private ruvectorEngine: unknown = null;
  private useNative = false;
  private analysisCache: Map<string, ASTAnalysis> = new Map();

  constructor(config: Partial<ASTAnalyzerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async initialize(): Promise<void> {
    this.ruvectorEngine = null;
    this.useNative = false;
  }

  analyze(code: string, filePath: string = 'unknown'): ASTAnalysis {
    const startTime = performance.now();
    if (code.length > this.config.maxFileSize) {
      throw new Error(`File too large: ${code.length} bytes exceeds ${this.config.maxFileSize}`);
    }
    const cacheKey = this.getCacheKey(code, filePath);
    const cached = this.analysisCache.get(cacheKey);
    if (cached) return cached;
    const language = this.detectLanguage(code, filePath);
    const root = this.parseAST(code, language, filePath);
    const functions = this.extractFunctions(root);
    const classes = this.extractClasses(root);
    const imports = this.extractImports(code, language, filePath);
    const exports = this.extractExports(code, language, filePath);
    const complexity = this.calculateComplexity(code, root, language, filePath);
    const durationMs = performance.now() - startTime;
    const analysis: ASTAnalysis = {
      filePath, language, root, functions, classes, imports, exports,
      complexity, timestamp: Date.now(), durationMs,
    };
    this.analysisCache.set(cacheKey, analysis);
    return analysis;
  }

  getFunctionAtLine(analysis: ASTAnalysis, line: number): ASTNode | null {
    let best: ASTNode | null = null;
    for (const func of analysis.functions) {
      if (line >= func.startLine && line <= func.endLine) {
        if (!best || this.lineSpan(func) < this.lineSpan(best)) best = func;
      }
    }
    return best;
  }

  getClassAtLine(analysis: ASTAnalysis, line: number): ASTNode | null {
    let best: ASTNode | null = null;
    for (const cls of analysis.classes) {
      if (line >= cls.startLine && line <= cls.endLine) {
        if (!best || this.lineSpan(cls) < this.lineSpan(best)) best = cls;
      }
    }
    return best;
  }

  getSymbols(analysis: ASTAnalysis): string[] {
    const symbols: string[] = [];
    for (const func of analysis.functions) symbols.push(func.name);
    for (const cls of analysis.classes) symbols.push(cls.name);
    return symbols;
  }

  getStats(): Record<string, number> {
    return { cacheSize: this.analysisCache.size, useNative: this.useNative ? 1 : 0 };
  }

  clearCache(): void { this.analysisCache.clear(); }

  private lineSpan(node: ASTNode): number {
    return node.endLine - node.startLine;
  }

  private getCacheKey(code: string, filePath: string): string {
    let hash = 0;
    const str = filePath + code.substring(0, 1000);
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `ast_${hash}_${code.length}`;
  }

  private detectLanguage(code: string, filePath: string): string {
    for (const [lang, patterns] of Object.entries(LANGUAGE_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(filePath) || pattern.test(code)) return lang;
      }
    }
    return 'unknown';
  }

  private parseAST(code: string, language: string, filePath = 'unknown'): ASTNode {
    const astGrepRoot = this.parseAstGrepAst(code, language, filePath);
    if (astGrepRoot) return astGrepRoot;
    return this.parseHeuristicAst(code, language);
  }

  private parseAstGrepAst(code: string, language: string, filePath: string): ASTNode | null {
    const lang = this.getAstGrepLang(language, filePath);
    if (!lang) return null;

    const parsedRoot = this.parseAstGrepRoot(code, lang);
    if (!parsedRoot) return null;

    const root: ASTNode = {
      type: 'program',
      name: 'root',
      startLine: 1,
      endLine: this.lineCount(code),
      children: [],
      metadata: {
        parser: 'ast-grep',
        matchEngine: 'ast-grep-kind-fields',
        filePath,
        lang,
      },
    };

    const entries = this.collectAstGrepEntries(parsedRoot, lang);
    this.attachAstGrepEntries(root, entries);
    return root;
  }

  private collectAstGrepEntries(root: SgNode, lang: Lang): AstGrepEntry[] {
    const entries = new Map<number, AstGrepEntry>();
    const addEntry = (source: SgNode, ast: ASTNode): void => {
      entries.set(source.id(), { source, ast });
    };

    for (const node of this.findAllAstGrepKind(root, lang, 'class_declaration')) {
      const name = this.sgNodeName(node) ?? 'default';
      addEntry(node, {
        type: 'class',
        name,
        ...this.sgNodeLines(node),
        children: [],
        metadata: {
          extends: this.sgClassExtends(node, lang),
        },
      });
    }

    for (const node of this.findAllAstGrepKind(root, lang, 'function_declaration')) {
      const name = this.sgNodeName(node) ?? 'default';
      addEntry(node, this.createAstGrepFunctionNode(node, name));
    }

    for (const node of this.findAllAstGrepKind(root, lang, 'method_definition')) {
      const name = this.sgNodeName(node) ?? 'default';
      addEntry(node, this.createAstGrepFunctionNode(node, name));
    }

    for (const node of this.findAllAstGrepKind(root, lang, 'variable_declarator')) {
      const value = node.field('value');
      if (!value || !this.isFunctionLikeValue(value)) continue;
      const name = this.sgNodeName(node);
      if (!name) continue;
      addEntry(node, this.createAstGrepFunctionNode(node, name, value));
    }

    return [...entries.values()];
  }

  private createAstGrepFunctionNode(node: SgNode, name: string, parameterSource = node): ASTNode {
    return {
      type: 'function',
      name,
      ...this.sgNodeLines(node),
      children: [],
      metadata: {
        params: this.sgNodeParams(parameterSource),
      },
    };
  }

  private attachAstGrepEntries(root: ASTNode, entries: AstGrepEntry[]): void {
    const containingParent = (entry: AstGrepEntry): AstGrepEntry | null => {
      let best: AstGrepEntry | null = null;
      for (const candidate of entries) {
        if (candidate.source.id() === entry.source.id()) continue;
        if (!this.sgContains(candidate.source, entry.source)) continue;
        if (!best || this.sgRangeSpan(candidate.source) < this.sgRangeSpan(best.source)) {
          best = candidate;
        }
      }
      return best;
    };

    for (const entry of entries) {
      const parent = containingParent(entry);
      if (parent) parent.ast.children.push(entry.ast);
      else root.children.push(entry.ast);
    }

    this.sortAstChildren(root);
  }

  private sortAstChildren(node: ASTNode): void {
    node.children.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine || left.name.localeCompare(right.name));
    for (const child of node.children) this.sortAstChildren(child);
  }

  private parseHeuristicAst(code: string, language: string): ASTNode {
    const lines = code.split('\n');
    const root: ASTNode = { type: 'program', name: 'root', startLine: 1, endLine: lines.length, children: [] };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const funcMatch = this.matchFunction(line, language);
      if (funcMatch) {
        const funcNode: ASTNode = {
          type: 'function', name: funcMatch.name, startLine: lineNum,
          endLine: lineNum + this.findBlockEnd(lines, i), children: [],
          metadata: { params: funcMatch.params },
        };
        root.children.push(funcNode);
        continue;
      }
      const classMatch = this.matchClass(line, language);
      if (classMatch) {
        const classNode: ASTNode = {
          type: 'class', name: classMatch.name, startLine: lineNum,
          endLine: lineNum + this.findBlockEnd(lines, i), children: [],
          metadata: { extends: classMatch.extends },
        };
        root.children.push(classNode);
      }
    }
    return root;
  }

  private matchFunction(line: string, language: string): { name: string; params: string } | null {
    const patterns: Record<string, RegExp> = {
      typescript: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/,
      javascript: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/,
      python: /def\s+(\w+)\s*\(([^)]*)\)/,
      rust: /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)/,
      go: /func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(([^)]*)\)/,
    };
    const pattern = patterns[language];
    if (!pattern) return null;
    const match = line.match(pattern);
    if (match) return { name: match[1], params: match[2] || '' };
    const arrowMatch = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/);
    if (arrowMatch) return { name: arrowMatch[1], params: '' };
    const methodMatch = line.match(/^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{/);
    if (methodMatch && methodMatch[1] !== 'if' && methodMatch[1] !== 'while' && methodMatch[1] !== 'for') {
      return { name: methodMatch[1], params: '' };
    }
    return null;
  }

  private matchClass(line: string, language: string): { name: string; extends?: string } | null {
    const patterns: Record<string, RegExp> = {
      typescript: /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/,
      javascript: /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/,
      python: /class\s+(\w+)(?:\((\w+)\))?/,
      rust: /(?:pub\s+)?struct\s+(\w+)/,
      go: /type\s+(\w+)\s+struct/,
    };
    const pattern = patterns[language];
    if (!pattern) return null;
    const match = line.match(pattern);
    if (match) return { name: match[1], extends: match[2] };
    return null;
  }

  private findBlockEnd(lines: string[], startIdx: number): number {
    let depth = 0;
    let inBlock = false;
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      const opens = (line.match(/[\{]/g) || []).length;
      const closes = (line.match(/[\}]/g) || []).length;
      if (opens > 0) inBlock = true;
      depth += opens - closes;
      if (inBlock && depth <= 0) return i - startIdx;
    }
    return Math.min(50, lines.length - startIdx);
  }

  private extractFunctions(root: ASTNode): ASTNode[] {
    const functions: ASTNode[] = [];
    const visit = (node: ASTNode) => {
      if (node.type === 'function') functions.push(node);
      for (const child of node.children) visit(child);
    };
    visit(root);
    return functions;
  }

  private extractClasses(root: ASTNode): ASTNode[] {
    const classes: ASTNode[] = [];
    const visit = (node: ASTNode) => {
      if (node.type === 'class') classes.push(node);
      for (const child of node.children) visit(child);
    };
    visit(root);
    return classes;
  }

  private extractImports(code: string, language: string, filePath = 'unknown'): string[] {
    const lang = this.getAstGrepLang(language, filePath);
    if (lang) {
      const parsedRoot = this.parseAstGrepRoot(code, lang);
      if (parsedRoot) return this.extractAstGrepImports(parsedRoot, lang);
    }

    const imports: string[] = [];
    const lines = code.split('\n');
    const patterns: Record<string, RegExp> = {
      typescript: /import\s+(?:.*\s+from\s+)?['"]([^'"]+)['"]/,
      javascript: /(?:import\s+.*from\s+|require\s*\(\s*)['"]([^'"]+)['"]/,
      python: /(?:from\s+(\S+)\s+import|import\s+(\S+))/,
      rust: /use\s+(\S+)/,
      go: /import\s+(?:\(\s*)?["']([^"']+)["']/,
    };
    const pattern = patterns[language];
    if (!pattern) return imports;
    for (const line of lines) {
      const match = line.match(pattern);
      if (match) imports.push(match[1] || match[2]);
    }
    return [...new Set(imports)];
  }

  private extractAstGrepImports(root: SgNode, lang: Lang): string[] {
    const imports: string[] = [];
    const addLiteral = (node: SgNode): void => {
      const moduleName = this.firstStringLiteral(node, lang);
      if (moduleName) imports.push(moduleName);
    };

    for (const node of this.findAllAstGrepKind(root, lang, 'import_statement')) addLiteral(node);
    for (const node of this.findAllAstGrepKind(root, lang, 'export_statement')) {
      if (!node.field('declaration')) {
        const moduleName = this.directStringLiteral(node);
        if (moduleName) imports.push(moduleName);
      }
    }

    for (const node of this.findAllAstGrepKind(root, lang, 'call_expression')) {
      const callee = node.field('function')?.text();
      if (callee === 'require' || callee === 'import') addLiteral(node);
    }

    return [...new Set(imports)];
  }

  private extractExports(code: string, language: string, filePath = 'unknown'): string[] {
    const lang = this.getAstGrepLang(language, filePath);
    if (lang) {
      const parsedRoot = this.parseAstGrepRoot(code, lang);
      if (parsedRoot) return this.extractAstGrepExports(parsedRoot, lang);
    }

    const exports: string[] = [];
    const lines = code.split('\n');
    for (const line of lines) {
      const exportMatch = line.match(/export\s+(?:default\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/);
      if (exportMatch) exports.push(exportMatch[1]);
      const namedExportMatch = line.match(/export\s*\{\s*([^}]+)\s*\}/);
      if (namedExportMatch) {
        const names = namedExportMatch[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0]);
        exports.push(...names);
      }
    }
    return [...new Set(exports)];
  }

  private extractAstGrepExports(root: SgNode, lang: Lang): string[] {
    const exports: string[] = [];

    for (const node of this.findAllAstGrepKind(root, lang, 'export_statement')) {
      const declaration = node.field('declaration');
      if (declaration) {
        const exportCountBeforeDeclaration = exports.length;
        this.addDeclarationExportNames(exports, declaration, lang);
        if (exports.length === exportCountBeforeDeclaration && this.hasDirectChildText(node, 'default')) exports.push('default');
        continue;
      }

      for (const specifier of this.findAllAstGrepKind(node, lang, 'export_specifier')) {
        const name = specifier.field('name')?.text();
        if (name) exports.push(name);
      }

      if (this.hasDirectChildText(node, 'default')) exports.push('default');
    }

    return [...new Set(exports)];
  }

  private addDeclarationExportNames(exports: string[], declaration: SgNode, lang: Lang): void {
    const directName = this.sgNodeName(declaration);
    if (directName) exports.push(directName);

    if (declaration.kind() === 'lexical_declaration') {
      for (const declarator of this.findAllAstGrepKind(declaration, lang, 'variable_declarator')) {
        const name = this.sgNodeName(declarator);
        if (name) exports.push(name);
      }
    }
  }

  private calculateComplexity(code: string, root: ASTNode, language: string, filePath: string): ASTAnalysis['complexity'] {
    const lang = this.getAstGrepLang(language, filePath);
    if (root.metadata?.parser === 'ast-grep' && lang) {
      const parsedRoot = this.parseAstGrepRoot(code, lang);
      if (parsedRoot) return this.calculateAstGrepComplexity(code, parsedRoot, lang);
    }

    const lines = code.split('\n');
    const nonEmptyLines = lines.filter(l => l.trim().length > 0);
    const commentLines = lines.filter(l => /^\s*(\/\/|\/\*|\*|#)/.test(l));
    const decisionPoints = (code.match(/\b(if|else|for|while|switch|case|catch|&&|\|\||\?)\b/g) || []).length;
    const cyclomatic = decisionPoints + 1;
    let cognitive = 0;
    let nestingLevel = 0;
    for (const line of lines) {
      const opens = (line.match(/[\{]/g) || []).length;
      const closes = (line.match(/[\}]/g) || []).length;
      if (/\b(if|for|while|switch)\b/.test(line)) cognitive += 1 + nestingLevel;
      nestingLevel += opens - closes;
      nestingLevel = Math.max(0, nestingLevel);
    }
    return {
      cyclomatic, cognitive, loc: nonEmptyLines.length,
      commentDensity: lines.length > 0 ? commentLines.length / lines.length : 0,
    };
  }

  private calculateAstGrepComplexity(code: string, root: SgNode, lang: Lang): ASTAnalysis['complexity'] {
    const lines = code.split('\n');
    const nonEmptyLines = lines.filter(l => l.trim().length > 0);
    const commentLines = lines.filter(l => /^\s*(\/\/|\/\*|\*)/.test(l));
    const decisionKinds = [
      'if_statement',
      'for_statement',
      'for_in_statement',
      'for_of_statement',
      'while_statement',
      'do_statement',
      'switch_case',
      'case_statement',
      'catch_clause',
      'ternary_expression',
      'conditional_expression',
    ];

    const decisionNodes: SgNode[] = [];
    const decisionIds = new Set<number>();
    for (const kindName of decisionKinds) {
      for (const node of this.findAllAstGrepKind(root, lang, kindName)) {
        if (decisionIds.has(node.id())) continue;
        decisionIds.add(node.id());
        decisionNodes.push(node);
      }
    }

    for (const node of this.findAllAstGrepKind(root, lang, 'binary_expression')) {
      if (!this.isLogicalBinaryExpression(node)) continue;
      if (decisionIds.has(node.id())) continue;
      decisionIds.add(node.id());
      decisionNodes.push(node);
    }

    let cyclomatic = 1;
    let cognitive = 0;
    for (const node of decisionNodes) {
      cyclomatic += 1;
      cognitive += 1 + this.decisionAncestorDepth(node, decisionIds);
    }

    return {
      cyclomatic,
      cognitive,
      loc: nonEmptyLines.length,
      commentDensity: lines.length > 0 ? commentLines.length / lines.length : 0,
    };
  }

  private getAstGrepLang(language: string, filePath: string): Lang | null {
    if (/\.tsx$/i.test(filePath)) return Lang.Tsx;
    if (/\.jsx$/i.test(filePath)) return Lang.Tsx;
    if (/\.mjs$/i.test(filePath) || /\.cjs$/i.test(filePath) || /\.js$/i.test(filePath)) return Lang.JavaScript;
    if (/\.ts$/i.test(filePath)) return Lang.TypeScript;
    if (language === 'typescript') return Lang.TypeScript;
    if (language === 'javascript') return Lang.JavaScript;
    return null;
  }

  private parseAstGrepRoot(code: string, lang: Lang): SgNode | null {
    try {
      return parse(lang, code).root();
    } catch {
      return null;
    }
  }

  private findAllAstGrepKind(node: SgNode, lang: Lang, kindName: string): SgNode[] {
    try {
      return node.findAll(kind(lang, kindName));
    } catch {
      return [];
    }
  }

  private sgNodeName(node: SgNode): string | null {
    const fieldName = node.field('name')?.text();
    if (fieldName) return fieldName;

    for (const child of node.children()) {
      const childKind = child.kind();
      if (childKind === 'identifier' || childKind === 'type_identifier' || childKind === 'property_identifier') {
        return child.text();
      }
    }
    return null;
  }

  private sgNodeParams(node: SgNode): string {
    const params = node.field('parameters')?.text();
    if (!params) return '';
    const trimmed = params.trim();
    if (trimmed.startsWith('(') && trimmed.endsWith(')')) return trimmed.slice(1, -1).trim();
    return trimmed;
  }

  private sgClassExtends(node: SgNode, lang: Lang): string | undefined {
    const heritage = this.findAllAstGrepKind(node, lang, 'class_heritage')[0]?.text().trim();
    if (!heritage) return undefined;
    return heritage.replace(/^extends\s+/, '').trim();
  }

  private sgNodeLines(node: SgNode): { startLine: number; endLine: number } {
    const range = node.range();
    return {
      startLine: range.start.line + 1,
      endLine: range.end.line + 1,
    };
  }

  private sgContains(parent: SgNode, child: SgNode): boolean {
    const parentRange = parent.range();
    const childRange = child.range();
    return parentRange.start.index <= childRange.start.index && parentRange.end.index >= childRange.end.index;
  }

  private sgRangeSpan(node: SgNode): number {
    const range = node.range();
    return range.end.index - range.start.index;
  }

  private isFunctionLikeValue(node: SgNode): boolean {
    const nodeKind = node.kind();
    return nodeKind === 'arrow_function' || nodeKind === 'function' || nodeKind === 'function_expression';
  }

  private firstStringLiteral(node: SgNode, lang: Lang): string | null {
    const literal = this.findAllAstGrepKind(node, lang, 'string')[0];
    if (!literal) return null;
    return this.unquoteLiteral(literal.text());
  }

  private directStringLiteral(node: SgNode): string | null {
    const literal = node.children().find(child => child.kind() === 'string');
    if (!literal) return null;
    return this.unquoteLiteral(literal.text());
  }

  private unquoteLiteral(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
      const first = trimmed[0];
      const last = trimmed[trimmed.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        return trimmed.slice(1, -1);
      }
    }
    return trimmed;
  }

  private isLogicalBinaryExpression(node: SgNode): boolean {
    return node.children().some(child => child.text() === '&&' || child.text() === '||');
  }

  private hasDirectChildText(node: SgNode, text: string): boolean {
    return node.children().some(child => child.text() === text);
  }

  private decisionAncestorDepth(node: SgNode, decisionIds: Set<number>): number {
    return node.ancestors().filter(ancestor => decisionIds.has(ancestor.id())).length;
  }

  private lineCount(code: string): number {
    return code.length === 0 ? 1 : code.split('\n').length;
  }
}

export function createASTAnalyzer(config?: Partial<ASTAnalyzerConfig>): ASTAnalyzer {
  return new ASTAnalyzer(config);
}
