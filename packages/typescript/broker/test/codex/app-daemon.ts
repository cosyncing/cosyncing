/** Shared-daemon app hosting and transport-loss regression tests, with no native runtime. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry, type AgentMessage } from '../../../adapter-api/src/index.ts';
import { Hub } from '../../src/sessions/hub.ts';
import { FakeCodexDaemon } from '../helpers/fake-codex-daemon.ts';

export async function testCodexAppDaemon(): Promise<void> {
  if (!import.meta.main) {
    // The parent suite already imported a module-scoped discovery root. Run this home in a fresh process.
    const child = Bun.spawn([process.execPath, import.meta.filename], { stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    assert.equal(code, 0, stdout + stderr);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-app-daemon-'));
  const home = join(root, 'codex');
  const cwd = join(root, 'project');
  mkdirSync(home); mkdirSync(cwd);
  const socket = join(root, 'daemon.sock');
  const alias = join(root, 'control.sock');
  symlinkSync(socket,alias);
  const sessions = join(home, 'sessions', '2026', '10', '10');
  mkdirSync(sessions, { recursive: true });
  let threadId = '';
  let rollout = '';
  let nextThread = 0;
  const marker = join(root, 'stdio-started');
  const bin = join(root, 'codex-bin');
  const keys = ['CODEX_HOME', 'COSYNCING_CODEX_BIN', 'COSYNCING_CODEX_SYNC_SERVER', 'COSYNCING_CODEX_APP_SERVER_SOCK'];
  const old = keys.map((key) => process.env[key]);
  Object.assign(process.env, { CODEX_HOME: home, COSYNCING_CODEX_BIN: bin, COSYNCING_CODEX_SYNC_SERVER: '1', COSYNCING_CODEX_APP_SERVER_SOCK: alias });
  // The discovery root is module-scoped. Import this instance only after its isolated home exists.
  const { CodexAdapter, queryCodexLoadedThreadActivitiesStrict } = await import(
    '../../../adapters/codex/src/implementation.ts'
  );
  const { createCodexRuntimeUpdateProvider } = await import('../../src/updates/runtime-update-providers.ts');
  // Private fallback implements the same RPC surface, and records any process spawn.
  writeFileSync(bin, `#!/usr/bin/env bun
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(marker)}, 'spawned');
let buffer = '';
for await (const chunk of Bun.stdin.stream()) {
 buffer += new TextDecoder().decode(chunk);
 let end;
 while ((end = buffer.indexOf('\\n')) >= 0) {
  const line = buffer.slice(0,end); buffer = buffer.slice(end+1);
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (request.id == null) continue;
  const params = request.params ?? {};
  let result = {};
  if (request.method === 'thread/loaded/list') result = {data: []};
  if (request.method === 'thread/start') {
   const threadId = 'private-' + require('node:crypto').randomUUID();
   const rollout = require('node:path').join(${JSON.stringify(sessions)}, 'rollout-' + threadId + '.jsonl');
   fs.writeFileSync(rollout, JSON.stringify({type:'session_meta',payload:{id:threadId,cwd:params.cwd,model_provider:params.modelProvider ?? 'openai'}})+'\\n', {flag:'wx'});
   result = {thread:{id:threadId,path:rollout,cwd:params.cwd},model:params.model,modelProvider:params.modelProvider};
  }
  if (request.method === 'thread/resume') result = {thread:{id:params.threadId,status:{type:'idle'},turns:[]}};
  console.log(JSON.stringify({id:request.id,result}));
 }
}
`); chmodSync(bin, 0o755);
  const daemon = new FakeCodexDaemon(socket, {
    loadedThreadIds: [],
    startResult: (params) => {
      threadId = `app-thread-${++nextThread}`;
      rollout = join(sessions, `rollout-${threadId}.jsonl`);
      writeFileSync(rollout, JSON.stringify({type:'session_meta',payload:{id:threadId,cwd:params.cwd,model_provider:params.modelProvider ?? 'openai'}})+'\n', {flag:'wx'});
      daemon.configure({loadedThreadIds: [threadId]});
      return {thread:{id:threadId,path:rollout,cwd:params.cwd},model:params.model,modelProvider:params.modelProvider};
    },
    resumeResult: () => ({thread:{id:threadId,path:rollout,status:{type:'idle'},turns:[]}}),
    readResult: () => ({thread:{id:threadId,status:{type:'idle'},turns:[]}}),
  });
  const diagnostics: any[] = [];
  const emptyPresence = () => ({attributed:new Set<string>(),unattributed:[],privateThreadIds:new Set<string>(),privateUnattributed:[],unknownUnattributed:[],unknownThreadIds:new Set<string>(),candidates:[],socketDiagAvailable:true,processScanAvailable:true});
  const adapter = new CodexAdapter({ scanCodexTuiPresence: async () => emptyPresence(), reportAttachDiagnostic: (event: unknown) => diagnostics.push(event) });
  const registry = new AgentRegistry(); registry.register(adapter);
  const hub = new Hub(registry, 20000);
  try {
    await daemon.start();
    writeFileSync(join(home, 'config.toml'), '[model_providers.fixture]\nname="Fixture"\nbase_url="http://fixture.invalid/v1"\nwire_api="responses"\n');
    writeFileSync(join(home, 'test.config.toml'), 'model_provider="fixture"\nmodel="selected"\n');
    const created: {id:string; nativeId:string; path:string; content:string}[] = [];
    for (const model of [undefined, {providerID:'fixture',modelID:'selected',variant:'test',reasoningEffort:'high'}, {providerID:'fixture',modelID:'no-profile-match',reasoningEffort:'high'}]) {
      const info = await adapter.createSession({directory:cwd,model});
      created.push({id:info.id,nativeId:threadId,path:rollout,content:readFileSync(rollout,'utf8')});
      assert.equal(existsSync(marker), false, 'managed app creation must not spawn stdio');
      assert.equal(info.cwd,cwd);
      assert.equal(info.control?.terminalSync.action,'join');
      assert.equal(info.control?.terminalSync.syncAvailable,true);
      const request = daemon.requests.filter((r)=>r.method==='thread/start').at(-1)!;
      assert.equal(request.params.cwd,cwd,'thread/start carries the project cwd');
      assert.equal(request.params.historyMode,'legacy');
      if (model) {
        assert.equal(request.params.modelProvider,'fixture'); assert.equal(request.params.model,model.modelID);
        assert.equal(request.params.allowProviderModelFallback,false);
        assert(daemon.requests.some((r)=>r.method==='thread/settings/update' && r.params.effort==='high'));
        if (model.variant) assert.match(info.terminalSyncHint!.command, /-p test resume --remote .* -m selected /);
        else assert.match(info.terminalSyncHint!.command, /-c 'model_provider="fixture"' resume --remote .* -m no-profile-match /);
        assert(info.terminalSyncHint!.command.endsWith(` ${threadId}`));
      }
    }
    assert.equal(new Set(created.map((info)=>info.id)).size,created.length,'each create returns a distinct stored session');
    assert.equal(new Set(created.map((info)=>info.nativeId)).size,created.length,'each create allocates a distinct native thread');
    for (const info of created) assert.equal(readFileSync(info.path,'utf8'),info.content,'later creates preserve historical rollouts');
    const id = Buffer.from(rollout).toString('base64url');
    // Cold Drive must load the same thread on the daemon.
    daemon.configure({loadedThreadIds:[]});
    let conn = await adapter.attach(id,'resume');
    assert.equal(conn.info.attachMode,'live');
    assert.equal(existsSync(marker),false,'cold Drive must not spawn stdio');
    assert(diagnostics.some((e)=>e.event==='transport-selected' && e.transport==='daemon-proxy'));
    await conn.close();
    // Explicit Drive joins a loaded thread through the Hub rather than refusing ownership.
    daemon.configure({loadedThreadIds:[threadId]});
    const managed = await hub.ensure('codex',id,'resume','takeover');
    assert.equal(await hub.ensure('codex',id,'live'),managed,'explicit Drive joins the existing broker owner');
    assert.equal(await hub.ensure('codex',id),managed,'mode-less attach joins the existing broker owner');
    conn = managed.conn;
    const messages: AgentMessage[] = [];
    conn.subscribe((message)=>messages.push(message));
    await conn.sendPrompt({text:'first app turn'});
    assert.equal(conn.info.status,'working');
    const before = daemon.calls.filter((method)=>method==='turn/interrupt').length;
    const joined = await adapter.attach(id,'live');
    await joined.close();
    assert.equal(daemon.calls.filter((method)=>method==='turn/interrupt').length,before,'terminal join does not interrupt');
    // App-hosted threads count as restart blockers, including when detached.
    daemon.configure({readResult:()=>({thread:{status:{type:'active',activeFlags:[]}}})});
    const provider = createCodexRuntimeUpdateProvider({
      policy:()=> 'when-detached', readVersion:async()=>({status:'running',cliVersion:'1.0.0',appServerVersion:'1.0.0',backend:'daemon'}),
      readConfigFreshness:async()=>({changed:true,detail:'fixture config',fingerprint:'fixture'}),
      loadedThreads:queryCodexLoadedThreadActivitiesStrict, restart:async()=>{},
    });
    const update = await provider.inspect();
    assert.equal(update.blockerComposition?.working,1,'app daemon turns block restart');
    assert.equal(update.autoRestartReady,false);
    // A lost transport accounts for the exact open run and clears terminal evidence promptly.
    conn.info.control!.terminalSync.active = true;
    conn.info.control!.terminalSync.presence = 'shared';
    await hub.refreshExternalSession(structuredClone(conn.info));
    await daemon.stop();
    await new Promise((resolve)=>setTimeout(resolve,30));
    assert.equal(conn.info.status,'idle','restart leaves Working');
    const interrupted = messages.filter((m)=>m.type==='run-summary' && m.status==='cancelled');
    assert.equal(interrupted.length,1,'restart closes the open run exactly once');
    assert(messages.some((m)=>m.type==='notice' && m.message==='Codex restarted; this turn was interrupted'));
    assert.equal(conn.info.control?.terminalSync.active,false);
    assert.equal(conn.info.control?.terminalSync.presence,'absent','restart clears stale shared presence');
    assert.equal(conn.info.control?.terminalSync.syncAvailable,false);
    assert.equal(managed.status,'idle','Hub agrees with interrupted owner');
    const rows = await (adapter as any).sessionInfosForLiveIds(new Set(), emptyPresence(), new Map());
    const row = rows.find((row: any) => row.id === id);
    assert(row, 'the roster still contains the interrupted app session');
    assert.equal(row.attachMode, 'live', 'a roster refresh preserves the reconnectable app owner');
    const discoveredRestart = (await adapter.discoverSessions()).find((row) => row.id === id)!;
    assert.equal(discoveredRestart.attachMode, 'live', 'fresh discovery preserves the reconnectable app owner');
    await hub.refreshExternalSession(row);
    assert.equal(managed.conn, conn, 'a roster refresh must not replace the disconnected app owner');
    assert.equal(row.control.terminalSync.presence, 'absent');
    await daemon.start();
    daemon.configure({loadedThreadIds:[],readResult:()=>({thread:{status:{type:'idle'},turns:[]}})});
    await conn.sendPrompt({text:'next prompt on replacement daemon'});
    assert.equal(conn.info.status,'working');
    assert.equal(conn.info.control?.terminalSync.syncAvailable,true);
    assert.equal(existsSync(marker),false,'reconnect must not spawn stdio');
    assert.equal(daemon.calls.filter((method)=>method==='turn/start').length,2);
    // Replacing the control alias also invalidates a still-open old transport.
    const replacementSocket = join(root,'replacement.sock');
    const replacement = new FakeCodexDaemon(replacementSocket,{loadedThreadIds:[],resumeResult:()=>({thread:{id:threadId,status:{type:'idle'},turns:[]}})});
    await replacement.start();
    try {
      unlinkSync(alias); symlinkSync(replacementSocket,alias);
      await conn.sendPrompt({text:'prompt after socket alias replacement'});
      assert(replacement.calls.includes('turn/start'),'replacement socket receives the next prompt');
      assert.equal(messages.filter((m)=>m.type==='run-summary' && m.status==='cancelled').length,2);
      await hub.dispose();
    } finally { await replacement.stop(); }
    process.env.COSYNCING_CODEX_APP_SERVER_SOCK=socket;
    await daemon.stop();
    // Older Bun leaves the closed Unix socket inode behind. This fixture
    // exercises an absent endpoint, so remove its owned path explicitly.
    rmSync(socket, { force: true });
    assert.equal(existsSync(socket), false, 'private fallback requires an absent endpoint');
    const missing = await adapter.attach(id,'resume');
    assert.equal(missing.info.control?.terminalSync.syncAvailable,false);
    assert.match(missing.info.control!.terminalSync.reason!,/not running or reachable/);
    assert.notEqual(missing.info.control?.terminalSync.action,'handoff');
    assert.equal(missing.info.terminalSyncHint?.command,'','private fallback must offer no runnable sync command');
    await missing.close();
    const unownedMissing = (await adapter.discoverSessions()).find((row) => row.id === id)!;
    assert.equal(unownedMissing.terminalSyncHint?.command, '', 'discovery must not advertise an unreachable daemon');
    assert.match(unownedMissing.control!.terminalSync.reason!, /not running or reachable/);
    const baseRollout = join(sessions, 'rollout-retained-private.jsonl');
    writeFileSync(baseRollout, JSON.stringify({type:'session_meta',payload:{id:'retained-private',cwd,model_provider:'fixture'}})+'\n');
    const baseId = Buffer.from(baseRollout).toString('base64url');
    const retainedPrivate = await adapter.attach(baseId, 'resume');
    await daemon.start();
    const retainedRow = (await adapter.discoverSessions()).find((row) => row.id === baseId)!;
    assert.equal(retainedRow.attachMode, 'observe', 'private sync metadata must not grant Drive to an observer');
    assert.equal(retainedRow.terminalSyncHint?.command, '', 'a returning daemon does not turn a private writer into shared sync');
    const watchedPrivate = (await (adapter as any).sessionInfosForLiveIds(new Set(), emptyPresence(), new Map())).find((row: any) => row.id === baseId)!;
    assert.equal(watchedPrivate.terminalSyncHint?.command, '');
    const privateHub = new Hub(registry, 20000);
    try {
      const observer = await privateHub.ensure('codex',baseId);
      assert.equal(observer.conn.info.attachMode, 'observe');
      assert.equal(observer.conn.info.control?.terminalSync.syncAvailable, false, 'an observer cannot sync past an open private writer');
      await privateHub.refreshExternalSession(retainedRow);
      assert.equal(observer.conn.info.attachMode, 'observe', 'private sync projection keeps the existing observer read-only');
      assert.equal(observer.conn.info.control?.drive.state, 'observing');
    } finally { await privateHub.dispose(); }

    await retainedPrivate.close();
    rmSync(marker,{force:true});
    writeFileSync(join(home,'private.config.toml'),'model_provider="private"\n[model_providers.private]\nname="Private"\nbase_url="http://fixture.invalid"\nwire_api="responses"\n');
    const privateInfo = await adapter.createSession({directory:cwd,model:{providerID:'private',modelID:'selected',variant:'private'}});
    const privatePath = Buffer.from(privateInfo.id,'base64url').toString('utf8');
    const privateContent = readFileSync(privatePath,'utf8');
    assert(existsSync(marker));
    assert.equal(privateInfo.control?.terminalSync.syncAvailable,false);
    assert.match(privateInfo.control!.terminalSync.reason!,/base config.toml/);
    const unownedProfile = (await adapter.discoverSessions()).find((row) => row.id === privateInfo.id)!;
    assert.equal(unownedProfile.terminalSyncHint?.command, '', 'metadata-only profile sessions remain unsyncable in discovery');
    assert.match(unownedProfile.control!.terminalSync.reason!, /base config.toml/);
    rmSync(marker);
    const privateRollout = join(sessions, 'rollout-private-empty.jsonl');
    writeFileSync(privateRollout, JSON.stringify({type:'session_meta',payload:{id:'private-empty',cwd,model_provider:'private'}})+'\n');
    const privateDrive = await adapter.attach(Buffer.from(privateRollout).toString('base64url'),'resume');
    assert(existsSync(marker), 'an empty rollout retains its profile-only provider and Drives privately');
    assert.equal(privateDrive.info.attachMode, 'resume');
    assert.match(privateDrive.info.control!.terminalSync.reason!, /base config.toml/);
    await privateDrive.close();
    rmSync(marker);
    // No turn means no currentModel: the base-defined provider still belongs in every join hint.
    writeFileSync(join(home, 'config.toml'), '[model_providers.base_empty]\nname="Empty fixture"\nbase_url="http://fixture.invalid"\nwire_api="responses"\n');
    const emptyRollout = join(sessions, 'rollout-base-empty.jsonl');
    writeFileSync(emptyRollout, JSON.stringify({ type: 'session_meta', payload: { id: 'base-empty', cwd, model_provider: 'base_empty' } }) + '\n');
    const emptyId = Buffer.from(emptyRollout).toString('base64url');
    const emptyRow = (await adapter.discoverSessions()).find((row) => row.id === emptyId)!;
    assert.match(emptyRow.terminalSyncHint!.command, /model_provider="base_empty"/, 'PR3 empty-thread discovery carries its base provider');
    const emptyObserver = await adapter.attach(emptyId, 'observe');
    try {
      assert.match(emptyObserver.info.terminalSyncHint!.command, /model_provider="base_empty"/, 'PR3 empty-thread attach carries its base provider');
      assert.equal(emptyObserver.info.control?.terminalSync.command, emptyObserver.info.terminalSyncHint!.command);
    } finally { await emptyObserver.close(); }
    const emptyRenamed = await adapter.renameSession(emptyId, 'Empty provider fixture');
    assert.match(emptyRenamed.terminalSyncHint!.command, /model_provider="base_empty"/, 'PR3 empty-thread rename carries its base provider');
    assert.equal(readFileSync(emptyRollout, 'utf8').trim().split('\n').length, 1, 'empty-provider fixture still has no turns');
    console.log('PASS PR3 empty-thread provider from session_meta survives discovery/attach/rename');
    // Exercise the watcher itself: a raw process-folder scan must go through
    // the same native-folder preparation as discovery/attach before publishing.
    const watchBorn = Date.now();
    const watchRollout = join(sessions, 'rollout-watch-user.jsonl');
    writeFileSync(watchRollout, JSON.stringify({ type: 'session_meta', payload: {
      id: 'watch-user', cwd: home, timestamp: new Date(watchBorn).toISOString(), thread_source: 'user',
    } }) + '\n');
    const watchAppRollout = join(sessions, 'rollout-watch-app.jsonl');
    writeFileSync(watchAppRollout, JSON.stringify({ type: 'session_meta', payload: {
      id: 'watch-app', cwd: home, timestamp: new Date(watchBorn).toISOString(),
    } }) + '\n');
    const rawWatchScan = () => ({ ...emptyPresence(),
      unattributed: [{ cwd, processCwd: cwd, startedAtMs: watchBorn - 1000 }],
      candidates: [{ pid: 77, cwd, processCwd: cwd, startedAtMs: watchBorn - 1000, proof: 'shared' as const }],
    });
    const watcher = new CodexAdapter({ scanCodexTuiPresence: async () => rawWatchScan(),
      queryLoadedThreadIds: async () => new Set(['watch-user', 'watch-app']),
      queryLoadedThreadActivities: async () => [],
    });
    const { codexNewThreadFolders } = await import('../../../adapters/codex/src/tui-presence.ts');
    // Substitute only native folder acquisition; retain the real preparation,
    // classification, rollout reading and asynchronous watcher publication.
    (watcher as any).presenceScan = async () => codexNewThreadFolders(rawWatchScan(), home);
    const watchFrames: any[] = [];
    let resolveWatch!: () => void;
    const watchPublished = new Promise<void>((resolve) => { resolveWatch = resolve; });
    const unwatch = watcher.watchSessionInfo((info) => {
      watchFrames.push(info);
      if (watchFrames.some((row) => row.nativeId === 'watch-user')
        && watchFrames.some((row) => row.nativeId === 'watch-app')) resolveWatch();
    });
    const watchDeadline = setTimeout(resolveWatch, 2000);
    try {
      await watchPublished;
      const userFrame = watchFrames.find((row) => row.nativeId === 'watch-user');
      assert.equal(userFrame?.control?.terminalSync.presence, 'shared', 'PR3 watcher preserves daemon-folder terminal sync');
      assert.equal(userFrame?.control?.terminalSync.label, 'Synced with Codex terminal');
      const appFrame = watchFrames.find((row) => row.nativeId === 'watch-app');
      assert.equal(appFrame?.control?.terminalSync.presence, 'absent', 'PR3 watcher does not match an app-only daemon-folder thread');
      assert.equal(appFrame?.control?.drive.state, 'driving');
      console.log('PASS PR3 watcher preserves daemon-folder terminal sync and keeps app-only Driving');
    } finally { clearTimeout(watchDeadline); unwatch(); }
    process.env.COSYNCING_CODEX_SYNC_SERVER='0';
    const disabled = await new CodexAdapter().createSession({directory:cwd});
    assert.notEqual(disabled.id,privateInfo.id,'a restarted private fake creates a distinct session');
    const disabledPath = Buffer.from(disabled.id,'base64url').toString('utf8');
    assert.notEqual(JSON.parse(readFileSync(disabledPath,'utf8')).payload.id,JSON.parse(privateContent).payload.id,'private creates allocate distinct native threads across process restarts');
    assert.equal(readFileSync(privatePath,'utf8'),privateContent,'a restarted private fake preserves the previous rollout');
    for (const info of created) assert.equal(readFileSync(info.path,'utf8'),info.content,'private creates preserve shared historical rollouts');
    assert(existsSync(marker));
    assert.equal(disabled.control?.terminalSync.syncAvailable,false);
    assert.match(disabled.control!.terminalSync.reason!,/disabled/);
    console.log('PASS shared app daemon: create/cwd/cold and loaded Drive/join/blockers/restart/fallbacks');
  } finally {
    await hub.dispose(); await daemon.stop();
    keys.forEach((key,i)=>{ if(old[i]===undefined) delete process.env[key]; else process.env[key]=old[i]; });
    rmSync(root,{recursive:true,force:true});
  }
}

if (import.meta.main) await testCodexAppDaemon();
