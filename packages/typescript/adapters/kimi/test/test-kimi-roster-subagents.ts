/**
 * Kimi ROSTER SUBAGENTS — `agents/agent-<N>/wire.jsonl` as observe-only child rows.
 *
 * The fixture tree below is SANITIZED: it reproduces the SHAPES measured on the
 * real host (`docs-internal/.../kimi-subagent-wire-facts.md`) with invented ids,
 * paths and prose. Nothing here is copied from a real session — the facts are
 * pinned in the doc, and a fixture that carried a user's prompts would leak them
 * into the repo.
 *
 * What this suite pins:
 *   1. enumeration — `state.json`'s `agents` map is the authority (its `type`
 *      is the discriminant, `parentAgentId` is not); `main` is never a child;
 *      a slot's NEWEST spawn record wins its title (slot reuse); a directory
 *      the map does not list yields no row.
 *   2. lineage — `child.parentThreadId === parent.nativeId` on rows the real
 *      discovery path built, and a CHILDLESS parent publishes no `nativeId`.
 *   3. budget — children spend from the sweep's own row ceiling, the cutoff
 *      filters by the child's own mtime, and every ceiling is REPORTED.
 *   4. observe-only — refused at attach, before any HTTP request is made, and
 *      every mutation on the connection rejects.
 *   5. history — the child's OWN journal, measured line types mapped, unknown
 *      types rendering nothing plus one trace, and no duplicated user row.
 *
 *   bun run packages/typescript/adapters/kimi/test/test-kimi-roster-subagents.ts   (exit 0 = pass)
 */
export {};
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KimiAdapter } from '../src/implementation.ts';
import { truncateToUtf8Budget } from '../src/mapping.ts';
import type { KimiInstanceScan } from '../src/server.ts';
import {
  kimiSessionNativeId,
  kimiSubagentIdInfo,
  kimiSubagentNativeId,
  kimiSubagentRow,
  kimiSubagentStatus,
  listKimiSubagents,
  readKimiAgentsMap,
  readKimiSpawnRecords,
  KIMI_SUBAGENT_DIR_SCAN_MAX,
  KIMI_SUBAGENT_NATIVE_PREFIX,
} from '../src/subagents.ts';
import {
  boundKimiSubagentText,
  kimiBlobRefMime,
  mapKimiSubagentHistory,
  readKimiWireTailLines,
  KimiSubagentConnection,
} from '../src/subagent-history.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
async function threw(run: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

// ── Fixture tree ────────────────────────────────────────────────────────────

const ROOT = join(tmpdir(), 'ca-kimi-roster-subagents');
rmSync(ROOT, { recursive: true, force: true });
const HOME = join(ROOT, 'kimi-home');
const SESSIONS = join(HOME, 'sessions');
const WORKSPACE_DIR = 'wd_fixture_0000000000';
const CWD = '/fixture/workspace';

const PARENT = 'session_11111111-1111-4111-8111-111111111111'; // 3 slots, 1 with a spawn record
const REUSED = 'session_22222222-2222-4222-8222-222222222222'; // 1 slot, 3 spawn records (reuse)
const PLAIN = 'session_33333333-3333-4333-8333-333333333333'; // no children at all
const COLD = 'session_44444444-4444-4444-8444-444444444444'; // children, all outside the cutoff
const GHOST = 'session_55555555-5555-4555-8555-555555555555'; // a dir the agents map does not list

const NOW = Date.now();
const FRESH = NOW - 5_000;
const STALE = NOW - 90 * 24 * 3600 * 1000;

function sessionDir(id: string): string {
  return join(SESSIONS, WORKSPACE_DIR, id);
}

/** `state.json` in the measured shape (§2): the agents map with `type` on every entry. */
function writeState(id: string, children: string[], opts: { omitFromMap?: string[] } = {}): void {
  const dir = sessionDir(id);
  mkdirSync(dir, { recursive: true });
  const agents: Record<string, unknown> = {
    main: { homedir: join(dir, 'agents', 'main'), type: 'main', parentAgentId: null },
  };
  for (const child of children) {
    if (opts.omitFromMap?.includes(child)) continue;
    agents[child] = {
      homedir: join(dir, 'agents', child),
      type: 'sub',
      parentAgentId: 'main',
      labels: { parentAgentId: 'main' },
    };
  }
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      id,
      version: 2,
      cwd: CWD,
      createdAt: NOW - 3_600_000,
      updatedAt: NOW,
      archived: false,
      agents,
      custom: {},
      title: `fixture ${id.slice(8, 12)}`,
      isCustomTitle: false,
    }),
  );
}

const line = (record: unknown): string => JSON.stringify(record) + '\n';

/** A child journal in the measured line schema (§3), with a settled 1.5 turn. */
function childJournal(opts: {
  protocolVersion?: string;
  profileName?: string;
  modelAlias?: string;
  promptText: string;
  createdAt?: number;
  extra?: unknown[];
}): string {
  const createdAt = opts.createdAt ?? NOW - 3_000_000;
  const out = [
    line({ type: 'metadata', protocol_version: opts.protocolVersion ?? '1.5', created_at: createdAt }),
    line({
      type: 'config.update',
      cwd: CWD,
      modelAlias: opts.modelAlias ?? 'kimi-code/k3-256k',
      thinkingEffort: 'high',
      time: createdAt,
    }),
    line({
      type: 'profile.bind',
      modelAlias: opts.modelAlias ?? 'kimi-code/k3-256k',
      profileName: opts.profileName ?? 'coder',
      thinkingEffort: 'high',
      systemPrompt: 'You are now running as a subagent. All the `user` messages are sent by the main agent.',
      time: createdAt,
    }),
    // A child's brief arrives with `origin.kind: 'system_trigger'` — MEASURED
    // on the FIRST `context.append_message` of 53/53 real child journals. The
    // kind matters: the reused mapper branches on it, and `task` (which the
    // parent's own journal uses for a background settlement) would render this
    // same text as a notification instead of the brief it is.
    line({
      type: 'turn.prompt',
      input: [{ type: 'text', text: opts.promptText }],
      origin: { kind: 'system_trigger' },
      time: createdAt + 10,
    }),
    // The measured duplicate: the SAME text also lands as a context message.
    line({
      type: 'context.append_message',
      message: { role: 'user', content: [{ type: 'text', text: opts.promptText }], toolCalls: [], origin: { kind: 'system_trigger' } },
      time: createdAt + 11,
    }),
  ];
  for (const record of opts.extra ?? []) out.push(line(record));
  return out.join('');
}

function writeChild(id: string, agentDir: string, journal: string, mtimeMs: number): string {
  const dir = join(sessionDir(id), 'agents', agentDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'wire.jsonl');
  writeFileSync(path, journal);
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}

function writeMain(id: string): void {
  const dir = join(sessionDir(id), 'agents', 'main');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'wire.jsonl'),
    line({ type: 'metadata', protocol_version: '1.5', created_at: NOW - 3_600_000 })
      + line({
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'PARENT TRANSCRIPT — a child row must never replay this' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
        time: NOW - 3_600_000,
      }),
  );
}

/** A `kind:'agent'` spawn record (§5); `agentId` names the DIRECTORY. */
function writeSpawn(id: string, taskId: string, agentDir: string, description: string, startedAt: number, status = 'completed'): void {
  const dir = join(sessionDir(id), 'agents', 'main', 'tasks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${taskId}.json`),
    JSON.stringify({
      taskId, description, status, detached: true,
      startedAt, endedAt: startedAt + 60_000, timeoutMs: 7_200_000,
      kind: 'agent', agentId: agentDir, subagentType: 'coder',
    }),
  );
}

// PARENT: agent-0 (no record), agent-1 (one record), agent-2 (explore profile)
writeState(PARENT, ['agent-0', 'agent-1', 'agent-2']);
writeMain(PARENT);
writeChild(PARENT, 'agent-0', childJournal({ promptText: 'Fixture brief zero for the roster suite.' }), FRESH);
writeChild(PARENT, 'agent-1', childJournal({ promptText: 'Fixture brief one for the roster suite.' }), FRESH);
writeChild(PARENT, 'agent-2', childJournal({ promptText: 'Fixture brief two.', profileName: 'explore', modelAlias: 'kimi-code/k3' }), FRESH);
writeSpawn(PARENT, 'agent-aaaa1111', 'agent-1', 'Named by its spawn record', NOW - 2_000_000);
// A `process` record named `agent-*` must NOT be read as a spawn record.
writeFileSync(
  join(sessionDir(PARENT), 'agents', 'main', 'tasks', 'agent-notatask.json'),
  JSON.stringify({ taskId: 'agent-notatask', kind: 'process', agentId: 'agent-0', description: 'impostor', status: 'completed' }),
);

// REUSED: one slot, three successive spawn records — newest must win.
writeState(REUSED, ['agent-0']);
writeMain(REUSED);
writeChild(REUSED, 'agent-0', childJournal({ promptText: 'First task in this slot.' }), FRESH);
writeSpawn(REUSED, 'agent-bbbb1111', 'agent-0', 'Oldest task in the slot', NOW - 5_000_000);
writeSpawn(REUSED, 'agent-bbbb3333', 'agent-0', 'Newest task in the slot', NOW - 1_000_000);
writeSpawn(REUSED, 'agent-bbbb2222', 'agent-0', 'Middle task in the slot', NOW - 3_000_000);

// PLAIN: main only.
writeState(PLAIN, []);
writeMain(PLAIN);

// COLD: children whose own journals are far outside any cutoff.
writeState(COLD, ['agent-0']);
writeMain(COLD);
writeChild(COLD, 'agent-0', childJournal({ promptText: 'A stale child.' }), STALE);

// GHOST: a directory on disk that the agents map does not list.
writeState(GHOST, ['agent-0'], { omitFromMap: ['agent-0'] });
writeMain(GHOST);
writeChild(GHOST, 'agent-0', childJournal({ promptText: 'Unlisted slot.' }), FRESH);

// F5: two parents whose agents map claims far more children than the
// examination cap allows, so the WORK ceiling is the only thing bounding them.
// One set is cold (journals exist, all outside any cutoff); the other is
// missing entirely (map entries with no file at all). NEITHER yields a row, so
// neither spends the YIELD budget — which is exactly why the yield budget alone
// could never bound this.
const MANY = 60;
const manyDirs = Array.from({ length: MANY }, (_, i) => `agent-${i}`);
const MANY_COLD = 'session_66666666-6666-4666-8666-666666666666';
const MANY_MISSING = 'session_77777777-7777-4777-8777-777777777777';

writeState(MANY_COLD, manyDirs);
writeMain(MANY_COLD);
for (const dir of manyDirs) {
  writeChild(MANY_COLD, dir, childJournal({ promptText: `Cold slot ${dir}.` }), STALE);
}

writeState(MANY_MISSING, manyDirs);
writeMain(MANY_MISSING);
// Deliberately no journals written: every entry is a map claim with no file.

// ── 1. Enumeration ──────────────────────────────────────────────────────────

{
  const scan = listKimiSubagents({ wireRoot: SESSIONS, parentSessionId: PARENT });
  const dirs = scan.children.map((c) => c.agentDir).join(',');
  check('all three slots enumerate, main excluded', dirs === 'agent-0,agent-1,agent-2', dirs);
  check('enumeration reports no truncation and no filtering',
    !scan.truncated && scan.filtered === 0 && scan.reads === 3,
    `truncated=${scan.truncated} filtered=${scan.filtered} reads=${scan.reads}`);

  const map = readKimiAgentsMap(sessionDir(PARENT)) ?? [];
  check('state.json is the authority and carries type on every entry',
    map.length === 4 && map.filter((e) => e.type === 'sub').length === 3
      && map.find((e) => e.agentId === 'main')?.type === 'main',
    JSON.stringify(map.map((e) => `${e.agentId}:${e.type}`)));

  const ghost = listKimiSubagents({ wireRoot: SESSIONS, parentSessionId: GHOST });
  check('a directory the agents map does not list yields NO row', ghost.children.length === 0,
    `children=${ghost.children.length}`);

  const plain = listKimiSubagents({ wireRoot: SESSIONS, parentSessionId: PLAIN });
  check('a childless parent enumerates nothing and reads nothing',
    plain.children.length === 0 && plain.reads === 0 && !plain.truncated);

  const unknown = listKimiSubagents({ wireRoot: SESSIONS, parentSessionId: 'session_does_not_exist' });
  check('an unknown session yields an empty scan rather than throwing', unknown.children.length === 0);

  const traversal = listKimiSubagents({ wireRoot: SESSIONS, parentSessionId: '../../etc' });
  check('a traversal-shaped id is refused before any io', traversal.children.length === 0 && traversal.reads === 0);

  // Identity + head-read facts.
  const zero = scan.children[0]!;
  const one = scan.children[1]!;
  const two = scan.children[2]!;
  check('the child nativeId is namespaced by parent AND slot',
    zero.nativeId === `${KIMI_SUBAGENT_NATIVE_PREFIX}${PARENT}/agent-0`
      && zero.nativeId === kimiSubagentNativeId(PARENT, 'agent-0'),
    zero.nativeId);
  check('title falls back to the first turn.prompt text when no spawn record names the slot',
    zero.title === 'Fixture brief zero for the roster suite.', zero.title);
  check('a spawn record description WINS the title',
    one.title === 'Named by its spawn record', one.title);
  check('subagentType and modelAlias come from the journal head',
    two.subagentType === 'explore' && two.modelAlias === 'kimi-code/k3',
    `${two.subagentType}/${two.modelAlias}`);
  check('protocolVersion and createdAt are read from the metadata line',
    zero.protocolVersion === '1.5' && typeof zero.createdAt === 'number', String(zero.protocolVersion));
  check('updatedAt tracks the journal mtime, not a wire line',
    Math.abs(zero.updatedAt - FRESH) < 2_000, `${zero.updatedAt} vs ${FRESH}`);

  // Slot reuse: newest record wins.
  const reused = listKimiSubagents({ wireRoot: SESSIONS, parentSessionId: REUSED });
  check('a reused slot is ONE row, not one row per task', reused.children.length === 1,
    `children=${reused.children.length}`);
  check('the NEWEST spawn record wins a reused slot',
    reused.children[0]?.title === 'Newest task in the slot', String(reused.children[0]?.title));
  const spawns = readKimiSpawnRecords(sessionDir(REUSED));
  check('all three records join to the same directory through agentId',
    spawns.byAgentId.size === 1 && spawns.byAgentId.get('agent-0')?.taskId === 'agent-bbbb3333',
    JSON.stringify([...spawns.byAgentId.keys()]));
  const parentSpawns = readKimiSpawnRecords(sessionDir(PARENT));
  check('a kind:process record named agent-* is NOT read as a spawn record',
    parentSpawns.byAgentId.size === 1 && !parentSpawns.byAgentId.has('agent-0'),
    JSON.stringify([...parentSpawns.byAgentId.keys()]));
}

// ── 2. Budget, cutoff, truncation ───────────────────────────────────────────

{
  const capped = listKimiSubagents({ wireRoot: SESSIONS, parentSessionId: PARENT, yieldBudget: 2 });
  check('the yield budget caps the children a parent may contribute',
    capped.children.length === 2, `children=${capped.children.length}`);
  check('an exhausted budget is REPORTED as truncation', capped.truncated === true);
  check('a capped scan pays only for what it yielded', capped.reads === 2, `reads=${capped.reads}`);

  const zeroBudget = listKimiSubagents({ wireRoot: SESSIONS, parentSessionId: PARENT, yieldBudget: 0 });
  check('a spent budget yields nothing and says so',
    zeroBudget.children.length === 0 && zeroBudget.truncated === true);

  const cold = listKimiSubagents({ wireRoot: SESSIONS, parentSessionId: COLD, updatedAfter: NOW - 3_600_000 });
  check('the cutoff excludes a child by its OWN mtime',
    cold.children.length === 0 && cold.filtered === 1,
    `children=${cold.children.length} filtered=${cold.filtered}`);
  check('a filtered scan is not reported as truncated (none exist ≠ none are recent)',
    cold.truncated === false);
  const coldNoCutoff = listKimiSubagents({ wireRoot: SESSIONS, parentSessionId: COLD });
  check('the same child IS enumerated with no cutoff', coldNoCutoff.children.length === 1);
}

// ── 2b. F5 — the yield budget bounds ROWS; the examination cap bounds WORK ───
//
// A yield budget spent only on produced rows leaves cold, missing and
// unreadable children free to cost a 64 KiB head read each. These parents claim
// 60 children and yield none, so under a yield-only bound they would run 60
// reads with the budget untouched.

{
  const cold = listKimiSubagents({
    wireRoot: SESSIONS,
    parentSessionId: MANY_COLD,
    updatedAfter: NOW - 3_600_000,
    yieldBudget: 50,
  });
  check('60 cold children yield no rows',
    cold.children.length === 0, `children=${cold.children.length}`);
  check('a scan that yields nothing still stops at the examination cap',
    cold.reads === KIMI_SUBAGENT_DIR_SCAN_MAX,
    `reads=${cold.reads} cap=${KIMI_SUBAGENT_DIR_SCAN_MAX} claimed=${MANY}`);
  check('tripping the examination cap is REPORTED as truncation', cold.truncated === true);
  check('only the examined children are counted as filtered, not all 60',
    cold.filtered === KIMI_SUBAGENT_DIR_SCAN_MAX, `filtered=${cold.filtered}`);

  const missing = listKimiSubagents({ wireRoot: SESSIONS, parentSessionId: MANY_MISSING, yieldBudget: 50 });
  check('60 children with no journal at all yield no rows',
    missing.children.length === 0, `children=${missing.children.length}`);
  check('a FAILED read still spends the examination cap and is counted as an attempt',
    missing.reads === KIMI_SUBAGENT_DIR_SCAN_MAX && missing.truncated === true,
    `reads=${missing.reads} truncated=${missing.truncated}`);

  // The two ceilings are independent: whichever binds first must stop the walk.
  const yieldBinds = listKimiSubagents({ wireRoot: SESSIONS, parentSessionId: MANY_COLD, yieldBudget: 5 });
  check('with no cutoff the YIELD budget binds first and caps reads below the examination cap',
    yieldBinds.children.length === 5 && yieldBinds.reads === 5 && yieldBinds.truncated === true,
    `children=${yieldBinds.children.length} reads=${yieldBinds.reads}`);
  const examBinds = listKimiSubagents({ wireRoot: SESSIONS, parentSessionId: MANY_COLD, yieldBudget: 1000 });
  check('with a huge yield budget the EXAMINATION cap binds instead',
    examBinds.children.length === KIMI_SUBAGENT_DIR_SCAN_MAX
      && examBinds.reads === KIMI_SUBAGENT_DIR_SCAN_MAX && examBinds.truncated === true,
    `children=${examBinds.children.length} reads=${examBinds.reads}`);

  check('the examination cap is a WIRED bound, not a declared-and-unused one',
    KIMI_SUBAGENT_DIR_SCAN_MAX === 32 && cold.reads <= KIMI_SUBAGENT_DIR_SCAN_MAX
      && missing.reads <= KIMI_SUBAGENT_DIR_SCAN_MAX,
    `cap=${KIMI_SUBAGENT_DIR_SCAN_MAX}`);

  // A parent within the cap must not be reported truncated just for existing.
  const small = listKimiSubagents({ wireRoot: SESSIONS, parentSessionId: PARENT });
  check('a parent under the examination cap reports no truncation',
    small.truncated === false && small.reads === 3, `reads=${small.reads}`);
}

// ── 3. Rows and lineage, through the real discovery path ────────────────────

const SERVER_STARTED_AT = 1_786_657_461_604;
const SERVER_META = {
  server_version: '0.35.0',
  server_id: 'api_subagent_fixture',
  started_at: new Date(SERVER_STARTED_AT + 200).toISOString(),
  capabilities: { websocket: true },
  dangerous_bypass_auth: false,
};
const ok = (data: unknown) => ({ code: 0, msg: 'success', data, request_id: 'req_fixture' });
const requests: string[] = [];
const rosterIds = [PARENT, REUSED, PLAIN];

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    requests.push(`${request.method} ${path}`);
    if (path === '/api/v1/healthz') return Response.json(ok({ ok: true }));
    if (path === '/api/v1/meta') return Response.json(ok(SERVER_META));
    if (path === '/api/v2/sessions') {
      return Response.json(ok({
        items: rosterIds.map((id) => ({
          id,
          workspace: { id: WORKSPACE_DIR, cwd: CWD },
          meta: { title: `fixture ${id.slice(8, 12)}`, created_at: NOW - 3_600_000, updated_at: NOW, archived: false },
          activity: { status: 'idle' },
        })),
        has_more: false,
      }));
    }
    return Response.json(ok({}));
  },
});

const baseUrl = `http://127.0.0.1:${server.port ?? 0}`;
const scan: KimiInstanceScan = {
  live: [{
    baseUrl, port: server.port ?? 0, pid: process.pid,
    serverId: 'srv_subagent_fixture', hostVersion: '0.35.0', startedAt: SERVER_STARTED_AT,
  }],
  stale: 0, invalid: 0, truncated: false,
};

try {
  const adapter = new KimiAdapter({
    env: { KIMI_CODE_HOME: HOME },
    homeDir: ROOT,
    instanceScan: () => scan,
    readToken: () => 'fixture-token',
  });

  const roster = await adapter.discoverSessions();
  const byId = new Map(roster.map((row) => [row.id, row]));
  const parentRow = byId.get(PARENT);
  const plainRow = byId.get(PLAIN);
  const childRows = roster.filter((row) => row.origin === 'subagent');

  check('discovery yields the three parents plus their four children',
    roster.length === 7 && childRows.length === 4,
    `rows=${roster.length} children=${childRows.length}`);

  check('a parent WITH children publishes a namespaced nativeId',
    parentRow?.nativeId === kimiSessionNativeId(PARENT), String(parentRow?.nativeId));
  check('a CHILDLESS parent publishes NO nativeId (identity is never invented store-wide)',
    plainRow?.nativeId === undefined && plainRow?.origin === undefined,
    `nativeId=${String(plainRow?.nativeId)}`);

  // The round-1 invariant, on rows the real sweep built.
  const pairsHold = childRows.every((child) => {
    const parent = roster.find((row) => row.nativeId === child.parentThreadId && row.origin === undefined);
    return parent !== undefined && child.parentThreadId === parent.nativeId;
  });
  check('INVARIANT child.parentThreadId === parent.nativeId for every child row', pairsHold,
    childRows.map((c) => `${c.id}->${c.parentThreadId}`).join(' '));

  const child0 = byId.get(kimiSubagentNativeId(PARENT, 'agent-0'));
  check('a child row carries origin subagent and its id equals its nativeId',
    child0?.origin === 'subagent' && child0.nativeId === child0.id,
    `${child0?.origin} ${child0?.id}`);
  check('a child inherits the parent workspace cwd', child0?.cwd === CWD, String(child0?.cwd));
  check('a child row publishes the host model alias verbatim, unlabelled',
    child0?.model === 'kimi-code/k3-256k' && child0?.currentModel === undefined, String(child0?.model));
  check('a child row is observe-only in its advertised control',
    child0?.attachMode === 'observe'
      && child0.control?.drive.supported === false
      && child0.control.drive.state === 'unavailable',
    JSON.stringify(child0?.control?.drive));
  check('a child row offers NO terminal command that cannot work',
    child0?.control?.terminalSync.supported === false
      && (child0.control.terminalSync as { command?: string }).command === undefined
      && (child0.control.terminalSync as { label?: string }).label === undefined,
    JSON.stringify(child0?.control?.terminalSync));
  check('a child row is idle while the parent has no turn in flight',
    child0?.status === 'idle', String(child0?.status));

  // Status rule, measured: BOTH evidences or idle.
  const fresh = { updatedAt: NOW, task: undefined };
  check('status is working only when the parent works AND the child journal is fresh',
    kimiSubagentStatus('working', fresh, NOW) === 'working'
      && kimiSubagentStatus('idle', fresh, NOW) === 'idle'
      && kimiSubagentStatus('working', { updatedAt: STALE, task: undefined }, NOW) === 'idle',
    'conjunction holds');
  check('a settled spawn record makes a child idle even under a working parent',
    kimiSubagentStatus('working', { updatedAt: NOW, task: { taskId: 't', agentId: 'agent-0', endedAt: NOW } }, NOW) === 'idle');

  // ── 4. Observe-only, ENFORCED at attach ──────────────────────────────────

  const childId = kimiSubagentNativeId(PARENT, 'agent-0');
  const before = requests.length;
  const live = await threw(() => adapter.attach(childId, 'live'));
  check('a live attach on a child row is REFUSED', live !== undefined && /Observe-only/.test(live.message),
    String(live?.message).slice(0, 90));
  const resume = await threw(() => adapter.attach(childId, 'resume'));
  check('a resume attach on a child row is REFUSED', resume !== undefined && /Observe-only/.test(resume.message));
  check('both refusals touched NO http request at all', requests.length === before,
    `requests before=${before} after=${requests.length}`);

  const conn = await adapter.attach(childId);
  check('a bare attach on a child row opens the observe-only connection',
    conn instanceof KimiSubagentConnection && conn.info.attachMode === 'observe');
  check('the attached child row rebuilds the SAME lineage pair discovery published',
    conn.info.nativeId === childId && conn.info.parentThreadId === kimiSessionNativeId(PARENT)
      && conn.info.origin === 'subagent',
    `${conn.info.nativeId} -> ${conn.info.parentThreadId}`);
  const explicitObserve = await adapter.attach(childId, 'observe');
  check('an explicit observe attach is admitted', explicitObserve instanceof KimiSubagentConnection);
  await explicitObserve.close();

  check('the child connection made no http request either',
    requests.length === before, `requests=${requests.length - before}`);

  // The concrete class, so the OPTIONAL members of `SessionConnection` are
  // reachable: an adapter that simply omitted them would leave the broker's
  // ownership precondition as the only guard, which reflection §11 says is the
  // wrong place for authority to live.
  const child = conn as KimiSubagentConnection;
  const mutations = await Promise.all([
    threw(() => child.sendPrompt()),
    threw(() => child.respondPermission()),
    threw(() => child.sendFile()),
    threw(() => child.runCommand()),
    threw(() => child.answerQuestion()),
    threw(() => child.setAgent()),
    threw(() => child.rejectQuestion()),
    threw(() => child.respondPlan()),
  ]);
  check('every mutating entry point on a child connection rejects',
    mutations.every((error) => error !== undefined && /observe-only/i.test(error.message)),
    `${mutations.filter((e) => e !== undefined).length}/${mutations.length} rejected`);
  check('subscribe accepts a handler and delivers nothing (no measured live shape)',
    typeof conn.subscribe(() => {}) === 'function');

  // A crafted id aimed at the PARENT's own journal must not open.
  const mainId = `${KIMI_SUBAGENT_NATIVE_PREFIX}${PARENT}/main`;
  const mainAttach = await threw(() => adapter.attach(mainId));
  check('an id aimed at agents/main is refused — a child must never replay the parent',
    mainAttach !== undefined && /not a subagent/.test(mainAttach.message),
    String(mainAttach?.message).slice(0, 80));
  const escape = await threw(() => adapter.attach(`${KIMI_SUBAGENT_NATIVE_PREFIX}${PARENT}/../main`));
  check('a traversal-shaped child id never reaches the journal reader', escape !== undefined);

  // ── 5. History — the CHILD's own journal ─────────────────────────────────

  const history = await conn.getHistory();
  const texts = history.filter((m) => m.type === 'user-message').map((m) => (m as { text?: string }).text ?? '');
  check('the child replays its OWN journal, never the parent transcript',
    !history.some((m) => JSON.stringify(m).includes('PARENT TRANSCRIPT')),
    `rows=${history.length}`);
  check('the child brief appears exactly ONCE despite turn.prompt duplicating it',
    texts.filter((t) => t === 'Fixture brief zero for the roster suite.').length === 1,
    JSON.stringify(texts));
  await conn.close();
} finally {
  server.stop(true);
}

// ── 6. The mapper, on measured line types ───────────────────────────────────

{
  const dir = join(ROOT, 'mapper');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'wire.jsonl');
  writeFileSync(path, [
    line({ type: 'metadata', protocol_version: '1.5', created_at: 1 }),
    line({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'hello from the parent agent' }], toolCalls: [], origin: { kind: 'system_trigger' } }, time: 2 }),
    line({ type: 'context.append_loop_event', event: { type: 'step.begin', turnId: '0', step: 1 }, time: 3 }),
    line({ type: 'context.append_loop_event', event: { type: 'content.part', uuid: 'u1', part: { type: 'think', think: 'thinking body' } }, time: 4 }),
    line({ type: 'context.append_loop_event', event: { type: 'content.part', uuid: 'u2', part: { type: 'text', text: 'assistant body' } }, time: 5 }),
    line({ type: 'context.append_loop_event', event: { type: 'tool.call', toolCallId: 'tool_1', name: 'Bash', args: { command: 'ls' }, description: 'Running: ls' }, time: 6 }),
    line({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'tool_1', parentUuid: 'tool_1', result: { output: 'a\nb' } }, time: 7 }),
    line({ type: 'context.append_loop_event', event: { type: 'tool.call', toolCallId: 'tool_2', name: 'ReadMediaFile', args: { path: '/x.png' } }, time: 8 }),
    line({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'tool_2', result: { output: [{ type: 'image_url', imageUrl: { url: 'blobref:image/png;' + 'a'.repeat(64) } }] } }, time: 9 }),
    line({ type: 'context.append_loop_event', event: { type: 'step.end', usage: { output: 1 } }, time: 10 }),
    line({ type: 'usage.record', usage: {}, usageScope: 'turn', time: 11 }),
    line({ type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 5, time: 12 }),
    line({ type: 'brand.new.line.type', time: 13 }),
    line({ type: 'context.append_loop_event', event: { type: 'brand.new.event' }, time: 14 }),
    'this line is not json\n',
  ].join(''));

  const read = readKimiWireTailLines(path)!;
  const mapped = mapKimiSubagentHistory(read);
  const types = mapped.messages.map((m) => m.type).join(',');
  check('measured line types map to canonical rows in file order',
    types === 'user-message,thinking,model-output,tool-call,tool-result,tool-call,tool-result', types);

  const thinking = mapped.messages.find((m) => m.type === 'thinking') as { text?: string } | undefined;
  const output = mapped.messages.find((m) => m.type === 'model-output') as { text?: string } | undefined;
  check('a think part reads its body from `part.think`, not `part.text`',
    thinking?.text === 'thinking body' && output?.text === 'assistant body',
    `${thinking?.text} / ${output?.text}`);

  const call = mapped.messages.find((m) => m.type === 'tool-call') as { toolName?: string; toolClass?: string; title?: string } | undefined;
  check('a tool call carries the name, the shared display class, and its description as the title',
    call?.toolName === 'Bash' && call.toolClass === 'execute' && call.title === 'Running: ls',
    JSON.stringify(call));
  const result = mapped.messages.find((m) => m.type === 'tool-result') as { callId?: string; toolName?: string; result?: unknown } | undefined;
  check('a tool result correlates to its call by toolCallId and inherits the tool name',
    result?.callId === 'tool_1' && result.toolName === 'Bash' && result.result === 'a\nb',
    JSON.stringify(result));

  const imageResult = mapped.messages.filter((m) => m.type === 'tool-result').at(-1) as { result?: unknown } | undefined;
  check('a blobref image renders as a NON-inlined placeholder naming its media type',
    JSON.stringify(imageResult?.result) === JSON.stringify([{ type: 'image', mimeType: 'image/png', inlined: false }]),
    JSON.stringify(imageResult?.result));
  check('blobref matching keys on the PREFIX, never on the 64-hex shape',
    kimiBlobRefMime('blobref:image/jpeg;' + 'b'.repeat(64)) === 'image/jpeg'
      && kimiBlobRefMime('c'.repeat(64)) === undefined
      && kimiBlobRefMime('sha256:' + 'd'.repeat(64)) === undefined);

  check('known telemetry lines render nothing and are NOT counted as drift',
    mapped.unmapped['usage.record'] === undefined
      && mapped.unmapped['turn.ended'] === undefined
      && mapped.unmapped['loop:step.begin'] === undefined,
    JSON.stringify(mapped.unmapped));
  check('an unknown line type renders NOTHING and is counted',
    mapped.unmapped['brand.new.line.type'] === 1 && mapped.unmapped['loop:brand.new.event'] === 1,
    JSON.stringify(mapped.unmapped));
  check('an unparseable line is dropped and counted, never guessed at',
    mapped.dropped === 1, `dropped=${mapped.dropped}`);

  const replayed = mapKimiSubagentHistory(read);
  check('the fold is deterministic — the same read yields the same rows',
    JSON.stringify(replayed.messages) === JSON.stringify(mapped.messages));

  // A clipped window drops its partial first line rather than parsing it.
  const clipped = readKimiWireTailLines(path, undefined, 200)!;
  check('a clipped tail read reports itself clipped and parses no partial line',
    clipped.clipped === true && clipped.lines.length > 0 && clipped.lines.length < read.lines.length,
    `lines=${clipped.lines.length}/${read.lines.length}`);
}

// ── 6b. F6 — truncation is measured AND cut in UTF-8 ────────────────────────
//
// The version this replaces measured the cap in bytes and cut with `slice()`,
// which counts UTF-16 code units: a CJK body under a 64 KiB byte cap came back
// at roughly three times it, and a cut landing between the two units of a
// surrogate pair emitted a lone surrogate — not valid UTF-8 at all.

{
  /** A lone surrogate does not survive a UTF-8 round trip; it becomes U+FFFD. */
  const utf8Clean = (text: string): boolean =>
    Buffer.from(text, 'utf8').toString('utf8') === text
    && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)
    && !/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

  const CJK = '思考内容需要被正确截断'.repeat(400); // 3 bytes per char
  const cjkBytes = Buffer.byteLength(CJK, 'utf8');
  const cut = boundKimiSubagentText(CJK, 1_024);
  check('a CJK body lands under the BYTE cap, not 3x over it',
    Buffer.byteLength(cut, 'utf8') <= 1_024,
    `in=${cjkBytes}B out=${Buffer.byteLength(cut, 'utf8')}B cap=1024`);
  check('the CJK source really was over the cap (the test would pass vacuously otherwise)',
    cjkBytes > 1_024 * 3, `${cjkBytes}B`);
  check('a truncated CJK body is still valid UTF-8', utf8Clean(cut));
  check('a truncated body says it was truncated', /truncated/.test(cut));

  // Emoji are surrogate PAIRS: a byte cut can land between their two units.
  // Sweeping caps walks the boundary across every offset inside a 4-byte glyph.
  const EMOJI = '🙂🚀🌍'.repeat(200);
  let worstBytes = 0;
  let allClean = true;
  let allUnderCap = true;
  for (let cap = 20; cap <= 200; cap += 1) {
    const out = boundKimiSubagentText(EMOJI, cap);
    const bytes = Buffer.byteLength(out, 'utf8');
    if (bytes > cap) { allUnderCap = false; worstBytes = Math.max(worstBytes, bytes - cap); }
    if (!utf8Clean(out)) allClean = false;
  }
  check('no cap in 20..200 ever splits a surrogate pair', allClean);
  check('no cap in 20..200 is ever exceeded', allUnderCap, `worst overshoot=${worstBytes}B`);

  // Mixed content, the realistic case: CJK + emoji + ASCII in one body.
  const MIXED = 'ok 好的 🙂 '.repeat(300);
  let mixedClean = true;
  for (let cap = 24; cap <= 300; cap += 7) {
    const out = boundKimiSubagentText(MIXED, cap);
    if (Buffer.byteLength(out, 'utf8') > cap || !utf8Clean(out)) mixedClean = false;
  }
  check('mixed CJK/emoji/ASCII bodies stay under cap and valid at every boundary', mixedClean);

  check('a body already under the cap is returned untouched',
    boundKimiSubagentText('短', 1_024) === '短' && boundKimiSubagentText('', 16) === '');

  // The same rule now governs the whole package — one implementation.
  check('the subagent reader and the approval reader share ONE truncation rule',
    boundKimiSubagentText('好'.repeat(100), 64) === truncateToUtf8Budget('好'.repeat(100), 64),
    'delegated to truncateToUtf8Budget');

  // And it reaches the real mapper path, not just the helper.
  const dir = join(ROOT, 'f6');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'wire.jsonl');
  // Over the 64 KiB TEXT cap but under the 128 KiB per-LINE ceiling: a longer
  // line is dropped by the reader (correctly), which would not exercise the cap.
  const bigThink = '推理过程'.repeat(7_000); // 28,000 chars ≈ 84,000 UTF-8 bytes
  writeFileSync(path, [
    line({ type: 'metadata', protocol_version: '1.5', created_at: 1 }),
    line({ type: 'context.append_loop_event', event: { type: 'content.part', uuid: 'u1', part: { type: 'think', think: bigThink } }, time: 2 }),
  ].join(''));
  const rows = mapKimiSubagentHistory(readKimiWireTailLines(path)!).messages;
  const think = rows.find((m) => m.type === 'thinking') as { text?: string } | undefined;
  check('a CJK thinking body from a real journal is capped in BYTES by the mapper',
    think?.text !== undefined
      && Buffer.byteLength(think.text, 'utf8') <= 64 * 1024
      && utf8Clean(think.text),
    `${Buffer.byteLength(think?.text ?? '', 'utf8')}B from ${Buffer.byteLength(bigThink, 'utf8')}B`);
}

// ── 7. Id round-trip ────────────────────────────────────────────────────────

{
  const id = kimiSubagentNativeId(PARENT, 'agent-7');
  const parsed = kimiSubagentIdInfo(id);
  check('a child id round-trips to its parent and slot',
    parsed?.parentSessionId === PARENT && parsed.agentDir === 'agent-7', JSON.stringify(parsed));
  check('an ordinary kimi session id is NOT read as a child handle',
    kimiSubagentIdInfo(PARENT) === undefined && kimiSubagentIdInfo('session_x') === undefined);
  check('a traversal-shaped handle is rejected at the boundary',
    kimiSubagentIdInfo(`${KIMI_SUBAGENT_NATIVE_PREFIX}../x/agent-0`) === undefined
      && kimiSubagentIdInfo(`${KIMI_SUBAGENT_NATIVE_PREFIX}${PARENT}/..`) === undefined
      && kimiSubagentIdInfo(`${KIMI_SUBAGENT_NATIVE_PREFIX}${PARENT}/`) === undefined);

  const row = kimiSubagentRow(
    {
      agentDir: 'agent-0',
      nativeId: kimiSubagentNativeId(PARENT, 'agent-0'),
      parentThreadId: kimiSessionNativeId(PARENT),
      parentSessionId: PARENT,
      wirePath: '/x/wire.jsonl',
      title: 't',
      updatedAt: NOW,
      headBytesRead: 1,
      headComplete: true,
      droppedLines: 0,
    },
    { cwd: '/parent/cwd', status: 'idle' },
    NOW,
  );
  check('a child with no cwd of its own inherits the parent workspace',
    row.cwd === '/parent/cwd' && row.parentThreadId === kimiSessionNativeId(PARENT), String(row.cwd));
}

// ── Summary ─────────────────────────────────────────────────────────────────

rmSync(ROOT, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exit(1);
