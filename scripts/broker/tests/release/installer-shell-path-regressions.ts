/** Exercise shipped PATH registration with isolated homes, without downloads or broker services. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Check = (name: string, ok: boolean, detail?: string) => void;
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function installerShellPathRegressions(check: Check): void {
  if (process.platform === 'win32') return;
  const template = readFileSync(join(import.meta.dir, '../../release/bootstrap-template.sh'), 'utf8');
  const start = template.indexOf('shell_quote() {');
  const end = template.indexOf('[ "$(id -u)"');
  if (start < 0 || end <= start) throw new Error('shell registration fixture boundary is missing');
  const ownedStart = template.indexOf('ensure_owned_directory() {');
  const ownedEnd = template.indexOf('\nensure_owned_directory "$STATE_HOME"', ownedStart);
  if (ownedStart < 0 || ownedEnd <= ownedStart) throw new Error('owned directory fixture boundary is missing');
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-shell-path-'));
  const originalPath = '/usr/bin:/bin';
  try {
    const run = (args: string[], env: NodeJS.ProcessEnv) => {
      const result = Bun.spawnSync(args, { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5_000 });
      return { ok: result.success, out: result.stdout.toString(), err: result.stderr.toString() };
    };
    const fixture = (name: string, shell = '/bin/bash', runtimeName = 'bun') => {
      const home = join(root, name);
      const state = join(home, "broker's $literal state");
      const bin = join(state, 'bin');
      const runtime = join(home, "Bun's runtime", runtimeName);
      const work = join(home, 'work');
      for (const directory of [bin, work, join(home, "Bun's runtime")]) mkdirSync(directory, { recursive: true, mode: 0o700 });
      // Ubuntu's system bashrc otherwise prints a first-login sudo hint on stdout.
      writeFileSync(join(home, '.hushlogin'), '');
      writeFileSync(runtime, `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
      writeFileSync(join(bin, 'cosyncing'), '#!/usr/bin/env bun\nconsole.log(JSON.stringify({ args: process.argv.slice(2), state: process.env.COSYNCING_HOME }));\n', { mode: 0o755 });
      symlinkSync('cosyncing', join(bin, 'cosy'));
      const env = { HOME: home, SHELL: shell, PATH: originalPath, STATE_HOME: state, INSTALL_DIR: bin, APPLICATION: join(bin, 'cosyncing'), BUN_BIN: runtime, WORK: work };
      const script = join(work, 'register.sh');
      writeFileSync(script, '#!/bin/sh\nset -eu\numask 077\n'
        + (process.platform === 'darwin'
          ? 'stat_owner() { stat -f "%u" "$1"; }\nstat_mode() { stat -f "%Lp" "$1"; }\n'
          : 'stat_owner() { stat -c "%u" "$1"; }\nstat_mode() { stat -c "%a" "$1"; }\n')
        + 'installer_message() { printf "%s\\n" "$1"; }\n'
        + 'fail() { printf "%s\\n" "$1" >&2; exit 1; }\n'
        + template.slice(ownedStart, ownedEnd) + '\n'
        + template.slice(start, end) + '\nregister_shell_commands\n');
      return { home, state, bin, runtime, work, env, script };
    };
    const commands = 'cosyncing version --json; cosy version --json';
    const validCommands = (result: ReturnType<typeof run>, state: string) => {
      const lines = result.out.trim().split('\n');
      return result.ok && lines.length === 2 && lines.every((line) => {
        try {
          const value = JSON.parse(line);
          return JSON.stringify(value.args) === '["version","--json"]' && value.state === state;
        } catch { return false; }
      });
    };

    for (const loginFile of ['.profile', '.bash_profile', '.bash_login']) {
      const f = fixture(`fresh host's ${loginFile}`);
      const original = '# retain operator configuration (no trailing newline)';
      writeFileSync(join(f.home, loginFile), original, { mode: 0o600 });
      writeFileSync(join(f.home, '.bashrc'), original, { mode: 0o600 });
      const installed = run(['sh', f.script], f.env);
      check(`register ${loginFile} without altering existing content`, installed.ok
        && readFileSync(join(f.home, loginFile), 'utf8').startsWith(`${original}\n`), installed.err);
      const startup = readFileSync(join(f.home, loginFile), 'utf8');
      const repeated = run(['sh', f.script], f.env);
      check(`repeat install leaves ${loginFile} unchanged`, repeated.ok && readFileSync(join(f.home, loginFile), 'utf8') === startup);
      const login = run(['sh', '-c', `. "$HOME/${loginFile}"; ${commands}`], f.env);
      check(`${loginFile} exposes both commands and the selected Bun with a relocated state`, validCommands(login, f.state), login.err + login.out);
      const interactive = run(['bash', '--noprofile', '--rcfile', join(f.home, '.bashrc'), '-ic', commands], f.env);
      check(`interactive Bash exposes both commands for ${loginFile}`, validCommands(interactive, f.state), interactive.err + interactive.out);
      const activation = installed.out.split('\n').find((line) => line.startsWith('  . '))?.trim();
      const current = run(['sh', '-c', `${activation}; ${commands}`], f.env);
      check(`printed activation works in the current shell for ${loginFile}`, !!activation && validCommands(current, f.state), current.err + current.out);
      const double = run(['sh', '-c', `. "$HOME/${loginFile}"; first="$PATH"; . "$HOME/${loginFile}"; [ "$first" = "$PATH" ]`], f.env);
      check(`repeated ${loginFile} sourcing does not grow PATH`, double.ok, double.err);
      check(`registration does not create a masking .bash_profile for ${loginFile}`,
        loginFile === '.bash_profile' || !existsSync(join(f.home, '.bash_profile')));

      // The verified Bun must win over an old runtime already found on PATH.
      const staleBin = join(f.home, 'old-runtime');
      mkdirSync(staleBin);
      writeFileSync(join(staleBin, 'bun'), '#!/bin/sh\nexit 91\n', { mode: 0o755 });
      const stale = run(['sh', '-c', `. "$HOME/${loginFile}"; ${commands}`], {
        ...f.env, PATH: `${staleBin}:${originalPath}:${join(f.home, "Bun's runtime")}`,
      });
      check(`selected Bun takes precedence over stale PATH runtime for ${loginFile}`, validCommands(stale, f.state), stale.err + stale.out);
    }

    const named = fixture('custom-runtime-name', '/bin/bash', 'bun-pinned');
    const customRuntime = run(['sh', named.script], named.env);
    writeFileSync(join(named.home, "Bun's runtime", 'bun'), '#!/bin/sh\nexit 92\n', { mode: 0o755 });
    const customCommands = run(['sh', '-c', `. "$HOME/.profile"; ${commands}`], named.env);
    check('explicit runtime with a non-bun filename executes both commands', customRuntime.ok
      && validCommands(customCommands, named.state), customCommands.err + customCommands.out);
    const argument = "argument's spaces $literal *";
    const args = run(['sh', '-c', `. "$HOME/.profile"; cosy ${quote(argument)}`], named.env);
    check('command launchers preserve arguments literally', args.ok && JSON.parse(args.out).args[0] === argument, args.err);
    const explicitState = run(['sh', '-c', '. "$HOME/.profile"; cosy version --json'], { ...named.env, COSYNCING_HOME: '/explicit/state' });
    check('command launchers preserve an explicit state override', explicitState.ok
      && JSON.parse(explicitState.out).state === '/explicit/state', explicitState.err);
    const parentState = run(['sh', '-c', '. "$HOME/.profile"; test -z "${COSYNCING_HOME:-}"'], named.env);
    check('activation does not change the parent shell state override', parentState.ok, parentState.err);
    const launcher = join(named.state, 'shell-bin', 'cosy');
    writeFileSync(launcher, '# operator-owned command\n');
    const foreignLauncher = run(['sh', named.script], named.env);
    check('foreign command launcher is preserved with an absolute fallback', foreignLauncher.ok
      && readFileSync(launcher, 'utf8') === '# operator-owned command\n'
      && foreignLauncher.err.includes('refusing to replace') && foreignLauncher.out.includes(' setup'), foreignLauncher.err);

    const z = fixture('zsh-home', '/bin/zsh');
    const zdotdir = join(z.home, "custom zsh's dotfiles");
    mkdirSync(zdotdir);
    const zenv = { ...z.env, ZDOTDIR: zdotdir };
    const registeredZsh = run(['sh', z.script], zenv);
    for (const profile of ['.zprofile', '.zshrc']) {
      const result = run(['sh', '-c', `. "$ZDOTDIR/${profile}"; ${commands}`], zenv);
      check(`ZDOTDIR ${profile} registers both commands`, registeredZsh.ok && validCommands(result, z.state), result.err + result.out);
    }
    const zsh = Bun.which('zsh');
    if (zsh) {
      for (const mode of ['-ic', '-lic']) {
        const result = run([zsh, mode, commands], zenv);
        check(`fresh Zsh ${mode} resolves both commands`, validCommands(result, z.state), result.err + result.out);
      }
    }
    check('custom ZDOTDIR does not create unused zsh dotfiles in HOME', !existsSync(join(z.home, '.zshrc')) && !existsSync(join(z.home, '.zprofile')));

    const linked = fixture('linked-profile');
    const target = join(linked.work, 'operator-dotfile');
    writeFileSync(target, '# preserve linked file\n');
    symlinkSync(target, join(linked.home, '.bashrc'));
    writeFileSync(join(linked.home, '.profile'), '# preserve read-only file\n', { mode: 0o400 });
    const skipped = run(['sh', linked.script], linked.env);
    check('symlink and read-only startup files are preserved with manual instructions', skipped.ok
      && readFileSync(target, 'utf8') === '# preserve linked file\n'
      && readFileSync(join(linked.home, '.profile'), 'utf8') === '# preserve read-only file\n'
      && skipped.err.includes('add this line yourself'), skipped.err);
    chmodSync(join(linked.home, '.profile'), 0o600);
    const generated = join(linked.state, 'shell-path.sh');
    rmSync(generated);
    symlinkSync(target, generated);
    const foreign = run(['sh', linked.script], linked.env);
    check('unowned environment symlink is not overwritten', foreign.ok
      && readFileSync(target, 'utf8') === '# preserve linked file\n'
      && foreign.err.includes('refusing to replace') && foreign.out.includes(' setup'), foreign.err);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  let failures = 0;
  installerShellPathRegressions((name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? `: ${detail}` : ''}`);
    if (!ok) failures += 1;
  });
  if (failures) process.exit(1);
}
