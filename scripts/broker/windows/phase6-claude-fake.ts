#!/usr/bin/env bun
/**
 * A fake `claude` for the Phase 6 Claude slice: enough of the stream-json protocol for the adapter's
 * resume Drive path, and nothing else. The product ships `COSYNCING_CLAUDE_BIN` for exactly this.
 *
 * Faithful in the two ways that matter on Windows:
 *   - It records its OWN pid to a file. The broker's spawn handle is the `.cmd` shim, not this
 *     process, so "did the child die" cannot be answered from the handle — it has to be answered
 *     about the process that is actually doing the work.
 *   - It does NOT exit when stdin closes. A real `claude` mid-turn has a request in flight and does
 *     not quit because a pipe end went away; a fake that exits on EOF would make every termination
 *     look clean and prove nothing.
 * It exits only when something terminates it.
 */
export {};

const args = process.argv.slice(2);
const driveAt = args.findIndex((arg) => arg === '--resume' || arg === '--session-id');

// Behave per invocation, or the evidence is worthless. The adapter also runs `<bin> agents --json`
// (execFile, 2s timeout) for live status. A fake that never exits turns THAT short probe into a
// lingering process, and a probe asking "did the drive child survive?" then measures the wrong one.
// Only a drive launch records a pid; everything else answers and exits like the real CLI does.
if (driveAt < 0) {
  if (args[0] === 'agents') process.stdout.write('[]\n');
  else if (args.includes('--version')) process.stdout.write('phase6-fake 0.0.0\n');
  process.exit(0);
}

const sessionId = args[driveAt + 1] ?? 'unknown';
const pidFile = process.env.COSYNCING_PHASE6_CLAUDE_PIDFILE;
if (pidFile) await Bun.write(pidFile, String(process.pid));
const argvFile = process.env.COSYNCING_PHASE6_CLAUDE_ARGV;
if (argvFile) await Bun.write(argvFile, JSON.stringify(args));

const out = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };

out({ type: 'system', subtype: 'init', session_id: sessionId, tools: [], slash_commands: [], model: 'fake-model' });

let turn = 0;
const answer = (text: string): void => {
  turn += 1;
  const id = `msg_fake_${turn}`;
  out({
    type: 'assistant',
    session_id: sessionId,
    message: {
      id,
      role: 'assistant',
      model: 'fake-model',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  out({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    is_error: false,
    duration_ms: 1,
    num_turns: turn,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
};

const reply = process.env.COSYNCING_PHASE6_CLAUDE_REPLY ?? 'PHASE6-CLAUDE-OK';
const decoder = new TextDecoder();
let buffered = '';
(async () => {
  const reader = Bun.stdin.stream().getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    buffered += decoder.decode(next.value, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed?.type === 'user') answer(reply);
      } catch { /* a line we do not model */ }
    }
  }
})();

// Outlive stdin on purpose. Only termination ends this process.
setInterval(() => {}, 1_000);
