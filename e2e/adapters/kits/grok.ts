/**
 * Grok Build conformance kit: an ACP stdio agent whose Drive is limited to
 * sessions this broker created (durable app-created provenance), floor-gated
 * at Grok Build 1.0.13 with newer builds admitted.
 */
import { expect } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fixturePath, type FixturePaths } from '../../harness/index.ts';
import {
  grokAnswerUpdate,
  grokCompletedUpdate,
  grokSessionDir,
  grokSummary,
  grokUserUpdate,
  type FakeAcpConfig,
} from './fakes/acp-agent.ts';
import {
  type ConformanceExtra,
  installFakeExecutable,
  Ledger,
  treeSnapshot,
  uuidV7,
  type ConformanceKit,
  type ConformanceProfile,
  type FakeController,
  type SeededSession,
  type SeedOptions,
} from './kit.ts';

export const grokProfile: ConformanceProfile = {
  agent: 'grok',
  displayName: 'Grok Build',
  capabilities: {
    integrationKind: 'acp-stdio',
    attachModes: ['observe', 'resume'],
    supportsObserve: true,
    supportsResume: true,
    supportsLiveAttach: false,
    supportsCrossClientDriveSharing: true,
    supportsNativeArtifact: false,
    supportsNativeFileInput: false,
    supportsModelSwitch: true,
    permissionGranularity: 'per-tool',
  },
  driveFamily: 'broker-child',
  driveEligibility: 'app-created',
  version: {
    current: '1.0.13',
    below: '1.0.12',
    newer: '1.9.0',
    newerDrives: true,
    cachedByBroker: false,
    doctor: {
      current: { check: 'version', status: 'pass', detailCode: 'version-supported' },
      below: { check: 'version', status: 'warn', detailCode: 'version-below-measured-floor' },
      newer: { check: 'version', status: 'pass', detailCode: 'version-newer-than-measured' },
      missing: { check: 'binary', status: 'warn', detailCode: 'binary-missing' },
    },
  },
  catalog: {
    models: ['xai/grok-4.6', 'xai/grok-4.5'],
    modes: ['default'],
    commands: ['compact'],
    switchModel: { providerID: 'xai', modelID: 'grok-4.5' },
    createModel: { providerID: 'xai', modelID: 'grok-4.6', reasoningEffort: 'low' },
    createMode: 'default',
  },
  binaryOverrideEnv: 'COSYNCING_GROK_BIN',
  driveArgv: {
    required: ['agent', '--no-leader', 'stdio', '--permission-mode'],
    forbidden: ['--always-approve', '--yolo', '--dangerously-skip-permissions'],
    updaterGuard: true,
  },
  createChildAdopted: false,
  userRowDurable: 'turn-start',
  terminal: { resumeHint: "--resume '{id}'", syncAvailable: false },
  subagents: true,
  missingBinaryRoster: 'hidden',
  knownBugs: {
    C09: 'a Grok turn that completes before the broker tails updates.jsonl never sends the sender its '
      + 'queued:false row (only a fresh attach shows it reconciled)',
    C15: 'an atomic replacement of the log is noticed only at the next prompt: Bun 1.3.14 fs.watch on Linux '
      + 'names a rename-over by its temporary source file only, which the adapter watcher filters out',
  },
  scenarios: {
    C12: {
      refuse: 'Grok advertises no stop/abort action command, so the product offers no Stop: '
        + 'GrokDriveConnection.cancel() (ACP session/cancel) is unreachable from a client.',
    },
  },
  hostileStore: [
    {
      name: 'a session directory that is not a canonical UUIDv7',
      plant: (fake) => plantGrokSession(fake, { id: '019f9d70-e38e-4591-9a24-74a06ad89476' }),
    },
    {
      name: 'a symlinked session directory',
      unsupportedOn: ['win32'],
      plant: (fake) => {
        const real = plantGrokSession(fake, { id: uuidV7(), outside: true });
        return real;
      },
    },
    {
      name: 'a summary whose cwd disagrees with its directory',
      plant: (fake) => plantGrokSession(fake, { id: uuidV7(), summaryCwd: '/elsewhere' }),
    },
    {
      name: 'one id under two cwd groups',
      plant: (fake) => {
        const id = uuidV7();
        plantGrokSession(fake, { id });
        plantGrokSession(fake, { id });
        return id;
      },
    },
    {
      name: 'a symlinked summary.json',
      unsupportedOn: ['win32'],
      plant: (fake) => plantGrokSession(fake, { id: uuidV7(), symlinkSummary: true }),
    },
    {
      name: 'a subagent summary with no parent lineage',
      plant: (fake) => plantGrokSession(fake, { id: uuidV7(), kind: 'subagent' }),
    },
  ],
};

interface GrokFake extends FakeController {
  installRoot: string;
}

/** Write a Grok store entry directly, hostile or not. Returns its id. */
function plantGrokSession(
  fake: FakeController,
  options: { id: string; summaryCwd?: string; outside?: boolean; symlinkSummary?: boolean; kind?: string },
): string {
  const cwd = fake.workspace('hostile');
  const session = { id: options.id, cwd };
  const summary = `${JSON.stringify(grokSummary({ id: options.id, cwd: options.summaryCwd ?? cwd }, {
    session_summary: `hostile ${options.id}`,
    ...(options.kind ? { session_kind: options.kind } : {}),
  }))}\n`;
  const updates = `${JSON.stringify(grokUserUpdate(options.id, 'hostile-1', 'hostile row'))}\n`;
  const target = grokSessionDir(fake.storeRoot, session);
  if (options.outside) {
    // The real directory lives outside the store; the store holds a symlink to it.
    const elsewhere = join(fake.workspace('outside'), options.id);
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'summary.json'), summary);
    writeFileSync(join(elsewhere, 'updates.jsonl'), updates);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(elsewhere, target, 'dir');
    return options.id;
  }
  mkdirSync(target, { recursive: true });
  if (options.symlinkSummary) {
    const elsewhere = join(fake.workspace('outside'), 'summary.json');
    writeFileSync(elsewhere, summary);
    symlinkSync(elsewhere, join(target, 'summary.json'));
  } else {
    writeFileSync(join(target, 'summary.json'), summary);
  }
  writeFileSync(join(target, 'updates.jsonl'), updates);
  return options.id;
}

const grokExtras: ConformanceExtra[] = [
  {
    title: 'Create fails closed when the reusable cached-token login is gone',
    async run(context) {
      // Readiness is cached for 30 s inside the broker, so each catalog is
      // measured by a fresh broker on the same state.
      const catalogs: Array<[string, unknown]> = [
        ['no auth methods', []],
        ['interactive login only', [{ id: 'grok.com', name: 'Grok' }]],
        ['a malformed catalog', [{ name: 'no id' }]],
      ];
      try {
        for (const [label, authMethods] of catalogs) {
          context.fake.configure({ authMethods });
          await context.restart();
          context.fake.prepareCreate();
          const created = await context.client.post('/api/sessions/grok', { directory: context.fake.workspace('auth') });
          expect(created.status, label).toBe(503);
          expect(created.body.code, label).toBe('SESSION_CREATE_TEMPORARILY_UNAVAILABLE');
        }
      } finally {
        context.fake.configure({ authMethods: undefined });
        await context.restart();
      }
      await context.drivableSession('auth restored');
    },
  },
  {
    title: 'Create refuses a model or effort that session/load does not confirm',
    async run(context) {
      const requested = { providerID: 'xai', modelID: 'grok-4.6', reasoningEffort: 'low' };
      const unconfirmed: Array<[string, { model?: string; effort?: string }]> = [
        ['effort', { effort: 'high' }],
        ['model', { model: 'grok-4.5' }],
      ];
      try {
        for (const [label, loadReports] of unconfirmed) {
          context.fake.configure({ loadReports });
          const id = context.fake.prepareCreate();
          const created = await context.client.post('/api/sessions/grok', { directory: context.fake.workspace('unconfirmed'), model: requested });
          expect(created.status, label).not.toBe(200);
          expect(created.text, label).toContain('did not confirm');
          // The native session exists, but the app never owned it: it lists Observe-only.
          const row = await context.client.waitForSession((candidate) => candidate.id === id);
          expect(row.control?.drive?.supported, label).toBe(false);
        }
      } finally {
        context.fake.configure({ loadReports: undefined });
      }
    },
  },
  {
    title: 'the lazily created updates log is an append, not a foreign rewrite',
    async run(context) {
      const session = await context.drivableSession('lazy log');
      const log = join(grokSessionDir(context.fake.storeRoot, session), 'updates.jsonl');
      expect(existsSync(log)).toBe(false);
      const stream = await context.openDrive(session);
      expect((await context.prompt(stream, 'first line')).kind).toBe('ack');
      expect(existsSync(log)).toBe(true);
      expect((await context.prompt(stream, 'second line')).kind).toBe('ack');
      expect(context.prompted(session)).toEqual(['first line', 'second line']);
      expect(stream.frames.findLast((frame) => frame.kind === 'session')?.authority?.canMutate).toBe(true);
      stream.close();
    },
  },
];

export const grokKit: ConformanceKit = {
  profile: grokProfile,
  extras: grokExtras,
  env: (paths) => ({
    GROK_HOME: join(paths.root, 'grok-home'),
  }),
  install(paths: FixturePaths): GrokFake {
    const storeRoot = join(paths.root, 'grok-home');
    const installRoot = join(paths.root, 'fakes', 'grok');
    const controlDir = join(installRoot, 'control');
    mkdirSync(join(storeRoot, 'sessions'), { recursive: true });
    mkdirSync(controlDir, { recursive: true });
    const ledger = new Ledger(join(installRoot, 'ledger.jsonl'));
    const config: FakeAcpConfig = {
      flavor: 'grok',
      ledger: ledger.path,
      storeRoot,
      controlDir,
      version: grokProfile.version.current,
      nextSessionId: uuidV7(),
    };
    const fake = installFakeExecutable(paths.bin, 'grok', 'acp-agent.ts', config);
    let workspaces = 0;
    let doctorVariants = 0;
    const updatesPath = (session: { id: string; cwd: string }) =>
      join(grokSessionDir(storeRoot, session), 'updates.jsonl');
    const append = (session: { id: string; cwd: string }, record: unknown) =>
      appendFileSync(updatesPath(session), `${JSON.stringify(record)}\n`);
    const touchSummary = (session: { id: string; cwd: string }) => {
      const path = join(grokSessionDir(storeRoot, session), 'summary.json');
      const summary = JSON.parse(readFileSync(path, 'utf8'));
      summary.last_active_at = new Date().toISOString();
      writeFileSync(path, `${JSON.stringify(summary)}\n`);
    };

    const controller: GrokFake = {
      ledger,
      storeRoot,
      installRoot,
      workspace(name = 'workspace') {
        const directory = join(paths.root, 'workspaces', `${name}-${++workspaces}`);
        mkdirSync(directory, { recursive: true });
        return directory;
      },
      seedSession(options: SeedOptions = {}): SeededSession {
        const id = uuidV7();
        const cwd = options.childOf?.cwd ?? controller.workspace('seed');
        const title = options.title ?? `Grok seeded ${id.slice(-6)}`;
        const session = { id, cwd };
        const dir = grokSessionDir(storeRoot, session);
        mkdirSync(dir, { recursive: true });
        const texts: string[] = [];
        const lines: unknown[] = [];
        for (let turn = 1; turn <= (options.turns ?? 1); turn += 1) {
          const user = `seeded prompt ${turn}`;
          const answer = `seeded answer ${turn}`;
          texts.push(user, answer);
          lines.push(
            grokUserUpdate(id, `seed-${turn}`, user, `seed-prompt-${turn}`),
            grokAnswerUpdate(id, `seed-${turn}-answer`, answer, `seed-prompt-${turn}`),
            grokCompletedUpdate(id, `seed-${turn}-done`, `seed-prompt-${turn}`, 'end_turn'),
          );
        }
        writeFileSync(join(dir, 'updates.jsonl'), lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
        writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(grokSummary(session, {
          session_summary: title,
          num_messages: texts.length,
          ...(options.childOf ? { session_kind: 'subagent' } : {}),
        }))}\n`);
        writeFileSync(join(dir, 'signals.json'), `${JSON.stringify({ contextTokensUsed: 15, contextWindowTokens: 500_000 })}\n`);
        if (options.childOf) {
          const metaDir = join(grokSessionDir(storeRoot, options.childOf), 'subagents', id);
          mkdirSync(metaDir, { recursive: true });
          writeFileSync(join(metaDir, 'meta.json'), `${JSON.stringify({
            child_session_id: id,
            subagent_id: id,
            parent_session_id: options.childOf.id,
            child_cwd: cwd,
          })}\n`);
        }
        return { id, cwd, title, texts };
      },
      prepareCreate(id) {
        const next = { ...fake.readConfig<FakeAcpConfig>(), nextSessionId: id ?? uuidV7() };
        fake.writeConfig(next);
        return next.nextSessionId;
      },
      appendTurn(session, user, answer) {
        const tag = `ext-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        append(session, grokUserUpdate(session.id, `${tag}`, user, `${tag}-prompt`));
        append(session, grokAnswerUpdate(session.id, `${tag}-answer`, answer, `${tag}-prompt`));
        append(session, grokCompletedUpdate(session.id, `${tag}-done`, `${tag}-prompt`, 'end_turn'));
        touchSummary(session);
      },
      appendForeignUser(session, text) {
        append(session, grokUserUpdate(session.id, `foreign-${Date.now()}`, text, `foreign-prompt-${Date.now()}`));
      },
      appendPartial(session, text) {
        appendFileSync(updatesPath(session), JSON.stringify(grokUserUpdate(session.id, `partial-${Date.now()}`, text)));
      },
      completePartial(session) {
        appendFileSync(updatesPath(session), '\n');
      },
      rewriteHistory(session) {
        const path = updatesPath(session);
        const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
        const first = JSON.parse(lines[0]!);
        first.params.update.content.text = 'rewritten first prompt';
        lines[0] = JSON.stringify(first);
        writeFileSync(path, `${lines.join('\n')}\n`);
      },
      replaceLog(session) {
        const path = updatesPath(session);
        writeFileSync(`${path}.tmp`, readFileSync(path));
        renameSync(`${path}.tmp`, path);
      },
      watcherNoise(session) {
        const dir = grokSessionDir(storeRoot, session);
        writeFileSync(join(dir, 'signals.json'), `${JSON.stringify({ contextTokensUsed: 16, contextWindowTokens: 500_000 })}\n`);
        touchSummary(session);
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
        const directory = join(installRoot, `doctor-${++doctorVariants}`);
        mkdirSync(directory, { recursive: true });
        const base = fixturePath(join(paths.root, 'no-agents'));
        if (variant.missing) return { PATH: base, COSYNCING_GROK_BIN: '' };
        const installed = installFakeExecutable(directory, 'grok', 'acp-agent.ts', {
          ...fake.readConfig<FakeAcpConfig>(),
          version: variant.version ?? grokProfile.version.current,
        });
        return variant.override
          ? { PATH: base, COSYNCING_GROK_BIN: installed.path }
          : { PATH: [directory, base].join(delimiter), COSYNCING_GROK_BIN: '' };
      },
      storeSnapshot: () => treeSnapshot(storeRoot),
    };
    return controller;
  },
};
