/**
 * A protocol client that talks to a broker the way the app does.
 *
 * HTTP requests carry the same credentials and contract revision as the
 * Flutter client, and session streams are opened with the same URL shape
 * (a one-use WebSocket ticket when a credential is in play). Every frame a
 * stream receives is recorded, so a test waits for the frame it needs instead
 * of sleeping.
 */
import {
  BROKER_CONTRACT_REVISION,
  BROKER_CONTRACT_SURFACE_HASH,
  CLIENT_MINIMUM_BROKER_CONTRACT_REVISION,
  PRODUCT_IDENTITY,
} from '../../packages/typescript/protocol/src/index.ts';
import { mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeWebSocketUpgrade } from './websocket-wire.ts';
import { eventually, scaled, type WaitOptions } from './wait.ts';

let upgradeFailureRecorded = false;

function listenerSnapshot(port: number) {
  const bindings: { family: string; address: string; inode: string }[] = [];
  const owners: { pid: number; inodes: string[] }[] = [];
  if (process.platform !== 'linux') return { platform: process.platform, unsupported: true, bindings, owners };
  for (const family of ['tcp', 'tcp6']) {
    try {
      for (const line of readFileSync(`/proc/net/${family}`, 'utf8').split('\n').slice(1)) {
        const columns = line.trim().split(/\s+/);
        if (columns[3] === '0A' && Number.parseInt(columns[1]!.split(':').at(-1)!, 16) === port && columns[9]) bindings.push({ family, address: columns[1]!, inode: columns[9] });
      }
    } catch { /* A kernel may expose only one address family. */ }
  }
  const inodes = new Set(bindings.map((binding) => binding.inode));
  const deadline = Date.now() + scaled(2000);
  let incomplete = false;
  for (const pid of readdirSync('/proc').filter((entry) => /^\d+$/.test(entry))) {
    if (Date.now() >= deadline) { incomplete = true; break; }
    try {
      const matched = new Set<string>();
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        if (Date.now() >= deadline) { incomplete = true; break; }
        try {
          const inode = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1];
          if (inode && inodes.has(inode)) matched.add(inode);
        } catch { /* A descriptor closed or belongs to another uid. */ }
      }
      if (matched.size) owners.push({ pid: Number(pid), inodes: [...matched] });
    } catch { /* The process exited or its descriptor table is private. */ }
  }
  return { platform: process.platform, bindings, owners, incomplete };
}

export type ClientAuth =
  | { kind: 'none' }
  | { kind: 'owner'; token: string }
  | { kind: 'peer'; peerToken: string };

export interface Response<T = any> {
  status: number;
  ok: boolean;
  headers: Headers;
  body: T;
  text: string;
}

/** Any frame the broker sends on a session stream. */
export type Frame = { kind: string; [key: string]: any };

export interface AttachOptions {
  /** An intentional refusal neither diagnoses nor consumes the failure-only guard. */
  expectRefusal?: boolean;
  mode?: string;
  reason?: string;
  readOnly?: boolean;
  since?: string;
  initialHistory?: number;
  artifactMode?: string;
  ownerEpoch?: string;
  ownerSeq?: number;
  /** Raw extra query parameters, for tests of the attach surface itself. */
  params?: Record<string, string>;
}

export class BrokerClient {
  readonly url: string;
  readonly wsUrl: string;
  readonly auth: ClientAuth;
  readonly #streams = new Set<SessionStream>();

  constructor(url: string, wsUrl: string, auth: ClientAuth, private readonly brokerPid?: () => number | undefined) {
    this.url = url;
    this.wsUrl = wsUrl;
    this.auth = auth;
  }

  /** The same broker, another identity. */
  as(auth: ClientAuth): BrokerClient {
    return new BrokerClient(this.url, this.wsUrl, auth, this.brokerPid);
  }

  credentialHeaders(): Record<string, string> {
    if (this.auth.kind === 'owner') return { [PRODUCT_IDENTITY.tokenHeader]: this.auth.token };
    if (this.auth.kind === 'peer') return { 'x-cosyncing-peer-token': this.auth.peerToken };
    return {};
  }

  async request<T = any>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response<T>> {
    const isBinary = body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof Blob;
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: {
        ...this.credentialHeaders(),
        ...(body !== undefined && !isBinary ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isBinary ? (body as BodyInit) : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON; `body` stays the text.
    }
    return { status: response.status, ok: response.ok, headers: response.headers, body: parsed as T, text };
  }

  get<T = any>(path: string, headers?: Record<string, string>): Promise<Response<T>> {
    return this.request<T>('GET', path, undefined, headers);
  }

  post<T = any>(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response<T>> {
    return this.request<T>('POST', path, body ?? {}, headers);
  }

  delete<T = any>(path: string, headers?: Record<string, string>): Promise<Response<T>> {
    return this.request<T>('DELETE', path, undefined, headers);
  }

  /** The session roster, as the app requests it. */
  async sessions(options: { window?: string; refresh?: boolean } = {}): Promise<any[]> {
    const query = new URLSearchParams({ contractRevision: String(BROKER_CONTRACT_REVISION) });
    if (options.refresh) query.set('refresh', '1');
    if (options.window) query.set('window', options.window);
    const response = await this.get(`/api/sessions?${query}`);
    if (!response.ok) throw new Error(`GET /api/sessions → ${response.status}: ${response.text.slice(0, 300)}`);
    const body = response.body;
    return Array.isArray(body) ? body : body?.sessions ?? [];
  }

  /** The agent roster, as the app requests it. */
  async agents(): Promise<any[]> {
    const response = await this.get(`/api/agents?contractRevision=${BROKER_CONTRACT_REVISION}`);
    if (!response.ok) throw new Error(`GET /api/agents → ${response.status}: ${response.text.slice(0, 300)}`);
    const body = response.body;
    return Array.isArray(body) ? body : body?.agents ?? [];
  }

  /** Wait until the roster holds a session matching `predicate`, and return it. */
  waitForSession(predicate: (session: any) => boolean, options: WaitOptions = {}): Promise<any> {
    return eventually(
      async () => (await this.sessions({ refresh: true })).find(predicate),
      { what: 'a matching session in the roster', ...options },
    );
  }

  /** Open a session stream. Resolves once the socket is open. */
  async attach(tool: string, sessionId: string, options: AttachOptions = {}): Promise<SessionStream> {
    const expectedBrokerPid = this.brokerPid?.();
    const params: Record<string, string> = {};
    if (options.mode) params.mode = options.mode;
    if (options.readOnly) params.readOnly = '1';
    if (options.reason) params.reason = options.reason;
    if (options.ownerEpoch) params.ownerEpoch = options.ownerEpoch;
    if (options.ownerSeq !== undefined) params.ownerSeq = String(options.ownerSeq);
    if (options.since) params.since = options.since;
    if (options.initialHistory !== undefined) params.initialHistory = String(options.initialHistory);
    if (options.artifactMode) params.artifactMode = options.artifactMode;
    params.clientVersion = 'e2e';
    params.contractRevision = String(BROKER_CONTRACT_REVISION);
    params.minimumBrokerRevision = String(CLIENT_MINIMUM_BROKER_CONTRACT_REVISION);
    params.contractSurfaceHash = BROKER_CONTRACT_SURFACE_HASH;
    Object.assign(params, options.params);

    const path = `/api/sessions/${encodeURIComponent(tool)}/${encodeURIComponent(sessionId)}/stream`;
    let query: string;
    if (this.auth.kind === 'none') {
      query = new URLSearchParams(params).toString();
    } else {
      const ticket = await this.post('/api/ws-auth-tickets', { tool, sessionId, params });
      if (ticket.status !== 201 || typeof ticket.body?.wsAuthTicket !== 'string') {
        throw new Error(`WebSocket ticket refused (${ticket.status}): ${ticket.text.slice(0, 300)}`);
      }
      query = new URLSearchParams({ wsAuthTicket: ticket.body.wsAuthTicket }).toString();
    }
    const stream = new SessionStream(`${this.wsUrl}${path}?${query}`, tool, sessionId);
    this.#streams.add(stream);
    stream.closed.finally(() => this.#streams.delete(stream));
    try { await stream.opened; }
    catch (error) {
      if (!options.expectRefusal && !upgradeFailureRecorded && error instanceof Error && error.message.includes('Expected 101')) {
        upgradeFailureRecorded = true;
        try { await this.diagnoseUpgrade(path, tool, sessionId, params, query, expectedBrokerPid); }
        catch { console.error('[e2e] WebSocket upgrade diagnostic could not be recorded.'); }
      }
      throw error;
    }
    return stream;
  }

  private async diagnoseUpgrade(path: string, tool: string, sessionId: string, params: Record<string, string>, originalQuery: string, expectedBrokerPid?: number): Promise<void> {
    const endpoint = new URL(this.wsUrl);
    const port = Number(endpoint.port) || (endpoint.protocol === 'wss:' ? 443 : 80);
    const secrets = [new URLSearchParams(originalQuery).get('wsAuthTicket'),
      this.auth.kind === 'owner' ? this.auth.token : this.auth.kind === 'peer' ? this.auth.peerToken : undefined].filter((value): value is string => !!value);
    const diagnostic: Record<string, unknown> = { signature: 'Expected 101', capturedAt: new Date().toISOString(), clientPid: process.pid, broker: { pid: expectedBrokerPid ?? null, currentPid: this.brokerPid?.() ?? null, port }, requestedPath: path, normalizedPath: new URL(this.wsUrl + path).pathname };
    try {
      diagnostic.listeners = listenerSnapshot(port);
      let query = new URLSearchParams(params);
      if (this.auth.kind !== 'none') {
        const response = await fetch(`${this.url}/api/ws-auth-tickets`, { method: 'POST', headers: { ...this.credentialHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ tool, sessionId, params }), signal: AbortSignal.timeout(scaled(3000)) });
        diagnostic.ticketStatus = response.status;
        if (response.status !== 201) { await response.body?.cancel(); throw new Error('Fresh diagnostic ticket unavailable'); }
        const reader = response.body?.getReader();
        let body = '';
        try {
          for (;;) {
            const chunk = await reader?.read();
            if (!chunk || chunk.done) break;
            if (body.length + chunk.value.length > 4096) throw new Error('Fresh diagnostic ticket response too large');
            body += new TextDecoder().decode(chunk.value);
          }
        } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
        let ticket: { wsAuthTicket?: string };
        try { ticket = JSON.parse(body); } catch { throw new Error('Fresh diagnostic ticket unavailable'); }
        if (!ticket || typeof ticket.wsAuthTicket !== 'string') throw new Error('Fresh diagnostic ticket unavailable');
        secrets.push(ticket.wsAuthTicket);
        query = new URLSearchParams({ wsAuthTicket: ticket.wsAuthTicket });
      }
      diagnostic.upgrade = await probeWebSocketUpgrade(new URL(`${this.wsUrl}${path}?${query}`));
    } catch (error) { diagnostic.error = error instanceof Error ? error.message : String(error); }
    const text = JSON.stringify(diagnostic, (_key, value) => typeof value === 'string' ? secrets.reduce((text, secret) => text.replaceAll(secret, '[credential]'), value) : value, 2);
    const directory = join(import.meta.dir, '..', '..', 'output', 'check', 'diagnostics');
    try {
      mkdirSync(directory, { recursive: true });
      const file = join(directory, `ws-upgrade-${process.pid}.json`);
      writeFileSync(file, text + '\n', { mode: 0o600 });
      console.error(`[e2e] WebSocket upgrade diagnostic: ${file}\n${text}`);
    } catch { console.error(`[e2e] WebSocket upgrade diagnostic:\n${text}`); }
  }

  /** Close every stream this client opened. */
  closeAll(): void {
    for (const stream of this.#streams) stream.close();
  }
}

export class SessionStream {
  readonly tool: string;
  readonly sessionId: string;
  /** Every frame received, in order. */
  readonly frames: Frame[] = [];
  readonly opened: Promise<void>;
  /** Resolves with the close code when the socket closes, for any reason. */
  readonly closed: Promise<number>;
  readonly #socket: WebSocket;
  #closeCode: number | undefined;
  #closeReason = '';

  constructor(url: string, tool: string, sessionId: string) {
    this.tool = tool;
    this.sessionId = sessionId;
    this.#socket = new WebSocket(url);
    this.#socket.onmessage = (event) => {
      try {
        this.frames.push(JSON.parse(String(event.data)) as Frame);
      } catch {
        this.frames.push({ kind: '(non-json)', data: String(event.data) });
      }
    };
    this.opened = new Promise((resolve, reject) => {
      this.#socket.addEventListener('open', () => resolve(), { once: true });
      this.#socket.addEventListener('close', (event) => {
        reject(new Error(`stream closed before opening: ${event.code} ${event.reason}`));
      }, { once: true });
    });
    this.opened.catch(() => undefined);
    this.closed = new Promise((resolve) => {
      this.#socket.addEventListener('close', (event) => {
        this.#closeCode = event.code;
        this.#closeReason = event.reason;
        resolve(event.code);
      }, { once: true });
    });
  }

  get isOpen(): boolean {
    return this.#socket.readyState === WebSocket.OPEN;
  }

  get closeCode(): number | undefined {
    return this.#closeCode;
  }

  get closeReason(): string {
    return this.#closeReason;
  }

  send(message: unknown): void {
    this.#socket.send(JSON.stringify(message));
  }

  close(): void {
    if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING) {
      this.#socket.close();
    }
  }

  /** Frames of one kind. */
  ofKind(kind: string): Frame[] {
    return this.frames.filter((frame) => frame.kind === kind);
  }

  /**
   * Every message the client holds, from history, history pages and live
   * message frames, in arrival order.
   */
  messages(): any[] {
    const out: any[] = [];
    for (const frame of this.frames) {
      if ((frame.kind === 'history' || frame.kind === 'history-page') && Array.isArray(frame.messages)) {
        out.push(...frame.messages);
      } else if (frame.kind === 'message' && frame.message) {
        out.push(frame.message);
      }
    }
    return out;
  }

  /** Wait for the first frame (from `after` on) that matches. */
  waitForFrame(predicate: (frame: Frame) => boolean, options: WaitOptions & { after?: number } = {}): Promise<Frame> {
    const after = options.after ?? 0;
    return eventually(() => this.frames.slice(after).find(predicate), {
      what: `a matching frame on ${this.tool}/${this.sessionId}`,
      ...options,
    });
  }

  /** Wait for the first frame of `kind`. */
  waitForKind(kind: string, options: WaitOptions & { after?: number } = {}): Promise<Frame> {
    return this.waitForFrame((frame) => frame.kind === kind, { what: `a "${kind}" frame`, ...options });
  }

  /** Wait until the client holds a message that matches. */
  waitForMessage(predicate: (message: any) => boolean, options: WaitOptions = {}): Promise<any> {
    return eventually(() => this.messages().find(predicate), {
      what: `a matching message on ${this.tool}/${this.sessionId}`,
      ...options,
    });
  }

  /**
   * Send a client message carrying a fresh `clientMessageId` and wait for the
   * broker's ack or nack for it.
   */
  async sendAndAwait(message: Record<string, unknown>, options: WaitOptions = {}): Promise<Frame> {
    const clientMessageId = (message.clientMessageId as string | undefined) ?? crypto.randomUUID();
    const after = this.frames.length;
    this.send({ ...message, clientMessageId });
    return this.waitForFrame(
      (frame) => (frame.kind === 'ack' || frame.kind === 'nack') && frame.clientMessageId === clientMessageId,
      { what: `ack/nack for ${String(message.kind)} ${clientMessageId}`, after, ...options },
    );
  }
}
