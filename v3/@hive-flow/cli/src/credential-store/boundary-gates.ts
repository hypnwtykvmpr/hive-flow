export type CredentialBoundaryGateStatus = 'xfail' | 'green';
export type CredentialBoundaryGateSlice = 'PR3' | 'PR4' | 'PR5';

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
    targetSlice: 'PR5',
    status: 'green',
    description: 'Strict API providers complete through a production holder bootstrap seeded from the credential store; raw keys stay out of env/config/log/result surfaces.',
  },
] as const;

export function getCredentialBoundaryGate(id: CredentialBoundaryGate['id']): CredentialBoundaryGate | undefined {
  return CREDENTIAL_BOUNDARY_GATES.find(gate => gate.id === id);
}
