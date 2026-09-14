#!/usr/bin/env bun
/**
 * omp discovery deltas: leading `title` slot before the session header, combined
 * `provider/modelId` model_change, last-write-wins `title_change`, session_info still readable,
 * and the XDG/PI_CONFIG_DIR/PI_CODING_AGENT_DIR path rules. Fixture JSONL only — no real omp.
 */
export {};
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

// Session B: pi-shaped session_info naming still reads (migrated/hand-built files).
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
  check('omp omits fork/clone hooks', typeof (adapter as any).forkSession === 'undefined' && typeof (adapter as any).cloneSession === 'undefined');

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
  check('title_change is last-write-wins', a?.title === 'Renamed session', String(a?.title));
  check(
    'combined model_change splits provider/modelId on the first slash',
    a?.currentModel?.providerID === 'openai' && a?.currentModel?.modelID === 'gpt-5.2',
    JSON.stringify(a?.currentModel),
  );
  check('model label comes from the split modelId', a?.model === 'gpt-5.2', String(a?.model));
  check('session rows stamp tool=omp', a?.tool === 'omp' && b?.tool === 'omp', '');
  check('ordinary row publishes its native header id', a?.nativeId === 'sess-a', String(a?.nativeId));
  check('subagent row links to the parent native header id',
    child?.origin === 'subagent'
      && child.nativeId === 'child-native'
      && child.parentThreadId === 'sess-a',
    JSON.stringify(child));
  check('nested subagent row links to its immediate parent native header id',
    grandchild?.origin === 'subagent'
      && grandchild.nativeId === 'grandchild-native'
      && grandchild.parentThreadId === 'child-native',
    JSON.stringify(grandchild));
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

  check('session_info naming still reads', b?.title === 'Legacy pi-shaped name', String(b?.title));
  check('non-empty leading title slot names the session', c?.title === 'Durable Title', String(c?.title));

  process.env.PI_CODING_AGENT_DIR = join(root, 'shared-agent');
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;
  const blockedSessions = await adapter.discoverSessions();
  check('a live adapter suppresses discovery when shared Pi variables collide',
    blockedSessions.length === 0 && adapter.canCreateSession() === false,
    `${blockedSessions.length}/${adapter.canCreateSession()}`);
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
  check('future omp refuses Resume and native rename before spawning the unverified runtime',
    /verified only for 17\.4\.2/.test(futureResumeRefusal)
      && /verified only for 17\.4\.2/.test(futureRenameRefusal)
      && !existsSync(futureSpawnMarker),
    JSON.stringify({ futureResumeRefusal, futureRenameRefusal }));
  check('future omp discovery does not auto-install its bridge',
    !existsSync(join(root, '.omp', 'agent', 'extensions', 'cosyncing-bridge', 'index.ts')));
  delete process.env.COSYNCING_OMP_BIN;
  process.env.COSYNCING_OMP_BRIDGE_AUTOINSTALL = '0';
  resetOmpRuntimeReadinessCache();

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
