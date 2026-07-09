import type { CacheEvent, Segment } from "./events.js";

type TimedEvent = CacheEvent<unknown, unknown> & { ts: number };

/** Rolling summary used by the CLI and web dashboards. */
export interface Snapshot {
  /** Timestamp (ms) when the snapshot was taken. */
  ts: number;
  /** Operations observed since the inspector started. */
  totalOps: number;
  /** Total hits observed. */
  hits: number;
  /** Total misses observed. */
  misses: number;
  /** Hit rate over the rolling window (0..1). */
  hitRate: number;
  /** Count of each event type in the rolling window. */
  eventCounts: Record<string, number>;
  /** Current segment occupancy (from the most recent event). */
  occupancy: {
    windowWeight: number;
    probationWeight: number;
    protectedWeight: number;
    weightedSize: number;
    windowMax: number;
    protectedMax: number;
  };
  /** Frequency histogram buckets (0..15) from recent hit events. */
  freqHistogram: number[];
  /** Recent raw events (newest last), capped for display. */
  recent: CacheEvent<unknown, unknown>[];
}

/** Options for {@link Aggregator}. */
export interface AggregatorOptions {
  /** Maximum number of recent events to keep. */
  recentSize?: number;
  /** Length of the rolling hit-rate/histogram window. */
  rollingWindow?: number;
}

/**
 * Consumes cache events and produces a rolling snapshot for visualizers.
 * Cheap: it only keeps a small circular buffer of recent events and counters.
 */
export class Aggregator {
  private readonly recentSize: number;
  private readonly rollingWindow: number;
  private readonly recent: TimedEvent[] = [];
  private readonly rolling: TimedEvent[] = [];
  private readonly freq: number[] = new Array(16).fill(0);
  private hits = 0;
  private misses = 0;
  private totalOps = 0;
  private lastOccupancy = {
    windowWeight: 0,
    probationWeight: 0,
    protectedWeight: 0,
    weightedSize: 0,
    windowMax: 0,
    protectedMax: 0,
  };

  constructor(options: AggregatorOptions = {}) {
    this.recentSize = Math.max(10, options.recentSize ?? 40);
    this.rollingWindow = Math.max(100, options.rollingWindow ?? 500);
  }

  /** Ingest one cache event. */
  ingest(event: CacheEvent<unknown, unknown>): void {
    this.totalOps++;
    const now = Date.now();
    const ev = { ...event, ts: now } as TimedEvent;

    if (ev.type === "hit") {
      this.hits++;
      this.freq[Math.min(15, Math.max(0, ev.freq))]++;
    } else if (ev.type === "miss") {
      this.misses++;
    }

    if (ev.occupancy) this.lastOccupancy = ev.occupancy;

    this.recent.push(ev);
    if (this.recent.length > this.recentSize) this.recent.shift();

    this.rolling.push(ev);
    if (this.rolling.length > this.rollingWindow) {
      const old = this.rolling.shift()!;
      if (old.type === "hit") {
        this.hits--;
        this.freq[Math.min(15, Math.max(0, old.freq))]--;
      } else if (old.type === "miss") {
        this.misses--;
      }
    }
  }

  /** Current snapshot. */
  snapshot(): Snapshot {
    const total = this.hits + this.misses;
    return {
      ts: Date.now(),
      totalOps: this.totalOps,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
      eventCounts: this.countRecentTypes(),
      occupancy: { ...this.lastOccupancy },
      freqHistogram: [...this.freq],
      recent: [...this.recent],
    };
  }

  private countRecentTypes(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const e of this.recent) {
      counts[e.type] = (counts[e.type] ?? 0) + 1;
    }
    return counts;
  }
}

/** @internal Helper for drawing segment bars. */
export function bar(ratio: number, width = 20): string {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** @internal Format a percentage. */
export function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** @internal Name of segment for display. */
export function segmentLabel(s: Segment): string {
  if (s === "window") return "Window";
  if (s === "probation") return "Probation";
  return "Protected";
}
