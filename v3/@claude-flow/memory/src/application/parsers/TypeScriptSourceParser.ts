import ts from 'typescript';
import { MemoryEntryInput } from '../../types.js';

/**
 * Code Chunk with metadata for memory system
 */
export interface CodeChunk extends MemoryEntryInput {
  metadata: {
    type: 'module' | 'class' | 'method' | 'property';
    className?: string;
    extends?: string[];
    lineStart: number;
    lineEnd: number;
    sourcePath: string;
    symbol?: string;
    [key: string]: unknown;
  };
}

/**
 * AST-Aware TypeScript Source Parser
 * 
 * Ported from Neo-mjs research. Chunks source code based on semantic structure.
 * Extracting methods and classes as separate, boostable memory units.
 */
export class TypeScriptSourceParser {
  /**
   * Parses a TypeScript file into semantic chunks
   * 
   * @param sourcePath - Path to the source file
   * @param sourceContent - Content of the source file
   * @returns Array of CodeChunks
   */
  public parse(sourcePath: string, sourceContent: string): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    const sourceFile = ts.createSourceFile(
      sourcePath,
      sourceContent,
      ts.ScriptTarget.Latest,
      true
    );

    // 1. Process Module Level
    this.extractModuleChunk(sourceFile, chunks, sourcePath, sourceContent);

    // 2. Traverse AST for Classes and Methods
    const visitor = (node: ts.Node) => {
      if (ts.isClassDeclaration(node) && node.name) {
        this.extractClassChunk(node, chunks, sourcePath, sourceFile);
      } else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
        this.extractMethodChunk(node, chunks, sourcePath, sourceFile);
      }
      ts.forEachChild(node, visitor);
    };

    ts.forEachChild(sourceFile, visitor);

    return chunks;
  }

  private extractModuleChunk(
    sourceFile: ts.SourceFile,
    chunks: CodeChunk[],
    sourcePath: string,
    sourceContent: string
  ): void {
    const lineStart = 1;
    const lineEnd = sourceFile.getLineAndCharacterOfPosition(sourceFile.getEnd()).line + 1;

    chunks.push({
      key: sourcePath,
      content: sourceContent,
      type: 'semantic',
      namespace: 'codebase',
      tags: ['module', 'source'],
      metadata: {
        type: 'module',
        lineStart,
        lineEnd,
        sourcePath
      }
    });
  }

  private extractClassChunk(
    node: ts.ClassDeclaration,
    chunks: CodeChunk[],
    sourcePath: string,
    sourceFile: ts.SourceFile
  ): void {
    const className = node.name?.getText() || 'Anonymous';
    const content = node.getText();
    const { line: lineStart } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    const { line: lineEnd } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

    const extendsList: string[] = [];
    if (node.heritageClauses) {
      for (const clause of node.heritageClauses) {
        if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
          for (const type of clause.types) {
            extendsList.push(type.getText());
          }
        }
      }
    }

    chunks.push({
      key: `${sourcePath}#${className}`,
      content,
      type: 'semantic',
      namespace: 'codebase',
      tags: ['class', 'source'],
      metadata: {
        type: 'class',
        className,
        extends: extendsList,
        lineStart: lineStart + 1,
        lineEnd: lineEnd + 1,
        sourcePath,
        symbol: className
      }
    });
  }

  private extractMethodChunk(
    node: ts.MethodDeclaration | ts.MethodSignature,
    chunks: CodeChunk[],
    sourcePath: string,
    sourceFile: ts.SourceFile
  ): void {
    const methodName = node.name.getText();
    const content = node.getText();
    const { line: lineStart } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    const { line: lineEnd } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

    // Find parent class
    let parent: ts.Node | undefined = node.parent;
    let className: string | undefined;
    while (parent) {
      if (ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent)) {
        className = parent.name?.getText();
        break;
      }
      parent = parent.parent;
    }

    chunks.push({
      key: className ? `${sourcePath}#${className}.${methodName}` : `${sourcePath}#${methodName}`,
      content,
      type: 'semantic',
      namespace: 'codebase',
      tags: ['method', 'source'],
      metadata: {
        type: 'method',
        className,
        lineStart: lineStart + 1,
        lineEnd: lineEnd + 1,
        sourcePath,
        symbol: methodName
      }
    });
  }
}
