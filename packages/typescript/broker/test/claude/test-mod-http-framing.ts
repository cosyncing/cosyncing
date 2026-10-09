/**
 * HTTP/1.1 framing for the Claude mod socket: the plan's nine rules, driven by raw bytes.
 *
 * The client here is `node:net` and not a fetch client on purpose. A fetch client normalises
 * the very things under test (it adds headers, it rewrites the request line, it hides whether
 * a response was answered twice), and the whole point is that the shipped reader agrees with
 * what Claude Code 2.1.288 actually sends. The recorded request fixtures under `fixtures/`
 * are replayed byte for byte for the same reason: a reader that passes synthetic requests and
 * fails the real ones passes CI while the feature is broken.
 *
 *   bun run packages/typescript/broker/test/claude/test-mod-http-framing.ts   (exit 0 = all pass)
 */
export {};
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { ModSocketServer } from '../../src/sessions/mod-socket-server.ts';
import { Http1RequestReader } from '../../src/sessions/mod-http-reader.ts';
import { ModRegistry } from '../../src/sessions/mod-registry.ts';
import { ModHoldStore } from '../../src/sessions/mod-holds.ts';
import { ModAuditStore } from '../../src/sessions/mod-audit.ts';
import { MOD_SOCKET_PATH_MAX_BYTES } from '../../src/sessions/mod-socket-server.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A socket name has to stay inside the client's own documented budget ("near 100 B at most"),
// so the temp root gets truncated to fit rather than assumed to be short.
// macOS reports os.tmpdir() behind the /var -> /private/var symlink, which the state-dir
  // guard refuses; canonicalize the root first, the way security/r2-export.ts does.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cmts-framing-')));
const SOCKET_NAME = 'claude-mod.sock';
const sessionId = randomUUID();
const socketPath = join(root.slice(0, root.length - Math.max(0, root.length + SOCKET_NAME.length + 1 - MOD_SOCKET_PATH_MAX_BYTES + 8)), SOCKET_NAME);

const seen: { route: string; target: string; body: string; headers: Record<string, string> }[] = [];
const registry = new ModRegistry();
const audit = new ModAuditStore();
const holds = new ModHoldStore({ registry, audit, gate: () => ({ mode: 'auto', viewers: 0, killSwitch: false }) });
const refusals: string[] = [];
const server = new ModSocketServer({
  socketPath,
  registry,
  holds,
  killSwitch: () => false,
  headerDeadlineMs: 400,
  bodyDeadlineMs: 600,
  maxConnections: 24,
  onRefusal: (code) => refusals.push(code),
  log: { warn: () => {} },
});

interface RawReply {
  status: number;
  head: string;
  body: string;
  responses: number;
  closed: boolean;
}

/** Send bytes a piece at a time and read whatever comes back before the peer hangs up. */
function raw(bytes: (string | Uint8Array)[], opts: { idleMs?: number; expectClose?: boolean; path?: string } = {}): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('latin1');
      const [head = '', body = ''] = text.split('\r\n\r\n');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
      socket.destroy();
      resolve({ status, head, body, responses: (text.match(/HTTP\/1\.[01] /g) ?? []).length, closed });
    };
    const socket = net.createConnection({ path: opts.path ?? socketPath }, () => {
      void (async () => {
        for (const piece of bytes) {
          socket.write(typeof piece === 'string' ? piece : Buffer.from(piece));
          await sleep(2);
        }
        timer = setTimeout(() => finish(false), opts.idleMs ?? 1_200);
      })();
    });
    socket.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
      // Answer-then-close is the contract, so a full response means we can stop waiting.
      const text = Buffer.concat(chunks).toString('latin1');
      const boundary = text.indexOf('\r\n\r\n');
      if (boundary >= 0) {
        const declared = /content-length: (\d+)/i.exec(text.slice(0, boundary))?.[1];
        const received = Buffer.byteLength(text.slice(boundary + 4), 'latin1');
        if (declared !== undefined && received >= Number(declared)) finish(false);
      }
    });
    socket.on('close', () => finish(true));
    socket.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

function bodyFor(route: string): string {
  if (route === 'register') {
    return JSON.stringify({
      protocolVersion: 1,
      sessionId,
      cwd: root,
      claudeVersion: '2.1.288',
      isInteractive: true,
      surface: 'terminal',
      reportedPid: process.pid,
    });
  }
  if (route === 'hold') return JSON.stringify({ sessionId, requestId: 'req-frame', tool: 'Bash', decision: 'ask' });
  return JSON.stringify({ sessionId, wait: 60 });
}

/** A real captured header block, with its body re-attached at the correct length. */
function replayBlock(rawBlock: string, body: string): string {
  const lines = rawBlock.split('\r\n').filter((line) => !/^content-length:/i.test(line));
  lines.push(`Content-Length: ${Buffer.byteLength(body, 'utf8')}`);
  return `${lines.join('\r\n')}\r\n\r\n${body}`;
}

try {
  await server.start();
  check('socket bound', server.listening, socketPath);

  // Framing is decided first: this declares one byte and sends two, so the reader refuses on
  // trailing bytes without ever looking at the body.
  const overShort = await raw([`POST /claude/mod/register?sid=${sessionId} HTTP/1.1\r\ncontent-length: 1\r\n\r\n{}`]);
  check('declared length shorter than the bytes sent is 400 trailing_bytes', overShort.status === 400 && overShort.body.includes('trailing_bytes'), `status=${overShort.status} body=${overShort.body.slice(0, 60)}`);

  const notJson = await raw(['POST /claude/mod/register HTTP/1.1\r\ncontent-length: 4\r\n\r\nnope']);
  check('a body that is not JSON is 400 json_invalid', notJson.status === 400 && notJson.body.includes('json_invalid'), `status=${notJson.status} body=${notJson.body.slice(0, 60)}`);

  const good = await raw([
    `POST /claude/mod/register?sid=${sessionId} HTTP/1.1\r\nContent-Type: application/json\r\ncontent-length: ${Buffer.byteLength(bodyFor('register'))}\r\n\r\n${bodyFor('register')}`,
  ]);
  check('a well-formed register answers 200', good.status === 200 && good.body.includes('"ok":true'), `status=${good.status} body=${good.body.slice(0, 90)}`);
  check('every response carries content-length', /content-length: \d+/i.test(good.head), good.head.replace(/\r\n/g, ' | ').slice(0, 120));
  check('every response carries connection: close', /connection: close/i.test(good.head));
  check('no response sets content-encoding', !/content-encoding/i.test(good.head));

  // Rule 9: split reads. Three shapes, all of which must produce one identical answer.
  const full = `POST /claude/mod/register?sid=${sessionId} HTTP/1.1\r\ncontent-length: ${Buffer.byteLength(bodyFor('register'))}\r\n\r\n${bodyFor('register')}`;
  const third = Math.ceil(full.length / 3);
  const thirds = await raw([full.slice(0, third), full.slice(third, third * 2), full.slice(third * 2)]);
  check('request split in thirds parses', thirds.status === 200, `status=${thirds.status}`);

  const midHeader = await raw([full.slice(0, full.indexOf('content-length') + 6), full.slice(full.indexOf('content-length') + 6)]);
  check('request split mid-header parses', midHeader.status === 200, `status=${midHeader.status}`);

  // A hundred-odd reads for the header alone, a few ms apart. Against the 400 ms header deadline the
  // rest of this suite tests, that raced the machine's load and lost under a parallel run (408 once
  // the session id became a UUID and the request grew). Its own reader keeps the production
  // deadlines, which are what one-byte reads meet in the field; the deadline checks keep theirs.
  const dribblePath = join(socketPath.slice(0, socketPath.length - SOCKET_NAME.length), 'drip.sock');
  const dribbleServer = new ModSocketServer({ socketPath: dribblePath, registry, holds, killSwitch: () => false, log: { warn: () => {} } });
  await dribbleServer.start();
  const bytes = Uint8Array.from(Buffer.from(full, 'utf8'));
  const dribble = await raw(Array.from(bytes, (byte) => Uint8Array.from([byte])), { path: dribblePath });
  dribbleServer.close();
  check('request delivered one byte per read parses', dribble.status === 200, `status=${dribble.status}`);

  // Rule 2.
  const noLength = await raw(['POST /claude/mod/poll HTTP/1.1\r\n\r\n{}']);
  check('missing content-length is 400 content_length_required', noLength.status === 400 && noLength.body.includes('content_length_required'), `status=${noLength.status} ${noLength.body.slice(0, 60)}`);
  const badLength = await raw(['POST /claude/mod/poll HTTP/1.1\r\ncontent-length: five\r\n\r\n{}']);
  check('unparseable content-length is 400', badLength.status === 400 && badLength.body.includes('content_length_required'), badLength.body.slice(0, 60));
  const negativeLength = await raw(['POST /claude/mod/poll HTTP/1.1\r\ncontent-length: -1\r\n\r\n{}']);
  check('negative content-length is 400', negativeLength.status === 400 && negativeLength.body.includes('content_length_required'), negativeLength.body.slice(0, 60));

  // Rule 3, decided before framing.
  const get = await raw(['GET /claude/mod/poll?sid=x&wait=20000 HTTP/1.1\r\naccept: */*\r\n\r\n']);
  check('GET is 405 method_not_allowed', get.status === 405 && get.body.includes('method_not_allowed'), `status=${get.status} ${get.body.slice(0, 60)}`);
  const junkLine = await raw(['NOTAREQUEST\r\n\r\n']);
  check('a junk request line is 400 request_line', junkLine.status === 400 && junkLine.body.includes('request_line'), `status=${junkLine.status} ${junkLine.body.slice(0, 60)}`);

  // Rule 4, before the body is read.
  const chunked = await raw(['POST /claude/mod/poll HTTP/1.1\r\ntransfer-encoding: chunked\r\ncontent-length: 2\r\n\r\n{}']);
  check('transfer-encoding is 400 unsupported_header', chunked.status === 400 && chunked.body.includes('unsupported_header'), `status=${chunked.status} ${chunked.body.slice(0, 60)}`);
  const expect = await raw(['POST /claude/mod/poll HTTP/1.1\r\nexpect: 100-continue\r\ncontent-length: 2\r\n\r\n{}']);
  check('expect is 400 unsupported_header', expect.status === 400 && expect.body.includes('unsupported_header'), `status=${expect.status} ${expect.body.slice(0, 60)}`);

  // Rule 5.
  const trailing = await raw([`POST /claude/mod/register?sid=${sessionId} HTTP/1.1\r\ncontent-length: 2\r\n\r\n{}GET / HTTP/1.1\r\nhost: x\r\n\r\n`]);
  check('bytes after the declared body are 400 trailing_bytes', trailing.status === 400 && trailing.body.includes('trailing_bytes'), `status=${trailing.status} ${trailing.body.slice(0, 60)}`);

  // Rule 1, the smuggle-shaped version of it: one answer per connection, ever.
  const pipelined = await raw([
    `POST /claude/mod/register?sid=${sessionId} HTTP/1.1\r\ncontent-length: ${Buffer.byteLength(bodyFor('register'))}\r\n\r\n${bodyFor('register')}POST /claude/mod/register HTTP/1.1\r\ncontent-length: 2\r\n\r\n{}`,
  ]);
  check('a second request on one connection is never answered', pipelined.responses === 1, `responses=${pipelined.responses}`);

  // Rule 6.
  const fatHeaders = await raw([`POST /claude/mod/poll HTTP/1.1\r\nx-filler: ${'a'.repeat(9 * 1024)}\r\n\r\n`]);
  check('header block over 8 KB is 431 header_too_large', fatHeaders.status === 431 && fatHeaders.body.includes('header_too_large'), `status=${fatHeaders.status} ${fatHeaders.body.slice(0, 60)}`);
  // Rule 6 counts the header block and nothing else. A small header block whose body arrives in the
  // same write -- a question hold with long options does exactly that -- is over 8 KB in the buffer
  // before the terminator has been looked for, and the ceiling is not about the body.
  const fatBody = JSON.stringify({ ...JSON.parse(bodyFor('register')), padding: 'q'.repeat(20 * 1024) });
  const bigBodyOneWrite = await raw([`POST /claude/mod/register?sid=${sessionId} HTTP/1.1\r\ncontent-length: ${Buffer.byteLength(fatBody)}\r\n\r\n${fatBody}`]);
  check('a small header block with a 20 KB body in the same write is not 431: the body never counts toward the header ceiling',
    bigBodyOneWrite.status === 200, `status=${bigBodyOneWrite.status} ${bigBodyOneWrite.body.slice(0, 60)}`);

  // Rule 7, answered off the header alone: no body is ever sent by this client.
  const hugeDeclared = await raw(['POST /claude/mod/poll HTTP/1.1\r\ncontent-length: 65537\r\n\r\n']);
  check('declared body over 64 KB is 413 body_too_large', hugeDeclared.status === 413 && hugeDeclared.body.includes('body_too_large'), `status=${hugeDeclared.status} ${hugeDeclared.body.slice(0, 60)}`);

  // Rule 8. The server was configured with a 400 ms header deadline for this.
  const stalled = Date.now();
  const headerTimeout = await raw(['POST /claude/mod/poll HTTP/1.1\r\ncontent-length: 2\r\n'], { idleMs: 2_000 });
  const waited = Date.now() - stalled;
  check('incomplete headers are 408 header_deadline', headerTimeout.status === 408 && headerTimeout.body.includes('header_deadline'), `status=${headerTimeout.status} after ${waited}ms`);
  check('the header deadline fired inside its budget', waited < 1_500, `${waited}ms`);

  // Rule 13: a declared body that stops arriving IS answered, and answered as a timeout. Silence
  // here used to mean a connection parked until the broker exited.
  const partialStarted = Date.now();
  const partial = await raw([`POST /claude/mod/hold?sid=${sessionId} HTTP/1.1\r\ncontent-length: 400\r\n\r\n{"sessionId":"${sessionId}"`], { idleMs: 1_400 });
  const partialWaited = Date.now() - partialStarted;
  check('a partial body is 408 body_deadline', partial.status === 408 && partial.body.includes('body_deadline'), `status=${partial.status} ${partial.body.slice(0, 60)}`);
  check('the body deadline fired inside its budget', partialWaited < 1_300, `${partialWaited}ms`);

  // Rules 10 to 12, each one reproduced against a raw socket on 2026-10-05 and each refused rather
  // than repaired. Every tolerance in a request reader is a place where two parsers can disagree.
  const emptyLength = await raw(['POST /claude/mod/poll HTTP/1.1\r\ncontent-length: \r\n\r\n{}']);
  check('an empty content-length is 400 content_length_required', emptyLength.status === 400 && emptyLength.body.includes('content_length_required'), `status=${emptyLength.status} ${emptyLength.body.slice(0, 60)}`);

  const hexLength = await raw(['POST /claude/mod/poll HTTP/1.1\r\ncontent-length: 0x10\r\n\r\n{}']);
  check('a hex content-length is 400 content_length_required', hexLength.status === 400 && hexLength.body.includes('content_length_required'), hexLength.body.slice(0, 60));

  const expLength = await raw(['POST /claude/mod/poll HTTP/1.1\r\ncontent-length: 1e3\r\n\r\n{}']);
  check('an exponent content-length is 400 content_length_required', expLength.status === 400 && expLength.body.includes('content_length_required'), expLength.body.slice(0, 60));

  const dupLength = await raw(['POST /claude/mod/poll HTTP/1.1\r\ncontent-length: 2\r\nContent-Length: 4\r\n\r\n{}']);
  check('two content-length values that disagree are 400 duplicate_content_length', dupLength.status === 400 && dupLength.body.includes('duplicate_content_length'), `status=${dupLength.status} ${dupLength.body.slice(0, 60)}`);

  const declared = Buffer.byteLength(bodyFor('register'));
  const dupSame = await raw([`POST /claude/mod/register?sid=${sessionId} HTTP/1.1\r\ncontent-length: ${declared}\r\nContent-Length: ${declared}\r\n\r\n${bodyFor('register')}`]);
  check('two identical content-length values still parse', dupSame.status === 200, `status=${dupSame.status}`);

  const emptyExpect = await raw(['POST /claude/mod/poll HTTP/1.1\r\nexpect: \r\ncontent-length: 2\r\n\r\n{}']);
  check('an empty expect is 400 unsupported_header', emptyExpect.status === 400 && emptyExpect.body.includes('unsupported_header'), `status=${emptyExpect.status} ${emptyExpect.body.slice(0, 60)}`);

  const emptyTransfer = await raw(['POST /claude/mod/poll HTTP/1.1\r\ntransfer-encoding: \r\ncontent-length: 2\r\n\r\n{}']);
  check('an empty transfer-encoding is 400 unsupported_header', emptyTransfer.status === 400 && emptyTransfer.body.includes('unsupported_header'), `status=${emptyTransfer.status} ${emptyTransfer.body.slice(0, 60)}`);

  const noColon = await raw(['POST /claude/mod/poll HTTP/1.1\r\nbroken header\r\ncontent-length: 2\r\n\r\n{}']);
  check('a header line without a colon is 400 malformed_header', noColon.status === 400 && noColon.body.includes('malformed_header'), `status=${noColon.status} ${noColon.body.slice(0, 60)}`);

  const folded = await raw(['POST /claude/mod/poll HTTP/1.1\r\nx-filler:\r\n  continued\r\ncontent-length: 2\r\n\r\n{}']);
  check('a folded continuation line is 400 malformed_header', folded.status === 400 && folded.body.includes('malformed_header'), `status=${folded.status} ${folded.body.slice(0, 60)}`);

  const spaceInName = await raw(['POST /claude/mod/poll HTTP/1.1\r\nbad name: value\r\ncontent-length: 2\r\n\r\n{}']);
  check('a header name containing a space is 400 malformed_header', spaceInName.status === 400 && spaceInName.body.includes('malformed_header'), `status=${spaceInName.status} ${spaceInName.body.slice(0, 60)}`);

  const fourTokens = await raw(['POST /claude/mod/poll HTTP/1.1 tail\r\ncontent-length: 2\r\n\r\n{}']);
  check('a four-token request line is 400 request_line', fourTokens.status === 400 && fourTokens.body.includes('request_line'), `status=${fourTokens.status} ${fourTokens.body.slice(0, 60)}`);

  // Case-insensitive header lookup, the way the real client sends them.
  const mixedCase = await raw([
    `POST /claude/mod/register?sid=${sessionId} HTTP/1.1\r\nCONTENT-TYPE: application/json\r\nContent-Length: ${Buffer.byteLength(bodyFor('register'))}\r\nCONTENT-LENGTH: ${Buffer.byteLength(bodyFor('register'))}\r\n\r\n${bodyFor('register')}`,
  ]);
  check('header names are matched case-insensitively', mixedCase.status === 200, `status=${mixedCase.status}`);

  // Unknown route, refused rather than answered with a default.
  const unknown = await raw(['POST /claude/mod/nope HTTP/1.1\r\ncontent-length: 2\r\n\r\n{}']);
  check('an unknown route is 404 unknown_route', unknown.status === 404 && unknown.body.includes('unknown_route'), `status=${unknown.status} ${unknown.body.slice(0, 60)}`);

  // C4: an oversized prompt is refused at the door, before it is ever queued. Truncating it would
  // have handed the agent a different instruction than the one the person wrote, and a command that
  // cannot fit the response write is a command that was never going to arrive.
  const hugeSend = registry.enqueue(sessionId, { requestId: 'req-huge', op: 'prompt', text: 'x'.repeat(64 * 1024), queuedAt: Date.now() });
  check('an oversized prompt is refused as command_too_large', hugeSend.ok === false && hugeSend.code === 'command_too_large', JSON.stringify(hugeSend));
  check('the refused prompt left nothing queued', registry.queuedCount(sessionId) === 0, `queued=${registry.queuedCount(sessionId)}`);
  const fitSend = registry.enqueue(sessionId, { requestId: 'req-fit', op: 'prompt', text: 'x'.repeat(8 * 1024), queuedAt: Date.now() });
  check('a prompt inside the ceiling still queues', fitSend.ok === true, JSON.stringify(fitSend));
  registry.dequeue(sessionId);

  // The connection cap, proved by parking the listener full. A `poll` with a long wait holds its
  // connection open on purpose, which is the only shape that occupies the cap deterministically.
  const parkBody = JSON.stringify({ sessionId, wait: 20_000 });
  const parkedSockets: net.Socket[] = [];
  const parked = await Promise.all(Array.from({ length: 24 }, () => new Promise<boolean>((resolve) => {
    const sock = net.createConnection({ path: socketPath }, () => {
      sock.write(`POST /claude/mod/poll?sid=${sessionId} HTTP/1.1\r\ncontent-length: ${Buffer.byteLength(parkBody)}\r\n\r\n${parkBody}`);
    });
    let closed = false;
    sock.on('close', () => { closed = true; });
    sock.on('error', () => { closed = true; });
    parkedSockets.push(sock);
    setTimeout(() => resolve(!closed && !sock.destroyed), 150);
  })));
  const stillParked = parked.filter((open) => open).length;
  check('the cap admits its own complement of parked polls', stillParked === 24, `${stillParked}/24 still open`);
  const overflow = await raw([`POST /claude/mod/poll?sid=${sessionId} HTTP/1.1\r\ncontent-length: ${Buffer.byteLength(parkBody)}\r\n\r\n${parkBody}`], { idleMs: 900 });
  check('a connection over the cap is closed without an answer', overflow.status === 0 && overflow.responses === 0, `status=${overflow.status} responses=${overflow.responses}`);
  for (const sock of parkedSockets) sock.destroy();
  await sleep(150);

  // Response writes, unit-shaped. `end(data)` and one `write(data)` both stop at the socket buffer
  // and report how far they got -- 219264 bytes on Linux, 8192 on macOS -- so a whole response
  // needs a loop, and a caller that queued something needs to know when the loop failed. Both halves
  // are asserted against a fake descriptor that decides the backpressure.
  const delivered: number[] = [];
  const trickleSocket = {
    fd: 1,
    ended: false,
    end() { this.ended = true; },
    write(data: Uint8Array) { const take = Math.min(64, data.byteLength); delivered.push(take); return take; },
  };
  const trickle = new Http1RequestReader({ sleep: async () => {} });
  const trickleOk = await trickle.respond(trickleSocket, 200, JSON.stringify({ ok: true, state: { killSwitch: false }, command: { requestId: 'r', op: 'prompt', text: 'y'.repeat(4096), queuedAt: 0 } }));
  const trickleBytes = delivered.reduce((total, part) => total + part, 0);
  check('a backpressured write is retried until every byte is out', trickleOk === true && trickleBytes > 4_100 && trickleSocket.ended, `${delivered.length} writes, ${trickleBytes} bytes`);

  const undelivered: string[] = [];
  let endCalls = 0;
  const stuckSocket = { fd: 2, end() { endCalls += 1; }, write: () => 0 };
  const stuck = new Http1RequestReader({ sleep: async () => {}, writeDeadlineMs: 40, onUndelivered: (_sock, detail) => undelivered.push(detail) });
  const stuckOk = await stuck.respond(stuckSocket, 200, '{"ok":true}');
  check('a descriptor that never drains is reported as undelivered', stuckOk === false && undelivered.length === 1 && endCalls === 1, `${undelivered.length} report(s), ${endCalls} end(s)`);
  check('BH10 a stall is reported as one, naming the write deadline it ran into',
    /undelivered after \d+ ms: the peer stopped reading \(write deadline 40 ms\)/.test(undelivered[0] ?? ''), undelivered[0]);

  // BH10: the writer checks the connection before it writes, and a failure is reported as what it was.
  const closedReports: string[] = [];
  let closedWrites = 0;
  const closedSocket = { fd: 3, end() {}, write: (data: Uint8Array) => { closedWrites += 1; return data.length; } };
  const closedReader = new Http1RequestReader({ onUndelivered: (_sock, detail) => closedReports.push(detail) });
  closedReader.onClose();
  const closedOk = await closedReader.respond(closedSocket, 200, '{"ok":true}');
  check('BH10 a response to a connection that has closed is not written, and is reported as such',
    closedOk === false && closedWrites === 0 && /undelivered after \d+ ms: the connection had closed/.test(closedReports[0] ?? ''),
    `${closedWrites} write(s); ${closedReports[0]}`);
  const midReports: string[] = [];
  let midWrites = 0;
  let midReader: Http1RequestReader | undefined;
  const midSocket = { fd: 5, end() {}, write: () => {
    midWrites += 1;
    // The peer stops reading, and then hangs up while the writer is waiting on it.
    if (midWrites === 2) midReader?.onClose();
    return 0;
  } };
  midReader = new Http1RequestReader({ sleep: async () => {}, writeDeadlineMs: 5_000, onUndelivered: (_sock, detail) => midReports.push(detail) });
  const midStartedAt = Date.now();
  const midOk = await midReader.respond(midSocket, 200, '{"ok":true}');
  check('BH10 a peer that hangs up while the writer waits on it ends the write at once, as a closed connection',
    midOk === false && midWrites === 2 && Date.now() - midStartedAt < 1_000 && /the connection had closed/.test(midReports[0] ?? ''),
    `${midWrites} write(s) in ${Date.now() - midStartedAt} ms; ${midReports[0]}`);
  const refusedReports: string[] = [];
  const refusedReader = new Http1RequestReader({ onUndelivered: (_sock, detail) => refusedReports.push(detail) });
  const refusedOk = await refusedReader.respond({ fd: 4, end() {}, write: () => -1 }, 200, '{"ok":true}');
  check('BH10 a write the socket refuses is reported at once, with its own elapsed time, not the 10 s deadline',
    refusedOk === false && /undelivered after [0-9] ms: the socket refused the write$/.test(refusedReports[0] ?? '')
      && !/10000/.test(refusedReports[0] ?? ''), refusedReports[0]);

  // Rule 14: bytes that arrive after the handler took the connection are dropped, not buffered, so
  // the one-request-per-connection rule cannot be turned into an unbounded buffer.
  const afterDispatch: string[] = [];
  const late = await raw([
    `POST /claude/mod/register?sid=${sessionId} HTTP/1.1\r\ncontent-length: ${declared}\r\n\r\n${bodyFor('register')}`,
    'POST /claude/mod/poll HTTP/1.1\r\ncontent-length: 2\r\n\r\n{}',
  ], { idleMs: 900 });
  check('bytes after the request was dispatched get no second answer', late.responses === 1, `responses=${late.responses} ${afterDispatch.length}`);

  // Fixture replay: the exact header blocks a real 2.1.288 session put on the wire.
  const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'claude-fetch-requests.json'), 'utf8')) as {
    claudeBuild: string;
    v1Routes?: string[];
    requests: { name: string; method: string; target: string; rawBlockCRLF: string; expectedOutcome: string; declaredContentLength?: number }[];
  };
  check('fixture is recorded against the floor build', fixture.claudeBuild === '2.1.288', fixture.claudeBuild);
  const v1Routes = new Set(fixture.v1Routes ?? []);
  for (const recorded of fixture.requests) {
    const target = recorded.target.replace('<sid>', sessionId);
    const path = target.split('?')[0] ?? '';
    const replayed = `${recorded.rawBlockCRLF.replace(recorded.target, target)}\r\n`;
    if (!v1Routes.has(path)) {
      // Evidence of what the client sends, and of what the socket refuses: a path the probe
      // invented is not part of the protocol and must not be answered by accident.
      const rejected = await raw([replayBlock(recorded.rawBlockCRLF.replace(recorded.target, target), bodyFor('poll'))]);
      check(`fixture ${recorded.name} is refused as not a v1 route`, rejected.status === 404 && rejected.body.includes('unknown_route'), `status=${rejected.status} ${rejected.body.slice(0, 60)}`);
      continue;
    }
    if (recorded.method !== 'POST') {
      // Rule 3 against the real captured bytes: this client's bodiless GET carries no
      // Content-Length, and the protocol does not accept it.
      const rejected = await raw([replayed]);
      check(`fixture ${recorded.name} is refused as a non-POST`, rejected.status === 405 && rejected.body.includes('method_not_allowed'), `status=${rejected.status} ${rejected.body.slice(0, 60)}`);
      continue;
    }
    if (recorded.expectedOutcome === 'parse') {
      const body = bodyFor(recorded.name === 'status' ? 'poll' : recorded.name);
      const replay = await raw([replayBlock(recorded.rawBlockCRLF.replace(recorded.target, target), body)]);
      check(`fixture ${recorded.name} replays to 200`, replay.status === 200, `status=${replay.status} body=${replay.body.slice(0, 70)}`);
      seen.push({ route: target, target, body, headers: {} });
    } else {
      const replay = await raw([`${recorded.rawBlockCRLF.replace(recorded.target, target)}\r\n`]);
      check(`fixture ${recorded.name} is refused as recorded`, replay.status === 405 && replay.body.includes('method_not_allowed'), `status=${replay.status} ${replay.body.slice(0, 60)}`);
    }
  }

  // R7: the bind refuses a path over the client's ceiling, loudly and by name.
  const longDir = join(root, 'x'.repeat(60), 'y'.repeat(40));
  let bindError = '';
  try {
    await new ModSocketServer({ socketPath: join(longDir, SOCKET_NAME), registry, holds, killSwitch: () => false, log: { warn: () => {} } }).start();
  } catch (error) {
    bindError = String((error as Error).message);
  }
  const longLength = Buffer.byteLength(join(longDir, SOCKET_NAME), 'utf8');
  check('a path over the 100 B ceiling fails the bind by name', bindError.includes('ceiling') && longLength > MOD_SOCKET_PATH_MAX_BYTES, `${longLength} bytes: ${bindError.slice(0, 70)}`);

  check('refusals were all reported to the caller', refusals.length > 8, `${refusals.length} refusals logged`);
  check('no framing refusal ever reached 5xx', !refusals.includes(undefined as unknown as string));
} catch (error) {
  check('no exception', false, String((error as Error)?.stack ?? error).slice(0, 300));
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `FAILED ${failed.length}/${results.length}` : `OK ${results.length}/${results.length} passed`}`);
process.exit(failed.length ? 1 : 0);
