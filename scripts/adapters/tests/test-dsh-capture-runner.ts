/** Whole capture startup, free scenarios and cleanup without an installed DSH. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { runDshContractCapture, type CaptureRuntime } from '../dsh-contract-capture.ts';
import { rememberCaptureChild, stopCaptureChild, trackCaptureChildren, type CaptureChildEffects } from '../dsh-capture-child.ts';
import type { HostProcessIdentity, HostProcessRead } from '../../../packages/typescript/adapter-api/src/index.ts';

async function testChildCleanup(check: (name: string, ok: boolean) => void): Promise<void> {
  const identity: HostProcessIdentity = { pid: 410, start: 'birth-1', boot: 'boot-1', comm: 'owned-wrapper' };
  {
    let reads = 0;
    const effects = {
      spawn: (_launch: string) => ({ pid: identity.pid }),
      liveProcess: (_pid: number, _options?: { fresh?: boolean }): HostProcessRead => {
        reads += 1; return { state: 'running', identity };
      },
    };
    const tracked = trackCaptureChildren(effects);
    effects.spawn('owned');
    check('managed capture tracking adds no startup process-table probe', reads === 0 && tracked.launched.has(identity.pid));
    effects.liveProcess(identity.pid); effects.liveProcess(999, { fresh: true });
    check('managed capture tracking ignores cached and unrelated identities', tracked.identities.size === 0);
    effects.liveProcess(identity.pid, { fresh: true });
    const replacement = { ...identity, start: 'recycled' };
    identity.start = replacement.start;
    effects.liveProcess(identity.pid, { fresh: true });
    check('managed capture retains the first fresh birth proof for cleanup', tracked.identities.get(identity.pid)?.start === 'birth-1' && reads === 4);
    identity.start = 'birth-1';
  }
  const fixture = () => {
    let now = 0;
    let live: HostProcessRead = { state: 'running', identity: { ...identity } };
    const signals: string[] = [];
    const fresh: boolean[] = [];
    let onSignal = (_signal: 'SIGTERM' | 'SIGKILL') => { live = { state: 'absent' }; };
    let onSleep = () => {};
    const effects: CaptureChildEffects = {
      read: (_pid, options) => { fresh.push(options.fresh === true); return live; },
      signal: (_pid, signal) => { signals.push(signal); onSignal(signal); },
      now: () => now,
      sleep: async (ms) => { now += ms; onSleep(); },
    };
    return { effects, signals, fresh, setLive: (value: HostProcessRead) => { live = value; },
      setSignal: (fn: typeof onSignal) => { onSignal = fn; }, setSleep: (fn: typeof onSleep) => { onSleep = fn; } };
  };
  {
    const h = fixture(); const owned = rememberCaptureChild(identity.pid, h.effects);
    const result = await stopCaptureChild(owned, h.effects, 100);
    check('capture cleanup signals its proven wrapper once and observes exit', result.ok && h.signals.join() === 'SIGTERM' && h.fresh[0] === true && h.fresh[1] === true);
  }
  for (const changed of [{ ...identity, start: 'reused-pid' }, { ...identity, boot: 'next-boot' }]) {
    const h = fixture(); const owned = rememberCaptureChild(identity.pid, h.effects);
    h.setLive({ state: 'running', identity: changed });
    const result = await stopCaptureChild(owned, h.effects, 100);
    check(`capture cleanup preserves a replaced ${changed.start === identity.start ? 'boot' : 'PID'}`, !result.ok && h.signals.length === 0);
  }
  {
    const h = fixture(); const owned = rememberCaptureChild(identity.pid, h.effects);
    h.setSignal(() => {});
    h.setSleep(() => h.setLive({ state: 'running', identity: { ...identity, start: 'replacement-after-term' } }));
    const result = await stopCaptureChild(owned, h.effects, 100);
    check('capture cleanup never escalates after wrapper identity changes', !result.ok && h.signals.join() === 'SIGTERM');
  }
  {
    const h = fixture(); const owned = rememberCaptureChild(identity.pid, h.effects);
    h.setSignal((signal) => { if (signal === 'SIGKILL') h.setLive({ state: 'absent' }); });
    const result = await stopCaptureChild(owned, h.effects, 100);
    check('capture cleanup escalates only against a freshly re-proved owned wrapper', result.ok && result.escalated && h.signals.join() === 'SIGTERM,SIGKILL' && h.fresh.filter(Boolean).length === 3);
  }
  for (const state of ['unknown', 'absent'] as const) {
    const h = fixture(); const owned = rememberCaptureChild(identity.pid, h.effects);
    h.setLive({ state });
    const result = await stopCaptureChild(owned, h.effects, 100);
    check(`capture cleanup sends nothing when a child is ${state}`, h.signals.length === 0 && result.ok === (state === 'absent'));
  }
}

// The runner still owns a real child, stdout announcement, HTTP and WebSocket.
// This host only supplies free contract responses; it cannot call a provider.
function fixtureHost(port: number): void {
  const server = Bun.serve({
    hostname: '127.0.0.1', port,
    fetch: async (request, server) => {
      const url = new URL(request.url);
      if (url.pathname === '/' && url.searchParams.get('token') === 'fixture-launch-token') {
        return new Response(null, { status: 303, headers: {
          location: '/', 'set-cookie': 'dsh-auth-fixture=fixture-cookie; HttpOnly; SameSite=Strict; Path=/',
        } });
      }
      if (!request.headers.get('cookie')?.includes('dsh-auth-fixture=fixture-cookie')) {
        return new Response('unauthorized', { status: 401 });
      }
      if (url.pathname === '/api/remote.mux' && server.upgrade(request)) return undefined;
      if (request.method === 'POST') {
        const body = await request.json() as { rpcId?: string; method?: string };
        if (body.method === 'session/prompt') throw new Error('a free capture must never prompt');
        return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} } });
      }
      return new Response('not found', { status: 404 });
    },
    websocket: {
      message(socket, raw) {
        const frame = JSON.parse(String(raw)) as { type?: string; streamId?: string; endpoint?: string };
        if (frame.type === 'open' && frame.endpoint === '$events') {
          socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId,
            value: { type: 'ready', clientId: 'fixture-client' } }));
        }
      },
    },
  });
  console.log(`dsh web: http://127.0.0.1:${String(server.port)}/?token=fixture-launch-token`);
}

async function unusedPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('fixture port not allocated');
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function testRunner(): Promise<void> {
  let passed = 0;
  let failed = 0;
  const check = (name: string, ok: boolean): void => {
    if (ok) passed += 1; else failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  };
  await testChildCleanup(check);
  const scratch = mkdtempSync(join(tmpdir(), 'cosyncing-capture-runner-test-'));
  const emptyPath = join(scratch, 'empty-path');
  mkdirSync(emptyPath);
  const names = ['PATH', 'COSYNCING_DSH_CAPTURE_PROMPT', 'COSYNCING_DSH_CAPTURE_CREDENTIAL_ENVS', 'COSYNCING_DSH_CAPTURE_SESSIONS'];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  const capture: typeof runDshContractCapture = async (argv, runtime) => {
    const log = console.log;
    try {
      console.log = () => {};
      return await runDshContractCapture(argv, runtime);
    } finally {
      console.log = log;
    }
  };
  try {
    process.env['PATH'] = emptyPath;
    process.env['COSYNCING_DSH_CAPTURE_PROMPT'] = '';
    process.env['COSYNCING_DSH_CAPTURE_CREDENTIAL_ENVS'] = '';
    process.env['COSYNCING_DSH_CAPTURE_SESSIONS'] = '';

    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const out = join(scratch, platform);
      let home = '';
      let child: ReturnType<NonNullable<CaptureRuntime['launchHost']>> | undefined;
      const exit = await capture([
        '--dsh', process.execPath, '--port', String(await unusedPort()), '--out', out,
      ], {
        platform,
        launchHost: (_executable, port, workspace, env) => {
          home = env['HOME']!;
          child = Bun.spawn([process.execPath, import.meta.filename, '--fixture-host', String(port)], {
            cwd: workspace, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
          });
          return child;
        },
      });
      const run = readdirSync(out)[0]!;
      const record = JSON.parse(readFileSync(join(out, run, 'capture.json'), 'utf8'));
      check(`${platform}: the complete free capture finishes without an OS helper`,
        exit === 0 && Object.keys(record.captures).length === 14 && record.captures.hostCleanup?.ok === true);
      check(`${platform}: unavailable Documents are evidence, not a startup exception`,
        record.provenance.defaultWorkspace.usable === false
          && record.provenance.defaultWorkspace.probed === false
          && record.provenance.defaultWorkspace.reason.includes(platform === 'linux' ? 'unavailable' : 'cannot be pinned'));
      check(`${platform}: free captures never attempt a model turn`, record.provenance.modelTurn.attempted === false && record.provenance.credentialEnvsForwarded.length === 0);
      check(`${platform}: the real fixture child exits and its home is removed`,
        !!child && (child.exitCode !== null || child.signalCode !== null)
          && home !== '' && !existsSync(home) && record.provenance.homeRemoved === true);
    }

    for (const kind of ['missing-executable', 'invalid-environment', 'launch-failure'] as const) {
      const out = join(scratch, kind);
      const executable = kind === 'missing-executable' ? join(scratch, 'absent-dsh') : process.execPath;
      let home = '';
      const exit = await capture([
        '--dsh', executable, '--port', String(await unusedPort()), '--out', out,
        ...(kind === 'invalid-environment' ? ['--credential-env', 'HOME'] : []),
      ], {
        platform: 'linux',
        launchHost: (_executable, _port, _workspace, env) => {
          home = env['HOME']!;
          throw new Error('fixture launch failure');
        },
      });
      const run = readdirSync(out)[0]!;
      const record = JSON.parse(readFileSync(join(out, run, 'capture.json'), 'utf8'));
      check(`${kind}: startup failure still writes its report`, exit === 1 && typeof record.captures.captureError?.message === 'string');
      check(`${kind}: no allocated home survives failed startup`,
        record.provenance.homeRemoved === true && (home === '' || !existsSync(home))
          && !existsSync(join(tmpdir(), `cosyncing-dsh-capture-${String(record.provenance.runId)}`)));
    }
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`\n${String(passed)} passed, ${String(failed)} failed`);
  if (failed > 0) process.exitCode = 1;
}

if (process.argv[2] === '--fixture-host') fixtureHost(Number(process.argv[3]));
else await testRunner();
