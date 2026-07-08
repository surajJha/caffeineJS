import { CaffeineCache } from "./cache.js";
import { CaffeineAsyncCache } from "./async-cache.js";
import type {
  AsyncLoader,
  AsyncLoadingCache,
  Cache,
  CacheOptions,
  RemovalListener,
} from "./types.js";

/**
 * Fluent builder for a {@link Cache}. Also accepts a plain options object.
 *
 * @example
 * const cache = caffeine<string, User>({ maximumSize: 10_000 })
 *   .recordStats()
 *   .removalListener((k, v, cause) => log(cause))
 *   .build();
 */
export class CacheBuilder<K, V> {
  private readonly options: CacheOptions<K, V>;

  constructor(options: CacheOptions<K, V>) {
    this.options = { ...options };
  }

  recordStats(enabled = true): this {
    this.options.recordStats = enabled;
    return this;
  }

  doorkeeper(enabled: boolean): this {
    this.options.doorkeeper = enabled;
    return this;
  }

  /** Bound the cache by total weight instead of entry count. */
  maximumWeight(max: number, weigher: (key: K, value: V) => number): this {
    this.options.maximumWeight = max;
    this.options.weigher = weigher;
    delete this.options.maximumSize;
    return this;
  }

  /** Bound the cache by entry count. */
  maximumSize(max: number): this {
    this.options.maximumSize = max;
    delete this.options.maximumWeight;
    delete this.options.weigher;
    return this;
  }

  /** Hint the expected steady-state entry count (weight-bounded caches). */
  expectedEntries(n: number): this {
    this.options.expectedEntries = n;
    return this;
  }

  /** Enable/disable adaptive hill-climbing window sizing (default on). */
  adaptive(enabled = true): this {
    this.options.adaptive = enabled;
    return this;
  }

  /** Expire entries `ms` after their last write (create/overwrite). */
  expireAfterWrite(ms: number): this {
    this.options.expireAfterWrite = ms;
    return this;
  }

  /** Expire entries `ms` after their last access (read or write). */
  expireAfterAccess(ms: number): this {
    this.options.expireAfterAccess = ms;
    return this;
  }

  /** Inject a millisecond time source (default `Date.now`). */
  clock(clock: () => number): this {
    this.options.clock = clock;
    return this;
  }

  removalListener(listener: RemovalListener<K, V>): this {
    this.options.removalListener = listener;
    return this;
  }

  build(): Cache<K, V> {
    return new CaffeineCache<K, V>(this.options);
  }

  /** Builds a read-through async cache backed by `loader`. */
  buildAsync(loader: AsyncLoader<K, V>): AsyncLoadingCache<K, V> {
    return new CaffeineAsyncCache<K, V>({ ...this.options, loader });
  }
}

export function caffeine<K, V>(
  options: CacheOptions<K, V>,
): CacheBuilder<K, V> {
  return new CacheBuilder<K, V>(options);
}
