/**
 * WebSocket guardrails for the current full-history attach protocol.
 *
 * These are deliberately split:
 * - maxPayloadLength is for client -> broker frames.
 * - backpressureLimit is the broker -> client outbound queue ceiling that matters for a large
 *   history frame.
 *
 * This is an interim stopgap until docs/architecture/client-ui.md lands.
 */
export const WS_INBOUND_MAX_BYTES = 32 * 1024 * 1024;
export const WS_OUTBOUND_BACKPRESSURE_BYTES = 256 * 1024 * 1024;

export const HISTORY_WEBSOCKET_OPTIONS = {
  idleTimeout: 240,
  maxPayloadLength: WS_INBOUND_MAX_BYTES,
  backpressureLimit: WS_OUTBOUND_BACKPRESSURE_BYTES,
  closeOnBackpressureLimit: true,
  perMessageDeflate: true,
} as const;
