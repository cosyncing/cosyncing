#!/usr/bin/env bun
/**
 * Refuse to capture release art from a broker that can see anything real.
 *
 * Screenshots are published artifacts, so "I pointed it at a fixture" is not evidence — one adapter
 * that isolates differently is all it takes. OpenCode already proved the point: it discovers over
 * HTTP at `$OPENCODE_URL`, so a redirected HOME left the maintainer's real projects, paths, and
 * prompts in the roster.
 *
 * The bar here is EQUALITY, not plausibility. Every one of those 243 leaked sessions would have
 * passed a path-shape test if it had happened to sit under the allowed prefix, and a real row
 * carrying no `cwd` at all would have passed trivially. So this compares the live broker against
 * `<root>/manifest.json` — the exact set the seeder created — and fails on any addition, omission,
 * or altered field, then re-checks the shape rules as a second net.
 *
 *   bun run scripts/dev/verify-brand-fixture.ts --base http://127.0.0.1:7745 --root DIR
 *   bun run scripts/dev/verify-brand-fixture.ts --base ... --root ... --self-test
 *   bun run scripts/dev/verify-brand-fixture.ts --base ... --root ... --after-capture
 *
 * `--self-test` proves the comparison actually rejects things: it mutates the live data ten ways —
 * extra sessions, omissions, altered fields, duplicates keyed to hide behind the expected row — and
 * fails if any mutant is accepted. A privacy check nobody has watched fail is not a check.
 *
 * Run it BEFORE capturing and again AFTER: the fixture broker is long-lived, and an adapter that
 * reconnects mid-run would otherwise leak into the last frames only. The run afterwards adds
 * `--after-capture`, which tolerates the notifications the capture itself caused the broker to
 * raise — and nothing else; see CAPTURE_CAUSED.
 *
 * Exit 0 means every published session and notification is exactly what the fixture created.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const arg = (name: string, fallback = ''): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1]!;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const base = arg('base', 'http://127.0.0.1:7745').replace(/\/$/, '');
const root = resolve(arg('root'));
if (!arg('root')) {
  console.error('--root is required: the fixture root printed by seed-brand-fixture.ts');
  process.exit(2);
}

interface ManifestSession {
  tool: string;
  id: string;
  title: string;
  cwd: string;
  model: string;
}
interface ManifestAttention {
  dedupeKey: string;
  kind: string;
  severity: string;
  title: string;
  summary: string;
  sessionTitle: string;
  agent: string;
  sessionId: string;
}
interface Manifest {
  machine: string;
  root: string;
  opencodeUrl: string;
  /** The one live turn the capture drives — see CAPTURE_CAUSED. */
  live: { session: string; requestId: string; command: string; prompt: string };
  sessions: ManifestSession[];
  attention: ManifestAttention[];
  counts: { sessions: number; attention: number };
}

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as Manifest;
const env = JSON.parse(readFileSync(join(root, 'env.json'), 'utf8')) as Record<string, string>;

/** Shapes that mean a real machine leaked in, independent of which adapter produced the row. */
const FORBIDDEN = [
  { label: 'home-directory path', pattern: /\/(?:home|Users)\/[A-Za-z0-9._-]/ },
  { label: 'Windows/WSL drive path', pattern: /\/mnt\/[a-z]\//i },
  { label: 'tailnet hostname', pattern: /[a-z0-9-]+\.ts\.net/i },
  { label: 'private network address', pattern: /\b(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)\d/ },
];

/**
 * The fixture broker is credentialed, so the sensitive reads need the credential.
 *
 * Read from the fixture's own state rather than passed in: the token this verifier must present is
 * by definition the one the fixture wrote, and a token supplied on the command line could belong to
 * a different broker — which is precisely the confusion this script exists to rule out.
 */
const brokerToken = (() => {
  try {
    return readFileSync(join(env.COSYNCING_HOME, 'secrets', 'broker-token'), 'utf8').trim();
  } catch {
    return '';
  }
})();

const get = async (path: string): Promise<any> => {
  const response = await fetch(`${base}${path}`, {
    headers: brokerToken ? { 'x-cosyncing-token': brokerToken } : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${path} responded ${response.status}`);
  return response.json();
};

// ── the comparison, as a pure function so --self-test can attack it ─────────────

const summarise = (value: unknown, limit = 90): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

/** Every string anywhere in a payload, so a leak in an unanticipated field is still caught. */
const strings = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, out);
  return out;
};

/**
 * Notifications the CAPTURE causes the broker to raise — pinned to their exact published shape.
 *
 * These are not leaks and not fixture data: they are the run's own footprints, and the broker is
 * right to record them. They are tolerated only by `--after-capture`, never by the check that runs
 * before a frame is taken, and only ever as ADDITIONS — everything the fixture did create is still
 * compared field by field, and every string in them is still leak-scanned.
 *
 * Kind alone is not the licence. "Some security-alert" and "some permission-required" are shapes a
 * genuine incident on a real machine has too, so tolerating a kind would leave a hole exactly the
 * width of the thing this script exists to catch. Each entry below therefore fixes every field the
 * app can render or act on, its dedupe key, and how many of it a run can produce — read off the code
 * that raises it (attention-policy.ts `upsertRequest`; the shared-token gate in runtime.ts). A
 * broker that starts raising something else here fails rather than being waved through.
 */
const liveSession = manifest.sessions.find((session) => session.title === manifest.live.session);
if (!liveSession) {
  console.error(`manifest names no session titled ${JSON.stringify(manifest.live?.session)}`);
  process.exit(2);
}

interface CaptureCaused {
  /** Why the capture causes it. Printed as a NOTE, so a reader can judge the tolerance. */
  why: string;
  /** How many a run can produce. A second one is somebody else's, not this run's footprint. */
  max: number;
  /** Exact values, compared with `String(value ?? '')` — so '' means "absent or empty". */
  fields: Record<string, string>;
  /** Exact where it is derivable; by pattern where the broker stamps a time into it. */
  dedupeKey: string | RegExp;
  /** What tapping the card does. */
  action: Record<string, string>;
}

const CAPTURE_CAUSED = new Map<string, CaptureCaused>([
  [
    'permission-required',
    {
      why: 'the approval frame leaves a real request pending, and a pending request is a notification',
      max: 1,
      fields: {
        kind: 'permission-required',
        state: 'active',
        severity: 'action-required',
        title: 'Permission required',
        summary: 'An agent is waiting for permission.',
        agent: liveSession.tool,
        sessionId: liveSession.id,
        sessionTitle: liveSession.title,
        requestId: manifest.live.requestId,
      },
      dedupeKey: `permission-required:${liveSession.tool}:${liveSession.id}:${manifest.live.requestId}`,
      action: { kind: 'open-session', tool: liveSession.tool, sessionId: liveSession.id },
    },
  ],
  [
    'security-alert',
    {
      why: 'the app makes its first reads before it is enrolled, and the broker records repeated auth '
        + 'failures (resolved on creation, so no frame can show it)',
      max: 1,
      fields: {
        kind: 'security-alert',
        // Created resolved, and that is why this one is tolerable at all: an event that is already
        // resolved is not in the inbox any frame photographs.
        state: 'resolved',
        severity: 'action-required',
        title: 'Repeated broker authentication failures',
        summary: 'Several requests failed broker authentication in a short period.',
        // The tracker stores no address, path, or session (attention-policy.ts), so a
        // security-alert that names one did not come from the enrolment gap.
        agent: '',
        sessionId: '',
        sessionTitle: '',
      },
      dedupeKey: /^auth-failures:\d+$/,
      action: { kind: 'open-attention-inbox' },
    },
  ],
]);

/** Every way a live event can fail to be the capture-caused one it claims to be. */
const capturedCausedProblems = (live: any, expected: CaptureCaused): string[] => {
  const found: string[] = [];
  const label = `capture-caused ${summarise(live?.kind)}`;
  for (const [field, want] of Object.entries(expected.fields)) {
    const got = String(live?.[field] ?? '');
    if (got !== want) {
      found.push(`${label} ${field} is ${summarise(got)}, expected ${summarise(want)}`);
    }
  }
  const key = String(live?.dedupeKey ?? '');
  const keyMatches = typeof expected.dedupeKey === 'string'
    ? key === expected.dedupeKey
    : expected.dedupeKey.test(key);
  if (!keyMatches) {
    found.push(`${label} dedupeKey is ${summarise(key, 60)}, expected ${summarise(String(expected.dedupeKey), 60)}`);
  }
  const action = live?.action ?? {};
  for (const [field, want] of Object.entries(expected.action)) {
    if (String(action[field] ?? '') !== want) {
      found.push(`${label} action ${field} is ${summarise(action[field])}, expected ${summarise(want)}`);
    }
  }
  return found;
};

const compare = (
  sessions: any[],
  events: any[],
  machine: string,
  options: { afterCapture?: boolean; notes?: string[] } = {},
): string[] => {
  const problems: string[] = [];
  const notes = options.notes ?? [];

  if (machine !== manifest.machine) {
    problems.push(`broker machine is ${JSON.stringify(machine)}, expected the fixture label ${JSON.stringify(manifest.machine)}`);
  }

  /**
   * Index a published list by its identity field, refusing duplicates.
   *
   * Collapsing rows into a map silently keeps the last one, so a duplicated id with the expected
   * row last would compare clean while the app rendered two — and the extra one is where a real
   * session would hide. The row count is checked against the map for the same reason.
   */
  const indexUnique = (rows: any[], key: string, what: string): Map<string, any> => {
    const byKey = new Map<string, any>();
    for (const row of rows) {
      const id = String(row?.[key] ?? '');
      if (id === '') {
        problems.push(`published ${what} has no ${key}: ${summarise(row)}`);
        continue;
      }
      if (byKey.has(id)) problems.push(`DUPLICATE ${what} ${key} published twice: ${summarise(id, 40)}`);
      byKey.set(id, row);
    }
    return byKey;
  };

  // Sessions, as an exact set keyed by the id the broker publishes.
  const expected = new Map(manifest.sessions.map((session) => [session.id, session]));
  const actual = indexUnique(sessions, 'id', 'session');
  if (sessions.length !== manifest.sessions.length) {
    problems.push(`roster publishes ${sessions.length} sessions, expected ${manifest.sessions.length}`);
  }

  for (const [id, session] of expected) {
    const live = actual.get(id);
    if (!live) {
      problems.push(`session missing from the roster: ${session.tool} "${session.title}"`);
      continue;
    }
    // Every field the roster or Session Detail can put on screen. `model` is rendered on each row.
    for (const field of ['tool', 'title', 'cwd', 'model'] as const) {
      if (String(live[field] ?? '') !== String(session[field] ?? '')) {
        problems.push(
          `session "${session.title}" ${field} is ${summarise(live[field])}, expected ${summarise(session[field])}`,
        );
      }
    }
  }
  for (const [id, live] of actual) {
    if (expected.has(id)) continue;
    problems.push(
      `UNEXPECTED session the fixture did not create: ${summarise(live.tool)} ${summarise(live.title)} ` +
        `cwd=${summarise(live.cwd)} id=${summarise(id, 40)}`,
    );
  }

  // Attention feed, as an exact set keyed by dedupe key.
  const expectedEvents = new Map(manifest.attention.map((event) => [event.dedupeKey, event]));
  const actualEvents = indexUnique(events, 'dedupeKey', 'attention event');
  const tolerated: any[] = [];
  const toleratedByKind = new Map<string, number>();
  for (const [key, live] of actualEvents) {
    if (expectedEvents.has(key)) continue;
    const kind = String(live.kind ?? '');
    const expected = options.afterCapture ? CAPTURE_CAUSED.get(kind) : undefined;
    if (!expected) {
      problems.push(
        `UNEXPECTED attention event the fixture did not create: ${summarise(live.kind)} ${summarise(live.title)}`,
      );
      continue;
    }
    // Tolerated as a whole shape or not at all: one field off and it is an unexpected event again.
    const wrong = capturedCausedProblems(live, expected);
    if (wrong.length > 0) {
      problems.push(
        `UNEXPECTED attention event: a ${summarise(kind)} that is not the one this capture causes`,
        ...wrong,
      );
      continue;
    }
    const seen = (toleratedByKind.get(kind) ?? 0) + 1;
    toleratedByKind.set(kind, seen);
    if (seen > expected.max) {
      problems.push(
        `capture-caused ${summarise(kind)} published ${seen} times; a run causes at most ${expected.max}`,
      );
      continue;
    }
    tolerated.push(live);
    notes.push(`capture-caused ${kind} "${String(live.title)}" — ${expected.why}`);
  }
  if (events.length - tolerated.length !== manifest.attention.length) {
    problems.push(
      `attention feed publishes ${events.length} events${tolerated.length ? ` (${tolerated.length} caused by the capture)` : ''}, ` +
        `expected ${manifest.attention.length}`,
    );
  }

  for (const [key, event] of expectedEvents) {
    const live = actualEvents.get(key);
    if (!live) {
      problems.push(`attention event missing from the feed: ${event.kind} "${event.title}"`);
      continue;
    }
    // `sessionTitle` is rendered in the Notifications frame and is free text that could carry a
    // real session's name, so it is compared like everything else rather than trusted.
    for (const field of ['kind', 'severity', 'title', 'summary', 'sessionTitle', 'agent', 'sessionId'] as const) {
      if (String(live[field] ?? '') !== event[field]) {
        problems.push(
          `attention "${event.title}" ${field} is ${summarise(live[field])}, expected ${summarise(event[field])}`,
        );
      }
    }
    // The action is what tapping the card does; a mismatched target opens a session the fixture
    // never created.
    const action = live.action ?? {};
    if (String(action.kind ?? '') !== 'open-session'
      || String(action.tool ?? '') !== event.agent
      || String(action.sessionId ?? '') !== event.sessionId) {
      problems.push(`attention "${event.title}" action does not open its own session: ${summarise(action)}`);
    }
  }
  // Second net: shapes that mean a real machine leaked, wherever they appear in either payload.
  // The fixture root itself is exempt ONLY from the home-directory rule: every byte under it is
  // seeder-generated (the id decode below proves each transcript lives there), so a root placed
  // under /home for readable on-camera paths cannot itself be a leak — while any REAL home path
  // beside it still trips the net.
  for (const text of [...strings(sessions), ...strings(events)]) {
    for (const { label, pattern } of FORBIDDEN) {
      const probe = label === 'home-directory path' ? text.split(manifest.root).join('<fixture>') : text;
      if (pattern.test(probe)) problems.push(`published payload contains a ${label}: ${summarise(text, 120)}`);
    }
  }

  // Ids are base64url of a transcript path, so they carry the fixture root wherever they are shown
  // or copied. Anything decoding outside the root means a foreign transcript is on the roster.
  for (const session of sessions) {
    const decoded = Buffer.from(String(session.id), 'base64url').toString('utf8');
    if (!decoded.startsWith(`${manifest.root}/`)) {
      problems.push(`session id for ${summarise(session.title)} decodes outside the fixture root: ${summarise(decoded, 120)}`);
    }
  }

  return problems;
};

// ── live data ───────────────────────────────────────────────────────────────────

const health = await get('/api/health');
const roster = await get('/api/sessions');
const attention = await get('/api/attention-events?clientId=brand-fixture-verify&limit=100');
const sessions: any[] = roster.sessions ?? [];
const events: any[] = attention.events ?? [];

const failures: string[] = [];
const fail = (message: string): void => {
  failures.push(message);
  console.log(`FAIL  ${message}`);
};
const pass = (message: string): void => console.log(`PASS  ${message}`);

const notes: string[] = [];
const problems = compare(sessions, events, health.machine, { afterCapture: flag('after-capture'), notes });
for (const note of notes) console.log(`NOTE  ${note}`);
for (const problem of problems) fail(problem);
if (problems.length === 0) {
  pass(`roster is exactly the ${manifest.counts.sessions} fictitious sessions the fixture created`);
  pass(`attention feed is exactly the ${manifest.counts.attention} fictitious events the fixture created`
    + (notes.length ? `, plus ${notes.length} the capture itself caused` : ''));
  pass('no published string carries a home path, drive path, tailnet name, or private address');
  pass('every published session id decodes to a path inside the fixture root');
}

// ── the OpenCode escape hatch stays closed ──────────────────────────────────────
const opencodeReachable = await fetch(`${env.OPENCODE_URL}/`, { signal: AbortSignal.timeout(1_500) })
  .then(() => true, () => false);
if (opencodeReachable) fail(`${env.OPENCODE_URL} answered — the fixture can reach a real OpenCode server`);
else pass(`${env.OPENCODE_URL} is dead, so OpenCode discovery contributes nothing`);

// ── does the comparison actually reject anything? ───────────────────────────────
if (flag('self-test')) {
  /** The live feed plus some intruders, judged the way the post-capture run judges it. */
  const after = (extra: any[]): string[] =>
    compare(sessions, [...events, ...extra], health.machine, { afterCapture: true });
  /**
   * Exactly what the capture causes the broker to publish, built from the tolerated shape itself.
   *
   * Building the mutants by altering THIS, rather than by writing plausible events by hand, is what
   * makes each one a test of a single field: everything except the named field is right.
   */
  const causedByCapture = (kind: string): Record<string, unknown> => {
    const expected = CAPTURE_CAUSED.get(kind)!;
    return {
      ...expected.fields,
      dedupeKey: typeof expected.dedupeKey === 'string' ? expected.dedupeKey : 'auth-failures:1780000000000',
      action: { ...expected.action },
    };
  };

  const mutants: { label: string; run: () => string[] }[] = [
    {
      label: 'one extra plausible-looking session',
      run: () =>
        compare(
          [
            ...sessions,
            {
              // Fictitious-looking by every rule the old check applied: it sits under the fixture
              // root, its id decodes there, and its title reads like the others.
              id: Buffer.from(
                `${manifest.root}/.fixture/claude/projects/x/00000000-0000-4000-8000-000000000000.jsonl`,
                'utf8',
              ).toString('base64url'),
              tool: 'claude',
              title: 'Add retry backoff to the webhook sender',
              cwd: `${manifest.root}/atlas-api`,
            },
          ],
          events,
          health.machine,
        ),
    },
    { label: 'one omitted session', run: () => compare(sessions.slice(1), events, health.machine) },
    {
      label: 'one altered session title',
      run: () =>
        compare(
          sessions.map((session, index) => (index === 0 ? { ...session, title: 'Something else entirely' } : session)),
          events,
          health.machine,
        ),
    },
    {
      label: 'one altered session model',
      run: () =>
        compare(
          sessions.map((session, index) => (index === 0 ? { ...session, model: 'some-other-model' } : session)),
          events,
          health.machine,
        ),
    },
    {
      // The dangerous shape: the expected row is still present and still last, so a comparison that
      // indexes by id without counting would see nothing wrong.
      label: 'a duplicated session id, expected row last',
      run: () => compare([{ ...sessions[0], title: 'A different session entirely' }, ...sessions], events, health.machine),
    },
    { label: 'one omitted attention event', run: () => compare(sessions, events.slice(1), health.machine) },
    {
      label: 'an altered notification session title',
      run: () =>
        compare(
          sessions,
          events.map((event, index) => (index === 0 ? { ...event, sessionTitle: 'Someone else’s session' } : event)),
          health.machine,
        ),
    },
    {
      label: 'a duplicated attention event, expected row last',
      run: () => compare(sessions, [{ ...events[0], title: 'A different notification' }, ...events], health.machine),
    },
    {
      // --after-capture tolerates the run's own footprints. Prove that tolerance is two exact
      // shapes and not a hole: a foreign event of any other kind must still be rejected by it.
      label: 'an unexpected event of another kind, in --after-capture mode',
      run: () =>
        after([{ dedupeKey: 'intruder:run-finished', kind: 'run-finished', title: 'Ready to review', summary: 'Something the fixture never created.' }]),
    },
    {
      // And that a tolerated KIND cannot smuggle a foreign session in with it.
      label: 'a capture-caused kind naming a session the fixture never created, in --after-capture mode',
      run: () => after([{ ...causedByCapture('permission-required'), sessionId: 'c29tZWJvZHkgZWxzZQ' }]),
    },
    {
      // The shape the old kind-only tolerance let through: everything else right, one field wrong.
      // A real incident on a real machine publishes a permission-required too.
      label: 'a capture-caused kind with an altered summary, in --after-capture mode',
      run: () => after([{ ...causedByCapture('permission-required'), summary: 'An agent is waiting to write to another checkout.' }]),
    },
    {
      // `sessionId` absent is not "nothing to check" — the request this capture causes names the
      // session it was raised in, and one that names nothing was raised somewhere else.
      label: 'a capture-caused kind with no session id at all, in --after-capture mode',
      run: () => after([{ ...causedByCapture('permission-required'), sessionId: undefined }]),
    },
    {
      // The bound. Two auth-failure incidents are two brokers' worth of failures, or an hour of
      // them; either way the second one is not this run's footprint.
      label: 'a second capture-caused security-alert, in --after-capture mode',
      run: () =>
        after([
          causedByCapture('security-alert'),
          { ...causedByCapture('security-alert'), dedupeKey: 'auth-failures:1780000000001' },
        ]),
    },
  ];
  for (const mutant of mutants) {
    const caught = mutant.run().length;
    if (caught > 0) pass(`self-test: ${mutant.label} is rejected (${caught} problem${caught === 1 ? '' : 's'})`);
    else fail(`self-test: ${mutant.label} was ACCEPTED — the comparison does not prove anything`);
  }
  // The other direction: a tolerance nothing can satisfy would fail every capture instead, so the
  // exact pair this run causes has to be accepted. Both are built from CAPTURE_CAUSED, which is
  // read off the broker code that raises them — the run itself is what proves that reading right.
  const control = after([causedByCapture('permission-required'), causedByCapture('security-alert')]);
  if (control.length === 0) pass('self-test: the exact pair a capture causes is accepted by --after-capture');
  else fail(`self-test: --after-capture rejects its own two events, so no capture can pass it: ${control.join('; ')}`);
}

console.log();
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed — do NOT capture from this broker.`);
  process.exit(1);
}
console.log('fixture is clean; captures may proceed.');
