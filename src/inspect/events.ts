import type { RemovalCause, CacheObserver as ICacheObserver, Occupancy } from "../types.js";

/** Logical W-TinyLFU segment for events. */
export type Segment = "window" | "probation" | "protected";

/** Common fields carried by every cache event. */
interface BaseEvent<K, V> {
  type: string;
  /** Key that triggered the event (absent if `includeKeys: false`). */
  key?: K;
  /** Value, only present when `includeValues: true`. */
  value?: V;
  occupancy: Occupancy;
}

/** A cache hit. */
export interface HitEvent<K, V> extends BaseEvent<K, V> {
  type: "hit";
  segment: Segment;
  /** Estimated frequency from the TinyLFU sketch (0..15). */
  freq: number;
}

/** A cache miss. */
export interface MissEvent<K, V> extends BaseEvent<K, V> {
  type: "miss";
}

/** A window-demoted candidate was admitted into the main region. */
export interface AdmitEvent<K, V> extends BaseEvent<K, V> {
  type: "admit";
  segment: Segment;
  freq: number;
}

/** A window-demoted candidate was rejected by the TinyLFU gate. */
export interface RejectEvent<K, V> extends BaseEvent<K, V> {
  type: "reject";
  segment: Segment;
  freq: number;
}

/** An entry moved from probation to protected. */
export interface PromoteEvent<K, V> extends BaseEvent<K, V> {
  type: "promote";
  freq: number;
}

/** An entry moved from protected to probation. */
export interface DemoteEvent<K, V> extends BaseEvent<K, V> {
  type: "demote";
  freq: number;
}

/** An entry left the cache. */
export interface EvictEvent<K, V> extends BaseEvent<K, V> {
  type: "evict";
  segment: Segment;
  freq: number;
  cause: RemovalCause;
}

/** The adaptive hill-climber resized segment maxima. */
export interface ResizeEvent<K, V> extends BaseEvent<K, V> {
  type: "resize";
  windowMax: number;
  protectedMax: number;
}

/** The frequency sketch aged (halved counters / doorkeeper cleared). */
export interface AgeEvent<K, V> extends BaseEvent<K, V> {
  type: "age";
}

/** Union of all events emitted by the cache event tap. */
export type CacheEvent<K, V> =
  | HitEvent<K, V>
  | MissEvent<K, V>
  | AdmitEvent<K, V>
  | RejectEvent<K, V>
  | PromoteEvent<K, V>
  | DemoteEvent<K, V>
  | EvictEvent<K, V>
  | ResizeEvent<K, V>
  | AgeEvent<K, V>;

/** Options for a {@link CacheObserver}. */
export interface ObserverOptions {
  /** Include the key in events (default true). */
  includeKeys?: boolean;
  /** Include the value in events (default false). */
  includeValues?: boolean;
  /** Fraction of events to emit, 0..1 (default 1). */
  sampleRate?: number;
}

/** Callback receiving each emitted event. */
export type ObserverCallback<K, V> = (event: CacheEvent<K, V>) => void;

/** Lightweight emitter used by the cache when an observer is registered. */
export class CacheObserver<K, V> implements ICacheObserver<K, V> {
  private readonly cb: ObserverCallback<K, V>;
  private readonly includeKeys: boolean;
  private readonly includeValues: boolean;
  private readonly sampleRate: number;

  constructor(cb: ObserverCallback<K, V>, options: ObserverOptions = {}) {
    this.cb = cb;
    this.includeKeys = options.includeKeys !== false;
    this.includeValues = options.includeValues === true;
    this.sampleRate = Math.max(0, Math.min(1, options.sampleRate ?? 1));
  }

  /** @internal true if the caller should bother building an event. */
  get active(): boolean {
    return !this.skip();
  }

  private skip(): boolean {
    if (this.sampleRate <= 0) return true;
    if (this.sampleRate < 1 && Math.random() >= this.sampleRate) return true;
    return false;
  }

  private send(event: CacheEvent<K, V>): void {
    try {
      this.cb(event);
    } catch {
      // Observer errors must not break cache operations.
    }
  }

  emitHit(args: {
    key: K;
    value: V;
    hash: number;
    segment: number;
    freq: number;
    occupancy: Occupancy;
  }): void {
    if (this.skip()) return;
    const event: HitEvent<K, V> = {
      type: "hit",
      key: this.includeKeys ? args.key : undefined,
      value: this.includeValues ? args.value : undefined,
      segment: segName(args.segment),
      freq: args.freq,
      occupancy: args.occupancy,
    };
    this.send(event);
  }

  emitMiss(args: { key: K; occupancy: Occupancy }): void {
    if (this.skip()) return;
    const event: MissEvent<K, V> = {
      type: "miss",
      key: this.includeKeys ? args.key : undefined,
      occupancy: args.occupancy,
    };
    this.send(event);
  }

  emitAdmit(args: {
    key: K;
    value: V;
    hash: number;
    segment: number;
    freq: number;
    occupancy: Occupancy;
  }): void {
    if (this.skip()) return;
    const event: AdmitEvent<K, V> = {
      type: "admit",
      key: this.includeKeys ? args.key : undefined,
      value: this.includeValues ? args.value : undefined,
      segment: segName(args.segment),
      freq: args.freq,
      occupancy: args.occupancy,
    };
    this.send(event);
  }

  emitReject(args: {
    key: K;
    value: V;
    hash: number;
    segment: number;
    freq: number;
    occupancy: Occupancy;
  }): void {
    if (this.skip()) return;
    const event: RejectEvent<K, V> = {
      type: "reject",
      key: this.includeKeys ? args.key : undefined,
      value: this.includeValues ? args.value : undefined,
      segment: segName(args.segment),
      freq: args.freq,
      occupancy: args.occupancy,
    };
    this.send(event);
  }

  emitPromote(args: { key: K; value: V; hash: number; freq: number; occupancy: Occupancy }): void {
    if (this.skip()) return;
    const event: PromoteEvent<K, V> = {
      type: "promote",
      key: this.includeKeys ? args.key : undefined,
      value: this.includeValues ? args.value : undefined,
      freq: args.freq,
      occupancy: args.occupancy,
    };
    this.send(event);
  }

  emitDemote(args: { key: K; value: V; hash: number; freq: number; occupancy: Occupancy }): void {
    if (this.skip()) return;
    const event: DemoteEvent<K, V> = {
      type: "demote",
      key: this.includeKeys ? args.key : undefined,
      value: this.includeValues ? args.value : undefined,
      freq: args.freq,
      occupancy: args.occupancy,
    };
    this.send(event);
  }

  emitEvict(args: {
    key: K;
    value: V;
    hash: number;
    segment: number;
    freq: number;
    cause: RemovalCause;
    occupancy: Occupancy;
  }): void {
    if (this.skip()) return;
    const event: EvictEvent<K, V> = {
      type: "evict",
      key: this.includeKeys ? args.key : undefined,
      value: this.includeValues ? args.value : undefined,
      segment: segName(args.segment),
      freq: args.freq,
      cause: args.cause,
      occupancy: args.occupancy,
    };
    this.send(event);
  }

  emitResize(args: { windowMax: number; protectedMax: number; occupancy: Occupancy }): void {
    if (this.skip()) return;
    const event: ResizeEvent<K, V> = {
      type: "resize",
      windowMax: args.windowMax,
      protectedMax: args.protectedMax,
      occupancy: args.occupancy,
    };
    this.send(event);
  }

  emitAge(args: { occupancy: Occupancy }): void {
    if (this.skip()) return;
    const event: AgeEvent<K, V> = {
      type: "age",
      occupancy: args.occupancy,
    };
    this.send(event);
  }
}

function segName(seg: number): Segment {
  if (seg === 0) return "window";
  if (seg === 1) return "probation";
  return "protected";
}

/** @internal Map internal segment number to public name. */
export { segName };
