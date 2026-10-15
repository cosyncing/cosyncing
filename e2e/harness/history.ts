/**
 * History-window helpers: the requests a client sends to page and refresh a
 * transcript, and the broker's native-read ledger.
 *
 * A history request is answered by one frame naming its `clientMessageId`: a
 * `history` frame for `history-refresh`, a `history-page` frame for
 * `history-page`, or a `nack`. `ask()` sends one and waits for exactly that.
 *
 * The ledger is the broker's own record of every native history read (one
 * line per read, appended before the read starts) in the file named by
 * `COSYNCING_TEST_HISTORY_READ_LOG`. A read always precedes the frame it
 * produced, so once a test holds that frame the ledger already counts it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Broker, FixturePaths } from './broker.ts';
import type { Frame, SessionStream } from './client.ts';
import type { WaitOptions } from './wait.ts';

/** Environment that turns on the read ledger, for `startBroker({ env })`. */
export function historyReadLedgerEnv(paths: FixturePaths): Record<string, string> {
  return { COSYNCING_TEST_HISTORY_READ_LOG: join(paths.root, 'history-reads.log') };
}

/** Every native read the broker made so far, as `<kind> <tool>:<id>`. */
export function historyReads(broker: Broker): string[] {
  const path = join(broker.paths.root, 'history-reads.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}

/** Reads of one session, optionally of one kind (`attach`, `refresh`, `page-cache-miss`, ...). */
export function sessionReads(broker: Broker, tool: string, id: string, kind?: string): number {
  return historyReads(broker).filter((line) => {
    const [lineKind, session] = line.split(' ');
    return session === `${tool}:${id}` && (kind === undefined || lineKind === kind);
  }).length;
}

let requestSequence = 0;

/**
 * Send a history request with a fresh `clientMessageId` (unless it names one)
 * and wait for the frame that answers it.
 */
export async function ask(
  stream: SessionStream,
  request: Record<string, unknown>,
  options: WaitOptions = {},
): Promise<Frame> {
  const clientMessageId = (request.clientMessageId as string | undefined) ?? `history-${++requestSequence}`;
  const after = stream.frames.length;
  stream.send({ ...request, clientMessageId });
  const answers = request.kind === 'history-refresh' ? 'history' : 'history-page';
  return stream.waitForFrame(
    (frame) => frame.clientMessageId === clientMessageId && (frame.kind === answers || frame.kind === 'nack'),
    { what: `the answer to ${String(request.kind)} ${clientMessageId}`, after, ...options },
  );
}

/** The first `history` frame on a stream: the attach frame. */
export function attachFrame(stream: SessionStream, options: WaitOptions = {}): Promise<Frame> {
  return stream.waitForKind('history', { what: 'the attach history frame', ...options });
}

/**
 * The window one attach delivered: the attach frame's rows, then the rows sent
 * right after it (while a turn runs the frame ends at the running-turn hold and
 * the rows it held follow it).
 */
export function windowAfterAttach(stream: SessionStream): any[] {
  const at = stream.frames.findIndex((frame) => frame.kind === 'history');
  if (at < 0) return [];
  return [
    ...(stream.frames[at]!.messages as any[] ?? []),
    ...stream.frames.slice(at + 1).filter((frame) => frame.kind === 'message').map((frame) => frame.message),
  ];
}

/** A row's identity as a client merges it. */
export function rowKey(message: any): string {
  return `${message?.type}:${message?.key ?? message?.requestId ?? message?.callId ?? ''}`;
}
