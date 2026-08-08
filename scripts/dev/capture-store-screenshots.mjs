#!/usr/bin/env node
// Capture the store screenshot campaign from the REAL Flutter app.
//
// Nothing here draws, retouches, or composes UI: it drives the served client in a browser and saves
// what the app painted. Headlines and backgrounds are added later, around an unchanged rectangle,
// by scripts/dev/compose-store-frames.mjs — which is also why most surfaces here are captured at
// the UI rectangle's size rather than the full store export size.
//
// Prerequisites — the fixture broker must be up and proven clean first, because these images are
// published artifacts. scripts/dev/run-store-capture.sh does all of it in order; the equivalent by
// hand is in that script's header.
//
//   node scripts/dev/capture-store-screenshots.mjs --base http://127.0.0.1:7745/cosy/ \
//     --fixture-root DIR --out DIR
//
// Every frame in PLAN is required. There is no skip path: a partial campaign that exits 0 is how a
// stale image from an older run survives into a release.
//
// Why raw CDP rather than Playwright's API: WSL2 reports network namespaces as supported and then
// denies them, so a directly launched Chrome zygote dies with SIGILL. This is the same transport
// scripts/dev/ui-drive.mjs uses, for the same reason.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { launchHeadlessShell } from "./headless-shell.mjs";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const BASE = (arg("base", "http://127.0.0.1:7745/cosy/")).replace(/\/$/, "") + "/";
/** Origin only — what a user types into the Connection form. */
const BROKER_ORIGIN = new URL(BASE).origin;
const FIXTURE_ROOT = resolve(arg("fixture-root", ""));
const OUT = resolve(arg("out", join(REPO, "output/brand/store/raw")));
const ONLY = arg("only", null);
const LOCALE = arg("locale", "en");

// The client localizes from `navigator.language`, which follows the accept-language override — so a
// zh-CN listing can show a Chinese app rather than an English one with Chinese captions pasted over
// it. Only chrome labels need translating here; session titles and tool rows come from the fixture
// and are the same in both.
const CHROME = {
  en: {
    notifications: "Notifications", connection: "Connection", connect: "Connect", showSessions: "Show sessions",
    brokerToken: "Broker token", saveToken: "Save token",
    observing: "Observing", driving: "Driving", takeOver: "Take over", takeOverTitle: "Take over this session",
    backToChat: "Back to chat",
  },
  "zh-CN": {
    notifications: "通知", connection: "连接", connect: "连接", showSessions: "显示会话",
    brokerToken: "Broker 令牌", saveToken: "保存令牌",
    observing: "观察中", driving: "应用控制中", takeOver: "接管", takeOverTitle: "接管此会话",
    backToChat: "返回对话",
  },
};
if (!CHROME[LOCALE]) {
  console.error(`--locale ${LOCALE} has no chrome label map; add one before capturing it`);
  process.exit(2);
}
const label = CHROME[LOCALE];

if (!arg("fixture-root", "")) {
  console.error("--fixture-root is required: the root printed by seed-brand-fixture.ts");
  process.exit(2);
}

const manifest = JSON.parse(await readFile(join(FIXTURE_ROOT, "manifest.json"), "utf8"));
const env = JSON.parse(await readFile(join(FIXTURE_ROOT, "env.json"), "utf8"));
/**
 * The fixture broker's own credential, entered through the app's enrolment gate.
 *
 * The app cannot take a session over without one — the broker's Drive boundary refuses `mode=resume`
 * to a caller that has not proved a credential — and without Drive the approval frame can only show
 * a request that says "answer where the agent is running". So the fixture is credentialed like a
 * real broker, and every frame starts by enrolling this device the way a user would.
 */
const BROKER_TOKEN = (await readFile(join(env.COSYNCING_HOME, "secrets", "broker-token"), "utf8")).trim();
/** A project group header, so a roster frame can prove its roster actually painted. */
const ROSTER_WITNESS = Object.values(manifest.projects)[0].split("/").pop();
/**
 * Resolve a click fragment against the manifest, so a frame can only ever aim at a row the verifier
 * proved fictitious, and only ever at one of them. Roster labels ellipsize at narrow rail widths,
 * so frames click a fragment rather than a full title — which makes "does this fragment identify
 * exactly one session?" the thing worth asserting.
 */
const sessionFor = (fragment) => {
  const hits = manifest.sessions.filter((s) => s.title.toLowerCase().includes(fragment.toLowerCase()));
  if (hits.length !== 1) {
    throw new Error(`${JSON.stringify(fragment)} matches ${hits.length} fixture sessions, expected exactly 1`);
  }
  return hits[0];
};

await mkdir(OUT, { recursive: true });

// ── target surfaces ─────────────────────────────────────────────────────────────
// `css` × `scale` is the captured pixel size. For a composed surface that is the UI RECTANGLE
// inside the finished store frame, not the frame itself: the composition places this bitmap 1:1, so
// capturing it at final size is what keeps every product pixel unresampled.
//
// Emulating a small CSS viewport at a high device pixel ratio is what a real device does, so the
// app takes its true layout AND exports at store resolution. The client switches to its two-pane
// layout at 840 logical px (router.dart `_wideNavigationBreakpoint`), so every `wide` surface below
// is at or above that.
const SURFACES = {
  // composed: capture is the UI rectangle inside a branded frame
  "apple-iphone": { css: [380, 700], scale: 3, layout: "narrow" }, //  1140×2100 in 1320×2868
  "apple-ipad": { css: [900, 1016], scale: 2, layout: "wide" }, //     1800×2032 in 2064×2752
  "apple-mac": { css: [1280, 650], scale: 2, layout: "wide" }, //      2560×1300 in 2880×1800
  "play-phone": { css: [468, 700], scale: 2, layout: "narrow" }, //     936×1400 in 1080×1920
  // A 16:9 tablet frame cannot afford a top headline band AND a 2× pane: at 840×420 logical the
  // conversation is four lines tall and mostly empty. The Google tablet composition puts its
  // headline in a left column instead and gives the app a 1× pane it can actually fill.
  "play-tablet": { css: [1280, 900], scale: 1, layout: "wide" }, //    1280×900  in 1920×1080
  // unadorned: shipped exactly as captured. Microsoft asks for no added logos or marketing text,
  // and the PWA install surfaces are documentation of the real window.
  "ms-desktop": { css: [1920, 1080], scale: 2, layout: "wide" }, //    3840×2160
  "pwa-wide": { css: [1920, 1080], scale: 1, layout: "wide" }, //      1920×1080
  "pwa-narrow": { css: [412, 915], scale: 1, layout: "narrow" }, //     412×915
};

// ── browser plumbing ────────────────────────────────────────────────────────────
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const { browserWsUrl, close: closeBrowser } = await launchHeadlessShell(["--window-size=1920,1080"]);

const ws = new WebSocket(browserWsUrl);
/**
 * Stop the browser and take its profile directory with it, however this run ends.
 *
 * Idempotent, and called from a `finally`: an unexpected throw anywhere below used to skip the close
 * at the bottom of this file entirely, which leaves a chrome-headless-shell running and a
 * `cosyncing-shot-*` profile in the temp directory for somebody to find later.
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
const loadWaiters = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: res, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
  if (msg.method === "Page.loadEventFired" && loadWaiters.has(msg.sessionId)) {
    loadWaiters.get(msg.sessionId)();
    loadWaiters.delete(msg.sessionId);
  }
});
/** Flat-session CDP: one browser socket, `sessionId` selects the page. */
const send = (method, params = {}, sessionId) =>
  new Promise((res, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve: res, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── one throwaway browser context per frame ─────────────────────────────────────
// The opened-sessions working set is durable client state (Drift over IndexedDB), so it survives a
// reload: without isolation every frame inherits the tabs the previous frame opened. That is not
// only untidy — with a tab strip present a roster label such as "Extract the pricing table" also
// matches its own tab, and clicking a tab does not switch the pane, so one frame silently captured
// the wrong session. A fresh context has an empty origin store, which removes the whole class.
class Page {
  static async open() {
    const { browserContextId } = await send("Target.createBrowserContext", {});
    const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(browserContextId, targetId, sessionId);
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Network.enable", {}, sessionId);
    // `Emulation.setLocaleOverride` moves Intl but not `navigator.language`, which is what the
    // client reads; the accept-language override moves both.
    await send("Network.setUserAgentOverride", { userAgent: USER_AGENT, acceptLanguage: LOCALE }, sessionId);
    return page;
  }

  constructor(browserContextId, targetId, sessionId) {
    this.browserContextId = browserContextId;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  cdp(method, params) { return send(method, params, this.sessionId); }

  async close() {
    await send("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
    await send("Target.disposeBrowserContext", { browserContextId: this.browserContextId }).catch(() => {});
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.cdp("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? "evaluate failed");
    return result.value;
  }

  nodes() { return this.evaluate(PROBE); }

  // Flutter renders to canvas; the widget tree only reaches the DOM once its accessibility
  // placeholder is clicked. That click races first paint, so retry until nodes really appear
  // instead of assuming one call took.
  async semantics(tries = 8) {
    for (let i = 0; i < tries; i++) {
      await this.evaluate(`(() => {
        const p = document.querySelector('flt-semantics-placeholder')
          || document.querySelector('[aria-label="Enable accessibility"]');
        if (p) { p.click(); return true; }
        return false;
      })()`);
      await sleep(1200);
      if ((await this.nodes()).length > 0) return true;
    }
    return false;
  }

  /**
   * `role` narrows the search to one kind of control. It is not cosmetic: in Chinese the Connect
   * button and the Connection tab are both exactly 连接, and the tab won on tie-break — so the
   * connection frame clicked the tab it was already on and never connected.
   */
  async find(text, { exact = false, role = null } = {}) {
    const all = await this.nodes();
    const needle = String(text).toLowerCase();
    const matches = all.filter((n) =>
      (role === null || n.role === role)
      && (exact ? n.label.toLowerCase() === needle : n.label.toLowerCase().includes(needle)));
    if (!matches.length) return null;
    // Prefer real controls over the container groups Flutter labels with all their descendant text,
    // then the tightest label, then the smallest box — clicking a group's centre hits whatever
    // happens to sit in the middle of it.
    const rank = (n) => (n.label.toLowerCase() === needle ? 0 : n.role !== "group" ? 1 : 2);
    matches.sort((a, b) => rank(a) - rank(b) || a.label.length - b.label.length || a.w * a.h - b.w * b.h);
    return matches[0];
  }

  /**
   * Poll until something appears, rather than sleeping a guessed number of milliseconds.
   *
   * The first localized run failed four frames on a loaded machine because fixed settles that were
   * comfortable when the box was idle were not when it had been rendering for an hour. Waiting on
   * the thing itself removes the guess.
   */
  async waitFor(text, { timeout = 30_000, interval = 700, role = null } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const node = await this.find(text, { role });
      if (node) return node;
      if (Date.now() >= deadline) return null;
      await sleep(interval);
    }
  }

  /** Is this node's box actually inside the frame being captured? */
  onScreen(node) {
    const [w, h] = SURFACES[this.surface].css;
    return !!node && node.x + node.w > 0 && node.y + node.h > 0 && node.x < w && node.y < h;
  }

  /**
   * Wait until at least one of `texts` is present AND within the captured viewport.
   *
   * Flutter publishes semantics for content scrolled out of view, so "the node exists" does not mean
   * "it is in the picture". Every frame proves what it is a frame OF, immediately before the
   * shutter — otherwise a blank canvas, a wrong pane, or a scroll that moved the subject off the
   * bottom all produce a file that looks like a successful capture.
   */
  async waitForVisible(texts, { timeout = 25_000, interval = 700 } = {}) {
    const wanted = Array.isArray(texts) ? texts : [texts];
    const deadline = Date.now() + timeout;
    for (;;) {
      for (const text of wanted) {
        const node = await this.find(text);
        if (this.onScreen(node)) return node;
      }
      if (Date.now() >= deadline) return null;
      await sleep(interval);
    }
  }

  async click(targetOrPoint, { settle = 1200, optional = false, role = null } = {}) {
    let point = targetOrPoint;
    if (typeof targetOrPoint === "string") {
      const node = await this.find(targetOrPoint, { role });
      if (!node) {
        if (optional) return false;
        throw new Error(`click: no element matching ${JSON.stringify(targetOrPoint)}`);
      }
      point = { x: node.x + node.w / 2, y: node.y + node.h / 2 };
      // Flutter reports semantics for rows scrolled out of view, and CDP will happily dispatch a
      // click at their off-screen coordinates — which lands on whatever is actually at that point,
      // or nothing. One frame captured the wrong session this way and looked entirely plausible.
      // Fail loudly instead: a capture that silently photographs the wrong thing is worse than one
      // that stops.
      const [w, h] = SURFACES[this.surface].css;
      if (point.x < 0 || point.y < 0 || point.x > w || point.y > h) {
        throw new Error(
          `click: ${JSON.stringify(targetOrPoint)} resolved to (${Math.round(point.x)}, ${Math.round(point.y)}), ` +
            `outside the ${w}x${h} viewport — it is scrolled out of view on this surface`,
        );
      }
    }
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.cdp("Input.dispatchMouseEvent", {
        type, x: Math.round(point.x), y: Math.round(point.y), button: "left", clickCount: 1,
      });
    }
    await sleep(settle);
    return true;
  }

  /**
   * Open a roster row and prove the pane that came up is that session's.
   *
   * `witness` is a string that appears only in this session's transcript. Without it "the click
   * landed somewhere" is the only thing a successful capture demonstrates, and a frame that
   * photographs a different session than it is named for looks entirely plausible.
   */
  async openSession(fragment, witness, { layout = "narrow" } = {}) {
    const session = sessionFor(fragment);
    // Retried, because a click that lands while the roster is still settling hits nothing and no
    // amount of further waiting recovers it. The witness still decides whether the frame is
    // acceptable — retrying changes how long a miss costs, not what counts as success.
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) {
        await this.goHome();
        if (layout === "wide") await this.expandRail();
      }
      if (!(await this.waitFor(fragment))) {
        if (attempt === 3) throw new Error(`the roster never showed a row matching ${JSON.stringify(fragment)}`);
        continue;
      }
      await this.click(fragment, { settle: 1500 });
      if (await this.waitFor(witness, { timeout: 15_000 })) {
        await sleep(1500);
        return;
      }
      console.log(`  · ${JSON.stringify(witness)} did not appear; reopening "${session.title}"`);
    }
    throw new Error(
      `opened "${session.title}" but ${JSON.stringify(witness)} never appeared — ` +
        'the pane may be showing a different session',
    );
  }

  /**
   * Expand a tool row when it is on screen, and say so when it is not.
   *
   * Expansions are content density, not correctness: a 420-logical-pixel tablet pane has the row
   * scrolled out of reach while a 1016-pixel iPad pane does not. Skipping is fine; skipping
   * quietly is not.
   */
  async expandIfVisible(label) {
    const node = await this.find(label);
    const [w, h] = SURFACES[this.surface].css;
    const point = node && { x: node.x + node.w / 2, y: node.y + node.h / 2 };
    if (!point || point.x < 0 || point.y < 0 || point.x > w || point.y > h) {
      console.log(`  · not expanding ${JSON.stringify(label)}: ${node ? "scrolled out of view" : "not present"}`);
      return false;
    }
    await this.click(point, { settle: 1800 });
    return true;
  }

  /**
   * Every text editor on screen, asked of the DOM rather than of the semantics tree.
   *
   * The semantics probe only sees nodes that carry a label, and the composer publishes none at
   * phone widths: the field is there, but its hint is painted on the canvas instead of being set as
   * a placeholder, so a label-filtered search reported zero fields on a screen that plainly had one.
   */
  editors() {
    return this.evaluate(`(() => {
      const out = [];
      for (const el of document.querySelectorAll('input, textarea')) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        // On screen, not merely in the document: Flutter keeps the editing hosts of screens the
        // user has left, and a form the app is no longer showing is not a field this can type into.
        if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
        // Disabled ones are not fields at all: Flutter renders selectable read-only prose as a
        // disabled <textarea>, which put a heading, a paragraph and a status line in front of the
        // connection form's single real input.
        if (el.disabled === true) continue;
        out.push({
          label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || '',
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        });
      }
      return out;
    })()`);
  }

  /** Wait until the screen has editors, then hand them back. */
  async waitForEditors(timeout = 20_000) {
    for (const deadline = Date.now() + timeout; ;) {
      const found = await this.editors();
      if (found.length || Date.now() >= deadline) return found;
      await sleep(700);
    }
  }

  async focusEditor(field) {
    await this.click({ x: field.x + field.w / 2, y: field.y + field.h / 2 }, { settle: 700 });
  }

  /**
   * Focus the one text field on screen, clear it, and type `text`.
   *
   * By element rather than by label: the accessible label sits on a separate span, and clicking a
   * label does not focus the field it names — the first attempt typed into nothing and produced a
   * validation error instead of a connection.
   */
  async typeIntoField(text) {
    const inputs = await this.waitForEditors(15_000);
    if (inputs.length !== 1) {
      throw new Error(`expected exactly one text field on screen, found ${inputs.length}: ${JSON.stringify(inputs)}`);
    }
    await this.focusEditor(inputs[0]);
    for (const type of ["keyDown", "keyUp"]) {
      await this.cdp("Input.dispatchKeyEvent", {
        type, modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      });
    }
    await this.cdp("Input.insertText", { text });
    await sleep(500);
  }

  /**
   * Take control of the open session, so its requests are the reader's to answer.
   *
   * Observe is honest about what it cannot do: a request replayed to an observing client renders
   * read-only, with "answer where the agent is running" under it. That is the correct product
   * behaviour and the wrong screenshot for a frame headlined "Read, steer, and approve" — the
   * approval has to be one this device can actually make.
   *
   * The status pill IS the control: tapping it opens the Status view, where Take over lives.
   */
  async ensureDriving() {
    if (await this.find(label.driving)) return;
    await this.click(label.observing, { settle: 2000 });
    const takeOver = await this.waitFor(label.takeOver, { timeout: 20_000, role: "button" });
    if (!takeOver) {
      throw new Error(`the Status view never offered ${JSON.stringify(label.takeOver)} for this session`);
    }
    await this.click({ x: takeOver.x + takeOver.w / 2, y: takeOver.y + takeOver.h / 2 }, { settle: 2000 });
    // The confirmation carries the same words as the button that opened it. Ranking by box area
    // picks the dialog's action over the panel's; checking for the dialog first is what stops a
    // suppressed warning from turning the second click into a second take-over attempt.
    if (await this.waitFor(label.takeOverTitle, { timeout: 8_000 })) {
      await this.click(label.takeOver, { settle: 2500, role: "button" });
    }
    if (!(await this.waitFor(label.driving, { timeout: 30_000 }))) {
      throw new Error("took the session over, but the broker never reported this device as driving");
    }
    await this.click(label.backToChat, { settle: 1800, role: "button" });
  }

  /**
   * Type one prompt into the composer and send it.
   *
   * Two things here are the result of watching it go wrong. The field is CLEARED first: the broker
   * keeps a per-session composer draft, so a retried frame types into whatever the previous attempt
   * left behind and the frame shows the same sentence three times. And the send is the composer's
   * own Ctrl+Enter chord, pressed as real Control key events rather than as a modifier flag on the
   * Enter — Flutter reads `HardwareKeyboard.isControlPressed`, which only a genuine Control keydown
   * sets, so a flagged Enter typed a newline and sent nothing.
   */
  async sendPrompt(text) {
    const fields = await this.waitForEditors();
    if (!fields.length) throw new Error("no composer field on screen to type the prompt into");
    // The bottom-most editor, not the only one: a wide layout shows the roster's search field beside
    // the conversation, and the composer is always the lowest thing on the screen.
    const composer = fields.reduce((lowest, n) => (n.y + n.h > lowest.y + lowest.h ? n : lowest));
    await this.focusEditor(composer);
    for (const type of ["keyDown", "keyUp"]) {
      await this.cdp("Input.dispatchKeyEvent", {
        type, modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      });
    }
    await this.cdp("Input.insertText", { text });
    await sleep(700);
    const control = { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 };
    const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await this.cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 2, ...control });
    await this.cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 2, ...enter });
    await this.cdp("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, ...enter });
    await this.cdp("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 0, ...control });
    await sleep(1500);
  }

  /** Wheel the transcript to its top so a frame opens on a message boundary, not a cut line. */
  /**
   * The first row the conversation paints below its header, in DEVICE pixels.
   *
   * Measured off the frame rather than the widget tree, because what matters is what the picture
   * shows — the same technique compose-store-frames.mjs uses to verify its product rectangle. A row
   * counts as ink if its pixels vary at all across the band, and the band is the left half of the
   * conversation pane, which every surface fills with the session title and then with message text.
   */
  async firstTranscriptInk(pane) {
    const { css, scale } = SURFACES[this.surface];
    const x0 = Math.round(pane.x * scale);
    const x1 = Math.round((pane.x + pane.w * 0.5) * scale);
    const rows = Math.round(css[1] * 0.35 * scale);
    const { data } = await this.cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    return this.evaluate(`(async () => {
      const img = await new Promise((res, rej) => {
        const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('decode'));
        i.src = 'data:image/png;base64,${data}';
      });
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const w = ${x1} - ${x0};
      const d = g.getImageData(${x0}, 0, w, ${rows}).data;
      const ink = (y) => {
        let min = 255, max = 0;
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
          if (v < min) min = v;
          if (v > max) max = v;
        }
        return max - min > 10;
      };
      let y = 0;
      while (y < ${rows} && !ink(y)) y++;   // clear space above the header
      while (y < ${rows} && ink(y)) y++;    // the header line itself
      while (y < ${rows} && !ink(y)) y++;   // clear space below it
      return y;
    })()`);
  }

  /**
   * Frame the conversation so it does not open halfway through a line.
   *
   * A Session Detail frame is scrolled to the end of its session, so the top edge lands wherever the
   * content's own height puts it — and on some surfaces that is through the middle of a line of text
   * or a tool row, which photographs as a broken crop. It cannot be fixed by rewriting the fixture:
   * each surface has its own width, wrapping and viewport, so the same transcript opens cleanly on
   * one and cut on the next, and a change that fixes one moves the other.
   *
   * Where the clip is, is found by looking rather than asserted from memory: ink can never be
   * painted above it, so scrolling somewhere with a lot of content overhead and taking the smallest
   * first-ink row over a few positions IS the clip. After that the test is simply whether the frame
   * leaves clear space under it, and the fix is to scroll until it does.
   *
   * This frames the shot; it does not change what the shot is of. Nothing is hidden or revealed that
   * a reader could not scroll to themselves, the movement is a few pixels, and the frame still has
   * to pass its witness check afterwards. The nudge is capped, because a large one would push the
   * pending request off the bottom of the very frame that exists to show it.
   */
  async frameTranscriptTop(anchorText, { step = 4, margin = 4, maxNudge = 20 } = {}) {
    const { css, scale } = SURFACES[this.surface];
    const fields = await this.editors();
    if (!fields.length) throw new Error("no composer on screen, so the conversation pane cannot be located");
    const pane = fields.reduce((lowest, n) => (n.y + n.h > lowest.y + lowest.h ? n : lowest));
    const anchorY = async () => {
      const node = (await this.nodes()).find((n) => n.label.includes(anchorText));
      if (!node) throw new Error(`framing lost sight of ${JSON.stringify(anchorText)}`);
      return node.y;
    };
    // Flutter consumes a wheel delta at a fraction of its size, so ask for the multiple and measure
    // the result instead of assuming it. `WHEEL` is only a starting guess; the anchor decides.
    const WHEEL = 4;
    const wheel = async (dy) => {
      await this.cdp("Input.dispatchMouseEvent", {
        type: "mouseWheel", x: Math.round(pane.x + pane.w * 0.5), y: Math.round(css[1] * 0.5),
        deltaX: 0, deltaY: dy * WHEEL,
      });
      await sleep(400);
    };

    const framed = await (async () => {
    let clip = Infinity;
    const look = async () => {
      const ink = await this.firstTranscriptInk(pane);
      clip = Math.min(clip, ink);
      return ink;
    };
    // Calibrate against a part of the session with plenty above it, then come back to the end.
    for (let i = 0; i < 3; i++) await wheel(-600);
    for (let i = 0; i < 5; i++) {
      await look();
      await wheel(-7);
    }
    for (let i = 0; i < 8; i++) await wheel(600);
    await sleep(600);

    for (let moved = 0; ; ) {
      const ink = await look();
      if (process.env.COSYNCING_FRAME_DEBUG) {
        console.log(`  · framing: ink ${ink}, clip ${clip}, moved ${moved}px`);
      }
      if (ink >= clip + margin * scale) {
        if (moved) console.log(`  · framed the conversation top by ${Math.round(moved)}px`);
        return moved;
      }
      if (moved >= maxNudge) {
        throw new Error(`the conversation opens mid-line and ${maxNudge}px of framing did not clear it`);
      }
      const before = await anchorY();
      await wheel(-step);
      const scrolled = (await anchorY()) - before;
      // Nothing moved: the conversation is shorter than its own pane, so it cannot be cut at all.
      if (scrolled < 0.5) return moved;
      moved += scrolled;
    }
    })();
    // Scrolling raises the scrollbar and leaves the pointer over the pane, and both are real UI that
    // a still frame has no reason to show. Move off it and let them fade before the shutter.
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
    await sleep(1600);
    return framed;
  }

  async scrollToTop() {
    const [w, h] = SURFACES[this.surface].css;
    for (let i = 0; i < 6; i++) {
      await this.cdp("Input.dispatchMouseEvent", {
        type: "mouseWheel", x: Math.round(w * 0.6), y: Math.round(h * 0.5), deltaX: 0, deltaY: -1200,
      });
      await sleep(220);
    }
    await sleep(700);
  }

  async surfaceFor(name, scheme) {
    this.surface = name;
    const { css, scale, layout } = SURFACES[name];
    await this.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    await this.cdp("Emulation.setDeviceMetricsOverride", {
      width: css[0], height: css[1], deviceScaleFactor: scale, mobile: layout === "narrow",
    });
    await sleep(800);
  }

  async goHome() {
    await this.load();
    await this.enrolDevice();
  }

  /** Load the app from scratch and wait until it has painted and published semantics. */
  async load() {
    const loaded = new Promise((r) => loadWaiters.set(this.sessionId, r));
    await this.cdp("Page.navigate", { url: BASE });
    await Promise.race([loaded, sleep(20000)]);
    // CanvasKit falls back to CPU rasterization in the headless shell; capturing before it paints
    // yields a blank canvas.
    await sleep(5500);
    // Without semantics there is nothing to find, nothing to click, and nothing to check a frame
    // against — every later assertion would be vacuous rather than satisfied.
    if (!(await this.semantics())) {
      throw new Error("the app never published a semantics tree; it may not have painted at all");
    }
  }

  /**
   * Give this device the broker's credential, through the app's own "Connect this device" gate.
   *
   * Each frame runs in a fresh browser context, so each frame meets the gate once — the same thing a
   * user does the first time they point a new device at their broker. It is not a detour around the
   * product: the token goes into the app's secure storage through the app's form, and every request
   * after it is the app's own authenticated request.
   *
   * Silently returns when there is no gate on screen, which is what a reload inside one frame sees.
   */
  async enrolDevice() {
    if (!(await this.find(label.saveToken, { role: "button" }))) return false;
    const field = (await this.waitForEditors()).find((n) => n.label.includes(label.brokerToken));
    if (!field) {
      throw new Error(`the broker gate is up but no field labelled ${JSON.stringify(label.brokerToken)} is on screen`);
    }
    await this.focusEditor(field);
    await this.cdp("Input.insertText", { text: BROKER_TOKEN });
    await this.click(label.saveToken, { settle: 2500, role: "button" });
    // Wait for the GATE to go, not for the roster: a wide surface opens with the rail collapsed, so
    // "the roster is on screen" is not yet true at this point and never becomes true by waiting.
    for (const deadline = Date.now() + 30_000; ;) {
      if (!(await this.find(label.saveToken, { role: "button" }))) break;
      if (Date.now() >= deadline) throw new Error("the broker gate stayed up after the fixture token was saved");
      await sleep(700);
    }
    // Then boot the app again, with the credential already in hand. Its first reads happened before
    // there was a token to send: the roster recovers on its own, but the attention inbox kept the
    // 401 it got and showed "Nothing needs your attention" over four live notifications.
    await this.load();
    return true;
  }

  /**
   * On a wide layout the roster rail starts collapsed to an icon strip; every wide frame needs it
   * open.
   *
   * Driven by the expand control's own accessible label rather than by a corner coordinate. A
   * coordinate cannot tell "the rail is collapsed" from "the rail has not painted yet", so a click
   * that arrived early hit nothing — and a retry that could not tell either would sometimes toggle
   * the rail shut again. The button only exists while the rail is closed, which makes it both the
   * target and the test.
   */
  async expandRail() {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const collapsed = await this.find(label.showSessions, { role: "button" });
      if (collapsed) {
        await this.click({ x: collapsed.x + collapsed.w / 2, y: collapsed.y + collapsed.h / 2 }, { settle: 1500 });
      }
      // Generous on purpose. These frames pass six times out of six on an idle machine and failed
      // twice an hour into a loaded one: the app simply took longer to paint than the budget
      // allowed. Waiting longer costs nothing when nothing is wrong, and a whole run when it is.
      if (await this.waitFor(ROSTER_WITNESS, { timeout: 25_000 })) return;
    }
    // Say what WAS on screen. "It did not open" is a symptom; the label list is the evidence, and
    // without it every recurrence costs another full run to reproduce.
    const seen = (await this.nodes()).slice(0, 14).map((n) => `${n.role}:${n.label.slice(0, 40)}`);
    throw new Error(
      `the roster rail did not open; every wide frame needs it expanded. On screen: ${seen.join(" | ") || "(nothing)"}`,
    );
  }

  async shot(name, witness) {
    if (!(await this.waitForVisible(witness))) {
      const wanted = (Array.isArray(witness) ? witness : [witness]).map((w) => JSON.stringify(w)).join(" or ");
      throw new Error(`nothing matching ${wanted} is on screen; refusing to save ${name}.png`);
    }
    const { data } = await this.cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const buf = Buffer.from(data, "base64");
    await writeFile(join(OUT, `${name}.png`), buf);
    console.log(`  ${name}.png  ${(buf.length / 1024).toFixed(0)} KiB`);
  }
}

const PROBE = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('flt-semantics, flt-semantics *, input, textarea')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const label = el.getAttribute('aria-label') || el.getAttribute('placeholder')
      || (el.children.length === 0 ? (el.textContent || '').trim() : '');
    if (!label) continue;
    out.push({ label: label.slice(0, 200), role: el.getAttribute('role') || el.tagName.toLowerCase(),
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
  }
  return out;
})()`;

// ── the six-frame story ─────────────────────────────────────────────────────────
// Order and intent follow the core story sequence in doc 14.
// Each returns the witness its frame must show, in the viewport, at the moment of capture.
// Witnesses are fixture text, never chrome: chrome is localized, and a witness that only exists in
// English silently fails the Chinese set — which is exactly how the first localized run lost its
// notifications frame.
const FRAMES = {
  // 1 — populated Sessions roster.
  roster: async (page, layout) => {
    await page.goHome();
    if (layout === "wide") await page.expandRail();
    await sleep(1200);
    return ROSTER_WITNESS;
  },

  // 2 — the attention inbox.
  notifications: async (page) => {
    await page.goHome();
    await page.click(label.notifications, { settle: 2500, role: "tab" });
    // Summaries are fixture text rendered verbatim; the card's headline is composed and localized.
    // ALL of them are offered as the witness, not the first one: which card a short inbox pane
    // renders depends on the pane, and checking only the first two failed a frame that was in fact
    // showing a perfectly good third.
    return manifest.attention.map((event) => event.summary);
  },

  // 3 — Session Detail with a permission request: doc 14's "Read, steer, and approve", and the one
  // frame that cannot be assembled out of transcript alone. A permission request is not transcript
  // data — the CLI raises it mid-turn on its control channel and blocks until the answer comes
  // back — so this frame reads the session, takes it over, steers it with one prompt, and
  // photographs the request that comes back while it is still pending.
  detail: async (page, layout) => {
    const open = async () => {
      await page.goHome();
      if (layout === "wide") await page.expandRail();
      await page.openSession("Move the session store", "bun test src/auth", { layout });
      await page.ensureDriving();
    };
    const pending = (timeout) => page.waitFor(manifest.live.command, { timeout });
    await open();
    // A pending request replays to every later tab, so only the first of these frames has any work
    // to do. The others must NOT prompt again: the fixture raises one request per session, and a
    // second prompt would stack an unanswered turn under the first in every frame after it.
    if (!(await pending(6_000))) {
      await page.sendPrompt(manifest.live.prompt);
      if (!(await pending(45_000))) {
        throw new Error(
          `the driven turn never asked to run ${JSON.stringify(manifest.live.command)} — ` +
            "without a pending request this frame has no approval in it",
        );
      }
      // Reopen, so this frame is the same view as the three that follow it. The tab that STARTS a
      // turn also carries that turn's own launch event and prompt echo; a tab that opens the
      // session afterwards — which is how anyone actually meets a waiting request — carries
      // neither. Without this, one frame in four had an "Event: init" card in it.
      await open();
    }
    if (!(await pending(45_000))) {
      throw new Error("the pending request did not replay into this frame");
    }
    // Last, because it depends on the transcript being final: the request card is the tallest thing
    // in it, and framing before it arrives would frame a different picture.
    await page.frameTranscriptTop(manifest.live.command);
    return manifest.live.command;
  },

  // 4 — an agent-sent file artifact in its session.
  artifact: async (page, layout) => {
    await page.goHome();
    if (layout === "wide") await page.expandRail();
    // Short witness on purpose: the artifact card ellipsizes its filename at the narrowest frame
    // width, so the full name is not a reliable probe.
    await page.openSession("Backfill tenant ids", "tenant-backfill", { layout });
    // Scrolling moves the subject, so the witness is re-checked after it — by shot(), against this
    // returned value, in the viewport.
    await page.scrollToTop();
    return "tenant-backfill";
  },

  // 5 — connection and pairing: the broker this device talks to. The Connection tab, not
  // Settings → Broker & devices: that screen leads with an empty broker-token field, which reads
  // like a credential prompt in a store listing rather than "you are talking to your own machine".
  //
  // The form is actually driven, because an untouched Connection tab reads "Not connected" under a
  // headline that says "Pair with your own broker." — and the field's default address is NOT the
  // fixture. Connecting blind would point the frame at whatever broker happens to answer there, so
  // the address is typed and the resulting machine name is checked against the fixture's.
  connection: async (page) => {
    await page.goHome();
    await page.click(label.connection, { settle: 3000, role: "tab" });
    await page.typeIntoField(BROKER_ORIGIN);
    await page.click(label.connect, { settle: 1500, role: "button" });
    if (!(await page.waitFor(manifest.machine))) {
      throw new Error(
        `connected, but ${JSON.stringify(manifest.machine)} never appeared — this frame may be ` +
          "showing a broker that is not the fixture",
      );
    }
    await sleep(1200);
    return manifest.machine;
  },

  // 6 — the wide two-pane workspace: roster and conversation at once. The diff and the test run are
  // expanded because a wide conversation pane is over a thousand logical pixels tall, and a
  // transcript of collapsed one-line rows leaves most of a store frame empty.
  workspace: async (page, layout) => {
    await page.goHome();
    if (layout === "wide") await page.expandRail();
    await page.openSession("Per-tenant rate limiting", "bun test src/plans", { layout });
    await page.expandIfVisible("Edited handler.ts");
    await page.expandIfVisible("bun test src/ingest");
    return "bun test src/plans";
  },
};

// Which frame is captured on which surface, in which scheme. Doc 14 requires at least one dark
// image in the Apple set, at least four Google phone captures, and both narrow and wide overall.
//
// The four `detail` frames run LAST, together, and that ordering is load-bearing: the approval
// warm-up below leaves the session driven, with a live turn open and a request pending. Every frame
// before them therefore sees the fixture exactly as it was seeded, and all four of them see the same
// pending request rather than one each.
const PLAN = [
  ["apple-iphone", "roster", "light"],
  ["apple-iphone", "notifications", "light"],
  ["apple-iphone", "artifact", "light"],
  ["apple-iphone", "connection", "dark"],
  ["apple-ipad", "workspace", "light"],
  ["apple-mac", "workspace", "dark"],
  ["play-phone", "roster", "light"],
  ["play-phone", "notifications", "light"],
  ["play-phone", "artifact", "light"],
  ["play-tablet", "workspace", "light"],
  ["ms-desktop", "workspace", "light"],
  ["pwa-wide", "workspace", "light"],
  ["pwa-narrow", "roster", "light"],
  ["apple-iphone", "detail", "dark"],
  // Detail, not roster, on the wide surfaces. A wide layout renders the roster as a rail beside a
  // detail pane, so a frame with nothing open is 70–80% "Select a session to open it here." — the
  // roster beat is carried by the phone frames, and these two carry the rail anyway.
  ["apple-mac", "detail", "light"],
  ["play-phone", "detail", "dark"],
  ["ms-desktop", "detail", "dark"],
];

// The fixture's isolation has to hold for the whole capture, not just at the moment it was proven.
// OpenCode discovers over HTTP, so a server appearing on the "dead" port mid-run would quietly
// start contributing real sessions to later frames.
const assertOpencodeDead = async () => {
  const reachable = await fetch(`${env.OPENCODE_URL}/`, { signal: AbortSignal.timeout(1_500) })
    .then(() => true, () => false);
  if (reachable) {
    throw new Error(`${env.OPENCODE_URL} answered mid-run — a real OpenCode server can now reach the fixture`);
  }
};

const selected = PLAN.filter(([surface, frame, scheme]) => !ONLY || `${surface}-${frame}-${scheme}`.includes(ONLY));
let failures = 0;

/**
 * Raise the approval in a page that is never photographed, before any detail frame is.
 *
 * The tab that STARTS a turn sees more of it than one that arrives later: the broker keeps a replay
 * ring of live frames for whoever joins mid-turn, and that ring still holds the turn's launch event
 * and prompt echo until a resync clears it — which is what a later attach ends up doing. So the
 * first detail frame carried an "Event: init" card the other three did not, purely because it was
 * the one that pressed send.
 *
 * Driving here makes every real frame a late joiner, which is also the ordinary way anyone meets a
 * waiting request: you open the session because something is asking you. Nothing is suppressed — the
 * launch event is still in the session's own history — and nothing is saved from this page.
 */
let warmUpFailed = false;
try {
  if (selected.some(([, frame]) => frame === "detail")) {
    process.stdout.write("raising the approval (warm-up; nothing is saved)\n");
    const page = await Page.open();
    try {
      await page.surfaceFor("apple-mac", "light");
      await FRAMES.detail(page, "wide");
    } catch (error) {
      warmUpFailed = true;
      console.error(`  FAILED: ${error.message}`);
    } finally {
      await page.close();
    }
  }
  for (const [surface, frame, scheme] of selected) {
    const name = `${surface}-${frame}-${scheme}`;
    const { css, scale, layout } = SURFACES[surface];
    process.stdout.write(`${name} (${css[0] * scale}×${css[1] * scale})\n`);
    // One retry, and only one. A frame whose first cold load loses its connection to the broker is
    // a transient — the last frame of a run has failed on the connect screen once — and discarding
    // thirty-three good frames for it costs an hour. A retry cannot turn a wrong frame into a right
    // one: the witness still has to be on screen, in the viewport, before the shutter fires.
    for (let attempt = 1; attempt <= 2; attempt++) {
      let page = null;
      let failure = null;
      let seen = [];
      try {
        await assertOpencodeDead();
        page = await Page.open();
        await page.surfaceFor(surface, scheme);
        const witness = await FRAMES[frame](page, layout);
        await page.shot(name, witness);
      } catch (error) {
        failure = error;
        // What the app was actually showing. A frame that fails an hour into a run is expensive to
        // reproduce; the label list is usually enough to see which screen it was stuck on.
        seen = page ? await page.nodes().catch(() => []) : [];
      } finally {
        if (page) await page.close();
      }
      if (!failure) break;
      if (attempt === 1) {
        console.error(`  retrying once after: ${failure.message}`);
        await sleep(5000);
        continue;
      }
      failures++;
      console.error(`  FAILED: ${failure.message}`);
      if (seen.length) {
        console.error(`  on screen: ${seen.slice(0, 14).map((n) => `${n.role}:${n.label.split("\n")[0].slice(0, 44)}`).join(" | ")}`);
      }
    }
  }
} finally {
  // Awaited, and the socket closed, so the browser is gone and its profile removed before this
  // process ends — including when something above threw. `process.exit()` here would kill both
  // mid-flight.
  await shutdown();
}
console.log(`\n${selected.length - failures}/${selected.length} captures written to ${OUT}`);
if (warmUpFailed) console.error("the approval warm-up failed, so the detail frames drove themselves");
if (failures || warmUpFailed) {
  console.error("campaign incomplete — nothing may be published from this run");
  process.exitCode = 1;
}
