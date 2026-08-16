/**
 * Everything this package knows about reaching a Kimi Code server: where its
 * home, token, and instance registry live; which registry entries still describe
 * a live process; the GET-only HTTP door; and the identity gate every
 * server-consuming path must pass through.
 *
 * The read-only posture is enforced HERE, structurally rather than by review.
 * {@link KimiReadOnlyHttp} exposes exactly one operation — `getJson` — and it
 * hardcodes `method: 'GET'`. There is no verb parameter, no request-body
 * parameter, and no escape hatch that reaches the underlying fetch, so no caller
 * inside or outside this package can issue a POST/PUT/PATCH/DELETE through it.
 * That matters more here than in the other adapters: two processes writing one
 * Kimi session silently fork its journal, so a write path that merely "is not
 * called yet" would be one refactor away from corrupting a user's session.
 *
 * Writes live in ONE other file, `drive-http.ts`, and are allowlisted the same
 * structural way: {@link KimiDriveHttp} has no generic `post(path)` door either,
 * only a fixed set of named operations. It shares this file's bounded body
 * reader and envelope discipline rather than growing a second copy of them —
 * see {@link readBoundedBody} and {@link decodeKimiEnvelope}.
 */
import { closeSync, constants, fstatSync, opendirSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

// ── Home ────────────────────────────────────────────────────────────────────

/** Documented default listen port of `kimi web`. */
export const KIMI_DEFAULT_PORT = 58627;

/** Version this round's fixtures and mappings were captured against. */
export const KIMI_FIXTURE_VERSION = '0.35.0';

/**
 * `KIMI_CODE_HOME` overrides the default home for every derived path, so every
 * caller must derive from here rather than assuming `~/.kimi-code` — a spike or
 * an isolated review install is otherwise read against the user's real sessions.
 */
export function resolveKimiHome(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): string {
  const configured = env.KIMI_CODE_HOME?.trim();
  return configured || join(homeDir, '.kimi-code');
}

export function kimiServerTokenPath(home: string): string {
  return join(home, 'server.token');
}

export function kimiInstancesDirectory(home: string): string {
  return join(home, 'server', 'instances');
}

// ── Instance registry ───────────────────────────────────────────────────────

/** One `<home>/server/instances/<id>.json` record, as far as this adapter reads it. */
export interface KimiInstanceRecord {
  serverId: string;
  pid: number;
  host: string;
  port: number;
  startedAt?: number;
  heartbeatAt?: number;
  hostVersion?: string;
}

/**
 * Decode one instance record. Returns undefined for anything that is not a
 * complete, plausible record: the registry is written by another product and a
 * partially-written or future-shaped file must never become a base URL.
 */
export function decodeKimiInstanceRecord(raw: unknown): KimiInstanceRecord | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const serverId = record.server_id;
  const pid = record.pid;
  const host = record.host;
  const port = record.port;
  if (typeof serverId !== 'string' || !serverId) return undefined;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (typeof host !== 'string' || !host) return undefined;
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port <= 0 || port > 65535) return undefined;
  return {
    serverId,
    pid,
    host,
    port,
    ...(typeof record.started_at === 'number' ? { startedAt: record.started_at } : {}),
    ...(typeof record.heartbeat_at === 'number' ? { heartbeatAt: record.heartbeat_at } : {}),
    ...(typeof record.host_version === 'string' ? { hostVersion: record.host_version } : {}),
  };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Base URL for an instance record. Only loopback instances are addressed: this
 * round never talks to a Kimi server bound to a routable interface, because
 * nothing here has proven that server belongs to this user.
 */
export function kimiInstanceBaseUrl(record: KimiInstanceRecord): string | undefined {
  if (!isLoopbackHost(record.host)) return undefined;
  const host = record.host === '::1' ? '[::1]' : record.host;
  return `http://${host}:${record.port}`;
}

/** Is a recorded pid still a live process? A dead pid means a stale registry entry. */
export function pidIsLive(pid: number, kill: (pid: number, signal: number) => void): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user; that is still "live".
    return (error as { code?: string } | undefined)?.code === 'EPERM';
  }
}

/** One live loopback instance from the registry, with dead-pid entries filtered out. */
export interface KimiDiscoveredInstance {
  baseUrl: string;
  port: number;
  serverId: string;
  hostVersion?: string;
}

/**
 * The most registry files one scan will examine. A real host holds a handful
 * of records (one per `kimi web`, reaped lazily), so a registry with more than
 * this is anomalous — and since every examined file costs a read, a decode,
 * and a pid probe on the broker's discovery path, an unbounded directory must
 * never become unbounded work. Files beyond the cap are counted, not read.
 */
export const KIMI_INSTANCE_SCAN_MAX_FILES = 32;

export interface KimiInstanceScan {
  /** Registry entries whose pid is still live and whose host is loopback. */
  live: KimiDiscoveredInstance[];
  /** Entries filtered out because their pid is gone. */
  stale: number;
  /** Entries that were unreadable or structurally invalid. */
  invalid: number;
  /**
   * True when the registry holds more entries than the bounded scan examined.
   * An unexamined record may describe another LIVE server, so a truncated scan
   * can prove neither "no server" nor "exactly one" — {@link
   * resolveVerifiedInstance} refuses it outright rather than selecting a
   * server from a partial view.
   */
  truncated: boolean;
}

/** A bounded directory read: at most the requested entries, truncation reported. */
export interface KimiRegistryListing {
  names: string[];
  truncated: boolean;
}

export interface KimiInstanceScanIo {
  /** Must ITERATE boundedly (never materialize an unbounded directory) and report truncation. */
  listFiles(directory: string): KimiRegistryListing;
  /** Must enforce a byte ceiling of its own; an oversized record throws and is counted invalid. */
  readJson(path: string): unknown;
  /** Effect-free pid liveness probe (signal-0 semantics). See {@link pidIsLive}. */
  pidAlive(pid: number): boolean;
}

/**
 * Bounded directory iteration for the runtime scan: reads entries one at a
 * time via the directory handle and stops at the ceiling, so a directory with
 * a million entries costs the ceiling, not the directory. The entry that
 * would exceed the ceiling proves truncation.
 */
export function boundedDirectoryListing(directory: string, maxEntries: number): KimiRegistryListing {
  const dir = opendirSync(directory);
  const names: string[] = [];
  let truncated = false;
  try {
    for (;;) {
      const entry = dir.readSync();
      if (entry === null) break;
      if (names.length >= maxEntries) {
        truncated = true;
        break;
      }
      names.push(entry.name);
    }
  } finally {
    dir.closeSync();
  }
  return { names, truncated };
}

/**
 * Open a path for reading and PROVE on the opened descriptor that it is a
 * regular file. The caller owns the descriptor and must `closeSync` it; a
 * refusal closes it here, so no failure path leaks one.
 *
 * A byte ceiling bounds how much a file costs but says nothing about how long
 * opening one takes, and every reader in this package runs over paths another
 * product writes — the broker's discovery path, the diagnosis path, and the
 * wire-journal tail. So the hardening lives at the open, once, for all of them.
 */
export function openRegularFileSync(path: string): number {
  // O_NONBLOCK makes a FIFO open return instead of waiting for a writer, and
  // O_NOFOLLOW refuses a symlinked path outright. The fstat then runs on the
  // OPENED descriptor, so there is no gap between what was checked and what is
  // read. O_NONBLOCK has no effect on regular-file reads.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

/**
 * Read at most `maxBytes` of a file. Reads through a ceiling-sized buffer, so
 * an oversized file costs one bounded read and a thrown error — never a full
 * read followed by a length check.
 *
 * Accepts only a REGULAR, non-symlinked file; see {@link openRegularFileSync}.
 */
export function readBoundedText(path: string, maxBytes: number): string {
  const fd = openRegularFileSync(path);
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const bytesRead = readSync(fd, buffer, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) throw new Error('file exceeds the bounded read ceiling');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Read `<home>/server/instances/`, keeping only records that describe a live
 * loopback process. A dead pid is a stale record — Kimi leaves those behind and
 * removes them lazily, so treating one as a reachable server would point the
 * adapter at a port somebody else may now own.
 *
 * Bounded: file names are sorted for determinism and at most
 * {@link KIMI_INSTANCE_SCAN_MAX_FILES} records are examined per scan.
 */
export function scanKimiInstances(home: string, io: KimiInstanceScanIo): KimiInstanceScan {
  const scan: KimiInstanceScan = { live: [], stale: 0, invalid: 0, truncated: false };
  let listing: KimiRegistryListing;
  try {
    listing = io.listFiles(kimiInstancesDirectory(home));
  } catch {
    return scan;
  }
  scan.truncated = listing.truncated;
  const records = listing.names.filter((file) => file.endsWith('.json')).sort();
  // Defensive re-cap: the io is REQUIRED to bound its iteration, but an
  // injected io that does not must still cost bounded work here — and its
  // excess must surface as truncation, never as a silently chosen subset.
  const examined = records.slice(0, KIMI_INSTANCE_SCAN_MAX_FILES);
  if (examined.length < records.length) scan.truncated = true;
  for (const file of examined) {
    let record;
    try {
      record = decodeKimiInstanceRecord(io.readJson(join(kimiInstancesDirectory(home), file)));
    } catch {
      scan.invalid += 1;
      continue;
    }
    if (!record) {
      scan.invalid += 1;
      continue;
    }
    if (!io.pidAlive(record.pid)) {
      scan.stale += 1;
      continue;
    }
    const baseUrl = kimiInstanceBaseUrl(record);
    if (!baseUrl) {
      scan.invalid += 1;
      continue;
    }
    scan.live.push({
      baseUrl,
      port: record.port,
      serverId: record.serverId,
      ...(record.hostVersion ? { hostVersion: record.hostVersion } : {}),
    });
  }
  return scan;
}

// ── Read-only HTTP ──────────────────────────────────────────────────────────

/**
 * Envelope business code for success.
 *
 * Every response is the server's uniform envelope `{code, msg, data, request_id}`.
 * The business outcome rides `code` (0 = success), NOT the HTTP status — an
 * unknown session answers HTTP 200 with code 40401 — so callers must read the
 * decoded envelope and never `response.ok` alone.
 */
export const KIMI_OK = 0;

/**
 * `401xx`/`403xx` business codes carry the same meaning as the transport
 * status, so both doors must treat them as a refused credential rather than as
 * an ordinary application error. One list, because a write door that classified
 * them differently would keep spending a proof the server has already refused.
 */
export const KIMI_UNAUTHORIZED_CODES = Object.freeze([40101, 40301] as const);

/** One decoded `{code, msg, data, request_id}` envelope, verb-agnostic. */
export type KimiEnvelope =
  | { outcome: 'ok'; data: unknown; requestId?: string }
  | { outcome: 'unauthorized'; code: number; message?: string }
  | { outcome: 'business-error'; code: number; message?: string; requestId?: string }
  /**
   * `shape` is not decoration: the read door reports a body that is not an
   * envelope AT ALL as `invalid-response` whatever the status, while an
   * unparsable or code-less body on a 4xx/5xx is reported as `http-error`. That
   * distinction predates this decoder and is preserved here rather than
   * flattened, so extracting the shared decode changed no read outcome.
   */
  | { outcome: 'invalid-response'; shape: 'unparsable' | 'not-an-object' | 'no-code' };

/**
 * Decode one envelope body. Shared by the read door and the write door: the
 * envelope is a property of the SERVER, not of the verb, and a second copy of
 * this arithmetic is how the two doors would come to disagree about what
 * "success" means.
 *
 * Total by construction — anything that is not an object carrying a numeric
 * `code` is `invalid-response`, never a thrown parse.
 */
export function decodeKimiEnvelope(body: string): KimiEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { outcome: 'invalid-response', shape: 'unparsable' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { outcome: 'invalid-response', shape: 'not-an-object' };
  }
  const envelope = parsed as { code?: unknown; msg?: unknown; data?: unknown; request_id?: unknown };
  if (typeof envelope.code !== 'number') return { outcome: 'invalid-response', shape: 'no-code' };
  const message = typeof envelope.msg === 'string' ? envelope.msg : undefined;
  const requestId = typeof envelope.request_id === 'string' ? envelope.request_id : undefined;
  if (envelope.code === KIMI_OK) {
    return { outcome: 'ok', data: envelope.data, ...(requestId ? { requestId } : {}) };
  }
  if ((KIMI_UNAUTHORIZED_CODES as readonly number[]).includes(envelope.code)) {
    return { outcome: 'unauthorized', code: envelope.code, ...(message !== undefined ? { message } : {}) };
  }
  return {
    outcome: 'business-error',
    code: envelope.code,
    ...(message !== undefined ? { message } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

export type KimiFetch = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number;
  /**
   * The body stream, when the response has one. Every real fetch Response
   * exposes it, and the default `fetchImpl` hands that Response straight
   * through, so this is the PRODUCTION path: {@link KimiReadOnlyHttp.getJson}
   * reads it under the byte ceiling and cancels on overflow. Optional only so
   * an injected test fake may implement `text()` alone.
   */
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}>;

export type KimiGetResult<T> =
  | { ok: true; data: T; requestId?: string }
  | { ok: false; reason: 'unauthorized' | 'http-error' | 'business-error' | 'unreachable' | 'invalid-response' | 'too-large'; status?: number; code?: number; message?: string };

export interface KimiReadOnlyHttpOptions {
  baseUrl: string;
  /** Bearer token read from `<KIMI_CODE_HOME>/server.token`. Never logged, never surfaced in evidence. */
  token?: string;
  timeoutMs?: number;
  /** Body ceiling in BYTES, enforced at the read; a larger body is reported as `too-large`, never parsed. */
  maxBytes?: number;
  fetchImpl?: KimiFetch;
}

/**
 * Request ceiling shared by BOTH doors.
 *
 * Exported because {@link KimiDriveHttp} must obey the same numbers: a write
 * client with its own timeout and its own body cap would be a second, quietly
 * divergent transport policy for the same server — and the write door is
 * precisely where a divergence matters most.
 */
export const KIMI_HTTP_TIMEOUT_MS = 5_000;
export const KIMI_HTTP_MAX_BODY_BYTES = 8 * 1024 * 1024;

export type KimiBoundedBody =
  | { outcome: 'ok'; text: string }
  | { outcome: 'too-large' }
  | { outcome: 'invalid-response' };

/**
 * Read a response body under a byte ceiling, bounding AT the read: the stream
 * stops and is cancelled the moment the running byte count passes the ceiling,
 * rather than materializing the whole body and measuring it afterwards.
 *
 * What that guarantees precisely: RETENTION is bounded by the ceiling, and
 * consumption stops within one transport chunk past it (plus whatever the
 * stream read ahead). Overflow is detected at chunk granularity, so this is a
 * bounded-retention guarantee, not an exact cap on transported bytes.
 *
 * Counted in BYTES — a string length counts UTF-16 code units, which
 * undercounts every multi-byte character.
 */
export async function readBoundedBody(
  response: { body?: ReadableStream<Uint8Array> | null; text(): Promise<string> },
  maxBytes: number,
): Promise<KimiBoundedBody> {
  if (!response.body) {
    // Defensive re-cap, the same pattern scanKimiInstances applies to an
    // injected io: the production path bounds at the read above, and a fake
    // that offers only `text()` is still surfaced here rather than silently
    // trusted.
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) return { outcome: 'too-large' };
    return { outcome: 'ok', text };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { outcome: 'too-large' };
      }
      // Streaming decode: a multi-byte character split across two chunks is
      // held until its remaining bytes arrive.
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return { outcome: 'ok', text };
  } catch {
    return { outcome: 'invalid-response' };
  }
}

export class KimiReadOnlyHttp {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: KimiFetch;

  constructor(options: KimiReadOnlyHttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    if (options.token) this.token = options.token;
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : KIMI_HTTP_TIMEOUT_MS;
    this.maxBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : KIMI_HTTP_MAX_BODY_BYTES;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<KimiFetch>);
  }

  /** The origin this client reads from. Safe to log; carries no credential. */
  get origin(): string {
    return this.baseUrl;
  }

  /**
   * Read one envelope-wrapped resource. The only network operation this package
   * performs over HTTP.
   */
  async getJson<T>(path: string, query?: Readonly<Record<string, string | number | undefined>>): Promise<KimiGetResult<T>> {
    let url: string;
    try {
      const resolved = new URL(path.startsWith('/') ? path : `/${path}`, `${this.baseUrl}/`);
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value === undefined) continue;
        resolved.searchParams.set(key, String(value));
      }
      url = resolved.toString();
    } catch {
      return { ok: false, reason: 'invalid-response', message: 'unresolvable request url' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status: number;
    let body: string;
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        signal: controller.signal,
      });
      status = response.status;
      // Refused on the status ALONE, before a single byte of body is read: an
      // unauthorized answer carries nothing this client acts on, so reading it
      // is cost spent on a body that cannot be used. That body is never read,
      // so the transport must be TORN DOWN rather than merely ignored —
      // without the abort the stream stays live for as long as a server we
      // have not authenticated cares to feed it.
      if (status === 401 || status === 403) {
        controller.abort();
        return { ok: false, reason: 'unauthorized', status };
      }
      const read = await readBoundedBody(response, this.maxBytes);
      if (read.outcome !== 'ok') return { ok: false, reason: read.outcome, status };
      body = read.text;
    } catch {
      return { ok: false, reason: 'unreachable' };
    } finally {
      clearTimeout(timer);
    }

    const envelope = decodeKimiEnvelope(body);
    if (envelope.outcome === 'invalid-response') {
      const reason = envelope.shape === 'not-an-object' || status < 400 ? 'invalid-response' : 'http-error';
      return { ok: false, reason, status };
    }
    if (envelope.outcome === 'ok') {
      return {
        ok: true,
        data: envelope.data as T,
        ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
      };
    }
    return {
      ok: false,
      reason: envelope.outcome === 'unauthorized' ? 'unauthorized' : 'business-error',
      status,
      code: envelope.code,
      ...(envelope.message !== undefined ? { message: envelope.message } : {}),
    };
  }
}

/**
 * The WebSocket control frames this round may send. `subscribe`/`subscribe_v2`
 * only register interest and `pong` only answers the server's heartbeat; none of
 * them mutates session state. Deliberately excludes `abort`, `terminal_*`, and
 * every other mutating frame the protocol also defines.
 */
export const KIMI_READ_ONLY_WS_FRAMES = Object.freeze([
  'client_hello',
  'subscribe',
  'subscribe_v2',
  'unsubscribe',
  'unsubscribe_v2',
  'pong',
] as const);

export type KimiReadOnlyWsFrame = (typeof KIMI_READ_ONLY_WS_FRAMES)[number];

export function isKimiReadOnlyWsFrame(type: string): type is KimiReadOnlyWsFrame {
  return (KIMI_READ_ONLY_WS_FRAMES as readonly string[]).includes(type);
}

// ── Identity gate ───────────────────────────────────────────────────────────

/** Why no server could be resolved, in machine terms. */
export type KimiInstanceRefusal = 'none' | 'ambiguous' | 'unreachable' | 'identity-mismatch' | 'incomplete';

export type KimiVerifiedInstance =
  | { ok: true; instance: KimiDiscoveredInstance; http: KimiReadOnlyHttp }
  | { ok: false; reason: KimiInstanceRefusal };

/**
 * The ONE way this adapter obtains a server to talk to: resolve, verify, and
 * hand back a pinned `{instance, http}` the caller reuses for that whole
 * operation. Every server-consuming path goes through it — `isAvailable`,
 * `discoverSessions`, `attach` — so there is no route that reaches a Kimi server
 * without the identity gate.
 *
 * Fails closed on each step:
 *  - a TRUNCATED registry scan: an unexamined record may describe another
 *    live server, so the count below would be a guess.
 *  - no live instance, or MORE than one. Several servers on one home are not
 *    interchangeable (each owns whichever sessions it loaded), so choosing is a
 *    guess; and resolving per call let a discovery and the attach it led to land
 *    on different servers.
 *  - `/api/v1/meta` unreachable, unauthorized, or malformed.
 *  - `server_id` that is absent, non-string, or unequal to the registry record.
 *    ABSENCE FAILS: an unverifiable identity is not a verified one, and treating
 *    a silent server as trusted is precisely the fail-open this gate exists to
 *    prevent.
 *
 * COST: one extra `/api/v1/meta` round-trip per operation. Deliberate — the
 * alternative is caching a verdict whose whole value is being current.
 *
 * TWO RESIDUAL RISKS, neither fixable at this version; do not read this gate as
 * stronger than it is:
 *  1. The bearer token is sent BEFORE identity can be checked. A registry record
 *     proves only that some process holds that pid, and the unauthenticated
 *     surface offers nothing to match against (`/api/v1/healthz` answers a bare
 *     `{ok:true}`; `server_id` lives behind the authenticated `/api/v1/meta`). A
 *     recycled pid on a reused port therefore receives one token before it is
 *     refused. Closing this needs an unauthenticated identity echo upstream.
 *  2. Verification and use are SEPARATE requests, so this is not atomic. A
 *     server replaced in the window between the `/meta` that verified it and the
 *     request that uses it would not be caught. The gate narrows that window to
 *     one round-trip; it does not eliminate it.
 */
export async function resolveVerifiedInstance(
  scan: KimiInstanceScan,
  createClient: (instance: KimiDiscoveredInstance) => KimiReadOnlyHttp,
): Promise<KimiVerifiedInstance> {
  // A truncated scan is refused BEFORE counting: an unexamined record may
  // describe another live server, so a partial registry view can prove
  // neither "none" nor "exactly one" — selecting the one server it happened
  // to see is exactly the multi-instance guess this gate exists to prevent.
  if (scan.truncated) return { ok: false, reason: 'incomplete' };
  const live = scan.live;
  if (live.length === 0) return { ok: false, reason: 'none' };
  if (live.length > 1) return { ok: false, reason: 'ambiguous' };
  const instance = live[0]!;
  const http = createClient(instance);
  const meta = await http.getJson<{ server_id?: unknown }>('/api/v1/meta');
  if (!meta.ok) return { ok: false, reason: 'unreachable' };
  const serverId = meta.data?.server_id;
  if (typeof serverId !== 'string' || serverId !== instance.serverId) {
    return { ok: false, reason: 'identity-mismatch' };
  }
  return { ok: true, instance, http };
}
