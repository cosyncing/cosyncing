#!/usr/bin/env bun
/**
 * Seed an isolated, entirely fictitious agent/broker state tree for release captures.
 *
 * Store and README screenshots must show the REAL Flutter app (doc 14, decision 2) driven by data
 * that is not the maintainer's. This script builds a throwaway world — HOME, agent state, broker
 * state, AND the working directories the sessions refer to — under one unique root, then prints the
 * exact environment a review broker must be started with so it can see nothing else.
 *
 *   bun run scripts/dev/seed-brand-fixture.ts            # picks its own unique root
 *   bun run scripts/dev/seed-brand-fixture.ts --root DIR # a new or empty directory, never a full one
 *
 * Everything is self-contained and user-writable by construction. The fixture never touches a
 * privileged location and never asks for one: an image campaign that only reproduces on a host
 * somebody ran `sudo` on is not reproducible.
 *
 * The root lives outside the repository on purpose. Claude and Codex session ids are base64url of
 * the transcript path, so a root under `output/` would encode this checkout's absolute path into
 * every id the broker publishes — recoverable from any capture that shows one.
 *
 * Every path, project, machine, model, prompt, file, command, and notification below is made up.
 * No host path, credential, tailnet name, or real session id may enter this file.
 *
 * The exact state seeded here is written to `<root>/manifest.json`, and
 * `scripts/dev/verify-brand-fixture.ts` refuses to let a capture proceed unless the live broker
 * publishes that set precisely — no additions, no omissions.
 *
 * `--now` fixes the clock so a rerun reproduces the same relative session ages; the default is the
 * wall clock, which is what you want when capturing (freshness gates read real time).
 */
import { chmodSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AttentionStore } from '../../packages/typescript/broker/src/attention-store.ts';

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

/**
 * A short, unique, lowercase root: these paths are on camera. The roster prints each project's
 * directory and the artifact card prints an absolute file path, so a long root ellipsizes on a
 * phone-width frame and a shouty random one reads like debris. Unique per run so two capture runs
 * can never share, inherit, or half-overwrite each other's state.
 */
const newRoot = (): string => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = join(tmpdir(), `code-${randomBytes(4).toString('hex').slice(0, 6)}`);
    try {
      mkdirSync(candidate, { recursive: false, mode: 0o700 });
      return candidate;
    } catch { /* taken; try again */ }
  }
  throw new Error(`could not create a unique fixture root under ${tmpdir()}`);
};

/**
 * Proof that a directory is a fixture root this script made.
 *
 * `run-store-capture.sh` removes the root recursively when the run ends, and a recursive remove is
 * only ever as safe as the path it is handed. So every root gets stamped, and both the maintenance
 * modes below and the runner's cleanup refuse to touch a directory that is not stamped. A mistyped
 * `--root`, a stale value inherited from the environment, or a path that used to be a fixture and
 * is now somebody's working directory then fails closed instead of being deleted.
 */
const SENTINEL = '.brand-fixture-root';
const SENTINEL_TEXT =
  'seed-brand-fixture.ts: throwaway release-capture fixture. Everything under this directory is '
  + 'generated and safe to delete.\n';
const isFixtureRoot = (directory: string): boolean => {
  try {
    return readFileSync(join(directory, SENTINEL), 'utf8').startsWith('seed-brand-fixture.ts:');
  } catch {
    return false;
  }
};

const explicitRoot = arg('root');
const maintenance = process.argv.includes('--settle-timestamps') || process.argv.includes('--reset-attention');
if (maintenance && !explicitRoot) throw new Error('--settle-timestamps and --reset-attention need --root');

const root = explicitRoot ? resolve(explicitRoot) : newRoot();
if (maintenance) {
  // Reads and rewrites files inside an existing root: it must be one of ours.
  if (!isFixtureRoot(root)) {
    throw new Error(`${root} is not a fixture root created by this script (no ${SENTINEL})`);
  }
} else if (explicitRoot) {
  // A caller may create the root itself — run-store-capture.sh does, so that the only path it ever
  // deletes is one it made — but seeding into a directory that already holds anything is refused.
  // Half-overwriting a live tree is how a "fixture" ends up publishing something real.
  let existing: string[] | null = null;
  try {
    existing = readdirSync(root);
  } catch {
    existing = null;
  }
  if (existing === null) mkdirSync(root, { recursive: false, mode: 0o700 });
  else if (existing.filter((entry) => entry !== SENTINEL).length > 0) {
    throw new Error(`--root ${root} is not empty; pass a new directory or an empty one`);
  }
}
if (!maintenance) writeFileSync(join(root, SENTINEL), SENTINEL_TEXT);

/**
 * Second pass: put the notification inbox back onto the ages it was seeded with.
 *
 * The store stamps `updatedAt` with the wall clock whenever an event changes semantically, and a
 * broker advances `presentationRevision`/`presentationStage` the first time it publishes one. So
 * the first broker start restamps every seeded event and the whole inbox reads "just now" —
 * truthful for a broker that has been alive for ten seconds, and a misrepresentation in a store
 * screenshot, where an inbox is supposed to look lived-in.
 *
 * Run this between a settling broker start and the capture broker: by then presentation has
 * advanced, so restoring `updatedAt` leaves nothing for the second start to change. Nothing about
 * the product is altered — only which moment the fixture claims these notifications arrived.
 */
if (process.argv.includes('--settle-timestamps')) {
  const snapshot = join(root, '.fixture', 'cosyncing-home', 'attention-events.json');
  const file = JSON.parse(readFileSync(snapshot, 'utf8')) as {
    events: { dedupeKey: string; createdAt: number; updatedAt: number }[];
  };
  for (const event of file.events) event.updatedAt = event.createdAt;
  const settled = `${JSON.stringify(file, null, 2)}\n`;
  writeFileSync(snapshot, settled);
  // Keep the settled feed, so a later locale can be captured against the same inbox this one was.
  writeFileSync(join(root, '.fixture', 'attention-settled.json'), settled);
  console.log(`settled ${file.events.length} attention timestamps back onto their seeded ages`);
  process.exit(0);
}

/**
 * Put the notification inbox back to the settled feed, for the next locale.
 *
 * A capture leaves its own footprints in the broker's attention store — a pending approval is a
 * notification, and so is a run of pre-enrolment auth failures. Both are correct, and both belong to
 * the run that caused them: without this, the second locale's Notifications frame would show a card
 * the first locale's does not, and the two sets would stop being the same campaign.
 *
 * Only ever with the broker stopped: the store holds this file in memory.
 */
if (process.argv.includes('--reset-attention')) {
  const settled = join(root, '.fixture', 'attention-settled.json');
  const snapshot = join(root, '.fixture', 'cosyncing-home', 'attention-events.json');
  writeFileSync(snapshot, readFileSync(settled, 'utf8'));
  console.log('restored the settled notification feed');
  process.exit(0);
}

const now = Number(arg('now') ?? Date.now());
if (!Number.isSafeInteger(now)) throw new Error('--now must be epoch milliseconds');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (ago: number): number => now - ago;
const iso = (ms: number): string => new Date(ms).toISOString();

// ── invented world ──────────────────────────────────────────────────────────────
// Four projects on one self-hosted machine, all inside the fixture root so they exist for real
// without any privileged mkdir. A Claude session whose `cwd` does not exist reports Drive as
// unavailable with "Workspace no longer exists — cannot resume." — truthful for a fixture and
// actively misleading in a store screenshot — so these directories are load-bearing.
const MACHINE = 'workshop';
const PROJECTS = {
  atlas: join(root, 'atlas-api'),
  harbor: join(root, 'harbor-web'),
  meridian: join(root, 'meridian-cli'),
  lantern: join(root, 'lantern-docs'),
} as const;

const CLAUDE_MODEL = 'claude-opus-5';

/**
 * The one live turn in the fixture: the approval the Session Detail frames are of.
 *
 * A permission request is not transcript data — the CLI raises it mid-turn over its control channel
 * and blocks until the answer comes back, so the only way to photograph an approval the app can
 * actually act on is to have a driven session raise one. The capture takes the session over from the
 * app and sends `prompt`; the fixture's stand-in binary echoes it, replies, and asks to run
 * `command`. Nothing here is answered by the fixture: the card is still pending when the shutter
 * falls, which is what the frame is meant to show.
 *
 * The strings live in the manifest so the capture types exactly what the fixture expects and can
 * wait on the command as its witness, rather than two files agreeing by coincidence.
 */
const LIVE_TURN = {
  prompt: 'Dry-run the cutover against staging before anything writes.',
  reply:
    'Staging first, then — the dry run only reads the session table and writes a report; nothing is migrated. It needs the staging credentials, so approve the command and I will run it.',
  requestId: 'perm-cutover-dry-run',
  tool: 'Bash',
  description: 'Run the staging cutover dry run',
  command: 'bun run db/cutover.ts --dry-run --env staging',
  reason: 'Reads the staging session table and writes a report.',
} as const;

/**
 * The loopback port OPENCODE_URL points at — see the environment block below.
 *
 * `--opencode-port` is how `run-store-capture.sh` passes a port it has already bound and will hold
 * for the whole run (scripts/dev/hold-opencode-port.mjs), which is the only way to close the gap
 * between "this address is dead" and "this address is still dead when the frame is captured". A
 * standalone seed with no reservation falls back to a fixed port and is checked instead of held.
 */
const OPENCODE_PORT = Number(arg('opencode-port') ?? 47_960);
const OPENCODE_PORT_RESERVED = arg('opencode-port') !== undefined;
if (!Number.isInteger(OPENCODE_PORT) || OPENCODE_PORT <= 0) {
  throw new Error('--opencode-port must be a TCP port number');
}

const state = join(root, '.fixture');
const claudeRoot = join(state, 'claude');
const codexRoot = join(state, 'codex');
const brokerHome = join(state, 'cosyncing-home');

for (const cwd of Object.values(PROJECTS)) mkdirSync(join(cwd, 'src'), { recursive: true });

/**
 * A real file the agent "sent" the user. It must exist on disk: the adapter inlines a preview from
 * it and the app's download path reads it, so a dangling path would render a card that cannot be
 * opened — the opposite of what the artifact/transfer frame is meant to show.
 */
const ARTIFACT_PATH = join(PROJECTS.atlas, 'reports', 'tenant-backfill-dry-run.md');
const ARTIFACT_BODY = [
  '# Tenant backfill — dry run',
  '',
  '| Batch size | Batches | Rows | Estimated runtime |',
  '| --- | --- | --- | --- |',
  '| 5,000 | 163 | 812,934 | 6m 20s |',
  '',
  'Resume point is recorded in `migration_progress` after every batch, so an interrupted',
  'run continues from the last committed id instead of restarting.',
  '',
  '## Rows needing review',
  '',
  '- `events.id = 41889` — no owning workspace; created before tenants existed.',
  '- `events.id = 502117` — workspace deleted; tenant cannot be inferred.',
  '',
].join('\n');

const slugForCwd = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');

const writeLines = (path: string, lines: unknown[]): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
};

/**
 * Age a transcript on disk to match the activity inside it.
 *
 * A file written a second ago is a session that was active a second ago: the Codex roster rows all
 * read "just now" without this, whatever their rollout says, so an eight-session roster looked like
 * eight simultaneous runs.
 */
const touch = (path: string, when: number): void => {
  const seconds = when / 1000;
  utimesSync(path, seconds, seconds);
};

// ── Claude Code transcripts ─────────────────────────────────────────────────────
// Shape follows packages/typescript/adapters/claude: `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`,
// one turn spread over several `assistant` lines sharing a `message.id`, and tool detail carried on
// the TOP-LEVEL `toolUseResult` of the matching `user`/tool_result line.
interface ClaudeSeed {
  uuid: string;
  cwd: string;
  title: string;
  /** Last transcript activity; also the roster's sort key. */
  updatedAt: number;
  lines: unknown[];
}

const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: Math.round(input * 0.6),
  cache_creation_input_tokens: 1_024,
});

/**
 * The headline session, and the one the wide two-pane frames are built around.
 *
 * It is deliberately long. A conversation pane on a 2064×2752 iPad frame is over a thousand
 * logical pixels tall, and a four-line transcript leaves most of a store screenshot empty — the
 * first capture pass shipped exactly that. Enough turns to fill the tallest pane in the campaign,
 * with the last turn left unretired so the roster reads Working.
 */
const rateLimitingSession = (): unknown[] => {
  const t = (offset: number) => iso(at(3 * MINUTE) - offset);
  const file = `${PROJECTS.atlas}/src/ingest/handler.ts`;
  return [
    { type: 'custom-title', customTitle: 'Per-tenant rate limiting on the ingest endpoint' },
    {
      type: 'user',
      uuid: 'c1-u1',
      cwd: PROJECTS.atlas,
      timestamp: t(19 * MINUTE),
      message: {
        role: 'user',
        content:
          'Add per-tenant rate limiting to the ingest endpoint. Keep the existing 429 body shape, and make the window configurable per plan.',
      },
    },
    {
      type: 'assistant',
      uuid: 'c1-a1',
      timestamp: t(18 * MINUTE),
      message: {
        id: 'c1-m1',
        model: CLAUDE_MODEL,
        stop_reason: 'tool_use',
        content: [
          {
            type: 'text',
            text: 'The endpoint already reads a plan record on every request, so the limiter can hang off that rather than a second lookup. Let me read the handler first.',
          },
        ],
        usage: usage(18_400, 96),
      },
    },
    {
      type: 'assistant',
      uuid: 'c1-a2',
      timestamp: t(18 * MINUTE),
      message: {
        id: 'c1-m1',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_c1_read', name: 'Read', input: { file_path: file } }],
        usage: usage(18_400, 96),
      },
    },
    {
      type: 'user',
      uuid: 'c1-r1',
      timestamp: t(17 * MINUTE),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c1_read', content: 'ok' }] },
      toolUseResult: { filePath: file, numLines: 214, startLine: 1, totalLines: 214 },
    },
    {
      type: 'assistant',
      uuid: 'c1-a3',
      timestamp: t(16 * MINUTE),
      message: {
        id: 'c1-m2',
        model: CLAUDE_MODEL,
        stop_reason: 'tool_use',
        content: [
          {
            type: 'text',
            text: 'Every plan already carries an `ingestWindow`, so the limiter can key a token bucket on the tenant and take its refill rate straight from the plan record. That keeps the 429 body untouched and makes the window per-plan without a second lookup.',
          },
        ],
        usage: usage(21_900, 340),
      },
    },
    {
      type: 'assistant',
      uuid: 'c1-a4',
      timestamp: t(16 * MINUTE),
      message: {
        id: 'c1-m2',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_c1_edit', name: 'Edit', input: { file_path: file } }],
        usage: usage(21_900, 340),
      },
    },
    {
      type: 'user',
      uuid: 'c1-r2',
      timestamp: t(15 * MINUTE),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c1_edit', content: 'ok' }] },
      toolUseResult: {
        filePath: file,
        oldString: 'const plan = await plans.forTenant(tenantId);',
        newString: 'const plan = await plans.forTenant(tenantId);\n  const bucket = limiter.bucketFor(tenantId, plan.ingestWindow);',
        structuredPatch: [
          {
            oldStart: 61,
            oldLines: 6,
            newStart: 61,
            newLines: 11,
            lines: [
              '   const tenantId = requireTenant(request);',
              '   const plan = await plans.forTenant(tenantId);',
              '+  const bucket = limiter.bucketFor(tenantId, plan.ingestWindow);',
              '+',
              '+  if (!bucket.tryConsume(1)) {',
              '+    return tooManyRequests({ retryAfterMs: bucket.retryAfterMs() });',
              '+  }',
              ' ',
              '   const batch = await readBatch(request);',
              '-  return accept(batch);',
              '+  return accept(batch, { window: plan.ingestWindow });',
            ],
          },
        ],
      },
    },
    {
      type: 'assistant',
      uuid: 'c1-a5',
      timestamp: t(13 * MINUTE),
      message: {
        id: 'c1-m3',
        model: CLAUDE_MODEL,
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_c1_bash', name: 'Bash', input: { command: 'bun test src/ingest' } }],
        usage: usage(24_100, 180),
      },
    },
    {
      type: 'user',
      uuid: 'c1-r3',
      timestamp: t(12 * MINUTE),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_c1_bash', content: 'ok', is_error: false }],
      },
      toolUseResult: {
        stdout:
          '  src/ingest/handler.test.ts:\n  ✓ accepts a batch under the plan window\n  ✓ returns 429 with the documented body\n  ✓ refills the bucket after the window\n\n 3 pass\n 0 fail\n Ran 3 tests across 1 file. [412.00ms]',
        stderr: '',
        interrupted: false,
        isImage: false,
      },
    },
    {
      type: 'assistant',
      uuid: 'c1-a6',
      timestamp: t(10 * MINUTE),
      message: {
        id: 'c1-m4',
        model: CLAUDE_MODEL,
        stop_reason: 'tool_use',
        content: [
          {
            type: 'text',
            text: 'All three pass. The trial plan is the one case the tests do not cover, so I want to see how its window is configured before calling this done.',
          },
          {
            type: 'tool_use',
            id: 'toolu_c1_grep',
            name: 'Grep',
            input: { pattern: 'ingestWindow', path: `${PROJECTS.atlas}/src` },
          },
        ],
        usage: usage(24_800, 240),
      },
    },
    {
      type: 'user',
      uuid: 'c1-r4',
      timestamp: t(9 * MINUTE),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c1_grep', content: 'ok' }] },
      toolUseResult: {
        mode: 'content',
        numFiles: 3,
        filenames: [
          `${PROJECTS.atlas}/src/plans/plan.ts`,
          `${PROJECTS.atlas}/src/plans/fixtures.ts`,
          `${PROJECTS.atlas}/src/ingest/handler.ts`,
        ],
        content:
          'src/plans/plan.ts:14:  readonly ingestWindow: Duration;\nsrc/plans/fixtures.ts:22:  ingestWindow: minutes(1),\nsrc/plans/fixtures.ts:31:  ingestWindow: minutes(15),\nsrc/ingest/handler.ts:62:  const bucket = limiter.bucketFor(tenantId, plan.ingestWindow);',
      },
    },
    {
      type: 'assistant',
      uuid: 'c1-a7',
      timestamp: t(6 * MINUTE),
      message: {
        id: 'c1-m5',
        model: CLAUDE_MODEL,
        stop_reason: 'tool_use',
        content: [
          {
            type: 'text',
            text: 'The trial plan uses a fifteen-minute window against the same burst allowance as paid plans, which lets a trial tenant spend a whole quarter-hour of budget in one second. Reading the plan definition to check whether the burst size is meant to scale with the window.',
          },
        ],
        usage: usage(26_400, 300),
      },
    },
    {
      type: 'assistant',
      uuid: 'c1-a8',
      timestamp: t(6 * MINUTE),
      message: {
        id: 'c1-m5',
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_c1_read2',
            name: 'Read',
            input: { file_path: `${PROJECTS.atlas}/src/plans/plan.ts` },
          },
        ],
        usage: usage(26_400, 300),
      },
    },
    {
      type: 'user',
      uuid: 'c1-r5',
      timestamp: t(5 * MINUTE),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c1_read2', content: 'ok' }] },
      toolUseResult: {
        filePath: `${PROJECTS.atlas}/src/plans/plan.ts`,
        numLines: 48,
        startLine: 1,
        totalLines: 48,
      },
    },
    // Unretired turn: an open tool_use with no result keeps the roster status Working. It is a
    // Bash call rather than an Edit because an in-flight Edit has no result to render from and
    // draws as a bare "Edit" row, which reads like a glitch at the bottom of a store frame; an
    // in-flight command shows the command.
    {
      type: 'assistant',
      uuid: 'c1-a9',
      timestamp: t(2 * MINUTE),
      message: {
        id: 'c1-m6',
        model: CLAUDE_MODEL,
        stop_reason: 'tool_use',
        content: [
          {
            type: 'text',
            text: 'Burst size is a flat constant, so scaling it with the window is the fix. Adding the trial case to the plan fixtures first, then running that suite against it.',
          },
          { type: 'tool_use', id: 'toolu_c1_bash2', name: 'Bash', input: { command: 'bun test src/plans' } },
        ],
        usage: usage(27_900, 210),
      },
    },
  ];
};

/**
 * The artifact/transfer session, and the one the narrow artifact frames are built around.
 *
 * Sized to sit just inside a phone-height conversation pane. A transcript that overflows scrolls,
 * which puts a half-sentence against the composer and floats a scroll-to-bottom button over the
 * card's own metadata; one that ends short of the composer simply ends. The frame is captured
 * scrolled to the top, so the start-of-session boundary is the top edge either way.
 */
const backfillSession = (): unknown[] => {
  const t = (offset: number) => iso(at(52 * MINUTE) - offset);
  return [
    { type: 'custom-title', customTitle: 'Backfill tenant ids on the events table' },
    {
      type: 'user',
      uuid: 'c2-u1',
      cwd: PROJECTS.atlas,
      timestamp: t(20 * MINUTE),
      message: {
        role: 'user',
        content: 'Write the backfill migration for tenant ids on the events table. It has to be resumable.',
      },
    },
    {
      type: 'assistant',
      uuid: 'c2-a1',
      timestamp: t(16 * MINUTE),
      message: {
        id: 'c2-m1',
        model: CLAUDE_MODEL,
        stop_reason: 'tool_use',
        content: [
          {
            type: 'text',
            text: 'The migration walks the table in id order in batches of 5,000 and records the last processed id in `migration_progress`, so an interrupted run resumes from where it stopped rather than restarting. Sending you the dry-run report.',
          },
        ],
        usage: usage(31_200, 410),
      },
    },
    {
      type: 'assistant',
      uuid: 'c2-a2',
      timestamp: t(15 * MINUTE),
      message: {
        id: 'c2-m1',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_c2_send', name: 'SendUserFile', input: { path: ARTIFACT_PATH } }],
        usage: usage(31_200, 410),
      },
    },
    // A SendUserFile delivery: the adapter turns `toolUseResult.attachments[]` into a file-artifact
    // card, which is the agent-to-user file path the Transfers frame needs.
    {
      type: 'user',
      uuid: 'c2-r1',
      timestamp: t(15 * MINUTE),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c2_send', content: 'sent' }] },
      toolUseResult: {
        status: 'proactive',
        attachments: [{ path: ARTIFACT_PATH, media_type: 'text/markdown', size: ARTIFACT_BODY.length }],
      },
    },
    {
      type: 'assistant',
      uuid: 'c2-a3',
      timestamp: t(14 * MINUTE),
      message: {
        id: 'c2-m2',
        model: CLAUDE_MODEL,
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: 'The dry run covers 812,934 rows in 163 batches and reports two rows whose tenant cannot be inferred; both are listed at the end of the report.',
          },
        ],
        usage: usage(33_100, 180),
      },
    },
  ];
};

/**
 * The "Read, steer, and approve" session, and the one the Session Detail frames are built around.
 *
 * Doc 14's third story beat wants a session detail with a *permission request*. A request that only
 * the terminal can answer is not that: an unanswered `AskUserQuestion` sitting in a transcript
 * renders — correctly and honestly — as a read-only card that says "Answer where the agent is
 * running", under a headline promising approval. The frame contradicted itself.
 *
 * So this transcript carries only what it can carry — the reading: a diff and a command with its
 * output. The approval is live. The capture takes over the session from the app, sends one prompt,
 * and the fixture's stand-in `claude` binary (see FAKE_CLAUDE below) answers with a real
 * `control_request`, which the app renders as an actionable permission card with working Reject and
 * Allow buttons. Every pixel is the product's, and the state is one a user can genuinely reach.
 */
const migrationApprovalSession = (): unknown[] => {
  const t = (offset: number) => iso(at(7 * MINUTE) - offset);
  const store = `${PROJECTS.harbor}/src/auth/session-store.ts`;
  return [
    { type: 'custom-title', customTitle: 'Move the session store to Redis' },
    {
      type: 'user',
      uuid: 'c6-u1',
      cwd: PROJECTS.harbor,
      timestamp: t(14 * MINUTE),
      message: {
        role: 'user',
        content: 'Move the session store off the database and onto Redis. Sessions can be lost on deploy, but nothing else can.',
      },
    },
    {
      type: 'assistant',
      uuid: 'c6-a1',
      timestamp: t(12 * MINUTE),
      message: {
        id: 'c6-m1',
        model: CLAUDE_MODEL,
        stop_reason: 'tool_use',
        content: [
          {
            type: 'text',
            // Short standalone paragraphs, for the same reason as the message below — see there.
            text: 'The store sits behind one interface.\n\n'
              + 'The swap is small; the risk is the signed-in users.',
          },
          { type: 'tool_use', id: 'toolu_c6_grep', name: 'Grep', input: { pattern: 'sessionStore', path: `${PROJECTS.harbor}/src` } },
        ],
        usage: usage(20_100, 260),
      },
    },
    {
      type: 'user',
      uuid: 'c6-r1',
      timestamp: t(11 * MINUTE),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c6_grep', content: 'ok' }] },
      toolUseResult: {
        mode: 'content',
        numFiles: 2,
        filenames: [`${PROJECTS.harbor}/src/auth/session-store.ts`, `${PROJECTS.harbor}/src/server.ts`],
        content:
          'src/auth/session-store.ts:9:export interface SessionStore {\nsrc/auth/session-store.ts:31:export function sessionStore(): SessionStore {\nsrc/server.ts:44:  const store = sessionStore();',
      },
    },
    {
      type: 'assistant',
      uuid: 'c6-a2',
      timestamp: t(9 * MINUTE),
      message: {
        id: 'c6-m2',
        model: CLAUDE_MODEL,
        stop_reason: 'tool_use',
        content: [
          {
            type: 'text',
            // Three standalone one-line paragraphs, and that shape is load-bearing rather than
            // styling. A Session Detail frame is scrolled to the end of its session, so the top of
            // the frame lands wherever this message's height puts it, and every surface lands
            // somewhere different. The capture can guarantee the frame opens on a line boundary
            // rather than through the middle of one (`frameTranscriptTop`), but only the text can
            // decide whether that line is a whole sentence: wrapped prose gave the flagship frame a
            // top line reading "the old table…", which is a broken crop however cleanly it is cut.
            // Sentences that fit one line at the narrowest width cannot be cut mid-thought.
            text: 'Two call sites, both through the interface.\n\n'
              + 'Redis first, then the database on a miss.\n\n'
              + 'The old table can go in a later release.',
          },
        ],
        usage: usage(22_700, 300),
      },
    },
    {
      type: 'assistant',
      uuid: 'c6-a3',
      timestamp: t(9 * MINUTE),
      message: {
        id: 'c6-m2',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_c6_edit', name: 'Edit', input: { file_path: store } }],
        usage: usage(22_700, 300),
      },
    },
    {
      type: 'user',
      uuid: 'c6-r2',
      timestamp: t(8 * MINUTE),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c6_edit', content: 'ok' }] },
      toolUseResult: {
        filePath: store,
        oldString: '      return db.sessions.find(id);',
        newString:
          '      const cached = await redis.get(key(id));\n      if (cached) return decode(cached);\n      return db.sessions.find(id);',
        structuredPatch: [
          {
            oldStart: 31,
            oldLines: 8,
            newStart: 31,
            newLines: 11,
            lines: [
              ' export function sessionStore(): SessionStore {',
              '   return {',
              '     async read(id: SessionId) {',
              '-      return db.sessions.find(id);',
              '+      const cached = await redis.get(key(id));',
              '+      if (cached) return decode(cached);',
              '+      return db.sessions.find(id);',
              '     },',
              '     async write(session: Session) {',
              '-      await db.sessions.upsert(session);',
              '+      await redis.set(key(session.id), encode(session), { ex: ttl });',
              '+      await db.sessions.upsert(session);',
              '     },',
            ],
          },
        ],
      },
    },
    {
      type: 'assistant',
      uuid: 'c6-a4',
      timestamp: t(8 * MINUTE),
      message: {
        id: 'c6-m3',
        model: CLAUDE_MODEL,
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_c6_bash', name: 'Bash', input: { command: 'bun test src/auth' } }],
        usage: usage(24_300, 210),
      },
    },
    {
      type: 'user',
      uuid: 'c6-r3',
      timestamp: t(7 * MINUTE),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_c6_bash', content: 'ok', is_error: false }],
      },
      toolUseResult: {
        stdout:
          '  src/auth/session-store.test.ts:\n  ✓ reads a session from Redis when it is cached\n  ✓ falls back to the database on a miss\n  ✓ expires with the configured ttl\n\n 3 pass\n 0 fail\n Ran 3 tests across 1 file. [318.00ms]',
        stderr: '',
        interrupted: false,
        isImage: false,
      },
    },
    // Unretired turn: an open tool_use with no result is what keeps this row's roster status
    // Working, exactly as it read before the frame's approval became live.
    {
      type: 'assistant',
      uuid: 'c6-a5',
      timestamp: t(5 * MINUTE),
      message: {
        id: 'c6-m4',
        model: CLAUDE_MODEL,
        stop_reason: 'tool_use',
        content: [
          {
            type: 'text',
            text: 'Both paths pass against the same suite.\n\n'
              + 'The cutover script has never been run.',
          },
          { type: 'tool_use', id: 'toolu_c6_grep2', name: 'Grep', input: { pattern: 'REDIS_URL', path: `${PROJECTS.harbor}/deploy` } },
        ],
        usage: usage(25_100, 260),
      },
    },
  ];
};

const claudeSeeds: ClaudeSeed[] = [
  {
    uuid: '4f1c8a02-6d3b-4e57-9a10-2b7c5e08d941',
    cwd: PROJECTS.atlas,
    title: 'Per-tenant rate limiting on the ingest endpoint',
    updatedAt: at(3 * MINUTE),
    lines: rateLimitingSession(),
  },
  {
    uuid: '9b62d07e-1f44-4c9a-b3d8-5e0a71c26f83',
    cwd: PROJECTS.atlas,
    title: 'Backfill tenant ids on the events table',
    updatedAt: at(52 * MINUTE),
    lines: backfillSession(),
  },
  {
    uuid: '6c0b41e8-5d92-4a37-b1c6-8e4f207a9d15',
    cwd: PROJECTS.harbor,
    title: 'Move the session store to Redis',
    updatedAt: at(7 * MINUTE),
    lines: migrationApprovalSession(),
  },
  {
    uuid: 'a70e5c3d-88b1-4f26-9d47-6c1e2f905ab4',
    cwd: PROJECTS.harbor,
    title: 'Flaky checkout test on slow CI runners',
    updatedAt: at(4 * HOUR),
    lines: (() => {
      const t = (offset: number) => iso(at(4 * HOUR) - offset);
      return [
        { type: 'custom-title', customTitle: 'Flaky checkout test on slow CI runners' },
        {
          type: 'user',
          uuid: 'c3-u1',
          cwd: PROJECTS.harbor,
          timestamp: t(30 * MINUTE),
          message: {
            role: 'user',
            content: 'The checkout test fails about one run in six on the slow runners. Find out why before changing timeouts.',
          },
        },
        {
          type: 'assistant',
          uuid: 'c3-a1',
          timestamp: t(11 * MINUTE),
          message: {
            id: 'c3-m1',
            model: CLAUDE_MODEL,
            stop_reason: 'end_turn',
            content: [
              {
                type: 'text',
                text: 'It is not a timeout. The test asserts on the cart total before the price recalculation promise settles; on a fast runner the microtask lands first by luck. Awaiting the recalculation makes it deterministic.',
              },
            ],
            usage: usage(27_600, 300),
          },
        },
      ];
    })(),
  },
  {
    uuid: 'd4c19b6a-2e70-4813-8f5b-91a7c0d3e256',
    cwd: PROJECTS.meridian,
    title: 'Release notes for 0.9',
    updatedAt: at(2 * DAY),
    lines: (() => {
      const t = (offset: number) => iso(at(2 * DAY) - offset);
      return [
        { type: 'custom-title', customTitle: 'Release notes for 0.9' },
        {
          type: 'user',
          uuid: 'c4-u1',
          cwd: PROJECTS.meridian,
          timestamp: t(18 * MINUTE),
          message: { role: 'user', content: 'Draft the 0.9 release notes from the merged pull requests. Group by user-visible change.' },
        },
        {
          type: 'assistant',
          uuid: 'c4-a1',
          timestamp: t(9 * MINUTE),
          message: {
            id: 'c4-m1',
            model: CLAUDE_MODEL,
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Draft is in `docs/releases/0.9.md`, grouped into config, output formatting, and fixes.' }],
            usage: usage(22_800, 260),
          },
        },
      ];
    })(),
  },
  {
    uuid: 'e83f2a51-7c06-49bd-a2e4-3d5b8f107c69',
    cwd: PROJECTS.lantern,
    title: 'Deployment guide for the new runner',
    updatedAt: at(5 * DAY),
    lines: (() => {
      const t = (offset: number) => iso(at(5 * DAY) - offset);
      return [
        { type: 'custom-title', customTitle: 'Deployment guide for the new runner' },
        {
          type: 'user',
          uuid: 'c5-u1',
          cwd: PROJECTS.lantern,
          timestamp: t(25 * MINUTE),
          message: { role: 'user', content: 'Update the deployment guide for the new runner image. The old volume mount section is wrong.' },
        },
        {
          type: 'assistant',
          uuid: 'c5-a1',
          timestamp: t(12 * MINUTE),
          message: {
            id: 'c5-m1',
            model: CLAUDE_MODEL,
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Rewrote the volume section against the new image layout and added the read-only cache mount that was missing.' }],
            usage: usage(19_400, 220),
          },
        },
      ];
    })(),
  },
];

mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
writeFileSync(ARTIFACT_PATH, ARTIFACT_BODY);

for (const seed of claudeSeeds) {
  const path = join(claudeRoot, 'projects', slugForCwd(seed.cwd), `${seed.uuid}.jsonl`);
  writeLines(path, seed.lines);
  touch(path, seed.updatedAt);
}

// ── Codex rollouts ──────────────────────────────────────────────────────────────
// Shape follows packages/typescript/adapters/codex: `$CODEX_HOME/sessions/YYYY/MM/DD/
// rollout-<iso>-<uuid>.jsonl`, with `event_msg` owning text/reasoning/user and `response_item`
// owning tool calls and results.
interface CodexSeed {
  uuid: string;
  cwd: string;
  /** Thread name, published through `$CODEX_HOME/session_index.jsonl` exactly as Codex does. */
  title: string;
  updatedAt: number;
  lines: unknown[];
}

const codexSeeds: CodexSeed[] = [
  {
    uuid: 'b1d9f4c7-3a52-4e08-9c61-7f2e5b0a8d34',
    cwd: PROJECTS.harbor,
    title: 'Extract the pricing table component',
    updatedAt: at(26 * MINUTE),
    lines: (() => {
      const t = (offset: number) => iso(at(26 * MINUTE) - offset);
      return [
        { type: 'session_meta', payload: { cwd: PROJECTS.harbor, id: 'b1d9f4c7-3a52-4e08-9c61-7f2e5b0a8d34' } },
        { timestamp: t(21 * MINUTE), type: 'event_msg', payload: { type: 'user_message', message: 'Extract the pricing table into its own component and keep the current markup.' } },
        { timestamp: t(20 * MINUTE), type: 'event_msg', payload: { type: 'task_started', turn_id: 'h1' } },
        { type: 'event_msg', payload: { type: 'agent_reasoning', content: 'The table is the only consumer of the currency helper, so it can move with it.' } },
        { type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', call_id: 'h-c1', arguments: '{}' } },
        {
          type: 'event_msg',
          payload: {
            type: 'patch_apply_end',
            call_id: 'h-c1',
            success: true,
            changes: { [`${PROJECTS.harbor}/src/pricing/PricingTable.tsx`]: { type: 'add', content: 'export function PricingTable() {\n  return null;\n}\n' } },
          },
        },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'h-c1', output: 'ok' } },
        { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'h-c2', arguments: '{"command":"bun run build"}' } },
        { type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'h-c2', exit_code: 0, duration: { secs: 6, nanos: 400_000_000 } } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'h-c2', output: 'built in 6.4s' } },
        { timestamp: t(1 * MINUTE), type: 'event_msg', payload: { type: 'agent_message', message: 'Pricing table now lives in its own component with the currency helper alongside it. Markup is byte-identical; the build is clean.', phase: 'final_answer' } },
        { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 42_100, output_tokens: 1_240, cached_input_tokens: 26_800 } } } },
        { timestamp: t(0), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'h1' } },
      ];
    })(),
  },
  {
    uuid: 'c58a2e91-6b3f-4d70-85a2-0e9c4f1b7d62',
    cwd: PROJECTS.meridian,
    title: 'Port the config loader to TOML',
    updatedAt: at(11 * MINUTE),
    lines: (() => {
      const t = (offset: number) => iso(at(11 * MINUTE) - offset);
      return [
        { type: 'session_meta', payload: { cwd: PROJECTS.meridian, id: 'c58a2e91-6b3f-4d70-85a2-0e9c4f1b7d62' } },
        { timestamp: t(7 * MINUTE), type: 'event_msg', payload: { type: 'user_message', message: 'Port the config loader from YAML to TOML. Keep both readable for one release.' } },
        { timestamp: t(6 * MINUTE), type: 'event_msg', payload: { type: 'task_started', turn_id: 'm1' } },
        { type: 'event_msg', payload: { type: 'agent_reasoning', content: 'Reading the loader and its tests before changing the parser selection.' } },
        { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'm-c1', arguments: '{"command":"rg -n \\"parseConfig\\" src"}' } },
        { type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'm-c1', exit_code: 0, duration: { secs: 0, nanos: 180_000_000 } } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'm-c1', output: 'src/config/load.ts:18\nsrc/config/load.ts:52\nsrc/cli/main.ts:9' } },
        // Deliberately `agent_reasoning`, not `agent_message`: an assistant message retires the
        // turn for status inference, and the roster would then read Idle beside a transcript that
        // visibly still has a command running.
        { type: 'event_msg', payload: { type: 'agent_reasoning', content: 'Three call sites, and only load.ts picks the parser. Selecting on file extension there and leaving the YAML path in place for this release.' } },
        { type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', call_id: 'm-c2', arguments: '{}' } },
        {
          type: 'event_msg',
          payload: {
            type: 'patch_apply_end',
            call_id: 'm-c2',
            success: true,
            changes: { [`${PROJECTS.meridian}/src/config/load.ts`]: { type: 'update', content: 'const parse = extname(file) === \'.toml\' ? parseToml : parseYaml;\n' } },
          },
        },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'm-c2', output: 'ok' } },
        { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'm-c3', arguments: '{"command":"bun test src/config"}' } },
        { type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'm-c3', exit_code: 0, duration: { secs: 1, nanos: 900_000_000 } } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'm-c3', output: '  src/config/load.test.ts:\n  ✓ reads a TOML config\n  ✓ still reads the legacy YAML config\n  ✓ prefers TOML when both exist\n\n 3 pass\n 0 fail' } },
        { type: 'event_msg', payload: { type: 'agent_reasoning', content: 'Both formats load. Checking the CLI help text still names the right default file.' } },
        { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'm-c4', arguments: '{"command":"bun run meridian --help"}' } },
        { type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'm-c4', exit_code: 0, duration: { secs: 0, nanos: 240_000_000 } } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'm-c4', output: 'meridian [command]\n\n  --config <path>   configuration file (default: meridian.toml, then meridian.yaml)' } },
        { timestamp: t(0), type: 'event_msg', payload: { type: 'agent_message', message: 'The loader now picks its parser from the file extension, so `meridian.toml` and the existing `meridian.yaml` both load and TOML wins when both are present. Tests cover all three cases, and `--help` names the new default first.\n\nI left the YAML path fully intact rather than deprecating it, since you asked to keep both readable for this release.', phase: 'final_answer' } },
        { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 51_600, output_tokens: 2_180, cached_input_tokens: 33_900 } } } },
        // Terminal: the roster status and the transcript must agree. Codex does not promote a
        // rollout to Working on an unfinished exec alone, so an intentionally "open" turn showed
        // Idle in the roster beside a command still rendering as running.
        { timestamp: t(0), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'm1' } },
      ];
    })(),
  },
  {
    uuid: 'f2e7b483-9d15-4a6c-b0f8-3a5d7c294e10',
    cwd: PROJECTS.atlas,
    title: 'Trace the p99 query regression',
    updatedAt: at(3 * HOUR),
    lines: (() => {
      const t = (offset: number) => iso(at(3 * HOUR) - offset);
      return [
        { type: 'session_meta', payload: { cwd: PROJECTS.atlas, id: 'f2e7b483-9d15-4a6c-b0f8-3a5d7c294e10' } },
        { timestamp: t(24 * MINUTE), type: 'event_msg', payload: { type: 'user_message', message: 'Find where the p99 on the query path regressed after the index change.' } },
        { timestamp: t(23 * MINUTE), type: 'event_msg', payload: { type: 'task_started', turn_id: 'a1' } },
        { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'a-c1', arguments: '{"command":"bun run bench:query"}' } },
        { type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'a-c1', exit_code: 0, duration: { secs: 31, nanos: 0 } } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'a-c1', output: 'p50 4.1ms  p95 22.7ms  p99 188.4ms' } },
        { type: 'event_msg', payload: { type: 'agent_reasoning', content: 'A p99 that far above p95 is a plan flip, not uniform slowness. Checking what the planner actually chose.' } },
        { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'a-c2', arguments: '{"command":"psql -c \\"explain analyze select * from events where tenant_id = $1 and created_at > now() - interval \'1 day\'\\""}' } },
        { type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'a-c2', exit_code: 0, duration: { secs: 2, nanos: 100_000_000 } } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'a-c2', output: 'Seq Scan on events  (cost=0.00..48219.10 rows=1174 width=284)\n  Filter: ((tenant_id = $1) AND (created_at > (now() - \'1 day\'::interval)))\n  Rows Removed by Filter: 812934\nPlanning Time: 0.214 ms\nExecution Time: 191.883 ms' } },
        { type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', call_id: 'a-c3', arguments: '{}' } },
        {
          type: 'event_msg',
          payload: {
            type: 'patch_apply_end',
            call_id: 'a-c3',
            success: true,
            changes: { [`${PROJECTS.atlas}/migrations/0042_events_tenant_index.sql`]: { type: 'add', content: 'drop index if exists events_created_at_idx;\ncreate index events_tenant_created_idx\n  on events (tenant_id, created_at desc);\n' } },
          },
        },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'a-c3', output: 'ok' } },
        { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'a-c4', arguments: '{"command":"bun run bench:query"}' } },
        { type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'a-c4', exit_code: 0, duration: { secs: 29, nanos: 0 } } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'a-c4', output: 'p50 3.9ms  p95 11.2ms  p99 24.1ms' } },
        { timestamp: t(1 * MINUTE), type: 'event_msg', payload: { type: 'agent_message', message: 'The partial index added last week is not selective for the tenant-scoped query, so above roughly 40k rows the planner drops it and sequentially scans `events` — that is the whole p99 regression.\n\nReplacing it with a composite `(tenant_id, created_at desc)` index brings p99 from 188ms to 24ms, and p95 improves as well. The migration is in `migrations/0042_events_tenant_index.sql`; it drops the old index in the same transaction, so there is no window where neither exists.', phase: 'final_answer' } },
        { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 38_900, output_tokens: 980, cached_input_tokens: 21_400 } } } },
        { timestamp: t(0), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'a1' } },
      ];
    })(),
  },
];

// Codex publishes thread names through its session index, not the rollout, so the roster reads
// them from there; without it every Codex row degrades to `<project> · <id prefix>`.
writeLines(
  join(codexRoot, 'session_index.jsonl'),
  codexSeeds.map((seed) => ({ id: seed.uuid, thread_name: seed.title })),
);

/** Codex ids are base64url of the rollout path (adapters/codex `enc(full)`), so keep the path. */
const codexRolloutPath = (seed: CodexSeed): string => {
  const day = new Date(seed.updatedAt);
  const yyyy = String(day.getUTCFullYear());
  const mm = String(day.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(day.getUTCDate()).padStart(2, '0');
  const stamp = iso(seed.updatedAt).replace(/[:.]/g, '-');
  return join(codexRoot, 'sessions', yyyy, mm, dd, `rollout-${stamp}-${seed.uuid}.jsonl`);
};

for (const seed of codexSeeds) {
  const path = codexRolloutPath(seed);
  writeLines(path, seed.lines);
  touch(path, seed.updatedAt);
}

// ── broker attention feed ───────────────────────────────────────────────────────
// Written through the product's own store so the snapshot is normalized exactly as the broker
// would write it, rather than hand-authored JSON that could drift from the schema.
const claudeSessionId = (cwd: string, uuid: string): string =>
  Buffer.from(join(claudeRoot, 'projects', slugForCwd(cwd), `${uuid}.jsonl`), 'utf8').toString('base64url');
const codexSessionId = (uuid: string): string => {
  const seed = codexSeeds.find((candidate) => candidate.uuid === uuid);
  if (!seed) throw new Error(`no codex seed ${uuid}`);
  return Buffer.from(codexRolloutPath(seed), 'utf8').toString('base64url');
};

mkdirSync(brokerHome, { recursive: true });

// ── the fixture broker's credential ─────────────────────────────────────────────
// A real broker has one, and so does this. It is not decoration: the Drive boundary in
// `runtime.ts` (credentialAuthenticated) refuses `mode=resume` to any caller that cannot prove a
// credential, so on a token-less broker NO client can ever take a session over — the app can only
// observe, and the approval frame would have nothing to approve. With one configured, the capture
// enters it through the app's own "Connect this device" gate, exactly as a user enrols a device.
//
// Throwaway, fictitious, and inside the throwaway root: it authorises nothing beyond this fixture.
const brokerToken = randomBytes(32).toString('base64url');
const secretsDir = join(brokerHome, 'secrets');
mkdirSync(secretsDir, { recursive: true });
chmodSync(secretsDir, 0o700);
const brokerTokenFile = join(secretsDir, 'broker-token');
writeFileSync(brokerTokenFile, brokerToken);
chmodSync(brokerTokenFile, 0o600);

const attention = new AttentionStore({ home: brokerHome });

const attentionSeeds = [
  {
    kind: 'run-finished' as const,
    severity: 'informational' as const,
    dedupeKey: 'fixture:run-finished:atlas-backfill',
    agent: 'claude',
    sessionId: claudeSessionId(PROJECTS.atlas, '9b62d07e-1f44-4c9a-b3d8-5e0a71c26f83'),
    sessionTitle: 'Backfill tenant ids on the events table',
    title: 'Ready to review',
    summary: 'Resumable backfill migration written and explained.',
    createdAt: at(52 * MINUTE),
  },
  {
    kind: 'run-finished' as const,
    severity: 'informational' as const,
    dedupeKey: 'fixture:run-finished:harbor-checkout',
    agent: 'claude',
    sessionId: claudeSessionId(PROJECTS.harbor, 'a70e5c3d-88b1-4f26-9d47-6c1e2f905ab4'),
    sessionTitle: 'Flaky checkout test on slow CI runners',
    title: 'Ready to review',
    summary: 'Root cause found: the assertion races the price recalculation.',
    createdAt: at(4 * HOUR),
  },
  {
    kind: 'run-failed' as const,
    severity: 'action-required' as const,
    dedupeKey: 'fixture:run-failed:lantern-guide',
    agent: 'claude',
    sessionId: claudeSessionId(PROJECTS.lantern, 'e83f2a51-7c06-49bd-a2e4-3d5b8f107c69'),
    sessionTitle: 'Deployment guide for the new runner',
    title: 'Run failed',
    summary: 'The docs link checker exited non-zero on two anchors.',
    createdAt: at(6 * DAY),
  },
  {
    // Codex-sourced, so the inbox is not all one agent. A quota/usage event was tried here first
    // and is deliberately not used: the broker resolves it at startup because the fixture has no
    // quota data behind it, and a card that deletes itself before the capture is worse than none.
    kind: 'run-finished' as const,
    severity: 'informational' as const,
    dedupeKey: 'fixture:run-finished:meridian-toml',
    agent: 'codex',
    sessionId: codexSessionId('c58a2e91-6b3f-4d70-85a2-0e9c4f1b7d62'),
    sessionTitle: 'Port the config loader to TOML',
    title: 'Ready to review',
    summary: 'TOML and YAML both load; TOML wins when both are present.',
    createdAt: at(11 * MINUTE),
  },
];

for (const seed of attentionSeeds) {
  const { sessionId, agent, ...rest } = seed;
  await attention.upsertEvent({
    ...rest,
    state: 'active',
    agent,
    sessionId,
    action: { kind: 'open-session', tool: agent, sessionId },
  });
}

// ── the fixture's stand-in `claude` ─────────────────────────────────────────────
// `COSYNCING_CLAUDE_BIN` is the adapter's documented launch-binary override (implementation.ts
// DEFAULT_BIN), used by the broker's own traces for exactly this: drive the real adapter over the
// real protocol with no model, no cost, and no network.
//
// It matters twice. First, it is what makes the live approval possible at all. Second, without it a
// drive — or the roster's `claude agents --json` overlay — would launch the maintainer's REAL claude
// binary. `CLAUDE_CONFIG_DIR` keeps that pointed at fixture state, but "the real CLI, aimed
// somewhere harmless" is a weaker claim than "the real CLI is never invoked", and a release capture
// should be able to make the stronger one.
//
// What it is NOT: a stand-in for the app. Nothing below draws, fakes, or decorates any UI. It speaks
// the same stream-json a real `claude --resume` speaks, and the adapter, broker, and client that
// turn it into a permission card are the shipped ones.
const binDir = join(state, 'bin');
const fakeClaude = join(binDir, 'claude');
mkdirSync(binDir, { recursive: true });
writeFileSync(
  fakeClaude,
  `#!/usr/bin/env bun
// Generated by scripts/dev/seed-brand-fixture.ts — the release fixture's stand-in for the claude
// CLI. One driven turn that ends in a real permission request, and never answers it.
const args = process.argv.slice(2);
// The roster's waiting overlay shells out for this; an empty roster is the truthful answer here.
if (args.includes('agents')) { console.log('[]'); process.exit(0); }
const send = (value) => console.log(JSON.stringify(value));
const resumeAt = args.indexOf('--resume');
send({
  type: 'system',
  subtype: 'init',
  session_id: resumeAt === -1 ? undefined : args[resumeAt + 1],
  model: ${JSON.stringify(CLAUDE_MODEL)},
  permissionMode: 'default',
  slash_commands: ['stop'],
});
let asked = false;
let buffer = '';
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  for (let nl = buffer.indexOf('\\n'); nl !== -1; nl = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    // Exactly one request per session, however many prompts arrive: a second card would stack a
    // duplicate approval under the first one in every later frame.
    if (asked || !line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const content = message && message.message && message.message.content;
    if (!Array.isArray(content)) continue;
    const block = content.find((part) => part && part.type === 'text' && String(part.text || '').trim());
    if (!block) continue;
    asked = true;
    send({ type: 'user', uuid: 'live-prompt', message: { role: 'user', content: [{ type: 'text', text: block.text }] } });
    send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'live-reply' } } });
    send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ${JSON.stringify(LIVE_TURN.reply)} } } });
    send({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    // The CLI blocks the tool here until a control_response arrives. So does this: the turn stays
    // open, the card stays pending, and the capture photographs a decision that is still the
    // reader's to make.
    send({
      type: 'control_request',
      request_id: ${JSON.stringify(LIVE_TURN.requestId)},
      request: {
        subtype: 'can_use_tool',
        tool_name: ${JSON.stringify(LIVE_TURN.tool)},
        description: ${JSON.stringify(LIVE_TURN.description)},
        input: { command: ${JSON.stringify(LIVE_TURN.command)} },
        decision_reason: ${JSON.stringify(LIVE_TURN.reason)},
      },
    });
  }
}
`,
);
chmodSync(fakeClaude, 0o755);

// ── environment ─────────────────────────────────────────────────────────────────
// A review broker must inherit ONLY these. Anything omitted (a real CLAUDE_CONFIG_DIR, the
// maintainer's ~/.codex) would put real sessions into a release capture.
const env: Record<string, string> = {
  HOME: join(state, 'home'),
  XDG_CONFIG_HOME: join(state, 'xdg-config'),
  XDG_STATE_HOME: join(state, 'xdg-state'),
  XDG_CACHE_HOME: join(state, 'xdg-cache'),
  CLAUDE_CONFIG_DIR: claudeRoot,
  CODEX_HOME: codexRoot,
  PI_CODING_AGENT_DIR: join(state, 'pi-agent'),
  PI_CODING_AGENT_SESSION_DIR: join(state, 'pi-sessions'),
  COSYNCING_HOME: brokerHome,
  COSYNCING_CACHE_DIR: join(state, 'cosyncing-cache'),
  COSYNCING_MACHINE: MACHINE,
  // Keep the fixture broker away from every real agent runtime: no OpenCode autoserve, no
  // Codex daemon, no Claude bridge. Discovery stays file-backed and offline.
  COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
  COSYNCING_CODEX_SYNC_SERVER: '0',
  COSYNCING_NO_BRIDGE: '1',
  // OpenCode is the one adapter a redirected HOME does not isolate: it discovers over HTTP at
  // $OPENCODE_URL, defaulting to 127.0.0.1:4096 — the maintainer's own running server. Without
  // these two the fixture roster fills with real projects, paths, and prompts. Point the adapter
  // at a dead port and an empty data dir so it finds nothing and contributes nothing.
  OPENCODE_URL: `http://127.0.0.1:${OPENCODE_PORT}`,
  OPENCODE_DATA: join(state, 'opencode-data'),
  XDG_DATA_HOME: join(state, 'xdg-data'),
};
for (const directory of Object.values(env)) {
  if (directory.startsWith('/')) mkdirSync(directory, { recursive: true });
}
// Added after the loop above on purpose: it is the only value here that names a FILE, and that loop
// would helpfully create a directory over it.
env.COSYNCING_CLAUDE_BIN = fakeClaude;

// An OpenCode server answering on this address would silently reconnect the fixture to real
// sessions, which is exactly the leak this env exists to prevent. A reserved port is already held
// by the caller and answers nothing by construction; an unreserved one is checked.
const opencodeAnswers = await fetch(`http://127.0.0.1:${OPENCODE_PORT}/`, {
  signal: AbortSignal.timeout(1_500),
}).then(() => true, () => false);
if (opencodeAnswers) {
  throw new Error(
    `something is serving HTTP on 127.0.0.1:${OPENCODE_PORT}; pass --opencode-port for a port you ` +
      'have reserved, or the fixture roster can pick up real OpenCode sessions',
  );
}

/**
 * Single-quote a value for a file that will be `source`d.
 *
 * env.sh is executed, not parsed, by whoever starts the broker. A bare `KEY=value` line hands the
 * shell whatever the value happens to contain — a space truncates it, and a `$(…)` in a path runs.
 * These values are paths derived from `--root`, so the caller chooses them; quoting is what keeps
 * "the caller chose a strange directory name" from meaning "the caller chose a command".
 */
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

writeFileSync(
  join(root, 'env.sh'),
  `# Generated by scripts/dev/seed-brand-fixture.ts — fictitious release-capture fixture.\n` +
    `# Usage: set -a; source ${join(root, 'env.sh')}; set +a\n` +
    Object.entries(env)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join('\n') +
    '\n',
);
writeFileSync(join(root, 'env.json'), `${JSON.stringify(env, null, 2)}\n`);

// ── manifest ────────────────────────────────────────────────────────────────────
// The complete, exact set this fixture put in front of the broker. The verifier compares the live
// roster and attention feed against this as an equality, not as a pattern match: a row that merely
// looks fictitious is not evidence, and the first capture pass proved it by publishing 243 real
// sessions that would each have passed a path-shape test.
const manifest = {
  machine: MACHINE,
  root,
  opencodeUrl: env.OPENCODE_URL,
  /** True when the caller holds this address for the run, rather than it merely testing dead. */
  opencodePortReserved: OPENCODE_PORT_RESERVED,
  artifactPath: ARTIFACT_PATH,
  projects: Object.fromEntries(Object.entries(PROJECTS)),
  /** The live approval turn: what the capture sends, and what it must see before it may shoot. */
  live: { session: 'Move the session store to Redis', ...LIVE_TURN },
  sessions: [
    ...claudeSeeds.map((seed) => ({
      tool: 'claude',
      id: claudeSessionId(seed.cwd, seed.uuid),
      title: seed.title,
      cwd: seed.cwd,
      model: CLAUDE_MODEL,
    })),
    // `model: null` is not a gap in the manifest, it is the expectation: a seeded Codex rollout
    // publishes no model on its roster row, and the verifier fails if one appears — a model where
    // none belongs is a row this fixture did not create.
    ...codexSeeds.map((seed) => ({
      tool: 'codex',
      id: Buffer.from(codexRolloutPath(seed), 'utf8').toString('base64url'),
      title: seed.title,
      cwd: seed.cwd,
      model: null,
    })),
  ],
  // Every field the app can render or act on. `sessionTitle` in particular is on camera in the
  // Notifications frame, so it is compared rather than assumed.
  attention: attentionSeeds.map((seed) => ({
    dedupeKey: seed.dedupeKey,
    kind: seed.kind,
    severity: seed.severity,
    title: seed.title,
    summary: seed.summary,
    sessionTitle: seed.sessionTitle,
    agent: seed.agent,
    sessionId: seed.sessionId,
  })),
  counts: {
    sessions: claudeSeeds.length + codexSeeds.length,
    claude: claudeSeeds.length,
    codex: codexSeeds.length,
    attention: attentionSeeds.length,
  },
};
writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`seeded ${manifest.counts.sessions} fictitious sessions (${claudeSeeds.length} Claude Code, ${codexSeeds.length} Codex)`);
console.log(`  projects:  ${Object.values(PROJECTS).map((p) => p.slice(root.length + 1)).join(', ')} (under the root, created)`);
console.log(`  attention: ${attentionSeeds.length} events`);
console.log(`  claude:    ${fakeClaude} (stand-in binary; the real CLI is never invoked)`);
console.log(`  token:     ${brokerTokenFile} (fictitious; the capture enters it through the app's gate)`);
console.log(`  root:      ${root}`);
console.log(`  env:       ${join(root, 'env.sh')}`);
console.log(`  manifest:  ${join(root, 'manifest.json')}`);
