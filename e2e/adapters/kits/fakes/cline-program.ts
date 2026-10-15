/**
 * The fake `cline` executable (compiled by the kit with `bun build --compile`, so `/proc/<pid>/exe` names it: the
 * broker's ownership proof for a Hub it launched compares real process identity).
 *
 *   cline --version                 what `config.json` says (`versionOutput` replaces the whole line)
 *   cline --cwd <dir>               with `CLINE_RUN_AS_HUB_DAEMON=1`: the Cline Hub v1 daemon the broker owns
 *   cline history update …          the native title write the adapter escalates to (rename)
 *
 * The Hub is one process: an HTTP `/health`, the `ws://…/hub` command socket (authenticated by the subprotocol
 * `cline-hub-auth.<token>` from its discovery file) and the discovery file itself, written 0600 under
 * `CLINE_HUB_DISCOVERY_PATH`. Its sessions live in `CLINE_DATA_DIR/sessions/<id>/` as Cline writes them (a metadata
 * JSON and a `.messages.json` snapshot) and every command that changes a session persists before it replies, so a
 * Hub that replaces this one (another process, another `hubId`) finds the same sessions.
 *
 * A prompt's own text scripts its run, as the other kits' fakes do:
 *
 *   [[permission]]   ask a native approval (`approval.requested`) and wait for `approval.respond`
 *   [[hold:TAG]]     keep the run open until `release-TAG` appears in the control directory (or an abort)
 *   [[error]]        end the run with a native failure (`run.failed`, `model exploded`)
 *
 * Control (what a test cannot do from outside) arrives as command files in `<state>/commands/`, applied before
 * any later request: release a hold, name the next session id, fail the next command, flip `/health`, crash.
 * Everything observable is appended to `<state>/ledger.jsonl`.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

declare const FAKE_CLINE_STATE: string;

type Json = Record<string, any>;

export interface FakeClineConfig {
  version: string;
  /** Replaces the whole `--version` output when set. */
  versionOutput?: string;
  /** The Hub core version it reports (`discovery.coreVersion`, `/health`). */
  coreVersion: string;
  /** `history update`: persist the title (default), exit non-zero, or never return. */
  renameBehaviour?: 'persist' | 'fail' | 'hang';
  /**
   * Whether the Hub answers the `run.start` of a run that was aborted. Measured Cline never does (the abort is
   * announced as `run.aborted` and the request is simply left open); `'aborted'` is the courteous Hub.
   */
  abortReply?: 'none' | 'aborted';
  /** Characters per `assistant.delta` (default: the whole answer in one delta; real Cline sends many small ones). */
  deltaSize?: number;
}

export interface ClineControlCommand {
  op: 'release' | 'prepareCreate' | 'failNext' | 'health' | 'exit' | 'foreignRun' | 'sessionStatus' | 'discovery' | 'append' | 'rewrite';
  [field: string]: unknown;
}

/** The measured document shapes, shared with the test side so the two can never disagree. */
export const clineMessagesFile = (sessionId: string, messages: Json[], updatedAt = new Date().toISOString()): Json => ({
  version: 1,
  agent: 'lead',
  sessionId,
  origin: { source: 'cosyncing', mode: 'user', sessionId },
  updated_at: updatedAt,
  messages,
});

if (import.meta.main) {
  const state = typeof FAKE_CLINE_STATE === 'string' ? FAKE_CLINE_STATE : '';
  const ledgerPath = join(state, 'ledger.jsonl');
  const commandsDir = join(state, 'commands');
  const readConfig = (): FakeClineConfig => JSON.parse(readFileSync(join(state, 'config.json'), 'utf8'));
  const record = (entry: Record<string, unknown>): void =>
    appendFileSync(ledgerPath, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`);
  const argv = process.argv.slice(2);

  /** Replaced whole, never rewritten in place: a reader may open it at any time. */
  const writeAtomic = (path: string, text: string, mode?: number): void => {
    mkdirSync(dirname(path), { recursive: true, ...(mode === undefined ? {} : { mode: 0o700 }) });
    const pending = `${path}.${process.pid}.tmp`;
    writeFileSync(pending, text, mode === undefined ? undefined : { mode });
    renameSync(pending, path);
  };

  const hubMain = (): void => {
    const config = readConfig();
    const host = process.env.CLINE_HUB_HOST ?? '127.0.0.1';
    const port = Number(process.env.CLINE_HUB_PORT ?? 0);
    const pathname = process.env.CLINE_HUB_PATHNAME ?? '/hub';
    const discoveryPath = process.env.CLINE_HUB_DISCOVERY_PATH ?? '';
    const dataDir = process.env.CLINE_DATA_DIR ?? '';
    const hubId = `hub-${crypto.randomUUID()}`;
    const authToken = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    const startedAt = new Date().toISOString();
    const url = `ws://${host}:${port}${pathname}`;
    let draining = false;
    let healthOverride: { status?: number; body?: Json } | undefined;
    let nextSessionId: string | undefined;
    let sequence = 0;
    let runCounter = 0;
    const failNext = new Map<string, string>();
    const sockets = new Set<any>();

    interface Session {
      id: string;
      cwd: string;
      provider: string;
      model: string;
      status: 'idle' | 'running';
      messages: Json[];
      metadata: Json;
      startedAt: string;
      run?: {
        reply: (payload: Json) => void;
        fail: (code: string, message: string) => void;
        resolve: (outcome: 'completed' | 'aborted') => void;
        prompt: string;
        socket: any;
      };
    }
    const sessions = new Map<string, Session>();
    const sessionDir = (id: string) => join(dataDir, 'sessions', id);
    const metadataPath = (id: string) => join(sessionDir(id), `${id}.json`);
    const messagesPath = (id: string) => join(sessionDir(id), `${id}.messages.json`);

    const persistMetadata = (session: Session): void => {
      // A title written by `history update` (another process) is the durable truth; keep it.
      try {
        const onDisk = JSON.parse(readFileSync(metadataPath(session.id), 'utf8'));
        if (typeof onDisk?.metadata?.title === 'string') session.metadata.title = onDisk.metadata.title;
      } catch { /* first write */ }
      writeAtomic(metadataPath(session.id), `${JSON.stringify({
        session_id: session.id,
        cwd: session.cwd,
        provider: session.provider,
        model: session.model,
        started_at: session.startedAt,
        status: session.status,
        pid: process.pid,
        metadata: session.metadata,
      })}\n`);
    };
    const persistMessages = (session: Session): void => {
      writeAtomic(messagesPath(session.id), `${JSON.stringify(clineMessagesFile(session.id, session.messages))}\n`);
    };

    // A session an earlier Hub left in this profile: adopted as it is (idle: nothing survives a Hub's death).
    const adopt = (): void => {
      let ids: string[] = [];
      try { ids = readdirSync(join(dataDir, 'sessions')); } catch { return; }
      for (const id of ids) {
        try {
          const meta = JSON.parse(readFileSync(metadataPath(id), 'utf8'));
          const file = JSON.parse(readFileSync(messagesPath(id), 'utf8'));
          const session: Session = {
            id, cwd: meta.cwd, provider: meta.provider, model: meta.model, status: 'idle',
            messages: file.messages ?? [], metadata: meta.metadata ?? {}, startedAt: meta.started_at,
          };
          sessions.set(id, session);
          persistMetadata(session);
        } catch {
          // Not a session of ours.
        }
      }
    };

    const event = (name: string, sessionId: string | undefined, payload: Json = {}): void => {
      sequence += 1;
      const frame = JSON.stringify({
        kind: 'event',
        envelope: {
          version: 'v1', event: name, eventId: `evt-${sequence}`, sequence,
          ...(sessionId ? { sessionId } : {}), timestamp: Date.now(), payload,
        },
      });
      for (const socket of sockets) {
        try { socket.send(frame); } catch { sockets.delete(socket); }
      }
    };

    const releasePath = (tag: string) => join(state, 'control', `release-${tag}`);
    const until = async (probe: () => boolean): Promise<void> => {
      while (!probe()) await new Promise((resolve) => setTimeout(resolve, 20));
    };

    const drain = (): void => {
      if (!existsSync(commandsDir)) return;
      for (const name of readdirSync(commandsDir).filter((file) => file.endsWith('.json')).sort()) {
        const path = join(commandsDir, name);
        let command: ClineControlCommand;
        try { command = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
        rmSync(path, { force: true });
        record({ ...command, kind: 'control' });
        if (command.op === 'prepareCreate') nextSessionId = command.id ? String(command.id) : undefined;
        else if (command.op === 'failNext') failNext.set(String(command.command), String(command.code ?? 'command_failed'));
        else if (command.op === 'health') healthOverride = command.clear === true ? undefined : { status: command.status as number | undefined, body: command.body as Json | undefined };
        else if (command.op === 'discovery') {
          // A discovery document another process would leave: rewritten as the test says, or removed.
          if (command.remove === true) rmSync(discoveryPath, { force: true });
          else writeAtomic(discoveryPath, `${JSON.stringify({ ...discovery(), ...(command.patch as Json ?? {}) })}\n`, 0o600);
        } else if (command.op === 'foreignRun') {
          const session = sessions.get(String(command.id));
          if (session) {
            session.status = 'running';
            persistMetadata(session);
            event('run.started', session.id, { clientId: 'foreign-client', runId: 'foreign-run' });
          }
        } else if (command.op === 'sessionStatus') {
          const session = sessions.get(String(command.id));
          if (session) {
            session.status = command.status === 'running' ? 'running' : 'idle';
            persistMetadata(session);
          }
        } else if (command.op === 'append') {
          // A turn another client (or a terminal) wrote into the session: durable state, in memory and on disk.
          const session = sessions.get(String(command.id));
          if (session) {
            for (const row of (command.rows as Json[] | undefined) ?? []) session.messages.push(row);
            persistMessages(session);
            persistMetadata(session);
            // Another client's run (a second Cline attached to the same Hub) is announced; a plain edit is not.
            if (command.announce === true) event('run.started', session.id, { clientId: 'foreign-client', runId: 'foreign-run' });
          }
        } else if (command.op === 'rewrite') {
          const session = sessions.get(String(command.id));
          const first = session?.messages.find((row) => row.role === 'user');
          if (session && first) {
            first.content = [{ type: 'text', text: String(command.text ?? 'rewritten first prompt') }];
            persistMessages(session);
          }
        } else if (command.op === 'exit') {
          record({ kind: 'hub-exit', reason: 'crash' });
          process.exit(Number(command.code ?? 1));
        }
      }
    };

    const discovery = (): Json => ({
      hubId,
      protocolVersion: 'v1',
      capabilities: ['session.create', 'session.run', 'session.abort', 'run.enqueue', 'run.list', 'stream.replay', 'approval.respond'],
      coreVersion: config.coreVersion,
      authToken,
      host,
      port,
      url,
      pid: process.pid,
      startedAt,
      updatedAt: new Date().toISOString(),
    });

    const assistantRow = (text: string, provider: string, model: string): Json => ({
      id: `assistant-${process.pid}-${runCounter}`,
      role: 'assistant',
      ts: Date.now(),
      modelInfo: { provider: provider, id: model },
      content: [{ type: 'text', text }],
      metrics: { inputTokens: 11, outputTokens: 7 },
    });

    const runTurn = async (session: Session, socket: any, envelope: Json): Promise<void> => {
      const payload = envelope.payload as Json;
      const prompt = String(payload.prompt);
      runCounter += 1;
      const run = runCounter;
      const hold = /\[\[hold:([^\]]+)\]\]/.exec(prompt)?.[1];
      const visible = prompt.replaceAll(/\[\[[^\]]*\]\]\s*/g, '').trim();
      const reply = (result: Json) => socket.send(JSON.stringify({
        kind: 'reply', envelope: { version: 'v1', requestId: envelope.requestId, ok: true, payload: result },
      }));
      const fail = (code: string, message: string) => socket.send(JSON.stringify({
        kind: 'reply', envelope: { version: 'v1', requestId: envelope.requestId, ok: false, error: { code, message } },
      }));
      session.messages.push({
        id: `user-${process.pid}-${run}`, role: 'user', ts: Date.now(),
        content: [{ type: 'text', text: `<user_input mode="${payload.mode === 'plan' ? 'plan' : 'act'}">${prompt}</user_input>` }],
      });
      session.status = 'running';
      persistMessages(session);
      persistMetadata(session);
      event('run.started', session.id, { clientId: envelope.clientId, runId: `run-${run}` });
      record({ kind: 'run-started', sessionId: session.id, text: prompt });
      let aborted = false;
      let note = '';
      let outcome: (value: 'completed' | 'aborted') => void = () => undefined;
      const settled = new Promise<'completed' | 'aborted'>((resolve) => { outcome = resolve; });
      session.run = {
        reply, fail, prompt, socket,
        resolve: (value) => { aborted = value === 'aborted'; outcome(value); },
      };
      const wait = <T>(gate: Promise<T>) => Promise.race([gate, settled]);
      if (hold) await wait(until(() => aborted || existsSync(releasePath(hold))));
      if (prompt.includes('[[permission]]') && !aborted) {
        const approvalId = `permission-${run}`;
        event('approval.requested', session.id, {
          approvalId, toolCallId: `tool-${run}`, toolName: 'write_to_file', inputJson: '{"path":"fixture.txt"}', policy: 'ask',
        });
        const decision = await wait(new Promise<{ approved: boolean }>((resolve) => pendingApprovals.set(approvalId, resolve)));
        if (typeof decision === 'string') aborted = true;
        else note = ` (permission ${decision.approved ? 'approve' : 'reject'})`;
      }
      if (prompt.includes('[[error]]') && !aborted) {
        session.status = 'idle';
        persistMetadata(session);
        persistMessages(session);
        event('run.failed', session.id, { reason: 'error', error: 'model exploded', text: 'model exploded', snapshot: { sessionId: session.id } });
        session.run = undefined;
        fail('command_failed', 'model exploded');
        record({ kind: 'run-end', sessionId: session.id, text: prompt, how: 'failed' });
        return;
      }
      if (aborted) {
        session.status = 'idle';
        persistMetadata(session);
        persistMessages(session);
        session.run = undefined;
        event('run.aborted', session.id, { reason: 'aborted', snapshot: { sessionId: session.id } });
        if (readConfig().abortReply === 'aborted') reply({ result: { finishReason: 'aborted' } });
        record({ kind: 'run-end', sessionId: session.id, text: prompt, how: 'aborted' });
        return;
      }
      const answer = `answer: ${visible}${note}`;
      session.messages.push(assistantRow(answer, session.provider, session.model));
      session.status = 'idle';
      persistMessages(session);
      persistMetadata(session);
      // One delta by default; `deltaSize` makes it the many small ones a real model streams.
      const size = readConfig().deltaSize ?? 0;
      for (const chunk of size > 0 ? answer.match(new RegExp(`.{1,${size}}`, 'gsu')) ?? [] : [answer]) event('assistant.delta', session.id, { text: chunk });
      event('usage.updated', session.id, { totals: { inputTokens: 11, outputTokens: 7 } });
      event('run.completed', session.id, { reason: 'completed', snapshot: { sessionId: session.id } });
      session.run = undefined;
      reply({ result: { finishReason: 'completed', text: answer } });
      record({ kind: 'run-end', sessionId: session.id, text: prompt, how: 'completed' });
    };
    const pendingApprovals = new Map<string, (decision: { approved: boolean }) => void>();

    const handleCommand = async (socket: any, envelope: Json): Promise<void> => {
      drain();
      const command = String(envelope.command);
      const payload = (envelope.payload ?? {}) as Json;
      record({ kind: 'command', command, sessionId: envelope.sessionId ?? payload.sessionId ?? null, clientId: envelope.clientId, payload });
      const reply = (result: Json = {}) => socket.send(JSON.stringify({
        kind: 'reply', envelope: { version: 'v1', requestId: envelope.requestId, ok: true, payload: result },
      }));
      const fail = (code: string, message: string) => socket.send(JSON.stringify({
        kind: 'reply', envelope: { version: 'v1', requestId: envelope.requestId, ok: false, error: { code, message } },
      }));
      const injected = failNext.get(command);
      if (injected) {
        failNext.delete(command);
        fail(injected, `fixture failed ${command}`);
        return;
      }
      if (command === 'client.register') return reply({ clientId: payload.clientId });
      if (command === 'client.unregister') return reply({ clientId: envelope.clientId });
      if (command === 'session.create') {
        const id = nextSessionId ?? `${Date.now()}_${crypto.randomUUID().replaceAll('-', '').slice(0, 5)}`;
        nextSessionId = undefined;
        const selection = (payload.modelSelection ?? {}) as Json;
        const session: Session = {
          id,
          cwd: String(payload.cwd ?? payload.workspaceRoot ?? ''),
          provider: String(selection.provider ?? payload.sessionConfig?.providerId ?? ''),
          model: String(selection.model ?? payload.sessionConfig?.modelId ?? ''),
          status: 'idle',
          messages: [],
          metadata: {
            ...(payload.metadata ?? {}),
            autoApproveTools: payload.runtimeOptions?.autoApproveTools === true,
            mode: payload.runtimeOptions?.mode ?? 'act',
          },
          startedAt: new Date().toISOString(),
        };
        sessions.set(id, session);
        persistMessages(session);
        persistMetadata(session);
        reply({ session: { sessionId: id }, snapshot: { sessionId: id } });
        event('session.created', id, { session: { sessionId: id } });
        return;
      }
      const sessionId = String(envelope.sessionId ?? payload.sessionId ?? '');
      const session = sessions.get(sessionId);
      if (command === 'session.messages') {
        if (!session) return fail('not_found', 'no such session');
        return reply({ sessionId, messages: structuredClone(session.messages) });
      }
      if (command === 'session.get') {
        if (!session) return fail('not_found', 'no such session');
        return reply({ session: { sessionId, status: session.status, metadata: session.metadata } });
      }
      if (command === 'session.update') {
        // Measured: acknowledged, and neither `session.get` nor the durable metadata change (title writes escalate to `history update`).
        return reply({ updated: true, session: { sessionId, metadata: payload.metadata } });
      }
      if (command === 'session.delete') {
        sessions.delete(sessionId);
        rmSync(sessionDir(sessionId), { recursive: true, force: true });
        return reply({ deleted: true });
      }
      if (command === 'run.start') {
        if (!session) return fail('not_found', 'no such session');
        void runTurn(session, socket, envelope);
        return;
      }
      if (command === 'run.abort') {
        reply({ aborted: true });
        if (session?.run) {
          session.run.resolve('aborted');
          record({ kind: 'abort', sessionId });
        }
        // Whatever the run was waiting for is over too.
        for (const [id, resolve] of pendingApprovals) {
          pendingApprovals.delete(id);
          resolve({ approved: false });
        }
        return;
      }
      if (command === 'approval.respond') {
        const resolve = pendingApprovals.get(String(payload.approvalId));
        reply({ approvalId: payload.approvalId, approved: payload.approved });
        event('approval.resolved', session?.id ?? sessionId, { approvalId: payload.approvalId, approved: payload.approved });
        if (resolve) {
          pendingApprovals.delete(String(payload.approvalId));
          resolve({ approved: payload.approved === true });
        }
        return;
      }
      if (command === 'capability.respond') return reply({ accepted: true });
      record({ kind: 'unimplemented', command });
      fail('unknown_command', `unsupported ${command}`);
    };

    adopt();
    drain();
    const server = Bun.serve({
      hostname: host,
      port,
      idleTimeout: 0,
      fetch(request, serverRef) {
        drain();
        const requestUrl = new URL(request.url);
        if (requestUrl.pathname === '/health') {
          record({ kind: 'health' });
          if (healthOverride) return Response.json(healthOverride.body ?? { ok: false }, { status: healthOverride.status ?? 200 });
          return Response.json({ ok: true, draining, protocolVersion: 'v1', coreVersion: config.coreVersion, host, port, url });
        }
        if (requestUrl.pathname === pathname) {
          const protocols = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((value) => value.trim());
          if (!protocols.includes(`cline-hub-auth.${authToken}`)) {
            record({ kind: 'rejected', reason: 'auth' });
            return new Response('unauthorized', { status: 401 });
          }
          const upgraded = serverRef.upgrade(request, {
            headers: { 'sec-websocket-protocol': `cline-hub-auth.${authToken}` },
            data: undefined,
          });
          return upgraded ? undefined : new Response('upgrade failed', { status: 400 });
        }
        record({ kind: 'unimplemented', path: requestUrl.pathname });
        return new Response('not found', { status: 404 });
      },
      websocket: {
        open(socket) {
          sockets.add(socket);
          record({ kind: 'socket-open' });
        },
        close(socket) {
          sockets.delete(socket);
        },
        message(socket, raw) {
          let frame: Json;
          try { frame = JSON.parse(String(raw)); } catch { return; }
          if (frame.kind === 'stream.subscribe') {
            record({ kind: 'subscribe', clientId: frame.clientId, sinceSequence: frame.sinceSequence ?? null });
            return;
          }
          if (frame.kind === 'command' && frame.envelope) void handleCommand(socket, frame.envelope);
        },
      },
    });
    // The port was asked for explicitly; `0` leases one and the document names the real one.
    const bound = server.port ?? port;
    writeAtomic(discoveryPath, `${JSON.stringify({ ...discovery(), port: bound, url: `ws://${host}:${bound}${pathname}` })}\n`, 0o600);
    if (process.platform !== 'win32') chmodSync(discoveryPath, 0o600);
    record({
      kind: 'hub-started',
      hubId,
      port: bound,
      host,
      pathname,
      discoveryPath,
      dataDir,
      cwd: process.cwd(),
      argv,
      env: {
        CLINE_NO_AUTO_UPDATE: process.env.CLINE_NO_AUTO_UPDATE ?? null,
        CLINE_RUN_AS_HUB_DAEMON: process.env.CLINE_RUN_AS_HUB_DAEMON ?? null,
        CLINE_HUB_PORT: process.env.CLINE_HUB_PORT ?? null,
        CLINE_HUB_HOST: process.env.CLINE_HUB_HOST ?? null,
        CLINE_SESSION_DATA_DIR: process.env.CLINE_SESSION_DATA_DIR ?? null,
        CLINE_DATA_DIR: process.env.CLINE_DATA_DIR ?? null,
      },
    });
    const timer = setInterval(drain, 20);
    const stop = (reason: string) => {
      clearInterval(timer);
      draining = true;
      record({ kind: 'hub-exit', reason });
      try { rmSync(discoveryPath, { force: true }); } catch { /* best effort */ }
      server.stop(true);
      process.exit(0);
    };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));
  };

  if (argv[0] === '--version') {
    const config = readConfig();
    record({
      kind: 'version-probe',
      argv,
      autoUpdateDisabled: process.env.CLINE_NO_AUTO_UPDATE ?? null,
      hubLaunchControls: ['CLINE_RUN_AS_HUB_DAEMON', 'CLINE_HUB_HOST', 'CLINE_HUB_PORT', 'CLINE_HUB_PATHNAME', 'CLINE_HUB_ADDRESS', 'CLINE_HUB_DISCOVERY_PATH']
        .filter((name) => process.env[name] !== undefined),
    });
    process.stdout.write(config.versionOutput ?? `${config.version}\n`);
  } else if (process.env.CLINE_RUN_AS_HUB_DAEMON === '1') {
    hubMain();
  } else if (argv[0] === 'history' && argv[1] === 'update') {
    const option = (name: string): string | undefined => {
      const index = argv.indexOf(name);
      return index >= 0 ? argv[index + 1] : undefined;
    };
    const config = readConfig();
    const sessionId = option('--session-id') ?? '';
    const title = option('--title') ?? '';
    record({
      kind: 'history-update',
      argv,
      sessionId,
      title,
      dataDir: process.env.CLINE_DATA_DIR ?? null,
      hubLaunchControls: ['CLINE_RUN_AS_HUB_DAEMON', 'CLINE_HUB_PORT'].filter((name) => process.env[name] !== undefined),
    });
    if (config.renameBehaviour === 'fail') process.exit(1);
    if (config.renameBehaviour === 'hang') {
      process.on('SIGTERM', () => process.exit(143));
      setInterval(() => undefined, 1 << 30);
      await new Promise(() => undefined);
    }
    const path = join(process.env.CLINE_DATA_DIR ?? '', 'sessions', sessionId, `${sessionId}.json`);
    const meta = JSON.parse(readFileSync(path, 'utf8'));
    meta.metadata = { ...(meta.metadata ?? {}), title };
    writeAtomic(path, `${JSON.stringify(meta)}\n`);
  } else {
    record({ kind: 'unimplemented', argv });
    process.stderr.write(`fake cline: unsupported ${argv.join(' ')}\n`);
    process.exit(2);
  }
}
