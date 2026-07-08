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
cache.stats();      // { hitCount, missCount, hitRate, evictionCount }
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
| `maximumSize` | `number` | — | Max entries before size-based eviction. |
| `doorkeeper` | `boolean` | `true` | Bloom filter that keeps one-hit-wonders out of the frequency sketch. |
| `adaptive` | `boolean` | `true` | Auto-tune the admission-window/main ratio via hill-climbing to maximize hit rate on the live workload. Disable for a fixed ~1% window and deterministic behavior. |
| `recordStats` | `boolean` | `false` | Track hit/miss/eviction counts (near-zero overhead when off). |
| `removalListener` | `(key, value, cause) => void` | — | Called on eviction/replacement/deletion. `cause` ∈ `"size" | "replaced" | "explicit"`. |

Builder methods (`.recordStats()`, `.doorkeeper(bool)`, `.adaptive(bool)`, `.removalListener(fn)`) mirror the options and return `this`; call `.build()` to get the `Cache`.

## Design

- **Structure-of-Arrays store** — one `Map<K, index>` plus preallocated typed arrays for all linked-list pointers and metadata, and a typed-array free-list. No per-entry object allocation, so GC stays flat at millions of entries.
- **Window-TinyLFU policy** — a small LRU admission window in front of a segmented-LRU (probation + protected) main region, gated by a 4-bit Count-Min Sketch with a doorkeeper and periodic aging.
- **Adaptive window** — a hill-climber continuously re-tunes the window/main split from the observed hit rate, so recency-heavy workloads get a larger window automatically (up to tens of points of extra hit rate) while stable frequency-skewed workloads keep a small window. On by default; `.adaptive(false)` pins it.
- **Batched read maintenance** — cache hits are buffered and drained in batches, keeping the hot `get` path allocation-free and cheap (~6M ops/s at 1M entries).

See `plan.md` for the full roadmap and architecture notes.

## Benchmark

```sh
node --expose-gc --import tsx bench/run.ts
```

## License

MIT
