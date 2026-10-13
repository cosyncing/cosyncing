import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export async function daemonHomeChecks(check: (name: string, ok: boolean, detail?: string) => void): Promise<void> {
  if (process.platform === 'win32') return;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cosyncing-daemon-home-')));
  const home = join(root, 'home'); const codexHome = join(home, 'codex'); const caller = join(root, 'broker-folder');
  const log = join(root, 'commands.ndjson'); const bin = join(root, 'codex'); const probe = join(root, 'probe.ts');
  mkdirSync(join(codexHome, 'sessions'), { recursive: true }); mkdirSync(caller);
  writeFileSync(bin, `#!${process.execPath}\nconst fs=require('node:fs'); const command=process.argv.at(-1);\nfs.appendFileSync(${JSON.stringify(log)},JSON.stringify({command,cwd:process.cwd()})+'\\n');\nconsole.log(JSON.stringify({status:'stopped',cliVersion:'1.0.0',appServerVersion:'1.0.0'}));\n`);
  chmodSync(bin, 0o700);
  const implementation = resolve(import.meta.dir, '../src/implementation.ts');
  writeFileSync(probe, `import {CodexAdapter,runCodexDaemonCommand,stopCodexDaemonEnsureProcess} from ${JSON.stringify(implementation)};
let notified:()=>void; const notification=new Promise<void>(r=>notified=r);
const adapter=new CodexAdapter({reportManagedStart:()=>notified!(),queryLoadedThreadIds:async()=>new Set(),
  scanCodexTuiPresence:async()=>({attributed:new Set(),unattributed:[],privateThreadIds:new Set(),privateUnattributed:[],unknownThreadIds:new Set(),unknownUnattributed:[],candidates:[],socketDiagAvailable:true,processScanAvailable:true})});
await adapter.discoverSessions();
await Promise.race([notification,new Promise((_,reject)=>setTimeout(()=>reject(new Error('start helper did not finish')),5000))]);
const restart=await runCodexDaemonCommand('restart',3000,${JSON.stringify(bin)});
if(restart.code!==0)throw new Error(restart.stderr);
await stopCodexDaemonEnsureProcess();
`);
  try {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, CODEX_HOME: codexHome, COSYNCING_CODEX_BIN: bin,
      COSYNCING_CODEX_SYNC_SERVER: '1' };
    delete env.COSYNCING_CODEX_APP_SERVER_SOCK;
    const child = Bun.spawn([process.execPath, probe], { cwd: caller, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const commands = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    check('PR3 automatic daemon start runs from home rather than the broker folder',
      code === 0 && commands.some((c) => c.command === 'start' && c.cwd === home), out + err);
    check('PR3 verified lifecycle restart helper runs from home rather than the broker folder',
      code === 0 && commands.some((c) => c.command === 'restart' && c.cwd === home), out + err);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (import.meta.main) {
  let failed = 0;
  await daemonHomeChecks((name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' ' + detail}`); if (!ok) failed++; });
  process.exitCode = failed ? 1 : 0;
}
