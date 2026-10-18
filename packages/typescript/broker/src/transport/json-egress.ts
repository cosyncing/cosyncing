import type { Server, ServerWebSocket } from 'bun';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { acceptsGzip } from '../roster/roster-http.ts';

const COMPRESSION_MIN_BYTES = 1024;
const gzipAsync = promisify(gzip);

/** Bun still owns negotiation and backpressure. Serialize once and return its
 * exact send status (including -1 for queued and 0 for dropped). */
export function sendJson(ws: Pick<ServerWebSocket<unknown>, 'send'>, value: unknown): number {
  const body = JSON.stringify(value);
  return ws.send(body, Buffer.byteLength(body) >= COMPRESSION_MIN_BYTES);
}

/** Compress successful JSON at the common HTTP egress boundary. Encoded bodies,
 * upgrades, files and non-200 responses retain their original semantics. */
export function withJsonCompression<T>(
  handler: (req: Request, server: Server<T>) => Response | undefined | Promise<Response | undefined>,
): (req: Request, server: Server<T>) => Promise<Response | undefined> {
  // A small bounded cache also coalesces concurrent compression of identical
  // capability/schedule/quota bodies. Headers and authorization remain per request.
  // Large bodies are compressed asynchronously without retaining another copy.
  const compressed = new Map<string, Promise<Buffer>>();
  return async (req, server) => {
    const response = await handler(req, server);
    if (!response || response.status !== 200 || req.method === 'HEAD' ||
        response.body === null || response.headers.has('content-encoding') ||
        response.headers.has('content-disposition') || response.headers.has('accept-ranges') ||
        !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      return response;
    }
    const headers = new Headers(response.headers);
    const vary = headers.get('vary');
    if (!vary?.split(',').some((token) => ['*', 'accept-encoding'].includes(token.trim().toLowerCase()))) {
      headers.set('vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
    }
    if (!acceptsGzip(req)) return new Response(response.body, { headers });
    const body = await response.text();
    const bytes = Buffer.byteLength(body);
    if (bytes < COMPRESSION_MIN_BYTES) return new Response(body, { headers });
    let pending = compressed.get(body);
    if (!pending) {
      pending = gzipAsync(body);
      if (bytes <= 256 * 1024) {
        if (compressed.size >= 4) compressed.delete(compressed.keys().next().value!);
        compressed.set(body, pending);
        void pending.catch(() => { if (compressed.get(body) === pending) compressed.delete(body); });
      }
    }
    const encoded = await pending;
    headers.set('content-encoding', 'gzip');
    headers.delete('content-length');
    // zlib allocates an ordinary ArrayBuffer; narrow Node's broader Buffer
    // declaration for the DOM BodyInit type without copying compressed bytes.
    return new Response(encoded as Uint8Array<ArrayBuffer>, { headers });
  };
}
