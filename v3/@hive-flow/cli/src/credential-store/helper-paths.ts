import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HELPER_BINARIES = {
  macosKeychain: 'hive-flow-macos-keychain-helper',
  peerCred: 'hive-flow-peer-cred-helper',
  winCredential: 'hive-flow-windows-credential-helper.exe',
  winPeerCred: 'hive-flow-windows-peer-cred-helper.exe',
} as const;

export function helperBinDir(homeDir = homedir()): string {
  return join(homeDir, '.hive-flow', 'bin');
}

export function installedHelperPath(binary: string, homeDir = homedir()): string | undefined {
  const candidate = join(helperBinDir(homeDir), binary);
  return existsSync(candidate) ? candidate : undefined;
}
