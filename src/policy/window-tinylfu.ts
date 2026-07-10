import { FrequencySketch } from "./frequency-sketch.js";
import { SoaStore, NIL } from "../store/soa-store.js";
import type { CacheObserver, Occupancy } from "../types.js";

/** Segment tags stored in `store.segment`. */
const WINDOW = 0;
const PROBATION = 1;
const PROTECTED = 2;

/**
 * Window-TinyLFU eviction policy, bounded by **weight**.
 *
 * Layout: a small LRU admission window (~1% of the weight bound) in front of a
 * segmented-LRU main region split into probation and protected (~80% of main).
 * New entries enter the window. When the window overflows, its LRU victim is
 * demoted to probation as an admission *candidate*; when the whole cache is
 * over its weight bound, the candidate's estimated frequency is compared
 * against the probation LRU *victim* and the loser is evicted. This is what
 * lets the cache keep frequently-used items that a plain LRU would drop.
 *
 * A count-bounded cache is the special case where every entry has weight 1, so
 * weighted size equals entry count and the bound equals the maximum size.
 */
/** Capacity of the deferred read buffer (power of two). */
const READ_BUFFER_SIZE = 64;

// --- Hill-climbing constants (Caffeine's adaptive scheme) ---
/** Step size as a fraction of the weight bound when restarting the climb. */
const HILL_STEP_PERCENT = 0.0625;
/** Multiplicative decay applied to the step as it converges. */
const HILL_STEP_DECAY = 0.9;
/** Hit-rate swing that triggers a full-size restart of the climb. */
const HILL_RESTART_THRESHOLD = 0.05;

export class WindowTinyLfu<K, V> {
  private readonly store: SoaStore<K, V>;
  private readonly sketch: FrequencySketch;

  /** The total weight bound (entry count for count-bounded caches). */
  private readonly maximumWeight: number;

  /** Mutable segment maxima (weight units) — adjusted by the adaptive climber. */
  private windowMax: number;
  private protectedMax: number;

  private windowWeight = 0;
  private probationWeight = 0;
  private protectedWeight = 0;
  /** Running total across all three segments. */
  private weightedSize = 0;

  // --- Adaptive window sizing (CAFF-041) ---
  private readonly adaptive: boolean;
  private readonly sampleSize: number;
  private hitsInSample = 0;
  private missesInSample = 0;
  private previousHitRate = 0;
  private stepSize: number;
  private warmedUp = false;

  /**
   * Deferred read buffer (CAFF-017). Cache hits append the accessed slot index
   * here instead of paying for a sketch increment + LRU reorder inline. The
   * buffer is drained in a tight batch before any structural mutation and when
   * it fills. Because reads never free slots, every buffered index stays live
   * and in the same segment until the next drain — so no generation tokens are
   * needed to validate entries at drain time.
   */
  private readonly readBuffer: Int32Array;
  private readBufferLen = 0;

  /** Opt-in event observer (zero cost when undefined). */
  private observer?: CacheObserver<K, V>;
  private hasObserver: boolean;

  constructor(
    store: SoaStore<K, V>,
    doorkeeper = true,
    adaptive = true,
    maximumWeight?: number,
    expectedEntries?: number,
    observer?: CacheObserver<K, V>,
  ) {
    this.store = store;
    this.observer = observer;
    this.hasObserver = observer !== undefined;
    const bound = maximumWeight ?? store.capacity;
    this.maximumWeight = bound;
    const sketchEntries = expectedEntries ?? store.capacity;
    this.sketch = new FrequencySketch(sketchEntries, doorkeeper, () => {
      if (this.hasObserver) {
        this.observer!.emitAge({ occupancy: this.occupancy() });
      }
    });
    this.readBuffer = new Int32Array(READ_BUFFER_SIZE);

    this.windowMax = Math.max(1, Math.floor(bound * 0.01));
    const mainMax = bound - this.windowMax;
    this.protectedMax = Math.max(0, Math.floor(mainMax * 0.8));

    this.adaptive = adaptive;
    // Re-evaluate the window ratio once per ~10× expected-entries accesses.
    this.sampleSize = Math.max(10, sketchEntries * 10);
    // Start at zero so the first sample only calibrates the baseline hit rate
    // (no window jerk while previousHitRate is still 0); the climb ramps after.
    this.stepSize = 0;
  }

  /** Current admission-window maximum (exposed for tests/observability). */
  get windowMaximum(): number {
    return this.windowMax;
  }

  /** Current protected-region maximum. */
  get protectedMaximum(): number {
    return this.protectedMax;
  }

  /** Attach/detach an observer after construction (used by the inspector). */
  setObserver(observer?: CacheObserver<K, V>): void {
    this.observer = observer;
    this.hasObserver = observer !== undefined;
  }

  /** Estimated frequency of the key currently in `idx`. */
  frequencyAt(idx: number): number {
    return this.sketch.frequency(this.store.hashAt(idx));
  }

  /** Current segment-occupancy snapshot. */
  occupancy(): Occupancy {
    return {
      windowWeight: this.windowWeight,
      probationWeight: this.probationWeight,
      protectedWeight: this.protectedWeight,
      weightedSize: this.weightedSize,
      windowMax: this.windowMax,
      protectedMax: this.protectedMax,
    };
  }

  /** Records a frequency observation for a key hash. */
  recordAccessHash(hash: number): void {
    this.sketch.increment(hash);
  }

  /** Called after a brand-new slot has been allocated with its key/value. */
  onAdd(idx: number, sink: (victim: number) => void): void {
    const w = this.store.weightAt(idx);
    this.sketch.increment(this.store.hashAt(idx));
    this.store.pushFront(this.store.WINDOW_HEAD, idx);
    this.store.segment[idx] = WINDOW;
    this.windowWeight += w;
    this.weightedSize += w;
    this.evict(sink);
  }

  /**
   * Adjusts bookkeeping when an existing entry's weight changes on overwrite,
   * then evicts if the new weight pushed the cache over its bound.
   */
  onReplaceWeight(idx: number, oldW: number, newW: number, sink: (victim: number) => void): void {
    const delta = newW - oldW;
    if (delta === 0) return;
    const seg = this.store.segment[idx];
    if (seg === WINDOW) this.windowWeight += delta;
    else if (seg === PROBATION) this.probationWeight += delta;
    else this.protectedWeight += delta;
    this.weightedSize += delta;
    if (delta > 0) this.evict(sink);
  }

  onAccessBuffered(idx: number): void {
    const len = this.readBufferLen;
    if (len > 0 && this.readBuffer[len - 1] === idx) return;
    if (len >= READ_BUFFER_SIZE) {
      this.drainRead();
      this.readBuffer[0] = idx;
      this.readBufferLen = 1;
      return;
    }
    this.readBuffer[len] = idx;
    this.readBufferLen = len + 1;
  }

  /** Applies all buffered reads (sketch increments + LRU reorders) in a batch. */
  drainRead(): void {
    const len = this.readBufferLen;
    if (len === 0) return;
    const buf = this.readBuffer;
    for (let k = 0; k < len; k++) {
      this.applyAccess(buf[k] as number);
    }
    this.readBufferLen = 0;
  }

  /** Immediate cache hit (used on the replace path, when the buffer is empty). */
  onAccess(idx: number): void {
    this.applyAccess(idx);
  }

  private applyAccess(idx: number): void {
    this.sketch.increment(this.store.hashAt(idx));
    const seg = this.store.segment[idx];
    if (seg === WINDOW) {
      if (this.store.front(this.store.WINDOW_HEAD) === idx) return;
      this.store.unlink(idx);
      this.store.pushFront(this.store.WINDOW_HEAD, idx);
    } else if (seg === PROTECTED) {
      if (this.store.front(this.store.PROTECTED_HEAD) === idx) return;
      this.store.unlink(idx);
      this.store.pushFront(this.store.PROTECTED_HEAD, idx);
    } else {
      this.promoteToProtected(idx);
    }
  }

  /** Called when a live slot is explicitly removed (delete/replace). */
  onRemove(idx: number): void {
    const w = this.store.weightAt(idx);
    this.store.unlink(idx);
    this.decSegment(this.store.segment[idx] as number, w);
    this.weightedSize -= w;
  }

  reset(): void {
    this.windowWeight = 0;
    this.probationWeight = 0;
    this.protectedWeight = 0;
    this.weightedSize = 0;
    this.readBufferLen = 0;
    this.hitsInSample = 0;
    this.missesInSample = 0;
    this.previousHitRate = 0;
    this.warmedUp = false;
  }

  recordSample(hit: boolean): void {
    if (!this.adaptive) return;
    if (hit) this.hitsInSample++;
    else this.missesInSample++;
    if (this.hitsInSample + this.missesInSample >= this.sampleSize) {
      this.climb();
    }
  }

  private climb(): void {
    const requests = this.hitsInSample + this.missesInSample;
    const hitRate = this.hitsInSample / requests;
    this.hitsInSample = 0;
    this.missesInSample = 0;

    if (!this.warmedUp) {
      this.warmedUp = true;
      this.previousHitRate = hitRate;
      this.stepSize = HILL_STEP_PERCENT * this.maximumWeight;
      return;
    }

    const delta = hitRate - this.previousHitRate;
    this.previousHitRate = hitRate;

    const amount = delta >= 0 ? this.stepSize : -this.stepSize;
    this.stepSize =
      Math.abs(delta) >= HILL_RESTART_THRESHOLD
        ? HILL_STEP_PERCENT * this.maximumWeight * (amount >= 0 ? 1 : -1)
        : HILL_STEP_DECAY * amount;

    const step = Math.trunc(amount);
    if (step !== 0) {
      this.drainRead();
      this.resizeWindow(step);
    }
  }

  /**
   * Shifts weight capacity between the admission window and the main region by
   * `delta` (positive grows the window), then rebalances segment occupancy back
   * within the new maxima. Total bound is unchanged, so no evictions occur here
   * — overflow is absorbed by probation.
   */
  private resizeWindow(delta: number): void {
    const bound = this.maximumWeight;
    const newWindowMax = Math.min(bound - 1, Math.max(1, this.windowMax + delta));
    const applied = newWindowMax - this.windowMax;
    if (applied === 0) return;
    this.windowMax = newWindowMax;
    this.protectedMax = Math.max(0, this.protectedMax - applied);

    if (this.hasObserver) {
      this.observer!.emitResize({
        windowMax: this.windowMax,
        protectedMax: this.protectedMax,
        occupancy: this.occupancy(),
      });
    }

    const s = this.store;
    while (this.windowWeight > this.windowMax) {
      const victim = s.back(s.WINDOW_HEAD);
      if (victim === NIL) break;
      const w = s.weightAt(victim);
      s.unlink(victim);
      this.windowWeight -= w;
      s.pushFront(s.PROBATION_HEAD, victim);
      s.segment[victim] = PROBATION;
      this.probationWeight += w;
    }
    while (this.protectedWeight > this.protectedMax) {
      const victim = s.back(s.PROTECTED_HEAD);
      if (victim === NIL) break;
      const w = s.weightAt(victim);
      s.unlink(victim);
      this.protectedWeight -= w;
      s.pushFront(s.PROBATION_HEAD, victim);
      s.segment[victim] = PROBATION;
      this.probationWeight += w;
    }
  }

  private decSegment(seg: number, w: number): void {
    if (seg === WINDOW) this.windowWeight -= w;
    else if (seg === PROBATION) this.probationWeight -= w;
    else this.protectedWeight -= w;
  }

  private promoteToProtected(idx: number): void {
    const s = this.store;
    const w = s.weightAt(idx);
    s.unlink(idx);
    this.probationWeight -= w;
    if (this.hasObserver) {
      this.observer!.emitPromote({
        key: s.keyAt(idx),
        value: s.valueAt(idx),
        hash: s.hashAt(idx),
        freq: this.frequencyAt(idx),
        occupancy: this.occupancy(),
      });
    }
    while (this.protectedWeight + w > this.protectedMax) {
      const demote = s.back(s.PROTECTED_HEAD);
      if (demote === NIL) break;
      const dw = s.weightAt(demote);
      s.unlink(demote);
      this.protectedWeight -= dw;
      s.pushFront(s.PROBATION_HEAD, demote);
      s.segment[demote] = PROBATION;
      this.probationWeight += dw;
      if (this.hasObserver) {
        this.observer!.emitDemote({
          key: s.keyAt(demote),
          value: s.valueAt(demote),
          hash: s.hashAt(demote),
          freq: this.frequencyAt(demote),
          occupancy: this.occupancy(),
        });
      }
    }
    s.pushFront(s.PROTECTED_HEAD, idx);
    s.segment[idx] = PROTECTED;
    this.protectedWeight += w;
  }

  private evict(sink: (victim: number) => void): void {
    const s = this.store;

    // 1. Drain the admission window into probation (as candidates).
    while (this.windowWeight > this.windowMax) {
      const victim = s.back(s.WINDOW_HEAD);
      if (victim === NIL) break;
      const w = s.weightAt(victim);
      s.unlink(victim);
      this.windowWeight -= w;
      s.pushFront(s.PROBATION_HEAD, victim);
      s.segment[victim] = PROBATION;
      this.probationWeight += w;
    }

    // 2. While over the weight bound, admit-or-reject from the main region.
    while (this.weightedSize > this.maximumWeight) {
      if (!this.evictFromMain(sink)) break;
    }
  }

  private evictFromMain(sink: (victim: number) => void): boolean {
    const s = this.store;

    if (this.probationWeight > 0) {
      const candidate = s.front(s.PROBATION_HEAD);
      const victim = s.back(s.PROBATION_HEAD);

      if (candidate === victim || candidate === NIL) {
        return this.evictSlot(victim, PROBATION, sink);
      }

      const freqC = this.sketch.frequency(s.hashAt(candidate));
      const freqV = this.sketch.frequency(s.hashAt(victim));
      if (this.hasObserver) {
        if (freqC > freqV) {
          this.observer!.emitAdmit({
            key: s.keyAt(candidate),
            value: s.valueAt(candidate),
            hash: s.hashAt(candidate),
            segment: PROBATION,
            freq: freqC,
            occupancy: this.occupancy(),
          });
        } else {
          this.observer!.emitReject({
            key: s.keyAt(candidate),
            value: s.valueAt(candidate),
            hash: s.hashAt(candidate),
            segment: PROBATION,
            freq: freqC,
            occupancy: this.occupancy(),
          });
        }
      }
      if (freqC > freqV) {
        return this.evictSlot(victim, PROBATION, sink);
      }
      return this.evictSlot(candidate, PROBATION, sink);
    }

    if (this.protectedWeight > 0) {
      return this.evictSlot(s.back(s.PROTECTED_HEAD), PROTECTED, sink);
    }

    return this.evictSlot(s.back(s.WINDOW_HEAD), WINDOW, sink);
  }

  private evictSlot(idx: number, seg: number, sink: (victim: number) => void): boolean {
    if (idx === NIL) return false;
    const w = this.store.weightAt(idx);
    this.store.unlink(idx);
    this.decSegment(seg, w);
    this.weightedSize -= w;
    sink(idx);
    return true;
  }
}
