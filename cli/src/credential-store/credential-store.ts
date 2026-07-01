export interface CredentialStoreStatus {
  available: boolean;
  degraded?: boolean;
  reason?: string;
}

export interface CredentialStoreProvider {
  isAvailable(): boolean | Promise<boolean>;
  storeSecret(provider: string, secret: Uint8Array | string): void | Promise<void>;
  retrieveSecret(provider: string): Uint8Array | null | Promise<Uint8Array | null>;
  deleteSecret(provider: string): void | Promise<void>;
  status(provider?: string): CredentialStoreStatus | Promise<CredentialStoreStatus>;
}

export function normalizeProviderKeyName(provider: string): string {
  const normalized = String(provider || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('credential provider name is required');
  return normalized;
}
