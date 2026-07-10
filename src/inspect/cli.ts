import type { Cache } from "../types.js";
import { Aggregator, bar, pct, segmentLabel } from "./aggregator.js";
import { CacheObserver } from "./events.js";
import type { CacheEvent } from "./events.js";

/** Options for the live CLI inspector. */
export interface InspectorOptions {
  /** Refresh interval in milliseconds (default 250). */
  refreshMs?: number;
  /** Maximum events to show in the recent stream (default 40). */
  recentSize?: number;
  /** Rolling window size for hit-rate/histogram (default 500). */
  rollingWindow?: number;
}

/** Handle returned by {@link attachInspector}; call `stop()` to detach. */
export interface InspectorHandle {
  stop(): void;
}

export function attachInspector(
  cache: Cache<unknown, unknown>,
  options: InspectorOptions = {},
): InspectorHandle {
  const refreshMs = Math.max(50, options.refreshMs ?? 250);
  const aggregator = new Aggregator({
    recentSize: options.recentSize,
    rollingWindow: options.rollingWindow,
  });

  const observer = new CacheObserver<unknown, unknown>(
    (event: CacheEvent<unknown, unknown>) => aggregator.ingest(event),
    { includeKeys: true },
  );

  const attachable = cache as unknown as {
    attachObserver?: (observer?: CacheObserver<unknown, unknown>) => void;
  };
  if (typeof attachable.attachObserver !== "function") {
    throw new Error(
      "Cache does not support runtime observer attachment. Build with .observer(...) or use createInspectedCache().",
    );
  }
  attachable.attachObserver(observer);

  const isTTY =
    typeof process !== "undefined" && process.stdout != null && process.stdout.isTTY === true;

  let stopped = false;

  const render = (): void => {
    const s = aggregator.snapshot();
    if (isTTY) {
      process.stdout.write("\x1b[2J\x1b[H" + renderDashboard(s));
    } else {
      // eslint-disable-next-line no-console
      console.log(renderSnapshot(s));
    }
  };

  const onExit = (): void => {
    stop();
    process.exit(0);
  };

  if (isTTY) {
    process.stdout.write("\x1b[?25l"); // hide cursor
    process.on("SIGINT", onExit);
    process.on("SIGTERM", onExit);
  }

  const timer = setInterval(render, refreshMs);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    if (isTTY) {
      process.stdout.write("\x1b[?25h\n"); // show cursor
      process.off("SIGINT", onExit);
      process.off("SIGTERM", onExit);
    }
    attachable.attachObserver?.(undefined);
  };

  return { stop };
}

function renderDashboard(s: ReturnType<Aggregator["snapshot"]>): string {
  const occ = s.occupancy;
  const total = occ.weightedSize || 1;
  const lines: string[] = [
    "╔══════════════════════════════════════════════════════════════════╗",
    "║  caffeine-js live inspector                                      ║",
    "╠══════════════════════════════════════════════════════════════════╣",
    `║  ops: ${pad(String(s.totalOps), 10)}  hit-rate: ${pad(pct(s.hitRate), 7)}                              ║`,
    "╠══════════════════════════════════════════════════════════════════╣",
  ];

  const segments: Array<[string, number, number]> = [
    ["Window     ", occ.windowWeight, occ.windowMax],
    ["Probation  ", occ.probationWeight, total - occ.protectedWeight - occ.windowWeight],
    ["Protected  ", occ.protectedWeight, occ.protectedMax],
  ];
  for (const [label, weight, max] of segments) {
    const ratio = max > 0 ? weight / max : 0;
    const ofTotal = weight / total;
    lines.push(
      `║ ${label} ${bar(ratio, 20)} ${pad(pct(ofTotal), 6)} (${weight}/${max > 0 ? max : "∞"})          ║`,
    );
  }

  lines.push(
    `║ Hit-rate   ${bar(s.hitRate, 20)} ${pad(pct(s.hitRate), 6)} (${s.hits}/${s.hits + s.misses})           ║`,
  );

  lines.push("╠══════════════════════════════════════════════════════════════════╣");
  const counts = s.eventCounts;
  const countLine = [
    `admit:${counts.admit ?? 0}`,
    `reject:${counts.reject ?? 0}`,
    `promote:${counts.promote ?? 0}`,
    `demote:${counts.demote ?? 0}`,
    `evict:${counts.evict ?? 0}`,
    `age:${counts.age ?? 0}`,
    `resize:${counts.resize ?? 0}`,
  ].join("  ");
  lines.push(`║ ${pad(countLine, 64)} ║`);

  lines.push("╠══════════════════════════════════════════════════════════════════╣");
  lines.push("║ Recent events                                                    ║");
  const recent = s.recent.slice(-12);
  if (recent.length === 0) {
    lines.push("║ (waiting for events…)                                            ║");
  } else {
    for (const e of recent) {
      lines.push(`║ ${pad(formatEvent(e), 64)} ║`);
    }
  }
  lines.push("╚══════════════════════════════════════════════════════════════════╝");
  return lines.join("\n");
}

function renderSnapshot(s: ReturnType<Aggregator["snapshot"]>): string {
  const lines = [
    `[caffeine-js inspector] ${new Date(s.ts).toISOString()}`,
    `ops=${s.totalOps} hit-rate=${pct(s.hitRate)}`,
    `occupancy=${JSON.stringify(s.occupancy)}`,
    `events=${JSON.stringify(s.eventCounts)}`,
  ];
  return lines.join(" | ");
}

function formatEvent(e: CacheEvent<unknown, unknown>): string {
  const name = e.type.padEnd(7);
  const key = e.key !== undefined ? String(e.key).slice(0, 20) : "<anon>";
  if (e.type === "hit" || e.type === "admit" || e.type === "reject" || e.type === "evict") {
    const seg = "segment" in e ? segmentLabel(e.segment) : "";
    const cause = e.type === "evict" ? `cause=${e.cause}` : "";
    return `${name} ${key} ${seg} freq=${e.freq}${cause ? " " + cause : ""}`;
  }
  if (e.type === "promote" || e.type === "demote") {
    return `${name} ${key} freq=${e.freq}`;
  }
  if (e.type === "resize") {
    return `${name} windowMax=${e.windowMax} protectedMax=${e.protectedMax}`;
  }
  if (e.type === "age") {
    return `${name} sketch reset`;
  }
  return `${name} ${key}`;
}

function pad(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n);
}
