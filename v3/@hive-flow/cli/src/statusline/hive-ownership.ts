import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { sanitizeSessionId } from '../mcp-tools/session-id.js';
import { readJsonFile } from './storage.js';
import type { ActiveHiveOwnershipSummary } from './types.js';

const MAX_HIVE_RECORDS = 500;

interface HiveRecordShape {
  status?: unknown;
  ownerSessionId?: unknown;
}

function isActiveHiveRecord(record: unknown): record is HiveRecordShape {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const status = (record as HiveRecordShape).status;
  return typeof status === 'string' && status.toLowerCase() === 'active';
}

export async function collectActiveHiveOwnership(
  projectRoot: string,
): Promise<ActiveHiveOwnershipSummary | undefined> {
  const hivesRoot = join(projectRoot, '.hive-flow', 'hives');
  try {
    const stat = await lstat(hivesRoot);
    if (!stat.isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  let entries;
  try {
    entries = await readdir(hivesRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }

  let active = 0;
  let unknownOwner = 0;
  let inspected = 0;
  const byOwnerSessionId: Record<string, number> = {};

  for (const entry of entries) {
    if (inspected >= MAX_HIVE_RECORDS) break;
    if (!entry.isDirectory()) continue;
    inspected++;

    const record = await readJsonFile<unknown>(join(hivesRoot, entry.name, 'hive.json')).catch(
      () => undefined,
    );
    if (!isActiveHiveRecord(record)) continue;

    active++;
    const ownerSessionId = sanitizeSessionId(record.ownerSessionId);
    if (ownerSessionId === null) {
      unknownOwner++;
      continue;
    }
    byOwnerSessionId[ownerSessionId] = (byOwnerSessionId[ownerSessionId] ?? 0) + 1;
  }

  if (active <= 0) return undefined;
  return { active, unknownOwner, byOwnerSessionId };
}
