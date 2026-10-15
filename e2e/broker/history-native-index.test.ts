/**
 * Large native histories and what a history frame carries.
 *
 * A Codex rollout is served from a compact index built from one streaming
 * read, so a session far past the size a client can hold attaches with a
 * bounded frame, pages from that index, and stays usable while it grows. The
 * frame's cap keeps the newest rows but carries the session state (plan,
 * goal) the cap dropped. An oversized diff travels as a reference the client
 * fetches on demand, in attach frames and pages alike, and a single row
 * larger than a WebSocket default still arrives whole.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Broker, startBroker } from '../harness/index.ts';
import { ask, attachFrame, historyReadLedgerEnv, historyReads, sessionReads } from '../harness/history.ts';
import { openPiBridgeSession } from '../harness/fakes/pi-bridge.ts';
import { codexAgent, codexPlan, codexUser, MiB, writeRollout, type Rollout } from '../harness/fakes/codex-rollout.ts';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCodeRows, startFakeOpenCode } from '../harness/fakes/opencode-server.ts';

const PAGE = 100;
/** Rows that are never backward-pageable: they describe current state, not transcript. */
const STATE_TYPES = new Set(['task-list-state', 'goal-state', 'metadata-update', 'agent-activity', 'history-reset']);

let broker: Broker;
let opencode: ReturnType<typeof startFakeOpenCode>;
let opencodeWorktree: string;
beforeAll(async () => {
  opencodeWorktree = mkdtempSync(join(tmpdir(), 'cosyncing-e2e-opencode-'));
  opencode = startFakeOpenCode(opencodeWorktree, 'ses_long');
  broker = await startBroker({
    name: 'history-native',
    env: (paths) => ({ OPENCODE_URL: opencode.url, ...historyReadLedgerEnv(paths) }),
  });
});
afterAll(async () => {
  await broker?.stop();
  opencode?.stop();
  rmSync(opencodeWorktree, { recursive: true, force: true });
});

describe("each agent's long history pages back to its start from one read", () => {
  const ROWS = 2_500;
  /** Attach with 100, then page to the start: every row once, in order, and no read per page. */
  async function pageToStart(tool: string, id: string, textOf: (index: number) => string): Promise<void> {
    const stream = await broker.client().attach(tool, id, { artifactMode: 'reference', initialHistory: PAGE });
    try {
      const frame = await attachFrame(stream);
      // A mapper may add rows of its own (a Claude prompt left unanswered gets its run's summary).
      expect(frame.truncated?.total).toBeGreaterThanOrEqual(ROWS);
      const readsAfterAttach = sessionReads(broker, tool, id);
      const pages: any[][] = [];
      let cursor: string | undefined = frame.olderCursor;
      for (let guard = 0; cursor && guard < 100; guard += 1) {
        const page = await ask(stream, { kind: 'history-page', cursor, limit: 500 });
        expect(page.kind).toBe('history-page');
        pages.unshift(page.messages);
        cursor = page.endOfHistory ? undefined : page.cursor;
      }
      const texts = [...pages.flat(), ...frame.messages]
        .filter((message: any) => message.type === 'user-message')
        .map((message: any) => message.text);
      expect(texts).toEqual(Array.from({ length: ROWS }, (_, index) => textOf(index)));
      expect(sessionReads(broker, tool, id)).toBe(readsAfterAttach);
    } finally {
      stream.close();
    }
  }

  test('a Claude transcript', async () => {
    const uuid = '0e2e0000-0000-4000-8000-00000000c1a0';
    const project = join(broker.paths.root, 'claude', 'projects', '-e2e-history');
    mkdirSync(project, { recursive: true });
    const transcript = join(project, `${uuid}.jsonl`);
    // The broker names a Claude session by its transcript path.
    const id = Buffer.from(transcript, 'utf8').toString('base64url');
    const text = (index: number) => `claude native history row ${index}`;
    writeFileSync(transcript, `${Array.from({ length: ROWS }, (_, index) => JSON.stringify({
      type: 'user',
      uuid: `claude-user-${index}`,
      sessionId: uuid,
      cwd: broker.paths.home,
      timestamp: `2026-07-28T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      message: { role: 'user', content: text(index) },
    })).join('\n')}\n`);
    await pageToStart('claude', id, text);
  });

  test('an OpenCode session', async () => {
    const text = (index: number) => `opencode native history row ${index}`;
    opencode.setRows(Array.from({ length: ROWS }, (_, index) => openCodeRows.user(`msg_${String(index).padStart(6, '0')}`, index, text(index))));
    await pageToStart('opencode', opencode.sessionId, text);
  });
});

describe('a Codex rollout past the former 32 MiB cache entry pages from its compact index', () => {
  const ROWS = 20_600;
  let rollout: Rollout;
  let stream: Awaited<ReturnType<ReturnType<Broker['client']>['attach']>>;
  let frame: any;
  let cursor: string;
  const reads = () => historyReads(broker).filter((line) => line.endsWith(`codex:${rollout.id}`));

  beforeAll(async () => {
    rollout = writeRollout(broker.paths.home, {
      // An old plan: current state the capped frame must still carry.
      rows: [codexPlan('Keep every older row reachable', 'old-plan')],
      generate: { count: ROWS, row: (index) => codexUser(`wire large row ${index} ${'x'.repeat(1_700)}`) },
    });
    expect(statSync(rollout.path).size).toBeGreaterThan(32 * MiB);
    stream = await broker.client().attach('codex', rollout.id, { artifactMode: 'reference', initialHistory: PAGE });
    frame = await attachFrame(stream, { timeoutMs: 60_000 });
  });
  afterAll(() => stream?.close());

  test('the capped attach shares its entries between the newest rows and the old plan, from one index read', () => {
    expect(frame.messages).toHaveLength(PAGE);
    expect(frame.truncated?.total).toBe(ROWS + 1);
    expect(frame.messages.some((message: any) => message.type === 'task-list-state' && message.key === 'codex:plan')).toBe(true);
    expect(frame.messages.findLast((message: any) => message.type === 'user-message').text)
      .toStartWith(`wire large row ${ROWS - 1} `);
    expect(typeof frame.olderCursor).toBe('string');
    expect(typeof frame.endCursor).toBe('string');
    // Never a whole-history read: one streaming read built the index.
    expect(reads().filter((line) => line.startsWith('attach '))).toEqual([]);
    expect(reads()).toHaveLength(1);
  });

  test('the end boundary reloads the attach rows and reconnects at its older boundary', async () => {
    const pageable = frame.messages.filter((message: any) => !STATE_TYPES.has(message.type));
    const end = await ask(stream, { kind: 'history-page', cursor: frame.endCursor, limit: pageable.length });
    expect(end.kind).toBe('history-page');
    expect(end.messages.map((message: any) => message.text)).toEqual(pageable.map((message: any) => message.text));
    expect(end.cursor).toBe(frame.olderCursor);
    expect(reads()).toHaveLength(1);
  });

  test('older pages come from the index, and an append keeps the socket and its index usable', async () => {
    cursor = frame.olderCursor;
    for (let index = 0; index < 3; index += 1) {
      const page = await ask(stream, { kind: 'history-page', cursor, limit: PAGE });
      expect(page.kind).toBe('history-page');
      expect(page.messages).toHaveLength(PAGE);
      expect(page.hasMore).toBe(true);
      cursor = page.cursor;
    }
    rollout.append([codexUser('active append', '2026-07-28T00:00:01.000Z')]);
    const afterAppend = await ask(stream, { kind: 'history-page', cursor, limit: PAGE });
    expect(afterAppend.kind).toBe('history-page');
    expect(afterAppend.messages).toHaveLength(PAGE);
    expect(reads()).toHaveLength(1);
  });

  test('a new attach after the append builds one newer index', async () => {
    const newer = await broker.client().attach('codex', rollout.id, { artifactMode: 'reference', initialHistory: PAGE });
    try {
      const newerFrame = await attachFrame(newer, { timeoutMs: 60_000 });
      expect(newerFrame.truncated?.total).toBe(ROWS + 2);
      expect(newerFrame.messages.findLast((message: any) => message.type === 'user-message').text).toBe('active append');
      expect(reads()).toHaveLength(2);
    } finally {
      newer.close();
    }
  });
});

describe('state the cap drops still reaches the client', () => {
  test('a paused goal thousands of rows back is carried as the last row of a 500-row frame', async () => {
    const goalAt = 300;
    const rollout = writeRollout(broker.paths.home, {
      generate: {
        count: 3_000,
        row: (index) => index === goalAt
          ? {
            timestamp: '2026-07-28T00:00:00.000Z',
            type: 'event_msg',
            payload: {
              type: 'thread_goal_updated',
              goal: { threadId: 'goal-thread', objective: 'resume the last goal', status: 'paused' },
            },
          }
          : codexUser(`goal row ${index}`),
      },
    });
    const stream = await broker.client().attach('codex', rollout.id, { artifactMode: 'reference', initialHistory: 500 });
    try {
      const frame = await attachFrame(stream);
      expect(frame.messages).toHaveLength(500);
      expect(frame.messages.at(-1)).toMatchObject({ type: 'goal-state', status: 'paused', title: 'resume the last goal' });
      expect(frame.messages.at(-2).text).toBe('goal row 2999');
    } finally {
      stream.close();
    }
  });

  test('only the newest dropped plan is carried, and none when the frame holds a newer one', async () => {
    const stale = writeRollout(broker.paths.home, {
      generate: {
        count: 1_200,
        row: (index) => index === 100 ? codexPlan('old plan', 'p1') : index === 200 ? codexPlan('newer plan', 'p2') : codexUser(`plan row ${index}`),
      },
    });
    const fresh = writeRollout(broker.paths.home, {
      generate: {
        count: 1_200,
        row: (index) => index === 100 ? codexPlan('stale plan', 'p1') : index === 1_150 ? codexPlan('fresh plan', 'p2') : codexUser(`plan row ${index}`),
      },
    });
    const plans = async (rollout: Rollout) => {
      const stream = await broker.client().attach('codex', rollout.id, { artifactMode: 'reference', initialHistory: PAGE });
      try {
        const frame = await attachFrame(stream);
        return frame.messages.filter((message: any) => message.type === 'task-list-state')
          .map((message: any) => message.items?.[0]?.title);
      } finally {
        stream.close();
      }
    };
    expect(await plans(stale)).toEqual(['newer plan']);
    expect(await plans(fresh)).toEqual(['fresh plan']);
  });
});

describe('a frame cut by its byte budget', () => {
  /** A 40 KB reply: about fifty fit the client's 2 MiB decoded budget. */
  const wide = (label: string) => codexAgent(`${label}:`.padEnd(40_000, 'w'));

  test('re-exposes the plan it cut away, and still ends at the newest row', async () => {
    const rollout = writeRollout(broker.paths.home, {
      rows: [
        ...Array.from({ length: 5 }, (_, index) => wide(`early-${index}`)),
        codexPlan('plan behind the cut', 'cut-plan'),
        ...Array.from({ length: 54 }, (_, index) => wide(`late-${index}`)),
      ],
    });
    const stream = await broker.client().attach('codex', rollout.id, { artifactMode: 'reference', initialHistory: PAGE });
    try {
      const frame = await attachFrame(stream);
      expect(frame.truncated).toBeDefined();
      expect(frame.messages.length).toBeLessThan(54);
      expect(frame.messages.at(-1).type).toBe('task-list-state');
      expect(frame.messages.at(-1).items?.[0]?.title).toBe('plan behind the cut');
      expect(frame.messages.findLast((message: any) => message.type === 'model-output').text).toStartWith('late-53:');
      // The boundary sits right before the first row the frame shows.
      const before = await ask(stream, { kind: 'history-page', cursor: frame.olderCursor, limit: 1 });
      const firstShown = frame.messages.find((message: any) => message.type === 'model-output').text.split(':')[0];
      const shownIndex = Number(firstShown.replace('late-', ''));
      expect(before.messages[0].text).toStartWith(shownIndex > 0 ? `late-${shownIndex - 1}:` : 'early-4:');
    } finally {
      stream.close();
    }
  });

  test('turns an incremental reconnect that does not fit into a replacement carrying the plan', async () => {
    const rollout = writeRollout(broker.paths.home, {
      rows: [...Array.from({ length: 5 }, (_, index) => wide(`early-${index}`)), codexPlan('plan in the omitted prefix', 'cut-plan')],
    });
    const first = await broker.client().attach('codex', rollout.id, { artifactMode: 'reference', initialHistory: PAGE });
    const firstFrame = await attachFrame(first);
    first.close();
    rollout.append(Array.from({ length: 54 }, (_, index) => wide(`late-${index}`)));
    const again = await broker.client().attach('codex', rollout.id, {
      artifactMode: 'reference', initialHistory: PAGE, since: firstFrame.cursor,
    });
    try {
      const frame = await attachFrame(again);
      expect(frame.reset).toBe(true);
      expect(frame.truncated).toBeDefined();
      expect(frame.messages.some((message: any) => message.type === 'task-list-state'
        && message.items?.[0]?.title === 'plan in the omitted prefix')).toBe(true);
    } finally {
      again.close();
    }
  });
});

describe('a rollout inside the public contract', () => {
  test('indexes even when its long tool names retain more than the retired 8 and 12 MiB ceilings', async () => {
    // 40,000 messages, inside the 50,000-message bound; each call name survives templating.
    const rollout = writeRollout(broker.paths.home, {
      generate: {
        count: 40_000,
        row: (index) => index % 2 === 0
          ? {
            timestamp: '2026-07-28T00:00:00.000Z',
            type: 'response_item',
            payload: { type: 'function_call', name: `mcp__fixture__${'n'.repeat(120)}_${index}`, call_id: `call-${index}`, arguments: '{"a":1}' },
          }
          : codexUser(`row ${index}`),
      },
    });
    const stream = await broker.client().attach('codex', rollout.id, { artifactMode: 'reference', initialHistory: PAGE });
    try {
      const frame = await attachFrame(stream, { timeoutMs: 60_000 });
      expect(frame.gap).toBeUndefined();
      expect(frame.messages).toHaveLength(PAGE);
      expect(typeof frame.olderCursor).toBe('string');
      expect(typeof frame.endCursor).toBe('string');
      const page = await ask(stream, { kind: 'history-page', cursor: frame.olderCursor, limit: PAGE });
      expect(page.kind).toBe('history-page');
      expect(page.messages).toHaveLength(PAGE);
    } finally {
      stream.close();
    }
  });
});

describe('diff references in history frames', () => {
  /** A distinct unified diff of about 56 KiB: past the 32 KiB inline cap. */
  const bigDiff = (file: number) => [
    `--- a/lib/huge_${file}.dart`,
    `+++ b/lib/huge_${file}.dart`,
    '@@ -1,600 +1,600 @@',
    ...Array.from({ length: 600 }, (_, line) => [
      `-old line ${line} of file ${file} with enough text to be realistic`,
      `+new line ${line} of file ${file} with enough text to be realistic`,
    ]).flat(),
  ].join('\n');
  const edit = (callId: string, diff: string, path: string) => ({
    t: 'tool-result', callId, name: 'edit', result: 'ok', isError: false, details: { diff }, args: { path },
  });

  test('an oversized diff arrives as a reference to its exact body; a small one stays inline', async () => {
    const diff = bigDiff(0);
    const small = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b';
    const session = await openPiBridgeSession(broker, [edit('big', diff, 'lib/huge.dart'), edit('small', small, 'x')]);
    const stream = await broker.client().attach('pi', session.id, { artifactMode: 'reference' });
    try {
      const frame = await attachFrame(stream);
      const big = frame.messages.find((message: any) => message.callId === 'big');
      expect(big.diff).toBeUndefined();
      expect(big.diffRef).toMatchObject({ byteSize: Buffer.byteLength(diff, 'utf8') });
      expect(big.diffRef.contentHash).toMatch(/^[0-9a-f]{64}$/);
      for (const change of big.fileChanges ?? []) expect(change.diff).toBeUndefined();
      const body = await broker.client().get(big.diffRef.fetchUrl);
      expect(body.status).toBe(200);
      expect(body.text).toBe(diff);
      const inline = frame.messages.find((message: any) => message.callId === 'small');
      expect(inline.diffRef).toBeUndefined();
      expect(inline.diff ?? inline.fileChanges?.[0]?.diff).toContain('+b');
    } finally {
      stream.close();
    }
  });

  test('a capped attach and the pages before it reference only their own rows', async () => {
    const diffs = Array.from({ length: 6 }, (_, index) => bigDiff(index + 1));
    const session = await openPiBridgeSession(broker, diffs.map((diff, index) => edit(`big${index}`, diff, `lib/huge_${index}.dart`)));
    const stream = await broker.client().attach('pi', session.id, { artifactMode: 'reference', initialHistory: 3 });
    try {
      const frame = await attachFrame(stream);
      const referenced = (messages: any[], from: number) => {
        expect(messages.map((message) => message.callId)).toEqual([0, 1, 2].map((offset) => `big${from + offset}`));
        for (const message of messages) {
          expect(message.diff).toBeUndefined();
          expect(message.diffRef.byteSize).toBe(Buffer.byteLength(diffs[Number(message.callId.slice(3))]!, 'utf8'));
        }
      };
      expect(frame.reset).toBe(true);
      expect(frame.truncated).toEqual({ shown: 3, total: 6 });
      referenced(frame.messages, 3);
      const page = await ask(stream, { kind: 'history-page', cursor: frame.olderCursor, limit: 3 });
      expect(page.kind).toBe('history-page');
      referenced(page.messages, 0);
      expect(page.endOfHistory).toBe(true);
      const hashes = new Set([...frame.messages, ...page.messages].map((message: any) => message.diffRef.contentHash));
      expect(hashes.size).toBe(6);
    } finally {
      stream.close();
    }
  });

  test('an indexed attach is not cut at a diff it receives as a reference', async () => {
    const lockfile = [
      'diff --git a/bun.lock b/bun.lock', '--- a/bun.lock', '+++ b/bun.lock', '@@ -1,1 +1,30000 @@',
      ...Array.from({ length: 30_000 }, (_, index) => `+dependency-${index} 1.0.${index}`),
    ].join('\n');
    const at = '2026-07-28T00:00:03.000Z';
    const rollout = writeRollout(broker.paths.home, {
      rows: [
        ...Array.from({ length: 60 }, (_, index) => codexUser(`diff row ${index}`, at)),
        { timestamp: at, type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', call_id: 'lock', arguments: '{}' } },
        {
          timestamp: at,
          type: 'event_msg',
          payload: { type: 'patch_apply_end', call_id: 'lock', success: true, changes: { 'bun.lock': { type: 'update', unified_diff: lockfile } } },
        },
        { timestamp: at, type: 'response_item', payload: { type: 'function_call_output', call_id: 'lock', output: 'Success' } },
        ...Array.from({ length: 30 }, (_, index) => codexUser(`diff row ${60 + index}`, at)),
      ],
    });
    const stream = await broker.client().attach('codex', rollout.id, { artifactMode: 'reference', initialHistory: PAGE });
    try {
      const frame = await attachFrame(stream);
      const result = frame.messages.find((message: any) => message.type === 'tool-result' && message.callId === 'lock');
      expect(typeof result?.diffRef?.fetchUrl).toBe('string');
      expect(frame.truncated).toBeUndefined();
      expect(frame.messages.filter((message: any) => message.type === 'user-message')).toHaveLength(90);
    } finally {
      stream.close();
    }
  });
});

describe('a history frame larger than a WebSocket default', () => {
  // The frame's decoded-size bound (2 MiB) is what keeps frames small in practice; with it off, a
  // frame is as large as the history, and the broker's socket must still deliver it whole rather
  // than drop it at Bun's 16 MiB default.
  let unbounded: Broker;
  beforeAll(async () => {
    unbounded = await startBroker({ name: 'history-large-frame', env: { COSYNCING_HISTORY_MAX_DECODED_BYTES: '0' } });
  });
  afterAll(() => unbounded?.stop());

  test('an 18 MiB history frame arrives whole and the socket stays open', async () => {
    const row = 'x'.repeat(900 * 1024);
    const session = await openPiBridgeSession(unbounded, [{ t: 'user', key: 'ask', text: 'say a lot' }]);
    // The bridge takes at most 1 MiB per request, so the reply arrives the way a long turn writes it.
    for (let index = 0; index < 20; index += 1) {
      await session.events([{ t: 'final', key: `large-${index}`, text: `${index}:${row}` }]);
    }
    const stream = await unbounded.client().attach('pi', session.id, { artifactMode: 'reference' });
    try {
      const frame = await attachFrame(stream, { timeoutMs: 60_000 });
      expect(JSON.stringify(frame).length).toBeGreaterThan(16 * MiB);
      expect(frame.messages).toHaveLength(21);
      expect(frame.messages.at(-1).text).toBe(`19:${row}`);
      expect(stream.isOpen).toBe(true);
    } finally {
      stream.close();
    }
  });
});
