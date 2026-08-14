/**
 * Long-lived agent runtime freshness guardian.
 *
 * Version drift is freshness-class, not outage-class: automatic remediation waits indefinitely for
 * the provider's safe gate, while an explicit confirmed manual action may restart immediately.
 *
 *   bun run packages/typescript/broker/test/broker/test-runtime-update-guardian.ts
 */
export {};
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCodexConfigFreshnessProbe,
  readCodexDaemonVersion,
  restartCodexDaemon,
} from '../../../adapters/codex/src/index.ts';
import { normalizeOpencodeVersion } from '../../../adapters/opencode/src/managed-server.ts';
import {
  RUNTIME_UPDATE_OCCURRENCE_FINGERPRINT,
  RuntimeUpdateCoordinator,
  type RuntimeUpdateInspection,
  type RuntimeUpdateProvider,
} from '../../src/updates/runtime-update.ts';
import {
  codexThreadActivityFromNative,
  createCodexRuntimeUpdateProvider,
  createOpencodeRuntimeUpdateProvider,
  inspectionFromVersions,
  parseCodexDaemonVersionOutput,
} from '../../src/updates/runtime-update-providers.ts';
import {
  getCodexUpdatePolicy,
  setCodexUpdatePolicy,
} from '../../src/installation/setup-state.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

check('OpenCode CLI version normalization extracts the semantic version', normalizeOpencodeVersion('opencode 1.16.2\n') === '1.16.2');

{
  const temp = mkdtempSync(join(tmpdir(), 'cosyncing-codex-config-freshness-'));
  const configPath = join(temp, 'config.toml');
  const socketPath = join(temp, 'app-server-control.sock');
  writeFileSync(configPath, 'model = "old"\n');
  writeFileSync(socketPath, 'daemon generation 1');
  utimesSync(configPath, new Date(1_000), new Date(1_000));
  utimesSync(socketPath, new Date(2_000), new Date(2_000));
  const probe = createCodexConfigFreshnessProbe({ configPath, socketPath });
  try {
    const initial = await probe.inspect({
      status: 'running', cliVersion: '0.144.1', appServerVersion: '0.144.1', socketPath,
    });
    check('Codex user config older than the daemon generation is current', !initial.changed, JSON.stringify(initial));

    writeFileSync(configPath, 'model = "new"\n');
    utimesSync(configPath, new Date(3_000), new Date(3_000));
    const edited = await probe.inspect({
      status: 'running', cliVersion: '0.144.1', appServerVersion: '0.144.1', socketPath,
    });
    check('Codex user config content edit is detected within the same daemon generation', edited.changed, JSON.stringify(edited));
    check('Codex config content edit changes its internal semantic fingerprint',
      !!initial.fingerprint && !!edited.fingerprint && initial.fingerprint !== edited.fingerprint);

    writeFileSync(socketPath, 'daemon generation 2');
    utimesSync(socketPath, new Date(4_000), new Date(4_000));
    const restarted = await probe.inspect({
      status: 'running', cliVersion: '0.144.1', appServerVersion: '0.144.1', socketPath,
    });
    check('Codex daemon generation change accepts the current config fingerprint', !restarted.changed, JSON.stringify(restarted));

    rmSync(configPath);
    const deleted = await probe.inspect({
      status: 'running', cliVersion: '0.144.1', appServerVersion: '0.144.1', socketPath,
    });
    check('Codex user config deletion is detected within the same daemon generation', deleted.changed, JSON.stringify(deleted));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

{
  const temp = mkdtempSync(join(tmpdir(), 'cosyncing-codex-config-startup-'));
  const configPath = join(temp, 'config.toml');
  const socketPath = join(temp, 'app-server-control.sock');
  writeFileSync(socketPath, 'old daemon');
  writeFileSync(configPath, 'model = "edited-after-daemon-start"\n');
  utimesSync(socketPath, new Date(1_000), new Date(1_000));
  utimesSync(configPath, new Date(3_000), new Date(3_000));
  const probe = createCodexConfigFreshnessProbe({ configPath, socketPath });
  try {
    const startup = await probe.inspect({
      status: 'running', cliVersion: '0.144.1', appServerVersion: '0.144.1', socketPath,
    });
    check('broker startup detects a Codex config newer than the existing daemon', startup.changed, JSON.stringify(startup));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// Agent definitions (`$CODEX_HOME/agents/*.toml`) are the same global daemon layer as config.toml and
// need a daemon restart to take effect, so the freshness probe must watch them too. Edits, additions, and
// deletions in the agents dir surface as a `configuration` change within the same daemon generation; a new
// socket generation re-baselines. Default `agentsDir = <dirname(configPath)>/agents`, so a temp configPath
// keeps this hermetic.
{
  const temp = mkdtempSync(join(tmpdir(), 'cosyncing-codex-agents-freshness-'));
  const configPath = join(temp, 'config.toml');
  const socketPath = join(temp, 'app-server-control.sock');
  const agentsDir = join(temp, 'agents');
  mkdirSync(agentsDir);
  writeFileSync(configPath, 'model = "base"\n');
  writeFileSync(join(agentsDir, 'glm.toml'), 'name = "glm"\n');
  writeFileSync(socketPath, 'daemon generation 1');
  utimesSync(configPath, new Date(1_000), new Date(1_000));
  utimesSync(join(agentsDir, 'glm.toml'), new Date(1_000), new Date(1_000));
  utimesSync(agentsDir, new Date(1_000), new Date(1_000));
  utimesSync(socketPath, new Date(5_000), new Date(5_000));
  const probe = createCodexConfigFreshnessProbe({ configPath, socketPath });
  const inspect = () => probe.inspect({ status: 'running', cliVersion: '0.144.1', appServerVersion: '0.144.1', socketPath });
  try {
    const baseline = await inspect();
    check('Codex agent definitions older than the daemon are current', !baseline.changed, JSON.stringify(baseline));

    writeFileSync(join(agentsDir, 'glm.toml'), 'name = "glm"\ninstructions = "edited"\n');
    utimesSync(join(agentsDir, 'glm.toml'), new Date(6_000), new Date(6_000));
    const edited = await inspect();
    check('Codex agent definition content edit is detected', edited.changed, JSON.stringify(edited));

    // New socket generation re-baselines, then prove an ADDED agent file is detected on its own.
    writeFileSync(socketPath, 'daemon generation 2');
    utimesSync(socketPath, new Date(7_000), new Date(7_000));
    const rebaselined = await inspect();
    check('Codex agents re-baseline on a new daemon generation', !rebaselined.changed, JSON.stringify(rebaselined));
    writeFileSync(join(agentsDir, 'kimi.toml'), 'name = "kimi"\n');
    const added = await inspect();
    check('Codex agent definition addition is detected', added.changed, JSON.stringify(added));

    // Re-baseline again, then prove a REMOVED agent file is detected on its own.
    writeFileSync(socketPath, 'daemon generation 3');
    utimesSync(socketPath, new Date(9_000), new Date(9_000));
    utimesSync(join(agentsDir, 'kimi.toml'), new Date(8_000), new Date(8_000));
    utimesSync(join(agentsDir, 'glm.toml'), new Date(8_000), new Date(8_000));
    utimesSync(agentsDir, new Date(8_000), new Date(8_000));
    const rebaselined2 = await inspect();
    check('Codex agents re-baseline again on the next daemon generation', !rebaselined2.changed, JSON.stringify(rebaselined2));
    rmSync(join(agentsDir, 'glm.toml'));
    const removed = await inspect();
    check('Codex agent definition deletion is detected', removed.changed, JSON.stringify(removed));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// Broker startup: an agent definition edited AFTER the existing daemon started (agents mtime > socket
// mtime) is flagged stale on the very first inspect, mirroring the config.toml startup case.
{
  const temp = mkdtempSync(join(tmpdir(), 'cosyncing-codex-agents-startup-'));
  const configPath = join(temp, 'config.toml');
  const socketPath = join(temp, 'app-server-control.sock');
  const agentsDir = join(temp, 'agents');
  mkdirSync(agentsDir);
  writeFileSync(configPath, 'model = "base"\n');
  writeFileSync(socketPath, 'old daemon');
  writeFileSync(join(agentsDir, 'glm.toml'), 'name = "glm-edited-after-daemon-start"\n');
  utimesSync(configPath, new Date(1_000), new Date(1_000));
  utimesSync(socketPath, new Date(1_000), new Date(1_000));
  utimesSync(join(agentsDir, 'glm.toml'), new Date(3_000), new Date(3_000));
  utimesSync(agentsDir, new Date(3_000), new Date(3_000));
  const probe = createCodexConfigFreshnessProbe({ configPath, socketPath });
  try {
    const startup = await probe.inspect({ status: 'running', cliVersion: '0.144.1', appServerVersion: '0.144.1', socketPath });
    check('broker startup detects a Codex agent def newer than the existing daemon', startup.changed, JSON.stringify(startup));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

{
  const temp = mkdtempSync(join(tmpdir(), 'cosyncing-runtime-policy-'));
  const previous = process.env.COSYNCING_HOME;
  process.env.COSYNCING_HOME = temp;
  try {
    check('Codex update policy defaults to when-detached', getCodexUpdatePolicy() === 'when-detached');
    setCodexUpdatePolicy('when-idle');
    check('Codex update policy persists the exact reviewed spelling', getCodexUpdatePolicy() === 'when-idle');
    writeFileSync(join(temp, 'setup-state.json'), JSON.stringify({ codexUpdatePolicy: 'surprise-me' }));
    check('invalid persisted Codex update policy fails back to when-detached', getCodexUpdatePolicy() === 'when-detached');
  } finally {
    if (previous == null) delete process.env.COSYNCING_HOME;
    else process.env.COSYNCING_HOME = previous;
    rmSync(temp, { recursive: true, force: true });
  }
}

{
  const idle = codexThreadActivityFromNative('idle-id', { thread: { status: { type: 'idle' } } });
  const working = codexThreadActivityFromNative('working-id', { thread: { status: { type: 'active', activeFlags: [] } } });
  const approval = codexThreadActivityFromNative('approval-id', { thread: { status: { type: 'active', activeFlags: ['waitingOnApproval'] } } });
  const question = codexThreadActivityFromNative('question-id', { thread: { status: { type: 'active', activeFlags: ['waitingOnUserInput'] } } });
  const broken = codexThreadActivityFromNative('broken-id', { thread: { status: { type: 'systemError' } } });
  check('native Codex thread/read maps idle exactly', idle.status === 'idle', JSON.stringify(idle));
  check('native Codex thread/read maps active without waiting flags to working', working.status === 'working', JSON.stringify(working));
  check('native Codex waiting flags map to needs-input', approval.status === 'needs-input' && question.status === 'needs-input', JSON.stringify({ approval, question }));
  check('native Codex system errors remain visible unknown blockers', broken.status === 'unknown', JSON.stringify(broken));
}

function inspection(agent: string, updateAvailable: boolean, autoRestartReady: boolean): RuntimeUpdateInspection {
  return {
    agent,
    displayName: agent === 'codex' ? 'Codex' : 'OpenCode',
    managed: true,
    state: updateAvailable ? 'pending' : 'current',
    updateAvailable,
    autoRestartReady,
    installedVersion: updateAvailable ? '2.0.0' : '1.0.0',
    runningVersion: '1.0.0',
    checkedAt: Date.now(),
  };
}

{
  let busy = true;
  let restarted = 0;
  const provider = createOpencodeRuntimeUpdateProvider({
    readVersions: async () => ({ managed: true, installedVersion: '1.2.0', runningVersion: restarted ? '1.2.0' : '1.1.0' }),
    isBusy: () => busy,
    restart: async () => { restarted++; },
  });
  const blocked = await provider.inspect();
  check('OpenCode provider reports managed binary drift while busy', blocked.state === 'pending' && !blocked.autoRestartReady, JSON.stringify(blocked));
  busy = false;
  const ready = await provider.inspect();
  check('OpenCode provider becomes auto-restart-ready only when idle', ready.state === 'pending' && ready.autoRestartReady, JSON.stringify(ready));
  await provider.restart();
  const current = await provider.inspect();
  check('OpenCode provider re-probes current after managed serve restart', restarted === 1 && current.state === 'current', JSON.stringify(current));
}

function fakeProvider(agent: string, safe: boolean): RuntimeUpdateProvider & { restarts: number; safe: boolean } {
  return {
    agent,
    restarts: 0,
    safe,
    async inspect() {
      return inspection(agent, this.restarts === 0, this.safe);
    },
    async restart() {
      this.restarts++;
    },
  };
}

{
  const parsed = parseCodexDaemonVersionOutput(JSON.stringify({
    status: 'running',
    cliVersion: '0.144.1',
    appServerVersion: '0.142.5',
    socketPath: '/tmp/app-server.sock',
  }));
  check('Codex daemon version JSON preserves installed/running split', parsed?.cliVersion === '0.144.1' && parsed.appServerVersion === '0.142.5', JSON.stringify(parsed));
}

{
  const temp = mkdtempSync(join(tmpdir(), 'cosyncing-codex-runtime-'));
  const fake = join(temp, 'codex');
  const marker = join(temp, 'restart.txt');
  writeFileSync(fake, `#!/bin/sh\nif [ "$2 $3" = "daemon version" ]; then\n  printf '%s\\n' '{"status":"running","cliVersion":"0.144.1","appServerVersion":"0.142.5"}'\n  exit 0\nfi\nif [ "$2 $3" = "daemon restart" ]; then\n  printf restarted > '${marker}'\n  exit 0\nfi\nexit 2\n`);
  chmodSync(fake, 0o755);
  const previous = process.env.COSYNCING_CODEX_BIN;
  process.env.COSYNCING_CODEX_BIN = fake;
  try {
    const version = await readCodexDaemonVersion();
    await restartCodexDaemon();
    check('Codex native version probe parses the managed-daemon command', version?.cliVersion === '0.144.1' && version.appServerVersion === '0.142.5', JSON.stringify(version));
    check('Codex native restart uses daemon restart', readFileSync(marker, 'utf8') === 'restarted');
  } finally {
    if (previous == null) delete process.env.COSYNCING_CODEX_BIN;
    else process.env.COSYNCING_CODEX_BIN = previous;
    rmSync(temp, { recursive: true, force: true });
  }
}

{
  const temp = mkdtempSync(join(tmpdir(), 'cosyncing-codex-missing-'));
  const previousPath = process.env.PATH;
  const previousOverride = process.env.COSYNCING_CODEX_BIN;
  process.env.PATH = temp;
  process.env.COSYNCING_CODEX_BIN = join(temp, 'missing-codex');
  try {
    const version = await readCodexDaemonVersion();
    check('Codex version probe reports unavailable when the CLI is not installed', version === undefined, JSON.stringify(version));
  } finally {
    if (previousPath == null) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousOverride == null) delete process.env.COSYNCING_CODEX_BIN;
    else process.env.COSYNCING_CODEX_BIN = previousOverride;
    rmSync(temp, { recursive: true, force: true });
  }
}

{
  const pending = inspectionFromVersions({
    agent: 'codex',
    displayName: 'Codex',
    managed: true,
    installedVersion: '0.144.1',
    runningVersion: '0.142.5',
    safe: false,
    blockers: 3,
  });
  const current = inspectionFromVersions({
    agent: 'codex',
    displayName: 'Codex',
    managed: true,
    installedVersion: '0.144.1',
    runningVersion: '0.144.1',
    safe: true,
  });
  check('native version mismatch is pending and blocked', pending.state === 'pending' && pending.updateAvailable && !pending.autoRestartReady && pending.blockers === 3, JSON.stringify(pending));
  check('equal native versions are current', current.state === 'current' && !current.updateAvailable, JSON.stringify(current));
}

{
  let restarted = 0;
  const activities = [
    { id: 'thread-idle', status: 'idle' as const },
    { id: 'thread-unknown', status: 'unknown' as const, detail: 'thread/read timed out' },
  ];
  const provider = createCodexRuntimeUpdateProvider({
    readVersion: async () => ({ status: 'running', cliVersion: '0.144.1', appServerVersion: restarted ? '0.144.1' : '0.142.5' }),
    loadedThreads: async () => restarted ? [] : activities,
    policy: () => 'when-idle',
    restart: async () => { restarted++; },
  });
  const blocked = await provider.inspect();
  check(
    'Codex when-idle policy exposes idle and unknown blocker composition per id',
    !!(blocked.state === 'pending' &&
      blocked.blockers === 2 &&
      blocked.blockerComposition?.idle === 1 &&
      blocked.blockerComposition?.unknown === 1 &&
      blocked.blockerDetails?.some((entry) => entry.id === 'thread-unknown' && entry.status === 'unknown') &&
      !blocked.autoRestartReady),
    JSON.stringify(blocked),
  );
  await provider.restart();
  const current = await provider.inspect();
  check('Codex provider re-probes current after native restart', restarted === 1 && current.state === 'current', JSON.stringify(current));
}

{
  let restarted = 0;
  const provider = createCodexRuntimeUpdateProvider({
    readVersion: async () => ({ status: 'running', cliVersion: '0.144.1', appServerVersion: '0.144.1' }),
    readConfigFreshness: async () => ({
      changed: restarted === 0,
      fingerprint: restarted === 0 ? 'config-fingerprint-a' : 'config-fingerprint-current',
      detail: restarted === 0 ? 'Codex user configuration changed after this daemon started.' : 'Codex user configuration matches this daemon generation.',
    }),
    loadedThreads: async () => [],
    policy: () => 'when-detached',
    restart: async () => { restarted++ },
  });
  const pending = await provider.inspect();
  check(
    'Codex config-only drift is pending even when binary versions match',
    pending.state === 'pending' && pending.updateAvailable && pending.pendingChanges?.join(',') === 'configuration' && pending.autoRestartReady,
    JSON.stringify(pending),
  );
  check(
    'Codex config occurrence fingerprint remains internal to broker policy',
    pending[RUNTIME_UPDATE_OCCURRENCE_FINGERPRINT] === 'config-fingerprint-a'
      && !JSON.stringify(pending).includes('config-fingerprint-a'),
  );
  await provider.restart();
  const current = await provider.inspect();
  check('Codex config-only drift clears after daemon restart', current.state === 'current' && !current.updateAvailable, JSON.stringify(current));
}

{
  const provider = createCodexRuntimeUpdateProvider({
    readVersion: async () => ({ status: 'running', cliVersion: '0.144.1', appServerVersion: '0.142.5' }),
    loadedThreads: async () => { throw new Error('socket probe failed'); },
    policy: () => 'when-detached',
    restart: async () => undefined,
  });
  const status = await provider.inspect();
  check('Codex loaded-list probe failure fails closed', status.state === 'pending' && !status.autoRestartReady && /probe failed/i.test(status.detail ?? ''), JSON.stringify(status));
}

{
  const loaded = [
    { id: 'thread-idle-a', status: 'idle' as const },
    { id: 'thread-idle-b', status: 'idle' as const },
  ];
  const detached = createCodexRuntimeUpdateProvider({
    readVersion: async () => ({ status: 'running', cliVersion: '0.144.1', appServerVersion: '0.142.5' }),
    loadedThreads: async () => loaded,
    policy: () => 'when-detached',
    restart: async () => undefined,
  });
  const idle = createCodexRuntimeUpdateProvider({
    readVersion: async () => ({ status: 'running', cliVersion: '0.144.1', appServerVersion: '0.142.5' }),
    loadedThreads: async () => loaded,
    policy: () => 'when-idle',
    restart: async () => undefined,
  });
  const detachedStatus = await detached.inspect();
  const idleStatus = await idle.inspect();
  check('Codex when-detached policy blocks even all-idle loaded threads', !detachedStatus.autoRestartReady, JSON.stringify(detachedStatus));
  check('Codex when-idle policy permits restart when every native thread status is idle', idleStatus.autoRestartReady, JSON.stringify(idleStatus));
}

// Freshness drift while attached remains pending forever: repeated polls must never grow a timer-based
// force path or invoke restart behind an active client.
{
  const provider = fakeProvider('codex', false);
  const coordinator = new RuntimeUpdateCoordinator([provider]);
  for (let i = 0; i < 20; i++) await coordinator.refresh('codex', { autoRestart: true });
  const status = coordinator.get('codex');
  check('unsafe freshness drift stays pending indefinitely', provider.restarts === 0 && status?.state === 'pending', JSON.stringify(status));
}

// Broker startup/poll path: once the native safe gate is open, the coordinator restarts and re-probes
// before publishing current state.
{
  const provider = fakeProvider('codex', true);
  const coordinator = new RuntimeUpdateCoordinator([provider]);
  const status = await coordinator.refresh('codex', { autoRestart: true });
  check('safe freshness drift auto-restarts and re-probes', provider.restarts === 1 && status?.state === 'current', JSON.stringify(status));
}

// A process signal may arrive after the asynchronous inspection stored a restart-ready snapshot but
// before the coordinator invokes the provider. Re-check lifecycle state at that exact boundary.
{
  const provider = fakeProvider('codex', true);
  let restartAllowed = true;
  const coordinator = new RuntimeUpdateCoordinator([provider], {
    onStatus: () => { restartAllowed = false; },
    restartAllowed: () => restartAllowed,
  });
  const status = await coordinator.refresh('codex', { autoRestart: true });
  check(
    'broker shutdown gate suppresses an in-flight automatic runtime restart',
    provider.restarts === 0 && status?.state === 'pending',
    JSON.stringify(status),
  );
}

// OpenCode binary drift uses the same no-cap rule: busy means pending, idle means restart now.
{
  const provider = fakeProvider('opencode', false);
  const coordinator = new RuntimeUpdateCoordinator([provider]);
  await coordinator.refresh('opencode', { autoRestart: true });
  provider.safe = true;
  const status = await coordinator.refresh('opencode', { autoRestart: true });
  check('OpenCode drift waits for idle without a force cap', provider.restarts === 1 && status?.state === 'current', JSON.stringify(status));
}

// The visible manual escape hatch is intentionally stronger than automatic remediation. The HTTP route
// supplies confirmation; the coordinator records the force/manual intent and re-probes afterward.
{
  const provider = fakeProvider('codex', false);
  const coordinator = new RuntimeUpdateCoordinator([provider]);
  await coordinator.refresh('codex', { autoRestart: false });
  const status = await coordinator.restartNow('codex');
  check('manual restart bypasses the automatic safe gate and re-probes', provider.restarts === 1 && status?.state === 'current', JSON.stringify(status));
}

// Every stored inspection is observable by attention reconciliation, including the pending status
// before an automatic restart and the current status after its re-probe. Listener failures are
// isolated from the guardian result.
{
  const provider = fakeProvider('codex', true);
  const observed: string[] = [];
  const coordinator = new RuntimeUpdateCoordinator([provider], {
    onStatus: (status) => {
      observed.push(status.state);
      if (status.state === 'pending') throw new Error('attention store unavailable');
    },
  });
  const status = await coordinator.refresh('codex', { autoRestart: true });
  check(
    'runtime coordinator observes every stored status and isolates listener failures',
    status?.state === 'current' && observed.join(',') === 'pending,current',
    JSON.stringify({ status, observed }),
  );
}

const failed = results.filter((result) => !result.ok);
if (failed.length) {
  console.error(`\nFAIL: ${failed.length}/${results.length} runtime-update guardian check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} runtime-update guardian checks`);
