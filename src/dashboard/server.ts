import { CacheObserver, type ObserverOptions } from "../inspect/events.js";
import type { CacheEvent } from "../inspect/events.js";
import type { Cache } from "../types.js";

export interface ServeDashboardOptions extends ObserverOptions {
  /** HTTP port; 0 picks an available port (default 0). */
  port?: number;
  /** Maximum events buffered per SSE client before dropping (default 64). */
  bufferSize?: number;
}

export interface DashboardServer {
  url: string;
  stop(): Promise<void>;
}

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>caffeine-js dashboard</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;margin:0;padding:24px;display:flex;justify-content:center}
    #root{width:min(720px,100%)}
    .caffeine-dashboard{font-size:13px;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px}
    .caffeine-dashboard h3{margin:0 0 10px;font-size:15px;color:#58a6ff}
    .caffeine-metrics{display:flex;gap:16px;margin-bottom:12px;flex-wrap:wrap}
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
    .caffeine-log{max-height:240px;overflow:auto;background:#161b22;border-radius:6px;padding:6px}
    .caffeine-log ul{list-style:none;margin:0;padding:0}
    .caffeine-log li{font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;padding:2px 0;border-bottom:1px solid #21262d}
    .caffeine-log li:last-child{border-bottom:none}
  </style>
</head>
<body>
  <div id="root">
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
      <div class="caffeine-gate">connecting…</div>
      <div class="caffeine-log"><ul></ul></div>
    </div>
  </div>
  <script>
    const $ = (s) => document.querySelector(s);
    const fills = { window: $('.row.window .fill'), probation: $('.row.probation .fill'), protected: $('.row.protected .fill') };
    const gate = $('.caffeine-gate');
    const log = $('.caffeine-log ul');
    let ops = 0, hits = 0, gateTimer;

    function setBar(name, value, total, max) {
      const pct = Math.min(100, Math.round((value / Math.max(1, total)) * 100));
      fills[name].style.width = pct + '%';
      fills[name].nextElementSibling.textContent = value + '/' + Math.round(max);
    }

    function render(event) {
      ops++;
      if (event.type === 'hit') hits++;
      $('.ops').textContent = ops;
      $('.hit-rate').textContent = ((hits / Math.max(1, ops)) * 100).toFixed(1) + '%';
      const o = event.occupancy;
      setBar('window', o.windowWeight, o.weightedSize, o.windowMax);
      setBar('probation', o.probationWeight, o.weightedSize, o.weightedSize - o.windowMax);
      setBar('protected', o.protectedWeight, o.weightedSize, o.protectedMax);
      $('.size').textContent = o.weightedSize;
      const main = Math.max(1, o.weightedSize - o.windowMax);
      $('.ratio').textContent = Math.round((o.windowMax / (o.windowMax + main)) * 100) + '%';

      const key = event.key !== undefined ? String(event.key) : '—';
      const seg = event.segment ?? '—';
      const freq = event.freq !== undefined ? event.freq : '—';
      const li = document.createElement('li');
      li.textContent = event.type.padEnd(8) + ' ' + key.padEnd(8) + ' seg=' + seg + ' freq=' + freq;
      log.prepend(li);
      while (log.children.length > 30) log.lastElementChild.remove();

      if (event.type === 'admit' || event.type === 'reject') {
        gate.className = 'caffeine-gate ' + event.type;
        gate.textContent = event.type.toUpperCase() + ' candidate freq=' + freq;
        clearTimeout(gateTimer);
        gateTimer = setTimeout(() => { gate.className = 'caffeine-gate'; gate.textContent = 'admission gate idle'; }, 600);
      }
    }

    const es = new EventSource('/events');
    es.onmessage = (e) => { try { render(JSON.parse(e.data)); } catch {} };
    es.onopen = () => { gate.className = 'caffeine-gate'; gate.textContent = 'admission gate idle'; };
    es.onerror = () => { gate.className = 'caffeine-gate reject'; gate.textContent = 'event source error'; };
  </script>
</body>
</html>`;

/**
 * Start a Node HTTP dashboard for `cache`. Serves a real-time HTML UI and
 * streams cache events via Server-Sent Events. Backpressure is handled by a
 * per-client bounded buffer; overflow drops oldest events rather than blocking
 * the cache hot path.
 */
export async function serveDashboard<K, V>(
  cache: Cache<K, V>,
  options: ServeDashboardOptions = {},
): Promise<DashboardServer> {
  const { createServer } = await import("node:http");
  const port = options.port ?? 0;
  const bufferSize = options.bufferSize ?? 64;

  type Client = {
    res: import("node:http").ServerResponse;
    queue: string[];
    ready: boolean;
  };
  const clients = new Set<Client>();

  const observer = new CacheObserver<K, V>((event: CacheEvent<K, V>) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      if (!client.ready) {
        if (client.queue.length >= bufferSize) client.queue.shift();
        client.queue.push(payload);
        continue;
      }
      const ok = client.res.write(payload);
      if (!ok) {
        client.ready = false;
        client.res.once("drain", () => {
          client.ready = true;
          let q: string | undefined;
          while (client.ready && (q = client.queue.shift())) {
            client.ready = client.res.write(q);
          }
        });
      }
    }
  }, options);

  cache.attachObserver!(observer);

  const server = createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(":ok\n\n");
      const client: Client = { res, queue: [], ready: true };
      clients.add(client);
      req.on("close", () => clients.delete(client));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      const address = server.address();
      const url =
        typeof address === "object" && address
          ? `http://localhost:${address.port}`
          : `http://localhost:${port}`;
      resolve({
        url,
        stop: () =>
          new Promise<void>((res) => {
            cache.attachObserver!(undefined);
            for (const client of clients) {
              try {
                client.res.end();
              } catch {
                // ignore
              }
            }
            clients.clear();
            server.close(() => res());
          }),
      });
    });
  });
}
