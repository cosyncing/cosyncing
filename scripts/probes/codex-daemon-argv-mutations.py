#!/usr/bin/env python3
"""Mutation-check PR-1 from the repo root; restore every source before exiting."""
import argparse
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='output/review/codex-daemon-argv/mutations')
    options = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    output = root / options.output
    output.mkdir(parents=True, exist_ok=True)
    adapter = Path('packages/typescript/adapters/codex')
    process = adapter / 'src/daemon-process.ts'
    diagnosis = adapter / 'src/diagnostics.ts'
    restart = adapter / 'src/daemon-restart.ts'
    unit = ['bun', 'run', str(adapter / 'test/test-codex-daemon-restart.ts')]
    doctor = ['bun', 'run', 'test:broker-doctor']
    originals = {path: (root / path).read_text() for path in (process, diagnosis, restart)}
    mutations = [
        ('M1-exact-argv-match', process,
         "  if (args[0] !== 'app-server')",
         "  const legacy = args.at(-1) === '--managed-daemon' ? args.slice(0, -1) : args;\n"
         "  if (!['app-server\\0--listen\\0unix://', 'app-server\\0--remote-control\\0--listen\\0unix://'].includes(legacy.join('\\0'))) return { valid: false, detail: 'old exact match' };\n"
         "  if (args[0] !== 'app-server')", unit),
        ('M2-any-listen-address', process,
         "if (address !== 'unix://')", "if (false)", unit),
        ('M3-flags-with-values', process,
         "      if (next !== undefined && !next.startsWith('--')) return refused(token, 'carries a value');",
         "      if (next !== undefined && !next.startsWith('--')) i++;", unit),
        ('M3b-flags-with-equals', process,
         "/^--[a-z0-9][a-z0-9-]*$/", "/^--[a-z0-9][a-z0-9-]*(?:=.*)?$/", unit),
        ('M4-old-macos-parser', process,
         'const parsed = codexDaemonCommandArguments(command, executable, live.identity.comm);',
         "const suffix = command?.match(/ (app-server(?: --remote-control)? --listen unix:\\/\\/(?: --managed-daemon)?)$/)?.[1];\n"
         "      const parsed = suffix ? [executable, ...suffix.split(' ')] : undefined;", unit),
        ('M5-duplicate-listener', process,
         "if (++listens !== 1) return refused(token, 'appears more than once');",
         'listens = 1;', unit),
        ('M6-missing-listener', process,
         "if (listens !== 1) return refused('--listen', 'is required exactly once');",
         "if (false) return refused('--listen', 'is required exactly once');", unit),
        ('M7-unnamed-refusal', process,
         "const flag = token?.match(/^--?[A-Za-z0-9][A-Za-z0-9_-]*/)?.[0];",
         'const flag: string | undefined = undefined;', unit),
        ('M8-drop-unknown-flags', process,
         "unknownFlags.push(token)", "unknownFlags.push()", unit),
        ('M9-unverified-macos-executable', process,
         "const prefix = [comm, executable].find((path) => command.startsWith(path) && /\\s/.test(command[path.length] ?? ''));",
         'const prefix = executable;', unit),
        ('M10-doctor-unknown-passes', diagnosis,
         "id, status: 'warn', detailCode: 'daemon-ownership-unknown',",
         "id, status: 'pass', detailCode: 'daemon-ownership-unknown',", doctor),
        ('M11-doctor-running-warns', diagnosis,
         "id, status: 'pass', detailCode: 'daemon-ownership-verified',",
         "id, status: 'warn', detailCode: 'daemon-ownership-verified',", doctor),
        ('M12-doctor-loses-detail', diagnosis,
         'summary: `cosyncing could not confirm it manages the Codex daemon: ${daemon.detail}`',
         "summary: 'cosyncing could not confirm it manages the Codex daemon: unknown'", doctor),
        ('M13-restart-loses-guidance', restart,
         'throw codexDaemonOwnershipFailure(captured.detail)',
         'throw new Error(captured.detail)', unit),
        ('M14-doctor-wrong-home', diagnosis,
         'const daemon = readProcess(home, executable);',
         "const daemon = readProcess(join(home, 'other-home'), executable);", doctor),
        ('M15-unnamed-subcommand', process,
         "token === 'daemon' || token === 'pid-update-loop' ? token : undefined",
         "false ? token : undefined", unit),
        ('M16-hidden-inline-value-form', process,
         'const inline = flag !== undefined && token?.startsWith(`${flag}=`);',
         'const inline = false;', unit),
        ('M17-unredacted-inline-value', process,
         "/^(?:0|1|true|false|unix:\\/\\/)$/.test(value!) ? value : '<value>'",
         'value', unit),
        ('M18-symlinked-macos-path', process,
         'const parsed = codexDaemonCommandArguments(command, executable, live.identity.comm);',
         'const parsed = codexDaemonCommandArguments(command, executable);', unit),
        ('M19-resolved-macos-path', process,
         'const prefix = [comm, executable].find',
         'const prefix = [comm].find', unit),
    ]
    results = []
    try:
        for name, path, old, new, command in mutations:
            original = originals[path]
            if original.count(old) != 1:
                raise RuntimeError(f'{name}: expected one mutation site')
            try:
                (root / path).write_text(original.replace(old, new, 1))
                run = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=60)
                log = run.stdout + run.stderr
                (output / f'{name}.log').write_text(log)
                killed = run.returncode != 0 and ('AssertionError' in log or 'FAIL ' in log)
                results.append({'name': name, 'killed': killed, 'exitCode': run.returncode,
                                'command': command, 'log': str(output / f'{name}.log')})
                print(f'{name}: {"KILLED" if killed else "SURVIVED"}', flush=True)
            finally:
                (root / path).write_text(original)
        for name, command in [('restored-unit', unit), ('restored-doctor', doctor)]:
            run = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=60)
            (output / f'{name}.log').write_text(run.stdout + run.stderr)
            if run.returncode:
                raise RuntimeError(f'{name} failed: exit {run.returncode}')
            print(f'{name}: PASS', flush=True)
    finally:
        for path, original in originals.items():
            (root / path).write_text(original)
        (output / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    if not all(result['killed'] for result in results):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
