/**
 * Cross-runtime environment shims. The cache core is pure and isomorphic — it
 * imports NO `node:*` built-ins and relies on NO background timers for
 * correctness (expiry is lazy + amortized via the timer wheel). This module is
 * the single place environment concerns are detected, so the rest of the code
 * stays runtime-agnostic (Node, browsers, Deno, Bun, Cloudflare Workers).
 */

/** True when a high-resolution monotonic clock is available. */
const HAS_PERF = typeof performance !== "undefined" && typeof performance.now === "function";

/**
 * Monotonic-ish millisecond timestamp for measuring durations (loader timing,
 * benchmarks). Prefers `performance.now()`; falls back to `Date.now()`.
 */
export const monotonicNow: () => number = HAS_PERF ? () => performance.now() : () => Date.now();

/**
 * Wall-clock millisecond timestamp, the default TTL clock. Always `Date.now`
 * so deadlines survive across `performance.now` epochs and match user intent
 * ("expire 60s from now"). Inject `options.clock` to override.
 */
export const wallClockNow: () => number = () => Date.now();

/**
 * Whether the runtime exposes background timers. The cache never needs these
 * for correctness; a host may opt into periodic `runMaintenance()` when true.
 */
export const hasBackgroundTimers: boolean =
  typeof setTimeout === "function" && typeof clearTimeout === "function";
