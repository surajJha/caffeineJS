import { SoaStore, NIL } from "./store/soa-store.js";
import { WindowTinyLfu } from "./policy/window-tinylfu.js";
import { hashKey } from "./util/hash.js";
import type {
  Cache,
  CacheOptions,
  CacheStats,
  RemovalCause,
  RemovalListener,
} from "./types.js";

/**
 * A bounded in-memory cache using the Window-TinyLFU eviction policy over a
 * Structure-of-Arrays store. Synchronous and single-threaded.
 */
export class CaffeineCache<K, V> implements Cache<K, V> {
  private readonly store: SoaStore<K, V>;
  private readonly policy: WindowTinyLfu<K, V>;
  private readonly listener?: RemovalListener<K, V>;
  private readonly statsEnabled: boolean;

  private hits = 0;
  private misses = 0;
  private evictions = 0;

  /** Reused eviction sink to avoid per-op closures. */
  private readonly evictSink: (victim: number) => void;

  constructor(options: CacheOptions<K, V>) {
    const { maximumSize, doorkeeper = true, recordStats = false } = options;
    this.store = new SoaStore<K, V>(maximumSize);
    this.policy = new WindowTinyLfu<K, V>(this.store, doorkeeper);
    this.listener = options.removalListener;
    this.statsEnabled = recordStats;

    this.evictSink = (victim: number) => {
      const key = this.store.keyAt(victim);
      const value = this.store.valueAt(victim);
      this.store.freeSlot(victim);
      if (this.statsEnabled) this.evictions++;
      if (this.listener) this.emit(key, value, "size");
    };
  }

  get capacity(): number {
    return this.store.capacity;
  }

  get size(): number {
    return this.store.size;
  }

  get(key: K): V | undefined {
    const idx = this.store.indexOf(key);
    if (idx === NIL) {
      if (this.statsEnabled) this.misses++;
      return undefined;
    }
    this.policy.onAccess(idx);
    if (this.statsEnabled) this.hits++;
    return this.store.valueAt(idx);
  }

  peek(key: K): V | undefined {
    const idx = this.store.indexOf(key);
    return idx === NIL ? undefined : this.store.valueAt(idx);
  }

  set(key: K, value: V): void {
    const existing = this.store.indexOf(key);
    if (existing !== NIL) {
      const old = this.store.valueAt(existing);
      this.store.setValueAt(existing, value);
      this.policy.onAccess(existing);
      if (this.listener && old !== value) this.emit(key, old, "replaced");
      return;
    }
    const idx = this.store.alloc(key, value, hashKey(key), 1);
    // alloc only fails if physical slots are exhausted, which cannot happen:
    // we hold capacity+1 slots and evict back to capacity on every add.
    this.policy.onAdd(idx, this.evictSink);
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  delete(key: K): boolean {
    const idx = this.store.indexOf(key);
    if (idx === NIL) return false;
    const value = this.store.valueAt(idx);
    this.policy.onRemove(idx);
    this.store.freeSlot(idx);
    if (this.listener) this.emit(key, value, "explicit");
    return true;
  }

  clear(): void {
    if (this.listener) {
      for (const idx of this.store.slots()) {
        this.emit(this.store.keyAt(idx), this.store.valueAt(idx), "explicit");
      }
    }
    this.store.clear();
    this.policy.reset();
  }

  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hitCount: this.hits,
      missCount: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
      evictionCount: this.evictions,
    };
  }

  *keys(): IterableIterator<K> {
    for (const idx of this.store.slots()) yield this.store.keyAt(idx);
  }

  *values(): IterableIterator<V> {
    for (const idx of this.store.slots()) yield this.store.valueAt(idx);
  }

  *entries(): IterableIterator<[K, V]> {
    for (const idx of this.store.slots()) {
      yield [this.store.keyAt(idx), this.store.valueAt(idx)];
    }
  }

  forEach(fn: (value: V, key: K, cache: Cache<K, V>) => void): void {
    for (const idx of this.store.slots()) {
      fn(this.store.valueAt(idx), this.store.keyAt(idx), this);
    }
  }

  private emit(key: K, value: V, cause: RemovalCause): void {
    try {
      this.listener!(key, value, cause);
    } catch {
      // Listener errors must not corrupt cache state.
    }
  }
}
