/**
 * Approximate in-memory byte size of a cache entry.
 *
 * JavaScript cannot measure exact object sizes at runtime, so this is a
 * heuristic intended for **approximate** byte-capacity caches (e.g. "keep the
 * cache near 1 GB"), not precise accounting. It deliberately errs toward
 * over-counting: every entry includes a fixed per-entry overhead to account for
 * the Map slot, typed-array metadata, and hidden-class pointers the cache keeps
 * per key.
 *
 * Use it as a weigher:
 *
 *   caffeine<string, Payload>({})
 *     .maximumWeight(1 << 30, estimateBytes) // ~1 GiB
 *     .build();
 */

/** Fixed bookkeeping overhead charged per entry (Map slot + SoA metadata). */
export const ENTRY_OVERHEAD_BYTES = 220;

/** Maximum object nesting depth walked before falling back to a flat estimate. */
const MAX_DEPTH = 6;

/** Estimates the combined byte size of a key and value, plus fixed overhead. */
export function estimateBytes(key: unknown, value: unknown): number {
  return (
    ENTRY_OVERHEAD_BYTES + sizeOf(key, 0, new Set()) + sizeOf(value, 0, new Set())
  );
}

/** Estimates the byte size of a single JavaScript value. */
export function sizeOfValue(value: unknown): number {
  return sizeOf(value, 0, new Set());
}

function sizeOf(v: unknown, depth: number, seen: Set<object>): number {
  switch (typeof v) {
    case "undefined":
      return 0;
    case "boolean":
      return 4;
    case "number":
      return 8;
    case "bigint":
      return 16;
    case "symbol":
      return 16;
    case "string":
      // UTF-16 code units plus a small header.
      return v.length * 2 + 16;
    case "function":
      return 64; // opaque; charge a nominal cost
    case "object":
      break;
    default:
      return 8;
  }

  if (v === null) return 0;
  const obj = v as object;

  if (seen.has(obj)) return 0; // cycle guard
  seen.add(obj);

  // Typed arrays / ArrayBuffers report their exact byte length.
  if (ArrayBuffer.isView(obj)) {
    return (obj as ArrayBufferView).byteLength + 32;
  }
  if (obj instanceof ArrayBuffer) {
    return obj.byteLength + 32;
  }
  if (obj instanceof Date) return 24;

  if (depth >= MAX_DEPTH) return 64; // stop walking; flat estimate

  if (Array.isArray(obj)) {
    let total = 32;
    for (const el of obj) total += sizeOf(el, depth + 1, seen);
    return total;
  }

  if (obj instanceof Map) {
    let total = 48;
    for (const [k, val] of obj) {
      total += sizeOf(k, depth + 1, seen) + sizeOf(val, depth + 1, seen);
    }
    return total;
  }

  if (obj instanceof Set) {
    let total = 48;
    for (const el of obj) total += sizeOf(el, depth + 1, seen);
    return total;
  }

  // Plain object: sum own enumerable keys and their values.
  let total = 40;
  for (const k in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      total += k.length * 2 + 16;
      total += sizeOf((obj as Record<string, unknown>)[k], depth + 1, seen);
    }
  }
  return total;
}
