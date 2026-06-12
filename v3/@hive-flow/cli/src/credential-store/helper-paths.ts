import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HELPER_BINARIES = {
  macosKeychain: 'hive-flow-macos-keychain-helper',
  peerCred: 'hive-flow-peer-cred-helper',
  winCredential: 'hive-flow-windows-credential-helper.exe',
  winPeerCred: 'hive-flow-windows-peer-cred-helper.exe',
} as const;

const HELPER_ENV: Record<string, string> = {
  [HELPER_BINARIES.macosKeychain]: 'HIVE_FLOW_MACOS_KEYCHAIN_HELPER',
  [HELPER_BINARIES.peerCred]: 'HIVE_FLOW_PEER_CRED_HELPER',
  [HELPER_BINARIES.winCredential]: 'HIVE_FLOW_WINDOWS_CREDENTIAL_HELPER',
  [HELPER_BINARIES.winPeerCred]: 'HIVE_FLOW_WINDOWS_PEER_CRED_HELPER',
};

export function helperBinDir(homeDir = homedir()): string {
  return join(homeDir, '.hive-flow', 'bin');
}

export function installedHelperPath(binary: string, homeDir = homedir()): string | undefined {
  const candidate = join(helperBinDir(homeDir), binary);
  return existsSync(candidate) ? candidate : undefined;
}

export function configuredOrInstalledHelperPath(
  binary: string,
  homeDir = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const envName = HELPER_ENV[binary];
  const configured = envName ? env[envName] : undefined;
  if (configured) return configured;
  return installedHelperPath(binary, homeDir);
}
