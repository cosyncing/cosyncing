/**
 * A live Pi session, driven the way Pi's bridge extension drives the broker.
 *
 * The extension announces the session (`hello`), pushes what happens in the
 * terminal (`events`), hands files over (`send-file`), and long-polls for what
 * the app asked it to do (`commands`). Nothing here needs a Pi install, so it
 * is the scriptable session behind most broker feature suites.
 *
 *   const pi = await PiBridgeSession.open(broker.client(), { cwd });
 *   await pi.events({ t: 'tool-result', callId: 'c1', name: 'edit', details: { diff } });
 *   const prompt = await pi.nextCommand((command) => command.kind === 'prompt');
 *
 * Every command the broker queued is kept in `commands`, in arrival order.
 */
import { join } from 'node:path';
import type { BrokerClient, Response } from '../client.ts';
import { scaled, SOON_MS } from '../wait.ts';

export interface PiSessionOptions {
  cwd: string;
  title?: string;
  /** The JSONL the session would write; its path is the session's identity. Default: under `cwd`'s parent. */
  sessionFile?: string;
  /** Extra hello fields (history backfill, model, commands). */
  hello?: Record<string, unknown>;
  /** The route family the dialect's extension calls: Pi `/pi/bridge` (default), omp `/omp/bridge`. */
  route?: '/pi/bridge' | '/omp/bridge';
}

let sequence = 0;

export class PiBridgeSession {
  readonly client: BrokerClient;
  readonly id: string;
  readonly sessionFile: string;
  cwd: string;
  title: string;
  /** Every command the broker queued for the extension, oldest first. */
  readonly commands: any[] = [];
  readonly route: '/pi/bridge' | '/omp/bridge';
  /** Fields repeated on every re-hello (omp's native version attestation). */
  private readonly helloFields: Record<string, unknown>;

  private constructor(
    client: BrokerClient,
    id: string,
    sessionFile: string,
    cwd: string,
    title: string,
    route: '/pi/bridge' | '/omp/bridge',
    helloFields: Record<string, unknown>,
  ) {
    this.client = client;
    this.id = id;
    this.sessionFile = sessionFile;
    this.cwd = cwd;
    this.title = title;
    this.route = route;
    this.helloFields = helloFields;
  }

  static async open(client: BrokerClient, options: PiSessionOptions): Promise<PiBridgeSession> {
    const title = options.title ?? `pi-${++sequence}`;
    const sessionFile = options.sessionFile
      ?? join(options.cwd, '..', `pi-session-${process.pid}-${Date.now().toString(36)}-${++sequence}.jsonl`);
    const route = options.route ?? '/pi/bridge';
    const hello = await client.post(`${route}/hello`, { sessionFile, cwd: options.cwd, title, ...options.hello });
    if (hello.status !== 200 || typeof hello.body?.id !== 'string') {
      throw new Error(`Pi bridge hello refused (${hello.status}): ${hello.text.slice(0, 300)}`);
    }
    // omp attests its native version on every hello; nothing else is repeated.
    const nativeVersion = options.hello?.nativeVersion;
    return new PiBridgeSession(client, hello.body.id, sessionFile, options.cwd, title, route, nativeVersion ? { nativeVersion } : {});
  }

  /** Announce the session again, as a reloaded extension does (the same id, possibly a new cwd). */
  async rehello(changes: { cwd?: string; title?: string; history?: unknown[] } = {}): Promise<void> {
    this.cwd = changes.cwd ?? this.cwd;
    this.title = changes.title ?? this.title;
    const hello = await this.client.post(`${this.route}/hello`, {
      ...this.helloFields,
      sessionFile: this.sessionFile,
      cwd: this.cwd,
      title: this.title,
      ...(changes.history ? { history: changes.history } : {}),
    });
    if (hello.status !== 200 || hello.body?.id !== this.id) {
      throw new Error(`Pi bridge re-hello refused (${hello.status}): ${hello.text.slice(0, 300)}`);
    }
  }

  async events(...events: Record<string, unknown>[]): Promise<void> {
    const response = await this.client.post(`${this.route}/events`, { id: this.id, events });
    if (!response.ok) throw new Error(`Pi bridge events refused (${response.status}): ${response.text.slice(0, 300)}`);
  }

  sendFile(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return this.client.post(`${this.route}/send-file`, { id: this.id, path }, headers);
  }

  /** The session ended in the terminal. `quit` tears it down at once. */
  async bye(reason = 'quit'): Promise<void> {
    await this.client.post(`${this.route}/bye`, { id: this.id, reason });
  }

  /**
   * Wait for a queued command that matches, long-polling as the extension
   * does. The broker answers a poll at once when something is queued.
   */
  async nextCommand(predicate: (command: any) => boolean, options: { timeoutMs?: number; what?: string } = {}): Promise<any> {
    const deadline = Date.now() + scaled(options.timeoutMs ?? SOON_MS);
    for (;;) {
      const found = this.commands.find(predicate);
      if (found) return found;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timed out waiting for ${options.what ?? 'a matching Pi bridge command'}; got ${JSON.stringify(this.commands).slice(0, 500)}`);
      }
      // The broker holds an empty poll for up to 25 s; the deadline bounds it here.
      const body = await fetch(`${this.client.url}${this.route}/commands?id=${encodeURIComponent(this.id)}`, {
        headers: this.client.credentialHeaders(),
        signal: AbortSignal.timeout(Math.max(1, remaining)),
      }).then((response) => response.json() as Promise<any>).catch((error: unknown) => {
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return undefined;
        throw error;
      });
      if (Array.isArray(body?.commands)) this.commands.push(...body.commands);
    }
  }
}
