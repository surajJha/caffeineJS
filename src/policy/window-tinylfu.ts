import { FrequencySketch } from "./frequency-sketch.js";
import { SoaStore, NIL } from "../store/soa-store.js";

/** Segment tags stored in `store.segment`. */
const WINDOW = 0;
const PROBATION = 1;
const PROTECTED = 2;

/**
 * Window-TinyLFU eviction policy.
 *
 * Layout: a small LRU admission window (~1% of capacity) in front of a
 * segmented-LRU main region split into probation and protected (~80% of main).
 * New entries enter the window. When the window overflows, its LRU victim is
 * demoted to probation as an admission *candidate*; when the whole cache is
 * over capacity, the candidate's estimated frequency is compared against the
 * probation LRU *victim* and the loser is evicted. This is what lets the cache
 * keep frequently-used items that a plain LRU would drop.
 */
export class WindowTinyLfu<K, V> {
  private readonly store: SoaStore<K, V>;
  private readonly sketch: FrequencySketch;

  private readonly windowMax: number;
  private readonly protectedMax: number;

  private windowSize = 0;
  private probationSize = 0;
  private protectedSize = 0;

  constructor(store: SoaStore<K, V>, doorkeeper = true) {
    this.store = store;
    this.sketch = new FrequencySketch(store.capacity, doorkeeper);

    const capacity = store.capacity;
    this.windowMax = Math.max(1, Math.floor(capacity * 0.01));
    const mainMax = capacity - this.windowMax;
    this.protectedMax = Math.max(0, Math.floor(mainMax * 0.8));
  }

  /** Records a frequency observation for the key at `idx`. */
  recordAccessHash(hash: number): void {
    this.sketch.increment(hash);
  }

  /** Called after a brand-new slot has been allocated with its key/value. */
  onAdd(idx: number, sink: (victim: number) => void): void {
    this.sketch.increment(this.store.hashAt(idx));
    this.store.pushFront(this.store.WINDOW_HEAD, idx);
    this.store.segment[idx] = WINDOW;
    this.windowSize++;
    this.evict(sink);
  }

  /** Called on a cache hit for the live slot `idx`. */
  onAccess(idx: number): void {
    this.sketch.increment(this.store.hashAt(idx));
    const seg = this.store.segment[idx];
    if (seg === WINDOW) {
      this.store.unlink(idx);
      this.store.pushFront(this.store.WINDOW_HEAD, idx);
    } else if (seg === PROTECTED) {
      this.store.unlink(idx);
      this.store.pushFront(this.store.PROTECTED_HEAD, idx);
    } else {
      this.promoteToProtected(idx);
    }
  }

  /** Called when a live slot is explicitly removed (delete/replace). */
  onRemove(idx: number): void {
    this.store.unlink(idx);
    this.decSegment(this.store.segment[idx] as number);
  }

  reset(): void {
    this.windowSize = 0;
    this.probationSize = 0;
    this.protectedSize = 0;
  }

  private decSegment(seg: number): void {
    if (seg === WINDOW) this.windowSize--;
    else if (seg === PROBATION) this.probationSize--;
    else this.protectedSize--;
  }

  private promoteToProtected(idx: number): void {
    const s = this.store;
    s.unlink(idx);
    this.probationSize--;
    if (this.protectedSize >= this.protectedMax) {
      // Demote protected LRU back to probation to make room.
      const demote = s.back(s.PROTECTED_HEAD);
      if (demote !== NIL) {
        s.unlink(demote);
        this.protectedSize--;
        s.pushFront(s.PROBATION_HEAD, demote);
        s.segment[demote] = PROBATION;
        this.probationSize++;
      }
    }
    s.pushFront(s.PROTECTED_HEAD, idx);
    s.segment[idx] = PROTECTED;
    this.protectedSize++;
  }

  private evict(sink: (victim: number) => void): void {
    const s = this.store;

    // 1. Drain the admission window into probation (as candidates).
    while (this.windowSize > this.windowMax) {
      const victim = s.back(s.WINDOW_HEAD);
      if (victim === NIL) break;
      s.unlink(victim);
      this.windowSize--;
      s.pushFront(s.PROBATION_HEAD, victim);
      s.segment[victim] = PROBATION;
      this.probationSize++;
    }

    // 2. While over capacity, admit-or-reject from the main region.
    while (s.size > s.capacity) {
      this.evictFromMain(sink);
    }
  }

  private evictFromMain(sink: (victim: number) => void): void {
    const s = this.store;

    // Prefer evicting from probation; fall back to protected, then window.
    if (this.probationSize > 0) {
      const candidate = s.front(s.PROBATION_HEAD); // MRU: most recent demotion
      const victim = s.back(s.PROBATION_HEAD); // LRU: eviction candidate

      if (candidate === victim || candidate === NIL) {
        this.evictSlot(victim, PROBATION, sink);
        return;
      }

      const freqC = this.sketch.frequency(s.hashAt(candidate));
      const freqV = this.sketch.frequency(s.hashAt(victim));
      if (freqC > freqV) {
        this.evictSlot(victim, PROBATION, sink); // admit candidate
      } else {
        this.evictSlot(candidate, PROBATION, sink); // reject candidate
      }
      return;
    }

    if (this.protectedSize > 0) {
      this.evictSlot(s.back(s.PROTECTED_HEAD), PROTECTED, sink);
      return;
    }

    this.evictSlot(s.back(s.WINDOW_HEAD), WINDOW, sink);
  }

  private evictSlot(idx: number, seg: number, sink: (victim: number) => void): void {
    if (idx === NIL) return;
    this.store.unlink(idx);
    this.decSegment(seg);
    sink(idx);
  }
}
