/**
 * The one hand-written HTTP/1.1 parser in the product, and its exact contract.
 *
 * Why it exists: the Claude mod socket must answer "which process is on the other end",
 * and under Bun that answer only comes from `Bun.listen({ unix })` plus `getsockopt` on
 * `socket.fd`. `Bun.serve({ unix })` speaks HTTP but exposes no descriptor and no peer
 * address (`server.requestIP` is `undefined` for a Unix connection), so it cannot carry the
 * check. The listener speaks no HTTP. Hence this file.
 *
 * Nine rules, each one either a security property or a measured fact about the only client
 * this server ever talks to (Claude Code 2.1.288's `$.http.fetch`, whose request shapes are
 * recorded in `test/claude/fixtures/claude-fetch-requests.json`):
 *
 * 1. One request per connection. Answer, then `connection: close` and end. A `hold` can sit
 *    open for 20 s; a reused connection could deliver one turn's verdict to the next.
 * 2. `Content-Length` is required on anything that must carry a body, because there is no
 *    other framing on offer. Absent or unparseable is `400 content_length_required`.
 * 3. POST only. A bodiless `GET` from this client carries no `Content-Length` at all
 *    (measured), so accepting GETs would buy a second framing rule for nothing.
 * 4. `Transfer-Encoding` or `Expect` present is `400 unsupported_header`, decided before any
 *    body is read: chunked is a second framing scheme, and `Expect: 100-continue` means the
 *    client is waiting for a reply we never send.
 * 5. Bytes after the declared body are `400 trailing_bytes`. That is pipelining or request
 *    smuggling, and this reader is one-request-per-connection by contract.
 * 6. A header block over `MAX_HEADER_BYTES` is `431 header_too_large`. A fixed ceiling beats
 *    an unbounded buffer on a socket any same-uid process can open.
 * 7. A declared body over `MAX_BODY_BYTES` is `413 body_too_large`, answered off the header
 *    alone and before the body is read. The largest real body measured here was 117 bytes.
 * 8. A header block that never completes is `408 header_deadline`. The client opens eagerly,
 *    so a half-open connection must not live forever.
 * 9. A request split across reads is reassembled. Measured shapes: whole, split in thirds,
 *    split mid-header, and one byte per read all parse to the same request.
 *
 * Five more, all added by the 2026-10-05 review after each was reproduced against a raw socket:
 *
 * 10. `Content-Length` must be a plain decimal integer. `Number('')` is `0`, so an empty value
 *     would otherwise read as a legitimate bodiless POST; the shape is checked before the value. A
 *     repeated `Content-Length` with two different values is refused rather than resolved, because
 *     "the last one wins" is a parser that agrees with the smuggler.
 * 11. `Transfer-Encoding` and `Expect` are refused when the field is PRESENT. `Expect:` with an
 *     empty value is still an `Expect`, and the client behind it is still waiting for a
 *     `100-continue` this server will never send.
 * 12. A header line without a colon, or a folded continuation line, is `400 malformed_header`.
 *     Every tolerance in a request reader is a place where two parsers can disagree.
 * 13. A body that never completes is `408 body_deadline`. Rule 8 covers the header block only, so
 *     without this a client that declares 64 KB and sends 3 bytes parks a connection forever.
 * 14. Bytes arriving after the request was handed to a handler are DROPPED, not buffered. The
 *     response is on its way and this connection answers one request, so anything further is
 *     pipelining or a client already told to close.
 *
 * Response writes are the other half of the contract, and the reason `respond()` is asynchronous.
 * Measured on Linux (Bun 1.3.14) and macOS 26 arm64 (Bun 1.3.8): `socket.end(payload)` and a single
 * `socket.write(payload)` stop at 219264 bytes on Linux and at 8192 bytes on macOS, and
 * report how far they got. NOTHING is buffered internally -- `getBufferedAmount` does not even
 * exist on a `Bun.listen` socket -- so the rest of the payload is simply gone. `drain` fires for
 * `write` and never for `end`, and a writer that waits for it instead of looping has no timeout.
 * So a response is written in a loop that retries while the descriptor reports backpressure, and
 * `respond()` resolves false when it could not get every byte out. A caller that queued something
 * for delivery has to put it back in that case: the body is one JSON document, so a partial write
 * delivered nothing at all, and a prompt that arrives one poll late beats a prompt that vanished.
 *
 * Nothing here is a guess about the client. Header names are matched case-insensitively
 * because the real client sends `Content-Type`, not `content-type`; responses never set
 * `content-encoding` because the real client advertises `gzip, deflate, br, zstd`, so a
 * compressed reply would be honoured by it and has to be a deliberate choice instead.
 *
 * `onRequest` does not answer. The handler is allowed to take twenty seconds on a long-poll,
 * so the caller answers with `respond()` when it is ready, and that is what closes the
 * connection. Until then the connection is owned by exactly one handler, which is what makes
 * "one request per connection" true rather than merely intended.
 */

/** Rule 6: the ceiling on the request line plus header block, in bytes. */
export const MAX_HEADER_BYTES = 8 * 1024;
/** Rule 7: the ceiling on a declared body, in bytes. */
export const MAX_BODY_BYTES = 64 * 1024;
/** Rule 8: how long a connection may spend not finishing its header block. */
export const HEADER_DEADLINE_MS = 5_000;
/**
 * Ceiling on simultaneously open mod-socket connections.
 *
 * Not a framing rule but the listener's, and it lives here because the listener is this file's
 * only caller. Sizing: one parked `poll` per registered terminal for up to 20 s, plus a second
 * while a hold's verdict is being waited for, so 64 covers dozens of terminals and is small enough
 * that a same-uid process opening this socket in a loop cannot make the broker hold thousands of
 * readers and timers.
 */
export const MAX_LIVE_CONNECTIONS = 64;
/** Rule 13: how long a declared body may take to arrive. */
export const BODY_DEADLINE_MS = 10_000;
/** How long a produced response may take to leave this process. */
export const WRITE_DEADLINE_MS = 10_000;

/** The stable code strings this reader can answer with. They are wire-visible; do not rename. */
export type HttpFramingRefusal =
  | 'method_not_allowed'
  | 'unsupported_header'
  | 'content_length_required'
  | 'trailing_bytes'
  | 'header_too_large'
  | 'body_too_large'
  | 'header_deadline'
  | 'body_deadline'
  | 'malformed_header'
  | 'duplicate_content_length'
  | 'request_line';

export interface ParsedHttpRequest {
  method: string;
  /** The absolute-form target, query included, exactly as it arrived. */
  target: string;
  /** Lower-cased header names, trimmed values. */
  headers: Record<string, string>;
  body: string;
  /** The declared body length, which equals the body's byte length for an accepted request. */
  contentLength: number;
  /** The request line plus header block, terminator excluded, for fixture assertions. */
  rawBlock: string;
}

/**
 * A connection the reader can drive. Shaped to Bun's `Bun.listen` socket so tests can fake it.
 *
 * `write` is what makes a whole response possible; `end` alone cannot, because it reports the bytes
 * it managed to send and drops the rest. A fake without `write` gets the response through `end`,
 * which is honest for a fake that never applies backpressure.
 *
 * There is deliberately no `data` member here. On a `Bun.listen` socket `socket.data` is the
 * caller's own per-connection bag -- the server parks its connection state on it -- so a method
 * with that name in this interface would describe a different thing than the object has.
 */
export interface ReaderSocket {
  fd?: number;
  end(data?: string | Uint8Array): unknown;
  write?(data: Uint8Array): number;
}

export interface HttpRequestReaderOptions {
  /** The peer descriptor and the decoded request. Does not answer; call `respond()`. */
  onRequest?: (socket: ReaderSocket, fd: number, request: ParsedHttpRequest) => void;
  /** Every refusal, so a caller can log a reason without parsing the response. */
  onRefuse?: (socket: ReaderSocket, code: HttpFramingRefusal, detail: string) => void;
  /** Header-block deadline. Overridable so the suite does not have to wait five seconds. */
  headerDeadlineMs?: number;
  /** Timer injection, for the deadline test. */
  armTimer?: (callback: () => void, ms: number) => unknown;
  cancelTimer?: (handle: unknown) => void;
  /** Backpressure wait between write attempts. Injectable so a suite does not really wait. */
  sleep?: (ms: number) => Promise<void>;
  /** A response that could not be written in full. The caller owns whatever it was carrying. */
  onUndelivered?: (socket: ReaderSocket, detail: string) => void;
  /** Body and write deadlines. Suites shorten them; production uses the defaults. */
  bodyDeadlineMs?: number;
  writeDeadlineMs?: number;
}

interface ConnectionState {
  /** Raw bytes received so far, held one byte per char via latin1. */
  buffer: string;
  /** Offset just past the header terminator, 0 until the header block completes. */
  headerEnd: number;
  /** Declared body length, meaningful once `headerEnd` is set. */
  contentLength: number;
  /** The parsed header block, kept so dispatch does not re-parse what was already refused-on. */
  headers: Record<string, string>;
  /** Terminal: no further byte and no further response from this connection. */
  settled: boolean;
  /** A request was handed to a handler, so only that handler may still answer. */
  inFlight: boolean;
  timer?: unknown;
  /** Rule 13's timer, armed the moment a header block declares a body. */
  bodyTimer?: unknown;
  /** A response stopped being ours to deliver. Nothing after it may answer this connection. */
  undelivered: boolean;
  /** The peer hung up. A response written now goes nowhere, and the writer says so instead. */
  closed: boolean;
}

/** Why a response did not get out, in the words the log line uses. */
type UndeliveredReason = 'the connection had closed' | 'the socket refused the write' | 'the peer stopped reading';

/** What one attempt to write a response came to. */
interface WriteOutcome {
  written: boolean;
  elapsedMs: number;
  reason?: UndeliveredReason;
}

const CRLF = '\r\n';

function toLatin1(chunk: string | ArrayBuffer | Uint8Array): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('latin1');
  return Buffer.from(chunk).toString('latin1');
}

/** What `headerFields` answers: the fields, or the reason the block is refused. */
type HeaderParse = { headers: Record<string, string>; duplicatedContentLength: boolean } | { error: string };

/**
 * Rule 12, with rule 10's duplicate check folded in.
 *
 * Strict on purpose: a folded continuation line is refused rather than joined, because joining is
 * exactly the ambiguity that lets `X-Foo: bar` plus a continuation mean one thing here and another
 * thing in the next hop. Repeated fields are kept at their first value -- a `Host: a` beside a
 * `Host: b` is a refusal only when the repeats disagree.
 */
function headerFields(block: string): HeaderParse {
  const headers: Record<string, string> = {};
  let duplicatedContentLength = false;
  for (const line of block.split(CRLF).slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) return { error: `header line without a field name (${line.slice(0, 40)})` };
    const rawName = line.slice(0, colon);
    const name = rawName.trim().toLowerCase();
    if (name.length === 0 || /\s/.test(rawName)) return { error: 'header field name is not a token' };
    const value = line.slice(colon + 1).trim();
    if (name in headers) {
      if (name === 'content-length' && headers[name] !== value) duplicatedContentLength = true;
      continue;
    }
    headers[name] = value;
  }
  return { headers, duplicatedContentLength };
}

/** One response shape for every outcome: `content-length` and `connection: close`, never an encoding. */
export function renderHttpResponse(status: number, body: string): string {
  const reason =
    status === 200 ? 'OK'
      : status === 400 ? 'Bad Request'
        : status === 405 ? 'Method Not Allowed'
          : status === 408 ? 'Request Timeout'
            : status === 413 ? 'Payload Too Large'
              : status === 431 ? 'Request Header Fields Too Large'
                : status === 500 ? 'Internal Server Error'
                  : 'Unknown';
  return `HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body, 'utf8')}\r\nconnection: close\r\n\r\n${body}`;
}

function refusalBody(code: HttpFramingRefusal): string {
  return `{"ok":false,"code":"${code}"}`;
}

/**
 * A stateful HTTP/1.1 reader for one `Bun.listen` connection.
 *
 * Create one per connection, in `socket.open()`. Bun's `listen({ data })` value is shared by
 * every connection, so state built outside `open()` is state shared between mods: the spike
 * watched three clean clients look like one client with three connections until the state
 * moved into `open()`. That is risk R1, and this shape is its mitigation.
 */
export class Http1RequestReader {
  private readonly state: ConnectionState = {
    buffer: '', headerEnd: 0, contentLength: 0, headers: {}, settled: false, inFlight: false, undelivered: false, closed: false,
  };
  private readonly options: HttpRequestReaderOptions;
  private readonly deadlineMs: number;
  private readonly bodyDeadlineMs: number;
  private readonly writeDeadlineMs: number;

  /** True once a response for this connection could not be delivered in full. */
  get undelivered(): boolean {
    return this.state.undelivered;
  }

  constructor(options: HttpRequestReaderOptions = {}) {
    this.options = options;
    this.deadlineMs = options.headerDeadlineMs ?? HEADER_DEADLINE_MS;
    this.bodyDeadlineMs = options.bodyDeadlineMs ?? BODY_DEADLINE_MS;
    this.writeDeadlineMs = options.writeDeadlineMs ?? WRITE_DEADLINE_MS;
  }

  /** Arm the header deadline. Call this from `socket.open()`. */
  open(socket: ReaderSocket): void {
    const arm = this.options.armTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms) as unknown);
    this.state.timer = arm(() => this.expireHeaders(socket), this.deadlineMs);
  }

  onData(socket: ReaderSocket, chunk: string | ArrayBuffer | Uint8Array): void {
    // Rules 1 and 14. Once a handler owns the connection the response is on its way, so any further
    // byte is pipelining or a client that was already told to close; buffering it would be an
    // unbounded buffer on a socket any same-uid process can open.
    if (this.state.settled || this.state.inFlight) return;
    this.state.buffer += toLatin1(chunk);
    this.evaluate(socket);
  }

  onClose(): void {
    this.state.closed = true;
    this.disarm();
    this.disarmBody();
  }

  /** True once this connection has been answered or refused; a second request is never served. */
  get settled(): boolean {
    return this.state.settled;
  }

  /**
   * Write the one response this connection will get, then finish the connection.
   *
   * Resolves true when every byte left this process, false when it could not. The difference is not
   * academic: a `poll` response carries the command the user typed, and a truncated write delivers
   * nothing at all, so the caller has to decide whether to put the command back.
   */
  async respond(socket: ReaderSocket, status: number, body: string): Promise<boolean> {
    if (this.state.settled) return false;
    this.settle();
    const outcome = await this.writeAll(socket, renderHttpResponse(status, body));
    if (!outcome.written) {
      this.state.undelivered = true;
      this.options.onUndelivered?.(socket, `response of ${Buffer.byteLength(body, 'utf8')} bytes undelivered after ${outcome.elapsedMs} ms: ${this.explain(outcome)}`);
    }
    return outcome.written;
  }

  /** The log's words for a write that failed: what happened, and for a stall, the limit it hit. */
  private explain(outcome: WriteOutcome): string {
    return outcome.reason === 'the peer stopped reading'
      ? `the peer stopped reading (write deadline ${this.writeDeadlineMs} ms)`
      : outcome.reason ?? 'unknown';
  }

  /**
   * Get `text` out, in full, or say that it did not go.
   *
   * `end(data)` and a single `write(data)` both stop at the socket buffer and report how far they
   * got -- 219264 bytes on this Linux build, 8192 on macOS, with nothing buffered for them
   * internally. So the loop retries while the descriptor reports backpressure (`write` answering 0),
   * and gives up at the deadline rather than holding a connection open for a client that stopped
   * reading. Measured with the loop in place: 8 MB reaches the peer on both hosts, in 40 writes and
   * 8 ms here, 1024 writes and 1.3 s on macOS.
   */
  private async writeAll(socket: ReaderSocket, text: string): Promise<WriteOutcome> {
    const startedAt = Date.now();
    const result = (written: boolean, reason?: UndeliveredReason): WriteOutcome => ({
      written,
      elapsedMs: Date.now() - startedAt,
      ...(reason ? { reason } : {}),
    });
    // A peer that has hung up is told nothing, and the caller is told so: writing into a closed
    // socket used to be reported as a write that "did not leave in 10000 ms" when it had failed at
    // once, and a parked poll's command was counted as sent to a terminal that was already gone.
    if (this.state.closed) return result(false, 'the connection had closed');
    const bytes = Buffer.from(text, 'utf8');
    if (typeof socket.write !== 'function') {
      // A fake that cannot report partial writes: one call is the whole response.
      socket.end(bytes);
      return result(true);
    }
    const sleep = this.options.sleep
      ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    let offset = 0;
    for (;;) {
      const written = socket.write(bytes.subarray(offset));
      if (typeof written !== 'number' || written < 0) {
        socket.end();
        return result(false, 'the socket refused the write');
      }
      offset += written;
      if (offset >= bytes.length) {
        socket.end();
        return result(true);
      }
      if (Date.now() - startedAt > this.writeDeadlineMs) {
        socket.end();
        return result(false, 'the peer stopped reading');
      }
      await sleep(written === 0 ? 2 : 0);
      // The peer can hang up while the writer waits for it to drain; the rest has nowhere to go.
      if (this.state.closed) return result(false, 'the connection had closed');
    }
  }

  private disarm(): void {
    if (this.state.timer === undefined) return;
    this.cancelHandle(this.state.timer);
    this.state.timer = undefined;
  }

  private disarmBody(): void {
    if (this.state.bodyTimer === undefined) return;
    this.cancelHandle(this.state.bodyTimer);
    this.state.bodyTimer = undefined;
  }

  private cancelHandle(handle: unknown): void {
    const cancel = this.options.cancelTimer ?? ((value: unknown) => clearTimeout(value as never));
    cancel(handle);
  }

  private settle(): void {
    this.state.settled = true;
    this.disarm();
  }

  private refuse(socket: ReaderSocket, status: number, code: HttpFramingRefusal, detail: string): void {
    if (this.state.settled) return;
    this.options.onRefuse?.(socket, code, detail);
    // A refusal body is 40 bytes at most, well inside one write, so its write result is not a
    // decision anyone has to act on. It is still awaited defensively so a hung descriptor cannot
    // leave this promise dangling.
    void this.writeAll(socket, renderHttpResponse(status, refusalBody(code))).then((outcome) => {
      if (!outcome.written) this.options.onUndelivered?.(socket, `refusal ${code} undelivered after ${outcome.elapsedMs} ms: ${this.explain(outcome)}`);
    });
    this.settle();
  }

  private expireHeaders(socket: ReaderSocket): void {
    if (this.state.settled || this.state.headerEnd) return;
    this.refuse(socket, 408, 'header_deadline', `header block incomplete after ${this.deadlineMs} ms`);
  }

  private expireBody(socket: ReaderSocket): void {
    if (this.state.settled || this.state.inFlight) return;
    this.refuse(socket, 408, 'body_deadline', `declared body of ${this.state.contentLength} bytes never arrived`);
  }

  private evaluate(socket: ReaderSocket): void {
    if (!this.state.headerEnd) {
      const terminator = this.state.buffer.indexOf(CRLF + CRLF);
      if (terminator < 0) {
        // Rule 6, the eager form: no terminator in sight and already past the ceiling. Only here,
        // after the terminator has been looked for: a body that arrived in the same write as a
        // small header block is not header bytes, and measuring the whole buffer counted it.
        if (Buffer.byteLength(this.state.buffer, 'latin1') > MAX_HEADER_BYTES) {
          this.refuse(socket, 431, 'header_too_large', `header block exceeded ${MAX_HEADER_BYTES} bytes`);
        }
        return; // rule 9: keep reassembling
      }
      const rawBlock = this.state.buffer.slice(0, terminator);
      if (Buffer.byteLength(rawBlock, 'latin1') > MAX_HEADER_BYTES) {
        this.refuse(socket, 431, 'header_too_large', `header block was ${Buffer.byteLength(rawBlock, 'latin1')} bytes`);
        return;
      }
      this.disarm(); // the deadline covers the header block only, never a long-poll handler
      this.state.headerEnd = terminator + 4;

      const requestLine = rawBlock.split(CRLF)[0] ?? '';
      const parts = requestLine.split(' ');
      // Exactly three tokens. A fourth is not a request line anyone means, and `parts.length < 3`
      // alone would let `POST /x HTTP/1.1 junk` through to a handler that reads a target.
      if (parts.length !== 3 || !/^HTTP\/1\.[01]$/.test(parts[2] ?? '')) {
        this.refuse(socket, 400, 'request_line', `unparsable request line (${requestLine.slice(0, 80)})`);
        return;
      }
      const method = parts[0]!;

      // Rule 3, decided before framing: a GET from this client carries no Content-Length, so
      // method is the honest reason and framing never gets to invent a different one.
      if (method !== 'POST') {
        this.refuse(socket, 405, 'method_not_allowed', `${method} is not part of the mod protocol`);
        return;
      }

      const parsed = headerFields(rawBlock);
      if ('error' in parsed) {
        this.refuse(socket, 400, 'malformed_header', parsed.error);
        return;
      }
      const headers = parsed.headers;

      // Rule 4, before the body is read: PRESENCE decides, not truthiness. `Expect:` with an empty
      // value still means a client waiting for a `100-continue` that this server never sends.
      const framing = headers['transfer-encoding'] !== undefined ? 'transfer-encoding'
        : headers['expect'] !== undefined ? 'expect' : undefined;
      if (framing !== undefined) {
        this.refuse(socket, 400, 'unsupported_header', `${framing} is not supported`);
        return;
      }

      // Rules 2 and 10. Digits only: `Number('')` is 0, `Number('0x10')` is 16 and `Number('1e3')`
      // is 1000, all of which would otherwise be read as a declared body length.
      if (parsed.duplicatedContentLength) {
        this.refuse(socket, 400, 'duplicate_content_length', 'two content-length values that disagree');
        return;
      }
      const declared = headers['content-length'];
      if (declared === undefined || !/^\d+$/.test(declared)) {
        this.refuse(socket, 400, 'content_length_required', `content-length ${declared === undefined ? 'absent' : `is not a decimal integer (${declared.slice(0, 24)})`}`);
        return;
      }
      const contentLength = Number(declared);

      // Rule 7, answered off the header alone, before the body arrives.
      if (contentLength > MAX_BODY_BYTES) {
        this.refuse(socket, 413, 'body_too_large', `declared ${contentLength} bytes, ceiling ${MAX_BODY_BYTES}`);
        return;
      }
      this.state.contentLength = contentLength;
      this.state.headers = headers;
      // Rule 13: a declared body that stops arriving is a parked connection. The header deadline is
      // already disarmed by now, so this is the only thing that ends such a connection.
      if (contentLength > 0) {
        const arm = this.options.armTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms) as unknown);
        this.state.bodyTimer = arm(() => this.expireBody(socket), this.bodyDeadlineMs);
      }
    }

    if (this.state.inFlight) return; // a handler already owns this connection
    const bodyStart = this.state.headerEnd;
    const haveBytes = Buffer.byteLength(this.state.buffer.slice(bodyStart), 'latin1');
    if (haveBytes < this.state.contentLength) return; // rule 9: body still arriving across reads
    if (haveBytes > this.state.contentLength) {
      this.refuse(socket, 400, 'trailing_bytes', `${haveBytes - this.state.contentLength} bytes after the declared body`);
      return;
    }

    const rawBlock = this.state.buffer.slice(0, this.state.headerEnd - 4);
    const parts = (rawBlock.split(CRLF)[0] ?? '').split(' ');
    const body = Buffer.from(this.state.buffer.slice(bodyStart), 'latin1').toString('utf8');
    this.disarmBody(); // the body is here; from here the handler's own deadline owns the connection
    this.state.inFlight = true;
    // The body is no longer needed once decoded; drop it so a 20 s hold is not holding bytes.
    this.state.buffer = '';
    this.options.onRequest?.(socket, socket.fd ?? -1, {
      method: parts[0]!,
      target: parts[1]!,
      headers: this.state.headers,
      body,
      contentLength: this.state.contentLength,
      rawBlock,
    });
  }
}
