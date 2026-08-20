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
import type { ModelOption } from '@cosyncing/adapter-api';
import {
  KIMI_APPROVAL_DETAIL_CAP_BYTES,
  KIMI_UNKEYABLE_QUESTION,
  KIMI_AMBIGUOUS_SINGLE_ANSWER,
  KIMI_UNREPRESENTABLE_ANSWER,
  boundedKimiToolInput,
  createKimiMappingState,
  kimiFallbackTitle,
  kimiForeignControlState,
  kimiOwnedControlState,
  kimiOwnedObserveControlState,
  kimiResumeTerminalCommand,
  mapKimiCreatedSession,
  mapKimiMessage,
  mapKimiMessagePage,
  mapKimiQuestionAnswers,
  mapKimiQuestionRequest,
  mapKimiRunState,
  mapKimiSession,
  mapKimiSessionStatus,
  mapKimiModelCatalog,
  mapKimiWorkChanged,
  KimiModelCatalogCache,
  type KimiMappedRow,
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

// ── Fallback titles ─────────────────────────────────────────────────────────
//
// An untitled session mapped AS its raw id renders two different names in the
// client: the roster shows the id verbatim while the header suppresses it as
// "Untitled session". The fallback is the codex/pi shape instead.

{
  check('an untitled session falls back to basename(cwd) plus the id prefix',
    mapKimiSession({ id: 'abcdef12-3456', workspace: { cwd: '/srv/u/my project' } })?.title
      === 'my project · abcdef12');
  check('the fallback with no cwd is the id itself, so roster and header agree',
    mapKimiSession({ id: 'abcdef12-3456' })?.title === 'abcdef12-3456');
  check('a real title wins, last_prompt second, the fallback last',
    mapKimiSession({ id: 's1', meta: { title: 'named' }, workspace: { cwd: '/w' } })?.title === 'named'
      && mapKimiSession({ id: 's2', meta: { last_prompt: 'what I asked' }, workspace: { cwd: '/w' } })?.title
        === 'what I asked'
      && mapKimiSession({ id: 's3', workspace: { cwd: '/w' } })?.title === 'w · s3');
  check('a created session composes the same fallback from metadata.cwd',
    mapKimiCreatedSession({ id: 'cafe0000-beef', metadata: { cwd: '/srv/u/proj' } })?.title
      === 'proj · cafe0000'
      && mapKimiCreatedSession({ id: 'cafe0000-beef', metadata: {} })?.title === 'cafe0000-beef'
      && mapKimiCreatedSession({ id: 'x', title: 'asked', metadata: { cwd: '/w' } })?.title === 'asked');
  check('the fallback helper itself is exactly the codex/pi shape',
    kimiFallbackTitle('0123456789ab', '/a/b/c') === 'c · 01234567'
      && kimiFallbackTitle('0123456789ab') === '0123456789ab');
}

// ── The owned driving state's resume-in-terminal command ────────────────────
//
// `kimi -S <id>` is confirmed upstream and is NOT cwd-scoped; the `cd` is a
// convenience for where the user's shell lands. Only the DRIVING state carries
// the command — a foreign session may have a live terminal owner this adapter
// cannot see, and an owned session opened in observe is not being handed off
// from here.

{
  const driving = kimiOwnedControlState('abcdef12-3456', '/srv/u/my project');
  check('the owned driving state publishes the resume command with shell quoting',
    driving.terminalSync.command === `cd '/srv/u/my project' && kimi -S abcdef12-3456`
      && driving.terminalSync.label === 'Resume in terminal'
      && driving.terminalSync.supported === false
      && driving.drive.handoffAvailable === true,
    driving.terminalSync.command ?? 'none');
  check('safe characters stay unquoted, and a single quote is escaped',
    kimiResumeTerminalCommand('s-1', '/plain/path_2') === 'cd /plain/path_2 && kimi -S s-1'
      && kimiResumeTerminalCommand(`s'1`, '/p') === `cd /p && kimi -S 's'\\''1'`);
  check('no cwd yields the bare resume command',
    kimiResumeTerminalCommand('s-1') === 'kimi -S s-1');
  check('the roster row for an owned session carries the command',
    mapKimiSession({ id: 's-owned', workspace: { cwd: '/w' } }, (id) => id === 's-owned')
      ?.control?.terminalSync.command === 'cd /w && kimi -S s-owned');
  check('the created-session row carries the command',
    mapKimiCreatedSession({ id: 's-new', metadata: { cwd: '/w' } })
      ?.control?.terminalSync.command === 'cd /w && kimi -S s-new');
  check('foreign and observe postures publish NO command',
    kimiForeignControlState().terminalSync.command === undefined
      && kimiOwnedObserveControlState().terminalSync.command === undefined
      && mapKimiSession({ id: 's-foreign', workspace: { cwd: '/w' } }, () => false)
        ?.control?.terminalSync.command === undefined);
}

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

// ── Skill/plugin activation rows SPLIT: the action, then the body ───────────
//
// kimi-code delivers a loaded skill as a separate `role: 'user'` wire message
// whose origin kind is `skill_activation` (or `plugin_command`) and whose text
// is the WHOLE loaded body — boilerplate prose plus a `<skill-loaded …>`
// envelope with attributes (upstream `agent/skill/prompt.ts`), a shape
// `unwrapContextBlock` cannot parse. Neither half is a message the operator
// typed: the row splits into the ACTION the user took (`/name args`, from the
// origin, not parsed out of the prose) and the body as a context event like
// any injection. Both halves keep the origin kind, so the divergence detector
// in `drive.ts` never reads them as a foreign prompt.

const SKILL_WIRE_TEXT = [
  'User activated the skill "commit". Follow the loaded skill instructions.',
  '',
  '<skill-loaded name="commit" trigger="user-slash" source="project" dir="/repo/.agents/skills/commit" args="please review">',
  '# Commit',
  'Stage, write the message, commit.',
  '</skill-loaded>',
].join('\n');
const skillOrigin = {
  origin: {
    kind: 'skill_activation', activationId: 'act_1',
    skillName: 'commit', skillArgs: 'please review', trigger: 'user-slash',
  },
};

const skillRows = mapKimiMessage({
  id: 'msg_skill',
  role: 'user',
  metadata: skillOrigin,
  content: [{ type: 'text', text: SKILL_WIRE_TEXT }],
});
const skillMessages = skillRows.map((row) => row.message) as Array<
  { type: string; text?: string; name?: string; payload?: { source?: string; body?: string } }
>;
check('a skill activation splits into exactly two rows: the action and the body',
  skillMessages.length === 2,
  JSON.stringify(skillMessages.map((row) => row.type)));
check('...the first a short user row for the action the user took, built from the origin',
  skillMessages[0]!.type === 'user-message' && skillMessages[0]!.text === '/commit please review',
  JSON.stringify(skillMessages[0]));
check('...the second a context event carrying the loaded body, envelope and attributes removed',
  skillMessages[1]!.type === 'event'
    && skillMessages[1]!.name === CONTEXT_INJECTION_EVENT
    && skillMessages[1]!.payload?.source === 'skill-loaded'
    && skillMessages[1]!.payload.body === [
      'User activated the skill "commit". Follow the loaded skill instructions.',
      '',
      '# Commit',
      'Stage, write the message, commit.',
    ].join('\n')
    && !skillMessages[1]!.payload.body.includes('<skill-loaded'),
  JSON.stringify(skillMessages[1]?.payload));
check('...with distinct identities, and BOTH rows keeping the origin kind the divergence detector reads',
  skillRows[0]!.identity !== skillRows[1]!.identity
    && skillRows.every((row) => row.originKind === 'skill_activation' && row.nativeRole === 'user'),
  JSON.stringify(skillRows.map((row) => ({ identity: row.identity, originKind: row.originKind }))));

// A no-args activation renders the bare command, upstream's own title shape.
const bareSkill = mapKimiMessage({
  id: 'msg_skill_bare',
  role: 'user',
  metadata: { origin: { kind: 'skill_activation', activationId: 'act_2', skillName: 'goal', trigger: 'user-slash' } },
  content: [{ type: 'text', text: '<skill-loaded name="goal" trigger="user-slash">\nWrite a goal.\n</skill-loaded>' }],
}).map((row) => row.message) as Array<{ type: string; text?: string }>;
check('a skill activated without args renders the bare /name',
  bareSkill.length === 2 && bareSkill[0]!.type === 'user-message' && bareSkill[0]!.text === '/goal',
  JSON.stringify(bareSkill[0]));

// A plugin command carries NO envelope: the text IS the expanded body, and the
// action reads `/plugin:command args` — upstream's own prompt-metadata shape
// (`promptMetadataTextFromPluginCommand`).
const pluginRows = mapKimiMessage({
  id: 'msg_plugin',
  role: 'user',
  metadata: {
    origin: {
      kind: 'plugin_command', activationId: 'act_3',
      pluginId: 'demo', commandName: 'wrap', commandArgs: 'src/', trigger: 'user-slash',
    },
  },
  content: [{ type: 'text', text: 'Expanded command body.\nDo the thing.' }],
});
const pluginMessages = pluginRows.map((row) => row.message) as Array<
  { type: string; text?: string; name?: string; payload?: { source?: string; body?: string } }
>;
check('a plugin command splits into a /plugin:command action row and its expanded body as context',
  pluginMessages.length === 2
    && pluginMessages[0]!.type === 'user-message'
    && pluginMessages[0]!.text === '/demo:wrap src/'
    && pluginMessages[1]!.type === 'event'
    && pluginMessages[1]!.name === CONTEXT_INJECTION_EVENT
    && pluginMessages[1]!.payload?.source === 'plugin_command'
    && pluginMessages[1]!.payload?.body === 'Expanded command body.\nDo the thing.',
  JSON.stringify(pluginMessages));
check('...and both rows keep the plugin_command origin kind',
  pluginRows.every((row) => row.originKind === 'plugin_command'),
  JSON.stringify(pluginRows.map((row) => row.originKind)));

// The safe direction for a row the adapter cannot attribute: an activation
// whose origin carries no NAME cannot be split without inventing the action,
// so it stays a whole user message — untidy, but nothing is hidden.
const nameless = mapKimiMessage({
  id: 'msg_skill_nameless',
  role: 'user',
  metadata: { origin: { kind: 'skill_activation', activationId: 'act_4', trigger: 'user-slash' } },
  content: [{ type: 'text', text: SKILL_WIRE_TEXT }],
}).map((row) => row.message) as Array<{ type: string; text?: string }>;
check('an activation whose origin carries no skill name stays a whole user message',
  nameless.length === 1 && nameless[0]!.type === 'user-message' && nameless[0]!.text === SKILL_WIRE_TEXT,
  JSON.stringify(nameless[0]));

// The other half of totality: an activation whose TEXT is not the expected
// envelope still splits on the origin's say-so — the action row from the
// origin, and the unparseable text kept whole as the body, labelled by the
// kind when no wrapper did.
const envelopeless = mapKimiMessage({
  id: 'msg_skill_envelopeless',
  role: 'user',
  metadata: skillOrigin,
  content: [{ type: 'text', text: 'The skill text, with no envelope around it.' }],
}).map((row) => row.message) as Array<
  { type: string; text?: string; name?: string; payload?: { source?: string; body?: string } }
>;
check('a skill activation whose text has no envelope still splits, body labelled by the origin kind',
  envelopeless.length === 2
    && envelopeless[0]!.type === 'user-message'
    && envelopeless[0]!.text === '/commit please review'
    && envelopeless[1]!.name === CONTEXT_INJECTION_EVENT
    && envelopeless[1]!.payload?.source === 'skill_activation'
    && envelopeless[1]!.payload?.body === 'The skill text, with no envelope around it.',
  JSON.stringify(envelopeless));

// Provenance is required here exactly as it is for injections: a row that
// merely QUOTES a skill envelope, written by a person, stays whole.
const quotedSkill = mapKimiMessage({
  id: 'msg_skill_quoted',
  role: 'user',
  metadata: { origin: { kind: 'user' } },
  content: [{ type: 'text', text: SKILL_WIRE_TEXT }],
}).map((row) => row.message) as Array<{ type: string; text?: string }>;
check('a person quoting a skill envelope stays a whole user message',
  quotedSkill.length === 1 && quotedSkill[0]!.type === 'user-message' && quotedSkill[0]!.text === SKILL_WIRE_TEXT,
  JSON.stringify(quotedSkill[0]));

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

// ── P8: the roster label is the HOST CATALOG's display name ─────────────────
//
// Probed on a live Kimi Code 0.37.2: `/status` reports the catalog's `model`
// verbatim, so the two join exactly. Without the join the client is left with a
// bare alias and prints `kimi-code/kimi-for-coding`, or `Kimi`, or the
// digit-scavenged `Kimi 3.256`.

{
  const catalog = mapKimiModelCatalog({
    items: [
      { provider: 'managed:kimi-code', model: 'kimi-code/kimi-for-coding', display_name: 'K2.7 Coding' },
      { provider: 'managed:kimi-code', model: 'kimi-code/kimi-for-coding-highspeed', display_name: 'K2.7 Coding Highspeed' },
      { provider: 'managed:kimi-code', model: 'kimi-code/k3', display_name: 'K3' },
      { provider: 'managed:kimi-code', model: 'kimi-code/k3-256k', display_name: 'K3-256k' },
    ],
  });
  const infoOf = (status: unknown, rows?: ModelOption[]) => {
    const overlay = mapKimiSessionStatus(status, rows)
      .find((m) => m.type === 'metadata-update' && m.key === 'sessionInfo');
    return (overlay?.type === 'metadata-update' ? overlay.value : {}) as Record<string, unknown>;
  };

  const coding = infoOf({ model: 'kimi-code/kimi-for-coding' }, catalog);
  check('a status model that joins the catalog carries the host display name',
    JSON.stringify(coding.currentModel) === JSON.stringify({
      providerID: 'managed:kimi-code', modelID: 'kimi-code/kimi-for-coding', label: 'K2.7 Coding',
    }),
    JSON.stringify(coding));
  check('...and the raw alias stays on `model` for the tooltip',
    coding.model === 'kimi-code/kimi-for-coding', JSON.stringify(coding));

  const k3 = infoOf({ model: 'kimi-code/k3-256k' }, catalog);
  check('the k3-256k alias labels as K3-256k, not the client\'s "Kimi 3.256" guess',
    (k3.currentModel as { label?: string } | undefined)?.label === 'K3-256k', JSON.stringify(k3));

  const unknown = infoOf({ model: 'kimi-code/k9-unreleased' }, catalog);
  check('a model the catalog does not know keeps the bare alias and invents no label',
    unknown.model === 'kimi-code/k9-unreleased' && unknown.currentModel === undefined,
    JSON.stringify(unknown));
  check('...and publishes an EXPLICIT clear, so a switch to it cannot leave the previous label folded in',
    'currentModel' in unknown && unknown.currentModel === undefined, JSON.stringify(unknown));
  const unreadCatalog = infoOf({ model: 'kimi-code/k9-unreleased' });
  const emptyCatalog = infoOf({ model: 'kimi-code/k9-unreleased' }, []);
  check('with no catalog loaded the overlay says nothing about the label either way',
    !('currentModel' in unreadCatalog) && !('currentModel' in emptyCatalog), JSON.stringify({ unreadCatalog, emptyCatalog }));
  const noCatalog = infoOf({ model: 'kimi-code/k3' });
  check('...and with no catalog at all the mapping is exactly what it was',
    noCatalog.model === 'kimi-code/k3' && noCatalog.currentModel === undefined,
    JSON.stringify(noCatalog));

  // The catalog is the only naming authority here: a row with no display_name
  // labels as its own alias rather than as something this adapter invented.
  const namelessCatalog = mapKimiModelCatalog({ items: [{ provider: 'kimi-code', model: 'k2' }] });
  const nameless = infoOf({ model: 'k2' }, namelessCatalog);
  check('a catalog row with no display_name labels as its own id',
    (nameless.currentModel as { label?: string } | undefined)?.label === 'k2', JSON.stringify(nameless));
}

// The cache is what keeps a 10 s poll from re-reading a per-host constant, and
// what still catches a model added mid-session.
{
  let reads = 0;
  let rows: ModelOption[] = mapKimiModelCatalog({
    items: [{ provider: 'managed:kimi-code', model: 'kimi-code/k3', display_name: 'K3' }],
  });
  const cache = new KimiModelCatalogCache();
  const read = async () => { reads += 1; return rows; };

  check('the first join reads the catalog once',
    (await cache.optionsFor('kimi-code/k3', read)).length === 1 && reads === 1, `reads=${reads}`);
  await cache.optionsFor('kimi-code/k3', read);
  check('a known alias is answered from the cache', reads === 1, `reads=${reads}`);

  // The host gained a model since this connection attached.
  rows = mapKimiModelCatalog({
    items: [
      { provider: 'managed:kimi-code', model: 'kimi-code/k3', display_name: 'K3' },
      { provider: 'managed:kimi-code', model: 'kimi-code/k4', display_name: 'K4' },
    ],
  });
  const refreshed = await cache.optionsFor('kimi-code/k4', read);
  check('an alias the cache lacks re-reads once and finds the new model',
    reads === 2 && refreshed.some((option) => option.modelID === 'kimi-code/k4'), `reads=${reads}`);
  await cache.optionsFor('kimi-code/k5-never-existed', read);
  await cache.optionsFor('kimi-code/k5-never-existed', read);
  check('an alias that stays unknown costs exactly one re-read, not one per poll',
    reads === 3, `reads=${reads}`);

  // A refused read must not forget a catalog the connection already has.
  const failing = async () => { reads += 1; return [] as ModelOption[]; };
  const kept = await cache.optionsFor('kimi-code/k6', failing);
  check('a failed re-read keeps the rows already held',
    kept.some((option) => option.modelID === 'kimi-code/k3'), JSON.stringify(kept.map((o) => o.modelID)));
  const cold = new KimiModelCatalogCache();
  check('a failed FIRST read yields no rows and no throw',
    (await cold.optionsFor('kimi-code/k3', failing)).length === 0);
  check('an absent model reads nothing at all',
    (await cold.optionsFor(undefined, failing)).length === 0);
}

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

// ── TodoList → the canonical task-list panel ────────────────────────────────
//
// Kimi's `TodoList` tool is SESSION STATE, not an invocation: `{todos: [...]}`
// replaces the list, `{todos: []}` clears it, and `{}` is a QUERY that changes
// nothing (upstream `agent/tools/todo-list/todo-list.ts`). The wire shapes
// under test are that declared schema, not a capture — the REST fold projects
// `tool_use` as `{tool_call_id, tool_name, input}` with no display payload, so
// `input` is what the mapper reads.

{
  const todoState = createKimiMappingState();
  const write = mapKimiMessage({
    id: 'msg_todo_write', role: 'assistant',
    content: [{
      type: 'tool_use', tool_call_id: 'call_todo_1', tool_name: 'TodoList',
      input: {
        todos: [
          { title: 'Wire the mapper', status: 'done' },
          { title: 'Write the tests', status: 'in_progress' },
          { title: 'Run the checks', status: 'pending' },
        ],
      },
    }],
  }, todoState).map((row) => row.message) as Array<{
    type: string; key?: string; title?: string; status?: string; sourceTool?: string;
    items?: Array<{ title: string; status: string }>;
  }>;
  check('a TodoList write maps to ONE task-list-state panel, not a tool card',
    write.length === 1
      && write[0]!.type === 'task-list-state'
      && write[0]!.key === 'kimi:todos'
      && write[0]!.title === 'Tasks'
      && write[0]!.sourceTool === 'TodoList'
      && write[0]!.status === 'running',
    JSON.stringify(write[0]));
  check('...with kimi statuses normalized to the canonical three',
    JSON.stringify(write[0]!.items) === JSON.stringify([
      { title: 'Wire the mapper', status: 'done' },
      { title: 'Write the tests', status: 'in-progress' },
      { title: 'Run the checks', status: 'open' },
    ]),
    JSON.stringify(write[0]!.items));

  const allDone = mapKimiMessage({
    id: 'msg_todo_done', role: 'assistant',
    content: [{
      type: 'tool_use', tool_call_id: 'call_todo_2', tool_name: 'TodoList',
      input: { todos: [{ title: 'Wire the mapper', status: 'done' }, { title: 'Write the tests', status: 'done' }] },
    }],
  }, todoState).map((row) => row.message) as Array<{ type: string; status?: string }>;
  check('a fully-done list reports panel status done',
    allDone.length === 1 && allDone[0]!.type === 'task-list-state' && allDone[0]!.status === 'done',
    JSON.stringify(allDone[0]));

  const cleared = mapKimiMessage({
    id: 'msg_todo_clear', role: 'assistant',
    content: [{
      type: 'tool_use', tool_call_id: 'call_todo_3', tool_name: 'TodoList',
      input: { todos: [] },
    }],
  }, todoState).map((row) => row.message) as Array<{ type: string; status?: string; items?: unknown[] }>;
  check('an explicit empty list CLEARS the panel',
    cleared.length === 1 && cleared[0]!.type === 'task-list-state'
      && cleared[0]!.status === 'cleared' && cleared[0]!.items!.length === 0,
    JSON.stringify(cleared[0]));

  // THE TRAP: `{}` is a query, not a clear. It must leave the panel alone —
  // emitting nothing panel-shaped — while staying a visible ordinary tool call.
  const query = mapKimiMessage({
    id: 'msg_todo_query', role: 'assistant',
    content: [{ type: 'tool_use', tool_call_id: 'call_todo_4', tool_name: 'TodoList', input: {} }],
  }, todoState).map((row) => row.message) as Array<{ type: string; callId?: string }>;
  check('a TodoList QUERY (todos absent) leaves the panel alone and stays a tool-call row',
    query.length === 1 && query[0]!.type === 'tool-call' && query[0]!.callId === 'call_todo_4',
    JSON.stringify(query[0]));

  for (const [label, input] of [
    ['todos that is not an array', { todos: 'nope' }],
    ['a non-object input', 'nope'],
  ] as Array<[string, unknown]>) {
    const malformed = mapKimiMessage({
      id: `msg_todo_bad_${label.replace(/\W+/g, '_')}`, role: 'assistant',
      content: [{ type: 'tool_use', tool_call_id: `call_todo_bad`, tool_name: 'TodoList', input }],
    }, todoState).map((row) => row.message) as Array<{ type: string }>;
    check(`a malformed TodoList call (${label}) falls through to a normal tool-call row`,
      malformed.length === 1 && malformed[0]!.type === 'tool-call',
      JSON.stringify(malformed[0]));
  }

  // A NONEMPTY list whose items are ALL unusable is drift, not a clear: the
  // malformed-falls-through rule governs, so the panel is left alone (no
  // `cleared` upsert) and the call degrades to a plain tool card.
  const allMalformed = mapKimiMessage({
    id: 'msg_todo_all_malformed', role: 'assistant',
    content: [{
      type: 'tool_use', tool_call_id: 'call_todo_all_bad', tool_name: 'TodoList',
      input: { todos: [{ status: 'done' }] },
    }],
  }, todoState).map((row) => row.message) as Array<{ type: string; callId?: string }>;
  check('a nonempty TodoList list with zero usable items falls through instead of CLEARING the panel',
    allMalformed.length === 1 && allMalformed[0]!.type === 'tool-call'
      && allMalformed[0]!.callId === 'call_todo_all_bad',
    JSON.stringify(allMalformed[0]));

  // The result suppression is keyed to calls that EMITTED the panel. A query
  // emitted none, so its non-error result — the only surface a query has —
  // must render; the same holds for a call that fell through as malformed.
  const queryResult = mapKimiMessage({
    id: 'msg_todo_query_result', role: 'tool',
    content: [{ type: 'tool_result', tool_call_id: 'call_todo_4', output: '1. [open] Run the checks' }],
  }, todoState).map((row) => row.message) as Array<{ type: string; result?: string }>;
  check('a TodoList QUERY result renders — it is the only surface a query has',
    queryResult.length === 1 && queryResult[0]!.type === 'tool-result'
      && queryResult[0]!.result === '1. [open] Run the checks',
    JSON.stringify(queryResult[0]));
  const fallthroughResult = mapKimiMessage({
    id: 'msg_todo_all_bad_result', role: 'tool',
    content: [{ type: 'tool_result', tool_call_id: 'call_todo_all_bad', output: 'rejected input' }],
  }, todoState).map((row) => row.message) as Array<{ type: string }>;
  check('a fallen-through TodoList call keeps its result too',
    fallthroughResult.length === 1 && fallthroughResult[0]!.type === 'tool-result',
    JSON.stringify(fallthroughResult[0]));

  // The panel is the surface; the paired result is an acknowledgment echo and
  // must not stack a second card (claude suppresses the TodoWrite result the
  // same way). The correlation needs the mapping state, because the REST
  // tool_result carries no tool_name — without it the result renders, which is
  // the safe direction.
  const echo = mapKimiMessage({
    id: 'msg_todo_result', role: 'tool',
    content: [{ type: 'tool_result', tool_call_id: 'call_todo_1', output: 'The todo list was updated.' }],
  }, todoState);
  check('the paired TodoList result is suppressed once the panel carries the state',
    echo.length === 0, JSON.stringify(echo));
  const failedEcho = mapKimiMessage({
    id: 'msg_todo_result_failed', role: 'tool',
    content: [{ type: 'tool_result', tool_call_id: 'call_todo_2', output: 'rejected', is_error: true }],
  }, todoState).map((row) => row.message) as Array<{ type: string; isError?: boolean }>;
  check('...but a FAILED TodoList call keeps its error row',
    failedEcho.length === 1 && failedEcho[0]!.type === 'tool-result' && failedEcho[0]!.isError === true,
    JSON.stringify(failedEcho[0]));
  const stateless = mapKimiMessage({
    id: 'msg_todo_result_stateless', role: 'tool',
    content: [{ type: 'tool_result', tool_call_id: 'call_todo_1', output: 'The todo list was updated.' }],
  }).map((row) => row.message) as Array<{ type: string }>;
  check('without the correlation state the result still renders (safe direction)',
    stateless.length === 1 && stateless[0]!.type === 'tool-result',
    JSON.stringify(stateless[0]));
}

// ── Background-task settlement notifications ────────────────────────────────
//
// A detached background task settling appends a `role: 'user'` row with
// `origin.kind === 'task'` (upstream `agent/task/taskService.ts`) whose text is
// a `<notification …>` envelope. The task id links to the originating tool call
// ONLY through the `task_id: <id>` line that opens the spawn result's output
// (upstream `bashTool.backgroundStartedResult`), recorded into the mapping
// state as the fold walks. Envelope and spawn-line shapes below follow those
// upstream sources.

const BG_SPAWN_OUTPUT = [
  'task_id: bash-abc12345',
  'pid: 4242',
  'description: npm test',
  'status: running',
  'automatic_notification: true',
].join('\n');

function bgSpawnMessages(state: ReturnType<typeof createKimiMappingState>, callId: string, taskId: string): void {
  mapKimiMessage({
    id: `msg_bg_call_${callId}`, role: 'assistant',
    content: [{ type: 'tool_use', tool_call_id: callId, tool_name: 'Bash', input: { command: 'npm test', run_in_background: true } }],
  }, state);
  mapKimiMessage({
    id: `msg_bg_result_${callId}`, role: 'tool',
    content: [{ type: 'tool_result', tool_call_id: callId, output: BG_SPAWN_OUTPUT.replace('bash-abc12345', taskId) }],
  }, state);
}

function bgNotificationWire(taskId: string, status: string, severity: string, body: string): {
  id: string; role: string; metadata: unknown; content: unknown[];
} {
  return {
    id: `msg_bg_note_${taskId}_${status}`,
    role: 'user',
    metadata: { origin: { kind: 'task', taskId, status, notificationId: `task:${taskId}:${status}` } },
    content: [{
      type: 'text',
      text: [
        `<notification id="task:${taskId}:${status}" category="task" type="task.${status}" source_kind="background_task" source_id="${taskId}">`,
        `Title: Background bash ${status}`,
        `Severity: ${severity}`,
        body,
        `<output-file path="/tmp/tasks/${taskId}.log" bytes="512">`,
        `Read the output file to retrieve the result: /tmp/tasks/${taskId}.log`,
        '</output-file>',
        '</notification>',
      ].join('\n'),
    }],
  };
}

{
  // (1) Correlation RESOLVES: the notification is the spawn call's deferred
  // tool-result — completed and failed variants alike.
  const taskState = createKimiMappingState();
  bgSpawnMessages(taskState, 'call_bg_1', 'bash-abc12345');
  const completed = mapKimiMessage(
    bgNotificationWire('bash-abc12345', 'completed', 'info', 'npm test completed.') as never,
    taskState,
  );
  const completedMessages = completed.map((row) => row.message) as Array<{
    type: string; callId?: string; toolName?: string; result?: string; isError?: boolean;
  }>;
  check('a settled background task folds onto its spawning call as the deferred tool-result',
    completedMessages.length === 1
      && completedMessages[0]!.type === 'tool-result'
      && completedMessages[0]!.callId === 'call_bg_1'
      && completedMessages[0]!.toolName === 'Bash'
      && completedMessages[0]!.isError === undefined,
    JSON.stringify(completedMessages[0]));
  check('...carrying a readable rendering (title, body, output path), envelope removed',
    completedMessages[0]!.result === [
      'Background bash completed',
      'npm test completed.',
      'Full output: /tmp/tasks/bash-abc12345.log',
    ].join('\n'),
    JSON.stringify(completedMessages[0]!.result));

  bgSpawnMessages(taskState, 'call_bg_2', 'bash-fail9999');
  const failedTask = mapKimiMessage(
    bgNotificationWire('bash-fail9999', 'failed', 'warning', 'npm test failed. Reason: exit code 1') as never,
    taskState,
  ).map((row) => row.message) as Array<{ type: string; callId?: string; isError?: boolean; result?: string }>;
  check('a FAILED background task folds the same way but stays visibly an error',
    failedTask.length === 1
      && failedTask[0]!.type === 'tool-result'
      && failedTask[0]!.callId === 'call_bg_2'
      && failedTask[0]!.isError === true
      && failedTask[0]!.result!.includes('exit code 1'),
    JSON.stringify(failedTask[0]));
  check('folded notification rows keep the task origin kind and never read as a user message',
    completed.every((row) => row.originKind === 'task' && row.nativeRole === 'user'
      && row.message.type !== 'user-message'),
    JSON.stringify(completed.map((row) => ({ type: row.message.type, originKind: row.originKind }))));
}

{
  // (3) Correlation does NOT resolve: a visible notice, failures severity-tagged.
  const lonely = mapKimiMessage(
    bgNotificationWire('bash-unknown0', 'completed', 'info', 'npm test completed.') as never,
    createKimiMappingState(),
  );
  const lonelyMessages = lonely.map((row) => row.message) as Array<{ type: string; message?: string }>;
  check('an uncorrelated settlement becomes a notice carrying title, body, task id, and output',
    lonelyMessages.length === 1
      && lonelyMessages[0]!.type === 'notice'
      && lonelyMessages[0]!.message === 'Background bash completed — npm test completed.'
        + ' (task bash-unknown0, output: /tmp/tasks/bash-unknown0.log)',
    JSON.stringify(lonelyMessages[0]));
  check('...and it too keeps the task origin kind, never a user message',
    lonely.every((row) => row.originKind === 'task' && row.message.type !== 'user-message'),
    JSON.stringify(lonely.map((row) => ({ type: row.message.type, originKind: row.originKind }))));

  const lonelyFailed = mapKimiMessage(
    bgNotificationWire('bash-unknown1', 'failed', 'warning', 'npm test failed.') as never,
    createKimiMappingState(),
  ).map((row) => row.message) as Array<{ type: string; message?: string }>;
  check('an uncorrelated FAILURE notice keeps its severity visible',
    lonelyFailed.length === 1
      && lonelyFailed[0]!.type === 'notice'
      && lonelyFailed[0]!.message!.startsWith('[warning] ')
      && lonelyFailed[0]!.message!.includes('Background bash failed'),
    JSON.stringify(lonelyFailed[0]));

  // The spawn line is anchored at the START of the result: a foreground call's
  // truncation footer mentions a task id too, and that task never notifies —
  // so it must not capture the correlation.
  const fgState = createKimiMappingState();
  mapKimiMessage({
    id: 'msg_fg_result', role: 'tool',
    content: [{
      type: 'tool_result', tool_call_id: 'call_fg_1',
      output: 'huge output…\n\n[Full output saved]\ntask_id: bash-fg77777\noutput_path: /tmp/x.log',
    }],
  }, fgState);
  const fgNotice = mapKimiMessage(
    bgNotificationWire('bash-fg77777', 'completed', 'info', 'done.') as never,
    fgState,
  ).map((row) => row.message) as Array<{ type: string }>;
  check('a task id mentioned mid-result does NOT capture the notification fold',
    fgNotice.length === 1 && fgNotice[0]!.type === 'notice',
    JSON.stringify(fgNotice[0]));

  // An envelope that will not parse still never becomes a user message — the
  // origin says the server wrote it — but stays visible as a raw notice.
  const raw = mapKimiMessage({
    id: 'msg_bg_raw', role: 'user',
    metadata: { origin: { kind: 'task', taskId: 'bash-raw0000', status: 'failed', notificationId: 'n' } },
    content: [{ type: 'text', text: 'not a notification envelope at all' }],
  }, createKimiMappingState());
  check('an unparseable task-origin row degrades to a visible notice, never a user message',
    raw.length === 1
      && raw[0]!.message.type === 'notice'
      && (raw[0]!.message as { message?: string }).message === 'not a notification envelope at all'
      && raw[0]!.originKind === 'task',
    JSON.stringify(raw[0]));

  // And the general floor: NO origin-kind-'task' row is ever a foreign-prompt
  // suspect — the detector suspects only kind 'user' or absent.
  const anyTask = mapKimiMessage(
    bgNotificationWire('bash-any0000', 'completed', 'info', 'done.') as never,
    createKimiMappingState(),
  );
  check("origin 'task' rows are never user-message suspects for the divergence detector",
    anyTask.length > 0
      && anyTask.every((row) => row.originKind === 'task')
      && anyTask.every((row) => row.message.type !== 'user-message'),
    JSON.stringify(anyTask.map((row) => row.message.type)));
}

// ── Subagent (`Agent` tool) activity bars ───────────────────────────────────
//
// The spawn tool is `Agent` — the ONLY tool producing an `agent-N` child — and
// the child id is runtime-assigned, never in the call, so bars key on the
// PARENT's toolCallId and take their title from `args.description` (child
// journals carry no title). FOREGROUND spawns (no `run_in_background`) are
// bracketed exactly by the call/result pair; DETACHED spawns return a task id
// immediately and settle later through the origin-kind-'task' notification.

function agentCallWire(id: string, callId: string, input: Record<string, unknown>, createdAt?: string): {
  id: string; role: string; created_at?: string; content: unknown[];
} {
  return {
    id, role: 'assistant',
    ...(createdAt ? { created_at: createdAt } : {}),
    content: [{ type: 'tool_use', tool_call_id: callId, tool_name: 'Agent', input }],
  };
}

function agentResultWire(id: string, callId: string, output: string, createdAt?: string, isError?: boolean): {
  id: string; role: string; created_at?: string; content: unknown[];
} {
  return {
    id, role: 'tool',
    ...(createdAt ? { created_at: createdAt } : {}),
    content: [{
      type: 'tool_result', tool_call_id: callId, output,
      ...(isError ? { is_error: true } : {}),
    }],
  };
}

type ActivityRow = {
  type: string; key?: string; kind?: string; title?: string; subtitle?: string;
  status?: string; elapsedMs?: number; startedAtMs?: number;
  agentsDone?: number; agentsTotal?: number;
};

{
  // FOREGROUND: the call/result pair brackets the run exactly.
  const fg = createKimiMappingState();
  const callRows = mapKimiMessage(agentCallWire('msg_ag_call_1', 'call_ag_1', {
    prompt: 'Find every caller of mapKimiMessage.\n\nReport back.',
    description: 'Find mapKimiMessage callers',
    subagent_type: 'explore',
  }, '2026-08-19T10:00:00.000Z') as never, fg).map((row) => row.message);
  const runningBar = callRows.find((row) => row.type === 'agent-activity') as ActivityRow | undefined;
  check('a foreground Agent call opens a running bar keyed on the parent toolCallId',
    callRows.length === 2
      && callRows[0]!.type === 'tool-call'
      && runningBar !== undefined
      && runningBar.key === 'agent:call_ag_1'
      && runningBar.kind === 'subagent'
      && runningBar.status === 'running'
      && runningBar.title === 'Find mapKimiMessage callers'
      && runningBar.subtitle === 'explore'
      && runningBar.startedAtMs === Date.parse('2026-08-19T10:00:00.000Z')
      && runningBar.agentsDone === 0 && runningBar.agentsTotal === 1,
    JSON.stringify(callRows));

  const resultRows = mapKimiMessage(agentResultWire(
    'msg_ag_result_1', 'call_ag_1', 'agent_id: agent-0\n\nFound 3 callers.',
    '2026-08-19T10:12:30.000Z',
  ) as never, fg).map((row) => row.message);
  const doneBar = resultRows.find((row) => row.type === 'agent-activity') as ActivityRow | undefined;
  check('the paired result closes the bar as done with the parent-wait elapsed',
    resultRows.length === 2
      && resultRows[0]!.type === 'tool-result'
      && doneBar !== undefined
      && doneBar.key === 'agent:call_ag_1'
      && doneBar.status === 'done'
      && doneBar.elapsedMs === 12 * 60 * 1000 + 30 * 1000
      && doneBar.agentsDone === 1 && doneBar.agentsTotal === 1,
    JSON.stringify(resultRows));

  // FOREGROUND, FAILED: the bar closes as error.
  const fgErr = createKimiMappingState();
  mapKimiMessage(agentCallWire('msg_ag_call_2', 'call_ag_2', {
    prompt: 'p', description: 'failing explorer',
  }) as never, fgErr);
  const errRows = mapKimiMessage(
    agentResultWire('msg_ag_result_2', 'call_ag_2', 'Error: blew up', undefined, true) as never,
    fgErr,
  ).map((row) => row.message);
  const errBar = errRows.find((row) => row.type === 'agent-activity') as ActivityRow | undefined;
  check('a failed foreground Agent result closes the bar as error',
    errRows.length === 2 && errBar?.status === 'error' && errBar.key === 'agent:call_ag_2',
    JSON.stringify(errRows));

  // Without the correlation state there is no bar at all — never an unclosable one.
  const stateless = mapKimiMessage(agentCallWire('msg_ag_call_3', 'call_ag_3', {
    prompt: 'p', description: 'stateless',
  }) as never);
  check('a stateless fold keeps the plain tool card and opens no bar',
    stateless.length === 1 && stateless[0]!.message.type === 'tool-call',
    JSON.stringify(stateless.map((row) => row.message.type)));

  // A call whose result ALREADY folded (the page-straddle guard) opens nothing.
  const straddle = createKimiMappingState();
  mapKimiMessage(agentResultWire('msg_ag_result_4', 'call_ag_4', 'done first') as never, straddle);
  const lateCall = mapKimiMessage(agentCallWire('msg_ag_call_4', 'call_ag_4', {
    prompt: 'p', description: 'straddled',
  }) as never, straddle).map((row) => row.message);
  check('a call folding after its own result opens no bar that nothing would close',
    lateCall.length === 1 && lateCall[0]!.type === 'tool-call',
    JSON.stringify(lateCall));
}

{
  // DETACHED: the pair brackets only the wait for a task id, never the run.
  const bg = createKimiMappingState();
  const spawnCall = mapKimiMessage(agentCallWire('msg_ag_call_bg1', 'call_ag_bg1', {
    prompt: 'Audit the auth module.',
    description: 'Audit auth module',
    subagent_type: 'coder',
    run_in_background: true,
  }, '2026-08-19T11:00:00.000Z') as never, bg).map((row) => row.message);
  check('a detached Agent call is a plain tool card — no instantly-completing bar',
    spawnCall.length === 1 && spawnCall[0]!.type === 'tool-call',
    JSON.stringify(spawnCall));

  const spawnResult = mapKimiMessage(agentResultWire(
    'msg_ag_result_bg1', 'call_ag_bg1',
    ['task_id: agent-a1b2c3d4', 'agent_id: agent-1', 'status: running', 'automatic_notification: true'].join('\n'),
    '2026-08-19T11:00:01.000Z',
  ) as never, bg).map((row) => row.message);
  const bgRunning = spawnResult.find((row) => row.type === 'agent-activity') as ActivityRow | undefined;
  check('the detached spawn result opens the running bar (with title and subtitle from the call)',
    spawnResult.length === 2
      && spawnResult[0]!.type === 'tool-result'
      && bgRunning !== undefined
      && bgRunning.key === 'agent:call_ag_bg1'
      && bgRunning.status === 'running'
      && bgRunning.title === 'Audit auth module'
      && bgRunning.subtitle === 'coder',
    JSON.stringify(spawnResult));

  // The settlement notification (the issue-13 row, carrying agent_id) closes it.
  const settled = mapKimiMessage({
    id: 'msg_ag_note_bg1', role: 'user',
    created_at: '2026-08-19T11:09:00.000Z',
    metadata: { origin: { kind: 'task', taskId: 'agent-a1b2c3d4', status: 'completed', agent_id: 'agent-1', notificationId: 'task:agent-a1b2c3d4:completed' } },
    content: [{
      type: 'text',
      text: [
        '<notification id="task:agent-a1b2c3d4:completed" category="task" type="task.completed" source_kind="background_task" source_id="agent-a1b2c3d4">',
        'Title: Subagent completed',
        'Severity: info',
        'Audit auth module finished.',
        '</notification>',
      ].join('\n'),
    }],
  } as never, bg).map((row) => row.message);
  const bgDone = settled.find((row) => row.type === 'agent-activity') as ActivityRow | undefined;
  check('the settlement notification folds as the deferred tool-result AND closes the bar',
    settled.length === 2
      && settled[0]!.type === 'tool-result'
      && (settled[0] as { callId?: string }).callId === 'call_ag_bg1'
      && bgDone !== undefined
      && bgDone.status === 'done'
      && bgDone.key === 'agent:call_ag_bg1'
      && bgDone.elapsedMs === 9 * 60 * 1000,
    JSON.stringify(settled));

  // A FAILED detached run closes the bar as error and keeps the error visible.
  const bgFail = createKimiMappingState();
  mapKimiMessage(agentCallWire('msg_ag_call_bg2', 'call_ag_bg2', {
    prompt: 'p', description: 'doomed task', run_in_background: true,
  }) as never, bgFail);
  mapKimiMessage(agentResultWire(
    'msg_ag_result_bg2', 'call_ag_bg2', 'task_id: agent-deadbeef\nagent_id: agent-2',
  ) as never, bgFail);
  const failSettled = mapKimiMessage({
    id: 'msg_ag_note_bg2', role: 'user',
    metadata: { origin: { kind: 'task', taskId: 'agent-deadbeef', status: 'failed', agent_id: 'agent-2', notificationId: 'task:agent-deadbeef:failed' } },
    content: [{
      type: 'text',
      text: [
        '<notification id="task:agent-deadbeef:failed" category="task" type="task.failed" source_kind="background_task" source_id="agent-deadbeef">',
        'Title: Subagent failed',
        'Severity: warning',
        'doomed task failed.',
        '</notification>',
      ].join('\n'),
    }],
  } as never, bgFail).map((row) => row.message);
  const failBar = failSettled.find((row) => row.type === 'agent-activity') as ActivityRow | undefined;
  check('a failed detached run closes the bar as error and the fold stays visibly an error',
    failSettled.length === 2
      && (failSettled[0] as { isError?: boolean }).isError === true
      && failBar?.status === 'error',
    JSON.stringify(failSettled));

  // A detached spawn whose settlement ALREADY folded (notification first in a
  // newest-first catch-up walk) opens no bar that nothing would close.
  const reversed = createKimiMappingState();
  mapKimiMessage({
    id: 'msg_ag_note_bg3', role: 'user',
    metadata: { origin: { kind: 'task', taskId: 'agent-cafe0000', status: 'completed', notificationId: 'n' } },
    content: [{
      type: 'text',
      text: '<notification id="task:agent-cafe0000:completed" category="task" type="task.completed" source_kind="background_task" source_id="agent-cafe0000">\nTitle: Subagent completed\nEarly settlement.\n</notification>',
    }],
  } as never, reversed);
  mapKimiMessage(agentCallWire('msg_ag_call_bg3', 'call_ag_bg3', {
    prompt: 'p', description: 'late spawn', run_in_background: true,
  }) as never, reversed);
  const lateSpawn = mapKimiMessage(agentResultWire(
    'msg_ag_result_bg3', 'call_ag_bg3', 'task_id: agent-cafe0000\nagent_id: agent-3',
  ) as never, reversed).map((row) => row.message);
  check('a spawn result for an already-settled task opens no bar',
    lateSpawn.length === 1 && lateSpawn[0]!.type === 'tool-result',
    JSON.stringify(lateSpawn));

  // A detached Bash spawn (kind:'process' task) never touches the bar surface.
  const bashState = createKimiMappingState();
  bgSpawnMessages(bashState, 'call_bg_proc', 'bash-proc9999');
  check('a detached Bash spawn opens no subagent bar',
    !bashState.agentActivities || bashState.agentActivities.size === 0);
}

// ── Echoed media rows ───────────────────────────────────────────────────────
//
// Upstream rehydrates `blobref:` media into a real `data:` URI before
// projecting history (`messageHistory.ts:165-187`), so an echoed image arrives
// as `{type:'image', source:{kind:'url', url:'data:image/…'}}` and deserves a
// real image row; an unresolvable ref arrives as the literal `[media missing]`
// and keeps the event fallback.

{
  const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk';
  const imageRow = mapKimiMessage({
    id: 'msg_img_1', role: 'user',
    content: [{ type: 'image', source: { kind: 'url', url: dataUri } }],
  } as never);
  check('an echoed image with a data: URI surfaces as a real image artifact row',
    imageRow.length === 2
      && imageRow[1]!.message.type === 'file-artifact'
      && (imageRow[1]!.message as { url?: string }).url === dataUri
      && (imageRow[1]!.message as { mimeType?: string }).mimeType === 'image/png'
      && (imageRow[1]!.message as { artifactKey?: string }).artifactKey === 'kimi:msg_img_1:0',
    JSON.stringify(imageRow[1]));

  const missing = mapKimiMessage({
    id: 'msg_img_2', role: 'user',
    content: [{ type: 'image', source: { kind: 'url', url: '[media missing]' } }],
  } as never);
  check('an unresolvable media ref keeps the event fallback',
    missing.length === 1
      && missing[0]!.message.type === 'event'
      && (missing[0]!.message as { name?: string }).name === 'kimi.image',
    JSON.stringify(missing[0]));

  const otherShapes = [
    { type: 'video', source: { kind: 'url', url: dataUri } },
    { type: 'image', source: { kind: 'blobref', ref: 'blob_1' } },
    { type: 'image' },
  ];
  const fallbacks = otherShapes.map((part) => mapKimiMessage({
    id: 'msg_img_x', role: 'user', content: [part],
  } as never));
  check('video and non-url sources keep the event fallback too',
    fallbacks.every((rows) => rows.length === 1 && rows[0]!.message.type === 'event'
      && (rows[0]!.message as { name?: string }).name !== 'kimi.unmapped-content'),
    JSON.stringify(fallbacks.map((rows) => rows[0]!.message)));

  const oversized = mapKimiMessage({
    id: 'msg_img_3', role: 'user',
    content: [{ type: 'image', source: { kind: 'url', url: `data:image/png;base64,${'A'.repeat(7_000_100)}` } }],
  } as never);
  const oversizedArtifact = oversized.find((row) => row.message.type === 'file-artifact');
  check('an image past the inline cap goes header-only rather than shipping the data URL',
    oversized.length === 2
      && oversizedArtifact !== undefined
      && (oversizedArtifact.message as { url?: string }).url === undefined,
    JSON.stringify(oversized.map((row) => row.message.type)));
}

// ── P6: a sent image belongs to the user row it was sent with ───────────────
//
// The artifact carries `userMessageKey`, the protocol's ownership link, so the
// client can render it inside the right-aligned user surface instead of as an
// agent deliverable. An image-only prompt still gets a user row — empty text —
// because the link needs a target and the person's send needs a bubble.

{
  const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk';
  const image = (url = dataUri) => ({ type: 'image', source: { kind: 'url', url } });
  const userRow = (rows: KimiMappedRow[]) =>
    rows.find((row) => row.message.type === 'user-message')?.message as
      { type: 'user-message'; text: string; key?: string; imageCount?: number } | undefined;
  const artifacts = (rows: KimiMappedRow[]) =>
    rows.filter((row) => row.message.type === 'file-artifact')
      .map((row) => row.message as { name: string; artifactKey?: string; userMessageKey?: string });

  const withText = mapKimiMessage({
    id: 'msg_p6_1', role: 'user',
    content: [{ type: 'text', text: 'what is in this screenshot?' }, image()],
  } as never);
  const withTextUser = userRow(withText);
  check('a text+image prompt links the artifact to that prompt\'s user row',
    withTextUser?.key === 'kimi:msg_p6_1:0'
      && withTextUser.text === 'what is in this screenshot?'
      && artifacts(withText).length === 1
      && artifacts(withText)[0]!.userMessageKey === withTextUser.key,
    JSON.stringify(withText.map((row) => row.message)));
  check('...and the user row states how many images travelled with it',
    withTextUser?.imageCount === 1, JSON.stringify(withTextUser));

  // The reported defect: nothing but the attachment, so before this there was
  // no user row at all and the card rendered detached.
  const imageOnly = mapKimiMessage({
    id: 'msg_p6_2', role: 'user', created_at: '2026-08-14T09:00:00.000Z',
    content: [image()],
  } as never);
  const imageOnlyUser = userRow(imageOnly);
  check('an image-only prompt still emits a user row, with empty text',
    imageOnly[0]!.message.type === 'user-message'
      && imageOnlyUser?.text === ''
      && imageOnlyUser.key === 'kimi:msg_p6_2:u'
      && imageOnlyUser.imageCount === 1,
    JSON.stringify(imageOnly.map((row) => row.message)));
  check('...and the artifact names it as its owner',
    artifacts(imageOnly)[0]!.userMessageKey === 'kimi:msg_p6_2:u'
      && artifacts(imageOnly)[0]!.artifactKey === 'kimi:msg_p6_2:0',
    JSON.stringify(artifacts(imageOnly)));
  check('...on a row that carries the native send time like any other user row',
    (imageOnly[0]!.message as { sentAt?: number }).sentAt === Date.parse('2026-08-14T09:00:00.000Z'),
    JSON.stringify(imageOnly[0]!.message));

  // Several text parts: ONE deterministic owner, the first user row in part
  // order, and the second text row is untouched.
  const multiText = mapKimiMessage({
    id: 'msg_p6_3', role: 'user',
    content: [
      { type: 'text', text: 'first' },
      image(),
      { type: 'text', text: 'second' },
      image('data:image/jpeg;base64,AAAA'),
    ],
  } as never);
  const multiUsers = multiText.filter((row) => row.message.type === 'user-message');
  check('several text parts pick the FIRST user row as the deterministic owner',
    multiUsers.length === 2
      && (multiUsers[0]!.message as { key?: string }).key === 'kimi:msg_p6_3:0'
      && (multiUsers[1]!.message as { imageCount?: number }).imageCount === undefined
      && artifacts(multiText).every((artifact) => artifact.userMessageKey === 'kimi:msg_p6_3:0')
      && (multiUsers[0]!.message as { imageCount?: number }).imageCount === 2,
    JSON.stringify(multiText.map((row) => row.message)));

  // Live and history read the same native record through the same mapper, so
  // the keys the client dedupes on must be identical either way.
  const native = {
    id: 'msg_p6_4', role: 'user', created_at: '2026-08-14T09:00:00.000Z',
    content: [{ type: 'text', text: 'look' }, image()],
  };
  const live = mapKimiMessage(native as never);
  const history = mapKimiMessagePage({ items: [native], has_more: false } as never).rows;
  check('history and live produce identical keys and links for one native message',
    JSON.stringify(live.map((row) => [row.identity, row.message]))
      === JSON.stringify(history.map((row) => [row.identity, row.message])),
    JSON.stringify(history.map((row) => row.identity)));

  // Only a USER row's image is an attachment. An assistant-produced image is a
  // deliverable and must keep its detached artifact card.
  const assistant = mapKimiMessage({
    id: 'msg_p6_5', role: 'assistant',
    content: [{ type: 'text', text: 'here it is' }, image()],
  } as never);
  check('an assistant image is a deliverable, not an attachment',
    assistant.every((row) => row.message.type !== 'user-message')
      && artifacts(assistant)[0]!.userMessageKey === undefined,
    JSON.stringify(assistant.map((row) => row.message)));

  // The event fallback is not an artifact, so an unresolvable ref links nothing
  // and mints no bubble that would sit empty in the transcript.
  const unresolvable = mapKimiMessage({
    id: 'msg_p6_6', role: 'user',
    content: [{ type: 'image', source: { kind: 'url', url: '[media missing]' } }],
  } as never);
  check('an unresolvable image mints no empty user row',
    unresolvable.length === 1 && unresolvable[0]!.message.type === 'event',
    JSON.stringify(unresolvable.map((row) => row.message)));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
