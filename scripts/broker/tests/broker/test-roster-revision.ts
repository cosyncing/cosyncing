#!/usr/bin/env bun
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  waitForBrokerHealth,
} from '../helpers/isolated-broker-fixture.ts';
import type { SessionInfo } from '../../../../packages/typescript/protocol/src/index.ts';
import { RosterRevisionStore } from '../../../../packages/typescript/broker/src/roster-revision.ts';

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const session = (status: SessionInfo['status'], title = 'One'): SessionInfo => ({
  id: 's1',
  tool: 'codex',
  machine: 'host-a',
  title,
  status,
  attachMode: 'observe',
  currentModel: { providerID: 'openai', modelID: 'gpt-5.4' },
});

const store = new RosterRevisionStore(3);
store.reconcile([session('idle')], 'host-a');
const baseline = store.revision;
check('initial reconcile establishes one revision', baseline === 1, `revision=${baseline}`);

store.observe(session('working'), 'host-a');
store.observe(session('idle'), 'host-a');
const transitions = store.eventsAfter(baseline);
check(
  'working and idle remain ordered semantic transitions',
  transitions.deltas.length === 2 &&
    transitions.deltas[0]?.session?.status === 'working' &&
    transitions.deltas[1]?.session?.status === 'idle',
);
check(
  'delta contains roster metadata but no transcript/telemetry/tool output',
  !JSON.stringify(transitions).match(/messages|telemetry|toolOutput|history/),
);

const beforeDuplicate = store.revision;
check(
  'identical metadata does not bump revision',
  store.observe(session('idle'), 'host-a') === undefined && store.revision === beforeDuplicate,
);

const pending = store.waitAfter(store.revision, 1000);
store.observe(session('needs-input', 'Needs approval'), 'host-a');
const awakened = await pending;
check(
  'long poll wakes on the next change',
  awakened.deltas.length === 1 && awakened.deltas[0]?.session?.status === 'needs-input',
);

store.observe(session('working', 'Again'), 'host-a');
store.observe(session('idle', 'Done'), 'host-a');
const gap = store.eventsAfter(0);
check('bounded journal reports a cursor gap', gap.resetRequired === true && gap.deltas.length === 0);

const futureCursor = store.eventsAfter(store.revision + 20);
check('broker restart/future cursor requires reset', futureCursor.resetRequired === true);

store.reconcile([], 'host-a');
const removal = store.eventsAfter(store.revision - 1).deltas[0];
check('reconcile emits a bounded removal', removal?.removed === true && removal.sessionId === 's1');

const incarnationStore = new RosterRevisionStore(16);
incarnationStore.reconcile([{
  ...session('working'),
  id: 'old-incarnation',
  nativeId: 'claude-bridge:exact-native',
  tool: 'claude',
}], 'host-a');
const incarnationRevision = incarnationStore.revision;
incarnationStore.reconcile([{
  ...session('idle'),
  id: 'replacement-incarnation',
  nativeId: 'claude-bridge:exact-native',
  tool: 'claude',
}], 'host-a');
const incarnationDeltas = incarnationStore.eventsAfter(incarnationRevision).deltas;
check(
  'cross-incarnation reconcile retires the old row before publishing its exact-native replacement',
  incarnationDeltas.length === 2 &&
    incarnationDeltas[0]?.removed === true &&
    incarnationDeltas[0]?.sessionId === 'old-incarnation' &&
    incarnationDeltas[1]?.session?.id === 'replacement-incarnation',
  JSON.stringify(incarnationDeltas.map((delta) => ({ id: delta.sessionId, removed: delta.removed }))),
);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate a test port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

const testHome = mkdtempSync(join(tmpdir(), 'cosyncing-roster-revision-'));
const piRoot = join(testHome, 'pi-sessions');
const piProject = join(piRoot, '--fixture--');
const agingFile = join(piProject, '2026-07-29_aging.jsonl');
const deletedFile = join(piProject, '2026-07-29_deleted.jsonl');
mkdirSync(piProject, { recursive: true });
const piLine = `${JSON.stringify({ type: 'session', id: 'fixture', cwd: testHome })}\n`;
writeFileSync(agingFile, piLine);
writeFileSync(deletedFile, piLine);
// Real Claude replacement shape: transcript bridge sidecar uses `cse_`, the live native registry
// uses `session_`, and the adapter ids differ. Only the registry-selected source generation may
// reach the broker roster.
const claudeProject = join(testHome, 'claude', 'projects', '-fixture-workspace');
const claudeSessions = join(testHome, 'claude', 'sessions');
mkdirSync(claudeProject, { recursive: true });
mkdirSync(claudeSessions, { recursive: true });
const oldClaudeId = '11111111-1111-4111-8111-111111111111';
const replacementClaudeId = '22222222-2222-4222-8222-222222222222';
const bridgeSuffix = '0123456789abcdefghijklmn';
const claudeLine = (value: unknown): string => `${JSON.stringify(value)}\n`;
writeFileSync(join(claudeProject, `${oldClaudeId}.jsonl`), [
  claudeLine({ type: 'custom-title', customTitle: 'Claude replacement fixture', sessionId: oldClaudeId }),
  claudeLine({ type: 'user', uuid: 'old-user', sessionId: oldClaudeId, cwd: '/fixture/workspace', timestamp: '2026-08-03T10:00:00.000Z', message: { role: 'user', content: 'fixture' } }),
  claudeLine({ type: 'assistant', uuid: 'old-tool', sessionId: oldClaudeId, timestamp: '2026-08-03T10:00:01.000Z', message: { id: 'old-assistant', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tool-old', name: 'Bash', input: { command: 'true' } }] } }),
  claudeLine({ type: 'bridge-session', bridgeSessionId: `cse_${bridgeSuffix}`, sessionId: oldClaudeId, lastSequenceNum: 1594 }),
].join(''));
writeFileSync(join(claudeProject, `${replacementClaudeId}.jsonl`), [
  claudeLine({ type: 'custom-title', customTitle: 'Claude replacement fixture', sessionId: replacementClaudeId }),
  claudeLine({ type: 'user', uuid: 'new-user', sessionId: replacementClaudeId, cwd: '/fixture/workspace', timestamp: '2026-08-03T11:00:00.000Z', message: { role: 'user', content: 'fixture' } }),
  claudeLine({ type: 'assistant', uuid: 'new-done', sessionId: replacementClaudeId, timestamp: '2026-08-03T11:00:01.000Z', message: { id: 'new-assistant', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }),
].join(''));
const oldRegistry = join(claudeSessions, 'old-dead.json');
const replacementRegistry = join(claudeSessions, 'replacement-dead.json');
writeFileSync(oldRegistry, JSON.stringify({
  sessionId: oldClaudeId,
  bridgeSessionId: `session_${bridgeSuffix}`,
  pid: 2_147_483_646,
  kind: 'bg',
  entrypoint: 'cli',
  cwd: '/fixture/workspace',
  startedAt: 1,
}));
writeFileSync(replacementRegistry, JSON.stringify({
  sessionId: replacementClaudeId,
  bridgeSessionId: `session_${bridgeSuffix}`,
  pid: 2_147_483_647,
  kind: 'bg',
  entrypoint: 'cli',
  cwd: '/fixture/workspace',
  startedAt: 2,
}));

const writeAmbiguousClaudePair = (
  title: string,
  suffix: string,
  ids: [string, string],
  generations: [number | undefined, number | undefined],
): void => {
  for (const [index, id] of ids.entries()) {
    writeFileSync(join(claudeProject, `${id}.jsonl`), [
      claudeLine({ type: 'custom-title', customTitle: title, sessionId: id }),
      claudeLine({ type: 'user', uuid: `${id}-user`, sessionId: id, cwd: '/fixture/workspace', message: { role: 'user', content: 'fixture' } }),
      claudeLine({ type: 'bridge-session', bridgeSessionId: `cse_${suffix}`, sessionId: id }),
    ].join(''));
    writeFileSync(join(claudeSessions, `${title}-${index}.json`), JSON.stringify({
      sessionId: id,
      bridgeSessionId: `session_${suffix}`,
      pid: 2_147_483_640 + index,
      ...(generations[index] === undefined ? {} : { startedAt: generations[index] }),
    }));
  }
};
writeAmbiguousClaudePair(
  'Claude tied generation fixture',
  'tiedgeneration',
  ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'],
  [3, 3],
);
writeAmbiguousClaudePair(
  'Claude missing generation fixture',
  'missinggeneration',
  ['55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'],
  [4, undefined],
);
const port = await freePort();
const startRosterBroker = (listenPort: number): ReturnType<typeof Bun.spawn> =>
  Bun.spawn(['bun', 'packages/typescript/broker/src/main.ts'], {
  cwd: process.cwd(),
  env: isolatedBrokerFixtureEnvironment(testHome, {
    overrides: {
      PORT: String(listenPort),
      HOST: '127.0.0.1',
      HOME: testHome,
      XDG_CONFIG_HOME: join(testHome, '.config'),
      XDG_DATA_HOME: join(testHome, '.local', 'share'),
      XDG_STATE_HOME: join(testHome, '.local', 'state'),
      COSYNCING_HOME: testHome,
      COSYNCING_MACHINE: 'roster-http-test',
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
      COSYNCING_CODEX_SYNC_SERVER: '0',
      COSYNCING_PI_SESSIONS_ROOT: piRoot,
      PI_CODING_AGENT_SESSION_DIR: piRoot,
      PI_CODING_AGENT_DIR: join(testHome, '.pi', 'agent'),
      COSYNCING_ROSTER_SAFETY_RECONCILE_MS: '1000',
      COSYNCING_RESTART_DRY_RUN: '1',
    },
  }),
  stdout: 'ignore',
  stderr: 'pipe',
});
const broker = startRosterBroker(port);
const brokerOutput = captureProcessOutput(broker);
const base = `http://127.0.0.1:${port}`;
try {
  // Readiness gets no wall-clock budget of its own: a broker booting beside
  // other suites is slow, not broken, and the fixed 10s here was really a
  // claim about how fast the host is.
  let healthy = true;
  try {
    await waitForBrokerHealth(broker, `${base}/api/health`);
  } catch (error) {
    healthy = false;
    console.log(`      ${(error as Error).message}\n${brokerOutput.read().trim().slice(-2000)}`);
  }
  check('isolated broker starts for roster HTTP checks', healthy);
  if (healthy) {
    const sevenDaysMs = 7 * 86_400_000;
    // Admit the row with a comfortable margin. A one-second margin made the
    // snapshot race the broker scan under aggregate load.
    const agingAt = new Date(Date.now() - sevenDaysMs + 60_000);
    utimesSync(agingFile, agingAt, agingAt);
    const first = await fetch(`${base}/api/sessions`);
    const firstText = await first.text();
    const firstEtag = first.headers.get('etag');
    const firstBody = JSON.parse(firstText) as { revision?: number; generatedAt?: number };
    const repeat = await fetch(`${base}/api/sessions`);
    const repeatText = await repeat.text();
    check(
      'unchanged roster representation has stable body and ETag',
      first.ok && repeat.ok && firstText === repeatText && firstEtag != null && repeat.headers.get('etag') === firstEtag,
    );
    const notModified = await fetch(`${base}/api/sessions`, {
      headers: { 'if-none-match': firstEtag ?? '' },
    });
    check('matching roster ETag returns an empty 304', notModified.status === 304 && (await notModified.text()) === '');

    const claudeRoster = await (await fetch(`${base}/api/sessions?refresh=1`)).json() as { sessions?: SessionInfo[] };
    const claudeRows = (claudeRoster.sessions ?? []).filter((row) => row.title === 'Claude replacement fixture');
    check(
      'broker roster publishes one Claude logical session selected by exact bridge identity and source generation',
      claudeRows.length === 1 &&
        claudeRows[0]?.nativeId === `claude-bridge:${bridgeSuffix}` &&
        claudeRows[0]?.status === 'idle' &&
        Buffer.from(claudeRows[0]!.id, 'base64url').toString('utf8').endsWith(`${replacementClaudeId}.jsonl`),
      JSON.stringify({
        claudeRows: claudeRows.map((row) => ({ id: row.id, nativeId: row.nativeId, status: row.status })),
        allTools: [...new Set((claudeRoster.sessions ?? []).map((row) => row.tool))],
      }),
    );
    for (const title of ['Claude tied generation fixture', 'Claude missing generation fixture']) {
      const ambiguousRows = (claudeRoster.sessions ?? []).filter((row) => row.title === title);
      check(
        `${title} retires neither incarnation`,
        ambiguousRows.length === 2 && ambiguousRows.every((row) => row.nativeId?.startsWith('claude-bridge:')),
        JSON.stringify(ambiguousRows.map((row) => ({ id: row.id, nativeId: row.nativeId }))),
      );
    }

    const deltas = await fetch(
      `${base}/api/session-roster-deltas?after=${firstBody.revision ?? 0}&waitMs=1`,
    );
    const deltaBody = await deltas.json() as Record<string, unknown>;
    check(
      'delta endpoint returns only bounded roster metadata',
      deltas.ok && !JSON.stringify(deltaBody).match(/messages|telemetry|toolOutput|history/),
    );
    const future = await fetch(
      `${base}/api/session-roster-deltas?after=${(firstBody.revision ?? 0) + 100}&waitMs=0`,
    );
    const futureBody = await future.json() as { resetRequired?: boolean };
    check('HTTP future cursor requests a reset', future.ok && futureBody.resetRequired === true);

    const windowed = await fetch(`${base}/api/sessions?window=7d&refresh=1`);
    const windowedBody = await windowed.json() as {
      revision: number;
      sessions: SessionInfo[];
    };
    const agingId = Buffer.from(agingFile).toString('base64url');
    const deletedId = Buffer.from(deletedFile).toString('base64url');
    check(
      'seven-day snapshot contains both in-window fixture rows',
      windowedBody.sessions.some((row) => row.id === agingId) &&
        windowedBody.sessions.some((row) => row.id === deletedId),
    );

    // Move the same native row past the cutoff after proving it was admitted;
    // the live-feed assertion now tests reconciliation rather than wall time.
    const expiredAt = new Date(Date.now() - sevenDaysMs - 1000);
    utimesSync(agingFile, expiredAt, expiredAt);

    let agedBatch: {
      revision: number;
      deltas: Array<{ sessionId: string; removed?: true }>;
    } = { revision: windowedBody.revision, deltas: [] };
    // A periodic safety reconciliation may become due just before the cutoff
    // and legitimately consume the first request's wait. The real client
    // immediately opens its next bounded long poll; mirror at most that one
    // extra cycle rather than relying on scheduler timing.
    for (let attempt = 0; attempt < 2; attempt++) {
      const agedResponse = await fetch(
        `${base}/api/session-roster-deltas?window=7d&after=${agedBatch.revision}&waitMs=2500`,
      );
      agedBatch = await agedResponse.json() as typeof agedBatch;
      if (agedBatch.deltas.some((delta) => delta.sessionId === agingId && delta.removed === true)) break;
    }
    check(
      'idle row crossing seven days disappears through the bounded live feed',
      agedBatch.deltas.some((delta) => delta.sessionId === agingId && delta.removed === true),
      JSON.stringify(agedBatch),
    );

    unlinkSync(deletedFile);
    await Bun.sleep(1100);
    const deletedResponse = await fetch(
      `${base}/api/session-roster-deltas?window=7d&after=${agedBatch.revision}&waitMs=0`,
    );
    const deletedBatch = await deletedResponse.json() as {
      revision: number;
      deltas: Array<{ sessionId: string; removed?: true }>;
    };
    check(
      'native deletion disappears through the same source-bounded live feed',
      deletedBatch.deltas.some((delta) => delta.sessionId === deletedId && delta.removed === true),
      JSON.stringify(deletedBatch),
    );

    // Claude removes its pid registry on clean exit. The exact generation winner must survive both
    // that removal and a cold broker process, while the retired Working transcript stays hidden.
    broker.kill();
    await broker.exited.catch(() => null);
    unlinkSync(oldRegistry);
    unlinkSync(replacementRegistry);
    const coldPort = await freePort();
    const coldBroker = startRosterBroker(coldPort);
    const coldOutput = captureProcessOutput(coldBroker);
    try {
      await waitForBrokerHealth(coldBroker, `http://127.0.0.1:${coldPort}/api/health`);
      const coldRoster = await (
        await fetch(`http://127.0.0.1:${coldPort}/api/sessions?refresh=1`)
      ).json() as { sessions?: SessionInfo[] };
      const coldRows = (coldRoster.sessions ?? []).filter((row) => row.title === 'Claude replacement fixture');
      check(
        'Claude replacement survives dead pids, registry deletion, and cold broker restart',
        coldRows.length === 1 &&
          coldRows[0]?.status === 'idle' &&
          coldRows[0]?.nativeId === `claude-bridge:${bridgeSuffix}` &&
          Buffer.from(coldRows[0]!.id, 'base64url').toString('utf8').endsWith(`${replacementClaudeId}.jsonl`),
        JSON.stringify(coldRows.map((row) => ({ id: row.id, nativeId: row.nativeId, status: row.status }))),
      );
    } catch (error) {
      check('cold broker restarts after Claude registry deletion', false, `${String(error)} ${coldOutput.read().slice(-1000)}`);
    } finally {
      coldBroker.kill();
      await coldBroker.exited.catch(() => null);
    }
  }
} finally {
  broker.kill();
  await broker.exited.catch(() => null);
  rmSync(testHome, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} roster revision checks passed.`);
if (failed.length) process.exit(1);
