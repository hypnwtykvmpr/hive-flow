// v3/@hive-flow/cli/src/integrations/state.ts
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { stableStringify, atomicWrite } from './atomic-merge.js';

export interface ManagedRecord {
  agent: string;
  kind: 'mcp' | 'hooks' | 'statusline' | 'plugin' | 'extension';
  scope: 'project' | 'user';
  targetPath: string;
  jsonPath: string;       // e.g., "mcpServers.hive-flow"
  /** sha256 of the primary entry's canonical serialization.
   *  - JSON adapters: full entry checksum (e.g., { command, args, env }).
   *  - TOML adapters: main table checksum (e.g., [mcp_servers.hive-flow] body). */
  checksum: string;
  /** Second checksum for adapters that own a subtable (e.g., Codex's [mcp_servers.hive-flow.env]).
   *  Used by `isManaged` on the env subtable to detect user tampering separately from the main table. */
  envChecksum?: string;
  launcherPath: string;
  installedAt: string;
  version: 1;
}

export interface IntegrationState { version: 1; entries: Record<string, ManagedRecord>; }

export function statePathFor(scope: 'project' | 'user', homeDir: string, projectRoot: string): string {
  return scope === 'user'
    ? join(homeDir, '.hive-flow', 'integrations', 'state.json')
    : join(projectRoot, '.hive-flow', 'integrations', 'state.json');
}

export function entryId(r: { agent: string; kind: string; scope: string; targetPath: string; jsonPath: string }): string {
  return [r.agent, r.kind, r.scope, resolve(r.targetPath), r.jsonPath].join('|');
}

export async function readState(p: string): Promise<IntegrationState> {
  if (!existsSync(p)) return { version: 1, entries: {} };
  // Bug-fix vs Codex's runbook: wrap JSON.parse in try/catch so a malformed state file
  // doesn't crash the entire setup command. A malformed state means "unknown ownership"
  // — degrade to "treat all existing entries as unowned, conservative".
  try {
    const parsed = JSON.parse(await readFile(p, 'utf8')) as IntegrationState;
    return parsed.version === 1 && parsed.entries ? parsed : { version: 1, entries: {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

export async function writeState(p: string, state: IntegrationState): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await atomicWrite(p, JSON.stringify(state, null, 2) + '\n');
}

export function checksumEntry(value: unknown): string {
  // Use stableStringify so key-order differences don't produce false checksum mismatches.
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}
