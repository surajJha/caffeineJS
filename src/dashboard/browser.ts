import { CacheObserver, type CacheEvent, type ObserverOptions } from "../inspect/events.js";
import type { Cache, Occupancy } from "../types.js";

export interface RenderDashboardOptions extends ObserverOptions {
  /** Maximum events to keep in the live log (default 30). */
  maxEvents?: number;
}

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
      <div class="caffeine-log"><ul></ul></div>
    </div>
  `;
  const dashboard = root.querySelector(".caffeine-dashboard") as HTMLElement;
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
  };
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
  let gateTimer: ReturnType<typeof setTimeout> | undefined;

  const observer = new CacheObserver<K, V>((event) => {
    ops++;
    if (event.type === "hit") hits++;
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

  return () => {
    clearTimeout(gateTimer);
    cache.attachObserver!(undefined);
    container.innerHTML = "";
  };
}
