# caffeine-js

> High-performance, isomorphic in-memory cache for JavaScript & TypeScript, built on the **Window-TinyLFU** admission policy. Zero runtime dependencies. Runs in Node.js, browsers, Deno, Bun, and edge runtimes.

**Status: production-ready (v1.0.0).** The core cache, W-TinyLFU policy, Structure-of-Arrays store, TTL, weighted/byte bounding, async loading, React adapter, CLI inspector, browser dashboard, and cross-runtime env shims are implemented and tested.

## Why Window-TinyLFU?

A plain LRU evicts the least _recently_ used item, which throws away frequently-used entries during scans or bursts. **W-TinyLFU** keeps a compact frequency sketch and only admits a new entry if it is estimated to be more valuable than the one it would evict. On skewed, real-world workloads this can dramatically improve hit ratios compared to recency-only policies.

## Install

```sh
npm install caffeine-js
```

## Quick start

```ts
import { caffeine } from "caffeine-js";

const cache = caffeine<string, number>({ maximumSize: 10_000 })
  .recordStats()
  .removalListener((key, value, cause) => console.log("removed", key, cause))
  .build();

cache.set("a", 1);
cache.get("a"); // 1
cache.peek("a"); // 1 (no recency/stats update)
cache.has("a"); // true
cache.delete("a"); // true
cache.size; // number of entries
cache.stats(); // { hitCount, missCount, hitRate, evictionCount, loadSuccessCount, loadFailureCount, totalLoadTime }
```

Works with CommonJS too:

```js
const { caffeine } = require("caffeine-js");
```

Any key type is supported, including objects (compared by reference, like `Map`):

```ts
const byRef = caffeine<object, string>({ maximumSize: 100 }).build();
const key = { id: 1 };
byRef.set(key, "value");
byRef.get(key); // "value"
byRef.get({ id: 1 }); // undefined — different object identity
```

## Usage in Node.js / backend

Use it anywhere you would reach for an in-process cache: request deduplication, session storage, computed-result memoization, or buffering database rows.

```ts
import { caffeine } from "caffeine-js";

const userCache = caffeine<string, User>({ maximumSize: 50_000 })
  .expireAfterAccess(60_000) // expire 60s after last read or write
  .recordStats()
  .build();

function getUser(id: string): User | undefined {
  return userCache.get(id);
}
```

For read-through loading with request coalescing:

```ts
const userLoader = caffeine<string, User>({ maximumSize: 50_000 }).buildAsync(
  async (id, signal) => {
    const res = await fetch(`/api/users/${id}`, { signal });
    return res.json();
  },
);

// Concurrent calls for the same id share a single loader invocation.
const user = await userLoader.get("42");
```

## Usage in the browser

The package ships ESM, CJS, and IIFE bundles with no runtime dependencies. Use it with any bundler or directly from a CDN.

### With a bundler

```ts
import { caffeine } from "caffeine-js";

const cache = caffeine<string, any>({ maximumSize: 1_000 }).build();
```

### From a CDN (ESM)

```html
<script type="module">
  import { caffeine } from "https://esm.sh/caffeine-js";
  const cache = caffeine({ maximumSize: 1000 }).build();
  cache.set("k", 42);
  console.log(cache.get("k")); // 42
</script>
```

### IIFE / global

```html
<script src="https://cdn.jsdelivr.net/npm/caffeine-js/dist/index.global.js"></script>
<script>
  const cache = CaffeineJS.caffeine({ maximumSize: 1000 }).build();
  cache.set("k", 42);
</script>
```

## Usage with React

Install the optional peer dependency `react`, then use the hook:

```tsx
import { useCachedValue } from "caffeine-js/react";
import { caffeine } from "caffeine-js";

const userCache = caffeine<string, User>({ maximumSize: 1_000 }).buildAsync((id) =>
  fetch(`/api/users/${id}`).then((r) => r.json()),
);

function UserCard({ userId }: { userId: string }) {
  const { value, loading, error, refresh } = useCachedValue(userCache, userId);

  if (loading) return <p>Loading…</p>;
  if (error) return <p>Error: {error.message}</p>;
  return (
    <div>
      <h1>{value?.name}</h1>
      <button onClick={refresh}>Reload</button>
    </div>
  );
}
```

## Features and options

`caffeine(options)` returns a fluent builder. The most common options are:

| Option              | Type                          | Default    | Description                                                                                                     |
| ------------------- | ----------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| `maximumSize`       | `number`                      | —          | Max entries before size-based eviction. Mutually exclusive with `maximumWeight`.                                |
| `maximumWeight`     | `number`                      | —          | Max total weight before eviction. Requires `weigher`.                                                           |
| `weigher`           | `(key, value) => number`      | —          | Per-entry weight for weight-bounded caches.                                                                     |
| `expectedEntries`   | `number`                      | `1024`     | Hint for weight-bounded caches; sizes the sketch and initial store.                                             |
| `expireAfterWrite`  | `number` (ms)                 | —          | Expire entries this long after their last write.                                                                |
| `expireAfterAccess` | `number` (ms)                 | —          | Expire entries this long after their last read or write.                                                        |
| `expireAfter`       | `Expiry<K, V>`                | —          | Per-entry expiry calculator. Mutually exclusive with global TTLs.                                               |
| `clock`             | `() => number`                | `Date.now` | Injectable millisecond clock (tests, `performance.now`).                                                        |
| `doorkeeper`        | `boolean`                     | `true`     | Bloom filter that keeps one-hit-wonders out of the frequency sketch.                                            |
| `adaptive`          | `boolean`                     | `true`     | Auto-tune the admission-window/main split to maximize hit rate.                                                 |
| `recordStats`       | `boolean`                     | `false`    | Track hit/miss/eviction/load counts. Near-zero overhead when off.                                               |
| `removalListener`   | `(key, value, cause) => void` | —          | Called after eviction/replacement/deletion/expiry. `cause` ∈ `"size" \| "replaced" \| "explicit" \| "expired"`. |

Builder methods mirror the options and return `this` for chaining: `.maximumSize(n)`, `.maximumWeight(n, weigher)`, `.expectedEntries(n)`, `.expireAfterWrite(ms)`, `.expireAfterAccess(ms)`, `.expireAfter(expiry)`, `.clock(fn)`, `.recordStats()`, `.doorkeeper(bool)`, `.adaptive(bool)`, `.removalListener(fn)`.

Call `.build()` for a synchronous `Cache`, or `.buildAsync(loader)` for an `AsyncLoadingCache`.

The `Cache` surface includes `get`/`set`/`peek`/`has`/`delete`/`clear`, helpers `getIfPresent`/`putAll`/`invalidate`/`invalidateAll`/`asMap`, iteration (`keys`/`values`/`entries`/`forEach`), `stats()`, and `runMaintenance()` (call it on edge/serverless runtimes to reclaim expired entries without background timers).

### TTL and expiry

```ts
import { caffeine } from "caffeine-js";

const cache = caffeine<string, string>({})
  .maximumSize(10_000)
  .expireAfterWrite(60_000)
  .expireAfterAccess(30_000)
  .build();
```

For per-entry TTL:

```ts
const cache = caffeine<string, number>({ maximumSize: 100 })
  .expireAfter({
    expireAfterCreate: (key, value) => (key.startsWith("temp") ? 5_000 : 60_000),
    expireAfterUpdate: (key, value, currentTime, currentDuration) => currentDuration,
    expireAfterRead: (key, value, currentTime, currentDuration) => currentDuration,
  })
  .build();
```

### Weight and byte bounding

```ts
import { caffeine } from "caffeine-js";
import { estimateBytes } from "caffeine-js/estimate";

// Bound by total weight instead of entry count.
const cache = caffeine<string, string>({})
  .maximumWeight(1000, (_key, value) => value.length)
  .build();

// Approximate byte-bounded cache (~256 MiB).
const bytes = caffeine<string, Buffer>({})
  .maximumWeight(256 * 1024 * 1024, estimateBytes)
  .build();
```

### Async loading cache

```ts
const loading = caffeine<string, User>({})
  .maximumSize(50_000)
  .buildAsync(async (id, signal) => fetchUser(id, signal));

const user = await loading.get("42"); // loads once even under concurrent misses
await loading.refresh("42"); // serves old value until the reload lands
const many = await loading.bulkGet(["1", "2", "3"]);
```

## Observability

Attach the live CLI inspector or browser dashboard to see hits, misses, admissions, promotions, demotions, and evictions in real time. Both are zero-overhead until attached.

### CLI inspector

```ts
import { caffeine } from "caffeine-js";
import { attachInspector } from "caffeine-js/inspect";

const cache = caffeine({ maximumSize: 10_000 }).recordStats().build();
attachInspector(cache);
```

Run the bundled demo:

```sh
npx caffeine-inspect
```

### Browser dashboard

```ts
import { caffeine } from "caffeine-js";
import { renderDashboard } from "caffeine-js/dashboard";

const cache = caffeine({ maximumSize: 10_000 }).build();
const stop = renderDashboard(document.getElementById("root")!, cache);
// stop() to detach
```

A server-side SSE dashboard is also available via `caffeine-js/dashboard/server`.

## Design

- **Structure-of-Arrays store** — one `Map<K, index>` plus preallocated typed arrays for linked-list pointers and metadata, plus a typed-array free-list. No per-entry object allocation, so GC stays flat at millions of entries.
- **Window-TinyLFU policy** — a small LRU admission window in front of a segmented-LRU main region (probation + protected), gated by a 4-bit Count-Min Sketch with a doorkeeper and periodic aging.
- **Adaptive window** — a hill-climber continuously re-tunes the window/main split from the observed hit rate. Recency-heavy workloads get a larger window automatically; stable frequency-skewed workloads keep a small window. Disable with `.adaptive(false)`.
- **Batched read maintenance** — cache hits are buffered and drained in batches, keeping the hot `get` path allocation-free and cheap.
- **Weight-bounded core** — the policy is bounded by total weight; a count-bounded cache is the special case where every entry has weight 1.
- **Hierarchical timer wheel TTL** — `expireAfterWrite`/`expireAfterAccess` use lazy expiry on access plus a 5-level timer wheel for O(1) amortized reclamation. No background `setInterval` required; call `runMaintenance()` on edge/serverless runtimes.
- **Async loading** — `buildAsync(loader)` gives a read-through cache with request coalescing, race-safe publishing via load-identity tokens, `refresh()`, `bulkGet()`, and `AbortSignal` support.
- **Post-commit removal listeners** — removal callbacks fire only after cache state is consistent, so listeners may safely re-enter `set`/`delete`/`clear`; listener errors are isolated.

## Benchmarks

Run the benchmarks locally:

```sh
npm run bench:throughput # ops/sec by key type and weight-bound mode
npm run bench:hitratio   # hit ratio on skewed, scan, and one-hit traces
npm run bench            # combined perf gate
```

Representative numbers from a single Node.js 20 process on this machine:

| Workload                   | Metric     | Result        |
| -------------------------- | ---------- | ------------- |
| Fill 100k integer keys     | throughput | ~5.1M ops/sec |
| Hot read 100k integer keys | throughput | ~4.9M ops/sec |
| Mixed load integer keys    | throughput | ~4.4M ops/sec |
| Zipf skew=3, cap=5k        | hit ratio  | ~21%          |
| Loop scan, cap=5k          | hit ratio  | ~44%          |
| One-hit-wonder, cap=5k     | hit ratio  | ~9%           |

Exact figures depend on hardware, key type, value size, and workload shape.

## Examples

Runnable snippets in [`examples/`](examples/):

- [`basic.ts`](examples/basic.ts) — bounded cache, stats, removal listener
- [`ttl.ts`](examples/ttl.ts) — TTL expiry with an injectable clock
- [`async-loader.ts`](examples/async-loader.ts) — async loading cache + request coalescing
- [`byte-bounded.ts`](examples/byte-bounded.ts) — approximate byte-capacity bounding

```sh
npx tsx examples/basic.ts
```

Generate the API reference with `npm run docs:api` (typedoc → `docs/api`).

## Scripts

| Script                 | Description                |
| ---------------------- | -------------------------- |
| `npm test`             | Run the full test suite    |
| `npm run coverage`     | Run tests with coverage    |
| `npm run typecheck`    | TypeScript type check      |
| `npm run lint`         | ESLint                     |
| `npm run format:check` | Prettier check             |
| `npm run build`        | Build ESM/CJS/IIFE bundles |
| `npm run size`         | Check bundle size budgets  |
| `npm run pack:audit`   | publint + attw + dry pack  |
| `npm run bench`        | Run all benchmarks         |

## License

MIT
