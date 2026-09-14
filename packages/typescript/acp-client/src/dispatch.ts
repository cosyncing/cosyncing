/**
 * The ONE dispatcher every inbound frame passes through (plan §"Traceable
 * swallowed failures"): requests, responses, notifications, errors. Unknown
 * methods, unknown `sessionUpdate` values, unknown error codes, malformed
 * envelopes, and unroutable extensions each emit a structured trace line
 * naming the operation — nothing degrades silently, and there is no bare
 * `catch {}` in the frame path.
 */
import {
  ACP_SESSION_UPDATE_KNOWN,
  JSON_RPC_ERROR,
  boundedTraceDetail,
  extensionNamespaceFor,
  isKnownErrorCode,
  type AcpClientHooks,
  type AcpExtensionHook,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResult,
  type AcpSessionUpdateParams,
  type AcpTraceSink,
  type JsonRpcErrorObject,
  type JsonRpcId,
} from './types.ts';

export interface AcpDispatchContext {
  trace: AcpTraceSink;
  hooks: AcpClientHooks;
  /**
   * Resolve an inbound response against the client's pending table. Returns
   * false when no request is waiting on that id.
   */
  resolveResponse: (id: JsonRpcId, result: unknown, error: JsonRpcErrorObject | undefined) => boolean;
  /** Answer an agent-issued request. Both no-ops when the child is gone. */
  sendResult: (id: JsonRpcId, result: unknown) => void;
  sendError: (id: JsonRpcId, code: number, message: string, data?: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === 'string' || typeof value === 'number';
}

export class AcpDispatcher {
  private readonly ctx: AcpDispatchContext;

  constructor(ctx: AcpDispatchContext) {
    this.ctx = ctx;
  }

  /** The single entry point: one raw stdout line from the child. */
  dispatchLine(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      this.ctx.trace({
        op: 'inbound-frame',
        kind: 'malformed-envelope',
        message: 'child emitted a line that is not JSON',
        detail: boundedTraceDetail(line),
      });
      return;
    }
    this.dispatchFrame(frame);
  }

  dispatchFrame(frame: unknown): void {
    if (!isRecord(frame)) {
      this.ctx.trace({
        op: 'inbound-frame',
        kind: 'malformed-envelope',
        message: 'frame is not a JSON object',
        detail: boundedTraceDetail(frame),
      });
      return;
    }
    if (frame.jsonrpc !== '2.0') {
      this.ctx.trace({
        op: 'inbound-frame',
        kind: 'malformed-envelope',
        message: 'frame does not declare JSON-RPC version 2.0',
        detail: boundedTraceDetail(frame),
      });
      return;
    }
    const method = typeof frame.method === 'string' ? frame.method : undefined;
    const id = isId(frame.id) ? frame.id : undefined;
    if (method !== undefined) {
      if (id !== undefined) {
        void this.dispatchRequest(id, method, frame.params);
      } else {
        this.dispatchNotification(method, frame.params);
      }
      return;
    }
    if (id !== undefined && ('result' in frame || 'error' in frame)) {
      this.dispatchResponse(id, frame);
      return;
    }
    this.ctx.trace({
      op: 'inbound-frame',
      kind: 'malformed-envelope',
      message: 'frame is neither request, notification, nor response',
      detail: boundedTraceDetail(frame),
    });
  }

  // ── Responses to client-issued requests ────────────────────────────────────

  private dispatchResponse(id: JsonRpcId, frame: Record<string, unknown>): void {
    let error: JsonRpcErrorObject | undefined;
    if ('error' in frame) {
      const raw = frame.error;
      if (isRecord(raw) && typeof raw.code === 'number' && typeof raw.message === 'string') {
        error = { code: raw.code, message: raw.message, data: raw.data };
        if (!isKnownErrorCode(raw.code)) {
          this.ctx.trace({
            op: 'inbound-response',
            kind: 'unknown-error-code',
            message: `agent answered with an unrecognized error code ${raw.code}`,
            detail: boundedTraceDetail(raw),
          });
        }
      } else {
        this.ctx.trace({
          op: 'inbound-response',
          kind: 'malformed-envelope',
          message: 'response error member is not a JSON-RPC error object',
          detail: boundedTraceDetail(raw),
        });
        error = { code: JSON_RPC_ERROR.internalError, message: 'malformed error object from agent' };
      }
    }
    if (!this.ctx.resolveResponse(id, frame.result, error)) {
      this.ctx.trace({
        op: 'inbound-response',
        kind: 'uncorrelated-response',
        message: `response id ${JSON.stringify(id)} matches no pending request`,
        detail: boundedTraceDetail(frame),
      });
    }
  }

  // ── Agent-issued requests (the client is the server side) ─────────────────

  private async dispatchRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    if (method === 'session/request_permission') {
      const handler = this.ctx.hooks.onPermissionRequest;
      if (!handler) {
        this.ctx.trace({
          op: method,
          kind: 'unknown-method',
          message: 'agent asked for permission but no onPermissionRequest hook is registered',
          detail: boundedTraceDetail(params),
        });
        this.ctx.sendError(id, JSON_RPC_ERROR.methodNotFound, 'client has no permission handler');
        return;
      }
      try {
        const result: AcpRequestPermissionResult = await handler(
          isRecord(params) ? (params as AcpRequestPermissionParams) : {},
        );
        this.ctx.sendResult(id, result);
      } catch (error) {
        this.ctx.trace({
          op: method,
          kind: 'extension-error',
          message: `permission hook threw: ${errorMessage(error)}`,
          detail: boundedTraceDetail(params),
        });
        this.ctx.sendError(id, JSON_RPC_ERROR.internalError, 'permission handler failed');
      }
      return;
    }
    if (method.startsWith('fs/') || method.startsWith('terminal/')) {
      // v1 declares both capabilities absent in initialize. A call anyway is a
      // capability error with a trace — never a hang.
      this.ctx.trace({
        op: method,
        kind: 'capability-refused',
        message: 'agent called a client capability this client did not offer',
        detail: boundedTraceDetail(params),
      });
      this.ctx.sendError(id, JSON_RPC_ERROR.methodNotFound, `capability ${method} not offered by this client`);
      return;
    }
    if (await this.routeExtension(id, method, params, 'request')) return;
    this.ctx.trace({
      op: method,
      kind: 'unknown-method',
      message: 'agent issued a request this client does not implement',
      detail: boundedTraceDetail(params),
    });
    this.ctx.sendError(id, JSON_RPC_ERROR.methodNotFound, `unknown method ${method}`);
  }

  // ── Notifications ──────────────────────────────────────────────────────────

  private dispatchNotification(method: string, params: unknown): void {
    if (method === 'session/update') {
      this.dispatchSessionUpdate(params);
      return;
    }
    if (method.startsWith('fs/') || method.startsWith('terminal/')) {
      this.ctx.trace({
        op: method,
        kind: 'capability-refused',
        message: 'agent notified a client capability this client did not offer',
        detail: boundedTraceDetail(params),
      });
      return;
    }
    if (this.routeExtensionSync(method, params)) return;
    this.ctx.trace({
      op: method,
      kind: 'unknown-method',
      message: 'agent sent a notification this client does not implement',
      detail: boundedTraceDetail(params),
    });
  }

  private dispatchSessionUpdate(params: unknown): void {
    const update = isRecord(params) && isRecord(params.update) ? params.update : undefined;
    const sessionUpdate = typeof update?.sessionUpdate === 'string' ? update.sessionUpdate : undefined;
    if (sessionUpdate === undefined) {
      this.ctx.trace({
        op: 'session/update',
        kind: 'malformed-envelope',
        message: 'session/update carries no update.sessionUpdate string',
        detail: boundedTraceDetail(params),
      });
      return;
    }
    if (!ACP_SESSION_UPDATE_KNOWN.includes(sessionUpdate)) {
      // Unknown values route to the adapter's named neutral category via the
      // same hook, raw — never a throw — and the swallow is traced.
      this.ctx.trace({
        op: 'session/update',
        kind: 'unknown-session-update',
        message: `unrecognized sessionUpdate value ${JSON.stringify(sessionUpdate)}`,
        detail: boundedTraceDetail(update),
      });
    }
    const handler = this.ctx.hooks.onSessionUpdate;
    if (!handler) return;
    try {
      handler(params as AcpSessionUpdateParams);
    } catch (error) {
      this.ctx.trace({
        op: 'session/update',
        kind: 'extension-error',
        message: `onSessionUpdate hook threw: ${errorMessage(error)}`,
        detail: boundedTraceDetail(update),
      });
    }
  }

  // ── Vendor extension namespaces ────────────────────────────────────────────

  /** Route a request into a typed namespace hook. Returns true when routed. */
  private async routeExtension(
    id: JsonRpcId,
    method: string,
    params: unknown,
    kind: 'request',
  ): Promise<boolean> {
    const namespace = extensionNamespaceFor(method);
    if (namespace === null) return false;
    if (namespace === 'unknown') {
      this.hookFor(namespace, method);
      this.ctx.sendError(id, JSON_RPC_ERROR.methodNotFound, `unhandled extension ${method}`);
      return true;
    }
    const hook = this.hookFor(namespace, method);
    if (!hook) {
      this.ctx.sendError(id, JSON_RPC_ERROR.methodNotFound, `unhandled extension ${method}`);
      return true;
    }
    try {
      const result = await hook({ namespace, method, params, kind });
      if (result === undefined) {
        this.ctx.trace({
          op: method,
          kind: 'unhandled-extension',
          message: `extension hook did not implement request ${method}`,
          detail: boundedTraceDetail(params),
        });
        this.ctx.sendError(id, JSON_RPC_ERROR.methodNotFound, `unhandled extension ${method}`);
      } else {
        this.ctx.sendResult(id, result);
      }
    } catch (error) {
      this.ctx.trace({
        op: method,
        kind: 'extension-error',
        message: `extension hook threw: ${errorMessage(error)}`,
        detail: boundedTraceDetail(params),
      });
      this.ctx.sendError(id, JSON_RPC_ERROR.internalError, `extension handler for ${method} failed`);
    }
    return true;
  }

  /** Route a notification into a typed namespace hook. Returns true when routed. */
  private routeExtensionSync(method: string, params: unknown): boolean {
    const namespace = extensionNamespaceFor(method);
    if (namespace === null) return false;
    if (namespace === 'unknown') {
      this.hookFor(namespace, method);
      return true;
    }
    const hook = this.hookFor(namespace, method);
    if (!hook) return true;
    try {
      const out = hook({ namespace, method, params, kind: 'notification' });
      if (out && typeof (out as Promise<unknown>).then === 'function') {
        void (out as Promise<unknown>)
          .then((result) => {
            if (result === undefined) this.traceUnhandledExtensionNotification(method, params);
          })
          .catch((error: unknown) => {
            this.ctx.trace({
              op: method,
              kind: 'extension-error',
              message: `extension hook rejected: ${errorMessage(error)}`,
              detail: boundedTraceDetail(params),
            });
          });
      } else if (out === undefined) {
        this.traceUnhandledExtensionNotification(method, params);
      }
    } catch (error) {
      this.ctx.trace({
        op: method,
        kind: 'extension-error',
        message: `extension hook threw: ${errorMessage(error)}`,
        detail: boundedTraceDetail(params),
      });
    }
    return true;
  }

  private traceUnhandledExtensionNotification(method: string, params: unknown): void {
    this.ctx.trace({
      op: method,
      kind: 'unhandled-extension',
      message: `extension hook did not implement notification ${method}`,
      detail: boundedTraceDetail(params),
    });
  }

  /**
   * The hook for a known namespace, or undefined — with the trace for the two
   * refuse cases: an unregistered known namespace, and any other `_*`
   * namespace, which is traced and NEVER executed.
   */
  private hookFor(namespace: 'reasonix' | 'xai' | 'unknown', method: string): AcpExtensionHook | undefined {
    if (namespace === 'unknown') {
      this.ctx.trace({
        op: method,
        kind: 'unhandled-extension',
        message: 'vendor extension namespace this client does not know; traced, never executed',
        detail: undefined,
      });
      return undefined;
    }
    const hook = this.ctx.hooks.extensions?.[namespace];
    if (!hook) {
      this.ctx.trace({
        op: method,
        kind: 'unhandled-extension',
        message: `no hook registered for the ${namespace} extension namespace`,
        detail: undefined,
      });
    }
    return hook;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
