/**
 * The true-sync service: transcript to gate decision to card to answer, with no Claude involved.
 *
 * `test:claude-mod-socket` proves the socket speaks the protocol. This proves the parts the broker
 * owns: that the permission mode really is read from the transcript rather than asserted, that a
 * held call draws a card in the app's existing permission-card channel, that a tap closes it and
 * answers the socket exactly once, and that the app cannot ask for an approval the mod channel
 * cannot honour.
 *
 * It also pins two facts the design quietly depends on:
 * - The transcript locator's path expression agrees with Claude's real layout, including the
 *   adapter's own containment guard. If the two drift, every hold becomes `mode:unknown` and the
 *   phone goes silent in a way that looks like a dead feature.
 * - A broker-launched Claude carries `COSYNCING_SPAWNED=1` and does *not* get its `COSYNCING_HOME`
 *   rewritten, because that variable decides which socket a session dials and must not mean two
 *   things at once.
 *
 * `CLAUDE_CONFIG_DIR` is pointed at the temp tree before the adapter is imported, so the
 * transcript under test lives inside a real allowlisted projects root. That guard is the adapter's
 * defence against a planted symlink, and this suite refuses to weaken it to make a test convenient.
 *
 *   bun run packages/typescript/broker/test/claude/test-claude-mod-service.ts   (exit 0 = all pass)
 */
export {};
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as net from 'node:net';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: () => boolean, ms = 4_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (what()) return true;
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
}

// macOS reports os.tmpdir() behind the /var -> /private/var symlink, which the state-dir
  // guard refuses; canonicalize the root first, the way security/r2-export.ts does.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cmts-service-')));
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude-config');
const { ClaudeModService, modCardDetail } = await import('../../src/sessions/claude-mod-service.ts');
const { claudeProjectsRoot, findClaudeTranscript, sameTranscriptPath } = await import('../../src/sessions/claude-transcript-locator.ts');
const { resumeEnv, isClaudeTranscriptPathAllowed, readLatestPermissionMode, claudeSessionId } = await import('../../../adapters/claude/src/implementation.ts');
const { MOD_SOCKET_FILENAME } = await import('../../src/sessions/mod-socket-server.ts');

const projectsRoot = claudeProjectsRoot();
const workDir = join(root, 'work');
mkdirSync(join(projectsRoot, workDir.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true });
mkdirSync(workDir, { recursive: true });
const sessionId = randomUUID();
const transcript = join(projectsRoot, workDir.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);

let counter = 0;
/** Each rewrite gets a fresh mtime: the adapter caches the mode by size+mtime, and a test that
 *  wrote two identical rows in the same millisecond would otherwise read a stale answer. */
function writeTranscript(mode: string | undefined): void {
  counter += 1;
  const rows = [
    { type: 'user', uuid: `u${counter}`, message: { role: 'user', content: [{ type: 'text', text: `the users prompt ${counter}` }] } },
    ...(mode ? [{ type: 'permission-mode', permissionMode: mode }] : []),
  ];
  writeFileSync(transcript, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

interface FakeConn {
  clientCount: number;
  ingestRequest: (request: Record<string, unknown>) => void;
  respondPermission: (requestId: string, decision: string, info?: { decidedBy?: string; releaseReason?: string }) => void;
  answerQuestion: (requestId: string, answers: string[][]) => void;
  noteModNotice: (message: string) => void;
  published: Record<string, unknown>[];
  resolved: { requestId: string; decision: string; releaseReason?: string }[];
  answered: { requestId: string; answers: string[][] }[];
  notices: string[];
}
function fakeConn(viewers = 1): FakeConn {
  const conn: FakeConn = {
    clientCount: viewers,
    published: [],
    resolved: [],
    answered: [],
    notices: [],
    ingestRequest(request) {
      conn.published.push(request);
    },
    respondPermission(requestId, decision, info) {
      conn.resolved.push({ requestId, decision, ...(info?.releaseReason ? { releaseReason: info.releaseReason } : {}) });
    },
    answerQuestion(requestId, answers) {
      conn.answered.push({ requestId, answers });
    },
    noteModNotice(message) {
      conn.notices.push(message);
    },
  };
  return conn;
}
const conn = fakeConn(1);
/**
 * The id the app's card carries for a mod's call: the broker mints one per hold, the mod's own id
 * and a random tail, because the mod's ids restart at one in every process.
 */
const isCardFor = (requestId: unknown, modId: string): boolean => typeof requestId === 'string' && requestId.startsWith(`${modId}@`);
function cardId(modId: string, from: { published: Record<string, unknown>[] } = conn): string {
  const drawn = from.published.find((p) => isCardFor(p.requestId, modId))?.requestId;
  return typeof drawn === 'string' ? drawn : `${modId}@never-drawn`;
}
let killSwitch = false;
/** Every id the service asked the Hub for. A stub that ignores its argument is what let a
 *  native-uuid lookup against a row-id-keyed Hub pass this suite and fail the app. */
const hubKeys: string[] = [];
/** Swap the Hub's answer wholesale: a resident tab attaches Claude in plain Observe, and that
 *  connection has no card channel at all. */
let hubOverride: { clientCount: number; conn: unknown } | undefined;
const service = new ClaudeModService({
  socketPath: join(root, MOD_SOCKET_FILENAME),
  hub: (id) => {
    hubKeys.push(id);
    return hubOverride ?? { clientCount: conn.clientCount, conn };
  },
  transcriptPath: (id) => findClaudeTranscript(id, workDir),
  killSwitch: () => killSwitch,
  sessionTitle: () => 'scratch work',
  holdPollWaitMs: 1_000,
  log: { warn: () => {} },
});

function post(route: string, body: unknown, sid?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return postAt(service.socketPath, route, body, sid);
}

function postAt(path: string, route: string, body: unknown, sid?: string, timeoutMs = 8_000): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = `POST /claude/mod/${route}${sid ? `?sid=${sid}` : ''} HTTP/1.1\r\ncontent-length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
    const chunks: Buffer[] = [];
    const socket = net.createConnection({ path }, () => socket.write(request));
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8');
      socket.destroy();
      const [head = '', rest = ''] = text.split('\r\n\r\n');
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(rest);
      } catch {
        parsed = {};
      }
      resolve({ status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0), body: parsed });
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('latin1');
      const boundary = text.indexOf('\r\n\r\n');
      if (boundary >= 0) {
        const declared = /content-length: (\d+)/i.exec(text.slice(0, boundary))?.[1];
        if (declared !== undefined && Buffer.byteLength(text.slice(boundary + 4), 'latin1') >= Number(declared)) finish();
      }
    });
    socket.on('close', finish);
    socket.on('error', (error) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

const registerBody = { protocolVersion: 1, sessionId, cwd: workDir, claudeVersion: '2.1.288', isInteractive: true, surface: 'terminal' };
const releaseWhy = (body: Record<string, unknown>): string | undefined => (body.release as { why?: string } | undefined)?.why;

try {
  // ── The locator, against Claude's real layout and the adapter's own guard ──
  writeTranscript('default');
  check('the transcript under test passes the adapter containment guard', isClaudeTranscriptPathAllowed(transcript));
  check('the adapter reads the mode the locator points at', readLatestPermissionMode(transcript) === 'default');
  const found = findClaudeTranscript(sessionId, workDir);
  check('the locator finds the transcript by session id and cwd', !!found && sameTranscriptPath(found, transcript), String(found));
  check('the locator gives nothing for an unknown session', findClaudeTranscript(randomUUID(), workDir) === undefined);
  check('the locator ignores ids that are not session ids', findClaudeTranscript('not-a-uuid', workDir) === undefined);
  check('the locator still finds it when the recorded cwd moved', !!findClaudeTranscript(sessionId, join(root, 'somewhere-else')));
  check('the locator refuses a path outside a projects root', findClaudeTranscript(sessionId, workDir, { projectsRoot: join(root, 'nowhere') }) === undefined);

  // Two properties the hold gate depends on and nothing else asserted.
  //
  // (a) It searches EVERY store the adapter can see, not the one directory the broker's own
  //     CLAUDE_CONFIG_DIR happens to name. A wrapper store (claude-mi and friends) is a normal
  //     place for a session the roster is showing, and `mode:unknown` on every hold is what a
  //     single-root search silently produces there.
  // (b) It does not re-scan the projects tree five or six times per hold. The gate reads the mode
  //     to decide, and reads it again on every verdict poll.
  // A wrapper store is a `~/bin`-style script that re-points CLAUDE_CONFIG_DIR and execs claude;
  // that is the shape `claudeStores()` recognises, and the only shape worth testing against.
  const binDir = join(root, 'wrapper-bin');
  const wrapperConfig = join(root, 'wrapper-store');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(wrapperConfig, 'projects', workDir.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true });
  const wrapperSession = randomUUID();
  writeFileSync(join(binDir, 'claude-mini'), [
    '#!/usr/bin/env bash',
    `export CLAUDE_CONFIG_DIR="${wrapperConfig}"`,
    'exec claude "$@"',
    '',
  ].join('\n'), { mode: 0o755 });
  writeFileSync(
    join(wrapperConfig, 'projects', workDir.replace(/[^a-zA-Z0-9]/g, '-'), `${wrapperSession}.jsonl`),
    JSON.stringify({ type: 'permission-mode', permissionMode: 'plan', sessionId: wrapperSession }) + '\n',
  );
  const savedWrapperDir = process.env.COSYNCING_CLAUDE_WRAPPER_DIR;
  process.env.COSYNCING_CLAUDE_WRAPPER_DIR = binDir;
  const { clearClaudeTranscriptCache } = await import('../../src/sessions/claude-transcript-locator.ts');
  clearClaudeTranscriptCache();
  const viaWrapper = findClaudeTranscript(wrapperSession, workDir);
  check(
    'the locator searches a wrapper store, not only the broker\u2019s own config dir',
    !!viaWrapper && viaWrapper.includes('wrapper-store'),
    String(viaWrapper),
  );

  clearClaudeTranscriptCache();
  const scanStart = Date.now();
  findClaudeTranscript(sessionId, workDir);
  const firstMs = Date.now() - scanStart;
  const cachedStart = Date.now();
  const repeats: (string | undefined)[] = [];
  for (let i = 0; i < 24; i += 1) repeats.push(findClaudeTranscript(sessionId, workDir));
  const repeatMs = Date.now() - cachedStart;
  check(
    'a located transcript is cached, so a hold does not re-scan the projects tree',
    repeats.every((found) => !!found && sameTranscriptPath(found!, transcript)) && repeatMs <= Math.max(firstMs, 5),
    `first=${firstMs}ms 24-cached=${repeatMs}ms`,
  );
  check('a pinned root is not answered from the cache',
    findClaudeTranscript(sessionId, workDir, { projectsRoot: join(root, 'nowhere') }) === undefined);

  // A transcript that disappears is not kept alive by its cache entry.
  const vanishing = randomUUID();
  const vanishingSlug = workDir.replace(/[^a-zA-Z0-9]/g, '-');
  const vanishingPath = join(projectsRoot, vanishingSlug, `${vanishing}.jsonl`);
  mkdirSync(join(projectsRoot, vanishingSlug), { recursive: true });
  writeFileSync(vanishingPath, JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: vanishing }) + '\n');
  check('a fresh transcript is found', !!findClaudeTranscript(vanishing, workDir));
  rmSync(vanishingPath, { force: true });
  check('once it is gone the locator stops reporting it', findClaudeTranscript(vanishing, workDir) === undefined);
  clearClaudeTranscriptCache();
  if (savedWrapperDir === undefined) delete process.env.COSYNCING_CLAUDE_WRAPPER_DIR;
  else process.env.COSYNCING_CLAUDE_WRAPPER_DIR = savedWrapperDir;

  await service.start();
  check('the service binds its socket', service.listening, service.socketPath);
  check('the socket path is the one the mod would dial by default', service.socketPath.endsWith(MOD_SOCKET_FILENAME));

  const registered = await post('register', registerBody, sessionId);
  check('register answers through the service', registered.status === 200 && registered.body.state === 'live', JSON.stringify(registered.body).slice(0, 90));
  check('the service remembers where the session lives', service.registrationFor(sessionId)?.cwd === workDir);

  // ── Gate decided from the transcript, not from a claim ──
  // A `hold` is a two-leg exchange now: the broker acks the moment it takes the call, and the
  // re-offer is the leg that waits for the answer. The ack is what lets the terminal draw its
  // band on a call somebody is really deciding instead of on every ask.
  const acked = await post('hold', { sessionId, requestId: 'svc-1', tool: 'Bash', decision: 'ask', input: 'git push' }, sessionId);
  check('the ack names the call it took', acked.status === 200 && acked.body.held === true, JSON.stringify(acked.body).slice(0, 90));
  const held = post('hold', { sessionId, requestId: 'svc-1', tool: 'Bash', decision: 'ask', input: 'git push' }, sessionId);
  await sleep(200);
  check('a default-mode session with a viewer is held', service.isHeld(sessionId, cardId('svc-1')));
  check('the app was shown a permission card', conn.published.some((p) => isCardFor(p.requestId, 'svc-1') && p.kind === 'permission'), JSON.stringify(conn.published).slice(0, 140));
  check('the card names the tool it is about', conn.published.some((p) => p.toolName === 'Bash'));
  check('the card says which mode it was decided in', conn.published.some((p) => isCardFor(p.requestId, 'svc-1') && p.permissionMode === 'default'), JSON.stringify(conn.published[0] ?? {}).slice(0, 110));
  // What is being approved, not a sentence about it. The card used to carry an English paragraph
  // and no command, so a tap on `Bash` agreed to something the user could not read -- and in the
  // four non-English locales that paragraph was still English.
  check('the card shows the command being approved', conn.published.some((p) => isCardFor(p.requestId, 'svc-1') && p.inputPreview === 'git push'), JSON.stringify(conn.published[0] ?? {}).slice(0, 140));
  // The one `detail` it does write is the same data again, for a client that predates
  // `inputPreview` and would otherwise approve a command it cannot see.
  check('and the broker writes no prose of its own on the card', conn.published.every((p) => p.detail === undefined || p.detail === `${p.toolName}: ${p.inputPreview}`), JSON.stringify(conn.published.map((p) => p.detail)));
  check('MB6 unit: an older client reads the tool and the command in detail', conn.published.some((p) => isCardFor(p.requestId, 'svc-1') && p.detail === 'Bash: git push'), JSON.stringify(conn.published.map((p) => p.detail)));
  check('MB6 unit: detail drops the argument name the mod put in front', modCardDetail('Bash', 'command: rm -rf build') === 'Bash: rm -rf build'
    && modCardDetail('WebFetch', 'url: https://example.com') === 'WebFetch: https://example.com'
    && modCardDetail('Tool', 'note: kept') === 'Tool: note: kept', modCardDetail('Tool', 'note: kept'));
  check('MB6 unit: no preview, no detail', modCardDetail('Bash', undefined) === '' && modCardDetail('Bash', '   ') === '');
  check('MB6 unit: detail is bounded like the preview', modCardDetail('Bash', 'x'.repeat(400)).length === 240
    && modCardDetail('Bash', 'x'.repeat(400)).endsWith('\u2026')
    && modCardDetail('Bash', `command: ${'x'.repeat(400)}`).length <= 240, String(modCardDetail('Bash', 'x'.repeat(400)).length));
  check('the card carries the session title', conn.published.some((p) => p.title === 'scratch work'));

  // The Hub keys a Claude row by the encoded transcript path, while the mod speaks the native
  // session uuid. Asked with the uuid, `getConn` finds nothing, `viewers` reads zero, and every
  // hold comes back `viewer:none` with no card ever drawn -- which is what the app showed.
  const rowId = claudeSessionId(transcript);
  check('the Hub is asked for the row id, not the mod uuid', hubKeys.includes(rowId), hubKeys.slice(0, 3).join(','));
  check('and never for the bare uuid', !hubKeys.includes(sessionId), hubKeys.slice(0, 3).join(','));

  const approved = service.approve({ sessionId, requestId: cardId('svc-1'), decision: 'approve' });
  const heldReply = await held;
  const verdict = heldReply.body.verdict as { behavior?: string; source?: string } | undefined;
  check('a tap in the app settles the held call', approved && verdict?.behavior === 'allow', JSON.stringify(heldReply.body).slice(0, 120));
  check('the verdict says the app answered', verdict?.source === 'app');
  check('the card is closed in the Hub after the answer', conn.resolved.some((r) => isCardFor(r.requestId, 'svc-1')));
  check('the hold is no longer answerable', !service.isHeld(sessionId, cardId('svc-1')) && service.approve({ sessionId, requestId: cardId('svc-1'), decision: 'reject' }) === false);

  // ── An approval the channel cannot honour ──
  await post('hold', { sessionId, requestId: 'svc-2', tool: 'Write', decision: 'ask' }, sessionId);
  const sessionWide = post('hold', { sessionId, requestId: 'svc-2', tool: 'Write', decision: 'ask' }, sessionId);
  await sleep(200);
  check('a session-wide approval is refused', service.approve({ sessionId, requestId: cardId('svc-2'), decision: 'approve-session' }) === false);
  check('and the refusal explains why', String(service.refusalReason('approve-session') ?? '').includes('one call'));
  check('the hold survives that refusal', service.isHeld(sessionId, cardId('svc-2')));
  check('MB2 unit: the mod\'s own id is not a card id, and answers nothing', service.approve({ sessionId, requestId: 'svc-2', decision: 'approve' }) === false
    && service.isHeld(sessionId, 'svc-2') === false && service.isHeld(sessionId, cardId('svc-2')), cardId('svc-2'));
  // The app's `approve` frame carries the id it is attached to, which is the row id; the hold it
  // answers is filed under the mod's uuid. Both spellings must reach the same hold.
  const rejected = service.approve({ sessionId: rowId, requestId: cardId('svc-2'), decision: 'reject' });
  const rejectedReply = await sessionWide;
  check('an answer addressed by row id reaches the hold', rejected && (rejectedReply.body.verdict as { behavior?: string } | undefined)?.behavior === 'deny', JSON.stringify(rejectedReply.body).slice(0, 100));

  // ── auto mode, the mode the product must never touch ──
  writeTranscript('auto');
  const autoReply = await post('hold', { sessionId, requestId: 'svc-3a', tool: 'Bash', decision: 'ask' }, sessionId);
  check('auto mode releases at once, read from the transcript', releaseWhy(autoReply.body) === 'mode:auto', JSON.stringify(autoReply.body).slice(0, 110));
  // AM2: the classifier answers it, with nobody shown a dialog, so there is nothing to explain.
  check('AM2: and draws no card, read-only or otherwise', !conn.published.some((p) => isCardFor(p.requestId, 'svc-3a')),
    JSON.stringify(conn.published.find((p) => isCardFor(p.requestId, 'svc-3a')) ?? {}).slice(0, 120));

  // ── bypass mode still shows a read-only card ──
  writeTranscript('bypassPermissions');
  const bypassReply = await post('hold', { sessionId, requestId: 'svc-3', tool: 'Bash', decision: 'ask' }, sessionId);
  check('bypass mode releases at once, read from the transcript', releaseWhy(bypassReply.body) === 'mode:bypassPermissions', JSON.stringify(bypassReply.body).slice(0, 110));
  check('the release names its rule as a field the client localizes', conn.published.some((p) => isCardFor(p.requestId, 'svc-3') && p.releaseReason === 'mode:bypassPermissions' && p.readOnly === true), JSON.stringify(conn.published.find((p) => isCardFor(p.requestId, 'svc-3')) ?? {}).slice(0, 120));

  // ── C2: what a read-only card is allowed to do ──
  // It explains a decision the broker did not make. That is worth showing, and worth replaying to
  // a socket that opens mid-turn, but it is NOT a wait: it used to arrive as a plain blocking
  // permission-request, which pinned the row at needs-input for the rest of the session and turned
  // every prompt typed afterwards into a mid-turn steer.
  check('the read-only card says nobody is waiting on it', conn.published.some((p) => isCardFor(p.requestId, 'svc-3') && p.blocking === false), JSON.stringify(conn.published.find((p) => isCardFor(p.requestId, 'svc-3')) ?? {}).slice(0, 140));
  check('a held card is still blocking, by contrast', conn.published.some((p) => isCardFor(p.requestId, 'svc-1') && p.blocking === undefined), 'svc-1');

  // The turn it explained is over, so the card stops being an open question.
  service.noteModEvent({ sessionId, kind: 'turn.complete' });
  check('a turn boundary retires the explanation card, with its reason',
    conn.resolved.some((r) => isCardFor(r.requestId, 'svc-3') && r.decision === 'external' && r.releaseReason === 'mode:bypassPermissions'),
    JSON.stringify(conn.resolved));
  const beforeRepeat = conn.resolved.length;
  service.noteModEvent({ sessionId, kind: 'turn.complete' });
  check('and it is retired once', conn.resolved.length === beforeRepeat, `${beforeRepeat} -> ${conn.resolved.length}`);

  // A prompt is the person moving on, which retires the explanation just as a turn boundary does.
  const svcRo = await post('hold', { sessionId, requestId: 'svc-ro2', tool: 'Bash', decision: 'ask' }, sessionId);
  check('a second declined ask draws a second explanation', releaseWhy(svcRo.body) === 'viewer:none' || releaseWhy(svcRo.body) === 'mode:unknown' || releaseWhy(svcRo.body) === 'mode:bypassPermissions', JSON.stringify(svcRo.body).slice(0, 90));
  const moved = service.send(sessionId, { requestId: 'svc-send', op: 'prompt', text: 'carry on', queuedAt: Date.now() });
  check('a prompt retires the explanation card too', moved.ok === true && conn.resolved.some((r) => isCardFor(r.requestId, 'svc-ro2')), JSON.stringify(conn.resolved.slice(-2)));

  // ── a mod that stopped polling ──
  // Nothing enters a verdict poll for a mod that is not polling, and the hold's expiry used to live
  // only inside that poll. The card stayed live after cosyncing had stopped waiting, tappable for
  // a call its terminal had long since been handed back. The status read is what has to close it.
  const quietConn = fakeConn(1);
  const quietId = randomUUID();
  const quietDir = join(projectsRoot, quietId.slice(0, 8));
  mkdirSync(quietDir, { recursive: true });
  const quietTranscript = join(quietDir, `${quietId}.jsonl`);
  writeFileSync(quietTranscript, JSON.stringify({ type: 'permission-mode', permissionMode: 'default' }) + '\n');
  const quiet = new ClaudeModService({
    socketPath: join(root, 'quiet.sock'),
    hub: () => ({ clientCount: quietConn.clientCount, conn: quietConn }),
    transcriptPath: () => quietTranscript,
    killSwitch: () => false,
    holdLeaseMs: 300,
    holdPollWaitMs: 150,
    log: { warn: () => {} },
    // This section is about the status read; the timed sweep has its own (test:claude-mod-hold-seam, BH1).
    sweepIntervalMs: 3_600_000,
  });
  await quiet.start();
  const quietSocket = quiet.socketPath;
  const quietRegister = await postAt(quietSocket, 'register', { protocolVersion: 1, sessionId: quietId, cwd: workDir, claudeVersion: '2.1.288', isInteractive: true, surface: 'terminal' }, quietId);
  check('the quiet session registers', quietRegister.status === 200, `status=${quietRegister.status}`);
  // Held, the hold request times its own wait out, and then the mod goes silent for good.
  const quietHold = await postAt(quietSocket, 'hold', { sessionId: quietId, requestId: 'cm-quiet', tool: 'Bash', toolUseId: 'tu-quiet', decision: 'ask', input: 'command: leave it hanging' }, quietId, 8_000);
  check('the silent mod has a hold open', quiet.isHeld(quietId, cardId('cm-quiet', quietConn)), JSON.stringify(quietHold.body).slice(0, 90));
  check('and its card is drawn', quietConn.published.some((p) => isCardFor(p.requestId, 'cm-quiet')), JSON.stringify(quietConn.published.map((p) => p.requestId)));
  await sleep(400);
  check('BH1: once its lease lapses the card stands for nothing a tap can reach, before any sweep or status read',
    quiet.isHeld(quietId, cardId('cm-quiet', quietConn)) === false);
  check('BH1: and an app approve on it is refused', quiet.approve({ sessionId: quietId, requestId: cardId('cm-quiet', quietConn), decision: 'approve' }) === false);
  quiet.status(quietId);
  check('a status read closes the hold that nobody is polling', await until(() => quiet.isHeld(quietId, cardId('cm-quiet', quietConn)) === false, 2_000), `held=${quiet.isHeld(quietId, cardId('cm-quiet', quietConn))}`);
  check('and closes the card with it', await until(() => quietConn.resolved.some((r) => isCardFor(r.requestId, 'cm-quiet')), 2_000), JSON.stringify(quietConn.resolved));
  check('a tap on the retired card does not report an approval', quietConn.resolved.filter((r) => isCardFor(r.requestId, 'cm-quiet')).every((r) => r.decision !== 'approve'), JSON.stringify(quietConn.resolved));
  // Re-offering the same call inside the same registration is a fresh wait, not a verdict. What
  // must not survive the expiry is a decision: the mod may be told "held" again, but it may never
  // be told "approved" by an answer that was never given.
  const quietAgain = await postAt(quietSocket, 'hold', { sessionId: quietId, requestId: 'cm-quiet', tool: 'Bash', toolUseId: 'tu-quiet', decision: 'ask' }, quietId, 8_000);
  check('the expired call comes back with no invented verdict', quietAgain.body?.verdict === undefined && quietAgain.body?.answer === undefined, JSON.stringify(quietAgain.body).slice(0, 110));
  quiet.close();

  // ── a viewer that cannot answer is not a seat ──
  // The count alone said "somebody is watching" and the hold parked the terminal's prompt against an
  // app that had no way to tap it. An Observe connection refuses
  // every mutation, so watching is not the gate; being able to answer is.
  hubOverride = { clientCount: 2, conn: { clientCount: 2 } };
  const readOnlyReply = await post('hold', { sessionId, requestId: 'svc-ro', tool: 'Bash', decision: 'ask' }, sessionId);
  check('a read-only viewer does not hold the prompt', releaseWhy(readOnlyReply.body) === 'viewer:none', JSON.stringify(readOnlyReply.body).slice(0, 110));
  check('and nothing was published to a connection that cannot draw it', !conn.published.some((p) => isCardFor(p.requestId, 'svc-ro')));
  hubOverride = undefined;

  // ── mode:unknown, the fail-open shape ──
  writeTranscript(undefined);
  const unknownReply = await post('hold', { sessionId, requestId: 'svc-4', tool: 'Bash', decision: 'ask' }, sessionId);
  check('a session with no permission-mode row is not held', releaseWhy(unknownReply.body) === 'mode:unknown', JSON.stringify(unknownReply.body).slice(0, 110));
  writeTranscript('default');

  // ── viewers, kill switch ──
  conn.clientCount = 0;
  const noViewer = await post('hold', { sessionId, requestId: 'svc-5', tool: 'Bash', decision: 'ask' }, sessionId);
  check('no viewer releases the hold', releaseWhy(noViewer.body) === 'viewer:none');
  conn.clientCount = 1;
  killSwitch = true;
  const switched = await post('hold', { sessionId, requestId: 'svc-6', tool: 'Bash', decision: 'ask' }, sessionId);
  check('the kill switch releases the hold and outranks everything', releaseWhy(switched.body) === 'killSwitch');
  const switchedPoll = await post('poll', { sessionId, wait: 10 }, sessionId);
  check('the switch reaches the mod on the next poll', (switchedPoll.body.state as { killSwitch?: boolean } | undefined)?.killSwitch === true, JSON.stringify(switchedPoll.body.state));
  killSwitch = false;

  // ── commands, and the audit trail ──
  const sent = service.send(sessionId, { requestId: 'cmd-1', op: 'prompt', text: 'run the tests', queuedAt: Date.now() });
  check('a prompt can be queued for a registered session', sent.ok === true, JSON.stringify(sent));
  const arrived = await post('poll', { sessionId, wait: 10 }, sessionId);
  check('the prompt arrives on the next poll', (arrived.body.command as { op?: string } | undefined)?.op === 'prompt', JSON.stringify(arrived.body).slice(0, 120));
  // `answer` survives in the command union as a queue entry with a TTL and nothing that consumes
  // it. Accepting it is the trap: the caller sees `{ok:true}`, the question stays open, and the
  // terminal waits out its hold deadline on an answer the broker was told about.
  const queuedAnswer = service.send(sessionId, { requestId: 'cmd-answer', op: 'answer', answers: { q: 'Red' }, queuedAt: Date.now() });
  check('an answer is refused as a command and said so', queuedAnswer.ok === false && queuedAnswer.code === 'answer_on_hold', JSON.stringify(queuedAnswer));
  const afterRefusal = await post('poll', { sessionId, wait: 10 }, sessionId);
  check('and nothing was queued behind that refusal', afterRefusal.body.command === undefined, JSON.stringify(afterRefusal.body).slice(0, 90));
  // ── Stop, and the turn it is allowed to stop ──
  // An abort used to be refused for want of a turn id the app could not possibly supply, and the
  // mod used to answer with whatever id it happened to be holding. Both are wrong the same way:
  // the broker is the only party that knows both the session and what that session is running.
  const noTurn = service.send(sessionId, { requestId: 'cmd-stop-none', op: 'abort', queuedAt: Date.now() });
  check('Stop with no turn running is refused as no_active_turn', noTurn.ok === false && noTurn.code === 'no_active_turn', JSON.stringify(noTurn));

  await post('event', { sessionId, kind: 'turn.start', detail: { turnId: 'turn-77' } }, sessionId);
  const stamped = service.send(sessionId, { requestId: 'cmd-stop', op: 'abort', queuedAt: Date.now() });
  check('Stop is accepted once a turn is running', stamped.ok === true, JSON.stringify(stamped));
  const stopArrived = await post('poll', { sessionId, wait: 10 }, sessionId);
  const stopCommand = stopArrived.body.command as { op?: string; turnId?: string } | undefined;
  check('and arrives carrying the turn the mod reported', stopCommand?.op === 'abort' && stopCommand.turnId === 'turn-77', JSON.stringify(stopArrived.body).slice(0, 140));

  await post('event', { sessionId, kind: 'turn.complete', detail: { turnId: 'turn-77' } }, sessionId);
  const afterTurn = service.send(sessionId, { requestId: 'cmd-stop-late', op: 'abort', queuedAt: Date.now() });
  check('the completed turn is not stopped twice', afterTurn.ok === false && afterTurn.code === 'no_active_turn', JSON.stringify(afterTurn));

  // A subagent's turn is not the main loop's. Every hook sees a child's `turn.complete`, and the
  // mod is told to say nothing about it; the broker refuses to be the half that forgets.
  await post('event', { sessionId, kind: 'turn.start', detail: { turnId: 'turn-88' } }, sessionId);
  await post('event', { sessionId, kind: 'turn.complete', detail: { turnId: 'child-1', agentId: 'agent-3' } }, sessionId);
  const childTurn = service.send(sessionId, { requestId: 'cmd-stop-child', op: 'abort', queuedAt: Date.now() });
  check("a subagent's turn.complete does not clear the main turn", childTurn.ok === true, JSON.stringify(childTurn));
  const childStop = (await post('poll', { sessionId, wait: 10 }, sessionId)).body.command as { turnId?: string } | undefined;
  check('and Stop still names the parent turn', childStop?.turnId === 'turn-88', JSON.stringify(childStop));

  const trail = service.auditTrail(sessionId);
  check('the audit trail records the decisions and the releases', trail.length >= 6, `${trail.length} rows`);
  check('every row names a mode, an answerer and a duration', trail.every((r) => typeof r.modeSeen === 'string' && typeof r.answeredBy === 'string' && typeof r.durationMs === 'number'));
  const serialised = JSON.stringify(trail);
  check('no audit row carries prompt or command text', !serialised.includes('git push') && !serialised.includes('run the tests') && !serialised.includes('the users prompt'), serialised.slice(0, 100));

  // ── an AskUserQuestion answered from the app ──
  // The app sends one array of labels per question; Claude's tool takes { [question text]:
  // answer } with a multi-select comma-joined. The conversion is the broker's, because a position
  // means nothing without the question it came from, and the hold, not the command queue, is what
  // has to resolve: a mod parked on a hold is not parked on its poll leg at the same time.
  const questions = [
    { question: 'Which report?', header: 'Report', multiSelect: false, options: [{ label: 'Weekly' }, { label: 'Monthly' }] },
    { question: 'Which sections?', header: 'Sections', multiSelect: true, options: [{ label: 'Revenue' }, { label: 'Churn' }] },
  ];
  await post('hold', { sessionId, requestId: 'svc-q1', tool: 'AskUserQuestion', decision: 'ask', questions }, sessionId);
  const asked = post('hold', { sessionId, requestId: 'svc-q1', tool: 'AskUserQuestion', decision: 'ask', questions }, sessionId);
  await sleep(200);
  const card = conn.published.find((p) => isCardFor(p.requestId, 'svc-q1'));
  check('a question hold draws a question card', card?.kind === 'question', JSON.stringify(card ?? {}).slice(0, 120));
  const cardQuestions = card?.questions as { multiple?: boolean }[] | undefined;
  check("Claude's multiSelect arrives as the contract's multiple", cardQuestions?.[0]?.multiple === false && cardQuestions?.[1]?.multiple === true, JSON.stringify(cardQuestions));

  const answered = service.answerQuestion({
    sessionId,
    requestId: cardId('svc-q1'),
    answers: [['Monthly'], ['Revenue', 'Churn']],
  });
  const askedReply = await asked;
  const wireAnswer = askedReply.body.answer as { requestId?: string; answers?: Record<string, string> } | undefined;
  check('the app answer resolves the hold rather than queueing behind it', answered, JSON.stringify(askedReply.body).slice(0, 120));
  check('the rows become the map the tool validates', wireAnswer?.answers?.['Which report?'] === 'Monthly' && wireAnswer?.answers?.['Which sections?'] === 'Revenue, Churn', JSON.stringify(wireAnswer));
  check('the card closes with the answer, in the app rows', conn.answered.some((a) => isCardFor(a.requestId, 'svc-q1')
    && JSON.stringify(a.answers) === JSON.stringify([['Monthly'], ['Revenue', 'Churn']])), JSON.stringify(conn.answered));
  check('and the hold is not left open to be answered twice', !service.isHeld(sessionId, cardId('svc-q1'))
    && service.answerQuestion({ sessionId, requestId: cardId('svc-q1'), answers: [['Monthly'], ['Revenue']] }) === false);

  // The answer must line up with the questions the card was drawn from. Rows in the wrong order,
  // a second label on a single-choice question, or a row count that does not match are all
  // refused: an answer on the wrong question is words in the user's mouth that the model believes.
  const asked2 = post('hold', { sessionId, requestId: 'svc-q2', tool: 'AskUserQuestion', decision: 'ask', questions }, sessionId);
  await sleep(150);
  check('a single-choice row with two labels is refused', service.answerQuestion({ sessionId, requestId: cardId('svc-q2'), answers: [['Weekly', 'Monthly'], ['Revenue']] }) === false);
  check('and so is a row count that does not match the questions', service.answerQuestion({ sessionId, requestId: cardId('svc-q2'), answers: [['Weekly']] }) === false);
  const lateAsk = await asked2;
  check('with the hold still open for the human', service.isHeld(sessionId, cardId('svc-q2')), JSON.stringify(lateAsk.body).slice(0, 80));
  await post('event', { sessionId, kind: 'user-cancel', requestId: 'svc-q2' }, sessionId);
  await sleep(60);

  // A command the mod took and then could not carry out. The app was told it was delivered, so
  // the terminal's refusal has to reach the seat that is watching or "sent" is a lie.
  await post('event', { sessionId, kind: 'command.refused', requestId: 'cmd-x', detail: { op: 'abort', reason: 'no_active_turn' } }, sessionId);
  check("the mod's own refusal reaches the watching seat", conn.notices.some((m) => m.includes('Nothing was running')), JSON.stringify(conn.notices));

  // ── lifecycle ──
  await post('event', { sessionId, kind: 'session.end', detail: { reason: 'prompt_input_exit' } }, sessionId);
  check('session.end drops the row', service.status(sessionId).present === false);
  check('and the cwd it remembered', service.registrationFor(sessionId) === undefined);
  service.close();
  check('close releases the socket', service.listening === false);

  // ── BH4: the kill switch read from a real config file, and a bind that failed advertises nothing ──
  {
    const { inspectBrokerConfig, writeBrokerConfig, defaultBrokerConfig, brokerConfigPath } = await import('../../src/runtime/configuration.ts');
    const { claudeTrueSyncKillSwitchFrom } = await import('../../src/runtime/claude-mod-kill-switch.ts');
    const configHome = (label: string): string => {
      const home = join(root, `config-${label}`);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      return home;
    };
    const switchFor = (home: string): boolean => claudeTrueSyncKillSwitchFrom(inspectBrokerConfig(home), true);
    const missing = configHome('missing');
    const enabled = configHome('enabled');
    writeBrokerConfig(defaultBrokerConfig(), enabled);
    const disabled = configHome('disabled');
    writeBrokerConfig({ ...defaultBrokerConfig(), features: { ...defaultBrokerConfig().features, claudeTrueSyncMod: false } }, disabled);
    const malformed = configHome('malformed');
    writeFileSync(brokerConfigPath(malformed), '{"schemaVersion": 2, "broker": {', { mode: 0o600 });
    const invalid = configHome('invalid');
    writeFileSync(brokerConfigPath(invalid), JSON.stringify({ schemaVersion: 99 }), { mode: 0o600 });
    const unsafe = configHome('unsafe');
    writeBrokerConfig(defaultBrokerConfig(), unsafe);
    chmodSync(brokerConfigPath(unsafe), 0o644);
    check('BH4 a missing config reads as the defaults: the kill switch is off', switchFor(missing) === false);
    check('BH4 a valid config with true sync on leaves the kill switch off, and one with it off turns it on',
      switchFor(enabled) === false && switchFor(disabled) === true);
    check('BH4 a malformed config reads as the kill switch ON, not as the default',
      inspectBrokerConfig(malformed).status === 'error' && switchFor(malformed) === true);
    check('BH4 a config that will not validate, or that is not owner-only, reads as the kill switch ON',
      switchFor(invalid) === true && inspectBrokerConfig(unsafe).status === 'error' && switchFor(unsafe) === true);

    const { ClaudeAdapter } = await import('../../../adapters/claude/src/implementation.ts');
    const unbindable = new ClaudeModService({
      socketPath: join(root, 'x'.repeat(70), 'y'.repeat(40), MOD_SOCKET_FILENAME),
      hub: () => undefined,
      transcriptPath: () => undefined,
      killSwitch: () => false,
      log: { warn: () => {} },
    });
    let bindError = '';
    try {
      await unbindable.start();
    } catch (error) {
      bindError = String((error as Error)?.message ?? error);
    }
    const unbound = new ClaudeAdapter({ modBridge: { serving: () => unbindable.listening, status: () => undefined } });
    check('BH4 a mod socket that failed to bind advertises no live attach',
      bindError.length > 0 && unbindable.listening === false
        && unbound.capabilities.supportsLiveAttach !== true && !unbound.capabilities.attachModes.includes('live'),
      `${bindError.slice(0, 60)} ${JSON.stringify(unbound.capabilities.attachModes)}`);
    const bindable = new ClaudeModService({
      socketPath: join(root, `bh4-${MOD_SOCKET_FILENAME}`),
      hub: () => undefined,
      transcriptPath: () => undefined,
      killSwitch: () => false,
      log: { warn: () => {} },
    });
    const bound = new ClaudeAdapter({ modBridge: { serving: () => bindable.listening, status: () => undefined } });
    const beforeBind = bound.capabilities.supportsLiveAttach === true;
    await bindable.start();
    const whileBound = bound.capabilities.supportsLiveAttach === true && bound.capabilities.attachModes[0] === 'live';
    bindable.close();
    check('BH4 live attach is advertised exactly while the socket is bound: not before, not after close',
      !beforeBind && whileBound && bound.capabilities.supportsLiveAttach !== true,
      `before=${beforeBind} bound=${whileBound} after=${bound.capabilities.supportsLiveAttach}`);

    // BH6: a `command.refused` comes from the terminal, and its words go into a sentence on the app.
    const refusalNotices: string[] = [];
    const refusing = new ClaudeModService({
      socketPath: join(root, `bh6-${MOD_SOCKET_FILENAME}`),
      hub: () => ({ clientCount: 1, conn: { noteModNotice: (message: string) => refusalNotices.push(message) } }),
      transcriptPath: () => undefined,
      killSwitch: () => false,
      log: { warn: () => {} },
    });
    const refusingSession = randomUUID();
    refusing.noteModEvent({ sessionId: refusingSession, kind: 'command.refused', detail: { op: 'steer', reason: 'not_running' } });
    refusing.noteModEvent({ sessionId: refusingSession, kind: 'command.refused', detail: { op: `x${'y'.repeat(5000)}`, reason: 'see <a href=x>\nthis</a>' } });
    check('BH6 a command.refused names the op and reason it carries when each is one the broker knows the shape of',
      refusalNotices[0] === 'The cosyncing mod in your terminal could not carry out that steer (not_running).', refusalNotices[0]);
    check('BH6 and anything else is named generically, never repeated onto the app',
      refusalNotices[1] === 'The cosyncing mod in your terminal could not carry out that command (refused).', (refusalNotices[1] ?? '').slice(0, 120));

    // BH3: the broker can be told to stop while its mod socket is still starting. Nothing may be left
    // listening afterwards, and the service may not report itself started.
    const stoppedEarlyPath = join(root, `bh3-${MOD_SOCKET_FILENAME}`);
    const stoppedEarly = new ClaudeModService({
      socketPath: stoppedEarlyPath,
      hub: () => undefined,
      transcriptPath: () => undefined,
      killSwitch: () => false,
      log: { warn: () => {} },
    });
    const startingEarly = stoppedEarly.start();
    stoppedEarly.close();
    await startingEarly.catch(() => undefined);
    const answeredAfterStop = await new Promise<string>((resolve) => {
      const probe = net.createConnection({ path: stoppedEarlyPath }, () => {
        probe.destroy();
        resolve('connected');
      });
      probe.on('error', () => resolve('refused'));
      setTimeout(() => resolve('hung'), 2_000);
    });
    check('BH3 a service stopped while it was starting is not listening, and nothing answers on its socket',
      stoppedEarly.listening === false && answeredAfterStop === 'refused', `listening=${stoppedEarly.listening} ${answeredAfterStop}`);
  }

  // ── R4-7: "the terminal has closed" is said only about a terminal the app was following ──
  {
    // Each terminal is a real process: it registers over the socket, polls, and is killed. Its pid
    // and start time are what the real registry watches, so its death is the kernel's, not a stub's.
    const terminalScript = [
      'const [socketPath, sessionId, interactive, cwd] = process.argv.slice(1);',
      'const post = async (route, body) => {',
      '  const response = await fetch(`http://cosyncing.local/claude/mod/${route}?sid=${sessionId}`, {',
      "    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), unix: socketPath,",
      '  });',
      '  return response.json();',
      '};',
      "const registered = await post('register', { protocolVersion: 1, sessionId, cwd, claudeVersion: '2.1.292', isInteractive: interactive === '1', surface: 'terminal' });",
      'console.log(JSON.stringify({ registered: registered.ok === true }));',
      "for (;;) { try { await post('poll', { sessionId, wait: 300 }); } catch { await Bun.sleep(100); } }",
    ].join('\n');
    const viewersOf = new Map<string, number>();
    const deadReported: string[] = [];
    const followSocket = join(root, `r47-${MOD_SOCKET_FILENAME}`);
    const following = new ClaudeModService({
      socketPath: followSocket,
      hub: (id) => {
        const viewers = viewersOf.get(id) ?? 0;
        return viewers > 0 ? { clientCount: viewers, conn: fakeConn(viewers) } : undefined;
      },
      transcriptPath: () => undefined,
      killSwitch: () => false,
      // The "terminals" are this suite's children, and so the broker's. Only the descendant rule is off.
      isBrokerChild: () => false,
      sweepIntervalMs: 50,
      onEvent: (event) => {
        if (event.kind === 'attention.pid-dead') deadReported.push(event.sessionId);
      },
      log: { warn: () => {} },
    });
    await following.start();
    const terminal = async (interactive: boolean) => {
      const id = randomUUID();
      const child = Bun.spawn([process.execPath, '-e', terminalScript, followSocket, id, interactive ? '1' : '0', workDir], {
        stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      });
      const present = await until(() => following.status(id).present, 8_000);
      return { id, child, present };
    };
    const kill = async (child: ReturnType<typeof Bun.spawn>) => {
      child.kill('SIGKILL');
      await child.exited;
    };
    const gone = (id: string) => until(() => !following.status(id).present, 3_000);

    // A `claude -p` script, watched by the app the whole time: not a terminal anyone sat at.
    const script = await terminal(false);
    viewersOf.set(script.id, 1);
    await until(() => false, 200);
    await kill(script.child);
    check('R4-7 a dead non-interactive row raises nothing, and is deregistered',
      script.present && await gone(script.id) && !deadReported.includes(script.id), JSON.stringify({ present: script.present, deadReported }));

    // A terminal nobody opened in the app: no viewer, no card, no command.
    const unwatched = await terminal(true);
    await until(() => false, 200);
    await kill(unwatched.child);
    check('R4-7 a dead interactive row the app never followed raises nothing, and is deregistered',
      unwatched.present && await gone(unwatched.id) && !deadReported.includes(unwatched.id), JSON.stringify({ present: unwatched.present, deadReported }));

    // A terminal the app had open.
    const watched = await terminal(true);
    viewersOf.set(watched.id, 1);
    await until(() => false, 200);
    await kill(watched.child);
    check('R4-7 a dead interactive row the app was following raises exactly one',
      watched.present && await gone(watched.id) && await until(() => deadReported.includes(watched.id), 2_000)
        && deadReported.filter((id) => id === watched.id).length === 1,
      JSON.stringify({ present: watched.present, deadReported }));

    // A terminal the app sent a message to, then closed the page on before it died.
    const messaged = await terminal(true);
    const sentPrompt = following.send(messaged.id, { requestId: 'r47-prompt', op: 'prompt', text: 'hello', queuedAt: Date.now() });
    const deliveredAt = Date.now();
    await until(() => false, 800);
    await kill(messaged.child);
    check('R4-7 a row the app followed only by a delivered command raises one too',
      sentPrompt.ok && messaged.present && await gone(messaged.id) && await until(() => deadReported.includes(messaged.id), 2_000)
        && deadReported.filter((id) => id === messaged.id).length === 1,
      JSON.stringify({ sentPrompt, deliveredAfterMs: Date.now() - deliveredAt, deadReported }));
    following.close();
  }

  // ── the spawned-child marker ──
  const env = resumeEnv({ configDir: join(root, 'claude-config'), isDefault: true } as never, { COSYNCING_HOME: '/tmp/review-state', PATH: '/usr/bin' });
  check('a broker-launched Claude is marked as spawned', env.COSYNCING_SPAWNED === '1');
  check('and its COSYNCING_HOME is left alone (one variable, one meaning)', env.COSYNCING_HOME === '/tmp/review-state');
  check('the marker sets the config dir it always set', env.CLAUDE_CONFIG_DIR === join(root, 'claude-config'));
} catch (error) {
  check('no exception', false, String((error as Error)?.stack ?? error).slice(0, 300));
} finally {
  try {
    service.close();
  } catch {
    // already closed
  }
  delete process.env.CLAUDE_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `FAILED ${failed.length}/${results.length}` : `OK ${results.length}/${results.length} passed`}`);
process.exit(failed.length ? 1 : 0);
