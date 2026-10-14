/**
 * Reasonix conformance kit: an ACP stdio agent that drives any stored session
 * its own metadata reports idle, pinned to exactly Reasonix 1.25.2 (newer
 * builds stay Observe-only), with the version gate cached by the broker.
 */
import { expect } from 'bun:test';
import { appendFileSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fixturePath, type FixturePaths } from '../../harness/index.ts';
import {
  type FakeAcpConfig,
  readReasonixRows,
  reasonixAssistantRow,
  reasonixUserRow,
  type ReasonixRow,
  writeReasonixFiles,
} from './fakes/acp-agent.ts';
import {
  type ConformanceExtra,
  type ConformanceKit,
  type ConformanceProfile,
  type FakeController,
  installFakeExecutable,
  Ledger,
  type SeededSession,
  type SeedOptions,
  treeSnapshot,
} from './kit.ts';

const sessionId = (): string => `reasonix-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;

export const reasonixProfile: ConformanceProfile = {
  agent: 'reasonix',
  displayName: 'Reasonix',
  capabilities: {
    integrationKind: 'acp-stdio',
    attachModes: ['observe', 'resume'],
    supportsObserve: true,
    supportsResume: true,
    supportsLiveAttach: false,
    supportsCrossClientDriveSharing: true,
    supportsNativeArtifact: false,
    supportsNativeFileInput: false,
    supportsModelSwitch: false,
    permissionGranularity: 'per-tool',
  },
  driveFamily: 'broker-child',
  driveEligibility: 'stored-idle',
  version: {
    current: '1.25.2',
    below: '1.25.1',
    newer: '1.26.0',
    newerDrives: false,
    cachedByBroker: true,
    doctor: {
      current: { check: 'version', status: 'pass', detailCode: 'version-supported' },
      below: { check: 'version', status: 'fail', detailCode: 'version-unverified' },
      newer: { check: 'version', status: 'fail', detailCode: 'version-unverified' },
      missing: { check: 'binary', status: 'warn', detailCode: 'binary-missing' },
    },
  },
  catalog: {
    // Drive offers no model catalog: mid-session switching is unproved.
    models: [],
    modes: ['ask', 'auto', 'yolo'],
    commands: ['review', 'compact'],
    stopCommand: 'stop',
    createModel: { providerID: 'provider', modelID: 'model' },
    createMode: 'auto',
  },
  driveArgv: {
    required: ['acp', '--workspace-only'],
    forbidden: ['--yolo', '--auto-approve'],
  },
  createChildAdopted: true,
  userRowDurable: 'turn-end',
  knownBugs: {
    C15: 'an atomic replacement of the log is noticed only at the next prompt: Bun 1.3.14 fs.watch on Linux '
      + 'names a rename-over by its temporary source file only, which the adapter watcher filters out',
  },
  // No hint until `--resume` has an exact session-target form.
  terminal: { resumeHint: null, syncAvailable: false },
  subagents: false,
  missingBinaryRoster: 'hidden',
  scenarios: {
    C18: {
      refuse: 'supportsModelSwitch is false: the v1.25.2 probe did not prove session/load + set_config_option, '
        + 'so Drive offers no model catalog and refuses a per-prompt model.',
    },
  },
  hostileStore: [
    {
      name: 'a symlinked transcript',
      unsupportedOn: ['win32'],
      plant: (fake) => {
        const session = { id: sessionId(), cwd: fake.workspace('hostile') };
        const elsewhere = join(fake.workspace('outside'), 'store');
        writeReasonixFiles(elsewhere, session, [reasonixUserRow('hostile row')]);
        writeReasonixFiles(fake.storeRoot, session, [reasonixUserRow('hostile row')]);
        const transcript = join(fake.storeRoot, 'sessions', `${session.id}.jsonl`);
        renameSync(transcript, `${transcript}.moved`);
        symlinkSync(join(elsewhere, 'sessions', `${session.id}.jsonl`), transcript);
        return session.id;
      },
    },
    {
      name: 'an unknown metadata schema',
      plant: (fake) => plantWithEdit(fake, '.jsonl.meta', (meta) => ({ ...meta, schema_version: 3 })),
    },
    {
      name: 'metadata naming another id',
      plant: (fake) => plantWithEdit(fake, '.jsonl.meta', (meta) => ({ ...meta, id: 'someone-else' })),
    },
    {
      name: 'ACP metadata naming another id',
      plant: (fake) => plantWithEdit(fake, '.acp.json', (acp) => ({ ...acp, sessionId: 'someone-else' })),
    },
    {
      name: 'an unknown display index schema',
      plant: (fake) => plantWithEdit(fake, '.display-index.json', (index) => ({ ...index, schema_version: 9 })),
    },
    {
      name: 'one id in both the global and a project layout',
      plant: (fake) => {
        const session = { id: sessionId(), cwd: fake.workspace('hostile') };
        writeReasonixFiles(fake.storeRoot, session, [reasonixUserRow('global copy')]);
        writeReasonixFiles(join(fake.storeRoot, 'projects', 'duplicate'), session, [reasonixUserRow('project copy')]);
        return session.id;
      },
    },
    {
      name: 'a FIFO in place of the transcript',
      unsupportedOn: ['win32'],
      plant: (fake) => {
        const session = { id: sessionId(), cwd: fake.workspace('hostile') };
        writeReasonixFiles(fake.storeRoot, session, [reasonixUserRow('fifo row')]);
        const transcript = join(fake.storeRoot, 'sessions', `${session.id}.jsonl`);
        renameSync(transcript, `${transcript}.moved`);
        const made = Bun.spawnSync(['mkfifo', transcript], { timeout: 10_000, stdout: 'pipe', stderr: 'pipe' });
        if (made.exitCode !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
        return session.id;
      },
    },
  ],
};

function plantWithEdit(fake: FakeController, suffix: string, edit: (value: Record<string, any>) => Record<string, any>): string {
  const session = { id: sessionId(), cwd: fake.workspace('hostile') };
  writeReasonixFiles(fake.storeRoot, session, [reasonixUserRow('hostile row'), reasonixAssistantRow('hostile answer')]);
  const path = join(fake.storeRoot, 'sessions', `${session.id}${suffix}`);
  writeFileSync(path, `${JSON.stringify(edit(JSON.parse(readFileSync(path, 'utf8'))))}\n`);
  return session.id;
}

const reasonixExtras: ConformanceExtra[] = [
  {
    title: 'Resume is refused while the native status is not idle or unknown, with no writer started',
    async run(context) {
      for (const state of ['running', 'not-a-state']) {
        const session = { id: sessionId(), cwd: context.fake.workspace('busy') };
        writeReasonixFiles(context.fake.storeRoot, session, [reasonixUserRow('busy prompt'), reasonixAssistantRow('busy answer')], { state });
        const row = await context.client.waitForSession((candidate) => candidate.id === session.id);
        expect(row.control?.drive?.state, state).toBe('observing');
        const mark = context.fake.ledger.mark();
        const refused = await context.client.attach('reasonix', session.id, { mode: 'resume', reason: 'takeover' });
        await refused.waitForKind('attach-conflict');
        await refused.waitForKind('history');
        expect(refused.frames.findLast((frame) => frame.kind === 'session')?.authority?.canMutate, state).toBe(false);
        expect(context.childStarts(session, mark), state).toEqual([]);
        refused.close();
      }
    },
  },
];

export const reasonixKit: ConformanceKit = {
  profile: reasonixProfile,
  extras: reasonixExtras,
  env: (paths) => ({
    REASONIX_HOME: join(paths.root, 'reasonix-home'),
  }),
  install(paths: FixturePaths): FakeController {
    const storeRoot = join(paths.root, 'reasonix-home');
    const installRoot = join(paths.root, 'fakes', 'reasonix');
    const controlDir = join(installRoot, 'control');
    mkdirSync(join(storeRoot, 'sessions'), { recursive: true });
    mkdirSync(controlDir, { recursive: true });
    const ledger = new Ledger(join(installRoot, 'ledger.jsonl'));
    const config: FakeAcpConfig = {
      flavor: 'reasonix',
      ledger: ledger.path,
      storeRoot,
      controlDir,
      version: reasonixProfile.version.current,
      nextSessionId: sessionId(),
    };
    const fake = installFakeExecutable(paths.bin, 'reasonix', 'acp-agent.ts', config);
    const transcriptPath = (session: { id: string }) => join(storeRoot, 'sessions', `${session.id}.jsonl`);
    const rows = (session: { id: string }): ReasonixRow[] => readReasonixRows(storeRoot, session.id);
    let workspaces = 0;
    let doctorVariants = 0;
    let partial: ReasonixRow | undefined;

    const controller: FakeController = {
      ledger,
      storeRoot,
      workspace(name = 'workspace') {
        const directory = join(paths.root, 'workspaces', `${name}-${++workspaces}`);
        mkdirSync(directory, { recursive: true });
        return directory;
      },
      seedSession(options: SeedOptions = {}): SeededSession {
        if (options.childOf) throw new Error('Reasonix stores no subagent sessions');
        const session = { id: sessionId(), cwd: controller.workspace('seed') };
        const title = options.title ?? `Reasonix seeded ${session.id.slice(-6)}`;
        const texts: string[] = [];
        const seeded: ReasonixRow[] = [];
        for (let turn = 1; turn <= (options.turns ?? 1); turn += 1) {
          texts.push(`seeded prompt ${turn}`, `seeded answer ${turn}`);
          seeded.push(reasonixUserRow(`seeded prompt ${turn}`), reasonixAssistantRow(`seeded answer ${turn}`));
        }
        writeReasonixFiles(storeRoot, session, seeded, { title });
        return { ...session, title, texts };
      },
      prepareCreate(id) {
        const next = { ...fake.readConfig<FakeAcpConfig>(), nextSessionId: id ?? sessionId() };
        fake.writeConfig(next);
        return next.nextSessionId;
      },
      appendTurn(session, user, answer) {
        writeReasonixFiles(storeRoot, session, [...rows(session), reasonixUserRow(user), reasonixAssistantRow(answer)]);
      },
      appendForeignUser(session, text) {
        writeReasonixFiles(storeRoot, session, [...rows(session), reasonixUserRow(text)]);
      },
      appendPartial(session, text) {
        // The transcript gains an unterminated line; the sidecars have not caught up.
        partial = reasonixUserRow(text);
        appendFileSync(transcriptPath(session), JSON.stringify(partial));
      },
      completePartial(session) {
        const complete = readFileSync(transcriptPath(session), 'utf8').split('\n').slice(0, -1)
          .filter(Boolean).map((line) => JSON.parse(line) as ReasonixRow);
        writeReasonixFiles(storeRoot, session, [...complete, partial!]);
        partial = undefined;
      },
      rewriteHistory(session) {
        const current = rows(session);
        current[0] = { ...current[0]!, content: 'rewritten first prompt', raw_content: 'rewritten first prompt' };
        writeReasonixFiles(storeRoot, session, current);
      },
      replaceLog(session) {
        const path = transcriptPath(session);
        writeFileSync(`${path}.tmp`, readFileSync(path));
        renameSync(`${path}.tmp`, path);
      },
      watcherNoise(session) {
        const path = join(storeRoot, 'sessions', `${session.id}.event-index.json`);
        writeFileSync(path, readFileSync(path));
      },
      setVersion(version, output) {
        const next = { ...fake.readConfig<FakeAcpConfig>(), version };
        if (output === undefined) delete next.versionOutput;
        else next.versionOutput = output;
        fake.writeConfig(next);
      },
      setInstalled: (installed) => fake.setInstalled(installed),
      release(tag) {
        writeFileSync(join(controlDir, `release-${tag}`), '');
      },
      configure(patch) {
        const previous = fake.readConfig<Record<string, unknown>>();
        fake.writeConfig({ ...previous, ...patch });
        return previous;
      },
      doctorEnvironment(variant) {
        const base = fixturePath(join(paths.root, 'no-agents'));
        if (variant.missing) return { PATH: base };
        const directory = join(installRoot, `doctor-${++doctorVariants}`);
        installFakeExecutable(directory, 'reasonix', 'acp-agent.ts', {
          ...fake.readConfig<FakeAcpConfig>(),
          version: variant.version ?? reasonixProfile.version.current,
        });
        return { PATH: [directory, base].join(delimiter) };
      },
      storeSnapshot: () => treeSnapshot(storeRoot),
    };
    return controller;
  },
};
