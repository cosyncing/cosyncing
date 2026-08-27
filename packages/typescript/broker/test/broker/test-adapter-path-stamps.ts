/**
 * Cross-adapter contract: does an adapter stamp a PATH on its file-read and
 * file-edit tool rows?
 *
 * The client derives every clickable file mention in a transcript from
 * structured contract fields alone (`file_reference.dart`:
 * `ToolFileReadSemantic.path`, `tool-result.path`, `FileChange.path`). Nothing
 * scans prose. So an adapter that stops stamping a path does not produce a
 * broken link — it produces NO link, silently, on one agent only, and the
 * feature quietly becomes "works on the agents someone happened to check".
 *
 * This suite is the answer to that. Every adapter answers both questions
 * EXPLICITLY, here, in [DECLARED]:
 *
 *   - `supported`, naming the exact contract fields the path lands on, or
 *   - `unsupported`, with a written reason.
 *
 * **Silence fails.** The adapter ids are read from the adapter classes
 * themselves, so a seventh adapter — or a renamed sixth — has no declared
 * answer and the suite goes red rather than skipping it.
 *
 * Then every declared answer is PROVEN against a recorded native record run
 * through that adapter's real mapper. No live agent, no network, no model
 * cost: each probe is the same native shape the adapter's own suite records,
 * driven through the same exported mapping function.
 *
 * The proof runs in both directions, which is the part that makes the table
 * trustworthy: a declared `supported` must actually stamp, and a declared
 * `unsupported` must actually NOT. An adapter that gains stamping has to come
 * back here and say so.
 *
 * Deliberately excluded from "carries a path": `ToolCommandSemantic.cwd` (a
 * directory a command ran in, never a file) and `ToolSearchSemantic.scope` (a
 * search scope directory — treating it as a file is the exact trap
 * `file_reference.dart` documents). Only fields naming a real FILE count.
 *
 *   bun run packages/typescript/broker/test/broker/test-adapter-path-stamps.ts
 *   (exit 0 = all pass)
 */
export {};
import type { AgentMessage } from '../../../adapter-api/src/index.ts';
// The adapter LIST comes from the production shipped-adapters source, so an
// adapter cannot register without this suite seeing it. The per-package
// imports below are only the mappers each probe drives.
import { shippedAdapters } from '../../src/installation/shipped-adapters.ts';
import { mapTranscript } from '../../../adapters/claude/src/index.ts';
import { mapRollout } from '../../../adapters/codex/src/index.ts';
// dsh and kimi publish NARROW broker-facing facades: the mapping stays
// package-internal by design, and their own suites reach it by module path.
// This one does the same rather than widening either facade for a test.
import { createDshMapState, mapDshEvent } from '../../../adapters/dsh/src/mapping.ts';
import { createKimiMappingState, mapKimiMessage } from '../../../adapters/kimi/src/mapping.ts';
import { mapOpenCodePart } from '../../../adapters/opencode/src/index.ts';
import { mapPiJsonlText } from '../../../adapters/pi/src/index.ts';
import { createAgyMapState, mapAgyStep, type AgyStep } from '../../../adapters/antigravity/src/index.ts';
// agy's probe replays the package's recorded 1.1.17 fixture rather than an
// inline reconstruction: the call row and the result row come from two
// DIFFERENT transcript steps (PLANNER_RESPONSE carries the tool_calls, the
// VIEW_FILE/CODE_ACTION step carries the result), and that cross-step pairing
// is exactly what the fixture pins.
import { FIXTURE as AGY_FIXTURE } from '../../../adapters/antigravity/test/fixtures/tree.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── The contract vocabulary ─────────────────────────────────────────────────

/** The row families a file mention can come from. */
type Family = 'read' | 'edit';

/**
 * Where a path may legitimately land on a (call, result) row pair.
 *
 * Exactly the FILE-naming fields `fileReferencesForToolRow` reads. The
 * client's other two sources are excluded on purpose: a command's `cwd` and a
 * search `scope` are directories, not the file a mention points at.
 */
type PathField = 'semantic.path' | 'result.path' | 'result.fileChanges[].path';

const ALL_PATH_FIELDS: readonly PathField[] = [
  'semantic.path',
  'result.path',
  'result.fileChanges[].path',
];

/** One adapter's answer for one family. */
type Answer =
  | { status: 'supported'; fields: PathField[] }
  | { status: 'unsupported'; reason: string };

/** The rows one recorded native record produced, split into the pair. */
interface RowPair {
  call?: AgentMessage;
  result?: AgentMessage;
}

// ── The declared answers ────────────────────────────────────────────────────

/**
 * What each adapter claims. Every entry is proven below against a recorded
 * native record; nothing here is taken on trust.
 *
 * A `reason` is prose a human wrote about a real upstream limitation, not a
 * to-do. "Not implemented yet" is not a reason — it is the absence of one, and
 * the proof below would then be pinning a bug in place.
 */
const DECLARED: Record<string, Record<Family, Answer>> = {
  claude: {
    // `Read`'s call carries `input.file_path`; the result repeats it under
    // `toolUseResult.file.filePath`, so both halves of the pair are stamped.
    read: { status: 'supported', fields: ['semantic.path', 'result.path'] },
    // `Edit`/`Write` publish no read semantic (there is no edit member on
    // ToolSemanticKind by design); the path rides the result's own field, out
    // of `toolUseResult.filePath`, and again on the change set derived from
    // `structuredPatch`.
    edit: {
      status: 'supported',
      fields: ['result.path', 'result.fileChanges[].path'],
    },
  },
  codex: {
    // The one genuine gap in the matrix, and the reason this suite records
    // answers rather than asserting a uniform rule.
    read: {
      status: 'unsupported',
      reason:
        'Codex has no file-read tool. It reads files by running a shell '
        + 'command (`cat`, `sed`, `rg`), which maps to an execute row with a '
        + 'command semantic — a command string, not a path. Recovering one '
        + 'would mean parsing shell text, and a guessed path opens the wrong '
        + 'file or nothing at all. Recorded as a gap rather than papered over.',
    },
    // Writes are a different story: `apply_patch` and `patch_apply_end` both
    // name the file, so an edit row is stamped even though a read is not —
    // once on the result and once per file in the change set.
    edit: {
      status: 'supported',
      fields: ['result.path', 'result.fileChanges[].path'],
    },
  },
  opencode: {
    // `read`'s `input.filePath`, on both the pending call's semantic and the
    // completed result.
    read: { status: 'supported', fields: ['semantic.path', 'result.path'] },
    // `edit`/`write`/`patch`: the part-level `filePath` plus the per-file
    // paths parsed out of the unified diff.
    edit: {
      status: 'supported',
      fields: ['result.path', 'result.fileChanges[].path'],
    },
  },
  pi: {
    // Pi spells the argument four ways (`path`, `file_path`, `filePath`,
    // `filename`); the mapper accepts all of them.
    read: { status: 'supported', fields: ['semantic.path', 'result.path'] },
    // Plus the change set parsed out of `details.diff`.
    edit: {
      status: 'supported',
      fields: ['result.path', 'result.fileChanges[].path'],
    },
  },
  kimi: {
    // Landed the round after this spec was written: `args.path` is kept as a
    // derived call fact and stamped on the result, for Read/ReadMediaFile and
    // for Edit/Write alike. The read semantic additionally carries it whenever
    // the numbered-gutter preview parses.
    read: { status: 'supported', fields: ['semantic.path', 'result.path'] },
    // Result field only: the REST projection publishes no unified diff, so the
    // row states the path it acted on and fabricates no change set.
    edit: { status: 'supported', fields: ['result.path'] },
  },
  dsh: {
    // The host publishes a rendered `view` per row: `card:'read'` carries
    // `view.path`, and it reaches both the result's own field and its
    // file-read semantic.
    read: { status: 'supported', fields: ['semantic.path', 'result.path'] },
    // `card:'diff'` names the file it rewrote. Only the result's own field:
    // dsh renders the diff as one unified string and publishes no per-file
    // `fileChanges[]`, so there is no second place the path could land.
    edit: { status: 'supported', fields: ['result.path'] },
  },
  agy: {
    // `view_file`'s result decodes `AbsolutePath` off the call's JSON-encoded
    // args and lands it on the file-read semantic and the result's own field —
    // both asserted with unquoted values in test-agy-mapping.ts.
    read: { status: 'supported', fields: ['semantic.path', 'result.path'] },
    // CODE_ACTION names the file it acted on; the transcript records prose
    // ("Created file file://…"), not a unified diff, so the row states
    // `result.path` and fabricates no change set — dsh's situation exactly.
    edit: { status: 'supported', fields: ['result.path'] },
  },
};

// ── The probes: recorded native records through the real mappers ────────────

const PROBES: Record<string, Partial<Record<Family, () => RowPair>>> = {};

/** Splits one mapper's output into the (call, result) pair for `callId`. */
function pair(messages: readonly AgentMessage[], callId: string): RowPair {
  const of = (type: string) =>
    messages.find((m) => m.type === type && (m as { callId?: string }).callId === callId);
  return { call: of('tool-call'), result: of('tool-result') };
}

// Claude: transcript JSONL lines, tool_use paired with a same-line
// toolUseResult — the shape test-claude-jsonl.ts records.
const claudeUsage = { input_tokens: 1, output_tokens: 1 };
const claudeLines = (id: string, name: string, input: unknown, toolUseResult: unknown) => [
  {
    type: 'assistant',
    uuid: `a-${id}`,
    message: {
      id: `m-${id}`,
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id, name, input }],
      usage: claudeUsage,
    },
  },
  {
    type: 'user',
    uuid: `u-${id}`,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    toolUseResult,
  },
];
PROBES.claude = {
  read: () => pair(
    mapTranscript(claudeLines('toolu_read', 'Read', { file_path: '/w/a.ts' }, {
      type: 'text',
      file: { filePath: '/w/a.ts', numLines: 2, totalLines: 2, startLine: 1, content: 'x\ny' },
    })),
    'toolu_read',
  ),
  edit: () => pair(
    mapTranscript(claudeLines('toolu_edit', 'Edit', { file_path: '/w/a.ts' }, {
      filePath: '/w/a.ts',
      oldString: 'a',
      newString: 'b',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
    })),
    'toolu_edit',
  ),
};

// Codex: rollout JSONL entries, the shape broker/test/codex/rollout.ts records.
PROBES.codex = {
  read: () => pair(
    mapRollout([
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c-read', arguments: '{"command":"cat /w/a.ts"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c-read', output: 'x\ny' } },
    ]),
    'c-read',
  ),
  edit: () => pair(
    mapRollout([
      { type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', call_id: 'c-edit', arguments: '{}' } },
      { type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'c-edit', success: true, changes: { '/w/a.ts': { type: 'add', content: 'l1\nl2' } } } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c-edit', output: 'ok' } },
    ]),
    'c-edit',
  ),
};

// OpenCode: one completed tool part, the shape
// test-opencode-file-changes.ts records.
const openCodePart = (tool: string, callID: string, state: Record<string, unknown>) => ({
  id: `prt_${callID}`,
  type: 'tool',
  tool,
  callID,
  messageID: 'msg_a1',
  sessionID: 'ses_probe',
  state: { status: 'completed', ...state },
});
PROBES.opencode = {
  read: () => pair(
    mapOpenCodePart(openCodePart('read', 'oc-read', {
      input: { filePath: 'src/app.ts' },
      output: '<file>\n00001| x\n</file>',
      metadata: { preview: 'x' },
    })),
    'oc-read',
  ),
  edit: () => pair(
    mapOpenCodePart(openCodePart('edit', 'oc-edit', {
      input: { filePath: 'src/app.ts' },
      output: 'ok',
      metadata: {
        diff: ['--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,1 +1,1 @@', '-old', '+new'].join('\n'),
        filediff: { file: 'src/app.ts', additions: 1, deletions: 1 },
      },
    })),
    'oc-edit',
  ),
};

// Pi: extension JSONL, the shape test-pi-observe.ts records.
const piJsonl = (id: string, name: string, args: unknown, details?: unknown) => [
  {
    type: 'message',
    id: `a-${id}`,
    message: {
      role: 'assistant',
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id, name, arguments: args }],
    },
  },
  {
    type: 'message',
    id: `r-${id}`,
    message: {
      role: 'toolResult',
      toolCallId: id,
      toolName: name,
      content: [{ type: 'text', text: 'Done' }],
      ...(details !== undefined ? { details } : {}),
      isError: false,
    },
  },
].map((line) => `${JSON.stringify(line)}\n`).join('');
PROBES.pi = {
  read: () => pair(mapPiJsonlText(piJsonl('pi-read', 'read', { path: 'src/a.ts' })), 'pi-read'),
  edit: () => pair(
    mapPiJsonlText(piJsonl('pi-edit', 'edit', { path: 'src/a.ts' }, {
      diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new\n',
    })),
    'pi-edit',
  ),
};

// Kimi: REST message rows, the shape test-kimi-mapping.ts records.
function kimiPair(callId: string, toolName: string, input: unknown, output: unknown): RowPair {
  const state = createKimiMappingState();
  const rows = [
    ...mapKimiMessage({
      id: `msg_${callId}`,
      role: 'assistant',
      content: [{ type: 'tool_use', tool_call_id: callId, tool_name: toolName, input }],
    } as never, state),
    ...mapKimiMessage({
      id: `msg_${callId}_result`,
      role: 'tool',
      content: [{ type: 'tool_result', tool_call_id: callId, output }],
    } as never, state),
  ].map((row) => row.message);
  return pair(rows, callId);
}
PROBES.kimi = {
  read: () => kimiPair('k-read', 'Read', { path: '/w/a.ts', line_offset: 1 }, '1\tconst a = 1;\n2\tconst b = 2;\n'),
  edit: () => kimiPair('k-edit', 'Edit', { path: '/w/a.ts', old_string: 'a', new_string: 'b' }, 'Replaced 1 occurrence in a.ts'),
};

// dsh: session-log events carrying the host's rendered view, the shape
// test-dsh-mapping.ts records.
function dshPair(callId: string, name: string, view: unknown): RowPair {
  const state = createDshMapState('session-probe', false);
  const rows = [
    ...mapDshEvent({
      event: { type: 'tool/call', seq: 1, time: 1, data: { callId, name, arguments: {} } },
    } as never, state),
    ...mapDshEvent({
      event: {
        type: 'tool/result',
        seq: 2,
        time: 2,
        data: { message: { content: [{ toolCallId: callId, content: 'ok' }] } },
      },
      view: { for: 'result', view },
    } as never, state),
  ];
  return pair(rows, callId);
}
PROBES.dsh = {
  read: () => dshPair('d-read', 'read', {
    card: 'read',
    path: '/w/a.ts',
    offset: 1,
    totalLines: 2,
    lines: [{ number: 1, text: 'const a = 1' }],
  }),
  edit: () => dshPair('d-edit', 'edit', {
    card: 'diff',
    diffs: [{ path: '/w/a.ts', oldText: 'old', newText: 'new' }],
  }),
};

// agy: the recorded 1.1.17 transcript fixture through the package's one
// mapper, exactly as replay and live tail run it. The pair is located by tool
// name because the callId embeds the fixture's conversation uuid and step
// index — deriving it here would re-implement the key function under test.
function agyPair(toolName: string): RowPair {
  const state = createAgyMapState(AGY_FIXTURE.conversationIds.withTranscript, { liveChild: false });
  const messages = (AGY_FIXTURE.transcript as unknown as AgyStep[]).flatMap((step) =>
    mapAgyStep(step, state));
  const result = messages.find(
    (m) => m.type === 'tool-result' && (m as { toolName?: string }).toolName === toolName,
  ) as { callId?: string } | undefined;
  return pair(messages, result?.callId ?? '');
}
PROBES.agy = {
  read: () => agyPair('view_file'),
  edit: () => agyPair('write_to_file'),
};

// ── The observation ─────────────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Which FILE-naming fields the pair actually carries.
 *
 * Mirrors `fileReferencesForToolRow` (`file_reference.dart`): the result's
 * semantic wins over the call's, a file-read semantic contributes its `path`,
 * and `fileChanges[]` contributes every entry's `path`. Nothing else counts —
 * in particular a command `cwd` and a search `scope` are directories.
 */
function observedFields(rows: RowPair): PathField[] {
  const found = new Set<PathField>();
  const result = record(rows.result);
  const semantic = record(result?.semantic) ?? record(record(rows.call)?.semantic);
  if (semantic?.kind === 'file-read' && nonEmptyString(semantic.path)) {
    found.add('semantic.path');
  }
  if (nonEmptyString(result?.path)) found.add('result.path');
  const changes = result?.fileChanges;
  if (Array.isArray(changes) && changes.some((c) => nonEmptyString(record(c)?.path))) {
    found.add('result.fileChanges[].path');
  }
  return ALL_PATH_FIELDS.filter((field) => found.has(field));
}

// ── 1. Completeness: silence fails ──────────────────────────────────────────
//
// The ids come from the PRODUCTION shipped-adapter list, not from imports
// maintained beside this suite: a hand-kept import block let a seventh adapter
// register and pass here silently unanswered, which is the exact failure this
// section exists to prevent. The direct class imports above remain only
// because the probes need each package's mapper.

const ADAPTER_IDS: string[] = shippedAdapters().map((adapter) => adapter.id);

const FAMILIES: readonly Family[] = ['read', 'edit'];

for (const id of ADAPTER_IDS) {
  const declared = DECLARED[id];
  check(
    `${id}: answers the path-stamp question for read and edit`,
    !!declared && FAMILIES.every((family) => !!declared[family]),
    JSON.stringify(declared ?? null),
  );
  check(
    `${id}: has a recorded probe for every family it answers`,
    !!PROBES[id] && FAMILIES.every((family) => typeof PROBES[id]?.[family] === 'function'),
    Object.keys(PROBES[id] ?? {}).join(','),
  );
}

check(
  'no answer is declared for an adapter that is not registered',
  Object.keys(DECLARED).every((id) => ADAPTER_IDS.includes(id)),
  `declared=${Object.keys(DECLARED).sort().join(',')} registered=${[...ADAPTER_IDS].sort().join(',')}`,
);

// An `unsupported` answer with no reason is silence wearing a label.
for (const id of ADAPTER_IDS) {
  for (const family of FAMILIES) {
    const answer = DECLARED[id]?.[family];
    if (answer?.status !== 'unsupported') continue;
    check(
      `${id}/${family}: the unsupported answer carries a written reason`,
      answer.reason.trim().length >= 40,
      answer.reason,
    );
  }
}

// A `supported` answer that names no field claims nothing checkable.
for (const id of ADAPTER_IDS) {
  for (const family of FAMILIES) {
    const answer = DECLARED[id]?.[family];
    if (answer?.status !== 'supported') continue;
    check(
      `${id}/${family}: the supported answer names the fields it stamps`,
      answer.fields.length > 0
        && answer.fields.every((field) => ALL_PATH_FIELDS.includes(field)),
      answer.fields.join(','),
    );
  }
}

// ── 2. Proof: the declared answer is what the mapper actually does ──────────

for (const id of ADAPTER_IDS) {
  for (const family of FAMILIES) {
    const answer = DECLARED[id]?.[family];
    const probe = PROBES[id]?.[family];
    if (!answer || !probe) continue;
    let rows: RowPair;
    try {
      rows = probe();
    } catch (error) {
      check(`${id}/${family}: the recorded ${family} record maps`, false, String(error));
      continue;
    }
    check(
      `${id}/${family}: the recorded record produces a tool row at all`,
      !!rows.call || !!rows.result,
      JSON.stringify(rows),
    );
    const observed = observedFields(rows);
    if (answer.status === 'supported') {
      check(
        `${id}/${family}: stamps a path on exactly the declared fields`,
        answer.fields.length === observed.length
          && answer.fields.every((field) => observed.includes(field)),
        `declared=[${answer.fields.join(',')}] observed=[${observed.join(',')}]`,
      );
    } else {
      // The other direction, and the reason this is a contract rather than a
      // snapshot: an adapter that GAINS stamping must come back and say so,
      // otherwise the matrix quietly understates what the app can do.
      check(
        `${id}/${family}: stamps nothing, as declared`,
        observed.length === 0,
        `observed=[${observed.join(',')}] — update DECLARED if this adapter now stamps`,
      );
    }
  }
}

// ── 3. The two traps the client's derivation documents ─────────────────────
//
// Both are directory facts. If either ever started counting as a file path,
// every command row and every grep would sprout a bogus link — and section 2
// above would go green on an adapter that stamps nothing real.

check(
  'a command cwd is not counted as a file path',
  observedFields({
    result: {
      type: 'tool-result',
      callId: 'x',
      toolName: 'bash',
      semantic: { kind: 'command', command: 'ls', cwd: '/w', state: 'completed' },
    } as never,
  }).length === 0,
);

check(
  'a search scope directory is not counted as a file path',
  observedFields({
    result: {
      type: 'tool-result',
      callId: 'x',
      toolName: 'grep',
      semantic: { kind: 'search', query: 'foo', scope: 'packages', groups: [] },
    } as never,
  }).length === 0,
);

// And the positive control: a file-read semantic IS counted, so a green
// section 2 cannot be an artefact of an observer that sees nothing.
check(
  'a file-read semantic path is counted',
  observedFields({
    result: {
      type: 'tool-result',
      callId: 'x',
      toolName: 'read',
      semantic: { kind: 'file-read', path: '/w/a.ts' },
    } as never,
  }).join(',') === 'semantic.path',
);

const failed = results.filter((item) => !item.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${results.length} adapter path-stamp checks failed.`);
  process.exit(1);
}
console.log(`\nPASS: ${results.length}/${results.length} adapter path-stamp checks passed.`);
