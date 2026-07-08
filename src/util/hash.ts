/**
 * 32-bit hashing for the frequency sketch. Key *equality* is handled by the
 * native `Map` in the store; this hash only needs good avalanche so the
 * Count-Min Sketch spreads keys across counters.
 *
 * - numbers  -> fmix32 of the bit pattern (integers and floats)
 * - strings  -> xmur3-style rolling hash
 * - objects  -> stable per-object id (WeakMap), then fmix32
 * - other    -> hash of String(key)
 */

/** Final integer avalanche mixer (Murmur3 fmix32). */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function hashString(str: string): number {
  let h = 0x9e3779b1 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x5bd1e995);
    h ^= h >>> 15;
  }
  return fmix32(h);
}

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

function hashObject(obj: object): number {
  let id = objectIds.get(obj);
  if (id === undefined) {
    id = nextObjectId++;
    objectIds.set(obj, id);
  }
  return fmix32(id);
}

const f64buf = new Float64Array(1);
const i32buf = new Int32Array(f64buf.buffer);

function hashNumber(n: number): number {
  if (Number.isInteger(n) && n >= -0x80000000 && n <= 0x7fffffff) {
    return fmix32(n | 0);
  }
  f64buf[0] = n;
  return fmix32((i32buf[0] as number) ^ Math.imul(i32buf[1] as number, 0x85ebca6b));
}

export function hashKey(key: unknown): number {
  switch (typeof key) {
    case "number":
      return hashNumber(key);
    case "string":
      return hashString(key);
    case "boolean":
      return key ? 0x9e3779b1 : 0x1b873593;
    case "bigint":
      return hashString(key.toString());
    case "object":
    case "function":
      return key === null ? 0 : hashObject(key as object);
    default:
      return hashString(String(key));
  }
}
