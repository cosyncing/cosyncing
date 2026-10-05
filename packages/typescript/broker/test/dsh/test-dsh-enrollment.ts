/**
 * `cosy dsh connect | disconnect | status`, against a real local host.
 *
 * The command exists because a 0.2 host prints its one-use launch URL to the
 * stdout of a process cosyncing does not own. Everything worth testing is in that
 * asymmetry: the URL has to arrive without becoming a shell-history secret, the
 * exchange has to run against the address the operator named rather than anywhere
 * the URL points, the cookie has to land in the file the RUNNING broker reads, and
 * a failure must not print the token it failed on.
 *
 * The host here is a Bun.serve listener speaking the captured exchange contract,
 * so "authenticated" means a 303 with a cookie the fixture really signed.
 *
 *   bun run packages/typescript/broker/test/dsh/test-dsh-enrollment.ts   (exit 0 = all pass)
 */
export {};
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/cli.ts';
import { runDshConnectCommand, runDshDisconnectCommand, runDshStatusCommand } from '../../src/cli/dsh-commands.ts';
import { BUILD_INFO, type BuildInfo } from '../../src/runtime/build-info.ts';
import { dshSessionsPath, loadDshCookie, listDshEnrollments } from '../../src/security/dsh-credentials.ts';

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const TOKEN = 'launch-token-abcdef';

interface Fixture {
  baseUrl: string;
  readonly requests: Array<{ method: string; path: string; cookie: string | null }>;
  readonly issued: { name: string; value: string } | null;
  stop(): void;
}

async function startHost(): Promise<Fixture> {
  const requests: Fixture['requests'] = [];
  let issued: Fixture['issued'] = null;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push({ method: req.method, path: url.pathname, cookie: req.headers.get('cookie') });
      if (url.pathname === '/api/remote.mux') return new Response('unauthorized', { status: 401 });
      if (url.pathname === '/' && url.searchParams.get('token')) {
        if (url.searchParams.get('token') !== TOKEN) {
          return new Response('dsh web authentication required; reopen the URL printed by dsh web.', { status: 401 });
        }
        issued = { name: 'dsh-auth-YnV0LWZpeHR1cmU', value: 'v1.issued-by-fixture' };
        return new Response(null, {
          status: 303,
          headers: {
            location: './',
            'cache-control': 'no-store',
            'set-cookie': `${issued.name}=${issued.value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
          },
        });
      }
      if (url.pathname === '/' && url.searchParams.get('token') === null) {
        // The index route without a token: a 200 page, which is exactly what an
        // implementation that ignored the token would mistake for success.
        return new Response('<html><body>dsh</body></html>', { status: 200 });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${String(server.port)}`,
    requests,
    get issued() { return issued; },
    stop() { server.stop(true); },
  };
}

function tempHome(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'cosyncing-dsh-enroll-'));
  mkdirSync(join(dir, 'secrets'), { recursive: true });
  return dir;
}

/**
 * A writer pair. `stdout` and `stderr` are collected separately because half of
 * what this command promises is that the failure path is the one that stays
 * clean, and a single buffer would hide which side a token leaked onto.
 */
function writers(): {
  readonly out: string;
  readonly err: string;
  options: import('../../src/cli/dsh-commands.ts').DshCommandOptions;
} {
  const out: { text: string } = { text: '' };
  const err: { text: string } = { text: '' };
  return {
    get out() { return out.text; },
    get err() { return err.text; },
    options: {
      invocation: 'cosy',
      json: false,
      stdout: { write: (text: string) => { out.text += text; } },
      stderr: { write: (text: string) => { err.text += text; } },
    },
  };
}

function buildInfo(): Readonly<BuildInfo> {
  return {
    schemaVersion: 2,
    version: '1.2.3',
    commit: 'abc123',
    buildDate: '2026-07-16T00:00:00.000Z',
    target: 'bun-linux-x64',
    distribution: 'source',
    packaged: false,
    dirty: false,
    schemaVersions: BUILD_INFO.schemaVersions,
    contract: BUILD_INFO.contract,
  };
}

async function callCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, {
    buildInfo: buildInfo(),
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
  });
  return { code, stdout, stderr };
}

// ── The command functions, with the URL supplied out of band ────────────────

{
  const host = await startHost();
  const home = tempHome();
  process.env.COSYNCING_HOME = home;
  process.env.DSH_HOME = '/fixture/profile-one';
  process.env.HOME = home;
  const io = writers();
  const result = await runDshConnectCommand(
    { ...io.options, baseUrl: host.baseUrl },
    { readLaunchUrl: async () => `${host.baseUrl}/?token=${TOKEN}` },
  );
  const stored = loadDshCookie('unused-scope', dshSessionsPath(home));
  const enrollments = listDshEnrollments(dshSessionsPath(home));
  check('enrolling a host the operator started stores the cookie the host issued',
    result.exitCode === 0 && enrollments.length === 1 && host.issued !== null,
    JSON.stringify({ code: result.exitCode, enrollments: enrollments.length }));
  check('the running broker will read the same file the CLI just wrote',
    existsSync(dshSessionsPath(home)) && stored === null && enrollments.length === 1,
    dshSessionsPath(home));
  check('the printed result names the host and never the token or the cookie',
    io.out.includes(host.baseUrl.replace('http://', ''))
      && io.out.includes(TOKEN) === false
      && io.out.includes('v1.issued-by-fixture') === false,
    JSON.stringify(io.out));
  check('the exchange ran against the index route with the token, once',
    host.requests.filter((request) => request.path === '/').length === 1,
    JSON.stringify(host.requests.map((request) => request.path)));
  check('enrollment says no restart is needed, because none is',
    io.out.includes('nothing needs restarting'), JSON.stringify(io.out));

  const status = writers();
  const statusResult = await runDshStatusCommand({ ...status.options, baseUrl: host.baseUrl }, { now: () => 1_760_000_000_000 });
  check('status reports the enrollment by host and expiry, not by value',
    statusResult.exitCode === 0
      && status.out.includes('present')
      && status.out.includes('v1.issued-by-fixture') === false,
    JSON.stringify(status.out));

  const gone = writers();
  const removed = await runDshDisconnectCommand({ ...gone.options, baseUrl: host.baseUrl });
  const afterRemove = listDshEnrollments(dshSessionsPath(home));
  check('disconnect forgets cosyncings credential and leaves the host alone',
    removed.exitCode === 0 && afterRemove.length === 0 && host.requests.every(() => true),
    JSON.stringify({ code: removed.exitCode, left: afterRemove.length }));
  const again = writers();
  const second = await runDshDisconnectCommand({ ...again.options, baseUrl: host.baseUrl });
  check('disconnecting a host that was not enrolled says so instead of failing',
    second.exitCode === 0 && again.out.includes('no stored session'), JSON.stringify(again.out));
  const statusAfter = writers();
  await runDshStatusCommand({ ...statusAfter.options, baseUrl: host.baseUrl });
  check('status after a disconnect points at the command that fixes it',
    statusAfter.out.includes('cosy dsh connect'), JSON.stringify(statusAfter.out));
  host.stop();
  rmSync(home, { recursive: true, force: true });
}

{
  // A token URL for a different address is not an enrollment credential.
  const host = await startHost();
  const home = tempHome();
  process.env.COSYNCING_HOME = home;
  process.env.DSH_HOME = '/fixture/profile-one';
  const io = writers();
  const result = await runDshConnectCommand(
    { ...io.options, baseUrl: 'http://127.0.0.1:19999' },
    { readLaunchUrl: async () => `${host.baseUrl}/?token=${TOKEN}` },
  );
  check('a launch URL for some other address is refused, and nothing is stored',
    result.exitCode === 1 && listDshEnrollments(dshSessionsPath(home)).length === 0,
    JSON.stringify({ code: result.exitCode, detail: result.detailCode }));
  check('the refusal does not quote the token back',
    io.err.includes(TOKEN) === false, JSON.stringify(io.err));
  host.stop();
  rmSync(home, { recursive: true, force: true });
}

{
  const host = await startHost();
  const home = tempHome();
  process.env.COSYNCING_HOME = home;
  process.env.DSH_HOME = '/fixture/profile-one';
  const io = writers();
  const result = await runDshConnectCommand(
    { ...io.options, baseUrl: host.baseUrl },
    { readLaunchUrl: async () => `${host.baseUrl}/?token=wrong-token` },
  );
  check('a refused token is reported as a login problem and stores nothing',
    result.exitCode === 1 && listDshEnrollments(dshSessionsPath(home)).length === 0,
    JSON.stringify({ code: result.exitCode, detail: result.detailCode }));
  check('nothing was written to the store, so the broker keeps its old answer',
    existsSync(dshSessionsPath(home)) === false, 'the file was never created');
  host.stop();
  rmSync(home, { recursive: true, force: true });
}

{
  // The empty case, which is the one an operator hits first.
  const home = tempHome();
  process.env.COSYNCING_HOME = home;
  const io = writers();
  const result = await runDshConnectCommand({ ...io.options, baseUrl: 'http://127.0.0.1:19998' }, { readLaunchUrl: async () => '' });
  check('no URL is an instruction, not a crash',
    result.exitCode === 1 && io.err.includes('dsh web'), JSON.stringify(io.err));
  const status = writers();
  const statusResult = await runDshStatusCommand({ ...status.options, baseUrl: 'http://127.0.0.1:19998' });
  check('status on a machine with no store says what to do next',
    statusResult.exitCode === 0 && status.out.includes('none yet'), JSON.stringify(status.out));
  rmSync(home, { recursive: true, force: true });
}

// ── The address the operator configured ─────────────────────────────────────

{
  // These commands exist to act on the same host the running broker acts on.
  // Handing the resolver the documented default as an explicit value made it win
  // over COSYNCING_DSH_BASE_URL, so all three talked to 3080 while the broker
  // talked to wherever the operator had pointed it: connect refused the intended
  // host as an origin mismatch, and disconnect removed a different enrollment
  // from the one in use.
  const home = tempHome();
  process.env.COSYNCING_HOME = home;
  const host = await startHost();
  const configured = { COSYNCING_DSH_BASE_URL: host.baseUrl, HOME: home };
  const authority = host.baseUrl.replace('http://', '');

  const io = writers();
  const connected = await runDshConnectCommand(
    { ...io.options, env: configured },
    { readLaunchUrl: async () => `${host.baseUrl}/?token=${TOKEN}` },
  );
  check('connect follows the configured host instead of the default port',
    connected.exitCode === 0 && io.out.includes(authority),
    JSON.stringify({ code: connected.exitCode, out: io.out, err: io.err }));

  const status = writers();
  await runDshStatusCommand(
    { ...status.options, env: configured, json: true },
    { now: () => 1_760_000_000_000 },
  );
  check('status reports the configured host, not 3080, and finds that enrollment',
    status.out.includes(new URL(host.baseUrl).host)
      && status.out.includes('3080') === false
      && status.out.includes('"enrolled": true'),
    JSON.stringify(status.out));

  const gone = writers();
  const removed = await runDshDisconnectCommand({ ...gone.options, env: configured });
  const forgotten = listDshEnrollments(dshSessionsPath(home));
  check('disconnect withdraws the enrollment for the configured host',
    removed.exitCode === 0 && gone.out.includes(authority) && forgotten.length === 0,
    JSON.stringify({ code: removed.exitCode, out: gone.out, left: forgotten.length }));

  const quiet = writers();
  await runDshStatusCommand({
    ...quiet.options,
    json: true,
    env: { COSYNCING_DSH_BASE_URL: 'http://127.0.0.1:19844', HOME: home },
  });
  check('a configured alternate with nothing enrolled is still reported as itself',
    quiet.out.includes('127.0.0.1:19844') && quiet.out.includes('3080') === false,
    JSON.stringify(quiet.out));

  host.stop();
  rmSync(home, { recursive: true, force: true });
}

// ── The argument surface ────────────────────────────────────────────────────

{
  const home = tempHome();
  process.env.COSYNCING_HOME = home;
  const unknown = await callCli(['dsh', 'attach']);
  check('an unknown dsh subcommand is refused with usage, not a stack',
    unknown.code === 2 && unknown.stderr.includes('expected connect, disconnect, or status'),
    JSON.stringify(unknown.stderr));

  const secretUrl = await callCli(['dsh', 'connect', '--url', `http://127.0.0.1:3080/?token=${TOKEN}`]);
  check('a credential-bearing --url is refused: this command exists so tokens stay out of argv',
    secretUrl.code === 2 && secretUrl.stderr.includes('credential-free'), JSON.stringify(secretUrl.stderr));

  const badUrl = await callCli(['dsh', 'status', '--url', 'not-a-url']);
  check('a malformed --url is refused the same way', badUrl.code === 2, JSON.stringify(badUrl.stderr));

  const dupe = await callCli(['dsh', 'status', '--bogus']);
  check('an unknown option is refused rather than ignored', dupe.code === 2, JSON.stringify(dupe.stderr));

  const help = await callCli(['help']);
  check('the command is discoverable from help', help.stdout.includes('dsh'), 'listed in usage');
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${String(results.filter((entry) => entry.ok).length)}/${String(results.length)} checks passed`);
if (results.some((entry) => !entry.ok)) process.exitCode = 1;
