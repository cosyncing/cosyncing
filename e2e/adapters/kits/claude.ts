/**
 * Claude Code conformance kit.
 *
 * Claude is not an ACP agent. Its store is the CLI's own append-only JSONL transcript
 * (`$CLAUDE_CONFIG_DIR/projects/<cwd slug>/<uuid>.jsonl`), Observe tails that file, and Drive is a
 * broker-owned `claude -p --resume <uuid>` child speaking stream-json, started lazily by the first
 * prompt. Three things differ from the ACP kits, and each is carried here rather than in the
 * scenarios:
 *
 *  - **Identity.** A Claude roster row id is the base64url of its transcript path (the attach id
 *    the roster publishes); the native session is the uuid. A parent with subagent children
 *    publishes `claude-session:<uuid>` as its `nativeId`, which is also its children's
 *    `parentThreadId`.
 *  - **The ledger vocabulary.** The fake records what it natively receives (stream-json frames on
 *    stdin, its argv, signals). {@link ClaudeLedger} reads that in the conformance vocabulary the
 *    scenarios assert on: a turn the CLI started is a `session/prompt`, a `--resume <uuid>` launch is
 *    a `session/load` of that session, a `--session-id <uuid>` launch is a `session/new`, an
 *    interrupt or a signal that ends a running turn is a `session/cancel`, and a `control_response` is the reply to the
 *    fake's `permission-*` / `question-*` request (its `result.outcome` is the native decision).
 *  - **The prompt ack.** The broker acks a Claude prompt once it is written to the child's stdin,
 *    not when the turn ends; {@link FakeController.promptSettled} waits for the turn's end.
 */
import { expect } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, join, relative, sep } from 'node:path';
import { eventually, fixturePath, type FixturePaths, type Frame, type SessionStream } from '../../harness/index.ts';
import {
  appendRows,
  CLAUDE_FAKE_VERSION,
  claudeAssistantRow,
  claudeQueueOperation,
  claudeSlug,
  claudeToolResultRow,
  claudeTranscriptPath,
  claudeUserRow,
  type FakeClaudeConfig,
  lastThreadUuid,
  type TranscriptContext,
} from './fakes/claude-agent.ts';
import {
  type ConformanceContext,
  type ConformanceExtra,
  type ConformanceKit,
  type ConformanceProfile,
  type FakeController,
  installFakeExecutable,
  Ledger,
  makeFifo,
  type LedgerEntry,
  type SeededSession,
  type SeedOptions,
  treeSnapshot,
} from './kit.ts';

/** The roster row id of a transcript: base64url of its path. */
export const claudeRowId = (transcriptPath: string): string => Buffer.from(transcriptPath, 'utf8').toString('base64url');
/** The transcript path a row id names. */
export const claudePathOf = (rowId: string): string => Buffer.from(rowId, 'base64url').toString('utf8');
/** The native session uuid a row id names. */
export const claudeUuidOf = (rowId: string): string => basename(claudePathOf(rowId)).replace(/\.jsonl$/, '');

const MOD_LIVE = process.platform !== 'win32';

export const claudeProfile: ConformanceProfile = {
  agent: 'claude',
  displayName: 'Claude Code',
  capabilities: {
    integrationKind: 'sdk-callback',
    // `live` (mod true-sync) is advertised while the broker serves its mod socket, which it does
    // on every platform but Windows.
    attachModes: MOD_LIVE ? ['live', 'observe', 'resume'] : ['observe', 'resume'],
    supportsObserve: true,
    supportsResume: true,
    supportsLiveAttach: MOD_LIVE,
    supportsNativeArtifact: true,
    supportsNativeFileInput: true,
    supportsModelSwitch: true,
    permissionGranularity: 'per-session',
    supportsCrossClientDriveSharing: true,
  },
  driveFamily: 'broker-child',
  driveEligibility: 'stored-idle',
  version: {
    current: CLAUDE_FAKE_VERSION,
    below: '2.1.206',
    newer: '2.9.0',
    newerDrives: true,
    cachedByBroker: false,
    doctor: {
      current: { check: 'version', status: 'pass', detailCode: 'version-supported' },
      below: { check: 'version', status: 'fail', detailCode: 'version-below-minimum' },
      newer: { check: 'version', status: 'pass', detailCode: 'version-supported' },
      missing: { check: 'binary', status: 'warn', detailCode: 'binary-missing' },
    },
  },
  catalog: {
    models: ['anthropic/opus', 'anthropic/sonnet', 'anthropic/haiku', 'anthropic/fable'],
    modes: ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'],
    commands: ['review', 'compact'],
    stopCommand: 'stop',
    switchModel: { providerID: 'anthropic', modelID: 'sonnet' },
    switchModelResolvesTo: 'claude-sonnet-4-6',
    unknownCommandsForwarded: true,
  },
  binaryOverrideEnv: 'COSYNCING_CLAUDE_BIN',
  driveArgv: {
    required: ['-p', '--resume', '--input-format', 'stream-json', '--output-format', '--permission-prompt-tool', 'stdio'],
    forbidden: ['--bare', '--fork-session', '--dangerously-skip-permissions'],
  },
  createChildAdopted: true,
  userRowDurable: 'turn-start',
  // `claude --resume` is cwd-scoped, so the hint leads with `cd <workspace> &&`.
  terminal: { resumeHint: (session) => `&& claude --resume ${claudeUuidOf(session.id)}`, syncAvailable: false },
  subagents: true,
  missingBinaryRoster: 'observe-only',
  idleSendQueued: false,
  permission: {
    approveReply: { behavior: 'allow', updatedInput: { command: 'true', description: 'Run fixture command' } },
    answerMentions: '(permission allow)',
  },
  knownBugs: {
    'C09.clientKey': 'Claude Drive never stamps the sender\'s clientMessageId as clientKey, on its pending row or on '
      + 'the transcript echo (the app falls back to exact-text reconcile)',
    'C09.replayKey': 'a fresh reader (a reload) keys the delivered Claude prompt by its transcript uuid, not by the '
      + 'key the sender held live',
    'C20.mode': 'the app-selected Claude permission mode is lost when the Drive connection is rebuilt (broker '
      + 'restart): the roster row has no currentMode and the next child launches without --permission-mode',
    'C13.clientKey': 'the joined socket replays the owner\'s pending row without its clientKey (same defect as C09)',
    C16: 'nothing gates Claude Create or Take over on the CLI version: doctor fails a build below 2.1.207 '
      + '(version-below-minimum), and the product still creates and drives it',
    C17: 'stored Claude rows keep offering Drive (drive.supported) while the claude binary is missing; the '
      + 'takeover then fails at the first prompt',
    'C06.live': 'an in-place rewrite of a Claude transcript is never seen by an open Observe tail (it reads on '
      + 'from its byte offset), so the client keeps the replaced rows until it re-attaches',
    'C15.detect': 'Claude Drive never notices a replaced or rewritten transcript (its echo tail only reads '
      + 'appended bytes), so the next prompt is still delivered to the child',
  },
  scenarios: {
    C07: {
      skip: 'Claude create allocates its session id in the broker and writes nothing until the first prompt: there '
        + 'is no native create to answer an id. Covered by the extra "create is deferred until the first prompt".',
    },
  },
  hostileStore: [
    {
      name: 'a transcript that is a symlink to a file outside the store',
      unsupportedOn: ['win32'],
      plant: (fake) => plantClaude(fake as ClaudeFake, { link: 'file' }),
    },
    {
      name: 'a project directory that is a symlink to a directory outside the store',
      unsupportedOn: ['win32'],
      plant: (fake) => plantClaude(fake as ClaudeFake, { link: 'project' }),
    },
    {
      name: 'a dangling symlink named like a transcript',
      unsupportedOn: ['win32'],
      plant: (fake) => plantClaude(fake as ClaudeFake, { link: 'dangling' }),
    },
    {
      name: 'an id that climbs out of the projects root through ..',
      plant: (fake) => plantClaude(fake as ClaudeFake, { climb: true }),
    },
    {
      name: 'a FIFO named like a transcript',
      unsupportedOn: ['win32'],
      plant: (fake) => plantClaude(fake as ClaudeFake, { fifo: true }),
    },
    {
      name: 'a subagent transcript that is a symlink to a file outside the store',
      unsupportedOn: ['win32'],
      plant: (fake) => plantClaudeChild(fake as ClaudeFake, { link: true }),
    },
    {
      // Discovery reads a child's `.meta.json` before its transcript, so both are pipes.
      name: 'a subagent whose transcript and metadata are FIFOs',
      unsupportedOn: ['win32'],
      plant: (fake) => plantClaudeChild(fake as ClaudeFake, { fifo: true }),
    },
  ],
};

/** A hostile parent transcript entry. Returns the row id that must stay unpublished. */
function plantClaude(fake: ClaudeFake, options: { link?: 'file' | 'project' | 'dangling'; fifo?: boolean; climb?: boolean }): string {
  const uuid = crypto.randomUUID();
  const cwd = fake.workspace('hostile');
  const context: TranscriptContext = { sessionId: uuid, cwd, entrypoint: 'cli' };
  const rows = [claudeUserRow(context, null, 'hostile row'), { type: 'custom-title', customTitle: `hostile ${uuid}`, sessionId: uuid }];
  const path = claudeTranscriptPath(fake.storeRoot, cwd, uuid);
  if (options.fifo) {
    makeFifo(path);
    return claudeRowId(path);
  }
  if (options.link === 'dangling') {
    mkdirSync(join(path, '..'), { recursive: true });
    symlinkSync(join(fake.workspace('gone'), `${uuid}.jsonl`), path);
    return claudeRowId(path);
  }
  const outside = join(fake.workspace('outside'), 'project');
  mkdirSync(outside, { recursive: true });
  appendRows(join(outside, `${uuid}.jsonl`), rows);
  if (options.climb) {
    // Spelled from inside the projects root, so only resolving `..` shows where it lands.
    const projects = join(fake.storeRoot, 'projects');
    return claudeRowId(`${projects}${sep}..${sep}${relative(fake.storeRoot, join(outside, `${uuid}.jsonl`))}`);
  }
  if (options.link === 'file') {
    mkdirSync(join(path, '..'), { recursive: true });
    symlinkSync(join(outside, `${uuid}.jsonl`), path);
  } else {
    symlinkSync(outside, join(path, '..'), 'dir');
  }
  return claudeRowId(path);
}

/** A hostile subagent entry under a fresh parent. Returns the row id that must stay unpublished. */
function plantClaudeChild(
  fake: ClaudeFake,
  options: { meta?: Record<string, unknown>; rawMeta?: string; nested?: boolean; link?: boolean; fifo?: boolean },
): string {
  const parent = fake.seedSession({ title: 'hostile parent' });
  const agent = `agent-${crypto.randomUUID().replaceAll('-', '').slice(0, 17)}`;
  const subagents = join(fake.transcriptOf(parent).replace(/\.jsonl$/, ''), 'subagents');
  const dir = options.nested ? join(subagents, 'workflows', `wf-${crypto.randomUUID().slice(0, 8)}`) : subagents;
  mkdirSync(dir, { recursive: true });
  if (options.fifo) {
    makeFifo(join(dir, `${agent}.meta.json`));
    makeFifo(join(dir, `${agent}.jsonl`));
    return claudeRowId(join(dir, `${agent}.jsonl`));
  }
  writeFileSync(join(dir, `${agent}.meta.json`), options.rawMeta ?? JSON.stringify(options.meta ?? { agentType: 'general-purpose', description: 'hostile child', toolUseId: 'toolu_hostile' }));
  const context: TranscriptContext = { sessionId: claudeUuidOf(parent.id), cwd: parent.cwd, entrypoint: 'cli' };
  const rows = [{ ...claudeUserRow(context, null, 'hostile child prompt'), isSidechain: true }];
  const path = join(dir, `${agent}.jsonl`);
  if (options.link) {
    const outside = join(fake.workspace('outside'), `${agent}.jsonl`);
    appendRows(outside, rows);
    symlinkSync(outside, path);
  } else {
    appendRows(path, rows);
  }
  return claudeRowId(path);
}

// --------------------------------------------------------------------- ledger

/**
 * The fake's native ledger, read in the conformance vocabulary (see the file comment). Every
 * translated entry keeps the native one under `native`.
 */
export class ClaudeLedger extends Ledger {
  override requests(method: string, from = 0): LedgerEntry[] {
    const entries = this.since(from);
    const as = (entry: LedgerEntry, frame: Record<string, any>): LedgerEntry => ({ ...entry, kind: 'recv', frame, native: entry });
    switch (method) {
      case 'session/prompt':
        return entries.filter((entry) => entry.kind === 'turn').map((entry) => as(entry, {
          method,
          params: { sessionId: claudeRowId(String(entry.transcript)), prompt: [{ type: 'text', text: String(entry.text) }] },
        }));
      case 'session/load':
      case 'session/new': {
        const flag = method === 'session/load' ? '--resume' : '--session-id';
        return entries.filter((entry) => entry.kind === 'spawn' && entry.argv?.includes(flag)).map((entry) => as(entry, {
          method,
          params: { sessionId: claudeRowId(String(entry.transcript)) },
        }));
      }
      case 'session/cancel':
        return entries.filter((entry) => (entry.kind === 'interrupt' || entry.kind === 'signal') && entry.midTurn === true)
          .map((entry) => as(entry, { method }));
      default:
        return super.requests(method, from);
    }
  }

  override promptTexts(from = 0): string[] {
    return this.requests('session/prompt', from).map((entry) => String(entry.frame?.params?.prompt?.[0]?.text ?? ''));
  }

  override replies(idPrefix: string, from = 0): LedgerEntry[] {
    return this.since(from)
      .filter((entry) => entry.kind === 'recv' && entry.frame?.type === 'control_response'
        && String(entry.frame?.response?.request_id ?? '').startsWith(idPrefix))
      .map((entry) => ({
        ...entry,
        frame: { id: entry.frame!.response.request_id, result: { outcome: entry.frame!.response.response } },
        native: entry,
      }));
  }

  /** Every stdin frame of one native type. */
  stdin(type: string, from = 0): LedgerEntry[] {
    return this.since(from).filter((entry) => entry.kind === 'recv' && entry.frame?.type === type);
  }
}

// ----------------------------------------------------------------- the fake

export interface ClaudeFake extends FakeController {
  readonly ledger: ClaudeLedger;
  readonly installRoot: string;
  /** The transcript a row id names. */
  transcriptOf(session: { id: string }): string;
  /** Set what `claude agents --json` reports. */
  setAgents(agents: FakeClaudeConfig['agents']): void;
  /** Append raw rows to a session's transcript (a terminal's own writes). */
  appendRaw(session: { id: string }, rows: Record<string, any>[]): void;
  /** The context the transcript writers need for a session. */
  contextOf(session: { id: string; cwd: string }, entrypoint?: 'cli' | 'sdk-cli'): TranscriptContext;
}

const turnAnswers = (texts: string[]): string[] => texts;

function install(paths: FixturePaths): ClaudeFake {
  // The isolated fixture environment points CLAUDE_CONFIG_DIR here.
  const storeRoot = join(paths.root, 'claude');
  const installRoot = join(paths.root, 'fakes', 'claude');
  const controlDir = join(installRoot, 'control');
  mkdirSync(join(storeRoot, 'projects'), { recursive: true });
  mkdirSync(controlDir, { recursive: true });
  const ledger = new ClaudeLedger(join(installRoot, 'ledger.jsonl'));
  const config: FakeClaudeConfig = {
    ledger: ledger.path,
    controlDir,
    version: CLAUDE_FAKE_VERSION,
    agents: [],
  };
  const fake = installFakeExecutable(paths.bin, 'claude', 'claude-agent.ts', config);
  let workspaces = 0;
  let doctorVariants = 0;
  const transcriptOf = (session: { id: string }) => claudePathOf(session.id);
  const contextOf = (session: { id: string; cwd: string }, entrypoint: 'cli' | 'sdk-cli' = 'cli'): TranscriptContext =>
    ({ sessionId: claudeUuidOf(session.id), cwd: session.cwd, entrypoint });
  const appendTurnRows = (session: { id: string; cwd: string }, user: string, answer: string): void => {
    const path = transcriptOf(session);
    const context = contextOf(session);
    const userRow = claudeUserRow(context, lastThreadUuid(path), user);
    const answerRow = claudeAssistantRow(context, userRow.uuid, `msg_seed_${crypto.randomUUID().slice(0, 8)}`, { type: 'text', text: answer });
    appendRows(path, [userRow, answerRow]);
  };

  const controller: ClaudeFake = {
    ledger,
    storeRoot,
    installRoot,
    transcriptOf,
    contextOf,
    workspace(name = 'workspace') {
      const directory = join(paths.root, 'workspaces', `${name}-${++workspaces}`);
      mkdirSync(directory, { recursive: true });
      return directory;
    },
    seedSession(options: SeedOptions = {}): SeededSession {
      const uuid = crypto.randomUUID();
      if (options.childOf) return seedChild(controller, options.childOf, uuid, options.title);
      const cwd = controller.workspace('seed');
      const title = options.title ?? `Claude seeded ${uuid.slice(-6)}`;
      const path = claudeTranscriptPath(storeRoot, cwd, uuid);
      const id = claudeRowId(path);
      const context: TranscriptContext = { sessionId: uuid, cwd, entrypoint: 'cli' };
      const texts: string[] = [];
      const rows: Record<string, any>[] = [{ type: 'permission-mode', permissionMode: 'default', sessionId: uuid }];
      let parent: string | null = null;
      for (let turn = 1; turn <= (options.turns ?? 1); turn += 1) {
        const user = `seeded prompt ${turn}`;
        const answer = `seeded answer ${turn}`;
        texts.push(user, answer);
        const userRow = claudeUserRow(context, parent, user);
        const answerRow = claudeAssistantRow(context, userRow.uuid, `msg_seed_${turn}_${uuid.slice(0, 8)}`, { type: 'text', text: answer });
        rows.push(userRow, answerRow);
        parent = answerRow.uuid;
      }
      rows.push({ type: 'custom-title', customTitle: title, sessionId: uuid });
      appendRows(path, rows);
      return { id, cwd, title, texts: turnAnswers(texts), rosterNativeId: `claude-session:${uuid}`, storeKey: uuid };
    },
    prepareCreate() {
      // Claude's create allocates its uuid in the broker; there is no native create to script.
      return '';
    },
    appendTurn: appendTurnRows,
    appendForeignUser(session, text) {
      const path = transcriptOf(session);
      appendRows(path, [claudeUserRow(contextOf(session), lastThreadUuid(path), text)]);
    },
    appendPartial(session, text) {
      const path = transcriptOf(session);
      appendFileSync(path, JSON.stringify(claudeUserRow(contextOf(session), lastThreadUuid(path), text)));
    },
    completePartial(session) {
      appendFileSync(transcriptOf(session), '\n');
    },
    rewriteHistory(session) {
      const path = transcriptOf(session);
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      const first = lines.findIndex((line) => JSON.parse(line).type === 'user');
      const row = JSON.parse(lines[first]!);
      row.message.content = 'rewritten first prompt';
      lines[first] = JSON.stringify(row);
      writeFileSync(path, `${lines.join('\n')}\n`);
    },
    replaceLog(session) {
      const path = transcriptOf(session);
      writeFileSync(`${path}.tmp`, readFileSync(path));
      renameSync(`${path}.tmp`, path);
    },
    watcherNoise(session) {
      // Sidecar rows Claude interleaves with the conversation: never transcript rows.
      const uuid = claudeUuidOf(session.id);
      appendRows(transcriptOf(session), [
        { type: 'file-history-snapshot', messageId: crypto.randomUUID(), snapshot: { messageId: crypto.randomUUID(), trackedFileBackups: {}, timestamp: new Date().toISOString() }, isSnapshotUpdate: false },
        { type: 'atis-latch', atis: '', sessionId: uuid },
      ]);
    },
    setVersion(version, output) {
      const next = { ...fake.readConfig<FakeClaudeConfig>(), version };
      if (output === undefined) delete next.versionOutput;
      else next.versionOutput = output;
      fake.writeConfig(next);
    },
    setInstalled: (installed) => fake.setInstalled(installed),
    setAgents(agents) {
      fake.writeConfig({ ...fake.readConfig<FakeClaudeConfig>(), agents });
    },
    appendRaw(session, rows) {
      appendRows(transcriptOf(session), rows);
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
      if (variant.missing) return { PATH: base, COSYNCING_CLAUDE_BIN: '' };
      const installed = installFakeExecutable(directory, 'claude', 'claude-agent.ts', {
        ...fake.readConfig<FakeClaudeConfig>(),
        version: variant.version ?? claudeProfile.version.current,
      });
      return variant.override
        ? { PATH: base, COSYNCING_CLAUDE_BIN: installed.path }
        : { PATH: [directory, base].join(delimiter), COSYNCING_CLAUDE_BIN: '' };
    },
    storeSnapshot: () => treeSnapshot(storeRoot),
    promptSettled(stream: SessionStream, text: string) {
      const mark = ledger.mark();
      const from = stream.frames.length;
      return async () => {
        // The CLI finished the turn, or the process running it is gone (Stop, demotion, a crash).
        await eventually(() => {
          const since = ledger.since(mark);
          if (since.some((entry) => entry.kind === 'turn-end' && entry.text === text)) return true;
          const ran = new Set(since.filter((entry) => (entry.kind === 'turn' && entry.text === text)
            || (entry.kind === 'recv' && entry.frame?.type === 'user' && JSON.stringify(entry.frame).includes(JSON.stringify(text).slice(1, -1))))
            .map((entry) => entry.pid));
          return since.some((entry) => (entry.kind === 'exit' || entry.kind === 'signal') && ran.has(entry.pid));
        }, { what: `the fake claude to settle the turn "${text}"` });
        // …and the client holds that turn's end.
        await stream.waitForFrame((frame: Frame) => frame.kind === 'message' && frame.message?.type === 'run-summary'
          && ['done', 'cancelled', 'error'].includes(frame.message.status), { after: from, what: `the end of the turn "${text}"` });
      };
    },
  };
  return controller;
}

/** A parent-spawned subagent child of `parent`: a meta sidecar naming its Agent tool_use, and its own transcript. */
function seedChild(fake: ClaudeFake, parent: SeededSession, uuid: string, title?: string): SeededSession {
  const parentPath = fake.transcriptOf(parent);
  const agent = `agent-${uuid.replaceAll('-', '').slice(0, 17)}`;
  const dir = join(parentPath.replace(/\.jsonl$/, ''), 'subagents');
  mkdirSync(dir, { recursive: true });
  const toolUseId = `toolu_seed_${uuid.slice(0, 8)}`;
  const description = title ?? `Subagent ${uuid.slice(-6)}`;
  writeFileSync(join(dir, `${agent}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description, toolUseId }));
  const path = join(dir, `${agent}.jsonl`);
  const context: TranscriptContext = { sessionId: claudeUuidOf(parent.id), cwd: parent.cwd, entrypoint: 'cli' };
  const user: any = { ...claudeUserRow(context, null, `child prompt ${description}`), isSidechain: true, agentId: agent.slice(6) };
  const answer: any = { ...claudeAssistantRow(context, user.uuid, `msg_child_${uuid.slice(0, 8)}`, { type: 'text', text: `child answer ${description}` }), isSidechain: true, agentId: agent.slice(6) };
  appendRows(path, [user, answer]);
  return { id: claudeRowId(path), cwd: parent.cwd, title: description, texts: [user.message.content, `child answer ${description}`], storeKey: agent };
}

// -------------------------------------------------------------------- extras

/** A parent transcript's Agent tool_use row, and its child's meta + transcript. Returns what the roster and activity read. */
function spawnSubagent(fake: ClaudeFake, parent: SeededSession, label: string, options: { background?: boolean; forkedSkill?: boolean } = {}) {
  const uuid = crypto.randomUUID();
  const agentId = uuid.replaceAll('-', '').slice(0, 17);
  const toolUseId = `toolu_${label}_${uuid.slice(0, 8)}`;
  const path = fake.transcriptOf(parent);
  const context = fake.contextOf(parent);
  const call = claudeAssistantRow(context, lastThreadUuid(path), `msg_agent_${uuid.slice(0, 8)}`, {
    type: 'tool_use', id: toolUseId, name: options.forkedSkill ? 'Skill' : 'Agent',
    input: options.forkedSkill ? { skill: 'code-review', args: '109' }
      : { description: label, subagent_type: 'general-purpose', prompt: `do ${label}`, ...(options.background ? { run_in_background: true } : {}) },
  }, { stopReason: 'tool_use' });
  appendRows(path, [call]);
  const dir = join(path.replace(/\.jsonl$/, ''), 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: label,
    ...(options.forkedSkill ? { name: 'code-review', spawnDepth: 1, requestShape: 'background', requestNonInteractive: true } : { toolUseId }) }));
  if (options.forkedSkill) {
    writeFileSync(join(dir, `agent-${agentId}.forked-skill.json`), JSON.stringify({ skillName: 'code-review', attributionName: 'code-review' }));
    writeFileSync(join(dir, `agent-${agentId}.forked-skill.marker.json`), JSON.stringify({ forkedSkill: true, skillName: 'code-review' }));
  }
  const childContext: TranscriptContext = { sessionId: context.sessionId, cwd: parent.cwd, entrypoint: 'cli' };
  const user: any = { ...claudeUserRow(childContext, null, `child prompt ${label}`), isSidechain: true, agentId };
  appendRows(join(dir, `agent-${agentId}.jsonl`), [user]);
  if (options.forkedSkill) {
    appendRows(path, [{ ...claudeToolResultRow(context, call.uuid, toolUseId,
      'Skill "code-review" launched (forked execution, running in the background).\n\nRunning in the background as @code-review'),
      toolUseResult: { success: true, commandName: 'code-review', status: 'forked', background: true, agentId, result: 'Running in the background as @code-review' } }]);
  } else if (options.background) {
    appendRows(path, [claudeToolResultRow(context, call.uuid, toolUseId, `Async agent launched successfully.\nagentId: ${agentId} (internal ID)`)]);
  }
  return { agentId, toolUseId, call, childPath: join(dir, `agent-${agentId}.jsonl`) };
}

/** The `<task-notification>` a finished background agent leaves, on one of the three carriers a transcript holds it on. */
function taskNotification(fake: ClaudeFake, session: SeededSession, spawn: { agentId: string; toolUseId: string }, carrier: 'user' | 'queue-operation' | 'attachment'): void {
  const payload = `<task-notification>\n<task-id>${spawn.agentId}</task-id>\n<tool-use-id>${spawn.toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>`;
  const context = fake.contextOf(session);
  const path = fake.transcriptOf(session);
  if (carrier === 'queue-operation') fake.appendRaw(session, [claudeQueueOperation(context.sessionId, 'enqueue', payload)]);
  else if (carrier === 'attachment') {
    fake.appendRaw(session, [{ type: 'attachment', uuid: crypto.randomUUID(), parentUuid: lastThreadUuid(path), timestamp: new Date().toISOString(), sessionId: context.sessionId,
      attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: payload } }]);
  } else {
    fake.appendRaw(session, [claudeUserRow(context, lastThreadUuid(path), payload, { extra: { origin: { kind: 'task-notification' } } })]);
  }
}

const claudeExtras: ConformanceExtra[] = [
  {
    title: 'session naming uses the first real headless prompt and retains native names beyond the tail',
    async run({ fake: controller, client, broker }) {
      const fake = controller as ClaudeFake;
      const session = fake.seedSession({ title: '', turns: 0 });
      const path = fake.transcriptOf(session);
      const context = { ...fake.contextOf(session), entrypoint: 'sdk-cli' as const };
      fake.appendRaw(session, [
        claudeUserRow(context, null, 'This session is being continued from a previous conversation summary', { extra: { isCompactSummary: true } }),
        claudeUserRow(context, null, '# AGENTS.md instructions for fixture'),
        claudeUserRow(context, null, '  First 🧪 prompt\nwith whitespace  '),
        { type: 'last-prompt', lastPrompt: 'The latest prompt' },
      ]);
      await client.waitForSession((row) => row.id === session.id && row.title === 'First 🧪 prompt with whitespace');
      const stream = await client.attach('claude', session.id, { mode: 'observe' });
      await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info?.title === 'First 🧪 prompt with whitespace');
      await stream.waitForFrame((frame) => frame.kind === 'history');
      fake.appendTurn(session, 'A later headless prompt', 'naming follow-up observed');
      await stream.waitForFrame((frame) => frame.kind === 'message'
        && String(frame.message?.text ?? frame.message?.delta ?? '').includes('naming follow-up observed'));
      expect((await client.sessions({ refresh: true })).find((candidate) => candidate.id === session.id)?.title)
        .toBe('First 🧪 prompt with whitespace');
      fake.appendRaw(session, [{ type: 'ai-title', aiTitle: 'Native AI / 名称.md' }]);
      await client.waitForSession((row) => row.id === session.id && row.title === 'Native AI / 名称.md');
      fake.appendRaw(session, [
        ...Array.from({ length: 65 }, () => ({ type: 'progress', data: 'x'.repeat(320 * 1024) })),
        { type: 'last-prompt', lastPrompt: 'Another follow-up' },
        { type: 'ai-title', aiTitle: 'Native AI / 名称.md' },
      ]);
      await client.waitForSession((row) => row.id === session.id && row.title === 'Native AI / 名称.md');
      await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info?.title === 'Native AI / 名称.md');
      stream.close();
      const custom = '😀'.repeat(180);
      fake.appendRaw(session, [{ type: 'custom-title', customTitle: custom }]);
      await broker.restart();
      const cold = (await client.sessions({ refresh: true, window: 'all' })).find((candidate) => candidate.id === session.id)!;
      expect(cold.title).toBe('😀'.repeat(160));
      await client.waitForSession((row) => row.id === session.id && !row.titlePending && row.title === '😀'.repeat(160));
      // Replacing the transcript invalidates retained title facts, including an old native name.
      writeFileSync(`${path}.replacement`, readFileSync(path, 'utf8').split('\n')
        .filter((line) => !line.includes('ai-title') && !line.includes('custom-title')).join('\n'));
      renameSync(`${path}.replacement`, path);
      await client.waitForSession((row) => row.id === session.id && row.title === 'First 🧪 prompt with whitespace');
      stream.close();
      const growing = fake.seedSession({ title: '', turns: 1 });
      fake.appendRaw(growing, Array.from({ length: 230 }, () => ({ type: 'progress', data: 'x'.repeat(320 * 1024) })));
      await broker.restart();
      const pending = (await client.sessions({ refresh: true, window: 'all' })).find((row) => row.id === growing.id)!;
      expect(pending.titlePending).toBe(true);
      const settled = await eventually(async () => {
        fake.appendRaw(growing, [{ type: 'progress', data: 'keeps growing' }]);
        const row = (await client.sessions({ refresh: true, window: 'all' })).find((candidate) => candidate.id === growing.id);
        return row && !row.titlePending ? row : undefined;
      }, { what: 'a growing Claude transcript to finish its forward title backlog' });
      expect(settled.title).toBe('seeded prompt 1');
      for (const largeText of [false, true]) {
        const imageSession = fake.seedSession({ title: '', turns: 0 });
        const imageContext = fake.contextOf(imageSession);
        const text = largeText ? '🧪'.repeat(180) : 'First image 🧪 prompt';
        const prompt = claudeUserRow(imageContext, null, text);
        prompt.message.content = largeText ? `${text}${'x'.repeat(2 * 1024 * 1024)}` : [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(2 * 1024 * 1024) } },
          { type: 'text', text },
        ];
        fake.appendRaw(imageSession, [prompt,
          claudeUserRow(imageContext, prompt.uuid, 'A later prompt must not become the title'),
        ]);
        const expected = largeText ? '🧪'.repeat(160) : text;
        await client.waitForSession((row) => row.id === imageSession.id && !row.titlePending && row.title === expected);
      }
    },
  },
  {
    title: 'a stray API credential in the broker environment never reaches a Drive child',
    async run(context) {
      const fake = context.fake as ClaudeFake;
      const mark = fake.ledger.mark();
      const session = await context.drivableSession('credential scrub');
      const stream = await context.openDrive(session);
      expect((await context.prompt(stream, 'which credentials')).kind).toBe('ack');
      stream.close();
      const spawns = fake.ledger.since(mark).filter((entry) => entry.kind === 'spawn' && entry.argv?.includes('--resume'));
      expect(spawns.length).toBeGreaterThan(0);
      for (const spawn of spawns) {
        expect((spawn as any).env.ANTHROPIC_API_KEY).toBeNull();
        expect((spawn as any).env.ANTHROPIC_AUTH_TOKEN).toBeNull();
        // The child runs against the isolated store, never the developer's own.
        expect((spawn as any).env.CLAUDE_CONFIG_DIR).toBe(fake.storeRoot);
      }
    },
  },
  {
    title: 'a Drive question is one question card, answered through the control channel',
    async run(context) {
      const fake = context.fake as ClaudeFake;
      const session = await context.drivableSession('question');
      const owner = await context.openDrive(session);
      const mark = fake.ledger.mark();
      const turn = context.prompt(owner, '[[question]] ask me');
      const card = await owner.waitForMessage((message: any) => message.type === 'question-request');
      expect(card.readOnly).not.toBe(true);
      expect(card.questions[0].question).toBe('Which path?');
      expect(card.questions[0].options.map((option: any) => option.label)).toEqual(['Left', 'Right']);
      // A question is never also a permission card.
      expect(owner.messages().some((message: any) => message.type === 'permission-request')).toBe(false);
      const answered = await owner.sendAndAwait({ kind: 'answer', requestId: card.requestId, answers: [['Right']] });
      expect(answered.kind).toBe('ack');
      await owner.waitForMessage((message: any) => message.type === 'question-resolved' && message.requestId === card.requestId);
      // A second answer to the settled card (a slower seat) is refused, and nothing reaches Claude.
      expect((await owner.sendAndAwait({ kind: 'answer', requestId: card.requestId, answers: [['Left']] })).kind).toBe('nack');
      expect((await turn).kind).toBe('ack');
      // The agent received the answer in the control reply, and answered with it.
      await eventually(() => fake.ledger.replies('question-', mark).length === 1, { what: 'the control reply to the question' });
      expect(fake.ledger.replies('question-', mark)[0]!.frame?.result?.outcome).toMatchObject({
        behavior: 'allow', updatedInput: { answers: { 'Which path?': 'Right' } },
      });
      await owner.waitForMessage((message: any) => message.type === 'model-output' && rowText(message).includes('answered Right'));
      owner.close();
    },
  },
  {
    title: 'subagents and forked skills appear, settle and replay in both roster and activity',
    async run(context) {
      const fake = context.fake as ClaudeFake;
      const parent = fake.seedSession({ title: 'subagent lifecycle' });
      fake.setAgents([{ sessionId: claudeUuidOf(parent.id), status: 'busy' }]);
      const streams: SessionStream[] = [];
      try {
        mkdirSync(join(fake.transcriptOf(parent).replace(/\.jsonl$/, ''), 'subagents'), { recursive: true });
        const observer = await context.client.attach('claude', parent.id);
        streams.push(observer);
        await observer.waitForKind('history');
        const ctx = fake.contextOf(parent);
        fake.appendRaw(parent, [claudeUserRow(ctx, lastThreadUuid(fake.transcriptOf(parent)), 'Launch the reviews in parallel.')]);
        // One live parent and one heartbeat serve every lifecycle. Separate
        // parents made each completion pay another watcher interval in CI.
        const metadata = spawnSubagent(fake, parent, '/code-review metadata', { forkedSkill: true });
        const notified = spawnSubagent(fake, parent, '/code-review notification', { forkedSkill: true });
        const stopped = spawnSubagent(fake, parent, '/code-review stop', { forkedSkill: true });
        rmSync(metadata.childPath.replace(/\.jsonl$/, '.forked-skill.json'));
        rmSync(notified.childPath.replace(/\.jsonl$/, '.forked-skill.marker.json'));
        const queued = spawnSubagent(fake, parent, 'queued background', { background: true });
        const attached = spawnSubagent(fake, parent, 'attached background', { background: true });
        const forks = [metadata, notified, stopped];
        const backgrounds = [...forks, queued, attached];
        const keyOf = (spawn: typeof metadata) => `agent:${forks.includes(spawn) ? `agent-${spawn.agentId}` : spawn.toolUseId}`;
        const latest = (stream: SessionStream, key: string) => stream.messages().filter((m: any) => m.type === 'agent-activity' && m.key === key).at(-1);
        const parkedAt = Date.now();
        fake.appendRaw(parent, [claudeAssistantRow(ctx, lastThreadUuid(fake.transcriptOf(parent)), 'reviews-launched', { type: 'text', text: 'Reviews are running.' }, { at: parkedAt, stopReason: 'end_turn' })]);
        await observer.waitForFrame((frame) => frame.kind === 'session' && frame.info?.status === 'idle' && frame.info?.updatedAt === parkedAt);
        await eventually(() => backgrounds.every((spawn) => latest(observer, keyOf(spawn))?.status === 'running'), { what: 'background agents still running after the parent returns to Idle' });
        let roster: any[] = [];
        await eventually(async () => {
          roster = await context.client.sessions({ refresh: true });
          return roster.find((row) => row.id === parent.id)?.status === 'idle' &&
            backgrounds.every((spawn) => roster.some((row) => row.id === claudeRowId(spawn.childPath) && row.status === 'working'));
        }, { what: 'working background children beneath an idle parent in the roster' });
        fake.appendRaw(parent, [claudeUserRow(ctx, lastThreadUuid(fake.transcriptOf(parent)), 'Wait for the reviews and summarize.')]);
        const foreground = spawnSubagent(fake, parent, 'sweep the repo');
        const spawns = [...forks, queued, attached, foreground];
        const excluded = ['workflow-subagent', 'general-purpose'].map((agentType) => {
          const path = join(dirname(metadata.childPath), `agent-excluded-${agentType}.jsonl`);
          writeFileSync(path, readFileSync(metadata.childPath));
          writeFileSync(path.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType, requestShape: 'background' }));
          return claudeRowId(path);
        });
        await eventually(() => spawns.every((spawn) => latest(observer, keyOf(spawn))?.status === 'running'), { what: 'all standalone subagent cards running' });
        await eventually(async () => {
          roster = await context.client.sessions({ refresh: true });
          return spawns.every((spawn) => roster.some((row) => row.id === claudeRowId(spawn.childPath) && row.status === 'working'));
        }, { what: 'every spawned child in the working roster' });
        const parentRow = roster.find((row) => row.id === parent.id)!;
        expect(roster.some((row) => excluded.includes(row.id))).toBe(false);
        expect(new Set(observer.messages().filter((m: any) => m.type === 'agent-activity').map((m: any) => m.key))).toEqual(new Set(spawns.map(keyOf)));
        expect(latest(observer, keyOf(foreground)).title).toBe('sweep the repo');
        for (const spawn of spawns) {
          const child = roster.find((row) => row.id === claudeRowId(spawn.childPath))!;
          expect(child).toMatchObject({ origin: 'subagent', parentThreadId: parentRow.nativeId });
          expect(child.title).toBe(latest(observer, keyOf(spawn)).title);
          expect(child.control?.drive?.supported).toBe(false);
          expect(latest(observer, keyOf(spawn))).toMatchObject({ kind: 'subagent', agentsTotal: 1 });
          expect(observer.messages().some((m: any) => m.type === 'agent-activity' && m.key === keyOf(spawn) && m.status === 'done')).toBe(false);
        }
        const children = await Promise.all(forks.map(async (spawn) => {
          const stream = await context.client.attach('claude', claudeRowId(spawn.childPath));
          streams.push(stream);
          expect((await stream.waitForKind('session')).info).toMatchObject({
            origin: 'subagent', status: 'working', parentThreadId: parentRow.nativeId,
            title: latest(observer, keyOf(spawn)).title,
          });
          return stream;
        }));
        fake.appendRaw(parent, [claudeToolResultRow(ctx, foreground.call.uuid, foreground.toolUseId, 'the sweep is done')]);
        taskNotification(fake, parent, queued, 'queue-operation');
        taskNotification(fake, parent, attached, 'attachment');
        taskNotification(fake, parent, notified, 'queue-operation');
        const metaPath = metadata.childPath.replace(/\.jsonl$/, '.meta.json');
        writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(readFileSync(metaPath, 'utf8')), finished: true }));
        const stopId = `stop_${stopped.agentId}`;
        const stop = claudeAssistantRow(ctx, lastThreadUuid(fake.transcriptOf(parent)), stopId, {
          type: 'tool_use', id: stopId, name: 'TaskStop', input: { task_id: stopped.agentId },
        }, { stopReason: 'tool_use' });
        fake.appendRaw(parent, [stop, claudeToolResultRow(ctx, stop.uuid, stopId, 'Stopped.')]);
        const completedAt = Date.now();
        fake.appendRaw(parent, [claudeAssistantRow(ctx, lastThreadUuid(fake.transcriptOf(parent)), 'all-agents-done', { type: 'text', text: 'All reviews finished.' }, { at: completedAt, stopReason: 'end_turn' })]);
        await eventually(() => spawns.every((spawn) => latest(observer, keyOf(spawn))?.status === 'done'), { what: 'every subagent activity settled' });
        await Promise.all(children.map((stream) => stream.waitForMessage((m: any) => m.type === 'status' && m.status === 'idle')));
        await observer.waitForFrame((frame) => frame.kind === 'session' && frame.info?.status === 'idle' && frame.info?.updatedAt === completedAt);
        await eventually(async () => {
          roster = await context.client.sessions({ refresh: true });
          return spawns.every((spawn) => roster.some((row) => row.id === claudeRowId(spawn.childPath) && row.status === 'idle'));
        }, { what: 'the completed child roster' });
        expect(roster.find((row) => row.id === parent.id)?.updatedAt).toBe(completedAt);
        for (const stream of streams) stream.close();
        const reopened = await context.client.attach('claude', parent.id);
        streams.push(reopened);
        await eventually(() => spawns.every((spawn) => latest(reopened, keyOf(spawn))?.status === 'done'), { what: 'completed subagents reconstructed on reconnect' });
      } finally {
        for (const stream of streams) stream.close();
        fake.setAgents([]);
      }
    },
  },
  {
    title: 'the in-session hook protocol is absent unless the development bypass is set',
    async run(context) {
      // Packaged builds answer 404 for every hook leg; a source broker does too without COSYNCING_DEV_MODE.
      const hello = await context.client.post('/claude/hook/hello', { sessionId: crypto.randomUUID() });
      expect(hello.status).toBe(404);
    },
  },
  {
    title: 'a terminal row the CLI reports busy reads working only while its last turn is open',
    async run(context) {
      const fake = context.fake as ClaudeFake;
      const ended = seedAged(fake, 5_000);
      const open = seedAged(fake, 5_000, true);
      try {
        fake.setAgents([ended, open].map((session) => ({ sessionId: claudeUuidOf(session.id), status: 'busy' })));
        await context.client.waitForSession((row: any) => row.id === open.id && row.status === 'working');
        // The same busy report on a turn that already ended is a stale overlay.
        expect((await context.client.waitForSession((row: any) => row.id === ended.id)).status).toBe('idle');
      } finally {
        fake.setAgents([]);
      }
    },
  },
  {
    title: 'taking over a session a terminal is mid-turn on is refused; an idle one is not',
    async run(context) {
      const fake = context.fake as ClaudeFake;
      const busy = seedAged(fake, 5_000, true);
      const idle = seedAged(fake, 5_000);
      // A terminal owner is a live process registered under the store's `sessions/` (this test's own pid is one).
      const registry = join(fake.storeRoot, 'sessions');
      mkdirSync(registry, { recursive: true });
      const registered = [busy, idle].map((session, index) => {
        const file = join(registry, `owner-${index}.json`);
        writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId: claudeUuidOf(session.id), cwd: session.cwd, kind: 'interactive' }));
        return file;
      });
      try {
        fake.setAgents([{ sessionId: claudeUuidOf(busy.id), status: 'busy' }]);
        await context.client.waitForSession((row: any) => row.id === busy.id && row.status === 'working');
        const refused = await context.client.attach('claude', busy.id, { mode: 'resume', reason: 'takeover' });
        const conflict = await refused.waitForKind('attach-conflict');
        expect(conflict.kind).toBe('attach-conflict');
        expect(conflict.code).toBe('DRIVE_OWNERSHIP_CONFLICT');
        expect(conflict.message).toContain('running a turn right now');
        refused.close();
        const allowed = await context.client.attach('claude', idle.id, { mode: 'resume', reason: 'takeover' });
        expect((await allowed.waitForKind('session')).authority?.canMutate).toBe(true);
        allowed.close();
      } finally {
        for (const file of registered) rmSync(file, { force: true });
        fake.setAgents([]);
      }
    },
  },
];

/** A stored session whose last row is `ageMs` old; `open` leaves its last turn unanswered (a terminal mid-turn). */
function seedAged(fake: ClaudeFake, ageMs: number, open = false): SeededSession {
  const uuid = crypto.randomUUID();
  const cwd = fake.workspace('aged');
  const path = claudeTranscriptPath(fake.storeRoot, cwd, uuid);
  const context: TranscriptContext = { sessionId: uuid, cwd, entrypoint: 'cli' };
  const at = Date.now() - ageMs;
  const user = claudeUserRow(context, null, 'aged prompt', { at });
  const answer = claudeAssistantRow(context, user.uuid, `msg_aged_${uuid.slice(0, 8)}`, { type: 'text', text: 'aged answer' }, { at: at + 1000 });
  appendRows(path, [user, ...(open ? [] : [answer]), { type: 'custom-title', customTitle: `aged ${uuid.slice(-6)}`, sessionId: uuid }]);
  return { id: claudeRowId(path), cwd, title: `aged ${uuid.slice(-6)}`, texts: open ? ['aged prompt'] : ['aged prompt', 'aged answer'], storeKey: uuid };
}

function rowText(message: any): string {
  return typeof message.text === 'string' ? message.text : JSON.stringify(message.content ?? message);
}

export const claudeKit: ConformanceKit = {
  profile: claudeProfile,
  extras: claudeExtras,
  env: () => ({
    // A stray API credential in the broker's environment must never reach a Drive child on the
    // subscription store (it would bill the API for every driven turn).
    ANTHROPIC_API_KEY: 'sk-ant-e2e-must-not-reach-the-child',
    ANTHROPIC_AUTH_TOKEN: 'e2e-auth-token-must-not-reach-the-child',
  }),
  install,
};

export type { ConformanceContext };
void symlinkSync;
void existsSync;
void utimesSync;
void claudeQueueOperation;
void claudeToolResultRow;
void claudeSlug;
