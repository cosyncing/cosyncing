#!/usr/bin/env bun
/**
 * Capture what an installed `dsh web` host of the 0.2 family actually says.
 *
 * Every DSH 0.2 suite in the gate is fixture-based, deliberately: the gate must
 * not need a machine with a particular CLI. That makes the fixture load-bearing,
 * and a fixture written by the same person who wrote the adapter proves nothing
 * about either. So this script talks to a real host with its own deliberately
 * small raw envelope reader, records the bytes back, and the adapter's
 * assumptions are then tested against the host's answers rather than against the
 * adapter's own source.
 *
 * Isolation is the point of the guards below. The child gets a HOME of its own,
 * so it cannot see or claim the owner's real `~/.dsh` sessions or provider
 * credentials, and it binds a port that is neither the production broker (7734)
 * nor the source-review broker (17734) and that must be free before we start.
 *
 * Default capture is read-only. `--sessions` additionally creates a session,
 * which is a mutation: it is still confined to the disposable home, and the run
 * record says whether it happened.
 *
 * The launch token and the session cookie never leave this process. What is
 * written out names the cookie, masks its value, and keeps the URL's token as a
 * fixed placeholder.
 *
 * Usage:
 *   bun run scripts/adapters/dsh-contract-capture.ts \
 *     [--dsh <path>] [--port <n>] [--sessions] [--out <dir>] [--keep-home]
 */
export {};
import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createConnection } from 'node:net';
import {
  assertDisposableHome, assertRootsContained, buildChildEnvironment,
  INHERITED_NAMES, isolatedStateRoots, probeDefaultWorkspace, provisionDocumentsDirectory,
} from './dsh-capture-sandbox.ts';
import { modelBackedVerdict } from './dsh-capture-prompt.ts';
import { runPromptTurn, type TurnSocket } from './dsh-capture-turn.ts';

const ROOT = resolve(import.meta.dir, '../..');

/** The owner's real broker and the source-review broker. Neither is ours to touch. */
const FORBIDDEN_PORTS = [7734, 17734];
const DEFAULT_PORT = 17_834;
const TOKEN_PLACEHOLDER = '<redacted-launch-token>';
const COOKIE_PLACEHOLDER = '<redacted-cookie-value>';


interface Args {
  executable: string;
  port: number;
  out: string;
  sessions: boolean;
  keepHome: boolean;
  workspace: string;
  /** Names of shell variables to forward to the child. Values are never recorded. */
  credentialEnvs: string[];
  /** Text for a real model turn. Empty means no turn is attempted. */
  prompt: string;
  approval: 'allow-once' | 'deny';
  promptTimeoutMs: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    executable: process.env['COSYNCING_DSH_CAPTURE_BIN'] ?? 'dsh',
    port: Number(process.env['COSYNCING_DSH_CAPTURE_PORT'] ?? DEFAULT_PORT),
    out: join(ROOT, 'output', 'review', 'dsh-0.2'),
    sessions: process.env['COSYNCING_DSH_CAPTURE_SESSIONS'] === '1',
    keepHome: false,
    workspace: '',
    credentialEnvs: (process.env['COSYNCING_DSH_CAPTURE_CREDENTIAL_ENVS'] ?? '')
      .split(',').map((name) => name.trim()).filter((name) => name.length > 0),
    prompt: process.env['COSYNCING_DSH_CAPTURE_PROMPT'] ?? '',
    approval: 'deny',
    promptTimeoutMs: 90_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${String(flag)} needs a value`);
      index += 1;
      return value;
    };
    if (flag === '--dsh') args.executable = next();
    else if (flag === '--port') args.port = Number(next());
    else if (flag === '--out') args.out = resolve(next());
    else if (flag === '--workspace') args.workspace = resolve(next());
    else if (flag === '--sessions') args.sessions = true;
    else if (flag === '--credential-env') args.credentialEnvs.push(next());
    else if (flag === '--prompt') args.prompt = next();
    else if (flag === '--approval') {
      const choice = next();
      if (choice !== 'allow-once' && choice !== 'deny') throw new Error('--approval is allow-once or deny');
      args.approval = choice;
    }
    else if (flag === '--prompt-timeout') args.promptTimeoutMs = Number(next());
    else if (flag === '--keep-home') args.keepHome = true;
    else throw new Error(`unknown argument ${String(flag)}`);
  }
  if (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65_535) {
    throw new Error(`--port must be a high port, got ${String(args.port)}`);
  }
  if (FORBIDDEN_PORTS.includes(args.port)) {
    throw new Error(`port ${String(args.port)} belongs to a cosyncing broker; this capture must not use it`);
  }
  if (args.prompt.length > 0 && !args.sessions) {
    throw new Error('--prompt needs --sessions: a model turn has to be sent to a session this run creates');
  }
  if (args.prompt.length > 0 && args.credentialEnvs.length === 0) {
    throw new Error('--prompt needs at least one --credential-env: the disposable home has no provider key, so the turn could only fail');
  }
  return args;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (free: boolean): void => {
      socket.destroy();
      resolvePromise(free);
    };
    socket.setTimeout(1_500);
    socket.once('connect', () => done(false));
    socket.once('timeout', () => done(true));
    socket.once('error', () => done(true));
  });
}

/** Strip the one secret that must never be written, whatever else a record holds. */
function redact(value: string, token: string | undefined, cookie: string | undefined): string {
  let out = value;
  if (token) out = out.split(token).join(TOKEN_PLACEHOLDER);
  if (cookie) out = out.split(cookie).join(COOKIE_PLACEHOLDER);
  return out;
}

function scrubJson(value: unknown, token: string | undefined, cookie: string | undefined): unknown {
  const text = JSON.stringify(value, (_key, entry: unknown) => (typeof entry === 'string' ? redact(entry, token, cookie) : entry));
  try {
    return JSON.parse(redact(text, token, cookie)) as unknown;
  } catch {
    return redact(text ?? String(value), token, cookie);
  }
}

/** Drop absolute paths that point at any real home; keep the shape of the field. */
function sanitizePaths(value: unknown, disposable = ''): unknown {
  const realHome = homedir();
  const walk = (entry: unknown): unknown => {
    if (typeof entry === 'string') {
      const base = disposable && entry.startsWith(disposable) ? disposable : realHome;
      const label = disposable && entry.startsWith(disposable) ? '/captured' : '/home/captured';
      return entry.startsWith(base) ? entry.split(base).join(label) : entry;
    }
    if (Array.isArray(entry)) return entry.map(walk);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>).map(([k, v]) => [k, walk(v)]));
    }
    return entry;
  };
  return walk(value);
}

function launchCaptureHost(executable: string, port: number, workspace: string, env: Record<string, string>) {
  return Bun.spawn([executable, 'web', '--no-open', '--port', String(port)], {
    cwd: workspace, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
}

/** Dependencies at the process boundary; fixtures still execute the complete capture. */
export interface CaptureRuntime {
  platform?: NodeJS.Platform;
  launchHost?: typeof launchCaptureHost;
}

export async function runDshContractCapture(
  argv: readonly string[], runtime: CaptureRuntime = {},
): Promise<number> {
  const args = parseArgs(argv);
  const platform = runtime.platform ?? process.platform;
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(args.out, runId);
  const home = join(tmpdir(), `cosyncing-dsh-capture-${runId}`);
  assertDisposableHome(home);
  if (!(await portFree(args.port))) {
    console.error(`port ${String(args.port)} already has a listener; refusing to share a host`);
    return 2;
  }
  // Establish the report destination before allocating disposable state.
  mkdirSync(runDir, { recursive: true });
  const workspace = args.workspace || join(home, 'workspace');

  const record: Record<string, unknown> = {
    provenance: {
      capturedAt: new Date().toISOString(),
      runId,
      // Recorded as given, never resolved: an absolute path here would put the
      // operator's account in a file that is meant to be shareable.
      executable: args.executable.includes('/') ? args.executable.split('/').pop() ?? 'dsh' : args.executable,
      executablePathRecorded: false,
      requestedPort: args.port,
      isolatedHome: true,
      // The claim is only as good as its evidence: name what the child could
      // actually reach, so a reader can see the override was pinned and can see
      // which credential variables were forwarded without seeing their values.
      stateRootsPinned: Object.keys(isolatedStateRoots(home)),
      credentialEnvsForwarded: [] as string[],
      inheritedNames: INHERITED_NAMES.filter((name) => process.env[name] !== undefined),
      mutatedHost: args.sessions || args.prompt.length > 0,
      scenarios: [
        'authentication', 'probe', 'unary', 'events',
        ...(args.sessions ? ['session-streams'] : []),
        ...(args.prompt.length > 0 ? ['model-turn'] : []),
      ],
      // Overwritten below with a verdict read off the host's own frames. Until a
      // turn has run there is nothing to derive it from, so it starts false and
      // says so rather than asserting a fixed answer.
      modelBacked: false,
      modelTurn: { attempted: false, reason: 'no prompt scenario was requested' },
      defaultWorkspace: { probed: false, usable: false, reason: 'startup has not reached the directory probe' },
      platform: `${platform}/${process.arch}`,
    },
    captures: {} as Record<string, unknown>,
  };
  const captures = record.captures as Record<string, unknown>;
  let token: string | undefined;
  let cookie: string | undefined;

  const record_ = (id: string, value: unknown): void => {
    captures[id] = sanitizePaths(scrubJson(value, token, cookie), home);
  };

  let child: ReturnType<typeof launchCaptureHost> | undefined;
  let failures = 0;
  try {
    mkdirSync(join(home, '.dsh'), { recursive: true, mode: 0o700 });
    const documents = provisionDocumentsDirectory(home, platform);
    const childEnv = buildChildEnvironment({
      home, inherited: process.env as Record<string, string | undefined>, injectedNames: args.credentialEnvs,
    });
    // Prove ownership before creating any caller-supplied workspace path.
    assertRootsContained(home, childEnv.env, workspace);
    mkdirSync(workspace, { recursive: true });
    const workspaceProbe = probeDefaultWorkspace(home, childEnv.env, platform);
    record.provenance = {
      ...record.provenance as object,
      credentialEnvsForwarded: childEnv.injected,
      // This describes web UI initialization, not API prompt admission.
      defaultWorkspace: {
        documentsDirectoryPinned: documents.pinned,
        documentsLookupPinnedReason: documents.reason,
        ...workspaceProbe,
      },
    };

    const version = Bun.spawnSync([args.executable, '-V'], { env: childEnv.env, stdout: 'pipe', stderr: 'pipe' });
    record.provenance = {
      ...record.provenance as object,
      versionOutput: version.stdout.toString().trim(),
      versionExit: version.exitCode,
      packageVersion: (() => {
        try {
          const pkg = join(dirname(dirname(resolve(args.executable))), 'package.json');
          return existsSync(pkg) ? (JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }).version ?? null : null;
        } catch {
          return null;
        }
      })(),
    };
    console.log(`dsh: ${String((record.provenance as Record<string, unknown>).versionOutput)}`);

    child = (runtime.launchHost ?? launchCaptureHost)(args.executable, args.port, workspace, childEnv.env);
    const host = child;
    let announcement = '';
    const tokenFound = new Promise<string>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('the host never announced a URL')), 60_000);
      void (async () => {
        let announced = false;
        try {
          for await (const chunk of host.stdout as unknown as AsyncIterable<Uint8Array>) {
            announcement = (announcement + new TextDecoder().decode(chunk)).slice(-16_384);
            const match = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9._~+/-]+=*)/.exec(announcement);
            if (!announced && match?.[1]) {
              announced = true;
              clearTimeout(timer);
              resolvePromise(match[1]);
            }
          }
          if (!announced) rejectPromise(new Error('the host exited before announcing a URL'));
        } catch (error) {
          rejectPromise(error);
        } finally {
          clearTimeout(timer);
        }
      })();
    });
    // Consume diagnostics without retaining or publishing provider output.
    void (async () => {
      for await (const _chunk of host.stderr as unknown as AsyncIterable<Uint8Array>) { /* drain */ }
    })().catch(() => { /* host shutdown */ });

    const baseUrl = `http://127.0.0.1:${String(args.port)}`;
    const launchUrl = await tokenFound;
    token = new URL(launchUrl).searchParams.get('token') ?? undefined;

    // 1. Authentication, proved before anything is allowed to depend on it.
    const unauth = await fetch(`${baseUrl}/api/remote.mux`, { method: 'GET' });
    record_('probe.remoteMuxUnauthenticated', {
      status: unauth.status,
      body: redact((await unauth.text()).slice(0, 400), token, cookie),
    });
    const exchange = await fetch(launchUrl, { method: 'GET', redirect: 'manual' });
    const setCookie = exchange.headers.get('set-cookie') ?? '';
    cookie = /dsh-auth-[^=]+=([^;]*)/.exec(setCookie)?.[1];
    record_('auth.exchange', {
      status: exchange.status,
      location: exchange.headers.get('location'),
      cacheControl: exchange.headers.get('cache-control'),
      cookieName: setCookie.split('=')[0] ?? null,
      cookieAttributes: setCookie.replace(/=[^;]*/, `=${COOKIE_PLACEHOLDER}`),
      body: redact((await exchange.text()).slice(0, 200), token, cookie),
    });
    const refused = await fetch(`${baseUrl}/?token=not-the-token`, { method: 'GET', redirect: 'manual' });
    record_('auth.refusedToken', { status: refused.status, body: (await refused.text()).slice(0, 300) });

    const cookieHeader = setCookie.split(';')[0] ?? '';
    const headers = { cookie: cookieHeader, 'content-type': 'application/json' };

    const probeMux = await fetch(`${baseUrl}/api/remote.mux`, { method: 'GET', headers: { cookie: cookieHeader } });
    record_('probe.remoteMuxAuthenticatedNoUpgrade', { status: probeMux.status, body: (await probeMux.text()).slice(0, 200) });
    const probeLegacy = await fetch(`${baseUrl}/api/events.mux`, { method: 'GET', headers: { cookie: cookieHeader } });
    record_('probe.legacyMux', { status: probeLegacy.status, body: (await probeLegacy.text()).slice(0, 200) });

    // 2. The unary envelope, raw: the exact frame the gateway answers with.
    let rpcSeq = 0;
    // Each record carries the request it made alongside the answer it got, so
    // the fixture can be read as "this exact payload produced this exact reply"
    // rather than as a pile of responses someone has to reconstruct.
    const call = async (
      id: string,
      method: string,
      args: Record<string, unknown>,
      options?: { path?: string; rawPayload?: unknown },
    ): Promise<{ ok: boolean; value?: unknown }> => {
      const rpcId = `capture-${String(++rpcSeq)}`;
      const path = options?.path ?? `/api/${method}`;
      const payload = options?.rawPayload ?? { args };
      let outcome: { ok: boolean; value?: unknown };
      try {
        const response = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
        });
        const text = await response.text();
        let envelope: unknown;
        try {
          envelope = JSON.parse(text) as unknown;
        } catch {
          envelope = { nonJsonBody: text.slice(0, 200) };
        }
        outcome = { ok: response.ok, value: { endpoint: method, path, args, status: response.status, envelope } };
      } catch (error) {
        outcome = { ok: false, value: { endpoint: method, path, args, error: error instanceof Error ? error.message : String(error) } };
      }
      record_(id, outcome.value);
      return outcome as { ok: boolean; value?: unknown };
    };

    await call('unary.unknownRoute', 'nonsense/nonsense', {}, { path: '/api/nonsense/nonsense' });
    await call('unary.streamViaPost', 'session/follow', { request: { address: { kind: 'session', sessionId: 'nope' } } });
    await call('unary.wrongArgName', 'session/list', { request: {} });
    await call('unary.missingArgs', 'session/list', {}, { rawPayload: {} });
    const list = await call('unary.sessionList', 'session/list', { _request: {} });
    await call('unary.modelCatalog', 'session/modelCatalog', {});
    await call('unary.permissionPresets', 'permissionPresets/catalog', {});

    // 3. The single carrier and its event stream. The ready frame is the only
    //    thing that makes a generation real; an HTTP 200 or an open socket does not.
    const events = await new Promise<Record<string, unknown>>((resolvePromise) => {
      const frames: unknown[] = [];
      const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/api/remote.mux`, { headers: { cookie: cookieHeader } } as never);
      const finish = (): void => {
        try { socket.close(); } catch { /* already gone */ }
        resolvePromise({ frames });
      };
      const timer = setTimeout(finish, 8_000);
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'open', streamId: 'cap-events', endpoint: '$events', payload: { args: {} } }));
      });
      socket.addEventListener('message', (event) => {
        frames.push(JSON.parse(String((event as MessageEvent).data)) as unknown);
        const ready = frames.find((frame) => (frame as { value?: { type?: string } }).value?.type === 'ready');
        if (ready) {
          clearTimeout(timer);
          setTimeout(finish, 1_000);
        }
      });
      socket.addEventListener('error', () => {
        frames.push({ captureError: 'socket error' });
        clearTimeout(timer);
        finish();
      });
    });
    record_('events.stream', events);

    // 4. Optional, mutating, and confined to the disposable home.
    if (args.sessions) {
      const created = await call('session.create', 'session/create', { request: {} });
      const envelope = (created.value as { envelope?: { result?: { value?: { sessionId?: string } } } })?.envelope;
      const sessionId = envelope?.result?.value?.sessionId;
      record_('session.createdIdShape', { present: typeof sessionId === 'string', keys: Object.keys((envelope?.result?.value ?? {}) as object) });
      if (typeof sessionId === 'string') {
        await call('session.page', 'session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: 0, maxMessages: 20 } });
        await call('session.projections', 'session/projections', { request: { sessionId } });
        // The roster has to be readable AFTER a session exists: a cold host with
        // an empty list proves nothing about agentAvailable, running or the
        // cached-projection hint, and those are exactly the roster's hard cases.
        await call('session.listAfterCreate', 'session/list', { _request: {} });
        await call('agentPresets.list', 'agentPresets/list', {});
        const streams = await new Promise<Record<string, unknown>>((resolvePromise) => {
          const frames = { follow: [] as unknown[], control: [] as unknown[], workspace: [] as unknown[] };
          // What this capture WRITES is as much a fact as what it reads: the
          // adapter's argument builders are pinned against these exact open
          // frames, so a builder that renames a field stops matching the host.
          const written: unknown[] = [];
          const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/api/remote.mux`, { headers: { cookie: cookieHeader } } as never);
          const finish = (): void => {
            try { socket.close(); } catch { /* gone */ }
            resolvePromise({ sessionId, frames, written });
          };
          const timer = setTimeout(finish, 12_000);
          const write = (frame: Record<string, unknown>): void => {
            written.push(frame);
            socket.send(JSON.stringify(frame));
          };
          socket.addEventListener('open', () => {
            write({ type: 'open', streamId: 'cap-follow', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } } } });
            // session/control is host-wide and its descriptor takes NO arguments.
            write({ type: 'open', streamId: 'cap-control', endpoint: 'session/control', payload: { args: {} } });
            write({ type: 'open', streamId: 'cap-ws', endpoint: 'workspace/follow', payload: { args: {} } });
          });
          socket.addEventListener('message', (event) => {
            const frame = JSON.parse(String((event as MessageEvent).data)) as { streamId?: string };
            const bucket = frame.streamId === 'cap-follow' ? frames.follow
              : frame.streamId === 'cap-control' ? frames.control
              : frame.streamId === 'cap-ws' ? frames.workspace : undefined;
            bucket?.push(frame);
            if ((frames.follow.length >= 1 && frames.control.length >= 1 && frames.workspace.length >= 1)) {
              clearTimeout(timer);
              setTimeout(finish, 500);
            }
          });
          socket.addEventListener('error', () => { clearTimeout(timer); finish(); });
        });
        record_('session.streams', streams);
        // `commands/list` is keyed by agentId, which nothing in the session
        // snapshot names. Record where it can and cannot be found rather than
        // inventing one; a guessed id answers as an empty roster, which looks
        // like a host with no commands rather than a wrong argument.
        const control = (streams.frames as { control?: unknown[] }).control ?? [];
        record_('session.controlShape', control.slice(0, 2));
        // The descriptor names its first parameter `agentId` and types it as a
        // SessionId: the commands roster is keyed by the session, not by a
        // separate agent process identity.
        await call('commands.list', 'commands/list', { agentId: sessionId });
        await call('session.followMissing', 'session/follow', { request: { address: { kind: 'session', sessionId: 'session-does-not-exist' } } });

        // 5. An optional, paid, deliberately chosen model turn.
        if (args.prompt.length > 0) {
          // Retain the conservative qualification boundary for paid scenarios.
          // A missing UI prerequisite does not imply that the API cannot prompt.
          // Free captures still complete and record the unverified prerequisite.
          if (!workspaceProbe.usable) {
            throw new Error(`the prompt scenario requires a verified default Workspace: ${workspaceProbe.reason}`);
          }
          // A turn needs BOTH subscriptions before anything is asked of the model:
          // the event stream because an approval has to reach a client the host
          // knows, and the followed session because its opening snapshot is the
          // baseline every later claim is measured against. The orchestration lives
          // in dsh-capture-turn.ts, where those orderings are testable rather than
          // implicit in a WebSocket callback.
          const turn = await runPromptTurn({
            openSocket: (base, cookie) => new WebSocket(
              base.replace(/^http/, 'ws') + '/api/remote.mux', { headers: { cookie } } as never,
            ) as unknown as TurnSocket,
            post: async (url, body, cookie) => {
              const response = await fetch(url, {
                method: 'POST',
                headers: { cookie, 'content-type': 'application/json' },
                body,
              });
              return { status: response.status, body: await response.text() };
            },
          }, {
            baseUrl,
            cookie: cookieHeader,
            sessionId,
            text: args.prompt,
            approval: args.approval,
            timeoutMs: args.promptTimeoutMs,
          });
          const delivered = turn.answers.filter((entry) => entry.state === 'delivered').length;
          const failed = turn.answers.filter((entry) => entry.state === 'failed').length;
          record_('model.turnEvidence', {
            evidence: turn.evidence,
            answers: turn.answers,
            answersAttempted: turn.answers.length,
            answersDelivered: delivered,
            answersFailed: failed,
            promptSent: turn.promptSent,
            promptState: turn.promptState,
            promptDetail: turn.promptDetail,
            stoppedBy: turn.stoppedBy,
            receiptsSettled: turn.receiptsSettled,
            frames: turn.frames,
          });
          // A run that never asked the model anything is not a turn that failed to
          // answer; saying which of the two happened is the whole record.
          const verdict = modelBackedVerdict(turn.evidence, turn.promptSent, turn.promptSent
            ? undefined
            : 'the prompt never left this client (' + String(turn.stoppedBy ?? 'subscriptions never opened') + ')');
          record.provenance = {
            ...record.provenance as object,
            modelBacked: verdict.modelBacked,
            modelTurn: {
              ...verdict,
              approvalPolicy: args.approval,
              promptSent: turn.promptSent,
              promptState: turn.promptState,
              promptDetail: turn.promptDetail,
              stoppedBy: turn.stoppedBy,
              approvalsAttempted: turn.answers.length,
              approvalsDelivered: delivered,
              approvalsFailed: failed,
            },
          };
          console.log('model turn: ' + (verdict.modelBacked ? 'model-backed' : 'not model-backed (' + verdict.reason + ')'));
        }
      }
    }
  } catch (error) {
    failures += 1;
    record_('captureError', { message: error instanceof Error ? error.message : String(error) });
  } finally {
    if (child) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        child.kill();
        await Promise.race([child.exited, new Promise((r) => { timer = setTimeout(r, 3_000); })]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await child.exited;
        }
      } catch (error) {
        failures += 1;
        record_('hostCleanupError', { message: error instanceof Error ? error.message : String(error) });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    try {
      if (!args.keepHome) rmSync(home, { recursive: true, force: true });
    } catch (error) {
      failures += 1;
      record_('cleanupError', { message: error instanceof Error ? error.message : String(error) });
    }
    record.provenance = {
      ...record.provenance as object,
      homeRemoved: !existsSync(home),
      keptHome: args.keepHome ? home : null,
      homeHasState: args.keepHome && existsSync(home) ? readdirSync(home) : [],
    };
    const bytes = JSON.stringify(record, (_key, entry: unknown) => (typeof entry === 'string' ? redact(entry, token, cookie) : entry), 2);
    writeFileSync(join(runDir, 'capture.json'), `${bytes}\n`, { mode: 0o600 });
    console.log(`captured ${String(Object.keys(captures).length)} samples -> ${join(runDir, 'capture.json')}`);
  }
  return failures > 0 ? 1 : 0;
}

if (import.meta.main) {
  void runDshContractCapture(process.argv.slice(2)).then((code) => process.exit(code), (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
