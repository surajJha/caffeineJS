import { SoaStore, NIL } from "./store/soa-store.js";
import { WindowTinyLfu } from "./policy/window-tinylfu.js";
import { ExpiryPolicy } from "./policy/expiry.js";
import { hashKey } from "./util/hash.js";
import { wallClockNow } from "./env.js";
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
  private readonly expiry?: ExpiryPolicy;
  private readonly weigher?: (key: K, value: V) => number;
  private readonly maxBound: number;

  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private loadSuccesses = 0;
  private loadFailures = 0;
  private loadTime = 0;

  /** Reused eviction sink to avoid per-op closures. */
  private readonly evictSink: (victim: number) => void;

  /** Post-commit removal queue: records are drained only after cache state is
   * fully consistent, so a listener that re-enters set/delete/clear is safe. */
  private readonly removals: { key: K; value: V; cause: RemovalCause }[] = [];
  private draining = false;

  constructor(options: CacheOptions<K, V>) {
    const {
      maximumSize,
      maximumWeight,
      weigher,
      expectedEntries,
      doorkeeper = true,
      adaptive = true,
      recordStats = false,
      expireAfterWrite,
      expireAfterAccess,
      clock = wallClockNow,
    } = options;

    const weighted = maximumWeight !== undefined;
    if (weighted === (maximumSize !== undefined)) {
      throw new Error(
        "specify exactly one of maximumSize or maximumWeight",
      );
    }
    if (weighted && typeof weigher !== "function") {
      throw new Error("maximumWeight requires a weigher function");
    }
    const w0 = normalizeTtl(expireAfterWrite, "expireAfterWrite");
    const a0 = normalizeTtl(expireAfterAccess, "expireAfterAccess");
    if (weighted && (w0 > 0 || a0 > 0)) {
      throw new Error(
        "TTL (expireAfterWrite/Access) is not supported with maximumWeight in v1",
      );
    }

    if (weighted) {
      const expected = Math.max(1, Math.floor(expectedEntries ?? 1024));
      this.store = new SoaStore<K, V>(expected, true);
      this.policy = new WindowTinyLfu<K, V>(
        this.store,
        doorkeeper,
        adaptive,
        maximumWeight,
        expected,
      );
      this.maxBound = maximumWeight!;
      this.weigher = weigher;
    } else {
      const size = maximumSize!;
      this.store = new SoaStore<K, V>(size + 1, false);
      this.policy = new WindowTinyLfu<K, V>(
        this.store,
        doorkeeper,
        adaptive,
        size,
        size,
      );
      this.maxBound = size;
    }

    this.listener = options.removalListener;
    this.statsEnabled = recordStats;

    if (w0 > 0 || a0 > 0) {
      this.expiry = new ExpiryPolicy(this.store.slotSpace, w0, a0, clock);
    }

    this.evictSink = (victim: number) => {
      const key = this.store.keyAt(victim);
      const value = this.store.valueAt(victim);
      if (this.expiry) this.expiry.onRemove(victim);
      this.store.freeSlot(victim);
      if (this.statsEnabled) this.evictions++;
      if (this.listener) this.enqueue(key, value, "size");
    };
  }

  get capacity(): number {
    return this.maxBound;
  }

  get size(): number {
    return this.store.size;
  }

  get(key: K): V | undefined {
    const idx = this.store.indexOf(key);
    if (idx === NIL) {
      if (this.statsEnabled) this.misses++;
      this.policy.recordSample(false);
      return undefined;
    }
    if (this.expiry) {
      const now = this.expiry.now();
      if (this.expiry.isExpired(idx, now)) {
        this.expireLazy(idx);
        if (this.statsEnabled) this.misses++;
        this.policy.recordSample(false);
        this.deliverRemovals();
        return undefined;
      }
      this.expiry.onAccess(idx, now);
    }
    this.policy.onAccessBuffered(idx);
    this.policy.recordSample(true);
    if (this.statsEnabled) this.hits++;
    return this.store.valueAt(idx);
  }

  peek(key: K): V | undefined {
    const idx = this.store.indexOf(key);
    if (idx === NIL) return undefined;
    if (this.expiry && this.expiry.isExpired(idx, this.expiry.now())) {
      return undefined;
    }
    return this.store.valueAt(idx);
  }

  getIfPresent(key: K): V | undefined {
    return this.get(key);
  }

  set(key: K, value: V): void {
    // Flush deferred reads before any structural change so eviction decisions
    // and slot lifetimes reflect the most recent access order.
    this.policy.drainRead();
    const now = this.expiry ? this.expiry.now() : 0;
    if (this.expiry) this.expiry.advance(now, this.wheelExpire);
    const existing = this.store.indexOf(key);
    if (existing !== NIL) {
      const old = this.store.valueAt(existing);
      const oldW = this.store.weightAt(existing);
      this.store.setValueAt(existing, value);
      const newW = this.weigher ? weight(this.weigher(key, value)) : 1;
      if (newW !== oldW) this.store.setWeightAt(existing, newW);
      this.policy.onAccess(existing);
      if (newW !== oldW) {
        this.policy.onReplaceWeight(existing, oldW, newW, this.evictSink);
      }
      if (this.expiry) this.expiry.onWrite(existing, now, false);
      if (this.listener && old !== value) this.enqueue(key, old, "replaced");
      this.deliverRemovals();
      return;
    }
    const w = this.weigher ? weight(this.weigher(key, value)) : 1;
    const idx = this.store.alloc(key, value, hashKey(key), w);
    // alloc only fails if physical slots are exhausted; the store grows for
    // weight-bounded caches and count-bounded caches hold a +1 overshoot slot.
    if (this.expiry) this.expiry.onWrite(idx, now, true);
    this.policy.onAdd(idx, this.evictSink);
    this.deliverRemovals();
  }

  putAll(entries: Iterable<readonly [K, V]>): void {
    for (const [k, v] of entries) this.set(k, v);
  }

  has(key: K): boolean {
    const idx = this.store.indexOf(key);
    if (idx === NIL) return false;
    if (this.expiry && this.expiry.isExpired(idx, this.expiry.now())) {
      return false;
    }
    return true;
  }

  delete(key: K): boolean {
    this.policy.drainRead();
    const idx = this.store.indexOf(key);
    if (idx === NIL) return false;
    const value = this.store.valueAt(idx);
    const expired =
      this.expiry !== undefined && this.expiry.isExpired(idx, this.expiry.now());
    this.policy.onRemove(idx);
    if (this.expiry) this.expiry.onRemove(idx);
    this.store.freeSlot(idx);
    if (this.listener) this.enqueue(key, value, expired ? "expired" : "explicit");
    this.deliverRemovals();
    return !expired;
  }

  invalidate(key: K): void {
    this.delete(key);
  }

  invalidateAll(keys?: Iterable<K>): void {
    if (keys === undefined) {
      this.clear();
      return;
    }
    for (const k of keys) this.delete(k);
  }

  clear(): void {
    if (this.listener) {
      for (const idx of this.store.slots()) {
        this.enqueue(this.store.keyAt(idx), this.store.valueAt(idx), "explicit");
      }
    }
    if (this.expiry) this.expiry.reset(this.store.slots());
    this.store.clear();
    this.policy.reset();
    this.deliverRemovals();
  }

  runMaintenance(): void {
    this.policy.drainRead();
    if (this.expiry) this.expiry.advance(this.expiry.now(), this.wheelExpire);
    this.deliverRemovals();
  }

  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hitCount: this.hits,
      missCount: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
      evictionCount: this.evictions,
      loadSuccessCount: this.loadSuccesses,
      loadFailureCount: this.loadFailures,
      totalLoadTime: this.loadTime,
    };
  }

  /** @internal Used by the async loading cache to fold in loader outcomes. */
  recordLoadSuccess(timeMs: number): void {
    if (this.statsEnabled) {
      this.loadSuccesses++;
      this.loadTime += timeMs;
    }
  }

  /** @internal Used by the async loading cache to fold in loader outcomes. */
  recordLoadFailure(timeMs: number): void {
    if (this.statsEnabled) {
      this.loadFailures++;
      this.loadTime += timeMs;
    }
  }

  *keys(): IterableIterator<K> {
    for (const idx of this.liveSlots()) yield this.store.keyAt(idx);
  }

  *values(): IterableIterator<V> {
    for (const idx of this.liveSlots()) yield this.store.valueAt(idx);
  }

  *entries(): IterableIterator<[K, V]> {
    for (const idx of this.liveSlots()) {
      yield [this.store.keyAt(idx), this.store.valueAt(idx)];
    }
  }

  forEach(fn: (value: V, key: K, cache: Cache<K, V>) => void): void {
    for (const idx of this.liveSlots()) {
      fn(this.store.valueAt(idx), this.store.keyAt(idx), this);
    }
  }

  asMap(): Map<K, V> {
    const map = new Map<K, V>();
    for (const idx of this.liveSlots()) {
      map.set(this.store.keyAt(idx), this.store.valueAt(idx));
    }
    return map;
  }

  /** Iterates slots, skipping (but not reclaiming) entries that have expired. */
  private *liveSlots(): IterableIterator<number> {
    if (!this.expiry) {
      yield* this.store.slots();
      return;
    }
    const now = this.expiry.now();
    for (const idx of this.store.slots()) {
      if (!this.expiry.isExpired(idx, now)) yield idx;
    }
  }

  /** Reclaims an entry found expired on the access path (still wheel-scheduled). */
  private expireLazy(idx: number): void {
    const key = this.store.keyAt(idx);
    const value = this.store.valueAt(idx);
    this.policy.onRemove(idx);
    this.expiry!.onRemove(idx);
    this.store.freeSlot(idx);
    if (this.statsEnabled) this.evictions++;
    if (this.listener) this.enqueue(key, value, "expired");
  }

  /** Reclaims an entry the timer wheel already detached (do not deschedule). */
  private readonly wheelExpire = (idx: number): void => {
    const key = this.store.keyAt(idx);
    const value = this.store.valueAt(idx);
    this.policy.onRemove(idx);
    this.expiry!.clearDeadline(idx);
    this.store.freeSlot(idx);
    if (this.statsEnabled) this.evictions++;
    if (this.listener) this.enqueue(key, value, "expired");
  };

  private enqueue(key: K, value: V, cause: RemovalCause): void {
    this.removals.push({ key, value, cause });
  }

  /** Delivers queued removal records after state is consistent. Re-entrant
   * calls are coalesced into the active drain so listeners can mutate safely. */
  private deliverRemovals(): void {
    if (!this.listener || this.draining) return;
    this.draining = true;
    try {
      while (this.removals.length > 0) {
        const r = this.removals.shift()!;
        try {
          this.listener(r.key, r.value, r.cause);
        } catch {
          // Listener errors must not corrupt cache state or halt delivery.
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

function normalizeTtl(value: number | undefined, name: string): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number of milliseconds`);
  }
  return value;
}

/** Coerces a weigher result to a non-negative finite number. */
function weight(w: number): number {
  if (!Number.isFinite(w) || w < 0) {
    throw new Error("weigher must return a non-negative finite number");
  }
  return w;
}
