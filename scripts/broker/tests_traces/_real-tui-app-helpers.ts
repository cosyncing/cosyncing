import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { refuseRetiredPocUiTrace } from './_app-trace-helpers.ts';

export interface Assertion {
  name: string;
  ok: boolean;
  detail?: string;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('could not allocate a free TCP port');
  const port = addr.port;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

export function record(path: string, obj: unknown): void {
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...(obj as Record<string, unknown>) }) + '\n');
}

export function check(assertions: Assertion[], name: string, ok: boolean, detail = ''): void {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
}

export async function command(cmd: string[], cwd?: string): Promise<{ ok: boolean; out: string; err: string; code: number }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, out, err, code };
}

export function drainProcessOutput(proc: ReturnType<typeof Bun.spawn>, path: string): void {
  for (const [name, stream] of [['stdout', proc.stdout], ['stderr', proc.stderr]] as const) {
    if (!stream || typeof stream === 'number') continue;
    void (async () => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), stream: name, text: decoder.decode(value) }) + '\n');
        }
      } catch {
        /* process ended */
      }
    })();
  }
}

export async function waitFrame<T>(frames: T[], pred: (f: T) => boolean, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const frame = frames.find(pred);
    if (frame) return frame;
    if (Date.now() > end) return undefined;
    await sleep(100);
  }
}

export async function submitTuiPromptAndWaitFrame<T>(opts: {
  tmuxName: string;
  prompt: string;
  frames: T[];
  predicate: (f: T) => boolean;
  timeoutMs: number;
}): Promise<T | undefined> {
  await tmux(['send-keys', '-t', opts.tmuxName, '--', opts.prompt]);
  await sleep(250);
  await tmux(['send-keys', '-t', opts.tmuxName, 'Enter']);
  return await waitFrame(opts.frames, opts.predicate, opts.timeoutMs);
}

export async function hasCommand(name: string): Promise<boolean> {
  return (await command(['bash', '-lc', `command -v ${shellQuote(name)}`])).ok;
}

export async function tmux(args: string[]): Promise<string> {
  const r = await command(['tmux', ...args]);
  if (!r.ok) throw new Error(`tmux ${args.join(' ')} failed: ${r.err || r.out}`);
  return r.out;
}

export async function tmuxOk(args: string[]): Promise<boolean> {
  return (await command(['tmux', ...args])).ok;
}

export async function tmuxCapture(name: string, scrollback = 300): Promise<string> {
  const r = await command(['tmux', 'capture-pane', '-p', '-t', name, '-S', `-${scrollback}`]);
  return r.out + r.err;
}

export async function waitHealth(url: string, ms = 15000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(1000, Math.max(100, end - Date.now())));
      try {
        if ((await fetch(url, { signal: controller.signal })).ok) return true;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  return false;
}

export async function waitForFile(path: string, ms: number): Promise<boolean> {
  const { existsSync } = await import('node:fs');
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(path)) return true;
    await sleep(250);
  }
  return false;
}

export async function waitForJsonFile(path: string, ms: number): Promise<any | undefined> {
  const { existsSync, readFileSync } = await import('node:fs');
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        return { error: `could not parse ${path}` };
      }
    }
    await sleep(250);
  }
  return undefined;
}

export function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function spawnPermissionClickDriver(opts: {
  home: string;
  base: string;
  token: string;
  screenshot: string;
  attachedFlag: string;
  resultFile: string;
  tool?: string;
  sessionId?: string;
}): ReturnType<typeof Bun.spawn> {
  refuseRetiredPocUiTrace();
  mkdirSync(opts.home, { recursive: true });
  const driverPath = join(opts.home, 'permission-driver.py');
  writeFileSync(driverPath, permissionDriverPy());
  return Bun.spawn([
    'python3',
    driverPath,
    opts.base,
    opts.token,
    opts.screenshot,
    opts.attachedFlag,
    opts.resultFile,
    opts.tool ?? '',
    opts.sessionId ?? '',
  ], {
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  });
}

export async function probeCodexDaemon(socketPath: string): Promise<{ ok: boolean; detail: string }> {
  const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let reqId = 0;
  let transport: CodexDaemonWebSocket | undefined;
  const write = (obj: unknown) => transport?.write(obj);
  const rpc = (method: string, params: unknown, timeoutMs = 5000): Promise<any> => {
    const rpcId = String(++reqId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(rpcId);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(rpcId, { resolve, reject, timer });
      write({ id: Number(rpcId), method, params });
    });
  };

  transport = new CodexDaemonWebSocket(socketPath, (line) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg?.id == null || (!('result' in msg) && !('error' in msg))) return;
    const p = pending.get(String(msg.id));
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(String(msg.id));
    msg.error ? p.reject(new Error(String(msg.error?.message ?? msg.error))) : p.resolve(msg.result);
  });

  try {
    await transport.connect();
    await rpc('initialize', {
      clientInfo: { name: 'cosyncing-trace-probe', title: 'cosyncing Trace Probe', version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    write({ method: 'initialized', params: {} });
    const resp: any = await rpc('thread/loaded/list', { limit: 100 }, 5000);
    const ids = Array.isArray(resp?.data) ? resp.data.map(String) : [];
    return { ok: true, detail: `loadedThreads=${ids.length}${ids.length ? ` ids=${ids.join(',')}` : ''}` };
  } catch (err) {
    return { ok: false, detail: String(err) };
  } finally {
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    transport?.close();
  }
}

export async function archiveCodexDaemonThread(socketPath: string, threadId: string): Promise<{ ok: boolean; detail: string }> {
  const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let reqId = 0;
  let transport: CodexDaemonWebSocket | undefined;
  const write = (obj: unknown) => transport?.write(obj);
  const rpc = (method: string, params: unknown, timeoutMs = 10000): Promise<any> => {
    const rpcId = String(++reqId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(rpcId);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(rpcId, { resolve, reject, timer });
      write({ id: Number(rpcId), method, params });
    });
  };

  transport = new CodexDaemonWebSocket(socketPath, (line) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg?.id == null || (!('result' in msg) && !('error' in msg))) return;
    const p = pending.get(String(msg.id));
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(String(msg.id));
    msg.error ? p.reject(new Error(String(msg.error?.message ?? msg.error))) : p.resolve(msg.result);
  });

  try {
    await transport.connect();
    await rpc('initialize', {
      clientInfo: { name: 'cosyncing-trace', title: 'cosyncing Trace', version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, 5000);
    write({ method: 'initialized', params: {} });
    await rpc('thread/archive', { threadId }, 10000);
    return { ok: true, detail: threadId };
  } catch (err) {
    return { ok: false, detail: `${threadId}: ${String(err)}` };
  } finally {
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    transport.close();
  }
}

class CodexDaemonWebSocket {
  private socket: Socket | undefined;
  private buffer = Buffer.alloc(0);
  private connected = false;
  private closed = false;

  constructor(
    private readonly socketPath: string,
    private readonly onMessage: (line: string) => void,
  ) {}

  connect(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath);
      this.socket = socket;
      const key = randomBytes(16).toString('base64');
      let handshake = Buffer.alloc(0);
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve();
      };
      const timer = setTimeout(() => finish(new Error('Codex daemon WebSocket handshake timed out')), timeoutMs);
      socket.on('connect', () => {
        socket.write(
          [
            'GET / HTTP/1.1',
            'Host: localhost',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n'),
        );
      });
      socket.on('data', (chunk) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!this.connected) {
          handshake = Buffer.concat([handshake, data]);
          const idx = handshake.indexOf('\r\n\r\n');
          if (idx === -1) return;
          const header = handshake.subarray(0, idx).toString('utf8');
          if (!/^HTTP\/1\.[01] 101\b/.test(header)) {
            finish(new Error(`Codex daemon WebSocket upgrade failed: ${header.split('\r\n')[0] || 'no status'}`));
            socket.destroy();
            return;
          }
          this.connected = true;
          finish();
          const rest = handshake.subarray(idx + 4);
          if (rest.length) this.consume(rest);
          return;
        }
        this.consume(data);
      });
      socket.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));
      socket.on('close', () => {
        this.closed = true;
      });
    });
  }

  write(obj: unknown): void {
    if (!this.socket || this.closed) return;
    this.socket.write(webSocketFrame(Buffer.from(JSON.stringify(obj), 'utf8'), 0x1));
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
    this.socket = undefined;
    this.buffer = Buffer.alloc(0);
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = readWebSocketFrame(this.buffer);
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.bytes);
      if (frame.opcode === 0x1) {
        this.onMessage(frame.payload.toString('utf8'));
      } else if (frame.opcode === 0x8) {
        this.close();
        return;
      } else if (frame.opcode === 0x9 && this.socket && !this.closed) {
        this.socket.write(webSocketFrame(frame.payload, 0xA));
      }
    }
  }
}

function webSocketFrame(payload: Buffer, opcode: number): Buffer {
  const mask = randomBytes(4);
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
      : payload.length <= 0xffff
        ? Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 126]), u16(payload.length)])
        : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), u64(payload.length)]);
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([header, mask, out]);
}

function readWebSocketFrame(buf: Buffer): { opcode: number; payload: Buffer; bytes: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0]! & 0x0f;
  const masked = Boolean(buf[1]! & 0x80);
  let len = buf[1]! & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    const big = buf.readBigUInt64BE(off);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Codex daemon WebSocket frame is too large.');
    len = Number(big);
    off += 8;
  }
  const mask = masked ? buf.subarray(off, off + 4) : undefined;
  if (masked) off += 4;
  if (buf.length < off + len) return null;
  let payload = buf.subarray(off, off + len);
  if (mask) {
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i]! ^ mask[i % 4]!;
    payload = out;
  }
  return { opcode, payload, bytes: off + len };
}

function u16(n: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(n);
  return buf;
}

function u64(n: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(n));
  return buf;
}

function permissionDriverPy(): string {
  return String.raw`
import json, sys
try:
    from playwright.sync_api import sync_playwright
except Exception as e:
    open(sys.argv[5], "w").write(json.dumps({"skip": "playwright import: " + str(e)})); sys.exit(0)

url, token, shot, attached, result = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
tool = sys.argv[6] if len(sys.argv) > 6 else ""
session_id = sys.argv[7] if len(sys.argv) > 7 else ""
out = {}

def save(page, data):
    try:
        page.screenshot(path=shot)
    except Exception:
        pass
    open(result, "w").write(json.dumps(data))

with sync_playwright() as p:
    try:
        browser = p.chromium.launch(headless=True)
    except Exception as e:
        open(result, "w").write(json.dumps({"skip": "chromium launch: " + str(e)})); sys.exit(0)

    page = browser.new_page()
    page.goto(url.rstrip('/') + '/poc-ui/', wait_until="domcontentloaded")  # PoC moved off root → /poc-ui/ (D6)
    try:
        page.wait_for_load_state("networkidle", timeout=3000)
    except Exception:
        pass
    page.wait_for_timeout(1200)

    try:
        if tool and session_id:
            exact = page.evaluate("""async ({tool, session_id}) => {
                const res = await fetch("/api/sessions");
                const payload = await res.json();
                const sessions = Array.isArray(payload) ? payload : (Array.isArray(payload?.sessions) ? payload.sessions : []);
                const s = (sessions || []).find((x) => x && x.tool === tool && x.id === session_id);
                if (!s) return { ok: false, error: "exact session not found", count: (sessions || []).length };
                return { ok: true, title: s.title || s.id, tool: s.tool, id: s.id, cwd: s.cwd || "" };
            }""", {"tool": tool, "session_id": session_id})
            out["exactSession"] = exact
        search = page.locator("#sessionSearch")
        if search.count() > 0:
            search.fill(token)
            page.wait_for_timeout(1000)
        project = page.locator("#rosterList .project", has_text=token).first
        if project.count() > 0:
            head = project.locator(".projectHead").first
            rows = project.locator(".srow")
            if rows.count() == 0 or not rows.first.is_visible():
                head.click(timeout=10000, force=True)
                page.wait_for_timeout(1000)
            rows = project.locator(".srow")
            if rows.count() == 0 or not rows.first.is_visible():
                head.evaluate("el => el.click()")
                page.wait_for_timeout(1000)
            row = project.locator(".srow", has_text=token).first
            if row.count() == 0:
                row = project.locator(".srow").first
            row.click(timeout=15000)
        else:
            row = page.locator("#rosterList .srow", has_text=token).first
            if row.count() > 0:
                row.click(timeout=15000)
            else:
                save(page, {"error": "open session: no row or project matched token " + token})
                browser.close()
                sys.exit(0)
    except Exception as e:
        save(page, {"error": "open session: " + str(e)})
        browser.close()
        sys.exit(0)

    page.wait_for_timeout(1800)
    open(attached, "w").write("1")

    try:
        page.wait_for_selector("[id^='perm-'] button.ok", state="visible", timeout=120000)
        out["cardShown"] = True
        allow = page.locator("[id^='perm-'] button.ok").first
        out["card"] = allow.evaluate("""btn => {
            const c = btn.closest("[id^='perm-']");
            if (!c) return null;
            return {
                id: c.id,
                pending: c.getAttribute("data-pending-input"),
                title: (c.textContent || "").slice(0, 180),
                hasAllow: !!c.querySelector("button.ok")
            };
        }""")
        allow.click(timeout=10000)
        out["approved"] = True
        page.wait_for_timeout(1800)
        card_id = out["card"]["id"] if out.get("card") else ""
        out["afterAllow"] = page.evaluate("""cardId => {
            const c = cardId ? document.getElementById(cardId) : null;
            if (!c) return { cleared: true };
            const ok = c.querySelector("button.ok");
            return {
                cleared: false,
                allowGone: !ok,
                disabled: ok ? ok.disabled === true : null,
                pending: c.getAttribute("data-pending-input")
            };
        }""", card_id)
    except Exception as e:
        out["error"] = "permission card / approve: " + str(e)

    save(page, out)
    browser.close()
`;
}
