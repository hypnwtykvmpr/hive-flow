import {
  isEnvOnlyCliProvider,
  isStrictApiProvider,
  probeCredentialHolderStatus,
  type CredentialHolderProbeStatus,
} from '../credential-store/strict-api-provider.js';

export type ProviderKeyPreflightResult =
  | { ok: true; degraded?: false; warning?: undefined }
  | { ok: true; degraded: true; warning: string }
  | { ok: false; reason: string };

export interface ProviderKeyPreflightOptions {
  holderStatus?: CredentialHolderProbeStatus;
}

export function providerKeyPreflight(
  provider: string | undefined,
  env: Record<string, unknown>,
  options: ProviderKeyPreflightOptions = {},
): ProviderKeyPreflightResult {
  const normalized = String(provider || '').trim().toLowerCase();

  if (isStrictApiProvider(normalized)) {
    const status = options.holderStatus ?? probeCredentialHolderStatus(env);
    if (status.available) return { ok: true };
    return {
      ok: false,
      reason:
        `${normalized} strict API provider requires an available credential holder. ` +
        `The holder must own the API call so key material stays out of env/config/tool output` +
        `${status.reason ? ` (${status.reason})` : ''}.`,
    };
  }

  if (isEnvOnlyCliProvider(normalized)) {
    return {
      ok: true,
      degraded: true,
      warning:
        `${normalized} is an env-only CLI provider; it is allowed as a degraded path and is not a strict API credential boundary.`,
    };
  }

  return { ok: true };
}
