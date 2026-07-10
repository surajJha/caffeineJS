import { CacheObserver, type CacheEvent, type ObserverOptions } from "../inspect/events.js";
import type { Cache, Occupancy } from "../types.js";

export interface RenderDashboardOptions extends ObserverOptions {
  /** Maximum events to keep in the live log (default 30). */
  maxEvents?: number;
}

const HISTORY_POINTS = 120;
const HISTORY_EVERY_MS = 500;

const CSS = `
.caffeine-dashboard{font-family:system-ui,-apple-system,sans-serif;font-size:13px;color:#e6edf3;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px;min-width:320px}
.caffeine-dashboard h3{margin:0 0 10px;font-size:15px;color:#58a6ff}
.caffeine-metrics{display:flex;gap:16px;margin-bottom:12px;flex-wrap:wrap}
.caffeine-metrics span{opacity:.9}
.caffeine-metrics b{color:#7ee787}
.caffeine-segments{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
.caffeine-segments .row{display:flex;align-items:center;gap:8px}
.caffeine-segments label{width:74px;opacity:.8}
.caffeine-segments .bar{flex:1;height:18px;background:#21262d;border-radius:4px;overflow:hidden;position:relative}
.caffeine-segments .fill{height:100%;width:0%;transition:width .2s ease}
.caffeine-segments .window .fill{background:#79c0ff}
.caffeine-segments .probation .fill{background:#d2a8ff}
.caffeine-segments .protected .fill{background:#56d364}
.caffeine-segments .text{position:absolute;right:6px;top:2px;font-size:11px;color:#fff;text-shadow:0 1px 2px #000}
.caffeine-gate{display:flex;justify-content:center;align-items:center;height:34px;border:1px dashed #484f58;border-radius:6px;margin-bottom:12px;color:#8b949e;font-size:12px;transition:all .2s}
.caffeine-gate.admit{background:#12261e;color:#56d364;border-color:#238636}
.caffeine-gate.reject{background:#2a1619;color:#f85149;border-color:#da3633}
.caffeine-charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:12px}
.caffeine-chart{background:#161b22;border:1px solid #21262d;border-radius:6px;padding:8px}
.caffeine-chart canvas{width:100%;height:80px}
.caffeine-chart h4{margin:0 0 6px;font-size:11px;text-transform:uppercase;opacity:.7}
.caffeine-heatmap{display:grid;grid-template-columns:repeat(16,1fr);gap:2px;margin-top:6px}
.caffeine-heatmap .cell{aspect-ratio:1;border-radius:2px;background:#21262d}
.caffeine-log{max-height:180px;overflow:auto;background:#161b22;border-radius:6px;padding:6px}
.caffeine-log ul{list-style:none;margin:0;padding:0}
.caffeine-log li{font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;padding:2px 0;border-bottom:1px solid #21262d}
.caffeine-log li:last-child{border-bottom:none}
`;

function createDOM(root: HTMLElement): {
  ops: HTMLElement;
  hitRate: HTMLElement;
  size: HTMLElement;
  ratio: HTMLElement;
  fills: Record<string, HTMLElement>;
  gate: HTMLElement;
  log: HTMLElement;
  charts: {
    hitRate: HTMLCanvasElement;
    size: HTMLCanvasElement;
    evict: HTMLCanvasElement;
  };
  heatmap: HTMLElement;
} {
  root.innerHTML = `
    <style>${CSS}</style>
    <div class="caffeine-dashboard">
      <h3>caffeine-js dashboard</h3>
      <div class="caffeine-metrics">
        <span>ops <b class="ops">0</b></span>
        <span>hit-rate <b class="hit-rate">0.0%</b></span>
        <span>size <b class="size">0</b></span>
        <span>window <b class="ratio">1%</b></span>
      </div>
      <div class="caffeine-segments">
        <div class="row window"><label>window</label><div class="bar"><div class="fill"></div><div class="text"></div></div></div>
        <div class="row probation"><label>probation</label><div class="bar"><div class="fill"></div><div class="text"></div></div></div>
        <div class="row protected"><label>protected</label><div class="bar"><div class="fill"></div><div class="text"></div></div></div>
      </div>
      <div class="caffeine-gate">admission gate idle</div>
      <div class="caffeine-charts">
        <div class="caffeine-chart"><h4>hit-rate %</h4><canvas class="hit-rate-chart"></canvas></div>
        <div class="caffeine-chart"><h4>size</h4><canvas class="size-chart"></canvas></div>
        <div class="caffeine-chart"><h4>evictions / sec</h4><canvas class="evict-chart"></canvas></div>
        <div class="caffeine-chart"><h4>frequency heatmap</h4><div class="caffeine-heatmap"></div></div>
      </div>
      <div class="caffeine-log"><ul></ul></div>
    </div>
  `;
  const dashboard = root.querySelector(".caffeine-dashboard") as HTMLElement;
  const heatmap = dashboard.querySelector(".caffeine-heatmap") as HTMLElement;
  for (let i = 0; i < 64; i++) {
    const cell = document.createElement("div");
    cell.className = "cell";
    heatmap.appendChild(cell);
  }
  return {
    ops: dashboard.querySelector(".ops") as HTMLElement,
    hitRate: dashboard.querySelector(".hit-rate") as HTMLElement,
    size: dashboard.querySelector(".size") as HTMLElement,
    ratio: dashboard.querySelector(".ratio") as HTMLElement,
    fills: {
      window: dashboard.querySelector(".row.window .fill") as HTMLElement,
      probation: dashboard.querySelector(".row.probation .fill") as HTMLElement,
      protected: dashboard.querySelector(".row.protected .fill") as HTMLElement,
    },
    gate: dashboard.querySelector(".caffeine-gate") as HTMLElement,
    log: dashboard.querySelector(".caffeine-log ul") as HTMLElement,
    charts: {
      hitRate: dashboard.querySelector(".hit-rate-chart") as HTMLCanvasElement,
      size: dashboard.querySelector(".size-chart") as HTMLCanvasElement,
      evict: dashboard.querySelector(".evict-chart") as HTMLCanvasElement,
    },
    heatmap,
  };
}

class HistoryBuffer {
  private readonly data: Float64Array;
  private write = 0;
  private count = 0;

  constructor(readonly length: number) {
    this.data = new Float64Array(length);
  }

  push(value: number): void {
    this.data[this.write] = value;
    this.write = (this.write + 1) % this.length;
    if (this.count < this.length) this.count++;
  }

  snapshot(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.write - this.count + i + this.length) % this.length;
      out.push(this.data[idx]!);
    }
    return out;
  }
}

function drawLine(
  canvas: HTMLCanvasElement,
  values: number[],
  { min = 0, max, color = "#58a6ff" }: { min?: number; max?: number; color?: string } = {},
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);
  if (values.length < 2) return;
  const lo = min;
  const hi = max ?? Math.max(...values, 1);
  const range = hi - lo || 1;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  for (let i = 0; i < values.length; i++) {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((values[i]! - lo) / range) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function updateHeatmap(heatmap: HTMLElement, buckets: number[]): void {
  const cells = heatmap.children;
  const max = Math.max(1, ...buckets);
  for (let i = 0; i < cells.length; i++) {
    const intensity = buckets[i]! / max;
    const cell = cells[i] as HTMLElement;
    const hue = 120 + (1 - intensity) * 240; // green -> purple
    cell.style.backgroundColor = `hsla(${hue},80%,50%,${0.2 + intensity * 0.8})`;
  }
}

function renderOccupancy(els: ReturnType<typeof createDOM>, occ: Occupancy): void {
  const total = Math.max(1, occ.weightedSize);
  const set = (name: keyof typeof els.fills, value: number, max: number) => {
    const pct = Math.min(100, Math.round((value / total) * 100));
    const bar = els.fills[name]!;
    bar.style.width = `${pct}%`;
    const text = bar.nextElementSibling as HTMLElement;
    text.textContent = `${value}/${Math.round(max)}`;
  };
  set("window", occ.windowWeight, occ.windowMax);
  set("probation", occ.probationWeight, total - occ.windowMax);
  set("protected", occ.protectedWeight, occ.protectedMax);
  els.size.textContent = String(occ.weightedSize);
  const main = Math.max(1, total - occ.windowMax);
  els.ratio.textContent = `${Math.round((occ.windowMax / (occ.windowMax + main)) * 100)}%`;
}

function renderEvent(els: ReturnType<typeof createDOM>, event: CacheEvent<unknown, unknown>): void {
  const key = "key" in event && event.key !== undefined ? String(event.key) : "—";
  const seg = "segment" in event ? event.segment : "—";
  const freq = "freq" in event ? event.freq : "—";
  const line = document.createElement("li");
  line.textContent = `${event.type.padEnd(8)} ${key.padEnd(8)} seg=${seg} freq=${freq}`;
  els.log.prepend(line);
}

/**
 * Render a live W-TinyLFU dashboard inside `container`, attached to `cache`.
 * Returns a cleanup function that detaches the observer and clears the DOM.
 */
export function renderDashboard<K, V>(
  container: HTMLElement,
  cache: Cache<K, V>,
  options: RenderDashboardOptions = {},
): () => void {
  const els = createDOM(container);
  const maxEvents = options.maxEvents ?? 30;

  let ops = 0;
  let hits = 0;
  let lastEvictCheck = performance.now();
  let evictsSinceCheck = 0;
  const hitRateHistory = new HistoryBuffer(HISTORY_POINTS);
  const sizeHistory = new HistoryBuffer(HISTORY_POINTS);
  const evictHistory = new HistoryBuffer(HISTORY_POINTS);
  const freqBuckets = new Array(64).fill(0);
  let gateTimer: ReturnType<typeof setTimeout> | undefined;
  let lastOccupancy: Occupancy = {
    windowWeight: 0,
    probationWeight: 0,
    protectedWeight: 0,
    weightedSize: 0,
    windowMax: 1,
    protectedMax: 1,
  };

  const sampleHistory = (): void => {
    hitRateHistory.push((hits / Math.max(1, ops)) * 100);
    sizeHistory.push(lastOccupancy.weightedSize);
    const now = performance.now();
    const secs = (now - lastEvictCheck) / 1000;
    evictHistory.push(Math.round(evictsSinceCheck / Math.max(0.001, secs)));
    evictsSinceCheck = 0;
    lastEvictCheck = now;
    drawLine(els.charts.hitRate, hitRateHistory.snapshot(), { min: 0, max: 100, color: "#79c0ff" });
    drawLine(els.charts.size, sizeHistory.snapshot(), { color: "#56d364" });
    drawLine(els.charts.evict, evictHistory.snapshot(), { color: "#f85149" });
  };

  const observer = new CacheObserver<K, V>((event) => {
    ops++;
    if (event.type === "hit") hits++;
    if (event.type === "evict") {
      evictsSinceCheck++;
    }
    if ("freq" in event && typeof event.freq === "number") {
      const idx = Math.min(63, event.freq);
      freqBuckets[idx] = (freqBuckets[idx] || 0) + 1;
      updateHeatmap(els.heatmap, freqBuckets);
    }

    lastOccupancy = event.occupancy;
    els.ops.textContent = String(ops);
    els.hitRate.textContent = `${((hits / Math.max(1, ops)) * 100).toFixed(1)}%`;

    renderOccupancy(els, event.occupancy);
    renderEvent(els, event);
    while (els.log.children.length > maxEvents) {
      els.log.lastElementChild?.remove();
    }

    if (event.type === "admit" || event.type === "reject") {
      const kind = event.type;
      const freq = "freq" in event ? event.freq : "?";
      els.gate.className = `caffeine-gate ${kind}`;
      els.gate.textContent = `${kind.toUpperCase()} candidate freq=${freq}`;
      clearTimeout(gateTimer);
      gateTimer = setTimeout(() => {
        els.gate.className = "caffeine-gate";
        els.gate.textContent = "admission gate idle";
      }, 600);
    }
  }, options);

  cache.attachObserver!(observer);
  const historyTimer = setInterval(sampleHistory, HISTORY_EVERY_MS);
  sampleHistory();

  return () => {
    clearTimeout(gateTimer);
    clearInterval(historyTimer);
    cache.attachObserver!(undefined);
    container.innerHTML = "";
  };
}
