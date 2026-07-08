/** Why an entry left the cache, passed to removal listeners. */
export type RemovalCause =
  | "explicit" // removed by delete()/invalidate()
  | "replaced" // overwritten by a new value for the same key
  | "expired" // removed because its TTL elapsed
  | "size"; // evicted by the size/weight policy

/** Monotonic-ish millisecond clock. Injectable for deterministic tests. */
export type Clock = () => number;

export type RemovalListener<K, V> = (
  key: K,
  value: V,
  cause: RemovalCause,
) => void;

/** Computes a positive integer weight for an entry (for weight-bounded caches). */
export type Weigher<K, V> = (key: K, value: V) => number;

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
  /** Maximum number of entries retained before size-based eviction. */
  maximumSize: number;
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
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[K, V]>;
  forEach(fn: (value: V, key: K, cache: Cache<K, V>) => void): void;
  /** A live `Map`-like read view over the current entries. */
  asMap(): Map<K, V>;
}
