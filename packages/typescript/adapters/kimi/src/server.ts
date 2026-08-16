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
 *
 * The optional fields are optional in SHAPE only. A field that is present but
 * malformed — an empty `host_version`, a non-finite `started_at` — invalidates
 * the whole record rather than being dropped, because dropping it produces a
 * record that merely LOOKS like an older, sparser one, and the identity gate
 * then skips the comparison that field enables. That is a fail-open edge reached
 * by exactly the malformed input the check exists for. See
 * {@link bindKimiServerIdentity}.
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
  const startedAt = record.started_at;
  const heartbeatAt = record.heartbeat_at;
  const hostVersion = record.host_version;
  if (startedAt !== undefined && (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0)) {
    return undefined;
  }
  if (heartbeatAt !== undefined && (typeof heartbeatAt !== 'number' || !Number.isFinite(heartbeatAt))) {
    return undefined;
  }
  if (hostVersion !== undefined && (typeof hostVersion !== 'string' || !hostVersion)) return undefined;
  return {
    serverId,
    pid,
    host,
    port,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(heartbeatAt === undefined ? {} : { heartbeatAt }),
    ...(hostVersion === undefined ? {} : { hostVersion }),
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
  /**
   * The REGISTRY generation id (`server_id` in the record file). It is NOT the
   * id `/api/v1/meta` echoes — see {@link bindKimiServerIdentity}.
   */
  serverId: string;
  hostVersion?: string;
  /** Registry `started_at`, epoch ms. The load-bearing half of the identity binding. */
  startedAt?: number;
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
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
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
export type KimiInstanceRefusal =
  | 'none'
  | 'ambiguous'
  | 'unreachable'
  | 'metadata-invalid'
  | 'auth-bypassed'
  | 'unbindable'
  | 'startup-mismatch'
  | 'version-mismatch'
  | 'incomplete';

/**
 * `/api/v1/meta`, decoded down to the fields identity depends on.
 *
 * The bearer-gated shape, verbatim from a real 0.36.1 host:
 * `{server_version, capabilities{…}, server_id, started_at, open_in_apps,
 * dangerous_bypass_auth, backend, experimental_flags}`.
 */
export interface KimiServerMeta {
  /**
   * The API-generation id. Upstream mints this with its OWN `ulid()` call when
   * it registers the `/api/v1` routes — it is a SIBLING of the registry id, not
   * a copy of it, and the two never compare equal on a real host.
   */
  serverId: string;
  serverVersion: string;
  /** `started_at` (ISO-8601 on this surface) normalized to epoch ms. */
  startedAtMs: number;
  dangerousBypassAuth: boolean;
  websocket: boolean;
}

/**
 * Decode `/api/v1/meta`'s `data`. Returns undefined for anything that cannot
 * carry an identity decision: this surface is written by another product, and a
 * partially-shaped payload must fail the gate rather than skip half of it.
 *
 * `dangerous_bypass_auth` is REQUIRED to be a boolean rather than defaulted.
 * Reading a missing or non-boolean value as `false` would turn metadata this
 * decoder does not understand into an affirmative "the token gate is on" — a
 * security-relevant field failing open on the exact input that proves the
 * payload is not the shape this gate was written against. Every supported
 * version (the 0.35.0 capture and a live 0.36.1 host) sends it.
 */
export function decodeKimiServerMeta(raw: unknown): KimiServerMeta | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const data = raw as Record<string, unknown>;
  const serverId = data.server_id;
  const serverVersion = data.server_version;
  const startedAt = data.started_at;
  const bypass = data.dangerous_bypass_auth;
  if (typeof serverId !== 'string' || !serverId) return undefined;
  if (typeof serverVersion !== 'string' || !serverVersion) return undefined;
  if (typeof startedAt !== 'string' || !startedAt) return undefined;
  if (typeof bypass !== 'boolean') return undefined;
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) return undefined;
  const capabilities = data.capabilities;
  return {
    serverId,
    serverVersion,
    startedAtMs,
    dangerousBypassAuth: bypass,
    websocket: !!capabilities
      && typeof capabilities === 'object'
      && (capabilities as { websocket?: unknown }).websocket === true,
  };
}

/**
 * What a passed gate observed, reported rather than compared.
 *
 * Carries BOTH ids on purpose: they are independent identifiers minted at
 * separate points in one startup, and conflating them is the defect this type
 * exists to make impossible to reintroduce.
 */
export interface KimiServerIdentity {
  /** `server_id` of the registry record that named this port. */
  registryServerId: string;
  /** `server_id` echoed by `/api/v1/meta`. Distinct from the registry id BY DESIGN. */
  apiServerId: string;
  /** `/api/v1/meta`'s `started_at`, epoch ms. */
  apiStartedAtMs: number;
  /** `server_version` the answering server reported. */
  serverVersion: string;
}

/**
 * How far after the registry record's `started_at` the API layer may report its
 * own start and still be CONSISTENT with having booted alongside it.
 *
 * Consistent, not proven — read the ceiling for exactly what it is. The two
 * timestamps are written by one process, milliseconds apart, in a fixed order:
 * the registry record first, then the `/api/v1` routes recording their start.
 * Two independent captures agree — 128 ms on a live 0.36.1 host and 255 ms in
 * the captured 0.35.0 fixture — and in both, each `server_id`'s ULID time
 * component equals its own `started_at` to the millisecond.
 *
 * What that buys is CORRELATION. It does not establish provenance: pid recycling
 * and port reuse can both happen well inside a minute on a busy machine, so an
 * unrelated process can in principle present a start time inside this window. A
 * narrower ceiling would not fix that either — it would only trade a shrinking
 * amount of correlation for a growing risk of refusing a genuine slow cold
 * start, which is the failure this whole round exists to remove. The ceiling is
 * therefore set for headroom against a slow start, and treated as
 * defense-in-depth rather than as the thing that makes the answer trustworthy.
 *
 * The only complete fix is upstream: an identity echo that returns the registry
 * `server_id` from `/api/v1/meta`. Until that exists, nothing in this file
 * proves the answering process is the one that wrote the record.
 */
export const KIMI_STARTUP_BINDING_WINDOW_MS = 60_000;

export type KimiIdentityBinding =
  | { ok: true; identity: KimiServerIdentity }
  | {
    ok: false;
    reason: 'metadata-invalid' | 'auth-bypassed' | 'unbindable' | 'startup-mismatch' | 'version-mismatch';
  };

/**
 * Decide whether the server answering `/api/v1/meta` is the one the registry
 * record describes. ONE implementation, called by both the adapter gate and
 * doctor, because a doctor that bound identity differently would report a
 * healthy Kimi for a server the adapter then refuses — or the reverse.
 *
 * WHY THIS IS NOT AN ID COMPARISON. The obvious check — registry `server_id`
 * equals meta `server_id` — is not merely weak, it is unsatisfiable. Upstream
 * mints the two with separate `ulid()` calls at separate points in startup, so
 * they NEVER match on any real host. A gate written that way refuses every
 * genuine Kimi server; this repository shipped exactly that, and it rejected
 * 100% of real hosts until a live host proved it. The premise survived 547
 * adapter checks because every fixture synthesized the registry record FROM the
 * meta id, so the suite proved the comparator and never the premise. Any future
 * change here must be tested against the captured record as upstream writes it.
 *
 * What is checkable instead is that the two are CONSISTENT with one startup:
 *  - the registry record's `started_at` and the API layer's `started_at` are
 *    written by one process in a fixed order, milliseconds apart, so the API
 *    start must fall inside {@link KIMI_STARTUP_BINDING_WINDOW_MS} after it;
 *  - the version the registry recorded must be the version answering now.
 *
 * Read that as correlation, not provenance. It narrows what can answer here; it
 * does not prove the answering process wrote the record, and
 * {@link KIMI_STARTUP_BINDING_WINDOW_MS} says why. The complete fix is upstream.
 *
 * Fails closed on:
 *  - metadata that is absent, non-object, or missing/malformed `server_id`,
 *    `server_version`, `started_at`, or `dangerous_bypass_auth`. Unverifiable is
 *    not verified, and a security-relevant field is never defaulted.
 *  - `dangerous_bypass_auth: true`. A server with its token gate disabled
 *    answers ANY caller, so a successful authenticated request proves no
 *    credential relationship — the gate's only evidence is gone. Refusing is
 *    not a policy preference about the user's server; it is the gate declining
 *    to treat an unowned answer as proof of ownership.
 *  - a registry record missing `started_at` or `host_version`. Both exist on
 *    every supported version, so a record without them is not an older shape to
 *    accommodate — it is a record this gate cannot check, and skipping the
 *    comparison it enables would fail open on exactly that input.
 *  - an API start before the registry record's, or later than the window. The
 *    early case is real: a PREVIOUS server still holding the port while a newer
 *    `kimi web` writes a record and fails to bind reports a start from before
 *    that record.
 *
 * There is deliberately NO cross-call identity pin. A pin is only ever a
 * ONE-CALL ALARM: it refuses the next resolution that observes a changed
 * generation and then has to stand down, or an ordinary `kimi web` restart would
 * strand the adapter forever. Which call pays that refusal is arbitrary — an
 * invisible availability poll can consume the whole alarm before any user action
 * runs — so it does not preserve continuity for the operation that matters. It
 * is an alarm, not a guarantee, and one that unrelated polling can spend.
 *
 * Note what a pin would NOT have bought either: the residual risks below allow a
 * recycled pid on a reused port to present metadata that correlates with a stale
 * record it never wrote, so passing this gate is not evidence of having written
 * the record, with or without a pin. Replacement DURING a live
 * connection is already handled where it belongs, by the connection's own
 * generation handling (the reverifier and the `{seq, epoch}` cursor).
 */
export function bindKimiServerIdentity(
  instance: KimiDiscoveredInstance,
  meta: unknown,
): KimiIdentityBinding {
  const decoded = decodeKimiServerMeta(meta);
  if (!decoded) return { ok: false, reason: 'metadata-invalid' };
  if (decoded.dangerousBypassAuth) return { ok: false, reason: 'auth-bypassed' };
  if (instance.startedAt === undefined || instance.hostVersion === undefined) {
    return { ok: false, reason: 'unbindable' };
  }
  const elapsed = decoded.startedAtMs - instance.startedAt;
  if (elapsed < 0 || elapsed > KIMI_STARTUP_BINDING_WINDOW_MS) {
    return { ok: false, reason: 'startup-mismatch' };
  }
  if (instance.hostVersion !== decoded.serverVersion) {
    return { ok: false, reason: 'version-mismatch' };
  }
  return {
    ok: true,
    identity: {
      registryServerId: instance.serverId,
      apiServerId: decoded.serverId,
      apiStartedAtMs: decoded.startedAtMs,
      serverVersion: decoded.serverVersion,
    },
  };
}

export type KimiVerifiedInstance =
  | { ok: true; instance: KimiDiscoveredInstance; http: KimiReadOnlyHttp; identity: KimiServerIdentity }
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
 *  - metadata that cannot bind the answering server to the registry record it
 *    was reached through. See {@link bindKimiServerIdentity} for every binding
 *    case, for why this is NOT an id comparison, and for why there is no
 *    cross-call generation pin.
 *
 * COST: one extra `/api/v1/meta` round-trip per operation. Deliberate — the
 * alternative is caching a verdict whose whole value is being current.
 *
 * THREE RESIDUAL RISKS, none fixable at this version; do not read this gate as
 * stronger than it is:
 *  1. The bearer token is sent BEFORE identity can be checked. A registry record
 *     proves only that some process holds that pid, and the unauthenticated
 *     surface offers nothing to match against (`/api/v1/healthz` answers a bare
 *     `{ok:true}`; every identity field lives behind the authenticated
 *     `/api/v1/meta`). A recycled pid on a reused port therefore receives one
 *     token before it is refused. Closing this needs an unauthenticated identity
 *     echo upstream.
 *  2. Verification and use are SEPARATE requests, so this is not atomic. A
 *     server replaced in the window between the `/meta` that verified it and the
 *     request that uses it would not be caught. The gate narrows that window to
 *     one round-trip; it does not eliminate it.
 *  3. The binding is CIRCUMSTANTIAL, not an identity echo. Kimi exposes no way
 *     to ask a running server which registry record it wrote, so this shows
 *     "same version, started when the record says" rather than "the process that
 *     wrote this record" — and pid and port can both be reused inside the
 *     correlation window. An upstream request to return the registry id from
 *     `/api/v1/meta` would replace all of it with one comparison; until then,
 *     this is defense-in-depth and must not be described as proof of provenance.
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
  const meta = await http.getJson<unknown>('/api/v1/meta');
  if (!meta.ok) return { ok: false, reason: 'unreachable' };
  const bound = bindKimiServerIdentity(instance, meta.data);
  if (!bound.ok) return { ok: false, reason: bound.reason };
  return { ok: true, instance, http, identity: bound.identity };
}
