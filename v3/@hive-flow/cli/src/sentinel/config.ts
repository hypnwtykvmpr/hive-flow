import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SentinelConfigLoadResult {
  config: Record<string, unknown>;
  path: string;
}

export class SentinelConfigError extends Error {
  constructor(
    message: string,
    public readonly configPath: string,
  ) {
    super(message);
    this.name = 'SentinelConfigError';
  }
}

export function resolveSentinelConfigPath(cwd: string, configPath?: string): string {
  if (configPath && configPath.trim() !== '') {
    return path.isAbsolute(configPath) ? configPath : path.resolve(cwd, configPath);
  }

  return path.join(cwd, '.hive-flow', 'config.yaml');
}

export function loadSentinelConfig(cwd: string, configPath?: string): SentinelConfigLoadResult {
  const resolvedPath = resolveSentinelConfigPath(cwd, configPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new SentinelConfigError(
      `Hive Flow config not found: ${resolvedPath}. Run "hive-flow init" first or pass --config <path>.`,
      resolvedPath,
    );
  }

  let content: string;
  try {
    content = fs.readFileSync(resolvedPath, 'utf-8');
  } catch (error) {
    throw new SentinelConfigError(
      `Unable to read Hive Flow config ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
      resolvedPath,
    );
  }

  try {
    return {
      config: parseSentinelYaml(content),
      path: resolvedPath,
    };
  } catch (error) {
    throw new SentinelConfigError(
      `Invalid Hive Flow config ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
      resolvedPath,
    );
  }
}

function parseSentinelYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [
    { indent: -1, obj: result },
  ];
  let parsedAny = false;
  let sawContent = false;

  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed === '' || trimmed.startsWith('#')) continue;
    sawContent = true;

    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) {
      if (!parsedAny) {
        throw new Error('expected a YAML object at the document root');
      }
      throw new Error(`line ${index + 1}: expected "key: value"`);
    }

    parsedAny = true;
    const indent = match[1].length;
    const key = match[2];
    const rawValue = stripInlineComment(match[3].trim());
    const value = parseScalar(rawValue, index + 1);

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].obj;
    if (value === EMPTY_OBJECT_VALUE) {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else {
      parent[key] = value;
    }
  }

  if (sawContent && !parsedAny) {
    throw new Error('expected a YAML object at the document root');
  }

  return result;
}

const EMPTY_OBJECT_VALUE = Symbol('empty-object-value');

function parseScalar(value: string, lineNumber: number): unknown {
  if (value === '') return EMPTY_OBJECT_VALUE;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;

  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length === 1) {
      throw new Error(`line ${lineNumber}: unterminated quoted string`);
    }
    return value.slice(1, -1);
  }

  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length === 1) {
      throw new Error(`line ${lineNumber}: unterminated quoted string`);
    }
    return value.slice(1, -1);
  }

  if (!Number.isNaN(Number(value)) && value.trim() !== '') {
    return Number(value);
  }

  return value;
}

function stripInlineComment(value: string): string {
  if (!value.includes('#')) return value;
  const hashIndex = value.indexOf('#');
  if (hashIndex === 0 || /\s/.test(value[hashIndex - 1])) {
    return value.slice(0, hashIndex).trimEnd();
  }
  return value;
}
