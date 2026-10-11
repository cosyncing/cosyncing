#!/usr/bin/env python3
"""Mutation-check PR-1b from the repo root, restoring source after each case."""
import argparse
import json
import os
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='output/review/lane-a1b/mutations')
    options = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    output = root / options.output
    output.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, 'CODEX_HOME': str(output / 'scratch-codex')}
    Path(env['CODEX_HOME']).mkdir(exist_ok=True)
    process = Path('packages/typescript/adapters/codex/src/daemon-process.ts')
    diagnosis = Path('packages/typescript/adapters/codex/src/diagnostics.ts')
    i18n = Path('packages/typescript/broker/src/cli/cli-i18n.ts')
    test = ['bun', 'run', 'packages/typescript/adapters/codex/test/test-codex-daemon-receipts.ts', '--case']
    doctor = ['bun', 'run', 'test:broker-doctor']
    originals = {p: (root / p).read_text() for p in (process, diagnosis, i18n)}
    mutations = []

    def receipt(name, old, new, case):
        mutations.append((name, process, old, new, test + [case]))

    layouts = "['app-server.pid', 'daemon.pid'] as const"
    receipt('M01-drop-legacy-layout', layouts, "['daemon.pid'] as const", 'legacy-layout')
    receipt('M02-drop-fresh-layout', layouts, "['app-server.pid'] as const", 'fresh-layout')
    receipt('M03-drop-daemon-package', "packageBinary(executable, 'app-server-daemon')", 'false', 'fresh-layout')
    receipt('M04-omit-second-layout-evidence', 'verified.map(({ layout }) => layout) }', '[verified[0]!.layout] }', 'both-layouts')
    receipt('M05-reject-previous-release', "packageBinary(executable, 'app-server-daemon')", "packageBinary(executable, 'app-server-daemon') && release === currentRelease", 'previous-daemon-release')
    receipt('M06-unresolved-home', 'join(realpathSync(home), \'packages\')', 'join(resolve(home), \'packages\')', 'symlinked-home')
    receipt('M07-any-package', "dirname(dirname(dirname(path))) === join(packages, name, 'releases')", "dirname(dirname(dirname(path))).startsWith(packages)", 'wrong-package')
    receipt('M08-daemon-in-any-home', "packageBinary(executable, 'app-server-daemon')", "basename(executable) === 'codex'", 'wrong-package-home')
    receipt('M09-cli-in-any-home', "packageBinary(cli, 'standalone')", "true", 'wrong-cli-home')
    receipt('M10-ignore-process-home', "if (resolve(configuredHome || join(homedir(), '.codex')) !== resolve(home))", 'if (false)', 'wrong-process-home')
    receipt('M11-unrelated-executable', "packageBinary(executable, 'app-server-daemon')", "true", 'unrelated-executable')
    receipt('M12-outside-bin', "basename(dirname(path)) === 'bin'", 'true', 'outside-bin')
    receipt('M13-any-release-name', "/^\\d+\\.\\d+\\.\\d+(?:[-+][A-Za-z0-9._-]+)?$/.test(basename(dirname(dirname(path))))", 'true', 'invalid-release')
    receipt('M14-package-symlink-escape', 'executable = realpathSync(`/proc/${pid}/exe`);', "executable = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\\0')[0]!;", 'package-symlink-escape')
    receipt('M15-stale-pid', 'return live.state === \'absent\' ? live : unknown(\'Codex process identity is unreadable.\');', "return { state: 'running', process: { pid, start: 'fixture start', boot: 'fixture boot', comm: cli, executable: cli, argv: [], home, cli } };", 'stale-pid')
    receipt('M16-stale-start', 'normalizeStart(start) !== receiptStart', 'false', 'stale-start')
    receipt('M17-invalid-pid', "if (pid === process.pid || !Number.isSafeInteger(pid) || pid <= 0) return unknown('Invalid Codex daemon PID.');", '', 'invalid-pid')
    receipt('M18-unsafe-mode', '(stat.mode & 0o022) !== 0', 'false', 'unsafe-mode')
    receipt('M19-unsafe-owner', 'stat.uid !== process.getuid?.()', 'false', 'unsafe-owner')
    receipt('M20-unsafe-size', 'stat.size > 4096', 'false', 'unsafe-size')
    # A substituted link looks like a regular receipt only if both type and link-mode checks are bypassed.
    receipt('M21-receipt-symlink', '!stat.isFile() || stat.size > 4096 || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0', 'stat.isDirectory()', 'receipt-symlink')
    receipt('M22-receipt-directory', "return unknown(`Codex daemon PID receipt ${layout} has unsafe ownership or permissions.`);", 'continue;', 'receipt-directory')
    receipt('M23-malformed-receipt', "!record.processStartTime.trim()", 'false', 'malformed-receipt')
    receipt('M24-unreadable-receipt', "return unknown(`Codex daemon PID receipt ${layout} is unreadable.`);", 'continue;', 'unreadable-receipt')
    selection = '  const verified: { layout: CodexDaemonReceiptLayout; process: CodexDaemonProcess }[] = [];'
    early_conflict = """  const first = records[0];
  if (first && records.some((other) => other.pid !== first.pid || other.processStartTime !== first.processStartTime)) {
    return unknown('Codex daemon PID receipts app-server.pid and daemon.pid conflict.');
  }
""" + selection
    receipt('M25-stale-legacy-pid-blocks-live', selection, early_conflict, 'stale-legacy-pid-plus-live')
    receipt('M26-stale-legacy-start-blocks-live', selection, early_conflict, 'stale-legacy-start-plus-live')
    receipt('M27-ignore-unsafe-second', "return unknown(`Codex daemon PID receipt ${layout} has unsafe ownership or permissions.`);", 'continue;', 'unsafe-second-receipt')
    receipt('M28-ignore-malformed-first', "return unknown(`Codex daemon PID receipt ${layout} is malformed.`);", 'continue;', 'malformed-first-receipt')
    receipt('M29-process-user', "if (lstatSync(`/proc/${pid}`).uid !== process.getuid?.())", 'if (false)', 'wrong-process-user')
    receipt('M30-process-start', 'after.identity.start !== live.identity.start', 'false', 'changed-process-start')
    receipt('M31-process-boot', 'after.identity.boot !== live.identity.boot', 'false', 'changed-boot')
    receipt('M32-structural-argv', 'if (!argumentsRead.valid) return unknown(argumentsRead.detail);', '', 'unsafe-argv')
    receipt('M33-missing-receipts', "if (!daemon) return { state: 'absent' };", "if (!daemon) return { state: 'unknown', detail: 'missing' };", 'missing-receipts')
    mutations.extend([
        ('M34-doctor-layout-evidence', diagnosis, "receiptLayouts: (daemon.process.receiptLayouts ?? []).join(', ')", "receiptLayouts: ''", doctor),
        ('M35-doctor-layout-summary', diagnosis, "daemon.process.receiptLayouts?.length ?", 'false ?', doctor),
        ('M36-doctor-layout-localization', i18n,
         "    ?? replaceMatch(source, /^The Codex daemon process ownership is verified \\((.*)\\)\\.$/, (layouts) => `Codex daemon 进程的归属已验证（${layouts}）。`)\n", '', doctor),
    ])
    receipt('M37-stale-fresh-pid-blocks-live', selection, early_conflict, 'stale-fresh-pid-plus-live')
    receipt('M38-stale-fresh-start-blocks-live', selection, early_conflict, 'stale-fresh-start-plus-live')
    receipt('M39-stale-reused-pid-blocks-live', '    if (receiptStart !== undefined) {', """    if (receiptStart !== undefined && !sameCodexInstallation(realpathSync(`/proc/${pid}/exe`), realpathSync(cli), home)) {
      return unknown('Codex daemon executable does not match this installation.');
    }
    if (receiptStart !== undefined) {""", 'stale-reused-pid-plus-live')
    receipt('M40-ignore-distinct-live-pids', 'other.pid !== daemon.pid || ', '', 'two-live-distinct-pids')
    receipt('M41-first-live-receipt-wins', '    verified.push({ layout: record.layout, process: inspected.process });', '    if (verified.length) continue;\n    verified.push({ layout: record.layout, process: inspected.process });', 'two-live-distinct-starts')
    receipt('M42-all-stale-is-unknown', "if (inspected.state === 'absent') continue;", "if (inspected.state === 'absent') return unknown('Stale receipt.');", 'two-stale-receipts')
    receipt('M43-unreadable-start-is-absent', "if (!start) return unknown('Codex daemon process start time could not be read.');", "if (!start) return { state: 'absent' };", 'unreadable-process-start')
    receipt('M44-include-stale-layout-evidence', 'verified.map(({ layout }) => layout) }', 'records.map(({ layout }) => layout) }', 'stale-legacy-pid-plus-live')
    results = []
    try:
        for name, path, old, new, command in mutations:
            original = originals[path]
            if original.count(old) != 1:
                raise RuntimeError(f'{name}: expected one mutation site, got {original.count(old)}')
            try:
                (root / path).write_text(original.replace(old, new, 1))
                run = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True, timeout=60)
                log = run.stdout + run.stderr
                (output / f'{name}.log').write_text(log)
                killed = run.returncode != 0 and ('AssertionError' in log or 'FAIL ' in log)
                results.append({'name': name, 'killed': killed, 'exitCode': run.returncode, 'command': command})
                print(f'{name}: {"KILLED" if killed else "SURVIVED"}', flush=True)
            finally:
                (root / path).write_text(original)
        for name, command in [('restored-receipts', test[:-1]), ('restored-doctor', doctor)]:
            run = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True, timeout=60)
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
