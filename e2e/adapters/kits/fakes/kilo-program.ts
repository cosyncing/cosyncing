/**
 * The fake `kilo` executable (compiled by the kit with `bun build --compile`, so `/proc/<pid>/exe` names it: the
 * broker's ownership proof for a serve it launched compares real process identity).
 *
 *   kilo --version     what `config.json` says (`versionOutput` replaces the whole line)
 *   kilo serve …       Kilo's HTTP/SSE server on `--port`, behind HTTP Basic auth (`KILO_SERVER_USERNAME` /
 *                      `KILO_SERVER_PASSWORD`), backed by the SQLite store in `config.dataDir`
 *
 * The serve is `FakeOpenCodeServe` (Kilo's wire is OpenCode's) with two additions that make it Kilo: every
 * request needs the credential, and every change is written to `kilo.db` before it reaches the event bus.
 * Sessions a test writes into the database (a terminal's work, a seeded roster) are picked up on the next
 * request or control command; what the test cannot do from outside (release a held turn, announce a row, fail
 * the next write, crash) arrives as a command file in `<state>/commands/`, applied before any later request.
 *
 * Run as a script (a doctor variant that only answers `--version`) its config is `<argv[1]>.json`; compiled,
 * the state directory is defined at build time (`FAKE_KILO_STATE`). Everything observable is appended to the
 * ledger.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FakeOpenCodeServe } from './opencode-serve.ts';
import { KiloDb, type KiloRow } from './kilo-store.ts';

declare const FAKE_KILO_STATE: string;

export interface FakeKiloConfig {
  version: string;
  /** Replaces the whole `--version` output when set. */
  versionOutput?: string;
  /** Kilo's data root (the directory holding `kilo.db`). */
  dataDir: string;
  models: Array<{ providerID: string; modelID: string; name: string }>;
  agents: Array<{ name: string; description: string }>;
  commands: Array<{ name: string; description: string }>;
  /** Heartbeat comment interval on the event stream, ms (0 off). */
  heartbeatMs?: number;
}

export interface KiloControlCommand {
  op: 'announce' | 'release' | 'prepareCreate' | 'failNext' | 'noise' | 'exit' | 'setBusy' | 'health' | 'oversize';
  [field: string]: unknown;
}

if (import.meta.main) {
  const state = typeof FAKE_KILO_STATE === 'string' ? FAKE_KILO_STATE : '';
  const configPath = state ? join(state, 'config.json') : `${process.argv[1]}.json`;
  const ledgerPath = state ? join(state, 'ledger.jsonl') : `${process.argv[1]}.ledger.jsonl`;
  const commandsDir = state ? join(state, 'commands') : '';

  const readConfig = (): FakeKiloConfig => JSON.parse(readFileSync(configPath, 'utf8'));
  const record = (entry: Record<string, unknown>): void =>
    appendFileSync(ledgerPath, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`);

  const serveMain = (hostname: string, port: number): void => {
    const config = readConfig();
    const username = process.env.KILO_SERVER_USERNAME ?? '';
    const password = process.env.KILO_SERVER_PASSWORD ?? '';
    const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    const db = new KiloDb(join(config.dataDir, 'kilo.db'));
    const mirrored = new Map<string, string>();
    let version = config.version;
    /** What `/global/health` answers instead of the truth (a status, or a body), until cleared. */
    let health: { status?: number; body?: unknown } | undefined;
    /** Paths whose next GET answers a body beyond the adapter's bound. */
    const oversize = new Set<string>();
    mkdirSync(commandsDir, { recursive: true });

    const rowKey = (sessionId: string, row: KiloRow) => `${sessionId}/${String(row.info.id)}`;

    /** Pull one session from the database into the serve, announcing what is new or changed. */
    const refresh = (id: string, announce: boolean): void => {
      const loaded = db.load(id);
      if (!loaded) return;
      const existing = server.sessions.get(id);
      if (!existing) {
        server.sessions.set(id, { info: loaded.info, rows: loaded.rows as never, busy: false, chain: Promise.resolve() });
        for (const row of loaded.rows) mirrored.set(rowKey(id, row), JSON.stringify(row));
        mirrored.set(id, JSON.stringify(loaded.info));
        return;
      }
      for (const row of loaded.rows) {
        const key = rowKey(id, row);
        const encoded = JSON.stringify(row);
        if (mirrored.get(key) === encoded) continue;
        mirrored.set(key, encoded);
        const at = existing.rows.findIndex((candidate) => candidate.info.id === row.info.id);
        if (at >= 0) existing.rows[at] = row as never;
        else existing.rows.push(row as never);
        if (announce) {
          server.publish({ type: 'message.updated', properties: { sessionID: id, info: { ...row.info, sessionID: id } } });
          for (const part of row.parts) {
            server.publish({ type: 'message.part.updated', properties: { sessionID: id, part: { ...part, sessionID: id, messageID: row.info.id } } });
          }
        }
      }
      existing.info.time = loaded.info.time;
      existing.info.title = loaded.info.title;
    };

    /**
     * Tell the serve's clients about rows a terminal wrote. The rows travel in the command: the serve never reads
     * the database to learn them, because a reader of a WAL database touches its shared-memory index and the
     * broker's own snapshot of the store treats that as a torn read. A session the serve has not loaded has no
     * clients to tell; it is loaded when a request names it.
     */
    const announce = (id: string, rows: KiloRow[] | undefined, updated: number | undefined): void => {
      const existing = server.sessions.get(id);
      if (!existing || !rows) return;
      for (const row of rows) {
        const key = rowKey(id, row);
        mirrored.set(key, JSON.stringify(row));
        const at = existing.rows.findIndex((candidate) => candidate.info.id === row.info.id);
        if (at >= 0) existing.rows[at] = row as never;
        else existing.rows.push(row as never);
        server.publish({ type: 'message.updated', properties: { sessionID: id, info: { ...row.info, sessionID: id } } });
        for (const part of row.parts) {
          server.publish({ type: 'message.part.updated', properties: { sessionID: id, part: { ...part, sessionID: id, messageID: row.info.id } } });
        }
      }
      if (updated !== undefined) {
        existing.info.time = { ...existing.info.time, updated };
        mirrored.set(id, JSON.stringify(existing.info));
      }
    };

    const loadNew = (): void => {
      for (const id of db.sessionIds()) if (!server.sessions.has(id)) refresh(id, false);
    };

    /** Write every change the serve made to the database (rows first, then the session row). */
    const mirror = (): void => {
      for (const [id, session] of server.sessions) {
        let dirty = false;
        for (const row of session.rows) {
          const key = rowKey(id, row as KiloRow);
          const encoded = JSON.stringify(row);
          if (mirrored.get(key) === encoded) continue;
          db.putRow(id, row as KiloRow);
          mirrored.set(key, encoded);
          dirty = true;
        }
        const info = JSON.stringify(session.info);
        if (dirty || mirrored.get(id) !== info) {
          db.putSession(session.info);
          mirrored.set(id, info);
        }
      }
    };

    const drain = (): void => {
      if (!existsSync(commandsDir)) return;
      for (const name of readdirSync(commandsDir).filter((file) => file.endsWith('.json')).sort()) {
        const path = join(commandsDir, name);
        let command: KiloControlCommand;
        try {
          command = JSON.parse(readFileSync(path, 'utf8'));
        } catch {
          continue;
        }
        rmSync(path, { force: true });
        record({ ...command, kind: 'control' });
        if (command.op === 'announce') announce(String(command.id), command.rows as KiloRow[] | undefined, command.updated as number | undefined);
        else if (command.op === 'release') server.release(String(command.tag));
        else if (command.op === 'prepareCreate') server.prepareCreate(command.id ? String(command.id) : undefined);
        else if (command.op === 'failNext') server.failNext(String(command.method), Number(command.status));
        else if (command.op === 'noise') server.noise(String(command.id));
        else if (command.op === 'setBusy') server.setBusy(String(command.id), command.busy === true);
        else if (command.op === 'health') health = command.clear === true ? undefined : { status: command.status as number | undefined, body: command.body };
      else if (command.op === 'oversize') oversize.add(String(command.path));
      else if (command.op === 'exit') {
          record({ kind: 'serve-exit', reason: 'crash' });
          process.exit(Number(command.code ?? 1));
        }
      }
      const next = readConfig();
      if (next.version !== version) {
        version = next.version;
        server.setVersion(version);
      }
    };

    const server = new FakeOpenCodeServe({
      record,
      version,
      models: config.models,
      agents: config.agents,
      commands: config.commands,
      // Milliseconds, not seconds: a serve hands out several ids a second, so a replacement started a second or
      // two after its predecessor reused their message ids and wrote a new turn over a settled one.
      sequenceStart: Date.now(),
      emitSessionIdle: true,
      onPublish: mirror,
      intercept: async (request, next) => {
        drain();
        const url = new URL(request.url);
        const credential = request.headers.get('authorization');
        if (credential !== expected) {
          record({ kind: 'rejected', method: request.method, path: url.pathname, credential: credential ? 'wrong' : 'missing' });
          return Response.json({ name: 'Unauthorized', data: { message: 'authentication required' } }, {
            status: 401,
            headers: { 'www-authenticate': 'Basic realm="kilo"' },
          });
        }
        if (url.pathname === '/global/health' && health) {
          record({ kind: 'health-override', status: health.status ?? 200 });
          return Response.json(health.body ?? { healthy: true, version }, { status: health.status ?? 200 });
        }
        if (request.method === 'GET' && oversize.delete(url.pathname)) {
          record({ kind: 'oversize', path: url.pathname });
          return Response.json({ padding: 'x'.repeat(9 * 1024 * 1024) });
        }
        // The database is read only when the request needs a session the serve has not loaded yet (or lists them):
        // a reader of a WAL database touches its shared-memory index, and the broker's own snapshot of the store
        // treats a changed sidecar as a torn read. A serve that polled the file on every request would make the
        // broker's reads fail at random.
        const named = /^\/session\/([^/]+)/.exec(url.pathname)?.[1];
        if ((named !== undefined && !server.sessions.has(named)) || (url.pathname === '/session' && request.method === 'GET')) loadNew();
        // Kilo answers a permission on `/session/:id/permissions/:permissionID` with `{ response }`; the shared
        // serve knows the newer `/permission/:id/reply`. Same request, translated, and recorded as Kilo's route.
        const permission = /^\/session\/([^/]+)\/permissions\/([^/]+)$/.exec(url.pathname);
        let routed = request;
        if (permission && request.method === 'POST') {
          const body = await request.json().catch(() => ({})) as { response?: string };
          record({ kind: 'permission-route', path: url.pathname, response: body.response ?? null });
          routed = new Request(`${url.origin}/permission/${permission[2]}/reply`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reply: body.response }),
          });
        }
        const response = await next(routed);
        mirror();
        return response;
      },
    });
    loadNew();
    mirror();
    server.start(port);
    if ((config.heartbeatMs ?? 1000) > 0) server.setHeartbeat(config.heartbeatMs ?? 1000);
    record({
      kind: 'serve-started',
      hostname,
      port: server.port,
      version,
      dataDir: config.dataDir,
      cwd: process.cwd(),
      credential: { username, passwordLength: password.length },
      autoUpdateDisabled: process.env.KILO_DISABLE_AUTOUPDATE ?? null,
    });
    const timer = setInterval(drain, 20);
    const stop = (reason: string) => {
      clearInterval(timer);
      record({ kind: 'serve-exit', reason });
      server.releaseAll();
      server.stop();
      db.close();
      process.exit(0);
    };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));
  };

  const argv = process.argv.slice(2);
  if (argv[0] === '--version') {
    const config = readConfig();
    record({ kind: 'version-probe', argv, autoUpdateDisabled: process.env.KILO_DISABLE_AUTOUPDATE ?? null });
    process.stdout.write(config.versionOutput ?? `kilo ${config.version}\n`);
  } else if (argv[0] === 'serve') {
    const option = (name: string): string | undefined => {
      const index = argv.indexOf(name);
      return index >= 0 ? argv[index + 1] : undefined;
    };
    record({ kind: 'cli', argv });
    serveMain(option('--hostname') ?? '127.0.0.1', Number(option('--port') ?? '4097'));
  } else {
    record({ kind: 'unimplemented', argv });
    process.stderr.write(`fake kilo: unsupported ${argv.join(' ')}\n`);
    process.exit(2);
  }
}
