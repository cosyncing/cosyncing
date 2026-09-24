/** Run the installer's real success messages without downloading or installing anything. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Check = (name: string, ok: boolean, detail?: string) => void;

export function installerShellLocaleRegressions(
  check: Check,
  source = readFileSync(join(import.meta.dir, '../../release/bootstrap-template.sh'), 'utf8'),
  name = 'shell installer template',
): void {
  const script = source.replaceAll('\r\n', '\n');
  // Bash 3.2 can consume a byte of adjacent Unicode as part of an unbraced variable name.
  // Scan on every host, since modern Linux shells do not reproduce the macOS failure.
  const unsafe = script.split('\n').flatMap((line, index) =>
    /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/.test(line) ? [`line ${index + 1}: ${line}`] : []);
  check(`${name} braces variables before non-ASCII text`, unsafe.length === 0, unsafe.join('\n'));
  if (process.platform === 'win32') return;

  // Execute the actual function AND top-level calls. Stubbing the function alone misses argument
  // expansion: even the English selection evaluates the Chinese argument before entering it.
  const messageFunction = script.match(/^installer_message\(\) \{\n[\s\S]*?^\}/m)?.[0];
  const messages = script.match(/^installer_message "Installed cosyncing .*\ninstaller_message "Web client: .*$/m)?.[0];
  if (!messageFunction || !messages) throw new Error(`${name}: installed-message fixture boundary is missing`);
  const fixture = `set -eu
VERSION='0.0.0-locale-test'
APPLICATION='/tmp/installer locale fixture/cosyncing'
WEB_ROOT='/tmp/installer locale fixture/web'
${messageFunction}
${messages}
printf 'CONTINUED\\n'
`;
  const utf8 = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  for (const locale of ['C', utf8]) {
    const environment = { ...process.env, LANG: locale, LC_ALL: locale, LC_CTYPE: locale };
    if (locale === utf8) {
      const charmap = Bun.spawnSync(['locale', 'charmap'], {
        env: environment, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5_000,
      });
      check(`${name} ${locale} exercises a UTF-8 locale`, charmap.success
        && /^utf-?8$/i.test(charmap.stdout.toString().trim()) && charmap.stderr.length === 0,
      charmap.stdout.toString() + charmap.stderr.toString());
    }
    for (const language of ['en', 'zh-Hans']) {
      // Absolute /bin/sh deliberately selects Apple's system Bash, even if PATH has a newer Bash.
      // Piped stdin matches the documented curl | sh invocation; no installer side effects run.
      const result = Bun.spawnSync(['/bin/sh'], {
        env: { ...environment, COSYNCING_SETUP_LANG: language }, stdin: Buffer.from(fixture),
        stdout: 'pipe', stderr: 'pipe', timeout: 5_000,
      });
      const expected = language === 'en'
        ? 'Installed cosyncing 0.0.0-locale-test at /tmp/installer locale fixture/cosyncing\n'
          + 'Web client: /tmp/installer locale fixture/web\nCONTINUED\n'
        : '已安装 cosyncing 0.0.0-locale-test：/tmp/installer locale fixture/cosyncing\n'
          + '网页客户端：/tmp/installer locale fixture/web\nCONTINUED\n';
      check(`${name} /bin/sh ${locale} ${language} continues after installed messages`,
        result.success && result.stdout.toString() === expected && result.stderr.length === 0,
        result.stdout.toString() + result.stderr.toString());
    }
  }
}

if (import.meta.main) {
  let failures = 0;
  const check: Check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? `: ${detail}` : ''}`);
    if (!ok) failures += 1;
  };
  const paths = process.argv.slice(2);
  if (paths.length === 0) installerShellLocaleRegressions(check);
  for (const path of paths) installerShellLocaleRegressions(check, readFileSync(path, 'utf8'), path);
  if (failures) process.exit(1);
}
