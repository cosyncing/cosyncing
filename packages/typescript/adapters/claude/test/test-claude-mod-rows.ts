/**
 * The mod's effect on the Claude adapter, OFFLINE — no real claude, no model cost.
 *
 * Four things are decided here and nowhere else, so all four are pinned:
 *
 *   1. A FRESH registration makes the row `live`; a stale, dead, or absent one leaves it
 *      `observe`. Advertising `live` on a registration whose poll chain stopped would send the
 *      app's prompts into a queue nothing drains.
 *   2. Take over over a live registration is REFUSED as an ownership conflict. The terminal is
 *      the writer and the mod is already our channel; a second Claude on one transcript forks its
 *      history.
 *   3. A live attach WRITES THROUGH THE MOD. Every mutation becomes one queued command; nothing
 *      spawns, and a refusal is said out loud instead of dropping what the user typed.
 *   4. A transcript row the MOD inserted renders as steering, and a transcript type the adapter
 *      does not know is reported once. Both are about not lying to the person looking at the app.
 *
 * Env is set before the dynamic import: the default store and the launch binary are resolved at
 * module load. Same harness shape as `test-claude-takeover.ts`.
 *
 *   bun run packages/typescript/adapters/claude/test/test-claude-mod-rows.ts
 */
export {};
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeModConnection } from '../src/mod-connection.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const ROOT = join(tmpdir(), 'ca-claude-mod-rows');
rmSync(ROOT, { recursive: true, force: true });

const configDir = join(ROOT, 'claude-config');
const fakeBin = join(ROOT, 'fake-claude');
process.env.CLAUDE_CONFIG_DIR = configDir;
process.env.COSYNCING_CLAUDE_BIN = fakeBin;
process.env.COSYNCING_CLAUDE_WRAPPER_DIR = join(ROOT, 'no-wrappers');

const workspace = join(ROOT, 'workspace');
const slugDir = join(configDir, 'projects', '-test-mod-rows');
mkdirSync(workspace, { recursive: true });
mkdirSync(slugDir, { recursive: true });
mkdirSync(join(ROOT, 'no-wrappers'), { recursive: true });
const BUSY = '44444444-4444-4444-8444-444444444444';
writeFileSync(fakeBin, `#!/usr/bin/env bash\nprintf '%s\\n' '[{"sessionId":"${BUSY}","status":"busy"}]'\n`);
chmodSync(fakeBin, 0o755);

const UUID = '11111111-1111-4111-8111-111111111111';
const transcriptPath = join(slugDir, `${UUID}.jsonl`);
const enc = (p: string): string => Buffer.from(p, 'utf8').toString('base64url');

function line(row: Record<string, unknown>): string {
  return JSON.stringify(row);
}

writeFileSync(
  transcriptPath,
  [
    line({ type: 'user', uuid: 'u1', cwd: workspace, timestamp: '2026-10-04T09:00:00.000Z', sessionId: UUID, version: '2.1.289', message: { role: 'user', content: 'first prompt' } }),
    line({ type: 'assistant', uuid: 'a1', sessionId: UUID, version: '2.1.289', timestamp: '2026-10-04T09:00:05.000Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'answer' }] } }),
  ].join('\n') + '\n',
);

const {
  ClaudeAdapter,
  mapLine,
  CLAUDE_KNOWN_LINE_TYPES,
} = await import('../src/implementation.ts');
const { CLAUDE_MOD_COMMAND_REFUSAL, CLAUDE_MOD_LIVE_CONFLICT } = await import('../src/mod-presence.ts');
const { isOwnershipConflictError } = await import('@cosyncing/adapter-api');

// ── the injected registry ────────────────────────────────────────────────────
type ModState = { live: boolean; present: boolean; reasons: string[] };
const registry = new Map<string, ModState>();
const sent: { sessionId: string; command: { op: string; text?: string } }[] = [];
let refuseNext = false;
/** Refuse the next send with a specific code, so the words each refusal produces are pinned. */
let refuseWith: string | undefined;

function fresh(sessionId: string): void {
  registry.set(sessionId, { live: true, present: true, reasons: [] });
}
function stale(sessionId: string): void {
  registry.set(sessionId, { live: false, present: true, reasons: ['stale'] });
}

const bridge = {
  status: (sessionId: string) => registry.get(sessionId),
  send: (sessionId: string, command: { requestId: string; op: string; text?: string; queuedAt: number }) => {
    sent.push({ sessionId, command });
    if (refuseWith !== undefined) return { ok: false, code: refuseWith };
    return refuseNext ? { ok: false, code: 'queue_full' } : { ok: true };
  },
  steeringEnabled: () => true,
};

const withBridge = new ClaudeAdapter({ modBridge: bridge });
const withoutBridge = new ClaudeAdapter();

// ── 1. capabilities follow the bridge, not a wish ────────────────────────────
check(
  'a wired bridge advertises live',
  withBridge.capabilities.attachModes.includes('live') && withBridge.capabilities.supportsLiveAttach === true,
  JSON.stringify(withBridge.capabilities.attachModes),
);
check(
  'no bridge means no live advertised',
  !withoutBridge.capabilities.attachModes.includes('live') && withoutBridge.capabilities.supportsLiveAttach === false,
  JSON.stringify(withoutBridge.capabilities.attachModes),
);

// ── 2. the row reads live only on a fresh registration ───────────────────────
const bareRow = (await withoutBridge.discoverSessions()).find((row) => row.id === enc(transcriptPath));
check('an adapter with no bridge reads observe', bareRow?.attachMode === 'observe', String(bareRow?.attachMode));

const staleRow = (await withBridge.discoverSessions()).find((row) => row.id === enc(transcriptPath));
check('an unregistered session reads observe', staleRow?.attachMode === 'observe', String(staleRow?.attachMode));

stale(UUID);
const agedRow = (await withBridge.discoverSessions()).find((row) => row.id === enc(transcriptPath));
check(
  'a stale registration reads observe, not live',
  agedRow?.attachMode === 'observe' && agedRow.control?.terminalSync?.active !== true,
  `${agedRow?.attachMode} active=${String(agedRow?.control?.terminalSync?.active)}`,
);

fresh(UUID);
const liveRoster = await withBridge.discoverSessions();
const liveRow = liveRoster.find((row) => row.id === enc(transcriptPath));
check('a fresh registration reads live', liveRow?.attachMode === 'live', String(liveRow?.attachMode));
check(
  'a live row reports true sync active and full input',
  liveRow?.control?.terminalSync?.active === true
    && liveRow.control.terminalSync.supported === true
    && liveRow.control.terminalSync.input === 'full',
  JSON.stringify(liveRow?.control?.terminalSync),
);
check(
  'a live row offers no Take over',
  liveRow?.control?.drive?.supported === false && liveRow.control.drive.state === 'unavailable',
  JSON.stringify(liveRow?.control?.drive),
);
// No join command on a row that is already shared, and this is the check that keeps it that way.
// A client not itself in the sync offers `terminalSync.command` verbatim as its Join action, which
// for an older app means `claude --resume <uuid>` on a session whose terminal is already open and
// whose session the first mod now claims: a forked transcript, then a refusal. The tip the command
// used to feed renders from `label` and `note`.
check(
  'a live row offers no join command',
  liveRow?.control?.terminalSync?.command === undefined,
  String(liveRow?.control?.terminalSync?.command),
);
check(
  'and the sync tip still has its own words',
  liveRow?.control?.terminalSync?.label === 'Synced with your terminal'
    && String(liveRow.control.terminalSync.note).includes('mod'),
  JSON.stringify(liveRow?.control?.terminalSync),
);
await withBridge.discoverSessions();

// ── 3. Take over over a fresh registration is refused ────────────────────────
let refusal: unknown = null;
try {
  await withBridge.attach(enc(transcriptPath), 'resume');
} catch (error) {
  refusal = error;
}
check('take over over a live mod throws', refusal !== null && isOwnershipConflictError(refusal), String((refusal as Error)?.name));
check(
  'the refusal carries the ownership conflict category',
  (refusal as { conflict?: string } | null)?.conflict === CLAUDE_MOD_LIVE_CONFLICT,
  String((refusal as { conflict?: string } | null)?.conflict),
);

// …and only over a live one: the same adapter refuses nothing else, so Take over still works.
stale(UUID);
const resumed = await withBridge.attach(enc(transcriptPath), 'resume').catch((error: Error) => error);
check(
  'a stale registration does not refuse Take over',
  !(resumed instanceof Error) || resumed.name !== 'OwnershipConflictError',
  resumed instanceof Error ? resumed.message.slice(0, 80) : 'attached',
);
registry.delete(UUID);

// ── 4. a live attach writes through the mod, and says so when it cannot ──────
fresh(UUID);
const live = await withBridge.attach(enc(transcriptPath), 'live');
check('a live attach reports live', live.info.attachMode === 'live', String(live.info.attachMode));
await live.sendPrompt({ text: 'do the thing' } as never);
check('a prompt becomes one prompt command', sent.length === 1 && sent[0]?.command.op === 'prompt', JSON.stringify(sent));
check('the command carries the text and the session', sent[0]?.command.text === 'do the thing' && sent[0]?.sessionId === UUID, JSON.stringify(sent[0]));

live.info.status = 'working';
await live.sendPrompt({ text: 'and also this' } as never);
check(
  'a prompt typed mid-turn becomes steering',
  sent[1]?.command.op === 'steer',
  JSON.stringify(sent[1]?.command),
);
live.info.status = 'idle';

const seen: { type?: string; name?: string; message?: string }[] = [];
live.subscribe((m: { type?: string; name?: string; message?: string }) => seen.push(m));
refuseNext = true;
await live.sendPrompt({ text: 'this will not land' } as never);
check(
  'a refused command is said to the user rather than dropped',
  seen.some((m) => m.type === 'error' && /everything cosyncing can queue/.test(String(m.message))),
  JSON.stringify(seen),
);
refuseNext = false;


let stopped = 0;
const commands = await live.listCommands?.();
check('a live row advertises exactly the stop action', commands?.length === 1 && commands[0]?.name === 'stop', JSON.stringify(commands));
await live.runCommand?.('stop');
stopped = sent.filter((entry) => entry.command.op === 'abort').length;
check('the stop action becomes one abort command', stopped === 1, String(stopped));

// The refusals a user can act on are said in their own terms. A Stop with nothing running is not
// a malfunction, and a raw `no_active_turn` on the screen explains nothing to anyone who has not
// read the protocol.
const refusalWords: Record<string, string> = {};
for (const code of ['no_active_turn', 'stale_registration', 'queue_full', 'no_registration', 'anything_else']) {
  seen.length = 0;
  refuseWith = code;
  await live.runCommand?.('stop');
  refusalWords[code] = String(seen.find((m) => m.type === 'error')?.message ?? '');
}
refuseWith = undefined;
check(
  'Stop with nothing running says so in plain words',
  /Nothing is running in that terminal right now/.test(refusalWords.no_active_turn ?? ''),
  refusalWords.no_active_turn ?? '',
);
check(
  'a mod that has gone quiet says so too',
  /stopped reporting/.test(refusalWords.stale_registration ?? ''),
  refusalWords.stale_registration ?? '',
);
check(
  'and an unrecognised code keeps the honest generic sentence',
  refusalWords.anything_else === CLAUDE_MOD_COMMAND_REFUSAL,
  refusalWords.anything_else ?? '',
);


const beforeClose = sent.length;
await live.sendPrompt({ text: '   ' } as never);
check('an empty prompt queues nothing', sent.length === beforeClose, String(sent.length));
await live.close();

// A live attach with nothing behind it fails OPEN to observe, rather than queueing into a hole.
registry.delete(UUID);
const demoted = await withBridge.attach(enc(transcriptPath), 'live');
check(
  'a live attach with no fresh registration falls back to observe',
  demoted.info.attachMode === 'observe' && demoted.info.control?.terminalSync?.active !== true,
  `${demoted.info.attachMode} active=${String(demoted.info.control?.terminalSync?.active)}`,
);
await demoted.close();

// ── 4b. a mod that dies mid-attach stops the row reading Synced ───────────────
//
// The finding: an attach's control was decided once. A terminal that closes writes no transcript
// line, so neither the tail nor the watcher ever fires for it, and the row kept saying "Synced
// with your terminal" over a terminal that had shut down -- with a composer whose prompts were
// refused, and a Take over refused on the grounds that a mod was sharing the session. These drive
// the ONE path production has: attach live, then let a discovery pass find the registration gone.

fresh(UUID);
const dying = await withBridge.attach(enc(transcriptPath), 'live');
const frames: Record<string, unknown>[] = [];
dying.subscribe((m: Record<string, unknown>) => frames.push(m));
check('the attach starts synced', dying.info.attachMode === 'live' && dying.info.control?.terminalSync?.active === true,
  String(dying.info.attachMode));

// The terminal dies: the poll chain stops, and the registry calls the row stale. No transcript
// line is written by any of this, which is the whole problem.
stale(UUID);
await withBridge.discoverSessions();
check('a discovery pass that finds the registration gone demotes the attached row',
  dying.info.attachMode === 'observe' && dying.info.control?.terminalSync?.active === false,
  `${dying.info.attachMode} active=${String(dying.info.control?.terminalSync?.active)}`);
check('the demoted row stops claiming an active sync but keeps its attach',
  dying.info.control?.terminalSync?.supported === true && dying.info.control?.terminalSync?.syncAvailable === true,
  JSON.stringify(dying.info.control?.terminalSync));
check('the demoted row offers a takeover, because there is no longer a mod to collide with',
  dying.info.control?.drive?.supported === false && dying.info.control?.drive?.takeoverAvailable === true,
  JSON.stringify(dying.info.control?.drive));
check('the demotion is broadcast, not merely stored',
  frames.some((f) => f.type === 'metadata-update' && f.key === 'sessionInfo'),
  JSON.stringify(frames.map((f) => f.type)));
// CX2: a terminal closing is the ordinary end of a sync, not a failure. The restated control is
// what the row shows; an error row on every normal exit said something had gone wrong and that
// "nothing was sent" when nothing was being sent.
check('CX2: the demotion adds no error row: the restated control says it',
  !frames.some((f) => f.type === 'error'), JSON.stringify(frames.filter((f) => f.type === 'error')));

// A prompt sent after the loss must not be accepted and then vanish.
const sentBefore = sent.length;
let refused = '';
dying.subscribe((m: Record<string, unknown>) => { if (m.type === 'error') refused = String(m.message); });
await dying.sendPrompt({ text: 'is anyone there' } as never);
check('a prompt after the mod is gone queues nothing', sent.length === sentBefore, String(sent.length - sentBefore));
check('and it says so, rather than reporting a send', refused.includes('read-only'), refused.slice(0, 60));

// And the way back is the mod coming back -- not a manual repair.
fresh(UUID);
await withBridge.discoverSessions();
check('a mod that re-registers restores the synced row',
  dying.info.attachMode === 'live' && dying.info.control?.terminalSync?.active === true,
  `${dying.info.attachMode} active=${String(dying.info.control?.terminalSync?.active)}`);
const sentAfter = sent.length;
await dying.sendPrompt({ text: 'back again' } as never);
check('writes flow again once the registration is fresh', sent.length === sentAfter + 1, String(sent.length - sentAfter));
await dying.close();

// A closed connection stops being restated: the adapter must not hold it alive by its map.
const afterClose = dying.info.attachMode;
stale(UUID);
await withBridge.discoverSessions();
check('a closed connection is not re-written', dying.info.attachMode === afterClose, dying.info.attachMode);
fresh(UUID);

// ── 5. the row the mod inserted is steering; every other isMeta row is not ───
const callMeta = new Map();
const mapped: Record<string, unknown>[] = [];
const steerRow = {
  type: 'user',
  isMeta: true,
  uuid: 'steer-1',
  timestamp: '2026-10-04T09:05:00.000Z',
  origin: { kind: 'plugin', name: 'cosyncing-claude' },
  message: { role: 'user', content: [{ type: 'text', text: 'use the other approach' }] },
};
mapped.push(...(mapLine(steerRow, callMeta, new Set()) as Record<string, unknown>[]));
check('the mod’s row maps to one message', mapped.length === 1, JSON.stringify(mapped).slice(0, 160));
check('the mod’s row is a named steering event', mapped[0]?.type === 'event' && mapped[0]?.name === 'steering.message', JSON.stringify(mapped[0]));
check(
  'the steering event carries the text and who sent it',
  (mapped[0]?.payload as { text?: string; source?: string })?.text === 'use the other approach'
    && (mapped[0]?.payload as { source?: string })?.source === 'cosyncing-claude',
  JSON.stringify(mapped[0]?.payload),
);

const foreignMeta = mapLine(
  { type: 'user', isMeta: true, uuid: 'x1', message: { role: 'user', content: 'a system-injected string' } },
  callMeta, new Set(),
) as Record<string, unknown>[];
check('a foreign isMeta string row is still skipped', foreignMeta.length === 0, JSON.stringify(foreignMeta));

const sameShapeOtherPlugin = mapLine(
  {
    type: 'user', isMeta: true, uuid: 'x2',
    origin: { kind: 'plugin', name: 'some-other-mod' },
    message: { role: 'user', content: [{ type: 'text', text: 'not ours' }] },
  },
  callMeta, new Set(),
) as Record<string, unknown>[];
check(
  'another plugin’s isMeta row is not claimed as steering',
  !sameShapeOtherPlugin.some((m) => m.name === 'steering.message'),
  JSON.stringify(sameShapeOtherPlugin).slice(0, 120),
);

// ── 6. a type the adapter does not know is reported once, per mapping run ─────
//
// The nine types the 2026-10-05 audit found and this list did not have are known now, and stay
// known: `atis-latch` sits in 137 of the 576 files scanned, so every reopened month-old session
// used to file an inbox item saying cosyncing had lost some of it. The event is for a type NOBODY
// has seen, which is why the probe below uses a name that is not in the corpus at all.
check('cost-state is a known type', CLAUDE_KNOWN_LINE_TYPES.has('cost-state'), '');
const auditedNine = ['agent-setting', 'artifact-autoreact-ledger', 'artifact-comment-monitor', 'atis-latch', 'continued-in', 'file-history-delta', 'frame-link', 'relocated', 'worktree-state'];
const stillUnknown = auditedNine.filter((type) => !CLAUDE_KNOWN_LINE_TYPES.has(type));
check(
  'every type the audit saw is on the known list',
  stillUnknown.length === 0,
  JSON.stringify(stillUnknown),
);
const unseen = 'not-a-line-type-in-the-corpus';
check('the probe type is genuinely unseen', !CLAUDE_KNOWN_LINE_TYPES.has(unseen), unseen);
const unknownTypes = new Set<string>();
const firstReport = mapLine({ type: unseen, value: 1 }, callMeta, new Set(), undefined, undefined, undefined, unknownTypes);
const secondReport = mapLine({ type: unseen, value: 2 }, callMeta, new Set(), undefined, undefined, undefined, unknownTypes);
check(
  'an unknown type is reported once as a named event',
  firstReport.length === 1 && firstReport[0]?.type === 'event' && firstReport[0]?.name === 'transcript.unknown-type',
  JSON.stringify(firstReport),
);
const unknownEvent = firstReport[0]?.type === 'event' ? firstReport[0] : undefined;
check(
  'the event names the type it did not know',
  (unknownEvent?.payload as { lineType?: string } | undefined)?.lineType === unseen,
  JSON.stringify(unknownEvent),
);
check('the second occurrence is silent', secondReport.length === 0, JSON.stringify(secondReport));

const knownSkipped = mapLine({ type: 'mode', mode: 'default' }, callMeta, new Set(), undefined, undefined, undefined, new Set());
check('a known sidecar type is skipped without a report', knownSkipped.length === 0, JSON.stringify(knownSkipped));

// `fork-context-ref` is written only into subagent transcripts, which the adapter maps and the
// first audit never read; it raised an unknown-type report on every subagent replay.
const forkContextRef = mapLine({ type: 'fork-context-ref', parentUuid: 'u1' }, callMeta, new Set(), undefined, undefined, undefined, new Set());
check(
  'a subagent fork-context-ref row is known and skipped without a report',
  CLAUDE_KNOWN_LINE_TYPES.has('fork-context-ref') && forkContextRef.length === 0,
  JSON.stringify(forkContextRef),
);

// ── R4-8: one reading of the mod per row per roster tick ─────────────────────
// A reading is not free: the broker's status read sweeps holds, probes the pid and can retire the row.
// A counting bridge is the proof here, because the claim is a count.
{
  const extra = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  for (const id of extra) {
    writeFileSync(
      join(slugDir, `${id}.jsonl`),
      [
        line({ type: 'user', uuid: `u-${id}`, cwd: workspace, timestamp: '2026-10-04T09:10:00.000Z', sessionId: id, version: '2.1.292', message: { role: 'user', content: 'another prompt' } }),
        line({ type: 'assistant', uuid: `a-${id}`, sessionId: id, version: '2.1.292', timestamp: '2026-10-04T09:10:05.000Z', message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'text', text: 'answer' }] } }),
      ].join('\n') + '\n',
    );
  }
  const reads = new Map<string, number>();
  /** A session whose terminal dies right after its first reading this tick. */
  let diesAfterFirstRead: string | undefined;
  const counting = new ClaudeAdapter({
    modBridge: {
      status: (sessionId: string) => {
        const count = (reads.get(sessionId) ?? 0) + 1;
        reads.set(sessionId, count);
        if (sessionId === diesAfterFirstRead && count > 1) return { live: false, present: true, reasons: ['pid-dead'] };
        return { live: true, present: true, reasons: [] };
      },
      send: () => ({ ok: true }),
      steeringEnabled: () => true,
    },
  });
  // One session attached live, so the tick's restatement of attachments is inside the count.
  reads.clear();
  const attached = await counting.attach(enc(transcriptPath), 'live');
  check('R4-8 a live attach reads the bridge status once', reads.get(UUID) === 1 && reads.size === 1,
    JSON.stringify(Object.fromEntries(reads)));
  reads.clear();
  const rows = (await counting.discoverSessions()).filter((row) => row.origin !== 'subagent');
  const total = [...reads.values()].reduce((sum, count) => sum + count, 0);
  check('R4-8 a tick over N rows reads the bridge status exactly N times',
    rows.length >= 3 && total === rows.length && [...reads.values()].every((count) => count === 1),
    `${rows.length} rows, ${total} reads: ${JSON.stringify(Object.fromEntries(reads))}`);
  const liveControl = JSON.stringify(rows.find((row) => row.id === enc(transcriptPath))?.control);
  reads.clear();
  diesAfterFirstRead = extra[0];
  const dying = (await counting.discoverSessions()).find((row) => row.id === enc(join(slugDir, `${extra[0]}.jsonl`)));
  check('R4-8 a row whose pid dies between two would-be reads is built from one consistent reading',
    dying?.attachMode === 'live' && JSON.stringify(dying?.control) === liveControl,
    `${dying?.attachMode} ${JSON.stringify(dying?.control)}`);
  await attached.close?.();
}

// ── R4-12: one version comparison for the gate, setup and the smoke ─────────
{
  const { claudeVersionAtLeast, CLAUDE_MOD_MIN_VERSION } = await import('../src/mod-presence.ts');
  check('R4-12 the floor is 2.1.288', CLAUDE_MOD_MIN_VERSION === '2.1.288', CLAUDE_MOD_MIN_VERSION);
  for (const [version, expected] of [
    ['2.1.290', true], ['v2.1.290', true], ['2.1.290 (Claude Code)', true], ['2.1.288', true], ['2.1.287', false],
    ['2.1.290-beta.1', true], ['2.1.288-rc.1', false], ['2.1.1000', true], ['', false], ['Claude Code', false],
  ] as const) {
    check(`R4-12 claudeVersionAtLeast(${JSON.stringify(version)}) is ${expected}`, claudeVersionAtLeast(version) === expected,
      String(claudeVersionAtLeast(version)));
  }
  check('R4-12 a pre-release orders below its release and above an earlier pre-release',
    claudeVersionAtLeast('2.1.290-rc.2', '2.1.290-rc.1') && !claudeVersionAtLeast('2.1.290-rc.1', '2.1.290-rc.2')
      && claudeVersionAtLeast('2.1.290-rc.10', '2.1.290-rc.9') && !claudeVersionAtLeast('2.1.290-rc.1', '2.1.290'));
}

// ── L-2 residual: an Observe attach after a Stop reads the mod's turn end ───────
// A Stop from the app writes no interruption row, so the transcript leaves the stopped turn open. An
// Observe attach made after the Stop never saw the live end, and replayed the turn as running.
{
  const STOPPED = '33333333-3333-4333-8333-333333333333';
  const stoppedPath = join(slugDir, `${STOPPED}.jsonl`);
  const startedAt = Date.parse('2026-10-09T09:00:00.000Z');
  writeFileSync(
    stoppedPath,
    [
      line({ type: 'user', uuid: 'u-stopped', cwd: workspace, timestamp: new Date(startedAt).toISOString(), sessionId: STOPPED, version: '2.1.295', message: { role: 'user', content: 'a long task' } }),
      line({ type: 'assistant', uuid: 'a-stopped', sessionId: STOPPED, version: '2.1.295', timestamp: new Date(startedAt + 2000).toISOString(), message: { id: 'm-stopped', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'Working' }], stop_reason: null, usage: { input_tokens: 3, output_tokens: 5 } } }),
    ].join('\n') + '\n',
  );
  let running = false;
  let endedAt: number | undefined;
  const turnBridge = { ...bridge, turnRunning: () => running, turnEndedAt: () => endedAt };
  const adapter = new ClaudeAdapter({ modBridge: turnBridge });
  const newestRun = async (on: InstanceType<typeof ClaudeAdapter>): Promise<string | undefined> => {
    const conn = await on.attach(enc(stoppedPath));
    const history = await conn.getHistory();
    await conn.close?.();
    const runs = history.filter((m) => m.type === 'run-summary') as { status?: string }[];
    return runs.at(-1)?.status;
  };
  check('L-2 residual: with no turn end from the mod, an Observe attach replays the open turn running',
    await newestRun(adapter) === 'running');
  endedAt = startedAt + 60_000;
  check('L-2 residual: once the mod says the turn ended after it started, an Observe attach replays it ended',
    await newestRun(adapter) === 'cancelled');
  running = true;
  check('L-2 residual: not while the mod says a turn is running', await newestRun(adapter) === 'running');
  running = false;
  endedAt = startedAt - 60_000;
  check('L-2 residual: nor when the end the mod remembers came before the turn started', await newestRun(adapter) === 'running');
  endedAt = startedAt + 60_000;
  check('L-2 residual: an adapter with no mod bridge replays the file as it is', await newestRun(withoutBridge) === 'running');
}

// PR-5: use the real attach path, so seeding cannot be bypassed by a seam's fake adapter.
{
  const { AgentRegistry } = await import('@cosyncing/adapter-api');
  const { Hub } = await import('../../../broker/src/sessions/hub.ts');
  const busyPath = join(slugDir, `${BUSY}.jsonl`);
  writeFileSync(busyPath, line({ type: 'user', uuid: 'u-busy', cwd: workspace,
    timestamp: new Date().toISOString(), message: { role: 'user', content: 'still running' } }) + '\n');
  fresh(BUSY);
  // The live CLI says busy, while the mod has not reported this turn's start to the broker.
  const adapter = new ClaudeAdapter({ modBridge: { ...bridge, turnRunning: () => false } });
  const agents = new AgentRegistry();
  agents.register(adapter);
  const hub = new Hub(agents);
  try {
    const mid = await hub.ensure('claude', enc(busyPath), 'live');
    await mid.conn.getHistory();
    check('PR-5 seed: a live attach mid-turn reads Working from transcript and CLI evidence',
      mid.conn.info.status === 'working' && mid.status === 'working', String(mid.status));
    check('PR-5 seed: the roster overlay keeps the attached session Working',
      hub.liveSnapshot().find((row) => row.info.id === enc(busyPath))?.status === 'working');
    // A pending card outranks that seed; opening a second client does not lose the card.
    (mid.conn as ClaudeModConnection).ingestRequest({ requestId: 'pr5-held', kind: 'permission', toolName: 'Write' });
    const joined = await hub.ensure('claude', enc(busyPath), 'live');
    check('PR-5 held: attaching while a card is held reads Needs input', joined.status === 'needs-input');
  } finally {
    await hub.dispose();
  }
  stale(BUSY);
  const fallback = await adapter.attach(enc(busyPath), 'live');
  check('PR-5 fallback seed: a stale mod attach falls back to Observe with Working status',
    fallback.info.attachMode === 'observe' && fallback.info.status === 'working', String(fallback.info.status));
  await fallback.close();

  // The transcript still ends the old turn and the CLI has no busy row, but the mod knows a
  // new turn began. This isolates the turnRunning raise from the transcript/CLI seed above.
  fresh(UUID);
  writeFileSync(transcriptPath, line({ type: 'assistant', uuid: 'a-pr5-ended',
    timestamp: new Date().toISOString(), message: { id: 'msg_pr5_ended', role: 'assistant',
      content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' } }) + '\n');
  const raised = await new ClaudeAdapter({ modBridge: { ...bridge, turnRunning: () => true } }).attach(enc(transcriptPath), 'live');
  check('PR-5 turnRunning raise: the mod makes an attach Working before the transcript catches up',
    raised.info.status === 'working', String(raised.info.status));
  await raised.close();
}

rmSync(ROOT, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
const { drainClaudeLiveStatusProbes } = await import('../src/implementation.ts');
await drainClaudeLiveStatusProbes();
process.exit(failed ? 1 : 0);
