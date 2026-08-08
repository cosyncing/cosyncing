#!/usr/bin/env bun
/** Direct, deterministic proof that adapter roster cutoffs avoid native decode/query work. */
export {};

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { SessionDiscoveryWork } from '../../../../packages/typescript/adapter-api/src/index.ts';

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-adapter-bounds-'));
const now = Date.now();
const cutoff = now - 7 * 86_400_000;
const oldTime = new Date(cutoff - 86_400_000);
const recentTime = new Date(cutoff + 86_400_000);
const decoded = (work: SessionDiscoveryWork[]): string[] =>
  work
    .filter((event): event is Extract<SessionDiscoveryWork, { kind: 'decode-file' }> =>
      event.kind === 'decode-file')
    .map((event) => event.source);

function writeTimed(path: string, contents: string, time: Date): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  utimesSync(path, time, time);
}

try {
  // Adapter roots are resolved at module import, so isolate every one before
  // loading the workspace packages.
  const codexHome = join(root, 'codex');
  const claudeConfig = join(root, 'claude');
  const piAgent = join(root, 'pi-agent');
  const piSessions = join(piAgent, 'sessions');
  const emptyWrappers = join(root, 'claude-wrappers');
  mkdirSync(emptyWrappers, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  process.env.COSYNCING_CODEX_SYNC_SERVER = '1';
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  process.env.COSYNCING_CLAUDE_WRAPPER_DIR = emptyWrappers;
  process.env.PI_CODING_AGENT_DIR = piAgent;
  process.env.COSYNCING_PI_SESSIONS_ROOT = piSessions;
  process.env.PI_CODING_AGENT_SESSION_DIR = piSessions;
  // Keep discovery offline even when the developer machine has agent CLIs.
  process.env.PATH = '/usr/bin:/bin';

  const fakeClaude = join(root, 'fake-claude');
  const claudeOldLiveId = '22222222-2222-4222-8222-222222222222';
  writeFileSync(
    fakeClaude,
    `#!/bin/sh
if [ "$1" = "agents" ] && [ "$2" = "--json" ]; then
  printf '%s\\n' '[{"sessionId":"${claudeOldLiveId}","status":"waiting"}]'
  exit 0
fi
exit 0
`,
  );
  chmodSync(fakeClaude, 0o755);
  process.env.COSYNCING_CLAUDE_BIN = fakeClaude;

  const { CodexAdapter } = await import('../../../../packages/typescript/adapters/codex/src/index.ts');
  const { ClaudeAdapter } = await import('../../../../packages/typescript/adapters/claude/src/index.ts');
  const { PiAdapter } = await import('../../../../packages/typescript/adapters/pi/src/index.ts');
  const { OpenCodeAdapter } = await import('../../../../packages/typescript/adapters/opencode/src/index.ts');

  const codexDir = join(codexHome, 'sessions', '2026', '07', '29');
  const codexOldIdleId = '11111111-1111-4111-8111-111111111111';
  const codexOldLiveId = '22222222-2222-4222-8222-222222222222';
  const codexRecentId = '33333333-3333-4333-8333-333333333333';
  const codexPath = (id: string) =>
    join(codexDir, `rollout-2026-07-29T00-00-00-${id}.jsonl`);
  const codexLine = (id: string) =>
    `${JSON.stringify({
      timestamp: new Date(now).toISOString(),
      type: 'session_meta',
      payload: { id, cwd: root },
    })}\n`;
  writeTimed(codexPath(codexOldIdleId), codexLine(codexOldIdleId), oldTime);
  writeTimed(codexPath(codexOldLiveId), codexLine(codexOldLiveId), oldTime);
  writeTimed(codexPath(codexRecentId), codexLine(codexRecentId), recentTime);
  const codexWork: SessionDiscoveryWork[] = [];
  const codexLoadedRolloutId = basename(codexPath(codexOldLiveId))
    .replace(/^rollout-.*?-([0-9a-f-]+)\.jsonl$/i, '$1');
  const codexRows = await new CodexAdapter({
    queryLoadedThreadIds: async () => new Set([codexLoadedRolloutId]),
    scanCodexTuiPresence: async () => ({
      attributed: new Set(),
      unattributed: [],
      privateThreadIds: new Set(),
      privateUnattributed: [],
      unknownUnattributed: [],
      unknownThreadIds: new Set(),
      candidates: [],
      socketDiagAvailable: true,
      processScanAvailable: true,
    }),
  }).discoverSessions({ updatedAfter: cutoff, onWork: (work) => codexWork.push(work) });
  const codexDecoded = decoded(codexWork).map((path) => basename(path));
  check(
    'Codex skips old idle rollout parsing but decodes recent and old loaded sessions',
    !codexDecoded.some((path) => path.includes(codexOldIdleId)) &&
      codexDecoded.some((path) => path.includes(codexOldLiveId)) &&
      codexDecoded.some((path) => path.includes(codexRecentId)) &&
      codexRows.some((row) => row.nativeId === codexOldLiveId),
    JSON.stringify(codexDecoded),
  );

  const claudeDir = join(claudeConfig, 'projects', '-fixture');
  const claudeOldIdleId = '11111111-1111-4111-8111-111111111111';
  const claudeRecentId = '33333333-3333-4333-8333-333333333333';
  const claudePath = (id: string) => join(claudeDir, `${id}.jsonl`);
  const claudeLine = (id: string) =>
    `${JSON.stringify({
      type: 'user',
      uuid: `user-${id}`,
      timestamp: new Date(now).toISOString(),
      cwd: root,
      message: { content: `prompt ${id}` },
    })}\n`;
  writeTimed(claudePath(claudeOldIdleId), claudeLine(claudeOldIdleId), oldTime);
  writeTimed(claudePath(claudeOldLiveId), claudeLine(claudeOldLiveId), oldTime);
  writeTimed(claudePath(claudeRecentId), claudeLine(claudeRecentId), recentTime);
  const claudeWork: SessionDiscoveryWork[] = [];
  const claudeRows = await new ClaudeAdapter().discoverSessions({
    updatedAfter: cutoff,
    onWork: (work) => claudeWork.push(work),
  });
  const claudeDecoded = decoded(claudeWork).map((path) => basename(path));
  check(
    'Claude skips old idle transcript parsing but decodes recent and old needs-input sessions',
    !claudeDecoded.includes(`${claudeOldIdleId}.jsonl`) &&
      claudeDecoded.includes(`${claudeOldLiveId}.jsonl`) &&
      claudeDecoded.includes(`${claudeRecentId}.jsonl`) &&
      claudeRows.some((row) => row.id === Buffer.from(claudePath(claudeOldLiveId)).toString('base64url')),
    JSON.stringify(claudeDecoded),
  );

  const piDir = join(piSessions, '--fixture--');
  const piOld = join(piDir, '2026-07-01_old.jsonl');
  const piRecent = join(piDir, '2026-07-29_recent.jsonl');
  const piLine = `${JSON.stringify({ type: 'session', id: 'pi-session', cwd: root })}\n`;
  writeTimed(piOld, piLine, oldTime);
  writeTimed(piRecent, piLine, recentTime);
  const piWork: SessionDiscoveryWork[] = [];
  const piRows = await new PiAdapter({ brokerUrl: 'http://127.0.0.1:1' }).discoverSessions({
    updatedAfter: cutoff,
    onWork: (work) => piWork.push(work),
  });
  const piDecoded = decoded(piWork);
  check(
    'Pi skips old session parsing before reading JSONL content',
    !piDecoded.includes(piOld) && piDecoded.includes(piRecent) && piRows.length === 1,
    JSON.stringify(piDecoded),
  );

  const opencodeData = join(root, 'opencode');
  mkdirSync(opencodeData, { recursive: true });
  const dbPath = join(opencodeData, 'opencode.db');
  const db = new Database(dbPath);
  db.run(`
    create table session (
      id text primary key,
      parent_id text,
      slug text,
      directory text,
      title text,
      model text,
      revert text,
      time_created integer,
      time_updated integer,
      time_archived integer
    )
  `);
  db.query(
    `insert into session
      (id, parent_id, slug, directory, title, time_created, time_updated, time_archived)
      values (?, null, ?, ?, ?, ?, ?, null)`,
  ).run('old', 'old', root, 'Old', oldTime.getTime(), oldTime.getTime());
  db.query(
    `insert into session
      (id, parent_id, slug, directory, title, time_created, time_updated, time_archived)
      values (?, null, ?, ?, ?, ?, ?, null)`,
  ).run('recent', 'recent', root, 'Recent', recentTime.getTime(), recentTime.getTime());
  db.close();
  const opencodeWork: SessionDiscoveryWork[] = [];
  const opencodeRows = await new OpenCodeAdapter({
    baseUrl: 'http://127.0.0.1:1',
    storageDir: opencodeData,
  }).discoverSessions({
    updatedAfter: cutoff,
    onWork: (work) => opencodeWork.push(work),
  });
  const sql = opencodeWork.find(
    (work): work is Extract<SessionDiscoveryWork, { kind: 'sqlite-query' }> =>
      work.kind === 'sqlite-query',
  );
  check(
    'OpenCode applies the cutoff in SQLite instead of decoding/filtering all rows',
    sql?.bounded === true &&
      sql.cutoff === cutoff &&
      opencodeRows.some((row) => row.id === 'recent') &&
      !opencodeRows.some((row) => row.id === 'old'),
    JSON.stringify({ sql, rows: opencodeRows.map((row) => row.id) }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} adapter discovery-bound checks passed.`);
if (failed.length) process.exit(1);
