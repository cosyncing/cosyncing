/**
 * Materialize a fake `~/.gemini/antigravity-cli` app-data root in a temp dir.
 *
 * Every suite in this package runs against one of these and NEVER against the
 * developer's live install: an adapter whose whole contract is "never write to
 * the user's store" cannot have its tests pointed at that store. The fixture
 * reproduces the real layout — the WAL-mode summaries database with its exact
 * column set, the metadata cache, `settings.json`, the brain tree with its
 * `.system_generated/logs` and `.system_generated/messages` children, and the
 * separate cockpit cache — so the code under test exercises the real paths.
 */
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgyRoots } from '../../src/store.ts';

export const FIXTURE = await Bun.file(new URL('./agy-1.1.17.json', import.meta.url)).json() as AgyFixture;

export interface AgyFixture {
  conversationIds: {
    withTranscript: string;
    withoutTranscript: string;
    ideRow: string;
    stale: string;
    /** A subagent child: it has a brain dir and a transcript, and NO summaries row. */
    subagentChild: string;
    /** A conversation the frozen summaries table never learned about. */
    supplementary: string;
  };
  summaryRows: Array<Record<string, string | number>>;
  conversationMetadata: unknown;
  availableModels: unknown;
  settings: unknown;
  transcript: Array<Record<string, unknown>>;
  transcriptFull: Array<Record<string, unknown>>;
  appendedSteps: Array<Record<string, unknown>>;
  unknownPairStep: Record<string, unknown>;
  settlement: Record<string, unknown>;
  streamEvents: {
    init: Record<string, unknown>;
    stepUpdates: Array<Record<string, unknown>>;
    result: Record<string, unknown>;
    /** CONSTRUCTED, not measured — see `_canceledNote` in the fixture. A step the stream cancels. */
    canceledStepUpdates: Array<Record<string, unknown>>;
  };
  /** Round 2b (P2a–P2f). See `_note` in the fixture for what is measured and what is constructed. */
  round2b: {
    cancelledTaskSettlement: Record<string, unknown>;
    subagentSettlement: Record<string, unknown>;
    systemSettlement: Record<string, unknown>;
    senderlessSettlement: Record<string, unknown>;
    taskLog: string;
    taskLogId: string;
    killStep: Record<string, unknown>;
    childTranscript: Array<Record<string, unknown>>;
    supplementaryTranscript: Array<Record<string, unknown>>;
    lastConversations: Record<string, string>;
  };
}

export interface AgyFixtureTree {
  roots: AgyRoots;
  dir: string;
  /** Path of the transcript for the conversation that has one. */
  transcriptPath: string;
  cleanup(): void;
}

export interface AgyFixtureOptions {
  /** Omit the untruncated transcript, so a `truncated_fields` row must state its truncation. */
  withoutTranscriptFull?: boolean;
  /** Omit the settlement inbox. */
  withoutSettlement?: boolean;
  /** Write only the first N transcript steps, so a test can append the rest. */
  transcriptSteps?: number;
  /**
   * Add the other three MEASURED settlement senders beside the task one: a bare
   * conversation id (a subagent), `system`, and a row with no sender at all. The
   * whole point of the taxonomy is that these are NOT tasks and NOT each other,
   * so a suite asserting it needs all four present at once.
   */
  withSettlementTaxonomy?: boolean;
  /** Write `…/tasks/task-7.log` for the settled task. */
  withTaskLog?: boolean;
  /**
   * Give the live conversation a subagent CHILD — a brain dir with its own
   * transcript, a settlement in the parent's inbox naming it, and deliberately NO
   * summaries row, which is how both real children were found (MEASURED).
   */
  withSubagentChild?: boolean;
  /** A brain dir with a transcript and no summaries row, plus the `last_conversations` cwd for it. */
  withSupplementaryConversation?: boolean;
}

export function jsonl(rows: Array<Record<string, unknown>>): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

/** Build the tree. Callers MUST `cleanup()`; every path lives under one mkdtemp dir. */
export function buildAgyFixtureTree(options: AgyFixtureOptions = {}): AgyFixtureTree {
  const dir = mkdtempSync(join(tmpdir(), 'agy-fixture-'));
  const appData = join(dir, '.gemini', 'antigravity-cli');
  const cockpitCache = join(dir, '.antigravity_cockpit', 'cache');
  mkdirSync(join(appData, 'cache'), { recursive: true });
  mkdirSync(join(appData, 'conversations'), { recursive: true });
  mkdirSync(cockpitCache, { recursive: true });

  writeSummariesDb(join(appData, 'conversation_summaries.db'), FIXTURE.summaryRows);
  writeFileSync(join(appData, 'cache', 'conversation_metadata.json'), JSON.stringify(FIXTURE.conversationMetadata, null, 1));
  writeFileSync(join(appData, 'settings.json'), JSON.stringify(FIXTURE.settings, null, 1));
  writeFileSync(join(cockpitCache, 'available_models.json'), JSON.stringify(FIXTURE.availableModels, null, 1));

  const live = FIXTURE.conversationIds.withTranscript;
  const logs = join(appData, 'brain', live, '.system_generated', 'logs');
  mkdirSync(logs, { recursive: true });
  const steps = options.transcriptSteps !== undefined
    ? FIXTURE.transcript.slice(0, options.transcriptSteps)
    : FIXTURE.transcript;
  const transcriptPath = join(logs, 'transcript.jsonl');
  writeFileSync(transcriptPath, jsonl(steps));
  if (!options.withoutTranscriptFull) {
    writeFileSync(join(logs, 'transcript_full.jsonl'), jsonl(FIXTURE.transcriptFull));
  }
  const inbox = join(appData, 'brain', live, '.system_generated', 'messages');
  if (!options.withoutSettlement) {
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, `${String(FIXTURE.settlement.id)}.json`), JSON.stringify(FIXTURE.settlement, null, 1));
    // Siblings the reader must NOT mistake for messages: the delivered-set, the
    // read watermark, and the undelivered spool. All three are real (MEASURED).
    writeFileSync(join(inbox, 'read.json'), JSON.stringify({ [String(FIXTURE.settlement.id)]: true }));
    writeFileSync(join(inbox, 'cursor.json'), JSON.stringify({ last_read_unix_nano: 1779364802373827874 }));
    mkdirSync(join(inbox, 'undelivered'), { recursive: true });
  }

  const writeSettlement = (row: Record<string, unknown>) => {
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, `${String(row.id)}.json`), JSON.stringify(row, null, 1));
  };
  if (options.withSettlementTaxonomy) {
    writeSettlement(FIXTURE.round2b.cancelledTaskSettlement);
    writeSettlement(FIXTURE.round2b.subagentSettlement);
    writeSettlement(FIXTURE.round2b.systemSettlement);
    writeSettlement(FIXTURE.round2b.senderlessSettlement);
  }
  if (options.withTaskLog) {
    const tasks = join(appData, 'brain', live, '.system_generated', 'tasks');
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(tasks, `${FIXTURE.round2b.taskLogId}.log`), FIXTURE.round2b.taskLog);
  }
  if (options.withSubagentChild) {
    // The settlement is what NAMES the child — the parent's `invoke_subagent`
    // step never does (MEASURED) — so the link exists only when this is written.
    writeSettlement(FIXTURE.round2b.subagentSettlement);
    writeBrainTranscript(appData, FIXTURE.conversationIds.subagentChild, FIXTURE.round2b.childTranscript);
  }
  if (options.withSupplementaryConversation) {
    writeBrainTranscript(appData, FIXTURE.conversationIds.supplementary, FIXTURE.round2b.supplementaryTranscript);
    writeFileSync(
      join(appData, 'cache', 'last_conversations.json'),
      JSON.stringify(FIXTURE.round2b.lastConversations, null, 1),
    );
  }

  // The conversation with a store and NO transcript: a brain dir exists, the
  // logs dir does not. 2 of 27 real CLI conversations are in exactly this state.
  mkdirSync(join(appData, 'brain', FIXTURE.conversationIds.withoutTranscript, '.system_generated'), { recursive: true });

  return {
    roots: { appData, cockpitCache },
    dir,
    transcriptPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A brain dir with nothing but its own transcript — the shape a conversation the
 *  summaries table never learned about actually has on disk. */
function writeBrainTranscript(appData: string, conversationId: string, steps: Array<Record<string, unknown>>): void {
  const logs = join(appData, 'brain', conversationId, '.system_generated', 'logs');
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'transcript.jsonl'), jsonl(steps));
}

// ── The fake `agy` child ─────────────────────────────────────────────────────

/**
 * What the fake binary should do. One entry in `turns` per stdin line it receives.
 *
 * `'silent'` reproduces the MEASURED exit-0 silent-failure trap: agy answers an
 * unrecognized input `event` with a stderr warning, no `result`, and exit 0. An
 * adapter that waits for `result` hangs forever with nothing to show, so the
 * drive suite asserts that this surfaces instead.
 */
export interface AgyFakeScript {
  /** \`agy models\` lines (\`id\\tdisplayName\`) the fake serves to the catalog probe. */
  models?: string[];
  /** Emitted once at startup, before any stdin arrives. */
  init?: Record<string, unknown>;
  /** Events to emit per received stdin line; `'silent'` emits nothing and exits. */
  turns?: Array<Array<Record<string, unknown>> | 'silent'>;
  /**
   * `turns`, but chosen by LAUNCH number rather than shared across launches.
   *
   * A relaunch (a per-turn model or mode switch) starts a second process, and the
   * turn counter is per-process — so without this, launch 2's first turn replays
   * launch 1's first turn. Any test where the two generations must behave
   * DIFFERENTLY needs this: notably "the first child never answers, the
   * replacement does".
   */
  turnsByLaunch?: Array<Array<Array<Record<string, unknown>> | 'silent'>>;
  /** Used when `turns` is exhausted. */
  defaultTurn?: Array<Record<string, unknown>> | 'silent';
  /** Exit status for the `'silent'` path — deliberately 0, which is what makes it a trap. */
  silentExitCode?: number;
  /** Text written to stderr at startup (the "ignoring unsupported stream input message event" warning). */
  stderr?: string;
  /**
   * Emit one stdout line padded to this many bytes BEFORE `init`.
   *
   * The reader buffers until it sees a newline, so a line larger than its cap is
   * the input that grows that buffer without bound. Pipes deliver it in ~64 KiB
   * chunks, which is what makes the overflow reachable at all.
   */
  oversizedLineBytes?: number;
}

export interface AgyFakeBinary {
  /** Path to pass as the adapter's `binary`. */
  path: string;
  /** The argv the child was actually invoked with, or undefined if it never ran. */
  argv(): string[] | undefined;
  /** Every NDJSON line the connection wrote to the child's stdin, across ALL launches. */
  stdin(): Array<Record<string, unknown>>;
  /** How many times the binary has been spawned. A relaunch is only observable as this going up. */
  launches(): number;
}

/**
 * Write an executable fake `agy`.
 *
 * The REAL binary is never spawned by any suite: it costs a full workspace init,
 * it reaches the network, and it would spend model quota. This one speaks the
 * measured wire — one NDJSON line in per turn, `init`/`step_update`/`result` out
 * — and records both its argv and everything written to its stdin so the suite
 * can assert the invocation contract (notably that `--print` is never passed).
 */
export function writeFakeAgyBinary(dir: string, script: AgyFakeScript): AgyFakeBinary {
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, 'agy-script.json');
  const argvPath = join(dir, 'agy-argv.json');
  const stdinPath = join(dir, 'agy-stdin.ndjson');
  const launchPath = join(dir, 'agy-launches.txt');
  const binPath = join(dir, 'agy');
  writeFileSync(scriptPath, JSON.stringify(script));
  writeFileSync(stdinPath, '');
  writeFileSync(launchPath, '0');

  writeFileSync(
    binPath,
    `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const script = JSON.parse(readFileSync(${JSON.stringify(scriptPath)}, 'utf8'));
// The read-only \`agy models\` catalog probe is NOT a conversation child. It is
// answered and forgotten BEFORE any recording: writing it into the argv/launch
// ledger would clobber the record these suites use to pin that attach spawns
// nothing and that a turn spawns exactly one child.
if (process.argv[2] === 'models') {
  for (const line of script.models ?? []) process.stdout.write(line + '\\n');
  process.exit(0);
}
writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));
// Which launch this is. The turn counter is per-process, so a relaunch would
// otherwise replay the previous generation's script from the top.
let launch = 0;
try { launch = Number(readFileSync(${JSON.stringify(launchPath)}, 'utf8')) || 0; } catch {}
writeFileSync(${JSON.stringify(launchPath)}, String(launch + 1));
const plans = (script.turnsByLaunch ?? [])[launch] ?? script.turns ?? [];
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (script.oversizedLineBytes) emit({ type: 'noise', pad: 'z'.repeat(script.oversizedLineBytes) });
if (script.stderr) process.stderr.write(String(script.stderr) + '\\n');
if (script.init) emit(script.init);
let turn = 0;
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    appendFileSync(${JSON.stringify(stdinPath)}, line + '\\n');
    const plan = plans[turn++] ?? script.defaultTurn ?? [];
    if (plan === 'silent') process.exit(script.silentExitCode ?? 0);
    for (const event of plan) emit(event);
  }
});
// Holding stdin open is the whole point: the child stays alive across turns, which
// is what makes \`--input-format stream-json\` a drive surface rather than a one-shot.
process.stdin.on('end', () => process.exit(0));
`,
  );
  chmodSync(binPath, 0o755);

  return {
    path: binPath,
    argv: () => {
      try {
        return JSON.parse(readFileSync(argvPath, 'utf8')) as string[];
      } catch {
        return undefined;
      }
    },
    stdin: () => {
      try {
        return readFileSync(stdinPath, 'utf8')
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      } catch {
        return [];
      }
    },
    launches: () => {
      try {
        return Number(readFileSync(launchPath, 'utf8')) || 0;
      } catch {
        return 0;
      }
    },
  };
}

/**
 * Write the summaries database with the REAL column set and journal mode.
 *
 * WAL matters: an ordinary read-only open of a WAL database creates `-wal` and
 * `-shm` sidecars, which is the exact behaviour `test-agy-store.ts` asserts the
 * adapter avoids. A fixture in the default rollback-journal mode would make that
 * assertion pass for the wrong reason.
 */
function writeSummariesDb(path: string, rows: Array<Record<string, string | number>>): void {
  const db = new Database(path, { create: true });
  db.run('pragma journal_mode = wal');
  db.run(
    'create table `conversation_summaries` ('
    + '`conversation_id` text, `title` text NOT NULL DEFAULT "", `preview` text NOT NULL DEFAULT "",'
    + '`step_count` integer NOT NULL DEFAULT 0, `last_modified_time` datetime NOT NULL,'
    + '`workspace_uris` text NOT NULL, `status` text NOT NULL DEFAULT "", `source` text NOT NULL DEFAULT "",'
    + '`project_id` text NOT NULL DEFAULT "", `agent_name` text NOT NULL DEFAULT "",'
    + '`parent_conversation_id` text NOT NULL DEFAULT "", `nesting_depth` integer NOT NULL DEFAULT 0,'
    + '`battle_id` text NOT NULL DEFAULT "", `winning_conversation_id` text NOT NULL DEFAULT "",'
    + '`not_fully_idle` numeric NOT NULL DEFAULT false, `killed` numeric NOT NULL DEFAULT false,'
    + '`last_user_input_time` datetime NOT NULL, `last_user_input_step_index` integer NOT NULL DEFAULT -1,'
    + '`app_data_dir` text NOT NULL DEFAULT "", PRIMARY KEY (`conversation_id`))',
  );
  const columns = [
    'conversation_id', 'title', 'preview', 'step_count', 'last_modified_time', 'workspace_uris',
    'status', 'source', 'project_id', 'agent_name', 'parent_conversation_id', 'nesting_depth',
    'battle_id', 'winning_conversation_id', 'not_fully_idle', 'killed', 'last_user_input_time',
    'last_user_input_step_index', 'app_data_dir',
  ];
  const insert = db.prepare(
    `insert into conversation_summaries (${columns.join(',')}) values (${columns.map(() => '?').join(',')})`,
  );
  for (const row of rows) insert.run(...columns.map((column) => row[column] ?? ''));
  // Checkpoint and close so the fixture is a single self-contained file, exactly
  // like the store on a host where the CLI is not currently running (the real
  // `conversation_summaries.db` has no sidecars beside it).
  db.run('pragma wal_checkpoint(TRUNCATE)');
  db.close();
  // bun removes the `-wal`/`-shm` pair on close ASYNCHRONOUSLY, so a snapshot
  // taken immediately after this function returns can still see them and then
  // watch them vanish mid-test — which reads as "something wrote to the store"
  // when nothing did. Remove them synchronously here so the fixture's starting
  // state is deterministic and the no-write assertion measures only the adapter.
  // The database stays in WAL MODE (that lives in the file header), so the
  // sidecar-creation hazard the suite exists to catch is still present.
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
    rmSync(sidecar, { force: true });
  }
}
