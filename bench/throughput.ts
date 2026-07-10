/**
 * CAFF-034 throughput harness.
 *
 * Reports ops/sec for caffeine-js vs lru-cache vs a plain Map across key types
 * (integer / short-string / object — V8 performance differs wildly by key type)
 * and scenarios (fill, hot-get, mixed 80/20, count-bound vs weight-bound, TTL).
 *
 * Run: npm run bench:throughput   (add --expose-gc for heap numbers)
 */
import { caffeine } from "../src/index.js";
import { LRUCache } from "lru-cache";
import { nowMs, opsPerSec, gc, heapMB, zipfStream } from "./lib.js";

const CAP = 100_000;
const STREAM = 500_000;
const UNIVERSE = 1_000_000;
const SKEW = 3;

type KeyType = "int" | "string" | "object";
type AnyKey = number | string | object;
const objectKeys: object[] = [];

function keyFor(kind: KeyType, n: number): number | string | object {
  if (kind === "int") return n;
  if (kind === "string") return "k:" + n;
  return (objectKeys[n] ??= { id: n });
}

interface Row {
  name: string;
  fill: string;
  hotGet: string;
  mixed: string;
  heapMB: number;
}

function benchMap(kind: KeyType, stream: Int32Array): Row {
  gc();
  const before = heapMB();
  const m = new Map<AnyKey, number>();
  let t = nowMs();
  for (let i = 0; i < CAP; i++) m.set(keyFor(kind, i), i);
  const fill = nowMs() - t;
  t = nowMs();
  let sink = 0;
  for (let i = 0; i < stream.length; i++) {
    const v = m.get(keyFor(kind, (stream[i] as number) % CAP));
    if (v !== undefined) sink += v;
  }
  const hot = nowMs() - t;
  t = nowMs();
  for (let i = 0; i < stream.length; i++) {
    const k = keyFor(kind, (stream[i] as number) % CAP);
    if (i % 5 === 0) m.set(k, i);
    else m.get(k);
  }
  const mixed = nowMs() - t;
  if (sink === -1) console.log(sink);
  return {
    name: `Map(${kind})`,
    fill: opsPerSec(CAP, fill),
    hotGet: opsPerSec(stream.length, hot),
    mixed: opsPerSec(stream.length, mixed),
    heapMB: heapMB() - before,
  };
}

function benchLru(kind: KeyType, stream: Int32Array): Row {
  gc();
  const before = heapMB();
  const c = new LRUCache<AnyKey, number>({ max: CAP });
  let t = nowMs();
  for (let i = 0; i < CAP; i++) c.set(keyFor(kind, i), i);
  const fill = nowMs() - t;
  t = nowMs();
  let sink = 0;
  for (let i = 0; i < stream.length; i++) {
    const v = c.get(keyFor(kind, (stream[i] as number) % CAP));
    if (v !== undefined) sink += v;
  }
  const hot = nowMs() - t;
  t = nowMs();
  for (let i = 0; i < stream.length; i++) {
    const k = keyFor(kind, (stream[i] as number) % CAP);
    if (i % 5 === 0) c.set(k, i);
    else c.get(k);
  }
  const mixed = nowMs() - t;
  if (sink === -1) console.log(sink);
  return {
    name: `lru-cache(${kind})`,
    fill: opsPerSec(CAP, fill),
    hotGet: opsPerSec(stream.length, hot),
    mixed: opsPerSec(stream.length, mixed),
    heapMB: heapMB() - before,
  };
}

function benchCaffeine(kind: KeyType, stream: Int32Array): Row {
  gc();
  const before = heapMB();
  const c = caffeine<AnyKey, number>({ maximumSize: CAP }).build();
  let t = nowMs();
  for (let i = 0; i < CAP; i++) c.set(keyFor(kind, i), i);
  const fill = nowMs() - t;
  t = nowMs();
  let sink = 0;
  for (let i = 0; i < stream.length; i++) {
    const v = c.get(keyFor(kind, (stream[i] as number) % CAP));
    if (v !== undefined) sink += v;
  }
  const hot = nowMs() - t;
  t = nowMs();
  for (let i = 0; i < stream.length; i++) {
    const k = keyFor(kind, (stream[i] as number) % CAP);
    if (i % 5 === 0) c.set(k, i);
    else c.get(k);
  }
  const mixed = nowMs() - t;
  if (sink === -1) console.log(sink);
  return {
    name: `caffeine-js(${kind})`,
    fill: opsPerSec(CAP, fill),
    hotGet: opsPerSec(stream.length, hot),
    mixed: opsPerSec(stream.length, mixed),
    heapMB: heapMB() - before,
  };
}

function table(rows: Row[]): void {
  console.log(
    [
      "cache".padEnd(22),
      "fill".padEnd(15),
      "hot-get".padEnd(15),
      "mixed".padEnd(15),
      "heapMB",
    ].join(""),
  );
  for (const r of rows) {
    console.log(
      [
        r.name.padEnd(22),
        r.fill.padEnd(15),
        r.hotGet.padEnd(15),
        r.mixed.padEnd(15),
        r.heapMB.toFixed(1),
      ].join(""),
    );
  }
}

function main(): void {
  const stream = zipfStream(STREAM, UNIVERSE, SKEW);
  console.log(
    `\nThroughput — cap=${CAP.toLocaleString()} stream=${STREAM.toLocaleString()} skew=${SKEW}`,
  );
  console.log(`Node ${process.version}\n`);
  for (const kind of ["int", "string", "object"] as KeyType[]) {
    console.log(`— key type: ${kind} —`);
    table([benchCaffeine(kind, stream), benchLru(kind, stream), benchMap(kind, stream)]);
    console.log("");
  }

  // Weight-bound vs count-bound (int keys).
  console.log("— weight-bound vs count-bound (caffeine-js, int) —");
  const wt = ((): Row => {
    gc();
    const before = heapMB();
    const c = caffeine<number, number>({})
      .maximumWeight(CAP, () => 1)
      .expectedEntries(CAP)
      .build();
    let t = nowMs();
    for (let i = 0; i < CAP; i++) c.set(i, i);
    const fill = nowMs() - t;
    t = nowMs();
    let sink = 0;
    for (let i = 0; i < stream.length; i++) {
      const v = c.get((stream[i] as number) % CAP);
      if (v !== undefined) sink += v;
    }
    const hot = nowMs() - t;
    if (sink === -1) console.log(sink);
    return {
      name: "weight-bound",
      fill: opsPerSec(CAP, fill),
      hotGet: opsPerSec(stream.length, hot),
      mixed: "-",
      heapMB: heapMB() - before,
    };
  })();
  table([wt]);
}

main();
