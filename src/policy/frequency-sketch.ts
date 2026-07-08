import { fmix32 } from "../util/hash.js";
import { nextPowerOfTwo } from "../util/typed-array.js";

/**
 * Count-Min Sketch with 4-bit saturating counters plus a doorkeeper bloom
 * filter, as used by TinyLFU (Caffeine / Ristretto).
 *
 * - 4 counters per key (depth=4), packed 2-per-byte into a `Uint8Array`.
 * - `frequency` returns the min across the 4 counters (+1 if the doorkeeper
 *   has seen the key), saturating at 15.
 * - Aging: after `sampleSize` (= width * 10) increments, every counter is
 *   halved (`>>> 1`) and the doorkeeper is cleared. This decays stale
 *   popularity so the sketch tracks a moving window of demand.
 *
 * The doorkeeper absorbs one-hit-wonders: a key's first touch only sets a
 * bloom bit (freq contribution 1) and does not pollute the CMS counters.
 */
const DEPTH = 4;
const MAX_COUNT = 15;

export class FrequencySketch {
  private readonly width: number;
  private readonly mask: number;
  private readonly table: Uint8Array; // 4-bit counters, 2 per byte
  private readonly door: Uint32Array; // doorkeeper bloom bits
  private readonly doorMask: number;
  private readonly sampleSize: number;
  private size = 0;
  private readonly doorkeeperEnabled: boolean;

  constructor(capacity: number, doorkeeper = true) {
    const width = nextPowerOfTwo(Math.max(capacity, 8));
    this.width = width;
    this.mask = width - 1;
    // width*DEPTH counters, 2 counters per byte.
    this.table = new Uint8Array((width * DEPTH) >> 1);
    this.sampleSize = width * 10;
    this.doorkeeperEnabled = doorkeeper;
    // Doorkeeper sized to width bits, rounded to 32-bit words.
    const doorWords = Math.max(1, width >> 5);
    this.door = new Uint32Array(doorWords);
    this.doorMask = doorWords * 32 - 1;
  }

  /** Adds 1 to the 4-bit counter at nibble position, saturating at 15. */
  private addNibble(nibbleIndex: number): boolean {
    const byteIndex = nibbleIndex >> 1;
    const byte = this.table[byteIndex] as number;
    if ((nibbleIndex & 1) === 0) {
      const v = byte & 0x0f;
      if (v >= MAX_COUNT) return false;
      this.table[byteIndex] = (byte & 0xf0) | (v + 1);
    } else {
      const v = byte >> 4;
      if (v >= MAX_COUNT) return false;
      this.table[byteIndex] = (byte & 0x0f) | ((v + 1) << 4);
    }
    return true;
  }

  private doorContains(h2: number): boolean {
    const bit = h2 & this.doorMask;
    return ((this.door[bit >> 5] as number) & (1 << (bit & 31))) !== 0;
  }

  /** @returns true if the bit was newly set (key not previously seen). */
  private doorSet(h2: number): boolean {
    const bit = h2 & this.doorMask;
    const word = bit >> 5;
    const flag = 1 << (bit & 31);
    const prev = this.door[word] as number;
    if ((prev & flag) !== 0) return false;
    this.door[word] = prev | flag;
    return true;
  }

  /** Estimated frequency of `h` (0..15). */
  frequency(h: number): number {
    // Double hashing: one extra mix yields DEPTH independent probes cheaply.
    const h2 = fmix32(h);
    const width = this.width;
    const mask = this.mask;
    const table = this.table;
    let min = MAX_COUNT;
    let probe = h;
    for (let d = 0; d < DEPTH; d++) {
      const nibbleIndex = d * width + (probe & mask);
      const byte = table[nibbleIndex >> 1] as number;
      const c = (nibbleIndex & 1) === 0 ? byte & 0x0f : byte >> 4;
      if (c < min) min = c;
      probe = (probe + h2) | 0;
    }
    if (this.doorkeeperEnabled && min < MAX_COUNT && this.doorContains(h2)) {
      min += 1;
    }
    return min;
  }

  /** Records one access of `h`, aging the sketch when the sample fills. */
  increment(h: number): void {
    const h2 = fmix32(h);
    if (this.doorkeeperEnabled && this.doorSet(h2)) {
      // First sighting: doorkeeper only, don't touch CMS counters.
      if (++this.size >= this.sampleSize) this.reset();
      return;
    }
    const width = this.width;
    const mask = this.mask;
    let added = false;
    let probe = h;
    for (let d = 0; d < DEPTH; d++) {
      if (this.addNibble(d * width + (probe & mask))) added = true;
      probe = (probe + h2) | 0;
    }
    if (added && ++this.size >= this.sampleSize) this.reset();
  }

  /** Halves every counter and clears the doorkeeper (aging pass). */
  private reset(): void {
    const t = this.table;
    for (let i = 0; i < t.length; i++) {
      // Halve both nibbles of the byte at once.
      t[i] = ((t[i] as number) >> 1) & 0x77;
    }
    this.door.fill(0);
    this.size = 0;
  }
}
