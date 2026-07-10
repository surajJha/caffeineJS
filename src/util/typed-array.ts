/**
 * Selects the smallest unsigned typed-array constructor able to index `max`
 * slots. Mirrors the sizing strategy used by isaacs/lru-cache and mnemonist:
 * fewer bytes per pointer means less memory and better cache locality.
 */
export type UintArray = Uint8Array | Uint16Array | Uint32Array;
export type UintArrayCtor = Uint8ArrayConstructor | Uint16ArrayConstructor | Uint32ArrayConstructor;

export function getUintArrayCtor(max: number): UintArrayCtor {
  if (max <= 0x100) return Uint8Array;
  if (max <= 0x10000) return Uint16Array;
  return Uint32Array;
}

export function allocUintArray(max: number): UintArray {
  const Ctor = getUintArrayCtor(max);
  return new Ctor(max);
}

/** Smallest power of two >= n (n >= 1). */
export function nextPowerOfTwo(n: number): number {
  if (n < 1) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
