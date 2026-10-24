/**
 * The fake `opencode` executable (compiled by `installFakeOpencode`; see opencode.ts).
 *
 * `opencode --version` reports the installed version; `opencode serve` runs an
 * HTTP server with the endpoints a broker reads to list sessions, track their
 * activity and compare versions (`/session`, `/project`, `/session/status`,
 * `/global/event`, `/global/health`), and stops on `/instance/dispose`,
 * `/global/dispose` or SIGTERM. A serve keeps the version it started with, so
 * upgrading the installed version underneath it makes it stale. Sessions and
 * their activity come from a config file the test rewrites; every invocation
 * and serve lifecycle event is appended to a ledger. With `holdServe` a serve
 * starting now waits (ledger `serve-waiting`) and only listens once the test
 * clears it, as a serve that is slow to boot does; `POST /session` creates a
 * session and records `create`.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

declare const FAKE_OPENCODE_STATE: string;

export interface FakeOpencodeConfig {
  installed: string;
  sessions?: Array<{ id: string; title: string; directory: string; busy?: boolean }>;
  /** A serve starting while this is set does not listen until it is cleared. */
  holdServe?: boolean;
  /** Fail once without changing the executable, as a transient first-exec failure does. */
  failFirstVersionProbe?: boolean;
}

const state = FAKE_OPENCODE_STATE;
const config = (): FakeOpencodeConfig => JSON.parse(readFileSync(join(state, 'config.json'), 'utf8'));
const ledger = (entry: Record<string, unknown>): void =>
  appendFileSync(join(state, 'ledger.jsonl'), `${JSON.stringify({ pid: process.pid, at: Date.now(), ...entry })}\n`);

async function serve(hostname: string, port: number): Promise<void> {
  if (config().holdServe) {
    ledger({ kind: 'serve-waiting', port });
    while (config().holdServe) await Bun.sleep(20);
  }
  const version = config().installed;
  const encoder = new TextEncoder();
  const exit = (reason: string): void => {
    ledger({ kind: 'serve-exit', reason });
    process.exit(0);
  };
  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      const sessions = config().sessions ?? [];
      if (request.method === 'POST' && (pathname === '/instance/dispose' || pathname === '/global/dispose')) {
        setTimeout(() => exit(pathname), 10);
        return Response.json(true);
      }
      if (pathname === '/global/health') return Response.json({ healthy: true, version });
      if (pathname === '/session' && request.method === 'POST') {
        const id = `ses_fake_created_${process.pid}_${Date.now().toString(36)}`;
        ledger({ kind: 'create', id });
        const now = Date.now();
        return Response.json({ id, title: 'Created', directory: new URL(request.url).searchParams.get('directory') ?? '', time: { created: now, updated: now } });
      }
      if (pathname === '/session') {
        const now = Date.now();
        return Response.json(sessions.map((session) => ({
          id: session.id,
          title: session.title,
          directory: session.directory,
          time: { created: now - 60_000, updated: now },
        })));
      }
      if (pathname === '/project') return Response.json([]);
      if (pathname === '/session/status') {
        return Response.json(Object.fromEntries(
          sessions.filter((session) => session.busy).map((session) => [session.id, { type: 'busy' }]),
        ));
      }
      if (pathname === '/global/event') {
        let timer: ReturnType<typeof setInterval> | undefined;
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ payload: { type: 'server.connected' } })}\n\n`));
            timer = setInterval(() => controller.enqueue(encoder.encode(': heartbeat\n\n')), 1_000);
          },
          cancel() {
            clearInterval(timer);
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json([], { status: 404 });
    },
  });
  ledger({ kind: 'serve-started', version, port: server.port });
  process.on('SIGTERM', () => exit('SIGTERM'));
}

const args = process.argv.slice(2);
ledger({ kind: 'cli', argv: args });
if (args[0] === '--version') {
  const versionConfig = config();
  const failedProbe = join(state, 'failed-version-probe');
  if (versionConfig.failFirstVersionProbe && !existsSync(failedProbe)) {
    writeFileSync(failedProbe, 'failed');
    process.exit(1);
  }
  process.stdout.write(`${versionConfig.installed}\n`);
  process.exit(0);
}
if (args[0] === 'serve') {
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  void serve(option('--hostname') ?? '127.0.0.1', Number(option('--port') ?? '4096'));
} else {
  process.stderr.write(`fake opencode: unsupported ${args.join(' ')}\n`);
  process.exit(2);
}
