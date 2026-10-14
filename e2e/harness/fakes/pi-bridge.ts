/**
 * The Pi bridge as a scripted session source: what the Pi extension posts to
 * the broker over HTTP. `hello` registers (or re-registers, replacing the
 * transcript) a session with its history, `events` appends live events, and
 * `bye` ends the extension's connection. No agent binary is involved.
 */
import { join } from 'node:path';
import type { Broker } from '../broker.ts';

export type PiEvent = Record<string, unknown> & { t: string };

export interface PiBridgeSession {
  readonly id: string;
  readonly sessionFile: string;
  /** Append live events, as the extension does during a turn. */
  events(events: PiEvent[]): Promise<void>;
  /** Re-register with a whole new transcript (an extension reload or a branch rewrite). */
  rehello(history: PiEvent[]): Promise<void>;
  bye(): Promise<void>;
}

/** `count` user rows `<prefix>-<i>`, the plainest transcript a bridge can carry. */
export function piUserRows(prefix: string, count: number, from = 0): PiEvent[] {
  return Array.from({ length: count }, (_, offset) => {
    const index = from + offset;
    return { t: 'user', key: `${prefix}-${index}`, text: `${prefix} row ${index}` };
  });
}

/** The same rows as finished assistant replies (`final` events append to history, not live). */
export function piFinalRows(prefix: string, count: number, from = 0): PiEvent[] {
  return Array.from({ length: count }, (_, offset) => {
    const index = from + offset;
    return { t: 'final', key: `${prefix}-${index}`, text: `${prefix} row ${index}` };
  });
}

let sessionSequence = 0;

export async function openPiBridgeSession(
  broker: Broker,
  history: PiEvent[],
  options: { title?: string; sessionFile?: string } = {},
): Promise<PiBridgeSession> {
  const client = broker.client();
  const sessionFile = options.sessionFile
    ?? join(broker.paths.root, `pi-session-${process.pid}-${++sessionSequence}.jsonl`);
  const hello = async (rows: PiEvent[]): Promise<string> => {
    const response = await client.post('/pi/bridge/hello', {
      sessionFile,
      cwd: broker.paths.home,
      title: options.title ?? 'history e2e',
      history: rows,
    });
    if (response.status !== 200) throw new Error(`pi bridge hello → ${response.status}: ${response.text.slice(0, 300)}`);
    return String(response.body.id);
  };
  const id = await hello(history);
  return {
    id,
    sessionFile,
    async events(events) {
      const response = await client.post('/pi/bridge/events', { id, events });
      if (!response.ok) throw new Error(`pi bridge events → ${response.status}: ${response.text.slice(0, 300)}`);
    },
    async rehello(rows) {
      const again = await hello(rows);
      if (again !== id) throw new Error(`re-hello moved the session: ${again} != ${id}`);
    },
    async bye() {
      const response = await client.post('/pi/bridge/bye', { id, reason: 'e2e' });
      if (!response.ok) throw new Error(`pi bridge bye → ${response.status}: ${response.text.slice(0, 300)}`);
    },
  };
}
