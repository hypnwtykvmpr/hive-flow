export type CredentialBoundaryGateStatus = 'xfail' | 'green';
export type CredentialBoundaryGateSlice = 'PR3' | 'PR4';

export interface CredentialBoundaryGate {
  id: 'credential-use-not-know' | 'strict-api-no-env-no-config-serialization';
  targetSlice: CredentialBoundaryGateSlice;
  status: CredentialBoundaryGateStatus;
  description: string;
}

export const CREDENTIAL_BOUNDARY_GATES: readonly CredentialBoundaryGate[] = [
  {
    id: 'credential-use-not-know',
    targetSlice: 'PR3',
    status: 'green',
    description: 'Same-user callers can request provider USE, but no caller can receive raw key material.',
  },
  {
    id: 'strict-api-no-env-no-config-serialization',
    targetSlice: 'PR4',
    status: 'xfail',
    description: 'Strict API providers complete without key material in process.env, argv, config.env, logs, or result JSON.',
  },
] as const;

export function getCredentialBoundaryGate(id: CredentialBoundaryGate['id']): CredentialBoundaryGate | undefined {
  return CREDENTIAL_BOUNDARY_GATES.find(gate => gate.id === id);
}
