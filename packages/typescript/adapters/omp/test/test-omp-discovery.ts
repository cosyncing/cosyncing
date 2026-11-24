#!/usr/bin/env bun
/**
 * omp discovery deltas the merged suites do not assert: dialect-specific naming, subagent lineage on
 * attach and observe-only control, symlinked transcripts, shared-Pi-variable suppression, the
 * future-version fail-closed surface, and the XDG/PI_CONFIG_DIR/PI_CODING_AGENT_DIR path rules.
 * (Title/model parsing and subagent tree rows live in e2e/adapters/conformance/omp.test.ts.)
 * Fixture JSONL only, no real omp.
 */
export {};
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-omp-discovery-'));
const sessionsRoot = join(root, 'sessions');
const cwdA = join(root, 'work-a');
mkdirSync(sessionsRoot, { recursive: true });
mkdirSync(cwdA, { recursive: true });

// Session A: the real omp layout — a leading `title` slot BEFORE the `session` header, a combined
// model_change string, and two title_change entries (last write wins).
const sessionA = join(sessionsRoot, '2026-08-20_aaaa.jsonl');
writeFileSync(sessionA, [
  JSON.stringify({ type: 'title', v: 1, title: '', updatedAt: 1787000000000, pad: '' }),
  JSON.stringify({ type: 'session', version: 3, id: 'sess-a', timestamp: '2026-08-20T00:00:00.000Z', cwd: cwdA }),
  JSON.stringify({ type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-08-20T00:00:01.000Z', model: 'openai/gpt-5.2', resolvedModelIsFallback: false }),
  JSON.stringify({ type: 'title_change', id: 't1', parentId: 'm1', timestamp: '2026-08-20T00:01:00.000Z', title: 'First name', source: 'user' }),
  JSON.stringify({ type: 'title_change', id: 't2', parentId: 't1', timestamp: '2026-08-20T00:02:00.000Z', title: 'Renamed session', previousTitle: 'First name', source: 'user', trigger: 'manual' }),
  JSON.stringify({ type: 'message', id: 'u1', parentId: 't2', timestamp: '2026-08-20T00:02:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'durable observe marker' }] } }),
].join('\n') + '\n');

// Session B: the declared migration path preserves an older Pi-shaped session name.
const sessionB = join(sessionsRoot, '2026-08-21_bbbb.jsonl');
writeFileSync(sessionB, [
  JSON.stringify({ type: 'session', version: 3, id: 'sess-b', timestamp: '2026-08-21T00:00:00.000Z', cwd: cwdA }),
  JSON.stringify({ type: 'session_info', id: 'n1', parentId: null, timestamp: '2026-08-21T00:01:00.000Z', name: 'Legacy pi-shaped name' }),
].join('\n') + '\n');

// Session C: a NON-EMPTY leading title slot and no later title_change — the durable slot is the name.
const sessionC = join(sessionsRoot, '2026-08-22_cccc.jsonl');
writeFileSync(sessionC, [
  JSON.stringify({ type: 'title', v: 1, title: 'Durable Title', updatedAt: 1787200000000, pad: '' }),
  JSON.stringify({ type: 'session', version: 3, id: 'sess-c', timestamp: '2026-08-22T00:00:00.000Z', cwd: cwdA }),
].join('\n') + '\n');

// OMP persists subagents beneath the owning transcript rather than as ordinary
// top-level sessions: `<parent-without-.jsonl>/<AgentId>.jsonl`, recursively.
const sessionAChildren = sessionA.slice(0, -'.jsonl'.length);
const childSession = join(sessionAChildren, 'ReviewChild.jsonl');
const grandchildSession = join(sessionAChildren, 'ReviewChild', 'NestedScout.jsonl');
mkdirSync(join(sessionAChildren, 'ReviewChild'), { recursive: true });
writeFileSync(childSession, [
  JSON.stringify({ type: 'session', version: 3, id: 'child-native', timestamp: '2026-08-20T00:03:00.000Z', cwd: cwdA }),
  JSON.stringify({ type: 'title_change', id: 'ct1', parentId: null, timestamp: '2026-08-20T00:03:01.000Z', title: 'Review child', source: 'auto' }),
].join('\n') + '\n');
writeFileSync(grandchildSession, [
  JSON.stringify({ type: 'session', version: 3, id: 'grandchild-native', timestamp: '2026-08-20T00:04:00.000Z', cwd: cwdA }),
].join('\n') + '\n');
symlinkSync(childSession, join(sessionAChildren, 'LinkedChild.jsonl'));

try {
  process.env.HOME = root;
  process.env.COSYNCING_OMP_SESSIONS_ROOT = sessionsRoot;
  process.env.COSYNCING_OMP_BRIDGE_AUTOINSTALL = '0';
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  delete process.env.PI_CONFIG_DIR;
  delete process.env.XDG_DATA_HOME;

  const { OmpAdapter, resetOmpRuntimeReadinessCache } = await import('../src/index.ts');
  const adapter = new OmpAdapter({ brokerUrl: 'http://127.0.0.1:7734' });
  check('omp adapter id/displayName', adapter.id === 'omp' && adapter.displayName === 'omp', `${adapter.id}/${adapter.displayName}`);

  const sessions = await adapter.discoverSessions();
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const idOf = (file: string) => Buffer.from(file, 'utf8').toString('base64url');
  const a = byId.get(idOf(sessionA));
  const b = byId.get(idOf(sessionB));
  const c = byId.get(idOf(sessionC));
  const child = byId.get(idOf(childSession));
  const grandchild = byId.get(idOf(grandchildSession));
  check('discovers ordinary sessions and the recursive OMP subagent tree once',
    sessions.length === 5 && !!a && !!b && !!c && !!child && !!grandchild,
    `${sessions.length}`);

  check('cwd comes from the session header AFTER the leading title slot', a?.cwd === cwdA, String(a?.cwd));
  check('session rows stamp tool=omp', a?.tool === 'omp' && b?.tool === 'omp', '');
  check('ordinary row publishes its native header id', a?.nativeId === 'sess-a', String(a?.nativeId));
  check('subagent row advertises observation only',
    child?.control?.drive.supported === false
      && child.control.terminalSync?.supported === false,
    JSON.stringify(child?.control));
  check('symlinked transcript is not followed or published',
    !sessions.some((session) => session.id === idOf(join(sessionAChildren, 'LinkedChild.jsonl'))));

  const childObserve = await adapter.attach(child!.id, 'observe');
  check('subagent attach preserves roster lineage',
    childObserve.info.origin === 'subagent'
      && childObserve.info.nativeId === 'child-native'
      && childObserve.info.parentThreadId === 'sess-a',
    JSON.stringify(childObserve.info));
  childObserve.close();
  let childDriveRefusal = '';
  try {
    await adapter.attach(child!.id, 'resume');
  } catch (error) {
    childDriveRefusal = String(error);
  }
  check('subagent resume is refused before a second writer starts',
    /owned by their parent.*only be observed/i.test(childDriveRefusal),
    childDriveRefusal);

  check('migrated Pi session_info naming still reads', b?.title === 'Legacy pi-shaped name', String(b?.title));


  process.env.PI_CODING_AGENT_DIR = join(root, 'shared-agent');
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;
  const blockedSessions = await adapter.discoverSessions();
  check('a live adapter suppresses discovery when shared Pi variables collide',
    blockedSessions.length === 0 && adapter.canCreateSession() === false,
    `${blockedSessions.length}/${adapter.canCreateSession()}`);
  const blockedTitle = await adapter.resolveSessionTitle(idOf(sessionB)).then(
    () => false, () => true,
  );
  check('a blocked store also refuses direct title resolution', blockedTitle);
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;

  // A readable store is deliberately not hidden when a future native protocol is present. Every
  // writer, bridge installer, and native rename surface must nevertheless fail closed.
  const futureBin = join(root, 'omp-future');
  const futureSpawnMarker = join(root, 'future-runtime-spawned');
  writeFileSync(futureBin, `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('17.4.3'); process.exit(0); }
writeFileSync(${JSON.stringify(futureSpawnMarker)}, 'spawned');
process.exit(73);
`);
  chmodSync(futureBin, 0o755);
  process.env.COSYNCING_OMP_BIN = futureBin;
  process.env.COSYNCING_OMP_BRIDGE_AUTOINSTALL = '1';
  resetOmpRuntimeReadinessCache();
  const futureAdapter = new OmpAdapter({ brokerUrl: 'http://127.0.0.1:7734' });
  const futureSessions = await futureAdapter.discoverSessions();
  const futureParent = futureSessions.find((session) => session.id === idOf(sessionA));
  check('future omp preserves store-backed Observe while advertising no mutable control',
    futureSessions.length === 5
      && futureParent?.control?.drive.supported === false
      && futureParent.control.terminalSync?.supported === false
      && futureAdapter.canCreateSession() === false
      && futureAdapter.canRenameNative() === false,
    JSON.stringify(futureParent?.control));
  const futureObserve = await futureAdapter.attach(idOf(sessionA), 'observe');
  const futureHistory = await futureObserve.getHistory();
  check('future omp Observe still replays the durable transcript',
    futureHistory.some((message) => message.type === 'user-message' && message.text === 'durable observe marker'),
    `${futureHistory.length}`);
  await futureObserve.close();
  let futureResumeRefusal = '';
  let futureRenameRefusal = '';
  try { await futureAdapter.attach(idOf(sessionA), 'resume'); } catch (error) { futureResumeRefusal = String(error); }
  try { await futureAdapter.renameSession(idOf(sessionA), 'must not persist'); } catch (error) { futureRenameRefusal = String(error); }
  let futureForkRefusal = '';
  try { await futureAdapter.forkSession(idOf(sessionA)); } catch (error) { futureForkRefusal = String(error); }
  check('future omp refuses Resume, native rename and fork before spawning the unverified runtime',
    /verified only for omp 17\.4\.2 and 19\.1\.0/.test(futureResumeRefusal)
      && /verified only for omp 17\.4\.2 and 19\.1\.0/.test(futureRenameRefusal)
      && /verified only for omp 17\.4\.2 and 19\.1\.0/.test(futureForkRefusal)
      && futureAdapter.canForkSession() === false
      && !existsSync(futureSpawnMarker),
    JSON.stringify({ futureResumeRefusal, futureRenameRefusal, futureForkRefusal }));
  check('future omp discovery does not auto-install its bridge',
    !existsSync(join(root, '.omp', 'agent', 'extensions', 'cosyncing-bridge', 'index.ts')));
  delete process.env.COSYNCING_OMP_BIN;
  process.env.COSYNCING_OMP_BRIDGE_AUTOINSTALL = '0';
  resetOmpRuntimeReadinessCache();

  // ── A file a newer omp wrote is not continued by an older configured omp ──
  // omp 19.1.0 stamps `runtime:{version}` on every entry it appends (captured; the shape below is
  // the captured one). omp 17.4.2 writes none and ignores 19.1.0's `activeLeafId`, so it could
  // continue such a file on the wrong branch: Resume and native rename refuse before any spawn.
  const { readOmpWriterStamps, ompNativeWriteRefusal } = await import('../src/index.ts');
  const sessionD = join(sessionsRoot, '2026-11-24_dddd.jsonl');
  writeFileSync(sessionD, [
    JSON.stringify({ type: 'title', v: 1, title: '', updatedAt: '2026-11-24T08:25:35.080Z', pad: '' }),
    JSON.stringify({ type: 'session', version: 3, id: 'sess-d', timestamp: '2026-11-24T08:25:35.080Z', cwd: cwdA }),
    JSON.stringify({ type: 'model_change', id: 'd1', parentId: null, timestamp: '2026-11-24T08:25:35.173Z', runtime: { version: '19.0.3' }, model: 'fixture-provider/fixture-model' }),
    JSON.stringify({ type: 'message', id: 'd2', parentId: 'd1', timestamp: '2026-11-24T08:25:35.367Z', runtime: { version: '19.1.0' }, message: { role: 'user', content: [{ type: 'text', text: 'written by omp 19.1.0' }] } }),
  ].join('\n') + '\n');
  const stampsD = await readOmpWriterStamps(sessionD);
  const stampsA = await readOmpWriterStamps(sessionA);
  check('the newest writer stamp is read from the file',
    stampsD.newest === '19.1.0' && !stampsD.incomparable && stampsA.newest === undefined && !stampsA.incomparable,
    JSON.stringify({ stampsD, stampsA }));
  check('only an omp older than the file\'s newest writer is refused',
    /written by omp 19\.1\.0, which is newer than the omp 17\.4\.2/.test(await ompNativeWriteRefusal(sessionD, '17.4.2') ?? '')
      && await ompNativeWriteRefusal(sessionD, '19.1.0') === undefined
      && await ompNativeWriteRefusal(sessionA, '17.4.2') === undefined
      && await ompNativeWriteRefusal(sessionD, undefined) === undefined);
  // The stamp rows below keep the captured entry shape and vary only the version, and a nested
  // `runtime` (as in a tool's `details`): no omp other than 17.4.2 and 19.1.0 was captured.
  const stampRow = (id: string, version: unknown, details?: unknown) => JSON.stringify({
    type: 'message', id, parentId: null, timestamp: '2026-11-24T08:25:35.367Z',
    ...(version === undefined ? {} : { runtime: { version } }),
    message: { role: 'toolResult', content: [{ type: 'text', text: 'ok' }], ...(details === undefined ? {} : { details }) },
  });
  const stampFile = (name: string, rows: string[]) => {
    const path = join(root, `${name}.jsonl`);
    writeFileSync(path, rows.join('\n') + '\n');
    return path;
  };
  const unknownFirst = stampFile('stamps-unknown-first', [stampRow('s1', 'dev-build'), stampRow('s2', '19.1.0')]);
  const unknownLast = stampFile('stamps-unknown-last', [stampRow('s1', '19.1.0'), stampRow('s2', 'dev-build')]);
  const unknownRefusals = [await ompNativeWriteRefusal(unknownFirst, '19.1.0'), await ompNativeWriteRefusal(unknownLast, '19.1.0')];
  check('a stamp that does not compare refuses whatever its place in the file',
    unknownRefusals.every((refusal) => /cannot compare with the omp 19\.1\.0/.test(refusal ?? '')),
    JSON.stringify(unknownRefusals));
  const nested = stampFile('stamps-nested', [
    stampRow('s1', '19.1.0', { runtime: { version: '22.11.0' } }),
    stampRow('s2', undefined, { runtime: { version: '22.11.0' } }),
  ]);
  const nestedStamps = await readOmpWriterStamps(nested);
  check('only an entry\'s own runtime stamp counts, not one nested in its details',
    nestedStamps.newest === '19.1.0' && !nestedStamps.incomparable && await ompNativeWriteRefusal(nested, '19.1.0') === undefined,
    JSON.stringify(nestedStamps));
  const growing = stampFile('stamps-growing', [stampRow('s1', '19.1.0')]);
  const before = await ompNativeWriteRefusal(growing, '19.1.0');
  appendFileSync(growing, stampRow('s2', '19.2.0') + '\n');
  const after = await ompNativeWriteRefusal(growing, '19.1.0');
  check('the cached reading follows the file when it changes',
    before === undefined && /written by omp 19\.2\.0/.test(after ?? ''), JSON.stringify({ before, after }));
  // A later omp may order the runtime keys differently, or write the stamp after a large payload:
  // the top-level stamp is still found, past a nested one, without parsing the entry whole.
  const reordered = stampFile('stamps-reordered', [JSON.stringify({
    type: 'message', id: 's1', parentId: null, timestamp: '2026-11-24T08:25:35.367Z',
    runtime: { build: 'later', version: '19.2.0' },
    message: { role: 'user', content: [{ type: 'text', text: 'ok' }] },
  })]);
  const payloadFirst = stampFile('stamps-payload-first', [JSON.stringify({
    type: 'message', id: 's1', parentId: null, timestamp: '2026-11-24T08:25:35.367Z',
    message: { role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(4 * 1024 * 1024) }], details: { runtime: { version: '22.11.0' } } },
    runtime: { version: '19.2.0' },
  })]);
  const walkStarted = performance.now();
  const reorderedStamps = await readOmpWriterStamps(reordered);
  const payloadFirstStamps = await readOmpWriterStamps(payloadFirst);
  const walkMs = performance.now() - walkStarted;
  check('the top-level stamp is found whatever its key order and after a 4 MiB payload',
    reorderedStamps.newest === '19.2.0' && payloadFirstStamps.newest === '19.2.0' && walkMs < 2_000,
    `${Math.round(walkMs)} ms ${JSON.stringify({ reorderedStamps, payloadFirstStamps })}`);
  const olderBin = join(root, 'omp-older');
  const olderSpawnMarker = join(root, 'older-runtime-spawned');
  writeFileSync(olderBin, `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('17.4.2'); process.exit(0); }
writeFileSync(${JSON.stringify(olderSpawnMarker)}, 'spawned');
process.exit(73);
`);
  chmodSync(olderBin, 0o755);
  process.env.COSYNCING_OMP_BIN = olderBin;
  resetOmpRuntimeReadinessCache();
  const olderAdapter = new OmpAdapter({ brokerUrl: 'http://127.0.0.1:7734' });
  const refusalOf = async (action: () => Promise<unknown>): Promise<{ name: string; message: string }> => {
    try {
      await action();
      return { name: 'none', message: '' };
    } catch (error) {
      return { name: (error as Error).name, message: String((error as Error).message) };
    }
  };
  const newerResume = await refusalOf(() => olderAdapter.attach(idOf(sessionD), 'resume'));
  const newerRename = await refusalOf(() => olderAdapter.renameSession(idOf(sessionD), 'must not persist'));
  check('omp 17.4.2 refuses Resume (unresumable) and native rename (alias fallback) of a file omp 19.1.0 wrote, before spawning',
    newerResume.name === 'NativeSessionUnresumableError'
      && /newer than the omp 17\.4\.2/.test(newerResume.message)
      && newerRename.name === 'NativeSessionRenameUnsupportedError'
      && !existsSync(olderSpawnMarker),
    JSON.stringify({ newerResume, newerRename }));
  const newerObserve = await olderAdapter.attach(idOf(sessionD), 'observe');
  const newerHistory = await newerObserve.getHistory();
  check('the refused file stays readable through Observe',
    newerHistory.some((message) => message.type === 'user-message' && message.text === 'written by omp 19.1.0'));
  await newerObserve.close();
  // Fork runs the configured omp as well. omp 17.4.2 has no RPC fork, so the refusal shows with omp
  // 19.1.0 configured and a later omp's entry (the captured shape, a version past the captured ones).
  const olderCanFork = olderAdapter.canForkSession();
  const nineteenBin = join(root, 'omp-nineteen');
  const nineteenSpawnMarker = join(root, 'nineteen-runtime-spawned');
  writeFileSync(nineteenBin, `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('omp/19.1.0'); process.exit(0); }
writeFileSync(${JSON.stringify(nineteenSpawnMarker)}, 'spawned');
process.exit(73);
`);
  chmodSync(nineteenBin, 0o755);
  process.env.COSYNCING_OMP_BIN = nineteenBin;
  resetOmpRuntimeReadinessCache();
  appendFileSync(sessionD, JSON.stringify({ type: 'message', id: 'd3', parentId: 'd2', timestamp: '2026-11-24T08:26:01.120Z', runtime: { version: '19.2.0' }, message: { role: 'user', content: [{ type: 'text', text: 'written by a later omp' }] } }) + '\n');
  const nineteenAdapter = new OmpAdapter({ brokerUrl: 'http://127.0.0.1:7734' });
  const newerFork = await refusalOf(() => nineteenAdapter.forkSession(idOf(sessionD)));
  check('omp 17.4.2 offers no fork, and omp 19.1.0 refuses to fork a file a later omp wrote (unresumable: the broker answers 409), before spawning',
    olderCanFork === false
      && nineteenAdapter.canForkSession() === true
      && newerFork.name === 'NativeSessionUnresumableError'
      && /written by omp 19\.2\.0, which is newer than the omp 19\.1\.0/.test(newerFork.message)
      && !existsSync(nineteenSpawnMarker),
    JSON.stringify(newerFork));
  rmSync(sessionD, { force: true });
  delete process.env.COSYNCING_OMP_BIN;
  resetOmpRuntimeReadinessCache();

  // ── omp 19.1.0's replay leaf (`resolveSessionLeafId`, session-entries.ts) ──
  // Source-modelled rows: no capture produced an `activeLeafId` row. An entry written off the
  // active branch records the leaf it interrupted, and a reload replays that leaf's branch.
  const { mapPiJsonlText } = await import('@cosyncing/pi-engine');
  const { OMP_DIALECT: ompDialect } = await import('../src/dialect.ts');
  const entry = (id: string, parentId: string | null, role: 'user' | 'assistant', text: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: 'message', id, parentId, timestamp: '2026-11-24T08:00:00.000Z', ...extra,
      message: role === 'user'
        ? { role, content: [{ type: 'text', text }] }
        : { role, content: [{ type: 'text', text }], stopReason: 'stop' },
    });
  const branched = (last: string) => [
    JSON.stringify({ type: 'session', version: 3, id: 'sess-leaf', timestamp: '2026-11-24T08:00:00.000Z', cwd: cwdA }),
    entry('u1', null, 'user', 'root prompt'),
    entry('a1', 'u1', 'assistant', 'root answer'),
    entry('u2', 'a1', 'user', 'branch A prompt'),
    entry('a2', 'u2', 'assistant', 'branch A answer'),
    entry('u3', 'a1', 'user', 'branch B prompt'),
    entry('a3', 'u3', 'assistant', 'branch B answer'),
    last,
  ].join('\n') + '\n';
  const userTexts = (raw: string) => mapPiJsonlText(raw, 0, ompDialect)
    .filter((message) => message.type === 'user-message').map((message) => (message as { text?: string }).text);
  const offBranch = userTexts(branched(entry('late', 'a2', 'assistant', 'late branch A result', { activeLeafId: 'a3' })));
  check('an off-branch entry with activeLeafId replays the branch it interrupted',
    JSON.stringify(offBranch) === JSON.stringify(['root prompt', 'branch B prompt']), JSON.stringify(offBranch));
  const lastIsLeaf = userTexts(branched(entry('late', 'a2', 'assistant', 'late branch A result')));
  check('without activeLeafId the last entry is the leaf, as for Pi',
    JSON.stringify(lastIsLeaf) === JSON.stringify(['root prompt', 'branch A prompt']), JSON.stringify(lastIsLeaf));
  const cleared = userTexts(branched(entry('late', 'a2', 'assistant', 'late branch A result', { activeLeafId: null })));
  check('a null activeLeafId replays a cleared leaf', cleared.length === 0, JSON.stringify(cleared));
  const missing = userTexts(branched(entry('late', 'a2', 'assistant', 'late branch A result', { activeLeafId: 'gone' })));
  check('a recorded leaf that no longer exists falls back to the newest self-selected entry',
    JSON.stringify(missing) === JSON.stringify(['root prompt', 'branch B prompt']), JSON.stringify(missing));

  // ── omp 19.1.0 form dialogs, read and validated the way omp reads and validates them ──
  const { parsePiFormDialog, piFormAnswer, piFormQuestions } = await import('../../../pi-engine/src/form-dialog.ts');
  const controls = parsePiFormDialog(`<form>
  <label>Region <select name="region"><option value="eu">Europe</option><option value="us" disabled>US</option><option value="ap">Asia</option></select></label>
  <label>Tags <select name="tags" multiple><option value="a" selected>Alpha</option><option value="b">Beta</option></select></label>
  <label>Replicas <input type="number" name="replicas" min="1" max="5" step="1" value="2"></label>
  <label>Load <input type="range" name="load" min="0" max="100"></label>
  <label>Notes <textarea name="notes" maxlength="10">
default</textarea></label>
</form>`);
  check('select, multi-select, number, range and textarea become card questions',
    JSON.stringify(controls && piFormQuestions(controls)) === JSON.stringify([
      { question: 'Region', options: [{ label: 'Europe' }, { label: 'Asia' }], freeText: false },
      { question: 'Tags', options: [{ label: 'Alpha' }, { label: 'Beta' }], multiple: true, freeText: false },
      { question: 'Replicas', options: [], kind: 'number', min: 1, max: 5, step: 1 },
      { question: 'Load', options: [], kind: 'number', min: 0, max: 100 },
      { question: 'Notes', options: [], kind: 'text' },
    ]),
    JSON.stringify(controls && piFormQuestions(controls)));
  const controlDefaults = controls && piFormAnswer(controls, undefined);
  check('defaults: a single select takes its first enabled option, a textarea its content',
    JSON.stringify(controlDefaults) === JSON.stringify({ ok: true, data: { region: 'eu', tags: ['a'], replicas: 2, notes: 'default' } }),
    JSON.stringify(controlDefaults));
  const controlAnswer = controls && piFormAnswer(controls, [['Asia'], ['Beta'], ['4'], ['50'], ['hi']]);
  check('answers become option values, an array for the multi-select, numbers for number and range',
    JSON.stringify(controlAnswer) === JSON.stringify({ ok: true, data: { region: 'ap', tags: ['b'], replicas: 4, load: 50, notes: 'hi' } }),
    JSON.stringify(controlAnswer));
  const outOfRange = controls && piFormAnswer(controls, [['Asia'], ['Beta'], ['9'], ['50'], ['hi']]);
  const tooLong = controls && piFormAnswer(controls, [['Asia'], ['Beta'], ['4'], ['50'], ['far too long here']]);
  check('a number past max and a textarea past maxlength are refused before sending',
    outOfRange?.ok === false && /Replicas: Must be at most 5/.test(outOfRange.problem)
      && tooLong?.ok === false && /Notes: At most 10 characters/.test(tooLong.problem),
    JSON.stringify({ outOfRange, tooLong }));

  // omp decides array or string over the options in the HTML, disabled and repeated ones counted.
  const groups = parsePiFormDialog(`<form>
  <fieldset><legend>Extras</legend>
    <label><input type="checkbox" name="extras" value="cheese"> Cheese</label>
    <label><input type="checkbox" name="extras" value="ham" disabled> Ham</label>
  </fieldset>
  <label><input type="checkbox" name="agree" value="yes"> I agree</label>
  <fieldset><legend>Size</legend>
    <label><input type="checkbox" name="size" value="m"> Medium</label>
    <label><input type="checkbox" name="size" value="m" checked> Medium again</label>
  </fieldset>
</form>`);
  const groupAnswer = groups && piFormAnswer(groups, [['Cheese'], ['I agree'], ['Medium']]);
  check('a two-option checkbox group with one disabled option still answers an array; a lone checkbox a string',
    JSON.stringify(groups?.fields.map((field) => [field.name, field.options.length, field.arrayAnswer])) === JSON.stringify([['extras', 1, true], ['agree', 1, false], ['size', 1, true]])
      && JSON.stringify(groupAnswer) === JSON.stringify({ ok: true, data: { extras: ['cheese'], agree: 'yes', size: ['m'] } }),
    JSON.stringify({ fields: groups?.fields, groupAnswer }));
  const groupDefaults = groups && piFormAnswer(groups, undefined);
  check('a repeated value that is checked is checked by default',
    groupDefaults?.ok === true && JSON.stringify(groupDefaults.data.size) === JSON.stringify(['m']),
    JSON.stringify(groupDefaults));

  // omp's field rules (`fieldError`): an answer it would refuse never leaves the card.
  const rules = parsePiFormDialog(`<form>
  <label>Name <input name="name" required minlength="2"></label>
  <label>Code <input name="code" pattern="[A-Z]{3}-\\d{2}"></label>
  <label>Mail <input type="email" name="mail"></label>
  <label>Site <input type="url" name="site"></label>
  <label>Size <select name="size" required><option value="" disabled selected>Pick one</option><option value="s">Small</option></select></label>
</form>`);
  const rulesProblem = (answers: string[][] | undefined) => {
    const answer = rules && piFormAnswer(rules, answers);
    return answer && !answer.ok ? answer.problem : answer ? 'ok' : 'unparsed';
  };
  const valid = rules && piFormAnswer(rules, [['Al'], ['ABC-12'], ['a@b'], ['https://x.test'], ['Small']]);
  check('a valid answer passes every rule',
    JSON.stringify(valid) === JSON.stringify({ ok: true, data: { name: 'Al', code: 'ABC-12', mail: 'a@b', site: 'https://x.test', size: 's' } }),
    JSON.stringify(valid));
  const refusals = [
    rulesProblem(undefined),
    rulesProblem([['A'], ['ABC-12'], ['a@b'], ['https://x.test'], ['Small']]),
    rulesProblem([['Al'], ['abc'], ['a@b'], ['https://x.test'], ['Small']]),
    rulesProblem([['Al'], ['ABC-12'], ['nope'], ['https://x.test'], ['Small']]),
    rulesProblem([['Al'], ['ABC-12'], ['a@b'], ['x'], ['Small']]),
    rulesProblem([['Al'], ['ABC-12'], ['a@b'], ['https://x.test'], ['Huge']]),
  ];
  check('required, minlength, pattern, email, url and an unknown option are each refused',
    /^Name: Required$/.test(refusals[0]!)
      && /^Name: Needs at least 2 characters$/.test(refusals[1]!)
      && /^Code: Must match /.test(refusals[2]!)
      && /^Mail: Enter an email address$/.test(refusals[3]!)
      && /^Site: Enter a full URL$/.test(refusals[4]!)
      && /^Size: Choose one of its options$/.test(refusals[5]!)
      && !refusals.some((problem) => problem.includes('Huge')),
    JSON.stringify(refusals));

  // Forms the card cannot carry exactly are not offered; an invalid pattern is ignored, as omp does.
  const refused = {
    file: parsePiFormDialog('<form><label>Doc <input type="file" name="doc"></label></form>'),
    twoTexts: parsePiFormDialog('<form><input name="a"><input name="a"></form>'),
    radioAndCheckbox: parsePiFormDialog('<form><input type="radio" name="a" value="1"><input type="checkbox" name="a" value="2"></form>'),
    requiredNothingToPick: parsePiFormDialog('<form><input type="radio" name="a" value="1" required disabled></form>'),
    nothing: parsePiFormDialog('<form><p>Just text</p></form>'),
  };
  const invalidPattern = parsePiFormDialog('<form><label>A <input name="a" pattern="["></label></form>');
  check('file inputs, repeated names, unanswerable required groups and empty forms are refused',
    Object.values(refused).every((form) => form === undefined)
      && invalidPattern?.fields.length === 1 && invalidPattern.fields[0]!.pattern === undefined,
    JSON.stringify({ refused, invalidPattern }));

  // A pattern never keeps a form from being offered. It is checked here only where a worst-case
  // bound on the matcher's work for the answer is small; otherwise omp alone checks it.
  const patternForm = (pattern: string) => parsePiFormDialog(`<form><label>Value <input name="v" pattern="${pattern}"></label></form>`);
  const kept = ['[a-z]+(-[a-z]+)*', '\\d+(\\.\\d+)*', '(?:[a-z]|-)*', '(\\w+\\s?)+', '\\w*\\w*\\w*\\w*x', '[\\s\\S]*']
    .map((pattern) => ({ pattern, form: patternForm(pattern) }));
  check('forms with linear, polynomial and exponential patterns are all offered with the pattern kept',
    kept.every(({ pattern, form }) => form?.fields.length === 1 && form.fields[0]!.pattern === pattern),
    JSON.stringify(kept.map(({ pattern, form }) => [pattern, form?.fields[0]?.pattern])));
  const alternation = patternForm('(?:[a-z]|-)*');
  const cheapOk = alternation && piFormAnswer(alternation, [['a-b']]);
  const cheapRefused = alternation && piFormAnswer(alternation, [['a_b']]);
  check('a pattern that is cheap to run on a short answer is still checked before sending',
    cheapOk?.ok === true && cheapRefused?.ok === false && /^Value: Must match /.test(cheapRefused.problem),
    JSON.stringify({ cheapOk, cheapRefused }));
  const slug = patternForm('[a-z]+(-[a-z]+)*');
  // `My_Slug` does not match: only a skipped check lets it through, so this proves omp is left to check it.
  const slugAnswer = slug && piFormAnswer(slug, [['My_Slug']]);
  check('a linear pattern the bound counts as costly is left to omp, and the answer is sent',
    JSON.stringify(slugAnswer) === JSON.stringify({ ok: true, data: { v: 'My_Slug' } }), JSON.stringify(slugAnswer));
  const patternStarted = performance.now();
  const polynomial = patternForm('\\w*\\w*\\w*\\w*x');
  const polynomialAnswer = polynomial && piFormAnswer(polynomial, [['a'.repeat(1024)]]);
  const anything = patternForm('[\\s\\S]*');
  const longAnswer = anything && piFormAnswer(anything, [['b'.repeat(5000)]]);
  const patternMs = performance.now() - patternStarted;
  check('a polynomial pattern with a 1024-character answer returns at once, and a long answer is no longer refused',
    patternMs < 1_000 && polynomialAnswer?.ok === true && longAnswer?.ok === true,
    `${Math.round(patternMs)} ms ${JSON.stringify({ polynomial: polynomialAnswer?.ok, long: longAnswer?.ok })}`);
  // Compiling runs on the broker too: a pattern past the length budget is neither compiled nor
  // checked here. These 8,000 set-operation classes would take seconds to compile.
  const compileStarted = performance.now();
  const longSetForm = patternForm('[\\p{L}--\\p{Lu}]'.repeat(8000));
  const longSetAnswer = longSetForm && piFormAnswer(longSetForm, [['NOT LOWER 1']]);
  const compileMs = performance.now() - compileStarted;
  check('a pattern past the compile budget keeps its form, is never compiled, and is left to omp',
    compileMs < 1_000 && longSetForm?.fields.length === 1 && longSetForm.fields[0]!.pattern === undefined
      && longSetAnswer?.ok === true,
    `${Math.round(compileMs)} ms ${JSON.stringify(longSetAnswer)}`);
  const budgetForm = parsePiFormDialog(`<form>${[1, 2, 3].map((n) => `<label>P${n} <input name="p${n}" pattern="${'a'.repeat(900)}"></label>`).join('')}</form>`);
  check('one form compiles at most its budget of pattern text, and the rest is left to omp',
    JSON.stringify(budgetForm?.fields.map((field) => field.pattern !== undefined)) === JSON.stringify([true, true, false]),
    JSON.stringify(budgetForm?.fields.map((field) => field.pattern?.length)));
  // Groups nested past the bound's depth limit count as unbounded: the check is left to omp rather
  // than recursing, so even an answer that does not match is sent.
  const deep = patternForm(`${'('.repeat(300)}a${')'.repeat(300)}`);
  const deepAnswer = deep && piFormAnswer(deep, [['b']]);
  check('a pattern nested past the depth limit is kept and left to omp',
    deep?.fields[0]?.pattern?.length === 601 && deepAnswer?.ok === true, JSON.stringify(deepAnswer));
  // A refusal quotes at most 80 characters of the pattern.
  const longQuoted = patternForm('a'.repeat(200));
  const longQuotedAnswer = longQuoted && piFormAnswer(longQuoted, [['b']]);
  check('a refusal quotes only the start of a long pattern',
    longQuotedAnswer?.ok === false && longQuotedAnswer.problem === `Value: Must match ${'a'.repeat(80)}…`,
    JSON.stringify(longQuotedAnswer));

  // The parser runs on the broker's event loop: crafted HTML up to the size cap stays linear.
  const megabyte = 1024 * 1024 - 64;
  const crafted = [
    '<a '.repeat(Math.floor(megabyte / 3)),
    '<!--'.repeat(Math.floor(megabyte / 4)),
    '<a b="'.repeat(Math.floor(megabyte / 6)),
    '<'.repeat(megabyte),
    '<textarea name="t">' + '</textare'.repeat(Math.floor(megabyte / 10)),
    // 19,000 checkboxes (about 1,021,560 characters, under the cap) carrying 5000 distinct values.
    Array.from({ length: 19_000 }, (_, index) => `<input type="checkbox" name="c" value="v${index % 5000}" checked>`).join(''),
  ];
  const parseStarted = performance.now();
  const craftedResults = crafted.map((html) => parsePiFormDialog(html));
  const parseMs = performance.now() - parseStarted;
  check('crafted near-cap HTML parses in bounded time',
    parseMs < 2_000 && craftedResults.slice(0, 4).every((form) => form === undefined)
      && craftedResults[5]?.fields[0]?.options.length === 5000,
    `${Math.round(parseMs)} ms`);

  // ── Path rules (pure dialect resolution; no adapter needed) ──
  const { inspectOmpPathCollision, OMP_DIALECT } = await import('../src/dialect.ts');
  const { PI_DIALECT, resolvePiDialectRuntime } = await import('@cosyncing/pi-engine');
  const stub = {
    hooks: {
      readiness: () => ({ ready: false, message: '', detailCode: '' }),
      diagnose: async () => { throw new Error('unused'); },
    },
    bridgeAsset: { source: '', sha256: '' },
  };
  const resolveOmp = (env: NodeJS.ProcessEnv) => resolvePiDialectRuntime(OMP_DIALECT, env, stub);

  const plain = resolveOmp({ HOME: root });
  check('default agent dir is ~/.omp/agent', plain.agentDir === join(root, '.omp', 'agent'), plain.agentDir);
  check('default sessions root is <agentDir>/sessions', plain.sessionsRoot === join(root, '.omp', 'agent', 'sessions'), plain.sessionsRoot);
  check('bridge installs under <agentDir>/extensions', plain.bridgeInstallPath === join(root, '.omp', 'agent', 'extensions', 'cosyncing-bridge', 'index.ts'), plain.bridgeInstallPath);

  const configDir = resolveOmp({ HOME: root, PI_CONFIG_DIR: '.omp-custom' });
  check('PI_CONFIG_DIR renames the config root', configDir.agentDir === join(root, '.omp-custom', 'agent'), configDir.agentDir);

  const xdg = join(root, 'xdg');
  const xdgOmp = join(xdg, 'omp');
  const withoutXdgDir = resolveOmp({ HOME: root, XDG_DATA_HOME: xdg });
  check('XDG redirect requires $XDG_DATA_HOME/omp to exist', withoutXdgDir.sessionsRoot === join(root, '.omp', 'agent', 'sessions'), withoutXdgDir.sessionsRoot);
  mkdirSync(xdgOmp, { recursive: true });
  const withXdg = resolveOmp({ HOME: root, XDG_DATA_HOME: xdg });
  check('migrated installs redirect sessions to $XDG_DATA_HOME/omp/sessions', withXdg.sessionsRoot === join(xdgOmp, 'sessions'), withXdg.sessionsRoot);
  check('XDG never redirects the bridge install path', withXdg.bridgeInstallPath === join(root, '.omp', 'agent', 'extensions', 'cosyncing-bridge', 'index.ts'), withXdg.bridgeInstallPath);

  const agentOverride = resolveOmp({ HOME: root, XDG_DATA_HOME: xdg, PI_CODING_AGENT_DIR: join(root, 'shared-agent') });
  check('PI_CODING_AGENT_DIR overrides the XDG redirect', agentOverride.sessionsRoot === join(root, 'shared-agent', 'sessions'), agentOverride.sessionsRoot);

  const sessionDirOverride = resolveOmp({ HOME: root, XDG_DATA_HOME: xdg, PI_CODING_AGENT_SESSION_DIR: join(root, 'explicit-sessions') });
  check('PI_CODING_AGENT_SESSION_DIR wins outright', sessionDirOverride.sessionsRoot === join(root, 'explicit-sessions'), sessionDirOverride.sessionsRoot);

  const sharedAgent = join(root, 'shared-agent');
  const sharedSessions = join(root, 'shared-sessions');
  const sharedEnv = {
    HOME: root,
    PI_CODING_AGENT_DIR: sharedAgent,
    PI_CODING_AGENT_SESSION_DIR: sharedSessions,
  };
  const piShared = resolvePiDialectRuntime(PI_DIALECT, sharedEnv, stub);
  const ompShared = resolveOmp(sharedEnv);
  const collision = inspectOmpPathCollision(sharedEnv);
  check('dual-adapter shared overrides resolve to the same bridge and session paths',
    piShared.bridgeInstallPath === ompShared.bridgeInstallPath
      && piShared.sessionsRoot === ompShared.sessionsRoot
      && collision?.agentDirCollision === true
      && collision.sessionsRootCollision === true,
    JSON.stringify(collision));

  const separatedEnv = {
    ...sharedEnv,
    COSYNCING_OMP_AGENT_DIR: join(root, 'omp-agent'),
    COSYNCING_OMP_SESSIONS_ROOT: join(root, 'omp-sessions'),
  };
  check('dialect-specific omp overrides remove the dual-adapter collision',
    inspectOmpPathCollision(separatedEnv) === undefined);

  const canonicalTarget = join(root, 'canonical-target');
  const piAlias = join(root, 'pi-alias');
  const ompAlias = join(root, 'omp-alias');
  mkdirSync(canonicalTarget, { recursive: true });
  symlinkSync(canonicalTarget, piAlias, 'dir');
  symlinkSync(canonicalTarget, ompAlias, 'dir');
  const aliasCollision = inspectOmpPathCollision({
    HOME: root,
    COSYNCING_PI_AGENT_DIR: join(piAlias, 'not-created-agent'),
    COSYNCING_OMP_AGENT_DIR: join(ompAlias, 'not-created-agent'),
  });
  check('symlink aliases collide through the nearest existing parent before targets are created',
    aliasCollision?.agentDirCollision === true && aliasCollision.sessionsRootCollision === true,
    JSON.stringify(aliasCollision));

  const caseFoldParent = join(root, 'case-fold-parent');
  mkdirSync(caseFoldParent, { recursive: true });
  const caseVariantEnv = {
    HOME: root,
    COSYNCING_PI_AGENT_DIR: join(root, 'case-pi-agent'),
    COSYNCING_OMP_AGENT_DIR: join(root, 'case-omp-agent'),
    COSYNCING_PI_SESSIONS_ROOT: join(caseFoldParent, 'CosySessions'),
    COSYNCING_OMP_SESSIONS_ROOT: join(caseFoldParent, 'cosysessions'),
  };
  const darwinCaseCollision = inspectOmpPathCollision(caseVariantEnv, 'darwin');
  const windowsCaseCollision = inspectOmpPathCollision(caseVariantEnv, 'win32');
  check('Darwin and Windows fold absent suffixes beneath the same canonical parent',
    darwinCaseCollision?.agentDirCollision === false
      && darwinCaseCollision.sessionsRootCollision === true
      && windowsCaseCollision?.agentDirCollision === false
      && windowsCaseCollision.sessionsRootCollision === true,
    `darwin=${JSON.stringify(darwinCaseCollision)} windows=${JSON.stringify(windowsCaseCollision)}`);
  check('Linux keeps the same absent suffixes case-sensitive',
    inspectOmpPathCollision(caseVariantEnv, 'linux') === undefined);
} finally {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
