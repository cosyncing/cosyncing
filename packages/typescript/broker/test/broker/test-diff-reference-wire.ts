/**
 * End-to-end WebSocket proof for the oversized-diff reference (T1b R3 finding 5):
 * spin a REAL broker, inject a tool-result whose diff exceeds the 32 KiB inline
 * cap through the Pi bridge, attach a phone WebSocket in `reference` mode, and
 * assert the HISTORY frame carries a `diffRef` (no inline body) — then fetch the
 * signed URL and confirm the full body is served. This exercises the actual
 * runtime attach + egress-swap path, not a hand-rolled call sequence (which
 * `test-diff-body-reference.ts` covers at the unit level).
 *
 * Second scenario (R4 finding 5): inject MORE oversized edits than the initial
 * history cap, attach with `?initialHistory=3`, assert the truncated history
 * frame references only the newest diffs (cap-then-reference), then send a REAL
 * `history-page` frame over the same socket and assert the older page is also
 * reference-swapped — locking the paging/capping route through the live runtime.
 *
 * Run: bun run packages/typescript/broker/test/broker/test-diff-reference-wire.ts
 */
export {};
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  reserveLoopbackFixturePort,
  startHealthyFixtureBrokerOnPort,
} from '../helpers/isolated-broker-fixture.ts';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

// A single-file edit whose unified diff is ~56 KiB — well past the 32 KiB inline
// cap, so `reference` mode moves it behind a signed diffRef.
function bigDiff(): string {
  const out: string[] = ['--- a/lib/huge.dart', '+++ b/lib/huge.dart', '@@ -1,600 +1,600 @@'];
  for (let i = 0; i < 600; i++) {
    out.push(`-old line ${i} with enough text to be realistic`, `+new line ${i} with enough text to be realistic`);
  }
  return out.join('\n');
}

// Distinct oversized diff per index: path and every line carry `i`, so each
// edit hashes to a different content blob (real paging must return different items).
function bigDiffFor(i: number): string {
  const out: string[] = [`--- a/lib/huge_${i}.dart`, `+++ b/lib/huge_${i}.dart`, '@@ -1,600 +1,600 @@'];
  for (let line = 0; line < 600; line++) {
    out.push(
      `-old line ${line} of file ${i} with enough text to be realistic`,
      `+new line ${line} of file ${i} with enough text to be realistic`,
    );
  }
  return out.join('\n');
}

const portLease = await reserveLoopbackFixturePort();
const PORT = Number(process.env.COSYNCING_TEST_PORT ?? portLease.port);
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Isolated state home so a fresh broker does not inherit the dev broker's
// persisted pi-integration URL (which would fail the credential-state check);
// no autoserve so it leaves any already-running opencode serve untouched.
const stateHome = mkdtempSync(join(tmpdir(), 'ca-diffwire-home-'));
await portLease.release();
// Started through the shared helper: a silent startup stall — alive, not
// listening, nothing written — is retired and respawned once on THIS port
// instead of costing the suite its whole readiness budget.
let brokerOutput!: ReturnType<typeof captureProcessOutput>;
const broker = await startHealthyFixtureBrokerOnPort({
  port: PORT,
  healthUrl: `${BROKER}/api/health`,
  spawn: () => {
    const child = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
      env: isolatedBrokerFixtureEnvironment(stateHome, {
        overrides: {
          PORT: String(PORT),
          HOST: '127.0.0.1',
          COSYNCING_HOME: stateHome,
          COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
        },
      }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    brokerOutput = captureProcessOutput(child);
    return child;
  },
  capture: () => brokerOutput,
  stop: async (child) => { child.kill(); await child.exited.catch(() => undefined); },
});
const post = (path: string, body: unknown) =>
  fetch(`${BROKER}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

try {
  // Readiness is not one of this suite's assertions. The fixed 15s budget it
  // used to have was an assertion about the host instead, and it lost that bet
  // beside other suites: "broker did not start" reads like a product defect
  // and was a slow boot.
  try {
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${brokerOutput.read().trim().slice(-2000)}`);
  }

  const diff = bigDiff();
  const diffBytes = Buffer.byteLength(diff, 'utf8');
  check('representative oversized edit exceeds the 32 KiB inline cap', diffBytes > 32 * 1024, `${diffBytes} bytes`);

  // 1. Register a Pi bridge session and inject the oversized edit BEFORE attaching,
  //    so it lands in the durable history the attach frame is built from.
  const sf = `/tmp/cadiffwire-${Math.random().toString(36).slice(2, 8)}.jsonl`;
  const id = String(
    (await (await post('/pi/bridge/hello', { sessionFile: sf, cwd: '/tmp', title: 'diff-wire-test' })).json()).id,
  );
  await post('/pi/bridge/events', {
    id,
    events: [{ t: 'tool-result', callId: 'big1', name: 'edit', result: 'ok', isError: false, details: { diff }, args: { path: 'lib/huge.dart' } }],
  });
  await sleep(400); // let the bridge fold the event into history

  // 2. Attach a phone WebSocket in reference mode (the client default; the broker
  //    WS defaults to inline unless ?artifactMode=reference is set).
  const frames: any[] = [];
  const ws = new WebSocket(`${WSBASE}/api/sessions/pi/${encodeURIComponent(id)}/stream?artifactMode=reference`);
  ws.onmessage = (e) => {
    try {
      frames.push(JSON.parse(String(e.data)));
    } catch {
      /* ignore non-JSON */
    }
  };
  await new Promise<void>((res) => {
    ws.onopen = () => res();
  });

  // The oversized tool-result arrives either in the history frame or as a live
  // message; find it and confirm it was swapped to a reference.
  const findToolResult = (): any => {
    for (const f of frames) {
      if (f.kind === 'history' && Array.isArray(f.messages)) {
        const m = f.messages.find((x: any) => x?.type === 'tool-result' && x?.callId === 'big1');
        if (m) return m;
      }
      if (f.kind === 'message' && f.message?.type === 'tool-result' && f.message?.callId === 'big1') return f.message;
    }
    return undefined;
  };
  let tr: any;
  const deadline = Date.now() + 4000;
  for (;;) {
    tr = findToolResult();
    if (tr || Date.now() > deadline) break;
    await sleep(60);
  }
  ws.close();

  check('oversized tool-result reached the client', !!tr, tr ? `callId=${tr.callId}` : 'not found');
  check(
    'over-wire tool-result carries a diffRef, NOT an inline diff',
    !!tr?.diffRef?.fetchUrl && typeof tr.diffRef.contentHash === 'string' && tr.diffRef.contentHash.length === 64 && tr.diffRef.byteSize === diffBytes && tr.diff === undefined,
    JSON.stringify({ hasRef: !!tr?.diffRef, diff: tr?.diff, byteSize: tr?.diffRef?.byteSize }),
  );
  check(
    'per-file metadata kept but its body stripped',
    tr?.fileChanges === undefined || (Array.isArray(tr.fileChanges) && tr.fileChanges.every((f: any) => f.diff === undefined)),
    JSON.stringify(tr?.fileChanges),
  );

  // 3. Fetch the signed diffRef URL directly (bearer material, no auth header) and
  //    confirm the FULL body is served. Rewrite the origin to the test broker so
  //    the fetch works regardless of the broker's advertised public URL.
  if (tr?.diffRef?.fetchUrl) {
    const u = new URL(tr.diffRef.fetchUrl);
    const resp = await fetch(`${BROKER}${u.pathname}${u.search}`);
    const body = await resp.text();
    check('signed diffRef URL serves the body (HTTP 200)', resp.status === 200, `status=${resp.status}`);
    check('served body is the full oversized diff, byte-for-byte', body === diff && Buffer.byteLength(body, 'utf8') === tr.diffRef.byteSize);
  } else {
    check('signed diffRef URL serves the body (HTTP 200)', false, 'no diffRef to fetch');
  }

  // ── Scenario 2 (R4 finding 5): capped attach + REAL backward history-page ──
  // 6 oversized edits, initialHistory=3: the attach frame must carry only the
  // newest 3 (all referenced), and a real `history-page` request must return the
  // older 3 — also referenced — through the live runtime paging path.
  const TOTAL = 6;
  const CAP = 3;
  const pageDiffs = Array.from({ length: TOTAL }, (_, i) => bigDiffFor(i));
  check(
    'paging scenario: all 6 distinct edits exceed the 32 KiB inline cap',
    pageDiffs.every((d) => Buffer.byteLength(d, 'utf8') > 32 * 1024),
    pageDiffs.map((d) => Buffer.byteLength(d, 'utf8')).join(','),
  );

  const sf2 = `/tmp/cadiffwire-${Math.random().toString(36).slice(2, 8)}.jsonl`;
  const id2 = String(
    (await (await post('/pi/bridge/hello', { sessionFile: sf2, cwd: '/tmp', title: 'diff-wire-paging-test' })).json()).id,
  );
  await post('/pi/bridge/events', {
    id: id2,
    events: pageDiffs.map((d, i) => ({
      t: 'tool-result',
      callId: `big${i}`,
      name: 'edit',
      result: 'ok',
      isError: false,
      details: { diff: d },
      args: { path: `lib/huge_${i}.dart` },
    })),
  });
  await sleep(400); // let the bridge fold the events into history

  const frames2: any[] = [];
  const ws2 = new WebSocket(
    `${WSBASE}/api/sessions/pi/${encodeURIComponent(id2)}/stream?artifactMode=reference&initialHistory=${CAP}`,
  );
  ws2.onmessage = (e) => {
    try {
      frames2.push(JSON.parse(String(e.data)));
    } catch {
      /* ignore non-JSON */
    }
  };
  await new Promise<void>((res) => {
    ws2.onopen = () => res();
  });
  const until = async (fn: () => any, ms: number): Promise<any> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v !== undefined || Date.now() > end) return v;
      await sleep(60);
    }
  };
  const callIds = (msgs: any[] | undefined): string[] =>
    (msgs ?? []).filter((m) => m?.type === 'tool-result').map((m) => String(m.callId));
  // Every tool-result in the batch was swapped to a reference: signed URL + stable
  // content hash + byteSize matching the injected diff, and NO inline body.
  const allReferenced = (msgs: any[] | undefined): boolean =>
    (msgs ?? [])
      .filter((m) => m?.type === 'tool-result')
      .every(
        (m) =>
          !!m.diffRef?.fetchUrl &&
          typeof m.diffRef.contentHash === 'string' &&
          m.diffRef.contentHash.length === 64 &&
          m.diffRef.byteSize === Buffer.byteLength(pageDiffs[Number(String(m.callId).slice(3))] ?? '', 'utf8') &&
          m.diff === undefined,
      );

  const hist = await until(() => frames2.find((f) => f.kind === 'history'), 8000);
  check('capped attach: history frame arrived', !!hist);
  check(
    'capped attach: frame is truncated to the newest 3 of 6 (reset:true)',
    hist?.messages?.length === CAP && hist?.truncated?.shown === CAP && hist?.truncated?.total === TOTAL && hist?.reset === true,
    JSON.stringify({ len: hist?.messages?.length, truncated: hist?.truncated, reset: hist?.reset }),
  );
  check(
    'capped attach: frame advertises earlier history (olderCursor + hasEarlier)',
    typeof hist?.olderCursor === 'string' && hist.olderCursor.length > 0 && hist?.hasEarlier === true,
    JSON.stringify({ hasEarlier: hist?.hasEarlier, olderCursor: typeof hist?.olderCursor }),
  );
  check(
    'capped attach: frame carries exactly the NEWEST items (big3..big5, in order)',
    JSON.stringify(callIds(hist?.messages)) === JSON.stringify(['big3', 'big4', 'big5']),
    JSON.stringify(callIds(hist?.messages)),
  );
  check(
    'capped attach: every SENT oversized tool-result is referenced, no inline diff',
    callIds(hist?.messages).length === CAP && allReferenced(hist?.messages),
    JSON.stringify((hist?.messages ?? []).map((m: any) => ({ callId: m?.callId, hasRef: !!m?.diffRef, diff: m?.diff }))),
  );

  // Real backward page over the SAME socket, using the cursor the broker issued.
  let page: any;
  if (typeof hist?.olderCursor === 'string') {
    ws2.send(JSON.stringify({ kind: 'history-page', cursor: hist.olderCursor, limit: 3, clientMessageId: 'p1' }));
    page = await until(() => frames2.find((f) => f.kind === 'history-page' && f.clientMessageId === 'p1'), 8000);
  }
  ws2.close();

  check('backward page: history-page reply arrived and echoes clientMessageId', page?.clientMessageId === 'p1', page ? '' : 'no reply');
  check(
    'backward page: carries the OLDER items (big0..big2, in order)',
    JSON.stringify(callIds(page?.messages)) === JSON.stringify(['big0', 'big1', 'big2']),
    JSON.stringify(callIds(page?.messages)),
  );
  check(
    'backward page: every PAGED oversized tool-result is referenced, no inline diff',
    callIds(page?.messages).length === CAP && allReferenced(page?.messages),
    JSON.stringify((page?.messages ?? []).map((m: any) => ({ callId: m?.callId, hasRef: !!m?.diffRef, diff: m?.diff }))),
  );
  check(
    'backward page: reaches the start of history (hasMore=false, endOfHistory=true)',
    page?.hasMore === false && page?.endOfHistory === true && page?.cursor === undefined,
    JSON.stringify({ hasMore: page?.hasMore, endOfHistory: page?.endOfHistory, cursor: page?.cursor }),
  );
  // Paging really moved backward: no callId overlap with the initial frame, and
  // all 6 references are distinct blobs (6 distinct content hashes).
  const initialIds = new Set(callIds(hist?.messages));
  const pagedIds = callIds(page?.messages);
  const refHashes = new Set(
    [...(hist?.messages ?? []), ...(page?.messages ?? [])]
      .filter((m: any) => m?.type === 'tool-result')
      .map((m: any) => m?.diffRef?.contentHash),
  );
  check(
    'backward page: returns DIFFERENT items than the initial frame (6 distinct hashes)',
    pagedIds.length === CAP && pagedIds.every((c) => !initialIds.has(c)) && refHashes.size === TOTAL,
    JSON.stringify({ pagedIds, distinctHashes: refHashes.size }),
  );
} catch (err) {
  check('diff-reference wire end-to-end', false, `threw: ${String(err)}`);
} finally {
  // Awaiting the exit is the point: signalling and returning left the broker
  // and its children alive past this process, for the lane to reap.
  broker.kill();
  await broker.exited;
  rmSync(stateHome, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
