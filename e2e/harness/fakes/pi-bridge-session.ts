/**
 * A live Pi session as the broker sees it: the in-session bridge extension, scripted.
 *
 * The real extension announces its session (`/pi/bridge/hello`), relays what the agent does as
 * events (`/pi/bridge/events`), long-polls for the app's commands (`/pi/bridge/commands`) and says
 * goodbye (`/pi/bridge/bye`). This does the same over HTTP, so a test produces agent activity —
 * turns, permission requests, questions — exactly as an agent would, with no agent binary.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrokerClient } from '../client.ts';

export type PiBridgeEvent = { t: string; [key: string]: unknown };

export class PiBridgeSession {
  readonly client: BrokerClient;
  readonly sessionFile: string;
  readonly cwd: string;
  readonly title: string;
  id = '';

  private constructor(client: BrokerClient, sessionFile: string, cwd: string, title: string) {
    this.client = client;
    this.sessionFile = sessionFile;
    this.cwd = cwd;
    this.title = title;
  }

  /** Persist and announce a named native session in the broker's isolated Pi store. */
  static async open(
    client: BrokerClient,
    root: string,
    name: string,
    options: { title?: string } = {},
  ): Promise<PiBridgeSession> {
    const cwd = join(root, 'work', name);
    mkdirSync(cwd, { recursive: true });
    const store = join(root, 'pi-sessions', '--fixture--');
    mkdirSync(store, { recursive: true });
    const session = new PiBridgeSession(client, join(store, `${name}.jsonl`), cwd, options.title ?? name);
    const timestamp = new Date().toISOString();
    writeFileSync(session.sessionFile, [
      { type: 'session', version: 3, id: name, cwd, timestamp },
      { type: 'session_info', id: 'name', parentId: null, name: session.title, timestamp },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    await session.hello();
    return session;
  }

  /** (Re)announce the session, as the extension does on start and after a reload. */
  async hello(): Promise<void> {
    const response = await this.client.post('/pi/bridge/hello', {
      sessionFile: this.sessionFile,
      cwd: this.cwd,
      title: this.title,
    });
    if (response.status !== 200) throw new Error(`pi hello refused (${response.status}): ${response.text.slice(0, 300)}`);
    this.id = String(response.body.id);
  }

  /** Relay agent events, in order, in one request. */
  async emit(...events: PiBridgeEvent[]): Promise<void> {
    const response = await this.client.post('/pi/bridge/events', { id: this.id, events });
    if (response.status !== 200) throw new Error(`pi events refused (${response.status}): ${response.text.slice(0, 300)}`);
  }

  /** A turn the user started, from running to `status`. */
  async turn(key: string, status: 'done' | 'error' = 'done'): Promise<void> {
    await this.emit(
      { t: 'run', key, turnId: key, status: 'running' },
      { t: 'run', key, turnId: key, status },
    );
  }

  /**
   * The commands the app has queued for the agent (the extension's long-poll): at once when some
   * are queued, otherwise after the broker's 25 s poll window. Call it only when one is expected.
   */
  async commands(): Promise<any[]> {
    const response = await this.client.get(`/pi/bridge/commands?id=${encodeURIComponent(this.id)}`);
    if (response.status !== 200) throw new Error(`pi commands refused (${response.status}): ${response.text.slice(0, 300)}`);
    return response.body.commands ?? [];
  }

  /** The session ends; `quit` tears it down at once. */
  async bye(reason = 'quit'): Promise<void> {
    const response = await this.client.post('/pi/bridge/bye', { id: this.id, reason });
    if (response.status !== 200) throw new Error(`pi bye refused (${response.status}): ${response.text.slice(0, 300)}`);
  }
}
