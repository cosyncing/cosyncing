#!/usr/bin/env node
// Real-browser evidence and regression test for the N3 startup shell (part A)
// and the versioned static cache (part B).
//
// Drives the ACTUAL release web build (`--base-href /cosy/`) in headless
// Chromium over CDP, mounted under /cosy/ by a deterministic local server, and
// records navigation-response -> first-shell-paint -> first-Flutter-frame
// timings plus screenshots for each scenario.
//
//   bun run client:build:web
//   node scripts/client/tests/test-startup-shell-browser.mjs \
//     [--out output/n3-browser] [--only <case>]
//
// Cases: light, dark, transition, normal, delayed, slow3g, offline-repeat,
//        empty-cache, corrupt-cache, new-version, bootstrap-failure,
//        retry-bound, base-path.
//
// Exits non-zero if any assertion fails. Uses no private session content: the
// broker is never started, so every capture is the app's own startup surface.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";

const REPO = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const BUILD = join(REPO, "apps/client/build/web");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const OUT = arg("out", join(REPO, "output/n3-browser"));
const ONLY = arg("only", null);

const CASES = arg("cases", null);
const SHARD_ID = arg("shard-id", null);

const order = [
  "light", "dark", "bootstrap-failure", "retry-bound", "normal", "transition",
  "delayed", "slow3g", "empty-cache", "offline-repeat", "corrupt-cache",
  "new-version", "update-handoff", "scope-isolation", "base-path",
];

/**
 * Every case is an independently resettable scheduling unit.
 *
 * Offline repeat, corrupt cache, and new version each create the exact warmed
 * state they need. Keeping them chained made the 25-second corrupt-cache case
 * wait behind unrelated cache scenarios and prevented useful sharding.
 */
const chains = order.map((name) => [name]);

// Before anything is spawned: a mistyped `--only` used to run zero cases and
// exit 0, which reads exactly like a clean isolated run.
if (ONLY !== null && !order.includes(ONLY)) {
  console.error(`Unknown --only case "${ONLY}".\nKnown cases: ${order.join(", ")}`);
  process.exit(2);
}

const selectedCases = CASES === null ? null : CASES.split(",").filter(Boolean);
if (selectedCases) {
  const unknown = selectedCases.filter((name) => !order.includes(name));
  if (unknown.length > 0) {
    console.error(`Unknown --cases: ${unknown.join(", ")}`);
    process.exit(2);
  }
}

if (!existsSync(join(BUILD, "index.html"))) {
  console.error(`No build at ${BUILD}\nRun: bun run client:build:web`);
  process.exit(1);
}
if (!existsSync(join(BUILD, "cosyncing-cache-manifest.json"))) {
  console.error(`No stamped cache manifest in ${BUILD}\nRun: bun run client:build:web`);
  process.exit(1);
}

/**
 * Fan the chains out across several browsers, then add up what they found.
 *
 * Sharding happens by re-running this script as child processes rather than by
 * driving N browsers from one: every case here reaches for one ambient browser,
 * endpoint and control object, and making those per-shard would mean rewriting
 * the suite. A child is the existing single-browser suite, unchanged, told
 * which chains to run — which is also why each shard needs the per-run profile
 * and OS-assigned port to be correct, not merely tidy.
 *
 * Screenshots keep going to the shared output directory: they are named per
 * case, so they cannot collide. Only the timings file is written per shard and
 * merged here.
 */
/**
 * Four browsers by default; `--shards 1` or the env var opts out.
 *
 * Cases own their browser state and the longest-processing-time scheduler uses
 * measured durations, so the fourth shard reduces the timeout-scenario tail
 * without creating cache-order dependencies. `--only` still runs one browser.
 */
const SHARDS = Math.max(
  1,
  Math.min(4, Number(arg("shards", process.env.COSYNCING_BROWSER_SHARDS ?? "4")) || 1),
);
const DURATIONS = join(OUT, "case-durations.json");

if (SHARDS > 1 && ONLY === null && selectedCases === null) {
  await mkdir(OUT, { recursive: true });
  const hint = await readFile(DURATIONS, "utf8")
    .then((text) => {
      const parsed = JSON.parse(text);
      if (parsed.schemaVersion !== 1 || typeof parsed.durationMs !== "object") {
        return new Map();
      }
      return new Map(
        Object.entries(parsed.durationMs).filter(
          ([, value]) => Number.isFinite(value) && value > 0,
        ),
      );
    })
    .catch(() => new Map());
  // Longest chain first into the least-loaded shard. With no hint every chain
  // weighs the same, which degrades to round-robin rather than to nonsense.
  const fallback = Math.max(1, ...[...hint.values()].filter((v) => typeof v === "number"));
  const weigh = (chain) =>
    chain.reduce((total, name) => total + (hint.get(name) ?? fallback), 0);
  const buckets = Array.from({ length: SHARDS }, () => ({ load: 0, cases: [] }));
  for (const chain of [...chains].sort((a, b) => weigh(b) - weigh(a))) {
    const target = buckets.reduce((low, b) => (b.load < low.load ? b : low));
    target.load += weigh(chain);
    target.cases.push(...chain);
  }
  const active = buckets.filter((bucket) => bucket.cases.length > 0);
  console.log(`sharding ${order.length} cases over ${active.length} browsers`);

  const children = active.map((bucket, index) => new Promise((resolveChild) => {
    const child = spawn(process.execPath, [
      process.argv[1],
      "--out", OUT,
      "--shard-id", String(index),
      "--cases", bucket.cases.join(","),
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const prefix = (stream) => (data) => {
      for (const line of String(data).split("\n")) {
        if (line.trim()) stream(`[shard ${index}] ${line}`);
      }
    };
    child.stdout.on("data", prefix(console.log));
    child.stderr.on("data", prefix(console.error));
    child.on("exit", (code) => resolveChild(code ?? 1));
  }));

  const codes = await Promise.all(children);
  let totalChecks = 0;
  let totalFailures = 0;
  const mergedTimings = {};
  const mergedDurations = new Map(hint);
  for (let index = 0; index < active.length; index += 1) {
    const shardFile = join(OUT, `timings-shard-${index}.json`);
    const parsed = await readFile(shardFile, "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (!parsed) {
      console.error(`shard ${index} produced no timings at ${shardFile}`);
      totalFailures += 1;
      continue;
    }
    totalChecks += parsed.checks ?? 0;
    totalFailures += parsed.failures ?? 0;
    Object.assign(mergedTimings, parsed.timings ?? {});
    for (const [name, durationMs] of Object.entries(parsed.durationMs ?? {})) {
      if (!Number.isFinite(durationMs) || durationMs <= 0) continue;
      const previous = mergedDurations.get(name);
      mergedDurations.set(
        name,
        previous === undefined
          ? durationMs
          : Math.round(previous + 0.5 * (durationMs - previous)),
      );
    }
  }
  // A shard that dies without writing timings must still fail the gate.
  const crashed = codes.filter((code) => code !== 0).length;
  await writeFile(
    join(OUT, "timings.json"),
    `${JSON.stringify({ base: null, checks: totalChecks, failures: totalFailures, timings: mergedTimings }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    DURATIONS,
    `${JSON.stringify({
      schemaVersion: 1,
      durationMs: Object.fromEntries([...mergedDurations].sort()),
    }, null, 2)}\n`,
    "utf8",
  );
  console.log(`\nartifacts: ${OUT}`);
  if (totalFailures > 0 || crashed > 0) {
    console.error(
      `startup shell browser evidence: ${totalFailures} failed of ${totalChecks} checks`
      + (crashed > 0 ? `; ${crashed} shard(s) exited non-zero` : ""),
    );
    process.exit(1);
  }
  console.log(`startup shell browser evidence: ${totalChecks} checks passed`);
  process.exit(0);
}

const CACHE = join(process.env.HOME, ".cache/ms-playwright");
const shells = (await readdir(CACHE).catch(() => []))
  .filter((d) => d.startsWith("chromium_headless_shell-"))
  .map((d) => ({ dir: d, rev: Number(d.split("-")[1]) }))
  .sort((a, b) => b.rev - a.rev);
if (!shells.length) {
  console.error("No chrome-headless-shell found. Run: npx playwright install chromium");
  process.exit(1);
}
const BROWSER = join(CACHE, shells[0].dir, "chrome-headless-shell-linux64/chrome-headless-shell");

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".wasm": "application/wasm", ".ttf": "font/ttf",
  ".otf": "font/otf", ".woff2": "font/woff2", ".bin": "application/octet-stream",
  ".symbols": "text/plain", ".frag": "text/plain",
};

/* ------------------------------------------------------------------ *
 * Deterministic server, mounted at /cosy/ exactly like the broker.
 * ------------------------------------------------------------------ */

// Per-request controls the cases flip: block a path, stall it, or corrupt it.
const control = {
  block: new Set(),
  stallMs: new Map(),
  corrupt: new Map(),
  startupClock: null,
  globalDelayMs: 0,
  requests: [],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BUILD_CACHE_MANIFEST = JSON.parse(
  await readFile(join(BUILD, "cosyncing-cache-manifest.json"), "utf8"),
);

/**
 * Shorten startup-shell clocks only in the bytes served by this test process.
 * The committed release HTML retains its production 8s/25s values, which the
 * static suite asserts. Exact replacement fails closed if that contract moves.
 */
function withTestStartupClock(body) {
  if (control.startupClock === null) return body;
  let text = body.toString("utf8");
  if (control.startupClock !== null) {
    const replacements = [
      ["var SLOW_MS = 8000;", `var SLOW_MS = ${control.startupClock.slowMs};`],
      ["var FAIL_MS = 25000;", `var FAIL_MS = ${control.startupClock.failMs};`],
    ];
    for (const [production, accelerated] of replacements) {
      if (!text.includes(production)) {
        throw new Error(`startup clock contract moved: ${production}`);
      }
      text = text.replace(production, accelerated);
    }
  }
  return text;
}

async function withTestWorkerClock(body) {
  if (control.startupClock === null) return body;
  const acceleratedIndex = withTestStartupClock(
    await readFile(join(BUILD, "index.html")),
  );
  const acceleratedHash = createHash("sha256").update(acceleratedIndex).digest("hex");
  const productionHash = BUILD_CACHE_MANIFEST.hashes["index.html"];
  const production = `"index.html": "${productionHash}"`;
  const text = body.toString("utf8");
  if (!productionHash || !text.includes(production)) {
    throw new Error("service-worker index hash contract moved");
  }
  return text.replace(production, `"index.html": "${acceleratedHash}"`);
}

/**
 * A minimal, unrelated app mounted at another path on the SAME origin.
 *
 * Its worker exists purely so recovery and activation can be asked the only
 * question that matters for scope-locality: does a /cosy/ reset leave a
 * neighbour's registration and caches alone?
 */
const NEIGHBOUR_WORKER = `self.addEventListener('install', (event) => {
  event.waitUntil(caches.open('neighbour-app-cache').then((cache) =>
    cache.put('/other-app/asset.txt', new Response('neighbour asset'))));
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
`;

/**
 * The N3b handoff page, from the broker's own module.
 *
 * Printed by a bun helper rather than copied: this file runs under plain node
 * and cannot import the broker's TypeScript, and a second copy of the document
 * would silently drift from the one users actually get.
 */
const HANDOFF_DOCUMENT = execFileSync(
  "bun",
  ["run", "scripts/client/print-web-handoff.ts"],
  { cwd: REPO, encoding: "utf8", maxBuffer: 8 << 20 },
);

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  control.requests.push(path);

  if (path === "/other-app/sw.js") {
    res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
    return void res.end(NEIGHBOUR_WORKER);
  }
  if (path.startsWith("/other-app/")) {
    res.writeHead(200, { "content-type": "text/html" });
    return void res.end("<!doctype html><title>neighbour</title>neighbour app");
  }

  // N3b handoff page, mounted exactly where the broker mounts it: a SIBLING of
  // /cosy/, so a tab parked here is outside the worker's scope and stops being
  // one of its controllees. Serving it under /cosy/ would defeat the whole case.
  if (path === "/cosy-handoff") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    return void res.end(HANDOFF_DOCUMENT);
  }

  if (!path.startsWith("/cosy/")) return void res.writeHead(404).end("not found");
  const rel = path.slice("/cosy/".length) || "index.html";

  if (control.block.has(rel)) return void res.writeHead(503).end("blocked");
  if (control.stallMs.has(rel)) await sleep(control.stallMs.get(rel));
  if (control.globalDelayMs) await sleep(control.globalDelayMs);
  if (control.corrupt.has(rel)) {
    res.writeHead(200, { "content-type": TYPES[extname(rel)] ?? "text/plain" });
    return void res.end(control.corrupt.get(rel));
  }

  const file = normalize(join(BUILD, rel));
  if (!file.startsWith(BUILD)) return void res.writeHead(403).end("forbidden");
  try {
    let body = await readFile(file);
    if (rel === "index.html") body = withTestStartupClock(body);
    if (rel === "sw.js") body = await withTestWorkerClock(body);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      // Mirrors the broker: shell files carry build identity, so never cached.
      "cache-control": ["index.html", "flutter_bootstrap.js", "version.json", "sw.js"].includes(rel)
        ? "no-store"
        : "max-age=300",
    });
    res.end(body);
  } catch {
    // SPA fallback for extension-less navigations, like the broker's.
    if (extname(rel)) return void res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(await readFile(join(BUILD, "index.html")));
  }
});

const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const ORIGIN = `http://127.0.0.1:${port}`;
const BASE = `${ORIGIN}/cosy/`;

/* ------------------------------------------------------------------ *
 * CDP plumbing.
 * ------------------------------------------------------------------ */

/**
 * Chrome picks the port; we read back which one it got.
 *
 * This used to be a hard-coded 9351 with a shared default profile. Two runs
 * that overlapped by even a second — and cleanup below used to let that happen
 * — produced a second Chrome that could not bind the port, after which the
 * `/json/version` probe below happily connected to the *first*, still-running
 * browser. The suite then drove a stale browser through its own long waits.
 *
 * `--remote-debugging-port=0` makes the kernel assign a free port, which Chrome
 * writes to `DevToolsActivePort` inside the profile directory. Because that
 * profile is a fresh temp dir per run, the port we read can only be ours.
 */
const profileDir = await mkdtemp(join(tmpdir(), "cosyncing-startup-shell-"));
const proc = spawn(BROWSER, [
  "--no-sandbox", "--disable-gpu", "--disable-software-rasterizer",
  "--disable-features=Vulkan,VizDisplayCompositor",
  "--disable-dev-shm-usage", "--headless",
  "--remote-debugging-port=0", "--remote-allow-origins=*",
  `--user-data-dir=${profileDir}`,
  "--window-size=1280,860", "about:blank",
], { stdio: "ignore" });

let cleanedUp = false;
/**
 * Shut the browser down and wait for it to actually be gone.
 *
 * `proc.kill()` followed immediately by `process.exit()` returned before Chrome
 * had released anything, which is how a finished run left a live browser (and
 * its zygote, GPU and renderer children) holding a port. SIGTERM first, then
 * SIGKILL if it will not leave.
 */
const cleanup = async ({ graceMs = 5000 } = {}) => {
  if (cleanedUp) return;
  cleanedUp = true;
  server.close();
  if (proc.exitCode === null && proc.signalCode === null) {
    const gone = new Promise((resolve) => proc.once("exit", resolve));
    proc.kill("SIGTERM");
    const killer = setTimeout(() => proc.kill("SIGKILL"), graceMs);
    killer.unref?.();
    await gone;
    clearTimeout(killer);
  }
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
};
// A synchronous last resort: `process.on("exit")` cannot await anything, so it
// only gets to fire the signal. The awaited path above is the real one.
process.on("exit", () => { if (!cleanedUp) proc.kill("SIGKILL"); });

/**
 * Every page's "reject everything still in flight" hook.
 *
 * A CDP call whose answer can never arrive — the tab crashed, the socket
 * dropped, Chrome exited — must become a failure, not a hang. Without this the
 * suite's only bound was the caller's own patience.
 */
const abortHooks = new Set();
let browserExited = false;
proc.on("exit", (code, signal) => {
  browserExited = true;
  const why = `chrome exited (code ${code}, signal ${signal})`;
  for (const abort of [...abortHooks]) abort(why);
});

/** Nothing this harness asks the browser legitimately takes this long. */
const CDP_TIMEOUT_MS = 30000;

/**
 * Read the port Chrome chose, then prove the endpoint is that same browser.
 *
 * `DevToolsActivePort` holds the port on line 1 and the browser's own
 * WebSocket path on line 2. Matching line 2 against what `/json/version`
 * reports is the ownership check: a browser answering on our port that does
 * not know our profile's socket path is not ours, and driving it would be the
 * exact stale-browser failure this replaces.
 */
async function discoverEndpoint({ attempts = 100, intervalMs = 200 } = {}) {
  const portFile = join(profileDir, "DevToolsActivePort");
  for (let i = 0; i < attempts; i++) {
    if (browserExited) throw new Error("chrome exited before publishing a debug port");
    const [port, wsPath] = await readFile(portFile, "utf8")
      .then((text) => text.trim().split("\n"))
      .catch(() => []);
    if (port && wsPath) {
      const base = `http://127.0.0.1:${port.trim()}`;
      try {
        const version = await (
          await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(2000) })
        ).json();
        const socket = version.webSocketDebuggerUrl ?? "";
        if (socket.endsWith(wsPath.trim())) return base;
        throw new Error(
          `debug port ${port.trim()} is owned by another browser `
          + `(${socket} does not match ${wsPath.trim()})`,
        );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("debug port")) throw error;
      }
    }
    await sleep(intervalMs);
  }
  throw new Error("chrome never published a usable debug port");
}

const endpoint = await discoverEndpoint();

async function newPage({ colorScheme = "light", width = 1280, height = 860 } = {}) {
  if (browserExited) throw new Error("chrome is gone; cannot open a page");
  const target = await (
    await fetch(`${endpoint}/json/new?about:blank`, {
      method: "PUT",
      signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
    })
  ).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP socket never opened")), CDP_TIMEOUT_MS);
    timer.unref?.();
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP socket failed")); });
  });

  let id = 0;
  let dead = null;
  const pending = new Map();
  const logs = [];
  const events = [];

  const abort = (why) => {
    dead = why;
    for (const [, { reject }] of pending) reject(new Error(why));
    pending.clear();
    abortHooks.delete(abort);
  };
  abortHooks.add(abort);
  ws.addEventListener("close", () => abort("the CDP socket closed"));
  ws.addEventListener("error", () => abort("the CDP socket errored"));

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
    if (msg.method) events.push(msg);
    if (msg.method === "Runtime.consoleAPICalled") {
      logs.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
    }
  });

  const send = (method, params = {}, { timeout = CDP_TIMEOUT_MS } = {}) =>
    new Promise((resolve, reject) => {
      if (dead) return void reject(new Error(`${method}: ${dead}`));
      const msgId = ++id;
      const timer = setTimeout(() => {
        if (!pending.has(msgId)) return;
        pending.delete(msgId);
        reject(new Error(`CDP ${method} timed out after ${timeout}ms`));
      }, timeout);
      timer.unref?.();
      pending.set(msgId, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: colorScheme }],
  });
  await send("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 1, mobile: false,
  });

  const page = {
    send, logs, events,
    async goto(url) { await send("Page.navigate", { url }); },
    async eval(expression) {
      const { result } = await send("Runtime.evaluate", {
        expression, awaitPromise: true, returnByValue: true,
      });
      return result?.value;
    },
    async observe(expression, { timeout = 30000, interval = 60 } = {}) {
      const started = Date.now();
      for (;;) {
        try {
          return await page.eval(expression);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/Inspected target navigated or closed|Execution context was destroyed/i.test(message)) {
            throw error;
          }
          if (Date.now() - started > timeout) throw error;
          await sleep(interval);
        }
      }
    },
    async shot(name) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      await writeFile(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
      return Buffer.from(data, "base64").length;
    },
    async waitFor(expression, { timeout = 30000, interval = 60 } = {}) {
      const started = Date.now();
      for (;;) {
        try {
          if (await page.eval(expression)) return Date.now() - started;
        } catch (error) {
          // Runtime.evaluate may race the deliberate /cosy/ -> /cosy-handoff ->
          // /cosy/ document swap. Chrome reports that as -32000 even though the
          // target and its CDP socket remain healthy. A polling observation is
          // safe to repeat; action-bearing evals still fail immediately.
          const message = error instanceof Error ? error.message : String(error);
          if (!/Inspected target navigated or closed|Execution context was destroyed/i.test(message)) {
            throw error;
          }
        }
        if (Date.now() - started > timeout) return null;
        await sleep(interval);
      }
    },
    async close() {
      try { await send("Page.close"); } catch { /* already gone */ }
      abort("the page was closed");
      ws.close();
    },
  };
  return page;
}

/* ------------------------------------------------------------------ *
 * Assertions.
 * ------------------------------------------------------------------ */

let failures = 0;
let checks = 0;
const timings = {};

function check(condition, description) {
  checks += 1;
  if (condition) return true;
  failures += 1;
  console.error(`  FAIL ${description}`);
  return false;
}

function resetControl() {
  control.block.clear();
  control.stallMs.clear();
  control.corrupt.clear();
  control.startupClock = null;
  control.globalDelayMs = 0;
  control.requests.length = 0;
}

/**
 * Returns the browser to a first-visit state.
 *
 * Cases share one browser profile, so once any case installs the worker every
 * later case is served from its cache — which silently defeats scenarios that
 * are supposed to exercise the network (a blocked or stalled bootstrap). The
 * warm-cache cases (offline-repeat, corrupt-cache, new-version) opt out and
 * warm the cache themselves.
 *
 * Cleared from the BROWSER side, on an about:blank tab. Resetting by navigating
 * to the app started the very worker the reset exists to remove, and made the
 * reset depend on a startup that a preceding case may have deliberately broken:
 * `--only base-path` would sit waiting for `readyState` on a page whose control
 * had already been ceded, and never fail.
 */
async function resetBrowserState() {
  const page = await newPage();
  await page.send("Storage.clearDataForOrigin", {
    origin: ORIGIN,
    storageTypes: [
      "service_workers", "cache_storage", "local_storage", "session_storage",
      "indexeddb", "websql", "cookies", "shader_cache",
    ].join(","),
  });
  await page.close();
}

/** Milliseconds from navigation start to the shell's first paint. */
const SHELL_PAINT_PROBE = `(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const paints = performance.getEntriesByType('paint');
  const fcp = paints.find((entry) => entry.name === 'first-contentful-paint');
  return {
    responseEnd: nav ? Math.round(nav.responseEnd) : null,
    firstContentfulPaint: fcp ? Math.round(fcp.startTime) : null,
    shellPresent: !!document.getElementById('cosyncing-startup-shell'),
    shellState: document.getElementById('cosyncing-startup-shell')?.dataset.state ?? null,
    shellText: document.getElementById('cosyncing-startup-shell-status')?.textContent ?? null,
    background: getComputedStyle(document.documentElement).backgroundColor,
  };
})()`;

/* ------------------------------------------------------------------ *
 * Cases.
 * ------------------------------------------------------------------ */

const cases = {};

/// Captures the shell in its LOADING state: the bootstrap is stalled rather
/// than blocked, because a blocked script trips the error listener at once and
/// the failure state is a different capture (see `bootstrap-failure`).
async function captureImmediateShell(scheme, expectedBackground) {
  control.stallMs.set("flutter_bootstrap.js", 30000);
  const page = await newPage({ colorScheme: scheme });
  await page.goto(BASE);
  await page.waitFor(`!!document.getElementById('cosyncing-startup-shell')`);
  const probe = await page.eval(SHELL_PAINT_PROBE);
  const bytes = await page.shot(`shell-${scheme}`);

  check(probe.shellPresent, `${scheme}: branded shell paints before Flutter runs`);
  check(
    probe.shellState === "booting",
    `${scheme}: the capture is the loading state (got ${probe.shellState})`,
  );
  check(
    probe.background === expectedBackground,
    `${scheme}: canvas matches the app canvas (got ${probe.background})`,
  );
  check(bytes > 0, `${scheme}: screenshot captured`);
  timings[scheme] = probe;
  await page.close();
}

cases.light = () => captureImmediateShell("light", "rgb(242, 245, 244)");
cases.dark = () => captureImmediateShell("dark", "rgb(11, 14, 20)");

cases["bootstrap-failure"] = async () => {
  control.block.add("flutter_bootstrap.js");
  const page = await newPage();
  await page.goto(BASE);
  // The error listener fails the shell immediately; no need to wait out 25 s.
  const waited = await page.waitFor(
    `document.getElementById('cosyncing-startup-shell')?.dataset.state === 'failed'`,
    { timeout: 20000 },
  );
  const state = await page.eval(`({
    state: document.getElementById('cosyncing-startup-shell').dataset.state,
    text: document.getElementById('cosyncing-startup-shell-status').textContent,
    retry: document.getElementById('cosyncing-startup-shell-retry')?.textContent ?? null,
  })`);
  await page.shot("bootstrap-failure");

  check(waited !== null, "failure: the shell reaches its bounded failed state");
  check(state.retry === "Retry", `failure: a plain retry action is offered (got ${state.retry})`);
  check(
    !/exception|stack|undefined|null/i.test(state.text ?? ""),
    "failure: primary copy stays plain, technical detail is console-only",
  );
  check(
    page.logs.some((line) => line.includes("[cosyncing] startup shell:")),
    "failure: technical detail went to the console",
  );
  timings.bootstrapFailure = { msToFailed: waited, ...state };
  await page.close();
};

cases["retry-bound"] = async () => {
  control.block.add("flutter_bootstrap.js");
  const page = await newPage();
  await page.goto(BASE);
  const labels = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const reached = await page.waitFor(
      `document.getElementById('cosyncing-startup-shell')?.dataset.state === 'failed'`,
      { timeout: 20000 },
    );
    if (reached === null) break;
    const label = await page.eval(
      `document.getElementById('cosyncing-startup-shell-retry')?.textContent ?? null`,
    );
    labels.push(label);
    if (label === null) break;
    await page.eval(`document.getElementById('cosyncing-startup-shell-retry').click(); true`);
    await sleep(700);
  }
  await page.shot("retry-exhausted");
  const finalText = await page.eval(
    `document.getElementById('cosyncing-startup-shell-status').textContent`,
  );

  check(
    labels.length >= 3 && labels[labels.length - 1] === null,
    `retry: the offer is bounded and then withdrawn (labels: ${JSON.stringify(labels)})`,
  );
  check(
    labels.includes("Clear cached files and retry"),
    "retry: the final attempt offers the cache reset",
  );
  check(
    /Reloading didn/.test(finalText ?? ""),
    "retry: an exhausted session explains itself instead of looping",
  );
  timings.retryBound = { labels, finalText };
  await page.close();
};

cases.normal = async () => {
  const page = await newPage();
  const started = Date.now();
  await page.goto(BASE);
  await page.waitFor(`!!document.getElementById('cosyncing-startup-shell')`);
  const shellAt = Date.now() - started;
  const shellProbe = await page.eval(SHELL_PAINT_PROBE);

  // The shell is dismissed only by the Dart post-frame handshake.
  const goneAfter = await page.waitFor(
    `!document.getElementById('cosyncing-startup-shell')`,
    { timeout: 60000 },
  );
  const frameAt = Date.now() - started;
  await page.shot("startup-normal");
  const flutterPresent = await page.eval(
    `!!document.querySelector('flt-glass-pane, flutter-view, flt-scene-host')`,
  );

  check(shellProbe.shellPresent, "normal: shell painted before Flutter");
  check(goneAfter !== null, "normal: shell is removed after the first Flutter frame");
  check(flutterPresent, "normal: Flutter chrome is on screen after the handover");
  timings.normal = {
    responseEndMs: shellProbe.responseEnd,
    firstShellPaintMs: shellProbe.firstContentfulPaint,
    shellVisibleAtMs: shellAt,
    firstFlutterFrameMs: frameAt,
  };
  await page.close();
};

cases.transition = async () => {
  const page = await newPage();
  await page.goto(BASE);
  await page.waitFor(`!!document.getElementById('cosyncing-startup-shell')`);
  await page.shot("transition-before");

  // Sample the document background across the handover. A white frame would
  // show up here as a colour that is neither the canvas nor transparent.
  const samples = await page.eval(`(async () => {
    const seen = [];
    for (let i = 0; i < 240; i++) {
      const shell = document.getElementById('cosyncing-startup-shell');
      seen.push({
        shell: !!shell,
        dismissing: shell?.dataset.dismissing ?? null,
        background: getComputedStyle(document.documentElement).backgroundColor,
      });
      if (!shell && i > 4) break;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return seen;
  })()`);
  await page.shot("transition-after");

  const backgrounds = new Set(samples.map((s) => s.background));
  check(
    !backgrounds.has("rgb(255, 255, 255)") && !backgrounds.has("rgba(0, 0, 0, 0)"),
    `transition: the document never goes white/transparent (saw ${[...backgrounds].join(", ")})`,
  );
  check(
    samples.some((s) => s.dismissing === "true"),
    "transition: removal goes through the fade, not an instant cut",
  );
  check(samples.at(-1)?.shell === false, "transition: the shell is gone at the end");
  timings.transition = { frames: samples.length, backgrounds: [...backgrounds] };
  await page.close();
};

cases.delayed = async () => {
  // Flutter's bootstrap arrives late; the shell must hold the screen.
  control.startupClock = { slowMs: 500, failMs: 8000 };
  control.stallMs.set("flutter_bootstrap.js", 1200);
  const page = await newPage();
  const started = Date.now();
  await page.goto(BASE);
  await page.waitFor(`!!document.getElementById('cosyncing-startup-shell')`);
  const shellAt = Date.now() - started;
  await sleep(650);
  const midway = await page.eval(SHELL_PAINT_PROBE);
  await page.shot("startup-delayed");
  const goneAfter = await page.waitFor(
    `!document.getElementById('cosyncing-startup-shell')`,
    { timeout: 90000 },
  );

  check(shellAt < 5000, `delayed: shell paints promptly (${shellAt}ms) despite the stalled loader`);
  check(midway.shellPresent, "delayed: the shell holds the screen past the accelerated slow threshold");
  check(
    midway.shellState === "slow",
    `delayed: the slow-start note appears (state ${midway.shellState})`,
  );
  check(goneAfter !== null, "delayed: the shell still hands over once Flutter paints");
  timings.delayed = {
    shellVisibleAtMs: shellAt,
    state: midway.shellState,
    testClock: control.startupClock,
  };
  await page.close();
};

cases.slow3g = async () => {
  // Prove the initial HTML shell paints on a genuinely slow link. Stop there:
  // downloading Flutter and the service-worker precache at 400 Kbps would
  // benchmark bundle size rather than strengthen this first-paint assertion.
  const page = await newPage();
  await page.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 400,
    downloadThroughput: (400 * 1024) / 8,
    uploadThroughput: (400 * 1024) / 8,
  });
  const started = Date.now();
  await page.goto(BASE);
  await page.waitFor(`!!document.getElementById('cosyncing-startup-shell')`, { timeout: 60000 });
  const shellAt = Date.now() - started;
  const paintedAfter = await page.waitFor(
    `performance.getEntriesByName('first-contentful-paint').length > 0`,
    { timeout: 15000 },
  );
  const probe = await page.eval(SHELL_PAINT_PROBE);
  await page.shot("startup-slow3g");

  check(probe.shellPresent, "slow3g: the initial HTML shell covers the slow start");
  check(
    paintedAfter !== null && probe.firstContentfulPaint !== null,
    "slow3g: the shell produces a real first-contentful-paint entry",
  );
  check(
    shellAt < 15000,
    `slow3g: shell paints from the first response (${shellAt}ms)`,
  );
  timings.slow3g = {
    shellVisibleAtMs: shellAt,
    firstShellPaintMs: probe.firstContentfulPaint,
    networkKbps: 400,
  };
  await page.close();
};

cases["empty-cache"] = async () => {
  const page = await newPage();
  const started = Date.now();
  await page.goto(BASE);
  const shellAt = await page.waitFor(`!!document.getElementById('cosyncing-startup-shell')`);
  const gone = await page.waitFor(`!document.getElementById('cosyncing-startup-shell')`, {
    timeout: 60000,
  });
  await page.shot("startup-empty-cache");
  // Registration is deferred to `load`, and install is asynchronous after it.
  const installed = await page.waitFor(
    `caches.keys().then((names) => names.some((n) => n.startsWith('cosyncing-app:')))`,
    { timeout: 40000 },
  );
  const cacheNames = await page.eval(`caches.keys()`);

  check(shellAt !== null, "empty-cache: the shell paints with nothing cached");
  check(gone !== null, "empty-cache: startup completes from the network alone");
  check(
    installed !== null && cacheNames.some((n) => n.startsWith("cosyncing-app:")),
    `empty-cache: a versioned app cache was created (${JSON.stringify(cacheNames)})`,
  );
  timings.emptyCache = {
    firstFlutterFrameMs: gone === null ? null : Date.now() - started,
    cacheNames,
  };
  await page.close();
};

cases["offline-repeat"] = async () => {
  // Visit once so the worker installs and fills, then repeat while offline.
  const warm = await newPage();
  await warm.goto(BASE);
  await warm.waitFor(`!document.getElementById('cosyncing-startup-shell')`, { timeout: 60000 });
  await warm.waitFor(`navigator.serviceWorker.controller !== null`, { timeout: 30000 });
  // Give the runtime set (canvaskit/sqlite) a moment to land in the cache.
  await sleep(2500);
  const cached = await warm.eval(`(async () => {
    const names = await caches.keys();
    const name = names.find((n) => n.startsWith('cosyncing-app:'));
    const keys = await (await caches.open(name)).keys();
    return keys.map((request) => new URL(request.url).pathname);
  })()`);
  await warm.close();

  const page = await newPage();
  await page.send("Network.emulateNetworkConditions", {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  const started = Date.now();
  await page.goto(BASE);
  const shellAt = await page.waitFor(`!!document.getElementById('cosyncing-startup-shell')`, {
    timeout: 30000,
  });
  const gone = await page.waitFor(`!document.getElementById('cosyncing-startup-shell')`, {
    timeout: 90000,
  });
  await page.shot("startup-offline-repeat");

  check(shellAt !== null, "offline-repeat: the cached shell paints with no network");
  check(gone !== null, "offline-repeat: Flutter starts from cached assets while offline");
  check(
    cached.some((path) => path.endsWith("/main.dart.js")),
    "offline-repeat: the app bundle was precached",
  );
  check(
    cached.every((path) => !path.startsWith("/api/")),
    `offline-repeat: no broker route is in the cache (${cached.filter((p) => p.startsWith("/api/")).join(", ")})`,
  );
  timings.offlineRepeat = {
    firstFlutterFrameMs: gone === null ? null : Date.now() - started,
    cachedEntries: cached.length,
  };
  await page.close();
};

cases["corrupt-cache"] = async () => {
  // Warm the cache, then poison the app bundle inside it and reload: the shell
  // must surface its bounded retry rather than a blank page.
  control.startupClock = { slowMs: 500, failMs: 4000 };
  const warm = await newPage();
  await warm.goto(BASE);
  await warm.waitFor(`!document.getElementById('cosyncing-startup-shell')`, { timeout: 60000 });
  await warm.waitFor(`navigator.serviceWorker.controller !== null`, { timeout: 30000 });
  await warm.eval(`(async () => {
    const names = await caches.keys();
    const name = names.find((n) => n.startsWith('cosyncing-app:'));
    const cache = await caches.open(name);
    await cache.put(
      new URL('main.dart.js', location.href).href,
      new Response('throw new Error("corrupt cached bundle");', {
        headers: { 'content-type': 'text/javascript' },
      }),
    );
    return true;
  })()`);
  await warm.close();

  const page = await newPage();
  await page.goto(BASE);
  const failed = await page.waitFor(
    `document.getElementById('cosyncing-startup-shell')?.dataset.state === 'failed'`,
    { timeout: 40000 },
  );
  await page.shot("corrupt-cache");
  const recoverable = await page.eval(
    `document.getElementById('cosyncing-startup-shell-retry')?.textContent ?? null`,
  );

  check(failed !== null, "corrupt-cache: a poisoned bundle produces the bounded retry state");
  check(recoverable !== null, "corrupt-cache: a recovery action is offered");
  timings.corruptCache = {
    msToFailed: failed,
    action: recoverable,
    testClock: control.startupClock,
  };
  await page.close();
};

cases["new-version"] = async () => {
  // The coherence property, end to end in a real browser: while an old page is
  // still open the new worker installs but must NOT take over, and the old
  // build keeps its complete cache. Only once that client is gone does the
  // replacement activate and the superseded cache disappear.
  //
  // N3b: the open page would normally move ITSELF out of the way, which is the
  // `update-handoff` case below. Here it declines through the real Dart hook —
  // the actively-editing path — so the pre-handoff invariant is still the thing
  // under test: a tab that will not move keeps the previous build whole.
  const workerSource = await readFile(join(BUILD, "sw.js"), "utf8");
  const currentVersion = /const BUILD_VERSION = '([^']+)'/.exec(workerSource)[1];
  const oldCacheName = `cosyncing-app:/cosy/:${currentVersion}`;
  const newCacheName = "cosyncing-app:/cosy/:newversion000001";

  const openClient = await newPage();
  await openClient.goto(BASE);
  await openClient.waitFor(`!document.getElementById('cosyncing-startup-shell')`, {
    timeout: 60000,
  });
  await openClient.waitFor(`navigator.serviceWorker.controller !== null`, { timeout: 30000 });
  await openClient.eval(
    `(window.cosyncingHandoffPrepare = () => Promise.resolve(false), true)`,
  );
  const before = await openClient.eval(`caches.keys()`);

  // Ship a "new build": same worker source, different stamped version.
  control.corrupt.set("sw.js", workerSource.replace(currentVersion, "newversion000001"));

  // A deployment also changes the bytes behind unversioned runtime URLs.
  // Flutter content-hashes none of them, so the OLD worker — still the one
  // serving this open page — would otherwise fetch the NEW build's engine
  // binary and hand it to the previous main.dart.js. Pick a runtime URL this
  // page has not needed yet and serve different bytes for it.
  const manifest = JSON.parse(
    await readFile(join(BUILD, "cosyncing-cache-manifest.json"), "utf8"),
  );
  const cachedUrls = await openClient.eval(
    `caches.open('${oldCacheName}').then((c) => c.keys()).then((ks) => ks.map((k) => k.url))`,
  );
  const skewTarget = manifest.runtime.find((path) => !cachedUrls.includes(BASE + path));
  let skew = null;
  if (skewTarget) {
    control.corrupt.set(skewTarget, "bytes from a different build");
    skew = await openClient.eval(
      `fetch('${skewTarget}').then((r) => r.text().then((body) => ({ status: r.status, body })))`,
    );
    control.corrupt.delete(skewTarget);
  }
  check(skewTarget !== undefined, "new-version: an uncached runtime URL exists to test");
  check(
    skew?.status === 503,
    `new-version: a version-skewed runtime asset fails explicitly (got ${skew?.status})`,
  );
  check(
    !(skew?.body ?? "").includes("different build"),
    "new-version: the new build's bytes never reach the old page",
  );

  await openClient.eval(`navigator.serviceWorker.getRegistration().then((r) => r && r.update())`);
  const installed = await openClient.waitFor(
    `caches.keys().then((names) => names.includes('${newCacheName}'))`,
    { timeout: 40000 },
  );
  // The page records the exact moment its real handoff hook refuses. Waiting on
  // that protocol state is both stronger and much faster than a fixed 12s nap.
  const refused = await openClient.waitFor(
    `Array.isArray(window.cosyncingHandoffDiagnostics)
      && window.cosyncingHandoffDiagnostics.some(
        (entry) => entry.k === 'round' && entry.d === 'coordinator-busy'
      )`,
    { timeout: 30000, interval: 100 },
  );

  const whileOpen = await openClient.eval(`(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const names = await caches.keys();
    const oldCache = await caches.open('${oldCacheName}');
    const bundle = await oldCache.match(new URL('main.dart.js', location.href).href);
    return {
      waiting: !!registration.waiting,
      pathname: location.pathname,
      appUpdateReady: window.cosyncingWebUpdateReady === true,
      handoffFailed: window.cosyncingWebUpdateHandoffFailed === true,
      hasReloadAction: typeof window.cosyncingApplyWebUpdate === 'function',
      controllerIsOld: registration.active
        ? registration.active.state === 'activated'
        : false,
      names,
      oldBundleStillCached: !!bundle,
    };
  })()`);

  check(installed !== null, "new-version: the replacement worker installs");
  check(refused !== null, "new-version: the observable handoff refusal completed");
  check(
    whileOpen.waiting,
    "new-version: the replacement WAITS instead of claiming an open client",
  );
  check(
    whileOpen.pathname === "/cosy/",
    `new-version: a tab that declines the handoff is not moved (at ${whileOpen.pathname})`,
  );
  check(
    whileOpen.appUpdateReady && !whileOpen.handoffFailed && !whileOpen.hasReloadAction,
    "new-version: a deferred update is silent — no failure state and no false reload action",
  );
  check(
    whileOpen.names.includes(oldCacheName),
    "new-version: the old build keeps its cache while its client is open",
  );
  check(
    whileOpen.oldBundleStillCached,
    "new-version: the open client's own bundle is still served from its build",
  );
  await openClient.shot("new-version-update-ready");

  // The old client goes away. The browser now activates the replacement.
  await openClient.close();

  const page = await newPage();
  await page.goto(BASE);
  await page.waitFor(`!document.getElementById('cosyncing-startup-shell')`, { timeout: 60000 });
  const swapped = await page.waitFor(
    `caches.keys().then((names) => names.includes('${newCacheName}'))`,
    { timeout: 40000 },
  );
  const obsoleteGone = await page.waitFor(
    `caches.keys().then((names) => !names.includes('${oldCacheName}'))`,
    { timeout: 40000 },
  );
  const after = await page.eval(`caches.keys()`);
  await page.shot("new-version");

  check(before.includes(oldCacheName), "new-version: the old cache existed");
  check(swapped !== null, "new-version: the next navigation gets the new build");
  check(
    obsoleteGone !== null,
    `new-version: the obsolete cache is deleted once unused (left ${JSON.stringify(after)})`,
  );
  check(
    after.filter((n) => n.startsWith("cosyncing-app:")).length === 1,
    "new-version: exactly one application cache survives",
  );
  timings.newVersion = { before, after, waitedForOpenClient: whileOpen.waiting };
  await page.close();
};

cases["update-handoff"] = async () => {
  // N3b end to end, in a real browser, with real tabs.
  //
  // Two open tabs on different /cosy/ routes. A verified replacement build is
  // deployed. Nobody is asked to close anything: the tabs elect a coordinator,
  // acknowledge, move themselves to /cosy-handoff — outside the worker's scope —
  // let the old worker retire, and come back to their own exact routes running
  // the new build. Nothing may be shown while that happens.
  const workerSource = await readFile(join(BUILD, "sw.js"), "utf8");
  const currentVersion = /const BUILD_VERSION = '([^']+)'/.exec(workerSource)[1];
  const oldCacheName = `cosyncing-app:/cosy/:${currentVersion}`;
  const handoffVersion = "handoffversion01";
  const newCacheName = `cosyncing-app:/cosy/:${handoffVersion}`;
  // Two genuinely different app routes. This client routes on the hash, so a
  // settled route always carries one; waiting for it is what makes "came back
  // to its exact route" a real comparison rather than a race with the router.
  const deepRoute = `${BASE}#/settings`;

  const first = await newPage();
  await first.goto(BASE);
  await first.waitFor(`!document.getElementById('cosyncing-startup-shell')`, { timeout: 60000 });
  await first.waitFor(`navigator.serviceWorker.controller !== null`, { timeout: 30000 });

  const second = await newPage();
  await second.goto(deepRoute);
  await second.waitFor(`!document.getElementById('cosyncing-startup-shell')`, { timeout: 60000 });
  await second.waitFor(`navigator.serviceWorker.controller !== null`, { timeout: 30000 });
  await first.waitFor(`location.hash.length > 1`, { timeout: 30000 });
  await second.waitFor(`location.hash === '#/settings'`, { timeout: 30000 });

  // Both tabs own durable local state and are willing to be moved: exactly the
  // shape of a session with an unsent draft that is not being typed right now.
  const install = `(window.__flushed = 0, window.cosyncingHandoffPrepare = () => {
    window.__flushed += 1;
    return Promise.resolve(true);
  }, true)`;
  await first.eval(install);
  await second.eval(install);

  // The routes as the app itself settled on them: this client routes on the
  // hash, so the exact URL a tab must come back to is the one it holds now, not
  // the one the test navigated to.
  const routesBefore = await Promise.all([
    first.eval(`location.href`),
    second.eval(`location.href`),
  ]);
  const historyBefore = await Promise.all([
    first.eval(`history.length`),
    second.eval(`history.length`),
  ]);
  const censusBefore = await first.eval(`new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve(event.data);
    navigator.serviceWorker.controller.postMessage(
      { type: 'cosyncing-client-census' }, [channel.port2],
    );
    setTimeout(() => resolve(null), 4000);
  })`);
  const identityBefore = await first.eval(`new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve(event.data);
    navigator.serviceWorker.controller.postMessage(
      { type: 'cosyncing-build-identity' }, [channel.port2],
    );
    setTimeout(() => resolve(null), 4000);
  })`);

  check(
    censusBefore?.windows === 2,
    `update-handoff: the active worker counts both tabs (got ${censusBefore?.windows})`,
  );
  check(
    identityBefore?.version === currentVersion,
    `update-handoff: the controller reports the build it was stamped with`,
  );
  check(
    identityBefore?.cacheName === oldCacheName,
    "update-handoff: the reported cache identity matches the live cache",
  );

  // Deploy. Same worker source, a different stamped identity — a real new build
  // as far as every identity check is concerned.
  control.corrupt.set("sw.js", workerSource.replace(currentVersion, handoffVersion));
  const handoffRequestsBefore = control.requests.filter((p) => p === "/cosy-handoff").length;
  await first.eval(`navigator.serviceWorker.getRegistration().then((r) => r && r.update())`);

  // No prompting, no reloading, no banner: both tabs simply end up back on
  // their own routes under the new build.
  // The only honest completion signal: this tab's CONTROLLER is the new build.
  // A new cache existing proves an install, not a swap, and the route alone
  // proves nothing at all.
  const controllerIs = (version) => `(async () => {
    const worker = navigator.serviceWorker.controller;
    if (!worker) return false;
    const identity = await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => resolve(event.data);
      worker.postMessage({ type: 'cosyncing-build-identity' }, [channel.port2]);
      setTimeout(() => resolve(null), 3000);
    });
    return identity ? identity.version === '${version}' : false;
  })()`;
  const [firstBack, secondBack] = await Promise.all([
    first.waitFor(controllerIs(handoffVersion), {
      timeout: 90000,
      interval: 500,
    }),
    second.waitFor(controllerIs(handoffVersion), {
      timeout: 90000,
      interval: 500,
    }),
  ]);
  // Read the persisted log, not the live one. Both tabs have navigated back by
  // now, so `window.cosyncingHandoffDiagnostics` belongs to the *replacement*
  // document and cannot describe the round that deferred — which is the only
  // part worth reading. sessionStorage survives the swap.
  const readLog = (page) => page.observe(
    `sessionStorage.getItem("cosyncing.handoff.diagnostics")`,
  );
  const diagnostics = await Promise.all([readLog(first), readLog(second)]);
  if (firstBack === null || secondBack === null) {
    console.error(`  handoff diagnostics: ${diagnostics.join(" | ")}`);
  }

  // The case costs ~84s against a 60s deferral cooldown, so what it spends the
  // time on is worth stating rather than inferring. Phases are printed with
  // offsets from the first record; a deferral names its own reason.
  //
  // BOTH tabs, labelled. The deferral is recorded by the tab that deferred, and
  // the coordinator's trail only shows that someone did — printing whichever
  // log happened to be non-empty hid the half that says why.
  const trails = diagnostics.map((raw) => {
    try {
      const log = JSON.parse(raw ?? "null");
      return Array.isArray(log) ? log : null;
    } catch { return null; }
  });
  const origins = trails.filter(Boolean).flatMap((log) => (log.length ? [log[0].t] : []));
  const origin = origins.length ? Math.min(...origins) : 0;
  trails.forEach((log, index) => {
    if (!log || log.length === 0) return;
    const line = log
      .map((entry) => `+${((entry.t - origin) / 1000).toFixed(1)}s ${entry.k}`
        + (entry.d === null ? "" : ` ${JSON.stringify(entry.d)}`))
      .join("\n    ");
    console.log(`  handoff phases (tab ${index === 0 ? "root" : "route"}):\n    ${line}`);
  });
  const phases = trails.find((log) => log && log.length > 0) ?? null;
  // The trail must survive the swap and be readable. Deliberately not asserted:
  // *which* phases appear. A deferred round is a race this protocol is allowed
  // to lose and allowed to stop losing, so requiring `no-waiting` here would
  // make the fix for it look like a regression.
  check(
    Array.isArray(phases) && phases.length > 0
      && phases.every((entry) => typeof entry.k === "string" && typeof entry.t === "number"),
    "update-handoff: a valid diagnostic trail survives the document swap",
  );
  // Specifically the move to THIS build. The trail is hydrated across
  // documents by design, so "a move happened at some point" can be satisfied
  // by a record left over from an earlier deploy in the same tab session —
  // which is precisely what this check exists to tell apart.
  check(
    phases !== null
      && phases.some((entry) => entry.k === "move" && entry.d?.v === handoffVersion),
    `update-handoff: the retained trail includes the move to ${handoffVersion}`,
  );

  const handoffRequests =
    control.requests.filter((p) => p === "/cosy-handoff").length - handoffRequestsBefore;

  await first.waitFor(`navigator.serviceWorker.controller !== null`, { timeout: 40000 });
  const identityAfter = await first.observe(`new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve(event.data);
    navigator.serviceWorker.controller.postMessage(
      { type: 'cosyncing-build-identity' }, [channel.port2],
    );
    setTimeout(() => resolve(null), 4000);
  })`);
  const after = await first.observe(`caches.keys()`);
  const surfaces = await Promise.all([
    first.observe(`({
      href: location.href,
      handoffFailed: window.cosyncingWebUpdateHandoffFailed === true,
      historyLength: history.length,
    })`),
    second.observe(`({
      href: location.href,
      handoffFailed: window.cosyncingWebUpdateHandoffFailed === true,
      historyLength: history.length,
    })`),
  ]);
  await first.shot("update-handoff-first");
  await second.shot("update-handoff-second");

  check(firstBack !== null, "update-handoff: the root tab returned under the new build");
  check(secondBack !== null, "update-handoff: the deep-linked tab returned under the new build");
  check(
    handoffRequests >= 2,
    `update-handoff: both tabs really left the worker scope (${handoffRequests} handoff loads)`,
  );
  check(
    surfaces[0].href === routesBefore[0],
    `update-handoff: the root tab is on its exact route (${surfaces[0].href} vs ${routesBefore[0]})`,
  );
  check(
    surfaces[1].href === routesBefore[1],
    `update-handoff: the deep-linked tab is on its exact route (${surfaces[1].href} vs ${routesBefore[1]})`,
  );
  check(
    !surfaces[0].handoffFailed && !surfaces[1].handoffFailed,
    "update-handoff: a routine update surfaces no failure state at all",
  );
  // `location.replace` on both legs, so the tab's history is the same shape it
  // was: no handoff URL to go Back onto, and no duplicate app entry.
  check(
    surfaces[0].historyLength === historyBefore[0]
      && surfaces[1].historyLength === historyBefore[1],
    `update-handoff: history is unchanged in length (${JSON.stringify([historyBefore, [surfaces[0].historyLength, surfaces[1].historyLength]])})`,
  );
  check(
    identityAfter?.version === handoffVersion,
    `update-handoff: the controller is now the new build (${identityAfter?.version})`,
  );
  check(
    identityAfter?.cacheName === newCacheName,
    "update-handoff: the live cache identity is the new build's",
  );
  check(
    !after.includes(oldCacheName),
    `update-handoff: the superseded cache is gone (${JSON.stringify(after)})`,
  );
  check(
    after.filter((n) => n.startsWith("cosyncing-app:")).length === 1,
    "update-handoff: exactly one application cache survives",
  );

  // Back must still leave the app rather than land on a handoff URL. Both legs
  // used `location.replace`, so no handoff entry exists to go back onto.
  await second.eval(`(setTimeout(() => { location.hash = '#/sessions'; }, 0), true)`);
  await second.waitFor(`location.hash === '#/sessions'`, { timeout: 30000 });
  // Schedule the navigation after Runtime.evaluate has replied. Calling Back
  // inline lets the document disappear before CDP acknowledges the one-shot
  // action; retrying that error would incorrectly move back twice.
  await second.eval(`(setTimeout(() => history.back(), 0), true)`);
  await sleep(2000);
  const afterBack = await second.observe(`location.pathname + location.hash`);
  check(
    !afterBack.startsWith("/cosy-handoff"),
    `update-handoff: Back never lands on the handoff page (got ${afterBack})`,
  );

  timings.updateHandoff = {
    censusBefore,
    identityBefore,
    identityAfter,
    handoffRequests,
    after,
    historyBefore,
    historyAfter: [surfaces[0].historyLength, surfaces[1].historyLength],
    diagnostics,
  };
  await first.close();
  await second.close();
};

cases["scope-isolation"] = async () => {
  // A neighbouring app on the same origin, with its own worker and cache, plus
  // a cache belonging to a second Cosyncing mount. A /cosy/ recovery must leave
  // every one of them alone.
  const neighbour = await newPage();
  await neighbour.goto(`http://127.0.0.1:${port}/other-app/`);
  await neighbour.eval(`navigator.serviceWorker.register('/other-app/sw.js', { scope: '/other-app/' })`);
  await neighbour.waitFor(
    `navigator.serviceWorker.getRegistration('/other-app/').then((r) => !!r && !!r.active)`,
    { timeout: 30000 },
  );
  await neighbour.close();

  const page = await newPage();
  await page.goto(BASE);
  await page.waitFor(`!document.getElementById('cosyncing-startup-shell')`, { timeout: 60000 });
  await page.waitFor(`navigator.serviceWorker.controller !== null`, { timeout: 30000 });
  // A cache belonging to a different Cosyncing mount on this origin.
  await page.eval(`caches.open('cosyncing-app:/staging/cosy/:othermount0001').then(() => true)`);

  const beforeReset = await page.eval(`(async () => ({
    caches: await caches.keys(),
    registrations: (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope),
  }))()`);

  // Drive the shell's own recovery path directly — the same function the final
  // retry button calls.
  await page.eval(`(async () => {
    const APP_SCOPE = new URL('./', document.baseURI).href;
    const CACHE_PREFIX = 'cosyncing-app:' + new URL('./', document.baseURI).pathname + ':';
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k.indexOf(CACHE_PREFIX) === 0 ? caches.delete(k) : null)));
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((r) => (r.scope === APP_SCOPE ? r.unregister() : null)));
    return true;
  })()`);

  const afterReset = await page.eval(`(async () => ({
    caches: await caches.keys(),
    registrations: (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope),
  }))()`);
  await page.shot("scope-isolation");

  const neighbourScope = `http://127.0.0.1:${port}/other-app/`;
  check(
    beforeReset.registrations.includes(neighbourScope),
    "scope-isolation: the neighbouring app really was registered",
  );
  check(
    afterReset.registrations.includes(neighbourScope),
    `scope-isolation: recovery leaves the neighbour registered (${JSON.stringify(afterReset.registrations)})`,
  );
  check(
    !afterReset.registrations.some((scope) => scope.endsWith("/cosy/")),
    "scope-isolation: recovery did unregister this app's own worker",
  );
  check(
    afterReset.caches.includes("neighbour-app-cache"),
    "scope-isolation: the neighbour's cache survives",
  );
  check(
    afterReset.caches.includes("cosyncing-app:/staging/cosy/:othermount0001"),
    "scope-isolation: another Cosyncing mount's cache survives",
  );
  check(
    !afterReset.caches.some((name) => name.startsWith("cosyncing-app:/cosy/:")),
    "scope-isolation: only this mount's caches were cleared",
  );
  timings.scopeIsolation = { beforeReset, afterReset };
  await page.close();
};

cases["base-path"] = async () => {
  const page = await newPage();
  await page.goto(BASE);
  await page.waitFor(`!document.getElementById('cosyncing-startup-shell')`, { timeout: 60000 });
  // Registration is deferred to `load` and resolves asynchronously after it.
  await page.waitFor(
    `navigator.serviceWorker.getRegistration().then((r) => !!r)`,
    { timeout: 40000 },
  );
  const scope = await page.eval(
    `navigator.serviceWorker.getRegistration().then((r) => r ? r.scope : null)`,
  );
  const baseHref = await page.eval(`document.querySelector('base').href`);
  // A deep link under /cosy/ must still resolve through the SPA fallback.
  const deep = await newPage();
  await deep.goto(`${BASE}sessions/codex/example`);
  const deepShell = await deep.waitFor(`!!document.getElementById('cosyncing-startup-shell')`, {
    timeout: 30000,
  });
  await deep.shot("base-path-deep-link");
  await deep.close();

  check(baseHref.endsWith("/cosy/"), `base-path: base href is /cosy/ (got ${baseHref})`);
  check(
    scope !== null && scope.endsWith("/cosy/"),
    `base-path: the worker scope is the app mount (got ${scope})`,
  );
  check(deepShell !== null, "base-path: a deep-linked refresh still paints the shell");

  // The app reaches its broker at the ORIGIN ROOT, deliberately outside the
  // worker's scope. Those requests must happen (the app is talking to the
  // broker) and none of them may end up in the static cache. They are issued
  // after the first frame, so wait for the first one instead of sampling.
  const outOfScope = () => [...new Set(control.requests.filter((p) => !p.startsWith("/cosy/")))];
  for (let i = 0; i < 100 && outOfScope().length === 0; i++) await sleep(100);
  const brokerRequests = outOfScope();
  const cachedPaths = await page.eval(`(async () => {
    const names = await caches.keys();
    const paths = [];
    for (const name of names) {
      const keys = await (await caches.open(name)).keys();
      for (const request of keys) paths.push(new URL(request.url).pathname);
    }
    return paths;
  })()`);
  check(
    brokerRequests.length > 0,
    "base-path: the app really did issue broker requests outside the worker scope",
  );
  check(
    cachedPaths.every((path) => path.startsWith("/cosy/")),
    `base-path: nothing outside the app mount is cached (${cachedPaths.filter((p) => !p.startsWith("/cosy/")).join(", ")})`,
  );
  check(
    cachedPaths.every((path) => !brokerRequests.includes(path)),
    `base-path: no broker request was written to the static cache (${brokerRequests.join(", ")})`,
  );
  timings.basePath = { baseHref, scope, brokerRequests, cachedPaths: cachedPaths.length };
  await page.close();
};

/* ------------------------------------------------------------------ *
 * Runner.
 * ------------------------------------------------------------------ */

await mkdir(OUT, { recursive: true });

/**
 * Wall-clock bound per case, generously above its own internal waits.
 *
 * A case that overruns is a failure with a name, not a suite that hangs: this
 * runs unattended in CI, and "still going" and "wedged" are indistinguishable
 * without one.
 */
const CASE_BUDGET_MS = {
  slow3g: 30000,
  "new-version": 120000,
  "update-handoff": 150000,
  "offline-repeat": 90000,
};
const DEFAULT_CASE_BUDGET_MS = 90000;

/** How long an over-budget case gets to unwind before we stop waiting for it. */
const CANCEL_GRACE_MS = 15000;

/**
 * Bound a case, and actually cancel it when the bound is hit.
 *
 * Rejecting the wrapper alone left the case itself running: it kept driving the
 * one shared browser and its control object while the runner had already moved
 * on to the next case, so an overrun corrupted whatever ran after it. Firing
 * the abort hooks rejects every in-flight CDP call, which unwinds the case's
 * own await chain, and the `finally` waits for that unwind.
 *
 * The abort hooks only reach work that is waiting on CDP. A case parked
 * anywhere else cannot be cancelled at all, so the wait is bounded — and when
 * that bound is reached the suite stops rather than starting another case
 * beside a case that is demonstrably still running.
 */
const UNWOUND = Symbol('unwound');

async function abandonRun(reason) {
  console.error(`\n${reason}`);
  console.error('stopping: a live case would corrupt every result after it');
  await cleanup();
  process.exit(1);
}

async function withBudget(promise, ms, label) {
  let timer;
  const settled = promise.catch(() => {});
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const why = `${label} exceeded ${ms}ms`;
      for (const abort of [...abortHooks]) abort(why);
      reject(new Error(why));
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, expiry]);
  } finally {
    clearTimeout(timer);
    const outcome = await Promise.race([
      settled.then(() => UNWOUND),
      sleep(CANCEL_GRACE_MS),
    ]);
    if (outcome !== UNWOUND) {
      await abandonRun(
        `${label} did not unwind within ${CANCEL_GRACE_MS}ms of being cancelled`,
      );
    }
  }
}

/** Per-case wall clock, fed back to the parent so it can balance the shards. */
const durationMs = {};

for (const name of order) {
  if (ONLY && ONLY !== name) continue;
  if (selectedCases && !selectedCases.includes(name)) continue;
  resetControl();
  console.log(name);
  const startedAt = Date.now();
  const failuresBefore = failures;
  let completed = false;
  try {
    await withBudget(resetBrowserState(), 60000, `${name}: reset`);
    resetControl();
    await withBudget(cases[name](), CASE_BUDGET_MS[name] ?? DEFAULT_CASE_BUDGET_MS, name);
    completed = failures === failuresBefore;
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name} threw: ${error?.message ?? error}`);
  }
  if (completed) durationMs[name] = Date.now() - startedAt;
}

await writeFile(
  join(OUT, SHARD_ID === null ? "timings.json" : `timings-shard-${SHARD_ID}.json`),
  `${JSON.stringify({ base: BASE, checks, failures, timings, durationMs }, null, 2)}\n`,
  "utf8",
);

console.log(`\nartifacts: ${OUT}`);
if (failures > 0) {
  console.error(`startup shell browser evidence: ${failures} failed of ${checks} checks`);
  await cleanup();
  process.exit(1);
}
console.log(`startup shell browser evidence: ${checks} checks passed`);
await cleanup();
process.exit(0);
