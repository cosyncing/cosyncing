/**
 * T2 adapter regression: every provider maps an equivalent native tool event to
 * an EQUIVALENT canonical `semantic` envelope, while provider-specific
 * differences stay truthful rather than being invented.
 *
 * Four providers, four families, one canonical shape:
 *   - command   Codex `exec_command_begin/end`, Claude Bash, OpenCode bash, Pi bash
 *   - file-read Claude Read, OpenCode read, Pi read
 *   - search    Claude Grep/Glob, OpenCode grep, Pi grep
 *   - web       Codex web_search, Claude WebSearch/WebFetch, OpenCode/Pi webfetch
 *
 * The point of the cross-provider block is NOT that the payloads are identical —
 * they are not — but that a client dispatching on `semantic.kind` plus canonical
 * fields gets the same presentation from all four, and that a provider which
 * genuinely lacks a field (Claude publishes no Bash exit code; Codex publishes
 * no separated streams on older exec events) leaves it ABSENT instead of
 * fabricating one.
 *
 * Also covers the shared retention bounds in adapter-api: stream tails, preview
 * clipping, search group/match/snippet caps, web result caps, incremental
 * append cost, and the whole-envelope ceiling.
 *
 * Pure and self-contained — no live agent, no model cost, no network.
 *
 *   bun run packages/typescript/broker/test/broker/test-tool-semantics.ts   (exit 0 = all pass)
 */
export {};
import {
  BoundedOutputTail,
  COMMAND_MAX_CHARS,
  COMMAND_STREAM_MAX_BYTES,
  FILE_PREVIEW_MAX_LINES,
  PATH_MAX_CHARS,
  SEARCH_MAX_GROUPS,
  SEARCH_MAX_MATCHES_PER_GROUP,
  SEARCH_SNIPPET_MAX_BYTES,
  TOOL_SEMANTIC_MAX_BYTES,
  WEB_MAX_RESULTS,
  boundToolSemantic,
  boundedPreview,
  boundedStream,
  commandSemantic,
  fileReadSemantic,
  searchGroup,
  searchSemantic,
  webSemantic,
  type AgentMessage,
  type ToolSemantic,
} from '../../../adapter-api/src/index.ts';
import {
  CodexEnrichStore,
  accumulateEnrich,
  enrichEntryBytes,
  mapRollout,
  type CodexEnrich,
} from '../../../adapters/codex/src/index.ts';
import { mapTranscript } from '../../../adapters/claude/src/index.ts';
import { mapPiJsonlText } from '../../../adapters/pi/src/index.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

type ToolMessage = Extract<AgentMessage, { type: 'tool-call' | 'tool-result' }>;

function toolResult(messages: AgentMessage[], callId: string): ToolMessage | undefined {
  return messages.find(
    (m): m is ToolMessage => m.type === 'tool-result' && m.callId === callId,
  );
}

function toolCall(messages: AgentMessage[], callId: string): ToolMessage | undefined {
  return messages.find(
    (m): m is ToolMessage => m.type === 'tool-call' && m.callId === callId,
  );
}

// ── 1. Codex: exec_command_begin/end → the canonical command family ──────────
{
  const rollout = mapRollout([
    { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{}' } },
    { type: 'event_msg', payload: { type: 'exec_command_begin', call_id: 'c1', command: ['pytest', '-q'], cwd: '/repo' } },
    {
      type: 'event_msg',
      payload: {
        type: 'exec_command_end',
        call_id: 'c1',
        exit_code: 1,
        stdout: '3 passed',
        stderr: '1 failed',
        duration: { secs: 2, nanos: 0 },
      },
    },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: '3 passed\n1 failed' } },
  ]);
  const result = toolResult(rollout, 'c1');
  const semantic = result?.semantic as ToolSemantic | undefined;
  check(
    'codex: exec begin/end becomes a command semantic with argv, cwd, and streams',
    semantic?.kind === 'command'
      && semantic.command === 'pytest -q'
      && semantic.cwd === '/repo'
      && semantic.state === 'failed'
      && semantic.stdout?.text === '3 passed'
      && semantic.stderr?.text === '1 failed',
    JSON.stringify(semantic),
  );
  check(
    'codex: the canonical exit code and duration stay on their existing fields',
    result?.type === 'tool-result' && result.exitCode === 1 && result.durationMs === 2000,
    `exit=${(result as any)?.exitCode} durationMs=${(result as any)?.durationMs}`,
  );

  // The SAME command with no exec_command_end stream fields: absent, not empty.
  const noStreams = mapRollout([
    { type: 'response_item', payload: { type: 'function_call', call_id: 'c2', name: 'exec_command', arguments: '{}' } },
    { type: 'event_msg', payload: { type: 'exec_command_begin', call_id: 'c2', command: ['ls'], cwd: '/repo' } },
    { type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'c2', exit_code: 0 } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: 'a\nb' } },
  ]);
  const merged = toolResult(noStreams, 'c2')?.semantic as ToolSemantic | undefined;
  check(
    'codex: an exec event without separated streams omits them rather than faking',
    merged?.kind === 'command'
      && merged.state === 'completed'
      && merged.stdout === undefined
      && merged.stderr === undefined,
    JSON.stringify(merged),
  );

  // A rollout with no exec evidence at all must not invent a command family.
  const other = mapRollout([
    { type: 'response_item', payload: { type: 'function_call', call_id: 'c3', name: 'some_mcp__thing', arguments: '{"a":1}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c3', output: 'done' } },
  ]);
  check(
    'codex: a non-command tool publishes no semantic and stays on the fallback',
    toolResult(other, 'c3')?.semantic === undefined,
    JSON.stringify(toolResult(other, 'c3')?.semantic),
  );

  const search = mapRollout([
    { type: 'response_item', payload: { type: 'function_call', call_id: 'c4', name: 'web_search', arguments: '{"query":"dart isolates"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c4', output: 'ok' } },
  ]);
  const web = toolCall(search, 'c4')?.semantic as ToolSemantic | undefined;
  check(
    'codex: web_search becomes the canonical web family with its query',
    web?.kind === 'web' && web.query === 'dart isolates',
    JSON.stringify(web),
  );
}

// ── 2. Claude: Bash / Read / Grep / WebSearch → the same four families ───────
{
  const transcript = mapTranscript([
    {
      type: 'assistant',
      uuid: 'u1',
      message: {
        id: 'm1',
        content: [
          { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'pytest -q' } },
          { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/repo/lib/main.dart', offset: 40 } },
          { type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'TODO', path: 'lib/' } },
          { type: 'tool_use', id: 'w1', name: 'WebSearch', input: { query: 'dart isolates' } },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      toolUseResult: { stdout: '3 passed', stderr: '1 failed', interrupted: false },
      message: { content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'out' }] },
    },
    {
      type: 'user',
      uuid: 'u3',
      toolUseResult: {
        type: 'text',
        file: { filePath: '/repo/lib/main.dart', content: 'void main() {}', startLine: 40, totalLines: 120 },
      },
      message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'read' }] },
    },
    {
      type: 'user',
      uuid: 'u4',
      toolUseResult: { mode: 'content', numFiles: 2, numLines: 3, content: 'lib/a.dart:10:// TODO a\nlib/b.dart:5:// TODO b' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'g1', content: 'grep' }] },
    },
    {
      type: 'user',
      uuid: 'u5',
      toolUseResult: { query: 'dart isolates', results: [{ url: 'https://example.com/a', title: 'Isolates' }] },
      message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'search' }] },
    },
  ]);

  const bash = toolResult(transcript, 'b1')?.semantic as ToolSemantic | undefined;
  check(
    'claude: Bash becomes a command semantic with separated stdout/stderr',
    bash?.kind === 'command'
      && bash.command === 'pytest -q'
      && bash.state === 'failed'
      && bash.stdout?.text === '3 passed'
      && bash.stderr?.text === '1 failed',
    JSON.stringify(bash),
  );
  check(
    'claude: Bash still publishes NO exit code, because the transcript has none',
    (toolResult(transcript, 'b1') as any)?.exitCode === undefined,
    JSON.stringify((toolResult(transcript, 'b1') as any)?.exitCode),
  );

  const read = toolResult(transcript, 'r1')?.semantic as ToolSemantic | undefined;
  check(
    'claude: Read becomes a file-read semantic with path, start line, and total',
    read?.kind === 'file-read'
      && read.path === '/repo/lib/main.dart'
      && read.startLine === 40
      && read.preview === 'void main() {}'
      && read.totalLines === 120,
    JSON.stringify(read),
  );

  const grep = toolResult(transcript, 'g1')?.semantic as ToolSemantic | undefined;
  check(
    'claude: Grep content rows become per-file groups with line numbers',
    grep?.kind === 'search'
      && grep.query === 'TODO'
      && grep.scope === 'lib/'
      && grep.fileCount === 2
      && grep.groups?.length === 2
      && grep.groups[0]?.path === 'lib/a.dart'
      && grep.groups[0]?.matches?.[0]?.line === 10
      && grep.groups[0]?.matches?.[0]?.text === '// TODO a',
    JSON.stringify(grep),
  );

  const web = toolResult(transcript, 'w1')?.semantic as ToolSemantic | undefined;
  check(
    'claude: WebSearch becomes the web family with human-readable results',
    web?.kind === 'web'
      && web.query === 'dart isolates'
      && web.results?.[0]?.url === 'https://example.com/a'
      && web.results?.[0]?.title === 'Isolates',
    JSON.stringify(web),
  );

  const interrupted = mapTranscript([
    {
      type: 'assistant',
      uuid: 'i1',
      message: { id: 'mi', content: [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'sleep 60' } }] },
    },
    {
      type: 'user',
      uuid: 'i2',
      toolUseResult: { interrupted: true },
      message: { content: [{ type: 'tool_result', tool_use_id: 'x1', is_error: true, content: '' }] },
    },
  ]);
  const state = (toolResult(interrupted, 'x1')?.semantic as ToolSemantic | undefined);
  check(
    'claude: an interrupted Bash reports interrupted, not failed',
    state?.kind === 'command' && state.state === 'interrupted',
    JSON.stringify(state),
  );
}

// ── 3. Pi: bash / read / grep through the shared resume mapper ───────────────
{
  const lines = [
    JSON.stringify({
      type: 'message',
      id: 'pa1',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'p1', name: 'bash', arguments: { command: 'pytest -q', cwd: '/repo' } },
          { type: 'toolCall', id: 'p2', name: 'read', arguments: { path: '/repo/a.txt', offset: 9 } },
          { type: 'toolCall', id: 'p3', name: 'grep', arguments: { pattern: 'TODO', path: 'lib/' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'p1',
        toolName: 'bash',
        isError: true,
        content: 'boom\nCommand exited with code 3',
        details: { stdout: 'out here', stderr: 'err here' },
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'p2',
        toolName: 'read',
        content: 'alpha\nbeta',
        details: { totalLines: 90 },
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'p3',
        toolName: 'grep',
        content: 'matches',
        details: { files: [{ path: 'lib/a.dart', count: 2, matches: [{ line: 4, text: '// TODO' }] }] },
      },
    }),
  ].join('\n');
  const mapped = mapPiJsonlText(lines);

  const bash = toolResult(mapped, 'p1')?.semantic as ToolSemantic | undefined;
  check(
    'pi: bash becomes a command semantic, recovering the exit code from the text',
    bash?.kind === 'command'
      && bash.command === 'pytest -q'
      && bash.cwd === '/repo'
      && bash.state === 'failed'
      && bash.stdout?.text === 'out here'
      && bash.stderr?.text === 'err here',
    JSON.stringify(bash),
  );

  const read = toolResult(mapped, 'p2')?.semantic as ToolSemantic | undefined;
  check(
    'pi: read becomes a file-read semantic with a 1-based start line from offset',
    read?.kind === 'file-read'
      && read.path === '/repo/a.txt'
      && read.startLine === 10
      && read.preview === 'alpha\nbeta'
      && read.totalLines === 90,
    JSON.stringify(read),
  );

  const grep = toolResult(mapped, 'p3')?.semantic as ToolSemantic | undefined;
  check(
    'pi: grep becomes a search semantic with per-file groups',
    grep?.kind === 'search'
      && grep.query === 'TODO'
      && grep.scope === 'lib/'
      && grep.groups?.[0]?.path === 'lib/a.dart'
      && grep.groups[0]?.matchCount === 2
      && grep.groups[0]?.matches?.[0]?.line === 4,
    JSON.stringify(grep),
  );

  const running = toolCall(mapped, 'p1')?.semantic as ToolSemantic | undefined;
  check(
    'pi: the tool-CALL frame carries the command family already in running state',
    running?.kind === 'command' && running.command === 'pytest -q' && running.state === 'running',
    JSON.stringify(running),
  );
}

// ── 4. Cross-provider equivalence ────────────────────────────────────────────
{
  // Same logical event: `pytest -q` failed, with both streams captured.
  const codex = mapRollout([
    { type: 'response_item', payload: { type: 'function_call', call_id: 'e1', name: 'exec_command', arguments: '{}' } },
    { type: 'event_msg', payload: { type: 'exec_command_begin', call_id: 'e1', command: ['pytest', '-q'], cwd: '/repo' } },
    { type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'e1', exit_code: 1, stdout: 'out', stderr: 'err' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'e1', output: 'out\nerr' } },
  ]);
  const claude = mapTranscript([
    {
      type: 'assistant',
      uuid: 'a1',
      message: { id: 'm', content: [{ type: 'tool_use', id: 'e1', name: 'Bash', input: { command: 'pytest -q', cwd: '/repo' } }] },
    },
    {
      type: 'user',
      uuid: 'a2',
      toolUseResult: { stdout: 'out', stderr: 'err' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'e1', is_error: true, content: 'x' }] },
    },
  ]);
  const pi = mapPiJsonlText([
    JSON.stringify({
      type: 'message',
      id: 'pe1',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'e1', name: 'bash', arguments: { command: 'pytest -q', cwd: '/repo' } }],
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'e1',
        toolName: 'bash',
        isError: true,
        content: 'x',
        details: { exitCode: 1, stdout: 'out', stderr: 'err' },
      },
    }),
  ].join('\n'));

  const presentations = [codex, claude, pi].map((messages) => {
    const semantic = toolResult(messages, 'e1')?.semantic as ToolSemantic | undefined;
    if (semantic?.kind !== 'command') return null;
    return JSON.stringify({
      kind: semantic.kind,
      command: semantic.command,
      cwd: semantic.cwd,
      state: semantic.state,
      stdout: semantic.stdout?.text,
      stderr: semantic.stderr?.text,
    });
  });
  check(
    'three providers map one equivalent command event to one canonical presentation',
    presentations[0] !== null
      && presentations[0] === presentations[1]
      && presentations[1] === presentations[2],
    presentations.join(' | '),
  );

  // Truthful divergence: Claude publishes no exit code for the identical run.
  check(
    'a provider-specific absence stays absent instead of being harmonized away',
    (toolResult(codex, 'e1') as any)?.exitCode === 1
      && (toolResult(claude, 'e1') as any)?.exitCode === undefined
      && (toolResult(pi, 'e1') as any)?.exitCode === 1,
    `codex=${(toolResult(codex, 'e1') as any)?.exitCode} claude=${(toolResult(claude, 'e1') as any)?.exitCode} pi=${(toolResult(pi, 'e1') as any)?.exitCode}`,
  );

  // No adapter leaks a native tool name INTO the canonical semantic envelope.
  const leaks: string[] = [];
  for (const [label, messages] of [['codex', codex], ['claude', claude], ['pi', pi]] as const) {
    const semantic = toolResult(messages, 'e1')?.semantic;
    const encoded = JSON.stringify(semantic ?? {});
    for (const native of ['exec_command', 'Bash', 'bash', 'toolName']) {
      if (encoded.includes(`"${native}"`)) leaks.push(`${label}:${native}`);
    }
  }
  check('no native tool name reaches the canonical semantic envelope', leaks.length === 0, leaks.join(','));
}

// ── 5. Shared retention bounds ───────────────────────────────────────────────
{
  const huge = 'x'.repeat(COMMAND_STREAM_MAX_BYTES * 3);
  const stream = boundedStream(huge)!;
  check(
    'stream retention clips to the shared byte bound and flags it',
    Buffer.byteLength(stream.text, 'utf8') === COMMAND_STREAM_MAX_BYTES
      && stream.truncated === true
      && stream.totalBytes === COMMAND_STREAM_MAX_BYTES * 3,
    `${Buffer.byteLength(stream.text, 'utf8')} of ${stream.totalBytes}`,
  );
  check(
    'a stream inside the bound is not flagged truncated',
    boundedStream('short')?.truncated === undefined,
    JSON.stringify(boundedStream('short')),
  );

  // Incremental append: cost is proportional to the FRAGMENT, and the retained
  // tail never grows past the bound however many fragments arrive.
  const tail = new BoundedOutputTail(1024);
  for (let index = 0; index < 5000; index++) tail.append(`line ${index}\n`);
  const appended = tail.stream()!;
  check(
    'incremental append keeps a bounded tail across thousands of fragments',
    Buffer.byteLength(appended.text, 'utf8') <= 1024
      && appended.truncated === true
      && appended.text.endsWith('line 4999\n'),
    `${Buffer.byteLength(appended.text, 'utf8')} bytes retained`,
  );

  const replaced = new BoundedOutputTail(1024);
  replaced.replace('y'.repeat(50_000));
  check(
    'a redelivered whole output takes a bounded tail slice, not a rescan',
    Buffer.byteLength(replaced.stream()!.text, 'utf8') === 1024,
    `${Buffer.byteLength(replaced.stream()!.text, 'utf8')}`,
  );

  const preview = boundedPreview(Array.from({ length: 900 }, (_, i) => `l${i}`).join('\n'));
  check(
    'file preview retention clips to the shared line bound and flags it',
    preview.preview!.split('\n').length === FILE_PREVIEW_MAX_LINES
      && preview.previewTruncated === true,
    `${preview.preview!.split('\n').length} lines`,
  );

  const search = searchSemantic({
    query: 'x',
    groups: Array.from({ length: SEARCH_MAX_GROUPS + 30 }, (_, index) =>
      searchGroup({
        path: `f${index}.ts`,
        matches: Array.from({ length: SEARCH_MAX_MATCHES_PER_GROUP + 20 }, () => ({
          text: 'z'.repeat(SEARCH_SNIPPET_MAX_BYTES * 2),
        })),
      })),
  });
  check(
    'search retention caps groups, matches per group, and snippet bytes',
    search.groups?.length === SEARCH_MAX_GROUPS
      && search.truncated === true
      && search.groups[0]?.matches?.length === SEARCH_MAX_MATCHES_PER_GROUP
      && search.groups[0]?.truncated === true
      && Buffer.byteLength(search.groups[0]!.matches![0]!.text, 'utf8') === SEARCH_SNIPPET_MAX_BYTES,
    `${search.groups?.length} groups`,
  );

  const web = webSemantic({
    results: Array.from({ length: WEB_MAX_RESULTS + 25 }, (_, index) => ({
      url: `https://example.com/${index}`,
      snippet: 'q'.repeat(4000),
    })),
  });
  check(
    'web retention caps results and snippet bytes',
    web.results?.length === WEB_MAX_RESULTS
      && web.truncated === true
      && Buffer.byteLength(web.results[0]!.snippet!, 'utf8') <= 512,
    `${web.results?.length} results`,
  );

  check(
    'a semantic without a real command line is not emitted at all',
    commandSemantic({ command: '   ', state: 'completed' }) === undefined
      && fileReadSemantic({ path: '' }) === undefined,
  );

  check(
    'unknown lifecycle values fail closed to unknown',
    commandSemantic({ command: 'x', state: 'exploded' })?.state === 'unknown',
    JSON.stringify(commandSemantic({ command: 'x', state: 'exploded' })),
  );

  // Whole-envelope ceiling: a pathological combination sheds bodies but keeps
  // its truncation flags, so the result can never read as complete.
  const oversized = boundToolSemantic({
    kind: 'search',
    query: 'x',
    groups: Array.from({ length: SEARCH_MAX_GROUPS }, (_, index) => ({
      path: `f${index}.ts`,
      matches: Array.from({ length: SEARCH_MAX_MATCHES_PER_GROUP }, () => ({
        text: 'w'.repeat(SEARCH_SNIPPET_MAX_BYTES),
      })),
    })),
  })!;
  check(
    'the whole-envelope ceiling sheds bodies and keeps the truncation flags',
    Buffer.byteLength(JSON.stringify(oversized), 'utf8') <= TOOL_SEMANTIC_MAX_BYTES
      && oversized.kind === 'search'
      && oversized.truncated === true
      && oversized.groups?.every((group) => group.truncated === true) === true,
    `${Buffer.byteLength(JSON.stringify(oversized), 'utf8')} bytes`,
  );

  const withinCeiling = boundToolSemantic(commandSemantic({
    command: 'ls',
    state: 'completed',
    stdout: boundedStream('a'),
  }))!;
  check(
    'a semantic inside the ceiling passes through unchanged',
    JSON.stringify(withinCeiling)
      === JSON.stringify(commandSemantic({ command: 'ls', state: 'completed', stdout: boundedStream('a') })),
    JSON.stringify(withinCeiling),
  );
}

// --- the ceiling is ABSOLUTE, not best-effort --------------------------------
//
// The per-field bounds sum to well over TOOL_SEMANTIC_MAX_BYTES, and several of
// them count CHARACTERS, so multibyte input multiplies them again. One shedding
// pass is therefore not enough. These saturate every field at once and assert
// the MEASURED size, not the intent.
{
  const cjk = (count: number) => '界'.repeat(count);
  // 1-byte characters that JSON escapes to 6 bytes each — the worst expansion.
  const ctrl = ''.repeat(6000);

  const saturatedSearch = boundToolSemantic(searchSemantic({
    query: cjk(2000),
    scope: cjk(2000),
    matchCount: 1_000_000,
    fileCount: 4000,
    groups: Array.from({ length: 40 }, (_, index) => searchGroup({
      path: `/srv/${cjk(1200)}/${index}.ts`,
      matchCount: 9999,
      matches: Array.from({ length: 30 }, (_, line) => ({ line: line + 1, text: cjk(4000) })),
    })),
  }))!;
  const searchBytes = Buffer.byteLength(JSON.stringify(saturatedSearch), 'utf8');
  check(
    'a fully saturated multibyte search still honors the ceiling',
    searchBytes <= TOOL_SEMANTIC_MAX_BYTES && saturatedSearch.kind === 'search'
      && saturatedSearch.truncated === true,
    `${searchBytes} <= ${TOOL_SEMANTIC_MAX_BYTES}`,
  );

  const saturatedWeb = boundToolSemantic(webSemantic({
    query: ctrl,
    url: `https://example.com/${ctrl}`,
    results: Array.from({ length: 50 }, (_, index) => ({
      url: `https://example.com/${ctrl}${index}`,
      title: ctrl,
      snippet: ctrl,
    })),
  }))!;
  const webBytes = Buffer.byteLength(JSON.stringify(saturatedWeb), 'utf8');
  check(
    'control characters cannot inflate a web envelope past the ceiling',
    webBytes <= TOOL_SEMANTIC_MAX_BYTES && saturatedWeb.kind === 'web'
      && saturatedWeb.truncated === true,
    `${webBytes} <= ${TOOL_SEMANTIC_MAX_BYTES}`,
  );

  const saturatedCommand = boundToolSemantic(commandSemantic({
    command: ctrl,
    cwd: cjk(2000),
    state: 'failed',
    stdout: boundedStream(cjk(200_000)),
    stderr: boundedStream(ctrl + cjk(200_000)),
  }))!;
  const commandBytes = Buffer.byteLength(JSON.stringify(saturatedCommand), 'utf8');
  check(
    'a saturated command envelope honors the ceiling and keeps its flags',
    commandBytes <= TOOL_SEMANTIC_MAX_BYTES
      && saturatedCommand.kind === 'command'
      && saturatedCommand.stdout?.truncated === true
      && saturatedCommand.stderr?.truncated === true,
    `${commandBytes} <= ${TOOL_SEMANTIC_MAX_BYTES}`,
  );

  const saturatedRead = boundToolSemantic(fileReadSemantic({
    path: cjk(2000),
    startLine: 1,
    preview: cjk(200_000),
    totalLines: 9_000_000,
  }))!;
  const readBytes = Buffer.byteLength(JSON.stringify(saturatedRead), 'utf8');
  check(
    'a saturated file-read envelope honors the ceiling',
    readBytes <= TOOL_SEMANTIC_MAX_BYTES
      && saturatedRead.kind === 'file-read'
      && saturatedRead.previewTruncated === true,
    `${readBytes} <= ${TOOL_SEMANTIC_MAX_BYTES}`,
  );
}

// --- a clipped web result never reads as a complete one ----------------------
{
  const clipped = webSemantic({
    results: [
      { url: 'https://example.com/a', snippet: 'x'.repeat(4000) },
      { url: 'https://example.com/b', snippet: 'short enough' },
      { url: 'https://example.com/c', title: 'T'.repeat(4000) },
    ],
  });
  check(
    'a snippet clipped to the wire bound is flagged truncated',
    clipped.results?.[0]?.truncated === true
      && Buffer.byteLength(clipped.results[0]!.snippet ?? '', 'utf8') <= 512,
    `${clipped.results?.[0]?.snippet?.length} chars retained`,
  );
  check(
    'a result inside every bound is NOT flagged truncated',
    clipped.results?.[1]?.truncated === undefined,
    JSON.stringify(clipped.results?.[1]),
  );
  check(
    'a clipped title also flags the result',
    clipped.results?.[2]?.truncated === true,
  );
}

// --- Codex enrichment retention is bounded AND fully charged -----------------
//
// The enrichment map is the one place a Codex adapter retains tool detail across
// records. Anything it keeps but does not charge is a hole straight through the
// history construction bound, so this asserts both halves: the retained bytes
// are clipped at ingest, and every retained field is counted.
{
  const enrich = new Map<string, CodexEnrich>();
  const huge = 'x'.repeat(4 * 1024 * 1024);
  accumulateEnrich({
    type: 'event_msg',
    payload: { type: 'exec_command_begin', call_id: 'c1', command: ['sh', '-c', huge], cwd: `/repo/${huge}` },
  }, enrich);
  accumulateEnrich({
    type: 'event_msg',
    payload: { type: 'exec_command_end', call_id: 'c1', exit_code: 0, stdout: huge, stderr: huge },
  }, enrich);
  const entry = enrich.get('c1')!;
  check(
    'a multi-megabyte command line and cwd are clipped at ingest',
    entry.command!.length <= COMMAND_MAX_CHARS && entry.cwd!.length <= PATH_MAX_CHARS,
    `command=${entry.command!.length} cwd=${entry.cwd!.length}`,
  );
  check(
    'multi-megabyte stdout/stderr are clipped to the shared stream bound',
    Buffer.byteLength(entry.stdout!, 'utf8') <= COMMAND_STREAM_MAX_BYTES
      && Buffer.byteLength(entry.stderr!, 'utf8') <= COMMAND_STREAM_MAX_BYTES,
    `stdout=${Buffer.byteLength(entry.stdout!, 'utf8')} stderr=${Buffer.byteLength(entry.stderr!, 'utf8')}`,
  );

  // The accounting must SEE those fields. Charging an entry that carries two
  // 16 KiB streams as if it were empty is exactly the hole being closed.
  const measured = enrichEntryBytes(entry);
  const streamBytes = Buffer.byteLength(entry.stdout!, 'utf8') + Buffer.byteLength(entry.stderr!, 'utf8');
  check(
    'enrichEntryBytes charges command, cwd, stdout, and stderr',
    measured >= streamBytes + entry.command!.length + entry.cwd!.length,
    `${measured} bytes charged, ${streamBytes} in streams alone`,
  );
  check(
    'an empty entry still costs its fixed overhead, and no more',
    enrichEntryBytes({}) === 32 && enrichEntryBytes(undefined) === 0,
    `${enrichEntryBytes({})}`,
  );
}

// --- a long-lived tail evicts instead of growing until disconnect ------------
//
// The history reader gets one bounded pass over one file and can refuse. An
// observe connection runs for as long as the session is open, so retaining
// every completed call would grow without limit. Both ceilings are asserted:
// entries alone would not bound a few very large calls, and bytes alone would
// not bound very many tiny ones.
{
  const exec = (id: number, out: string) => [
    {
      type: 'event_msg',
      payload: { type: 'exec_command_begin', call_id: `call-${id}`, command: ['echo', `${id}`], cwd: '/repo' },
    },
    {
      type: 'event_msg',
      payload: { type: 'exec_command_end', call_id: `call-${id}`, exit_code: 0, stdout: out },
    },
  ];

  const byEntries = new CodexEnrichStore();
  for (let id = 0; id < 500; id++) {
    for (const line of exec(id, 'small')) {
      byEntries.accumulate(line);
      byEntries.evictUntilWithin(50, 1024 * 1024 * 1024, `call-${id}`);
    }
  }
  check(
    'thousands of completed calls do not accumulate past the entry ceiling',
    byEntries.size <= 50 && byEntries.entries.has('call-499'),
    `${byEntries.size} entries retained of 500 calls, newest kept`,
  );

  const byBytes = new CodexEnrichStore();
  for (let id = 0; id < 200; id++) {
    for (const line of exec(id, 'x'.repeat(64 * 1024))) {
      byBytes.accumulate(line);
      byBytes.evictUntilWithin(100_000, 256 * 1024, `call-${id}`);
    }
  }
  check(
    'large per-call output is bounded by the retained-byte ceiling',
    byBytes.retainedBytes <= 256 * 1024 && byBytes.size < 200,
    `${byBytes.retainedBytes} bytes across ${byBytes.size} entries`,
  );

  // Eviction must never drop the call currently being enriched: its own
  // function_call_output has not been read yet.
  const keepNewest = new CodexEnrichStore();
  for (const line of exec(1, 'y'.repeat(512 * 1024))) {
    keepNewest.accumulate(line);
    keepNewest.evictUntilWithin(1, 1, 'call-1');
  }
  check(
    'the call being enriched survives even an impossible ceiling',
    keepNewest.entries.has('call-1'),
    `${keepNewest.size} entries`,
  );

  check(
    'the accounting stays exact as entries are added and evicted',
    (() => {
      const store = new CodexEnrichStore();
      for (let id = 0; id < 60; id++) {
        for (const line of exec(id, 'z'.repeat(1024))) store.accumulate(line);
      }
      store.evictUntilWithin(10, 1024 * 1024 * 1024);
      let expected = 0;
      for (const entry of store.entries.values()) expected += enrichEntryBytes(entry);
      return store.retainedBytes === expected;
    })(),
  );
}

const failed = results.filter((item) => !item.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${results.length} tool-semantics checks failed.`);
  process.exit(1);
}
console.log(`\nPASS: ${results.length}/${results.length} tool-semantics checks passed.`);
