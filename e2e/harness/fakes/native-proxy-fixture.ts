/** Controlled HTTP/SOCKS5 paths for the native client transport journey.
 * No public network is used. Destination DNS deliberately exists only here.
 * The owning test closes stdin; every listener and socket then closes. */
import {
  createServer as tcpServer,
  connect,
  type Socket,
  type AddressInfo,
} from 'node:net';
import { testCertificates } from './tls-ca.ts';

const credentials = { username: 'fixture-user', password: 'fixture-password' };
const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
const sockets = new Set<Socket>();
const forwardingErrors: string[] = [];
const requests: Array<{
  path: string;
  proxyAuthorization: boolean;
  token: string | null;
  tls: boolean;
}> = [];
const proxyRequests: Array<{
  protocol: string;
  host: string;
  port: number;
  authenticated: boolean;
}> = [];
const certificates = testCertificates();
// Review campaigns can exercise large streamed bodies without making the
// ordinary transport journey expensive. This remains an isolated fixture.
const fileBytes = Number(process.env.COSYNCING_TEST_PROXY_BYTES ?? 256 * 1024);
if (!Number.isInteger(fileBytes) || fileBytes < 64 || fileBytes > 64 * 1024 * 1024)
  throw new Error('COSYNCING_TEST_PROXY_BYTES must be 64..67108864');
const body = Buffer.alloc(fileBytes, 97);
const serve = (tls: boolean, hostname = '127.0.0.1') =>
  Bun.serve<{ tls: boolean }>({
    hostname,
    port: 0,
    ...(tls
      ? { tls: { cert: certificates.certPem, key: certificates.keyPem } }
      : {}),
    async fetch(request, server) {
      const url = new URL(request.url);
      requests.push({
        path: url.pathname,
        proxyAuthorization: request.headers.has('proxy-authorization'),
        token: request.headers.get('x-cosyncing-token'),
        tls,
      });
      if (url.pathname === '/stream') {
        if (server.upgrade(request, { data: { tls } })) return;
        return new Response('upgrade required', { status: 426 });
      }
      if (
        url.pathname === '/file' ||
        url.pathname.startsWith('/api/media-previews/')
      ) {
        const range = request.headers.get('range');
        const parsed = range?.match(/^bytes=(\d+)-(\d+)$/);
        if (parsed) {
          const start = Number(parsed[1]),
            end = Number(parsed[2]);
          if (start > end || end >= body.length)
            return new Response(null, { status: 416 });
          return new Response(body.subarray(start, end + 1), {
            status: 206,
            headers: {
              'content-range': `bytes ${start}-${end}/${body.length}`,
              etag: '"fixture-v1"',
            },
          });
        }
        return new Response(body, { headers: { etag: '"fixture-v1"' } });
      }
      if (url.pathname === '/upload') {
        let count = 0;
        const reader = request.body?.getReader();
        if (reader)
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            count += next.value.byteLength;
          }
        return Response.json({ bytes: count });
      }
      if (url.pathname === '/redirect')
        return Response.redirect('http://unapproved.invalid/credential-target');
      return Response.json({ ok: true });
    },
    websocket: {
      open(socket) {
        socket.send(JSON.stringify({ kind: 'ready' }));
      },
      message(socket, data) {
        socket.send(data);
      },
    },
  });
const plain = serve(false),
  secure = serve(true);
// IPv6 is requested by the functional journey and uses real IPv6 listeners.
// Large-transfer campaigns can retain their original IPv4-only fixture.
const ipv6 = process.env.COSYNCING_TEST_PROXY_IPV6 === '1';
const plain6 = ipv6 ? serve(false, '::1') : undefined;
const secure6 = ipv6 ? serve(true, '::1') : undefined;
const normalizeHost = (host: string) => host.startsWith('[') ? host.slice(1, -1) : host;
const destinationHost = (host: string) => normalizeHost(host) === '::1' ? '::1' : '127.0.0.1';
const allowed = (host: string, port: number) =>
  normalizeHost(host) === '::1'
    ? ipv6 && [plain6?.port, secure6?.port].includes(port)
    : ['127.0.0.1', 'proxy-only.invalid'].includes(host) &&
      [plain.port, secure.port].includes(port);
const own = (socket: Socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  return socket;
};
// Use Bun's native streaming HTTP boundary. Its Node IncomingMessage ->
// ClientRequest compatibility pipe can stall large request bodies.
const http = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  maxRequestBodySize: 64 * 1024 * 1024,
  async fetch(request) {
    const uri = new URL(request.url);
    const authenticated = request.headers.get('proxy-authorization') === authorization;
    proxyRequests.push({ protocol: 'http', host: uri.hostname,
      port: Number(uri.port), authenticated });
    if (!authenticated) return new Response(null, { status: 407,
      headers: { 'proxy-authenticate': 'Basic realm="fixture"' } });
    if (!allowed(uri.hostname, Number(uri.port))) return new Response(null, { status: 502 });
    const headers = new Headers(request.headers);
    headers.delete('proxy-authorization');
    headers.delete('proxy-connection');
    try {
      const host = destinationHost(uri.hostname) === '::1' ? '[::1]' : '127.0.0.1';
      return await fetch(`http://${host}:${uri.port}${uri.pathname}${uri.search}`, {
        method: request.method, headers, body: request.body,
        redirect: 'manual', signal: request.signal,
      });
    } catch (error) {
      forwardingErrors.push(String(error));
      return new Response(null, { status: 502 });
    }
  },
});
// Keep raw tunnels on net.Socket: Bun's node:http upgrade wrapper does not
// forward arbitrary tunnel writes reliably. Ordinary HTTP still uses its parser.
const front = tcpServer((socket) => {
  own(socket);
  let pending = Buffer.alloc(0);
  const first = (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    const end = pending.indexOf('\r\n\r\n');
    // Bound the header, not a body chunk coalesced into the same TCP packet.
    if (end > 32768 || (end < 0 && pending.length > 32768)) {
      socket.destroy();
      return;
    }
    if (end < 0) return;
    socket.pause();
    socket.removeListener('data', first);
    const lines = pending.subarray(0, end).toString().split('\r\n');
    const [method, target] = lines.shift()!.split(' ');
    const headers = Object.fromEntries(
      lines.map((line) => {
        const i = line.indexOf(':');
        return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()];
      })
    );
    const tunnel = method === 'CONNECT',
      upgrade = headers.upgrade?.toLowerCase() === 'websocket';
    if (!tunnel && !upgrade) {
      const upstream = own(
        connect(http.port!, '127.0.0.1', () => {
          upstream.write(pending);
          socket.pipe(upstream);
          upstream.pipe(socket);
          socket.resume();
        })
      );
      socket.on('close', () => upstream.destroy());
      upstream.on('close', () => socket.destroy());
      return;
    }
    const uri = new URL(
      tunnel ? `http://${target}` : target!,
      `http://${headers.host}`
    );
    const valid = headers['proxy-authorization'] === authorization;
    proxyRequests.push({
      protocol: tunnel ? 'http-connect' : 'http-ws',
      host: uri.hostname,
      port: Number(uri.port),
      authenticated: valid,
    });
    if (!valid) {
      socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fixture"\r\nContent-Length: 0\r\n\r\n'
      );
      return;
    }
    if (uri.hostname === 'proxy-hang.invalid') {
      socket.once('close', () => console.log(JSON.stringify({ closed: 'http' })));
      socket.resume();
      console.log(JSON.stringify({ waiting: 'http' }));
      return;
    }
    if (!allowed(uri.hostname, Number(uri.port))) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    const upstream = own(
      connect(Number(uri.port), destinationHost(uri.hostname), () => {
        if (tunnel) socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        else
          upstream.write(
            `GET ${uri.pathname}${uri.search} HTTP/1.1\r\n${lines.filter((line) => !/^proxy-/i.test(line)).join('\r\n')}\r\n\r\n`
          );
        const rest = pending.subarray(end + 4);
        if (rest.length) upstream.write(rest);
        socket.pipe(upstream);
        upstream.pipe(socket);
        socket.resume();
      })
    );
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  };
  socket.on('data', first);
});

const socks = tcpServer((socket) => {
  own(socket);
  let pending = Buffer.alloc(0),
    stage = 0,
    upstream: Socket | undefined;
  let validated = false;
  socket.on('data', (chunk) => {
    if (upstream) {
      if (!upstream.write(chunk)) socket.pause();
      return;
    }
    pending = Buffer.concat([
      pending,
      typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
    ]);
    if (pending.length > 1024) {
      socket.destroy();
      return;
    }
    for (;;) {
      if (stage === 0) {
        if (pending.length < 2 || pending.length < 2 + pending[1]!) return;
        if (
          pending[0] !== 5 ||
          !pending.subarray(2, 2 + pending[1]!).includes(2)
        ) {
          socket.end(Buffer.from([5, 255]));
          return;
        }
        pending = pending.subarray(2 + pending[1]!);
        socket.write(Buffer.from([5, 2]));
        stage = 1;
      } else if (stage === 1) {
        if (pending.length < 2 || pending.length < 3 + pending[1]!) return;
        const userLength = pending[1]!,
          passwordLength = pending[2 + userLength]!;
        if (pending.length < 3 + userLength + passwordLength) return;
        validated =
          pending[0] === 1 &&
          pending.subarray(2, 2 + userLength).toString() ===
            credentials.username &&
          pending
            .subarray(3 + userLength, 3 + userLength + passwordLength)
            .toString() === credentials.password;
        pending = pending.subarray(3 + userLength + passwordLength);
        socket.write(Buffer.from([1, validated ? 0 : 1]));
        if (!validated) {
          socket.end();
          return;
        }
        stage = 2;
      } else if (stage === 2) {
        if (pending.length < 5) return;
        const type = pending[3]!,
          length =
            type === 3 ? pending[4]! : type === 1 ? 4 : type === 4 ? 16 : 0,
          start = type === 3 ? 5 : 4;
        if (!length) {
          socket.destroy();
          return;
        }
        if (pending.length < start + length + 2) return;
        const host =
          type === 3
            ? pending.subarray(start, start + length).toString()
            : type === 1
              ? [...pending.subarray(start, start + length)].join('.')
              : new URL(`http://[${Array.from({ length: 8 }, (_, index) =>
                  pending.readUInt16BE(start + index * 2).toString(16)).join(':')}]`).hostname.slice(1, -1);
        const port = pending.readUInt16BE(start + length);
        proxyRequests.push({
          protocol: 'socks5',
          host,
          port,
          authenticated: validated,
        });
        if (host === 'proxy-hang.invalid') {
          stage = 3;
          socket.once('close', () => console.log(JSON.stringify({ closed: 'socks5' })));
          console.log(JSON.stringify({ waiting: 'socks5' }));
          return;
        }
        if (!allowed(host, port)) {
          socket.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
          return;
        }
        pending = pending.subarray(start + length + 2);
        stage = 3;
        upstream = own(
          connect(port, destinationHost(host), () => {
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            if (pending.length) upstream!.write(pending);
            pending = Buffer.alloc(0);
          })
        );
        upstream.on('drain', () => socket.resume());
        upstream.pipe(socket);
        socket.on('close', () => upstream?.destroy());
        upstream.on('close', () => socket.destroy());
        return;
      } else return;
    }
  });
});
await Promise.all([
  new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve)),
  new Promise<void>((resolve) => socks.listen(0, '127.0.0.1', resolve)),
]);
const control = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: () =>
    Response.json({ requests, proxyRequests, sockets: sockets.size, forwardingErrors,
      socketState: [...sockets].slice(0, 100).map((socket) => ({
        localPort: socket.localPort, remotePort: socket.remotePort,
        bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten,
        readableFlowing: socket.readableFlowing, readableLength: socket.readableLength,
        writableLength: socket.writableLength, writableNeedDrain: socket.writableNeedDrain,
      })),
    }),
});
console.log(
  JSON.stringify({
    httpPort: (front.address() as AddressInfo).port,
    socksPort: (socks.address() as AddressInfo).port,
    plainPort: plain.port,
    tlsPort: secure.port,
    plain6Port: plain6?.port,
    tls6Port: secure6?.port,
    controlPort: control.port,
    caPem: certificates.caPem,
  })
);
const lifetime = Bun.stdin.stream().getReader();
while (!(await lifetime.read()).done) {
  /* Parent lifetime, no commands. */
}
for (const socket of sockets) socket.destroy();
await Promise.all([
  http.stop(true),
  new Promise<void>((resolve) => front.close(() => resolve())),
  new Promise<void>((resolve) => socks.close(() => resolve())),
  plain.stop(true),
  secure.stop(true),
  plain6?.stop(true),
  secure6?.stop(true),
  control.stop(true),
]);
