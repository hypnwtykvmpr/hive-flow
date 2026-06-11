import { join } from 'node:path';

import { resolveHiveHome } from '@hive-flow/shared';

import { readJsonFile } from './storage.js';

export interface EnforcementLiveStatus {
  readonly active: boolean;
  readonly level?: number;
  readonly levelName?: string;
  readonly sourcePath?: string;
}

const LEVEL_NAMES = ['NORMAL', 'WARNED', 'RESTRICTED', 'HALTED'] as const;

function levelName(level: number | undefined): string {
  if (level === undefined) return 'UNKNOWN';
  return LEVEL_NAMES[level] ?? 'UNKNOWN';
}

function readLevel(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as { state?: unknown; level?: unknown };
  const state = record.state && typeof record.state === 'object' && !Array.isArray(record.state)
    ? record.state as { level?: unknown }
    : record;
  const raw = state.level;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return undefined;
  return raw >= 0 && raw < LEVEL_NAMES.length ? raw : undefined;
}

async function readLiveState(path: string): Promise<EnforcementLiveStatus | undefined> {
  const parsed = await readJsonFile<unknown>(path);
  if (parsed === undefined) return undefined;
  const level = readLevel(parsed);
  return {
    active: true,
    ...(level !== undefined ? { level } : {}),
    levelName: levelName(level),
    sourcePath: path,
  };
}

export async function collectEnforcementStatus(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnforcementLiveStatus> {
  const hiveHome = resolveHiveHome(env).home;
  const candidates = [
    join(hiveHome, 'enforcement', 'global', 'state.json'),
    join(projectRoot, '.hive-flow', 'enforcement', 'state.json'),
  ];

  for (const candidate of candidates) {
    const status = await readLiveState(candidate).catch(() => undefined);
    if (status !== undefined) return status;
  }

  return { active: false };
}
