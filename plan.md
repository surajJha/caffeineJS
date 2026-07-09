# Implementation Plan — `caffeine-js` (W-TinyLFU In-Memory Cache)

> A high-performance, isomorphic (browser + Node.js) in-memory caching library
> implementing the **Window TinyLFU (W-TinyLFU)** admission/eviction policy.
> Inspired by [ben-manes/caffeine](https://github.com/ben-manes/caffeine) — **referenced, not ported.**

---

## 1. Epic Summary

- **Epic Title**: `caffeine-js` — Isomorphic W-TinyLFU Cache Library
- **Epic Goal**: Deliver a zero-dependency, high hit-ratio in-memory cache for JavaScript that
  outperforms LRU/LFU on real-world workloads, works identically in Node.js, browsers, Deno, Bun,
  and edge runtimes, and is consumable from JS, TypeScript, React, and any framework.
- **Success Criteria** (measurable):
  1. Hit ratio ≥ LRU on all Caffeine "efficiency" trace workloads; ≥ +5% on Zipfian/DB/search traces.
  2. Core `get`/`set`/`has` operations run in **O(1) amortized**; ≥ 5M ops/sec single-thread on Node 20 (bench harness).
  3. Ships as **ESM + CJS + UMD** with first-class `.d.ts`; tree-shakeable; **zero runtime dependencies**.
  4. Runs unmodified in Node 18+, modern browsers, Deno, Bun, and Cloudflare Workers (CI-verified).
  5. ≥ 95% line coverage on core policy; public API documented with runnable examples.
- **Scope Boundary**:
  - **IN scope**: sync cache core, W-TinyLFU policy (with **doorkeeper** + **adaptive window on by default**),
    size/count bounds, **byte/weight-based bounding + estimator**, TTL (expire-after-write/access),
    async loading cache (`getOrLoad`), stats/metrics, eviction/removal listeners, **opt-in instrumentation
    event tap**, **CLI/TUI live inspector**, **web dashboard**, TypeScript types, build tooling, benchmarks,
    docs, React adapter (thin), weighted entries.
  - **OUT of scope (v1)**: distributed/multi-node cache, persistence to disk, cross-tab `SharedWorker` sync,
    off-heap storage, refresh-ahead scheduling (deferred to v1.1), LFU decay tuning UI, encryption.

---

## 2. Milestones

### M0: Foundation — Repo, tooling, contracts
Shippable increment: an empty-but-installable package with types, build, CI, and a no-op cache stub.

### M1: Core Policy — W-TinyLFU engine
Shippable increment: a fully working bounded cache (`get`/`set`/`has`/`delete`) using W-TinyLFU with count bounds.

### M2: Capabilities — TTL, weights, stats, listeners, async loader
Shippable increment: feature-complete synchronous + async loading cache with observability.

### M3: Isomorphic + DX — Cross-runtime, React adapter, docs, benchmarks
Shippable increment: published-quality package validated across runtimes with docs and perf proof.

### M4: Hardening — Efficiency validation, fuzzing, release
Shippable increment: v1.0.0 release with proven hit-ratio parity and CI-gated quality.

### M5: Observability & Visualization — Instrumentation, CLI/TUI, web dashboard
Shippable increment: opt-in event tap feeding a live CLI inspector and a web dashboard so users can *see* admission, promotion, and eviction happening in real time. (Can ship post-1.0 as a companion; depends only on the core event tap.)

---

## 2b. Design Revisions (post rubber-duck + at-scale research)

These decisions supersede earlier notes where they conflict. Sources verified against actual repos.

- **Storage = unified flat Structure-of-Arrays (SoA), NOT object-per-node.** Use `Map<K, index>` for lookup + preallocated typed arrays for all structural metadata + a typed-array free-list. This is the proven at-scale JS design (`isaacs/lru-cache`, `mnemonist`). Per-entry object allocation is the #1 scale risk in V8. Keys/values stay in plain JS arrays (can't be typed); everything else is typed:
  - `next: UintArray`, `prev: UintArray` (DLL pointers, one shared index space across all 3 queues)
  - `segment: Uint8Array` (0=window, 1=protected, 2=probation)
  - `weight: Uint32Array`, `ttlExp: Float64Array`, `genArr: Uint32Array` (generation/ABA guard)
  - `keyList: K[]`, `valList: V[]` (plain arrays), `keyMap: Map<K, index>`, `free: UintArray` stack
  - `getUintArray(max)` picks Uint8/16/32Array by 2^8 / 2^16 / 2^32 thresholds.
  - **Novelty:** unified SoA across W-TinyLFU's 3 segments with a `segment` column is not done by any existing JS lib.
- **Prototype/perf gate moves to M1 (before full policy build).** Prove the storage layout hits throughput/GC targets vs `lru-cache` before committing.
- **V8 `Map` limit ≈ 153M entries** (not the outdated 16.7M). Memory is the real ceiling → no JS-level sharding needed; document capacity tiers instead.
- **Sampled eviction (sample of 5)** from a cost map, compare frequencies — O(1), avoids scanning (Ristretto).
- **Maintenance cadence**: flush read buffer at 64 ops OR 300ms; cap a maintenance run at ~100ms/bounded iterations (Moka). Batched read records carry `index + generation`, never object refs.
- **TTL = 5-level timer wheel + lazy expiry**, advanced on mutation/maintenance. **No dependency on `setInterval`** (unreliable on edge). Expose `runMaintenance()`; optional auto-timer only on Node/Bun/Deno via capability detection.
- **Async loader**: track pending loads with generation tokens; publish/remove only if token still matches. Support `AbortSignal`, optional negative caching (TTL), and define whether pending entries count toward size.
- **Listeners/events strictly post-commit**: mutate → enqueue records → drain callbacks after invariants restored; guard recursive drains; isolate exceptions.
- **Iterators are weakly-consistent** (not snapshots); define whether iteration/`asMap().get()` updates recency.
- **Scope trims**: defer UMD (ESM primary + CJS); byte-estimator is an optional subpath split Node vs browser; `FinalizationRegistry`/`COLLECTED` cause is experimental-only, never relied on for bounds.
- **Observability**: prefer `node:diagnostics_channel` on supporting runtimes; numeric counters, no per-op object/`Math.random()` in the hot path; never retain keys unless opted in.

---

## 3. Tickets

### M0 — Foundation

#### CAFF-001 Bootstrap repository & package manifest
- **Type**: Chore | **Priority**: P0 | **Size**: S | **Depends On**: None
- **Files**: `package.json`, `.gitignore`, `.editorconfig`, `README.md`, `LICENSE`
- **Acceptance Criteria**:
  - [ ] `package.json` declares `type: module`, `exports` map (import/require/types), `sideEffects: false`.
  - [ ] Node engines `>=18`; zero `dependencies`; MIT license file present.
  - [ ] `npm install` succeeds on clean clone.
- **Implementation Notes**: Use `exports` conditional map for ESM/CJS/types. Keep `dependencies: {}`.

#### CAFF-002 TypeScript + build pipeline (ESM/CJS/UMD + d.ts)
- **Type**: Chore | **Priority**: P0 | **Size**: M | **Depends On**: CAFF-001
- **Files**: `tsconfig.json`, `tsup.config.ts`, `src/index.ts`
- **Acceptance Criteria**:
  - [ ] `npm run build` emits `dist/index.mjs`, `dist/index.cjs`, `dist/index.global.js`, `dist/index.d.ts`.
  - [ ] `strict: true`; `target: ES2020` or lower for broad browser support.
  - [ ] `are-the-types-wrong` (`attw`) passes; `publint` passes.
- **Implementation Notes**: Use `tsup` (esbuild) for multi-format bundling. UMD/global name `CaffeineJS`.

#### CAFF-003 Test runner, lint, format, coverage
- **Type**: Chore | **Priority**: P0 | **Size**: S | **Depends On**: CAFF-001
- **Files**: `vitest.config.ts`, `eslint.config.js`, `.prettierrc`, `package.json` scripts
- **Acceptance Criteria**:
  - [ ] `npm test`, `npm run lint`, `npm run format:check`, `npm run coverage` all wired.
  - [ ] Coverage provider configured (v8) with thresholds placeholder.
- **Implementation Notes**: Vitest runs in both `node` and `jsdom`/`happy-dom` environments.

#### CAFF-004 Public API contract & type surface (interfaces only)
- **Type**: Spike | **Priority**: P0 | **Size**: S | **Depends On**: CAFF-002
- **Files**: `src/types.ts`, `src/index.ts`
- **Acceptance Criteria**:
  - [ ] Interfaces defined: `Cache<K,V>`, `AsyncLoadingCache<K,V>`, `CacheOptions<K,V>`, `CacheStats`, `RemovalCause`, `RemovalListener`, `Weigher`, `Expiry`.
  - [ ] Builder/factory signature finalized: `caffeine<K,V>(options).build()` and `.buildAsync(loader)`.
  - [ ] Type-only test file compiles (`tsd` or `vitest` type asserts).
- **Implementation Notes**: Mirror Caffeine's builder ergonomics but idiomatic JS (options object + fluent builder). No implementation yet.

#### CAFF-005 CI pipeline (GitHub Actions)
- **Type**: Chore | **Priority**: P1 | **Size**: S | **Depends On**: CAFF-002, CAFF-003
- **Files**: `.github/workflows/ci.yml`
- **Acceptance Criteria**:
  - [ ] CI runs lint + typecheck + test + build on Node 18/20/22 matrix.
  - [ ] Fails on coverage below threshold and on `publint`/`attw` errors.
- **Implementation Notes**: Cache npm; add Deno/Bun/browser jobs later in M3.

---

### M1 — Core Policy (W-TinyLFU engine)

#### CAFF-009 Storage-layout perf gate (SoA prototype) — **blocks the rest of M1**
- **Type**: Spike | **Priority**: P0 | **Size**: M | **Depends On**: CAFF-004
- **Files**: `bench/storage-proto/*`, `src/store/soa-store.ts` (skeleton)
- **Acceptance Criteria**:
  - [ ] Prototype the unified SoA store (`Map<K,index>` + typed arrays + free-list) and a naive object-node variant.
  - [ ] Microbench both: hot-key `get`, `set`-with-eviction, mixed 80/20, at 1M and 5M entries; capture ops/sec, heap size, and GC pause behavior.
  - [ ] SoA meets throughput target (≥5M ops/sec get on Node 20) and materially lower heap/GC than object-node; compare against `lru-cache` as a yardstick.
  - [ ] Decision recorded: proceed with SoA (default) — do not build the policy stack on a layout that fails this gate.
- **Implementation Notes**: This de-risks the #1 scale concern before CAFF-012/013/014. If SoA underperforms for a key-type mix, document why and adjust before proceeding.

#### CAFF-010 Frequency sketch — Count-Min Sketch (4-bit counters)
- **Type**: Feature | **Priority**: P0 | **Size**: L | **Depends On**: CAFF-004
- **Files**: `src/policy/frequency-sketch.ts`, `test/frequency-sketch.test.ts`
- **Acceptance Criteria**:
  - [ ] 4-bit counters packed into a `Uint32Array` (8 counters/word) sized to next power of two of capacity.
  - [ ] `increment(hash)` bumps 4 hash-derived counters (saturating at 15).
  - [ ] `frequency(hash)` returns min of the 4 counters.
  - [ ] **Aging/reset**: after `sampleSize` (~10× capacity) increments, halve all counters (`>>>1`) and preserve reset residual.
  - [ ] Deterministic unit tests validate saturation, min-estimate, and reset behavior.
- **Implementation Notes**: Port the *algorithm/idea* from Caffeine's `FrequencySketch`, re-implemented in idiomatic TS. Use a good hash spreader (e.g. mix like `xmur3`/`fmix32`). **Use Caffeine's block/bit-sliced layout**: keep a key's 4 counters within one 64-byte block for typed-array locality (start with classic 4-row CMS, then migrate).

#### CAFF-011 Hashing & key coercion strategy
- **Type**: Feature | **Priority**: P0 | **Size**: M | **Depends On**: CAFF-004
- **Files**: `src/util/hash.ts`, `test/hash.test.ts`
- **Acceptance Criteria**:
  - [ ] Storage uses native `Map` for O(1) key lookup (supports any key type incl. objects by reference).
  - [ ] Separate numeric `hash(key)` for the sketch: string keys via string hash; numbers directly; objects via monotonic id table (WeakMap).
  - [ ] Good avalanche/distribution verified by a spread test.
- **Implementation Notes**: `Map` handles equality/lookup; sketch only needs a 32-bit hash. Use `WeakMap<object, id>` counter for object keys.

#### CAFF-012 SLRU main region (probation + protected) on unified SoA
- **Type**: Feature | **Priority**: P0 | **Size**: L | **Depends On**: CAFF-004, CAFF-009
- **Files**: `src/store/soa-store.ts`, `src/policy/slru.ts`, `test/slru.test.ts`
- **Acceptance Criteria**:
  - [ ] Doubly-linked lists implemented over **shared typed-array index space** (`next`/`prev: UintArray`), no per-node objects, O(1) move/evict.
  - [ ] `segment: Uint8Array` tracks queue membership; free-list stack reuses freed indices; `getUintArray(max)` sizing.
  - [ ] Protected segment capped at ~80% of main; overflow demotes LRU protected → probation.
  - [ ] On access, entries promote probation → protected (MRU); eviction victim is LRU of probation.
- **Implementation Notes**: Single index space + sentinel head slots per queue (see §2b). Movement between segments is DLL unlink + relink + `segment[idx]` update. Prior art: `isaacs/lru-cache`, `mnemonist`, `velo-org/velo` (per-segment SoA — we unify).

#### CAFF-013 Admission window (LRU) + TinyLFU admission gate
- **Type**: Feature | **Priority**: P0 | **Size**: L | **Depends On**: CAFF-010, CAFF-012
- **Files**: `src/policy/window-tinylfu.ts`, `test/window-tinylfu.test.ts`
- **Acceptance Criteria**:
  - [ ] Window (~1% capacity) is an LRU; new entries enter window first.
  - [ ] On overflow, window victim (candidate) competes with main probation victim.
  - [ ] Admission: if `freq(candidate) > freq(victim)` admit candidate, evict victim; else evict candidate. Include tie-break random rejection for hot short bursts.
  - [ ] For **weighted** caches, victim selection uses a **sampled-LFU** (random sample of ~5 from a cost map, evict lowest frequency) rather than scanning — O(sample), per Ristretto.
  - [ ] Every access records into the read buffer (drained to `sketch.increment` in batch — CAFF-017).
  - [ ] Policy exposed behind an internal `EvictionPolicy` interface for testability.
- **Implementation Notes**: This is the heart of W-TinyLFU. Keep window/main sizing configurable for the adaptive step in CAFF-041. Admission gate consults the doorkeeper (CAFF-016) before the CMS.

#### CAFF-016 Doorkeeper bloom filter (one-hit-wonder guard)
- **Type**: Feature | **Priority**: P1 | **Size**: M | **Depends On**: CAFF-010
- **Files**: `src/policy/doorkeeper.ts`, `src/policy/window-tinylfu.ts`, `test/doorkeeper.test.ts`
- **Acceptance Criteria**:
  - [ ] A 1-bit-per-slot bloom filter fronts the CMS: first touch of a key sets the bloom and returns freq 1; repeats fall through to the CMS.
  - [ ] Bloom is cleared on each aging/reset cycle in lockstep with the sketch.
  - [ ] Measurably reduces sketch pollution from single-access keys (asserted on a synthetic one-hit-wonder trace: fewer false admissions vs no-doorkeeper baseline).
  - [ ] Can be disabled via `options.doorkeeper: false`.
- **Implementation Notes**: `Uint32Array` bitset, k hash functions. Effective frequency = `doorkeeper.contains(h) ? 1 : 0) + cms.frequency(h)`. Reset alongside CMS aging.

#### CAFF-014 Bounded cache core (get/set/has/delete/clear/size)
- **Type**: Feature | **Priority**: P0 | **Size**: L | **Depends On**: CAFF-013, CAFF-011
- **Files**: `src/cache.ts`, `src/builder.ts`, `src/index.ts`, `test/cache.test.ts`
- **Acceptance Criteria**:
  - [ ] `caffeine({ maximumSize }).build()` returns a working `Cache<K,V>`.
  - [ ] `get`, `set`/`put`, `has`, `delete`, `clear`, `size`, `entries()` implemented and covered.
  - [ ] Never exceeds `maximumSize` (invariant asserted in tests after random ops).
  - [ ] Overwriting existing key updates value without double-counting size.
- **Implementation Notes**: Wire `Map<K, index>` + SoA store (CAFF-012) + policy. All mutations funnel through policy hooks (`onAdd`/`onAccess`/`onUpdate`/`onRemove`). Iterators are weakly-consistent; removal listeners fire strictly post-commit (see §2b).

#### CAFF-015 Correctness invariants & property tests
- **Type**: Feature | **Priority**: P1 | **Size**: M | **Depends On**: CAFF-014
- **Files**: `test/invariants.test.ts`
- **Acceptance Criteria**:
  - [ ] Property test (fast-check, devDep) runs 10k random op sequences; asserts size bound, Map/list consistency, no dangling nodes.
  - [ ] Segment size invariants (window/protected/probation) hold after every op.
- **Implementation Notes**: `fast-check` as devDependency only. **M1 smoke test**: random workload keeps `size <= maximumSize` and hit ratio > naive FIFO.

#### CAFF-017 Batched policy maintenance (read/write ring buffers) — ✅ DONE
- **Type**: Feature | **Priority**: P2 | **Size**: M | **Depends On**: CAFF-014
- **Files**: `src/policy/window-tinylfu.ts`, `src/cache.ts`, `test/cache.test.ts`
- **Acceptance Criteria**:
  - [x] Reads record into a small fixed ring buffer (64); policy (LRU moves, sketch increments) is drained in batch before any structural mutation (`set`/`delete`/`clear`) and when the buffer fills, not per-op.
  - [x] Consecutive hits on the same slot are coalesced (buffer holds a hot index at most once in a row), collapsing repeated hot-key reads. No generation tokens needed — reads never free slots, so buffered indices stay live until the next drain.
  - [x] Throughput on the hot-key workload improved **4.46M → ~6.2M ops/s** (bench-asserted; clears the 5M gate). Hit ratio unchanged at 0.905.
  - [x] Correctness invariants (CAFF-015) still hold; added targeted tests: hot-read survivor vs cold evictee, and interleaved read/write/delete consistency vs a model map.
- **Implementation Notes**: Single-thread JS, so this is a *churn/throughput* optimization, not a locking mechanism. Also added an "already-MRU" short-circuit in the reorder path. Deferred the read buffer inside `WindowTinyLfu` (`readBuffer: Int32Array`, `onAccessBuffered`/`drainRead`/`applyAccess`).

---

### M2 — Capabilities

> **M2 status (shipped):** TTL (CAFF-020), weighted entries (CAFF-022),
> byte estimator (CAFF-027), extended stats (CAFF-023), hardened removal
> listeners (CAFF-024), async loading cache (CAFF-025), and utility methods
> (CAFF-026) are all implemented and tested (57 tests, perf gate 5.88M/s hot-get
> preserved). The core was unified onto a **weight-bounded** policy where a
> count-bounded cache is the special case of every entry having weight 1, and
> the SoA store became **growable** (sentinels relocated to fixed low indices)
> for weight/byte-bounded caches.
>
> **v1 boundaries / deferred:** CAFF-021 variable per-entry expiry deferred;
> TTL is not combined with `maximumWeight` in v1 (throws — growable expiry
> arrays deferred); `asMap()` returns a snapshot rather than a live proxy view;
> negative caching for async failures deferred (CAFF-028 decision log).

#### CAFF-020 TTL: expire-after-write & expire-after-access — ✅ DONE
- **Type**: Feature | **Priority**: P1 | **Size**: L | **Depends On**: CAFF-014
- **Files**: `src/policy/expiry.ts`, `src/cache.ts`, `test/expiry.test.ts`
- **Acceptance Criteria**:
  - [ ] `expireAfterWrite(ms)` and `expireAfterAccess(ms)` options supported.
  - [ ] Lazy expiration on access + O(1) amortized reclamation via a **5-level hierarchical timer wheel** (Moka/Caffeine layout), advanced on mutation/maintenance — **no reliance on `setInterval`**.
  - [ ] Injectable clock (`options.clock`) for deterministic tests (no real timers).
  - [ ] Expired entries fire removal listener with cause `EXPIRED`.
  - [ ] Cleanup is budgeted (bounded entries reclaimed per op); `runMaintenance()` exposed for edge runtimes; optional auto-timer only on Node/Bun/Deno via capability detection.
- **Implementation Notes**: Timer-wheel buckets are SoA deques (`timerNext`/`timerPrev: UintArray`). Access-order TTL updates ride the batched-maintenance pipeline (CAFF-017) so hits stay cheap. Portable design per §2b (CF Workers timers only fire in-request; `Date.now()` doesn't advance during CPU).

#### CAFF-021 Variable expiry (per-entry `Expiry` calculator)
- **Type**: Feature | **Priority**: P2 | **Size**: M | **Depends On**: CAFF-020
- **Files**: `src/policy/expiry.ts`, `test/expiry-variable.test.ts`
- **Acceptance Criteria**:
  - [ ] `expireAfter(expiry)` with `create/update/read` hooks returning per-entry TTL.
  - [ ] Falls back to a hierarchical timer wheel for O(1) scheduling.
- **Implementation Notes**: Optional; mirrors Caffeine `Expiry`. Keep behind capability flag.

#### CAFF-022 Weighted entries (`maximumWeight` + `Weigher`) — ✅ DONE
- **Type**: Feature | **Priority**: P1 | **Size**: M | **Depends On**: CAFF-014
- **Files**: `src/cache.ts`, `src/builder.ts`, `test/weight.test.ts`
- **Acceptance Criteria**:
  - [ ] `maximumWeight(n)` + `weigher(fn)` bound total weight, not count.
  - [ ] Evicts until `totalWeight <= maximumWeight`; single entry heavier than max is rejected/immediately evicted per policy.
  - [ ] Weight recomputed on value update.
- **Implementation Notes**: `maximumSize` and `maximumWeight` are mutually exclusive (validate in builder).

#### CAFF-027 Byte-based bounding & memory estimator — ✅ DONE
- **Type**: Feature | **Priority**: P1 | **Size**: M | **Depends On**: CAFF-022
- **Files**: `src/util/estimate-bytes.ts`, `src/builder.ts`, `test/estimate-bytes.test.ts`
- **Acceptance Criteria**:
  - [ ] Ships a built-in `estimateBytes(key, value)` heuristic: strings `≈ len*2 + 16`, typed arrays via `byteLength`, numbers/bool fixed, objects via shallow/recursive walk (depth-capped) or `v8.serialize().length` in Node.
  - [ ] Enables `caffeine({ maximumWeight: bytes, weigher: estimateBytes })` for approximate byte-capacity caches (e.g. 1 GB).
  - [ ] Docs state clearly: JS cannot measure exact object size; this is an **approximation**. Include the fixed ~220 B/entry overhead in the estimate.
  - [ ] Optional Node safety valve: sample `process.memoryUsage().heapUsed` every N ops and force-evict if over a hard ceiling.
- **Implementation Notes**: This is the honest answer to "bound the cache to 1 GB." Estimator lives in a subpath (split Node vs browser) so it tree-shakes out when unused. See Appendix C for capacity math.

#### CAFF-028 Production ergonomics — explicit accept/defer decisions
- **Type**: Spike | **Priority**: P2 | **Size**: S | **Depends On**: CAFF-025
- **Files**: `docs/decisions.md`, `src/builder.ts`
- **Acceptance Criteria**:
  - [ ] Each of the following has a written **accept-for-v1 / defer** decision with rationale: negative caching (TTL), stale-while-revalidate / refresh-ahead, **jittered TTL** (avoid synchronized expiry storms), snapshot/serialize/import for cache warming, bulk `get`/`set`/`delete`, `AbortSignal` on loaders, max in-flight loads / loader backpressure, deterministic testing mode for the adaptive policy, value-mutation-after-insert guidance, and integer/string/object key-type performance guidance.
  - [ ] Accepted items get tickets; deferred items are recorded in "OUT of scope (v1)".
- **Implementation Notes**: Prevents silent scope creep and surfaces decisions the review flagged as undecided. Cheap now, expensive later.

#### CAFF-023 Statistics & metrics — ✅ DONE
- **Type**: Feature | **Priority**: P1 | **Size**: M | **Depends On**: CAFF-014
- **Files**: `src/stats.ts`, `test/stats.test.ts`
- **Acceptance Criteria**:
  - [ ] `recordStats()` opt-in; `cache.stats()` returns hitCount, missCount, hitRate, loadSuccess/Fail, evictionCount, totalLoadTime.
  - [ ] Counters are cheap (plain numbers); disabled path has ~zero overhead.
- **Implementation Notes**: Provide a `StatsCounter` interface with `Disabled` (no-op) and `Concurrent`/`Counting` impls.

#### CAFF-024 Removal & eviction listeners — ✅ DONE
- **Type**: Feature | **Priority**: P1 | **Size**: S | **Depends On**: CAFF-014
- **Files**: `src/cache.ts`, `test/listeners.test.ts`
- **Acceptance Criteria**:
  - [ ] `removalListener((key, value, cause) => …)` fired for EXPLICIT, REPLACED, SIZE, EXPIRED (and COLLECTED only if the experimental WeakRef mode is on).
  - [ ] Delivery is **strictly post-commit**: state mutated fully → records enqueued → callbacks drained after invariants restored; recursive drains guarded; listener errors isolated.
- **Implementation Notes**: `RemovalCause` enum-like union type. Never invoke callbacks mid-mutation (re-entrancy hazard — a listener may call `set`/`delete`/`clear`).

#### CAFF-025 Async loading cache (`getOrLoad`, coalescing, `refresh`) — ✅ DONE
- **Type**: Feature | **Priority**: P0 | **Size**: L | **Depends On**: CAFF-014, CAFF-023
- **Files**: `src/async-cache.ts`, `test/async-cache.test.ts`
- **Acceptance Criteria**:
  - [ ] `buildAsync(loader)` returns `AsyncLoadingCache`; `get(key)` returns a `Promise<V>`.
  - [ ] **Request coalescing**: concurrent misses for same key share one in-flight loader promise.
  - [ ] **Race-safe via generation tokens**: on settle, only publish/remove if the pending token still matches (handles invalidate-while-pending, overwrite-while-pending, evict-while-pending, refresh racing get).
  - [ ] Loader rejection removes the pending entry (records load-failure); **optional negative caching** with short TTL to damp repeated failures.
  - [ ] `AbortSignal` support (cancel/timeout); `bulkGet(keys, bulkLoader?)` with partial-failure semantics defined.
  - [ ] Decide & document whether pending entries count toward size/weight and whether they can be evicted.
- **Implementation Notes**: Track pending loads with a per-key generation token, not just "store the promise as value". Stampede protection comes from sharing the in-flight promise; correctness comes from the token check on settle.

#### CAFF-026 Utility methods (getIfPresent, putAll, invalidate, invalidateAll, asMap view) — ✅ DONE
- **Type**: Feature | **Priority**: P2 | **Size**: S | **Depends On**: CAFF-014
- **Files**: `src/cache.ts`, `test/api-surface.test.ts`
- **Acceptance Criteria**:
  - [ ] Ergonomic helpers implemented and typed; `asMap()` returns a live `Map`-like view.
  - [ ] **M2 smoke test**: loading cache under concurrent access coalesces to a single loader call (asserted via spy).

---

### M3 — Isomorphic + DX

> **M3 status (shipped):** cross-runtime env shims (CAFF-030), benchmark harness
> (CAFF-034), docs + examples + typedoc (CAFF-033), React adapter subpath (CAFF-032),
> and multi-runtime CI + smoke scripts (CAFF-031) are all implemented. 64 tests pass,
> perf gate 5.94M/s hot-get preserved, build emits `./`, `./estimate`, `./react` subpaths.

#### CAFF-030 Cross-runtime abstraction (clock, timers, no Node built-ins) — ✅ DONE
- **Type**: Chore | **Priority**: P0 | **Size**: M | **Depends On**: CAFF-020
- **Files**: `src/env.ts`, `test/env.test.ts`
- **Acceptance Criteria**:
  - [ ] No imports of `node:*`; time via `Date.now()`/`performance.now()` with injectable clock.
  - [ ] No reliance on `setInterval` for correctness (lazy + amortized cleanup only).
  - [ ] Bundle contains zero Node polyfills; verified by bundle inspection.
- **Implementation Notes**: Keep the core pure; environment concerns isolated in one module.

#### CAFF-031 Multi-runtime CI (browser, Deno, Bun, Workers) — ✅ DONE
- **Type**: Chore | **Priority**: P1 | **Size**: M | **Depends On**: CAFF-030, CAFF-005
- **Files**: `.github/workflows/ci.yml`, `test/browser/*`, `scripts/smoke-*.{js,ts}`
- **Acceptance Criteria**:
  - [ ] Browser tests run headless (Playwright/vitest browser mode).
  - [ ] Deno + Bun smoke scripts import the built ESM and pass a basic get/set assertion.
  - [ ] Cloudflare Workers smoke via `wrangler`/miniflare imports the bundle successfully.
- **Implementation Notes**: Smoke, not full-suite, on exotic runtimes to keep CI fast.

#### CAFF-032 React adapter (`@caffeine-js/react` or subpath export) — ✅ DONE
- **Type**: Feature | **Priority**: P2 | **Size**: M | **Depends On**: CAFF-025
- **Files**: `src/react/useCache.ts`, `src/react/index.ts`, `test/react.test.tsx`
- **Acceptance Criteria**:
  - [ ] `useCachedValue(cache, key)` hook returns `{ data, isLoading, error }` with coalesced loads.
  - [ ] React is a **peerDependency**, not bundled; adapter is a separate subpath export (`caffeine-js/react`).
  - [ ] Works with React 18 concurrent features; no state updates after unmount.
- **Implementation Notes**: Thin wrapper only — core stays framework-agnostic. Consider `useSyncExternalStore`.

#### CAFF-033 Documentation site & API reference — ✅ DONE
- **Type**: Chore | **Priority**: P1 | **Size**: L | **Depends On**: CAFF-026
- **Files**: `README.md`, `docs/**`, `typedoc.json`
- **Acceptance Criteria**:
  - [ ] README quickstart (Node, browser `<script>`, TS, React) with runnable snippets.
  - [ ] Generated API docs (typedoc); "Why W-TinyLFU vs LRU/LFU" explainer page.
  - [ ] Migration/comparison table vs `lru-cache`, `quick-lru`.
- **Implementation Notes**: Keep examples in `examples/` and lint them so they never rot.

#### CAFF-034 Benchmark harness — ✅ DONE
- **Type**: Feature | **Priority**: P1 | **Size**: L | **Depends On**: CAFF-014
- **Files**: `bench/throughput.ts`, `bench/hit-ratio.ts`, `bench/traces/*`
- **Acceptance Criteria**:
  - [ ] Throughput bench (tinybench/mitata) vs `lru-cache` and a plain `Map`, reported separately for **integer / short-string / object keys** (V8 perf differs wildly by key type).
  - [ ] Distinct scenarios: **cold vs steady-state**, mixed 80/20 get/set, hot-key, scan-resistance, count-bound vs weight-bound, with/without TTL.
  - [ ] Hit-ratio bench replays synthetic Zipfian + loop/burst/one-hit-wonder + at least one real trace; reports vs LRU/LFU/FIFO.
  - [ ] Reports **memory + GC-pause metrics** at 1M/5M entries, not only ops/sec; reproducible via `npm run bench`; numbers captured in docs.
- **Implementation Notes**: Benchmarks are easy to get wrong — isolate cold-start hit ratio from steady-state, and never benchmark solely with integer keys (V8 flatters object-node designs there). Reuse Caffeine's public trace formats where license allows; otherwise generate Zipfian/Scrambled-Zipfian.

---

### M4 — Hardening & Release

#### CAFF-040 Efficiency validation vs Caffeine claims — ✅ DONE
- **Type**: Feature | **Priority**: P0 | **Size**: L | **Depends On**: CAFF-034, CAFF-015
- **Files**: `test/efficiency.test.ts`, `bench/hit-ratio.ts`
- **Acceptance Criteria**:
  - [ ] On Zipfian + DB/search-like traces, hit ratio ≥ LRU and within tolerance of TinyLFU expectations.
  - [ ] Regression guard: hit-ratio thresholds asserted in CI (allow small variance).
- **Implementation Notes**: This ticket proves Success Criterion #1. If parity fails, revisit CAFF-010/013 tuning (sample size, admission tie-break).

#### CAFF-041 Adaptive window sizing (hill-climbing) — default-on — ✅ DONE
- **Type**: Feature | **Priority**: P1 | **Size**: XL | **Depends On**: CAFF-040
- **Files**: `src/policy/window-tinylfu.ts`, `src/cache.ts`, `src/types.ts`, `src/builder.ts`, `test/adaptive.test.ts`, `bench/adaptive.ts`
- **Acceptance Criteria**:
  - [x] Periodically adjusts the window/main ratio based on the hit-rate delta between sampling periods (climbs toward the better-performing ratio). Sample period = 10× capacity accesses; step restarts at 6.25% of capacity on large swings, decays ×0.9 otherwise.
  - [x] Bounded exploration cost on stable frequency-skewed traces: within ~0.1–0.6pp of static and converging tighter over time (a first-sample **warmup** avoids the `previousHitRate=0` jerk). Large gains on recency/dynamic traces: **+26pp (short trace) to +55pp (converged)** on a sliding-hot-set workload, window auto-grows toward ~70–98%.
  - [x] **On by default** (`options.adaptive: true` / `.adaptive(false)` to disable for a fixed ~1% window and deterministic behavior).
  - [x] No throughput regression: perf gate still 6.2M/s hot-get (climb runs once per ~10M accesses).
- **Implementation Notes**: Faithful to Caffeine's climb (restart threshold 0.05, step-percent 0.0625, decay 0.9) plus a warmup sample and a noise-tolerant resize that rebalances protected/window overflow into probation without evicting (total capacity unchanged). Validation harness: `bench/adaptive.ts` (zipfian skew 2/3 + recency-shift). **Reality check** (rubber-duck): an absolute "never regresses" guarantee is unachievable for any online noisy hill-climber on a flat surface; the realistic guarantee is *bounded sub-1pp exploration cost on stable traces, large gains on dynamic ones*, which the validation confirms.

#### CAFF-042 Fuzz & stress testing — ✅ DONE
- **Type**: Feature | **Priority**: P1 | **Size**: M | **Depends On**: CAFF-015
- **Files**: `test/fuzz.test.ts`
- **Acceptance Criteria**:
  - [ ] Long randomized run (100k+ ops) mixing set/get/delete/ttl/weight without invariant violation or leak.
  - [ ] Memory stays bounded (heap snapshot delta under threshold).
- **Implementation Notes**: Extend fast-check model-based testing against a reference oracle map.

#### CAFF-043 Bundle size budget & tree-shaking verification — ✅ DONE
- **Type**: Chore | **Priority**: P1 | **Size**: S | **Depends On**: CAFF-002
- **Files**: `.size-limit.json`, `.github/workflows/ci.yml`
- **Acceptance Criteria**:
  - [x] Core import budget (≤ 8 kB brotli, measured with `import { caffeine }`) enforced by `size-limit` in CI.
  - [x] Subpath imports (`estimate`, `react`, `inspect`) stay separate; importing core does not pull React/inspect/estimate code.
- **Implementation Notes**: Uses `@size-limit/preset-small-lib` with per-subpath `import` entries. Actual sizes: core 6.12 kB, estimate 350 B, react 215 B, inspect 1.95 kB.

#### CAFF-044 Release automation & versioning — ✅ DONE
- **Type**: Chore | **Priority**: P0 | **Size**: S | **Depends On**: CAFF-031, CAFF-033, CAFF-040, CAFF-043
- **Files**: `.github/workflows/release.yml`, `CHANGELOG.md`, `.changeset/*`, `package.json`
- **Acceptance Criteria**:
  - [x] Changesets-driven semver; `npm publish --provenance --access public` on merge to main.
  - [x] `npm pack` contents audited (dist + types + license + readme only).
  - [x] v1.0.0 versioned; install-and-import smoke passes from the generated tarball.
  - [x] Release workflow gates on typecheck, tests, build, size-limit, and pack audit before publishing.
- **Implementation Notes**: Version bumped to `1.0.0` via `changeset version`. Publishing to the npm registry requires an `NPM_TOKEN` repository secret; the workflow is otherwise ready to publish with provenance.

---

### M5 — Observability & Visualization

#### CAFF-050 Instrumentation event tap (zero-overhead when off) — ✅ DONE
- **Type**: Feature | **Priority**: P1 | **Size**: M | **Depends On**: CAFF-014, CAFF-023
- **Files**: `src/inspect/events.ts`, `src/cache.ts`, `test/events.test.ts`
- **Acceptance Criteria**:
  - [ ] Opt-in observer emits structured events: `hit`, `miss`, `admit`, `reject`, `promote` (probation→protected), `demote`, `evict` (with `RemovalCause`), `resize` (window/main ratio change), `age` (sketch reset).
  - [ ] Each event carries key, hash, freq estimate, and segment occupancy snapshot (counts only, not values by default).
  - [ ] **Zero overhead when no observer registered** — hot path checks a single boolean; verified by a bench showing no regression vs baseline.
  - [ ] Optional sampling (`{ sampleRate }`) to cap event volume on hot caches.
- **Implementation Notes**: This is the shared backbone for BOTH visualizers. Keep it a lightweight emitter, not a full pub/sub lib. Never emit values unless `includeValues: true` (privacy/perf).

#### CAFF-051 CLI/TUI live inspector — ✅ DONE
- **Type**: Feature | **Priority**: P2 | **Size**: L | **Depends On**: CAFF-050
- **Files**: `src/inspect/cli/*`, `bin/caffeine-inspect.ts`, `test/cli.test.ts`
- **Acceptance Criteria**:
  - [ ] `caffeine-js/inspect` renders a live terminal dashboard: hit-rate gauge, window/probation/protected occupancy bars, rolling admit/evict stream, frequency histogram, adaptive window ratio.
  - [ ] Attaches to a live in-process cache via the event tap; refreshes at a configurable interval without blocking the app.
  - [ ] Degrades gracefully in non-TTY (prints periodic snapshots).
- **Implementation Notes**: Use `ink` (React-for-CLI) or `blessed`. Node-only; ships as an optional subpath/bin so it never bloats the core browser bundle. Primary audience: backend/prod debugging over SSH.

#### CAFF-052 Web dashboard (real-time visualization)
- **Type**: Feature | **Priority**: P2 | **Size**: XL | **Depends On**: CAFF-050
- **Files**: `packages/dashboard/*`, `src/inspect/bridge.ts`
- **Acceptance Criteria**:
  - [ ] Web UI animates the W-TinyLFU flow: entries entering the window, the admission-gate decision (candidate vs victim freq), promotions/demotions, and evictions, in real time.
  - [ ] Time-series charts (hit rate, size, eviction rate), per-segment occupancy, and a frequency heatmap.
  - [ ] Two transports: in-browser (subscribe directly to an in-page cache's event tap) and Node (small WS bridge streams events to the browser).
  - [ ] Backpressure-safe: dashboard sampling/batching so a hot cache can't flood the socket.
- **Implementation Notes**: The "wow"/teaching showpiece — animating the admission gate is what makes W-TinyLFU's advantage over LRU *visible*. Separate package; consumes the same events as the CLI. Can ship post-1.0.


---

## 4. Dependency Graph

```
M0:  CAFF-001 ─┬─ CAFF-002 ─┬─ CAFF-004 ─┐
               │            └─ CAFF-005    │
               └─ CAFF-003 ───────────────┘   (CAFF-005 also needs 003)

M1:  CAFF-004 ── CAFF-009 (SoA perf gate, BLOCKS M1) ─┬─ CAFF-010 ─┬─ CAFF-013 ── CAFF-014 ─┬─ CAFF-015
                                                      ├─ CAFF-011 ─┤                        └─ CAFF-017
                                                      ├─ CAFF-012 ─┘
                                                      └─ CAFF-010 ── CAFF-016 (doorkeeper) ── CAFF-013

M2:  CAFF-014 ─┬─ CAFF-020 ── CAFF-021
               ├─ CAFF-022 ── CAFF-027 (byte bounding)
               ├─ CAFF-023 ─┐
               ├─ CAFF-024   ├─ CAFF-025 ─┬─ CAFF-026
               └────────────┘             └─ CAFF-028 (ergonomics decisions)

M3:  CAFF-020 ── CAFF-030 ── CAFF-031 (also needs 005)
     CAFF-025 ── CAFF-032
     CAFF-026 ── CAFF-033
     CAFF-014 ── CAFF-034

M4:  CAFF-034 + CAFF-015 ── CAFF-040 ── CAFF-041
     CAFF-015 ── CAFF-042
     CAFF-002 ── CAFF-043
     CAFF-031 + CAFF-033 + CAFF-040 + CAFF-043 ── CAFF-044

M5:  CAFF-014 + CAFF-023 ── CAFF-050 ─┬─ CAFF-051 (CLI/TUI)
                                      └─ CAFF-052 (web dashboard)
```

Parallelizable within M1: CAFF-010, CAFF-011, CAFF-012 (and CAFF-016 after 010) can proceed concurrently before CAFF-013 joins them. M5 depends only on the core + event tap, so it can proceed in parallel with M3/M4 once CAFF-050 lands.

---

## 5. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Hit ratio doesn't beat LRU (policy bug) | Med | High | CAFF-040 gates release; deterministic sketch tests (CAFF-010); tie-break + sample-size tuning knobs. |
| Perf below target due to GC/object churn | Med | High | Intrusive lists + reused node objects; typed-array sketch; bench early (CAFF-034). |
| Node-only APIs leak into bundle, break browser/edge | Med | High | CAFF-030 isolates env; multi-runtime CI (CAFF-031); no `node:*` lint rule. |
| Timer-wheel complexity for variable expiry | Med | Med | Ship write/access-order lists first (CAFF-020); variable expiry (CAFF-021) is P2/optional. |
| Async coalescing races / promise leaks on rejection | Med | High | Explicit pending-entry cleanup on reject; concurrency tests with spies (CAFF-025). |
| Adaptive hill-climbing regresses hit ratio | Low | Med | Feature-flagged (CAFF-041); guard asserts no regression vs static window. |
| API churn breaks early adopters | Low | Med | Freeze contract in CAFF-004; changesets + semver (CAFF-044). |
| Object-key hashing id map grows unbounded | Low | Med | Use `WeakMap` for object→id so ids are GC'd with keys. |
| Byte-based bound is only approximate (JS can't size objects) | High | Med | Document clearly; ship estimator + optional `process.memoryUsage()` safety valve (CAFF-027); recommend explicit weigher. |
| Event tap taxes the hot path | Med | High | Single-boolean gate, zero cost when off; sampling; never emit values by default (CAFF-050). |
| Web dashboard floods socket on hot cache | Med | Med | Server-side batching/sampling + backpressure (CAFF-052). |
| Doorkeeper reset drifts out of sync with sketch aging | Low | Med | Reset bloom in the same aging pass as the CMS; unit-test the lockstep (CAFF-016). |

---

## 6. Definition of Done (Epic)

- All **P0** and **P1** tickets complete; P2/P3 explicitly deferred or done.
- All acceptance criteria checked; existing + new tests green in CI.
- Hit-ratio parity/superiority vs LRU proven on benchmark traces (CAFF-040) and CI-guarded.
- Runs verified on Node 18/20/22, a browser, Deno, Bun, and Workers (CAFF-031).
- Public API documented with runnable Node/browser/TS/React examples (CAFF-033).
- Bundle size budget met and tree-shaking verified (CAFF-043); zero runtime deps.
- No regressions: size bound, segment invariants, and memory bound hold under fuzz (CAFF-042).
- v1.0.0 published with provenance; fresh-install smoke passes (CAFF-044).
- Event tap adds zero measurable overhead when disabled (CAFF-050); CLI inspector renders live against a running cache (CAFF-051).
- Byte-based bounding documented as approximate with a working estimator (CAFF-027).

---

## Appendix A — W-TinyLFU Architecture (reference)

```
                    new entry
                        │
                        ▼
        ┌───────────────────────────────┐
        │   Admission Window (LRU, ~1%)  │
        └───────────────┬───────────────┘
                        │ window victim (candidate)
                        ▼
                ┌───────────────┐   freq(candidate) vs freq(victim)
                │  TinyLFU gate  │◄──── Count-Min Sketch (4-bit, aging)
                └───────┬───────┘
              admit ▲   │  reject → evict candidate
                    │   ▼
        ┌───────────────────────────────────────────┐
        │           Main region (SLRU, ~99%)         │
        │  ┌───────────────┐   ┌──────────────────┐  │
        │  │ Probation LRU │──▶│  Protected LRU    │  │
        │  │ (evict from   │   │  (~80% of main)   │  │
        │  │  LRU here)    │◄──│  demote on overflow│ │
        │  └───────────────┘   └──────────────────┘  │
        └───────────────────────────────────────────┘
```

Key data structures:
- **`Map<K, Node>`** — O(1) lookup, arbitrary key types.
- **Intrusive doubly-linked lists** — window, probation, protected, (write-order, access-order for TTL).
- **`Uint32Array` Count-Min Sketch** — 4-bit saturating counters, halve-on-aging every ~10× capacity increments.
- **`Node`** — `{ key, value, hash, weight, prev, next, queue, writeTime, accessTime }`, reused across queues.

## Appendix B — Proposed Public API (sketch)

```ts
import { caffeine } from "caffeine-js";

// Sync bounded cache
const cache = caffeine<string, User>({ maximumSize: 10_000 })
  .expireAfterWrite(60_000)
  .recordStats()
  .removalListener((k, v, cause) => log(cause))
  .build();

cache.set("u1", user);
cache.get("u1");            // User | undefined
cache.stats();             // { hitRate, evictionCount, ... }

// Async loading cache (stampede-safe)
const loading = caffeine<string, User>({ maximumSize: 10_000 })
  .buildAsync(async (id) => fetchUser(id));

await loading.get("u1");   // Promise<User>, coalesced

// React
import { useCachedValue } from "caffeine-js/react";
const { data, isLoading, error } = useCachedValue(loading, "u1");
```

## Appendix C — Memory capacity math (byte-bounding)

**JS gives no reliable per-object byte size**, so exact "1 GB" cannot be enforced natively.
Bound by explicit **weight (bytes)** via a weigher + estimator (CAFF-027), with an optional
`process.memoryUsage()` safety valve in Node.

Rough per-entry fixed overhead in V8 (excluding the stored value):

| Component | ~Bytes |
|-----------|--------|
| `Node` object (~9 fields) | ~110 |
| V8 `Map` slot | ~60 |
| Key string (~20 chars) | ~50 |
| CMS sketch share (per entry) | ~0.5 |
| **Fixed overhead / entry** | **~220** |

Items that fit in **1 GB** (overhead + value):

| Value size | Bytes/entry | Items in 1 GB |
|-----------|-------------|---------------|
| tiny (number / short string ~50 B) | ~270 B | **~4,000,000** |
| small object (~500 B) | ~720 B | **~1,500,000** |
| ~1 KB JSON | ~1.25 KB | **~850,000** |
| ~10 KB | ~10.2 KB | **~100,000** |
| ~100 KB blob | ~100 KB | **~10,000** |

Caveats:
- Node old-space default (~2 GB) — a 1 GB cache needs `--max-old-space-size` headroom or GC pauses appear near the ceiling.
- Browsers expose no heap API → estimates are best-effort only.
- The CMS/doorkeeper cost is negligible (~0.5 B/entry; ~5 MB for 10 M entries).
- **V8 `Map` hard cap ≈ 153M entries** (derived from `OrderedHashMap` `MaxCapacity()`; the widely-repeated 16.7M/2^24 figure is outdated). You will hit the memory ceiling long before the Map cap, so no JS-level sharding is needed purely for capacity. On edge runtimes (e.g. Cloudflare Workers, ~128 MB per isolate shared across requests) preallocation must be sized conservatively.
- Recommended: `caffeine({ maximumWeight: 1_073_741_824, weigher: estimateBytes })`.

## Appendix D — Known W-TinyLFU weaknesses & our mitigations

| Weakness of textbook W-TinyLFU | Our mitigation (ticket) |
|--------------------------------|-------------------------|
| Static 1% window underperforms on recency-skewed workloads | Adaptive hill-climbing window, default-on (CAFF-041) |
| CMS hash collisions inflate frequency → wrong admissions | Doorkeeper bloom filter fronts the CMS (CAFF-016) |
| Global halving (aging) is coarse; slow to adapt to shifts | Tuned sample size + doorkeeper; adaptive window reacts faster |
| Scattered CMS counters hurt memory locality | Block/bit-sliced sketch layout (CAFF-010) |
| Hot-key list-move churn wastes cycles | Batched policy maintenance via ring buffer (CAFF-017) |
| Weighted caches ignore item cost/size in admission | Future spike: cost-aware (GDSF-style) admission for weighted mode |
| Caffeine's lock-free concurrency machinery is complex | Dropped — single-threaded JS; ring buffers kept only for churn, not locking |
| Object-per-node layout balloons GC/heap at scale in V8 | Unified Structure-of-Arrays store (§2b, CAFF-009/012) |

## Appendix E — At-scale reference implementations & lessons (source-verified)

We benchmarked our design against proven at-scale caches, not just Java Caffeine. Key transferable ideas and citations:

| Source | Idea we adopt | Reference |
|--------|---------------|-----------|
| **isaacs/lru-cache** (JS) | SoA typed-array pointers; `getUintArray(max)` (Uint8/16/32 by 2^8/2^16/2^32); typed-array free-list `Stack`; full preallocation at construct time; `node:diagnostics_channel` for observability | `src/index.ts:60-108, 1296-1513` |
| **mnemonist** (JS) | SoA `forward`/`backward` pointer arrays for LRU; confirms the pattern | `lru-cache.js:36-56` |
| **velo-org/velo** (TS) | Only existing TS W-TinyLFU — correct sketch/segment sizing (window 1%, protected 80%); reference for CMS `Uint8Array(width*depth)`, reset at `width*10`. Gaps: plain-object keys, no TTL, no weights, unmaintained | `src/policy/tiny_lfu/*` |
| **dgraph/Ristretto** (Go) | Doorkeeper bloom + 4-bit CMS; **sampled-LFU eviction (sample of 5)**; lossy read-batch buffers | `policy.go`, `ring.go`, `sketch.go` |
| **moka / mini-moka** (Rust) | Flush buffers at **64 ops**; throttle maintenance to **300ms**, cap a run at **100ms**; **5-level timer wheel** (165 buckets) for TTL; entry generation for ABA/stale-slot detection | `common/concurrent/constants.rs`, `timer_wheel.rs`, `housekeeper.rs` |
| **V8 internals** | `Map` cap ≈153M (`OrderedHashMap::MaxCapacity`); short-string/int keys are fastest; memory is the real ceiling | `objects/ordered-hash-table.h:205-209` |
| **Edge runtimes** | Timers only fire in-request on CF Workers; `Date.now()` frozen during CPU; 128 MB/isolate → lazy expiry + `runMaintenance()`, no `setInterval` reliance | CF Workers limits/web-standards docs |

**Ecosystem gap confirmed:** no maintained, production-grade W-TinyLFU cache exists on npm (searches for `w-tinylfu`/`tinylfu` returned no standalone published library). Combined with the novel unified-SoA-across-segments layout, this library fills a real gap.

**What does NOT transfer from Java/Go/Rust:** store sharding, `sync.Pool`/goroutine pinning, background maintenance threads, `Arc`/reference counting, lock-free CAS — all artifacts of multi-threaded runtimes. Single-threaded JS does maintenance inline/deferred via the batched pipeline.


