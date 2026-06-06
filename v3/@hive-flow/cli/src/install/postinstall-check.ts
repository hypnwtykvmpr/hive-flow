import { pathToFileURL } from 'node:url';

import { isEnforcementEngineInstalled, type EnforcementMarkerFs } from './enforcement-marker.js';

interface WritableLike {
  write(value: string): unknown;
}

export interface PostinstallCheckOptions {
  homeDir?: string;
  fs?: EnforcementMarkerFs;
  stdout?: WritableLike;
  stderr?: WritableLike;
}

export function enforcementNotInstalledMessage(): string {
  return [
    '',
    '============================================================',
    'ENFORCEMENT NOT INSTALLED',
    '',
    'Hive Flow is installed, but the user-level enforcement engine',
    'is not active for this account.',
    '',
    'Run:',
    '  hive-flow install --global',
    '',
    'For CI or other non-interactive installs:',
    '  hive-flow install --global --yes',
    '============================================================',
    '',
  ].join('\n');
}

function safeWrite(stream: WritableLike | undefined, value: string): void {
  try {
    stream?.write(value);
  } catch {
    // Postinstall diagnostics must never break package installation.
  }
}

export function runPostinstallCheck(options: PostinstallCheckOptions = {}): number {
  try {
    if (isEnforcementEngineInstalled({ homeDir: options.homeDir, fs: options.fs })) {
      return 0;
    }
    safeWrite(options.stderr ?? process.stderr, enforcementNotInstalledMessage());
    return 0;
  } catch {
    safeWrite(options.stderr ?? process.stderr, enforcementNotInstalledMessage());
    return 0;
  } finally {
    void options.stdout;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runPostinstallCheck());
}
