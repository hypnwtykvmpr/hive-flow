import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUSPECT_LEGACY_RU_PREFIX } from './debrand-prohibited-patterns.js';
import { isScannedTextFile, REPO_ROOT, trackedFilesForShippedSurfaces } from './debrand-static-scope.js';

interface ClassifiedSuspect {
  readonly classification: 'compatibility-alias' | 'migration-deferred';
  readonly reason: string;
}

const CLASSIFIED_SUSPECTS: ReadonlyMap<string, ClassifiedSuspect> = new Map([
  [
    'package.json:content:suspect legacy ru-prefixed token',
    {
      classification: 'migration-deferred',
      reason: 'Root optional @ruvector dependencies remain load-bearing until the dependency replacement plan lands.',
    },
  ],
  [
    'v3/@hive-flow/cli/package.json:content:suspect legacy ru-prefixed token',
    {
      classification: 'compatibility-alias',
      reason: 'Published ./ruvector subpath aliases point at ./hivector for import compatibility.',
    },
  ],
  [
    'v3/@hive-flow/cli/src/appliance/ruvllm-bridge.ts:path:suspect legacy ru-prefixed token',
    {
      classification: 'migration-deferred',
      reason: 'RVFA/local-LLM appliance naming is deferred to DB-RVFA because it crosses serialized appliance boundaries.',
    },
  ],
  [
    'v3/@hive-flow/cli/src/appliance/rvfa-format.ts:content:suspect legacy ru-prefixed token',
    {
      classification: 'migration-deferred',
      reason: 'Validates RVFA provider values; changing them requires DB-RVFA compatibility coverage.',
    },
  ],
  [
    'v3/@hive-flow/cli/src/appliance/rvfa-runner.ts:content:suspect legacy ru-prefixed token',
    {
      classification: 'migration-deferred',
      reason: 'Reads RVFA provider values; changing them requires DB-RVFA compatibility coverage.',
    },
  ],
  [
    'v3/@hive-flow/cli/src/commands/embeddings.ts:content:suspect legacy ru-prefixed token',
    {
      classification: 'compatibility-alias',
      reason: 'Reads legacy neural config key while writing the primary hivector key.',
    },
  ],
  [
    'v3/@hive-flow/cli/src/commands/hooks.ts:content:suspect legacy ru-prefixed token',
    {
      classification: 'compatibility-alias',
      reason: 'Deprecated --no-ruvector flag remains an alias for --no-hivector.',
    },
  ],
  [
    'v3/@hive-flow/cli/src/mcp-tools/embeddings-tools.ts:content:suspect legacy ru-prefixed token',
    {
      classification: 'compatibility-alias',
      reason: 'Reads legacy MCP embeddings config key while writing/reporting hivector.',
    },
  ],
  [
    'v3/@hive-flow/guidance/README.md:content:suspect legacy ru-prefixed token',
    {
      classification: 'migration-deferred',
      reason: 'Documents the ruvbot optional external package integration.',
    },
  ],
  [
    'v3/@hive-flow/guidance/package.json:content:suspect legacy ru-prefixed token',
    {
      classification: 'migration-deferred',
      reason: 'Published ruvbot integration subpath and keywords refer to an external optional package.',
    },
  ],
  [
    'v3/@hive-flow/guidance/src/index.ts:content:suspect legacy ru-prefixed token',
    {
      classification: 'migration-deferred',
      reason: 'Re-exports the ruvbot optional external package integration API.',
    },
  ],
  [
    'v3/@hive-flow/guidance/src/ruvbot-integration.ts:path:suspect legacy ru-prefixed token',
    {
      classification: 'migration-deferred',
      reason: 'File name is the public integration module for the ruvbot optional external package.',
    },
  ],
  [
    'v3/@hive-flow/guidance/src/ruvbot-integration.ts:content:suspect legacy ru-prefixed token',
    {
      classification: 'migration-deferred',
      reason: 'Dynamic imports and API names target the ruvbot optional external package.',
    },
  ],
  [
    'v3/@hive-flow/memory/src/agentdb-backend.ts:content:suspect legacy ru-prefixed token',
    {
      classification: 'compatibility-alias',
      reason: 'Accepts legacy vectorBackend value and normalizes new hivector input for AgentDB.',
    },
  ],
]);

function hitKey(relativePath: string, location: 'path' | 'content', label: string): string {
  return `${relativePath}:${location}:${label}`;
}

describe('DB-5 legacy ru-prefix suspect classification', () => {
  it('has no unclassified suspect ru-prefixed tokens in widened tracked shipped surfaces', () => {
    const findings = collectSuspectFindings();
    const unclassified = findings
      .filter(({ key }) => !CLASSIFIED_SUSPECTS.has(key))
      .map(({ key, pattern }) => `${key}: ${pattern}`);

    expect(unclassified, '[DB-5 ru-audit] classify or remove suspect legacy ru-prefixed tokens').toEqual([]);
  });

  it('keeps the documented ru-prefix allowlist synchronized with real hits', () => {
    const findingKeys = new Set(collectSuspectFindings().map(({ key }) => key));
    const stale = [...CLASSIFIED_SUSPECTS.keys()].filter((key) => !findingKeys.has(key));

    expect(stale, '[DB-5 ru-audit] remove stale legacy ru-prefix allowlist entries').toEqual([]);
  });
});

function collectSuspectFindings(): Array<{ key: string; pattern: RegExp }> {
  return trackedFilesForShippedSurfaces()
    .filter(isScannedTextFile)
    .flatMap((relativePath) => {
      const absolutePath = resolve(REPO_ROOT, relativePath);
      const content = readFileSync(absolutePath, 'utf8');
      const normalizedPath = relativePath.split(sep).join('/');
      return SUSPECT_LEGACY_RU_PREFIX.flatMap(({ label, pattern }) => {
        const findings: Array<{ key: string; pattern: RegExp }> = [];
        if (pattern.test(normalizedPath)) findings.push({ key: hitKey(normalizedPath, 'path', label), pattern });
        if (pattern.test(content)) findings.push({ key: hitKey(normalizedPath, 'content', label), pattern });
        return findings;
      });
    });
}
