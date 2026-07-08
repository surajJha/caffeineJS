# Why W-TinyLFU (vs LRU and LFU)

`caffeine-js` uses **Window-TinyLFU (W-TinyLFU)** — the admission/eviction policy
popularized by [Caffeine](https://github.com/ben-manes/caffeine). This page explains,
in plain terms, why it beats the classic LRU and LFU policies on real workloads.

## The problem with LRU and LFU

- **LRU (Least Recently Used)** keeps whatever you touched most recently. It handles
  temporal locality well, but it is easily wrecked by a **scan** (one pass over a large
  key range flushes the whole cache) and it retains **one-hit wonders** — keys accessed
  once and never again.
- **LFU (Least Frequently Used)** keeps whatever you touched most often. It resists scans,
  but a naive LFU never forgets: keys that were hot yesterday linger forever, and it adapts
  slowly to shifting workloads. Exact LFU also needs a counter per key, which is expensive.

Neither policy is a clear winner — each loses badly on the other's weakness.

## What W-TinyLFU does

W-TinyLFU combines a small **recency window** with a large **frequency-filtered main region**,
and uses a compact frequency sketch to decide admissions.

```
 new key ─▶ [ Admission Window (LRU, ~1%) ]
                     │ window victim (candidate)
                     ▼
              [ TinyLFU gate ] ◀── Count-Min Sketch (4-bit, aged)
              admit if freq(candidate) > freq(main victim)
                     │
                     ▼
        [ Main region: SLRU — Probation ⇄ Protected (~99%) ]
```

1. **New keys enter a tiny LRU window** (~1% of capacity). This absorbs bursts and gives
   brand-new keys a chance before judging them — so short-lived recency is captured.
2. **When the window overflows**, its victim ("candidate") competes with the main region's
   eviction victim. The **TinyLFU gate** admits the candidate only if its estimated
   frequency is higher. This is what makes the cache **scan-resistant**: a scan's
   one-hit keys have frequency 1 and lose the admission contest.
3. **Frequency is estimated by a Count-Min Sketch** — a 4-bit-per-counter array, not a
   per-key counter. It is **periodically halved** ("aging"), so old popularity decays and
   the cache adapts to workload shifts — fixing LFU's "never forgets" flaw.
4. A **doorkeeper bloom filter** fronts the sketch so single-access keys don't pollute it.

## Extra optimizations in `caffeine-js`

- **Adaptive window (on by default):** the window/main ratio is tuned online via
  hill-climbing, so recency-heavy workloads get a bigger window automatically. See
  `.adaptive(false)` to pin a fixed ~1% window for deterministic behavior.
- **Structure-of-Arrays storage:** all per-entry metadata lives in typed arrays with a
  free-list — no object-per-node — which keeps GC pressure and heap low at millions of entries.
- **Batched maintenance:** reads are recorded into a ring buffer and drained in batches,
  so hot-key reads don't thrash the linked lists.

## When each policy wins (measured)

From `npm run bench:hitratio` (Zipfian/scan/one-hit-wonder traces):

| Workload         | caffeine-js | LRU   | LFU   | FIFO  |
| ---------------- | ----------- | ----- | ----- | ----- |
| zipf(skew=2)     | **best**    | worse | tie   | worst |
| zipf(skew=3)     | **best**    | worse | tie   | worst |
| loop-scan        | **best**    | 0%    | 0%    | 0%    |
| one-hit-wonder   | **best**    | worse | tie   | worse |
| bursty (recency) | good        | best  | worst | best  |

Takeaway: W-TinyLFU matches or beats LRU on skewed and scan-heavy workloads (the common case
for databases, search, and web caches) while staying close to LRU on pure-recency bursts.

## Comparison to popular npm caches

| Library          | Policy          | Scan-resistant | Frequency-aware | TTL | Weights | Async loader | Isomorphic |
| ---------------- | --------------- | -------------- | --------------- | --- | ------- | ------------ | ---------- |
| **caffeine-js**  | **W-TinyLFU**   | ✅              | ✅               | ✅   | ✅       | ✅            | ✅          |
| `lru-cache`      | LRU             | ❌              | ❌               | ✅   | ✅       | ✅ (fetch)    | ✅          |
| `quick-lru`      | LRU (2-segment) | partial        | ❌               | ✅   | ❌       | ❌            | ✅          |
| `mnemonist` LRU  | LRU/LFU         | ❌              | partial         | ❌   | ❌       | ❌            | ✅          |

See [`README.md`](../README.md) for the API and quickstart, and the `examples/` directory
for runnable snippets.
