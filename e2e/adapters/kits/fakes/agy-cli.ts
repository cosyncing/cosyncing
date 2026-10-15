/**
 * A fake `agy` CLI, one self-contained file (node builtins and bun:sqlite only), installed into `paths.bin` by
 * `installFakeExecutable` (kit.ts). Its config is `<argv[1]>.json`.
 *
 *   agy --version             the configured version (or `versionOutput`)
 *   agy models                a banner line, then `id<TAB>displayName` per configured model
 *   agy --conversation <id> --output-format=stream-json --input-format=stream-json [--model M] [--mode X]
 *                             the Drive child: one NDJSON `{event:"user",...}` line per turn on stdin;
 *                             `init` / `step_update` / `result` envelopes on stdout, nested under the event's
 *                             own tag; the turn is also appended to the conversation's transcript.jsonl
 *   anything else             recorded and refused (exit 2)
 *
 * Turns are processed one at a time, in arrival order, and are scripted by the prompt text:
 *   [[hold:TAG]]      wait for `release-TAG` in `controlDir` before answering
 *   [[silent]]        exit 0 with no `result` (agy's answer to an input it does not recognise)
 *   [[fail]]          a `result` whose status is ERROR
 *   [[userstep]]      also stream the text-less `user_input` step, ahead of the transcript append
 *   [[state:X]]       a step that ends in stream state X instead of STEP_DONE (a cancel, an abort ...)
 * The answer is `answer: <text with every [[..]] stripped>`.
 *
 * Like the real 1.1.22+ binary it never touches `conversation_summaries.db` or `cache/conversation_metadata.json`
 * (both froze); it does keep `cache/last_conversations.json` current. Run as a program it is the fake CLI;
 * imported, it exports the store writers the test side seeds sessions with, so the test and the fake can never
 * disagree on the store layout.
 *
 * Every invocation is appended to the ledger (`kind: version-probe | models | spawn | recv | exit | fault`); a
 * prompt's `recv` entry is in the conformance vocabulary (`session/prompt`, `session/load`).
 */
import { Database } from 'bun:sqlite';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export interface FakeAgyConfig {
  ledger: string;
  controlDir: string;
  appData: string;
  version: string;
  versionOutput?: string;
  /** `id<TAB>displayName` lines `agy models` prints after its banner. */
  models: string[];
  /** Exit status of `agy models` (non-zero: the live catalog is unavailable). */
  modelsExit?: number;
  /** The model a child reports when it was launched without `--model`. */
  defaultModel: string;
}

type Json = Record<string, any>;

// ------------------------------------------------------------------ store writers

const SUMMARY_COLUMNS = [
  'conversation_id', 'title', 'preview', 'step_count', 'last_modified_time', 'workspace_uris',
  'status', 'source', 'project_id', 'agent_name', 'parent_conversation_id', 'nesting_depth',
  'battle_id', 'winning_conversation_id', 'not_fully_idle', 'killed', 'last_user_input_time',
  'last_user_input_step_index', 'app_data_dir',
];

/** The summaries database with the real column set, in WAL mode, as one self-contained file. */
export function ensureSummariesDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) return;
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
  closeSummariesDb(db, path);
}

function closeSummariesDb(db: Database, path: string): void {
  // One self-contained file, as on a host where the CLI is not running: no -wal/-shm sidecar a read could be blamed for.
  db.run('pragma wal_checkpoint(TRUNCATE)');
  db.close();
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) rmSync(sidecar, { force: true });
}

/** One `conversation_summaries` row (what an older `agy` wrote and the roster still reads). */
export function putSummaryRow(
  path: string,
  row: { id: string; preview: string; cwd?: string; stepCount: number; modified?: Date; ide?: boolean },
): void {
  const db = new Database(path);
  const values: Record<string, string | number> = {
    conversation_id: row.id,
    preview: row.preview,
    step_count: row.stepCount,
    last_modified_time: `${(row.modified ?? new Date()).toISOString().replace('T', ' ').replace('Z', '000000+00:00')}`,
    workspace_uris: row.cwd ? JSON.stringify([`file://${row.cwd}`]) : '',
    last_user_input_time: '0001-01-01 00:00:00+00:00',
    last_user_input_step_index: -1,
    app_data_dir: row.ide ? 'antigravity' : 'antigravity-cli',
  };
  db.prepare(`insert or replace into conversation_summaries (${SUMMARY_COLUMNS.join(',')}) values (${SUMMARY_COLUMNS.map(() => '?').join(',')})`)
    .run(...SUMMARY_COLUMNS.map((column) => values[column] ?? ''));
  closeSummariesDb(db, path);
}

export function transcriptPath(appData: string, id: string): string {
  return join(appData, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
}

/** What agy writes around a typed prompt: the request, then the host's metadata. */
export function wrapUserRequest(text: string): string {
  return `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${new Date().toISOString()}.\n</ADDITIONAL_METADATA>`;
}

export function readTranscript(appData: string, id: string): Json[] {
  const path = transcriptPath(appData, id);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as Json);
}

export function userStep(index: number, text: string): Json {
  return {
    step_index: index,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: new Date().toISOString(),
    content: wrapUserRequest(text),
  };
}

export function plannerStep(index: number, text: string): Json {
  return { step_index: index, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date().toISOString(), content: text };
}

/** Append whole steps (one line each) to a conversation's transcript, creating its brain directory. */
export function appendSteps(appData: string, id: string, steps: Json[]): void {
  const path = transcriptPath(appData, id);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, steps.map((step) => `${JSON.stringify(step)}\n`).join(''));
}

export function nextStepIndex(appData: string, id: string): number {
  return readTranscript(appData, id).reduce((next, step) => Math.max(next, Number(step.step_index) + 1), 0);
}

/** `cache/last_conversations.json` maps a workspace to its last conversation (one id per cwd). */
export function putLastConversation(appData: string, cwd: string, id: string): void {
  const path = join(appData, 'cache', 'last_conversations.json');
  let current: Json = {};
  try {
    current = JSON.parse(readFileSync(path, 'utf8')) as Json;
  } catch {
    // First write.
  }
  current[cwd] = id;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(current));
  renameSync(`${path}.tmp`, path);
}

// ------------------------------------------------------------------ the program

function main(): void {
  const config = JSON.parse(readFileSync(`${process.argv[1]}.json`, 'utf8')) as FakeAgyConfig;
  const args = process.argv.slice(2);
  const log = (kind: string, extra: Json = {}): void => {
    try {
      appendFileSync(config.ledger, `${JSON.stringify({ at: Date.now(), pid: process.pid, kind, ...extra })}\n`);
    } catch {
      // The ledger is evidence for the test, never a reason for the fake to fail.
    }
  };

  if (args[0] === '--version' || args[0] === '-V') {
    log('version-probe', { argv: args });
    process.stdout.write(config.versionOutput ?? `${config.version}\n`);
    return;
  }
  if (args[0] === 'models') {
    log('models', { argv: args });
    if (config.modelsExit) process.exit(config.modelsExit);
    process.stdout.write('Fetching available models...\n');
    for (const line of config.models) process.stdout.write(`${line}\n`);
    return;
  }
  if (!args.includes('--output-format=stream-json') || !args.includes('--input-format=stream-json')) {
    log('unimplemented', { argv: args });
    process.stderr.write(`fake agy: unsupported invocation: ${args.join(' ')}\n`);
    process.exit(2);
  }

  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const conversation = flag('--conversation') ?? crypto.randomUUID();
  const model = flag('--model') ?? config.defaultModel;
  const cwd = process.cwd();
  log('spawn', { argv: args, cwd, conversation });
  if (flag('--conversation')) {
    log('recv', { frame: { method: 'session/load', params: { sessionId: conversation } } });
  }
  process.on('SIGTERM', () => {
    log('exit', { signal: 'SIGTERM' });
    process.exit(0);
  });

  const emit = (event: string, body: Json, sibling: Json = {}): void => {
    process.stdout.write(`${JSON.stringify({ event, ...sibling, [event]: body })}\n`);
  };
  emit('init', { model, cwd, permission_mode: 'request-review', tools: ['run_command', 'view_file'] }, { conversation_id: conversation });

  const stepUpdate = (index: number, state: string, type: string, extra: Json = {}): void => {
    emit('step_update', { conversation_id: conversation, step_index: index, state, step_type: type, ...extra });
  };
  const waitFor = async (path: string): Promise<void> => {
    const deadline = Date.now() + 120_000;
    while (!existsSync(path)) {
      if (Date.now() > deadline) {
        log('fault', { reason: `never released: ${path}` });
        process.exit(4);
      }
      await Bun.sleep(15);
    }
  };

  const turn = async (text: string): Promise<void> => {
    log('recv', {
      frame: { method: 'session/prompt', params: { sessionId: conversation, prompt: [{ type: 'text', text }] } },
    });
    const hold = /\[\[hold:([^\]]+)\]\]/.exec(text)?.[1];
    const state = /\[\[state:([^\]]+)\]\]/.exec(text)?.[1];
    const clean = text.replace(/\[\[[^\]]*\]\]\s*/g, '').trim();
    const index = nextStepIndex(config.appData, conversation);
    // Real agy streams a text-less `user_input` step as well; how it orders against the transcript append is not
    // measured, so it is emitted only on request, and then BEFORE the append (the order that exposes the adapter).
    if (text.includes('[[userstep]]')) stepUpdate(index, 'STEP_DONE', 'user_input');
    appendSteps(config.appData, conversation, [userStep(index, text)]);
    putLastConversation(config.appData, cwd, conversation);
    if (hold) await waitFor(join(config.controlDir, `release-${hold}`));
    if (text.includes('[[silent]]')) {
      log('turn-end', { text, outcome: 'silent' });
      log('exit', { code: 0, reason: 'silent' });
      process.exit(0);
    }
    if (text.includes('[[fail]]')) {
      emit('result', { status: 'ERROR', error: 'fixture failure', response: '', num_turns: 1 });
      log('turn-end', { text, outcome: 'failed' });
      return;
    }
    const answer = `answer: ${clean}`;
    if (state) {
      stepUpdate(index + 1, 'STEP_RUNNING', 'agent_response', { text_delta: 'half an answ' });
      stepUpdate(index + 1, state, 'agent_response');
      emit('result', { status: 'SUCCESS', response: '', num_turns: 1 });
      log('turn-end', { text, outcome: state });
      return;
    }
    stepUpdate(index + 1, 'STEP_DONE', 'agent_response', { text_delta: answer, duration_seconds: 0.1 });
    appendSteps(config.appData, conversation, [plannerStep(index + 1, answer)]);
    emit('result', {
      status: 'SUCCESS',
      response: answer,
      duration_seconds: 0.1,
      num_turns: 1,
      usage: { input_tokens: 12, output_tokens: 3, cache_read_tokens: 0, thinking_tokens: 0, total_tokens: 15 },
    });
    log('turn-end', { text, outcome: 'done' });
  };

  // One turn at a time, in arrival order: a prompt written while a turn runs waits for it, and only then
  // reaches the ledger (the agent reads its stdin sequentially).
  let chain: Promise<void> = Promise.resolve();
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let input: Json;
      try {
        input = JSON.parse(line) as Json;
      } catch {
        continue;
      }
      chain = chain.then(async () => {
        if (input.event !== 'user') {
          // The measured silent-failure trap: an unrecognised event is a stderr warning and a clean exit.
          process.stderr.write(`warning: ignoring unsupported stream input message event ${JSON.stringify(input.event)}\n`);
          log('exit', { code: 0, reason: 'unrecognised-event' });
          process.exit(0);
        }
        await turn(String(input.message?.content ?? ''));
      });
    }
  });
  process.stdin.on('end', () => {
    log('exit', { code: 0, reason: 'stdin-closed' });
    process.exit(0);
  });
}

if (import.meta.main) main();
