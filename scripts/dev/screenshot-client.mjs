#!/usr/bin/env node
// Screenshot the built Flutter web client on WSL2.
//
// WSL2 reports network namespaces as supported but denies them without elevated
// privileges, which crashes a directly-launched google-chrome zygote with SIGILL.
// We drive Playwright's bundled chrome-headless-shell over CDP instead.
//
//   node scripts/dev/screenshot-client.mjs [--out shot.png] [--route /] [--wait 8000]
//
// Requires an existing build: bun run client:build:web

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, normalize } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const BUILD = join(REPO, "apps/client/build/web");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const out = arg("out", join(REPO, "output/screenshots/client.png"));
const route = arg("route", "/");
const waitMs = Number(arg("wait", 8000));

if (!existsSync(join(BUILD, "index.html"))) {
  console.error(`No build at ${BUILD}\nRun: bun run client:build:web`);
  process.exit(1);
}

// Resolve the newest installed chrome-headless-shell. Pinning a revision breaks
// on every Playwright bump, so glob the cache instead.
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
  ".symbols": "text/plain",
};

// The build is compiled with --base-href /cosy/, so it must be mounted there.
// Serving it at / returns 200 for index.html and 404s every asset, which looks
// exactly like a browser crash.
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (!path.startsWith("/cosy/")) return void res.writeHead(404).end("not found");
  const file = normalize(join(BUILD, path.slice("/cosy/".length) || "index.html"));
  if (!file.startsWith(BUILD)) return void res.writeHead(403).end("forbidden");
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(200, { "content-type": "text/html" }).end(await readFile(join(BUILD, "index.html")));
  }
});

const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const cdpPort = 9334;

const proc = spawn(BROWSER, [
  "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--headless",
  `--remote-debugging-port=${cdpPort}`, "--remote-allow-origins=*",
  "--window-size=1280,800", "about:blank",
], { stdio: "ignore" });

const cleanup = () => { proc.kill(); server.close(); };
process.on("exit", cleanup);

const endpoint = `http://127.0.0.1:${cdpPort}`;
for (let i = 0; i < 50; i++) {
  try { await fetch(`${endpoint}/json/version`); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
}

const target = await (await fetch(`${endpoint}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));

let id = 0;
const pending = new Map();
const logs = [];
let onLoad;
const loaded = new Promise((r) => (onLoad = r));

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
  if (msg.method === "Page.loadEventFired") onLoad();
  if (msg.method === "Runtime.consoleAPICalled") {
    logs.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

const url = `http://127.0.0.1:${port}/cosy/${route.replace(/^\//, "")}`;
await send("Page.navigate", { url });
await Promise.race([loaded, new Promise((r) => setTimeout(r, 15000))]);

// Headless shell has no WebGL, so CanvasKit falls back to CPU rasterization.
// Capturing before it paints yields a blank canvas.
await new Promise((r) => setTimeout(r, waitMs));

const { data } = await send("Page.captureScreenshot", { format: "png" });
await writeFile(out, Buffer.from(data, "base64"));

console.log(`${url} -> ${out} (${Buffer.from(data, "base64").length} bytes)`);
for (const line of logs.slice(0, 20)) console.log(`  ${line}`);

cleanup();
process.exit(0);
