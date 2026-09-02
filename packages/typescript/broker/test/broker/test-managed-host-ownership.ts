#!/usr/bin/env bun
/**
 * The rule this suite exists to defend: cosyncing stops or replaces ONLY a
 * process it can prove it started.
 *
 * Every case is driven by injected fakes — synthetic pids, a scripted process
 * table, a virtual clock, a temp state directory. No real host is started, and
 * no signal reaches a real process. That is not merely convenient: the failure
 * being guarded against is killing someone else's work, so the suite must be
 * able to assert "no signal was sent" as a fact about a call log rather than a
 * hope about a machine.
 *
 * The two cases worth reading first are the pid-recycling ones. Ownership is
 * proven against a pid, and a pid is not a process — it can be released and
 * handed to a stranger between the moment we decide and the moment we act. Both
 * windows (decide→SIGTERM, SIGTERM→SIGKILL) are exercised, and in both the
 * assertion is that the replacement is never signalled.
 *
 *   bun run packages/typescript/broker/test/broker/test-managed-host-ownership.ts
 */
export {};

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  classifyManagedHost,
  ensureManagedHost,
  HOST_ABSENT,
  HOST_UNKNOWN,
  hostAt,
  managedHostGateEnv,
  managedHostOwnerPath,
  MANAGED_HOST_ACTIONS,
  managedHostRestartLedger,
  managedHostStartupReport,
  managedHostStore,
  ManagedHostSupervisor,
  readManagedHostOwnership,
  recoverManagedHost,
  releaseManagedHost,
  startManagedHost,
  stopManagedHost,
  PROCESS_ABSENT,
  PROCESS_UNKNOWN,
  type HostProcessIdentity,
  type LiveProcess,
  type ManagedHostChild,
  type ManagedHostEffects,
  type ManagedHostEnsureOutcome,
  type ManagedHostLaunch,
  type ManagedHostLocation,
  type ManagedHostOwnership,
  type ManagedHostPlan,
} from '../../src/runtime/managed-host.ts';
import { brokerManagedHostIdentities } from '../../src/installation/managed-host-posture.ts';
import { shippedAdapters } from '../../src/installation/shipped-adapters.ts';
import { brokerServiceEnvironmentEntries } from '../../src/installation/service-manager.ts';
import { writeInstallState } from '../../src/installation/install-state.ts';

/** A live process, as the effects report one. */
const running = (identity: HostProcessIdentity): LiveProcess => ({ state: 'running', identity });

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const AGENT = 'fixture-host';
/** One synthetic boot for the whole suite; the cross-boot case names its own. */
const BOOT = 'boot-aaaa';
const KEY = 'http://127.0.0.1:59999';
const HOST_PID = 4242;
const OWNED: HostProcessIdentity = { pid: HOST_PID, start: '881122', boot: BOOT, comm: 'fixture-host' };
/** Same pid, later start token: the OS handed this number to something else. */
const RECYCLED: HostProcessIdentity = { pid: HOST_PID, start: '990000', boot: BOOT, comm: 'someone-else' };
/**
 * The same recycled pid, wearing our host's name.
 *
 * A stranger that renamed itself, or simply the next copy of the same program —
 * either way the start token is the ONLY thing separating it from the process we
 * recorded, which is precisely the load the name no longer carries. Kept
 * distinct from {@link RECYCLED} so the recycling cases cannot pass on the
 * strength of a differing name.
 */
const RECYCLED_SAME_NAME: HostProcessIdentity = { ...RECYCLED, comm: OWNED.comm };

function ownership(overrides: Partial<ManagedHostOwnership> = {}): ManagedHostOwnership {
  return {
    schemaVersion: 3,
    ...OWNED,
    agent: AGENT,
    identityKey: KEY,
    recordedAtMs: 1_700_000_000_000,
    evidence: { executable: '/fixture/bin/host', args: ['web'] },
    ...overrides,
  };
}

/**
 * A scripted machine.
 *
 * `identityScript` answers `processIdentity` call by call, which is how the
 * recycling windows are reproduced exactly: the same pid reads as ours the
 * first time it is asked about and as a stranger every time after.
 */
function fakeEffects(options: {
  identities?: Map<number, HostProcessIdentity>;
  identityScript?: LiveProcess[];
  onLiveRead?: (pid: number, options: { fresh?: boolean } | undefined) => void;
  onSignal?: (pid: number, signal: 'SIGTERM' | 'SIGKILL', table: Map<number, HostProcessIdentity>) => void;
  spawnPid?: number;
  childExitsAfter?: number;
  /** Which signal, if any, the spawned child actually dies on. */
  childDiesOn?: 'SIGTERM' | 'SIGKILL';
  selfPid?: number;
  listeners?: Map<number, ManagedHostLocation>;
  /**
   * What a pid NOT in the table reads as. Defaults to 'unknown' — the answer
   * that authorizes nothing — so a suite has to say so explicitly when it means
   * a process is provably gone.
   */
  missingProcess?: LiveProcess;
  /**
   * Descendant relationships this fixture can PROVE, as pid -> ancestor pid.
   * Any pair not listed answers 'unknown', which is what a real provider says
   * on every platform but Windows.
   */
  descendants?: Map<number, number>;
}): {
  effects: ManagedHostEffects;
  signals: Array<{ pid: number; signal: string }>;
  spawns: ManagedHostLaunch[];
  table: Map<number, HostProcessIdentity>;
} {
  const table = options.identities ?? new Map<number, HostProcessIdentity>();
  const signals: Array<{ pid: number; signal: string }> = [];
  const spawns: ManagedHostLaunch[] = [];
  const script = options.identityScript ? [...options.identityScript] : undefined;
  let clock = 1_000;
  let child: { exitCode: number | null } | null = null;
  let sleeps = 0;

  const effects: ManagedHostEffects = {
    // A port this fixture was told nothing about is 'unknown', never 'absent':
    // proof of an empty address has to be stated, exactly as on a real machine.
    listener: (port) => options.listeners?.get(port) ?? HOST_UNKNOWN,
    liveProcess: (pid, readOptions) => {
      options.onLiveRead?.(pid, readOptions);
      if (script) return script.length > 1 ? script.shift()! : script[0]!;
      const identity = table.get(pid);
      return identity ? running(identity) : (options.missingProcess ?? PROCESS_UNKNOWN);
    },
    spawn: (launch) => {
      spawns.push(launch);
      const pid = options.spawnPid ?? 5150;
      child = { exitCode: null };
      const spawned: ManagedHostChild = {
        pid,
        exited: Promise.resolve(0),
        get exitCode() { return child!.exitCode; },
        readOutput: () => 'stdout:\nfixture\nstderr:\n',
      };
      return spawned;
    },
    signal: (pid, signal) => {
      signals.push({ pid, signal });
      if (child && options.childDiesOn === signal) child.exitCode = 143;
      options.onSignal?.(pid, signal, table);
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      sleeps += 1;
      if (options.childExitsAfter !== undefined && sleeps >= options.childExitsAfter && child) {
        child.exitCode = 1;
      }
      await Promise.resolve();
    },
    // A macrotask, so the virtual clock is only charged when the deadline
    // actually WINS: a probe that answers in microtasks settles the race first
    // and this timer is cancelled having cost nothing, which is the property
    // being modelled — a fast probe does not consume its whole budget.
    deadline: (ms) => {
      let fire: () => void = () => {};
      const expired = new Promise<void>((resolve) => { fire = resolve; });
      const timer = setTimeout(() => { clock += ms; fire(); }, 0);
      return { expired, cancel: () => clearTimeout(timer) };
    },
    selfPid: () => options.selfPid ?? 111_111,
    descendsFrom: (pid, ancestorPid) => {
      if (pid === ancestorPid) return 'yes';
      const parent = options.descendants?.get(pid);
      if (parent === undefined) return 'unknown';
      return parent === ancestorPid ? 'yes' : 'no';
    },
  };
  return { effects, signals, spawns, table };
}

function plan(overrides: Partial<ManagedHostPlan> = {}): ManagedHostPlan {
  return {
    agent: AGENT,
    identityKey: KEY,
    ready: async () => false,
    locate: async () => HOST_ABSENT,
    launch: { command: '/fixture/bin/host', args: ['web'] },
    readyTimeoutMs: 1_000,
    readyPollMs: 100,
    stopGraceMs: 200,
    ...overrides,
  };
}

const memoryStore = () => {
  const records = new Map<string, ManagedHostOwnership>();
  return {
    store: {
      read: (agent: string) => records.get(agent) ?? null,
      write: (record: ManagedHostOwnership) => { records.set(record.agent, record); },
      clear: (agent: string) => { records.delete(agent); },
    },
    records,
  };
};

const home = mkdtempSync(join(tmpdir(), 'cosyncing-managed-host-'));

try {
  // ── the pure decision ──────────────────────────────────────────────────────
  check('a matching record on a matching live process is the only thing that proves ownership',
    classifyManagedHost(ownership(), running(OWNED), KEY) === 'owned');
  check('no record means foreign, never owned',
    classifyManagedHost(null, running(OWNED), KEY) === 'foreign');
  check('a record written for a different address proves nothing here',
    classifyManagedHost(ownership({ identityKey: 'http://127.0.0.1:1' }), running(OWNED), KEY) === 'foreign');
  check('a different pid is foreign',
    classifyManagedHost(ownership({ pid: 5 }), running(OWNED), KEY) === 'foreign');
  // The pid-reuse guard, which is the whole reason a start token is recorded.
  check('the same pid with a different start token is a RECYCLED pid, not our host',
    classifyManagedHost(ownership(), running(RECYCLED), KEY) === 'foreign');
  // The same guard with the name removed from the argument, so it is provably
  // the start token doing the work and not a coincidence of naming.
  check('a recycled pid is rejected on the start token alone, even wearing our host name',
    classifyManagedHost(ownership(), running(RECYCLED_SAME_NAME), KEY) === 'foreign');
  // This assertion used to read the other way, and the inversion is the point.
  // `/proc/<pid>/comm` is writable by the process — `prctl(PR_SET_NAME)`, Node's
  // `process.title` — so it is a label, not an identity. Both hosts this product
  // manages rewrite it after being recorded (kimi → kimi-code; dsh, a
  // `#!/usr/bin/env node` script, → node), and comparing it made the broker call
  // its own children strangers: it left them running at shutdown AND cleared
  // their records, so nothing could ever reap them. pid + start + boot already
  // exclude a recycled pid, which was the only job the name had.
  check('a host that renamed itself since it was recorded is still ours',
    classifyManagedHost(ownership(), running({ ...OWNED, comm: 'renamed-itself' }), KEY) === 'owned');
  // Indeterminate must beat even a perfect record: an unidentifiable process is
  // never touched, no matter what we believe about it.
  check('an unreadable live identity is indeterminate even with a perfectly matching record',
    classifyManagedHost(ownership(), PROCESS_UNKNOWN, KEY) === 'indeterminate');
  // ...and the OTHER half of that distinction, which is what makes a stale
  // record safe to delete. Only a positive "no such process" may say 'absent'.
  check('a process the OS says does not exist is absent, which is not the same as unreadable',
    classifyManagedHost(ownership(), PROCESS_ABSENT, KEY) === 'absent'
      && classifyManagedHost(null, PROCESS_ABSENT, KEY) === 'absent');

  // ── start: never disturb what is already there ─────────────────────────────
  {
    const { effects, signals, spawns } = fakeEffects({ identities: new Map([[HOST_PID, OWNED]]) });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await startManagedHost(
      plan({ ready: async () => true, locate: async () => hostAt(HOST_PID) }), effects, store);
    check('a host already serving is left alone, and recognised as ours',
      outcome.action === 'already-serving' && outcome.verdict === 'owned'
        && spawns.length === 0 && signals.length === 0,
      JSON.stringify({ outcome, spawns: spawns.length, signals }));
  }
  {
    const { effects, signals, spawns } = fakeEffects({ identities: new Map([[HOST_PID, OWNED]]) });
    const { store } = memoryStore(); // no record at all: this host is a stranger's
    const outcome = await startManagedHost(
      plan({ ready: async () => true, locate: async () => hostAt(HOST_PID) }), effects, store);
    check('a STRANGER already serving is left completely untouched',
      outcome.action === 'already-serving' && outcome.verdict === 'foreign'
        && spawns.length === 0 && signals.length === 0,
      JSON.stringify({ outcome, spawns: spawns.length, signals }));
  }
  {
    const { effects, signals, spawns } = fakeEffects({ identities: new Map() });
    const { store } = memoryStore();
    const outcome = await startManagedHost(
      plan({ ready: async () => true, locate: async () => hostAt(HOST_PID) }), effects, store);
    check('a serving host this machine cannot identify is indeterminate, and still untouched',
      outcome.action === 'already-serving' && outcome.verdict === 'indeterminate'
        && spawns.length === 0 && signals.length === 0,
      JSON.stringify({ outcome, spawns: spawns.length, signals }));
  }
  {
    // The dangerous middle state: something holds the address but does not
    // answer. It is as likely to be a host still starting as a stranger, so it
    // is neither spawned over nor signalled.
    const { effects, signals, spawns } = fakeEffects({ identities: new Map([[HOST_PID, OWNED]]) });
    const { store } = memoryStore();
    const outcome = await startManagedHost(
      plan({ ready: async () => false, locate: async () => hostAt(HOST_PID) }), effects, store);
    check('an occupied but unready address is preserved, not spawned into and not signalled',
      outcome.action === 'preserved-unready' && outcome.pid === HOST_PID
        && spawns.length === 0 && signals.length === 0,
      JSON.stringify({ outcome, spawns: spawns.length, signals }));
  }

  // ── start: the happy path writes proof ─────────────────────────────────────
  {
    const spawnPid = 5150;
    const spawnedIdentity: HostProcessIdentity = { pid: spawnPid, start: '777', boot: BOOT, comm: 'host' };
    const { effects, spawns } = fakeEffects({ identities: new Map([[spawnPid, spawnedIdentity]]), spawnPid });
    const { store, records } = memoryStore();
    let serving = false;
    const outcome = await startManagedHost(
      plan({
        ready: async () => serving,
        locate: async () => (serving ? hostAt(spawnPid) : HOST_ABSENT),
        // Becomes ready on the second poll, so the wait loop is genuinely used.
        readyPollMs: 100,
      }),
      { ...effects, sleep: async (ms) => { serving = true; await effects.sleep(ms); } },
      store,
    );
    const record = records.get(AGENT);
    check('an empty address is spawned into, and ownership is recorded from the CHILD identity',
      outcome.action === 'started' && outcome.pid === spawnPid && outcome.servingProven === true
        && spawns.length === 1 && spawns[0]?.command === '/fixture/bin/host'
        && record?.pid === spawnPid && record.start === '777' && record.identityKey === KEY,
      JSON.stringify({ outcome, record }));
  }
  {
    // A child we cannot identify is a process no LATER broker could ever prove
    // it owns. Leaking one per start is worse than not starting.
    const spawnPid = 5151;
    const { effects, signals } = fakeEffects({ identities: new Map(), spawnPid });
    const { store, records } = memoryStore();
    const outcome = await startManagedHost(plan({ ready: async () => false }), effects, store);
    check('a spawned child whose identity cannot be read is stopped again and never recorded',
      outcome.action === 'start-failed' && outcome.detailCode === 'host-identity-unreadable'
        && records.size === 0 && signals.some((s) => s.pid === spawnPid),
      JSON.stringify({ outcome, records: records.size, signals }));
  }
  {
    const spawnPid = 5152;
    const { effects } = fakeEffects({
      identities: new Map([[spawnPid, { pid: spawnPid, start: '1', boot: BOOT, comm: 'host' }]]),
      spawnPid,
      childExitsAfter: 1,
    });
    const { store, records } = memoryStore();
    const outcome = await startManagedHost(plan({ ready: async () => false }), effects, store);
    check('a child that exits during startup fails the start and leaves no ownership record',
      outcome.action === 'start-failed' && outcome.detailCode === 'host-exited-during-start'
        && records.size === 0,
      JSON.stringify({ outcome, records: records.size }));
  }
  {
    const spawnPid = 5153;
    const identity = { pid: spawnPid, start: '1', boot: BOOT, comm: 'host' };
    const table = new Map([[spawnPid, identity]]);
    const { effects, signals } = fakeEffects({
      identities: table,
      spawnPid,
      childDiesOn: 'SIGKILL',
      missingProcess: PROCESS_ABSENT,
      onSignal: (pid, signal, live) => { if (signal === 'SIGKILL') live.delete(pid); },
    });
    const { store, records } = memoryStore();
    const outcome = await startManagedHost(
      plan({ ready: async () => false, readyTimeoutMs: 300, readyPollMs: 100 }), effects, store);
    check('a child that never becomes ready is stopped — escalating — and leaves no record',
      outcome.action === 'start-failed' && outcome.detailCode === 'host-not-ready-in-time'
        && records.size === 0
        && signals.some((s) => s.signal === 'SIGTERM') && signals.some((s) => s.signal === 'SIGKILL'),
      JSON.stringify({ outcome, signals }));
  }


  // ── start: what the readiness barrier is allowed to conclude ───────────────
  //
  // `ready()` asks about an ADDRESS. Treating that as an answer about OUR CHILD
  // is the mistake these four cases exist to make impossible.
  {
    // A stranger's host wins the address during our launch window. Ours must not
    // be claimed on its readiness, and the stranger must not be touched.
    const spawnPid = 5160;
    const table = new Map([[spawnPid, { pid: spawnPid, start: '9', boot: BOOT, comm: 'host' }], [HOST_PID, OWNED]]);
    let locates = 0;
    const { effects, signals } = fakeEffects({
      identities: table, spawnPid, childDiesOn: 'SIGTERM', missingProcess: PROCESS_ABSENT,
    });
    const { store, records } = memoryStore();
    const outcome = await startManagedHost(
      plan({
        ready: async () => locates > 0,
        locate: async () => (locates++ === 0 ? HOST_ABSENT : hostAt(HOST_PID)),
      }),
      effects, store,
    );
    check('a FOREIGN host that becomes ready during our launch is never claimed as ours',
      outcome.action === 'already-serving' && (outcome as { verdict: string }).verdict === 'foreign'
        // Our own child is stopped rather than leaked, and the stranger is not signalled.
        && signals.every((entry) => entry.pid === spawnPid) && records.size === 0,
      JSON.stringify({ outcome, signals, records: records.size }));
  }
  {
    // Ready, but this machine will not say which process serves it. Killing our
    // child here would destroy a working host over a failure to LOOK, so it is
    // kept — recorded, provably ours, and reported as unproven.
    const spawnPid = 5161;
    let locates = 0;
    const { effects, signals } = fakeEffects({
      identities: new Map([[spawnPid, { pid: spawnPid, start: '9', boot: BOOT, comm: 'host' }]]), spawnPid,
    });
    const { store, records } = memoryStore();
    const outcome = await startManagedHost(
      plan({
        ready: async () => locates > 0,
        locate: async () => (locates++ === 0 ? HOST_ABSENT : HOST_UNKNOWN),
      }),
      effects, store,
    );
    check('a ready host this machine cannot resolve is still ours, but reported as UNPROVEN',
      outcome.action === 'started' && outcome.servingProven === false
        && records.size === 1 && signals.length === 0,
      JSON.stringify({ outcome, records: records.size, signals }));
  }
  {
    // The advertised readiness ceiling has to bound the wait for an ANSWER, not
    // just the interval between questions. A probe that never returns — a socket
    // that connects and then says nothing — must not hold the start open.
    //
    // The ceiling bounds each PHASE rather than the call as a whole, and the
    // difference is not bookkeeping. A pre-flight probe that hangs for the full
    // ceiling used to leave the child a budget of zero: it was spawned, never
    // probed once, and killed for being slow. So the phases are bounded
    // separately — pre-flight, then the predecessor stop, then the child — and
    // the total is their sum. Every one is finite, which is the property that
    // matters; a freshly spawned host always gets the full budget its adapter
    // advertised, which is the property an operator was promised.
    const spawnPid = 5162;
    const { effects } = fakeEffects({
      identities: new Map([[spawnPid, { pid: spawnPid, start: '9', boot: BOOT, comm: 'host' }]]),
      spawnPid, childDiesOn: 'SIGTERM', missingProcess: PROCESS_ABSENT,
    });
    const { store, records } = memoryStore();
    const signalsSeen: AbortSignal[] = [];
    const started = effects.now();
    const outcome = await startManagedHost(
      plan({
        ready: (signal) => {
          if (signal) signalsSeen.push(signal);
          return new Promise<boolean>(() => {}); // never answers
        },
        readyTimeoutMs: 300,
        readyPollMs: 100,
      }),
      effects, store,
    );
    check('a readiness probe that never answers cannot outlast the advertised deadline',
      outcome.action === 'start-failed' && outcome.detailCode === 'host-not-ready-in-time'
        // Pre-flight ceiling, child ceiling, and the stop grace — and no more.
        && effects.now() - started <= 300 + 300 + 200
        // The child was PROBED on its own budget rather than spawned and killed
        // unasked, which is what a single shared deadline did to it.
        && signalsSeen.length >= 2
        // ...and every probe was told to abandon its socket, not merely ignored.
        && signalsSeen.every((signal) => signal.aborted)
        && records.size === 0,
      JSON.stringify({ outcome, elapsed: effects.now() - started, probes: signalsSeen.length }));
  }
  {
    // An address this machine will not describe is exactly where an unowned host
    // hides. Spawning into it races a process we cannot see.
    const { effects, spawns, signals } = fakeEffects({});
    const { store, records } = memoryStore();
    const outcome = await startManagedHost(
      plan({ ready: async () => false, locate: async () => HOST_UNKNOWN }), effects, store);
    check('an address this machine cannot describe is never spawned into',
      outcome.action === 'preserved-unlocatable'
        && spawns.length === 0 && signals.length === 0 && records.size === 0,
      JSON.stringify({ outcome, spawns: spawns.length }));
  }
  {
    // A child that survives SIGTERM and SIGKILL is still running and still ours.
    // Its record is the only thing that can ever authorize another attempt, so a
    // failed stop must not be the thing that throws the proof away.
    const spawnPid = 5163;
    const { effects, signals } = fakeEffects({
      identities: new Map([[spawnPid, { pid: spawnPid, start: '9', boot: BOOT, comm: 'host' }]]),
      spawnPid, // no childDiesOn: it ignores both signals
    });
    const { store, records } = memoryStore();
    const outcome = await startManagedHost(
      plan({ ready: async () => false, readyTimeoutMs: 200, readyPollMs: 100 }), effects, store);
    check('a child that survives both signals KEEPS its ownership record',
      outcome.action === 'start-failed' && outcome.detailCode === 'host-not-ready-in-time'
        && signals.map((entry) => entry.signal).join(',') === 'SIGTERM,SIGKILL'
        && records.size === 1 && records.get(AGENT)?.pid === spawnPid,
      JSON.stringify({ outcome, signals, records: records.size }));
  }

  // ── stop: only what is proven ours ─────────────────────────────────────────
  {
    const table = new Map([[HOST_PID, OWNED]]);
    const liveReads: Array<{ fresh?: boolean } | undefined> = [];
    const { effects, signals } = fakeEffects({
      identities: table,
      missingProcess: PROCESS_ABSENT,
      onLiveRead: (_pid, options) => liveReads.push(options),
      onSignal: (pid, signal, live) => { if (signal === 'SIGTERM') live.delete(pid); },
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await stopManagedHost(
      { agent: AGENT, identityKey: KEY, stopGraceMs: 200 }, effects, store, async () => hostAt(HOST_PID));
    check('a proven-owned host stops on SIGTERM, and its record is cleared',
      outcome.action === 'stopped' && outcome.escalated === false
        && signals.length === 1 && signals[0]?.signal === 'SIGTERM' && records.size === 0,
      JSON.stringify({ outcome, signals }));
    check('every identity read immediately authorizing termination bypasses cached process data',
      liveReads.length >= 3 && liveReads[1]?.fresh === true,
      JSON.stringify(liveReads));
  }
  {
    const table = new Map([[HOST_PID, OWNED]]);
    const { effects, signals } = fakeEffects({
      identities: table,
      missingProcess: PROCESS_ABSENT,
      onSignal: (pid, signal, live) => { if (signal === 'SIGKILL') live.delete(pid); },
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await stopManagedHost(
      { agent: AGENT, identityKey: KEY, stopGraceMs: 200 }, effects, store, async () => hostAt(HOST_PID));
    check('a proven-owned host that ignores SIGTERM is escalated to SIGKILL',
      outcome.action === 'stopped' && outcome.escalated === true
        && signals.map((s) => s.signal).join(',') === 'SIGTERM,SIGKILL' && records.size === 0,
      JSON.stringify({ outcome, signals }));
  }
  {
    const { effects, signals } = fakeEffects({ identities: new Map([[HOST_PID, OWNED]]) });
    const { store } = memoryStore(); // no record: not ours
    const outcome = await stopManagedHost(
      { agent: AGENT, identityKey: KEY, stopGraceMs: 200 }, effects, store, async () => hostAt(HOST_PID));
    check('a foreign host is preserved and NEVER signalled',
      outcome.action === 'preserved' && outcome.verdict === 'foreign' && signals.length === 0,
      JSON.stringify({ outcome, signals }));
  }
  {
    const { effects, signals } = fakeEffects({ identities: new Map() }); // identity unreadable
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await stopManagedHost(
      { agent: AGENT, identityKey: KEY, stopGraceMs: 200 }, effects, store, async () => hostAt(HOST_PID));
    check('an unidentifiable host is preserved and NEVER signalled, record or not',
      outcome.action === 'preserved' && outcome.verdict === 'indeterminate' && signals.length === 0,
      JSON.stringify({ outcome, signals }));
  }
  {
    const { effects, signals } = fakeEffects({ identities: new Map(), missingProcess: PROCESS_ABSENT });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await stopManagedHost(
      { agent: AGENT, identityKey: KEY, stopGraceMs: 200 }, effects, store, async () => HOST_ABSENT);
    check('a host proven gone clears its stale record without signalling anything',
      outcome.action === 'already-gone' && signals.length === 0 && records.size === 0,
      JSON.stringify({ outcome, signals }));
  }
  {
    // Our own pid must never be signalled, whatever the record says.
    const { effects, signals } = fakeEffects({ identities: new Map([[HOST_PID, OWNED]]), selfPid: HOST_PID });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await stopManagedHost(
      { agent: AGENT, identityKey: KEY, stopGraceMs: 200 }, effects, store, async () => hostAt(HOST_PID));
    check('the broker never signals its own pid, even when a record claims it',
      outcome.action === 'preserved' && signals.length === 0,
      JSON.stringify({ outcome, signals }));
  }


  {
    // The observed `kimi web` shutdown: the listener is released while the
    // process lingers. An empty address is NOT proof our host exited, and
    // walking away here strands a process nothing will ever reap.
    const table = new Map([[HOST_PID, OWNED]]);
    const { effects, signals } = fakeEffects({
      identities: table,
      missingProcess: PROCESS_ABSENT,
      onSignal: (pid, signal, live) => { if (signal === 'SIGTERM') live.delete(pid); },
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await stopManagedHost(
      { agent: AGENT, identityKey: KEY, stopGraceMs: 200 }, effects, store, async () => HOST_ABSENT);
    check('a host that released its listener but is still running is stopped, not forgotten',
      outcome.action === 'stopped' && signals.length === 1 && signals[0]?.pid === HOST_PID
        && records.size === 0,
      JSON.stringify({ outcome, signals }));
  }
  {
    // The same shape as the start-side case: a stop that did not work must leave
    // the evidence behind that a later stop needs.
    const { effects, signals } = fakeEffects({
      identities: new Map([[HOST_PID, OWNED]]), // survives every signal
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await stopManagedHost(
      { agent: AGENT, identityKey: KEY, stopGraceMs: 100 }, effects, store, async () => hostAt(HOST_PID));
    check('a stop that failed to kill the process KEEPS the proof that the process is ours',
      outcome.action === 'preserved' && (outcome as { verdict: string }).verdict === 'indeterminate'
        && signals.map((entry) => entry.signal).join(',') === 'SIGTERM,SIGKILL'
        && records.size === 1,
      JSON.stringify({ outcome, signals, records: records.size }));
  }
  {
    // No record and something there: not ours, whatever it is.
    const { effects, signals } = fakeEffects({ identities: new Map(), missingProcess: PROCESS_ABSENT });
    const { store, records } = memoryStore();
    const outcome = await stopManagedHost(
      { agent: AGENT, identityKey: KEY, stopGraceMs: 200 }, effects, store, async () => HOST_ABSENT);
    check('an empty address with no record is simply nothing to do',
      outcome.action === 'already-gone' && signals.length === 0 && records.size === 0,
      JSON.stringify({ outcome, signals }));
  }

  // ── stop: the pid stops being ours mid-flight ──────────────────────────────
  {
    // Call 1 classifies (ours). Every call after is the stranger that took the
    // pid. Nothing may be signalled.
    const { effects, signals } = fakeEffects({ identityScript: [running(OWNED), running(RECYCLED)] });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await stopManagedHost(
      { agent: AGENT, identityKey: KEY, stopGraceMs: 200 }, effects, store, async () => hostAt(HOST_PID));
    check('a pid recycled between deciding and signalling is never signalled',
      outcome.action === 'already-gone' && signals.length === 0 && records.size === 0,
      JSON.stringify({ outcome, signals }));
  }
  {
    // Ours through the SIGTERM, a stranger by the time SIGKILL would be sent.
    // Exactly one signal may ever be delivered.
    const script: LiveProcess[] = [running(OWNED), running(OWNED), running(RECYCLED)];
    const { effects, signals } = fakeEffects({ identityScript: script });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await stopManagedHost(
      { agent: AGENT, identityKey: KEY, stopGraceMs: 200 }, effects, store, async () => hostAt(HOST_PID));
    check('a pid recycled between SIGTERM and SIGKILL never receives the SIGKILL',
      signals.map((s) => s.signal).join(',') === 'SIGTERM' && outcome.action === 'stopped'
        && records.size === 0,
      JSON.stringify({ outcome, signals }));
  }
  // The same two windows against a replacement that differs ONLY in its start
  // token. Both windows above would also pass on a differing command name, which
  // is no longer compared; these two hold them to the token that still is. If
  // the start token were ever dropped from the proof, these are the checks that
  // fail — and a stranger takes the signal.
  {
    const { effects, signals } = fakeEffects({
      identityScript: [running(OWNED), running(RECYCLED_SAME_NAME)],
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await stopManagedHost(
      { agent: AGENT, identityKey: KEY, stopGraceMs: 200 }, effects, store, async () => hostAt(HOST_PID));
    check('a same-named replacement taking the pid before SIGTERM is never signalled',
      outcome.action === 'already-gone' && signals.length === 0 && records.size === 0,
      JSON.stringify({ outcome, signals }));
  }
  {
    const script: LiveProcess[] = [running(OWNED), running(OWNED), running(RECYCLED_SAME_NAME)];
    const { effects, signals } = fakeEffects({ identityScript: script });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await stopManagedHost(
      { agent: AGENT, identityKey: KEY, stopGraceMs: 200 }, effects, store, async () => hostAt(HOST_PID));
    check('a same-named replacement taking the pid before SIGKILL is never escalated to',
      signals.map((s) => s.signal).join(',') === 'SIGTERM' && outcome.action === 'stopped',
      JSON.stringify({ outcome, signals }));
  }
  // ── the rename, end to end: spawn, rename, and still be stopped ────────────
  {
    // The production failure this suite did not catch. A host is recorded under
    // the name it was launched with and rewrites it moments later; the whole
    // lifecycle has to stay indifferent to that, not just the pure decision.
    // Modelled on the real dsh: launched as `dsh`, serving as `node`.
    const spawnPid = 7311;
    const table = new Map<number, HostProcessIdentity>();
    const { effects, signals } = fakeEffects({
      identities: table,
      spawnPid,
      missingProcess: PROCESS_ABSENT,
      // The child dies on the SIGTERM and leaves the process table with it.
      onSignal: (pid, signal, live) => { if (signal === 'SIGTERM') live.delete(pid); },
    });
    const { store, records } = memoryStore();
    table.set(spawnPid, { pid: spawnPid, start: '5150', boot: BOOT, comm: 'dsh' });
    let serving = false;
    const started = await startManagedHost(
      plan({
        launch: { command: '/fixture/bin/dsh', args: ['web'] },
        ready: async () => serving,
        locate: async () => (serving ? hostAt(spawnPid) : HOST_ABSENT),
        readyPollMs: 100,
      }),
      { ...effects, sleep: async (ms) => { serving = true; await effects.sleep(ms); } },
      store,
    );
    check('a managed host is recorded under the name it was launched with',
      started.action === 'started' && records.get(AGENT)?.comm === 'dsh',
      JSON.stringify({ action: started.action, comm: records.get(AGENT)?.comm }));

    // …and then renames itself, exactly as the shipped one does.
    table.set(spawnPid, { pid: spawnPid, start: '5150', boot: BOOT, comm: 'node' });
    check('the renamed host still classifies as ours',
      classifyManagedHost(records.get(AGENT)!, running(table.get(spawnPid)!), KEY) === 'owned');

    const outcome = await stopManagedHost(
      { agent: AGENT, identityKey: KEY, stopGraceMs: 200 }, effects, store, async () => hostAt(spawnPid));
    check('a host that renamed itself is stopped, not left running with its record cleared',
      outcome.action === 'stopped' && signals.length === 1
        && signals[0]?.pid === spawnPid && signals[0]?.signal === 'SIGTERM' && records.size === 0,
      JSON.stringify({ outcome, signals }));
  }

  {
    // An uninstalled host is the ORDINARY case for an optional agent, and
    // `Bun.spawn` reports it by throwing. It must read as a start failure, not
    // escape into the broker's startup path.
    const { effects } = fakeEffects({});
    const { store, records } = memoryStore();
    const outcome = await startManagedHost(plan(), {
      ...effects,
      spawn: () => { throw new Error('ENOENT: no such file or directory'); },
    }, store);
    check('a command that cannot be spawned at all is a reported failure, not a thrown error',
      outcome.action === 'start-failed' && outcome.detailCode === 'host-spawn-failed'
        && records.size === 0,
      JSON.stringify(outcome));
  }

  // ── driving it from an adapter's description ───────────────────────────────
  //
  // The broker must reach these decisions without knowing which agent it holds,
  // so everything below goes through the generic entry point with a fake backend.
  {
    check('the gate variable is DERIVED from the agent id, not listed anywhere',
      managedHostGateEnv('kimi') === 'COSYNCING_KIMI_MANAGED_HOST'
        && managedHostGateEnv('dsh') === 'COSYNCING_DSH_MANAGED_HOST'
        && managedHostGateEnv('some-agent') === 'COSYNCING_SOME_AGENT_MANAGED_HOST',
      [managedHostGateEnv('kimi'), managedHostGateEnv('dsh'), managedHostGateEnv('some-agent')].join(','));
  }
  const backend = (overrides: Record<string, unknown> = {}) => ({
    id: AGENT,
    integration: { externalHost: { managed: true as const } },
    isAvailable: async () => false,
    describeManagedHost: async () => ({
      identityKey: KEY,
      locator: { kind: 'tcp-port' as const, port: 59999 },
      launch: { command: '/fixture/bin/host', args: ['web'] },
      readyTimeoutMs: 300,
      stopGraceMs: 100,
    }),
    ...overrides,
  });
  {
    const { effects, spawns } = fakeEffects({});
    const { store } = memoryStore();
    const outcome = await ensureManagedHost(
      { id: 'plain', isAvailable: async () => true } as never, effects, store, {});
    check('an adapter with no external host is not this engine\'s business',
      outcome.action === 'not-applicable' && spawns.length === 0, JSON.stringify(outcome));
  }
  {
    // The default-off proof: a fully described, startable host, and an empty
    // environment. Nothing may be spawned.
    const { effects, spawns, signals } = fakeEffects({});
    const { store } = memoryStore();
    const outcome = await ensureManagedHost(backend() as never, effects, store, {});
    check('managed start is DEFAULT OFF: nothing spawns without explicit authorization',
      outcome.action === 'not-authorized'
        && (outcome as { variable: string }).variable === `COSYNCING_${AGENT.replace(/-/g, '_').toUpperCase()}_MANAGED_HOST`
        && spawns.length === 0 && signals.length === 0,
      JSON.stringify({ outcome, spawns: spawns.length }));
  }
  const AUTHORIZED = { [managedHostGateEnv(AGENT)]: '1' };
  {
    const { effects, spawns } = fakeEffects({});
    const { store } = memoryStore();
    const outcome = await ensureManagedHost(
      backend({ describeManagedHost: async () => null }) as never, effects, store, AUTHORIZED);
    check('an adapter that cannot describe its host has nothing started for it',
      outcome.action === 'undescribed' && spawns.length === 0, JSON.stringify(outcome));
  }
  {
    // Authorized, and a stranger is already serving on the described port. The
    // authorization is to START a host, never to replace one.
    const { effects, spawns, signals } = fakeEffects({
      identities: new Map([[HOST_PID, OWNED]]),
      listeners: new Map([[59999, hostAt(HOST_PID)]]),
    });
    const { store } = memoryStore();
    const outcome = await ensureManagedHost(
      backend({ isAvailable: async () => true }) as never, effects, store, AUTHORIZED);
    check('authorization does not license replacing a stranger already serving',
      outcome.action === 'already-serving' && (outcome as { verdict: string }).verdict === 'foreign'
        && spawns.length === 0 && signals.length === 0,
      JSON.stringify({ outcome, spawns: spawns.length, signals }));
  }
  {
    // A described host with no launch spec: report whose it is, start nothing.
    const { effects, spawns } = fakeEffects({
      identities: new Map([[HOST_PID, OWNED]]),
      listeners: new Map([[59999, hostAt(HOST_PID)]]),
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await ensureManagedHost(
      backend({
        isAvailable: async () => true,
        describeManagedHost: async () => ({
          identityKey: KEY,
          locator: { kind: 'tcp-port' as const, port: 59999 },
          launch: null,
          readyTimeoutMs: 300,
          stopGraceMs: 100,
        }),
      }) as never,
      effects, store, AUTHORIZED,
    );
    check('a host that cannot be started is still classified and reported',
      outcome.action === 'already-serving' && (outcome as { verdict: string }).verdict === 'owned'
        && spawns.length === 0,
      JSON.stringify(outcome));
  }
  {
    // The stop path deliberately ignores the gate: a host this broker started
    // must remain reapable after the variable is turned off, or flipping it
    // strands a process nothing will ever clean up.
    const table = new Map([[HOST_PID, OWNED]]);
    const { effects, signals } = fakeEffects({
      identities: table,
      missingProcess: PROCESS_ABSENT,
      listeners: new Map([[59999, hostAt(HOST_PID)]]),
      onSignal: (pid, signal, live) => { if (signal === 'SIGTERM') live.delete(pid); },
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await releaseManagedHost(backend() as never, effects, store);
    check('a host we started is still stoppable after the start gate is turned off',
      outcome.action === 'stopped' && signals.length === 1 && records.size === 0,
      JSON.stringify({ outcome, signals }));
  }
  {
    // ...but the stop path is still gated on OWNERSHIP, which is the real guard.
    const { effects, signals } = fakeEffects({
      identities: new Map([[HOST_PID, OWNED]]),
      listeners: new Map([[59999, hostAt(HOST_PID)]]),
    });
    const { store } = memoryStore();
    const outcome = await releaseManagedHost(backend() as never, effects, store);
    check('release never signals a host this broker cannot prove it started',
      outcome.action === 'preserved' && signals.length === 0, JSON.stringify({ outcome, signals }));
  }
  {
    // Two listeners on one port is an ambiguous machine, and an ambiguous machine
    // names nobody. That says nothing either way about OUR process, which is
    // what the record names and what the stop is actually about — so a host we
    // can still prove we started is still reaped. Deciding this from the
    // listener instead is how a `servingProven: false` start became a process
    // nothing could ever stop.
    const { effects, signals } = fakeEffects({
      identities: new Map([[HOST_PID, OWNED]]),
      listeners: new Map(), // an ambiguous port names nobody, as a real one would
      missingProcess: PROCESS_ABSENT,
      onSignal: (pid, signal, live) => { if (signal === 'SIGTERM') live.delete(pid); },
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await releaseManagedHost(backend() as never, effects, store);
    check('an unresolvable listener does not strand a host we can still prove we started',
      outcome.action === 'stopped' && signals.length === 1 && signals[0]?.pid === HOST_PID
        && records.size === 0,
      JSON.stringify({ outcome, signals, records: records.size }));
  }


  // ── recovery: noticing that a host we started has died ─────────────────────
  //
  // Starting and stopping a host is worth very little if nothing notices when it
  // dies at 3am. These are the two states a supervisor may act on, and the four
  // it must not.
  {
    // The crash: our record names a process, that process is PROVEN gone, and
    // nothing is serving.
    const spawnPid = 6001;
    // The port is empty until the replacement takes it, which is what makes this
    // a crash rather than a host that is merely slow.
    const listeners = new Map([[59999, HOST_ABSENT]]);
    const { effects, spawns } = fakeEffects({
      identities: new Map([[spawnPid, { pid: spawnPid, start: '5', boot: BOOT, comm: 'host' }]]),
      spawnPid, missingProcess: PROCESS_ABSENT, listeners,
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const serving = () => {
      if (spawns.length === 0) return false;
      listeners.set(59999, hostAt(spawnPid));
      return true;
    };
    const outcome = await recoverManagedHost(
      backend({ isAvailable: async () => serving() }) as never,
      effects, store, managedHostRestartLedger(), AUTHORIZED);
    check('a host that crashed is noticed and replaced, and the dead record is not reused',
      outcome.action === 'recovered'
        && (outcome as { outcome: { action: string } }).outcome.action === 'started'
        && spawns.length === 1 && records.get(AGENT)?.pid === spawnPid,
      JSON.stringify({ outcome, spawns: spawns.length, record: records.get(AGENT)?.pid }));
  }
  {
    // A serving host is the common case, and the tick must cost it nothing.
    const { effects, spawns, signals } = fakeEffects({});
    const { store } = memoryStore();
    const outcome = await recoverManagedHost(
      backend({ isAvailable: async () => true }) as never,
      effects, store, managedHostRestartLedger(), AUTHORIZED);
    check('a healthy host is left entirely alone by the supervisor',
      outcome.action === 'healthy' && spawns.length === 0 && signals.length === 0,
      JSON.stringify(outcome));
  }
  {
    // Ours, alive, and not answering: stopped through the ownership-checked path
    // and replaced.
    const table = new Map([[HOST_PID, OWNED], [6002, { pid: 6002, start: '7', boot: BOOT, comm: 'host' }]]);
    const listeners = new Map([[59999, hostAt(HOST_PID)]]);
    const { effects, signals, spawns } = fakeEffects({
      identities: table, spawnPid: 6002, missingProcess: PROCESS_ABSENT, listeners,
      // Dying releases the port, so the replacement finds the address empty.
      onSignal: (pid, signal, tbl) => {
        if (signal === 'SIGTERM') { tbl.delete(pid); listeners.set(59999, HOST_ABSENT); }
      },
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const serving = () => {
      if (spawns.length === 0) return false;
      listeners.set(59999, hostAt(6002));
      return true;
    };
    const outcome = await recoverManagedHost(
      backend({ isAvailable: async () => serving() }) as never,
      effects, store, managedHostRestartLedger(), AUTHORIZED);
    check('a wedged host that is PROVEN ours is stopped and replaced',
      outcome.action === 'recovered' && signals.some((entry) => entry.pid === HOST_PID)
        && spawns.length === 1 && records.get(AGENT)?.pid === 6002,
      JSON.stringify({ outcome, signals, spawns: spawns.length }));
  }
  {
    // A stranger's unresponsive host is not ours to restart FOR them.
    const { effects, signals, spawns } = fakeEffects({
      identities: new Map([[HOST_PID, OWNED]]),
      listeners: new Map([[59999, hostAt(HOST_PID)]]),
    });
    const { store, records } = memoryStore(); // no record: not ours
    records.set(AGENT, ownership({ pid: 999 })); // a record for a DIFFERENT process
    const outcome = await recoverManagedHost(
      backend({ isAvailable: async () => false }) as never,
      effects, store, managedHostRestartLedger(), AUTHORIZED);
    check('a foreign host that stops responding is never restarted on the user\'s behalf',
      outcome.action === 'declined' && (outcome as { reason: string }).reason === 'foreign'
        && signals.length === 0 && spawns.length === 0,
      JSON.stringify({ outcome, signals, spawns: spawns.length }));
  }
  {
    // An address this machine will not describe: no conclusion, no action.
    const { effects, signals, spawns } = fakeEffects({
      identities: new Map([[HOST_PID, OWNED]]),
      listeners: new Map(), // unknown
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await recoverManagedHost(
      backend({ isAvailable: async () => false }) as never,
      effects, store, managedHostRestartLedger(), AUTHORIZED);
    check('an unlocatable address is never recovered from, because nothing about it is proven',
      outcome.action === 'declined' && (outcome as { reason: string }).reason === 'unproven'
        && signals.length === 0 && spawns.length === 0,
      JSON.stringify({ outcome, signals, spawns: spawns.length }));
  }
  {
    // A host that dies instantly must not be respawned forever: the budget is
    // what turns a crash LOOP into one visible failure.
    const ledger = managedHostRestartLedger();
    const { effects, spawns } = fakeEffects({
      identities: new Map(), spawnPid: 6003, missingProcess: PROCESS_ABSENT,
      listeners: new Map([[59999, HOST_ABSENT]]),
    });
    const { store } = memoryStore();
    const attempts: string[] = [];
    for (let round = 0; round < 6; round += 1) {
      const outcome = await recoverManagedHost(
        backend({ isAvailable: async () => false }) as never,
        effects, store, ledger, AUTHORIZED);
      attempts.push(outcome.action === 'declined' ? (outcome as { reason: string }).reason : outcome.action);
    }
    // Each of the three attempts is reported as a FAILED recovery, which is what
    // this fixture has always described: a host that crashes on every start
    // never came back, and calling those attempts 'recovered' was the bug — the
    // operator was told the host had restarted, three times, while it was down.
    check('a host that crashes on every start stops being respawned once its budget is spent',
      attempts.slice(0, 3).every((entry) => entry === 'recovery-failed')
        && attempts.slice(3).every((entry) => entry === 'budget-exhausted')
        && spawns.length === 3,
      attempts.join(','));
  }
  {
    // The supervisor is behind the same gate as the start: an unauthorized agent
    // is not supervised into existence.
    const { effects, spawns } = fakeEffects({});
    const { store } = memoryStore();
    const outcome = await recoverManagedHost(
      backend({ isAvailable: async () => false }) as never,
      effects, store, managedHostRestartLedger(), {});
    check('recovery is behind the same default-off gate as starting',
      outcome.action === 'not-authorized' && spawns.length === 0, JSON.stringify(outcome));
  }
  {
    // A recovery that ends with a serving host, beside one that does not, so the
    // two are told apart by the OUTCOME rather than by the attempt having
    // happened. Only the first may ever reach an operator as good news.
    const listeners = new Map([[59999, HOST_ABSENT]]);
    const { effects } = fakeEffects({ missingProcess: PROCESS_ABSENT, listeners });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await recoverManagedHost(
      backend({ isAvailable: async () => false }) as never,
      { ...effects, spawn: () => { throw new Error('ENOENT: no such file or directory'); } },
      store, managedHostRestartLedger(), AUTHORIZED);
    check('a restart that cannot start a host is a FAILED recovery, never a recovery',
      outcome.action === 'recovery-failed'
        && (outcome as { outcome: { action: string; detailCode?: string } }).outcome.action === 'start-failed'
        && (outcome as { outcome: { detailCode?: string } }).outcome.detailCode === 'host-spawn-failed',
      JSON.stringify(outcome));
    check('...and it leaves no ownership record behind for a host that never started',
      records.size === 0, JSON.stringify([...records.keys()]));
  }
  {
    // The race the action name alone cannot describe: our host dies, and before
    // the restart spawns anything, ANOTHER process takes the address. The
    // attempt ends `already-serving` — the address answers — but what answers
    // is not ours. Reporting that as a recovery would tell the operator this
    // broker restarted a host it never touched, on an address it has lost.
    const listeners = new Map([[59999, HOST_ABSENT]]);
    const STRANGER = 7777;
    const { effects, spawns, signals } = fakeEffects({
      identities: new Map([[STRANGER, { pid: STRANGER, start: '99', boot: BOOT, comm: 'fixture-host' }]]),
      missingProcess: PROCESS_ABSENT,
      listeners,
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    let probes = 0;
    const outcome = await recoverManagedHost(
      backend({
        isAvailable: async () => {
          // The supervisor's own probe sees the crash; by the time the restart
          // probes, the stranger holds the port.
          probes += 1;
          if (probes === 1) return false;
          listeners.set(59999, hostAt(STRANGER));
          return true;
        },
      }) as never,
      effects, store, managedHostRestartLedger(), AUTHORIZED);
    check('an address taken by a FOREIGN host is a failed recovery, not a restart we can claim',
      outcome.action === 'recovery-failed'
        && (outcome as { outcome: { action: string; verdict?: string } }).outcome.action === 'already-serving'
        && (outcome as { outcome: { verdict?: string } }).outcome.verdict === 'foreign'
        // Nothing of ours was spawned and nobody else's host was signalled.
        && spawns.length === 0 && signals.length === 0,
      JSON.stringify({ outcome, spawns: spawns.length, signals }));
  }
  {
    // Same shape, one step weaker: something is serving and ownership cannot be
    // proved at all. A recovery claim needs proof, so this fails closed too.
    const listeners = new Map([[59999, HOST_ABSENT]]);
    const { effects, spawns } = fakeEffects({ missingProcess: PROCESS_ABSENT, listeners });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    let probes = 0;
    const outcome = await recoverManagedHost(
      backend({
        isAvailable: async () => {
          probes += 1;
          if (probes === 1) return false;
          listeners.set(59999, HOST_UNKNOWN);
          return true;
        },
      }) as never,
      effects, store, managedHostRestartLedger(), AUTHORIZED);
    check('an address whose holder cannot be identified is not reported as a recovery either',
      outcome.action === 'recovery-failed'
        && (outcome as { outcome: { action: string; verdict?: string } }).outcome.action === 'already-serving'
        && (outcome as { outcome: { verdict?: string } }).outcome.verdict !== 'owned'
        && spawns.length === 0,
      JSON.stringify({ outcome, spawns: spawns.length }));
  }

  // ── the locator is re-read, because Kimi's only exists after the spawn ──────
  //
  // A host found through a REGISTRY — not a port — cannot be located before it
  // has registered. The descriptor taken before starting says 'absent' and goes
  // on saying it, so a start that closes over it can never attribute the serving
  // host to the child it just spawned: every managed Kimi start reported
  // `servingProven: false` and logged that it could not confirm the process.
  {
    const spawnPid = 7401;
    const { effects } = fakeEffects({
      identities: new Map([[spawnPid, { pid: spawnPid, start: '11', boot: BOOT, comm: 'kimi-code' }]]),
      spawnPid, missingProcess: PROCESS_ABSENT,
    });
    const { store, records } = memoryStore();
    let registered = false;
    /** The registry publishes the pid only once the process exists. */
    const registryBackend = (locator: () => { kind: 'pid'; pid: number } | { kind: 'absent' }, key = KEY) =>
      backend({
        isAvailable: async () => registered,
        describeManagedHost: async () => ({
          identityKey: key,
          locator: locator(),
          launch: { command: '/fixture/bin/kimi', args: ['web', '--no-open'] },
          readyTimeoutMs: 300,
          stopGraceMs: 100,
        }),
      });
    const registering = { ...effects, spawn: (launch: ManagedHostLaunch) => { registered = true; return effects.spawn(launch); } };
    const outcome = await ensureManagedHost(
      registryBackend(() => (registered ? { kind: 'pid', pid: spawnPid } : { kind: 'absent' })) as never,
      registering, store, AUTHORIZED);
    check('a host whose registry names it only AFTER it starts is proven to be the process serving',
      outcome.action === 'started' && (outcome as { servingProven: boolean }).servingProven === true
        && records.get(AGENT)?.pid === spawnPid,
      JSON.stringify(outcome));
  }
  // ── the launch command is not always the thing that serves ────────────────
  //
  // On Windows a CLI installed by npm is a `.cmd` shim; batch has no exec, so
  // the shim CALLS the real program. The pid the broker spawns is `cmd.exe` and
  // the server is its child, which is the pid the adapter's locator names. A
  // native Windows Phase 6 run measured what that cost: a Kimi host spawned into
  // an EMPTY disposable home came back `already-serving` with verdict 'foreign'
  // — the engine stopped the host it had just started, and the record it kept
  // named a shim, so the serving process classified 'foreign' ever after and
  // could never be reaped.
  const SHIM_PID = 8100;
  const SERVER_PID = 8101;
  const shimTable = () => new Map([
    [SHIM_PID, { pid: SHIM_PID, start: '20', boot: BOOT, comm: 'cmd.exe' }],
    [SERVER_PID, { pid: SERVER_PID, start: '21', boot: BOOT, comm: 'node' }],
  ]);
  /** Ready only once spawned, and the locator names the SERVER, never the shim. */
  const shimBackend = (started: () => boolean) => backend({
    isAvailable: async () => started(),
    describeManagedHost: async () => ({
      identityKey: KEY,
      locator: started() ? { kind: 'pid' as const, pid: SERVER_PID } : { kind: 'absent' as const },
      launch: { command: '/fixture/bin/kimi.cmd', args: ['web', '--no-open'] },
      readyTimeoutMs: 300,
      stopGraceMs: 100,
    }),
  });
  {
    const { effects, signals } = fakeEffects({
      identities: shimTable(), spawnPid: SHIM_PID, missingProcess: PROCESS_ABSENT,
      descendants: new Map([[SERVER_PID, SHIM_PID]]),
    });
    const { store, records } = memoryStore();
    let started = false;
    const outcome = await ensureManagedHost(
      shimBackend(() => started) as never,
      { ...effects, spawn: (launch: ManagedHostLaunch) => { started = true; return effects.spawn(launch); } },
      store, AUTHORIZED);
    check('a serving process PROVEN to descend from the spawned child is ours, not a competitor',
      outcome.action === 'started'
        && (outcome as { servingProven: boolean }).servingProven === true
        && (outcome as { pid: number }).pid === SERVER_PID
        && signals.length === 0,
      JSON.stringify({ outcome, signals }));
    check('the record is RE-KEYED onto the serving process, so it still proves ownership later',
      records.get(AGENT)?.pid === SERVER_PID
        && records.get(AGENT)?.comm === 'node'
        && classifyManagedHost(records.get(AGENT)!, running(shimTable().get(SERVER_PID)!), KEY) === 'owned',
      JSON.stringify(records.get(AGENT)));
  }
  {
    // Descent PROVEN ABSENT is the competitor case, and it must still stop our
    // child. This is the assertion that the change above did not simply teach
    // the engine to adopt whatever happens to be serving.
    const { effects, signals } = fakeEffects({
      identities: shimTable(), spawnPid: SHIM_PID, missingProcess: PROCESS_ABSENT,
      childDiesOn: 'SIGTERM',
      onSignal: (pid, signal, live) => { if (signal === 'SIGTERM') live.delete(pid); },
      descendants: new Map([[SERVER_PID, 9999]]),
    });
    const { store, records } = memoryStore();
    let started = false;
    const outcome = await ensureManagedHost(
      shimBackend(() => started) as never,
      { ...effects, spawn: (launch: ManagedHostLaunch) => { started = true; return effects.spawn(launch); } },
      store, AUTHORIZED);
    check('a serving process proven NOT to descend from our child is still a competitor',
      outcome.action === 'already-serving'
        && signals.some((entry) => entry.pid === SHIM_PID)
        && records.size === 0,
      JSON.stringify({ outcome, signals }));
  }
  {
    // 'unknown' is not 'yes'. Every platform but Windows answers this way, so
    // this is the case that pins the no-change guarantee for them.
    const { effects, signals } = fakeEffects({
      identities: shimTable(), spawnPid: SHIM_PID, missingProcess: PROCESS_ABSENT,
      childDiesOn: 'SIGTERM',
      onSignal: (pid, signal, live) => { if (signal === 'SIGTERM') live.delete(pid); },
    });
    const { store } = memoryStore();
    let started = false;
    const outcome = await ensureManagedHost(
      shimBackend(() => started) as never,
      { ...effects, spawn: (launch: ManagedHostLaunch) => { started = true; return effects.spawn(launch); } },
      store, AUTHORIZED);
    check('a machine that cannot say whether it descends behaves exactly as before',
      outcome.action === 'already-serving' && signals.some((entry) => entry.pid === SHIM_PID),
      JSON.stringify({ outcome, signals }));
  }
  {
    // Proven ours, but the serving identity cannot be read, so there is nothing
    // to re-key the record ONTO. The host is not stopped and the record is not
    // rewritten from an unreadable process; the start simply declines to claim
    // which process serves.
    const { effects, signals } = fakeEffects({
      identities: new Map([[SHIM_PID, { pid: SHIM_PID, start: '20', boot: BOOT, comm: 'cmd.exe' }]]),
      spawnPid: SHIM_PID,
      descendants: new Map([[SERVER_PID, SHIM_PID]]),
    });
    const { store, records } = memoryStore();
    let started = false;
    const outcome = await ensureManagedHost(
      shimBackend(() => started) as never,
      { ...effects, spawn: (launch: ManagedHostLaunch) => { started = true; return effects.spawn(launch); } },
      store, AUTHORIZED);
    check('an unreadable serving identity leaves the record on the child and claims nothing more',
      outcome.action === 'started'
        && (outcome as { servingProven: boolean }).servingProven === false
        && (outcome as { pid: number }).pid === SHIM_PID
        && records.get(AGENT)?.pid === SHIM_PID
        && signals.length === 0,
      JSON.stringify({ outcome, record: records.get(AGENT) }));
  }
  {
    // A competing pid appears while the new host is coming up, and the live
    // locator is what makes it VISIBLE — the frozen one could only ever answer
    // 'absent' and would have let the start report success beside a stranger.
    //
    // Seeing it, the engine takes the harder of the two correct actions: our
    // child is demonstrably not the process serving, so it is stopped rather
    // than leaked, and the winner is classified and left strictly alone.
    const spawnPid = 7402;
    const competitor = 7403;
    const table = new Map([
      [spawnPid, { pid: spawnPid, start: '12', boot: BOOT, comm: 'kimi-code' }],
      [competitor, { pid: competitor, start: '13', boot: BOOT, comm: 'kimi-code' }],
    ]);
    const { effects, signals } = fakeEffects({
      identities: table,
      spawnPid, missingProcess: PROCESS_ABSENT, childDiesOn: 'SIGTERM',
      onSignal: (pid, signal, live) => { if (signal === 'SIGTERM') live.delete(pid); },
    });
    const { store, records } = memoryStore();
    let registered = false;
    const outcome = await ensureManagedHost(
      backend({
        isAvailable: async () => registered,
        describeManagedHost: async () => ({
          identityKey: KEY,
          locator: registered ? { kind: 'pid' as const, pid: competitor } : { kind: 'absent' as const },
          launch: { command: '/fixture/bin/kimi', args: ['web', '--no-open'] },
          readyTimeoutMs: 300,
          stopGraceMs: 100,
        }),
      }) as never,
      { ...effects, spawn: (launch: ManagedHostLaunch) => { registered = true; return effects.spawn(launch); } },
      store, AUTHORIZED);
    check('a registry naming somebody else during readiness stops OUR child and leaves the winner alone',
      outcome.action === 'already-serving'
        && (outcome as { verdict: string }).verdict === 'foreign'
        && signals.every((entry) => entry.pid === spawnPid)
        && signals.length > 0
        && records.size === 0,
      JSON.stringify({ outcome, signals, records: [...records.keys()] }));
  }
  {
    // Re-description that fails, or that comes back describing a DIFFERENT
    // address, must resolve to 'unknown' — which authorizes nothing and leaves
    // the start unable to claim more than it proved. An operator who repointed
    // the adapter mid-start must not have a host at the new address judged
    // against the record written for the old one.
    for (const [label, describe] of [
      ['throws', async () => { throw new Error('registry unreadable'); }],
      ['describes nothing', async () => null],
      ['names a different address', async () => ({
        identityKey: 'http://127.0.0.1:1',
        locator: { kind: 'pid' as const, pid: 7404 },
        launch: { command: '/fixture/bin/kimi', args: ['web'] },
        readyTimeoutMs: 300,
        stopGraceMs: 100,
      })],
    ] as Array<[string, () => Promise<unknown>]>) {
      const spawnPid = 7405;
      const { effects } = fakeEffects({
        identities: new Map([[spawnPid, { pid: spawnPid, start: '14', boot: BOOT, comm: 'kimi-code' }]]),
        spawnPid, missingProcess: PROCESS_ABSENT,
      });
      const { store, records } = memoryStore();
      let started = false;
      const outcome = await ensureManagedHost(
        backend({
          isAvailable: async () => started,
          describeManagedHost: async () => (started
            ? await describe()
            : {
                identityKey: KEY,
                locator: { kind: 'absent' as const },
                launch: { command: '/fixture/bin/kimi', args: ['web'] },
                readyTimeoutMs: 300,
                stopGraceMs: 100,
              }),
        }) as never,
        { ...effects, spawn: (launch: ManagedHostLaunch) => { started = true; return effects.spawn(launch); } },
        store, AUTHORIZED);
      check(`a re-description that ${label} leaves the start unproven rather than wrong`,
        outcome.action === 'started' && (outcome as { servingProven: boolean }).servingProven === false
          && records.get(AGENT)?.pid === spawnPid,
        `${label}: ${JSON.stringify(outcome)}`);
    }
  }


  {
    // ...but the process still has to BE ours. An unresolvable listener plus a
    // process this machine will not identify authorizes nothing, and the record
    // survives so a later stop can try again.
    const { effects, signals } = fakeEffects({
      identities: new Map(), // unreadable
      listeners: new Map(),  // unresolvable
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await releaseManagedHost(backend() as never, effects, store);
    check('an unidentifiable process behind an unresolvable listener is preserved, and its record kept',
      outcome.action === 'preserved' && (outcome as { verdict: string }).verdict === 'indeterminate'
        && signals.length === 0 && records.size === 1,
      JSON.stringify({ outcome, signals, records: records.size }));
  }
  {
    // The round trip the reviewer asked for: a start whose serving process could
    // not be resolved must still be stoppable afterwards. Under the listener-led
    // stop this host survived shutdown and uninstall forever.
    const spawnPid = 7101;
    const identity = { pid: spawnPid, start: '31', boot: BOOT, comm: 'host' };
    const table = new Map([[spawnPid, identity]]);
    let locates = 0;
    const { effects, signals } = fakeEffects({
      identities: table, spawnPid, missingProcess: PROCESS_ABSENT,
      onSignal: (pid, signal, live) => { if (signal === 'SIGTERM') live.delete(pid); },
    });
    const { store, records } = memoryStore();
    const started = await startManagedHost(
      plan({
        ready: async () => locates > 0,
        locate: async () => (locates++ === 0 ? HOST_ABSENT : HOST_UNKNOWN),
      }),
      effects, store,
    );
    const released = await stopManagedHost(
      { agent: AGENT, identityKey: KEY, stopGraceMs: 200 }, effects, store, async () => HOST_UNKNOWN);
    check('a start whose serving process could not be resolved is still stoppable afterwards',
      started.action === 'started' && started.servingProven === false
        && released.action === 'stopped' && signals.some((entry) => entry.pid === spawnPid)
        && records.size === 0,
      JSON.stringify({ started, released, signals }));
  }
  {
    // A REBOOT is what makes the Linux start token ambiguous: it counts ticks
    // since boot, so a fresh process can hold the same pid, the same tick, and
    // the same name as the host a persisted record describes.
    const afterReboot: HostProcessIdentity = { ...OWNED, boot: 'boot-bbbb' };
    check('a process from a DIFFERENT boot is never our host, however exactly the rest matches',
      classifyManagedHost(ownership(), running(afterReboot), KEY) === 'foreign',
      JSON.stringify(afterReboot));
    const { effects, signals } = fakeEffects({ identities: new Map([[HOST_PID, afterReboot]]) });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await stopManagedHost(
      { agent: AGENT, identityKey: KEY, stopGraceMs: 200 }, effects, store, async () => hostAt(HOST_PID));
    check('a stale pre-reboot record never signals the stranger that inherited its pid',
      outcome.action === 'already-gone' && signals.length === 0 && records.size === 0,
      JSON.stringify({ outcome, signals }));
  }
  {
    // Not a comparison — the two names are equal here and it is still foreign.
    // An identity carrying no command name came from a read that never reached a
    // process, and treating that as a successful read of an unnamed one would
    // let a failed lookup authorize a signal.
    check('an empty command name is a failed read, not a match, even against a record that also has none',
      classifyManagedHost(
        ownership({ comm: '' }), running({ ...OWNED, comm: '' }), KEY,
      ) === 'foreign');
    // Both sides, checked separately, because dropping the comparison must not
    // let a malformed record through on the strength of a healthy live read.
    // `startManagedHost` builds a record FROM a live identity, so one with no
    // command name was never written by this product.
    check('a record with no command name proves nothing, however healthy the live process reads',
      classifyManagedHost(ownership({ comm: '' }), running(OWNED), KEY) === 'foreign');
    check('a live process with no command name proves nothing, however complete the record',
      classifyManagedHost(ownership(), running({ ...OWNED, comm: '' }), KEY) === 'foreign');
  }


  // ── shutdown must not race a recovery that is already in flight ────────────
  {
    // The race, parked open on purpose. A recovery is suspended INSIDE its
    // start, shutdown begins, and the release pass runs. If shutdown only waits
    // for startup, it releases while that start is still pending and the
    // replacement appears afterwards: a live process with a valid ownership
    // record and no broker left to reap it.
    const spawnPid = 7201;
    const listeners = new Map([[59999, HOST_ABSENT]]);
    const { effects, spawns, signals } = fakeEffects({
      identities: new Map([[spawnPid, { pid: spawnPid, start: '77', boot: BOOT, comm: 'host' }]]),
      spawnPid, missingProcess: PROCESS_ABSENT, listeners,
      onSignal: (pid, signal, live) => { if (signal === 'SIGTERM') live.delete(pid); },
    });
    const { store, records } = memoryStore();
    let release!: () => void;
    const parked = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    const order: string[] = [];
    let stopping = false;
    const supervisor = new ManagedHostSupervisor({
      backends: () => [backend({
        isAvailable: async () => {
          // Park exactly once, on the recovery's own liveness probe: the tick is
          // now committed and inside `recoverManagedHost`.
          if (!held) {
            held = true;
            await parked;
            return false;
          }
          if (spawns.length > 0) { listeners.set(59999, hostAt(spawnPid)); return true; }
          return false;
        },
      }) as never],
      effects, store, ledger: managedHostRestartLedger(),
      stopping: () => stopping,
      env: AUTHORIZED,
      onOutcome: (_agent, outcome) => { order.push(`recovery:${outcome.action}`); },
    });
    supervisor.tick();
    // Shutdown begins while that tick is parked.
    stopping = true;
    const shutdown = (async () => {
      await supervisor.settled();
      order.push('settled');
      const outcome = await releaseManagedHost(backend() as never, effects, store);
      order.push(`release:${outcome.action}`);
    })();
    release();
    await shutdown;
    check('shutdown waits for an in-flight recovery, so a host it spawned is still released',
      order.join(' → ') === 'recovery:recovered → settled → release:stopped'
        && spawns.length === 1 && signals.some((entry) => entry.pid === spawnPid)
        && records.size === 0,
      JSON.stringify({ order, spawns: spawns.length, signals, records: records.size }));
  }
  {
    // A tick refused because shutdown already began must not start anything.
    const { effects, spawns } = fakeEffects({ listeners: new Map([[59999, HOST_ABSENT]]) });
    const { store } = memoryStore();
    const supervisor = new ManagedHostSupervisor({
      backends: () => [backend({ isAvailable: async () => false }) as never],
      effects, store, ledger: managedHostRestartLedger(),
      stopping: () => true,
      env: AUTHORIZED,
    });
    supervisor.tick();
    await supervisor.settled();
    check('a tick asked for after shutdown began starts nothing at all',
      spawns.length === 0, String(spawns.length));
  }


  // ── a start must not overwrite the proof for a host we already have ────────
  //
  // An empty ADDRESS is not the same as having no host. Two ordinary situations
  // produce a live, recorded process that the address knows nothing about, and
  // in both, spawning over the record destroys the only thing that could ever
  // authorize stopping the process still running.
  {
    // The lingering case: `kimi web` released its listener, its process did not
    // exit, and the registry no longer names it.
    const previous = 8801;
    const previousIdentity: HostProcessIdentity = { pid: previous, start: '400', boot: BOOT, comm: 'host' };
    const spawnPid = 8802;
    const table = new Map([
      [previous, previousIdentity],
      [spawnPid, { pid: spawnPid, start: '401', boot: BOOT, comm: 'host' }],
    ]);
    let locates = 0;
    const { effects, signals, spawns } = fakeEffects({
      identities: table, spawnPid, missingProcess: PROCESS_ABSENT,
      onSignal: (pid, signal, live) => { if (signal === 'SIGTERM') live.delete(pid); },
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership({ pid: previous, start: '400', comm: 'host' }));
    const outcome = await startManagedHost(
      plan({
        ready: async () => locates > 0,
        locate: async () => (locates++ === 0 ? HOST_ABSENT : hostAt(spawnPid)),
      }),
      effects, store,
    );
    check('a recorded host that is still ALIVE at an empty address is stopped before a replacement starts',
      outcome.action === 'started' && spawns.length === 1
        // The predecessor was reaped rather than abandoned...
        && signals.some((entry) => entry.pid === previous)
        // ...and the record now describes the replacement, not the ghost.
        && records.get(AGENT)?.pid === spawnPid,
      JSON.stringify({ outcome, signals, record: records.get(AGENT)?.pid }));
  }
  {
    // The repointed case: the operator moved the adapter to a new address. The
    // new one is empty; the host we started for the OLD one is still running,
    // and its record carries that old identity key.
    const previous = 8811;
    const spawnPid = 8812;
    const table = new Map([
      [previous, { pid: previous, start: '500', boot: BOOT, comm: 'host' }],
      [spawnPid, { pid: spawnPid, start: '501', boot: BOOT, comm: 'host' }],
    ]);
    let locates = 0;
    const { effects, signals, spawns } = fakeEffects({
      identities: table, spawnPid, missingProcess: PROCESS_ABSENT,
      onSignal: (pid, signal, live) => { if (signal === 'SIGTERM') live.delete(pid); },
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership({
      pid: previous, start: '500', comm: 'host', identityKey: 'http://127.0.0.1:1111',
    }));
    const outcome = await startManagedHost(
      plan({
        identityKey: 'http://127.0.0.1:2222', // repointed since
        ready: async () => locates > 0,
        locate: async () => (locates++ === 0 ? HOST_ABSENT : hostAt(spawnPid)),
      }),
      effects, store,
    );
    check('repointing the adapter reaps the host started for the OLD address instead of stranding it',
      outcome.action === 'started' && spawns.length === 1
        && signals.some((entry) => entry.pid === previous)
        && records.get(AGENT)?.pid === spawnPid
        && records.get(AGENT)?.identityKey === 'http://127.0.0.1:2222',
      JSON.stringify({ outcome, signals, record: records.get(AGENT) }));
  }
  {
    // ...but a predecessor this machine cannot identify is NOT settled, so
    // nothing is started over it. Its record is the only proof there is.
    const previous = 8821;
    const { effects, signals, spawns } = fakeEffects({
      identities: new Map(), spawnPid: 8822, // predecessor unreadable
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership({ pid: previous, start: '600', comm: 'host' }));
    const outcome = await startManagedHost(
      plan({ ready: async () => false, locate: async () => HOST_ABSENT }), effects, store);
    check('an unidentifiable predecessor blocks the start rather than having its proof overwritten',
      outcome.action === 'preserved-predecessor'
        && (outcome as { verdict: string }).verdict === 'indeterminate'
        && spawns.length === 0 && signals.length === 0
        && records.get(AGENT)?.pid === previous,
      JSON.stringify({ outcome, spawns: spawns.length, record: records.get(AGENT)?.pid }));
  }
  {
    // A predecessor proven GONE is simply forgotten, and the start proceeds.
    const spawnPid = 8832;
    const { effects, spawns } = fakeEffects({
      identities: new Map([[spawnPid, { pid: spawnPid, start: '701', boot: BOOT, comm: 'host' }]]),
      spawnPid, missingProcess: PROCESS_ABSENT,
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership({ pid: 8831, start: '700', comm: 'host' }));
    let locates = 0;
    const outcome = await startManagedHost(
      plan({
        ready: async () => locates > 0,
        locate: async () => (locates++ === 0 ? HOST_ABSENT : hostAt(spawnPid)),
      }),
      effects, store,
    );
    check('a predecessor proven gone is forgotten and the start proceeds normally',
      outcome.action === 'started' && spawns.length === 1 && records.get(AGENT)?.pid === spawnPid,
      JSON.stringify({ outcome, record: records.get(AGENT)?.pid }));
  }

  // ── the predecessor question is NOT about this address ─────────────────────
  //
  // Reconciling only after the new address was proven empty made the repointed
  // case unreachable in the way it actually happens. An operator who repoints the
  // adapter at an address their own host already serves used to get
  // 'already-serving' from the very first check, so the host WE started for the
  // old address kept running, unmentioned, until the broker exited.
  {
    const previous = 8841;
    const stranger = 8842;
    const table = new Map([
      [previous, { pid: previous, start: '800', boot: BOOT, comm: 'host' }],
      [stranger, { pid: stranger, start: '801', boot: BOOT, comm: 'host' }],
    ]);
    const { effects, signals, spawns } = fakeEffects({
      identities: table, missingProcess: PROCESS_ABSENT,
      onSignal: (pid, signal, live) => { if (signal === 'SIGTERM') live.delete(pid); },
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership({
      pid: previous, start: '800', comm: 'host', identityKey: 'http://127.0.0.1:1111',
    }));
    const outcome = await startManagedHost(
      plan({
        identityKey: 'http://127.0.0.1:2222', // repointed onto a served address
        ready: async () => true,
        locate: async () => hostAt(stranger),
      }),
      effects, store,
    );
    check('a repointed start reaps our old host even though the new address is already served',
      outcome.action === 'already-serving'
        && signals.some((entry) => entry.pid === previous)
        && records.get(AGENT) === undefined,
      JSON.stringify({ outcome, signals, record: records.get(AGENT)?.pid }));
    check('reaping the old host never touches the one now serving, and starts nothing',
      !signals.some((entry) => entry.pid === stranger) && spawns.length === 0,
      JSON.stringify({ signals, spawns: spawns.length }));
  }
  {
    // The same reconciliation must NOT fire when the process at the address might
    // BE the recorded one. An address this machine will not describe is exactly
    // that case, and reaping on a guess there kills the working host.
    const previous = 8851;
    const { effects, signals, spawns } = fakeEffects({
      identities: new Map([[previous, { pid: previous, start: '900', boot: BOOT, comm: 'host' }]]),
      missingProcess: PROCESS_ABSENT,
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership({ pid: previous, start: '900', comm: 'host' }));
    const outcome = await startManagedHost(
      plan({ ready: async () => false, locate: async () => HOST_UNKNOWN }), effects, store);
    check('an unlocatable address leaves the recorded host alone rather than reaping on a guess',
      outcome.action === 'preserved-unlocatable'
        && signals.length === 0 && spawns.length === 0
        && records.get(AGENT)?.pid === previous,
      JSON.stringify({ outcome, signals, record: records.get(AGENT)?.pid }));
  }
  {
    // Nor when the record IS what is serving: that is the ordinary healthy case,
    // and reaping there would kill the host this call exists to ensure.
    const { effects, signals, spawns } = fakeEffects({
      identities: new Map([[HOST_PID, OWNED]]), missingProcess: PROCESS_ABSENT,
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await startManagedHost(
      plan({ ready: async () => true, locate: async () => hostAt(HOST_PID) }), effects, store);
    check('our own serving host is never reaped as its own predecessor',
      outcome.action === 'already-serving'
        && (outcome as { verdict: string }).verdict === 'owned'
        && signals.length === 0 && spawns.length === 0
        && records.get(AGENT)?.pid === HOST_PID,
      JSON.stringify({ outcome, signals, record: records.get(AGENT)?.pid }));
  }
  {
    // A predecessor that refuses to die on a path where something else is already
    // serving: the address answer is 'already-serving', and the stranded host is
    // reported ALONGSIDE it rather than instead of it. One fact must not hide the
    // other — the operator needs to know both that their host is up and that one
    // of ours is loose.
    const previous = 8861;
    const stranger = 8862;
    const { effects, signals } = fakeEffects({
      identities: new Map([
        [previous, { pid: previous, start: '950', boot: BOOT, comm: 'host' }],
        [stranger, { pid: stranger, start: '951', boot: BOOT, comm: 'host' }],
      ]),
      missingProcess: PROCESS_ABSENT, // signals land, nothing dies
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership({
      pid: previous, start: '950', comm: 'host', identityKey: 'http://127.0.0.1:1111',
    }));
    const outcome = await startManagedHost(
      plan({
        identityKey: 'http://127.0.0.1:2222',
        ready: async () => true,
        locate: async () => hostAt(stranger),
      }),
      effects, store,
    );
    check('a host that refused to die is reported alongside the address outcome, not instead of it',
      outcome.action === 'already-serving' && outcome.strandedPredecessor === 'indeterminate'
        // Its proof survives, because it is still running and still ours.
        && records.get(AGENT)?.pid === previous
        && signals.some((entry) => entry.pid === previous),
      JSON.stringify({ outcome, record: records.get(AGENT)?.pid }));
  }
  {
    // A predecessor stop takes real time. Measuring the child's readiness from
    // before that stop let a slow reap spend the new host's entire budget and
    // then fail it for being slow: here the stop costs 250ms of a 1000ms
    // timeout and the child answers 800ms after it is spawned, which is inside
    // its own budget and outside a budget started at the top of the call.
    const previous = 8871;
    const spawnPid = 8872;
    const { effects, spawns } = fakeEffects({
      identities: new Map([
        [previous, { pid: previous, start: '960', boot: BOOT, comm: 'host' }],
        [spawnPid, { pid: spawnPid, start: '961', boot: BOOT, comm: 'host' }],
      ]),
      spawnPid, missingProcess: PROCESS_ABSENT,
      // Refuses SIGTERM, dies on SIGKILL: the expensive but ordinary reap.
      onSignal: (pid, signal, live) => { if (signal === 'SIGKILL') live.delete(pid); },
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership({ pid: previous, start: '960', comm: 'host' }));
    let readyCalls = 0;
    const outcome = await startManagedHost(
      plan({
        ready: async () => readyCalls++ >= 9,
        locate: async () => (readyCalls > 9 ? hostAt(spawnPid) : HOST_ABSENT),
      }),
      effects, store,
    );
    check('a slow predecessor reap does not spend the new host\'s readiness budget',
      outcome.action === 'started' && spawns.length === 1 && records.get(AGENT)?.pid === spawnPid,
      JSON.stringify({ outcome, record: records.get(AGENT)?.pid }));
  }
  {
    // THE MOVE FROM A LOCAL HOST TO A REMOTE ONE.
    //
    // The operator repoints dsh at a host somebody else runs. The new descriptor
    // carries no launch spec — nothing here can start that host — and the new
    // address is healthy and foreign. The old, locally managed process we
    // started is still running and is now unreachable by any address this
    // adapter will ever describe again. It has to be reaped on this pass; there
    // is no later one that would.
    const previous = 8881;
    const remote = 8882;
    const { effects, signals, spawns } = fakeEffects({
      identities: new Map([
        [previous, { pid: previous, start: '970', boot: BOOT, comm: 'host' }],
        [remote, { pid: remote, start: '971', boot: BOOT, comm: 'host' }],
      ]),
      listeners: new Map([[59999, hostAt(remote)]]),
      missingProcess: PROCESS_ABSENT,
      onSignal: (pid, signal, live) => { if (signal === 'SIGTERM') live.delete(pid); },
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership({
      pid: previous, start: '970', comm: 'host', identityKey: 'http://127.0.0.1:1111',
    }));
    const outcome = await ensureManagedHost(
      backend({
        isAvailable: async () => true,
        describeManagedHost: async () => ({
          identityKey: 'http://127.0.0.1:59999',
          locator: { kind: 'tcp-port' as const, port: 59999 },
          launch: null, // not this machine's host to run
          readyTimeoutMs: 300,
          stopGraceMs: 100,
        }),
      }) as never,
      effects, store, AUTHORIZED,
    );
    check('moving a managed host to a remote one reaps the local process we started',
      outcome.action === 'already-serving'
        && signals.some((entry) => entry.pid === previous)
        && records.get(AGENT) === undefined,
      JSON.stringify({ outcome, signals, record: records.get(AGENT)?.pid }));
    check('the remote host is classified and left strictly alone',
      (outcome as { verdict?: string }).verdict === 'foreign'
        && !signals.some((entry) => entry.pid === remote) && spawns.length === 0,
      JSON.stringify({ outcome, signals }));
  }
  {
    // The same descriptor with nothing at the address at all: still not a start,
    // and still a reconciliation.
    const previous = 8891;
    const { effects, signals, spawns } = fakeEffects({
      identities: new Map([[previous, { pid: previous, start: '980', boot: BOOT, comm: 'host' }]]),
      listeners: new Map([[59999, HOST_ABSENT]]),
      missingProcess: PROCESS_ABSENT,
      onSignal: (pid, signal, live) => { if (signal === 'SIGTERM') live.delete(pid); },
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership({ pid: previous, start: '980', comm: 'host' }));
    const outcome = await ensureManagedHost(
      backend({
        isAvailable: async () => false,
        describeManagedHost: async () => ({
          identityKey: KEY,
          locator: { kind: 'tcp-port' as const, port: 59999 },
          launch: null,
          readyTimeoutMs: 300,
          stopGraceMs: 100,
        }),
      }) as never,
      effects, store, AUTHORIZED,
    );
    check('an unlaunchable descriptor over an empty address still settles the recorded host',
      outcome.action === 'not-launchable'
        && signals.some((entry) => entry.pid === previous)
        && records.get(AGENT) === undefined && spawns.length === 0,
      JSON.stringify({ outcome, signals, record: records.get(AGENT)?.pid }));
  }

  // ── the posture that decides what an operator is TOLD to do ───────────────
  //
  // Doctor may not tell someone to start a host while cosyncing is starting or
  // recovering one: the two race and leave two servers on one home, which is the
  // ambiguity every proof in this file exists to prevent. Two independent
  // signals answer it, because either alone is wrong exactly when it matters —
  // during a first startup there is no record yet, and a foreground broker has
  // no service at all.
  {
    const postureHome = mkdtempSync(join(tmpdir(), 'cosyncing-managed-posture-'));
    // The fixture adapters resolve an identity the way the real ones do: from the
    // environment they are asked about, falling back to a default under the home.
    // That is what makes the operator-shell case expressible at all — the same
    // adapter answers differently for the service's environment and for a shell's.
    const externalHostAdapter = (id: string) => ({
      id,
      displayName: id,
      capabilities: {},
      integration: { externalHost: { managed: true as const } },
      managedHostIdentity: ({ env, homeDir }: { env: Record<string, string | undefined>; homeDir: string }) =>
        env[`${id.toUpperCase().replace(/-/g, '_')}_HOME`] ?? `${homeDir}/${id}-default`,
    });
    const plainAdapter = (id: string) => ({ id, displayName: id, capabilities: {} });
    const adapters = [
      externalHostAdapter('fixture-host'), externalHostAdapter('other-host'), plainAdapter('plain'),
    ] as never as readonly Parameters<typeof brokerManagedHostIdentities>[2][number][];
    // Two homes, deliberately different, because they ARE different on a real
    // machine: `~/.cosyncing` holds the receipt and the records, `~` holds the
    // agent's own directory. A fixture that used one path for both would pass
    // while the product resolved every identity under the wrong home.
    const postureUserHome = mkdtempSync(join(tmpdir(), 'cosyncing-managed-userhome-'));
    const serviceIdentity = (id: string) => `${postureUserHome}/${id}-default`;

    const environmentPath = join(postureHome, 'broker.env');
    const installState = (resources: Array<Record<string, unknown>>) => ({
      schemaVersion: 1 as const,
      product: 'cosyncing',
      setup: { status: 'committed' as const, committedAt: '2026-08-17T00:00:00.000Z' },
      resources,
      migrations: [],
    });
    const serviceEnvironmentResource = [{
      id: 'service-environment', kind: 'environment-file', target: environmentPath,
      ownership: { proof: 'receipt' },
    }];
    /** A machine where every recorded pid reads as a live host of ours. */
    const liveEffects = fakeEffects({
      identities: new Map([[HOST_PID, OWNED]]), missingProcess: PROCESS_ABSENT,
    }).effects;
    /** `agent=identity|identity`, sorted, so a check reads as the whole answer. */
    const postureOf = (effects = liveEffects) =>
      [...brokerManagedHostIdentities(postureHome, postureUserHome, adapters, { effects })]
        .map(([agent, identities]) => `${agent}=${[...identities].sort().join('|')}`)
        .sort().join(',');

    // Nothing installed and nothing recorded: manual instructions are correct
    // here, and suppressing them would leave the operator with no way forward.
    check('with no service configuration and no record, no host is broker-managed',
      postureOf() === '', postureOf());

    // A RECORD alone is enough. This is the foreground broker, and the state a
    // failed stop leaves behind — no durable service anywhere, and a process
    // that is still ours.
    const postureStore = managedHostStore(postureHome);
    postureStore.write(ownership({ agent: 'fixture-host' }));
    check('an ownership record for a live process alone makes that host broker-managed',
      postureOf() === `fixture-host=${KEY}`, postureOf());
    // ...and it manages THAT host, not the agent. The identity is the record's
    // own key — the host that was actually started — so a diagnosis pointed
    // anywhere else matches nothing and keeps its manual instruction.
    check('the record contributes its own identity and no other',
      postureOf() === `fixture-host=${KEY}` && KEY !== serviceIdentity('fixture-host'), postureOf());

    // ...but only while it still describes a process. A record whose process is
    // provably gone manages nothing, and treating it as management would leave
    // an unmanaged operator with no way to start their host at all.
    const goneEffects = fakeEffects({ identities: new Map(), missingProcess: PROCESS_ABSENT }).effects;
    check('a record whose process is proven gone is not management',
      postureOf(goneEffects) === '', postureOf(goneEffects));
    // An unreadable process table is not proof of anything, so it does not
    // withdraw the record either.
    const unreadableEffects = fakeEffects({ identities: new Map() }).effects;
    check('a record this machine cannot resolve still suppresses manual instructions',
      postureOf(unreadableEffects) === `fixture-host=${KEY}`, postureOf(unreadableEffects));
    postureStore.clear('fixture-host');

    // THE COMMITTED SERVICE RECEIPT, with no record at all — the first startup,
    // before anything has been started to record.
    writeInstallState(installState(serviceEnvironmentResource) as never, postureHome);
    writeFileSync(environmentPath, `${managedHostGateEnv('fixture-host')}="1"\nHOME="/fixture"\n`);
    check('a committed service receipt needs no ownership record to prove management',
      postureOf() === `fixture-host=${serviceIdentity('fixture-host')},other-host=${serviceIdentity('other-host')}`,
      postureOf());
    // The identity is the one the SERVICE resolves, not the one an operator's
    // shell would. Poisoning the CALLER's environment is what makes this a test
    // rather than a restatement: `cosyncing doctor` runs in a shell whose
    // variables say nothing about how the broker was launched, so a posture that
    // read them would report the operator's host as the supervised one — the
    // exact false claim identities exist to prevent.
    const callerHome = process.env.FIXTURE_HOST_HOME;
    process.env.FIXTURE_HOST_HOME = '/from-a-shell';
    try {
      check('the receipt manages the service\'s own configuration, not the caller\'s',
        postureOf() === `fixture-host=${serviceIdentity('fixture-host')},other-host=${serviceIdentity('other-host')}`
          && !postureOf().includes('from-a-shell'),
        postureOf());
    } finally {
      if (callerHome === undefined) delete process.env.FIXTURE_HOST_HOME;
      else process.env.FIXTURE_HOST_HOME = callerHome;
    }
    // BOTH signals at once, which is the state a running service reaches the
    // moment it starts a host: the receipt's default identity and the record's
    // actual one, and a diagnosis matches whichever it resolved.
    postureStore.write(ownership({ agent: 'fixture-host' }));
    check('a receipt and a record contribute both identities, not one merged claim',
      postureOf().startsWith(`fixture-host=${[KEY, serviceIdentity('fixture-host')].sort().join('|')}`),
      postureOf());
    postureStore.clear('fixture-host');

    // THE THREE WAYS THE FILE STOPS AGREEING WITH THE RUNNING SERVICE.
    //
    // Managed hosts are default-on in the environment setup writes, and that file
    // is receipt-owned rather than a live opt-out: a service already running has
    // loaded `=1` into its own process environment, and editing, breaking, or
    // deleting the file afterwards does not reach into that process. So none of
    // these may read as "nothing is managing the host" — that would hand the
    // operator a start command while the service is still supervising one.
    writeFileSync(environmentPath, `${managedHostGateEnv('fixture-host')}="0"\n`);
    check('a drifted environment that switches management off is still managed',
      postureOf() === `fixture-host=${serviceIdentity('fixture-host')},other-host=${serviceIdentity('other-host')}`, postureOf());
    writeFileSync(environmentPath, 'this is not an environment file\n');
    check('an unparseable environment file is still managed',
      postureOf() === `fixture-host=${serviceIdentity('fixture-host')},other-host=${serviceIdentity('other-host')}`, postureOf());
    rmSync(environmentPath, { force: true });
    check('a missing environment file is still managed',
      postureOf() === `fixture-host=${serviceIdentity('fixture-host')},other-host=${serviceIdentity('other-host')}`, postureOf());

    // THE TWO HOMES ARE NOT INTERCHANGEABLE, and this is the check that says so.
    //
    // Passing the state home where the user home belongs resolves identities
    // under `~/.cosyncing`, which no agent has ever used. Nothing errors: the
    // posture simply names a host that does not exist, the diagnosis resolves
    // the real one, they do not match, and an operator whose service manages
    // that host is handed a manual start command again. The failure is silent
    // by construction, so it needs an explicit test rather than a type.
    {
      const wrongHome = [...brokerManagedHostIdentities(postureHome, postureHome, adapters, { effects: liveEffects })]
        .flatMap(([, identities]) => [...identities]);
      const rightHome = [...brokerManagedHostIdentities(postureHome, postureUserHome, adapters, { effects: liveEffects })]
        .flatMap(([, identities]) => [...identities]);
      check('the identity follows the USER home, not the state home',
        rightHome.every((identity) => identity.startsWith(postureUserHome))
          && !rightHome.some((identity) => identity.startsWith(`${postureHome}/`))
          && wrongHome.some((identity) => identity.startsWith(`${postureHome}/`)),
        `user=${rightHome.join(' ')} | state=${wrongHome.join(' ')}`);
      // ...and the receipt is still read from the STATE home, so the split did
      // not simply move both roles onto the other path.
      const noReceipt = brokerManagedHostIdentities(postureUserHome, postureUserHome, adapters, { effects: liveEffects });
      check('the receipt is still looked for in the state home',
        noReceipt.size === 0 && rightHome.length > 0,
        `${noReceipt.size} agents from the user home`);
    }

    // THE RECONSTRUCTION, checked against the real thing.
    //
    // The posture resolves the service's identity from an EMPTY environment plus
    // the install home, which is only correct while the service environment
    // carries no agent host variable. That is a property of
    // `brokerServiceEnvironmentEntries`, not of this module, so it is asserted
    // against the actual entries rather than assumed: add `KIMI_CODE_HOME` or
    // `COSYNCING_DSH_BASE_URL` there and this fails instead of silently scoping
    // every posture to the wrong host.
    {
      const serviceEnvironment = Object.fromEntries(brokerServiceEnvironmentEntries({
        homeDir: '/fixture/home',
        stateHome: '/fixture/state',
        cacheRoot: '/fixture/cache',
        executablePath: '/fixture/bin/cosyncing',
        webDir: '/fixture/web',
      }));
      const managedShipped = shippedAdapters().filter((a) => a.integration?.externalHost?.managed === true);
      check('every shipped adapter with a managed host can name that host',
        managedShipped.length > 0 && managedShipped.every((a) => typeof a.managedHostIdentity === 'function'),
        managedShipped.map((a) => `${a.id}=${typeof a.managedHostIdentity}`).join(' '));
      const disagreeing = managedShipped.filter((a) =>
        a.managedHostIdentity!({ env: serviceEnvironment, homeDir: '/fixture/home' })
          !== a.managedHostIdentity!({ env: {}, homeDir: '/fixture/home' }));
      check('the real service environment resolves the same identity the posture reconstructs',
        disagreeing.length === 0,
        disagreeing.map((a) => `${a.id}=${a.managedHostIdentity!({ env: serviceEnvironment, homeDir: '/fixture/home' })}`)
          .join(' ') || 'none');
      // ...and the reconstruction is not vacuous: an environment that DOES name a
      // host resolves somewhere else, which is the operator-shell case the whole
      // identity scoping exists for.
      const shellIdentities = managedShipped.map((a) => a.managedHostIdentity!({
        env: { KIMI_CODE_HOME: '/elsewhere/.kimi-code', COSYNCING_DSH_BASE_URL: 'http://dsh-host.example:9999' },
        homeDir: '/fixture/home',
      }));
      check('an operator shell that names a host resolves a different identity',
        shellIdentities.every((identity, index) =>
          identity !== managedShipped[index]!.managedHostIdentity!({ env: {}, homeDir: '/fixture/home' })),
        shellIdentities.join(' '));
    }

    // Provider-neutral by construction: the question is asked of adapters that
    // DECLARE an external host, never of a tool named in this file.
    check('an adapter with no external host is never broker-managed',
      !postureOf().includes('plain='), postureOf());
    rmSync(postureHome, { recursive: true, force: true });
    rmSync(postureUserHome, { recursive: true, force: true });
  }

  // ── every outcome an operator can hit says something ───────────────────────
  //
  // `preserved-predecessor` was returned by the engine and handled nowhere, so an
  // authorized managed host could decline to start in silence. Asserting the
  // report as data is what stops the next variant from doing the same.
  {
    const spoken = (outcome: Parameters<typeof managedHostStartupReport>[1]) =>
      managedHostStartupReport(AGENT, outcome);

    check('a start blocked by a predecessor explains itself and points at doctor',
      (() => {
        const lines = spoken({ action: 'preserved-predecessor', verdict: 'indeterminate' });
        return lines.length === 1 && lines[0]!.level === 'warn'
          && lines[0]!.message.includes('cosyncing doctor')
          && lines[0]!.message.includes(AGENT);
      })());

    check('a stranded host is reported in ADDITION to whatever happened at the address',
      (() => {
        const lines = spoken({ action: 'already-serving', verdict: 'foreign', strandedPredecessor: 'indeterminate' });
        return lines.length === 2
          && lines[0]!.level === 'warn' && lines[0]!.message.includes('cosyncing doctor')
          && lines[1]!.message.includes('already running that cosyncing did not start');
      })());

    check('native output from another program never reaches an operator log line',
      (() => {
        const lines = spoken({
          action: 'start-failed', detailCode: 'host-spawn-failed',
          capturedOutput: 'stderr:\nTOKEN=super-secret\n',
        });
        return lines.length === 1 && lines[0]!.level === 'warn'
          && lines[0]!.message.includes('host-spawn-failed')
          && !lines[0]!.message.includes('super-secret');
      })());

    check('nothing attempted is nothing said',
      spoken({ action: 'not-applicable' }).length === 0
        && spoken({ action: 'not-authorized', variable: 'COSYNCING_FIXTURE_HOST' }).length === 0
        && spoken({ action: 'undescribed' }).length === 0);

    // The two starts differ in exactly one respect an operator can act on, and
    // the unproven one has to say so rather than reading as an ordinary success.
    check('an unproven start is not reported as an ordinary one',
      (() => {
        const proven = spoken({ action: 'started', pid: 4242, servingProven: true });
        const unproven = spoken({ action: 'started', pid: 4242, servingProven: false });
        return proven.length === 1 && unproven.length === 1
          && proven[0]!.message !== unproven[0]!.message
          && unproven[0]!.message.includes('could not confirm');
      })());

    check('an address decision that leaves a foreign host untouched is stated, and ours quietly is not',
      spoken({ action: 'already-serving', verdict: 'foreign' }).length === 1
        && spoken({ action: 'already-serving', verdict: 'owned' }).length === 0
        && spoken({ action: 'preserved-unlocatable' }).length === 1
        && spoken({ action: 'preserved-unready', pid: 4242, verdict: 'owned' }).length === 1);

    // EVERY posture that prevented a start is reported, not just the one that
    // happens to be ours. 'foreign' and 'indeterminate' used to return no line
    // at all here, so a broker that started nothing because something else was
    // sitting on the address looked exactly like a clean startup.
    check('an occupied-but-unready address reports every posture, and warns when it is not ours',
      (() => {
        const postures = (['owned', 'foreign', 'indeterminate'] as const).map(
          (verdict) => spoken({ action: 'preserved-unready', pid: 4242, verdict }));
        const messages = new Set(postures.map((lines) => lines[0]?.message));
        return postures.every((lines) => lines.length === 1)
          && messages.size === 3 // three distinct situations, three distinct sentences
          && postures[0]![0]!.level === 'info'
          && postures[1]![0]!.level === 'warn' && postures[2]![0]!.level === 'warn';
      })());

    // 'indeterminate' is not 'foreign'. Saying "cosyncing did not start this" of
    // a host we merely failed to identify is a claim we cannot support, and it
    // is the one that would talk an operator into killing their own process.
    check('a serving host we cannot identify is not described as somebody else\'s',
      (() => {
        const unknown = spoken({ action: 'already-serving', verdict: 'indeterminate' });
        return unknown.length === 1
          && !unknown[0]!.message.includes('did not start')
          && unknown[0]!.message.includes('could not determine');
      })());

    // The table is keyed by the ACTION LIST the engine exports, which cannot be
    // written without every union member. A new action therefore fails to
    // compile there, and then fails here until it is exercised — the two halves
    // of "no outcome reaches an operator as silence by accident".
    const REPORTED: Record<string, ManagedHostEnsureOutcome[]> = {
      'not-applicable': [{ action: 'not-applicable' }],
      'not-authorized': [{ action: 'not-authorized', variable: 'COSYNCING_FIXTURE_HOST_MANAGED_HOST' }],
      'undescribed': [{ action: 'undescribed' }],
      'already-serving': (['owned', 'foreign', 'indeterminate', 'absent'] as const)
        .map((verdict) => ({ action: 'already-serving', verdict })),
      'preserved-unready': (['owned', 'foreign', 'indeterminate', 'absent'] as const)
        .map((verdict) => ({ action: 'preserved-unready', pid: 4242, verdict })),
      'preserved-unlocatable': [{ action: 'preserved-unlocatable' }],
      'preserved-predecessor': [{ action: 'preserved-predecessor', verdict: 'indeterminate' }],
      'not-launchable': [{ action: 'not-launchable' }],
      'started': [
        { action: 'started', pid: 4242, servingProven: true },
        { action: 'started', pid: 4242, servingProven: false },
      ],
      'start-failed': [{ action: 'start-failed', detailCode: 'host-spawn-failed', capturedOutput: 'x' }],
    };
    check('every outcome the engine can return has a decided report',
      MANAGED_HOST_ACTIONS.every((action) => (REPORTED[action]?.length ?? 0) > 0),
      MANAGED_HOST_ACTIONS.filter((action) => !REPORTED[action]?.length).join(',') || 'all covered');

    // Silence is allowed, but only where it is the ANSWER: nothing was asked
    // for, nothing could be described, or the host we wanted is already ours and
    // serving. Everywhere else a start did not happen and must say so.
    const silentByDesign = new Set(['not-applicable', 'not-authorized', 'undescribed']);
    check('no outcome that prevented a start is silent',
      Object.entries(REPORTED).every(([action, samples]) => samples.every((sample) => {
        const lines = spoken(sample);
        if (silentByDesign.has(action)) return lines.length === 0;
        if (action === 'already-serving' && (sample as { verdict: string }).verdict === 'owned') {
          return lines.length === 0; // the goal, met
        }
        return lines.length === 1 && lines[0]!.message.includes(AGENT);
      })),
      Object.entries(REPORTED)
        .flatMap(([action, samples]) => samples.map((s) => `${action}:${spoken(s).length}`)).join(' '));

    // And the stranded fact rides along with ANY of them without displacing the
    // address answer — including the two that report nothing on their own.
    check('a stranded predecessor is reported on every outcome, including the silent ones',
      MANAGED_HOST_ACTIONS.every((action) => {
        const sample = REPORTED[action]![0]!;
        if (silentByDesign.has(action)) return true; // no start ran, so none could strand
        const lines = spoken({ ...sample, strandedPredecessor: 'indeterminate' } as ManagedHostEnsureOutcome);
        return lines.length >= 1 && lines[0]!.level === 'warn'
          && lines[0]!.message.includes('could not be stopped');
      }));
  }

  // ── release must not depend on the adapter still describing its host ───────
  {
    // Kimi returns null from `describeManagedHost` when its registry is
    // truncated or shows more than one live server — that is, when a SECOND
    // Kimi appears. Refusing to release there strands the process we can still
    // prove we started, at exactly the moment there is another one to confuse
    // it with.
    const table = new Map([[HOST_PID, OWNED]]);
    const { effects, signals } = fakeEffects({
      identities: table, missingProcess: PROCESS_ABSENT,
      onSignal: (pid, signal, live) => { if (signal === 'SIGTERM') live.delete(pid); },
    });
    const { store, records } = memoryStore();
    records.set(AGENT, ownership());
    const outcome = await releaseManagedHost(
      backend({ describeManagedHost: async () => null }) as never, effects, store);
    check('a host whose description went ambiguous is still released from its durable record',
      outcome.action === 'stopped' && signals.some((entry) => entry.pid === HOST_PID)
        && records.size === 0,
      JSON.stringify({ outcome, signals }));
  }
  {
    // No record and no description really is nothing to do.
    const { effects, signals } = fakeEffects({});
    const { store } = memoryStore();
    const outcome = await releaseManagedHost(
      backend({ describeManagedHost: async () => null }) as never, effects, store);
    check('no description and no record is still nothing to do, and signals nothing',
      outcome.action === 'undescribed' && signals.length === 0, JSON.stringify(outcome));
  }

  // ── what the shipped adapters actually describe ────────────────────────────
  //
  // The engine above is only as good as the descriptions fed to it, so these
  // assert the two real ones — with the machine injected, so a developer host
  // that happens to have (or lack) either binary cannot change the answer.
  {
    const { KimiAdapter } = await import('../../../adapters/kimi/src/index.ts');
    const { DshAdapter } = await import('../../../adapters/dsh/src/index.ts');
    const kimiHome = '/fixture/agent-root/.kimi-code';
    const kimiScan = (live: Array<Record<string, unknown>>, truncated = false) => ({
      live: live as never, stale: 0, invalid: 0, truncated,
    });
    const instance = {
      baseUrl: 'http://127.0.0.1:58627', port: 58627, pid: 7311, serverId: 'srv', startedAt: 1,
    };
    const kimi = (overrides: Record<string, unknown> = {}) => new KimiAdapter({
      env: { KIMI_CODE_HOME: kimiHome },
      homeDir: '/fixture/agent-root',
      instanceScan: () => kimiScan([instance]),
      resolveExecutable: (command) => (command === 'kimi' ? '/usr/bin/kimi' : undefined),
      ...overrides,
    });

    check('both adapters declare their host EXTERNAL, which is what makes the engine apply',
      kimi().integration?.externalHost?.managed === true
        && new DshAdapter().integration?.externalHost?.managed === true);

    const described = await kimi().describeManagedHost();
    check('kimi locates its host by the pid its own registry recorded, not by a port lookup',
      described?.locator.kind === 'pid' && described.locator.pid === 7311
        && described.identityKey === kimiHome
        && described.launch?.command === '/usr/bin/kimi'
        // `--no-open` matters: a broker starting a host must not open a browser.
        && described.launch.args.join(' ') === 'web --no-open',
      JSON.stringify(described));

    // Both refusals mirror the identity gate's: a registry that cannot prove
    // "one" or "none" describes nothing at all.
    check('a truncated kimi registry describes nothing',
      await kimi({ instanceScan: () => kimiScan([instance], true) }).describeManagedHost() === null);
    check('an ambiguous kimi registry (two live servers) describes nothing',
      await kimi({ instanceScan: () => kimiScan([instance, { ...instance, pid: 7312 }]) })
        .describeManagedHost() === null);

    const empty = await kimi({ instanceScan: () => kimiScan([]) }).describeManagedHost();
    check('with no live kimi server the registry ASSERTS absence, which is what lets one be started',
      empty?.locator.kind === 'absent', JSON.stringify(empty?.locator));
    // ...but only from a scan that finished. A truncated one proves nothing and
    // is already refused outright, so it can never reach that assertion.
    check('a truncated scan can never become an absence assertion',
      await kimi({ instanceScan: () => kimiScan([], true) }).describeManagedHost() === null);

    const noBinary = await kimi({ resolveExecutable: () => undefined }).describeManagedHost();
    check('with kimi not installed the host is described but not launchable',
      noBinary !== null && noBinary.launch === null && noBinary.locator.kind === 'pid',
      JSON.stringify(noBinary));
    // The installer's directory is off a service PATH, and an install that is
    // present but off PATH is still an install.
    const offPath = await kimi({
      resolveExecutable: (command: string) =>
        (command === '/fixture/agent-root/.kimi-code/bin/kimi' ? command : undefined),
    }).describeManagedHost();
    check('kimi installed off PATH at the official location is still launchable',
      offPath?.launch?.command === '/fixture/agent-root/.kimi-code/bin/kimi', JSON.stringify(offPath?.launch));

    const dsh = (overrides: Record<string, unknown> = {}) => new DshAdapter({
      env: {},
      baseUrl: 'http://127.0.0.1:3080',
      homeDir: '/fixture/agent-root',
      resolveExecutable: (command) => (command === 'dsh' ? '/usr/bin/dsh' : undefined),
      ...overrides,
    });
    const dshDescribed = await dsh().describeManagedHost();
    check('dsh locates its host by the configured loopback port',
      dshDescribed?.locator.kind === 'tcp-port' && dshDescribed.locator.port === 3080
        && dshDescribed.identityKey === 'http://127.0.0.1:3080'
        && dshDescribed.launch?.command === '/usr/bin/dsh'
        && dshDescribed.launch.args.join(' ') === 'web --port 3080',
      JSON.stringify(dshDescribed));
    // The launch must NAME the config root the adapter resolved, for the same
    // reason Kimi's does: the adapter's environment is not required to be the
    // broker's, and a child that inherited a different one would serve a
    // different profile than the adapter diagnosed and reported.
    check('the dsh launch names the config root and the poll-watcher it needs',
      dshDescribed?.launch?.env?.DSH_HOME === '/fixture/agent-root/.dsh'
        && dshDescribed.launch.env.CHOKIDAR_USEPOLLING === '1'
        && dshDescribed.launch.cwd === '/fixture/agent-root',
      JSON.stringify(dshDescribed?.launch));
    check('an explicit DSH_HOME is what the launch carries, not the derived default',
      (await dsh({ env: { DSH_HOME: '/custom/dsh-root' } }).describeManagedHost())
        ?.launch?.env?.DSH_HOME === '/custom/dsh-root',
      'explicit DSH_HOME');
    // No environment may produce a RELATIVE home: every profile path is built
    // from it, and a broker started as a service starts from `/`. Constructed
    // with an EMPTY environment and no injected homeDir, which is the shape
    // that used to fall through to `'.'`.
    const rootless = await new DshAdapter({
      env: {},
      baseUrl: 'http://127.0.0.1:3080',
      resolveExecutable: (command) => (command === 'dsh' ? '/usr/bin/dsh' : undefined),
    }).describeManagedHost();
    check('a dsh adapter with nothing in its environment still resolves an absolute home',
      typeof rootless?.launch?.cwd === 'string' && isAbsolute(rootless.launch.cwd)
        && typeof rootless.launch.env?.DSH_HOME === 'string'
        && isAbsolute(rootless.launch.env.DSH_HOME),
      JSON.stringify({ cwd: rootless?.launch?.cwd, home: rootless?.launch?.env?.DSH_HOME }));
    // The launch has to produce a host at the address the locator WATCHES, and
    // it now does that by NAMING the port rather than by being restricted to the
    // one address the flagless invocation happens to serve.
    //
    // `--port` is source-verified: `dsh --profile web --help` documents it, and
    // native Windows runs booted `dsh web --port N` and reached it. So a host
    // configured off the default is startable, which is what an operator who
    // moved dsh off 3080 — or whose 3080 is taken by something else — needs.
    const shifted = await dsh({ baseUrl: 'http://127.0.0.1:3999' }).describeManagedHost();
    check('a dsh host configured off the default port is launched AT that port',
      shifted?.locator.kind === 'tcp-port' && shifted.locator.port === 3999
        && shifted.launch?.args.join(' ') === 'web --port 3999',
      JSON.stringify(shifted));
    check('the default port is named too, so there is one launch shape rather than two',
      dshDescribed?.launch?.args.join(' ') === 'web --port 3080',
      JSON.stringify(dshDescribed?.launch?.args));
    check('localhost is launchable and resolves to the same watched port',
      (await dsh({ baseUrl: 'http://localhost:4123' }).describeManagedHost())
        ?.launch?.args.join(' ') === 'web --port 4123',
      'localhost');
    // `--host` is never passed, so only the forms dsh's own default bind already
    // resolves to may be launched. An invented `--host ::1` is exactly the kind
    // of unverified flag this descriptor refuses to emit.
    const sixLoopback = await dsh({ baseUrl: 'http://[::1]:3080' }).describeManagedHost();
    check('the IPv6 loopback form is watched but NEVER launched',
      sixLoopback?.locator.kind === 'tcp-port' && sixLoopback.launch === null,
      JSON.stringify(sixLoopback));
    const secure = await dsh({ baseUrl: 'https://127.0.0.1:3080' }).describeManagedHost();
    check('an https address is watched but NEVER launched, since dsh web serves http',
      secure?.launch === null, JSON.stringify(secure));
    check('the launchable dsh invocation pins its watch mode and its working directory',
      dshDescribed?.launch?.env?.CHOKIDAR_USEPOLLING === '1'
        && dshDescribed.launch.cwd === '/fixture/agent-root',
      JSON.stringify(dshDescribed?.launch));
    // A remote address is another machine's process: not startable, and not even
    // locatable, so no ownership opinion can form about it.
    const remote = await dsh({ baseUrl: 'http://dsh-host.invalid:3080' }).describeManagedHost();
    check('a dsh host on another machine is neither launched nor located',
      remote?.locator.kind === 'unknown' && remote.launch === null, JSON.stringify(remote));
    // npx-only installs: reported as unlaunchable rather than started via npx,
    // which would fetch and execute code from the network on broker startup.
    const npxOnly = await dsh({ resolveExecutable: () => undefined }).describeManagedHost();
    check('an npx-only dsh install is described and located, but never launched',
      npxOnly?.launch === null && npxOnly.locator.kind === 'tcp-port', JSON.stringify(npxOnly));
  }

  // ── the on-disk record is fail-closed ──────────────────────────────────────
  {
    const store = managedHostStore(home);
    store.write(ownership());
    const round = readManagedHostOwnership(AGENT, home);
    check('an ownership record round-trips through the owner-only store, evidence included',
      round?.pid === HOST_PID && round.start === OWNED.start && round.identityKey === KEY
        && round.evidence.executable === '/fixture/bin/host',
      JSON.stringify(round));
    store.clear(AGENT);
    check('clearing removes the record', readManagedHostOwnership(AGENT, home) === null);
  }
  {
    // Records written by the build that DID compare the command name stay valid.
    // The stored shape is unchanged, so nothing on disk needs migrating and no
    // operator has to delete anything to recover a host — which matters because
    // the records on a machine running the previous build are the only proof
    // that authorizes stopping the hosts already running there. Exercised in the
    // shape those records are actually in: a name that no longer matches.
    const store = managedHostStore(home);
    store.write(ownership({ comm: 'dsh' }));
    const existing = readManagedHostOwnership(AGENT, home);
    check('a record from the previous build needs no migration and still proves ownership',
      existing !== null && existing.schemaVersion === ownership().schemaVersion
        && classifyManagedHost(existing, running({ ...OWNED, comm: 'node' }), KEY) === 'owned',
      JSON.stringify(existing));
    store.clear(AGENT);
  }
  {
    // Corrupt state must read as "no proof", which preserves the live host. The
    // opposite default would authorize a kill from a damaged file.
    const cases: Array<[string, string]> = [
      ['not json at all', '{{{'],
      ['an unknown schema version', JSON.stringify({ ...ownership(), schemaVersion: 99 })],
      ['a record naming a different agent', JSON.stringify({ ...ownership(), agent: 'someone-else' })],
      ['a missing start token', JSON.stringify({ ...ownership(), start: '' })],
      ['an empty command name', JSON.stringify({ ...ownership(), comm: '' })],
      ['a missing boot identity', JSON.stringify({ ...ownership(), boot: undefined })],
      ['a non-integer pid', JSON.stringify({ ...ownership(), pid: 1.5 })],
      ['an empty identity key', JSON.stringify({ ...ownership(), identityKey: '' })],
      ['a previous schema version', JSON.stringify({ ...ownership(), schemaVersion: 1 })],
      ['evidence that is not an object', JSON.stringify({ ...ownership(), evidence: 'kimi web' })],
      ['evidence naming no executable', JSON.stringify({ ...ownership(), evidence: { args: [] } })],
    ];
    const leaked: string[] = [];
    for (const [label, body] of cases) {
      writeFileSync(managedHostOwnerPath(AGENT, home), body);
      if (readManagedHostOwnership(AGENT, home) !== null) leaked.push(label);
    }
    check('every damaged ownership record reads as NO proof, so the live host is preserved',
      leaked.length === 0, leaked.join(' | '));
    rmSync(managedHostOwnerPath(AGENT, home), { force: true });
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} managed-host ownership checks passed.`);
if (failed.length) process.exit(1);
