#!/usr/bin/env node
// Throttled built-app verifier for the credential-gate session lifecycle race.
//
// Drives the RELEASE Flutter web build served by a real broker from this repo,
// under 4x CPU throttling, through: anonymous session attach -> broker begins
// requiring a token -> unauthorized barrier -> save token in the gate UI ->
// gate refresh remount. Verdict criteria, observed at the CDP Network layer:
//   1. exactly ONE post-save session /stream WebSocket carries the saved
//      token, targets the fixture session, completed a 101 handshake, and is
//      still open at judgement — extra token sockets, even closed ones, fail
//   2. zero post-save session /stream WebSockets without the saved token
//   3. zero anonymous session sockets remain open at judgement
//
// Isolation: the broker runs with a synthetic HOME (plus explicit
// CLAUDE_CONFIG_DIR / CODEX_HOME / COSYNCING_CACHE_DIR overrides), so it can
// discover no real transcript stores. The only session is a synthetic Pi
// bridge fixture created through POST /pi/bridge/hello — the same mechanism
// the hosted release verifier (scripts/broker/release/verify-candidate-pair.ts)
// uses — whose id is deterministic in the session file path, so re-issuing
// the hello after the phase-B restart restores the identical session id.
// The roster must contain exactly that fixture in both phases; this doubles
// as the proof that the process answering on the leased port is THIS run's
// broker child and not an unrelated cosyncing instance.
//
// Ports: the broker port is an ephemeral kernel-assigned port protected by
// the same atomic lease-directory protocol the release verifier uses; the
// lease is held for the whole run because phase B must reuse the exact port
// (it is the loaded page's origin). The browser publishes its own CDP port
// through DevToolsActivePort. Health acceptance always requires the spawned
// child to still be alive (with a post-ready grace re-check for the
// close-before-bind race).
//
// Browser bootstrap cribbed from scripts/dev/ui-drive.mjs (chrome-headless-
// shell over raw CDP is the only reliable path on this WSL2 machine).

import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const OUT = join(REPO, "output/credential-gate-verifier");
const RUN = join(OUT, "run");
const BROKER_HOME = join(RUN, "broker-home");
const HOST_HOME = join(RUN, "host-home");
const FIXTURE_DIR = join(RUN, "fixture");
const BROWSER_PROFILE = join(RUN, "browser-profile");
const TOKEN = "fresh-token-e2e";
const PI_INTEGRATION_TOKEN = "pi-integration-e2e";
const FIXTURE_NONCE = `credential-gate-fixture-${process.pid.toString(36)}`;
const FIXTURE_SESSION_FILE = join(FIXTURE_DIR, `${FIXTURE_NONCE}.jsonl`);
const CPU_THROTTLE = 4;

await rm(RUN, { recursive: true, force: true });
for (const dir of [
  RUN, BROKER_HOME, FIXTURE_DIR, BROWSER_PROFILE,
  join(HOST_HOME, ".claude"), join(HOST_HOME, ".codex"),
  join(HOST_HOME, ".cache"), join(HOST_HOME, "bin"),
]) {
  await mkdir(dir, { recursive: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- leased loopback port (release-verifier protocol) ----------
// The kernel picks the port while the probe socket is bound; the atomic lease
// directory (shared with verify-candidate-pair.ts) closes the gap between
// releasing the probe and the broker binding, and stays held all run because
// phase B must rebind the same port.
const LEASE_ROOT = join(tmpdir(), "cosyncing-candidate-port-leases");
async function reserveLoopbackPort() {
  await mkdir(LEASE_ROOT, { recursive: true });
  for (let attempt = 0; attempt < 64; attempt++) {
    const server = createServer();
    const port = await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
    const leasePath = join(LEASE_ROOT, String(port));
    let leased = true;
    try {
      await mkdir(leasePath);
    } catch {
      leased = false;
    }
    await new Promise((resolve) => server.close(resolve));
    if (leased) {
      return {
        port,
        release: () => rm(leasePath, { recursive: true, force: true }).catch(() => {}),
      };
    }
  }
  throw new Error("could not reserve an ephemeral loopback port");
}

// The lease, the browser, and the CDP socket are all acquired INSIDE the
// verdict's try/finally below, so a failure at any bootstrap step still
// releases the lease and kills the browser.
let portLease = null;
let PORT = null;
let ORIGIN = null;
let BASE = null;

// ---------- broker lifecycle ----------
let broker = null; // { child, exited, label }

function spawnBroker({ token, label }) {
  const env = {
    ...process.env,
    // Synthetic identity: no real transcript store, wrapper dir, codex home,
    // or cache is reachable from this process.
    HOME: HOST_HOME,
    CLAUDE_CONFIG_DIR: join(HOST_HOME, ".claude"),
    CODEX_HOME: join(HOST_HOME, ".codex"),
    COSYNCING_CLAUDE_WRAPPER_DIR: join(HOST_HOME, "bin"),
    COSYNCING_HOME: BROKER_HOME,
    COSYNCING_CACHE_DIR: join(HOST_HOME, ".cache", "cosyncing"),
    COSYNCING_WEB_DIR: join(REPO, "apps/client/build/web"),
    PORT: String(PORT),
    HOST: "127.0.0.1",
    COSYNCING_CLAUDE_HOOKS: "0",
    COSYNCING_OPENCODE_NO_AUTOSERVE: "1",
    // Without this the adapter reads the host's LIVE `opencode serve` on the
    // default :4096 and its real sessions flood the roster.
    OPENCODE_URL: "http://127.0.0.1:1",
    COSYNCING_RESTART_DRY_RUN: "1",
    COSYNCING_CODEX_SYNC_SERVER: "0",
    COSYNCING_TOKDASH_URL: "http://127.0.0.1:1",
    COSYNCING_PI_INTEGRATION_TOKEN: PI_INTEGRATION_TOKEN,
  };
  if (token) env.COSYNCING_TOKEN = token;
  const log = openSync(join(RUN, `broker-${label}.log`), "a");
  const child = spawn(
    "bun",
    ["run", join(REPO, "packages/typescript/broker/src/main.ts")],
    { env, stdio: ["ignore", log, log] },
  );
  // Registered at spawn so a stop can never miss an exit that already
  // happened (the old stop registered its listener after SIGKILL and could
  // wait forever on an already-dead child).
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, label };
}

function brokerAlive() {
  return broker !== null
    && broker.child.exitCode === null
    && broker.child.signalCode === null;
}

async function brokerLogTail(label) {
  try {
    const text = await readFile(join(RUN, `broker-${label}.log`), "utf8");
    return text.slice(-800);
  } catch {
    return "";
  }
}

async function startBroker({ token, label }) {
  broker = spawnBroker({ token, label });
  let healthy = false;
  for (let i = 0; i < 120 && !healthy; i++) {
    if (broker.child.exitCode !== null) break;
    try {
      healthy = (await fetch(`${ORIGIN}/api/health`)).ok;
    } catch {}
    if (!healthy) await sleep(250);
  }
  if (healthy) {
    // A process that wins a close-before-bind race can answer health briefly
    // while the child is still discovering EADDRINUSE.
    await sleep(150);
    if (broker.child.exitCode !== null) healthy = false;
  }
  if (!healthy) {
    const tail = await brokerLogTail(label);
    await stopBroker();
    throw new Error(
      `broker ${label} did not become healthy on leased port ${PORT}`
      + (tail ? `: ${tail}` : ""),
    );
  }
  console.log(`[verify] broker ${label} healthy on ${PORT} (pid ${broker.child.pid})`);
}

async function stopBroker() {
  if (!broker) return;
  const handle = broker;
  broker = null;
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    handle.child.kill("SIGTERM");
    const timely = await Promise.race([
      handle.exited.then(() => true),
      sleep(5000).then(() => false),
    ]);
    if (!timely) {
      handle.child.kill("SIGKILL");
      await handle.exited;
    }
  }
  const outcome = await handle.exited;
  console.log(
    `[verify] broker ${handle.label} stopped (exit=${outcome.code ?? outcome.signal})`,
  );
  await sleep(300);
}

// ---------- synthetic fixture (the run's only session, and its identity) ----------
async function registerFixture() {
  const response = await fetch(`${ORIGIN}/pi/bridge/hello`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cosyncing-integration-token": PI_INTEGRATION_TOKEN,
    },
    body: JSON.stringify({
      sessionFile: FIXTURE_SESSION_FILE,
      cwd: FIXTURE_DIR,
      title: FIXTURE_NONCE,
      history: [],
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.id !== "string") {
    throw new Error(`fixture hello failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.id;
}

/// The roster must be exactly [the fixture]. Anything else means either host
/// data leaked into the synthetic HOME (isolation failure) or the process
/// answering on the port is not this run's broker (identity failure).
async function assertRosterIsExactlyFixture(fixtureId, where) {
  const response = await fetch(`${ORIGIN}/api/sessions`);
  if (!response.ok) throw new Error(`${where}: roster fetch failed (${response.status})`);
  const body = await response.json();
  const list = Array.isArray(body) ? body : body.sessions;
  if (!Array.isArray(list)) throw new Error(`${where}: roster shape unexpected`);
  const ids = list.map((s) => `${s.tool}/${s.id}`);
  if (list.length !== 1 || list[0].tool !== "pi" || list[0].id !== fixtureId
      || list[0].title !== FIXTURE_NONCE) {
    throw new Error(
      `${where}: roster is not exactly the synthetic fixture — got [${ids.join(", ")}]`,
    );
  }
}

// ---------- browser over raw CDP ----------
function chromeHeadlessShellPath(shellDirs) {
  const configured = process.env.CHROME_BIN?.trim();
  if (configured && existsSync(configured)) return configured;
  const shells = shellDirs
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .map((d) => ({ dir: d, rev: Number(d.split("-")[1]) }))
    .sort((a, b) => b.rev - a.rev);
  if (!shells.length) throw new Error("no chrome-headless-shell in the playwright cache");
  return join(
    CACHE, shells[0].dir, "chrome-headless-shell-linux64/chrome-headless-shell",
  );
}
const CACHE = join(process.env.HOME, ".cache/ms-playwright");
let browserProc = null;
let ws = null;

/// Spawns the browser and connects the CDP socket. Runs inside the verdict's
/// cleanup boundary; every failure throws so the finally below can release
/// what was already acquired.
async function connectBrowser() {
  const BROWSER = chromeHeadlessShellPath(await readdir(CACHE));
  browserProc = spawn(BROWSER, [
    "--no-sandbox", "--disable-gpu", "--disable-software-rasterizer",
    "--disable-features=Vulkan,VizDisplayCompositor", "--disable-dev-shm-usage",
    "--headless", "--remote-debugging-port=0", "--remote-allow-origins=*",
    `--user-data-dir=${BROWSER_PROFILE}`,
    "--window-size=800,900", "about:blank",
  ], { stdio: "ignore" });

  // The browser publishes its kernel-assigned CDP port itself; no fixed port,
  // no possibility of talking to someone else's DevTools endpoint.
  let cdpPort = null;
  const activePortPath = join(BROWSER_PROFILE, "DevToolsActivePort");
  for (let i = 0; i < 100 && cdpPort === null; i++) {
    if (browserProc.exitCode !== null) break;
    try {
      const first = (await readFile(activePortPath, "utf8")).split(/\r?\n/, 1)[0];
      const candidate = Number(first);
      if (Number.isSafeInteger(candidate) && candidate > 0) cdpPort = candidate;
    } catch {}
    if (cdpPort === null) await sleep(150);
  }
  if (cdpPort === null) throw new Error("browser never published its CDP port");
  const endpoint = `http://127.0.0.1:${cdpPort}`;
  let cdpReady = false;
  for (let i = 0; i < 60 && !cdpReady; i++) {
    if (browserProc.exitCode !== null) break;
    try { cdpReady = (await fetch(`${endpoint}/json/version`)).ok; }
    catch { await sleep(200); }
  }
  if (!cdpReady) throw new Error("browser CDP endpoint never answered");
  const target = await (await fetch(`${endpoint}/json/new?about:blank`, { method: "PUT" })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("CDP socket open timed out")), 10000,
    );
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("CDP socket failed to open"));
    });
  });
  ws.addEventListener("message", onCdpMessage);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
}

let msgId = 0;
const pending = new Map();
let resolveLoad = () => {};

// Every session-stream WebSocket the page ever opens, in creation order.
// `open` is DERIVED: a socket is open only if its handshake completed with
// exactly HTTP 101 and no close/error has been seen since.
const sockets = [];
const socketsById = new Map();
const socketOpen = (s) => s.handshakeStatus === 101 && !s.closed;

function onCdpMessage(ev) {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
  if (msg.method === "Page.loadEventFired") resolveLoad();
  if (msg.method === "Network.webSocketCreated") {
    const { requestId, url } = msg.params;
    if (!url.includes("/api/sessions/") || !url.includes("/stream")) return;
    const u = new URL(url);
    const entry = {
      url,
      pathname: u.pathname,
      hasToken: u.searchParams.has("token"),
      token: u.searchParams.get("token"),
      handshakeStatus: null,
      closed: false,
      at: Date.now(),
    };
    sockets.push(entry);
    socketsById.set(requestId, entry);
  }
  if (msg.method === "Network.webSocketHandshakeResponseReceived") {
    const entry = socketsById.get(msg.params.requestId);
    if (entry) entry.handshakeStatus = msg.params.response?.status ?? null;
  }
  if (msg.method === "Network.webSocketClosed" || msg.method === "Network.webSocketFrameError") {
    const entry = socketsById.get(msg.params.requestId);
    if (entry) entry.closed = true;
  }
}

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? "evaluate failed");
  return result.value;
};

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
    out.push({ label: label.slice(0, 200), role: el.getAttribute('role') || el.tagName.toLowerCase(),
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
  }
  return out;
})()`;

const nodes = () => evaluate(PROBE);
async function find(text) {
  const all = await nodes();
  const needle = String(text).toLowerCase();
  const matches = all.filter((n) => n.label.toLowerCase().includes(needle));
  if (!matches.length) return null;
  const rank = (n) => n.label.toLowerCase() === needle ? 0 : (n.role !== "group" ? 1 : 2);
  matches.sort((a, b) => rank(a) - rank(b) || a.label.length - b.label.length || a.w * a.h - b.w * b.h);
  return matches[0];
}
async function click(node) {
  const x = Math.round(node.x + node.w / 2);
  const y = Math.round(node.y + node.h / 2);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
  await sleep(1200);
}
async function waitFor(label, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const node = await find(label);
    if (node) return node;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what ?? label}`);
}
async function goto(url) {
  const loaded = new Promise((r) => { resolveLoad = r; });
  await send("Page.navigate", { url });
  await Promise.race([loaded, sleep(30000)]);
  await sleep(8000); // CanvasKit CPU rasterization warmup
}
// Page.navigate to the already-current hash URL is a same-document
// navigation: the app never reboots and the gate never re-evaluates. Phase B
// needs a REAL reload so the boot-time gate probe runs against the
// token-requiring broker.
async function reload() {
  const loaded = new Promise((r) => { resolveLoad = r; });
  await send("Page.reload", { ignoreCache: false });
  await Promise.race([loaded, sleep(30000)]);
  await sleep(8000);
}
async function a11y() {
  await evaluate(`(() => {
    const p = document.querySelector('flt-semantics-placeholder')
      || document.querySelector('[aria-label="Enable accessibility"]');
    if (p) {
      const r = p.getBoundingClientRect();
      p.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        clientX: Math.floor(r.left + (r.right - r.left) / 2),
        clientY: Math.floor(r.top + (r.bottom - r.top) / 2),
      }));
      return true;
    }
    return false;
  })()`);
  await sleep(2000);
}
async function shot(name) {
  try {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(RUN, `${name}.png`), Buffer.from(data, "base64"));
  } catch {}
}
async function checkpoint(name) {
  let health = null;
  try { health = (await fetch(`${ORIGIN}/api/health`)).status; } catch { health = "unreachable"; }
  console.log(`[verify] checkpoint ${name}: brokerAlive=${brokerAlive()} health=${health}`);
}

const verdict = { pass: false, port: null, fixture: FIXTURE_NONCE, phases: {} };
const summarize = (list) => list.map((s) => ({
  open: socketOpen(s),
  closed: s.closed,
  handshakeStatus: s.handshakeStatus,
  hasToken: s.hasToken,
  token: s.token ? (s.token === TOKEN ? "SAVED_TOKEN" : "OTHER") : null,
  pathname: s.pathname,
}));

try {
  // ---- Bootstrap: everything acquired from here on is released by the
  // finally below, whichever step fails.
  portLease = await reserveLoopbackPort();
  PORT = portLease.port;
  ORIGIN = `http://127.0.0.1:${PORT}`;
  BASE = `${ORIGIN}/cosy/`;
  verdict.port = PORT;
  console.log(`[verify] leased broker port ${PORT}`);
  await connectBrowser();

  // ---- Phase A: anonymous broker; the app deep-links straight into the
  // synthetic fixture session and attaches without a token.
  console.log("[verify] phase A: anonymous broker + synthetic fixture");
  await startBroker({ token: null, label: "a" });
  const fixtureId = await registerFixture();
  await assertRosterIsExactlyFixture(fixtureId, "phase A");
  const expectedPath = `/api/sessions/pi/${encodeURIComponent(fixtureId)}/stream`;
  const onFixturePath = (s) =>
    s.pathname === expectedPath
    || decodeURIComponent(s.pathname) === decodeURIComponent(expectedPath);
  const sessionUrl = `${BASE}#/sessions/pi/${encodeURIComponent(fixtureId)}`;
  console.log(`[verify] fixture ${fixtureId} registered; deep-linking`);

  await goto(sessionUrl);
  await a11y();
  await shot("a1-session");

  const anonDeadline = Date.now() + 60000;
  while (Date.now() < anonDeadline
      && !sockets.some((s) => socketOpen(s) && !s.hasToken && onFixturePath(s))) {
    await sleep(500);
  }
  const anonymousAttach = sockets.find((s) => socketOpen(s) && !s.hasToken && onFixturePath(s));
  if (!anonymousAttach) {
    throw new Error(`phase A: no open anonymous socket on the fixture stream: ${JSON.stringify(summarize(sockets))}`);
  }
  if (sockets.some((s) => s.hasToken)) {
    throw new Error("phase A: a socket unexpectedly carried a token");
  }
  if (sockets.some((s) => !onFixturePath(s))) {
    throw new Error("phase A: a socket targeted a non-fixture session");
  }
  verdict.phases.anonymousAttach = { sockets: summarize(sockets) };
  console.log(`[verify] phase A ok: anonymous 101 attach on the fixture stream`);

  // ---- Phase B: same port, same COSYNCING_HOME, but the broker now
  // REQUIRES the token; the fixture is re-registered (same file -> same id)
  // and the page reloads under CPU throttle.
  console.log("[verify] phase B: broker requires a token; reloading under throttle");
  await stopBroker();
  await startBroker({ token: TOKEN, label: "b" });
  const fixtureIdB = await registerFixture();
  if (fixtureIdB !== fixtureId) {
    throw new Error(`fixture id changed across restart: ${fixtureId} -> ${fixtureIdB}`);
  }
  await assertRosterIsExactlyFixture(fixtureId, "phase B");
  const phaseBMark = sockets.length;
  await send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });

  await checkpoint("broker-b-up");
  await reload();
  await a11y();
  await shot("b1-after-reload");
  await waitFor("save token", 90000, "unauthorized barrier with token entry");
  await shot("b2-barrier");
  await checkpoint("b-barrier-visible");

  // ---- Save the token through the real gate UI.
  const field = await find("broker token")
    ?? (await nodes()).find((n) => n.role === "input" || n.role === "textbox");
  if (!field) throw new Error("no token input field found on the barrier");
  await click(field);
  await send("Input.insertText", { text: TOKEN });
  await sleep(800);
  const save = await find("save token");
  const saveMark = sockets.length;
  await click(save);
  console.log(`[verify] token saved via gate UI (pre-save sockets: ${saveMark})`);
  await checkpoint("b-after-save");

  // ---- Wait out the remount + handoff under throttle. The throttle's job is
  // to widen the retirement/remount window; once the first post-save socket
  // exists the race has been exercised, so drop back to full speed and let
  // the attach settle for the survivorship judgement.
  const firstPostSaveDeadline = Date.now() + 120000;
  while (Date.now() < firstPostSaveDeadline && sockets.length === saveMark) {
    await sleep(1000);
  }
  await send("Emulation.setCPUThrottlingRate", { rate: 1 });
  const judgeDeadline = Date.now() + 120000;
  while (Date.now() < judgeDeadline
      && !sockets.slice(saveMark).some((s) => socketOpen(s) && s.token === TOKEN)) {
    await sleep(2000);
  }
  await sleep(20000); // grace: let any anonymous reconnection or churn show itself
  await shot("b3-after-save");

  // ---- Judgement. Every requirement is encoded, not implied.
  const postSave = sockets.slice(saveMark);
  const postSaveSavedToken = postSave.filter((s) => s.token === TOKEN);
  const postSaveOtherToken = postSave.filter((s) => s.hasToken && s.token !== TOKEN);
  const postSaveAnonymous = postSave.filter((s) => !s.hasToken);
  const intended = postSaveSavedToken[0] ?? null;
  const openAnonymousAtJudge = sockets.filter((s) => socketOpen(s) && !s.hasToken);
  // The race's precondition, load-bearing in the verdict: this page lifetime
  // must have attempted at least one anonymous attach on the fixture stream
  // before the save (a pre-token resolver existed), and the token-requiring
  // broker must have refused every anonymous attempt — refusal means the
  // handshake never completed with 101, NOT merely that the socket has since
  // closed (a 101-then-closed socket was accepted).
  const phaseBPreSaveAnonymous = sockets
    .slice(phaseBMark, saveMark)
    .filter((s) => !s.hasToken);

  let healthAtJudge = null;
  try { healthAtJudge = (await fetch(`${ORIGIN}/api/health`)).status; }
  catch (error) { healthAtJudge = `unreachable: ${error.message}`; }
  let rosterIdentityAtJudge = true;
  try { await assertRosterIsExactlyFixture(fixtureId, "judge"); }
  catch { rosterIdentityAtJudge = false; }

  const requirements = {
    // finding-4 encoding: exactly one saved-token socket EVER created after
    // the save (closed extras are churn and fail), on the fixture path, with
    // a 101 handshake, still open at judgement.
    exactlyOnePostSaveTokenSocket: postSaveSavedToken.length === 1,
    intendedSocketOnFixturePath: intended !== null && onFixturePath(intended),
    intendedSocketHandshake101: intended !== null && intended.handshakeStatus === 101,
    intendedSocketStillOpen: intended !== null && !intended.closed,
    zeroPostSaveAnonymousSockets: postSaveAnonymous.length === 0,
    zeroPostSaveForeignTokenSockets: postSaveOtherToken.length === 0,
    zeroOpenAnonymousSocketsAtJudge: openAnonymousAtJudge.length === 0,
    phaseBAnonymousAttemptOnFixturePath:
      phaseBPreSaveAnonymous.some(onFixturePath),
    phaseBAnonymousAttemptsAllRefused:
      phaseBPreSaveAnonymous.every((s) => s.handshakeStatus !== 101),
    // finding-3 encoding: the endpoint that answered the judgement is this
    // run's child, alive, and still serving exactly the synthetic fixture.
    brokerChildAliveAtJudge: brokerAlive(),
    brokerHealthyAtJudge: healthAtJudge === 200,
    brokerServesFixtureRosterAtJudge: rosterIdentityAtJudge,
  };
  verdict.phases.postSave = {
    healthAtJudge,
    saveMark,
    postSaveCreated: postSave.length,
    phaseBPreSaveAnonymousAttempts: summarize(phaseBPreSaveAnonymous),
    sockets: summarize(sockets),
    requirements,
  };
  verdict.pass = Object.values(requirements).every(Boolean);
  if (!verdict.pass) {
    const failed = Object.entries(requirements)
      .filter(([, ok]) => !ok).map(([name]) => name);
    console.error(`[verify] FAILED requirements: ${failed.join(", ")}`);
  }
} catch (error) {
  verdict.error = String(error?.message ?? error);
} finally {
  console.log("VERDICT:" + JSON.stringify(verdict, null, 2));
  await writeFile(join(OUT, "verdict.json"), JSON.stringify(verdict, null, 2)).catch(() => {});
  await stopBroker().catch(() => {});
  browserProc?.kill();
  await portLease?.release();
  process.exit(verdict.pass ? 0 : 1);
}
