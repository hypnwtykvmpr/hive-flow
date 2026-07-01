// integrations/__tests__/atomic-merge.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertJsonPath } from '../atomic-merge.js';

let dir: string;
const isManagedAlways = async () => true;
const isManagedNever  = async () => false;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hf-')); });

describe('Rule 1: do not create agent config files', () => {
  it('returns missing-config when target file does not exist and ownership=agent', async () => {
    const target = join(dir, 'absent.json');
    const r = await upsertJsonPath({
      filePath: target, ownership: 'agent', jsonPath: ['mcpServers','hive-flow'],
      value: { command: 'x' }, dryRun: false, createIfMissing: false, forceAdopt: false, isManaged: isManagedAlways,
    });
    expect(r.outcome).toBe('missing-config');
    expect(existsSync(target)).toBe(false);
  });
});

describe('Rule 2: idempotent skip when entry matches', () => {
  it('returns already-registered on byte-equal re-apply', async () => {
    const target = join(dir, 'existing.json');
    writeFileSync(target, '{\n  "mcpServers": {}\n}\n');
    const v = { command: '/path/to/launcher', args: [], env: { HIVE_FLOW_MODE: 'v3' } };
    const r1 = await upsertJsonPath({ filePath: target, ownership: 'agent', jsonPath: ['mcpServers','hive-flow'], value: v, dryRun: false, createIfMissing: false, forceAdopt: false, isManaged: isManagedAlways });
    expect(r1.outcome).toBe('applied');
    const r2 = await upsertJsonPath({ filePath: target, ownership: 'agent', jsonPath: ['mcpServers','hive-flow'], value: v, dryRun: false, createIfMissing: false, forceAdopt: false, isManaged: isManagedAlways });
    expect(r2.outcome).toBe('already-registered');
  });
});

describe('Rule 3: sibling keys preserved', () => {
  it('preserves filesystem and hooks alongside hive-flow', async () => {
    const target = join(dir, 'gemini-like.json');
    writeFileSync(target, '{\n  "mcpServers": {\n    "filesystem": { "command": "fs" },\n    "playwright": { "command": "pw" }\n  },\n  "hooks": []\n}\n');
    await upsertJsonPath({
      filePath: target, ownership: 'agent', jsonPath: ['mcpServers','hive-flow'],
      value: { command: '/launcher', args: [] }, dryRun: false, createIfMissing: false, forceAdopt: false, isManaged: isManagedAlways,
    });
    const after = readFileSync(target, 'utf8');
    expect(after).toContain('"filesystem"');
    expect(after).toContain('"playwright"');
    expect(after).toContain('"hooks"');
    expect(after).toContain('"hive-flow"');
  });
});

describe('Rule 4: malformed config detection', () => {
  it('returns invalid-config on broken JSON, leaves file unchanged', async () => {
    const target = join(dir, 'broken.json');
    writeFileSync(target, '{ "this": is not valid }');
    const original = readFileSync(target, 'utf8');
    const r = await upsertJsonPath({
      filePath: target, ownership: 'agent', jsonPath: ['mcpServers','hive-flow'],
      value: { command: 'x' }, dryRun: false, createIfMissing: false, forceAdopt: false, isManaged: isManagedAlways,
    });
    expect(r.outcome).toBe('invalid-config');
    expect(readFileSync(target, 'utf8')).toBe(original);
  });
});

describe('Rule 5/6: backup is created on first modify, rotates on second', () => {
  it('creates .hive-flow.bak on first, .bak.1 on second', async () => {
    const target = join(dir, 'rotate.json');
    writeFileSync(target, '{\n  "mcpServers": {}\n}\n');
    await upsertJsonPath({ filePath: target, ownership: 'agent', jsonPath: ['mcpServers','hive-flow'], value: { command: 'v1' }, dryRun: false, createIfMissing: false, forceAdopt: false, isManaged: isManagedAlways });
    expect(existsSync(`${target}.hive-flow.bak`)).toBe(true);
    await upsertJsonPath({ filePath: target, ownership: 'agent', jsonPath: ['mcpServers','hive-flow'], value: { command: 'v2' }, dryRun: false, createIfMissing: false, forceAdopt: false, isManaged: isManagedAlways });
    expect(existsSync(`${target}.hive-flow.bak.1`)).toBe(true);
  });
});

describe('Conflict: unowned entry, no forceAdopt', () => {
  it('returns conflict:manual-entry when existing entry is not state-tracked', async () => {
    const target = join(dir, 'pre-existing.json');
    writeFileSync(target, '{ "mcpServers": { "hive-flow": { "command": "user-set" } } }');
    const r = await upsertJsonPath({
      filePath: target, ownership: 'agent', jsonPath: ['mcpServers','hive-flow'],
      value: { command: '/launcher' }, dryRun: false, createIfMissing: false, forceAdopt: false, isManaged: isManagedNever,
    });
    expect(r.outcome).toBe('conflict:manual-entry');
  });
});
