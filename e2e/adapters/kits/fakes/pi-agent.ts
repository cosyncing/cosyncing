/**
 * A scriptable fake `pi` / `omp` (the Pi family's coding agents), one self-contained file (node
 * builtins only).
 *
 * `installFakeExecutable` (kit.ts) copies this file into a broker's `paths.bin` as `pi` or `omp`, so
 * the product resolves it exactly where it would find the real CLI. Run as a program it is the fake
 * agent; imported, it only exports the session-file writers the kit seeds sessions with, so the kit
 * and the fake can never disagree on the store layout.
 *
 * What it answers, as the measured runtimes do:
 *
 *   pi --version                       `pi <version>` (omp: `omp <version>`), or `versionOutput`
 *   pi --mode rpc [--session <file>]   the JSONL RPC process the broker owns: create, rename, fork,
 *                                      clone and Drive all start this
 *
 * RPC commands (one JSON object per stdin line, `{type:'response'}` per command with an id):
 * get_state, get_available_models, get_available_thinking_levels, set_model, set_thinking_level,
 * set_session_name, get_messages, get_commands (omp: get_available_commands), prompt
 * (`streamingBehavior: 'steer'` while a run is open), abort, compact, fork, clone, export_html,
 * extension_ui_response.
 *
 * Thinking levels follow the version the fake reports. Pi 0.81.0 and later, and omp 19 and later,
 * answer `get_available_thinking_levels`; an older build refuses it as an unknown command, with no
 * id (Pi 0.78.1 rpc-mode). omp 19 and later also list the current model's selectors, `auto` among
 * them, in `get_state.thinkingLevels`, and name the configured selector beside the effective level
 * (captured, omp 19.1.0).
 *
 * A turn follows the measured event order: agent_start, turn_start, the user message (omp: the
 * `collab-prompt` custom message the broker's correlated prompt creates), the assistant message
 * with one text delta, agent_end. Each message is persisted to the session file at its message_end,
 * in the measured entry shape, so Observe and Drive read the same keys. A prompt's own text scripts
 * its turn:
 *
 *   [[permission]]   an `extension_ui_request` confirm; the turn waits for the product's reply
 *   [[question]]     an `extension_ui_request` select (Left / Right); the choice rides the reply
 *   [[expiringconfirm]] a confirm the runtime stops waiting on by itself, without a word to the
 *                    client (as Pi's dialog timeout or the run's abort settles one); the turn goes on
 *   [[form]]         an omp `extension_ui_request` form (the HTML a real omp 19.1.0 `ask` sent); the
 *                    reply's `data` rides the answer
 *   [[expiringform:TAG]] an omp form the runtime stops waiting on once `release-TAG` appears: it says
 *                    so with `cancel{targetId}`, as omp 19.1.0 does at a dialog's timeout, and goes on
 *                    with the form's defaults
 *   [[background:TAG]] omp 19.1.0's yield to background work: the run ends with a non-terminal
 *                    `agent_end{awaitingAsyncWork}`; once `release-TAG` appears the runtime wakes
 *                    itself (async-result message, answer, terminal agent_end) and settles
 *   [[backgroundgone:TAG]] the same yield, but the work ends without a wake-up run: only
 *                    `session_settled` follows `release-TAG` (source-modelled; no capture had it)
 *                    An `abort` during either yield ends it without a wake-up run; the runtime then
 *                    closes the run (terminal `agent_end`, `session_settled`) once `release-TAG`
 *                    appears, and a prompt that arrives before that close runs after it
 *                    (source-modelled from omp 19.1.0, see the `abort` command)
 *   [[hold:TAG]]     keep the run open until the control file `release-TAG` appears, or `abort`
 *   [[retry]]        one failed attempt (`auto_retry_start`/`auto_retry_end`) before the answer
 *   [[tool]]         a bash tool call and its result before the answer
 *   [[warm]]         Pi only: a cache warm while the turn runs, before the answer: a `usage` entry
 *                    in the captured Pi 1.6.0 shape, announced by `entry_appended`
 *   [[warmafter]]    Pi only: the same cache warm once the run has ended, while the session is idle
 *
 * A prompt that arrives while a run is open and says `streamingBehavior: 'steer'` is injected at the
 * next turn boundary of the same run (answered in order). omp 19 and later list the queued prompts
 * in `queue_update {steering, followUp, liveSteered}` (captured, omp 19.1.0): when one is queued,
 * before the prompt's response; when one starts, between `turn_end` and `turn_start`; and when the
 * queue is cleared. Everything observable is appended to the
 * ledger (JSONL): every start with argv, cwd and the variables it inherited, every version probe,
 * every stdin command (`recv`, with the session file it reached), every turn start and end, every
 * abort, and every exit. Tests read the ledger; they never patch the fake.
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Json = Record<string, any>;

export type PiDialectName = 'pi' | 'omp';

export interface FakePiModel {
  provider: string;
  id: string;
  name: string;
  reasoning?: boolean;
  /** Pi: the model's level map (`null` drops a level; `xhigh` and `max` exist only when named). */
  thinkingLevelMap?: Record<string, string | null>;
  /** omp: the efforts the model lists (`thinking.efforts`). */
  efforts?: string[];
}

export interface FakePiConfig {
  /** JSONL ledger every fake process appends to. */
  ledger: string;
  /** Directory for `release-TAG` files. */
  controlDir: string;
  dialect: PiDialectName;
  /** Version printed by `--version`. */
  version: string;
  /** Replaces the whole `--version` output when set. */
  versionOutput?: string;
  /** What get_available_models answers. The first is the default model. */
  models: FakePiModel[];
  /** The tool's own slash commands (prompt templates, skills, extension commands). */
  commands: string[];
  /** The session file and id the next native create answers with. */
  next?: { file: string; id: string };
  /** Answer fork/clone as an extension-cancelled call. */
  cancelFork?: boolean;
  /** Fail the next prompt RPC with this error text. */
  failNextPrompt?: string;
}

/** Form HTML a real omp 19.1.0 `ask` sent (captured 2026-11-24 under `--mode rpc-ui`; an extension's
 *  `formDialog` sends the same frame under Drive's `--mode rpc`): radio, checkbox and text. */
export const OMP_CAPTURED_FORM_HTML = "<form>\n  <fieldset>\n    <legend>Color</legend>\n    <label><input type=\"radio\" name=\"color\" value=\"red\" checked> Red</label>\n    <label><input type=\"radio\" name=\"color\" value=\"blue\"> Blue</label>\n  </fieldset>\n  <fieldset>\n    <legend>Extras</legend>\n    <label><input type=\"checkbox\" name=\"extras\" value=\"cheese\"> Cheese</label>\n    <label><input type=\"checkbox\" name=\"extras\" value=\"ham\"> Ham</label>\n    <label><input type=\"checkbox\" name=\"extras\" value=\"olives\"> Olives</label>\n  </fieldset>\n  <label>Note <input type=\"text\" name=\"note\" required></label>\n</form>";
/** The form a real omp 19.1.0 `ask` sent with `timeout: 20000`, then withdrew with `cancel{targetId}`. */
export const OMP_CAPTURED_EXPIRING_FORM_HTML = "<form>\n  <p>Proceed with the deploy?</p>\n  <label><input type=\"radio\" name=\"proceed\" value=\"yes\" checked> Yes</label>\n  <label><input type=\"radio\" name=\"proceed\" value=\"no\"> No</label>\n</form>";

export const PI_FAKE_VERSION = '0.84.0';
export const OMP_FAKE_VERSION = '17.4.2';
export const PI_COLLAB_PROMPT_PREFIX = '/__cosyncing_rpc_prompt ';

// ------------------------------------------------------------------ the store

/** Pi's session directory name for a cwd. */
export function piCwdDir(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

const fileStamp = (at: number): string => new Date(at).toISOString().replace(/[:.]/g, '-');

export function piSessionFilePath(sessionsRoot: string, cwd: string, id: string, at = Date.now()): string {
  return join(sessionsRoot, piCwdDir(cwd), `${fileStamp(at)}_${id}.jsonl`);
}

const shortId = (): string => crypto.randomUUID().slice(0, 8);

export function appendLines(path: string, rows: Json[]): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
}

/** The last entry id a session file holds (the parent of the next entry). */
export function lastEntryId(path: string): string | null {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index]!.trim()) continue;
    try {
      const entry = JSON.parse(lines[index]!);
      if (typeof entry.id === 'string' && entry.type !== 'session') return entry.id;
    } catch {
      // A partial line: the writer's next append completes it.
    }
  }
  return null;
}

export function piHeader(dialect: PiDialectName, id: string, cwd: string, at: number, title?: string): Json[] {
  const header = { type: 'session', version: 3, id, timestamp: new Date(at).toISOString(), cwd };
  // omp keeps its title in a leading slot, before the header.
  return dialect === 'omp' && title ? [{ type: 'title', title }, header] : [header];
}

export function piModelEntry(dialect: PiDialectName, parentId: string | null, model: { provider: string; id: string }, at: number): Json {
  return dialect === 'omp'
    ? { type: 'model_change', id: shortId(), parentId, timestamp: new Date(at).toISOString(), model: `${model.provider}/${model.id}` }
    : { type: 'model_change', id: shortId(), parentId, timestamp: new Date(at).toISOString(), provider: model.provider, modelId: model.id };
}

export function piTitleEntry(dialect: PiDialectName, parentId: string | null, title: string, at: number): Json {
  return dialect === 'omp'
    ? { type: 'title_change', id: shortId(), parentId, timestamp: new Date(at).toISOString(), title, source: 'user', trigger: 'manual' }
    : { type: 'session_info', id: shortId(), parentId, timestamp: new Date(at).toISOString(), name: title };
}

export function piUserEntry(parentId: string | null, text: string, at: number): Json {
  return {
    type: 'message', id: shortId(), parentId, timestamp: new Date(at).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: at },
  };
}

export function piAssistantEntry(
  parentId: string | null,
  text: string,
  at: number,
  model: { provider: string; id: string },
  stopReason = 'stop',
): Json {
  return {
    type: 'message', id: shortId(), parentId, timestamp: new Date(at).toISOString(),
    message: {
      role: 'assistant',
      content: text ? [{ type: 'text', text }] : [],
      api: 'fixture', provider: model.provider, model: model.id,
      usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0 } },
      stopReason, timestamp: at,
    },
  };
}

/** The user then assistant entries of one finished turn, chained onto `parentId`. */
export function piTurnEntries(
  parentId: string | null,
  user: string,
  answer: string,
  at: number,
  model: { provider: string; id: string },
): Json[] {
  const userEntry = piUserEntry(parentId, user, at);
  const answerEntry = piAssistantEntry(userEntry.id, answer, at + 500, model);
  return [userEntry, answerEntry];
}

// ------------------------------------------------------------------ the agent

function runFakePi(): void {
  const configPath = `${process.argv[1]}.json`;
  const readConfig = (): FakePiConfig => JSON.parse(readFileSync(configPath, 'utf8')) as FakePiConfig;
  let config = readConfig();
  const argv = process.argv.slice(2);
  const record = (entry: Json): void => {
    appendFileSync(config.ledger, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`);
  };
  const argValue = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const dialect = config.dialect;

  // ---------------------------------------------------------- one-shot commands
  if (argv.includes('--version') || argv[0] === '-v') {
    record({ kind: 'version-probe', argv });
    process.stdout.write(config.versionOutput ?? `${dialect} ${config.version}\n`);
    process.exit(0);
  }
  if (argValue('--mode') !== 'rpc') {
    record({ kind: 'unimplemented', argv });
    process.stderr.write(`fake ${dialect} does not implement: ${argv.join(' ')}\n`);
    process.exit(2);
  }

  // ------------------------------------------------------------- the RPC process
  const cwd = process.cwd();
  const sessionArg = argValue('--session');
  // Pi 1.6.0 and omp 19.1.0 (captured) take the session directory from `--session-dir`, else from a
  // non-empty PI_CODING_AGENT_SESSION_DIR.
  const sessionDir = argValue('--session-dir') ?? (process.env.PI_CODING_AGENT_SESSION_DIR || undefined);
  const sessionsRoot = sessionDir
    ?? join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? '.', '.pi', 'agent'), 'sessions');
  record({
    kind: 'spawn',
    argv,
    cwd,
    session: sessionArg ?? null,
    env: {
      COSYNCING_NO_BRIDGE: process.env.COSYNCING_NO_BRIDGE ?? null,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null,
      PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR ?? null,
    },
  });

  const out = (message: Json): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const emit = (event: Json): void => out(event);

  let model: { provider: string; id: string; name?: string } = { provider: config.models[0]!.provider, id: config.models[0]!.id };
  let thinkingLevel = 'medium';
  /** omp 19.1.0: the selector set, when it differs from the effective level (`auto`). */
  let configuredThinkingLevel: string | undefined;
  const modelByArg = argValue('--model');
  if (modelByArg) {
    const slash = modelByArg.indexOf('/');
    model = slash >= 0 ? { provider: modelByArg.slice(0, slash), id: modelByArg.slice(slash + 1) } : { provider: '', id: modelByArg };
  }
  thinkingLevel = argValue('--thinking') ?? thinkingLevel;
  if (thinkingLevel === 'auto') record({ kind: 'fault', message: '--thinking auto on argv' });

  let file: string;
  let sessionId: string;
  let sessionName: string | undefined;
  if (sessionArg) {
    file = sessionArg;
    sessionId = baseId(file);
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'session' && typeof entry.id === 'string') sessionId = entry.id;
          if (entry.type === 'session_info' && typeof entry.name === 'string') sessionName = entry.name;
          if ((entry.type === 'title' || entry.type === 'title_change') && typeof entry.title === 'string') sessionName = entry.title;
          // A resumed session restores its last level, and omp its `auto` selector, unless argv names one.
          if (!argValue('--thinking') && entry.type === 'thinking_level_change') {
            if (typeof entry.thinkingLevel === 'string') thinkingLevel = entry.thinkingLevel;
            configuredThinkingLevel = entry.configured === 'auto' ? 'auto' : undefined;
          }
          if (!modelByArg && entry.type === 'model_change') {
            if (typeof entry.model === 'string' && entry.model.includes('/')) {
              model = { provider: entry.model.slice(0, entry.model.indexOf('/')), id: entry.model.slice(entry.model.indexOf('/') + 1) };
            } else if (entry.modelId) model = { provider: String(entry.provider ?? ''), id: String(entry.modelId) };
          }
        } catch {
          // A partial line.
        }
      }
    }
  } else {
    // A fresh session: the runtime names its file now and writes it with the first message.
    sessionId = crypto.randomUUID();
    file = piSessionFilePath(sessionsRoot, cwd, sessionId);
  }
  // A create adopts the session the test prepared (`next`) when it asks for state; a process that
  // first asked for the model catalog is the broker's catalog probe, not a create, and leaves it.
  let catalogProbe = false;
  const adoptPrepared = (): void => {
    if (sessionArg || catalogProbe || !config.next) return;
    ({ file, id: sessionId } = config.next);
    config = { ...config, next: undefined };
    writeFileSync(configPath, `${JSON.stringify(readConfigFromDisk(), null, 2)}\n`);
  };
  const readConfigFromDisk = (): FakePiConfig => ({ ...readConfig(), next: undefined });

  /** A catalog model in the dialect's shape: Pi carries its level map, omp its efforts. */
  const catalogModel = (entry: FakePiModel | undefined, fallback: { provider: string; id: string }): Json => ({
    provider: entry?.provider ?? fallback.provider,
    id: entry?.id ?? fallback.id,
    name: entry?.name ?? fallback.id,
    reasoning: entry?.reasoning === true,
    ...(dialect === 'pi' && entry?.thinkingLevelMap ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
    ...(dialect === 'omp' && entry?.efforts ? { thinking: { mode: 'effort', efforts: entry.efforts, requiresEffort: true } } : {}),
  });
  const currentEntry = (): FakePiModel | undefined =>
    config.models.find((candidate) => candidate.provider === model.provider && candidate.id === model.id);
  const modelObject = () => catalogModel(currentEntry(), model);

  const versionAtLeast = (major: number, minor = 0): boolean => {
    const [have = 0, haveMinor = 0] = String(config.version).split('.').map((part) => Number.parseInt(part, 10) || 0);
    return have > major || (have === major && haveMinor >= minor);
  };
  const answersThinkingLevels = (): boolean => (dialect === 'omp' ? versionAtLeast(19) : versionAtLeast(0, 81));
  const ompSelectors = (): boolean => dialect === 'omp' && versionAtLeast(19);
  /** The levels the current model takes, as `get_available_thinking_levels` lists them: Pi's map
   *  rule (`getSupportedThinkingLevels`), or omp's efforts; `off` alone without reasoning. */
  const modelLevels = (): string[] => {
    const entry = currentEntry();
    if (entry?.reasoning !== true) return ['off'];
    if (dialect === 'omp') return ['off', ...(entry.efforts ?? ['minimal', 'low', 'medium', 'high'])];
    const map = entry.thinkingLevelMap;
    return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter((level) => {
      const mapped = map?.[level];
      if (mapped === null) return false;
      return level === 'xhigh' || level === 'max' ? mapped !== undefined : true;
    });
  };
  /** omp 19.1.0's selector list: `off`, `auto`, then the efforts; empty without reasoning. */
  const selectorLevels = (): string[] => {
    const levels = modelLevels();
    return levels.length > 1 ? ['off', 'auto', ...levels.slice(1)] : [];
  };

  let clock = Date.now();
  const tick = (): number => (clock = Math.max(clock + 1, Date.now()));
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  function snapshot<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
  }

  const persist = (entry: Json): void => {
    if (!existsSync(file)) {
      appendLines(file, [...piHeader(dialect, sessionId, cwd, Date.now(), undefined)]);
    }
    appendLines(file, [{ ...entry, parentId: lastEntryId(file) }]);
  };

  // ------------------------------------------------------------ the run loop
  type Input = { text: string; raw: string; collab?: Json };
  let running = false;
  let aborted = false;
  let stopHold: (() => void) | undefined;
  /** The tag of the background wait the open yield is in, while it is in one. */
  let yieldTag: string | undefined;
  /** Set from an abort during a yield until the runtime has closed that run. */
  let abortClosing: Promise<void> | undefined;
  let turnNumber = 0;
  const steers: Input[] = [];
  const awaiting = new Map<string, (response: Json) => void>();
  /** omp 19.1.0's queue snapshot, sent whenever the queued prompts change. */
  const queueUpdate = (): void => {
    if (dialect !== 'omp' || !versionAtLeast(19)) return;
    emit({ type: 'queue_update', steering: steers.map((steer) => steer.text), followUp: [], liveSteered: 0 });
  };

  const decode = (message: string): Input => {
    if (dialect === 'omp' && message.startsWith(PI_COLLAB_PROMPT_PREFIX)) {
      const payload = JSON.parse(Buffer.from(message.slice(PI_COLLAB_PROMPT_PREFIX.length), 'base64url').toString('utf8'));
      return { text: String(payload.text ?? ''), raw: message, collab: payload };
    }
    return { text: message, raw: message };
  };

  const userMessage = (input: Input): Json => input.collab
    ? {
      role: 'custom', customType: 'collab-prompt', content: input.text, display: true, attribution: 'user',
      details: { from: 'cosyncing', messageKey: input.collab.messageKey, clientKey: input.collab.clientKey, sentAt: input.collab.sentAt },
      timestamp: tick(),
    }
    : { role: 'user', content: [{ type: 'text', text: input.text }], timestamp: tick() };

  const persistMessage = (message: Json): void => {
    if (message.role === 'custom') {
      persist({
        type: 'custom_message', id: shortId(), timestamp: new Date().toISOString(), customType: message.customType,
        content: message.content, display: message.display, details: message.details, attribution: message.attribution,
      });
    } else {
      persist({ type: 'message', id: shortId(), timestamp: new Date().toISOString(), message });
    }
  };

  const inputMessage = (message: Json): void => {
    emit({ type: 'message_start', message: snapshot(message) });
    emit({ type: 'message_end', message: snapshot(message) });
    persistMessage(message);
  };

  const assistant = (blocks: Json[], stopReason: string, persisted = true, error?: string): Json => {
    const message: Json = {
      role: 'assistant', content: [], api: 'fixture', provider: model.provider, model: model.id,
      usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0 } },
      stopReason, ...(error ? { error: { message: error } } : {}), timestamp: tick(),
    };
    emit({ type: 'message_start', message: snapshot(message) });
    const update = (event: Json): void => {
      const partial = snapshot(message);
      emit({ type: 'message_update', assistantMessageEvent: { ...event, partial }, message: partial });
    };
    blocks.forEach((block, contentIndex) => {
      if (block.type === 'toolCall') {
        message.content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: {} });
        update({ type: 'toolcall_start', contentIndex });
        message.content[contentIndex].arguments = block.arguments;
        update({ type: 'toolcall_end', contentIndex, toolCall: snapshot(message.content[contentIndex]) });
        return;
      }
      message.content.push({ type: 'text', text: '' });
      update({ type: 'text_start', contentIndex });
      // One delta carries the whole text: a client sees the answer as one row either way.
      message.content[contentIndex].text = block.text;
      update({ type: 'text_delta', contentIndex, delta: block.text });
      update({ type: 'text_end', contentIndex, content: block.text });
    });
    emit({ type: 'message_end', message: snapshot(message) });
    if (persisted) persistMessage(message);
    return message;
  };

  /** A cache warm as Pi 1.6.0 records and announces it (captured 2026-11-28; usage from the run). */
  const cacheWarm = (): void => {
    const entry: Json = {
      type: 'usage', id: shortId(), parentId: lastEntryId(file), timestamp: new Date().toISOString(),
      kind: 'cache_warm', provider: model.provider, model: model.id,
      usage: {
        input: 500, output: 1, cacheRead: 1500, cacheWrite: 0, reasoning: 0, totalTokens: 2001,
        cost: { input: 0.5, output: 0.001, cacheRead: 0.015, cacheWrite: 0, total: 0.516, totalFromProvider: false },
      },
    };
    appendLines(file, [entry]);
    emit({ type: 'entry_appended', entry: snapshot(entry) });
  };

  const released = (tag: string): Promise<void> => new Promise((resolve) => {
    stopHold = resolve;
    const tickRelease = (): void => {
      if (aborted || existsSync(join(config.controlDir, `release-${tag}`))) return resolve();
      setTimeout(tickRelease, 20);
    };
    tickRelease();
  });

  /** `release-TAG` appearing, whatever else happens meanwhile. */
  const untilReleased = (tag: string): Promise<void> => new Promise((resolve) => {
    const tickRelease = (): void => {
      if (existsSync(join(config.controlDir, `release-${tag}`))) return resolve();
      setTimeout(tickRelease, 20);
    };
    tickRelease();
  });

  const ui = (request: Json): Promise<Json> => new Promise((resolve) => {
    awaiting.set(request.id, resolve);
    emit({ type: 'extension_ui_request', ...request });
  });

  const answer = async (input: Input): Promise<void> => {
    const text = input.text;
    let outcome = '';
    if (text.includes('[[permission]]')) {
      const reply = await ui({ id: `permission-${process.pid}-${turnNumber}`, method: 'confirm', title: 'Allow command?', message: 'Run fixture command' });
      outcome = reply.confirmed === true ? ' (permission allow)' : ' (permission deny)';
    }
    if (text.includes('[[question]]')) {
      const reply = await ui({ id: `question-${process.pid}-${turnNumber}`, method: 'select', title: 'Path', message: 'Which path?', options: ['Left', 'Right'] });
      outcome = typeof reply.value === 'string' && reply.value ? ` (answered ${reply.value})` : ' (question unanswered)';
    }
    if (text.includes('[[form]]')) {
      const reply = await ui({ id: `form-${process.pid}-${turnNumber}`, method: 'form', html: OMP_CAPTURED_FORM_HTML });
      outcome = reply.cancelled === true ? ' (form cancelled)' : ` (form ${JSON.stringify(reply.data ?? null)})`;
    }
    const expiring = /\[\[expiringform:([\w-]+)\]\]/.exec(text)?.[1];
    if (expiring) {
      // omp settles the form itself at its timeout: it tells the client to close the dialog, takes
      // the form's defaults, and ignores any later reply (one here is recorded as a fault).
      const id = `form-${process.pid}-${turnNumber}-expiring`;
      awaiting.set(id, () => record({ kind: 'fault', message: `reply to a form the runtime already settled: ${id}` }));
      emit({ type: 'extension_ui_request', id, method: 'form', html: OMP_CAPTURED_EXPIRING_FORM_HTML, timeout: 20000 });
      await released(expiring);
      emit({ type: 'extension_ui_request', id: `cancel-${process.pid}-${turnNumber}`, method: 'cancel', targetId: id });
      outcome = ' (form timed out: proceed=yes)';
    }
    if (text.includes('[[tool]]')) {
      const call = { type: 'toolCall', id: `call-${process.pid}-${turnNumber}`, name: 'bash', arguments: { command: 'echo fixture' } };
      const step = assistant([call], 'toolUse');
      emit({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments });
      const result = { content: [{ type: 'text', text: 'fixture\n' }], details: { exitCode: 0 } };
      emit({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, result, isError: false });
      inputMessage({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: result.content, details: result.details, isError: false, timestamp: tick() });
      emit({ type: 'turn_end', message: snapshot(step), toolResults: [] });
      emit({ type: 'turn_start' });
    }
    if (text.includes('[[notify]]')) {
      // Fire-and-forget: the runtime awaits no reply.
      emit({ type: 'extension_ui_request', id: `notify-${process.pid}-${turnNumber}`, method: 'notify', message: 'fixture notice' });
    }
    if (text.includes('[[input]]') || text.includes('[[editor]]')) {
      const method = text.includes('[[editor]]') ? 'editor' : 'input';
      const reply = await ui({ id: `question-${process.pid}-${turnNumber}-${method}`, method, title: 'Name', message: 'Enter a name' });
      outcome = typeof reply.value === 'string' && reply.value ? ` (typed ${reply.value})` : ' (nothing typed)';
    }
    if (text.includes('[[expiringconfirm]]')) {
      // `dialog-` ids are the ones the fake raised without waiting on: a reply for one is no fault.
      emit({ type: 'extension_ui_request', id: `dialog-${process.pid}-${turnNumber}-expiring`, method: 'confirm', title: 'Expires', message: 'Nobody answers this' });
    }
    if (text.includes('[[unknowndialog]]')) {
      // A blocking dialog method this build does not know: the product must cancel it rather than hang the turn.
      emit({ type: 'extension_ui_request', id: `dialog-${process.pid}-${turnNumber}`, method: 'custom-widget', title: 'Unknown' });
    }
    if (text.includes('[[retryfail]]')) {
      // The failed attempt, then the runtime gives up: the last error message stays the turn's final entry.
      assistant([], 'error', true, 'rate limited');
      emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 10, errorMessage: '429 rate limited' });
      emit({ type: 'auto_retry_end', success: false, attempt: 2, finalError: '429 rate limited\nretry-after: 1' });
      return;
    }
    if (text.includes('[[retry]]')) {
      assistant([], 'error', false);
      emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: '429 rate limited' });
      emit({ type: 'auto_retry_end', success: true, attempt: 1 });
    }
    if (text.includes('[[warm]]') && dialect === 'pi') cacheWarm();
    const hold = /\[\[hold:([\w-]+)\]\]/.exec(text)?.[1];
    if (hold) await released(hold);
    if (aborted) {
      assistant([], 'aborted');
      return;
    }
    const visible = text.replace(/\[\[[^\]]*\]\]/g, '').trim();
    assistant([{ type: 'text', text: `answer: ${visible}${outcome}` }], 'stop');
  };

  const run = async (first: Input): Promise<void> => {
    running = true;
    aborted = false;
    const heldStart = /\[\[hold-start:([\w-]+)\]\]/.exec(first.text)?.[1];
    if (heldStart) await released(heldStart);
    emit({ type: 'agent_start' });
    let input: Input | undefined = first;
    while (input) {
      turnNumber += 1;
      emit({ type: 'turn_start' });
      inputMessage(userMessage(input));
      record({ kind: 'turn', text: input.text, session: file, model: model.id });
      try {
        await answer(input);
      } catch (error) {
        record({ kind: 'fault', message: String(error) });
      }
      record({ kind: 'turn-end', text: input.text, session: file, aborted });
      emit({ type: 'turn_end', toolResults: [] });
      const queued = steers.length;
      if (aborted) steers.length = 0;
      input = steers.shift();
      if (queued) queueUpdate();
    }
    const background = /\[\[background(gone)?:([\w-]+)\]\]/.exec(first.text);
    if (background && !aborted) {
      // omp 19.1.0 (captured): the run yields to work it started in the background. The session
      // accepts prompts meanwhile, and is settled only once that work is done.
      emit({ type: 'agent_end', messages: [], isTerminal: false, yielded: true, awaitingAsyncWork: true });
      running = false;
      yieldTag = background[2]!;
      await released(background[2]!);
      // An abort ended the wait: the `abort` command closes the run, and nothing wakes it.
      if (aborted) return;
      yieldTag = undefined;
      // `[[backgroundgone]]` is source-modelled, not captured: omp's async-job manager settles the
      // session without a wake-up run when no result is left to deliver (a killed job, or a result
      // another turn already took). Every capture woke up.
      if (!background[1]) {
        running = true;
        emit({ type: 'agent_start' });
        turnNumber += 1;
        emit({ type: 'turn_start' });
        const notice: Json = {
          role: 'custom', customType: 'async-result', display: true, attribution: 'agent',
          content: '<system-notice>\nBackground job bg_1 (fixture) has completed.\n</system-notice>', timestamp: tick(),
        };
        emit({ type: 'message_start', message: snapshot(notice) });
        emit({ type: 'message_end', message: snapshot(notice) });
        persistMessage(notice);
        assistant([{ type: 'text', text: 'background done' }], 'stop');
        record({ kind: 'turn-end', text: 'background wake-up', session: file, aborted: false });
        emit({ type: 'turn_end', toolResults: [] });
        emit({ type: 'agent_end', messages: [], isTerminal: true, yielded: true });
        running = false;
      }
      emit({ type: 'session_settled' });
      return;
    }
    emit({ type: 'agent_end', messages: [] });
    running = false;
    if (first.text.includes('[[warmafter]]') && dialect === 'pi') cacheWarm();
  };

  // ------------------------------------------------------------ the commands
  const respond = (command: Json, payload: Json): void => {
    if (command.id === undefined) return;
    out({ type: 'response', id: command.id, command: command.type, ...payload });
  };
  const ok = (command: Json, data: Json = {}): void => respond(command, { success: true, data });
  const fail = (command: Json, error: string): void => respond(command, { success: false, error });

  const state = (): Json => ({
    sessionFile: file,
    sessionId,
    ...(sessionName ? { sessionName } : {}),
    model: modelObject(),
    thinkingLevel,
    ...(ompSelectors() ? { configuredThinkingLevel: configuredThinkingLevel ?? thinkingLevel, thinkingLevels: selectorLevels() } : {}),
    isStreaming: running,
  });

  const switchTo = (next: string, nextId: string): void => {
    file = next;
    sessionId = nextId;
  };

  const handle = (command: Json): void => {
    // Read only after an aborted yield's close (see `abort`): recorded when it is handled.
    if (abortClosing && command.type === 'prompt') {
      void abortClosing.then(() => handle(command));
      return;
    }
    record({ kind: 'recv', session: file, model: model.id, frame: command });
    switch (command.type) {
      case 'get_state':
        adoptPrepared();
        return ok(command, state());
      case 'get_available_models':
        catalogProbe = true;
        return ok(command, { models: config.models.map((entry) => catalogModel(entry, entry)) });
      case 'get_available_thinking_levels':
        if (!answersThinkingLevels()) {
          // An older build's refusal of a command it lacks carries no id. The product asks on purpose
          // (to learn whether the build has it), so this is no fault.
          return out({ type: 'response', command: command.type, success: false, error: `Unknown command: ${String(command.type)}` });
        }
        return ok(command, { levels: modelLevels() });
      case 'set_model': {
        const known = config.models.find((entry) => entry.provider === command.provider && entry.id === command.modelId);
        if (!known) return fail(command, `Model not found: ${String(command.provider)}/${String(command.modelId)}`);
        model = { provider: known.provider, id: known.id };
        if (existsSync(file)) persist(piModelEntry(dialect, null, model, Date.now()));
        return ok(command, modelObject());
      }
      case 'set_thinking_level': {
        const level = String(command.level);
        if (level === 'auto') {
          if (!ompSelectors() || !selectorLevels().includes('auto')) {
            record({ kind: 'fault', message: `set_thinking_level auto on ${dialect} ${config.version} (${model.id})` });
            return fail(command, `Invalid thinking level: ${level}`);
          }
          // Captured: auto mode reports the level it resolved to beside the `auto` selector.
          configuredThinkingLevel = 'auto';
          thinkingLevel = 'high';
          return ok(command);
        }
        configuredThinkingLevel = undefined;
        thinkingLevel = level;
        return ok(command);
      }
      case 'set_session_name': {
        const requested = String(command.name ?? '');
        // Measured omp behaviour: an empty name is rejected, so a rename cannot clear an omp title.
        if (dialect === 'omp' && !requested.trim()) return fail(command, 'Session name cannot be empty');
        // A failure whose native text must never reach a client.
        if (requested.startsWith('fail-secret')) return fail(command, 'FAKE_RUNTIME_SECRET token=sk-fixture-secret path=/root/.pi');
        sessionName = requested;
        // A runtime records the name once the file exists; a fresh session persists it with its first message.
        if (existsSync(file)) persist(piTitleEntry(dialect, null, sessionName, Date.now()));
        return ok(command);
      }
      case 'get_messages':
        return ok(command, { messages: [] });
      case 'get_session_stats': {
        // The shape Pi documents (rpc-commands.md): cost at the root, the context window inside contextUsage.
        const entries = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
        return ok(command, {
          sessionFile: file,
          sessionId,
          userMessages: turnNumber,
          assistantMessages: turnNumber,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: turnNumber * 2,
          tokens: { input: 3 * turnNumber, output: 2 * turnNumber, cacheRead: 0, cacheWrite: 0, total: 5 * turnNumber },
          cost: 0.0042,
          contextUsage: { tokens: 1000 + entries, contextWindow: 200_000, percent: 0.5 },
        });
      }
      case 'get_commands':
      case 'get_available_commands':
        return ok(command, {
          commands: [
            ...config.commands.map((name) => ({ name, description: `${name} (fixture)`, source: 'prompt' })),
            ...(dialect === 'omp' ? [{ name: '__cosyncing_rpc_prompt', description: 'broker correlated prompt', source: 'extension' }] : []),
          ],
        });
      case 'prompt': {
        if (config.failNextPrompt) {
          const error = config.failNextPrompt;
          config = { ...config, failNextPrompt: undefined };
          writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
          return fail(command, error);
        }
        const input = decode(String(command.message ?? ''));
        if (running && command.streamingBehavior !== 'steer') return fail(command, 'Agent is already processing a prompt.');
        if (running) {
          steers.push(input);
          queueUpdate();
        }
        ok(command);
        if (!running) void run(input).catch((error) => record({ kind: 'fault', message: String(error) }));
        return;
      }
      case 'abort': {
        record({ kind: 'abort', session: file, midTurn: running });
        aborted = true;
        stopHold?.();
        if (yieldTag && !running) {
          // omp 19.1.0 source (source-modelled, not captured): `abort` awaits `session.abort`
          // (rpc-mode.ts). A paused run counts as stoppable, so the abort sets
          // `autoResumeSuppressed` and the awaited work wakes nothing; once the abort has unwound,
          // `#checkRun` closes the run and emits its stored agent_end, which the wire encodes
          // terminal (`#closeRun`, loop-end-wire.ts), and the session settles. Prompts start through
          // the serial command queue behind the abort, so one sent meanwhile runs after the close.
          // The fake holds that close until `release-TAG`.
          const tag = yieldTag;
          yieldTag = undefined;
          abortClosing = untilReleased(tag).then(() => {
            abortClosing = undefined;
            record({ kind: 'yield-closed', session: file });
            emit({ type: 'agent_end', messages: [], isTerminal: true, yielded: true });
            emit({ type: 'session_settled' });
          });
        }
        return ok(command);
      }
      case 'compact': {
        ok(command, {});
        emit({ type: 'compaction_start', reason: 'manual' });
        persist({ type: 'compaction', id: shortId(), timestamp: new Date().toISOString(), summary: 'fixture summary', firstKeptEntryId: lastEntryId(file), tokensBefore: 10 });
        emit({ type: 'compaction_end', reason: 'manual', aborted: false });
        return;
      }
      case 'fork':
      case 'clone': {
        // omp has no clone, and its RPC fork exists only from 19 on (17.4.2 has none).
        const ompFork = dialect === 'omp' && Number(String(config.version).split('.')[0]) >= 19;
        if (dialect === 'omp' && (command.type === 'clone' || !ompFork)) {
          record({ kind: 'unimplemented', what: String(command.type) });
          return fail(command, `Unknown command: ${String(command.type)}`);
        }
        if (config.cancelFork) return ok(command, { cancelled: true });
        const copyId = crypto.randomUUID();
        // Captured `SessionManager.open` (Pi 1.6.0, omp 19.1.0): the copy goes flat into the session
        // directory, and a session opened without one writes beside its own file.
        const copy = join(sessionDir ?? dirname(sessionArg ?? file), `${fileStamp(Date.now())}_${copyId}.jsonl`);
        mkdirSync(dirname(copy), { recursive: true });
        const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()) : [];
        let kept = lines;
        // Pi forks just before the chosen user entry and needs one; omp 19.1.0 (captured) keeps the
        // chosen entry, and a bare fork copies the whole session.
        if (command.type === 'fork' && (dialect !== 'omp' || command.entryId !== undefined)) {
          const at = lines.findIndex((line) => { try { return JSON.parse(line).id === command.entryId; } catch { return false; } });
          if (at < 0) return fail(command, 'Invalid entry ID for forking');
          kept = lines.slice(0, dialect === 'omp' ? at + 1 : at);
        }
        const rewritten = kept.map((line) => {
          const entry = JSON.parse(line);
          return entry.type === 'session' ? JSON.stringify({ ...entry, id: copyId, parentSession: file }) : line;
        });
        if (!rewritten.length) rewritten.push(JSON.stringify(piHeader(dialect, copyId, cwd, Date.now())[0]));
        writeFileSync(copy, `${rewritten.join('\n')}\n`);
        switchTo(copy, copyId);
        return ok(command, command.type === 'fork' && dialect !== 'omp' ? { cancelled: false, text: '' } : { cancelled: false });
      }
      case 'export_html': {
        const target = String(command.outputPath ?? '');
        if (!target) return fail(command, 'outputPath is required');
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, `<!doctype html><title>${sessionId}</title>`);
        return ok(command, { path: target });
      }
      case 'extension_ui_response': {
        const resolve = awaiting.get(String(command.id));
        awaiting.delete(String(command.id));
        if (resolve) resolve(command);
        // A dialog the fake raised without waiting on it (an unknown method the product cancels at once).
        else if (!String(command.id).startsWith('dialog-')) record({ kind: 'fault', message: `extension_ui_response for an unknown request ${String(command.id)}` });
        return;
      }
      default:
        record({ kind: 'unimplemented', what: String(command.type) });
        return fail(command, `unimplemented command: ${String(command.type)}`);
    }
  };

  const exit = (reason: string, code: number): never => {
    record({ kind: 'exit', reason, midTurn: running });
    process.exit(code);
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      record({ kind: 'signal', signal, midTurn: running });
      exit(signal, 143);
    });
  }

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line) as Json);
      } catch (error) {
        record({ kind: 'fault', message: String(error), line });
      }
    }
  });
  // As the runtimes do: a closed stdin ends the process. A held run waits for the signal; the bound
  // only keeps a fake whose broker died without signalling it from outliving the test.
  process.stdin.on('end', () => {
    if (!running) exit('stdin-closed', 0);
    setTimeout(() => exit('stdin-closed-held', 0), 10_000).unref();
  });
  void renameSync;
  void copyFileSync;
  void sleep;
}

function baseId(file: string): string {
  return (file.split(/[\\/]/).pop() ?? file).replace(/\.jsonl$/, '').split('_').pop() ?? file;
}

if (import.meta.main) runFakePi();
