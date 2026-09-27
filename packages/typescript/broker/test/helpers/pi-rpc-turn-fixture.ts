/**
 * A fake Pi / OMP RPC process that streams turns and persists them as the real runtimes do, so a
 * test can compare the keys an engine connection streams live with the keys its history read gives
 * the persisted entries. Synthetic content only; nothing here reads host data.
 *
 * The shapes follow the runtimes' own code, not a capture:
 *   - `@earendil-works/pi-agent-core` 0.78.1 `agent-loop.js` (`@oh-my-pi/pi-agent-core` 17.4.2
 *     `agent-loop.ts` emits the same events): one `message_start` and one `message_end` per
 *     message; every `message_update` carries `assistantMessageEvent` (with `contentIndex`, the
 *     delta and the provider `partial`) and `message`, a snapshot of the partial; the provider stamps
 *     the assistant message's `timestamp` once, when its stream starts; tool results arrive as
 *     `toolResult` messages after `tool_execution_end`; a steer queued while a turn runs is injected
 *     as a user message at the next `turn_start`.
 *   - `rpc-mode` forwards each session event whole (`output(event)`).
 *   - `agent-session.js` persists a message at its `message_end`, after the event reached
 *     listeners, through `session-manager.js`: `{ type: 'message', id, parentId, timestamp, message }`
 *     with an 8-hex `id` from `randomUUID()`, the key set this host's session files carry. OMP's
 *     correlated prompt is a `custom_message` entry with `customType: 'collab-prompt'`.
 *
 * `PI_RPC_TURN_FIXTURE_SOURCE` is plain JavaScript for the fake's own source. The fake must import
 * `appendFileSync`, `readFileSync` (node:fs) and `randomUUID` (node:crypto) before it, then call
 * `createPiRpcTurnFixture({ file, emit, correlated })` and route `prompt` requests to
 * `fixture.handlePrompt(req, send)`.
 *
 * Prompt text selects the turn:
 *   - `refuse …`: the first prompt with that text fails its RPC, so nothing is ever written for
 *     it; the same text sent again is accepted, as a prompt resent after Pi turned it away;
 *   - `/handled …`: accepted and taken by an extension command, so no run starts and nothing is
 *     written (agent-session `prompt`, `_tryExecuteExtensionCommand`);
 *   - `strand …`: one answer, then a pause after the loop's last queue check and before
 *     `agent_end`; a prompt sent in that pause runs in a continuation after `agent_end`;
 *   - `long …`: three steps with pauses, so a prompt sent meanwhile is steered into the turn;
 *   - `blocks …`: a message with two text blocks around a tool call, then one whose first text
 *     block stays empty;
 *   - `same clock …`: two assistant messages with one timestamp. No session file on this host has
 *     two, but nothing in the runtimes prevents it;
 *   - `clock <ms>`: one answer stamped with that timestamp, to repeat one already in the file;
 *   - `late start …`: the prompt's entry is written 300ms before the events announcing it, as the
 *     file stands while a connection has yet to read those events from the process's output;
 *   - anything else: thinking, text and a tool call, then a final thinking and text step.
 */
export const PI_RPC_TURN_FIXTURE_SOURCE = String.raw`
function createPiRpcTurnFixture({ file, emit, correlated }) {
  let clock = Date.now();
  const tick = () => (clock = Math.max(clock + 1, Date.now()));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const ids = new Set();
  let parentId = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry.id === 'string') { ids.add(entry.id); parentId = entry.id; }
    } catch {}
  }
  const newId = () => {
    for (;;) {
      const id = randomUUID().slice(0, 8);
      if (!ids.has(id)) { ids.add(id); return id; }
    }
  };
  const persist = (message) => {
    const id = newId();
    const timestamp = new Date().toISOString();
    const entry = message.role === 'custom'
      ? { type: 'custom_message', id, parentId, timestamp, customType: message.customType, content: message.content,
          display: message.display, details: message.details, attribution: message.attribution }
      : { type: 'message', id, parentId, timestamp, message };
    appendFileSync(file, JSON.stringify(entry) + '\n');
    parentId = id;
  };
  const snapshot = (value) => JSON.parse(JSON.stringify(value));
  const pieces = (text) => {
    const cut = Math.max(1, Math.ceil(text.length / 3));
    const out = [];
    for (let i = 0; i < text.length; i += cut) out.push(text.slice(i, i + cut));
    return out;
  };
  const announce = (message) => {
    emit({ type: 'message_start', message: snapshot(message) });
    emit({ type: 'message_end', message: snapshot(message) });
  };
  const inputMessage = (message) => {
    announce(message);
    persist(message);
  };
  const assistant = (blocks, stopReason, timestamp = tick()) => {
    const message = {
      role: 'assistant', content: [], api: 'fixture', provider: 'fixture', model: 'fixture',
      usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0 } },
      stopReason, timestamp,
    };
    emit({ type: 'message_start', message: snapshot(message) });
    const update = (event) => {
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
      const field = block.type === 'text' ? 'text' : 'thinking';
      message.content.push({ type: block.type, [field]: '' });
      update({ type: field + '_start', contentIndex });
      for (const piece of pieces(block[field])) {
        message.content[contentIndex][field] += piece;
        update({ type: field + '_delta', contentIndex, delta: piece });
      }
      update({ type: field + '_end', contentIndex, content: message.content[contentIndex][field] });
    });
    emit({ type: 'message_end', message: snapshot(message) });
    persist(message);
    return message;
  };
  const runTools = (message) => {
    for (const call of message.content.filter((block) => block.type === 'toolCall')) {
      emit({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments });
      const result = { content: [{ type: 'text', text: 'result of ' + call.id }], details: {} };
      emit({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, result, isError: false });
      inputMessage({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: result.content,
        details: result.details, isError: false, timestamp: tick() });
    }
  };
  let calls = 0;
  const call = (name) => ({ type: 'toolCall', id: 'call-' + (++calls), name, arguments: { path: 'fixture-' + calls + '.txt' } });
  const plan = (text) => {
    if (text.startsWith('long')) {
      return [
        { blocks: [{ type: 'thinking', thinking: 'plan the long task' }, { type: 'text', text: 'starting the long task' }, call('read')], pauseMs: 150 },
        { blocks: [{ type: 'text', text: 'still on the long task' }, call('read')], pauseMs: 150 },
        { blocks: [{ type: 'text', text: 'long task finished' }], stop: 'stop' },
      ];
    }
    if (text.startsWith('clock ')) {
      return [{ blocks: [{ type: 'text', text: 'answered on an old clock' }], stop: 'stop', timestamp: Number(text.slice('clock '.length)) }];
    }
    if (text.startsWith('same clock')) {
      return [
        { blocks: [{ type: 'text', text: 'first under one clock' }, call('read')] },
        { blocks: [{ type: 'text', text: 'second under the same clock' }], stop: 'stop', sameClock: true },
      ];
    }
    if (text.startsWith('blocks')) {
      return [
        { blocks: [{ type: 'text', text: 'before the call' }, call('read'), { type: 'text', text: 'after the call' }] },
        { blocks: [{ type: 'text', text: '' }, { type: 'thinking', thinking: 'only this one counts' }, { type: 'text', text: 'after an empty block' }], stop: 'stop' },
      ];
    }
    return [
      { blocks: [{ type: 'thinking', thinking: 'thinking about ' + text }, { type: 'text', text: 'looking at ' + text }, call('read')] },
      { blocks: [{ type: 'thinking', thinking: 'wrapping up ' + text }, { type: 'text', text: 'answered ' + text }], stop: 'stop' },
    ];
  };
  const steers = [];
  let running = false;
  const run = async (inputs, steps, strandMs = 0, persisted = false) => {
    running = true;
    emit({ type: 'agent_start' });
    emit({ type: 'turn_start' });
    for (const input of inputs) {
      if (persisted) announce(input);
      else inputMessage(input);
    }
    let previous;
    for (let i = 0; i < steps.length || steers.length > 0; i += 1) {
      const step = steps[i] ?? { blocks: [{ type: 'text', text: 'answered the steer' }], stop: 'stop' };
      if (i > 0) {
        emit({ type: 'turn_start' });
        while (steers.length > 0) inputMessage(steers.shift());
      }
      const message = assistant(step.blocks, step.stop ?? 'toolUse', step.timestamp ?? (step.sameClock ? previous.timestamp : undefined));
      previous = message;
      runTools(message);
      emit({ type: 'turn_end', message: snapshot(message), toolResults: [] });
      if (step.pauseMs) await sleep(step.pauseMs);
    }
    // The loop has drained its queue. A steer arriving now is still queued, and upstream Pi runs it
    // in a continuation after agent_end (agent-session _handlePostAgentRun).
    if (strandMs) await sleep(strandMs);
    emit({ type: 'agent_end', messages: [] });
    if (steers.length > 0) {
      await run(steers.splice(0), [{ blocks: [{ type: 'text', text: 'answered the late steer' }], stop: 'stop' }]);
      return;
    }
    running = false;
  };
  const userMessage = (raw) => {
    if (!correlated) return { role: 'user', content: [{ type: 'text', text: raw }], timestamp: tick() };
    const prefix = '/__cosyncing_rpc_prompt ';
    const payload = JSON.parse(Buffer.from(raw.slice(prefix.length), 'base64url').toString('utf8'));
    return {
      role: 'custom', customType: 'collab-prompt', content: payload.text, display: true, attribution: 'user',
      details: { from: 'cosyncing', messageKey: payload.messageKey, clientKey: payload.clientKey, sentAt: payload.sentAt },
      timestamp: tick(),
    };
  };
  const promptText = (raw) => {
    if (!correlated) return raw;
    const prefix = '/__cosyncing_rpc_prompt ';
    return JSON.parse(Buffer.from(raw.slice(prefix.length), 'base64url').toString('utf8')).text;
  };
  const refused = new Set();
  return {
    handlePrompt(req, send) {
      const raw = String(req.message ?? '');
      const text = promptText(raw);
      if (text.startsWith('refuse') && !refused.has(text)) {
        refused.add(text);
        send({ type: 'response', id: req.id, command: 'prompt', success: false, error: 'fixture refusal' });
        return;
      }
      send({ type: 'response', id: req.id, command: 'prompt', success: true });
      // Upstream Pi runs an extension command without persisting a message or starting a run.
      if (text.startsWith('/handled')) return;
      const message = userMessage(raw);
      if (running) {
        steers.push(message);
        return;
      }
      if (text.startsWith('late start')) {
        running = true;
        persist(message);
        void sleep(300).then(() => run([message], plan(text), 0, true));
        return;
      }
      void run([message], plan(text), text.startsWith('strand') ? 150 : 0);
    },
    get running() { return running; },
  };
}
`;
