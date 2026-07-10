import type { Expiry } from "../types.js";

/**
 * TTL expiration with lazy access-time checks and a 5-level hierarchical timer
 * wheel for amortized O(1) reclamation. No background timers required.
 */

/** Bits to shift a millisecond deadline to get the tick index for each level. */
const SHIFT = [10, 16, 22, 27, 29] as const;
/** Bucket count per level. All powers of two so `& (n-1)` masks the tick. */
const BUCKETS = [64, 64, 32, 4, 1] as const;
/** Duration (ms) spanned by a single tick at each level: 2^SHIFT[level]. */
const SPAN = SHIFT.map((s) => 2 ** s);
/** Coverage of each level = BUCKETS[i]*SPAN[i]; used to pick the target level. */
const COVER = BUCKETS.map((b, i) => b * SPAN[i]);
const LEVELS = SHIFT.length;

/** Prefix offsets of each level's buckets within the flat sentinel space. */
const BUCKET_OFFSET: number[] = [];
{
  let acc = 0;
  for (let i = 0; i < LEVELS; i++) {
    BUCKET_OFFSET.push(acc);
    acc += BUCKETS[i]!;
  }
}
const TOTAL_BUCKETS = BUCKET_OFFSET[LEVELS - 1]! + BUCKETS[LEVELS - 1]!;

export type ExpireCallback = (idx: number) => void;

/**
 * Hierarchical timer wheel over the cache's slot index space. Each bucket is a
 * circular doubly-linked list threaded through dedicated `next`/`prev` typed
 * arrays, so scheduling adds no per-entry object allocation. Sentinel nodes for
 * the buckets live at indices `physical + bucketOrdinal`.
 */
class TimerWheel {
  private readonly next: Int32Array;
  private readonly prev: Int32Array;
  private readonly base: number; // first sentinel index
  private nowTicks: number;

  constructor(physical: number, now: number) {
    const size = physical + TOTAL_BUCKETS;
    this.next = new Int32Array(size);
    this.prev = new Int32Array(size);
    this.base = physical;
    this.nowTicks = now;
    for (let i = 0; i < TOTAL_BUCKETS; i++) {
      const s = this.base + i;
      this.next[s] = s;
      this.prev[s] = s;
    }
  }

  private sentinelFor(deadline: number): number {
    const duration = deadline - this.nowTicks;
    for (let i = 0; i < LEVELS - 1; i++) {
      if (duration < COVER[i]!) {
        const ticks = Math.floor(deadline / SPAN[i]!);
        const bucket = ticks & (BUCKETS[i]! - 1);
        return this.base + BUCKET_OFFSET[i]! + bucket;
      }
    }
    return this.base + BUCKET_OFFSET[LEVELS - 1]!; // coarsest single bucket
  }

  private link(sentinel: number, idx: number): void {
    const first = this.next[sentinel]!;
    this.next[idx] = first;
    this.prev[idx] = sentinel;
    this.next[sentinel] = idx;
    this.prev[first] = idx;
  }

  private unlink(idx: number): void {
    const p = this.prev[idx]!;
    const n = this.next[idx]!;
    this.next[p] = n;
    this.prev[n] = p;
  }

  schedule(idx: number, deadline: number): void {
    this.link(this.sentinelFor(deadline), idx);
  }

  deschedule(idx: number): void {
    this.unlink(idx);
  }

  /**
   * Advances the wheel to `now`, reclaiming or re-bucketing every entry whose
   * tick has elapsed. `deadlineOf` reports an entry's current deadline (it may
   * have moved since scheduling, e.g. on access); still-future entries are
   * rescheduled into a finer level, expired ones are handed to `expire`.
   */
  advance(now: number, deadlineOf: (idx: number) => number, expire: ExpireCallback): void {
    const prevNow = this.nowTicks;
    this.nowTicks = now;
    for (let level = 0; level < LEVELS; level++) {
      const span = SPAN[level]!;
      const prevTicks = Math.floor(prevNow / span);
      const currTicks = Math.floor(now / span);
      const delta = currTicks - prevTicks;
      if (delta < 0) continue;
      // Level 0 stores near-term deadlines; if real time moved but not enough
      // to cross a tick boundary, the current bucket can still contain entries
      // whose deadline is now <= now.
      if (delta === 0 && (level !== 0 || now <= prevNow)) continue;
      this.expireLevel(level, prevTicks, delta, deadlineOf, expire);
    }
  }

  private expireLevel(
    level: number,
    prevTicks: number,
    delta: number,
    deadlineOf: (idx: number) => number,
    expire: ExpireCallback,
  ): void {
    const buckets = BUCKETS[level]!;
    const mask = buckets - 1;
    const steps = Math.min(delta + 1, buckets);
    const start = ((prevTicks & mask) + buckets) % buckets;
    const offset = this.base + BUCKET_OFFSET[level]!;
    for (let s = 0; s < steps; s++) {
      const sentinel = offset + ((start + s) & mask);
      // Detach the whole chain, then reprocess each node individually.
      let node = this.next[sentinel]!;
      this.next[sentinel] = sentinel;
      this.prev[sentinel] = sentinel;
      while (node !== sentinel) {
        const nextNode = this.next[node]!;
        if (deadlineOf(node) > this.nowTicks) {
          this.link(this.sentinelFor(deadlineOf(node)), node); // still future → refine
        } else {
          expire(node);
        }
        node = nextNode;
      }
    }
  }
}

/**
 * Ties per-entry deadlines to a timer wheel. Invokes the supplied `expire`
 * callback so removal listeners and stats stay in the cache.
 */
export class ExpiryPolicy<K, V> {
  private readonly writeTtl: number; // 0 = disabled
  private readonly accessTtl: number; // 0 = disabled
  private readonly expiry?: Expiry<K, V>;
  private readonly clock: () => number;
  private readonly wheel: TimerWheel;
  private readonly keyAt: (idx: number) => K;
  private readonly valueAt: (idx: number) => V;
  private readonly writeDeadline: Float64Array;
  private readonly accessDeadline: Float64Array;

  constructor(
    physical: number,
    expiry: Expiry<K, V> | undefined,
    writeTtl: number,
    accessTtl: number,
    clock: () => number,
    keyAt: (idx: number) => K,
    valueAt: (idx: number) => V,
  ) {
    this.expiry = expiry;
    this.writeTtl = writeTtl > 0 ? writeTtl : 0;
    this.accessTtl = accessTtl > 0 ? accessTtl : 0;
    this.clock = clock;
    this.keyAt = keyAt;
    this.valueAt = valueAt;
    this.writeDeadline = new Float64Array(physical).fill(Infinity);
    this.accessDeadline = new Float64Array(physical).fill(Infinity);
    this.wheel = new TimerWheel(physical, clock());
  }

  now(): number {
    return this.clock();
  }

  /** Effective deadline = the earliest of the two configured bounds. */
  private effective(idx: number): number {
    const w = this.writeDeadline[idx]!;
    const a = this.accessDeadline[idx]!;
    return w < a ? w : a;
  }

  private remaining(idx: number, now: number): number {
    const d = this.writeDeadline[idx]!;
    return d === Infinity ? Infinity : Math.max(0, d - now);
  }

  private clampDuration(ms: number): number {
    if (ms <= 0) return 0;
    if (!Number.isFinite(ms)) return Number.MAX_SAFE_INTEGER;
    return Math.min(ms, Number.MAX_SAFE_INTEGER);
  }

  /** Records a fresh write (create or overwrite) and (re)schedules the entry. */
  onWrite(idx: number, now: number, isNew: boolean): void {
    if (!isNew) this.wheel.deschedule(idx);

    if (this.expiry) {
      const key = this.keyAt(idx);
      const value = this.valueAt(idx);
      const duration = isNew
        ? this.clampDuration(this.expiry.expireAfterCreate(key, value, now))
        : this.clampDuration(
            this.expiry.expireAfterUpdate(key, value, now, this.remaining(idx, now)),
          );
      this.writeDeadline[idx] = duration > 0 ? now + duration : now;
      this.accessDeadline[idx] = Infinity;
    } else {
      this.writeDeadline[idx] = this.writeTtl > 0 ? now + this.writeTtl : Infinity;
      this.accessDeadline[idx] = this.accessTtl > 0 ? now + this.accessTtl : Infinity;
    }

    this.wheel.schedule(idx, this.effective(idx));
  }

  /** Records an access; reschedules when expire-after-access or per-entry read hook is enabled. */
  onAccess(idx: number, now: number): void {
    if (this.expiry?.expireAfterRead) {
      this.wheel.deschedule(idx);
      const duration = this.clampDuration(
        this.expiry.expireAfterRead(
          this.keyAt(idx),
          this.valueAt(idx),
          now,
          this.remaining(idx, now),
        ),
      );
      this.writeDeadline[idx] = duration > 0 ? now + duration : now;
      this.wheel.schedule(idx, this.effective(idx));
      return;
    }
    if (this.accessTtl === 0) return;
    this.wheel.deschedule(idx);
    this.accessDeadline[idx] = now + this.accessTtl;
    this.wheel.schedule(idx, this.effective(idx));
  }

  onRemove(idx: number): void {
    this.wheel.deschedule(idx);
    this.writeDeadline[idx] = Infinity;
    this.accessDeadline[idx] = Infinity;
  }

  /** Clears deadlines for an entry already detached from the wheel. */
  clearDeadline(idx: number): void {
    this.writeDeadline[idx] = Infinity;
    this.accessDeadline[idx] = Infinity;
  }

  isExpired(idx: number, now: number): boolean {
    return this.effective(idx) <= now;
  }

  advance(now: number, expire: ExpireCallback): void {
    this.wheel.advance(now, (i) => this.effective(i), expire);
  }

  reset(all: Iterable<number>): void {
    for (const idx of all) {
      this.wheel.deschedule(idx);
      this.writeDeadline[idx] = Infinity;
      this.accessDeadline[idx] = Infinity;
    }
  }
}
