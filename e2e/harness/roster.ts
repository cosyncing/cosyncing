/**
 * The session roster as the app reads it: snapshots from `/api/sessions` and
 * the delta feed from `/api/session-roster-deltas`, plus the on-disk session
 * stores a roster is discovered from.
 *
 *   const feed = new RosterFeed(client, '7d');
 *   await feed.start();
 *   const removed = await feed.waitFor((delta) => delta.sessionId === id && delta.removed);
 */
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BROKER_CONTRACT_REVISION } from '../../packages/typescript/protocol/src/index.ts';
import type { BrokerClient, Response } from './client.ts';
import type { FixturePaths } from './broker.ts';
import { eventually, type WaitOptions } from './wait.ts';

export interface RosterDelta {
  revision: number;
  machine?: string;
  tool: string;
  sessionId: string;
  changedFields: string[];
  session?: any;
  removed?: true;
}

export interface RosterSnapshot {
  machine: string;
  revision: number;
  generatedAt: number;
  complete?: boolean;
  sessions: any[];
}

/** Query string for a roster request made by the current app (it declares its contract revision). */
export function rosterQuery(params: Record<string, string | undefined> = {}): string {
  const query = new URLSearchParams({ contractRevision: String(BROKER_CONTRACT_REVISION) });
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, value);
  return query.toString();
}

/** One `/api/sessions` request; `window` and `refresh` as the app sends them. */
export async function rosterSnapshot(
  client: BrokerClient,
  options: { window?: string; refresh?: boolean; headers?: Record<string, string> } = {},
): Promise<Response<RosterSnapshot>> {
  return client.get<RosterSnapshot>(
    `/api/sessions?${rosterQuery({ window: options.window, refresh: options.refresh ? '1' : undefined })}`,
    options.headers,
  );
}

/** The id the broker gives a session discovered from a file: its path, base64url. */
export function fileSessionId(path: string): string {
  return Buffer.from(path).toString('base64url');
}

/** A Pi session file in the fixture's Pi store, last written `ageMs` ago. */
export function writePiSession(paths: FixturePaths, name: string, ageMs = 0): { path: string; id: string } {
  const directory = join(paths.root, 'pi-sessions', '--fixture--');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `2026-09-01_${name}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: 'session', id: name, cwd: paths.home })}\n`);
  age(path, ageMs);
  return { path, id: fileSessionId(path) };
}

/** Set a file's modification time to `ageMs` ago. */
export function age(path: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
}

/**
 * A client following the delta feed of one roster window from a cursor, the
 * way the app does: every poll is a long poll from the last revision it saw.
 */
export class RosterFeed {
  readonly client: BrokerClient;
  readonly window: string | undefined;
  /** Every delta received since `start`, in order. */
  readonly seen: RosterDelta[] = [];
  cursor = 0;

  constructor(client: BrokerClient, window?: string) {
    this.client = client;
    this.window = window;
  }

  /** One raw poll, without moving the cursor. */
  async request(after: number, waitMs = 0): Promise<{ revision: number; deltas: RosterDelta[]; resetRequired?: boolean }> {
    const response = await this.client.get(
      `/api/session-roster-deltas?${rosterQuery({ window: this.window, after: String(after), waitMs: String(waitMs) })}`,
    );
    if (!response.ok) throw new Error(`roster deltas → ${response.status}: ${response.text.slice(0, 300)}`);
    return response.body;
  }

  /** The journal's current revision (a cursor past it is answered with a reset that names it). */
  async head(): Promise<number> {
    return (await this.request(Number.MAX_SAFE_INTEGER)).revision;
  }

  /** Follow from the current head: only changes made after this are seen. */
  async start(): Promise<void> {
    this.cursor = await this.head();
    this.seen.length = 0;
  }

  /** One long poll from the cursor. A reset is an error: the tests that follow a feed never expect one. */
  async poll(waitMs = 2_000): Promise<RosterDelta[]> {
    const batch = await this.request(this.cursor, waitMs);
    if (batch.resetRequired) throw new Error(`roster feed (${this.window ?? 'all'}) asked for a reset at ${this.cursor}`);
    this.cursor = batch.revision;
    this.seen.push(...batch.deltas);
    return batch.deltas;
  }

  /** Keep polling until a delta (from index `from` of `seen`) matches. */
  waitFor(predicate: (delta: RosterDelta) => boolean, options: WaitOptions & { from?: number } = {}): Promise<RosterDelta> {
    const from = options.from ?? 0;
    return eventually(async () => {
      const found = this.seen.slice(from).find(predicate);
      if (found) return found;
      await this.poll();
      return this.seen.slice(from).find(predicate);
    }, { what: `a matching roster delta (${this.window ?? 'all'})`, intervalMs: 0, ...options });
  }

  /** Deltas for one session from index `from` of `seen`. */
  of(sessionId: string, from = 0): RosterDelta[] {
    return this.seen.slice(from).filter((delta) => delta.sessionId === sessionId);
  }
}
