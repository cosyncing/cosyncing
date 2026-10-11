#!/usr/bin/env python3
"""Checkpoint PR-2 mutations, one at a time, restoring exact source bytes after each run."""
import argparse
import json
import os
from pathlib import Path
import subprocess

adapter = Path('packages/typescript/adapters/codex/src/implementation.ts')
reviewer = Path('packages/typescript/adapters/codex/src/daemon-reviewer.ts')
runtime = Path('packages/typescript/broker/src/updates/runtime-update-providers.ts')
hub = Path('packages/typescript/broker/src/sessions/hub.ts')
parser = argparse.ArgumentParser()
parser.add_argument('--names', nargs='*')
parser.add_argument('--output', type=Path, default=Path('output/review/lane-a2/pr2-mutations'))
args = parser.parse_args()
out = args.output
out.mkdir(parents=True, exist_ok=True)
# Each mutation targets a behavior asserted by a production adapter/Hub or doctor fixture.
cases = [
 ('force-stdio-new', adapter, '  const run = shared\n', '  const run = false\n', 'app'),
 ('drop-daemon-start-cwd', adapter, "const started = await rpc('thread/start', {\n      cwd,", "const started = await rpc('thread/start', {", 'app'),
 ('restore-terminal-sync-active-refusal', adapter, "    const providerReason = codexSharedProviderReason(surface.currentModel?.providerID", "    if (mode === 'resume' && liveLoaded) throw new OwnershipConflictError('terminal-sync-active', 'terminal-sync-active');\n    const providerReason = codexSharedProviderReason(surface.currentModel?.providerID", 'app'),
 ('emit-handoff-again', adapter, "        terminalSyncAction: 'join',", "        terminalSyncAction: 'handoff',", 'app'),
 ('exclude-app-restart-blockers', runtime, 'const loaded = await deps.loadedThreads();', "const loaded = (await deps.loadedThreads()).filter((entry) => entry.id !== 'app-thread');", 'app'),
 ('doctor-ignore-reviewer-override', reviewer, "typeof entry?.auto_review_model_override === 'string'\n      && entry.auto_review_model_override.trim()", 'true', 'doctor'),
 ('doctor-ignore-approvals-reviewer', reviewer, "effective.approvals_reviewer !== 'auto_review'", 'false', 'doctor'),
 ('doctor-throw-missing-home', reviewer, '  } catch { /* a missing or unreadable home cannot enumerate profiles */ }', '  } catch (error) { throw error; }', 'doctor'),
 ('doctor-skip-base-config', reviewer, "    { label: 'config.toml', effective: base },\n", '', 'doctor'),
 ('doctor-ignore-startup-catalog', reviewer, "if (typeof base.model_catalog_json === 'string')", 'if (false)', 'doctor'),
 ('doctor-check-openai-provider', reviewer, "(effective.model_provider ?? 'openai') === 'openai'", 'false', 'doctor'),
 ('ignore-daemon-transport-close', adapter, 'this.daemon === daemon && !this.closeFlight', 'false', 'app'),
 ('retain-stale-shared-presence', adapter, '  private daemonLost(): void {\n', '  private daemonLost(): void {\n    const stalePresence = this.info.control?.terminalSync.presence;\n', 'stale'),
 ('force-stdio-cold-drive', adapter, "const transport = liveEligible ? 'daemon-proxy' : 'stdio';", "const transport = 'stdio';", 'app'),
 ('allow-profile-only-on-daemon', adapter, "if (resolution?.source === 'base') return undefined;", 'return undefined;', 'app'),
 ('omit-fallback-reason', adapter, "const CODEX_DAEMON_UNAVAILABLE_REASON = 'The shared Codex daemon is not running or reachable. Start it to enable terminal sync; the app can still Drive privately.';", "const CODEX_DAEMON_UNAVAILABLE_REASON = '';", 'app'),
 ('ignore-sync-disabled-on-create', adapter, 'const sock = syncEnabled && !providerReason ?', 'const sock = !providerReason ?', 'app'),
 ('ignore-socket-replacement', adapter, '!== this.daemonRuntimeFingerprint', '=== this.daemonRuntimeFingerprint', 'app'),
 ('omit-create-effort', adapter, 'if (model?.reasoningEffort) {', 'if (false) {', 'app'),
 ('allow-model-fallback', adapter, 'allowProviderModelFallback: false,', 'allowProviderModelFallback: true,', 'app'),
 ('ignore-empty-rollout-provider', adapter, "?? firstMetadataString([meta], ['modelProvider', 'model_provider', 'provider'])", '?? undefined', 'app'),
 ('replace-roster-owner-with-observe', adapter, "    // reconnects on the next action. A loader snapshot must not replace it with Observe.\n    for (const owner of this.openOwners)", "    // reconnects on the next action. A loader snapshot must not replace it with Observe.\n    for (const owner of [] as CodexRepairableOwner[])", 'app'),
 ('split-hub-daemon-owners', hub, 'if (sharedModes?.length && (mode === undefined || sharedModes.includes(mode)))', 'if (false)', 'app'),
 ('omit-shared-owner-hook', adapter, "readonly sharedMutableAttachModes = ['resume', 'live'] as const;", 'readonly sharedMutableAttachModes = [] as const;', 'app'),
 ('ignore-private-owner-projection', adapter, "?? (privateOwner ? privateOwner.info.control?.terminalSync.reason ?? CODEX_DAEMON_UNAVAILABLE_REASON : undefined)", '?? undefined', 'app'),
 ('promote-private-observers', adapter, "if (!owner.reconcileDaemonTransport || owner.info.attachMode !== 'live') continue;", "if (owner.info.attachMode !== 'live' && owner.info.attachMode !== 'resume') continue;", 'app'),
 ('ignore-discovery-owner-projection', adapter, 'return this.preserveOpenOwners(out, liveThreadIds);', 'return out;', 'app'),
 ('ignore-unowned-socket-boundary', adapter, "inspectCodexRuntimeSocket(codexAppServerSock()).state !== 'socket' ? CODEX_DAEMON_UNAVAILABLE_REASON", "false ? CODEX_DAEMON_UNAVAILABLE_REASON", 'app'),
 ('ignore-unowned-profile-boundary', adapter, 'const reason = codexSharedProviderReason(provider)', 'const reason = undefined', 'app'),
 ('ignore-discovery-provider-metadata', adapter, "surface.currentModel?.providerID ?? firstMetadataString([meta], ['modelProvider', 'model_provider', 'provider']),", 'surface.currentModel?.providerID,', 'app'),
 ('drop-create-history-mode', adapter, "historyMode: 'legacy',", "historyMode: 'disabled',", 'app'),
 ('drop-create-model', adapter, '            model: model.modelID,', '            model: undefined,', 'app'),
 ('drop-create-provider', adapter, '            modelProvider: model.providerID,', '            modelProvider: undefined,', 'app'),
]
results_path = out / 'results.json'
results = json.loads(results_path.read_text()) if results_path.exists() else []
for name, path, original, mutation, suite in cases:
    if args.names and name not in args.names:
        continue
    before = path.read_bytes()
    source = before.decode()
    if original not in source:
        raise RuntimeError(f'Mutation anchor missing: {name}')
    changed = source.replace(original, mutation, 1)
    if suite == 'stale':
        anchor = "    this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { control: this.info.control, terminalSyncHint: this.info.terminalSyncHint } });\n  }\n\n  private async reconnectDaemon"
        assert anchor in changed
        changed = changed.replace(anchor, "    this.info.control!.terminalSync.presence = stalePresence;\n" + anchor, 1)
        suite = 'app'
    try:
        path.write_text(changed)
        command = ['bun', 'run', 'packages/typescript/broker/test/codex/app-daemon.ts'] if suite == 'app' else ['bun', 'run', 'test:broker-doctor']
        isolated = out / 'codex-home'
        isolated.mkdir(exist_ok=True)
        run = subprocess.run(command, env={**os.environ, 'CODEX_HOME':str(isolated.resolve())}, capture_output=True, text=True, timeout=25)
        log = run.stdout + run.stderr
        (out / (name + '.log')).write_text(log)
        killed = run.returncode != 0 and ('AssertionError' in log or 'FAIL ' in log or 'terminal-sync-active' in log)
        record = {'name':name, 'killed':killed, 'exitCode':run.returncode, 'log':str(out/(name+'.log'))}
    finally:
        path.write_bytes(before)
    results = [r for r in results if r['name'] != name] + [record]
    results_path.write_text(json.dumps(results,indent=2)+'\n')
    print(json.dumps(record),flush=True)
    if not killed:
        raise SystemExit(1)
