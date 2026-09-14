/** Bounded Cline Hub v1 client and discovery gate, floored at core 0.0.82. */
import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { compareSemanticVersions, type HistorySourceIdentity } from '@cosyncing/adapter-api';
import {
  CLINE_HUB_CORE_MINIMUM_VERSION,
  CLINE_MAX_BLOCKS_PER_MESSAGE,
  CLINE_MAX_MESSAGES,
  CLINE_MAX_MESSAGES_BYTES,
  CLINE_MAX_TOTAL_BLOCKS,
  type ClineNativeMessage,
} from './store.ts';

/**
 * The Hub core version this adapter was measured against, used as a FLOOR.
 *
 * 3.0.60's Hub reports 0.0.81 and 3.0.61's reports 0.0.82, so this number moves
 * with the CLI. It was compared with `!==`, which meant every Cline update
 * rejected its own Hub's discovery record and took Drive with it.
 *
 * It is DEFINED in `store.ts` and re-exported here. That fact -- 3.0.60 ships a
 * core below this floor -- was already written in this comment while the CLI
 * floor was still derived independently, which is how the two came to
 * contradict each other: 3.0.60 passed the CLI gate and was advertised as the
 * minimum, then had its Hub refused here. `CLINE_MINIMUM_SUPPORTED_VERSION` is
 * now derived from `CLINE_MEASURED_HUB_CORE` against this value, so the CLI
 * floor cannot drop below the Hub floor again.
 *
 * `protocolVersion` below stays an EXACT match, and is the one that matters:
 * it names the wire contract this adapter implements, and is the reason a
 * newer core version can be admitted without guessing.
 */
export { CLINE_HUB_CORE_MINIMUM_VERSION };
export const CLINE_HUB_PROTOCOL_VERSION = 'v1';

export function clineHubCoreVersionSupported(version: unknown): boolean {
  if (typeof version !== 'string') return false;
  if (version === CLINE_HUB_CORE_MINIMUM_VERSION) return true;
  const order = compareSemanticVersions(version, CLINE_HUB_CORE_MINIMUM_VERSION);
  return order !== undefined && order >= 0;
}
export const CLINE_MANAGED_HUB_PORT = 25_464;
/** Cline's OWN default Hub port, which the owner's personal `cline` binds.
 *
 *  The broker must never take it. Every ownership guarantee in this adapter
 *  rests on the managed Hub living at a dedicated address the owner's Hub does
 *  not use; binding 25463 would put a broker-managed daemon exactly where the
 *  owner's is expected, and 3.0.61 made that easier to reach by accident by
 *  moving the address out of argv and into the environment. `COSYNCING_CLINE_
 *  HUB_PORT` accepted any port in range, so a single typo was enough. It is now
 *  refused like any other invalid value: the managed default wins. */
export const CLINE_OWNER_DEFAULT_HUB_PORT = 25_463;
export const CLINE_HUB_MAX_DISCOVERY_BYTES = 64 * 1024;
export const CLINE_HUB_MAX_FRAME_BYTES = CLINE_MAX_MESSAGES_BYTES + 256 * 1024;
export const CLINE_HUB_READY_TIMEOUT_MS = 30_000;
export const CLINE_HUB_STOP_GRACE_MS = 5_000;

/** The managed Hub's launch controls, stripped from every OTHER cline child.
 *
 *  Until 3.0.61 daemon mode needed an argv flag, so inheriting the broker's
 *  environment was harmless. It is now a single variable: any `cline` process
 *  that inherits `CLINE_RUN_AS_HUB_DAEMON=1` becomes a hub daemon. A version
 *  probe or a history write that did so would bind the DEFAULT hub port, which
 *  is the owner's 25463 — and the probe's own 5s timeout kills only the Node
 *  resolver, leaving the native grandchild holding that port with no ownership
 *  record and nothing to reap it. Cline scrubs this variable from its own
 *  children for the same reason; the address vars go too, so a stray daemon
 *  cannot be pointed at the managed port either. */
export function clineChildEnvWithoutHubLaunch(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env };
  delete child.CLINE_RUN_AS_HUB_DAEMON;
  delete child.CLINE_HUB_HOST;
  delete child.CLINE_HUB_PORT;
  delete child.CLINE_HUB_PATHNAME;
  delete child.CLINE_HUB_ADDRESS;
  delete child.CLINE_HUB_DISCOVERY_PATH;
  return child;
}

const MAX_ID_CHARS = 512;
const MAX_TOKEN_CHARS = 4_096;
const REQUIRED_CAPABILITIES = new Set([
  'session.create',
  'session.run',
  'session.abort',
  'run.enqueue',
  'run.list',
  'stream.replay',
]);

export interface ClineHubDiscovery {
  hubId: string;
  protocolVersion: 'v1';
  capabilities: string[];
  /** What the Hub actually reported, not the floor it cleared. Anything at or
   *  above `CLINE_HUB_CORE_MINIMUM_VERSION` is admitted, so pinning this to the
   *  constant would report `0.0.82` for a Hub that said `0.0.83`. */
  coreVersion: string;
  authToken: string;
  host: '127.0.0.1';
  port: number;
  url: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
}

export interface ClineHubReply {
  version?: string;
  requestId?: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

export interface ClineHubEvent {
  version?: string;
  event: string;
  eventId?: string;
  sequence?: number;
  sessionId?: string;
  clientId?: string;
  timestamp?: number;
  payload?: Record<string, unknown>;
}

export interface ClineHubSocketLike {
  readonly readyState?: number;
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: any) => void, options?: any): void;
  removeEventListener?(type: 'open' | 'message' | 'error' | 'close', listener: (event: any) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type ClineHubSocketFactory = (url: string, protocols: string[]) => ClineHubSocketLike;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function field(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) return undefined;
  return value;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function pathContained(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function openOwnerFile(root: string, path: string): Promise<FileHandle | undefined> {
  if (!pathContained(root, path)) return undefined;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > CLINE_HUB_MAX_DISCOVERY_BYTES) return undefined;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return undefined;
    if ((stat.mode & 0o077) !== 0) return undefined;
    const [rootTarget, pathTarget] = await Promise.all([realpath(root), realpath(path)]);
    if (!pathContained(rootTarget, pathTarget)) return undefined;
    return handle;
  } catch {
    await handle?.close().catch(() => undefined);
    return undefined;
  }
}

export function clineManagedDataRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  userHome = homedir(),
): string {
  const configured = env.COSYNCING_CLINE_PROFILE_DIR?.trim();
  if (configured && isAbsolute(configured)) return resolve(configured);
  return resolve(userHome, '.cosyncing', 'agents', 'cline');
}

export function clineManagedHubDiscoveryPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  userHome = homedir(),
): string {
  return join(clineManagedDataRoot(env, userHome), 'locks', 'hub', 'cosyncing.json');
}

export function clineManagedHubPort(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const configured = Number(env.COSYNCING_CLINE_HUB_PORT?.trim());
  return Number.isSafeInteger(configured) && configured > 0 && configured <= 65_535
    && configured !== CLINE_OWNER_DEFAULT_HUB_PORT
    ? configured
    : CLINE_MANAGED_HUB_PORT;
}

export function clineManagedHubIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
  userHome = homedir(),
): string {
  return `ws://127.0.0.1:${clineManagedHubPort(env)}/hub|${clineManagedDataRoot(env, userHome)}`;
}

export async function readClineHubDiscovery(options: {
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  path?: string;
} = {}): Promise<ClineHubDiscovery | undefined> {
  const env = options.env ?? process.env;
  const root = clineManagedDataRoot(env, options.homeDir);
  const path = options.path ?? clineManagedHubDiscoveryPath(env, options.homeDir);
  if (!isAbsolute(path) || !pathContained(root, path)) return undefined;
  const handle = await openOwnerFile(root, path);
  if (!handle) return undefined;
  try {
    const stat = await handle.stat();
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) return undefined;
    const parsed = record(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
    if (!parsed) return undefined;
    const hubId = field(parsed.hubId, MAX_ID_CHARS);
    const authToken = field(parsed.authToken, MAX_TOKEN_CHARS);
    const pid = safeInteger(parsed.pid);
    const port = safeInteger(parsed.port);
    const startedAt = field(parsed.startedAt, 128);
    const updatedAt = field(parsed.updatedAt, 128);
    const coreVersion = field(parsed.coreVersion, 128);
    const capabilities = Array.isArray(parsed.capabilities)
      ? parsed.capabilities.filter((value): value is string => typeof value === 'string' && value.length <= 256)
      : [];
    const expectedPort = clineManagedHubPort(env);
    const expectedUrl = `ws://127.0.0.1:${expectedPort}/hub`;
    if (!hubId || !authToken || !pid || port !== expectedPort || !startedAt || !updatedAt
      || parsed.protocolVersion !== CLINE_HUB_PROTOCOL_VERSION
      || !coreVersion || !clineHubCoreVersionSupported(coreVersion)
      || parsed.host !== '127.0.0.1'
      || parsed.url !== expectedUrl
      || [...REQUIRED_CAPABILITIES].some((name) => !capabilities.includes(name))) return undefined;
    return {
      hubId,
      protocolVersion: CLINE_HUB_PROTOCOL_VERSION,
      capabilities,
      coreVersion,
      authToken,
      host: '127.0.0.1',
      port,
      url: expectedUrl,
      pid,
      startedAt,
      updatedAt,
    };
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function boundedResponseJson(response: Response, maxBytes = CLINE_HUB_MAX_DISCOVERY_BYTES): Promise<Record<string, unknown> | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxBytes) return undefined;
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString('utf8');
  try { return record(JSON.parse(body)); } catch { return undefined; }
}

export async function probeClineHub(options: {
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  fetcher?: typeof globalThis.fetch;
  signal?: AbortSignal;
} = {}): Promise<ClineHubDiscovery | undefined> {
  const discovery = await readClineHubDiscovery(options);
  if (!discovery) return undefined;
  const signal = options.signal ?? AbortSignal.timeout(3_000);
  try {
    const response = await (options.fetcher ?? globalThis.fetch)(
      `http://127.0.0.1:${discovery.port}/health`,
      { signal, redirect: 'error' },
    );
    if (!response.ok) {
      // Drained: this probe runs on every managed-host readiness check, and an
      // abandoned error body keeps its connection out of the pool exactly when
      // the next probe needs it.
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const health = await boundedResponseJson(response);
    if (health?.ok !== true || health.draining === true
      || health.protocolVersion !== CLINE_HUB_PROTOCOL_VERSION
      // Floored, like the discovery record this probe confirms. Left exact, a
      // Hub above the floor was admitted by `readClineHubDiscovery` and then
      // refused here -- and since this probe is the only entry to the managed
      // lane, that silently took Create, Drive and Resume with it. The live
      // Hub must still AGREE with its own record; that exactness is what makes
      // a stale or swapped descriptor detectable.
      || !clineHubCoreVersionSupported(health.coreVersion)
      || health.coreVersion !== discovery.coreVersion
      || health.host !== discovery.host
      || health.port !== discovery.port
      || health.url !== discovery.url) return undefined;
    return discovery;
  } catch {
    return undefined;
  }
}

interface PendingReply {
  command: string;
  resolve: (reply: ClineHubReply) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ClineHubClientOptions {
  discovery: ClineHubDiscovery;
  clientId: string;
  workspaceRoot: string;
  cwd: string;
  capabilities?: Array<{ name: string; description?: string }>;
  socketFactory?: ClineHubSocketFactory;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export class ClineHubClient {
  private socket?: ClineHubSocketLike;
  private connecting?: Promise<void>;
  private readonly pending = new Map<string, PendingReply>();
  private readonly eventHandlers = new Set<(event: ClineHubEvent) => void>();
  private readonly closeHandlers = new Set<(error: Error) => void>();
  private requestCounter = 0;
  private closed = false;
  private registered = false;
  private lastSequence = 0;

  constructor(readonly options: ClineHubClientOptions) {}

  get clientId(): string { return this.options.clientId; }
  get sequence(): number { return this.lastSequence; }
  get alive(): boolean { return this.registered && !this.closed && !!this.socket; }

  subscribe(handler: (event: ClineHubEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onClose(handler: (error: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async connect(sinceSequence?: number): Promise<void> {
    if (this.alive) return;
    if (this.connecting) return this.connecting;
    if (this.closed) throw new Error('Cline Hub client is closed.');
    const work = this.openAndRegister(sinceSequence);
    this.connecting = work;
    try { await work; } finally {
      if (this.connecting === work) this.connecting = undefined;
    }
  }

  private async openAndRegister(sinceSequence?: number): Promise<void> {
    const socketFactory = this.options.socketFactory
      ?? ((url: string, protocols: string[]) => new WebSocket(url, protocols) as unknown as ClineHubSocketLike);
    const socket = socketFactory(
      this.options.discovery.url,
      [`cline-hub-auth.${this.options.discovery.authToken}`],
    );
    this.socket = socket;
    const opened = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Cline Hub WebSocket open timed out.'));
        socket.close(1000, 'open timeout');
      }, this.options.connectTimeoutMs ?? 5_000);
      socket.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('Cline Hub WebSocket open failed.'));
      }, { once: true });
    });
    socket.addEventListener('message', (event) => this.handleMessage(event));
    socket.addEventListener('close', (event) => this.handleClose(
      new Error(`Cline Hub WebSocket closed (${String(event?.code ?? 'unknown')}).`),
    ));
    socket.addEventListener('error', () => {
      if (this.registered) this.handleClose(new Error('Cline Hub WebSocket failed.'));
    });
    try {
      await opened;
      const registered = await this.commandOnOpen('client.register', {
        clientId: this.options.clientId,
        clientType: 'cosyncing',
        displayName: 'cosyncing',
        actorKind: 'client',
        transport: 'native',
        capabilities: this.options.capabilities ?? [],
        workspaceContext: {
          workspaceRoot: this.options.workspaceRoot,
          cwd: this.options.cwd,
        },
        protocolVersion: CLINE_HUB_PROTOCOL_VERSION,
      });
      if (registered.clientId !== this.options.clientId) {
        throw new Error('Cline Hub registered a different client identity.');
      }
      this.registered = true;
      this.sendFrame({
        kind: 'stream.subscribe',
        clientId: this.options.clientId,
        ...(sinceSequence === undefined ? {} : { sinceSequence }),
      });
    } catch (error) {
      socket.close(1000, 'registration failed');
      this.socket = undefined;
      throw error;
    }
  }

  async command(
    command: string,
    payload: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs: number | null = this.options.requestTimeoutMs ?? 30_000,
  ): Promise<Record<string, unknown>> {
    await this.connect();
    return this.commandOnOpen(command, payload, sessionId, timeoutMs);
  }

  private async commandOnOpen(
    command: string,
    payload: Record<string, unknown>,
    sessionId?: string,
    timeoutMs: number | null = this.options.requestTimeoutMs ?? 30_000,
  ): Promise<Record<string, unknown>> {
    const requestId = `cosyncing-cline-${Date.now().toString(36)}-${(++this.requestCounter).toString(36)}`;
    const reply = new Promise<ClineHubReply>((resolve, reject) => {
      const pending: PendingReply = { command, resolve, reject };
      if (timeoutMs !== null) {
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(requestId)) return;
          reject(new Error(`Cline Hub ${command} timed out.`));
        }, timeoutMs);
      }
      this.pending.set(requestId, pending);
    });
    try {
      this.sendFrame({
        kind: 'command',
        envelope: {
          version: CLINE_HUB_PROTOCOL_VERSION,
          command,
          requestId,
          clientId: this.options.clientId,
          ...(sessionId ? { sessionId } : {}),
          timeoutMs,
          payload,
        },
      });
    } catch (error) {
      const pending = this.pending.get(requestId);
      if (pending) {
        this.pending.delete(requestId);
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    const result = await reply;
    if (!result.ok) {
      throw new Error(`Cline Hub ${command} failed${result.error?.code ? ` (${result.error.code})` : ''}: ${result.error?.message ?? 'unknown error'}`);
    }
    return result.payload ?? {};
  }

  private sendFrame(frame: unknown): void {
    if (!this.socket || this.closed) throw new Error('Cline Hub WebSocket is not open.');
    const encoded = JSON.stringify(frame);
    if (Buffer.byteLength(encoded, 'utf8') > CLINE_HUB_MAX_FRAME_BYTES) {
      throw new Error('Cline Hub outbound frame exceeds the supported bound.');
    }
    this.socket.send(encoded);
  }

  private handleMessage(event: { data?: unknown }): void {
    const value = typeof event.data === 'string' ? event.data
      : event.data instanceof ArrayBuffer ? Buffer.from(event.data).toString('utf8')
        : ArrayBuffer.isView(event.data) ? Buffer.from(event.data.buffer, event.data.byteOffset, event.data.byteLength).toString('utf8')
          : '';
    if (!value || Buffer.byteLength(value, 'utf8') > CLINE_HUB_MAX_FRAME_BYTES) {
      this.handleClose(new Error('Cline Hub sent an invalid or oversized frame.'));
      this.socket?.close(1009, 'frame bound');
      return;
    }
    let frame: Record<string, unknown> | undefined;
    try { frame = record(JSON.parse(value)); } catch { frame = undefined; }
    const envelope = record(frame?.envelope);
    if (!frame || !envelope) {
      this.handleClose(new Error('Cline Hub sent a malformed frame.'));
      this.socket?.close(1002, 'malformed frame');
      return;
    }
    if (frame.kind === 'reply') {
      const requestId = field(envelope.requestId, MAX_ID_CHARS);
      if (!requestId) return;
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(envelope as unknown as ClineHubReply);
      return;
    }
    if (frame.kind !== 'event') return;
    const name = field(envelope.event, 256);
    if (!name || envelope.version !== CLINE_HUB_PROTOCOL_VERSION) return;
    const sequence = typeof envelope.sequence === 'number'
      && Number.isSafeInteger(envelope.sequence) && envelope.sequence >= 0
      ? envelope.sequence : undefined;
    if (sequence !== undefined) {
      if (sequence <= this.lastSequence) return;
      this.lastSequence = sequence;
    }
    const hubEvent: ClineHubEvent = {
      event: name,
      version: CLINE_HUB_PROTOCOL_VERSION,
      ...(field(envelope.eventId, MAX_ID_CHARS) ? { eventId: field(envelope.eventId, MAX_ID_CHARS) } : {}),
      ...(sequence === undefined ? {} : { sequence }),
      ...(field(envelope.sessionId, MAX_ID_CHARS) ? { sessionId: field(envelope.sessionId, MAX_ID_CHARS) } : {}),
      ...(field(envelope.clientId, MAX_ID_CHARS) ? { clientId: field(envelope.clientId, MAX_ID_CHARS) } : {}),
      ...(typeof envelope.timestamp === 'number' && Number.isFinite(envelope.timestamp)
        ? { timestamp: envelope.timestamp } : {}),
      ...(record(envelope.payload) ? { payload: record(envelope.payload) } : {}),
    };
    for (const handler of this.eventHandlers) handler(hubEvent);
  }

  private handleClose(error: Error): void {
    const active = !!this.socket || this.registered || this.pending.size > 0;
    if (!active) return;
    this.socket = undefined;
    this.registered = false;
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const handler of this.closeHandlers) handler(error);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.registered) {
      await this.commandOnOpen('client.unregister', { clientId: this.options.clientId }, undefined, 2_000)
        .catch(() => undefined);
    }
    this.closed = true;
    const socket = this.socket;
    this.socket = undefined;
    this.registered = false;
    socket?.close(1000, 'client close');
    this.handleClose(new Error('Cline Hub client closed.'));
    this.eventHandlers.clear();
    this.closeHandlers.clear();
  }
}

export function parseClineHubMessages(sessionId: string, value: unknown): ClineNativeMessage[] | undefined {
  if (!Array.isArray(value) || value.length > CLINE_MAX_MESSAGES) return undefined;
  let encodedBytes = 2;
  let totalBlocks = 0;
  const seen = new Set<string>();
  const out: ClineNativeMessage[] = [];
  for (const raw of value) {
    const message = record(raw);
    const id = field(message?.id, MAX_ID_CHARS);
    const role = field(message?.role, 64);
    if (!message || !id || !role || seen.has(id) || !Array.isArray(message.content)
      || message.content.length > CLINE_MAX_BLOCKS_PER_MESSAGE
      || message.content.some((block) => !record(block))) return undefined;
    totalBlocks += message.content.length;
    if (totalBlocks > CLINE_MAX_TOTAL_BLOCKS) return undefined;
    let encoded: string;
    try { encoded = JSON.stringify(message); } catch { return undefined; }
    encodedBytes += Buffer.byteLength(encoded, 'utf8') + 1;
    if (encodedBytes > CLINE_MAX_MESSAGES_BYTES) return undefined;
    seen.add(id);
    out.push({
      ...message,
      id,
      role,
      content: message.content as Array<Record<string, unknown>>,
    } as ClineNativeMessage);
  }
  return out;
}

export function clineHubHistoryIdentity(
  profileRoot: string,
  sessionId: string,
  hubEpoch: string,
  messages: readonly ClineNativeMessage[],
): HistorySourceIdentity {
  const first = messages[0]?.id ?? 'empty';
  const digest = createHash('sha256');
  for (const message of messages) {
    digest.update(JSON.stringify(message));
    digest.update('\0');
  }
  return {
    sourceId: `${resolve(profileRoot)}:${sessionId}:${hubEpoch}`,
    revision: `${messages.length}:${digest.digest('hex')}`,
    appendPosition: messages.length,
    rewriteToken: first,
  };
}

export function clineHubEpoch(discovery: ClineHubDiscovery): string {
  return `${discovery.hubId}:${discovery.startedAt}`;
}

export function sameClineHubHistoryIdentity(
  left: HistorySourceIdentity | undefined,
  right: HistorySourceIdentity | undefined,
): left is HistorySourceIdentity {
  return left !== undefined && right !== undefined
    && left.sourceId === right.sourceId
    && left.revision === right.revision
    && left.appendPosition === right.appendPosition
    && left.rewriteToken === right.rewriteToken;
}
