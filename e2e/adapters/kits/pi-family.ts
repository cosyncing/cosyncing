/**
 * Pi-family conformance kit: Pi (`pi`) and oh-my-pi (`omp`), one engine and two dialects.
 *
 * Neither is an ACP agent. The native store is the runtime's own JSONL session file
 * (`<sessions root>/--<cwd slug>--/<stamp>_<uuid>.jsonl`), Observe tails that file, and Drive is a
 * broker-owned `pi --mode rpc --session <file>` child speaking the runtime's JSONL RPC. A third path,
 * the in-session bridge extension a terminal runtime loads, is not Drive and is covered by
 * `e2e/adapters/pi-bridge.test.ts`. Three things differ from the ACP kits and are carried here:
 *
 *  - **Identity.** A roster row id is the base64url of the session file's path; the native session
 *    is the header's uuid, which is also the file name's last segment. The ledger and
 *    `FakeController.nativeId` speak the uuid.
 *  - **The ledger vocabulary.** The fake records what it natively receives (RPC commands on stdin,
 *    its argv, aborts). {@link PiLedger} reads that in the conformance vocabulary the scenarios
 *    assert on: a prompt command is a `session/prompt`, a spawn on `--session <file>` is a
 *    `session/load`, a spawn on no session is a `session/new`, an abort that ends a running turn is
 *    a `session/cancel`, and an `extension_ui_response` is the reply to the fake's `permission-*`.
 *  - **The prompt ack.** The broker acks a prompt once the runtime's RPC `prompt` command answers,
 *    not when the turn ends; {@link FakeController.promptSettled} waits for the turn's end.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { CLIENT_REVISION_WITH_OMP_ROSTER_IDENTITY } from '../../../packages/typescript/protocol/src/index.ts';
import { eventually, fixturePath, type FixturePaths, type Frame, type SessionStream } from '../../harness/index.ts';
import {
  appendLines,
  type FakePiConfig,
  type FakePiModel,
  lastEntryId,
  OMP_FAKE_VERSION,
  PI_COLLAB_PROMPT_PREFIX,
  PI_FAKE_VERSION,
  type PiDialectName,
  piAssistantEntry,
  piHeader,
  piModelEntry,
  piSessionFilePath,
  piTitleEntry,
  piTurnEntries,
  piUserEntry,
} from './fakes/pi-agent.ts';
import {
  type ConformanceExtra,
  type ConformanceKit,
  type ConformanceProfile,
  type FakeController,
  installFakeExecutable,
  Ledger,
  type LedgerEntry,
  type SeededSession,
  type SeedOptions,
  treeSnapshot,
} from './kit.ts';

/** The roster row id of a session file: base64url of its path. */
export const piRowId = (file: string): string => Buffer.from(file, 'utf8').toString('base64url');
/** The session file a row id names. */
export const piFileOf = (rowId: string): string => Buffer.from(rowId, 'base64url').toString('utf8');
/** The native session uuid a session file names (its file name's last segment). */
export const piUuidOf = (file: string): string => basename(file).replace(/\.jsonl$/, '').split('_').pop() ?? file;

const MODELS: FakePiModel[] = [
  { provider: 'fake', id: 'pi-fake', name: 'Pi Fake' },
  { provider: 'fake', id: 'pi-reason', name: 'Pi Reason', reasoning: true },
];

export interface PiFamilyDialect {
  name: PiDialectName;
  displayName: string;
  version: { current: string; below: string; newer: string };
  /** Directory under the fixture root the broker's isolated environment points this dialect's sessions at. */
  sessionsDirectory: string;
  agentDirectory: string;
  binaryOverrideEnv: string;
}

export const PI_DIALECT_FACTS: PiFamilyDialect = {
  name: 'pi',
  displayName: 'Pi',
  version: { current: PI_FAKE_VERSION, below: '0.77.0', newer: '0.99.0' },
  sessionsDirectory: 'pi-sessions',
  agentDirectory: 'pi-agent',
  binaryOverrideEnv: 'COSYNCING_PI_BIN',
};

export const OMP_DIALECT_FACTS: PiFamilyDialect = {
  name: 'omp',
  displayName: 'omp',
  version: { current: OMP_FAKE_VERSION, below: '17.4.1', newer: '17.5.0' },
  sessionsDirectory: 'omp-sessions',
  agentDirectory: 'omp-agent',
  binaryOverrideEnv: 'COSYNCING_OMP_BIN',
};

// --------------------------------------------------------------------- ledger

/**
 * The fake's native ledger, read in the conformance vocabulary (see the file comment). Every
 * translated entry keeps the native one under `native`.
 */
export class PiLedger extends Ledger {
  override requests(method: string, from = 0): LedgerEntry[] {
    const entries = this.since(from);
    const as = (entry: LedgerEntry, frame: Record<string, any>): LedgerEntry => ({ ...entry, kind: 'recv', frame, native: entry });
    switch (method) {
      case 'session/prompt':
        return entries.filter((entry) => entry.kind === 'recv' && entry.frame?.type === 'prompt').map((entry) => as(entry, {
          method,
          params: {
            sessionId: piUuidOf(String(entry.session)),
            prompt: [{ type: 'text', text: promptText(String(entry.frame?.message ?? '')) }],
            // The model the runtime held when the prompt reached it (a switch is its own command, just before).
            model: entry.model,
          },
        }));
      case 'session/load':
      case 'session/new':
        return entries
          .filter((entry) => entry.kind === 'spawn' && (method === 'session/load' ? entry.session !== null : entry.session === null))
          .map((entry) => as(entry, {
            method,
            params: { sessionId: entry.session === null ? null : piUuidOf(String(entry.session)) },
          }));
      case 'session/cancel':
        return entries.filter((entry) => entry.kind === 'abort' && entry.midTurn === true).map((entry) => as(entry, { method }));
      default:
        return super.requests(method, from);
    }
  }

  override promptTexts(from = 0): string[] {
    return this.requests('session/prompt', from).map((entry) => String(entry.frame?.params?.prompt?.[0]?.text ?? ''));
  }

  override replies(idPrefix: string, from = 0): LedgerEntry[] {
    return this.since(from)
      .filter((entry) => entry.kind === 'recv' && entry.frame?.type === 'extension_ui_response'
        && String(entry.frame?.id ?? '').startsWith(idPrefix))
      .map((entry) => {
        const { type: _type, id, ...outcome } = entry.frame!;
        return { ...entry, frame: { id, result: { outcome } }, native: entry };
      });
  }

  /** Every stdin command of one native type. */
  commands(type: string, from = 0): LedgerEntry[] {
    return this.since(from).filter((entry) => entry.kind === 'recv' && entry.frame?.type === type);
  }
}

/** The prompt text an RPC `prompt` command carries (omp wraps a broker prompt in a correlated command). */
export function promptText(message: string): string {
  if (!message.startsWith(PI_COLLAB_PROMPT_PREFIX)) return message;
  try {
    return String(JSON.parse(Buffer.from(message.slice(PI_COLLAB_PROMPT_PREFIX.length), 'base64url').toString('utf8')).text ?? '');
  } catch {
    return message;
  }
}

// ----------------------------------------------------------------- the fake

export interface PiFake extends FakeController {
  readonly ledger: PiLedger;
  /** The installed command the product resolves. */
  readonly executable: string;
  readonly installRoot: string;
  readonly dialect: PiDialectName;
  readonly sessionsRoot: string;
  /** The session file a row id names. */
  fileOf(session: { id: string }): string;
  /** Append raw rows to a session's file (a terminal's own writes). */
  appendRaw(session: { id: string }, rows: Record<string, any>[]): void;
  /** Merge fields into the fake's re-read config (`failNextPrompt`, `cancelFork`, ...). */
  patchConfig(patch: Partial<FakePiConfig>): void;
}

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export function installPiFamily(dialect: PiFamilyDialect, paths: FixturePaths): PiFake {
  // The isolated fixture environment points the dialect's session store here.
  mkdirSync(join(paths.root, dialect.sessionsDirectory), { recursive: true });
  const sessionsRoot = realpathSync(join(paths.root, dialect.sessionsDirectory));
  const installRoot = join(paths.root, 'fakes', dialect.name);
  const controlDir = join(installRoot, 'control');
  mkdirSync(controlDir, { recursive: true });
  const ledger = new PiLedger(join(installRoot, 'ledger.jsonl'));
  const config: FakePiConfig = {
    ledger: ledger.path,
    controlDir,
    dialect: dialect.name,
    version: dialect.version.current,
    models: MODELS,
    commands: ['review'],
  };
  const fake = installFakeExecutable(paths.bin, dialect.name, 'pi-agent.ts', config);
  let workspaces = 0;
  let doctorVariants = 0;
  const fileOf = (session: { id: string }) => piFileOf(session.id);
  const modelOf = { provider: MODELS[0]!.provider, id: MODELS[0]!.id };
  const chain = (file: string, rows: Record<string, any>[]): void => {
    for (const row of rows) appendLines(file, [{ ...row, parentId: row.type === 'session' || row.type === 'title' ? undefined : lastEntryId(file) }]);
  };
  const writeSession = (file: string, id: string, cwd: string, title: string, turns: Array<[string, string]>, at: number): void => {
    appendLines(file, piHeader(dialect.name, id, cwd, at, title));
    chain(file, [piModelEntry(dialect.name, null, modelOf, at), piTitleEntry(dialect.name, null, title, at)]);
    turns.forEach(([user, answer], index) => {
      chain(file, piTurnEntries(null, user, answer, at + 1_000 + index * 2_000, modelOf));
    });
  };

  const controller: PiFake = {
    ledger,
    executable: fake.path,
    storeRoot: sessionsRoot,
    installRoot,
    dialect: dialect.name,
    sessionsRoot,
    fileOf,
    workspace(name = 'workspace') {
      const directory = join(paths.root, 'workspaces', `${name}-${++workspaces}`);
      mkdirSync(directory, { recursive: true });
      return realpathSync(directory);
    },
    nativeId: (sessionId) => piUuidOf(piFileOf(sessionId)),
    seedSession(options: SeedOptions = {}): SeededSession {
      const uuid = crypto.randomUUID();
      const at = Date.now() - 120_000;
      const title = options.title ?? `${dialect.displayName} seeded ${uuid.slice(-6)}`;
      if (options.childOf) {
        const parentFile = fileOf(options.childOf);
        const file = join(parentFile.replace(/\.jsonl$/, ''), `${new Date(at).toISOString().replace(/[:.]/g, '-')}_${uuid}.jsonl`);
        writeSession(file, uuid, options.childOf.cwd, title, [[`child prompt ${title}`, `child answer ${title}`]], at);
        return { id: piRowId(file), nativeId: undefined, cwd: options.childOf.cwd, title, texts: [`child prompt ${title}`, `child answer ${title}`], storeKey: uuid };
      }
      const cwd = controller.workspace('seed');
      const file = piSessionFilePath(sessionsRoot, cwd, uuid, at);
      const turns: Array<[string, string]> = [];
      for (let turn = 1; turn <= (options.turns ?? 1); turn += 1) turns.push([`seeded prompt ${turn}`, `seeded answer ${turn}`]);
      writeSession(file, uuid, cwd, title, turns, at);
      return { id: piRowId(file), cwd, title, texts: turns.flat(), rosterNativeId: uuid, storeKey: uuid };
    },
    prepareCreate(id) {
      const current = fake.readConfig<FakePiConfig>();
      if (id) {
        const file = piFileOf(id);
        fake.writeConfig({ ...current, next: { file, id: piUuidOf(file) } });
        return id;
      }
      const uuid = crypto.randomUUID();
      // The runtime names the file from the cwd it starts in; a create's cwd is only known to the broker.
      const file = join(sessionsRoot, '--e2e-create--', `${new Date().toISOString().replace(/[:.]/g, '-')}_${uuid}.jsonl`);
      fake.writeConfig({ ...current, next: { file, id: uuid } });
      return piRowId(file);
    },
    appendTurn(session, user, answer) {
      const file = fileOf(session);
      const entries = piTurnEntries(lastEntryId(file), user, answer, Date.now(), modelOf);
      chain(file, entries);
    },
    appendForeignUser(session, text) {
      const file = fileOf(session);
      appendLines(file, [piUserEntry(lastEntryId(file), text, Date.now())]);
    },
    appendPartial(session, text) {
      const file = fileOf(session);
      appendFileSync(file, JSON.stringify(piUserEntry(lastEntryId(file), text, Date.now())));
    },
    completePartial(session) {
      appendFileSync(fileOf(session), '\n');
    },
    rewriteHistory(session) {
      const file = fileOf(session);
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const first = lines.findIndex((line) => {
        const entry = JSON.parse(line);
        return entry.type === 'message' && entry.message?.role === 'user';
      });
      const entry = JSON.parse(lines[first]!);
      entry.message.content = [{ type: 'text', text: 'rewritten first prompt' }];
      lines[first] = JSON.stringify(entry);
      writeFileSync(file, `${lines.join('\n')}\n`);
    },
    replaceLog(session) {
      const file = fileOf(session);
      writeFileSync(`${file}.tmp`, readFileSync(file));
      renameSync(`${file}.tmp`, file);
    },
    watcherNoise(session) {
      // An extension's own entries and a bare touch: never conversation rows.
      const file = fileOf(session);
      appendLines(file, [{ type: 'custom', id: crypto.randomUUID().slice(0, 8), parentId: lastEntryId(file), timestamp: new Date().toISOString(), customType: 'noise', data: {} }]);
      const now = new Date();
      utimesSync(file, now, now);
    },
    setVersion(version, output) {
      const next = { ...fake.readConfig<FakePiConfig>(), version };
      if (output === undefined) delete next.versionOutput;
      else next.versionOutput = output;
      fake.writeConfig(next);
    },
    setInstalled: (installed) => fake.setInstalled(installed),
    appendRaw(session, rows) {
      appendLines(fileOf(session), rows);
    },
    patchConfig(patch) {
      fake.writeConfig({ ...fake.readConfig<FakePiConfig>(), ...patch });
    },
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
      if (variant.missing) return { PATH: base, [dialect.binaryOverrideEnv]: '' };
      const installed = installFakeExecutable(directory, dialect.name, 'pi-agent.ts', {
        ...fake.readConfig<FakePiConfig>(),
        version: variant.version ?? dialect.version.current,
      });
      return variant.override
        ? { PATH: base, [dialect.binaryOverrideEnv]: installed.path }
        : { PATH: [directory, base].join(delimiter), [dialect.binaryOverrideEnv]: '' };
    },
    storeSnapshot: () => treeSnapshot(sessionsRoot),
    promptSettled(stream: SessionStream, text: string) {
      const mark = ledger.mark();
      const from = stream.frames.length;
      return async () => {
        // The runtime finished the turn the prompt started (or Stop ended it), …
        await eventually(() => ledger.since(mark).some((entry) => entry.kind === 'turn-end' && entry.text === text),
          { what: `the fake ${dialect.name} to settle the turn "${text}"` });
        // …and the client holds that turn's end.
        await stream.waitForFrame((frame: Frame) => frame.kind === 'message' && frame.message?.type === 'run-summary'
          && ['done', 'cancelled', 'error'].includes(frame.message.status), { after: from, what: `the end of the turn "${text}"` });
      };
    },
  };
  void existsSync;
  void symlinkSync;
  void dirname;
  void piAssistantEntry;
  return controller;
}

// -------------------------------------------------------------------- profile

export function piFamilyProfile(dialect: PiFamilyDialect): ConformanceProfile {
  const omp = dialect.name === 'omp';
  return {
    agent: dialect.name,
    displayName: dialect.displayName,
    capabilities: {
      integrationKind: 'jsonrpc-stdio',
      attachModes: ['observe', 'resume', 'live'],
      supportsObserve: true,
      supportsResume: true,
      supportsLiveAttach: true,
      supportsCrossClientDriveSharing: true,
      supportsNativeArtifact: false,
      supportsNativeFileInput: true,
      supportsModelSwitch: true,
      permissionGranularity: 'per-tool',
    },
    ...(omp ? { minimumClientRevision: CLIENT_REVISION_WITH_OMP_ROSTER_IDENTITY } : {}),
    driveFamily: 'broker-child',
    driveEligibility: 'stored-idle',
    version: {
      ...dialect.version,
      newerDrives: !omp,
      cachedByBroker: true,
      doctor: {
        current: { check: 'version', status: 'pass', detailCode: 'version-supported' },
        below: { check: 'version', status: 'fail', detailCode: 'version-below-minimum' },
        newer: { check: 'version', status: 'pass', detailCode: 'version-supported' },
        missing: { check: 'binary', status: 'warn', detailCode: 'binary-missing' },
      },
    },
    catalog: {
      models: MODELS.map((model) => `${model.provider}/${model.id}`),
      modes: [],
      commands: ['review', 'compact'],
      stopCommand: 'stop',
      switchModel: { providerID: 'fake', modelID: 'pi-reason' },
      unknownCommandsForwarded: true,
      createModel: { providerID: 'fake', modelID: 'pi-reason', reasoningEffort: 'high' },
    },
    binaryOverrideEnv: dialect.binaryOverrideEnv,
    driveArgv: { required: ['--mode', 'rpc', '--session'], forbidden: [] },
    createChildAdopted: false,
    userRowDurable: 'turn-start',
    // Upstream Pi keeps no app-send token in its session file; omp persists the sender's key on the entry.
    historyClientKey: omp,
    midTurnPrompt: 'steered',
    modelSwitch: 'per-turn',
    terminal: {
      resumeHint: (session) => `--session ${quote(piFileOf(session.id))}`,
      syncAvailable: true,
    },
    subagents: true,
    missingBinaryRoster: 'observe-only',
    permission: { approveReply: { confirmed: true }, answerMentions: 'permission allow' },
    knownBugs: {
      ...(omp ? {} : {
        'C09.replayKey': 'a fresh Observe reader keys the delivered Pi prompt by its session entry id, not by the key '
          + 'the sender held live (only the Drive connection\'s history takes the echo key)',
      }),
      C07: 'Create trusts the session file get_state answers: one naming a session already in the store is accepted '
        + 'and the existing file gets a model_change entry appended',
      C11: 'a forged request id and a second decision on a settled card are both acked (respondPermission ignores '
        + 'ids it does not hold)',
      C14: 'Pi Drive never reads the session file back, so a user row another process appends is not noticed: the '
        + 'joined sockets stay driving and the next prompt is still delivered to the runtime',
      'C15.detect': 'Pi Drive never notices a replaced or rewritten session file, so the next prompt is still '
        + 'delivered to the runtime',
    },
    scenarios: {},
    hostileStore: [],
  };
}

export function piFamilyKit(dialect: PiFamilyDialect, extras: ConformanceExtra[] = []): ConformanceKit {
  return {
    profile: piFamilyProfile(dialect),
    extras,
    env: () => ({}),
    install: (paths) => installPiFamily(dialect, paths),
  };
}
