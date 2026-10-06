/**
 * The capture sandbox, tested.
 *
 * The property under test is narrow and load-bearing: a capture that records
 * `isolatedHome: true` must not be able to read or write the operator's real
 * DSH storage. The first version of the runner overrode `HOME` and inherited the
 * rest, and because the installed host resolves `DSH_HOME` before `~/.dsh`, an
 * exported `DSH_HOME` sent the "isolated" child straight into real storage.
 *
 *   bun run scripts/adapters/tests/test-dsh-capture-sandbox.ts
 */
export {};
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acceptsDefaultWorkspace, assertDisposableHome, assertRootsContained, buildChildEnvironment,
  INHERITED_NAMES, isolatedStateRoots, isNeverInjectable, provisionDocumentsDirectory,
} from '../dsh-capture-sandbox.ts';

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const scratch = join(tmpdir(), `cosyncing-sandbox-test-${Date.now().toString(36)}`);
mkdirSync(scratch, { recursive: true });
const home = join(scratch, 'disposable-home');
mkdirSync(home, { recursive: true });

try {
  // The finding itself: an inherited DSH_HOME must not survive.
  const hostileRealStorage = join(scratch, 'existing-dsh-state');
  mkdirSync(hostileRealStorage, { recursive: true });
  writeFileSync(join(hostileRealStorage, 'sessions.json'), JSON.stringify({ real: 'data' }));

  const built = buildChildEnvironment({
    home,
    inherited: {
      DSH_HOME: hostileRealStorage,
      HOME: '/fixture/profile',
      USERPROFILE: 'C:\\fixture\\profile',
      PATH: '/usr/bin',
      // The other half of the finding: provider keys used to ride along.
      DEEPSEEK_API_KEY: 'sk-inherited-should-not-pass',
      DASHSCOPE_API_KEY: 'sk-inherited-should-not-pass',
      AWS_SECRET_ACCESS_KEY: 'inherited-should-not-pass',
      SSH_AUTH_SOCK: '/run/user/1000/vscode-ssh-auth-sock',
      COSYNCING_HOME: '/fixture/profile/.cosyncing',
    },
  });

  check('an inherited DSH_HOME is replaced rather than forwarded',
    built.env['DSH_HOME'] === join(home, '.dsh'),
    `${String(built.env['DSH_HOME'])} vs ${String(join(home, '.dsh'))}`);
  check('an inherited HOME and USERPROFILE are replaced',
    built.env['HOME'] === home && built.env['USERPROFILE'] === home);
  check('inherited provider and cloud credentials never reach the child',
    !('DEEPSEEK_API_KEY' in built.env) && !('DASHSCOPE_API_KEY' in built.env)
      && !('AWS_SECRET_ACCESS_KEY' in built.env) && !('SSH_AUTH_SOCK' in built.env),
    Object.keys(built.env).join(','));
  check('the only inherited value is one the allowlist names',
    built.env['PATH'] === '/usr/bin' && !('COSYNCING_HOME' in built.env));
  check('nothing the child receives mentions the hostile path',
    !JSON.stringify(built.env).includes(hostileRealStorage),
    JSON.stringify(built.env));
  check('the hostile storage directory is untouched by building the environment',
    readdirSync(hostileRealStorage).join(',') === 'sessions.json'
      && JSON.parse(readFileSync(join(hostileRealStorage, 'sessions.json'), 'utf8')).real === 'data');
  check('the containment proof passes for the built environment and rejects the hostile one',
    (() => {
      assertRootsContained(home, built.env, join(home, 'workspace'));
      try {
        assertRootsContained(home, { ...built.env, DSH_HOME: hostileRealStorage }, join(home, 'workspace'));
        return false;
      } catch {
        return true;
      }
    })());
  check('a workspace outside the disposable home is refused',
    (() => {
      try {
        assertRootsContained(home, built.env, join(scratch, 'elsewhere'));
        return false;
      } catch {
        return true;
      }
    })());

  const roots = isolatedStateRoots(home);
  check('every state root the host consults is pinned under the home',
    ['HOME', 'USERPROFILE', 'DSH_HOME', 'DSH_AGENTS_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
      'XDG_STATE_HOME', 'XDG_CACHE_HOME'].every((name) => typeof roots[name] === 'string' && roots[name].startsWith(home)),
    Object.keys(roots).join(','));
  check('telemetry is disabled for the child and cannot be inherited as enabled',
    roots['DSH_TELEMETRY_DISABLED'] === '1'
      && buildChildEnvironment({ home, inherited: { DSH_TELEMETRY_DISABLED: '0' } }).env['DSH_TELEMETRY_DISABLED'] === '1');
  // The inherited list is OS plumbing. Anything that could relocate storage or
  // name this product is refused there, and refused again on the injection path.
  check('the inherited list carries no harness, product or XDG state name',
    INHERITED_NAMES.filter((name) => /^(DSH_|COSYNCING_|XDG_)/i.test(name) || /^HOME$|USERPROFILE/.test(name)).length === 0,
    INHERITED_NAMES.filter((name) => /^(DSH_|COSYNCING_|XDG_|HOME$|USERPROFILE)/i.test(name)).join(','));
  check('a path root cannot be smuggled in as an injected credential',
    ['PATH', 'DSH_HOME', 'HOME', 'XDG_CACHE_HOME'].every((name) => isNeverInjectable(name)));

  const injected = buildChildEnvironment({
    home,
    inherited: { DEEPSEEK_API_KEY: 'sk-explicitly-offered' },
    injectedNames: ['DEEPSEEK_API_KEY'],
  });
  check('a named credential is forwarded when the operator asks for it',
    injected.env['DEEPSEEK_API_KEY'] === 'sk-explicitly-offered'
      && JSON.stringify(injected.injected) === JSON.stringify(['DEEPSEEK_API_KEY']));
  check('an injection request naming a state root is refused',
    (['DSH_HOME', 'HOME', 'XDG_CACHE_HOME', 'COSYNCING_HOME', 'PATH'] as const).every((name) => {
      try {
        buildChildEnvironment({ home, inherited: { [name]: '/somewhere/real' }, injectedNames: [name] });
        return false;
      } catch {
        return true;
      }
    }));
  check('a credential that is not actually set fails the run instead of faking it',
    (() => {
      try {
        buildChildEnvironment({ home, inherited: { DEEPSEEK_API_KEY: '  ' }, injectedNames: ['DEEPSEEK_API_KEY'] });
        return false;
      } catch {
        return true;
      }
    })());
  check('even an injected credential cannot outvote a pinned state root',
    buildChildEnvironment({
      home, inherited: { DSH_WEB_HOME: home }, injectedNames: ['DSH_WEB_HOME'],
    }).env['DSH_HOME'] === join(home, '.dsh'));

  check('a home that would contain the real ~/.dsh is refused',
    (() => {
      const nested = join(scratch, 'nested-home');
      mkdirSync(join(nested, '.dsh'), { recursive: true });
      try {
        assertDisposableHome(nested, { cosyncingHome: join(scratch, 'elsewhere') });
        return false;
      } catch {
        return true;
      }
    })());
  check('a home that already has content is refused',
    (() => {
      const occupied = join(scratch, 'occupied-home');
      mkdirSync(join(occupied, 'leftover'), { recursive: true });
      try {
        assertDisposableHome(occupied, { cosyncingHome: join(scratch, 'elsewhere') });
        return false;
      } catch {
        return true;
      }
    })());
  check('the account home itself is refused',
    (() => {
      try {
        assertDisposableHome(process.env['HOME'] ?? '/fixture/profile', { cosyncingHome: join(scratch, 'elsewhere') });
        return false;
      } catch {
        return true;
      }
    })());
  check('an empty disposable home is accepted',
    (() => {
      const fresh = join(scratch, 'fresh-home');
      mkdirSync(fresh, { recursive: true });
      assertDisposableHome(fresh, { cosyncingHome: join(scratch, 'elsewhere') });
      return true;
    })());

  // Native Windows re-resolves homedir() after USERPROFILE is pinned. Exercise
  // that lookup in an isolated process on every gate platform, preserving the
  // original account while accepting only the separate disposable roots.
  const movingHomeProbe = Bun.spawnSync([process.execPath, '--eval', `
    import { pathToFileURL } from 'node:url';
    const original = ${JSON.stringify(join(scratch, 'original-account'))};
    const disposable = ${JSON.stringify(home)};
    globalThis.captureTestAccount = original;
    const source = await Bun.file(new URL(${JSON.stringify(new URL('../dsh-capture-sandbox.ts', import.meta.url).href)})).text();
    // Replace only the OS lookup seam; Bun optimizes native built-in imports
    // around mock.module. All containment implementation remains unchanged.
    const lookup = ${JSON.stringify(join(scratch, 'dynamic-home-lookup.mjs'))};
    const guard = ${JSON.stringify(join(scratch, 'dynamic-home-guard.mjs'))};
    await Bun.write(lookup, 'export function homedir() { return globalThis.captureTestAccount; }');
    const injected = source.replace("from 'node:os'", 'from ' + JSON.stringify(pathToFileURL(lookup).href));
    const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(injected);
    await Bun.write(guard, executable);
    const sandbox = await import(pathToFileURL(guard).href);
    globalThis.captureTestAccount = disposable;
    sandbox.assertRootsContained(disposable, sandbox.isolatedStateRoots(disposable), disposable);
    let refused = false;
    try { sandbox.assertRootsContained(original, sandbox.isolatedStateRoots(original), original); }
    catch { refused = true; }
    if (!refused) throw new Error('the original account lost its containment protection');
    refused = false;
    try { sandbox.assertDisposableHome(original); } catch { refused = true; }
    if (!refused) throw new Error('the original account became a disposable home');
  `], { stdout: 'pipe', stderr: 'pipe' });
  check('pinning a dynamic account-home lookup accepts the capture and still protects the original account',
    movingHomeProbe.success, movingHomeProbe.stderr.toString());

  // The first-use Workspace: a host that cannot resolve a Documents directory
  // cannot create its default Workspace and its web composer stays disabled.
  // Direct API sessions may still use the host's working directory. The host
  // which answers `system Documents directory is unavailable` without this.
  check('provisioning pins the Documents lookup inside the disposable home',
    (() => {
      const fresh = join(scratch, 'provisioned-home');
      mkdirSync(join(fresh, '.config'), { recursive: true });
      const provision = provisionDocumentsDirectory(fresh, 'linux');
      const written = readFileSync(provision.userDirsFile, 'utf8');
      return provision.pinned
        && provision.documentsDirectory === join(fresh, 'Documents')
        && written.includes('XDG_DOCUMENTS_DIR="$HOME/Documents"')
        && existsSync(join(fresh, 'Documents'))
        && provision.userDirsFile === join(fresh, '.config', 'user-dirs.dirs');
    })());
  check('provisioning does not claim a pin on a platform that asks the OS',
    (() => {
      const fresh = join(scratch, 'darwin-home');
      mkdirSync(fresh, { recursive: true });
      const provision = provisionDocumentsDirectory(fresh, 'darwin');
      // macOS answers from osascript, which reads the operator's real account,
      // so claiming a pin here would be a false isolation claim.
      return !provision.pinned && !existsSync(provision.userDirsFile);
    })());
  check('the host\'s own refusal is read off its answer: empty',
    !acceptsDefaultWorkspace('\n', home, 'linux').usable);
  check('the host calls an answer equal to the home unavailable',
    (() => {
      const verdict = acceptsDefaultWorkspace(home + '\n', home, 'linux');
      return !verdict.usable && verdict.reason.includes('unavailable');
    })());
  check('an answer that escapes the disposable home is refused',
    !acceptsDefaultWorkspace(join(scratch, 'elsewhere-docs'), home, 'linux').usable);
  check('an answer under the home is usable',
    acceptsDefaultWorkspace(join(home, 'Documents'), home, 'linux').usable);
  check('the verdict is refused on a platform that cannot be pinned',
    !acceptsDefaultWorkspace(join(home, 'Documents'), home, 'win32').usable);
  check('the provisioned home keeps the Documents root contained',
    (() => {
      const fresh = join(scratch, 'contained-home');
      mkdirSync(fresh, { recursive: true });
      const provision = provisionDocumentsDirectory(fresh, 'linux');
      const env = isolatedStateRoots(fresh);
      assertRootsContained(fresh, { ...env, HOME: fresh }, provision.documentsDirectory);
      return true;
    })());

} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${String(results.length - failed.length)} passed, ${String(failed.length)} failed`);
if (failed.length > 0) process.exit(1);
