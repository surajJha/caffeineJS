import {
  allocUintArray,
  getUintArrayCtor,
  type UintArray,
} from "../util/typed-array.js";

/**
 * Unified Structure-of-Arrays store for the whole cache.
 *
 * Every live entry occupies one integer slot (0..capacity-1). All structural
 * metadata lives in preallocated typed arrays indexed by slot, so there is
 * NO per-entry object allocation — the dominant scaling cost in V8. Keys and
 * values must stay in plain arrays (they are arbitrary JS references).
 *
 * A single index space is shared across all three W-TinyLFU queues (window,
 * probation, protected). Each queue is a circular doubly-linked list threaded
 * through a sentinel slot appended after the real slots:
 *
 *   sentinel.next = MRU (most-recently-used)   sentinel.prev = LRU (evict here)
 *
 * Freed slots are recycled through a typed-array free-list stack.
 */
export const NIL = -1;

export class SoaStore<K, V> {
  readonly capacity: number;

  // Sentinel slot indices (appended after real slots).
  readonly WINDOW_HEAD: number;
  readonly PROBATION_HEAD: number;
  readonly PROTECTED_HEAD: number;

  private readonly next: UintArray;
  private readonly prev: UintArray;
  private readonly keys: (K | undefined)[];
  private readonly vals: (V | undefined)[];
  private readonly hashes: Int32Array;
  readonly weights: Float64Array;
  /** 0 = window, 1 = probation, 2 = protected. */
  readonly segment: Uint8Array;

  private readonly keyMap = new Map<K, number>();
  private readonly free: UintArray;
  private freeTop: number;

  /** Physical slots = logical capacity + 1, to hold the transient overshoot
   * while W-TinyLFU adds a new entry before evicting one. */
  private readonly physical: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("capacity must be a positive integer");
    }
    this.capacity = capacity;
    const physical = capacity + 1;
    this.physical = physical;
    const slots = physical + 3;
    this.WINDOW_HEAD = physical;
    this.PROBATION_HEAD = physical + 1;
    this.PROTECTED_HEAD = physical + 2;

    this.next = allocUintArray(slots);
    this.prev = allocUintArray(slots);
    this.keys = new Array(physical).fill(undefined);
    this.vals = new Array(physical).fill(undefined);
    this.hashes = new Int32Array(physical);
    this.weights = new Float64Array(physical);
    this.segment = new Uint8Array(physical);

    // Free-list holds every real slot initially (top of stack = physical-1).
    const FreeCtor = getUintArrayCtor(physical);
    this.free = new FreeCtor(physical);
    for (let i = 0; i < physical; i++) this.free[i] = i;
    this.freeTop = physical;

    // Each sentinel initially points to itself (empty circular list).
    for (const h of [this.WINDOW_HEAD, this.PROBATION_HEAD, this.PROTECTED_HEAD]) {
      this.next[h] = h;
      this.prev[h] = h;
    }
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

  /**
   * Reserves a slot for a new key. The slot is unlinked (belongs to no queue
   * yet); the caller must link it into a segment. Returns NIL if the store is
   * full (no free slots).
   */
  alloc(key: K, value: V, hash: number, weight: number): number {
    if (this.freeTop === 0) return NIL;
    const i = this.free[--this.freeTop] as number;
    this.keys[i] = key;
    this.vals[i] = value;
    this.hashes[i] = hash | 0;
    this.weights[i] = weight;
    this.keyMap.set(key, i);
    return i;
  }

  /**
   * Releases a slot back to the free-list and drops its key/value references.
   * The slot must already be unlinked from its queue.
   */
  freeSlot(i: number): void {
    this.keyMap.delete(this.keys[i] as K);
    this.keys[i] = undefined;
    this.vals[i] = undefined;
    this.free[this.freeTop++] = i;
  }

  // --- Doubly-linked list primitives (over the shared index space) ---

  /** Most-recently-used entry of a queue, or NIL if empty. */
  front(head: number): number {
    const f = this.next[head] as number;
    return f === head ? NIL : f;
  }

  /** Least-recently-used entry of a queue (eviction candidate), or NIL. */
  back(head: number): number {
    const b = this.prev[head] as number;
    return b === head ? NIL : b;
  }

  isEmpty(head: number): boolean {
    return (this.next[head] as number) === head;
  }

  /** Detaches slot `i` from whatever list it is currently in. */
  unlink(i: number): void {
    const p = this.prev[i] as number;
    const n = this.next[i] as number;
    this.next[p] = n;
    this.prev[n] = p;
  }

  /** Inserts slot `i` at the MRU position (just after the sentinel). */
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
    for (let i = 0; i < this.physical; i++) this.free[i] = i;
    this.freeTop = this.physical;
    for (const h of [this.WINDOW_HEAD, this.PROBATION_HEAD, this.PROTECTED_HEAD]) {
      this.next[h] = h;
      this.prev[h] = h;
    }
  }

  /** Iterates live slots in unspecified order. */
  *slots(): IterableIterator<number> {
    for (const i of this.keyMap.values()) yield i;
  }
}
