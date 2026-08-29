/**
 * Claude DRIVEN-PROMPT ownership (physical-pass P1a/P1b/P1c). Zero cost: no `claude`, no model — the
 * child is a stdin-capturing fake and the transcript is a temp file the test appends to.
 *
 * The facts these checks encode were measured, not assumed. A cosyncing-DRIVEN prompt is recorded by
 * the CLI as a CONTENT-LESS `queue-operation` enqueue/dequeue pair and only then as the real user
 * line, so the transcript carries no queued bubble and nothing registers in `queuedSends.pending`.
 * Before this round the user's words existed only in the client's memory between send and delivery —
 * a page reload lost them. So the connection mints the row itself, replays it from getHistory() until
 * the transcript echo claims it, and refuses a send outright when no child was launched.
 *
 *   bun run packages/typescript/adapters/claude/test/test-claude-driven-queue.ts   (exit 0 = all pass)
 */
export {};
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_SUBMITTED_TEXTS_LIMIT, ClaudeResumeConnection, claudeModelLabel } from '../src/index.ts';
import type { ClaudeStore } from '../src/index.ts';
import type { AgentMessage, SessionInfo } from '../../../adapter-api/src/index.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const DIR = mkdtempSync(join(tmpdir(), 'ca-driven-'));
const store: ClaudeStore = { configDir: DIR, projectsRoot: join(DIR, 'projects'), bin: 'claude', isDefault: true };
let seq = 0;

type Harness = {
  conn: ClaudeResumeConnection;
  stdin: any[];
  msgs: AgentMessage[];
  path: string;
  um: () => any[];
  append: (o: any) => void;
  drain: () => void;
  history: () => Promise<AgentMessage[]>;
  historyUsers: () => Promise<any[]>;
};

/** A connection on its OWN transcript whose relaunch is stubbed to install a fake child (no spawn).
 *  `installProc: false` models a spawn failure: relaunch returns false and leaves no process.
 *  `preLines` are in the transcript BEFORE the connection subscribes — the echo tail baselines past
 *  them, so only a history replay ever reads them (the attach-after-enqueue case). */
function newConn(installProc = true, preLines: any[] = []): Harness {
  const path = join(DIR, `sess-${++seq}.jsonl`);
  writeFileSync(path, preLines.map((o) => JSON.stringify(o) + '\n').join(''));
  const info: SessionInfo = { id: `sess-${seq}`, tool: 'claude', title: 'd', cwd: DIR, status: 'idle', attachMode: 'resume' };
  const conn = new ClaudeResumeConnection(store, path, info);
  const stdin: any[] = [];
  const fakeProc = { stdin: { write: (s: string) => { for (const l of String(s).split('\n')) { const t = l.trim(); if (t) try { stdin.push(JSON.parse(t)); } catch {} } return true; }, end: () => {} }, kill: () => {}, killed: false };
  (conn as any).relaunch = (): boolean => {
    if (!installProc) return false; // spawn threw — killProc() already nulled `proc`
    (conn as any).proc = fakeProc;
    return true;
  };
  const msgs: AgentMessage[] = [];
  conn.subscribe((m) => msgs.push(m));
  const um = () => msgs.filter((m: any) => m.type === 'user-message') as any[];
  return {
    conn, stdin, msgs, path, um,
    append: (o: any) => writeFileSync(path, JSON.stringify(o) + '\n', { flag: 'a' }),
    drain: () => (conn as any).drainUserEcho(),
    history: () => conn.getHistory(),
    historyUsers: async () => (await conn.getHistory()).filter((m: any) => m.type === 'user-message') as any[],
  };
}

/** The transcript user line the CLI writes when it delivers a driven prompt. */
function userLine(uuid: string, text: string, timestamp = '2026-08-20T10:00:00.000Z'): any {
  return { type: 'user', uuid, timestamp, message: { role: 'user', content: [{ type: 'text', text }] } };
}
const nowIso = () => new Date().toISOString();

async function main(): Promise<void> {
  // ── (a) idle send: one canonical row, one key, replayable, claimed by the echo ───────────────────
  {
    const h = newConn();
    await h.conn.sendPrompt({ text: 'plain driven prompt' });
    const sent = h.um()[0];
    check('P1a: an idle driven send emits ONE user-message row',
      h.um().length === 1 && sent?.text === 'plain driven prompt' && typeof sent?.sentAt === 'number', JSON.stringify(h.um()));
    check('P1a: the row is app-keyed (no collision with transcript queued:<ts>:<len> keys) and NOT queued',
      String(sent?.key).startsWith('queued:app:') && sent?.queued === undefined, JSON.stringify(sent));
    const before = await h.historyUsers();
    check('P1a: getHistory replays the pending row before delivery (a reload keeps the words)',
      before.length === 1 && before[0].key === sent.key && before[0].text === 'plain driven prompt', JSON.stringify(before));

    h.append(userLine('deliv-1', 'plain driven prompt'));
    h.drain();
    check('P1b: the tail echo re-emits the SAME key (queued styling clears in place)',
      h.um().length === 2 && h.um()[1].key === sent.key && h.um()[1].queued === undefined, JSON.stringify(h.um()));
    const after = await h.historyUsers();
    check('P1a/P1b: after delivery the line appears ONCE in history, under the live key',
      after.length === 1 && after[0].key === sent.key && after[0].turnId === 'deliv-1', JSON.stringify(after));
    await h.conn.close();
  }

  // ── (b) send during a running turn: queued:true, replayable, cleared on delivery ─────────────────
  {
    const h = newConn();
    await h.conn.sendPrompt({ text: 'first turn' }); // running = true, no result yet
    await h.conn.sendPrompt({ text: 'steered mid-turn' });
    const [first, steered] = h.um();
    check('P1a: a send while a turn runs is flagged queued (and the first one is not)',
      first?.queued === undefined && steered?.queued === true && steered?.text === 'steered mid-turn', JSON.stringify(h.um()));
    const pending = await h.historyUsers();
    check('P1a: getHistory carries the queued row before delivery',
      pending.length === 2 && pending[1].key === steered.key && pending[1].queued === true, JSON.stringify(pending));

    h.append(userLine('deliv-a', 'first turn'));
    h.append(userLine('deliv-b', 'steered mid-turn'));
    h.drain();
    const delivered = h.um().filter((u) => u.key === steered.key);
    check('P1b: the delivered steer re-emits its key WITHOUT the queued flag',
      delivered.length === 2 && delivered[1].queued === undefined, JSON.stringify(delivered));
    const done = await h.historyUsers();
    check('P1a: both rows are retired from the pending tail; the transcript lines carry their keys',
      (h.conn as any).pendingDriven.length === 0
        && done.length === 2
        && done[0].key === first.key && done[1].key === steered.key
        && done.every((u: any) => u.queued === undefined),
      JSON.stringify(done));
    await h.conn.close();
  }

  // ── (c) a dropped prompt stays queued — honest "typed, never delivered" ──────────────────────────
  {
    const h = newConn();
    await h.conn.sendPrompt({ text: 'running turn' });
    await h.conn.sendPrompt({ text: 'dropped at turn end' });
    const dropped = h.um()[1];
    // The CLI drops a queued item with a content-less `remove` and NO user line ever follows.
    h.append({ type: 'queue-operation', operation: 'remove', timestamp: '2026-08-20T10:00:05.000Z' });
    h.drain();
    const rows = await h.historyUsers();
    const stillQueued = rows.find((u: any) => u.key === dropped.key);
    check('P1a: a `remove`d driven prompt keeps its QUEUED row in getHistory (never silently vanishes)',
      !!stillQueued && stillQueued.queued === true && stillQueued.text === 'dropped at turn end', JSON.stringify(rows));
    await h.conn.close();
  }

  // ── (d) a slash command gets no pending row (its echo is a <command-name> wrapper) ───────────────
  {
    const h = newConn();
    const before = h.um().length;
    await h.conn.runCommand('compact');
    check('P1a: runCommand emits NO pending row (mapUser rewrites its echo, so the row could never clear)',
      h.um().length === before && (h.conn as any).pendingDriven.length === 0, JSON.stringify(h.um()));
    check('the command still reaches the child as a turn',
      h.stdin.some((o: any) => o?.message?.content?.some((c: any) => c.type === 'text' && c.text === '/compact')), JSON.stringify(h.stdin));
    check('P1a: getHistory carries no pending row for a slash command',
      (await h.historyUsers()).length === 0);
    await h.conn.close();
  }

  // ── (e) the stdout caveat ────────────────────────────────────────────────────────────────────────
  // Claude does NOT echo a submitted prompt on stdout: probed on 2.1.207, the native
  // `--input-format stream-json --output-format stream-json` flow emits no user event for a driven
  // prompt, and the delivery proof is the transcript line. handleEvent's `case 'user'` therefore stays
  // WITHOUT queuedSends — it is defensive/future-schema handling. This check pins that: a stdout user
  // event is keyed by its own uuid and leaves the pending row alone. Wire stdout only if a real
  // capture ever proves a submitted prompt can arrive there.
  {
    const h = newConn();
    await h.conn.sendPrompt({ text: 'stdout never echoes this' });
    const sent = h.um()[0];
    (h.conn as any).handleEvent({ type: 'user', uuid: 'stdout-1', message: { role: 'user', content: [{ type: 'text', text: 'stdout never echoes this' }] } });
    const echoed = h.um()[1];
    check('caveat: a stdout user event is keyed by its own uuid, not the pending key',
      echoed?.key === 'stdout-1:u' && echoed.key !== sent.key, JSON.stringify(echoed));
    const rows = await h.historyUsers();
    check('caveat: the pending row survives a stdout user event (only the transcript tail retires it)',
      (h.conn as any).pendingDriven.length === 1 && rows.some((u: any) => u.key === sent.key), JSON.stringify(rows));
    await h.conn.close();
  }

  // ── P1c: a failed (re)launch must reject the send, not swallow it ────────────────────────────────
  {
    const h = newConn(false); // relaunch returns false and installs no child (spawn threw)
    let rejected = '';
    try {
      await h.conn.sendPrompt({ text: 'never sent' });
    } catch (e) {
      rejected = String(e);
    }
    check('P1c: sendPrompt REJECTS when no child was launched', /was not sent/.test(rejected), rejected);
    check('P1c: no running status is published for a turn that never started',
      !h.msgs.some((m: any) => m.type === 'status' && m.status === 'running'), JSON.stringify(h.msgs));
    check('P1c: no user-message row is accepted', h.um().length === 0 && (h.conn as any).pendingDriven.length === 0);
    check('P1c: nothing is recorded in the echo-exoneration FIFO', (h.conn as any).submittedTexts.length === 0);
    check('P1c: getHistory has no pending row for the refused send', (await h.historyUsers()).length === 0);
    check('P1c: nothing was written to a dead stdin', h.stdin.length === 0);
    await h.conn.close();
  }

  // ── demotion KEEPS the pending row and its link: the prompt was already on the child's stdin ─────
  // Killing the child proves nothing about input it had buffered. If the line lands late the echo must
  // still take the app key; if it never lands the user's words must survive a reload. Only close() —
  // the end of the connection — drops the state.
  {
    const h = newConn();
    await h.conn.sendPrompt({ text: 'before demotion' });
    const sent = h.um()[0];
    (h.conn as any).demoteToObserve();
    const rows = await h.historyUsers();
    check('demotion: the accepted prompt still replays, queued, under its app key',
      (h.conn as any).pendingDriven.length === 1 && rows.length === 1 && rows[0].key === sent.key && rows[0].queued === true, JSON.stringify(rows));
    h.append(userLine('late-1', 'before demotion', nowIso()));
    h.drain();
    const late = h.um().filter((u: any) => u.key === sent.key);
    check('demotion: a late echo takes the app key and retires the row — no uuid-keyed twin',
      late.length === 2 && late[1].queued === undefined && (h.conn as any).pendingDriven.length === 0 && !h.um().some((u: any) => u.key === 'late-1:u'), JSON.stringify(h.um()));
    await h.conn.close();
    check('close: drops the pending state', (h.conn as any).pendingDriven.length === 0 && (h.conn as any).queuedSends.pending.length === 0);
  }

  // ── (f) the reload race: the transcript line lands BEFORE the 1 s tail tick ──────────────────────
  // getHistory() used to replay against a BLANK pending list, so a line the tail had not reached yet
  // was keyed by uuid while the app-keyed row was still appended as pending — two identities for one
  // prompt until the next full resync.
  {
    const h = newConn();
    await h.conn.sendPrompt({ text: 'replayed before the tail' });
    const sent = h.um()[0];
    h.append(userLine('early-1', 'replayed before the tail', nowIso()));
    const rows = await h.historyUsers(); // getHistory() BEFORE drainUserEcho()
    check('replay race: the delivered line appears ONCE, under the app key, not queued',
      rows.length === 1 && rows[0].key === sent.key && rows[0].turnId === 'early-1' && rows[0].queued === undefined, JSON.stringify(rows));
    check('replay race: the replay itself retires the pending row and its correlation link',
      (h.conn as any).pendingDriven.length === 0 && (h.conn as any).queuedSends.pending.length === 0);
    h.drain();
    check('replay race: the tail then re-emits the SAME key (an idempotent upsert, never a second identity)',
      h.um().length === 2 && h.um()[1].key === sent.key && h.um()[1].queued === undefined, JSON.stringify(h.um()));
    const again = await h.historyUsers();
    check('replay race: a later history read still holds exactly one row under that key',
      again.length === 1 && again[0].key === sent.key, JSON.stringify(again));
    await h.conn.close();
  }

  // ── (g) a dropped prompt must not lend its key to the next identical prompt ─────────────────────
  // The tail used to ignore `queue-operation: remove`, so the dropped prompt's link stayed pending and
  // the oldest-first text match handed its key to the next identical prompt's delivery.
  {
    const h = newConn();
    await h.conn.sendPrompt({ text: 'same words' });
    const first = h.um()[0];
    h.append({ type: 'queue-operation', operation: 'remove', timestamp: nowIso() }); // the CLI dropped it
    h.drain();
    await h.conn.sendPrompt({ text: 'same words' });
    const second = h.um()[1];
    h.append(userLine('deliv-2', 'same words', nowIso()));
    h.drain();
    const delivered = h.um()[2];
    check("drop: the delivered line takes the SECOND prompt's key, not the dropped one's",
      delivered?.key === second.key && delivered.key !== first.key && delivered.queued === undefined, JSON.stringify(h.um()));
    const rows = await h.historyUsers();
    check('drop: history shows the dropped prompt still queued and the delivered one exactly once',
      rows.length === 2
        && rows.filter((u: any) => u.key === first.key && u.queued === true).length === 1
        && rows.filter((u: any) => u.key === second.key && u.queued === undefined).length === 1, JSON.stringify(rows));
    await h.conn.close();
  }

  // ── (h) an OLD identical prompt in the transcript cannot claim a new send's key on replay ───────
  {
    const h = newConn();
    h.append(userLine('old-1', 'continue', '2026-01-01T00:00:00.000Z')); // long before this send
    await h.conn.sendPrompt({ text: 'continue' });
    const sent = h.um()[0];
    const rows = await h.historyUsers();
    check('old line: the replay keeps the old line on its uuid key and the new send pending',
      rows.length === 2 && rows[0].key === 'old-1:u' && rows[1].key === sent.key && rows[1].turnId === undefined, JSON.stringify(rows));
    h.append(userLine('new-1', 'continue', nowIso()));
    const after = await h.historyUsers();
    check('old line: the NEW line, stamped after the send, claims the app key on replay',
      after.length === 2 && after[0].key === 'old-1:u' && after[1].key === sent.key && after[1].turnId === 'new-1', JSON.stringify(after));
    await h.conn.close();
  }

  // ── (i) a terminal-typed enqueue on the live tail: same bubble as the replay, claimed by its line ─
  {
    const h = newConn();
    await h.conn.sendPrompt({ text: 'our own turn' });
    h.append({ type: 'queue-operation', operation: 'enqueue', timestamp: nowIso(), content: 'typed in the terminal' });
    h.drain();
    const bubble = h.um().find((u: any) => u.text === 'typed in the terminal');
    check('terminal enqueue: the live tail emits the queued bubble the replay would',
      !!bubble && bubble.queued === true && String(bubble.key).startsWith('queued:') && !String(bubble.key).startsWith('queued:app:'), JSON.stringify(h.um()));
    h.append(userLine('term-1', 'typed in the terminal', nowIso()));
    h.drain();
    const delivered = h.um().filter((u: any) => u.key === bubble?.key);
    check('terminal enqueue: its user line takes over the bubble key and proves a second writer (demotion)',
      delivered.length === 2 && delivered[1].queued === undefined && (h.conn as any).demoted === true, JSON.stringify(delivered));
    await h.conn.close();
  }

  // ── (j) a terminal retract names its message: it must not unlink the driven prompt beside it ─────
  // The queue mixes app-minted and terminal-typed entries. A `remove` with content (every terminal
  // retract since CLI 2.1.203) used to retire the OLDEST entry regardless — the driven one — so the
  // app prompt's later echo landed on a uuid key beside its row, which then replayed queued forever.
  {
    const h = newConn();
    await h.conn.sendPrompt({ text: 'from the app' });
    const sent = h.um()[0];
    h.append({ type: 'queue-operation', operation: 'enqueue', timestamp: nowIso(), content: 'typed in the terminal' });
    h.drain();
    const bubble = h.um().find((u: any) => u.text === 'typed in the terminal');
    h.append({ type: 'queue-operation', operation: 'remove', timestamp: nowIso(), content: 'typed in the terminal' }); // retracted in the TUI
    h.drain();
    const pendingKeys = (h.conn as any).queuedSends.pending.map((p: any) => p.key);
    check('retract by content: the terminal link is retired and the driven link survives',
      pendingKeys.length === 1 && pendingKeys[0] === sent.key, JSON.stringify(pendingKeys));
    h.append(userLine('deliv-app', 'from the app', nowIso()));
    h.drain();
    const delivered = h.um().filter((u: any) => u.key === sent.key);
    check("retract by content: the app prompt's echo still takes its own key and clears the badge",
      delivered.length === 2 && delivered[1].queued === undefined && (h.conn as any).demoted === false, JSON.stringify(delivered));
    const rows = await h.historyUsers();
    check('retract by content: history has the app prompt once (delivered) and the retracted bubble once (queued)',
      rows.length === 2
        && rows.filter((u: any) => u.key === sent.key && u.queued === undefined).length === 1
        && rows.filter((u: any) => u.key === bubble?.key && u.queued === true).length === 1, JSON.stringify(rows));
    await h.conn.close();
  }

  // ── (k) a content-less remove is the CLI dropping a DRIVEN prompt, not the terminal's message ────
  {
    const h = newConn();
    await h.conn.sendPrompt({ text: 'from the app' });
    const sent = h.um()[0];
    h.append({ type: 'queue-operation', operation: 'enqueue', timestamp: nowIso(), content: 'typed in the terminal' });
    h.append({ type: 'queue-operation', operation: 'remove', timestamp: nowIso() }); // no content: the driven drop shape
    h.drain();
    const bubble = h.um().find((u: any) => u.text === 'typed in the terminal');
    const pendingKeys = (h.conn as any).queuedSends.pending.map((p: any) => p.key);
    check('content-less remove: retires the driven link, keeps the terminal link',
      pendingKeys.length === 1 && pendingKeys[0] === bubble?.key, JSON.stringify(pendingKeys));
    const rows = await h.historyUsers();
    check('content-less remove: the dropped app prompt replays queued, the terminal bubble too',
      rows.length === 2 && rows.every((u: any) => u.queued === true) && rows.some((u: any) => u.key === sent.key), JSON.stringify(rows));
    await h.conn.close();
  }

  // ── (l) an old CLI (≤ 2.1.202) retracts without content: that is the NEWEST enqueue, not the oldest
  // 659 of the corpus's 1,010 content-less removes are followed by a re-enqueue — the user edited the
  // message they had just typed. Retiring the oldest instead left the first message's delivery
  // without its link: a uuid-keyed row next to a bubble stuck queued.
  {
    const h = newConn();
    h.append({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-06-01T10:00:00.000Z', content: 'first message' });
    h.append({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-06-01T10:00:05.000Z', content: 'second draft' });
    h.append({ type: 'queue-operation', operation: 'remove', timestamp: '2026-06-01T10:00:06.000Z' }); // retract (no content on that CLI)
    h.append({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-06-01T10:00:09.000Z', content: 'second draft, edited' });
    h.append(userLine('old-d1', 'first message', '2026-06-01T10:00:20.000Z'));
    h.append(userLine('old-d2', 'second draft, edited', '2026-06-01T10:00:40.000Z'));
    // The replay emits each bubble at its enqueue line and again, same key, at its delivery; the client
    // reduces by key (last write wins), so assert on the reduced view.
    const byKey = new Map<string, any>();
    for (const u of await h.historyUsers()) byKey.set(u.key, u);
    const rows = [...byKey.values()];
    const texts = rows.map((u: any) => [u.text, u.queued === true ? 'queued' : 'delivered', u.key]);
    check('old-CLI retract: each delivered message is one row under its enqueue key (no uuid-keyed twin), the retracted draft stays queued',
      rows.length === 3 && rows.every((u: any) => String(u.key).startsWith('queued:'))
        && rows.find((u: any) => u.text === 'first message')?.queued === undefined
        && rows.find((u: any) => u.text === 'second draft')?.queued === true
        && rows.find((u: any) => u.text === 'second draft, edited')?.queued === undefined,
      JSON.stringify(texts));
    await h.conn.close();
  }

  // ── (m) identical text from both sources: the app's delivery takes the APP key ──────────────────
  // A terminal enqueue the tail never saw (it was in the file before attach) is seeded by the replay
  // AHEAD of the driven link; an oldest-first text match then handed the terminal key to the app
  // prompt's own echo, leaving the app row pending forever.
  {
    const h = newConn(true, [{ type: 'queue-operation', operation: 'enqueue', timestamp: nowIso(), content: 'same words' }]);
    await h.conn.sendPrompt({ text: 'same words' });
    const sent = h.um()[0];
    const rows = await h.historyUsers(); // the replay registers the pre-attach terminal enqueue as a leftover
    const termKey = rows.find((u: any) => u.key !== sent.key)?.key;
    const pendingKeys = (h.conn as any).queuedSends.pending.map((p: any) => p.key);
    check('same words: the replay seeds the terminal link ahead of the driven link',
      pendingKeys.length === 2 && pendingKeys[0] === termKey && pendingKeys[1] === sent.key && String(termKey).startsWith('queued:') && !String(termKey).startsWith('queued:app:'), JSON.stringify(pendingKeys));
    h.append(userLine('deliv-same', 'same words', nowIso()));
    h.drain();
    const delivered = h.um().filter((u: any) => u.queued === undefined && u.text === 'same words' && u.key !== sent.key);
    check("same words: the echo takes the driven link's key, not the older terminal one",
      delivered.length === 0 && h.um().some((u: any) => u.key === sent.key && u.queued === undefined) && (h.conn as any).pendingDriven.length === 0 && (h.conn as any).demoted === false,
      JSON.stringify(h.um()));
    h.append({ type: 'queue-operation', operation: 'remove', timestamp: nowIso(), content: 'same words' }); // the terminal user retracts theirs
    h.drain();
    const after = await h.historyUsers();
    check('same words: after the retract, history has the app prompt delivered once and the terminal bubble queued once',
      (h.conn as any).queuedSends.pending.length === 0
        && after.filter((u: any) => u.key === sent.key && u.queued === undefined).length === 1
        && after.filter((u: any) => u.key === termKey && u.queued === true).length === 1
        && after.length === 2, JSON.stringify(after));
    await h.conn.close();
  }

  // ── (n) an OLD identical line cannot claim a live terminal link on replay ───────────────────────
  // The replay used to seed a COPY of every live link; a terminal link had no send time to fence it, so
  // an earlier identical line in the file took its key and the real delivery then fell to a uuid key.
  // Now the replay rebuilds a terminal link at its enqueue line, which only later lines can see.
  {
    const h = newConn(true, [userLine('old-same', 'same', '2026-01-01T00:00:00.000Z')]);
    await h.conn.sendPrompt({ text: 'our own turn' });
    h.append({ type: 'queue-operation', operation: 'enqueue', timestamp: nowIso(), content: 'same' });
    h.drain();
    const bubble = h.um().find((u: any) => u.text === 'same');
    const rows = await h.historyUsers();
    check('old line vs terminal link: the replay keeps the old line on its uuid key and the link pending',
      rows.find((u: any) => u.turnId === 'old-same')?.key === 'old-same:u' && (h.conn as any).queuedSends.pending.some((p: any) => p.key === bubble?.key), JSON.stringify(rows));
    h.append(userLine('new-same', 'same', nowIso()));
    const byKey = new Map<string, any>();
    for (const u of await h.historyUsers()) byKey.set(u.key, u); // replay BEFORE the tail
    check('old line vs terminal link: the NEW line takes the bubble key on replay; the old line stays on uuid',
      byKey.get(bubble?.key)?.turnId === 'new-same' && byKey.has('old-same:u') && !byKey.has('new-same:u'), JSON.stringify([...byKey.values()]));
    h.drain();
    check('old line vs terminal link: the tail agrees — same key, one identity',
      !h.um().some((u: any) => u.key === 'new-same:u') && h.um().filter((u: any) => u.key === bubble?.key).length === 2 && !(h.conn as any).queuedSends.pending.some((p: any) => p.key === bubble?.key), JSON.stringify(h.um()));
    await h.conn.close();
  }

  // ── (o) a line written moments BEFORE a send cannot claim it: the fence is the file position ─────
  // The time fence had 5 s of backward slack, so an identical line stamped just before the send could
  // take the app key on replay. The fence is now the transcript's byte size at send time.
  {
    const h = newConn();
    h.append(userLine('just-before', 'go', nowIso()));
    await h.conn.sendPrompt({ text: 'go' });
    const sent = h.um()[0];
    const rows = await h.historyUsers();
    check('position fence: the earlier line keeps its uuid key and the send stays pending',
      rows.length === 2 && rows[0].key === 'just-before:u' && rows[1].key === sent.key && rows[1].queued === true, JSON.stringify(rows));
    h.append(userLine('after', 'go', nowIso()));
    const byKey = new Map<string, any>();
    for (const u of await h.historyUsers()) byKey.set(u.key, u);
    check('position fence: the line appended after the send claims the app key',
      byKey.size === 2 && byKey.get(sent.key)?.turnId === 'after' && byKey.get(sent.key)?.queued === undefined && byKey.has('just-before:u'), JSON.stringify([...byKey.values()]));
    await h.conn.close();
  }

  // ── (p) the two pending structures are bounded together ─────────────────────────────────────────
  {
    const h = newConn();
    for (let i = 0; i <= CLAUDE_SUBMITTED_TEXTS_LIMIT; i++) await h.conn.sendPrompt({ text: `p${i}` });
    const first = h.um()[0];
    const links = (h.conn as any).queuedSends.pending;
    check('bounded: an evicted driven row takes its correlation link with it',
      (h.conn as any).pendingDriven.length === CLAUDE_SUBMITTED_TEXTS_LIMIT && links.filter((p: any) => p.driven).length === CLAUDE_SUBMITTED_TEXTS_LIMIT && !links.some((p: any) => p.key === first.key), `${links.length}`);
    const base = Date.now();
    for (let i = 0; i < CLAUDE_SUBMITTED_TEXTS_LIMIT + 8; i++) h.append({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(base + i).toISOString(), content: `t${i}` });
    h.drain();
    const term = (h.conn as any).queuedSends.pending.filter((p: any) => !p.driven);
    check('bounded: terminal links are capped at the same limit, oldest first, their bubbles untouched',
      term.length === CLAUDE_SUBMITTED_TEXTS_LIMIT && term[0].text === 't8' && h.um().filter((u: any) => /^t\d+$/.test(u.text)).length === CLAUDE_SUBMITTED_TEXTS_LIMIT + 8, `${term.length} ${term[0]?.text}`);
    await h.conn.close();
  }

  // ── P2: the adapter authors its own roster label (the client has no `fable` family entry) ────────
  {
    const table: [string, string | undefined][] = [
      ['claude-opus-4-8-20260701', 'Opus 4.8'],
      ['claude-fable-5', 'Fable 5'],
      ['claude-sonnet-4-6', 'Sonnet 4.6'],
      ['claude-3-7-sonnet-20250219', 'Sonnet 3.7'],
      ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
      ['opus', 'Opus'],
      ['Claude-Fable-5', 'Fable 5'], // ids are compared case-insensitively
      ['wrapper-tail-model', undefined], // unknown family → no label, never an invented one
      ['MiniMax-M3', undefined],
      ['my-sonnet-fork', 'Sonnet'], // a wrapper whose id has the alias as a whole segment: family only, no fake version
      ['', undefined],
    ];
    const wrong = table.filter(([id, want]) => claudeModelLabel(id) !== want);
    check('P2: claudeModelLabel maps family + version, and answers undefined for an unknown family',
      wrong.length === 0, JSON.stringify(wrong.map(([id, want]) => ({ id, want, got: claudeModelLabel(id) }))));
  }

  // ── P2: a live `init` model reaches the roster with its authored label ───────────────────────────
  {
    const h = newConn();
    (h.conn as any).ingestInit({ model: 'claude-fable-5', permissionMode: 'default', slash_commands: [] });
    check('P2: a fable session reports currentModel.label = "Fable 5"',
      h.conn.info.currentModel?.label === 'Fable 5' && h.conn.info.currentModel?.modelID === 'claude-fable-5',
      JSON.stringify(h.conn.info.currentModel));
    check('P2: the label rides the metadata-update the client roster reads',
      h.msgs.some((m: any) => m.type === 'metadata-update' && m.value?.currentModel?.label === 'Fable 5'),
      JSON.stringify(h.msgs.filter((m: any) => m.type === 'metadata-update')));
    await h.conn.close();
  }

  // ── Drive context usage comes from init model + authoritative result usage ─────────────────────
  for (const fixture of [
    { label: '200K', model: 'claude-opus-5', used: 175_010, max: 200_000, history: [] },
    {
      label: '1M',
      model: 'claude-opus-5[1m]',
      used: 175_010,
      max: 1_000_000,
      history: [
        {
          type: 'assistant',
          uuid: 'old-context-row',
          message: {
            id: 'old-context-message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            content: [{ type: 'text', text: 'historical answer' }],
            usage: { input_tokens: 20, cache_read_input_tokens: 10 },
          },
        },
        { type: 'cost-state', modelUsage: { 'claude-sonnet-5': { inputTokens: 30 } } },
      ],
    },
  ]) {
    const h = newConn(true, fixture.history);
    await h.history();
    (h.conn as any).ingestInit({ model: fixture.model, permissionMode: 'default', slash_commands: [] });
    await h.history(); // non-empty replay must not replace the live init model/window seed
    await h.conn.sendPrompt({ text: `context ${fixture.label}` });
    h.msgs.length = 0;
    (h.conn as any).handleEvent({
      type: 'result',
      usage: {
        input_tokens: 10,
        output_tokens: 99,
        cache_read_input_tokens: fixture.used - 10,
        cache_creation_input_tokens: 0,
      },
    });
    const contexts = h.msgs.filter(
      (message: any) => message.type === 'metadata-update' && message.key === 'contextUsage',
    ) as any[];
    check(`Drive ${fixture.label}: result emits one authoritative composer context update`,
      contexts.length === 1
        && contexts[0].value?.used === fixture.used
        && contexts[0].value?.max === fixture.max,
      JSON.stringify(contexts));
    check(`Drive ${fixture.label}: output tokens do not inflate resident context`,
      contexts[0]?.value?.used !== fixture.used + 99,
      JSON.stringify(contexts));
    await h.conn.close();
  }

  {
    const h = newConn();
    await h.history();
    const emitResult = async (label: string): Promise<any[]> => {
      await h.conn.sendPrompt({ text: `context transition ${label}` });
      h.msgs.length = 0;
      (h.conn as any).handleEvent({
        type: 'result',
        usage: {
          input_tokens: 10,
          output_tokens: 99,
          cache_read_input_tokens: 175_000,
          cache_creation_input_tokens: 0,
        },
      });
      return h.msgs.filter(
        (message: any) => message.type === 'metadata-update' && message.key === 'contextUsage',
      ) as any[];
    };

    (h.conn as any).ingestInit({
      model: 'claude-opus-5[1m]',
      permissionMode: 'default',
      slash_commands: [],
    });
    const extended = await emitResult('1M');
    (h.conn as any).ingestInit({
      model: 'claude-opus-5',
      permissionMode: 'default',
      slash_commands: [],
    });
    const standard = await emitResult('200K');
    check('Drive context transition: a later untagged init revokes prior 1M evidence',
      extended.length === 1
        && JSON.stringify(extended[0].value) === JSON.stringify({ used: 175_010, max: 1_000_000 })
        && standard.length === 1
        && JSON.stringify(standard[0].value) === JSON.stringify({ used: 175_010, max: 200_000 }),
      JSON.stringify({ extended, standard }));
    await h.conn.close();
  }

  // ── every abnormal termination closes the live run exactly once ───────────────────────────────
  {
    const h = newConn();
    await h.history();
    await h.conn.sendPrompt({ text: 'stop this run' });
    h.msgs.length = 0;
    await h.conn.runCommand('stop');
    (h.conn as any).finishLiveAbnormally('cancelled');
    const closed = h.msgs.filter((m: any) => m.type === 'run-summary' && m.status !== 'running') as any[];
    check('abnormal close: Stop emits exactly one cancelled summary before Idle',
      closed.length === 1 && closed[0].status === 'cancelled'
        && h.msgs.findIndex((m: any) => m.type === 'run-summary') < h.msgs.findIndex((m: any) => m.type === 'status' && m.status === 'idle'),
      JSON.stringify(h.msgs));
    await h.conn.close();
  }
  {
    const h = newConn();
    await h.history();
    await h.conn.sendPrompt({ text: 'child exits' });
    const proc = (h.conn as any).proc;
    h.msgs.length = 0;
    (h.conn as any).handleChildExit(proc);
    (h.conn as any).handleChildExit(proc);
    const closed = h.msgs.filter((m: any) => m.type === 'run-summary' && m.status !== 'running') as any[];
    check('abnormal close: current child exit emits exactly one error summary before Idle',
      closed.length === 1 && closed[0].status === 'error'
        && h.msgs.findIndex((m: any) => m.type === 'run-summary') < h.msgs.findIndex((m: any) => m.type === 'status' && m.status === 'idle'),
      JSON.stringify(h.msgs));
    await h.conn.close();
  }
  {
    const h = newConn();
    await h.history();
    await h.conn.sendPrompt({ text: 'owned live run' });
    h.msgs.length = 0;
    h.append(userLine('foreign-user', 'foreign writer'));
    h.drain();
    (h.conn as any).finishLiveAbnormally('cancelled');
    const closed = h.msgs.filter((m: any) => m.type === 'run-summary' && m.status !== 'running') as any[];
    check('abnormal close: drive demotion emits exactly one cancelled summary before Idle',
      (h.conn as any).demoted === true && closed.length === 1 && closed[0].status === 'cancelled'
        && h.msgs.findIndex((m: any) => m.type === 'run-summary') < h.msgs.findIndex((m: any) => m.type === 'status' && m.status === 'idle'),
      JSON.stringify(h.msgs));
    await h.conn.close();
  }

  // ── (q) symptom 4: a background-agent wake is OUR OWN CHILD's turn, never a foreign writer ───────
  // Real flow (docs-internal 2026-08-28 diagnosis): the spawn turn ends with end_turn, the subagent
  // finishes minutes later, and the SAME child appends `<task-notification>` + continuation assistant
  // rows outside any driven turn. Before this round the first such row demoted the drive.
  const assistantLine = (uuid: string, id: string, text: string, stop: string | null, timestamp = nowIso()): any =>
    ({ type: 'assistant', uuid, timestamp, message: { id, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }], stop_reason: stop } });
  const wakeLine = (uuid: string, timestamp = nowIso()): any =>
    ({ type: 'user', uuid, timestamp, origin: { kind: 'task-notification' }, message: { role: 'user', content: [{ type: 'text', text: '<task-notification>\n<task-id>t1</task-id>\n<summary>Agent "explore" finished</summary>\n</task-notification>' }] } });
  {
    const h = newConn();
    h.append(wakeLine('wake-1'));
    h.append(assistantLine('cont-1', 'msg_cont', 'continuing after the wake', null));
    h.drain();
    check('q: continuation assistant rows after a task-notification line do not demote',
      (h.conn as any).demoted === false && (h.conn as any).tailContinuationOpenedAt !== undefined, JSON.stringify(h.msgs.filter((m: any) => m.type === 'error')));
    h.append(assistantLine('cont-2', 'msg_cont', 'done', 'end_turn'));
    h.drain();
    check('q: the terminal line is exonerated too and closes the window with a grace stamp',
      (h.conn as any).demoted === false && (h.conn as any).tailContinuationOpenedAt === undefined && Date.now() - (h.conn as any).lastTurnEndedAt < 2_000);
    h.append(assistantLine('cont-3', 'msg_cont', 'trailing per-block twin', 'end_turn'));
    h.drain();
    check('q: the terminal message\'s trailing per-block line rides the grace stamp', (h.conn as any).demoted === false);
    (h.conn as any).lastTurnEndedAt = Date.now() - 60_000; // grace long over, window closed
    h.append(assistantLine('for-1', 'msg_foreign', 'a second writer mid-turn', null));
    h.drain();
    check('q: after the continuation closed, a foreign assistant row still convicts', (h.conn as any).demoted === true);
    await h.conn.close();
  }
  {
    const h = newConn(); // a stale wake (30 min bound) cannot shelter a real foreign writer
    h.append(wakeLine('wake-stale'));
    h.drain();
    (h.conn as any).tailContinuationOpenedAt = Date.now() - 31 * 60_000;
    h.append(assistantLine('for-2', 'msg_foreign2', 'foreign under a stale window', null));
    h.drain();
    check('q: an expired continuation window no longer exonerates', (h.conn as any).demoted === true);
    await h.conn.close();
  }
  {
    const h = newConn(); // ownership proof by stdout echo, independent of any notification
    (h.conn as any).handleEvent({ type: 'assistant', message: { id: 'msg_ours', role: 'assistant', content: [{ type: 'text', text: 'streamed by our child' }] } });
    h.append(assistantLine('t-1', 'msg_ours', 'streamed by our child', 'end_turn'));
    h.drain();
    check('q: a transcript row whose message id OUR child streamed never convicts', (h.conn as any).demoted === false);
    await h.conn.close();
  }
  {
    const h = newConn(); // the detector itself is intact
    h.append(assistantLine('f-1', 'msg_f', 'foreign with no window and no streamed id', null));
    h.drain();
    check('q: a bare foreign assistant row still demotes (detector unweakened)', (h.conn as any).demoted === true);
    await h.conn.close();
  }
  {
    const h = newConn(); // the stdout wake event opens a real turn: status, tracker run, result closes it
    await h.history(); // installs the live runtime tracker (as a real drive attach does)
    await h.conn.sendPrompt({ text: 'seed the owned child' });
    (h.conn as any).handleEvent({ type: 'result', usage: { input_tokens: 1, output_tokens: 1 } });
    h.msgs.length = 0;
    const before = h.msgs.length;
    (h.conn as any).handleEvent(wakeLine('wake-live'));
    const after = h.msgs.slice(before);
    const running = after.filter((m: any) => m.type === 'run-summary' && m.status === 'running') as any[];
    check('q: a task-notification stdout event flips running + emits status running',
      (h.conn as any).running === true && after.some((m: any) => m.type === 'status' && m.status === 'running'), JSON.stringify(after));
    check('q: the continuation run opens on the wake line uuid with NO association keys (append-only holds)',
      running.length === 1 && running[0].turnId === 'wake-live' && running[0].userMessageKey === undefined && running[0].assistantMessageKey === undefined,
      JSON.stringify(running));
    check('q: the wake event itself never renders as a user bubble', !after.some((m: any) => m.type === 'user-message'), JSON.stringify(after));
    (h.conn as any).handleEvent(wakeLine('wake-live-2')); // repeat wake mid-turn is a no-op
    check('q: a second wake while the continuation runs opens nothing new',
      h.msgs.filter((m: any) => m.type === 'run-summary' && m.status === 'running').length === 1);
    (h.conn as any).handleEvent({ type: 'result', usage: { input_tokens: 5, output_tokens: 7 } });
    const done = h.msgs.filter((m: any) => m.type === 'run-summary' && m.status === 'done') as any[];
    check('q: result closes the continuation with a done summary and idle status',
      (h.conn as any).running === false && done.length === 1 && done[0].key === running[0].key
        && (h.msgs.filter((m: any) => m.type === 'status') as any[]).at(-1)?.status === 'idle', JSON.stringify(done));
    await h.conn.close();
  }
  {
    const h = newConn(); // output between wakes fences the first live continuation
    await h.history();
    await h.conn.sendPrompt({ text: 'seed the owned child' });
    (h.conn as any).handleEvent({ type: 'result', usage: { input_tokens: 1, output_tokens: 1 } });
    h.msgs.length = 0;
    (h.conn as any).handleEvent(wakeLine('wake-output-1'));
    (h.conn as any).handleEvent({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'wake-output-message' } },
    });
    (h.conn as any).handleEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'partial continuation output' },
      },
    });
    (h.conn as any).handleEvent(wakeLine('wake-output-2'));
    const summaries = h.msgs.filter((m: any) => m.type === 'run-summary') as any[];
    const first = summaries.filter((m) => m.turnId === 'wake-output-1');
    const second = summaries.filter((m) => m.turnId === 'wake-output-2');
    check('q: output-bearing live continuation is cancelled before the next wake opens',
      first.map((m) => m.status).join(',') === 'running,cancelled'
        && second.map((m) => m.status).join(',') === 'running'
        && summaries.findIndex((m) => m.turnId === 'wake-output-1' && m.status === 'cancelled')
          < summaries.findIndex((m) => m.turnId === 'wake-output-2' && m.status === 'running'),
      JSON.stringify(summaries));
    (h.conn as any).handleEvent({ type: 'result', usage: { input_tokens: 5, output_tokens: 7 } });
    check('q: result closes the second output-fenced continuation, not the first',
      h.msgs.some((m: any) => m.type === 'run-summary' && m.turnId === 'wake-output-2' && m.status === 'done')
        && !h.msgs.some((m: any) => m.type === 'run-summary' && m.turnId === 'wake-output-1' && m.status === 'done'));
    await h.conn.close();
  }
  {
    const h = newConn(); // message_start with no driven turn open = autonomous turn (fallback trigger)
    await h.history();
    await h.conn.sendPrompt({ text: 'seed the owned child' });
    (h.conn as any).handleEvent({ type: 'result', usage: { input_tokens: 1, output_tokens: 1 } });
    h.msgs.length = 0;
    (h.conn as any).handleEvent({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_auto' } } });
    check('q: message_start outside a driven turn opens an autonomous turn and records the id',
      (h.conn as any).running === true && (h.conn as any).childStreamedMessageIds.has('msg_auto'),
      JSON.stringify(h.msgs.filter((m: any) => m.type === 'status')));
    await h.conn.close();
  }
}

await main().catch((e) => check('test threw', false, String(e)));
rmSync(DIR, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
