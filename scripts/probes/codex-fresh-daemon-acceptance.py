#!/usr/bin/env python3
"""Opt-in fresh standalone acceptance; requires the physical slot and a complete local package."""
import argparse
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import subprocess
import tarfile
import tempfile
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', required=True, type=Path)
    parser.add_argument('--version', default='0.162.1-x86_64-unknown-linux-musl')
    parser.add_argument('--owner', required=True, type=Path)
    parser.add_argument('--output', default='output/review/lane-a1b/physical', type=Path)
    parser.add_argument('--port', default=17734, type=int)
    options = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    output = root / options.output
    output.mkdir(parents=True, exist_ok=True)
    assert options.owner.is_file() and str(root) in options.owner.read_text(), 'Physical slot is not owned by this worktree'
    # Never replace an existing listener or use a host's installed agent home.
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', options.port))
    home = Path(tempfile.mkdtemp(prefix='cosyncing-lane-a1b-fresh-'))
    release = home / 'packages/standalone/releases' / options.version
    release.mkdir(parents=True)
    with tarfile.open(options.package) as archive:
        archive.extractall(release, filter='data')
    (release / 'codex').symlink_to('bin/codex')
    (home / 'packages/standalone/current').symlink_to(release)
    cli = home / 'packages/standalone/current/bin/codex'
    (home / 'config.toml').write_text('[analytics]\nenabled = false\n')
    (home / 'sessions').mkdir()
    (home / 'app-server-daemon').mkdir()
    (home / 'app-server-daemon/settings.json').write_text('{"remoteControlEnabled":false}\n')
    tools = home / 'tools'
    tools.mkdir()
    bun = shutil.which('bun')
    assert bun
    (tools / 'bun').symlink_to(bun)
    env = {
        'PATH': f'{release / "bin"}:{tools}:/usr/local/bin:/usr/bin:/bin',
        'HOME': str(home), 'CODEX_HOME': str(home), 'XDG_CACHE_HOME': str(home / 'cache'),
        'LANG': 'C.UTF-8', 'TERM': 'dumb', 'COSYNCING_CODEX_BIN': str(cli),
        'COSYNCING_HOME': str(output / 'broker-state'), 'COSYNCING_CACHE_DIR': str(output / 'broker-state/cache'),
        'PORT': str(options.port), 'HOST': '127.0.0.1',
        'COSYNCING_CODEX_SYNC_SERVER': '1', 'COSYNCING_CLAUDE_HOOKS': '0', 'COSYNCING_CLAUDE_MOD_OFF': '1',
        'COSYNCING_OPENCODE_NO_AUTOSERVE': '1', 'OPENCODE_URL': 'http://127.0.0.1:1',
        'COSYNCING_TOKDASH_URL': 'http://127.0.0.1:1', 'COSYNCING_DSH_BASE_URL': 'http://127.0.0.1:1',
        'COSYNCING_KIMI_MANAGED_HOST': '0', 'COSYNCING_DSH_MANAGED_HOST': '0',
        'COSYNCING_CLINE_BIN': str(home / 'missing/cline'), 'COSYNCING_KILO_BIN': str(home / 'missing/kilo'),
        'COSYNCING_RUNTIME_UPDATE_POLL_MS': '600000', 'COSYNCING_RUNTIME_UPDATE_STATUS_TTL_MS': '0',
        'COSYNCING_RESTART_DRY_RUN': '1', 'COSYNCING_TOKEN': 'lane-a1b-local-fixture-token',
    }
    results = {'scratchHome': str(home), 'cli': str(cli), 'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    broker = None
    pidfds = []

    def run(args, name, overrides=None, timeout=30):
        p = subprocess.run(args, cwd=root, env={**env, **(overrides or {})}, text=True, capture_output=True, timeout=timeout)
        (output / f'{name}.stdout').write_text(p.stdout)
        (output / f'{name}.stderr').write_text(p.stderr)
        return p

    def receipt():
        return json.loads((home / 'app-server-daemon/daemon.pid').read_text())

    def bind_own(pid):
        fd = os.pidfd_open(pid)
        try:
            assert 'CODEX_HOME=' + str(home) in Path(f'/proc/{pid}/environ').read_bytes().decode().split('\0')
            assert os.readlink(f'/proc/{pid}/exe').startswith(str(home / 'packages') + '/')
        except BaseException:
            os.close(fd)
            raise
        pidfds.append(fd)
        return fd

    def exited(fd, timeout=5000):
        poll = select.poll()
        poll.register(fd, select.POLLIN)
        return bool(poll.poll(timeout))

    def http(path, body=None):
        request = urllib.request.Request(f'http://127.0.0.1:{options.port}{path}',
            data=json.dumps(body).encode() if body is not None else None,
            headers={'x-cosyncing-token': env['COSYNCING_TOKEN'], 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    def inspect(name):
        code = '''import {readCodexDaemonProcess} from './packages/typescript/adapters/codex/src/daemon-process.ts';
import {diagnoseCodexSetup} from './packages/typescript/adapters/codex/src/diagnostics.ts';
import {createSetupDiagnosisContext} from './packages/typescript/broker/src/installation/diagnosis-context.ts';
console.log(JSON.stringify({process:readCodexDaemonProcess(process.env.CODEX_HOME!,process.env.COSYNCING_CODEX_BIN!),
diagnosis:await diagnoseCodexSetup(createSetupDiagnosisContext())}));'''
        p = run([bun, '-e', code], name)
        assert p.returncode == 0, p.stderr
        result = json.loads(p.stdout)
        assert result['process']['state'] == 'running', result
        checks = result['diagnosis']['checks']
        ownership = next(c for c in checks if c['id'] == 'codex.daemon-ownership')
        assert ownership['status'] == 'pass' and ownership['evidence']['receiptLayouts'] == 'daemon.pid', ownership
        assert not [c for c in checks if c['status'] in ('fail', 'warn')], checks
        return result

    try:
        # Initialize only this synthetic broker's setup state. No service or agent integration is installed.
        code = '''import {defaultBrokerConfig,writeBrokerConfig} from './packages/typescript/broker/src/runtime/configuration.ts';
import {ensureInstallationCredentials} from './packages/typescript/broker/src/security/credentials.ts';
import {ensureOwnerOnlyDirectory} from './packages/typescript/broker/src/security/secure-files.ts';
const state=process.env.COSYNCING_HOME!;
const config=JSON.parse(JSON.stringify(defaultBrokerConfig())); config.broker.port=Number(process.env.PORT);
const saved=writeBrokerConfig(config,state);
ensureInstallationCredentials({home:state,internalUrl:saved.broker.internalUrl});
ensureOwnerOnlyDirectory(process.env.COSYNCING_CACHE_DIR!);
ensureOwnerOnlyDirectory(process.env.COSYNCING_CACHE_DIR!+'/artifacts/blobs');'''
        p = run([bun, '-e', code], 'scratch-broker-setup')
        assert p.returncode == 0, p.stderr
        env['COSYNCING_TOKEN'] = (output / 'broker-state/secrets/broker-token').read_text().strip()
        results['beforeReceipts'] = [name for name in ('daemon.pid', 'app-server.pid') if (home / 'app-server-daemon' / name).exists()]
        assert not results['beforeReceipts']
        p = run([str(cli), 'app-server', 'daemon', 'start'], 'native-start', timeout=60)
        results['nativeStart'] = {'exit': p.returncode, 'stdout': p.stdout}
        assert p.returncode == 0, p.stderr
        assert not (home / 'app-server-daemon/app-server.pid').exists()
        results['nativeReceiptBefore'] = receipt()
        old = receipt()['pid']
        oldfd = bind_own(old)
        results['before'] = inspect('doctor-before')
        # Explicit scratch socket disables automatic daemon startup in the hermetic broker.
        broker_env = {**env, 'COSYNCING_CODEX_APP_SERVER_SOCK': str(home / 'app-server-control/app-server-control.sock')}
        with (output / 'broker.log').open('w') as log:
            broker = subprocess.Popen([bun, 'run', 'packages/typescript/broker/src/main.ts'], cwd=root, env=broker_env, stdout=log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 20
        while True:
            try:
                results['health'] = http('/api/health')
                break
            except (OSError, urllib.error.URLError):
                if time.monotonic() >= deadline:
                    raise RuntimeError('Hermetic review broker did not become ready')
                time.sleep(.1)
        p = run([bun, '-e', "import {queryCodexLoadedThreadIdsStrict} from './packages/typescript/adapters/codex/src/index.ts'; console.log(JSON.stringify([...await queryCodexLoadedThreadIdsStrict()]));"], 'loaded-before')
        assert p.returncode == 0 and json.loads(p.stdout) == [], p.stderr
        start = time.monotonic()
        results['restart'] = http('/api/agent-runtime-updates/codex/restart', {'confirmRestart': True})
        results['restartElapsedMs'] = round((time.monotonic() - start) * 1000)
        assert results['restart']['ok'] is True, results['restart']
        assert exited(oldfd), 'Old process still lives after successful restart'
        results['oldProcessExited'] = True
        results['nativeReceiptAfter'] = receipt()
        assert receipt()['pid'] != old
        bind_own(receipt()['pid'])
        results['after'] = inspect('doctor-after')
        p = run([str(cli), 'app-server', 'daemon', 'version'], 'native-version-after')
        results['versionAfter'] = json.loads(p.stdout)
        assert p.returncode == 0 and results['versionAfter']['status'] == 'running'
        assert results['versionAfter']['cliVersion'] == results['versionAfter']['appServerVersion']
        p = run([bun, '-e', "import {queryCodexLoadedThreadIdsStrict} from './packages/typescript/adapters/codex/src/index.ts'; console.log(JSON.stringify([...await queryCodexLoadedThreadIdsStrict()]));"], 'loaded-after')
        assert p.returncode == 0 and json.loads(p.stdout) == [], p.stderr
        p = run([bun, 'run', 'packages/typescript/broker/src/cli/cli.ts', 'doctor', '--json'], 'cosy-doctor', overrides={'OPENCODE_URL': ''}, timeout=60)
        results['cosyDoctorExit'] = p.returncode
        results['cosyDoctor'] = json.loads(p.stdout)
        assert p.returncode == 0 and results['cosyDoctor']['ok'], results['cosyDoctor']['summary']
        results['passed'] = True
    finally:
        if broker:
            broker.terminate()
            try:
                broker.wait(timeout=10)
            except subprocess.TimeoutExpired:
                broker.kill()
                broker.wait(timeout=5)
            results['brokerExited'] = broker.returncode
        cleanup = []
        for name in ('daemon.pid', 'daemon-updater.pid', 'app-server.pid', 'app-server-updater.pid'):
            path = home / 'app-server-daemon' / name
            if not path.exists():
                continue
            pid = json.loads(path.read_text())['pid']
            try:
                fd = bind_own(pid)
                signal.pidfd_send_signal(fd, signal.SIGTERM)
                if not exited(fd):
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
                    assert exited(fd)
                cleanup.append({'receipt': name, 'pid': pid, 'exited': True})
            except ProcessLookupError:
                cleanup.append({'receipt': name, 'pid': pid, 'alreadyExited': True})
        for fd in pidfds:
            os.close(fd)
        results['cleanup'] = cleanup
        results['completedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        (output / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
        if cleanup and all(c.get('exited') or c.get('alreadyExited') for c in cleanup):
            shutil.rmtree(home)
    print(json.dumps({k: results[k] for k in ('passed', 'oldProcessExited', 'restartElapsedMs', 'cosyDoctorExit', 'cleanup') if k in results}, indent=2))


if __name__ == '__main__':
    main()
