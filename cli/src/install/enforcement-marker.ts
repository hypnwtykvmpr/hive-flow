import { existsSync as nodeExistsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface EnforcementMarkerFs {
  existsSync(path: string): boolean;
}

export interface EnforcementMarkerOptions {
  homeDir?: string;
  fs?: EnforcementMarkerFs;
}

export interface EnforcementMarkerPaths {
  versionPath: string;
  enforcementPath: string;
}

const DEFAULT_FS: EnforcementMarkerFs = {
  existsSync: nodeExistsSync,
};

export function enforcementBinDir(homeDir = homedir()): string {
  return join(homeDir, '.hive-flow', 'enforcement', 'bin');
}

export function enforcementMarkerPaths(options: EnforcementMarkerOptions = {}): EnforcementMarkerPaths {
  const binDir = enforcementBinDir(options.homeDir);
  return {
    versionPath: join(binDir, '.version'),
    enforcementPath: join(binDir, 'enforcement.cjs'),
  };
}

export function isEnforcementEngineInstalled(options: EnforcementMarkerOptions = {}): boolean {
  try {
    const fs = options.fs ?? DEFAULT_FS;
    const paths = enforcementMarkerPaths(options);
    const hasVersion = fs.existsSync(paths.versionPath);
    const hasEnforcement = fs.existsSync(paths.enforcementPath);
    return hasVersion && hasEnforcement;
  } catch {
    return false;
  }
}
