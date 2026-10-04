/**
 * The 0.2 web contract: Typert Remote endpoints over `POST /api/<namespace>/<method>`.
 *
 * Three things changed from 0.1 and all three are enforced structurally here.
 *
 * ROUTES. The host no longer serves a flat `RpcMethodMap`. It serves
 * `namespace/method` endpoints whose payload is `{args:{…}}` with NAMED fields,
 * and the gateway matches those field names against a generated descriptor — an
 * extra key and a missing key are both rejected with
 * `gateway/arguments-invalid`, before any business code runs. The same rule
 * applies in reverse to this client: {@link DSH_REMOTE_ENDPOINTS} is the only
 * set of endpoints a request can be built for, so the reachable surface is a
 * frozen list a reviewer can read rather than a string a caller assembled.
 *
 * ARGUMENT NAMES. `session/list` names its parameter `_request`; every other
 * session endpoint names it `request`; `commands/*` and `userQuestions/*` take
 * their arguments as top-level named fields. These are not interchangeable and
 * no amount of plausible naming makes them so. The names live in the generated
 * descriptor shipped by the host package, and each one here carries the fixture
 * id that pins it.
 *
 * AUTHENTICATION. Every request here can carry a session cookie, and the host
 * refuses the request without one. Headers are therefore pulled per call rather
 * than captured at construction: a cookie renewed between two calls must be
 * used by the second one.
 */
import { DshUnaryTransport, transportFailure, type DshFetch, type DshOutcome, type DshUnaryCallOptions } from './envelope.ts';

/** The gateway's own error-code namespace, for the codes this client must read. */
export const DSH_GATEWAY_ERROR_CODES = Object.freeze([
  'gateway/arguments-invalid',
  'gateway/definition-unavailable',
  'gateway/input-invalid',
  'gateway/method-unavailable',
  'gateway/protocol',
  'gateway/service-unavailable',
  'gateway/signature-invalid',
  'gateway/uplink-overflow',
  'session/writer-held',
  'session/model-unavailable',
] as const);

/**
 * Endpoints this adapter may call.
 *
 * Every entry is one cosyncing feature, and each was read out of the host's own
 * generated descriptor array rather than inferred from a route name. Adding a
 * line here means adding the feature it serves, its fixture sample, and its
 * test; that is the point of the list.
 */
export const DSH_REMOTE_ENDPOINTS = Object.freeze([
  '$events/result',
  'commands/execute',
  'commands/list',
  'permissionPresets/catalog',
  'session/attachment',
  'session/cancel',
  'session/create',
  'session/list',
  'session/modelCatalog',
  'session/page',
  'session/projections',
  'session/prompt',
  'session/rename',
  'session/selectModel',
  'session/updateQueue',
  'userQuestions/answer',
  'workspace/initializeDefault',
] as const);

export type DshRemoteEndpoint = typeof DSH_REMOTE_ENDPOINTS[number];

/**
 * Remote endpoints the 0.2 host serves that this adapter does NOT call, listed
 * so the structural test can prove each is refused and so a widening is an edit
 * to a frozen list. Two families are here for different reasons and the
 * difference matters:
 *
 *  - `session/fork`, `session/search`, `goal/*`, `schedule/*`,
 *    `pluginManager/*`, `settings/*`, `credentials/*`, `account/*` are features
 *    cosyncing has not built. They stay here on purpose.
 *  - `session/control`, `session/follow`, `workspace/follow`, `job/list`,
 *    `job/follow`, `userQuestions/attachWait` are STREAMS. They are reached
 *    through the mux carrier, and posting them to `/api/...` is not a
 *    conservative fallback but a `gateway/signature-invalid` error, because the
 *    gateway refuses to open a stream method through the unary carrier.
 */
export const DSH_DEFERRED_REMOTE_ENDPOINTS: readonly string[] = Object.freeze([
  'account/getState',
  'agentPresets/list',
  'directoryPicker/list',
  'goals/create',
  'goals/edit',
  'goals/pause',
  'goals/resume',
  'goals/complete',
  'goals/clear',
  'job/kill',
  'llm/listProviders',
  'llm/listConfigurableProviders',
  'llm/discoverModels',
  'messageFeedback/put',
  'pluginInventory/list',
  'pluginManager/listPlugins',
  'schedule/list',
  'settings/describe',
  'settings/mutate',
  'settings/replace',
  'settings/update',
  'session/fork',
  'session/openWorkspacePath',
  'session/search',
  'skills/list',
  'subagents/prompt',
  'subagents/interruptByParent',
  'terminal/create',
  'terminal/list',
  'terminal/write',
  'workspace/create',
  'workspace/delete',
  'workspace/rename',
  'workspace/archiveSession',
  'workspace/unarchiveSession',
  'workspace/insertBefore',
  'workspace/insertSessionBefore',
  'workspace/pinSession',
  'workspace/unpinSession',
]);

/** Stream-only endpoints, named separately because a unary POST to one is a bug, not a fallback. */
export const DSH_STREAM_ONLY_ENDPOINTS: readonly string[] = Object.freeze([
  '$events',
  'job/follow',
  'job/list',
  'session/control',
  'session/follow',
  'userQuestions/attachWait',
  'workspace/follow',
]);

export function isDshRemoteEndpoint(value: string): value is DshRemoteEndpoint {
  return (DSH_REMOTE_ENDPOINTS as readonly string[]).includes(value);
}

/** Raised when a caller asks for an endpoint outside {@link DSH_REMOTE_ENDPOINTS}. */
export class DshRouteNotAllowedError extends Error {
  constructor(readonly route: string) {
    super(`dsh remote endpoint "${route}" is outside the allowlist`);
    this.name = 'DshRouteNotAllowedError';
  }
}

/** The ONE place a Remote path is produced. */
export function dshRemotePath(endpoint: string): string {
  if (!isDshRemoteEndpoint(endpoint)) throw new DshRouteNotAllowedError(endpoint);
  return `/api/${endpoint}`;
}

// ── Argument shapes ─────────────────────────────────────────────────────────

/**
 * A session-addressed request. `session/follow` and `session/page` both take an
 * `address`, and the subagent form is deliberately unreachable from here:
 * cosyncing surfaces ordinary sessions, and an address that names a child would
 * need its parent's identity to be meaningful.
 */
export function dshSessionAddress(sessionId: string): { kind: 'session'; sessionId: string } {
  return { kind: 'session', sessionId };
}

/** Named `args` builders, one per endpoint shape. */
export const DshRemoteArgs = Object.freeze({
  list: (request?: { cursor?: string }): Record<string, unknown> => ({ _request: request ?? {} }),
  page: (request: {
    sessionId: string;
    throughSeq: number;
    beforeSeq?: number;
    maxMessages?: number;
    turnWindow?: { minMessages: number; minTurns: number };
  }): Record<string, unknown> => ({
    request: {
      address: dshSessionAddress(request.sessionId),
      throughSeq: request.throughSeq,
      ...(request.beforeSeq === undefined ? {} : { beforeSeq: request.beforeSeq }),
      ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
      ...(request.turnWindow === undefined ? {} : { turnWindow: request.turnWindow }),
    },
  }),
  follow: (request: {
    sessionId: string;
    assistantStream?: boolean;
    maxMessages?: number;
    turnWindow?: { minMessages: number; minTurns: number };
  }): Record<string, unknown> => ({
    request: {
      address: dshSessionAddress(request.sessionId),
      ...(request.assistantStream === undefined ? {} : { assistantStream: request.assistantStream }),
      ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
      ...(request.turnWindow === undefined ? {} : { turnWindow: request.turnWindow }),
    },
  }),
  create: (request?: { workspaceId?: string; cwd?: string; sessionId?: string; agentPreset?: string }): Record<string, unknown> => ({
    request: request ?? {},
  }),
  rename: (sessionId: string, title: string): Record<string, unknown> => ({ request: { sessionId, title } }),
  cancel: (sessionId: string): Record<string, unknown> => ({ request: { sessionId } }),
  prompt: (request: {
    requestId: string;
    sessionId: string;
    mode: 'queue' | 'steer';
    content: readonly unknown[];
    clientTimeZone?: string;
  }): Record<string, unknown> => ({
    request: {
      requestId: request.requestId,
      sessionId: request.sessionId,
      mode: request.mode,
      content: request.content,
      ...(request.clientTimeZone === undefined ? {} : { clientTimeZone: request.clientTimeZone }),
    },
  }),
  modelCatalog: (): Record<string, unknown> => ({}),
  selectModel: (request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Record<string, unknown> => ({
    request: {
      sessionId: request.sessionId,
      provider: request.provider,
      model: request.model,
      ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    },
  }),
  projections: (sessionId: string): Record<string, unknown> => ({ request: { sessionId } }),
  attachment: (sessionId: string, attachmentId: string): Record<string, unknown> => ({ request: { sessionId, attachmentId } }),
  updateQueue: (request: Record<string, unknown>): Record<string, unknown> => ({ request }),
  permissionCatalog: (): Record<string, unknown> => ({}),
  commands: (agentId: string): Record<string, unknown> => ({ agentId }),
  execute: (agentId: string, line: string, submittedAttachments: readonly unknown[]): Record<string, unknown> => ({
    agentId,
    line,
    submittedAttachments,
  }),
  answerQuestion: (agentId: string, callId: string, answer: unknown): Record<string, unknown> => ({
    agentId,
    callId,
    answer,
  }),
  eventResult: (result: { clientId: string; eventId: string; outcome: unknown }): Record<string, unknown> => ({
    clientId: result.clientId,
    eventId: result.eventId,
    outcome: result.outcome,
  }),
});

// ── Forwarded-event payloads ────────────────────────────────────────────────

/** The opening item of one event generation. Nothing may be trusted before it. */
export interface DshEventReadyFrame {
  type: 'ready';
  clientId: string;
  host: { home: string };
}

export interface DshEventEmitFrame {
  type: 'emit';
  event: string;
  args: readonly unknown[];
}

export interface DshEventWaterfallFrame {
  type: 'waterfall';
  event: string;
  eventId: string;
  agentId: string;
  request: Readonly<Record<string, unknown>>;
}

export interface DshEventCancellationFrame {
  type: 'cancel';
  eventId: string;
}

export type DshEventFrame =
  | DshEventReadyFrame
  | DshEventEmitFrame
  | DshEventWaterfallFrame
  | DshEventCancellationFrame;

/** What a client may answer a waterfall with. `next` delegates to the host's own chain. */
export type DshEventOutcome =
  | { kind: 'next' }
  | { kind: 'result'; value?: unknown }
  | { kind: 'rejected'; error: { name: string; message: string; code?: string; details?: unknown } };

/** Validate one event-stream item. Anything else ends the generation, not merely the item. */
export function parseDshEventFrame(value: unknown): DshEventFrame | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case 'ready': {
      const host = record.host as { home?: unknown } | undefined;
      if (typeof record.clientId !== 'string' || record.clientId === '') return null;
      if (!host || typeof host.home !== 'string') return null;
      return { type: 'ready', clientId: record.clientId, host: { home: host.home } };
    }
    case 'emit': {
      if (typeof record.event !== 'string' || !Array.isArray(record.args)) return null;
      return { type: 'emit', event: record.event, args: record.args as readonly unknown[] };
    }
    case 'waterfall': {
      const request = record.request as Record<string, unknown> | undefined;
      if (typeof record.event !== 'string') return null;
      if (typeof record.eventId !== 'string' || record.eventId === '') return null;
      if (typeof record.agentId !== 'string' || record.agentId === '') return null;
      if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
      return { type: 'waterfall', event: record.event, eventId: record.eventId, agentId: record.agentId, request };
    }
    case 'cancel': {
      if (typeof record.eventId !== 'string' || record.eventId === '') return null;
      return { type: 'cancel', eventId: record.eventId };
    }
    default:
      return null;
  }
}

// ── Client ──────────────────────────────────────────────────────────────────

export interface DshRemoteClientOptions {
  baseUrl: string;
  /** Per-call request headers. Read at request time, never captured once. */
  headers?: () => Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: DshFetch;
  newRpcId?: () => string;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/**
 * One 0.2 unary caller.
 *
 * There is deliberately no `respond` here and no fallback to the legacy client
 * anywhere in this class. A waterfall answer travels to `$events/result` with
 * the event generation's own `clientId`, and an answer that reaches the wrong
 * generation is not merely dropped — it is a decision attributed to an event
 * stream that may already have been replaced.
 */
export class DshRemoteClient {
  private readonly transport: DshUnaryTransport;

  constructor(options: DshRemoteClientOptions) {
    this.transport = new DshUnaryTransport({
      baseUrl: options.baseUrl,
      pathFor: (route) => {
        try {
          return dshRemotePath(route);
        } catch {
          return null;
        }
      },
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.newRpcId === undefined ? {} : { newRpcId: options.newRpcId }),
      ...(options.setTimeout === undefined ? {} : { setTimeout: options.setTimeout }),
      ...(options.clearTimeout === undefined ? {} : { clearTimeout: options.clearTimeout }),
    });
  }

  get origin(): string {
    return this.transport.origin;
  }

  /** Abort epoch-bound in-flight calls when the carrier generation ends. */
  abortInFlight(): void {
    this.transport.abortInFlight();
  }

  /**
   * Call one endpoint with its exact named `args`.
   *
   * The `method` inside the envelope is the endpoint string itself, which is
   * what the host's connection layer matches the path against; both halves come
   * from the same allowlisted constant, so a body can never disagree with the
   * URL it is posted to.
   */
  call<T>(
    endpoint: DshRemoteEndpoint,
    args: Readonly<Record<string, unknown>>,
    options?: DshUnaryCallOptions,
  ): Promise<DshOutcome<T>> {
    if (!isDshRemoteEndpoint(endpoint)) {
      return Promise.resolve(transportFailure('route-not-allowed', { retryable: false, detail: String(endpoint) }));
    }
    return this.transport.call<T>(endpoint, endpoint, { args }, options);
  }

  /**
   * Settle one forwarded waterfall.
   *
   * `clientId` must be the one this generation's `ready` frame carried. The
   * host drops a result that names no active event stream, so a stale id is
   * silently not an answer, and the caller has to be able to tell that apart
   * from a decision the host accepted.
   */
  answerEvent(clientId: string, eventId: string, outcome: DshEventOutcome): Promise<DshOutcome<unknown>> {
    return this.call<unknown>('$events/result', DshRemoteArgs.eventResult({ clientId, eventId, outcome }));
  }
}
