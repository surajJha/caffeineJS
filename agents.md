# Agent Guide: caffeine-js

## Project

A zero-dependency, isomorphic in-memory cache for JavaScript/TypeScript implementing the Window-TinyLFU eviction policy. Ships ESM + CJS + IIFE, runs on Node 18+, browsers, Deno, Bun, and Workers.

## Architecture

```
src/
  index.ts          Public API: caffeine(), cache builders
  types.ts          Public interfaces (Cache, AsyncLoadingCache, CacheOptions, etc.)
  builder.ts        Fluent CacheBuilder
  cache.ts          Synchronous CaffeineCache (policy + store + expiry)
  async-cache.ts    Async loading cache with coalescing/refresh
  policy/
    window-tinylfu.ts  Admission + W-TinyLFU segment management
    frequency-sketch.ts Count-Min sketch for frequency estimates
    expiry.ts          Hierarchical timer wheel + variable/global TTL
  store/
    soa-store.ts       Structure-of-arrays hash table
  inspect/          Optional CLI/SSE observer subpath
  dashboard/        Optional browser + SSE server subpath
  react/            Optional React hook subpath
  util/             hash, estimate-bytes, typed-array helpers
  env.ts            Runtime capability detection
```

## Conventions

- **ESM only** source. Use `.ts` with `.js` specifiers for internal imports.
- **No runtime deps.** Peer deps only where appropriate (React).
- **Zero-overhead defaults.** Stats, observers, expiry, async loading are opt-in.
- **Structure-of-arrays.** Hot paths use typed arrays and sentinel-node linked lists, not per-entry objects.
- **Mutations drain reads first.** `policy.drainRead()` must precede any structural change (`set`, `delete`, `clear`).
- **Expiry is lazy + timer-wheel.** Expired entries are reclaimed on access; `runMaintenance()` advances the wheel for runtimes without background timers.
- **Removal listeners are deferred.** Enqueue records and drain after state is consistent so listeners can re-enter safely.
- **Observer events add zero overhead when disabled.** `CacheObserver.active` short-circuits before any allocation.

## Making Changes

1. Keep the public surface in `src/types.ts` and `src/index.ts`.
2. Add builder options in `builder.ts` and validate in `CaffeineCache`/`CaffeineAsyncCache` constructors.
3. Prefer stateless helpers; avoid closures on hot paths.
4. Update or add tests in `test/`. Run `npm test` before committing.
5. Run `npm run lint` and `npm run format:check`. The project uses ESLint flat config + Prettier.
6. Ensure `npm run build && npm run size && npm run pack:audit` still pass.
7. Cross-runtime source must not import `node:*` modules or rely on `setInterval` in core files (inspect/dashboard are exempt).

## Testing

- `npm test` runs Vitest in node environment.
- `npm run coverage` enforces thresholds.
- `npm run smoke:node` verifies the built ESM bundle end-to-end.
- Fuzz tests live in `test/fuzz.test.ts`; efficiency/hot-path benches live in `bench/`.

## Common Pitfalls

- **TTL and `maximumWeight` are mutually exclusive** in v1; validate and throw early.
- **Variable expiry (`expireAfter`) is mutually exclusive with global TTLs.**
- **Timer-wheel deadlines** must be clamped to safe floats; `Infinity` is valid and means non-expiring.
- **Access-order TTL updates** happen in `onAccess`, which is called after `isExpired` checks.
- **Dashboard/CLI use `cache.attachObserver?`** at runtime; the method is optional and internal.
- **Browser subpaths must not import Node built-ins.** Keep Node-only code in `dashboard/server.ts` and `inspect/`.
