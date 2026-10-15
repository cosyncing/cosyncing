/**
 * A fake `opencode` CLI, one self-contained file (node builtins only), installed into `paths.bin` by
 * `installFakeExecutable` (kit.ts). Its config is `<argv[1]>.json`.
 *
 *   opencode --version        the configured version (or `versionOutput`), guard variable recorded
 *   opencode run …            the private Drive child: `--format json` events on stdout, scripted by
 *                             the prompt text (`[[hold:TAG]]` waits for `release-TAG` in `controlDir`)
 *   anything else             recorded and refused (exit 2)
 *
 * The serve itself is `fakes/opencode-serve.ts`, in the test process: the CLI never listens.
 * `run` persists the continuation into OpenCode's own store (`storeLayout`: the sqlite `opencode.db` of
 * current builds, or the older `storage/**.json` tree), so a reader sees the turn there afterwards.
 *
 * Every invocation is appended to the ledger (`kind: cli | spawn | exit | signal | ...`).
 *
 * Run as a program it is the fake CLI; imported, it only exports `OpencodeStore`, the writer the test
 * side seeds sessions with, so the test and the fake can never disagree on the store layout.
 */
import { Database } from 'bun:sqlite';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface FakeOpencodeCliConfig {
  ledger: string;
  controlDir: string;
  version: string;
  versionOutput?: string;
  /** Where `run` persists the turn: the data directory (the one holding `storage/` or `opencode.db`) and its layout. */
  store?: { dataDir: string; layout: StoreLayout };
}

export type StoreLayout = 'sqlite' | 'json';

type Json = Record<string, any>;

/** OpenCode's session store, in either layout the adapter reads. */
export class OpencodeStore {
  readonly dataDir: string;
  readonly layout: StoreLayout;
  #db: Database | undefined;

  constructor(dataDir: string, layout: StoreLayout) {
    this.dataDir = dataDir;
    this.layout = layout;
    mkdirSync(join(dataDir, 'storage', 'session'), { recursive: true });
    if (layout === 'sqlite') {
      // Held open for the life of the object, as OpenCode's own process holds its database (WAL).
      this.#db = new Database(join(dataDir, 'opencode.db'));
      this.#db.exec('pragma journal_mode = wal; pragma busy_timeout = 5000;');
      this.#db.exec(`create table if not exists session (id text primary key, parent_id text, slug text, directory text, title text, model text, revert text, time_created integer, time_updated integer, time_archived integer);
        create table if not exists message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
        create table if not exists part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);`);
    }
  }

  close(): void {
    this.#db?.close();
  }

  putSession(session: { id: string; directory: string; title: string; created: number; updated: number; parentID?: string; revert?: string | null; model?: { providerID: string; modelID: string } }): void {
    const model = session.model ? { providerID: session.model.providerID, id: session.model.modelID, modelID: session.model.modelID } : undefined;
    if (this.#db) {
      this.#db.query('insert or replace into session (id, parent_id, slug, directory, title, model, revert, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(session.id, session.parentID ?? null, session.title.toLowerCase().replaceAll(/\W+/g, '-'), session.directory, session.title,
          model ? JSON.stringify(model) : null, session.revert ? JSON.stringify({ messageID: session.revert }) : null, session.created, session.updated);
      return;
    }
    const path = join(this.dataDir, 'storage', 'session', 'proj_e2e', `${session.id}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      id: session.id, slug: session.title.toLowerCase().replaceAll(/\W+/g, '-'), directory: session.directory, title: session.title,
      time: { created: session.created, updated: session.updated },
      ...(session.parentID ? { parentID: session.parentID } : {}),
      ...(session.revert ? { revert: { messageID: session.revert } } : {}),
      ...(model ? { model } : {}),
    }));
  }

  /** Point (or clear) the session's revert pointer and bump its update time. */
  setRevert(sessionId: string, messageId: string | null, updated: number): void {
    if (this.#db) {
      this.#db.query('update session set revert = ?, time_updated = ? where id = ?')
        .run(messageId ? JSON.stringify({ messageID: messageId }) : null, updated, sessionId);
      return;
    }
    for (const project of ['proj_e2e']) {
      const path = join(this.dataDir, 'storage', 'session', project, `${sessionId}.json`);
      const session = JSON.parse(readFileSync(path, 'utf8'));
      if (messageId) session.revert = { messageID: messageId };
      else delete session.revert;
      session.time.updated = updated;
      writeFileSync(path, JSON.stringify(session));
    }
  }

  /** Move the session's update time, as a write to it does. */
  touchSession(sessionId: string, updated: number): void {
    if (this.#db) {
      this.#db.query('update session set time_updated = ? where id = ?').run(updated, sessionId);
      return;
    }
    const path = join(this.dataDir, 'storage', 'session', 'proj_e2e', `${sessionId}.json`);
    const session = JSON.parse(readFileSync(path, 'utf8'));
    session.time.updated = updated;
    writeFileSync(path, JSON.stringify(session));
  }

  putMessage(sessionId: string, info: Json): void {
    const created = Number(info.time?.created ?? 0);
    const updated = Number(info.time?.completed ?? created);
    if (this.#db) {
      const { id, sessionID: _sessionID, ...data } = info;
      this.#db.query('insert or replace into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)')
        .run(id, sessionId, created, updated, JSON.stringify(data));
      return;
    }
    const path = join(this.dataDir, 'storage', 'message', sessionId, `${info.id}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...info, sessionID: sessionId }));
  }

  putPart(sessionId: string, messageId: string, part: Json): void {
    const created = Number(part.time?.start ?? part.time?.created ?? 0);
    const updated = Number(part.time?.end ?? created);
    if (this.#db) {
      const { id, messageID: _messageID, sessionID: _sessionID, ...data } = part;
      this.#db.query('insert or replace into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)')
        .run(id, messageId, sessionId, created, updated, JSON.stringify(data));
      return;
    }
    const path = join(this.dataDir, 'storage', 'part', messageId, `${part.id}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...part, sessionID: sessionId, messageID: messageId }));
  }
}


async function main(): Promise<void> {
  const config: FakeOpencodeCliConfig = JSON.parse(readFileSync(`${process.argv[1]}.json`, 'utf8'));
  const argv = process.argv.slice(2);
  const record = (entry: Record<string, unknown>): void =>
    appendFileSync(config.ledger, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`);
  const out = (event: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify(event)}\n`);

  async function run(): Promise<void> {
    const option = (name: string): string | undefined => {
      const index = argv.indexOf(name);
      return index >= 0 ? argv[index + 1] : undefined;
    };
    const sessionId = option('--session') ?? '';
    const cwd = option('--dir') ?? process.cwd();
    const flagged = new Set(['--session', '--format', '--dir', '--model', '--agent', '--file']);
    const text = argv.slice(1).filter((value, index, all) => !value.startsWith('--') && !flagged.has(all[index - 1] ?? '')).join(' ');
    record({ kind: 'spawn', argv, cwd, sessionId, text, autoUpdateDisabled: process.env.OPENCODE_DISABLE_AUTOUPDATE ?? null });
    process.on('SIGTERM', () => {
      record({ kind: 'signal', signal: 'SIGTERM' });
      process.exit(143);
    });
    const hold = /\[\[hold:([^\]]+)\]\]/.exec(text)?.[1];
    if (hold) {
      while (!existsSync(join(config.controlDir, `release-${hold}`))) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const visible = text.replaceAll(/\[\[[^\]]*\]\]\s*/g, '').trim();
    out({ type: 'step_start', sessionID: sessionId, part: { type: 'step-start' } });
    out({ type: 'text', sessionID: sessionId, part: { type: 'text', text: `answer: ${visible}` } });
    out({ type: 'step_finish', sessionID: sessionId, part: { type: 'step-finish', reason: 'stop', tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } });
    if (config.store) {
      // The continuation is durable: the next reader finds this turn in the store.
      const store = new OpencodeStore(config.store.dataDir, config.store.layout);
      const at = Date.now();
      const id = `${at.toString(36)}${crypto.randomUUID().replaceAll('-', '').slice(0, 6)}`;
      store.putMessage(sessionId, { id: `msg_run_${id}_u`, role: 'user', time: { created: at } });
      store.putPart(sessionId, `msg_run_${id}_u`, { id: `prt_run_${id}_u`, type: 'text', text: visible });
      store.putMessage(sessionId, {
        id: `msg_run_${id}_a`, role: 'assistant', parentID: `msg_run_${id}_u`, time: { created: at + 1, completed: at + 2 }, finish: 'stop',
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0,
      });
      store.putPart(sessionId, `msg_run_${id}_a`, { id: `prt_run_${id}_a`, type: 'text', text: `answer: ${visible}`, time: { start: at + 1, end: at + 2 } });
      store.touchSession(sessionId, at + 2);
      store.close();
    }
    record({ kind: 'exit', code: 0 });
  }

  if (argv[0] === '--version') {
    record({ kind: 'version-probe', argv, autoUpdateDisabled: process.env.OPENCODE_DISABLE_AUTOUPDATE ?? null });
    process.stdout.write(config.versionOutput ?? `${config.version}\n`);
  } else if (argv[0] === 'run') {
    await run();
  } else if (argv[0] === 'attach') {
    // A terminal UI joined to a serve: it only has to exist, with this argv, until it is stopped.
    record({ kind: 'attach', argv });
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => undefined, 1 << 30);
    await new Promise(() => undefined);
  } else {
    record({ kind: 'unimplemented', argv });
    process.stderr.write(`fake opencode: unsupported ${argv.join(' ')}\n`);
    process.exit(2);
  }
}

if (import.meta.main) await main();
