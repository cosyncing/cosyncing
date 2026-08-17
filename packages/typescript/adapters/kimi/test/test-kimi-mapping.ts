/**
 * Kimi native REST payloads → canonical protocol objects.
 *
 * Driven by SANITIZED CAPTURES from a real Kimi Code 0.35.0 `kimi web` instance
 * (fixtures/kimi-0.35.0.json), so the shapes under test are the ones the server
 * actually answers rather than shapes invented to match the mapper.
 *
 * The property that matters most here is TOTALITY: Kimi marks its server API
 * experimental, so an unknown role, an unknown content kind, or a structurally
 * broken record must cost one oddly-rendered row and never a thrown attach. The
 * second property is IDENTITY: two native rows whose rendered bytes are equal
 * are still two rows, and the dedupe downstream depends on that surviving.
 *
 *   bun run packages/typescript/adapters/kimi/test/test-kimi-mapping.ts   (exit 0 = all pass)
 */
export {};
import { CONTEXT_INJECTION_BODY_MAX_UNITS, CONTEXT_INJECTION_EVENT } from '@cosyncing/adapter-api';
import {
  KIMI_APPROVAL_DETAIL_CAP_BYTES,
  KIMI_UNKEYABLE_QUESTION,
  KIMI_AMBIGUOUS_SINGLE_ANSWER,
  KIMI_UNREPRESENTABLE_ANSWER,
  boundedKimiToolInput,
  mapKimiMessage,
  mapKimiMessagePage,
  mapKimiQuestionAnswers,
  mapKimiQuestionRequest,
  mapKimiRunState,
  mapKimiSession,
  mapKimiSessionStatus,
  mapKimiWorkChanged,
} from '../src/mapping.ts';

const FIXTURE = await Bun.file(new URL('./fixtures/kimi-0.35.0.json', import.meta.url)).json() as {
  kimiVersion: string;
  sessionId: string;
  rest: Record<string, { code: number; msg: string; data: unknown }>;
};

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── Sessions ────────────────────────────────────────────────────────────────

const listing = FIXTURE.rest.v2Sessions!.data as { items: unknown[] };
const session = mapKimiSession(listing.items[0] as never);
check('captured session row maps', !!session && session.id === FIXTURE.sessionId);
check('mapped session is observe-only and undriveable',
  session?.attachMode === 'observe' && session?.control?.drive.supported === false);
check('mapped session carries cwd and timestamps',
  session?.cwd === '/fixture/workspace' && typeof session?.updatedAt === 'number');
check('session with no id is refused', mapKimiSession({ meta: { title: 'x' } }) === undefined);

const statuses: Array<[string, string]> = [
  ['running', 'working'], ['approval', 'needs-input'], ['question', 'needs-input'],
  ['idle', 'idle'], ['failed', 'idle'], ['a-status-from-the-future', 'idle'],
];
const mismatched = statuses.filter(([native, want]) =>
  mapKimiSession({ id: 's', activity: { status: native } })?.status !== want);
check('activity status mapping is total', mismatched.length === 0, JSON.stringify(mismatched));

// ── Transcript ──────────────────────────────────────────────────────────────

const page = mapKimiMessagePage((FIXTURE.rest.messagesAll!.data) as never);
const pageMessages = page.rows.map((row) => row.message);
check('captured transcript maps to canonical messages', pageMessages.length > 0,
  `${pageMessages.length} messages`);
const kinds = [...new Set(pageMessages.map((m) => m.type))].sort();
check('captured transcript yields user/assistant/thinking rows',
  kinds.includes('user-message') && kinds.includes('model-output') && kinds.includes('thinking'),
  kinds.join(','));

// Native paging is newest-first; the canonical transcript is oldest-first.
const firstUser = pageMessages.find((m) => m.type === 'user-message') as { text?: string } | undefined;
check('page is reversed into oldest-first order',
  firstUser?.text?.includes('PING-ONE') === true, firstUser?.text ?? 'none');

const keys = pageMessages.map((m) => (m as { key?: string }).key).filter(Boolean);
check('every keyed message has a unique stable key', new Set(keys).size === keys.length);
const identities = page.rows.map((row) => row.identity);
check('every mapped row carries a unique native identity',
  identities.length > 0 && new Set(identities).size === identities.length,
  `${identities.length} rows`);

// ── Degradation floor ───────────────────────────────────────────────────────

const degraded = mapKimiMessage({
  id: 'msg_x', role: 'assistant',
  content: [
    { type: 'a-content-type-from-the-future', blob: 1 },
    { type: 'tool_use' },
    { type: 'text', text: 'kept' },
  ],
}).map((row) => row.message);
check('unknown content degrades instead of throwing',
  degraded.length === 3 && degraded[0]?.type === 'event' && degraded[2]?.type === 'model-output',
  degraded.map((m) => m.type).join(','));
check('degraded rows leak no native payload',
  JSON.stringify(degraded[0]).includes('kimi.unmapped-content')
    && !JSON.stringify(degraded[0]).includes('blob'));

// Only 'assistant' text is model output. A novel role must not be silently
// attributed to the model.
for (const novelRole of ['tool', 'a-role-from-the-future']) {
  const mapped = mapKimiMessage({
    id: `msg_role_${novelRole}`, role: novelRole,
    content: [{ type: 'text', text: 'not model output' }],
  }).map((row) => row.message);
  check(`role '${novelRole}' degrades instead of becoming model-output`,
    mapped.length === 1 && mapped[0]?.type === 'event'
      && JSON.stringify(mapped[0]).includes(novelRole),
    mapped.map((m) => m.type).join(','));
}
check('assistant text is still model output',
  mapKimiMessage({ id: 'msg_a', role: 'assistant', content: [{ type: 'text', text: 'hi' }] })
    .map((row) => row.message)[0]?.type === 'model-output');

// ── Injected context vs. a real system message ──────────────────────────────
//
// A system row is either something the USER should read or context the AGENT
// was handed. Only a whole, identifiable wrapper is re-categorized, because
// folding a real message into a collapsed block hides content nobody then sees.

const reminderRows = mapKimiMessage({
  id: 'msg_ctx1',
  role: 'system',
  content: [{
    type: 'text',
    text: '<system-reminder>\nAuto permission mode is active.\n</system-reminder>',
  }],
}).map((row) => row.message) as Array<{ type: string; name?: string; payload?: { source?: string; body?: string } }>;
check('a whole system-reminder block becomes a provider-neutral context event',
  reminderRows.length === 1
    && reminderRows[0]!.type === 'event'
    && reminderRows[0]!.name === CONTEXT_INJECTION_EVENT
    && reminderRows[0]!.payload?.source === 'system-reminder',
  JSON.stringify(reminderRows[0]));
check('...carrying the material with the wrapper syntax removed',
  reminderRows[0]!.payload?.body === 'Auto permission mode is active.'
    && !reminderRows[0]!.payload!.body!.includes('<system-reminder>'),
  JSON.stringify(reminderRows[0]!.payload?.body));
check('...and claiming no truncation, because nothing was clipped',
  (reminderRows[0]!.payload as { truncated?: boolean }).truncated === undefined,
  JSON.stringify(reminderRows[0]!.payload));

// The same shared ceiling as every other adapter, and a clip that announces
// itself: a body that stops mid-sentence must not read as the whole material.
const hugeReminder = mapKimiMessage({
  id: 'msg_ctx_big',
  role: 'system',
  content: [{
    type: 'text',
    text: `<system-reminder>${'x'.repeat(CONTEXT_INJECTION_BODY_MAX_UNITS + 500)}</system-reminder>`,
  }],
}).map((row) => row.message) as Array<{ payload?: { body?: string; truncated?: boolean } }>;
check('an oversized context body is clipped at the shared ceiling and declares it',
  hugeReminder.length === 1
    && hugeReminder[0]!.payload?.body?.length === CONTEXT_INJECTION_BODY_MAX_UNITS
    && hugeReminder[0]!.payload?.truncated === true,
  `${hugeReminder[0]?.payload?.body?.length} truncated=${hugeReminder[0]?.payload?.truncated}`);

const plainSystem = mapKimiMessage({
  id: 'msg_ctx2',
  role: 'system',
  content: [{ type: 'text', text: 'The terminal took over this session.' }],
}).map((row) => row.message) as Array<{ type: string }>;
check('a real system message is still a notice, not folded away as context',
  plainSystem.length === 1 && plainSystem[0]!.type === 'notice',
  JSON.stringify(plainSystem[0]));

const embedded = mapKimiMessage({
  id: 'msg_ctx3',
  role: 'system',
  content: [{
    type: 'text',
    text: 'Heads up. <system-reminder>be careful</system-reminder> Act on this.',
  }],
}).map((row) => row.message) as Array<{ type: string }>;
check('a message that merely CONTAINS a reminder is not collapsed — it has content of its own',
  embedded.length === 1 && embedded[0]!.type === 'notice',
  JSON.stringify(embedded[0]));

// ── the row shape this actually arrives in ──────────────────────────────────
//
// Every case above is `role: 'system'`, which is the role Kimi never uses for
// injected context. On a live 0.36.1 server every whole `<system-reminder>` is
// `role: 'user'` carrying `metadata.origin.kind: 'injection'`, and none is
// `role: 'system'` — so the rule above, written for a row that does not occur,
// never fired, and the raw wrapper reached the transcript styled as text the
// operator had typed.
//
// The user row takes BOTH the provenance and the whole wrapper. Text alone
// proves nothing: a person may paste an entire reminder and still be writing.
const REMINDER_TEXT = '<system-reminder>\nAuto permission mode is active.\n</system-reminder>';
const injectedOrigin = { origin: { kind: 'injection', variant: 'permission_mode' } };

const userReminder = mapKimiMessage({
  id: 'msg_ctx_user',
  role: 'user',
  metadata: injectedOrigin,
  content: [{ type: 'text', text: REMINDER_TEXT }],
}).map((row) => row.message) as Array<{ type: string; name?: string; payload?: { source?: string; body?: string } }>;
check('a whole system-reminder Kimi calls an injection is context, not something the operator typed',
  userReminder.length === 1
    && userReminder[0]!.type === 'event'
    && userReminder[0]!.name === CONTEXT_INJECTION_EVENT
    && userReminder[0]!.payload?.source === 'system-reminder'
    && userReminder[0]!.payload?.body === 'Auto permission mode is active.',
  JSON.stringify(userReminder[0]));

// Provenance is REQUIRED, not merely consulted. Each of these is a whole,
// perfectly formed wrapper — the only thing separating them from the case above
// is Kimi's own account of who produced the row, and that has to be enough to
// keep the message whole. `cron_job` is a real third kind the live server
// returns; it is a schedule firing a genuine prompt, not injected context.
for (const [label, metadata] of [
  ['a person who pasted one', { origin: { kind: 'user' } }],
  ['a scheduled prompt', { origin: { kind: 'cron_job' } }],
  ['metadata that is absent', undefined],
  ['metadata with no origin', { variant: 'permission_mode' }],
  ['an origin that is not an object', { origin: 'injection' }],
  ['an origin kind that is not a string', { origin: { kind: 7 } }],
] as Array<[string, unknown]>) {
  const rows = mapKimiMessage({
    id: `msg_ctx_user_${label.replace(/\W+/g, '_')}`,
    role: 'user',
    ...(metadata === undefined ? {} : { metadata }),
    content: [{ type: 'text', text: REMINDER_TEXT }],
  }).map((row) => row.message) as Array<{ type: string; text?: string }>;
  check(`a whole wrapper from ${label} stays a user message, verbatim`,
    rows.length === 1 && rows[0]!.type === 'user-message' && rows[0]!.text === REMINDER_TEXT,
    JSON.stringify(rows[0]));
}

// The other half of the injected case: even WITH the provenance, a row that
// merely contains a reminder has content of its own and is never collapsed.
const userEmbedded = mapKimiMessage({
  id: 'msg_ctx_user2',
  role: 'user',
  metadata: injectedOrigin,
  content: [{
    type: 'text',
    text: 'Heads up. <system-reminder>be careful</system-reminder> Act on this.',
  }],
}).map((row) => row.message) as Array<{ type: string; text?: string }>;
check('a message that merely quotes a reminder stays whole even when marked injected',
  userEmbedded.length === 1
    && userEmbedded[0]!.type === 'user-message'
    && userEmbedded[0]!.text === 'Heads up. <system-reminder>be careful</system-reminder> Act on this.',
  JSON.stringify(userEmbedded[0]));

// ── Identity of equal-content rows ──────────────────────────────────────────

const twinNotices = [
  mapKimiMessage({ id: 'msg_n1', role: 'system', content: [{ type: 'text', text: 'same text' }] }),
  mapKimiMessage({ id: 'msg_n2', role: 'system', content: [{ type: 'text', text: 'same text' }] }),
].flat();
check('two identical notices from distinct native parts keep distinct identities',
  twinNotices.length === 2 && twinNotices[0]!.identity !== twinNotices[1]!.identity,
  twinNotices.map((row) => row.identity).join(' vs '));
const twinFiles = [
  mapKimiMessage({ id: 'msg_f1', role: 'assistant', content: [{ type: 'file', file_id: 'f', name: 'a.txt', media_type: 'text/plain', size: 1 }] }),
  mapKimiMessage({ id: 'msg_f2', role: 'assistant', content: [{ type: 'file', file_id: 'f', name: 'a.txt', media_type: 'text/plain', size: 1 }] }),
].flat();
check('two identical file rows keep distinct identities and artifact keys',
  twinFiles.length === 2 && twinFiles[0]!.identity !== twinFiles[1]!.identity
    && (twinFiles[0]!.message as { artifactKey?: string }).artifactKey
      !== (twinFiles[1]!.message as { artifactKey?: string }).artifactKey,
  twinFiles.map((row) => row.identity).join(' vs '));

const hostile: unknown[] = [null, 42, 'text', [], { id: 1 }, { id: 'x', content: 'not-an-array' }];
let threw = '';
for (const value of hostile) {
  try {
    mapKimiMessage(value as never);
  } catch (error) {
    threw = String(error);
  }
}
check('hostile message shapes never throw', threw === '', threw);

// ── Status overlays ─────────────────────────────────────────────────────────

const overlays = mapKimiSessionStatus(FIXTURE.rest.status!.data);
const usage = overlays.find((m) => m.type === 'metadata-update' && m.key === 'contextUsage');
check('session status maps to a context-usage overlay', !!usage,
  JSON.stringify(usage?.type === 'metadata-update' ? usage.value : undefined));
check('status mapping tolerates junk', mapKimiSessionStatus(null).length === 0);

// The host's reported approval mode has to reach the CONTRACT field the mode
// picker preselects from. Under any other name the broker still folds it onto
// the session info, where nothing declares it and nothing reads it — the picker
// stays blank and the session looks like it has no mode at all.
const info = overlays.find((m) => m.type === 'metadata-update' && m.key === 'sessionInfo');
const infoValue = (info?.type === 'metadata-update' ? info.value : {}) as Record<string, unknown>;
check('the reported permission mode arrives as SessionInfo.currentMode',
  infoValue.currentMode === 'manual', JSON.stringify(infoValue));
check('...and not under a name the contract does not declare',
  !('permissionMode' in infoValue), JSON.stringify(Object.keys(infoValue)));
// A host that reports no mode must leave the picker with nothing to preselect:
// an invented default would claim an approval posture nobody granted.
const modeless = mapKimiSessionStatus({ model: 'k3', busy: false });
const modelessInfo = modeless.find((m) => m.type === 'metadata-update' && m.key === 'sessionInfo');
check('a status without a permission mode invents none',
  !((modelessInfo?.type === 'metadata-update' ? modelessInfo.value : {}) as Record<string, unknown>).currentMode,
  JSON.stringify(modelessInfo));

// ── Run state: idle is a CLAIM, not a default ───────────────────────────────
//
// `busy` is a required boolean upstream (`protocol/session.ts:49`,
// `events-zod.ts:591-597`) and `pending_interaction` a closed enum, so anything
// else is a payload this reader cannot read. It must say so, because idle is
// what clears the drive connection's completion fences and ends the turn — a
// fabricated idle ends a turn that is still running.

const runStateEvidence: Array<[string, unknown, unknown, string | undefined]> = [
  ['busy:true', true, 'none', 'working'],
  ['busy:false', false, 'none', 'idle'],
  ['busy:false with no interaction field', false, undefined, 'idle'],
  ['busy:false + approval', false, 'approval', 'needs-input'],
  ['busy:false + question', false, 'question', 'needs-input'],
  // busy wins: a turn running while an interaction is unreaped is working.
  ['busy:true + approval', true, 'approval', 'working'],
  // ...and it wins over a field it does not depend on, however that field
  // drifts. `busy:true` is a complete answer on its own, so discarding it
  // because the interaction name is from a later version throws away real
  // evidence and leaves the caller holding a stale (usually idle) state for a
  // session the server just said is running.
  ['busy:true + an unknown pending_interaction', true, 'future-kind', 'working'],
  ['busy:true + a non-string pending_interaction', true, 42, 'working'],
  ['busy:true + a null pending_interaction', true, null, 'working'],
  // The reverse stays undefined: with busy:false the answer genuinely turns on
  // the interaction field, and an unreadable one cannot be narrowed into either
  // `idle` or `needs-input`.
  ['busy:false + an unknown pending_interaction', false, 'future-kind', undefined],
  ['busy:"false"', 'false', 'none', undefined],
  ['busy:null', null, 'none', undefined],
  ['busy absent', undefined, 'none', undefined],
  ['busy:0', 0, 'none', undefined],
  ['an unknown pending_interaction', false, 'a-state-from-the-future', undefined],
  ['a null pending_interaction', false, null, undefined],
];
const wrongRunState = runStateEvidence.filter(([, busy, pending, want]) =>
  mapKimiRunState(busy, pending) !== want);
check('run-state mapping answers undefined for every payload that is not evidence',
  wrongRunState.length === 0,
  wrongRunState.map(([name, busy, pending]) => `${name}→${String(mapKimiRunState(busy, pending))}`).join(' | '));

const workChangedJunk: unknown[] = [null, undefined, 42, 'busy', [], ['busy'], {}, { busy: 'false' }];
const fabricated = workChangedJunk.filter((payload) => mapKimiWorkChanged(payload) !== undefined);
check('a work_changed frame with no readable run state yields undefined, never idle',
  fabricated.length === 0, JSON.stringify(fabricated));
check('a well-formed work_changed frame still maps',
  mapKimiWorkChanged({ busy: true, pending_interaction: 'none' }) === 'working'
    && mapKimiWorkChanged({ busy: false, pending_interaction: 'none' }) === 'idle',
  `${mapKimiWorkChanged({ busy: true })} / ${mapKimiWorkChanged({ busy: false })}`);

// ── Approval detail truncation is UTF-8 safe ────────────────────────────────
//
// The cap is measured in bytes, so the cut must be made in bytes too. Slicing
// characters at a byte cap returned ~3x the cap for CJK, and a cut landing
// inside a surrogate pair emits a lone surrogate that is not valid UTF-8.

const utf8RoundTrips = (text: string) => Buffer.from(text, 'utf8').toString('utf8') === text;
const detailCases: Array<[string, string]> = [
  ['ascii', 'x'.repeat(KIMI_APPROVAL_DETAIL_CAP_BYTES * 3)],
  // 3 bytes per character: 4096 characters is 12288 bytes against a 2048 cap.
  ['cjk', '文'.repeat(KIMI_APPROVAL_DETAIL_CAP_BYTES * 2)],
  // 4 bytes per code point, 2 UTF-16 units each — the surrogate-pair case.
  ['emoji', '🙂'.repeat(KIMI_APPROVAL_DETAIL_CAP_BYTES)],
  // A pair sitting exactly where a byte-budget cut would fall.
  ['mixed', `${'a'.repeat(KIMI_APPROVAL_DETAIL_CAP_BYTES - 2)}🙂${'b'.repeat(64)}`],
];
for (const [name, input] of detailCases) {
  const detail = boundedKimiToolInput(input);
  const bytes = detail === undefined ? -1 : Buffer.byteLength(detail, 'utf8');
  check(`a ${name} tool input truncates to at most the cap in BYTES, on a code-point boundary`,
    detail !== undefined
      && bytes <= KIMI_APPROVAL_DETAIL_CAP_BYTES
      && detail.endsWith('… (truncated)')
      && utf8RoundTrips(detail),
    `${bytes} bytes, cap=${KIMI_APPROVAL_DETAIL_CAP_BYTES}, validUtf8=${detail !== undefined && utf8RoundTrips(detail)}`);
}
const shortDetail = boundedKimiToolInput('rm -rf /tmp/scratch');
check('an input under the cap is returned verbatim and unmarked',
  shortDetail === 'rm -rf /tmp/scratch', String(shortDetail));
// A JSON-rendered input is bounded on the rendered bytes, not on the source.
const rendered = boundedKimiToolInput({ command: '文'.repeat(KIMI_APPROVAL_DETAIL_CAP_BYTES) });
check('a rendered (non-string) tool input obeys the same byte cap',
  rendered !== undefined
    && Buffer.byteLength(rendered, 'utf8') <= KIMI_APPROVAL_DETAIL_CAP_BYTES
    && utf8RoundTrips(rendered),
  `${rendered === undefined ? -1 : Buffer.byteLength(rendered, 'utf8')} bytes`);

// ── Question ids are READ, never minted ─────────────────────────────────────
//
// The server synthesizes `q_<index>` / `opt_<item>_<option>` for every item and
// option (`routes/questions.ts:299-322`), and resolves an id it does not
// recognize by falling back to the id STRING as the answer text
// (`routes/questions.ts:381-403`). So an invented option id is delivered to the
// model as the literal answer "opt_0_1", and an invented item id keys a question
// that was never asked — a wrong answer, sent confidently, with no error.

const wellFormed = {
  question_id: 'qn_ok',
  questions: [{
    id: 'q_0', question: 'Pick one',
    options: [{ id: 'opt_0_0', label: 'Alpha' }, { id: 'opt_0_1', label: 'Beta' }],
    allow_other: true,
  }],
};
const okMapped = mapKimiQuestionRequest(wellFormed, false)!;
check('a well-formed question is answerable and actionable',
  okMapped.record.answerable === true && okMapped.message.readOnly === undefined,
  JSON.stringify(okMapped.message));
check('a well-formed answer keys the server\'s own ids',
  JSON.stringify(mapKimiQuestionAnswers(okMapped.record, [['Beta']]))
    === JSON.stringify({ q_0: { kind: 'single', option_id: 'opt_0_1' } }),
  JSON.stringify(mapKimiQuestionAnswers(okMapped.record, [['Beta']])));

const noItemId = mapKimiQuestionRequest({
  question_id: 'qn_no_item_id',
  questions: [{
    question: 'Pick one',
    options: [{ id: 'opt_0_0', label: 'Alpha' }, { id: 'opt_0_1', label: 'Beta' }],
  }],
}, false)!;
check('an item with no native id makes the question unanswerable but still DELIVERS it',
  noItemId.record.answerable === false
    && noItemId.message.readOnly === true
    && noItemId.message.questions.length === 1
    && noItemId.message.questions[0]?.question === 'Pick one',
  JSON.stringify(noItemId.message));
// NEGATIVE CONTROL for the invented id: the record must carry NO `q_`-shaped
// substitute at all, because a substitute is what would then be POSTed.
check('an item with no native id carries no minted replacement',
  noItemId.record.items[0]?.id === '' && !/q_\d/.test(JSON.stringify(noItemId.record)),
  JSON.stringify(noItemId.record));

const noOptionId = mapKimiQuestionRequest({
  question_id: 'qn_no_option_id',
  questions: [{
    id: 'q_0', question: 'Pick one',
    options: [{ id: 'opt_0_0', label: 'Alpha' }, { label: 'Beta' }],
  }],
}, false)!;
check('an option with no native id makes the WHOLE question unanswerable',
  noOptionId.record.answerable === false && noOptionId.message.readOnly === true
    && !/opt_\d+_\d+/.test(JSON.stringify(noOptionId.record.items[0]?.options[1])),
  JSON.stringify(noOptionId.record));

const refusals: Array<[string, () => unknown, string]> = [
  ['an unkeyable item', () => mapKimiQuestionAnswers(noItemId.record, [['Alpha']]), KIMI_UNKEYABLE_QUESTION],
  ['an unkeyable option', () => mapKimiQuestionAnswers(noOptionId.record, [['Alpha']]), KIMI_UNKEYABLE_QUESTION],
];
for (const [name, work, message] of refusals) {
  let error: Error | undefined;
  try { work(); } catch (thrown) { error = thrown as Error; }
  check(`answering ${name} refuses rather than inventing an id`,
    error?.message === message, error?.message ?? '(did not throw)');
}

// F8a: an unrepresentable selection is not a skip the user chose.
const noFreeText = mapKimiQuestionRequest({
  question_id: 'qn_closed',
  questions: [{
    id: 'q_0', question: 'Yes or no?',
    options: [{ id: 'opt_0_0', label: 'Yes' }, { id: 'opt_0_1', label: 'No' }],
    allow_other: false,
  }],
}, false)!;
let unrepresentable: Error | undefined;
try {
  mapKimiQuestionAnswers(noFreeText.record, [['Maybe']]);
} catch (thrown) { unrepresentable = thrown as Error; }
check('a non-empty selection the native union cannot express refuses instead of reporting a skip',
  unrepresentable?.message === KIMI_UNREPRESENTABLE_ANSWER,
  unrepresentable?.message ?? '(did not throw)');
check('a genuinely EMPTY selection is still a real skip',
  JSON.stringify(mapKimiQuestionAnswers(noFreeText.record, [[]]))
    === JSON.stringify({ q_0: { kind: 'skipped' } }),
  JSON.stringify(mapKimiQuestionAnswers(noFreeText.record, [[]])));
check('an omitted answer array is a skip too',
  JSON.stringify(mapKimiQuestionAnswers(noFreeText.record, []))
    === JSON.stringify({ q_0: { kind: 'skipped' } }),
  JSON.stringify(mapKimiQuestionAnswers(noFreeText.record, [])));

// The partial face of the same misattribution: one drifted label ALONGSIDE a
// matched one must refuse, not vanish — submitting the matched subset reports
// a smaller selection than the user made.
const multiClosed = mapKimiQuestionRequest({
  question_id: 'qn_multi_closed',
  questions: [{
    id: 'q_0', question: 'Pick any',
    options: [{ id: 'opt_0_0', label: 'A' }, { id: 'opt_0_1', label: 'B' }],
    multi_select: true, allow_other: false,
  }],
}, false)!;
let partial: Error | undefined;
try {
  mapKimiQuestionAnswers(multiClosed.record, [['A', 'STALE']]);
} catch (thrown) { partial = thrown as Error; }
check('a drifted label alongside a matched one refuses rather than silently dropping the choice',
  partial?.message === KIMI_UNREPRESENTABLE_ANSWER,
  partial?.message ?? `(did not throw — the drifted label was dropped)`);
check('the fully-matched multi selection still answers (the refusal is not overbroad)',
  JSON.stringify(mapKimiQuestionAnswers(multiClosed.record, [['A', 'B']]))
    === JSON.stringify({ q_0: { kind: 'multi', option_ids: ['opt_0_0', 'opt_0_1'] } }),
  JSON.stringify(mapKimiQuestionAnswers(multiClosed.record, [['A', 'B']])));

// ── A SINGLE-answer item cannot carry a plural selection ────────────────────
//
// The third face of the same misattribution. `questionAnswerSchema`
// (`/tmp/kimi-code` `packages/protocol/src/question.ts:35-45`) gives a
// single-answer item exactly two shapes — `single` with ONE `option_id`, `other`
// with ONE `text` — so a selection carrying two options, or an option plus a
// free text on an `allow_other` item, has no faithful encoding. Sending one of
// them reports a choice the user did not make, silently, and the answer reaches
// the model as if it had been chosen.

const singleOther = mapKimiQuestionRequest({
  question_id: 'qn_single_other',
  questions: [{
    id: 'q_0', question: 'Pick one',
    options: [{ id: 'opt_0_0', label: 'A' }, { id: 'opt_0_1', label: 'B' }],
    allow_other: true,
  }],
}, false)!;
const ambiguousCases: Array<[string, string[]]> = [
  ['two matched options', ['A', 'B']],
  ['a matched option plus free text', ['A', 'my own answer']],
  ['two free texts', ['one of mine', 'another of mine']],
];
for (const [name, labels] of ambiguousCases) {
  let ambiguous: Error | undefined;
  try {
    mapKimiQuestionAnswers(singleOther.record, [labels]);
  } catch (thrown) { ambiguous = thrown as Error; }
  check(`a single-answer item handed ${name} refuses rather than sending one of them`,
    ambiguous?.message === KIMI_AMBIGUOUS_SINGLE_ANSWER,
    ambiguous?.message ?? `(did not throw — sent ${JSON.stringify(mapKimiQuestionAnswers(singleOther.record, [labels]))})`);
}
// NEGATIVE CONTROL on the refusal's breadth: exactly one expressed value maps
// exactly as it did before, on both sides of the union.
check('one matched option on a single-answer item still maps to `single`',
  JSON.stringify(mapKimiQuestionAnswers(singleOther.record, [['B']]))
    === JSON.stringify({ q_0: { kind: 'single', option_id: 'opt_0_1' } }),
  JSON.stringify(mapKimiQuestionAnswers(singleOther.record, [['B']])));
check('one free text on an allow_other single-answer item still maps to `other`',
  JSON.stringify(mapKimiQuestionAnswers(singleOther.record, [['my own answer']]))
    === JSON.stringify({ q_0: { kind: 'other', text: 'my own answer' } }),
  JSON.stringify(mapKimiQuestionAnswers(singleOther.record, [['my own answer']])));
// ...and a MULTI item is untouched by the new rule: plural is what it is for.
check('a multi-select item still accepts a plural selection',
  JSON.stringify(mapKimiQuestionAnswers(multiClosed.record, [['A', 'B']]))
    === JSON.stringify({ q_0: { kind: 'multi', option_ids: ['opt_0_0', 'opt_0_1'] } })
    && JSON.stringify(mapKimiQuestionAnswers(
      mapKimiQuestionRequest({
        question_id: 'qn_multi_other',
        questions: [{
          id: 'q_0', question: 'Pick any',
          options: [{ id: 'opt_0_0', label: 'A' }, { id: 'opt_0_1', label: 'B' }],
          multi_select: true, allow_other: true,
        }],
      }, false)!.record,
      [['A', 'B', 'and one of mine']],
    )) === JSON.stringify({
      q_0: { kind: 'multi_with_other', option_ids: ['opt_0_0', 'opt_0_1'], other_text: 'and one of mine' },
    }),
  'multi and multi_with_other unchanged');

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
