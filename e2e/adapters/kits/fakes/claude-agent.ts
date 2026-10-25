/**
 * A scriptable fake `claude` (Claude Code CLI), one self-contained file (node builtins only).
 *
 * `installFakeExecutable` (kit.ts) copies this file into a broker's `paths.bin` as `claude`, so the
 * product resolves it exactly where it would find the real CLI. Run as a program it is the fake
 * CLI; imported, it only exports the transcript writers the kit seeds sessions with, so the kit and
 * the fake can never disagree on the store layout.
 *
 * What it answers, as the measured CLI does:
 *
 *   claude --version                  `<version> (Claude Code)` (or `versionOutput`)
 *   claude agents --json              the `agents` array from the config (live status overlay)
 *   claude -p --resume <uuid> …       the Drive child: stream-json in, stream-json out
 *   claude -p --session-id <uuid> …   the first Drive turn of a session the broker created
 *
 * Drive child: `--input-format stream-json --output-format stream-json --include-partial-messages`.
 * Each stdin `{"type":"user"}` line is one turn, run in arrival order (a line that arrives while a
 * turn runs waits for it, as the CLI's own prompt queue does). A turn writes the durable transcript
 * at `$CLAUDE_CONFIG_DIR/projects/<cwd slug>/<uuid>.jsonl` in the measured shape: a queue-operation
 * enqueue when the line arrives (content-less for an array-content message, with `content` for a
 * string one: measured over 138 local sdk-cli transcripts, builds 2.1.170-2.1.295), a dequeue and
 * the user row when the turn starts, then the assistant row(s), and streams `system/init` (first
 * turn), `stream_event` deltas, the `assistant` event and the `result` on stdout.
 *
 * A prompt's own text scripts its turn:
 *
 *   [[permission]]   run a gated Bash tool: `control_request` can_use_tool, then wait for the
 *                    product's `control_response` (allow runs the tool, deny refuses it)
 *   [[question]]     AskUserQuestion gated the same way; the answers ride `updatedInput.answers`
 *   [[hold:TAG]]     keep the turn open until the control file `release-TAG` appears, an
 *                    interrupt ends it, or the process is terminated
 *
 * Control requests on stdin, answered as Claude Code 2.1.310 answers them: `interrupt` ends the
 * running turn as aborted (withdrawing an open permission or question gate with
 * `control_cancel_request` first) and, with `cancel_queued`, drops the turns queued behind it;
 * `set_model` switches the model for later turns and records the switch in the transcript as the
 * CLI's `/model` command rows; `set_permission_mode` and `apply_flag_settings` are accepted.
 *
 * Everything observable is appended to the ledger (JSONL): every start with its argv, cwd and the
 * credential variables it inherited, every version and `agents` probe, every stdin frame (`recv`),
 * every turn start (`turn`) and end (`turn-end`), every interrupt, every signal, and every exit. Tests read the
 * ledger; they never patch the fake.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

type Json = Record<string, any>;

/** Thrown through a turn that an interrupt ended; `toolUse` when it stopped at a gated tool. */
class TurnInterrupted extends Error {
  constructor(readonly toolUse = true) {
    super('turn interrupted');
  }
}

export interface FakeClaudeConfig {
  /** JSONL ledger every fake process appends to. */
  ledger: string;
  /** Directory for `release-TAG` files. */
  controlDir: string;
  /** Version printed by `--version`. */
  version: string;
  /** Replaces the whole `--version` output when set. */
  versionOutput?: string;
  /** What `agents --json` reports: busy → working, waiting → needs input, anything else → idle. */
  agents?: Array<{ sessionId: string; status?: string; waitingFor?: string }>;
  /** The model a launch without `--model` runs. */
  model?: string;
  /** `system/init` slash_commands. */
  slashCommands?: string[];
}

/** The CLI's own alias resolution for `--model` (an alias selects a concrete model id). */
export const CLAUDE_FAKE_MODELS: Record<string, string> = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5',
};

export const CLAUDE_FAKE_VERSION = '2.1.295';

// ------------------------------------------------------------------ the store

/** Claude's project directory name for a cwd: every non-alphanumeric character becomes `-`. */
export function claudeSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function claudeTranscriptPath(configDir: string, cwd: string, sessionId: string): string {
  return join(configDir, 'projects', claudeSlug(cwd), `${sessionId}.jsonl`);
}

export interface TranscriptContext {
  sessionId: string;
  cwd: string;
  /** `cli` for a terminal session, `sdk-cli` for a `claude -p` child. */
  entrypoint?: 'cli' | 'sdk-cli';
  version?: string;
}

const iso = (ms = Date.now()): string => new Date(ms).toISOString();

function base(context: TranscriptContext, parentUuid: string | null, uuid: string, at: number): Json {
  return {
    parentUuid,
    isSidechain: false,
    uuid,
    timestamp: iso(at),
    userType: 'external',
    entrypoint: context.entrypoint ?? 'cli',
    cwd: context.cwd,
    sessionId: context.sessionId,
    version: context.version ?? CLAUDE_FAKE_VERSION,
    gitBranch: 'HEAD',
  };
}

/** A durable user prompt row (string content, as a typed prompt is recorded). */
export function claudeUserRow(
  context: TranscriptContext,
  parentUuid: string | null,
  content: string | Json[],
  options: { uuid?: string; at?: number; permissionMode?: string; sdk?: boolean; extra?: Json } = {},
): Json {
  const uuid = options.uuid ?? crypto.randomUUID();
  return {
    ...base(context, parentUuid, uuid, options.at ?? Date.now()),
    promptId: crypto.randomUUID(),
    type: 'user',
    message: { role: 'user', content },
    permissionMode: options.permissionMode ?? 'default',
    ...(options.sdk ? { promptSource: 'sdk', turnOrigin: 'sdk' } : { origin: { kind: 'human' }, promptSource: 'typed', turnOrigin: 'human' }),
    ...options.extra,
  };
}

/** One durable assistant row: one content block per line, as current builds record a message. */
export function claudeAssistantRow(
  context: TranscriptContext,
  parentUuid: string | null,
  messageId: string,
  block: Json,
  options: { model?: string; stopReason?: string | null; at?: number; uuid?: string } = {},
): Json {
  return {
    ...base(context, parentUuid, options.uuid ?? crypto.randomUUID(), options.at ?? Date.now()),
    message: {
      model: options.model ?? 'claude-opus-4-8',
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [block],
      stop_reason: options.stopReason === undefined ? 'end_turn' : options.stopReason,
      stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    requestId: `req_${messageId}`,
    type: 'assistant',
  };
}

/** A durable tool_result row answering `toolUseId`. */
export function claudeToolResultRow(
  context: TranscriptContext,
  parentUuid: string | null,
  toolUseId: string,
  content: string,
  options: { isError?: boolean; toolUseResult?: unknown; at?: number } = {},
): Json {
  return {
    ...base(context, parentUuid, crypto.randomUUID(), options.at ?? Date.now()),
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: options.isError === true }] },
    ...(options.toolUseResult !== undefined ? { toolUseResult: options.toolUseResult } : {}),
  };
}

export function claudeQueueOperation(sessionId: string, operation: 'enqueue' | 'dequeue' | 'remove', content?: string): Json {
  return { type: 'queue-operation', operation, timestamp: iso(), sessionId, ...(content !== undefined ? { content } : {}) };
}

/** The `uuid` of the last threaded row in a transcript (the next row's parentUuid), or null. */
export function lastThreadUuid(path: string): string | null {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.uuid === 'string') return parsed.uuid;
    } catch {
      // A partial line: the writer's next append completes it.
    }
  }
  return null;
}

export function appendRows(path: string, rows: Json[]): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
}

// ------------------------------------------------------------------ the agent

function runFakeClaude(): void {
  const configPath = `${process.argv[1]}.json`;
  const readConfig = (): FakeClaudeConfig => JSON.parse(readFileSync(configPath, 'utf8')) as FakeClaudeConfig;
  let config = readConfig();
  const argv = process.argv.slice(2);
  const record = (entry: Json): void => {
    appendFileSync(config.ledger, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`);
  };
  const argValue = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  // ---------------------------------------------------------- one-shot commands
  if (argv.includes('--version') || argv[0] === '-v') {
    record({ kind: 'version-probe', argv });
    process.stdout.write(config.versionOutput ?? `${config.version} (Claude Code)\n`);
    process.exit(0);
  }
  if (argv[0] === 'agents') {
    record({ kind: 'agents', argv });
    process.stdout.write(`${JSON.stringify(config.agents ?? [])}\n`);
    process.exit(0);
  }
  const resumeId = argValue('--resume');
  const createId = argValue('--session-id');
  const sessionId = resumeId ?? createId;
  if (!argv.includes('-p') || !sessionId || argValue('--input-format') !== 'stream-json') {
    record({ kind: 'unimplemented', argv });
    process.stderr.write(`fake claude does not implement: ${argv.join(' ')}\n`);
    process.exit(2);
  }

  // ------------------------------------------------------------- Drive child
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  const cwd = process.cwd();
  const transcript = claudeTranscriptPath(configDir, cwd, sessionId);
  const resolveModel = (requested: string | undefined): string =>
    (requested && CLAUDE_FAKE_MODELS[requested]) ?? requested ?? config.model ?? 'claude-opus-4-8';
  let model = resolveModel(argValue('--model'));
  let permissionMode = argValue('--permission-mode') ?? 'default';
  const context: TranscriptContext = { sessionId, cwd, entrypoint: 'sdk-cli', version: config.version };
  record({
    kind: 'spawn',
    argv,
    cwd,
    sessionId,
    transcript,
    env: {
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
      COSYNCING_SPAWNED: process.env.COSYNCING_SPAWNED ?? null,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY === undefined ? null : 'present',
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN === undefined ? null : 'present',
    },
  });

  const out = (message: Json): void => {
    process.stdout.write(`${JSON.stringify({ ...message, session_id: sessionId, uuid: crypto.randomUUID() })}\n`);
  };
  const fail = (text: string): never => {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: text, duration_ms: 0, num_turns: 0, total_cost_usd: 0 });
    record({ kind: 'exit', reason: 'refused', message: text });
    process.exit(1);
  };
  // The CLI's own refusals: a resume names an existing conversation in THIS cwd's project, and a
  // `--session-id` must be new.
  if (resumeId && !existsSync(transcript)) fail(`No conversation found with session ID: ${resumeId}`);
  if (createId && existsSync(transcript)) fail(`Session ID ${createId} is already in use.`);

  const append = (rows: Json[]): void => appendRows(transcript, rows);
  let turns = 0;
  let running: string | undefined;
  let initSent = false;
  let stdinClosed = false;
  const queue: Json[] = [];
  const awaiting = new Map<string, (frame: Json) => void>();
  /** Ends the running turn early, as an interrupt does. Set while a turn runs. */
  let interruptTurn: (() => void) | undefined;
  let interruption: Promise<'interrupted'> = new Promise(() => {});

  const exit = (reason: string, code: number): never => {
    record({ kind: 'exit', reason, midTurn: running !== undefined, turnText: running ?? null });
    process.exit(code);
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      record({ kind: 'signal', signal, midTurn: running !== undefined, turnText: running ?? null });
      exit(signal, 143);
    });
  }

  const textOf = (content: unknown): string => typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((block: Json) => block?.type === 'text').map((block: Json) => String(block.text ?? '')).join('\n')
      : '';

  const released = (tag: string): Promise<void> => new Promise((resolve) => {
    const tick = (): void => {
      if (existsSync(join(config.controlDir, `release-${tag}`))) return resolve();
      setTimeout(tick, 20);
    };
    tick();
  });

  const control = async (request: Json): Promise<Json> => {
    const id = `${request.tool_name === 'AskUserQuestion' ? 'question' : 'permission'}-${process.pid}-${turns}`;
    const answered = new Promise<Json>((resolve) => {
      awaiting.set(id, resolve);
      out({ type: 'control_request', request_id: id, request });
    });
    const outcome = await Promise.race([answered, interruption]);
    if (outcome !== 'interrupted') return outcome;
    // An interrupt withdraws the gate it found open before the turn ends.
    awaiting.delete(id);
    out({ type: 'control_cancel_request', request_id: id });
    throw new TurnInterrupted();
  };

  /** Stream one assistant message (one text block) and write its durable row. */
  const say = (text: string, stopReason: string, parent: string | null): string => {
    const messageId = `msg_fake_${process.pid}_${turns}_${Math.random().toString(16).slice(2, 8)}`;
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 11, output_tokens: 1 } } } });
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } });
    const row = claudeAssistantRow(context, parent, messageId, { type: 'text', text }, { model, stopReason });
    append([row]);
    out({ type: 'assistant', parent_tool_use_id: null, message: row.message });
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 4 } } });
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } });
    return row.uuid as string;
  };

  /** A gated tool call: assistant tool_use, the product's decision, then its durable result. */
  const gatedTool = async (name: string, input: Json, parent: string | null): Promise<{ decision: Json; parent: string }> => {
    const messageId = `msg_fake_${process.pid}_${turns}_tool`;
    const toolUseId = `toolu_fake_${process.pid}_${turns}`;
    const block = { type: 'tool_use', id: toolUseId, name, input };
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 11, output_tokens: 1 } } } });
    const row = claudeAssistantRow(context, parent, messageId, block, { model, stopReason: 'tool_use' });
    append([row]);
    out({ type: 'assistant', parent_tool_use_id: null, message: row.message });
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } });
    const decision = await control({
      subtype: 'can_use_tool',
      tool_name: name,
      input,
      tool_use_id: toolUseId,
      ...(name === 'Bash' ? { description: String(input.description ?? ''), decision_reason: 'This command requires approval' } : {}),
    });
    const response = decision.response?.response ?? {};
    let result: Json;
    if (name === 'AskUserQuestion') {
      const answers = response.updatedInput?.answers;
      const text = answers && Object.keys(answers).length
        ? `User has answered your questions: ${Object.entries(answers).map(([question, answer]) => `"${question}"="${String(answer)}"`).join(', ')}. You can now continue with the user's answers in mind.`
        : 'The user did not answer the questions.';
      result = claudeToolResultRow(context, row.uuid, toolUseId, text, answers ? { toolUseResult: { questions: input.questions, answers } } : {});
    } else if (response.behavior === 'allow') {
      result = claudeToolResultRow(context, row.uuid, toolUseId, '', { toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false } });
    } else {
      result = claudeToolResultRow(context, row.uuid, toolUseId, String(response.message ?? 'Permission denied'), { isError: true });
    }
    append([result]);
    out({ type: 'user', parent_tool_use_id: null, message: result.message });
    return { decision: response, parent: result.uuid as string };
  };

  /** End an interrupted turn the way the CLI records one: the interruption row, then an aborted result. */
  const endInterrupted = (text: string, parent: string | null, toolUse: boolean): void => {
    const row = claudeUserRow(context, parent, toolUse ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]', { permissionMode, sdk: true });
    append([row]);
    out({ type: 'user', parent_tool_use_id: null, message: row.message });
    out({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: toolUse ? 'aborted_tools' : 'aborted_streaming',
      duration_ms: 3,
      num_turns: turns,
      total_cost_usd: 0.0001,
      usage: { input_tokens: 11, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    record({ kind: 'turn-end', text, sessionId, interrupted: true });
    running = undefined;
  };

  const runTurn = async (frame: Json): Promise<void> => {
    config = readConfig();
    turns += 1;
    const content = frame.message?.content;
    const text = textOf(content);
    running = text;
    interruption = new Promise((resolve) => {
      interruptTurn = () => resolve('interrupted');
    });
    try {
      await playTurn(text, content);
    } catch (error) {
      if (!(error instanceof TurnInterrupted)) throw error;
      endInterrupted(text, lastThreadUuid(transcript), error.toolUse);
    } finally {
      interruptTurn = undefined;
      interruption = new Promise(() => {});
    }
  };

  const playTurn = async (text: string, content: string | Json[]): Promise<void> => {
    if (!initSent) {
      initSent = true;
      out({
        type: 'system',
        subtype: 'init',
        cwd,
        tools: ['Bash', 'Edit', 'Read', 'Write', 'AskUserQuestion', 'Agent'],
        mcp_servers: [],
        model,
        permissionMode,
        slash_commands: config.slashCommands ?? ['compact', 'context', 'cost', 'init', 'review', 'security-review'],
        apiKeySource: 'none',
        claude_code_version: config.version,
        output_style: 'default',
      });
    }
    let parent = lastThreadUuid(transcript);
    const command = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    // A slash command is recorded as the CLI's command wrapper, then its expansion as a meta row.
    const user = command
      ? claudeUserRow(context, parent, `<command-message>${command[1]}</command-message>\n<command-name>/${command[1]}</command-name>\n<command-args>${command[2] ?? ''}</command-args>`, { permissionMode, sdk: true })
      : claudeUserRow(context, parent, content, { permissionMode, sdk: true });
    append([claudeQueueOperation(sessionId, 'dequeue'), user]);
    parent = user.uuid;
    record({ kind: 'turn', text, sessionId, transcript });
    let outcome = '';
    if (text.includes('[[permission]]')) {
      const tool = await gatedTool('Bash', { command: 'true', description: 'Run fixture command' }, parent);
      parent = tool.parent;
      outcome = ` (permission ${String(tool.decision.behavior ?? 'none')})`;
    }
    if (text.includes('[[question]]')) {
      const tool = await gatedTool('AskUserQuestion', {
        questions: [{ question: 'Which path?', header: 'Path', multiSelect: false, options: [{ label: 'Left', description: 'the left one' }, { label: 'Right', description: 'the right one' }] }],
      }, parent);
      parent = tool.parent;
      const answers = tool.decision.updatedInput?.answers;
      outcome = answers && Object.keys(answers).length ? ` (answered ${Object.values(answers).join(', ')})` : ' (question unanswered)';
    }
    const hold = /\[\[hold:([\w-]+)\]\]/.exec(text)?.[1];
    if (hold && await Promise.race([released(hold), interruption]) === 'interrupted') throw new TurnInterrupted(false);
    const visible = text.replace(/\[\[[^\]]*\]\]/g, '').trim();
    const answer = `answer: ${visible}${outcome}`;
    say(answer, 'end_turn', parent);
    out({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 3,
      duration_api_ms: 2,
      num_turns: turns,
      result: answer,
      total_cost_usd: 0.0001,
      usage: { input_tokens: 11, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      permission_denials: [],
    });
    record({ kind: 'turn-end', text, sessionId });
    running = undefined;
  };

  let chain: Promise<void> = Promise.resolve();
  const pump = (): void => {
    chain = chain.then(async () => {
      const next = queue.shift();
      if (next) await runTurn(next);
      if (stdinClosed && queue.length === 0 && running === undefined) exit('stdin-closed', 0);
    }).catch((error) => {
      record({ kind: 'fault', message: String(error) });
    });
  };

  const handle = (frame: Json): void => {
    record({ kind: 'recv', frame });
    if (frame.type === 'user') {
      const content = frame.message?.content;
      if (Array.isArray(content) && content.length && content.every((block: Json) => block?.type === 'tool_result')) {
        record({ kind: 'unimplemented', what: 'a tool_result on stdin (only gated questions are modelled)' });
        return;
      }
      // The CLI records the arrival at once; the dequeue and the row follow when the turn starts.
      append([claudeQueueOperation(sessionId, 'enqueue', typeof content === 'string' ? content : undefined)]);
      queue.push(frame);
      pump();
      return;
    }
    if (frame.type === 'control_response') {
      const id = String(frame.response?.request_id ?? '');
      const resolve = awaiting.get(id);
      awaiting.delete(id);
      if (resolve) resolve(frame);
      else record({ kind: 'fault', message: `control_response for an unknown request ${id}` });
      return;
    }
    if (frame.type === 'control_request') {
      const request = frame.request ?? {};
      const reply = (response?: Json): void => out({
        type: 'control_response',
        response: { subtype: 'success', request_id: frame.request_id, ...(response ? { response } : {}) },
      });
      if (request.subtype === 'interrupt') {
        const dropped = request.cancel_queued === true ? queue.splice(0) : [];
        record({ kind: 'interrupt', midTurn: running !== undefined, turnText: running ?? null, dropped: dropped.length });
        reply({ still_queued: [], ...(request.cancel_queued === true ? { cancelled: dropped.map(() => crypto.randomUUID()) } : {}) });
        interruptTurn?.();
        return;
      }
      if (request.subtype === 'set_model') {
        model = resolveModel(String(request.model ?? ''));
        const parent = lastThreadUuid(transcript);
        const caveat = claudeUserRow(context, parent, '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It\'s recorded here as context for later messages.</local-command-caveat>', { permissionMode, sdk: true, extra: { isMeta: true } });
        const command = claudeUserRow(context, caveat.uuid, `<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>${String(request.model ?? '')}</command-args>`, { permissionMode, sdk: true });
        const stdout = `<local-command-stdout>Set model to \`${String(request.model ?? '')} (${model})\`</local-command-stdout>`;
        const result = claudeUserRow(context, command.uuid, stdout, { permissionMode, sdk: true });
        append([caveat, command, result]);
        out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: stdout } });
        reply({ model });
        return;
      }
      if (request.subtype === 'set_permission_mode') {
        permissionMode = String(request.mode ?? permissionMode);
        out({ type: 'system', subtype: 'status', permissionMode });
        reply({ mode: permissionMode });
        return;
      }
      if (request.subtype === 'apply_flag_settings') {
        reply();
        return;
      }
    }
    record({ kind: 'unimplemented', what: String(frame.type) });
  };

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        handle(JSON.parse(line) as Json);
      } catch (error) {
        record({ kind: 'fault', message: String(error), line });
      }
    }
  });
  // As the CLI does: a closed stdin finishes the queued turns, then exits. The broker ends a child
  // with stdin EOF plus SIGTERM, and a held turn waits for that signal; the bound below only keeps a
  // fake whose broker died without signalling it from outliving the test.
  process.stdin.on('end', () => {
    stdinClosed = true;
    if (running === undefined && queue.length === 0) exit('stdin-closed', 0);
    setTimeout(() => exit('stdin-closed-held', 0), 10_000).unref();
  });
}

if (import.meta.main) runFakeClaude();
