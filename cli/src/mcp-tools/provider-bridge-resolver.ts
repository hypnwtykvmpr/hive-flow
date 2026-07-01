import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROVIDER_BRIDGE_SPECIFIER = '@hive-flow/providers/scripts/provider-agent-bridge.mjs';
export const PROVIDER_BRIDGE_RELATIVE_PATH = join('scripts', 'provider-agent-bridge.mjs');

export interface ProviderBridgeCandidate {
  source: string;
  path: string;
}

export interface ProviderBridgeResolverOptions {
  projectRoot?: string;
  moduleUrl?: string;
  exists?: (path: string) => boolean;
  packageResolve?: (specifier: string) => string;
}

export type ProviderBridgeResolution =
  | { ok: true; bridgePath: string; source: string; candidates: ProviderBridgeCandidate[] }
  | { ok: false; error: string; candidates: ProviderBridgeCandidate[] };

function importMetaResolve(specifier: string): string {
  const resolver = (import.meta as ImportMeta & { resolve?: (value: string) => string }).resolve;
  if (typeof resolver !== 'function') {
    throw new Error('import.meta.resolve is unavailable');
  }
  return resolver(specifier);
}

function resolvedSpecifierToPath(value: string): string {
  return value.startsWith('file:') ? fileURLToPath(value) : value;
}

function pushCandidate(candidates: ProviderBridgeCandidate[], seen: Set<string>, source: string, path: string | null | undefined): void {
  if (!path) return;
  const resolvedPath = resolve(path);
  if (seen.has(resolvedPath)) return;
  seen.add(resolvedPath);
  candidates.push({ source, path: resolvedPath });
}

function inferPackageRootFromCompiledModule(modulePath: string): string | null {
  const normalized = resolve(modulePath);
  const normalizedMarker = 'dist/src/mcp-tools/';
  const normalizedPath = normalized.replace(/\\/g, '/');
  const idx = normalizedPath.indexOf(normalizedMarker);
  if (idx < 0) return null;
  return normalizedPath.slice(0, idx);
}

export function collectProviderBridgeCandidates(options: ProviderBridgeResolverOptions = {}): ProviderBridgeCandidate[] {
  const candidates: ProviderBridgeCandidate[] = [];
  const seen = new Set<string>();
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const modulePath = fileURLToPath(moduleUrl);
  const packageRoot = inferPackageRootFromCompiledModule(modulePath);

  try {
    const resolved = options.packageResolve
      ? options.packageResolve(PROVIDER_BRIDGE_SPECIFIER)
      : importMetaResolve(PROVIDER_BRIDGE_SPECIFIER);
    pushCandidate(candidates, seen, 'package-resolution', resolvedSpecifierToPath(resolved));
  } catch {
    // Fall through to explicit layout candidates.
  }

  if (options.projectRoot) {
    const projectRoot = resolve(options.projectRoot);
    pushCandidate(candidates, seen, 'project-root-cli-packages', join(projectRoot, 'cli', 'packages', 'providers', PROVIDER_BRIDGE_RELATIVE_PATH));
    pushCandidate(candidates, seen, 'project-root-cli-node-modules', join(projectRoot, 'cli', 'node_modules', '@hive-flow', 'providers', PROVIDER_BRIDGE_RELATIVE_PATH));
    pushCandidate(candidates, seen, 'project-root-node-modules', join(projectRoot, 'node_modules', '@hive-flow', 'providers', PROVIDER_BRIDGE_RELATIVE_PATH));
  }

  if (packageRoot) {
    pushCandidate(candidates, seen, 'package-root-cli-packages', join(packageRoot, 'packages', 'providers', PROVIDER_BRIDGE_RELATIVE_PATH));
    pushCandidate(candidates, seen, 'package-root-node-modules', join(packageRoot, 'node_modules', '@hive-flow', 'providers', PROVIDER_BRIDGE_RELATIVE_PATH));
  }

  return candidates;
}

export function resolveProviderBridgePath(options: ProviderBridgeResolverOptions = {}): ProviderBridgeResolution {
  const exists = options.exists ?? existsSync;
  const candidates = collectProviderBridgeCandidates(options);
  const found = candidates.find((candidate) => exists(candidate.path));
  if (found) {
    return {
      ok: true,
      bridgePath: found.path,
      source: found.source,
      candidates,
    };
  }
  return {
    ok: false,
    error: `Provider bridge script not found; tried ${candidates.map((candidate) => `${candidate.source}:${candidate.path}`).join(', ')}`,
    candidates,
  };
}
