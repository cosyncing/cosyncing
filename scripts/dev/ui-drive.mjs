#!/usr/bin/env node
// Drive the Flutter web client in a real browser on WSL2, for UI verification.
//
// Why this exists rather than Playwright: WSL2 reports network namespaces as
// supported but denies them without elevated privileges, which crashes a
// directly-launched Chrome zygote with SIGILL. Playwright's own MCP server
// hangs here for the same reason. Driving Playwright's bundled
// chrome-headless-shell over raw CDP sidesteps the zygote entirely.
//
// Unlike screenshot-client.mjs, this does NOT serve the build from disk. It
// points at the source review broker (default http://127.0.0.1:17734/cosy/) so the API,
// the auth gate and real session data are all in play.
//
//   node scripts/dev/ui-drive.mjs scenario.mjs [--base URL] [--out DIR] [--keep]
//
// A scenario is an ES module with a default async function receiving `ctx`:
//
//   export default async (ctx) => {
//     await ctx.goto('/');
//     await ctx.a11y();               // build the DOM semantics tree
//     await ctx.click('Settings');
//     await ctx.shot('settings');
//   };
//
// Flutter renders to canvas, so there is normally nothing in the DOM to query.
// ctx.a11y() clicks Flutter's hidden "Enable accessibility" placeholder, which
// makes Flutter mirror the widget tree into real DOM nodes with aria-labels.
// That is what makes ctx.find/click/expect work by text instead of by
// hand-measured pixel coordinates.

import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const scenarioPath = process.argv[2];
if (!scenarioPath || scenarioPath.startsWith("--")) {
  console.error("usage: node scripts/dev/ui-drive.mjs <scenario.mjs> [--base URL] [--out DIR]");
  process.exit(2);
}

const BASE = (arg("base", "http://127.0.0.1:17734/cosy/")).replace(/\/$/, "") + "/";
const OUT = resolve(arg("out", join(REPO, "output/screenshots")));
const KEEP = process.argv.includes("--keep");

await mkdir(OUT, { recursive: true });

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

const cdpPort = 9000 + Math.floor((process.pid % 900));
const proc = spawn(BROWSER, [
  "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--headless",
  `--remote-debugging-port=${cdpPort}`, "--remote-allow-origins=*",
  "--window-size=1440,900", "about:blank",
], { stdio: "ignore" });

let closed = false;
const cleanup = () => { if (!closed) { closed = true; proc.kill(); } };
process.on("exit", cleanup);

const endpoint = `http://127.0.0.1:${cdpPort}`;
let up = false;
for (let i = 0; i < 60; i++) {
  try { await fetch(`${endpoint}/json/version`); up = true; break; }
  catch { await new Promise((r) => setTimeout(r, 200)); }
}
if (!up) { console.error("browser never came up"); process.exit(1); }

const target = await (await fetch(`${endpoint}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));

let msgId = 0;
const pending = new Map();
const logs = [];
let resolveLoad = () => {};

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: res, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
  if (msg.method === "Page.loadEventFired") resolveLoad();
  if (msg.method === "Runtime.consoleAPICalled") {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    logs.push(`[${msg.params.type}] ${text}`);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    logs.push(`[pageerror] ${msg.params.exceptionDetails.exception?.description ?? ""}`);
  }
});

const send = (method, params = {}) =>
  new Promise((res, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve: res, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return result.value;
};

// Collect every DOM node Flutter's semantics tree exposes, with its on-screen
// box. Flutter positions semantic nodes with CSS transforms, so
// getBoundingClientRect is authoritative and matches what the user sees.
const PROBE = `(() => {
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('flt-semantics, flt-semantics *, input, textarea')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const label = el.getAttribute('aria-label')
      || el.getAttribute('placeholder')
      || (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value : '')
      || (el.children.length === 0 ? (el.textContent || '').trim() : '');
    if (!label) continue;
    const key = label + '@' + Math.round(r.x) + ',' + Math.round(r.y);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label: label.slice(0, 200),
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
    });
  }
  return out;
})()`;

const ctx = {
  logs,
  base: BASE,
  outDir: OUT,

  async goto(path = "/") {
    const url = path.startsWith("http") ? path : BASE + String(path).replace(/^\//, "");
    const loaded = new Promise((r) => { resolveLoad = r; });
    await send("Page.navigate", { url });
    await Promise.race([loaded, sleep(20000)]);
    // CanvasKit falls back to CPU rasterization in the headless shell; a
    // screenshot taken before it paints is a blank canvas.
    await sleep(Number(arg("settle", 6000)));
    return url;
  },

  wait: sleep,

  async resize(width, height, deviceScaleFactor = 1) {
    await send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor, mobile: false,
    });
    await sleep(1200);
  },

  // Flutter only mirrors the widget tree into the DOM once accessibility is
  // switched on. Without this, find/click by text cannot work at all.
  async a11y() {
    await evaluate(`(() => {
      const p = document.querySelector('flt-semantics-placeholder')
        || document.querySelector('[aria-label="Enable accessibility"]');
      if (p) { p.click(); return true; }
      return false;
    })()`);
    await sleep(1500);
    return (await this.nodes()).length;
  },

  // The headless shell defaults to prefers-color-scheme: light. Anything
  // claiming a dark-theme bug must be checked with this set to 'dark', or the
  // test is only ever exercising the light path.
  async colorScheme(scheme) {
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme }],
    });
    await sleep(1200);
  },

  eval: evaluate,

  nodes: () => evaluate(PROBE),

  // Ranking matters more than it looks. Flutter gives container nodes a label
  // built from all their descendant text, so a card whose body prose says
  // "paste a broker token below" matches "Broker token" and, being an ancestor,
  // appears first in document order. Clicking its centre hits whatever happens
  // to sit in the middle of the card. Prefer real controls over groups, then
  // the tightest label match, then the smallest box.
  async find(text, { exact = false } = {}) {
    const nodes = await evaluate(PROBE);
    const needle = String(text).toLowerCase();
    const matches = nodes.filter((n) => exact
      ? n.label.toLowerCase() === needle
      : n.label.toLowerCase().includes(needle));
    if (!matches.length) return null;
    const rank = (n) => {
      const label = n.label.toLowerCase();
      if (label === needle) return 0;
      if (n.role !== "group") return 1;
      return 2;
    };
    matches.sort((a, b) =>
      rank(a) - rank(b)
      || a.label.length - b.label.length
      || (a.w * a.h) - (b.w * b.h));
    return matches[0];
  },

  async click(target, opts = {}) {
    let point = target;
    if (typeof target === "string") {
      const node = await this.find(target, opts);
      if (!node) throw new Error(`click: no element matching ${JSON.stringify(target)}`);
      point = { x: node.x + node.w / 2, y: node.y + node.h / 2 };
    }
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", {
        type, x: Math.round(point.x), y: Math.round(point.y),
        button: "left", clickCount: 1,
      });
    }
    await sleep(opts.settle ?? 900);
  },

  async type(text) {
    await send("Input.insertText", { text });
    await sleep(400);
  },

  async key(key) {
    const map = {
      Enter: { windowsVirtualKeyCode: 13, text: "\r" },
      Tab: { windowsVirtualKeyCode: 9, text: "\t" },
      Escape: { windowsVirtualKeyCode: 27 },
      Backspace: { windowsVirtualKeyCode: 8 },
    };
    const extra = map[key] ?? {};
    for (const type of ["keyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", { type, key, ...extra });
    }
    await sleep(400);
  },

  // Modifier bits per CDP: Alt=1, Ctrl=2, Meta=4, Shift=8.
  async wheel(x, y, deltaY, { ctrl = false } = {}) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: Math.round(x), y: Math.round(y),
      deltaX: 0, deltaY, modifiers: ctrl ? 2 : 0,
    });
    await sleep(700);
  },

  async shot(name, { fullPage = false } = {}) {
    const file = join(OUT, `${name.replace(/[^a-z0-9_.-]/gi, "-")}.png`);
    const { data } = await send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: fullPage,
    });
    const buf = Buffer.from(data, "base64");
    await writeFile(file, buf);
    console.log(`  shot ${file} (${buf.length} b)`);
    return file;
  },
};

let failed = false;
try {
  const mod = await import(pathToFileURL(resolve(scenarioPath)).href);
  await mod.default(ctx);
  console.log("scenario OK");
} catch (error) {
  failed = true;
  console.error(`scenario FAILED: ${error.message}`);
} finally {
  if (logs.length) {
    console.log("--- console ---");
    for (const line of logs.slice(0, 40)) console.log(`  ${line}`);
  }
  if (!KEEP) cleanup();
}
process.exit(failed ? 1 : 0);
