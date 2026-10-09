/**
 * The tier-2 harness, checked without Claude.
 *
 * The real smoke spends the run's model turns, so everything that can be proven for free
 * is proven here: that the harness binds a socket the mod's own request shape can reach,
 * that the peer credential it reports is this process, that a hold is answered within the
 * poll budget, and that zero viewers releases rather than parks the call. A smoke that
 * fails for the wrong reason costs a turn to discover and a turn to re-run.
 *
 * The requests are the recorded bytes from the spike's capture of Claude's own fetch, so
 * a framing change is caught here too.
 *
 * The second half is the smoke's own proof rules (evidence.ts): what counts as a step having
 * happened. Each is run against rows and events where the step did NOT happen but the previous
 * step left evidence that an earlier version of the smoke read as success.
 *
 *   bun run scripts/claude-mod/smoke/selftest.ts        (exit 0 = all pass)
 */
export {};
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { startHarness } from './harness.ts';
import { spawn } from 'node:child_process';
import {
  appPromptIsNextUserRow,
  appStopLeftIdle,
  brokerChildRefusedOnce,
  closedByTerminal,
  modeFollowedPrompt,
  nothingHeld,
  oneQuestionCard,
  planApprovalOptions,
  questionClosedBy,
  questionKeptInTerminal,
  questionResolvedWith,
  questionSettledInTerminal,
  seatMode,
  seatPendingInput,
  transcriptMode,
  type TranscriptRow,
  resyncShowsNotRunning,
  turnEndGaps,
  type SeatFrame,
  configAuditVerdicts,
  parseTranscript,
  questionAnswers,
  spawnedStayedSilent,
  stopEndedTurn,
  userCancelSeen,
  writeDeclinedByClaude,
  writeSettledByClaude,
  type BrokerEvent,
  type TimedBrokerEvent,
} from './evidence.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

interface Fixture { requests: { name: string; method: string; target: string; headers: Record<string, string> }[] }
const RECORD = JSON.parse(readFileSync(new URL('../../../packages/typescript/broker/test/claude/fixtures/claude-fetch-requests.json', import.meta.url), 'utf8')) as Fixture;
/** The recorded register request, headers and all, so the shape under test is Claude's. */
const CAPTURED = RECORD.requests.find((request) => request.name === 'register');
if (!CAPTURED) throw new Error('the fixture carries no register request');
// Narrowed once, at the top, so the readers below hold a value the compiler already checked.
const CAPTURED_REQUEST = CAPTURED;

/** The reply shapes this file reads. Typed, because `Record<string, unknown>` made every read
 * below a property access on `{}` and a wrong field name stopped being a compile error. */
interface ModReply {
  ok?: boolean;
  code?: string;
  verdict?: { behavior?: string; [key: string]: unknown };
  release?: { why?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** One request, one connection, `connection: close`: the shape Claude's fetch produces. */
function request(socketPath: string, path: string, body: unknown): Promise<{ status: number; json: ModReply }> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath, () => {
      const payload = JSON.stringify(body);
      // The captured header block, byte for byte apart from the one field whose value is
      // this body's length. `Content-Type` arrives capitalised from the real client, which
      // is why the reader matches names case-insensitively.
      const headers = { ...CAPTURED_REQUEST.headers, 'Content-Length': String(Buffer.byteLength(payload)) };
      const lines = [`${CAPTURED_REQUEST.method} ${path} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n' + payload);
    });
    let raw = '';
    socket.on('data', (chunk) => {
      raw += chunk.toString('latin1');
      const end = raw.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = raw.slice(0, end);
      const declared = /content-length: (\d+)/i.exec(head);
      const length = declared ? Number(declared[1]) : 0;
      if (raw.length - end - 4 < length) return;
      socket.destroy();
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0);
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(raw.slice(end + 4, end + 4 + length));
      } catch (error) {
        json = { parseError: String(error) };
      }
      resolve({ status, json });
    });
    socket.on('error', reject);
  });
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

try {
  const harness = await startHarness();
  check('the harness binds under the socketPath ceiling', Buffer.byteLength(harness.socketPath) <= 100, harness.socketPath);

  const sid = randomUUID();
  const register = await request(harness.socketPath, `/claude/mod/register?sid=${sid}`, {
    protocolVersion: 1,
    sessionId: sid,
    cwd: process.cwd(),
    claudeVersion: '2.1.289',
    isInteractive: true,
    surface: 'terminal',
  });
  check('register is accepted over the recorded request shape', register.status === 200 && register.json.ok === true, JSON.stringify(register));
  check('the peer credential is this process', register.json.peerPid === process.pid, `${String(register.json.peerPid)} vs ${process.pid}`);

  harness.setMode('default');
  harness.setViewers(1);
  const holdUrl = `/claude/mod/hold?sid=${sid}&wait=20000`;
  const holdBody = {
    sessionId: sid,
    requestId: 'self-1',
    tool: 'Bash',
    decision: 'ask',
    input: 'command: echo held',
  };

  // Two legs, because that is what the mod does. The opening request is answered as soon as the
  // hold is open, so the terminal knows it may put its band up; the re-offer is the leg that
  // parks and takes the verdict. Reading the first response as the answer is the mistake this
  // file used to make, and it went unnoticed because the response is `ok: true` either way.
  const ack = await request(harness.socketPath, holdUrl, holdBody);
  check('the opening hold is answered at once, with no verdict in it',
    ack.status === 200 && ack.json.held === true && ack.json.verdict === undefined, JSON.stringify(ack.json));

  const parked = request(harness.socketPath, holdUrl, holdBody);
  await wait(300);
  // The card carries an id the broker minted for this hold alone (`self-1@...`), not the mod's
  // own id, which restarts in every process. The app answers by the card's id.
  const card = harness.cards.find((entry) => entry.requestId.startsWith('self-1@'));
  check('the hold raised a card', card !== undefined, JSON.stringify(harness.cards));
  // The card is the human's whole view of the call, so it has to carry what is being approved and
  // the mode it is being decided in. `inputPreview` is that field; a card with only a tool name
  // and an English sentence is what the review called an approval nobody could read.
  check('the card carries what is being approved', card?.inputPreview === 'command: echo held', JSON.stringify(card?.inputPreview ?? null));
  check('the card names the mode it was decided in', card?.permissionMode === 'default', String(card?.permissionMode));
  const cardId = card?.requestId ?? 'self-1';
  check('the broker reports the hold as open for this session', harness.service.isHeld(sid, cardId));
  check('another session does not see this hold', harness.service.isHeld('some-other-session', cardId) === false);
  check('the mod\'s own id is not the card\'s, and does not name the hold', harness.service.isHeld(sid, 'self-1') === false);
  const approved = harness.service.approve({ sessionId: sid, requestId: cardId, decision: 'approve' });
  const outcome = await parked;
  check('the app answer settles the hold', approved === true && outcome.json.verdict?.behavior === 'allow', JSON.stringify(outcome.json));

  const polls = harness.holdPolls('self-1');
  // Counted, never capped: a hold lasts as long as the person takes.
  check('the audit counts the hold\'s polls', typeof polls === 'number' && polls >= 1, String(polls));

  harness.setViewers(0);
  const nobody = await request(harness.socketPath, `/claude/mod/hold?sid=${sid}&wait=20000`, {
    sessionId: sid,
    requestId: 'self-2',
    tool: 'Bash',
    decision: 'ask',
  });
  check('no viewer releases at once', nobody.json.release?.why === 'viewer:none', JSON.stringify(nobody.json));

  harness.setViewers(1);
  harness.setKillSwitch(true);
  const off = await request(harness.socketPath, `/claude/mod/hold?sid=${sid}&wait=20000`, {
    sessionId: sid,
    requestId: 'self-3',
    tool: 'Bash',
    decision: 'ask',
  });
  check('the kill switch releases at once', off.json.release?.why === 'killSwitch', JSON.stringify(off.json));
  harness.setKillSwitch(false);

  harness.setMode('auto');
  const auto = await request(harness.socketPath, `/claude/mod/hold?sid=${sid}&wait=20000`, {
    sessionId: sid,
    requestId: 'self-4',
    tool: 'Bash',
    decision: 'ask',
  });
  check('auto mode is never held', auto.json.release?.why === 'mode:auto', JSON.stringify(auto.json));

  // The mode read follows each hold's own session, looked up on every read: a fresh launch writes
  // its transcript, and its first mode row, with its first message, after a step has pointed here.
  const lateDir = mkdtempSync(join(tmpdir(), 'cmts-selftest-'));
  const late = join(lateDir, `${sid}.jsonl`);
  const lookedUp: string[] = [];
  harness.useTranscript((sessionId) => {
    lookedUp.push(sessionId);
    return existsSync(late) ? late : undefined;
  });
  const unread = await request(harness.socketPath, `/claude/mod/hold?sid=${sid}&wait=20000`, {
    sessionId: sid,
    requestId: 'self-5',
    tool: 'Bash',
    decision: 'ask',
  });
  writeFileSync(late, JSON.stringify({ type: 'permission-mode', permissionMode: 'auto', sessionId: sid }) + '\n');
  const read = await request(harness.socketPath, `/claude/mod/hold?sid=${sid}&wait=20000`, {
    sessionId: sid,
    requestId: 'self-6',
    tool: 'Bash',
    decision: 'ask',
  });
  rmSync(lateDir, { recursive: true, force: true });
  check('a session whose transcript does not exist yet reads as unknown', unread.json.release?.why === 'mode:unknown', JSON.stringify(unread.json));
  check('and its mode is read as soon as Claude writes it, from that session\u2019s own transcript',
    read.json.release?.why === 'mode:auto' && lookedUp.length > 0 && lookedUp.every((id) => id === sid), `${JSON.stringify(read.json)} looked up ${JSON.stringify([...new Set(lookedUp)])}`);

  const audit = harness.audit();
  check('every hold left an audit row', audit.length >= 4, String(audit.length));
  check('no audit row carries prompt text', audit.every((row) => !JSON.stringify(row).includes('echo held')));
  check('the audit row names the mode it decided in', audit.some((row) => row.modeSeen === 'auto'));

  // The two harness facts those rules stand on. Each event carries the moment it arrived, and a
  // child of this process that registers is refused in the line shape the spawned step reads.
  const eventFrom = Date.now();
  const evented = await request(harness.socketPath, `/claude/mod/event?sid=${sid}`, { sessionId: sid, kind: 'turn.complete', detail: { turnId: 'timed' } });
  const timedEvent = harness.events.find((event) => event.kind === 'turn.complete' && event.detail?.turnId === 'timed');
  check('the harness records each broker event with the moment it arrived',
    evented.status === 200 && typeof timedEvent?.at === 'number' && timedEvent.at >= eventFrom && timedEvent.at <= Date.now(), JSON.stringify(timedEvent ?? null));
  const childSid = randomUUID();
  const logFrom = harness.log.length;
  const childScript = `const net = require('node:net');
const body = JSON.stringify({ protocolVersion: 1, sessionId: process.env.SID, cwd: '/', claudeVersion: '2.1.292', isInteractive: false, surface: 'sdk' });
const s = net.connect(process.env.SOCK, () => s.write('POST /claude/mod/register?sid=' + process.env.SID + ' HTTP/1.1\\r\\nHost: cosyncing.local\\r\\nContent-Type: application/json\\r\\nContent-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body));
let raw = ''; s.on('data', (c) => { raw += c; if (raw.includes('\\r\\n\\r\\n')) { console.log(raw.split('\\r\\n')[0]); s.destroy(); } });`;
  const child = spawn(process.execPath, ['-e', childScript], { env: { SOCK: harness.socketPath, SID: childSid }, stdio: ['ignore', 'pipe', 'inherit'] });
  let childOut = '';
  child.stdout.on('data', (chunk) => { childOut += String(chunk); });
  await new Promise<void>((resolve) => child.on('close', () => resolve()));
  check('a register from a child of the broker\u2019s process is refused, in the line shape the spawned step reads',
    / 403 /.test(childOut) && brokerChildRefusedOnce(harness.log.slice(logFrom)).ok, `${childOut.trim()} :: ${harness.log.slice(logFrom).join(' / ')}`);

  harness.close();

  // ---- the smoke's proof rules, without Claude ----

  const WORKSPACE = '/scratch/cmts-run/workspace';
  const jsonl = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  const writeUse = (id: string, file: string) => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: `${WORKSPACE}/${file}`, content: 'x\n' } }] },
  });
  const writeResult = (id: string, isError: boolean, content: string) => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  });
  // Claude's own answer to a permission declined in its dialog, as the tool_result it records.
  const DECLINED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
  // The pane the band-deny step leaves behind: Claude's own dialog for that step's file, in the
  // shape a 2026-10-05 run recorded for its auto-mode step ("Do you want to create
  // cmts-auto-mode.txt? / 1. Yes / 2. Yes, and switch to accept edits ...").
  const previousStepPane = [
    ' Do you want to create cmts-band-deny.txt?',
    ' \u276f 1. Yes',
    '   2. Yes, and switch to accept edits (auto-approve file edits)',
    '   3. No, and tell Claude what to do differently (esc)',
  ].join('\n');
  // The regex both replaced pane checks used.
  const OLD_PANE_PROOF = /Do you want|permission|Yes,|allow once/i;

  // The band-deny step's Write was declined, and the dialog step's has not reached the transcript:
  // the newest Write in the file, and the newest decline, are the previous step's.
  const afterDeny = parseTranscript(jsonl(
    writeUse('toolu_01deny', 'cmts-band-deny.txt'),
    writeResult('toolu_01deny', true, DECLINED),
  ));
  check('the old pane proof is green on the previous step\u2019s dialog text', OLD_PANE_PROOF.test(previousStepPane),
    'this is the false green the transcript proof replaces');
  check('the dialog step is not proven by the previous step\u2019s declined Write',
    !writeDeclinedByClaude(afterDeny, 'cmts-own-dialog.txt', false).ok, writeDeclinedByClaude(afterDeny, 'cmts-own-dialog.txt', false).detail);
  const dialogDeclined = parseTranscript(jsonl(
    writeUse('toolu_01deny', 'cmts-band-deny.txt'),
    writeResult('toolu_01deny', true, DECLINED),
    writeUse('toolu_02dialog', 'cmts-own-dialog.txt'),
    writeResult('toolu_02dialog', true, DECLINED),
  ));
  check('the dialog step is proven once its own Write is declined', writeDeclinedByClaude(dialogDeclined, 'cmts-own-dialog.txt', false).ok,
    writeDeclinedByClaude(dialogDeclined, 'cmts-own-dialog.txt', false).detail);
  check('a declined Write whose file exists is not a decline', !writeDeclinedByClaude(dialogDeclined, 'cmts-own-dialog.txt', true).ok);

  // The auto step: earlier steps' Writes ran or were declined in Claude's dialog, and the auto
  // step's own Write has not reached the transcript yet.
  const beforeAuto = parseTranscript(jsonl(
    writeUse('toolu_03allow', 'cmts-band-allow.txt'),
    writeResult('toolu_03allow', false, 'File created successfully at: /scratch/cmts-run/workspace/cmts-band-allow.txt'),
    writeUse('toolu_02dialog', 'cmts-own-dialog.txt'),
    writeResult('toolu_02dialog', true, DECLINED),
  ));
  check('the auto step is not proven by an earlier step\u2019s outcome', !writeSettledByClaude(beforeAuto, 'cmts-auto-mode.txt', false).ok,
    writeSettledByClaude(beforeAuto, 'cmts-auto-mode.txt', false).detail);
  const autoRan = parseTranscript(jsonl(writeUse('toolu_04auto', 'cmts-auto-mode.txt'),
    writeResult('toolu_04auto', false, 'File created successfully at: /scratch/cmts-run/workspace/cmts-auto-mode.txt')));
  const ranVerdict = writeSettledByClaude(autoRan, 'cmts-auto-mode.txt', true);
  check('the auto step reads a call Claude ran itself', ranVerdict.ok && ranVerdict.how === 'ran', ranVerdict.detail);
  const autoDeclined = parseTranscript(jsonl(writeUse('toolu_04auto', 'cmts-auto-mode.txt'), writeResult('toolu_04auto', true, DECLINED)));
  const declinedVerdict = writeSettledByClaude(autoDeclined, 'cmts-auto-mode.txt', false);
  check('the auto step reads a call Claude declined itself', declinedVerdict.ok && declinedVerdict.how === 'declined', declinedVerdict.detail);
  check('a result that disagrees with the disk is not settled', !writeSettledByClaude(autoRan, 'cmts-auto-mode.txt', false).ok
    && !writeSettledByClaude(autoDeclined, 'cmts-auto-mode.txt', true).ok);

  // Broker events in the shape a recorded run produced around its dialog step (ids are synthetic).
  const recordedEvents: BrokerEvent[] = [
    { sessionId: '11111111-2222-4333-8444-555555555555', kind: 'turn.start', detail: { turnId: '66666666-7777-4888-9999-aaaaaaaaaaaa' } },
    { sessionId: '11111111-2222-4333-8444-555555555555', kind: 'user-cancel', requestId: 'cm-6' },
    { sessionId: '11111111-2222-4333-8444-555555555555', kind: 'turn.complete', detail: { turnId: '66666666-7777-4888-9999-aaaaaaaaaaaa' } },
  ];
  check('a user-cancel for this hold in this session proves button 3',
    userCancelSeen(recordedEvents, '11111111-2222-4333-8444-555555555555', 'cm-6'));
  check('a user-cancel for another hold or another session does not',
    !userCancelSeen(recordedEvents, '11111111-2222-4333-8444-555555555555', 'cm-7')
      && !userCancelSeen(recordedEvents, 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', 'cm-6')
      && !userCancelSeen(recordedEvents.filter((event) => event.kind !== 'user-cancel'), '11111111-2222-4333-8444-555555555555', 'cm-6'));

  // An AskUserQuestion result as 2.1.292 recorded it (the answers are the probe's; ids are
  // synthetic), after an earlier step's question and with the answer quoted in assistant text too.
  const questionRows = parseTranscript([
    JSON.stringify({ type: 'user', toolUseResult: { questions: [], answers: { 'Which colour?': 'Red' } },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'Your questions have been answered: "Which colour?"="Red".' }] } }),
    JSON.stringify({ type: 'user', toolUseResult: { questions: [], annotations: {}, answers: { 'Which phrases?': '"Say \\"hi\\", now", Tokyo, "Quote \\" only"', 'Which city?': 'Paris, France' } },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'Your questions have been answered: "Which phrases?"=""Say \\"hi\\", now", Tokyo, "Quote \\" only"", "Which city?"="Paris, France".' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'You picked "Which build?"="Release".' }] } }),
  ].join('\n'));
  check('a question\u2019s answers are read from the tool\u2019s own result, byte for byte',
    questionAnswers(questionRows, 'Which phrases?')?.['Which phrases?'] === '"Say \\"hi\\", now", Tokyo, "Quote \\" only"',
    JSON.stringify(questionAnswers(questionRows, 'Which phrases?')));
  check('an earlier question\u2019s answers do not stand in for this one',
    questionAnswers(questionRows, 'Which colour?')?.['Which colour?'] === 'Red' && questionAnswers(questionRows, 'Which phrases?')?.['Which colour?'] === undefined);
  check('an answer quoted in the assistant\u2019s text is not an answer', questionAnswers(questionRows, 'Which build?') === undefined);

  // The operator's ~/.claude.json, before and after a run.
  const before = { keys: ['/srv/a', '/srv/b'], trusted: ['/srv/a'], problem: '' };
  const verdictsFor = (after: typeof before) => Object.fromEntries(configAuditVerdicts(before, after).map((entry) => [entry.name, entry.ok]));
  const keysRule = 'the run left the project keys in ~/.claude.json as it found them';
  const trustRule = 'the run wrote no trust into ~/.claude.json';
  const unchanged = verdictsFor({ ...before });
  check('an untouched ~/.claude.json passes every config check', Object.values(unchanged).every(Boolean), JSON.stringify(unchanged));
  check('a new project key fails the run', verdictsFor({ ...before, keys: [...before.keys, '/scratch/cmts-run/workspace'] })[keysRule] === false);
  check('a removed project key fails the run', verdictsFor({ ...before, keys: ['/srv/a'] })[keysRule] === false);
  check('trust gained on an existing key fails the run', verdictsFor({ ...before, trusted: ['/srv/a', '/srv/b'] })[trustRule] === false);

  // ── Round 4: a Stop with a hold open, a prompt while a card is open, a spawned Claude ──
  const S1 = '11111111-2222-4333-8444-555555555555';
  const S2 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const sentAt = 1_000_000;
  const timed: TimedBrokerEvent[] = [
    { sessionId: S1, kind: 'turn.complete', detail: { turnId: 'previous' }, at: sentAt - 50 },
    { sessionId: S2, kind: 'turn.complete', detail: { turnId: 'other-terminal' }, at: sentAt + 100 },
    { sessionId: S1, kind: 'user-cancel', requestId: 'cm-9', at: sentAt + 300 },
    { sessionId: S1, kind: 'turn.complete', detail: { turnId: 'stopped' }, at: sentAt + 400 },
  ];
  const stopped = stopEndedTurn(timed, S1, sentAt, 2000);
  check('a turn.complete 400 ms after the Stop is a Stop that ended the turn', stopped.ok && stopped.afterMs === 400, stopped.detail);
  check('a turn.complete from before the Stop, or from another terminal, does not stand in for it',
    !stopEndedTurn(timed.slice(0, 3), S1, sentAt, 2000).ok && stopEndedTurn(timed.slice(0, 3), S1, sentAt, 2000).afterMs === undefined);
  check('a turn that ended 2.5 s after the Stop is over the 2 s rule',
    !stopEndedTurn([{ sessionId: S1, kind: 'turn.complete', at: sentAt + 2500 }], S1, sentAt, 2000).ok);

  // P-2: an app Stop with no hold. The window is turn.complete to the seat's idle.
  const frame = (at: number, message: SeatFrame['message']): SeatFrame => ({ at, message });
  const stopFrames = [
    frame(sentAt - 3000, { type: 'status', status: 'running' }),
    frame(sentAt + 450, { type: 'status', status: 'idle' }),
    frame(sentAt + 450, { type: 'run-summary', status: 'cancelled', key: 's:run:u1' }),
  ];
  const turnDone = (at: number, extra: Record<string, unknown> = {}): TimedBrokerEvent => ({ sessionId: S1, kind: 'turn.complete', at, detail: { turnId: 't1', ...extra } });
  const left = appStopLeftIdle(stopFrames, [turnDone(sentAt + 400)], S1, sentAt, 2000);
  check('a seat that says idle 50 ms after turn.complete, with the turn closed, was left idle', left.ok && left.idleAfterMs === 50, left.detail);
  check('a seat that never says idle was not left idle', !appStopLeftIdle(stopFrames.filter((f) => f.message.status !== 'idle'), [turnDone(sentAt + 400)], S1, sentAt, 2000).ok);
  check('an idle from before the Stop does not stand in for one after it',
    !appStopLeftIdle([frame(sentAt - 100, { type: 'status', status: 'idle' }), ...stopFrames.filter((f) => f.message.status !== 'idle')], [turnDone(sentAt + 400)], S1, sentAt, 2000).ok);
  check('idle 2.5 s after turn.complete is over the rule',
    !appStopLeftIdle([frame(sentAt + 2900, { type: 'status', status: 'idle' }), frame(sentAt + 2900, { type: 'run-summary', status: 'cancelled' })], [turnDone(sentAt + 400)], S1, sentAt, 2000).ok);
  check('a seat that says running again after idle did not leave the session idle',
    !appStopLeftIdle([...stopFrames, frame(sentAt + 1500, { type: 'status', status: 'running' })], [turnDone(sentAt + 400)], S1, sentAt, 2000).ok);
  check('idle with the turn still drawn running is not idle',
    !appStopLeftIdle(stopFrames.filter((f) => f.message.type !== 'run-summary'), [turnDone(sentAt + 400)], S1, sentAt, 2000).ok);
  check('a subagent\u2019s turn.complete is not the session\u2019s turn ending',
    !appStopLeftIdle(stopFrames, [turnDone(sentAt + 400, { agentId: 'a1' })], S1, sentAt, 2000).ok);
  check('a resync whose newest turn is cancelled draws it not running',
    resyncShowsNotRunning([{ type: 'run-summary', status: 'running', key: 'k0' }, { type: 'run-summary', status: 'cancelled', key: 'k1' }]).ok);
  check('a resync whose newest turn is running fails',
    !resyncShowsNotRunning([{ type: 'run-summary', status: 'done', key: 'k0' }, { type: 'run-summary', status: 'running', key: 'k1' }]).ok);

  // P-3: one question, one card, closed with the rows the app sent.
  const ask = (at: number, requestId: string) => frame(at, { type: 'question-request', requestId });
  const rowsSent = [['Red'], ['Paris, France', 'Say "hi", now']];
  check('the transcript\u2019s copy and the held copy under one call id are one card',
    oneQuestionCard([ask(1, 'toolu_q'), ask(2, 'toolu_q')], 'toolu_q').ok);
  check('a card under a minted id beside the call\u2019s is two cards', !oneQuestionCard([ask(1, 'toolu_q'), ask(2, 'cm-3@abcd')], 'toolu_q').ok);
  check('one card under another id is not the call\u2019s card', !oneQuestionCard([ask(1, 'cm-3@abcd')], 'toolu_q').ok);
  const resolvedQ = (answers?: unknown) => frame(5, { type: 'question-resolved', requestId: 'toolu_q', ...(answers !== undefined ? { answers } : {}) });
  check('a resolution carrying the rows sent, beside a bare one, closed with the answer',
    questionResolvedWith([resolvedQ(), resolvedQ(rowsSent)], 'toolu_q', rowsSent).ok);
  check('resolutions that carry no answer did not close with it', !questionResolvedWith([resolvedQ(), resolvedQ()], 'toolu_q', rowsSent).ok);
  check('a resolution carrying another answer fails', !questionResolvedWith([resolvedQ(rowsSent), resolvedQ([['Blue'], ['Tokyo']])], 'toolu_q', rowsSent).ok);

  // P-1: a card the terminal took back says so.
  const closedPerm = (extra: Record<string, unknown>) => frame(6, { type: 'permission-resolved', requestId: 'cm-4@ef01', ...extra } as SeatFrame['message']);
  check('a card closed with releaseReason band says the terminal answered it', closedByTerminal([closedPerm({ releaseReason: 'band' })], 'cm-4@ef01').ok);
  check('a bare close reads as another client, which fails', !closedByTerminal([closedPerm({})], 'cm-4@ef01').ok);
  check('a close the app\u2019s Stop made is not the terminal\u2019s', !closedByTerminal([closedPerm({ decidedBy: 'app' })], 'cm-4@ef01').ok);
  check('another card\u2019s close does not stand in', !closedByTerminal([closedPerm({ releaseReason: 'band' })], 'cm-5@ef01').ok);

  // The turn.complete -> end_turn gap the P-2 grace sits above.
  const t0 = 1_000_000;
  const gaps = turnEndGaps(
    [turnDone(t0), turnDone(t0 + 20_000), { sessionId: S1, kind: 'turn.complete', at: t0 + 40_000, detail: { turnId: 't3' } }, turnDone(t0 + 60_000, { agentId: 'sub' })],
    [frame(t0 + 120, { type: 'run-summary', status: 'done' }), frame(t0 + 19_950, { type: 'run-summary', status: 'done' }), frame(t0 + 41_500, { type: 'run-summary', status: 'cancelled' })],
    S1,
  );
  check('a gap is measured to the transcript\u2019s own close, either side of turn.complete',
    gaps.length === 3 && gaps[0]?.gapMs === 120 && gaps[1]?.gapMs === -50 && gaps[0]?.closedBy === 'transcript', JSON.stringify(gaps));
  check('a turn only the grace closed is reported as the grace\u2019s, with no gap', gaps[2]?.closedBy === 'grace' && gaps[2]?.gapMs === undefined, JSON.stringify(gaps[2]));
  check('a turn nothing closed is reported as none',
    turnEndGaps([turnDone(t0)], [], S1)[0]?.closedBy === 'none');

  const stepPrompt = 'Use the Write tool to create the file cmts-prompt-held.txt';
  const appPrompt = 'Reply with exactly the word QUEUEDRUN1 and nothing else.';
  const user = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', ...extra, message: { role: 'user', content: [{ type: 'text', text }] } });
  const toolTurn = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_w', name: 'Write', input: { file_path: '/w/cmts-prompt-held.txt' } }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_w', content: 'File created' }] } }),
    user('<system-reminder>context</system-reminder>', { isMeta: true }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }),
  ];
  const delivered = parseTranscript([user(appPrompt.replace('RUN1', 'OLD')), user(stepPrompt), ...toolTurn, user(appPrompt)].join('\n'));
  check('the app\u2019s prompt after the held turn\u2019s tool result is the next user row', appPromptIsNextUserRow(delivered, stepPrompt, appPrompt).ok,
    appPromptIsNextUserRow(delivered, stepPrompt, appPrompt).detail);
  check('another user row in between means the app\u2019s prompt was not the next thing said',
    !appPromptIsNextUserRow(parseTranscript([user(stepPrompt), ...toolTurn, user('/usage'), user(appPrompt)].join('\n')), stepPrompt, appPrompt).ok);
  check('the app\u2019s prompt from before this step\u2019s prompt does not count',
    !appPromptIsNextUserRow(parseTranscript([user(appPrompt), user(stepPrompt), ...toolTurn].join('\n')), stepPrompt, appPrompt).ok);

  const refusedChild = `mod socket refused register: broker_child (pid 4242 is the broker's own child)`;
  const silentId = 'cccccccc-dddd-4eee-8fff-000000000000';
  check('a spawned Claude that registered nothing and drew no refusal stayed silent', spawnedStayedSilent([{ sessionId: S1 }], ['mod socket bound'], silentId).ok);
  check('a registration under the spawned Claude\u2019s id is not silence', !spawnedStayedSilent([{ sessionId: silentId }], [], silentId).ok);
  check('a refused request in the broker log while it ran is not silence', !spawnedStayedSilent([], [refusedChild], silentId).ok);
  check('the control is refused as a broker child exactly once', brokerChildRefusedOnce(['mod socket bound', refusedChild]).ok);
  check('a control the broker never heard from proves nothing, so it fails', !brokerChildRefusedOnce(['mod socket bound']).ok);
  check('a control that kept dialling after a refusal for good fails', !brokerChildRefusedOnce([refusedChild, refusedChild, refusedChild]).ok);

  // P-9: the mode a transcript records, read where Claude 2.1.294 writes it. Row shapes are that
  // build's, keys and types only, as the adapter's own P-9 tests build them.
  let rowN = 0;
  const base = (extra: Record<string, unknown>): TranscriptRow => ({
    parentUuid: `m-${rowN}`, isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: '/work',
    sessionId: 'm-session', version: '2.1.294', gitBranch: 'main', timestamp: new Date(1_791_400_000_000 + (rowN += 1) * 1000).toISOString(),
    uuid: `m-${rowN}`, ...extra,
  } as TranscriptRow);
  const promptRow = (mode: string, text = 'go') => base({
    type: 'user', promptId: `pr-${rowN}`, promptSource: 'typed', turnOrigin: 'human', turnPosition: { promptIndex: rowN, turnIndex: rowN },
    permissionMode: mode, message: { role: 'user', content: text },
  });
  const titleMode = (mode: string): TranscriptRow => ({ type: 'permission-mode', permissionMode: mode, sessionId: 'm-session' } as TranscriptRow);
  const resultRow = (toolUseId: string) => base({
    type: 'user', promptId: `pr-${rowN}`, sourceToolAssistantUUID: `a-${rowN}`,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }] },
    toolUseResult: { type: 'text', content: 'done' },
  });
  const planCall = (toolUseId: string) => base({
    type: 'assistant', requestId: `req-${rowN}`,
    message: { id: `msg_${rowN}`, role: 'assistant', type: 'message', model: 'claude-haiku-5-5', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: toolUseId, name: 'ExitPlanMode', input: { plan: 'the plan', planFilePath: '/plans/p.md' }, caller: { type: 'direct' } }] },
  });
  const planApproved = (toolUseId: string) => base({
    type: 'user', promptId: `pr-${rowN}`, sourceToolAssistantUUID: `a-${rowN}`,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'User has approved your plan.' }] },
    toolUseResult: { plan: 'the plan', isAgent: false, filePath: '/plans/p.md' },
  });
  const planRejected = (toolUseId: string) => base({
    type: 'user', promptId: `pr-${rowN}`, sourceToolAssistantUUID: `a-${rowN}`, toolDenialKind: 'user-rejected',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'The user rejected the plan.', is_error: true }] },
    toolUseResult: 'User rejected tool use',
  });
  const sidechainPrompt = (text: string) => base({ type: 'user', isSidechain: true, agentId: 'agent-1', promptId: `pr-${rowN}`, message: { role: 'user', content: text } });
  check('a prompt row after the title block’s row is the mode', transcriptMode([titleMode('default'), promptRow('auto')]) === 'auto');
  check('a title-block row after the prompt row is the mode', transcriptMode([promptRow('auto'), titleMode('default')]) === 'default');
  check('a tool result carries no mode and leaves the prompt’s', transcriptMode([promptRow('acceptEdits'), resultRow('toolu_r')]) === 'acceptEdits');
  check('a subagent’s prompt is not the session’s', transcriptMode([promptRow('default'), sidechainPrompt('task')]) === 'default');
  check('an approved plan leaves the mode unknown', transcriptMode([promptRow('plan'), planCall('toolu_p1'), planApproved('toolu_p1')]) === undefined);
  check('a rejected plan stays in plan mode', transcriptMode([promptRow('plan'), planCall('toolu_p2'), planRejected('toolu_p2')]) === 'plan');
  check('the next prompt after an approved plan names the mode again',
    transcriptMode([promptRow('plan'), planCall('toolu_p3'), planApproved('toolu_p3'), promptRow('acceptEdits')]) === 'acceptEdits');

  // R5-A: band 1 on a held question keeps the card, read-only and open in the terminal.
  const qid = 'toolu_band';
  const asked = frame(1, { type: 'question-request', requestId: qid });
  const restated = frame(2, { type: 'question-request', requestId: qid, readOnly: true, answerInTerminal: true });
  check('the Hub replay counts a card with no blocking field as blocking', seatPendingInput([asked]).needsInput);
  check('and a blocking:false card as not', !seatPendingInput([frame(1, { type: 'question-request', requestId: qid, blocking: false })]).needsInput);
  check('a card restated read-only and open in the terminal, still pending, keeps the seat at Needs input',
    questionKeptInTerminal([asked, restated], qid).ok, questionKeptInTerminal([asked, restated], qid).detail);
  check('a card closed at band 1 with nothing picked fails (R5-A)',
    !questionKeptInTerminal([asked, frame(2, { type: 'question-resolved', requestId: qid })], qid).ok);
  check('a restatement drawn blocking:false does not keep the seat at Needs input, which fails',
    !questionKeptInTerminal([asked, frame(2, { type: 'question-request', requestId: qid, readOnly: true, answerInTerminal: true, blocking: false })], qid).ok);
  check('a card never restated is still answerable in the app, which fails', !questionKeptInTerminal([asked], qid).ok);
  check('a second card under another id fails', !questionKeptInTerminal([asked, restated, frame(3, { type: 'question-request', requestId: 'cm-2@ab' })], qid).ok);
  const picked = (at: number, answers?: unknown) => frame(at, { type: 'question-resolved', requestId: qid, ...(answers !== undefined ? { answers } : {}) });
  check('one resolution carrying the pick closes the card and the seat leaves Needs input',
    questionSettledInTerminal([asked, restated, picked(4, [['Circle']])], qid, [['Circle']]).ok,
    questionSettledInTerminal([asked, restated, picked(4, [['Circle']])], qid, [['Circle']]).detail);
  check('two resolutions for the one card fail, even when both carry the pick',
    !questionSettledInTerminal([asked, restated, picked(4, [['Circle']]), picked(5, [['Circle']])], qid, [['Circle']]).ok);
  check('a resolution with no pick fails', !questionSettledInTerminal([asked, restated, picked(4)], qid, [['Circle']]).ok);
  check('a resolution with another pick fails', !questionSettledInTerminal([asked, restated, picked(4, [['Square']])], qid, [['Circle']]).ok);
  check('another card still waiting keeps Needs input, which fails',
    !questionSettledInTerminal([asked, restated, frame(3, { type: 'permission-request', requestId: 'cm-9@ff' }), picked(4, [['Circle']])], qid, [['Circle']]).ok);

  // P-8(a): a question the app answered closes saying so, on every copy.
  const closedQ = (extra: Record<string, unknown>) => frame(7, { type: 'question-resolved', requestId: 'toolu_q', ...extra } as SeatFrame['message']);
  check('two closes, each decidedBy app, say the app answered it',
    questionClosedBy([closedQ({ decidedBy: 'app', answers: rowsSent }), closedQ({ decidedBy: 'app', answers: rowsSent })], 'toolu_q', 'app').ok);
  check('a bare close beside them fails', !questionClosedBy([closedQ({ decidedBy: 'app' }), closedQ({})], 'toolu_q', 'app').ok);
  check('a close that says the terminal took it back fails', !questionClosedBy([closedQ({ releaseReason: 'band' })], 'toolu_q', 'app').ok);
  check('no close at all fails', !questionClosedBy([], 'toolu_q', 'app').ok);

  // P-9: after an idle shift+tab, the next prompt row carries the mode, and the seat and gate follow.
  const stepAsk = 'Run exactly this Bash command';
  const modeRows = [promptRow('default', 'earlier'), resultRow('toolu_e'), promptRow('acceptEdits', `${stepAsk} now.`)];
  const chip = (at: number, mode: string | undefined) => frame(at, { type: 'metadata-update', key: 'sessionInfo', value: { currentMode: mode } });
  const chips = [chip(1, 'default'), frame(2, { type: 'metadata-update', key: 'sessionInfo', value: { model: 'claude-haiku-5-5' } }), chip(3, 'acceptEdits')];
  check('the seat’s mode is its newest currentMode, and a model update does not move it', seatMode(chips) === 'acceptEdits' && seatMode(chips.slice(0, 2)) === 'default');
  check('a seat that said "no mode" reads null', seatMode([chip(1, 'plan'), chip(2, undefined)]) === null);
  const followed = modeFollowedPrompt(modeRows, chips, stepAsk, 'default', 'acceptEdits');
  check('prompt row, seat and gate on the new mode is the mode followed at the prompt', followed.ok && followed.promptMode === 'acceptEdits', followed.detail);
  check('a seat still on the old mode fails', !modeFollowedPrompt(modeRows, chips.slice(0, 2), stepAsk, 'default', 'acceptEdits').ok);
  check('a gate that read the old mode fails', !modeFollowedPrompt(modeRows, chips, stepAsk, 'default', 'default').ok);
  check('a prompt row on the old mode proves nothing, so it fails',
    !modeFollowedPrompt([promptRow('default', `${stepAsk} again.`)], [chip(1, 'default')], stepAsk, 'default', 'default').ok);
  check('a step prompt that only a subagent sent fails', !modeFollowedPrompt([sidechainPrompt(`${stepAsk} please.`)], chips, stepAsk, 'default', 'acceptEdits').ok);

  // P-9: Claude's plan-approval dialog, read off the pane. The "Exit plan mode?" pane is a 2.1.295
  // capture, as drawn; "Ready to code?" carries the option labels that build's dialog code writes.
  const readyPane = (labels: string[]) => [
    '\u2500'.repeat(40), ' Ready to code?', '', ' Here is Claude\u2019s plan:', '  1. Create the file', '  2. Run the command', '',
    ' Would you like to proceed?', '',
    ...labels.map((label, index) => `${index === 0 ? ' \u276f ' : '   '}${index + 1}. ${label}`),
    '', ' ctrl-g to edit in your editor',
  ].join('\n');
  const exitPane = (yes: string) => [
    ' \u276f Plan this task: create a file named cmts-plan-auto.txt',
    '  2. this is the prompt\u2019s own text, not an option', '',
    '  ' + '\u2500'.repeat(40), '   Exit plan mode?', '', '    Claude wants to exit plan mode', '',
    `    \u276f 1. ${yes}`, '      2. No', '',
  ].join('\n');
  const both = planApprovalOptions(readyPane(['Yes, clear context (14% used) and use auto mode', 'Yes, and use auto mode', 'Yes, manually approve edits', 'No, keep planning']));
  check('"Ready to code?" is read as up, with its four options and not the plan\u2019s own numbered lines',
    both.up && both.title === 'Ready to code?' && both.options.length === 4 && both.options[0]!.label.startsWith('Yes, clear context'), JSON.stringify(both.options));
  check('an auto option that keeps the context is taken over one that clears it', both.auto?.digit === '2', JSON.stringify(both.auto ?? null));
  check('an auto option that clears the context is taken when it is the only one',
    planApprovalOptions(readyPane(['Yes, clear context and use auto mode', 'Yes, auto-accept edits', 'No, keep planning'])).auto?.digit === '1');
  const noAuto = planApprovalOptions(readyPane(['Yes, clear context and auto-accept edits', 'Yes, auto-accept edits', 'Yes, manually approve edits', 'No, keep planning']));
  check('auto-accept edits is not auto mode', noAuto.up && noAuto.auto === undefined, JSON.stringify(noAuto));
  const exitDefault = planApprovalOptions(exitPane('Yes, and switch to default (ask each time) for this session'));
  check('"Exit plan mode?" as 2.1.295 draws it is up, with Yes and No, and offers no auto',
    exitDefault.up && exitDefault.title === 'Exit plan mode?' && exitDefault.options.length === 2 && exitDefault.auto === undefined, JSON.stringify(exitDefault));
  check('"Exit plan mode?" that returns to auto is the auto option', planApprovalOptions(exitPane('Yes, and switch to auto mode for this session')).auto?.digit === '1');
  check('a numbered list with no dialog title is not the plan dialog', !planApprovalOptions(' 1. Yes, and use auto mode\n 2. No').up);
  // The dialog as 2.1.295 drew it in a captured smoke run, the plan's own numbered list included.
  const captured = planApprovalOptions([
    '  ' + '\u2500'.repeat(40), '   Ready to code?', '', '   Here is Claude\u2019s plan:', '  ' + '\u254c'.repeat(40),
    '   1. Create cmts-plan-auto.txt in the current directory containing the single word ready.',
    "   2. Run exactly: curl -sI https://example.com -o /dev/null -w '%{http_code}'", '  ' + '\u254c'.repeat(40), '',
    '  ' + '\u2500'.repeat(40), '   Claude has written up a plan and is ready to execute. Would you like to proceed?', '',
    '   \u276f 1. Yes, and use auto mode', '     2. Yes, manually approve edits', '     3. Tell Claude what to change',
    '        shift+tab to approve with this feedback', '', '   ctrl+g to edit in VS Code \u00b7 ~/.claude/plans/a-plan.md', '',
  ].join('\n'));
  check('the 2.1.295 capture: three options, the first approves into auto mode',
    captured.up && captured.options.length === 3 && captured.auto?.digit === '1' && captured.auto.label === 'Yes, and use auto mode', JSON.stringify(captured));

  // P-9: nothing held after a plan approved into auto mode.
  check('released calls and read-only cards are nothing held',
    nothingHeld([{ requestId: 'cm-1@aa', toolName: 'Bash', readOnly: true }], [{ requestId: 'cm-1', tool: 'Bash', released: 'mode:unknown' }]).ok);
  check('no call at all is nothing held', nothingHeld([], []).ok);
  check('a card the app could answer is a hold, which fails', !nothingHeld([{ requestId: 'cm-2@aa', toolName: 'Write' }], []).ok);
  check('an audit row somebody answered is a hold, which fails', !nothingHeld([], [{ requestId: 'cm-2', tool: 'Write' }]).ok);

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(failed.length === 0 ? `OK ${results.length}/${results.length} passed` : `FAILED ${results.length - failed.length}/${results.length}`);
  for (const f of failed) console.log(`  failed: ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
  process.exit(failed.length ? 1 : 0);
} catch (error) {
  console.log(`FAILED harness: ${String((error as Error)?.stack ?? error)}`);
  process.exit(1);
}
