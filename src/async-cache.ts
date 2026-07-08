import { CaffeineCache } from "./cache.js";
import type { AsyncCacheOptions, AsyncLoadingCache, AsyncLoader, BulkLoader } from "./types.js";

const now: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

/** Tracks a single in-flight loader call so concurrent misses can coalesce and
 * so a settle can verify it still "owns" the key (race-safety via identity). */
class Load<V> {
  settled = false;
  readonly controller?: AbortController;
  promise!: Promise<V>;
  constructor(useSignal: boolean) {
    if (useSignal && typeof AbortController !== "undefined") {
      this.controller = new AbortController();
    }
  }
}

/**
 * Read-through async cache over a synchronous {@link CaffeineCache}.
 *
 * - **Coalescing**: concurrent misses for the same key share one loader call.
 * - **Race-safety**: a load only publishes/settles if it still owns the key at
 *   settle time (identity check), so invalidate/overwrite/refresh racing a
 *   pending load never publishes a stale value.
 * - Pending loads live outside the bounded store, so they neither occupy a
 *   cache slot nor trigger eviction until they resolve.
 */
export class CaffeineAsyncCache<K, V> implements AsyncLoadingCache<K, V> {
  private readonly cache: CaffeineCache<K, V>;
  private readonly loader: AsyncLoader<K, V>;
  private readonly useSignal: boolean;
  private readonly inFlight = new Map<K, Load<V>>();
  private readonly refreshing = new Map<K, Promise<V>>();

  constructor(options: AsyncCacheOptions<K, V>) {
    const { loader, useAbortSignal = true, ...cacheOptions } = options;
    this.cache = new CaffeineCache<K, V>(cacheOptions);
    this.loader = loader;
    this.useSignal = useAbortSignal;
  }

  get size(): number {
    return this.cache.size;
  }

  get capacity(): number {
    return this.cache.capacity;
  }

  /** Returns the cached value, or loads it (coalescing concurrent misses). */
  get(key: K): Promise<V> {
    const present = this.cache.getIfPresent(key);
    if (present !== undefined) return Promise.resolve(present);

    const existing = this.inFlight.get(key);
    if (existing) return existing.promise;

    return this.startLoad(key).promise;
  }

  /** Synchronous peek; never triggers a load. */
  getIfPresent(key: K): V | undefined {
    return this.cache.getIfPresent(key);
  }

  private startLoad(key: K): Load<V> {
    const load = new Load<V>(this.useSignal);
    const started = now();
    let raw: Promise<V>;
    try {
      raw = Promise.resolve(this.loader(key, load.controller?.signal));
    } catch (err) {
      raw = Promise.reject(err);
    }
    load.promise = raw.then(
      (value) => {
        load.settled = true;
        // Only publish if this load still owns the key (no invalidate/set/
        // superseding load happened while we were pending).
        if (this.inFlight.get(key) === load) {
          this.inFlight.delete(key);
          this.cache.set(key, value);
        }
        this.cache.recordLoadSuccess(now() - started);
        return value;
      },
      (err) => {
        load.settled = true;
        if (this.inFlight.get(key) === load) this.inFlight.delete(key);
        this.cache.recordLoadFailure(now() - started);
        throw err;
      },
    );
    this.inFlight.set(key, load);
    return load;
  }

  /**
   * Asynchronously reloads `key`, serving the existing value until the new one
   * resolves. Concurrent refreshes for the same key coalesce. On loader failure
   * the previous value is retained.
   */
  refresh(key: K): Promise<V> {
    const active = this.refreshing.get(key);
    if (active) return active;
    const started = now();
    const controller =
      this.useSignal && typeof AbortController !== "undefined"
        ? new AbortController()
        : undefined;
    let raw: Promise<V>;
    try {
      raw = Promise.resolve(this.loader(key, controller?.signal));
    } catch (err) {
      raw = Promise.reject(err);
    }
    const p = raw.then(
      (value) => {
        // Publish only if this refresh still owns the key (no invalidate/set
        // or newer refresh superseded it).
        if (this.refreshing.get(key) === p) {
          this.refreshing.delete(key);
          this.cache.set(key, value);
        }
        this.cache.recordLoadSuccess(now() - started);
        return value;
      },
      (err) => {
        if (this.refreshing.get(key) === p) this.refreshing.delete(key);
        this.cache.recordLoadFailure(now() - started);
        throw err; // previous value is retained
      },
    );
    this.refreshing.set(key, p);
    return p;
  }

  set(key: K, value: V): void {
    // A direct write supersedes any pending load for the key.
    this.abortInFlight(key);
    this.cache.set(key, value);
  }

  invalidate(key: K): void {
    this.abortInFlight(key);
    this.cache.invalidate(key);
  }

  invalidateAll(keys?: Iterable<K>): void {
    if (keys === undefined) {
      for (const k of [...this.inFlight.keys()]) this.abortInFlight(k);
    } else {
      for (const k of keys) this.abortInFlight(k);
    }
    this.cache.invalidateAll(keys);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  private abortInFlight(key: K): void {
    const load = this.inFlight.get(key);
    if (load) {
      this.inFlight.delete(key); // identity broken → its settle won't publish
      if (!load.settled) load.controller?.abort();
    }
    // Break any in-flight refresh's ownership so it can't overwrite this write.
    this.refreshing.delete(key);
  }

  /**
   * Loads many keys at once. Present keys are served from cache; missing keys
   * are loaded via `bulkLoader` (one call) when provided, else per-key.
   * Resolves with a map of successfully-available values; keys whose load
   * rejects are omitted (their failures are recorded in stats).
   */
  async bulkGet(keys: Iterable<K>, bulkLoader?: BulkLoader<K, V>): Promise<Map<K, V>> {
    const result = new Map<K, V>();
    const missing: K[] = [];
    for (const key of keys) {
      const v = this.cache.getIfPresent(key);
      if (v !== undefined) result.set(key, v);
      else if (!missing.includes(key)) missing.push(key);
    }
    if (missing.length === 0) return result;

    if (bulkLoader) {
      const started = now();
      try {
        const loaded = await bulkLoader(missing);
        const entries = loaded instanceof Map ? loaded : new Map(loaded);
        for (const [k, v] of entries) {
          this.cache.set(k, v);
          result.set(k, v);
        }
        this.cache.recordLoadSuccess(now() - started);
      } catch {
        this.cache.recordLoadFailure(now() - started);
      }
      return result;
    }

    // Per-key path reuses single-key coalescing.
    await Promise.all(
      missing.map((key) =>
        this.get(key).then(
          (v) => result.set(key, v),
          () => undefined,
        ),
      ),
    );
    return result;
  }

  stats() {
    return this.cache.stats();
  }

  runMaintenance(): void {
    this.cache.runMaintenance();
  }

  /** The underlying synchronous cache, for iteration and inspection. */
  get sync(): CaffeineCache<K, V> {
    return this.cache;
  }
}
