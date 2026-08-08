#!/usr/bin/env bun
/**
 * R1c adapter evidence: LIVE OpenCode API discovery must carry a real parent/child relation all the
 * way into the roster, and the disk-only fallback must stay parent-only.
 *
 * This drives the REAL `OpenCodeAdapter.discoverSessions()` — not a re-implementation of its mapping
 * — against a stub `opencode serve` whose payloads use the shape a real OpenCode store emits:
 * `{ id, parentID, projectID, directory, slug, title, time: { created, updated }, version }`, with
 * `ses_`-prefixed ids. That shape was read back from a real local store during the R1c audit (418
 * session files: 118 parent rows, 300 rows carrying a real `parentID`, every child's `parentID`
 * resolving to a present parent id).
 *
 * The invariant the Flutter roster nests on is `child.parentThreadId === parent.nativeId`, resolved
 * within one machine+tool. Nothing here may depend on a title heuristic or a tool-specific branch.
 *
 *   bun run scripts/broker/tests/opencode/test-opencode-api-lineage.ts     (exit 0 = all pass)
 */
export {};
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeAdapter } from '../../../../packages/typescript/adapters/opencode/src/index.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const WORKTREE = '/work/cosyncing';
const now = 1_769_000_000_000;
const row = (id: string, title: string, parentID?: string) => ({
  id,
  ...(parentID ? { parentID } : {}),
  projectID: 'be013a1e458995ddc9e1b5ac57e5aaccb770eaff',
  directory: WORKTREE,
  slug: title.toLowerCase().replace(/\W+/g, '-'),
  title,
  version: '1.17.19',
  time: { created: now - 60_000, updated: now },
});

// A real live-API listing: one human parent plus two sub-agent children it spawned, and a second
// unrelated top-level session. Children are returned by the API exactly like parents are.
const API_PARENT = row('ses_3d1a3849fffeD0T7YXGdaXe3f4', 'Build the thing');
const API_CHILD_A = row('ses_3d19bf606ffeG8AZxrg5PV5saW', 'Explore repo', API_PARENT.id);
const API_CHILD_B = row('ses_3d134f246ffezXSws7SQF0qVv6', 'Research API', API_PARENT.id);
const API_OTHER = row('ses_3d0f00112ffeQ2ZmnbW4rTc9kL', 'Unrelated work');
const API_ROWS = [API_CHILD_A, API_PARENT, API_CHILD_B, API_OTHER]; // child-first on purpose

// Disk-only rows the API never returns: one orphaned-projectID parent (must be added) and one of its
// children (must NOT be bulk-added — that is the boundary R1c deliberately keeps).
const DISK_PARENT = row('ses_3d0aaa223ffeM7QwertyUio1p', 'Offline parent');
const DISK_CHILD = row('ses_3d0bbb334ffeN8AsdfghJkl2q', 'Offline child', DISK_PARENT.id);

const dataDir = mkdtempSync(join(tmpdir(), 'oc-lineage-'));
const sessionDir = join(dataDir, 'storage', 'session', DISK_PARENT.projectID);
mkdirSync(sessionDir, { recursive: true });
for (const s of [DISK_PARENT, DISK_CHILD]) {
  writeFileSync(join(sessionDir, `${s.id}.json`), JSON.stringify(s));
}

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    const json = (body: unknown) => Response.json(body);
    if (url.pathname === '/session') return json(API_ROWS);
    if (url.pathname === '/project') return json([{ worktree: WORKTREE }]);
    if (url.pathname === '/session/status') return json({});
    if (url.pathname === '/question' || url.pathname === '/permission') return json([]);
    // The status tracker's SSE subscription: keep it empty and open-ended rather than 404ing, so the
    // adapter takes its normal live path.
    if (url.pathname === '/global/event') {
      return new Response(new ReadableStream({ start() {} }), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response('not found', { status: 404 });
  },
});

const adapter = new OpenCodeAdapter({
  baseUrl: `http://127.0.0.1:${server.port}`,
  storageDir: dataDir,
});

const sessions = await adapter.discoverSessions();
const byId = new Map(sessions.map((s) => [s.id, s]));
const parent = byId.get(API_PARENT.id);
const childA = byId.get(API_CHILD_A.id);
const childB = byId.get(API_CHILD_B.id);

check(
  'live API discovery returns the parent AND its children as roster rows',
  !!parent && !!childA && !!childB,
  `${sessions.length} rows: ${sessions.map((s) => s.id.slice(0, 12)).join(', ')}`,
);

// THE invariant the client nests on.
check(
  "a live child's parentThreadId equals its parent's nativeId",
  childA?.parentThreadId === parent?.nativeId && childB?.parentThreadId === parent?.nativeId,
  `${childA?.parentThreadId} / ${childB?.parentThreadId} → ${parent?.nativeId}`,
);
check(
  'every live row carries its OWN nativeId, so nested descendants can resolve to it',
  parent?.nativeId === API_PARENT.id && childA?.nativeId === API_CHILD_A.id && childB?.nativeId === API_CHILD_B.id,
  JSON.stringify({ p: parent?.nativeId, a: childA?.nativeId, b: childB?.nativeId }),
);
check(
  'live children are tagged origin subagent and the parent is not tagged',
  childA?.origin === 'subagent' && childB?.origin === 'subagent' && parent?.origin === undefined,
  JSON.stringify({ a: childA?.origin, b: childB?.origin, p: parent?.origin }),
);
check(
  'parent and children share one machine+tool identity space',
  childA?.tool === parent?.tool && childB?.tool === parent?.tool && parent?.tool === 'opencode',
  `${parent?.tool}`,
);
check(
  'API-sourced rows are live (they win over any disk copy)',
  parent?.attachMode === 'live' && childA?.attachMode === 'live',
  `${parent?.attachMode} / ${childA?.attachMode}`,
);
// Broker order is status-then-recency and may put a child first; nesting is the client's job, so the
// adapter only has to keep the relation intact, which the checks above assert.
check(
  'a child listed before its parent still resolves to that parent',
  API_ROWS[0]!.id === API_CHILD_A.id && childA?.parentThreadId === parent?.nativeId,
  'API listing is deliberately child-first',
);

// The retained R1c boundary: disk augmentation adds top-level rows only.
check(
  'a disk-only orphaned-projectID PARENT is still added to the roster',
  byId.has(DISK_PARENT.id),
  DISK_PARENT.id,
);
check(
  'a disk-only CHILD is NOT bulk-added (historical children stay off the roster)',
  !byId.has(DISK_CHILD.id),
  `${DISK_CHILD.id} present=${byId.has(DISK_CHILD.id)}`,
);
check(
  'the disk-only parent is observe-mode, not falsely advertised as live',
  byId.get(DISK_PARENT.id)?.attachMode === 'observe',
  `${byId.get(DISK_PARENT.id)?.attachMode}`,
);

// No title heuristic: lineage is id-based, so identical titles never merge or split a relation.
check(
  'lineage never keys off titles',
  childA?.title !== childB?.title && childA?.parentThreadId === childB?.parentThreadId,
  `${childA?.title} vs ${childB?.title}`,
);

server.stop(true);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
