#!/usr/bin/env bun
/**
 * Coexistence test — the CO-CLIENT probe. Connects to the channel bridge Unix socket as ANOTHER client
 * (claude.ai's cse_ bridge is attached separately, on the RPC side), logs every frame, and lets you inject
 * prompts + answer permissions — so you can verify first-answer-wins between OUR channel and claude.ai.
 *
 * It speaks the verified socket protocol (NDJSON, see packages/typescript/adapters/claude/plugin/server.ts):
 *   server→us:  {type:'hello',…}  {type:'permission_request',request_id,tool_name,description,…}  {type:'reply',text}  {type:'file',…}
 *   us→server:  {type:'prompt',id,text[,file_path]}     {type:'permission',request_id,behavior:'allow'|'deny'}
 *
 * Usage:  bun run scripts/broker/coexistence-test/probe.ts [sockPath]      (auto-finds the newest socket if omitted)
 * Then type:   prompt <text>   |   allow [request_id]   |   deny [request_id]   |   quit
 * Everything is mirrored to ~/.claude/cosyncing/bridge/coexist-probe.log (paste it back for analysis).
 */
import { connect } from 'node:net';
import { readdirSync, statSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const BRIDGE = join(homedir(), '.claude', 'cosyncing', 'bridge');
const LOG = join(BRIDGE, 'coexist-probe.log');

function newestSock(): string | undefined {
  try {
    const socks = readdirSync(BRIDGE)
      .filter((f) => f.endsWith('.sock'))
      .map((f) => ({ p: join(BRIDGE, f), m: statSync(join(BRIDGE, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return socks[0]?.p;
  } catch {
    return undefined;
  }
}

const sockPath = process.argv[2] ?? newestSock();
const ts = (): string => new Date().toISOString();
function out(s: string): void {
  const line = `${ts()} ${s}`;
  console.log(line);
  try { appendFileSync(LOG, line + '\n'); } catch { /* ignore */ }
}

if (!sockPath) {
  out(`✗ no .sock under ${BRIDGE} — launch the session first (launch.sh)`);
  process.exit(1);
}

let lastRid = '';
out(`PROBE → connecting to ${sockPath}`);
const sock = connect(sockPath);
let buf = '';

sock.on('connect', () => out('CONNECTED as a co-client. Commands:  prompt <text> | allow [rid] | deny [rid] | quit'));
sock.on('data', (b: Buffer) => {
  buf += b.toString('utf8');
  let nl: number;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const ln = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!ln) continue;
    out('FRAME<= ' + ln);
    try {
      const o = JSON.parse(ln);
      if (o.type === 'hello') out('  ↳ handshake OK — sessionId=' + o.sessionId + ' pid=' + o.pid);
      if (o.type === 'permission_request' && o.request_id) {
        lastRid = String(o.request_id);
        out('  ↳ PERMISSION over OUR channel: request_id=' + lastRid + ' tool=' + (o.tool_name ?? '?') + '  → type "allow" or "deny"');
      }
    } catch { /* non-JSON frame */ }
  }
});
sock.on('error', (e) => out('ERROR ' + String(e)));
sock.on('close', () => { out('SOCKET CLOSED (session ended / bridge died)'); process.exit(0); });

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const parts = line.trim().split(/\s+/);
  const cmd = parts[0];
  const rest = parts.slice(1);
  if (cmd === 'prompt') {
    const text = rest.join(' ');
    sock.write(JSON.stringify({ type: 'prompt', id: 'probe' + Date.now(), text }) + '\n');
    out('INJECT=> ' + text);
  } else if (cmd === 'allow' || cmd === 'deny') {
    const rid = rest[0] || lastRid;
    if (!rid) { out('no request_id seen yet — wait for a permission_request frame'); return; }
    sock.write(JSON.stringify({ type: 'permission', request_id: rid, behavior: cmd === 'allow' ? 'allow' : 'deny' }) + '\n');
    out('ANSWER=> ' + cmd + ' ' + rid + ' (over OUR channel — first answer wins)');
  } else if (cmd === 'quit' || cmd === 'exit') {
    try { sock.destroy(); } catch { /* ignore */ }
    process.exit(0);
  } else if (cmd) {
    out('unknown: ' + cmd + '  (use: prompt <text> | allow [rid] | deny [rid] | quit)');
  }
});
