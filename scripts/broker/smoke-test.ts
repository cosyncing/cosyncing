/**
 * Read-only smoke test: attaches to one OpenCode + one Pi session over the broker
 * WebSocket, verifies session info + history replay. Sends NO prompts (no LLM cost,
 * no session mutation). Usage: bun run scripts/broker/smoke-test.ts
 */
export {};

const BASE = process.env.BROKER ?? 'http://127.0.0.1:7734';

function summarize(msgs: any[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const m of msgs) c[m.type] = (c[m.type] ?? 0) + 1;
  return c;
}

async function probe(s: any, ms = 5000): Promise<boolean> {
  if (!s) {
    console.log('  (no session available)');
    return false;
  }
  const wsUrl = BASE.replace(/^http/, 'ws') + `/api/sessions/${encodeURIComponent(s.tool)}/${encodeURIComponent(s.id)}/stream`;
  console.log(`\n=== attach ${s.tool}: ${s.title} ===`);
  return await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(wsUrl);
    const live: Record<string, number> = {};
    let ok = false;
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.kind === 'session') console.log('  session ✓', m.info.title);
      else if (m.kind === 'history') {
        ok = true;
        console.log('  history ✓', m.messages.length, 'messages', JSON.stringify(summarize(m.messages)));
      } else if (m.kind === 'message') live[m.message.type] = (live[m.message.type] ?? 0) + 1;
      else if (m.kind === 'error') console.log('  ERROR:', m.message);
    };
    ws.onerror = () => console.log('  ws error');
    setTimeout(() => {
      if (Object.keys(live).length) console.log('  live messages:', JSON.stringify(live));
      try { ws.close(); } catch {}
      resolve(ok);
    }, ms);
  });
}

const { sessions } = await (await fetch(BASE + '/api/sessions')).json();
const pick = (tool: string) => sessions.find((s: any) => s.tool === tool);
console.log(`broker has ${sessions.length} sessions`);
const a = await probe(pick('opencode'));
const b = await probe(pick('pi'), 7000);
console.log(`\nRESULT: opencode=${a ? 'ok' : 'FAIL'} pi=${b ? 'ok' : 'FAIL'}`);
process.exit(0);
