import type { AgentOption, ModelOption, ModeOption, SessionConnection } from '@cosyncing/protocol';

export interface SessionOptions {
  models: ModelOption[];
  agents: AgentOption[];
  modes: ModeOption[];
}

/** Collect the attach-time picker options (models/agents/modes) with PER-SURFACE fault isolation.
 *
 *  The original inline `Promise.all` had a recurring failure shape (issues-part2 re-flag: "no model
 *  selection for a newly created session"): ONE rejecting surface — e.g. `model/list` timing out on
 *  a codex daemon that is still starting the just-created thread — rejected the whole combine, the
 *  caller's catch swallowed it, and the socket never received an options frame at all (the all-empty
 *  retry never ran because nothing returned). Each list now fails soft to [], so a transient failure
 *  in one surface cannot blank the others, and an all-empty result returns null so the caller keeps
 *  retrying on a bounded schedule. */
export async function collectSessionOptions(conn: SessionConnection): Promise<SessionOptions | null> {
  const soft = async <T>(p: Promise<T[]> | T[] | undefined): Promise<T[]> => {
    try {
      return (await p) ?? [];
    } catch {
      return [];
    }
  };
  const [models, agents, modes] = await Promise.all([
    soft(conn.listModels?.()),
    soft(conn.listAgents?.()),
    soft(conn.listModes?.()),
  ]);
  if (!models.length && !agents.length && !modes.length) return null;
  return { models, agents, modes };
}

/** Stable, field-complete signature for the picker catalog.
 *
 *  Options are adapter-owned opaque values. In particular, a native Codex update can replace one
 *  effort with another (or add Ultra while removing a stale effort) without changing any list
 *  length. Keep the schema explicit instead of stringifying arbitrary object key order, and include
 *  every field that changes picker meaning or copy. Advertised order is meaningful UI order. */
export function sessionOptionsSignature(options: SessionOptions): string {
  return JSON.stringify([
    options.models.map((model) => [
      model.providerID,
      model.modelID,
      model.variant ?? null,
      model.label,
      model.description ?? null,
      (model.reasoningEfforts ?? []).map((effort) => [
        effort.effort,
        effort.label,
        effort.description ?? null,
      ]),
      model.defaultReasoningEffort ?? null,
    ]),
    options.agents.map((agent) => [agent.name, agent.description ?? null]),
    options.modes.map((mode) => [
      mode.value,
      mode.label,
      mode.description ?? null,
      mode.category ?? null,
    ]),
  ]);
}

/** True when `next` differs semantically from what was already sent.
 *
 *  The app overwrites its pickers wholesale on every options frame, so identical results stay
 *  quiet while same-length native catalog changes are delivered. */
export function optionsChanged(next: SessionOptions, sent: SessionOptions | null): boolean {
  if (!sent) return true;
  return sessionOptionsSignature(next) !== sessionOptionsSignature(sent);
}

/** Attach-time refresh delays for a catalog that may still be loading or changing.
 *
 *  A backing service that is starting (managed opencode serve — a restart takes 10-20s — or a
 *  Codex daemon spawning the just-created thread) usually settles within this window. A non-empty
 *  model list does not prove the catalog is complete: Codex can first advertise Sol/Max and add
 *  Ultra later without changing the model count. The ladder therefore always runs to completion;
 *  semantic comparison keeps identical frames quiet. Bounded — after the last attempt the socket
 *  has what it has until reattach. */
export const SESSION_OPTIONS_RETRY_DELAYS_MS = [3000, 8000, 15000, 30000] as const;

type SessionOptionsWait = (delayMs: number) => Promise<void>;

export interface SessionOptionsRefreshConfig {
  delays?: readonly number[];
  wait?: SessionOptionsWait;
  signal?: AbortSignal;
}

async function waitForSessionOptionsRefresh(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Collect and send semantically distinct attach-time option frames over the bounded refresh ladder.
 *
 *  The injected waiter keeps the real runtime timer-based while allowing a caller-level regression
 *  to execute the exact loop without waiting 56 seconds. */
export async function refreshSessionOptions(
  conn: SessionConnection,
  send: (options: SessionOptions) => void,
  config: SessionOptionsRefreshConfig = {},
): Promise<void> {
  const {
    delays = SESSION_OPTIONS_RETRY_DELAYS_MS,
    signal,
  } = config;
  const wait = config.wait ?? ((delayMs) => waitForSessionOptionsRefresh(delayMs, signal));
  let sent: SessionOptions | null = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (signal?.aborted) return;
    const options = await collectSessionOptions(conn).catch(() => null);
    if (signal?.aborted) return;
    if (options && optionsChanged(options, sent)) {
      send(options);
      sent = options;
    }
    const delay = delays[attempt];
    if (delay === undefined) return;
    await wait(delay);
    if (signal?.aborted) return;
  }
}
