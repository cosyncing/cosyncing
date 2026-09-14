#!/usr/bin/env bun
/**
 * A roster answered ahead of its sweep reaches the client before the safety net.
 *
 * `/api/sessions` answers 304 whenever the roster revision is unchanged, and it
 * does so ABOVE discovery -- a 304 never calls `discoverLocalSessions`. So a
 * sweep that finishes in the background is invisible: it fills the snapshot, no
 * revision moves, and the poll that would have picked its rows up is the very
 * poll being short-circuited. Nothing broke the loop except an unrelated live
 * mutation or the periodic safety reconcile, which the completed sweep had
 * itself just deferred.
 *
 * The case that matters is a session discovered on DISK with no live owner to
 * announce it -- a terminal-started harness. It is exactly what a sweep is for,
 * and it was the thing most likely to be missing.
 *
 * This suite proves the outcome over real HTTP, where the revision and the ETag
 * live; `test-roster-sweep-cache.ts` proves the rule that produces it. The
 * safety reconcile is pushed to an hour so it CANNOT be what rescues the test,
 * and the fixture is a Pi session because Pi ships no `watchSessionInfo` -- a
 * watcher would publish the new row independently and the test would pass
 * against the bug.
 *
 * What this suite does NOT reach is a roster the broker calls incomplete. That
 * needs an adapter slow enough to be abandoned or to miss the cold-partial
 * bound, and the isolated fixture has no such harness to install. The rule that
 * decides coverage is pinned in `test-roster-sweep-cache.ts`, and the 304 rule
 * that an incomplete body must never be reused is pinned in `test-roster-http.ts`.
 * What is proved here is the wire: a healthy roster says `complete: true` rather
 * than leaving a client to assume it.
 *
 *   bun run packages/typescript/broker/test/broker/test-roster-stale-reconcile.ts
 */
export {};
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  waitForBrokerHealth,
} from '../helpers/isolated-broker-fixture.ts';
import type { SessionInfo } from '../../../protocol/src/index.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate a test port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

const ROSTER_TTL_MS = 1_000;
/** Far longer than the whole suite, so a pass cannot be the safety net's work. */
const SAFETY_RECONCILE_MS = 3_600_000;
/** Generous against a loaded host, and still two orders below the safety net. */
const CORRECTION_DEADLINE_MS = 15_000;

const testHome = mkdtempSync(join(tmpdir(), 'cosyncing-roster-stale-'));
const piRoot = join(testHome, 'pi-sessions');
const piProject = join(piRoot, '--fixture--');
mkdirSync(piProject, { recursive: true });
const piLine = (id: string): string => `${JSON.stringify({ type: 'session', id, cwd: testHome })}\n`;

const knownFile = join(piProject, '2026-09-11_known.jsonl');
const appearsFile = join(piProject, '2026-09-11_appears.jsonl');
writeFileSync(knownFile, piLine('known'));
const knownId = Buffer.from(knownFile).toString('base64url');
const appearsId = Buffer.from(appearsFile).toString('base64url');

const port = await freePort();
const broker = Bun.spawn(['bun', 'packages/typescript/broker/src/main.ts'], {
  cwd: process.cwd(),
  env: isolatedBrokerFixtureEnvironment(testHome, {
    overrides: {
      PORT: String(port),
      HOST: '127.0.0.1',
      HOME: testHome,
      XDG_CONFIG_HOME: join(testHome, '.config'),
      XDG_DATA_HOME: join(testHome, '.local', 'share'),
      XDG_STATE_HOME: join(testHome, '.local', 'state'),
      COSYNCING_HOME: testHome,
      COSYNCING_MACHINE: 'roster-stale-test',
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
      COSYNCING_CODEX_SYNC_SERVER: '0',
      COSYNCING_PI_SESSIONS_ROOT: piRoot,
      PI_CODING_AGENT_SESSION_DIR: piRoot,
      PI_CODING_AGENT_DIR: join(testHome, '.pi', 'agent'),
      COSYNCING_ROSTER_TTL_MS: String(ROSTER_TTL_MS),
      COSYNCING_ROSTER_SAFETY_RECONCILE_MS: String(SAFETY_RECONCILE_MS),
      COSYNCING_RESTART_DRY_RUN: '1',
    },
  }),
  stdout: 'ignore',
  stderr: 'pipe',
});
const brokerOutput = captureProcessOutput(broker);
const base = `http://127.0.0.1:${port}`;

interface Roster { revision: number; sessions: SessionInfo[]; complete?: boolean }
const ids = (roster: Roster): string[] => roster.sessions.map((session) => session.id);

try {
  let healthy = true;
  try {
    await waitForBrokerHealth(broker, `${base}/api/health`);
  } catch (error) {
    healthy = false;
    console.log(`      ${(error as Error).message}\n${brokerOutput.read().trim().slice(-2000)}`);
  }
  check('isolated broker starts for the stale-reconcile check', healthy);

  if (healthy) {
    const firstResponse = await fetch(`${base}/api/sessions`);
    const first = await firstResponse.json() as Roster;
    check(
      'the first roster carries the session already on disk',
      firstResponse.ok && ids(first).includes(knownId),
      JSON.stringify({ revision: first.revision, rows: ids(first).length }),
    );
    // Contract revision 23. A healthy sweep says so explicitly rather than
    // leaving the client to assume it: the assumption is the thing that broke.
    check(
      'a healthy roster states on the wire that it is the whole roster',
      first.complete === true,
      `complete=${String(first.complete)}`,
    );

    // A terminal-started session appears with no live owner to announce it.
    writeFileSync(appearsFile, piLine('appears'));
    // Past the TTL, so the next request takes the stale-while-revalidate path
    // rather than a cache hit.
    await Bun.sleep(ROSTER_TTL_MS + 250);

    // A reconnect: no If-None-Match, so it reaches discovery and is served the
    // rows from before the new file existed.
    const staleResponse = await fetch(`${base}/api/sessions`);
    const stale = await staleResponse.json() as Roster;
    const staleEtag = staleResponse.headers.get('etag') ?? '';
    check(
      'a reconnect past the TTL is served the rows from before the session appeared',
      staleResponse.status === 200 && !ids(stale).includes(appearsId) && staleEtag !== '',
      `status=${staleResponse.status} rows=${ids(stale).length} hasNew=${ids(stale).includes(appearsId)}`,
    );

    // From here the client behaves exactly as the app does: poll with the ETag
    // it was given. Against the bug every one of these is a 304, because the
    // revision never moves and a 304 never reaches discovery.
    const startedAt = Date.now();
    let corrected: Roster | undefined;
    let statuses: number[] = [];
    while (Date.now() - startedAt < CORRECTION_DEADLINE_MS) {
      const poll = await fetch(`${base}/api/sessions`, { headers: { 'if-none-match': staleEtag } });
      statuses.push(poll.status);
      if (poll.status === 200) {
        const body = await poll.json() as Roster;
        if (ids(body).includes(appearsId)) { corrected = body; break; }
      } else {
        await poll.arrayBuffer();
      }
      await Bun.sleep(250);
    }
    const elapsed = Date.now() - startedAt;
    check(
      'the completed sweep reaches the ETag client without waiting for the safety reconcile',
      corrected !== undefined,
      `${elapsed}ms of a ${CORRECTION_DEADLINE_MS}ms deadline, safety reconcile at ${SAFETY_RECONCILE_MS}ms; statuses=${statuses.join(',')}`,
    );
    check(
      'and it arrives as a moved roster revision rather than a silently swapped body',
      corrected !== undefined && corrected.revision > stale.revision,
      `stale=${stale.revision} corrected=${String(corrected?.revision)}`,
    );
    check(
      'the corrected roster keeps the row it already had',
      corrected !== undefined && ids(corrected).includes(knownId) && ids(corrected).includes(appearsId),
      JSON.stringify(corrected === undefined ? [] : ids(corrected).length),
    );
    check(
      'and both the stale answer and the correction are whole rosters, so neither is flagged',
      stale.complete === true && corrected?.complete === true,
      `stale=${String(stale.complete)} corrected=${String(corrected?.complete)}`,
    );
  }
} finally {
  broker.kill();
  await broker.exited.catch(() => null);
  rmSync(testHome, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
