/**
 * Same-host detection of `opencode attach` TUIs joined to our shared serve — the missing "synced"
 * proof for the OpenCode badge (issues-part2 follow-up: "does not display the synced status when it
 * is completely in sync").
 *
 * Why /proc and not the server: opencode serve (verified on 1.17.18) exposes NO client-presence
 * surface — `server.connected` is only the per-subscriber SSE greeting, `/api/session/active` lists
 * running drains (busy sessions) not clients, `tui.*` bus events are server→TUI commands (a toast
 * POST echoes on the bus with zero TUIs attached), and a TUI exit emits nothing. The broker-managed
 * serve is same-host by design (remote serves already disable disk pairing), so the honest signal is
 * the operating system's: an attached TUI is an `opencode attach <our-url> -s <session>` process
 * holding the terminal. Process gone ⇒ terminal gone — kill -9 safe, no bye handshake to lose.
 *
 * Linux (incl. WSL2) only: on other platforms the scan returns empty, so the badge simply never
 * lights (under-claims, never over-claims). A TUI attached without `-s`/`--session` (bare attach,
 * `--continue`) is not attributable to a session id and is likewise ignored — under-claim by design.
 * A TUI that switches sessions IN-APP after attaching keeps its launch `-s` attribution: the terminal
 * is still a live client of the same shared owner, so "synced" remains true in the co-ownership sense.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

/** True when the serve URL is a local loopback endpoint we can pair with this machine's /proc. */
export function tuiPresenceSupported(baseUrl: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'linux') return false;
  try {
    return LOOPBACK.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** Parse one /proc cmdline (NUL-separated argv) into the session ids it attaches to our serve.
 *  Exported for tests. Returns [] unless the argv contains BOTH an `attach` verb and a URL token
 *  whose port matches the serve's (loopback hosts only — an attach to another machine's :4096 must
 *  not light our badge). Session id from `-s <id>` / `--session <id>` / `--session=<id>`. */
export function attachSessionIdsFromArgv(argv: string[], servePort: string): string[] {
  if (!argv.some((a) => a === 'attach')) return [];
  const urlMatch = argv.some((a) => {
    if (!/^https?:\/\//.test(a)) return false;
    try {
      const u = new URL(a);
      return (u.port || (u.protocol === 'https:' ? '443' : '80')) === servePort && LOOPBACK.has(u.hostname);
    } catch {
      return false;
    }
  });
  if (!urlMatch) return [];
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-s' || a === '--session') {
      const v = argv[i + 1];
      if (v && !v.startsWith('-')) ids.push(v);
    } else if (a.startsWith('--session=')) {
      const v = a.slice('--session='.length);
      if (v) ids.push(v);
    }
  }
  return ids;
}

/** Scan a /proc root for live `opencode attach` clients of the serve at `servePort`. Synchronous and
 *  cheap (argv reads for the handful of numeric pids whose cmdline mentions opencode); every read is
 *  fault-isolated so a process exiting mid-scan is just skipped. `procRoot` is injectable for tests. */
export function scanAttachedTuiSessions(servePort: string, procRoot = '/proc'): Set<string> {
  const out = new Set<string>();
  let pids: string[];
  try {
    pids = readdirSync(procRoot).filter((d) => /^\d+$/.test(d));
  } catch {
    return out;
  }
  for (const pid of pids) {
    let raw: string;
    try {
      raw = readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8');
    } catch {
      continue; // exited mid-scan / not ours
    }
    // Cheap pre-filter before argv parsing. Matches the binary regardless of install path; a shell
    // wrapper line (`sh -c "opencode attach …"`) parses to the same session id — Set dedupes it.
    if (!raw.includes('opencode')) continue;
    const argv = raw.split('\0').filter(Boolean);
    for (const id of attachSessionIdsFromArgv(argv, servePort)) out.add(id);
  }
  return out;
}

/** TTL-cached presence per serve port: discovery calls this once per roster row, so the scan must be
 *  amortized. 2s keeps badge flips near-live while bounding /proc traffic to one scan per window. */
const cache = new Map<string, { at: number; sessions: Set<string> }>();
export const TUI_PRESENCE_TTL_MS = 2_000;
/** Scan after the presence cache expires. */
export const TUI_PRESENCE_WATCH_MS = 2_500;

export function attachedTuiSessions(baseUrl: string, procRoot = '/proc'): Set<string> {
  if (!tuiPresenceSupported(baseUrl)) return new Set();
  let port = '';
  try {
    const u = new URL(baseUrl);
    port = u.port || (u.protocol === 'https:' ? '443' : '80');
  } catch {
    return new Set();
  }
  const key = `${port}\0${procRoot}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TUI_PRESENCE_TTL_MS) return hit.sessions;
  const sessions = scanAttachedTuiSessions(port, procRoot);
  cache.set(key, { at: now, sessions });
  return sessions;
}

/** Presence needs a same-host process table and a loopback service. */
export function v2TuiPresenceSupported(baseUrl: string): boolean {
  if (process.platform !== 'linux') return false;
  try { return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(baseUrl).hostname); }
  catch { return false; }
}

/** V2 joins the shared service directly; standalone processes belong to a different runtime. */
export function attachedV2TuiSessions(baseUrl: string, procRoot = '/proc'): Set<string> {
  if (!v2TuiPresenceSupported(baseUrl)) return new Set();
  const origin = new URL(baseUrl).origin;
  const key = `v2:${origin}\0${procRoot}`;
  const now = Date.now(), hit = cache.get(key);
  if (hit && now - hit.at < TUI_PRESENCE_TTL_MS) return hit.sessions;
  const sessions = new Set<string>();
  let pids: string[];
  try { pids = readdirSync(procRoot).filter((pid) => /^\d+$/.test(pid)); } catch { return sessions; }
  for (const pid of pids) {
    try {
      if (process.getuid && statSync(`${procRoot}/${pid}`).uid !== process.getuid()) continue;
      const argv = readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      const binary = argv.findIndex((arg, index) => index < 2 && basename(arg) === 'opencode');
      if (binary < 0) continue;
      const args = argv.slice(binary + 1);
      if (['attach', 'serve', 'service', 'run'].includes(args[0] ?? '') || args.some((arg) => /^--standalone(?:=|$)/.test(arg))) continue;
      let server: string | undefined;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--server') server = args[++i] ?? '';
        else if (args[i]!.startsWith('--server=')) server = args[i]!.slice(9);
      }
      if (server !== undefined && new URL(server).origin !== origin) continue;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        const id = arg === '-s' || arg === '--session' ? args[++i] : arg.startsWith('--session=') ? arg.slice(10) : undefined;
        if (id && !id.startsWith('-')) sessions.add(id);
      }
    } catch { /* The process exited, belongs to another uid, or has invalid arguments. */ }
  }
  cache.set(key, { at: now, sessions });
  return sessions;
}

/** Test hook: drop the TTL cache so a subsequent call re-scans immediately. */
export function resetTuiPresenceCache(): void {
  cache.clear();
}
