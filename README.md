# caffeine-js

> High-performance, isomorphic in-memory cache for JavaScript & TypeScript, built on the **Window-TinyLFU** admission policy. Higher hit ratios than LRU/LFU. Zero runtime dependencies. Runs in Node, browsers, Deno, Bun, and edge runtimes.

**Status: early development (v0).** The core cache, W-TinyLFU policy, and Structure-of-Arrays store are implemented and tested. TTL, weights, async loading, and observability are on the roadmap (see `plan.md`).

## Why

A plain LRU evicts the least *recently* used item, which throws away frequently-used entries during scans or bursts. **W-TinyLFU** keeps a compact frequency sketch and only admits a new entry if it is estimated to be more valuable than the one it would evict. On skewed (real-world) workloads this nearly triples the hit ratio versus LRU:

```
capacity 1M, skewed stream 2M ops:  caffeine-js hit rate 0.905  vs  lru-cache 0.332
```

## Install

```sh
npm install caffeine-js
```

## Usage

```ts
import { caffeine } from "caffeine-js";

const cache = caffeine<string, number>({ maximumSize: 10_000 })
  .recordStats()
  .removalListener((key, value, cause) => console.log("removed", key, cause))
  .build();

cache.set("a", 1);
cache.get("a");     // 1
cache.peek("a");    // 1 (no recency/stats update)
cache.has("a");     // true
cache.delete("a");  // true
cache.size;         // number of entries
cache.stats();      // { hitCount, missCount, hitRate, evictionCount, loadSuccessCount, loadFailureCount, totalLoadTime }
```

### TTL, weight bounding, and async loading

```ts
import { caffeine } from "caffeine-js";
import { estimateBytes } from "caffeine-js/estimate";

// Time-based expiry (injectable clock; no setInterval — lazy + timer wheel).
const ttl = caffeine<string, string>({})
  .maximumSize(10_000)
  .expireAfterWrite(60_000)   // 60s after last write
  .expireAfterAccess(30_000)  // and/or 30s after last read
  .build();

// Approximate byte-bounded cache (~256 MiB): bound by weight, not count.
const bytes = caffeine<string, Buffer>({})
  .maximumWeight(256 * 1024 * 1024, estimateBytes)
  .build();

// Read-through async cache with request coalescing + race-safe publishing.
const loading = caffeine<string, User>({})
  .maximumSize(50_000)
  .buildAsync(async (id, signal) => fetchUser(id, signal));

const user = await loading.get("42"); // loads once even under concurrent misses
await loading.refresh("42");          // serves old value until the reload lands
```


Works with `require` too:

```js
const { caffeine } = require("caffeine-js");
```

Any key type is supported, including objects (compared by reference, like `Map`):

```ts
const byRef = caffeine<object, string>({ maximumSize: 100 }).build();
const key = { id: 1 };
byRef.set(key, "value");
byRef.get(key);        // "value"
byRef.get({ id: 1 });  // undefined — different object identity
```

## API

`caffeine(options)` returns a builder:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maximumSize` | `number` | — | Max entries before size-based eviction. Mutually exclusive with `maximumWeight`. |
| `maximumWeight` | `number` | — | Max total weight before eviction. Requires `weigher`. |
| `weigher` | `(key, value) => number` | — | Per-entry weight for weight-bounded caches. |
| `expectedEntries` | `number` | `1024` | Steady-state entry-count hint for weight-bounded caches (sizes the sketch/store; the store grows past it). |
| `expireAfterWrite` | `number` (ms) | — | Expire entries this long after their last write. |
| `expireAfterAccess` | `number` (ms) | — | Expire entries this long after their last read/write. |
| `clock` | `() => number` | `Date.now` | Injectable millisecond clock (deterministic tests, `performance.now`). |
| `doorkeeper` | `boolean` | `true` | Bloom filter that keeps one-hit-wonders out of the frequency sketch. |
| `adaptive` | `boolean` | `true` | Auto-tune the admission-window/main ratio via hill-climbing to maximize hit rate on the live workload. Disable for a fixed ~1% window and deterministic behavior. |
| `recordStats` | `boolean` | `false` | Track hit/miss/eviction/load counts (near-zero overhead when off). |
| `removalListener` | `(key, value, cause) => void` | — | Called after eviction/replacement/deletion/expiry. `cause` ∈ `"size" \| "replaced" \| "explicit" \| "expired"`. |

Builder methods mirror the options (`.maximumSize(n)`, `.maximumWeight(n, weigher)`, `.expectedEntries(n)`, `.expireAfterWrite(ms)`, `.expireAfterAccess(ms)`, `.clock(fn)`, `.recordStats()`, `.doorkeeper(bool)`, `.adaptive(bool)`, `.removalListener(fn)`) and return `this`; call `.build()` for a `Cache`, or `.buildAsync(loader)` for an `AsyncLoadingCache`.

The `Cache` surface includes `get`/`set`/`peek`/`has`/`delete`/`clear`, the utilities `getIfPresent`/`putAll`/`invalidate`/`invalidateAll`/`asMap`, iteration (`keys`/`values`/`entries`/`forEach`), `stats()`, and `runMaintenance()` (call it on edge/serverless runtimes to reclaim expired entries without background timers).

## Design

- **Structure-of-Arrays store** — one `Map<K, index>` plus preallocated typed arrays for all linked-list pointers and metadata, and a typed-array free-list. No per-entry object allocation, so GC stays flat at millions of entries.
- **Window-TinyLFU policy** — a small LRU admission window in front of a segmented-LRU (probation + protected) main region, gated by a 4-bit Count-Min Sketch with a doorkeeper and periodic aging.
- **Adaptive window** — a hill-climber continuously re-tunes the window/main split from the observed hit rate, so recency-heavy workloads get a larger window automatically (up to tens of points of extra hit rate) while stable frequency-skewed workloads keep a small window. On by default; `.adaptive(false)` pins it.
- **Batched read maintenance** — cache hits are buffered and drained in batches, keeping the hot `get` path allocation-free and cheap (~6M ops/s at 1M entries).
- **Weight-bounded core** — the policy is bounded by total weight; a count-bounded cache is just the special case where every entry has weight 1. Pair `maximumWeight` with `estimateBytes` (from `caffeine-js/estimate`) for approximate byte-capacity caches. The Structure-of-Arrays store grows on demand for weight-bounded caches.
- **TTL via a hierarchical timer wheel** — `expireAfterWrite`/`expireAfterAccess` use lazy expiry on access plus a 5-level timer wheel for O(1) amortized reclamation, with an injectable clock and **no `setInterval`** (call `runMaintenance()` on edge runtimes).
- **Async loading** — `buildAsync(loader)` gives a read-through cache with request coalescing (concurrent misses share one loader call), race-safe publishing via load-identity tokens, `refresh()`, `bulkGet()`, and `AbortSignal` support.
- **Post-commit removal listeners** — removal callbacks fire only after cache state is fully consistent, so a listener may safely re-enter `set`/`delete`/`clear`; listener errors are isolated.

See `plan.md` for the full roadmap and architecture notes.

## Benchmark

```sh
node --expose-gc --import tsx bench/run.ts
```

## License

MIT
