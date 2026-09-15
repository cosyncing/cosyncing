/** Exercise only the prompt sections of the shipped templates; never download or install anything. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Check = (name: string, ok: boolean, detail?: string) => void;
const shellTemplate = readFileSync(join(import.meta.dir, '../../release/bootstrap-template.sh'), 'utf8');
const psTemplate = readFileSync(join(import.meta.dir, '../../release/bootstrap-template.ps1'), 'utf8');
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export async function installerOnboardingRegressions(check: Check, powerShell?: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-onboarding-prompts-'));
  try {
    if (process.platform !== 'win32' && !powerShell) {
      const boundary = shellTemplate.indexOf('[ "$(id -u)"');
      if (boundary < 0) throw new Error('shell prompt fixture boundary is missing');
      const prefix = shellTemplate.slice(0, boundary)
        .replace("INSTALL_MODE='@INSTALL_MODE@'", "INSTALL_MODE='all'");
      const path = join(root, 'prompt.sh');
      writeFileSync(path, `${prefix}\nprintf 'SETUP_LANG=%s\\n' "$COSYNCING_SETUP_LANG"\n`);
      const env = { ...process.env, COSYNCING_SETUP_LANG: '' };
      for (const [input, expected] of [['2\n', 'zh-Hans'], ['\n', 'en'], ['bad\n2\n', 'zh-Hans'], ['q\n', undefined]]) {
        // script(1) supplies a real controlling terminal while sh receives the script over a pipe.
        const command = `cat ${quote(path)} | sh`;
        const cmd = process.platform === 'darwin'
          ? ['script', '-q', '/dev/null', 'sh', '-c', command]
          : ['script', '-q', '-e', '-c', command, '/dev/null'];
        const result = Bun.spawnSync(cmd, { env, stdin: Buffer.from(input!), stdout: 'pipe', stderr: 'pipe', timeout: 5_000 });
        const output = result.stdout.toString() + result.stderr.toString();
        check(`piped shell installer language input ${JSON.stringify(input)}`,
          result.success && output.includes('选择语言 / Language')
            && (expected ? output.includes(`SETUP_LANG=${expected}`) : !output.includes('SETUP_LANG=')), output);
      }
      for (const language of ['en', 'zh-Hans']) {
        const result = Bun.spawnSync(['sh', path], {
          env: { ...env, COSYNCING_SETUP_LANG: language }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5_000,
        });
        check(`shell installer honours explicit ${language} without a prompt`,
          result.success && result.stdout.toString() === `SETUP_LANG=${language}\n` && result.stderr.length === 0);
      }
      if (process.platform === 'linux') {
        const result = Bun.spawnSync(['setsid', 'sh', path], {
          env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5_000,
        });
        check('headless shell installer defaults without reading its script as answers',
          result.success && result.stdout.toString() === 'SETUP_LANG=en\n' && result.stderr.length === 0);
      }
    } else {
      const executable = powerShell ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const boundary = psTemplate.indexOf('\ntry {\n  $SETUP_LANGUAGE = Select-SetupLanguage');
      if (boundary < 0) throw new Error('PowerShell prompt fixture boundary is missing');
      const prefix = psTemplate.slice(0, boundary)
        .replace("$INSTALL_MODE = '@INSTALL_MODE@'", "$INSTALL_MODE = 'all'");
      const windowsPath = (path: string): string => process.platform === 'win32' ? path
        : Bun.spawnSync(['wslpath', '-w', path], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim();
      // Only console availability and Read-Host are injected; execute the actual template functions.
      const run = (answers: string[], inherited = '', redirected = false): string => {
        const script = `${prefix.replaceAll('[Console]::IsInputRedirected', redirected ? '$true' : '$false')}\n`
          + `$env:COSYNCING_SETUP_LANG = '${inherited}'\n`
          + `$script:answers = @(${answers.map((answer) => `'${answer}'`).join(',')})\n$script:answerIndex = 0\n`
          + 'function Read-Host { param($Prompt)\n'
          + '  if ($script:answerIndex -ge $script:answers.Count) { throw "unexpected prompt" }\n'
          + '  $value = $script:answers[$script:answerIndex]; $script:answerIndex += 1; return $value\n}\n'
          + '$SETUP_LANGUAGE = Select-SetupLanguage\nWrite-Output "SETUP_LANG=$SETUP_LANGUAGE"\n';
        const fixture = join(root, 'language.ps1');
        writeFileSync(fixture, script);
        const result = Bun.spawnSync([executable, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', windowsPath(fixture)], {
          stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
        });
        const output = result.stdout.toString() + result.stderr.toString();
        check(`PowerShell language answers=${JSON.stringify(answers)} inherited=${inherited} redirected=${redirected}`, result.success, output);
        return output;
      };
      check('PowerShell chooses Chinese before installation', run(['2']).includes('SETUP_LANG=zh-Hans'));
      check('PowerShell Enter chooses English', run(['']).includes('SETUP_LANG=en'));
      check('PowerShell invalid answers retry', run(['bad', '2']).includes('SETUP_LANG=zh-Hans'));
      check('PowerShell cancellation stops before installation', !run(['q']).includes('SETUP_LANG='));
      check('PowerShell explicit language bypasses the prompt', run([], 'zh-Hans').trim() === 'SETUP_LANG=zh-Hans');
      check('PowerShell headless invocation does not prompt', run([], '', true).trim() === 'SETUP_LANG=en');
      // Exercise irm's actual HTTP decoding, not just PowerShell's file parser.
      // The website serves octet-stream without a charset; also qualify explicit UTF-8.
      const httpScript = prefix.replaceAll('[Console]::IsInputRedirected', '$false')
        + "\n$env:COSYNCING_SETUP_LANG = ''\nfunction Read-Host { return '2' }\n"
        + '$SETUP_LANGUAGE = Select-SetupLanguage\nWrite-Output "SETUP_LANG=$SETUP_LANGUAGE"\n'
        + 'Write-InstallerMessage "ENGLISH" (Get-InstallerText \'5Lit5paH\')\n';
      const server = Bun.serve({
        hostname: '127.0.0.1', port: 0,
        fetch: (request) => new Response(httpScript, {
          headers: { 'Content-Type': new URL(request.url).pathname === '/utf8'
            ? 'text/plain; charset=utf-8' : 'application/octet-stream' },
        }),
      });
      try {
        for (const route of ['/octet-stream', '/utf8']) {
          const command = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); `
            + `$ErrorActionPreference = 'Stop'; irm http://127.0.0.1:${server.port}${route} | iex`;
          const child = Bun.spawn([executable, '-NoProfile', '-NonInteractive', '-EncodedCommand',
            Buffer.from(command, 'utf16le').toString('base64')], {
            stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
          });
          const timer = setTimeout(() => child.kill(), 15_000);
          try {
            const [code, output, errors] = await Promise.all([
              child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
            ]);
            check(`PowerShell irm | iex decodes Chinese with ${route}`, code === 0
              && output.includes('选择语言 / Language') && output.includes('简体中文')
              && output.includes('SETUP_LANG=zh-Hans') && output.includes('中文'), output + errors);
          } finally { clearTimeout(timer); }
        }
      } finally { server.stop(true); }
      // Parser runs against the entire script, including the setup environment handoff, without executing it.
      const fullTemplate = join(root, 'installer.ps1');
      writeFileSync(fullTemplate, psTemplate);
      const parse = `$tokens = $null; $errors = $null; $null = [Management.Automation.Language.Parser]::ParseFile('${windowsPath(fullTemplate).replaceAll("'", "''")}', [ref]$tokens, [ref]$errors); if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }; 'PARSE_OK'`;
      const parsed = Bun.spawnSync([executable, '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(parse, 'utf16le').toString('base64')], {
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
      });
      check('complete PowerShell installer parses in Windows PowerShell 5.1', parsed.success && parsed.stdout.toString().includes('PARSE_OK'), parsed.stdout.toString() + parsed.stderr.toString());
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  let failures = 0;
  await installerOnboardingRegressions((name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? `: ${detail}` : ''}`);
    if (!ok) failures += 1;
  }, process.argv[2]);
  if (failures) process.exit(1);
}
