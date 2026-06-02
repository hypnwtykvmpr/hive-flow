import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';

import { statuslinePaths } from '../paths.js';
import { atomicWriteJson } from '../storage.js';
import type { McpDetailRow, McpSummary } from '../types.js';

export interface UpdateMcpHealthOptions {
  readonly projectRoot: string;
  readonly homeDir?: string;
  readonly observedAt?: string;
}

interface McpConfigFile {
  readonly mcpServers?: unknown;
}

const SOURCE = 'setup-verify-json-rpc';
const PROBE_VERSION = 1;

export async function updateMcpHealth(
  projectRootOrOptions: string | UpdateMcpHealthOptions,
): Promise<McpSummary> {
  const options = normalizeOptions(projectRootOrOptions);
  const projectRoot = resolve(options.projectRoot);
  const projectConfig = await readMcpServerIds(join(projectRoot, '.mcp.json'));
  const homeConfig =
    options.homeDir === undefined ? [] : await readMcpServerIds(join(options.homeDir, '.claude.json'));
  const ids = uniqueServerIds([...projectConfig, ...homeConfig]);
  const paths = statuslinePaths(projectRoot);
  const details = ids.map<McpDetailRow>((id) => ({
    id,
    configured: true,
    runtime: 'up',
    reason: 'configured',
  }));
  const observedAt = options.observedAt ?? new Date().toISOString();
  const summary: McpSummary = {
    version: 1,
    observedAt,
    probeVersion: PROBE_VERSION,
    source: SOURCE,
    total: ids.length,
    configured: ids.length,
    runtimeUp: ids.length,
    state: ids.length > 0 ? 'config-present' : 'not-configured',
    ...(details.length > 0 ? { details } : {}),
  };

  await atomicWriteJson(paths.mcpHealth, summary);
  return summary;
}

function normalizeOptions(value: string | UpdateMcpHealthOptions): UpdateMcpHealthOptions {
  if (typeof value === 'string') {
    return { projectRoot: value, homeDir: homedir() };
  }
  return {
    ...value,
    homeDir: value.homeDir ?? homedir(),
  };
}

async function readMcpServerIds(filePath: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  let parsed: McpConfigFile;
  try {
    parsed = parseJsonc(text) as McpConfigFile;
  } catch {
    return [];
  }
  if (!isPlainObject(parsed.mcpServers)) return [];
  return Object.keys(parsed.mcpServers).filter((id) => id.length > 0);
}

function uniqueServerIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
