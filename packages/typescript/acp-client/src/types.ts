/**
 * Provider-neutral Agent Client Protocol (ACP) wire types.
 *
 * ACP is JSON-RPC 2.0 over newline-delimited stdio. These types describe the
 * wire floor shared by every ACP agent (reasonix, grok, cline `--acp`, …) and
 * carry NO cosyncing semantics: no session postures, no adapter concepts.
 * Unknown fields are preserved, not stripped — every payload interface keeps an
 * index signature so a vendor extra survives the round trip, and `_meta` is
 * passed through raw.
 */

/** JSON-RPC 2.0 permits String, Number, and Null request identifiers. */
export type JsonRpcId = string | number | null;

export const JSON_RPC_VERSION = '2.0' as const;

/** The JSON-RPC 2.0 error codes this client can name. */
export const JSON_RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/** Lower/upper bound of the reserved implementation-defined server-error range. */
export const JSON_RPC_SERVER_ERROR_RANGE: readonly [number, number] = [-32099, -32000];

export function isKnownErrorCode(code: number): boolean {
  const standard = Object.values(JSON_RPC_ERROR) as number[];
  if (standard.includes(code)) return true;
  return code >= JSON_RPC_SERVER_ERROR_RANGE[0] && code <= JSON_RPC_SERVER_ERROR_RANGE[1];
}

export interface JsonRpcRequest {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: typeof JSON_RPC_VERSION;
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResultResponse {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcOutbound = JsonRpcRequest | JsonRpcNotification | JsonRpcResultResponse | JsonRpcErrorResponse;

// ── Protocol version ─────────────────────────────────────────────────────────

/** The only ACP protocol major this client speaks. Untested majors fail closed. */
export const ACP_PROTOCOL_MAJOR = 1;

/**
 * Agents disagree on the encoding: reasonix answers `1` (number, measured
 * 2026-08-23), grok's own bundled docs show `"1"` and `1` in different pages.
 * Both are accepted.
 */
export type AcpProtocolVersion = number | string;

/**
 * Tolerant decode of a wire `protocolVersion`. Returns `undefined` when the
 * value is neither a non-negative safe integer nor its decimal string; the caller fails
 * closed on that and records the raw value on the trace.
 */
export function normalizeProtocolVersion(raw: unknown): { major: number; raw: unknown } | undefined {
  const parsed = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && raw.trim() !== ''
      ? Number(raw)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
  return { major: parsed, raw };
}

// ── Client → agent ───────────────────────────────────────────────────────────

/**
 * v1 offers NO client capabilities: `fs` and `terminal` stay absent so the
 * agent never calls `fs/*` or `terminal/*`. If one does anyway, the dispatcher
 * answers with a capability error and a trace — never a hang.
 */
export interface AcpClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean; [key: string]: unknown };
  terminal?: boolean;
  [key: string]: unknown;
}

export interface AcpClientInfo {
  name: string;
  version: string;
  [key: string]: unknown;
}

export interface AcpInitializeParams {
  protocolVersion: AcpProtocolVersion;
  clientCapabilities: AcpClientCapabilities;
  clientInfo?: AcpClientInfo;
  [key: string]: unknown;
}

export interface AcpInitializeResult {
  protocolVersion?: AcpProtocolVersion;
  agentCapabilities?: Record<string, unknown>;
  agentInfo?: { name?: string; version?: string; [key: string]: unknown };
  authMethods?: unknown[];
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Select one authentication method exactly as advertised by initialize. */
export interface AcpAuthenticateParams {
  methodId: string;
  [key: string]: unknown;
}

export interface AcpAuthenticateResult {
  [key: string]: unknown;
}

export interface AcpSessionNewParams {
  cwd: string;
  mcpServers?: unknown[];
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AcpSessionLoadParams {
  sessionId: string;
  cwd: string;
  mcpServers?: unknown[];
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AcpSessionNewResult {
  sessionId?: string;
  [key: string]: unknown;
}

/** `session/load` keeps the requested ID; ACP does not echo it in the result. */
export interface AcpSessionLoadResult {
  models?: Record<string, unknown> | null;
  modes?: Record<string, unknown> | null;
  configOptions?: unknown[] | null;
  _meta?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface AcpSessionListResult {
  sessions?: Array<{ sessionId?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface AcpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface AcpSessionPromptParams {
  sessionId: string;
  prompt: AcpContentBlock[];
  [key: string]: unknown;
}

export interface AcpSessionPromptResult {
  stopReason?: string;
  [key: string]: unknown;
}

export interface AcpSessionCloseParams {
  sessionId: string;
  [key: string]: unknown;
}

export interface AcpSessionCloseResult {
  [key: string]: unknown;
}

export interface AcpSetConfigOptionParams {
  sessionId: string;
  configId: string;
  value: string | boolean;
  type?: 'boolean';
  [key: string]: unknown;
}

export interface AcpSetConfigOptionResult {
  configOptions?: unknown[] | null;
  [key: string]: unknown;
}

// ── Agent → client ───────────────────────────────────────────────────────────

/**
 * Core `sessionUpdate` values plus the vendor extras measured so far.
 * Attribution (audit 2026-08-27): grok's `turn_completed`, `retry_state`,
 * `task_completed`, `task_backgrounded` are MEASURED from local
 * `updates.jsonl` (2026-08-23); only `plan` is in grok's bundled docs.
 * Anything outside this list is still delivered — raw — and traced as
 * `unknown-session-update`; it is never a throw.
 */
export const ACP_SESSION_UPDATE_KNOWN: readonly string[] = [
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'available_commands_update',
  'current_mode_update',
  // Cline 3.0.60 native ACP config and usage telemetry.
  'config_option_update',
  'usage_update',
  // Grok Build 1.0.13: bounded session title patch.
  'session_info_update',
  // grok vendor extras (measured, see header note)
  'turn_completed',
  'retry_state',
  'task_completed',
  'task_backgrounded',
];

export interface AcpSessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

export interface AcpSessionUpdateParams {
  sessionId?: string;
  update?: AcpSessionUpdate;
  [key: string]: unknown;
}

export interface AcpPermissionOption {
  optionId?: string;
  id?: string;
  name?: string;
  kind?: string;
  [key: string]: unknown;
}

export interface AcpRequestPermissionParams {
  sessionId?: string;
  toolCall?: Record<string, unknown>;
  options?: AcpPermissionOption[];
  [key: string]: unknown;
}

export type AcpPermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' };

export interface AcpRequestPermissionResult {
  outcome: AcpPermissionOutcome;
  [key: string]: unknown;
}

// ── Vendor extension namespaces ──────────────────────────────────────────────

/**
 * Namespaces with typed hooks. `_reasonix.io/*` is version-pinned to the
 * v1.25.2 shape; `_x.ai/*` is Grok's measured store/wire namespace and
 * `x.ai/*` is retained for the earlier documented spelling. Any OTHER method whose name starts with
 * `_` is a vendor namespace this client does not know: it is traced and never
 * executed.
 */
export const ACP_EXTENSION_NAMESPACES = ['_reasonix.io/', '_x.ai/', 'x.ai/'] as const;

export type AcpExtensionNamespace = 'reasonix' | 'xai';

export function extensionNamespaceFor(method: string): AcpExtensionNamespace | 'unknown' | null {
  if (method.startsWith('_reasonix.io/')) return 'reasonix';
  if (method.startsWith('_x.ai/')) return 'xai';
  if (method.startsWith('x.ai/')) return 'xai';
  if (method.startsWith('_')) return 'unknown';
  return null;
}

export interface AcpExtensionEvent {
  namespace: AcpExtensionNamespace;
  /** The full wire method, e.g. `_reasonix.io/session/status_update`. */
  method: string;
  params: unknown;
  kind: 'request' | 'notification';
}

/**
 * Per-namespace extension hook. A defined return value marks the method
 * handled (and becomes a request's JSON-RPC result); `undefined` refuses a
 * request as method-not-found or traces an unhandled notification. A throw is
 * answered with an internal error and traced.
 */
export type AcpExtensionHook = (event: AcpExtensionEvent) => unknown | Promise<unknown>;

// ── Hooks ────────────────────────────────────────────────────────────────────

export interface AcpClientHooks {
  /**
   * Every `session/update` notification, with the raw update preserved —
   * including values outside {@link ACP_SESSION_UPDATE_KNOWN}, which the
   * dispatcher also traces. The adapter's live mapper owns the semantics.
   */
  onSessionUpdate?: (params: AcpSessionUpdateParams) => void;
  /**
   * Answers the agent-issued `session/request_permission` request. When no
   * hook is registered the request is answered with a method-not-found error
   * and traced — a permission ask must never hang the agent.
   */
  onPermissionRequest?: (
    params: AcpRequestPermissionParams,
  ) => AcpRequestPermissionResult | Promise<AcpRequestPermissionResult>;
  /** Typed per-namespace vendor extension hooks. */
  extensions?: {
    reasonix?: AcpExtensionHook;
    xai?: AcpExtensionHook;
  };
}

// ── Trace ────────────────────────────────────────────────────────────────────

/**
 * Traceable swallowed failures: every degradation the dispatcher absorbs emits
 * one of these, naming the operation. Degrading is fine; degrading silently is
 * the defect.
 */
export type AcpTraceKind =
  | 'malformed-envelope'
  | 'uncorrelated-response'
  | 'unknown-method'
  | 'unknown-session-update'
  | 'unknown-error-code'
  | 'capability-refused'
  | 'unhandled-extension'
  | 'extension-error'
  | 'unsupported-protocol-version'
  | 'request-timeout'
  | 'oversized-frame'
  | 'child-exit'
  | 'child-stderr';

export interface AcpTraceEvent {
  /** The operation in flight, e.g. `initialize`, `session/prompt`, `inbound-frame`. */
  op: string;
  kind: AcpTraceKind;
  message: string;
  /** Raw envelope, version value, exit record… bounded by the emitter. */
  detail?: unknown;
}

export type AcpTraceSink = (event: AcpTraceEvent) => void;

/** Default sink: nothing this client absorbs is ever silent. */
export const stderrTraceSink: AcpTraceSink = (event) => {
  console.error(`[acp-client] ${event.kind} op=${event.op}: ${event.message}`);
};

/** Bound a raw envelope before it lands on a trace line. */
export function boundedTraceDetail(value: unknown, maxChars = 1_024): unknown {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > maxChars ? `${text.slice(0, maxChars)}…(+${text.length - maxChars} chars)` : value;
  } catch {
    return String(value);
  }
}
