#!/usr/bin/env bun
/**
 * Deterministic functional acceptance for the OpenCode terminal-attach shim's RUNTIME REDIRECT logic
 * (packages/typescript/broker/shell/opencode-shim.sh).
 *
 * This is the OpenCode analog of proving the terminal-join path: a bare `opencode` (or `opencode <dir>`)
 * must become a client of the shared, broker-managed serve so its live session shows up — and syncs — in
 * the app. Codex/Pi terminals auto-join their shared daemon/bridge natively; OpenCode has no such native
 * hook, so this shell shim is the ONLY bridge, and this test guards its decisions:
 *   - serve reachable + 0 args        -> `opencode attach http://127.0.0.1:<port> --dir "$PWD"`
 *   - serve reachable + 1 dir arg     -> `opencode attach http://127.0.0.1:<port> --dir <dir>`
 *   - any flag / subcommand (incl. `serve`, `attach`, `run`) / >=2 args / a non-dir single arg -> pass through
 *   - serve UNREACHABLE               -> warn on stderr + start a private instance, NEVER attach
 *   - honors the COSYNCING_OPENCODE_PORT override
 *
 * The shim claims bash AND zsh support, so the whole matrix runs under both (zsh skipped when absent). The
 * fake `opencode` echoes its argv one-per-line (NOT $*) so argument boundaries are provable — e.g. that
 * `run "hello world"` reaches the binary as two arguments, not three. Complements the install<->uninstall
 * coverage in test-opencode-shim-symmetry.ts. Hermetic: a fake `opencode` on PATH + an in-process serve.
 *
 *   bun run scripts/broker/tests/broker/test-opencode-shim-runtime.ts
 */
export {};
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHIM = join(import.meta.dir, '../../../../packages/typescript/broker/shell/opencode-shim.sh');
const REBUILD_RESTART = join(import.meta.dir, '../../../dev/rebuild-restart-app.sh');

interface Assertion { name: string; ok: boolean; detail?: string }
const assertions: Assertion[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// The review restart owns the same managed OpenCode server the shim attaches terminals to. Its
// pre-SIGTERM guard is part of this gated runtime claim: otherwise a normal app rebuild can leave
// the terminal alive while silently destroying its in-flight model turn.
{
  const script = readFileSync(REBUILD_RESTART, 'utf8');
  const stopStart = script.indexOf('stop_review_broker()');
  const stopEnd = script.indexOf('\nstart_review_broker()', stopStart);
  const stopBody = script.slice(stopStart, stopEnd);
  check(
    'review restart queries a fresh roster for active OpenCode turns',
    script.includes('/api/sessions?window=all&refresh=1')
      && script.includes('.tool == "opencode"')
      && script.includes('.status == "working" or .status == "needs-input"'),
  );
  check(
    'review restart fails closed before SIGTERM when OpenCode activity cannot be ruled out',
    script.includes('could not verify whether the broker owns an active OpenCode turn; refusing restart')
      && stopBody.indexOf('assert_no_active_opencode_turns') >= 0
      && stopBody.indexOf('assert_no_active_opencode_turns') < stopBody.indexOf('kill -TERM'),
  );
}

const tmp = mkdtempSync(join(tmpdir(), 'cosyncing-opencode-shim-runtime-'));
const binDir = join(tmp, 'bin');
const existingDir = join(tmp, 'work');
const missingPath = join(tmp, 'no-such-dir');
mkdirSync(binDir, { recursive: true });
mkdirSync(existingDir, { recursive: true });

// Fake `opencode` on PATH: echoes the forwarded argv ONE ARGUMENT PER LINE (via "$@", not $*), so the test
// can prove argument boundaries — a quoted multi-word arg must survive as a single argument.
const fake = join(binDir, 'opencode');
writeFileSync(fake, '#!/usr/bin/env bash\nfor a in "$@"; do printf \'ARG:%s\\n\' "$a"; done\n', { mode: 0o755 });
chmodSync(fake, 0o755);

// A tiny wrapper the shell sources + invokes, run as a SCRIPT FILE (not `-c`) so positional-parameter and
// $0 semantics are identical under bash and zsh. The shim path arrives via env to avoid $0/$1 differences.
const wrapper = join(tmp, 'run-opencode.sh');
writeFileSync(wrapper, 'source "$COSYNCING_SHIM"\nopencode "$@"\n');

// Reachable serve: the shim probes GET /session with `curl -f` (fails on >=400), so return 200.
const serve = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }) });
if (typeof serve.port !== 'number') throw new Error('in-process serve did not bind a port');
const PORT: number = serve.port;
const URL_ = `http://127.0.0.1:${PORT}`;
const DEAD = 1; // reliably closed for a non-root user — the shim's reachability probe fails fast

async function runShim(shell: string, argv: string[], port: number, extraEnv: Record<string, string> = {}): Promise<{ argv: string[]; stderr: string }> {
  // Async spawn (NOT spawnSync): the reachability probe curls the in-process Bun.serve, so the parent event
  // loop must keep running to answer it — spawnSync would freeze the loop and every probe would fail.
  const proc = Bun.spawn([shell, wrapper, ...argv], {
    cwd: tmp, // a clean cwd so single args like `serve`/`run` are never mistaken for an existing directory
    // Pin PWD to the spawn cwd so the bare-invocation `--dir "$PWD"` assertion is deterministic.
    env: { ...process.env, PWD: tmp, COSYNCING_SHIM: SHIM, PATH: `${binDir}:${process.env.PATH ?? ''}`, COSYNCING_OPENCODE_PORT: String(port), ...extraEnv },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const forwarded = stdout.split('\n').filter((l) => l.startsWith('ARG:')).map((l) => l.slice('ARG:'.length));
  return { argv: forwarded, stderr };
}
const eq = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

async function runMatrix(shell: string): Promise<void> {
  const P = `[${shell}] `;
  // --- serve reachable: redirect the two bare-TUI shapes, pass everything else through ---
  const bare = await runShim(shell, [], PORT);
  check(P + 'reachable + 0 args -> attach scoped to $PWD', eq(bare.argv, ['attach', URL_, '--dir', tmp]), bare.argv.join(' | '));

  const dir = await runShim(shell, [existingDir], PORT);
  check(P + 'reachable + 1 dir arg -> attach --dir <dir>', eq(dir.argv, ['attach', URL_, '--dir', existingDir]), dir.argv.join(' | '));

  const flag = await runShim(shell, ['--help'], PORT);
  check(P + 'reachable + a flag passes through', eq(flag.argv, ['--help']), flag.argv.join(' | '));

  const sub = await runShim(shell, ['run', 'hello world'], PORT);
  check(P + 'reachable + subcommand passes through AND preserves arg boundaries', eq(sub.argv, ['run', 'hello world']), `argc=${sub.argv.length} argv=${sub.argv.join(' | ')}`);

  const serveArg = await runShim(shell, ['serve'], PORT);
  check(P + 'reachable + `serve` passes through (never self-redirects the serve)', eq(serveArg.argv, ['serve']), serveArg.argv.join(' | '));

  const attachArg = await runShim(shell, ['attach', 'http://x'], PORT);
  check(P + 'reachable + `attach ...` passes through (no double-attach)', eq(attachArg.argv, ['attach', 'http://x']), attachArg.argv.join(' | '));

  const twoArgs = await runShim(shell, ['foo', 'bar'], PORT);
  check(P + 'reachable + >=2 args passes through', eq(twoArgs.argv, ['foo', 'bar']), twoArgs.argv.join(' | '));

  const nonDir = await runShim(shell, [missingPath], PORT);
  check(P + 'reachable + a single non-dir arg passes through', eq(nonDir.argv, [missingPath]), nonDir.argv.join(' | '));

  // --- serve unreachable: warn + start a private instance, NEVER attach ---
  const deadBare = await runShim(shell, [], DEAD);
  check(P + 'unreachable + 0 args -> passthrough (no attach)', deadBare.argv.length === 0, deadBare.argv.join(' | '));
  check(P + 'unreachable warns on stderr', /unreachable/i.test(deadBare.stderr), deadBare.stderr.trim().slice(0, 120));

  const deadDir = await runShim(shell, [existingDir], DEAD);
  check(P + 'unreachable + 1 dir arg -> passthrough, not attach --dir', eq(deadDir.argv, [existingDir]), deadDir.argv.join(' | '));

  // --- port override is honored (attach targets the COSYNCING_OPENCODE_PORT the managed rc block pins) ---
  check(P + 'attach target reflects the COSYNCING_OPENCODE_PORT override', bare.argv.includes(URL_), bare.argv.join(' | '));

  // --- host override: an IPv6 literal is bracketed in the endpoint URL (the ::1 case). The DEAD port makes it
  //     unreachable, and the shim's warning surfaces the exact URL it dialed, proving the bracketing. ---
  const v6 = await runShim(shell, [], DEAD, { COSYNCING_OPENCODE_HOST: '::1' });
  check(P + 'IPv6 host override is bracketed in the endpoint URL', /http:\/\/\[::1\]:1\b/.test(v6.stderr) && v6.argv.length === 0, v6.stderr.trim().slice(0, 120));
}

try {
  await runMatrix('bash');
  if (Bun.which('zsh')) await runMatrix('zsh');
  else check('zsh matrix skipped (zsh not installed)', true, 'rc block still valid; zsh users get it when zsh is present');
} catch (err) {
  check('shim runtime test completed without exception', false, String(err));
} finally {
  serve.stop(true);
  rmSync(tmp, { recursive: true, force: true });
  const failed = assertions.filter((a) => !a.ok).length;
  console.log(`\n${assertions.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
