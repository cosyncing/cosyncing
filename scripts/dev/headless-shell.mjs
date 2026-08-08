// Launch a headless browser and connect to THAT browser, not to whatever answers a port.
//
// A predictable `--remote-debugging-port` is a shared name, not an identity: if the port is already
// taken when the shell starts, the bind loses and the script cheerfully drives someone else's
// browser — reading its pages and screenshotting them. So the shell is given a private profile
// directory and port 0, and the endpoint is read back from the `DevToolsActivePort` file the shell
// itself writes into that directory. A file only this process's browser can write, naming the port
// and the per-launch browser WebSocket path, is proof of ownership; a port number is not.
//
// Why chrome-headless-shell over CDP at all: WSL2 reports network namespaces as supported and then
// denies them, so a directly launched Chrome zygote dies with SIGILL. Same transport, and same
// reason, as scripts/dev/ui-drive.mjs.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @returns {Promise<{ browserWsUrl: string, close: () => Promise<void> }>}
 */
export async function launchHeadlessShell(extraArgs = []) {
  const cache = join(process.env.HOME, ".cache/ms-playwright");
  const shells = (await readdir(cache).catch(() => []))
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .map((d) => ({ dir: d, rev: Number(d.split("-")[1]) }))
    .sort((a, b) => b.rev - a.rev);
  if (!shells.length) {
    throw new Error("No chrome-headless-shell found. Run: npx playwright install chromium");
  }
  const binary = join(cache, shells[0].dir, "chrome-headless-shell-linux64/chrome-headless-shell");
  const profile = await mkdtemp(join(tmpdir(), "cosyncing-shot-"));

  const proc = spawn(binary, [
    "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--headless",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--remote-allow-origins=*", "--hide-scrollbars", "--force-device-scale-factor=1",
    ...extraArgs,
    "about:blank",
  ], { stdio: "ignore" });

  let exited = false;
  proc.on("exit", () => { exited = true; });
  const hasExited = new Promise((resolve) => proc.once("exit", resolve));

  const portFile = join(profile, "DevToolsActivePort");
  let browserWsUrl = null;
  for (let i = 0; i < 200 && !exited; i++) {
    const [port, path] = await readFile(portFile, "utf8").then((t) => t.trim().split("\n"), () => []);
    if (port && path?.startsWith("/devtools/")) {
      browserWsUrl = `ws://127.0.0.1:${port}${path}`;
      break;
    }
    await sleep(150);
  }
  if (!browserWsUrl) {
    proc.kill();
    await rm(profile, { recursive: true, force: true });
    throw new Error(`the headless shell never published a DevTools endpoint in ${profile}`);
  }

  let closed = false;
  /**
   * Stop the browser and take its profile with it.
   *
   * The wait is the point: removing the profile directory while the shell is still writing to it
   * leaves the directory behind, and callers that fire-and-forget this strand one profile per run
   * under the temp directory. Await it, then let the process exit on its own.
   */
  const close = async () => {
    if (closed) return;
    closed = true;
    proc.kill();
    const escalate = setTimeout(() => proc.kill("SIGKILL"), 5_000);
    await hasExited;
    clearTimeout(escalate);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  // Last-resort only: an exit handler cannot await, so it can stop the browser but not tidy up.
  process.on("exit", () => { if (!closed) { closed = true; proc.kill(); } });

  return { browserWsUrl, close };
}
