/**
 * Claude Resume DRIVE surface — adapter-level units for doc-12 Drive rows that are awkward to prove through
 * the broker trace: permission-mode categories, native file/image input, model/mode reassert on omitted
 * turns, and interrupt. NO claude, NO model cost (relaunch is stubbed; a fake child proc captures stdin).
 *
 *   bun run packages/typescript/adapters/claude/test/test-claude-drive-surface.ts   (exit 0 = all pass)
 */
export {};
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeResumeConnection } from '../src/index.ts';
import type { ClaudeStore } from '../src/index.ts';
import type { AgentMessage, SessionInfo } from '../../../adapter-api/src/index.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const DIR = mkdtempSync(join(tmpdir(), 'ca-drive-'));
const TRANSCRIPT = join(DIR, 'sess.jsonl');
writeFileSync(TRANSCRIPT, '');
const store: ClaudeStore = { configDir: DIR, projectsRoot: join(DIR, 'projects'), bin: 'claude', isDefault: true };
const baseInfo = (): SessionInfo => ({ id: 'sess', tool: 'claude', title: 'd', cwd: DIR, status: 'idle', attachMode: 'resume' });

/** A ClaudeResumeConnection whose relaunch is stubbed to install a stdin-capturing fake child (no spawn). */
function newConn(info = baseInfo()): { conn: ClaudeResumeConnection; stdin: any[]; relaunches: { model?: string; mode?: string }[]; killed: () => boolean; msgs: AgentMessage[] } {
  const conn = new ClaudeResumeConnection(store, TRANSCRIPT, info);
  const stdin: any[] = [];
  const relaunches: { model?: string; mode?: string }[] = [];
  let wasKilled = false;
  const fakeProc = { stdin: { write: (s: string) => { for (const l of String(s).split('\n')) { const t = l.trim(); if (t) try { stdin.push(JSON.parse(t)); } catch {} } return true; }, end: () => {} }, kill: () => { wasKilled = true; }, killed: false };
  (conn as any).relaunch = (model?: string, mode?: string) => { relaunches.push({ model, mode }); (conn as any).proc = fakeProc; (conn as any).launchModel = model; (conn as any).launchMode = mode; };
  const msgs: AgentMessage[] = [];
  conn.subscribe((m) => msgs.push(m));
  return { conn, stdin, relaunches, killed: () => wasKilled, msgs };
}

async function main(): Promise<void> {
  // ── #7 permission-mode categories ──────────────────────────────────────────────
  const modes = await newConn().conn.listModes();
  const cat = new Map(modes.map((m) => [m.value, m.category]));
  check('every ModeOption carries a universal category', modes.every((m) => m.category && ['ask-permission', 'approve-for-me', 'full-access', 'custom'].includes(m.category)));
  check('Claude mode→category mapping is correct', cat.get('default') === 'ask-permission' && cat.get('acceptEdits') === 'approve-for-me' && cat.get('bypassPermissions') === 'full-access' && cat.get('plan') === 'custom', JSON.stringify([...cat]));

  // ── #4 native file input (staged to inbox + path-ref) ───────────────────────────
  {
    const { conn, stdin } = newConn();
    const inbox = join(DIR, '.cosyncing', 'inbox');
    const first = join(inbox, 'notes-a.txt');
    const second = join(inbox, 'notes-b.txt');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(first, 'hello agent A');
    writeFileSync(second, 'hello agent B');
    await conn.sendPrompt({
      text: 'review both',
      files: [
        {
          name: 'notes-a.txt',
          mimeType: 'text/plain',
          size: 13,
          brokerPath: first,
        },
        {
          name: 'notes-b.txt',
          mimeType: 'text/plain',
          size: 13,
          brokerPath: second,
        },
      ],
    });
    const userLine = stdin.find((o) => o?.message?.content?.some((c: any) => c.type === 'text'));
    const txt = userLine?.message?.content?.find((c: any) => c.type === 'text')?.text ?? '';
    check(
      'broker-staged files are referenced together in the exact turn',
      readFileSync(first, 'utf8') === 'hello agent A'
        && readFileSync(second, 'utf8') === 'hello agent B'
        && txt.includes(first)
        && txt.includes(second),
    );
    await conn.close();
  }

  // ── #4 native image input (Anthropic base64 block) ──────────────────────────────
  {
    const { conn, stdin } = newConn();
    await conn.sendPrompt({ text: 'what is this', images: [{ data: 'AAAA', mimeType: 'image/png' }] });
    const userLine = stdin.find((o) => o?.message?.content?.some((c: any) => c.type === 'image'));
    const img = userLine?.message?.content?.find((c: any) => c.type === 'image');
    check('image upload → native Anthropic image block on the turn', img?.source?.type === 'base64' && img?.source?.media_type === 'image/png' && img?.source?.data === 'AAAA');
    await conn.close();
  }

  // ── #6 model/mode reassert on an omitted-field turn ─────────────────────────────
  {
    const info = baseInfo();
    info.currentModel = { providerID: 'anthropic', modelID: 'opus' };
    info.currentMode = 'plan';
    const { conn, relaunches } = newConn(info);
    await conn.sendPrompt({ text: 'go' }); // no model, no permissionMode
    const last = relaunches[relaunches.length - 1];
    check('omitted-field turn reasserts currentModel + currentMode on relaunch', last?.model === 'opus' && last?.mode === 'plan', JSON.stringify(last));
    await conn.close();
  }

  // ── MODE-1/MODE-2: no spurious relaunch after init divergence; no relaunch on an empty turn ──────
  {
    const { conn, relaunches, msgs } = newConn(); // no currentModel/Mode → turn 1 cold-launches with undefined
    await conn.sendPrompt({ text: 'turn one' });
    const afterTurn1 = relaunches.length;
    // init reports a concrete model/mode → currentModel/currentMode now DIVERGE from the launched undefineds
    (conn as any).ingestInit({ model: 'claude-opus-5-0-20260701', permissionMode: 'plan', slash_commands: [] });
    check(
      'init retains the exact resolved model id separately from alias selection',
      conn.info.currentModel?.modelID === 'claude-opus-5-0-20260701' &&
        msgs.some(
          (m: any) =>
            m.type === 'metadata-update' &&
            m.value?.currentModel?.modelID === 'claude-opus-5-0-20260701',
        ),
      JSON.stringify(conn.info.currentModel),
    );
    await conn.sendPrompt({ text: 'turn two' }); // omitted model/mode → must NOT SIGTERM the warm child
    check('MODE-1: omitted turn 2 does NOT relaunch after init model/mode divergence', relaunches.length === afterTurn1, `relaunches=${relaunches.length} expected ${afterTurn1}`);
    const beforeEmpty = relaunches.length;
    const msgsBefore = msgs.length;
    await conn.sendPrompt({ text: '   ' }); // empty/whitespace → no content
    check('MODE-2: empty prompt neither relaunches nor emits a status frame', relaunches.length === beforeEmpty && !msgs.slice(msgsBefore).some((m: any) => m.type === 'status'));
    await conn.close();
  }

  // ── #17 interrupt: runCommand('stop') kills the child + emits idle ──────────────
  {
    const { conn, killed, msgs } = newConn();
    await conn.sendPrompt({ text: 'long task' }); // installs the fake proc, running=true
    const res = await conn.runCommand('stop');
    check('runCommand(stop) terminates the child process', killed());
    check('runCommand(stop) emits status idle + a notice', msgs.some((m: any) => m.type === 'status' && m.status === 'idle') && !!(res && (res as any).notice));
    await conn.close();
  }

  // ── 13.1c drive permission round-trip (control_request/can_use_tool ↔ control_response) ─────────
  // The exact event shapes were probed live on claude 2.1.207 (--permission-prompt-tool stdio): the
  // CLI BLOCKS the gated tool until we reply; allow echoes the input as updatedInput, deny carries a
  // message the model reads back. Before the flag shipped, headless -p silently auto-denied and the
  // app never saw a popup (maintainer: "drive mode still broken -> no permission popup for tools").
  {
    const { conn, stdin, msgs } = newConn();
    await conn.sendPrompt({ text: 'run the sudo check' }); // installs the fake proc
    (conn as any).handleEvent({
      type: 'control_request',
      request_id: 'perm-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'sudo -n whoami', description: 'Run sudo -n whoami' },
        description: 'Run sudo -n whoami',
        decision_reason: 'This command requires approval',
      },
    });
    const card = msgs.find((m: any) => m.type === 'permission-request') as any;
    check('can_use_tool surfaces a permission card naming the tool AND the command', card?.requestId === 'perm-1' && card?.title === 'Bash' && String(card?.detail ?? '').includes('sudo -n whoami'), JSON.stringify(card));
    check('the pending card replays in full for a late-joining tab (getPending)', (conn.getPending?.() ?? []).some((m: any) => m.requestId === 'perm-1' && String(m.detail ?? '').includes('sudo')), JSON.stringify(conn.getPending?.() ?? []));
    await conn.respondPermission('perm-1', 'approve');
    const allowResp = stdin.filter((s: any) => s.type === 'control_response').at(-1);
    check('approve → control_response allow echoing the tool input as updatedInput', allowResp?.response?.request_id === 'perm-1' && allowResp?.response?.response?.behavior === 'allow' && allowResp?.response?.response?.updatedInput?.command === 'sudo -n whoami', JSON.stringify(allowResp));
    check('approve broadcasts permission-resolved (other tabs clear the card)', msgs.some((m: any) => m.type === 'permission-resolved' && m.requestId === 'perm-1' && m.decision === 'approve'));
    check('a resolved card no longer replays', !(conn.getPending?.() ?? []).some((m: any) => (m as any).requestId === 'perm-1'));

    (conn as any).handleEvent({
      type: 'control_request',
      request_id: 'perm-2',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /' }, description: 'Run rm -rf /', decision_reason: 'This command requires approval' },
    });
    await conn.respondPermission('perm-2', 'reject');
    const denyResp = stdin.filter((s: any) => s.type === 'control_response').at(-1);
    check('reject → control_response deny with an explanatory message', denyResp?.response?.request_id === 'perm-2' && denyResp?.response?.response?.behavior === 'deny' && typeof denyResp?.response?.response?.message === 'string', JSON.stringify(denyResp));
    await conn.close();
  }

  // ── item-12 follow-up: USER-ECHO TAIL — drive stdout has NO user events (probed 2.1.207), so the
  //    delivery proof for a mid-turn queued send is the user line the child appends to the transcript.
  //    The tail must emit ONLY user-message frames from appended lines and never re-emit history. ──
  {
    const { conn, msgs } = newConn(); // subscribe() baselines the tail at the file's current size
    const um = () => msgs.filter((m: any) => m.type === 'user-message') as any[];
    const append = (o: any) => writeFileSync(TRANSCRIPT, JSON.stringify(o) + '\n', { flag: 'a' });
    const drain = () => (conn as any).drainUserEcho();

    append({ type: 'user', uuid: 'echo-1', timestamp: '2026-07-14T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'the queued message, delivered' }] } });
    drain();
    check('echo tail: an appended plain user line emits a user-message frame', um().length === 1 && um()[0].text === 'the queued message, delivered', JSON.stringify(um()));
    drain();
    check('echo tail: re-drain emits nothing (offset advanced)', um().length === 1);

    const before = msgs.length;
    append({ type: 'assistant', uuid: 'echo-a', message: { id: 'em1', role: 'assistant', content: [{ type: 'text', text: 'reply' }] } });
    append({ type: 'user', uuid: 'echo-tr', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_X', content: 'ok' }] } });
    append({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-07-14T10:00:01.000Z' }); // driven enqueues are contentless
    drain();
    check('echo tail: assistant/tool_result/queue-op lines emit NOTHING (stdout owns those)', msgs.length === before, JSON.stringify(msgs.slice(before)));

    // a fork moves the live file: the tail must re-baseline there and NEVER re-emit its copied history
    const forkPath = join(DIR, 'fork-echo.jsonl');
    writeFileSync(forkPath, JSON.stringify({ type: 'user', uuid: 'copied-1', message: { role: 'user', content: 'copied history line' } }) + '\n');
    (conn as any).liveUuid = 'fork-echo';
    drain(); // repoint + baseline tick
    drain(); // nothing new yet
    check('echo tail: fork repoint does NOT re-emit copied history', !um().some((u) => u.text === 'copied history line'));
    writeFileSync(forkPath, JSON.stringify({ type: 'user', uuid: 'fork-new', message: { role: 'user', content: 'typed after the fork' } }) + '\n', { flag: 'a' });
    drain();
    check('echo tail: appended user line on the FORK file emits', um().some((u) => u.text === 'typed after the fork'), JSON.stringify(um().map((u) => u.text)));

    await conn.close();
    check('echo tail: close() stops the poll timer', (conn as any).echoTailTimer === undefined);
  }
}

await main().catch((e) => check('test threw', false, String(e)));
rmSync(DIR, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
