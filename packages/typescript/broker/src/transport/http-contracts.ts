/**
 * Broker-root paths for the browser client, shared by the HTTP runtime and by every surface that PRINTS a
 * URL (setup outro, pair guidance). One definition keeps what setup tells the operator to open and what the
 * runtime actually answers on from drifting apart.
 */

/** The one mount of the Flutter web build. Short enough to read off a terminal and retype on a phone,
 *  which is why it is the mount and not an alias of one: an app reached through a redirect leaves the
 *  address bar somewhere the operator was never told to go. The trailing slash is load-bearing — it is the
 *  service-worker scope and the base the shell's relative asset URLs resolve against. */
export const APP_MOUNT_PATH = '/cosy/';

/** The same mount without its trailing slash: what a person types, and what every printed URL ends in. */
export const APP_PATH = '/cosy';

/** The URL to hand an operator for `base`, e.g. `https://devbox.tailnet.ts.net` → `https://devbox.tailnet.ts.net/cosy`. */
export function browserClientUrl(base: string): string {
  return `${base.replace(/\/+$/, '')}${APP_PATH}`;
}

/** WebSocket guardrails for client input and broker history output. */
export const WS_INBOUND_MAX_BYTES = 32 * 1024 * 1024;
export const WS_OUTBOUND_BACKPRESSURE_BYTES = 256 * 1024 * 1024;

export const HISTORY_WEBSOCKET_OPTIONS = {
  idleTimeout: 240,
  maxPayloadLength: WS_INBOUND_MAX_BYTES,
  backpressureLimit: WS_OUTBOUND_BACKPRESSURE_BYTES,
  closeOnBackpressureLimit: true,
  perMessageDeflate: true,
} as const;
