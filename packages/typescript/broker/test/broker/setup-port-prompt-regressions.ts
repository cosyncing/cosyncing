/** Exercise clack's actual Enter/default and cancellation behavior through a pseudo-terminal. */
import { createClackSetupPresenter } from '../../src/installation/setup-presenter.ts';
import { SETUP_PROMPT_CANCELLED, type SetupInspection } from '../../src/installation/setup.ts';

type Check = (name: string, ok: boolean, detail?: string) => void;
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export async function setupPortPromptRegressions(check: Check): Promise<void> {
  // Windows PowerShell has its own installer tests; script(1) provides the terminal for the shared
  // TypeScript presenter on POSIX. Every child only prompts, and never inspects or configures a host.
  if (process.platform === 'win32') return;
  for (const [name, input, expected] of [
    ['default', '\r', '7735'],
    ['custom', '8800\r', '8800'],
    ['cancel', '\x03', 'cancelled'],
  ]) {
    const command = `stty cols 120 rows 30 && exec ${shellQuote(process.execPath)} ${shellQuote(import.meta.path)} --child`;
    const argv = process.platform === 'darwin'
      ? ['script', '-q', '/dev/null', 'sh', '-c', command]
      : ['script', '-q', '-e', '-c', command, '/dev/null'];
    const child = Bun.spawn(argv, {
      env: { ...process.env, COSYNCING_SETUP_LANG: 'en', TERM: 'xterm-256color' },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    const stderr = new Response(child.stderr).text();
    const timeout = setTimeout(() => child.kill(), 10_000);
    let output = '';
    let answered = false;
    const reader = child.stdout.getReader();
    try {
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
        if (!answered && output.includes('Broker port')) {
          child.stdin.write(input!);
          await child.stdin.flush();
          answered = true;
        }
      }
      const exitCode = await child.exited;
      output += await stderr;
      check(`real terminal broker port prompt: ${name}`,
        exitCode === 0 && output.includes(`RESULT=${expected}`), output);
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
      child.stdin.end();
      if (child.exitCode === null) { child.kill(); await child.exited; }
    }
  }
}

if (import.meta.main) {
  if (process.argv[2] === '--child') {
    const presenter = createClackSetupPresenter();
    await presenter.chooseLanguage({ setupState: {} } as SetupInspection);
    const port = await presenter.chooseBrokerPort!(7734, 7735);
    console.log(port === SETUP_PROMPT_CANCELLED ? 'RESULT=cancelled' : `RESULT=${port}`);
  } else {
    let failures = 0;
    await setupPortPromptRegressions((name, ok, detail) => {
      console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? `: ${detail}` : ''}`);
      if (!ok) failures += 1;
    });
    if (failures) process.exit(1);
  }
}
