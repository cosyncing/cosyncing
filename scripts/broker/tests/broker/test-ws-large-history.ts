/**
 * Behavioral regression for the large-history WebSocket stopgap.
 *
 * This does not prove the final cache/lazy-artifact architecture; it only verifies that the shared
 * broker WS options can deliver a history frame larger than Bun's default 16 MB inbound/outbound
 * defaults, and that the config keeps inbound and outbound limits separated.
 */
import {
  HISTORY_WEBSOCKET_OPTIONS,
  WS_INBOUND_MAX_BYTES,
  WS_OUTBOUND_BACKPRESSURE_BYTES,
} from '../../../../packages/typescript/broker/src/ws-limits.ts';

const BIG_TEXT_BYTES = 17 * 1024 * 1024;

function fail(message: string): never {
  throw new Error(message);
}

if (WS_INBOUND_MAX_BYTES >= WS_OUTBOUND_BACKPRESSURE_BYTES) {
  fail('inbound max must stay smaller than outbound history backpressure limit');
}
if (!HISTORY_WEBSOCKET_OPTIONS.closeOnBackpressureLimit) {
  fail('large history overflow must close visibly instead of silently dropping frames');
}

const largeHistory = JSON.stringify({
  kind: 'history',
  messages: [{ type: 'model-output', key: 'large', text: 'x'.repeat(BIG_TEXT_BYTES) }],
});

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req, srv) {
    if (srv.upgrade(req)) return undefined;
    return new Response('upgrade required', { status: 426 });
  },
  websocket: {
    ...HISTORY_WEBSOCKET_OPTIONS,
    open(ws) {
      const status = ws.send(largeHistory);
      if (status === 0) ws.close(1011, 'large history frame dropped');
    },
    message() {},
  },
});

try {
  const received = await new Promise<string>((resolve, reject) => {
    const url = `ws://${server.hostname}:${server.port}/history`;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('timed out waiting for large history frame')), 10_000);
    ws.onmessage = (event) => {
      clearTimeout(timer);
      resolve(String(event.data));
      ws.close();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('large history socket errored before delivery'));
    };
    ws.onclose = (event) => {
      if (!event.wasClean && event.code !== 1005) {
        clearTimeout(timer);
        reject(new Error(`large history socket closed early: ${event.code} ${event.reason}`));
      }
    };
  });

  const parsed = JSON.parse(received) as { kind?: string; messages?: Array<{ text?: string }> };
  if (parsed.kind !== 'history') fail('expected a history frame');
  if ((parsed.messages?.[0]?.text?.length ?? 0) !== BIG_TEXT_BYTES) fail('large history text was truncated');
  console.log('PASS broker large-history WebSocket stopgap delivered a >16 MB history frame');
} finally {
  server.stop(true);
}
