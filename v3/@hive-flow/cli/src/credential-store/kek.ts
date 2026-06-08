import { randomBytes } from 'node:crypto';

export const KEK_BYTES = 32;

export type RandomBytes = (size: number) => Buffer;

export interface SealedKek {
  version: number;
  backend: string;
  sealed: Uint8Array | string;
  degraded?: boolean;
}

export interface KekProvider {
  sealKek(kek: Uint8Array): Promise<SealedKek> | SealedKek;
  unsealKek(sealed: SealedKek): Promise<Uint8Array> | Uint8Array;
  status(): Promise<{ available: boolean; degraded?: boolean; reason?: string }> | { available: boolean; degraded?: boolean; reason?: string };
}

export function isValidKek(value: Uint8Array): boolean {
  return value instanceof Uint8Array && value.byteLength === KEK_BYTES;
}

export function assertValidKek(value: Uint8Array): void {
  if (!isValidKek(value)) {
    throw new Error(`credential vault KEK must be ${KEK_BYTES} bytes`);
  }
}

export function generateKek(random: RandomBytes = randomBytes): Buffer {
  const kek = random(KEK_BYTES);
  assertValidKek(kek);
  return Buffer.from(kek);
}
