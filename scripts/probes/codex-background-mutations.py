#!/usr/bin/env python3
"""Run bounded background-command mutations from the repository root, restoring each file."""
import json
import os
from pathlib import Path
import subprocess

source = Path('packages/typescript/adapters/codex/src/background-commands.ts')
hub = Path('packages/typescript/broker/src/sessions/hub.ts')
out = Path('output/codex-background-terminals/mutations')
out.mkdir(parents=True, exist_ok=True)
mutations = [
    ('socket-alias-resolution', Path('packages/typescript/adapters/codex/src/runtime-socket.ts'),
     'entry.isSymbolicLink() ? statSync(path) : entry', 'entry', 'control-socket symlinks'),
    ('socket-alias-drive-wiring', Path('packages/typescript/adapters/codex/src/implementation.ts'),
     '      const observation = inspectCodexRuntimeSocket(socket);',
     "      if (socket && lstatSync(socket).isSymbolicLink()) return 'unknown';\n      const observation = inspectCodexRuntimeSocket(socket);", 'control-socket symlinks'),
    ('socket-alias-reconnect-scope', Path('packages/typescript/adapters/codex/src/implementation.ts'),
     'this.daemon ? inspectCodexRuntimeSocket(codexAppServerSock()).fingerprint : undefined',
     'this.daemon ? codexAppServerSocketFingerprint(codexAppServerSock()) : undefined', 'actual Hub client lifecycle'),
    ('stdio-fixture-isolation', Path('packages/typescript/broker/test/codex/resume-fake.ts'),
     "  process.env.COSYNCING_CODEX_APP_SERVER_SOCK = join(dir, 'unused-app-server.sock');",
     '', 'isolate stdio fixtures'),
    ('exit-result', source, "entry.status = item.exitCode === 0 ? 'done' : 'error';", "entry.status = 'done';", 'preserve exact lifecycle'),
    ('stale-withdrawal', source,
     "if (entry.admitted && entry.status === 'running' && now - entry.evidenceAt >= BACKGROUND_STALE_MS)",
     'if (false)', 'preserve exact lifecycle'),
    ('snapshot-fence', source,
     "if (entry.status === 'done' || entry.status === 'error' || previous && entry.changed > startedVersion) continue;",
     'if (false) continue;', 'preserve exact lifecycle'),
    ('output-throttle', source,
     " || message.status === 'running' && old?.status === 'running' && this.now() - old.at < BACKGROUND_REEMIT_MIN_MS",
     '', 'reconcile capabilities'),
    ('client-gate-wiring', hub, '    this.conn.setClientCount?.(this.clients.size);', '', 'actual Hub client lifecycle'),
    ('legacy-negotiation', source,
     '|| error.message.startsWith(`Invalid request: unknown variant \\`${method}\\`, expected one of `)',
     '', 'reconcile capabilities'),
    ('full-history-overlay', Path('packages/typescript/adapters/codex/src/implementation.ts'),
     '    out.push(...(this.backgroundCommands?.replayCards() ?? []));', '', 'actual Hub client lifecycle'),
    ('stale-candidate', source, '&& now - entry.evidenceAt < BACKGROUND_STALE_MS', '', 'preserve exact lifecycle'),
    ('live-replacement', source, '    this.retain(); // a replacement is constructed before its predecessor closes',
     '', 'reconcile capabilities'),
    ('reconnect-resolution', source, '    return [...resolutions, ...current, {', '    return [...current, {', 'repair incremental reconnect'),
    ('eviction-reconciliation', source, "name: 'codex.background-running-snapshot'", "name: 'ignored-snapshot'", 'repair incremental reconnect'),
    ('preserve-completed-result', source, '      resolutions.push(card);',
     "      resolutions.push({ ...card, status: 'retired' });", 'repair incremental reconnect'),
    ('output-restoration', source, "          entry.status = 'running';", "          entry.status = 'retired';", 'repair incremental reconnect'),
    ('replayed-start', source,
     'entry.evidenceAt = previous && !reused ? Math.max(entry.evidenceAt, startEvidence) : startEvidence;',
     'entry.evidenceAt = now;', 'preserve exact lifecycle'),
]
results = []
for name, path, original, mutation, test_filter in mutations:
    before = path.read_text()
    if original not in before:
        raise RuntimeError(f'Mutation target missing: {name}')
    try:
        path.write_text(before.replace(original, mutation, 1))
        run = subprocess.run(['bun', 'run', 'packages/typescript/broker/test/codex/resume-fake.ts'],
            env=dict(os.environ, COSYNCING_TEST_FILTER=test_filter), capture_output=True, text=True, timeout=30)
        (out / f'{name}.log').write_text(run.stdout + run.stderr)
        killed = run.returncode != 0 and 'FAIL  Codex background commands' in run.stdout
        results.append(dict(name=name, killed=killed, returncode=run.returncode))
    finally:
        path.write_text(before)
(out / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results))
if not all(result['killed'] for result in results):
    raise SystemExit(1)
