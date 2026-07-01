import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { PROVIDER_BRIDGE_RELATIVE_PATH, PROVIDER_BRIDGE_SPECIFIER, resolveProviderBridgePath } from '../provider-bridge-resolver.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = join(tmpdir(), `hf-provider-bridge-resolver-${process.pid}-${Date.now()}-${roots.length}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

function touchBridge(root: string, ...segments: string[]): string {
  const bridgePath = join(root, ...segments, PROVIDER_BRIDGE_RELATIVE_PATH);
  mkdirSync(join(bridgePath, '..'), { recursive: true });
  writeFileSync(bridgePath, '#!/usr/bin/env node\n', 'utf8');
  return bridgePath;
}

function moduleUrl(root: string, ...segments: string[]): string {
  return pathToFileURL(join(root, ...segments, 'dist', 'src', 'mcp-tools', 'agent-tools.js')).href;
}

describe('provider bridge resolver', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers package resolution when @hive-flow/providers is installed or bundled', () => {
    const root = makeRoot();
    const packageBridge = touchBridge(root, 'node_modules', '@hive-flow', 'providers');
    touchBridge(root, 'cli', 'packages', 'providers');

    const resolved = resolveProviderBridgePath({
      projectRoot: root,
      moduleUrl: moduleUrl(root, 'cli'),
      packageResolve: (specifier) => {
        expect(specifier).toBe(PROVIDER_BRIDGE_SPECIFIER);
        return pathToFileURL(packageBridge).href;
      },
    });

    expect(resolved).toMatchObject({
      ok: true,
      bridgePath: packageBridge,
      source: 'package-resolution',
    });
  });

  it('resolves the promoted source layout for a fresh cli/dist child', () => {
    const root = makeRoot();
    const bridge = touchBridge(root, 'cli', 'packages', 'providers');

    const resolved = resolveProviderBridgePath({
      projectRoot: root,
      moduleUrl: moduleUrl(root, 'cli'),
      packageResolve: () => {
        throw new Error('not installed');
      },
    });

    expect(resolved).toMatchObject({
      ok: true,
      bridgePath: bridge,
      source: 'project-root-cli-packages',
    });
  });

  it('resolves the legacy v3 providers bridge for an old live MCP child', () => {
    const root = makeRoot();
    const bridge = touchBridge(root, 'v3', '@hive-flow', 'providers');

    const resolved = resolveProviderBridgePath({
      projectRoot: root,
      moduleUrl: moduleUrl(root, 'v3', '@hive-flow', 'cli'),
      packageResolve: () => {
        throw new Error('not installed');
      },
    });

    expect(resolved).toMatchObject({
      ok: true,
      bridgePath: bridge,
      source: 'project-root-legacy-v3',
    });
  });

  it('resolves the bundled providers package beside an installed hive-flow package', () => {
    const root = makeRoot();
    const bridge = touchBridge(root, 'node_modules', 'hive-flow', 'node_modules', '@hive-flow', 'providers');

    const resolved = resolveProviderBridgePath({
      moduleUrl: moduleUrl(root, 'node_modules', 'hive-flow'),
      packageResolve: () => {
        throw new Error('not installed');
      },
    });

    expect(resolved).toMatchObject({
      ok: true,
      bridgePath: bridge,
      source: 'package-root-node-modules',
    });
  });

  it('returns all attempted candidates when the bridge is unavailable', () => {
    const root = makeRoot();

    const resolved = resolveProviderBridgePath({
      projectRoot: root,
      moduleUrl: moduleUrl(root, 'cli'),
      packageResolve: () => {
        throw new Error('not installed');
      },
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error).toContain('Provider bridge script not found');
      expect(resolved.candidates.map((candidate) => candidate.source)).toEqual([
        'project-root-cli-packages',
        'project-root-legacy-v3',
        'project-root-cli-node-modules',
        'project-root-node-modules',
      ]);
    }
  });
});
