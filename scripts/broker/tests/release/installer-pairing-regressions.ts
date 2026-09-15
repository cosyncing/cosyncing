/** Run the shipped pairing tail with fixture CLI replies, without installing any artifacts. */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Check = (name: string, ok: boolean, detail?: string) => void;
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

function section(source: string, start: string, end: string): string {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin);
  if (begin < 0 || finish < 0) throw new Error('pairing fixture boundary is missing');
  return source.slice(begin, finish);
}

export function installerPairingRegressions(check: Check, powerShell?: string): void {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-pairing-tail-'));
  const listener = { ready: true, url: 'http://127.0.0.1:7735' };
  const status = { schemaVersion: 2, product: 'cosyncing', ok: false,
    agentsRead: 'unreadable', detailCodes: ['agent-roster-unreadable'], listener };
  const cases = [
    { name: 'agent status failure with ready listener', status, exitCode: 1, paired: true },
    { name: 'healthy broker', status: { ...status, ok: true }, exitCode: 0, paired: true },
    { name: 'stopped broker', status: { ...status, listener: { ...listener, ready: false } }, exitCode: 1 },
    { name: 'unverified listener', status: { ...status, listener: { url: listener.url } }, exitCode: 0 },
    { name: 'malformed readiness', status: { ...status, listener: { ...listener, ready: 'True' } }, exitCode: 0 },
    { name: 'foreign product', status: { ...status, product: 'other' }, exitCode: 0 },
    { name: 'nonlocal listener', status: { ...status, listener: { ...listener, url: 'http://example.invalid' } }, exitCode: 0 },
    { name: 'malformed status', status: null, exitCode: 1 },
  ];
  try {
    if (process.platform !== 'win32' && !powerShell) {
      const source = readFileSync(join(import.meta.dir, '../../release/bootstrap-template.sh'), 'utf8');
      const tail = section(source, 'HANDOFF_HOME="$STATE_HOME"', '\nif [ -z "$CLIENT_SKIP" ]; then');
      const app = join(root, 'fixture-app.ts');
      writeFileSync(app, `
        if (process.argv[2] === 'status') {
          console.log(process.env.FIXTURE_STATUS);
          process.exit(Number(process.env.FIXTURE_STATUS_EXIT));
        }
        if (process.argv[2] !== 'pair') process.exit(2);
        if (process.env.FIXTURE_PAIR_FAIL === '1') process.exit(1);
        console.log(JSON.stringify({ qr: 'fixture-one-use-offer', brokerUrl: process.argv[5],
          expiresAt: new Date(Date.now() + 300_000).toISOString() }));
      `);
      const path = join(root, 'handoff.sh');
      writeFileSync(path, 'set -eu\numask 077\n'
        + `STATE_HOME=${shellQuote(root)}\nWORK=${shellQuote(root)}\nBUN_BIN=${shellQuote(process.execPath)}\n`
        + `APPLICATION=${shellQuote(app)}\nCLIENT_CONTAINER=''\nCLIENT_SKIP=''\nCLIENT_RUNNING=''\n`
        + tail);
      for (const scenario of [...cases, { name: 'pair command rejected', status, exitCode: 0, reject: true }]) {
        const file = join(root, 'client-pairing.json');
        rmSync(file, { force: true });
        const result = Bun.spawnSync(['sh', path], {
          env: { ...process.env, FIXTURE_STATUS: JSON.stringify(scenario.status),
            FIXTURE_STATUS_EXIT: String(scenario.exitCode),
            FIXTURE_PAIR_FAIL: 'reject' in scenario ? '1' : '0' },
          stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
        });
        const paired = 'paired' in scenario && scenario.paired === true;
        const document = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
        check(`shell pairing handoff: ${scenario.name}`, result.success && (paired
          ? document?.brokerUrl === listener.url && document?.qr === 'fixture-one-use-offer'
            && (statSync(file).mode & 0o777) === 0o600
          : !existsSync(file) && result.stdout.toString().includes('Pairing handoff: skipped')),
        result.stdout.toString() + result.stderr.toString());
      }
    } else {
      const executable = powerShell ?? join(process.env.SystemRoot ?? 'C:\\Windows',
        'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const source = readFileSync(join(import.meta.dir, '../../release/bootstrap-template.ps1'), 'utf8').replaceAll('\r\n', '\n');
      const prefix = section(source, 'function Get-JsonProperty {', '\n<#');
      const statusStep = section(source,
        '  $status = Invoke-Native -FilePath $bunBin -ArgumentList @($application, \'status\', \'--json\')',
        '  if (-not $handoffSkip) {');
      for (const scenario of cases) {
        const script = `$ErrorActionPreference='Stop'\n${prefix}\n`
          + `$bunBin='fixture'; $application='fixture'; $handoffSkip=''; $listenerUrl=''\n`
          + `function Invoke-Native { return [pscustomobject] @{ ExitCode=${scenario.exitCode}; `
          + `StdOut=${psQuote(JSON.stringify(scenario.status))} } }\n${statusStep}\n`
          + `Write-Output "LISTENER=$listenerUrl"\nWrite-Output "SKIP=$handoffSkip"`;
        const result = Bun.spawnSync([executable, '-NoProfile', '-NonInteractive', '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64')], {
          stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
        });
        const output = result.stdout.toString();
        const paired = 'paired' in scenario && scenario.paired === true;
        check(`PowerShell pairing listener: ${scenario.name}`, result.success && (paired
          ? output.includes(`LISTENER=${listener.url}`) && /SKIP=\s*$/.test(output)
          : /LISTENER=\r?\n/.test(output) && output.includes('ready local listener')),
        output + result.stderr.toString());
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (import.meta.main) {
  let failures = 0;
  installerPairingRegressions((name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? `: ${detail}` : ''}`);
    if (!ok) failures += 1;
  }, process.argv[2]);
  if (failures) process.exit(1);
}
