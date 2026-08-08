#!/usr/bin/env node
// Compose the finished Apple and Google store frames around the real captures.
//
//   node scripts/dev/compose-store-frames.mjs --raw DIR --out DIR
//
// The product screenshot is a LOCKED INPUT (doc 14, screenshot rules): it is placed at its exact
// pixel size, at integer coordinates, at device pixel ratio 1, so the composition is a blit and
// not a resample. Nothing is scaled, cropped, rounded off at the corners, or drawn over. The only
// thing that touches the rectangle's edge is a shadow, which renders outside the element box.
//
// That is asserted, not assumed: every composed frame is re-read afterwards and the rectangle is
// compared pixel-for-pixel against the capture it came from. A frame whose product pixels moved
// does not get written.
//
// Headlines are the locked campaign lines from doc 14's core story sequence; the Chinese set is the
// one in assets/brand/store/listing-zh-CN.md, which is written in Chinese rather than translated.
// Background, plane, lockup, and type follow the approved marketing masters in assets/brand/
// marketing (social-banner.html, play-feature-dark-teal.html) — same palette, same geometry, same
// font stack including the CJK fallback.
//
// Microsoft and PWA frames are NOT composed. Microsoft asks for no added logos or marketing
// messages, and the PWA frames document the real install surface; both ship exactly as captured.

import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { launchHeadlessShell } from "./headless-shell.mjs";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const BRAND = join(REPO, "apps/client/assets/brand");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const RAW = resolve(arg("raw", join(REPO, "output/brand/store/raw/en")));
const OUT = resolve(arg("out", join(REPO, "output/brand/store/final/en")));
const LOCALE = arg("locale", "en");

// ── palette and type, from the locked masters ───────────────────────────────────
const OBSIDIAN = "#0B0E14";
const OFFWHITE = "#F2F5F4";
const BRIGHT_TEAL = "#2DD4BF";
const DEEP_TEAL_WASH = "rgba(15,118,110,0.16)";
const FONTS = "'Inter','Droid Sans Fallback','DejaVu Sans',sans-serif";

// ── frame geometry ──────────────────────────────────────────────────────────────
// `ui` must equal the capture's real pixel size (capture-store-screenshots.mjs SURFACES), and
// `at` is where it lands in the export. Both are integers; nothing here divides.
const LAYOUTS = {
  "apple-iphone": {
    export: [1320, 2868], ui: [1140, 2100], at: [90, 620], mode: "top",
    type: { mark: 58, wordmark: 48, headline: 68, sub: 34 },
  },
  "apple-ipad": {
    export: [2064, 2752], ui: [1800, 2032], at: [132, 560], mode: "top",
    type: { mark: 66, wordmark: 56, headline: 80, sub: 40 },
  },
  "apple-mac": {
    // A landscape band cannot carry a sub-line without crowding the capture; the headline alone
    // does the work here.
    export: [2880, 1800], ui: [2560, 1300], at: [160, 360], mode: "top",
    type: { mark: 50, wordmark: 42, headline: 62, sub: 0 },
  },
  "play-phone": {
    export: [1080, 1920], ui: [936, 1400], at: [72, 400], mode: "top",
    type: { mark: 46, wordmark: 38, headline: 56, sub: 28 },
  },
  "play-tablet": {
    // 16:9 has no room for a top band over a usable pane, so the headline takes a left column.
    export: [1920, 1080], ui: [1280, 900], at: [560, 90], mode: "left",
    type: { mark: 46, wordmark: 38, headline: 54, sub: 27 },
  },
};

// ── campaign copy ───────────────────────────────────────────────────────────────
// Keyed by story frame. `en` is doc 14's core story sequence verbatim.
const COPY = {
  roster: {
    en: ["Every session, one calm view.", "Grouped by project, with the status of each."],
    "zh-CN": ["所有会话，一眼看清。", "按项目归组，状态各自分明。"],
  },
  notifications: {
    en: ["See what needs your attention.", "Finished, failed, or waiting on you."],
    "zh-CN": ["需要你的，一个不漏。", "跑完了、失败了，还是在等你。"],
  },
  detail: {
    en: ["Read, steer, and approve.", "Full transcripts, real diffs, real commands."],
    "zh-CN": ["看得懂，也管得住。", "完整对话、真实 diff、真实命令。"],
  },
  artifact: {
    en: ["Move files. Inspect artifacts.", "Send files in; open what comes back."],
    "zh-CN": ["传文件，看产物。", "把文件送进去，把结果取回来。"],
  },
  connection: {
    en: ["Pair with your own broker.", "Your machine, your network, no account."],
    "zh-CN": ["只连你自己的 Broker。", "你的机器、你的网络，不需要账号。"],
  },
  workspace: {
    en: ["One workspace, every screen.", "Phone, tablet, desktop, browser."],
    "zh-CN": ["一套工作区，换屏不断线。", "手机、平板、电脑、浏览器。"],
  },
};
if (!COPY.roster[LOCALE]) {
  console.error(`--locale ${LOCALE} has no campaign copy; add it to COPY before composing it`);
  process.exit(2);
}

/** Shipped exactly as captured — no background, no headline, no logo. */
const UNADORNED = /^(ms-desktop|pwa-wide|pwa-narrow)-/;

const mark = await readFile(join(BRAND, "source/cosyncing-mark-two-tone-dark-teal-leads.svg"), "utf8");
const MARK_URI = `data:image/svg+xml;base64,${Buffer.from(mark).toString("base64")}`;

/**
 * Split a headline so its second sentence carries the teal accent, exactly as the banner and
 * feature-graphic masters do. Chinese sentences end in `。`, English in `.`.
 */
const accentedHeadline = (text) => {
  const match = text.match(/^(.*?[.。])\s*(.+)$/s);
  if (!match) return escapeHtml(text);
  return `${escapeHtml(match[1])}<br><span class="accent">${escapeHtml(match[2])}</span>`;
};
const escapeHtml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const page = (layout, headline, sub, uiDataUri) => {
  const [w, h] = layout.export;
  const [uw, uh] = layout.ui;
  const [ux, uy] = layout.at;
  const t = layout.type;
  const left = layout.mode === "left";
  // In left mode the copy column is everything to the left of the capture; in top mode it is the
  // full width above it, centred.
  const column = left
    ? `left:${Math.round(w * 0.042)}px; top:0; bottom:0; width:${ux - Math.round(w * 0.042) - 48}px;
       display:flex; flex-direction:column; justify-content:center; text-align:left; align-items:flex-start;`
    : `left:0; right:0; top:0; height:${uy}px;
       display:flex; flex-direction:column; justify-content:center; text-align:center; align-items:center;`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body { margin:0; padding:0; background:${OBSIDIAN}; }
  .frame { position:relative; width:${w}px; height:${h}px; overflow:hidden; background:${OBSIDIAN};
           font-family:${FONTS}; -webkit-font-smoothing:antialiased; }
  /* Anchored to the bottom-right and mostly covered by the capture, so the brand plane reads as a
     corner accent in the margin instead of a hard diagonal running through the headline. */
  .plane { position:absolute; right:${-Math.round(w * 0.16)}px; bottom:${-Math.round(w * 0.14)}px;
           width:${Math.round(w * 0.7)}px; height:${Math.round(w * 0.7)}px;
           background:${DEEP_TEAL_WASH}; border-radius:${Math.round(w * 0.09)}px;
           transform:rotate(12deg); }
  .copy { position:absolute; ${column} }
  .lock { display:flex; align-items:center; gap:${Math.round(t.mark * 0.28)}px; opacity:0.92; }
  .wm { font-weight:500; letter-spacing:-0.01em; font-size:${t.wordmark}px; color:${OFFWHITE}; }
  .sync { color:${BRIGHT_TEAL}; }
  .headline { margin-top:${Math.round(t.headline * 0.9)}px; font-weight:500; font-size:${t.headline}px;
              line-height:1.24; letter-spacing:-0.01em; color:${OFFWHITE}; }
  .headline .accent { color:${BRIGHT_TEAL}; }
  .sub { margin-top:${Math.round(t.headline * 0.42)}px; font-weight:400; font-size:${t.sub}px;
         line-height:1.35; color:rgba(242,245,244,0.66); }
  /* The capture: exact pixel size, integer position, no transform, no radius, no filter. The
     shadow renders outside the element box, so it never touches a product pixel. */
  .ui { position:absolute; left:${ux}px; top:${uy}px; width:${uw}px; height:${uh}px;
        display:block; box-shadow:0 ${Math.round(h * 0.012)}px ${Math.round(h * 0.05)}px rgba(0,0,0,0.55); }
</style></head><body>
  <div class="frame">
    <div class="plane"></div>
    <div class="copy">
      <div class="lock">
        <img src="${MARK_URI}" style="width:${t.mark}px;height:${t.mark}px">
        <span class="wm">co<span class="sync">sync</span>ing</span>
      </div>
      <div class="headline">${accentedHeadline(headline)}</div>
      ${t.sub && sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}
    </div>
    <img class="ui" src="${uiDataUri}">
  </div>
</body></html>`;
};

// ── what there is to compose ────────────────────────────────────────────────────
// Read before the browser starts, so that "there is nothing here" is not a reason to leave one
// running: nothing below this point may exit the process without going through `shutdown`.
const captures = (await readdir(RAW)).filter((f) => f.endsWith(".png")).sort();
if (!captures.length) { console.error(`no captures in ${RAW}`); process.exit(1); }
await mkdir(OUT, { recursive: true });

// ── browser ─────────────────────────────────────────────────────────────────────
// Connected by the endpoint the shell publishes into its own private profile, not by a guessed
// port — see scripts/dev/headless-shell.mjs.
const { browserWsUrl, close: closeBrowser } = await launchHeadlessShell();

const ws = new WebSocket(browserWsUrl);
/**
 * Stop the browser and take its profile directory with it, however this run ends.
 *
 * Idempotent, and called from a `finally`: an unexpected throw below used to skip the close at the
 * bottom of this file entirely, leaving a chrome-headless-shell running and a `cosyncing-shot-*`
 * profile in the temp directory.
 */
let shutDown = false;
const shutdown = async () => {
  if (shutDown) return;
  shutDown = true;
  try { ws.close(); } catch { /* already gone */ }
  await closeBrowser();
};
try {
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error(`could not open a CDP socket to ${browserWsUrl}`)));
  });
} catch (error) {
  await shutdown();
  throw error;
}
let msgId = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: res, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
});
const raw = (method, params = {}, sessionId) =>
  new Promise((res, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve: res, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const sessionId = await (async () => {
  const { targetId } = await raw("Target.createTarget", { url: "about:blank" });
  const attached = await raw("Target.attachToTarget", { targetId, flatten: true });
  return attached.sessionId;
})().catch(async (error) => { await shutdown(); throw error; });
/** Every call below is addressed to the page this process created. */
const send = (method, params = {}) => raw(method, params, sessionId);
try {
  await send("Page.enable");
  await send("Runtime.enable");
} catch (error) {
  await shutdown();
  throw error;
}

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? "evaluate failed");
  return result.value;
};

/**
 * Prove the product rectangle survived composition byte-identically.
 *
 * Decoding both PNGs in the page and diffing the pixels is the whole point: "I set width and height
 * to the natural size" is a claim about intent, and this is a statement about output.
 */
const assertUiUnchanged = async (composedUri, rawUri, layout, name) => {
  const [ux, uy] = layout.at;
  const [uw, uh] = layout.ui;
  const diff = await evaluate(`(async () => {
    const load = (src) => new Promise((res, rej) => {
      const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('decode')); img.src = src;
    });
    const [composed, raw] = await Promise.all([load(${JSON.stringify(composedUri)}), load(${JSON.stringify(rawUri)})]);
    if (raw.width !== ${uw} || raw.height !== ${uh}) return -1;
    const cut = (img, dx, dy) => {
      const c = document.createElement('canvas'); c.width = ${uw}; c.height = ${uh};
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, dx, dy);
      return g.getImageData(0, 0, ${uw}, ${uh}).data;
    };
    const a = cut(composed, ${-ux}, ${-uy});
    const b = cut(raw, 0, 0);
    let differing = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) differing++;
    }
    return differing;
  })()`);
  if (diff === -1) throw new Error(`${name}: capture is not ${uw}×${uh}; the layout and the capture disagree`);
  if (diff !== 0) throw new Error(`${name}: ${diff} product pixels changed during composition`);
};

// ── compose ─────────────────────────────────────────────────────────────────────
let written = 0;
let failures = 0;

try {
  for (const file of captures) {
    const name = file.replace(/\.png$/, "");
    // Unadorned frames still belong in the submission folder: a console upload should be one
    // directory, not "these files from here and those from there".
    if (UNADORNED.test(name)) {
      await copyFile(join(RAW, file), join(OUT, file));
      console.log(`  ${file}  (shipped exactly as captured)`);
      written++;
      continue;
    }
    const [surface, frame] = [name.split("-").slice(0, 2).join("-"), name.split("-")[2]];
    const layout = LAYOUTS[surface];
    const copy = COPY[frame];
    if (!layout || !copy) {
      console.error(`  FAILED ${name}: no layout for surface ${surface} or copy for frame ${frame}`);
      failures++;
      continue;
    }
    const rawUri = `data:image/png;base64,${(await readFile(join(RAW, file))).toString("base64")}`;
    const [headline, sub] = copy[LOCALE];
    try {
      const html = page(layout, headline, sub, rawUri);
      await send("Emulation.setDeviceMetricsOverride", {
        width: layout.export[0], height: layout.export[1], deviceScaleFactor: 1, mobile: false,
      });
      await send("Page.navigate", { url: `data:text/html;base64,${Buffer.from(html).toString("base64")}` });
      await new Promise((r) => setTimeout(r, 900));
      const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const composedUri = `data:image/png;base64,${data}`;
      await assertUiUnchanged(composedUri, rawUri, layout, name);
      const buf = Buffer.from(data, "base64");
      await writeFile(join(OUT, file), buf);
      console.log(`  ${file}  ${layout.export[0]}×${layout.export[1]}  ${(buf.length / 1024).toFixed(0)} KiB  (UI rect verified identical)`);
      written++;
    } catch (error) {
      console.error(`  FAILED ${name}: ${error.message}`);
      failures++;
    }
  }
} finally {
  // Awaited, and the socket closed, so the browser is gone and its profile removed before this
  // process ends — including when something above threw. `process.exit()` here would kill both
  // mid-flight.
  await shutdown();
}
console.log(`\n${written} ${LOCALE} store frames written to ${OUT}`);
if (failures) {
  console.error(`${failures} composition(s) failed — nothing may be published from this run`);
  process.exitCode = 1;
}
