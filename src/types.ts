/** Why an entry left the cache, passed to removal listeners. */
export type RemovalCause =
  | "explicit" // removed by delete()/invalidate()
  | "replaced" // overwritten by a new value for the same key
  | "expired" // removed because its TTL elapsed
  | "size"; // evicted by the size/weight policy

/** Monotonic-ish millisecond clock. Injectable for deterministic tests. */
export type Clock = () => number;

export type RemovalListener<K, V> = (key: K, value: V, cause: RemovalCause) => void;

/** Computes a positive integer weight for an entry (for weight-bounded caches). */
export type Weigher<K, V> = (key: K, value: V) => number;

/**
 * Per-entry expiry calculator. Mirrors Caffeine's `Expiry`.
 *
 * Each hook returns the desired TTL in milliseconds from the current time.
 * Returning `Infinity` means the entry never expires through this policy.
 */
export interface Expiry<K, V> {
  /** TTL for a newly created entry. */
  expireAfterCreate(key: K, value: V, currentTime: number): number;
  /** TTL when an existing entry is overwritten. `currentDuration` is the remaining TTL before the update. */
  expireAfterUpdate(key: K, value: V, currentTime: number, currentDuration: number): number;
  /** TTL when an entry is read. `currentDuration` is the remaining TTL before the read. */
  expireAfterRead(key: K, value: V, currentTime: number, currentDuration: number): number;
}

/** Snapshot of segment occupancy at the moment an event fires. */
export interface Occupancy {
  windowWeight: number;
  probationWeight: number;
  protectedWeight: number;
  weightedSize: number;
  windowMax: number;
  protectedMax: number;
}

/** Observer interface consumed by the cache; implemented by {@link CacheObserver}. */
export interface CacheObserver<K, V> {
  readonly active: boolean;
  emitHit(args: {
    key: K;
    value: V;
    hash: number;
    segment: number;
    freq: number;
    occupancy: Occupancy;
  }): void;
  emitMiss(args: { key: K; occupancy: Occupancy }): void;
  emitAdmit(args: {
    key: K;
    value: V;
    hash: number;
    segment: number;
    freq: number;
    occupancy: Occupancy;
  }): void;
  emitReject(args: {
    key: K;
    value: V;
    hash: number;
    segment: number;
    freq: number;
    occupancy: Occupancy;
  }): void;
  emitPromote(args: { key: K; value: V; hash: number; freq: number; occupancy: Occupancy }): void;
  emitDemote(args: { key: K; value: V; hash: number; freq: number; occupancy: Occupancy }): void;
  emitEvict(args: {
    key: K;
    value: V;
    hash: number;
    segment: number;
    freq: number;
    cause: RemovalCause;
    occupancy: Occupancy;
  }): void;
  emitResize(args: { windowMax: number; protectedMax: number; occupancy: Occupancy }): void;
  emitAge(args: { occupancy: Occupancy }): void;
}

/**
 * Loads a value for a missing key. May be sync or async; receives an optional
 * AbortSignal that fires when the load is superseded/invalidated.
 */
export type AsyncLoader<K, V> = (key: K, signal?: AbortSignal) => Promise<V> | V;

/** Loads many keys in one call, returning the resolved subset. */
export type BulkLoader<K, V> = (
  keys: K[],
  signal?: AbortSignal,
) => Promise<Map<K, V> | Iterable<readonly [K, V]>>;

export interface CacheStats {
  readonly hitCount: number;
  readonly missCount: number;
  readonly hitRate: number;
  readonly evictionCount: number;
  /** Successful async loader completions (loading caches only). */
  readonly loadSuccessCount: number;
  /** Failed async loader completions (loading caches only). */
  readonly loadFailureCount: number;
  /** Total time spent in loaders, in milliseconds. */
  readonly totalLoadTime: number;
}

export interface CacheOptions<K, V> {
  /**
   * Maximum number of entries retained before size-based eviction. Mutually
   * exclusive with {@link maximumWeight}.
   */
  maximumSize?: number;
  /**
   * Maximum total weight retained before eviction. Requires {@link weigher}
   * and is mutually exclusive with {@link maximumSize}.
   */
  maximumWeight?: number;
  /** Computes each entry's weight; required when using {@link maximumWeight}. */
  weigher?: Weigher<K, V>;
  /**
   * Expected steady-state entry count for a weight-bounded cache. Sizes the
   * frequency sketch and the initial store; the store grows past it as needed.
   * Defaults to a small value.
   */
  expectedEntries?: number;
  /** Enable the doorkeeper bloom filter (default true). */
  doorkeeper?: boolean;
  /**
   * Auto-tune the admission-window / main-region ratio via hill-climbing to
   * maximize hit rate on the live workload (default true). Disable for a fixed
   * ~1% window and fully deterministic behavior.
   */
  adaptive?: boolean;
  /** Track hit/miss/eviction statistics (default false, ~zero overhead). */
  recordStats?: boolean;
  /** Opt-in event observer. Zero overhead when not registered. */
  observer?: CacheObserver<K, V>;
  /** Invoked after an entry is removed, evicted, or replaced. */
  removalListener?: RemovalListener<K, V>;
  /**
   * Expire entries this many milliseconds after they were last written
   * (created or overwritten). Requires a positive integer.
   */
  expireAfterWrite?: number;
  /**
   * Expire entries this many milliseconds after they were last accessed
   * (read or written). Requires a positive integer.
   */
  expireAfterAccess?: number;
  /**
   * Per-entry expiry calculator. Mutually exclusive with `expireAfterWrite`
   * and `expireAfterAccess`.
   */
  expireAfter?: Expiry<K, V>;
  /**
   * Time source in milliseconds. Defaults to `Date.now`. Inject a fake clock
   * for deterministic TTL tests, or `performance.now` for a monotonic source.
   */
  clock?: Clock;
}

export interface Cache<K, V> {
  /** Returns the value for `key`, updating recency/frequency, or undefined. */
  get(key: K): V | undefined;
  /** Like get() but does not update recency/frequency or statistics. */
  peek(key: K): V | undefined;
  /** Inserts or updates `key`. */
  set(key: K, value: V): void;
  /** Whether `key` is present (does not update recency). */
  has(key: K): boolean;
  /** Removes `key`; returns true if it was present. */
  delete(key: K): boolean;
  /** Removes all entries. */
  clear(): void;
  /** Alias of {@link get} without loading semantics; returns value or undefined. */
  getIfPresent(key: K): V | undefined;
  /** Inserts or updates every `[key, value]` pair. */
  putAll(entries: Iterable<readonly [K, V]>): void;
  /** Removes `key`. Alias of {@link delete} that returns void. */
  invalidate(key: K): void;
  /** Removes the given keys (or all entries when omitted). */
  invalidateAll(keys?: Iterable<K>): void;
  /**
   * Runs deferred maintenance (TTL reclamation, pending policy work). Safe to
   * call on runtimes without background timers (edge/serverless).
   */
  runMaintenance(): void;
  /** Current number of entries. */
  readonly size: number;
  /** Maximum number of entries. */
  readonly capacity: number;
  /** Snapshot of statistics. */
  stats(): CacheStats;
  /**
   * @internal Attach or detach a runtime event observer. Used by the inspect
   * and dashboard subpaths; not part of the stable public API.
   */
  attachObserver?(observer?: CacheObserver<K, V>): void;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[K, V]>;
  forEach(fn: (value: V, key: K, cache: Cache<K, V>) => void): void;
  /** A live `Map`-like read view over the current entries. */
  asMap(): Map<K, V>;
}

/** Options for an {@link AsyncLoadingCache}: all sync options plus a loader. */
export interface AsyncCacheOptions<K, V> extends CacheOptions<K, V> {
  /** Loads a value for a missing key. */
  loader: AsyncLoader<K, V>;
  /**
   * Pass an AbortSignal to the loader, aborted when a load is superseded
   * (default true where AbortController exists).
   */
  useAbortSignal?: boolean;
}

/** Read-through async cache with request coalescing and race-safe publishing. */
export interface AsyncLoadingCache<K, V> {
  /** Returns the cached value or loads it; concurrent misses coalesce. */
  get(key: K): Promise<V>;
  /** Synchronous peek; never triggers a load. */
  getIfPresent(key: K): V | undefined;
  /** Loads many keys at once, resolving with the available subset. */
  bulkGet(keys: Iterable<K>, bulkLoader?: BulkLoader<K, V>): Promise<Map<K, V>>;
  /** Reloads `key` in the background, serving the old value until it resolves. */
  refresh(key: K): Promise<V>;
  /** Directly inserts/updates a value, superseding any pending load. */
  set(key: K, value: V): void;
  /** Removes `key`, cancelling any pending load. */
  invalidate(key: K): void;
  /** Removes the given keys (or all), cancelling their pending loads. */
  invalidateAll(keys?: Iterable<K>): void;
  has(key: K): boolean;
  runMaintenance(): void;
  stats(): CacheStats;
  readonly size: number;
  readonly capacity: number;
}
