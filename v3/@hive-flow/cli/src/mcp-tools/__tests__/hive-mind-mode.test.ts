import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hiveMindTools } from '../hive-mind-tools.js';
import { operatorSessionEnvKeys } from '../session-id.js';

const initTool = hiveMindTools.find(tool => tool.name === 'hive-mind_init')!;
const spawnTool = hiveMindTools.find(tool => tool.name === 'hive-mind_spawn')!;
const ORIGINAL_CWD = process.cwd();
const OWNER_ENV_KEYS = Array.from(new Set([
  ...operatorSessionEnvKeys(),
  'HIVE_FLOW_CLIENT_KIND',
]));
const ORIGINAL_ENV = Object.fromEntries(
  OWNER_ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<string, string | undefined>;

function clearOwnerEnv(): void {
  for (const key of OWNER_ENV_KEYS) delete process.env[key];
}

function readAgentRecords(root: string): Array<Record<string, unknown>> {
  const storePath = join(root, '.hive-flow', 'agents', 'store.json');
  if (!existsSync(storePath)) return [];
  const store = JSON.parse(readFileSync(storePath, 'utf8')) as {
    agents?: Record<string, Record<string, unknown>>;
  };
  return Object.values(store.agents ?? {});
}

describe('hive-mind_spawn persisted agent mode', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'hive-flow-hive-mind-mode-'));
    process.chdir(tmpRoot);
    clearOwnerEnv();
    process.env.CODEX_SESSION_ID = 'hive-parent-session';
  });

  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('stamps mode full on records created by the secondary hive-mind spawn writer', async () => {
    await initTool.handler({ topology: 'mesh' });

    const result = await spawnTool.handler({
      count: 2,
      agentType: 'tester',
      prefix: 'hm-mode',
    }) as Record<string, unknown>;

    expect(result).toMatchObject({ success: true, spawned: 2 });
    const records = readAgentRecords(tmpRoot);
    expect(records).toHaveLength(2);
    expect(records.every(record => record.ownerSessionId === 'hive-parent-session')).toBe(true);
    expect(records.every(record => record.ownerClientKind === 'codex')).toBe(true);
    expect(records.every(record => record.mode === 'full')).toBe(true);
  });
});
