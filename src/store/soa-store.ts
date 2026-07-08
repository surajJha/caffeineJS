/**
 * Unified Structure-of-Arrays store for the whole cache.
 *
 * Every live entry occupies one integer slot. All structural metadata lives in
 * preallocated typed arrays indexed by slot, so there is NO per-entry object
 * allocation — the dominant scaling cost in V8. Keys and values must stay in
 * plain arrays (they are arbitrary JS references).
 *
 * A single index space is shared across all three W-TinyLFU queues (window,
 * probation, protected). Each queue is a circular doubly-linked list threaded
 * through a sentinel slot. Sentinels occupy the three FIXED low indices 0,1,2
 * so that the store can grow (for weight-bounded caches) by appending slots at
 * the high end without relocating any sentinel:
 *
 *   sentinel.next = MRU (most-recently-used)   sentinel.prev = LRU (evict here)
 *
 * Real entry slots start at {@link OFFSET}. Freed slots are recycled through a
 * typed-array free-list stack; when the free-list empties and the store is
 * growable, the backing arrays double.
 */
export const NIL = -1;

/** Real entry slots start after the three queue sentinels. */
const OFFSET = 3;

export class SoaStore<K, V> {
  /** Fixed sentinel indices (shared with the policy). */
  readonly WINDOW_HEAD = 0;
  readonly PROBATION_HEAD = 1;
  readonly PROTECTED_HEAD = 2;

  /** Current physical entry-slot capacity (grows for weight-bounded caches). */
  private cap: number;
  private readonly growable: boolean;

  private next: Int32Array;
  private prev: Int32Array;
  private keys: (K | undefined)[];
  private vals: (V | undefined)[];
  private hashes: Int32Array;
  private weights: Float64Array;
  /** 0 = window, 1 = probation, 2 = protected. */
  segment: Uint8Array;

  private readonly keyMap = new Map<K, number>();
  private free: Int32Array;
  private freeTop: number;

  constructor(initialCapacity: number, growable = false) {
    if (!Number.isInteger(initialCapacity) || initialCapacity < 1) {
      throw new Error("capacity must be a positive integer");
    }
    this.cap = initialCapacity;
    this.growable = growable;
    const slots = OFFSET + initialCapacity;

    this.next = new Int32Array(slots);
    this.prev = new Int32Array(slots);
    this.keys = new Array(slots).fill(undefined);
    this.vals = new Array(slots).fill(undefined);
    this.hashes = new Int32Array(slots);
    this.weights = new Float64Array(slots);
    this.segment = new Uint8Array(slots);

    this.free = new Int32Array(initialCapacity);
    for (let i = 0; i < initialCapacity; i++) this.free[i] = OFFSET + i;
    this.freeTop = initialCapacity;

    for (const h of [this.WINDOW_HEAD, this.PROBATION_HEAD, this.PROTECTED_HEAD]) {
      this.next[h] = h;
      this.prev[h] = h;
    }
  }

  /** Current physical slot capacity. */
  get capacity(): number {
    return this.cap;
  }

  /** Exclusive upper bound on slot indices (for sizing parallel arrays). */
  get slotSpace(): number {
    return OFFSET + this.cap;
  }

  get size(): number {
    return this.keyMap.size;
  }

  indexOf(key: K): number {
    const i = this.keyMap.get(key);
    return i === undefined ? NIL : i;
  }

  has(key: K): boolean {
    return this.keyMap.has(key);
  }

  keyAt(i: number): K {
    return this.keys[i] as K;
  }

  valueAt(i: number): V {
    return this.vals[i] as V;
  }

  setValueAt(i: number, v: V): void {
    this.vals[i] = v;
  }

  hashAt(i: number): number {
    return this.hashes[i] as number;
  }

  weightAt(i: number): number {
    return this.weights[i] as number;
  }

  setWeightAt(i: number, w: number): void {
    this.weights[i] = w;
  }

  /**
   * Reserves a slot for a new key. The slot is unlinked (belongs to no queue
   * yet); the caller must link it into a segment. Grows the store if full and
   * growable; returns NIL only if full and not growable.
   */
  alloc(key: K, value: V, hash: number, weight: number): number {
    if (this.freeTop === 0) {
      if (!this.growable) return NIL;
      this.grow();
    }
    const i = this.free[--this.freeTop] as number;
    this.keys[i] = key;
    this.vals[i] = value;
    this.hashes[i] = hash | 0;
    this.weights[i] = weight;
    this.keyMap.set(key, i);
    return i;
  }

  private grow(): void {
    const oldCap = this.cap;
    const newCap = oldCap * 2;
    const newSlots = OFFSET + newCap;

    this.next = growInt32(this.next, newSlots);
    this.prev = growInt32(this.prev, newSlots);
    this.hashes = growInt32(this.hashes, newSlots);
    this.weights = growFloat64(this.weights, newSlots);
    this.segment = growUint8(this.segment, newSlots);
    this.keys.length = newSlots;
    this.vals.length = newSlots;

    // The free-list was empty; refill it with the freshly added high slots.
    this.free = new Int32Array(newCap);
    let top = 0;
    for (let i = OFFSET + oldCap; i < newSlots; i++) this.free[top++] = i;
    this.freeTop = top;
    this.cap = newCap;
  }

  /**
   * Releases a slot back to the free-list and drops its key/value references.
   * The slot must already be unlinked from its queue.
   */
  freeSlot(i: number): void {
    this.keyMap.delete(this.keys[i] as K);
    this.keys[i] = undefined;
    this.vals[i] = undefined;
    if (this.freeTop >= this.free.length) {
      // Only reachable in growable mode when the free-list is smaller than the
      // live count would allow; grow the free-list to admit the returned slot.
      const bigger = new Int32Array(this.free.length * 2 || 1);
      bigger.set(this.free);
      this.free = bigger;
    }
    this.free[this.freeTop++] = i;
  }

  // --- Doubly-linked list primitives (over the shared index space) ---

  front(head: number): number {
    const f = this.next[head] as number;
    return f === head ? NIL : f;
  }

  back(head: number): number {
    const b = this.prev[head] as number;
    return b === head ? NIL : b;
  }

  isEmpty(head: number): boolean {
    return (this.next[head] as number) === head;
  }

  unlink(i: number): void {
    const p = this.prev[i] as number;
    const n = this.next[i] as number;
    this.next[p] = n;
    this.prev[n] = p;
  }

  pushFront(head: number, i: number): void {
    const first = this.next[head] as number;
    this.next[i] = first;
    this.prev[i] = head;
    this.next[head] = i;
    this.prev[first] = i;
  }

  clear(): void {
    this.keyMap.clear();
    this.keys.fill(undefined);
    this.vals.fill(undefined);
    this.free = new Int32Array(this.cap);
    for (let i = 0; i < this.cap; i++) this.free[i] = OFFSET + i;
    this.freeTop = this.cap;
    for (const h of [this.WINDOW_HEAD, this.PROBATION_HEAD, this.PROTECTED_HEAD]) {
      this.next[h] = h;
      this.prev[h] = h;
    }
  }

  *slots(): IterableIterator<number> {
    for (const i of this.keyMap.values()) yield i;
  }
}

function growInt32(old: Int32Array, n: number): Int32Array {
  const arr = new Int32Array(n);
  arr.set(old);
  return arr;
}
function growFloat64(old: Float64Array, n: number): Float64Array {
  const arr = new Float64Array(n);
  arr.set(old);
  return arr;
}
function growUint8(old: Uint8Array, n: number): Uint8Array {
  const arr = new Uint8Array(n);
  arr.set(old);
  return arr;
}
