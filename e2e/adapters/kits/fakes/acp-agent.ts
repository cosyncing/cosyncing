/**
 * A scriptable fake ACP agent, one self-contained file (node builtins only).
 *
 * `installFakeExecutable` (kit.ts) copies this file into a broker's `paths.bin`
 * under the agent's own command name, so the broker finds it exactly where it
 * would find the real CLI. Run as a program it is the fake agent; imported, it
 * only exports the native store writers the kits seed sessions with, so the
 * kit and the fake can never disagree on the store layout.
 *
 * Behaviour is data, re-read on every launch and every prompt from a JSON
 * config next to the executable, so one broker can vary it per scenario:
 *
 *   - `version` / `versionOutput`  what `--version` prints
 *   - `nextSessionId`             the id the next `session/new` answers with
 *
 * A prompt's own text scripts its turn:
 *
 *   [[permission]]   ask `session/request_permission` before answering
 *   [[hold:TAG]]     keep the turn open until `session/cancel` arrives or the
 *                    control file `release-TAG` appears
 *
 * Everything observable is appended to the ledger (JSONL): every start with
 * its argv, every version probe, every inbound frame, and every reply to a
 * request the fake made. Tests read the ledger; they never patch the fake.
 *
 * Two store flavours, matching the measured native layouts:
 *   grok      sessions/<urlencoded cwd>/<uuidv7>/{summary.json, updates.jsonl}
 *   reasonix  sessions/<id>.jsonl + .jsonl.meta, .display-index.json,
 *             .event-index.json, .acp.json
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FakeAcpConfig {
  flavor: 'grok' | 'reasonix';
  /** JSONL ledger every fake process appends to. */
  ledger: string;
  /** The agent's store root (GROK_HOME / REASONIX_HOME). */
  storeRoot: string;
  /** Directory for `release-TAG` files. */
  controlDir: string;
  /** Version token printed by `--version`. */
  version: string;
  /** Replaces the whole `--version` output when set. */
  versionOutput?: string;
  /** Grok: the `initialize` authMethods catalog (default: the measured cached_token pair). */
  authMethods?: Json[];
  /** The id the next `session/new` answers with. */
  nextSessionId: string;
  /** Grok: what `session/load` reports instead of the launch's model/effort (a build that ignored the flag). */
  loadReports?: { model?: string; effort?: string };
}

type Json = Record<string, any>;

export interface NativeSession {
  id: string;
  cwd: string;
}

// ------------------------------------------------------------------ Grok store

export function grokSessionDir(storeRoot: string, session: NativeSession): string {
  return join(storeRoot, 'sessions', encodeURIComponent(session.cwd), session.id);
}

export function grokSummary(session: NativeSession, fields: Json = {}): Json {
  const now = new Date().toISOString();
  return {
    info: { id: session.id, cwd: session.cwd },
    session_kind: 'headless',
    session_summary: 'Fake Grok session',
    created_at: now,
    updated_at: now,
    last_active_at: now,
    num_messages: 0,
    current_model_id: 'grok-4.6',
    reasoning_effort: 'high',
    agent_name: 'build',
    ...fields,
  };
}

/** One durable `updates.jsonl` record in Grok's measured shape. */
export function grokUpdate(sessionId: string, method: string, eventId: string, update: Json, promptId?: string): Json {
  return {
    timestamp: new Date().toISOString(),
    method,
    params: {
      sessionId,
      _meta: { eventId, ...(promptId ? { promptId } : {}), agentTimestampMs: Date.now() },
      update,
    },
  };
}

export function grokUserUpdate(sessionId: string, eventId: string, text: string, promptId?: string): Json {
  return grokUpdate(sessionId, 'session/update', eventId, {
    sessionUpdate: 'user_message_chunk', content: { type: 'text', text },
  }, promptId);
}

export function grokAnswerUpdate(sessionId: string, eventId: string, text: string, promptId?: string): Json {
  return grokUpdate(sessionId, 'session/update', eventId, {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text },
  }, promptId);
}

export function grokCompletedUpdate(sessionId: string, eventId: string, promptId: string, stopReason: string): Json {
  return grokUpdate(sessionId, '_x.ai/session/update', eventId, {
    sessionUpdate: 'turn_completed',
    prompt_id: promptId,
    stop_reason: stopReason,
    usage: { input_tokens: 11, output_tokens: 4 },
  }, promptId);
}

export function grokModels(): Json[] {
  return [
    { modelId: 'grok-4.6', name: 'Grok 4.6', _meta: { reasoningEfforts: [
      { value: 'high', label: 'High', default: true },
      { value: 'low', label: 'Low', default: false },
    ] } },
    { modelId: 'grok-4.5', name: 'Grok 4.5' },
  ];
}

// -------------------------------------------------------------- Reasonix store

export interface ReasonixRow {
  role: string;
  content?: string;
  [field: string]: unknown;
}

/** Reasonix v1.25.2 global layout: the transcript plus four sidecars, rewritten per append. */
export function writeReasonixFiles(
  storeRoot: string,
  session: NativeSession,
  rows: readonly ReasonixRow[],
  options: { title?: string; model?: string; mode?: string; state?: string } = {},
): void {
  const sessions = join(storeRoot, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const base = join(sessions, session.id);
  const previousMeta: Json = existsSync(`${base}.jsonl.meta`) ? JSON.parse(readFileSync(`${base}.jsonl.meta`, 'utf8')) : {};
  const previousAcp: Json = existsSync(`${base}.acp.json`) ? JSON.parse(readFileSync(`${base}.acp.json`, 'utf8')) : {};
  const revision = Number(previousMeta.revision ?? 0) + 1;
  const lines = rows.map((row) => JSON.stringify(row));
  let offset = 0;
  const entries = lines.map((line, index) => {
    const length = Buffer.byteLength(`${line}\n`);
    const role = rows[index]?.role;
    const entry = {
      index,
      offset,
      length,
      ...(typeof role === 'string' ? { role } : {}),
      authored_turn: Math.floor(index / 2),
      ...(role === 'user' ? { starts_turn: true } : {}),
    };
    offset += length;
    return entry;
  });
  const transcript = lines.length ? `${lines.join('\n')}\n` : '';
  const model = options.model ?? previousAcp.model ?? 'provider/model';
  const mode = options.mode ?? previousAcp.toolApprovalMode;
  const now = new Date().toISOString();
  writeFileSync(`${base}.jsonl`, transcript);
  writeFileSync(`${base}.display-index.json`, `${JSON.stringify({
    schema_version: 1, revision, revision_known: true,
    transcript_size: Buffer.byteLength(transcript), message_count: rows.length, entries,
  })}\n`);
  writeFileSync(`${base}.event-index.json`, `${JSON.stringify({
    schema_version: 1, revision, log_size: 97 + revision, message_count: rows.length,
    writer_id: 'reasonix-fake', content_digest: `fake-revision-${revision}`,
  })}\n`);
  writeFileSync(`${base}.jsonl.meta`, `${JSON.stringify({
    id: session.id, schema_version: 2, model,
    preview: options.title ?? previousMeta.preview ?? 'Reasonix fake session',
    turns: Math.ceil(rows.length / 2), revision,
    writer_id: 'reasonix-fake', content_digest: `fake-revision-${revision}`,
    created_at: previousMeta.created_at ?? now, updated_at: now,
  })}\n`);
  writeFileSync(`${base}.acp.json`, `${JSON.stringify({
    ...previousAcp,
    sessionId: session.id,
    cwd: session.cwd,
    title: options.title ?? previousAcp.title ?? 'Reasonix fake session',
    model,
    ...(mode ? { toolApprovalMode: mode } : {}),
    status: { state: options.state ?? 'idle' },
    updatedAt: now,
  })}\n`);
}

export function readReasonixRows(storeRoot: string, id: string): ReasonixRow[] {
  const path = join(storeRoot, 'sessions', `${id}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as ReasonixRow);
}

export function reasonixUserRow(text: string): ReasonixRow {
  return { role: 'user', content: text, raw_content: text, createdAt: Date.now() };
}

export function reasonixAssistantRow(text: string): ReasonixRow {
  return { role: 'assistant', content: text, reasoning_content: '', workDurationMs: 3 };
}

// ------------------------------------------------------------------- the agent

interface TurnStore {
  /** Extra fields of the `session/new` result. */
  newSession(session: NativeSession): Json;
  loadSession(session: NativeSession): Json;
  user(session: NativeSession, text: string, turn: number): void;
  answer(session: NativeSession, text: string, turn: number): void;
  complete(session: NativeSession, turn: number, stopReason: string): void;
  announceCommands(session: NativeSession): void;
  /** `session/set_config_option`: returns the resulting config options. */
  configure?(configId: string, value: string, session: NativeSession | undefined): Json[];
}

function runFakeAgent(): void {
  const configPath = process.env.COSYNCING_E2E_FAKE_CONFIG ?? `${process.argv[1]}.json`;
  const readConfig = (): FakeAcpConfig => JSON.parse(readFileSync(configPath, 'utf8')) as FakeAcpConfig;
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
  if (argv.includes('--version')) {
    record({ kind: 'version-probe', argv, autoUpdateDisabled: process.env.GROK_DISABLE_AUTOUPDATER ?? null });
    process.stdout.write(config.versionOutput
      ?? `${config.flavor} ${config.version}${config.flavor === 'grok' ? ' (fixture) [stable]' : ''}\n`);
    process.exit(0);
  }
  if (config.flavor === 'reasonix' && argv[0] === 'doctor' && argv.includes('--json')) {
    record({ kind: 'doctor', argv });
    process.stdout.write(`${JSON.stringify({
      providers: [
        { name: 'provider', api_key_env: 'FAKE_KEY_ENV', key_present: true, models: ['model', 'other'] },
        { name: 'second', api_key_env: 'FAKE_KEY_ENV', key_present: false, models: ['model'] },
      ],
    })}\n`);
    process.exit(0);
  }
  record({ kind: 'spawn', argv, cwd: process.cwd(), autoUpdateDisabled: process.env.GROK_DISABLE_AUTOUPDATER ?? null });

  // ---------------------------------------------------------------- transport
  const send = (message: Json): void => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  const awaitingReply = new Map<string, (message: Json) => void>();
  const request = (method: string, params: Json, id: string): Promise<Json> => new Promise((resolve) => {
    awaitingReply.set(id, resolve);
    send({ id, method, params });
  });

  // ------------------------------------------------------------ grok flavour
  const grokStore = (): TurnStore => {
    const model = argValue('--model') ?? 'grok-4.6';
    const effort = argValue('--reasoning-effort') ?? 'high';
    const mode = argValue('--permission-mode') ?? 'default';
    const promptId = (turn: number) => `prompt-${process.pid}-${turn}`;
    const eventId = (turn: number, suffix = '') => `event-${process.pid}-${turn}${suffix}`;
    const summaryPath = (session: NativeSession) => join(grokSessionDir(config.storeRoot, session), 'summary.json');
    const emit = (session: NativeSession, record: Json): void => {
      send({ method: record.method, params: record.params });
      appendFileSync(join(grokSessionDir(config.storeRoot, session), 'updates.jsonl'), `${JSON.stringify(record)}\n`);
    };
    return {
      newSession(session) {
        mkdirSync(grokSessionDir(config.storeRoot, session), { recursive: true });
        // updates.jsonl is created lazily by the first prompt, as Grok does.
        writeFileSync(summaryPath(session), `${JSON.stringify(grokSummary(session, {
          current_model_id: model, reasoning_effort: effort,
        }))}\n`);
        return {};
      },
      loadSession(session) {
        const path = summaryPath(session);
        const summary = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : grokSummary(session);
        // A launch with an explicit model/effort persists it, as Grok does.
        if (argValue('--model')) summary.current_model_id = model;
        if (argValue('--reasoning-effort')) summary.reasoning_effort = effort;
        writeFileSync(path, `${JSON.stringify(summary)}\n`);
        return {
          models: {
            currentModelId: config.loadReports?.model ?? model,
            currentReasoningEffort: config.loadReports?.effort ?? effort,
            availableModels: grokModels(),
          },
          modes: { currentModeId: mode },
        };
      },
      user(session, text, turn) {
        emit(session, grokUserUpdate(session.id, eventId(turn), text, promptId(turn)));
      },
      answer(session, text, turn) {
        emit(session, grokAnswerUpdate(session.id, eventId(turn, '-answer'), text, promptId(turn)));
      },
      complete(session, turn, stopReason) {
        emit(session, grokCompletedUpdate(session.id, eventId(turn, '-done'), promptId(turn), stopReason));
        const path = summaryPath(session);
        const summary = JSON.parse(readFileSync(path, 'utf8'));
        summary.num_messages = Number(summary.num_messages ?? 0) + 2;
        summary.last_active_at = new Date().toISOString();
        writeFileSync(path, `${JSON.stringify(summary)}\n`);
      },
      announceCommands() { /* Grok advertises commands in initialize _meta. */ },
    };
  };

  // -------------------------------------------------------- reasonix flavour
  const reasonixStore = (): TurnStore => {
    let mode = 'ask';
    let effort = 'auto';
    const model = argValue('--model') ?? 'provider/model';
    const pendingUsers = new Map<number, ReasonixRow>();
    // The measured v1.25.2 config surface: model, effort and tool approval.
    const configOptions = (): Json[] => [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [
        { value: 'provider/model', name: 'Provider Model' }, { value: 'provider/other', name: 'Provider Other' },
      ] },
      { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: effort, options: [
        { value: 'auto', name: 'Auto' }, { value: 'high', name: 'High' },
      ] },
      { id: 'tool_approval', name: 'Tool Approval', category: 'tool_approval', type: 'select', currentValue: mode, options: [
        { value: 'ask', name: 'Ask', description: 'Ask before permission-gated tool calls' },
        { value: 'auto', name: 'Auto', description: 'Follow configured permission rules without fallback prompts' },
        { value: 'yolo', name: 'Yolo', description: 'Approve tool calls except protected decisions' },
      ] },
    ];
    return {
      newSession(session) {
        // Nothing durable until the first prompt; only the inbox transaction lock.
        const inbox = join(config.storeRoot, 'sessions', `${session.id}.inbox`);
        mkdirSync(inbox, { recursive: true });
        writeFileSync(join(inbox, 'transaction.lock'), '');
        return { configOptions: configOptions() };
      },
      loadSession(session) {
        const acpPath = join(config.storeRoot, 'sessions', `${session.id}.acp.json`);
        if (existsSync(acpPath)) mode = JSON.parse(readFileSync(acpPath, 'utf8')).toolApprovalMode ?? mode;
        return {
          models: {
            currentModelId: model,
            availableModels: [
              { modelId: 'provider/model', name: 'Provider Model' },
              { modelId: 'provider/other', name: 'Provider Other' },
            ],
          },
          configOptions: configOptions(),
        };
      },
      configure(configId, value, session) {
        if (configId === 'effort') effort = value;
        if (configId !== 'tool_approval') return configOptions();
        mode = value;
        // The approval mode persists durably, as Reasonix does.
        const path = session && join(config.storeRoot, 'sessions', `${session.id}.acp.json`);
        if (path && existsSync(path)) {
          const acp = JSON.parse(readFileSync(path, 'utf8'));
          acp.toolApprovalMode = value;
          writeFileSync(path, `${JSON.stringify(acp)}\n`);
        }
        return configOptions();
      },
      user(_session, text, turn) {
        pendingUsers.set(turn, reasonixUserRow(text));
      },
      answer(session, text, turn) {
        send({ method: 'session/update', params: {
          sessionId: session.id,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        } });
        const user = pendingUsers.get(turn);
        pendingUsers.delete(turn);
        writeReasonixFiles(config.storeRoot, session, [
          ...readReasonixRows(config.storeRoot, session.id),
          ...(user ? [user] : []),
          reasonixAssistantRow(text),
        ], { mode });
      },
      complete(session, turn) {
        const user = pendingUsers.get(turn);
        pendingUsers.delete(turn);
        // A cancelled turn leaves its user row durable with no assistant row.
        if (user) writeReasonixFiles(config.storeRoot, session, [...readReasonixRows(config.storeRoot, session.id), user], { mode });
      },
      announceCommands(session) {
        send({ method: 'session/update', params: {
          sessionId: session.id,
          update: { sessionUpdate: 'available_commands_update', availableCommands: [
            { name: 'review', description: 'Review the current diff', input: { hint: '<scope>' } },
            { name: 'compact', description: 'Compact the current context', input: null },
          ] },
        } });
      },
    };
  };

  const store = config.flavor === 'grok' ? grokStore() : reasonixStore();
  let session: NativeSession | undefined;
  let turns = 0;
  let chain: Promise<void> = Promise.resolve();
  let cancelRequested = false;

  const released = (tag: string): Promise<'released' | 'cancelled'> => new Promise((resolve) => {
    const tick = (): void => {
      if (cancelRequested) return resolve('cancelled');
      if (existsSync(join(config.controlDir, `release-${tag}`))) return resolve('released');
      setTimeout(tick, 20);
    };
    tick();
  });

  const prompt = async (frame: Json): Promise<void> => {
    config = readConfig();
    const current = session;
    if (!current) {
      send({ id: frame.id, error: { code: -32602, message: 'no loaded session' } });
      return;
    }
    const text = (frame.params?.prompt ?? []).map((part: Json) => part?.text ?? '').join('');
    const turn = ++turns;
    cancelRequested = false;
    store.user(current, text, turn);
    let outcome = '';
    if (text.includes('[[permission]]')) {
      const reply = await request('session/request_permission', {
        sessionId: current.id,
        toolCall: { toolCallId: `call-${process.pid}-${turn}`, title: 'Run fixture command', rawInput: { command: 'true' } },
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
        ],
      }, `permission-${process.pid}-${turn}`);
      const selected = reply.result?.outcome;
      outcome = ` (permission ${selected?.outcome === 'selected' ? selected.optionId : 'cancelled'})`;
    }
    const hold = /\[\[hold:([\w-]+)\]\]/.exec(text)?.[1];
    if (hold && (await released(hold)) === 'cancelled') {
      store.complete(current, turn, 'cancelled');
      send({ id: frame.id, result: { stopReason: 'cancelled' } });
      return;
    }
    const visible = text.replace(/\[\[[^\]]*\]\]/g, '').trim();
    store.answer(current, `answer: ${visible}${outcome}`, turn);
    store.complete(current, turn, 'end_turn');
    send({ id: frame.id, result: { stopReason: 'end_turn' } });
  };

  const handle = (frame: Json): void => {
    record({ kind: 'recv', frame });
    if (frame.method === undefined && frame.id !== undefined) {
      const resolve = awaitingReply.get(String(frame.id));
      awaitingReply.delete(String(frame.id));
      resolve?.(frame);
      return;
    }
    switch (frame.method) {
      case 'initialize':
        send({ id: frame.id, result: config.flavor === 'grok'
          ? {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
            authMethods: config.authMethods ?? [{ id: 'cached_token', name: 'cached_token' }, { id: 'grok.com', name: 'Grok' }],
            _meta: {
              agentVersion: config.version,
              defaultAuthMethodId: 'cached_token',
              modelState: { currentModelId: 'grok-4.6', availableModels: grokModels() },
              availableCommands: [{ name: 'compact', description: 'Compact context', input: null }],
            },
          }
          : {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
            agentInfo: { name: 'reasonix-fake', version: config.version },
          } });
        return;
      case 'authenticate':
        send({ id: frame.id, result: {} });
        return;
      case 'session/new':
        config = readConfig();
        session = { id: config.nextSessionId, cwd: String(frame.params?.cwd ?? process.cwd()) };
        send({ id: frame.id, result: { sessionId: session.id, ...store.newSession(session) } });
        return;
      case 'session/load':
        session = { id: String(frame.params?.sessionId), cwd: String(frame.params?.cwd ?? process.cwd()) };
        store.announceCommands(session);
        send({ id: frame.id, result: store.loadSession(session) });
        return;
      case 'session/set_config_option':
        if (!store.configure) {
          record({ kind: 'unimplemented', method: frame.method });
          send({ id: frame.id, error: { code: -32601, message: 'fake does not implement session/set_config_option' } });
          return;
        }
        send({ id: frame.id, result: {
          configOptions: store.configure(String(frame.params?.configId), String(frame.params?.value), session),
        } });
        return;
      case 'session/prompt':
        chain = chain.then(() => prompt(frame)).catch((error) => {
          record({ kind: 'fault', message: String(error) });
          send({ id: frame.id, error: { code: -32603, message: String(error) } });
        });
        return;
      case 'session/cancel':
        cancelRequested = true;
        return;
      case 'session/close':
        send({ id: frame.id, result: {} });
        return;
      default:
        record({ kind: 'unimplemented', method: frame.method });
        if (frame.id !== undefined) {
          send({ id: frame.id, error: { code: -32601, message: `fake does not implement ${String(frame.method)}` } });
        }
    }
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
  // The broker owns this process through its stdin: when the pipe closes, the
  // fake exits, so a killed broker never leaves a fake behind.
  process.stdin.on('end', () => {
    record({ kind: 'exit', reason: 'stdin-closed' });
    process.exit(0);
  });
}

if (import.meta.main) runFakeAgent();
