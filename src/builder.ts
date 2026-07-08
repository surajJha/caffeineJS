import { CaffeineCache } from "./cache.js";
import type { Cache, CacheOptions, RemovalListener } from "./types.js";

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

  /** Enable/disable adaptive hill-climbing window sizing (default on). */
  adaptive(enabled = true): this {
    this.options.adaptive = enabled;
    return this;
  }

  removalListener(listener: RemovalListener<K, V>): this {
    this.options.removalListener = listener;
    return this;
  }

  build(): Cache<K, V> {
    return new CaffeineCache<K, V>(this.options);
  }
}

export function caffeine<K, V>(
  options: CacheOptions<K, V>,
): CacheBuilder<K, V> {
  return new CacheBuilder<K, V>(options);
}
