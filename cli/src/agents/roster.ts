import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CANONICAL_AGENT_TYPES = [
  'investigator',
  'researcher',
  'verifier',
  'architect',
  'planner',
  'implementer',
  'tester',
  'auditor',
  'bug-hunter',
  'debugger',
  'security-architect',
  'security-reviewer',
  'red-team',
  'blue-team',
  'performance-engineer',
  'memory-specialist',
  'documenter',
  'coordinator',
] as const;

export type CanonicalAgentType = typeof CANONICAL_AGENT_TYPES[number];

export const DEFAULT_CANONICAL_AGENT_TYPE: CanonicalAgentType = 'implementer';

const CANONICAL_AGENT_TYPE_SET = new Set<string>(CANONICAL_AGENT_TYPES);

export interface CanonicalAgentRecord {
  name: CanonicalAgentType;
  type: CanonicalAgentType;
  description: string;
  soloExempt: boolean;
  defaultProvider: string;
  defaultModel: string;
  phases: Array<number | string>;
  capabilities: string[];
  systemPrompt: string;
}

const REQUIRED_FIELDS = [
  'name',
  'type',
  'description',
  'soloExempt',
  'defaultProvider',
  'defaultModel',
  'phases',
  'capabilities',
  'systemPrompt',
] as const;

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export function resolveCanonicalAgentsDir(): string {
  const base = moduleDir();
  const candidates = [
    resolve(base, '..', '..', 'agents'),
    resolve(base, '..', '..', '..', 'agents'),
    resolve(process.cwd(), 'agents'),
    resolve(process.cwd(), 'cli', 'agents'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return candidates[0];
}

function parseScalar(value: string): string | boolean | number {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseAgentYaml(source: string, filePath: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = source.replace(/\r\n/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const keyMatch = /^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/.exec(line);
    if (!keyMatch) {
      throw new Error(`Invalid roster YAML line in ${filePath}: ${line}`);
    }

    const [, key, rawValue = ''] = keyMatch;
    const value = rawValue.trim();

    if (value === '|') {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || !lines[i + 1].trim())) {
        i++;
        block.push(lines[i].replace(/^  /, ''));
      }
      out[key] = block.join('\n').trimEnd();
      continue;
    }

    if (!value) {
      const items: Array<string | boolean | number> = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        const itemMatch = /^\s+-\s+(.*)$/.exec(next);
        if (!itemMatch) break;
        i++;
        items.push(parseScalar(itemMatch[1]));
      }
      out[key] = items;
      continue;
    }

    out[key] = parseScalar(value);
  }

  return out;
}

function assertRosterRecord(
  record: Record<string, unknown>,
  filePath: string,
): asserts record is Record<string, unknown> & CanonicalAgentRecord {
  for (const field of REQUIRED_FIELDS) {
    if (!(field in record)) {
      throw new Error(`Roster file ${filePath} is missing required field ${field}`);
    }
  }

  if (record.name !== record.type) {
    throw new Error(`Roster file ${filePath} must use matching name and type`);
  }
  if (!CANONICAL_AGENT_TYPES.includes(record.type as CanonicalAgentType)) {
    throw new Error(`Roster file ${filePath} has non-canonical type ${String(record.type)}`);
  }
  if (basename(filePath, '.yaml') !== record.type) {
    throw new Error(`Roster file ${filePath} filename must match type ${String(record.type)}`);
  }
  if (typeof record.description !== 'string' || !record.description.trim()) {
    throw new Error(`Roster file ${filePath} has invalid description`);
  }
  if (typeof record.soloExempt !== 'boolean') {
    throw new Error(`Roster file ${filePath} must set soloExempt as a boolean`);
  }
  if (typeof record.defaultProvider !== 'string' || !record.defaultProvider.trim()) {
    throw new Error(`Roster file ${filePath} has invalid defaultProvider`);
  }
  if (typeof record.defaultModel !== 'string' || !record.defaultModel.trim()) {
    throw new Error(`Roster file ${filePath} has invalid defaultModel`);
  }
  if (!Array.isArray(record.phases) || record.phases.length === 0) {
    throw new Error(`Roster file ${filePath} must define phases[]`);
  }
  if (!Array.isArray(record.capabilities) || record.capabilities.length === 0) {
    throw new Error(`Roster file ${filePath} must define capabilities[]`);
  }
  if (typeof record.systemPrompt !== 'string' || !record.systemPrompt.trim()) {
    throw new Error(`Roster file ${filePath} has invalid systemPrompt`);
  }
}

export function loadCanonicalRoster(agentsDir = resolveCanonicalAgentsDir()): CanonicalAgentRecord[] {
  const records = readdirSync(agentsDir)
    .filter(file => file.endsWith('.yaml'))
    .map(file => {
      const filePath = join(agentsDir, file);
      const parsed = parseAgentYaml(readFileSync(filePath, 'utf8'), filePath);
      assertRosterRecord(parsed, filePath);
      return parsed;
    });

  const byType = new Map(records.map(record => [record.type, record]));
  const extra = records.find(record => !CANONICAL_AGENT_TYPES.includes(record.type));
  if (extra) throw new Error(`Non-canonical agent type found: ${extra.type}`);

  for (const type of CANONICAL_AGENT_TYPES) {
    if (!byType.has(type)) throw new Error(`Missing canonical agent type: ${type}`);
  }
  if (records.length !== CANONICAL_AGENT_TYPES.length) {
    throw new Error(`Expected ${CANONICAL_AGENT_TYPES.length} roster files, found ${records.length}`);
  }

  return CANONICAL_AGENT_TYPES.map(type => byType.get(type)!);
}

export function getCanonicalAgentTypes(agentsDir = resolveCanonicalAgentsDir()): CanonicalAgentType[] {
  return loadCanonicalRoster(agentsDir).map(record => record.type);
}

export function isCanonicalAgentType(value: unknown): value is CanonicalAgentType {
  return typeof value === 'string' && CANONICAL_AGENT_TYPE_SET.has(value);
}

export function canonicalAgentTypesDescription(): string {
  return CANONICAL_AGENT_TYPES.join(', ');
}
