/**
 * Claude discovery recency/status tests.
 *
 * Offline: a fake `claude agents --json` reports the fixture as busy while the transcript mtime is fresh.
 * The adapter must use the last timestamped conversation line, not mtime-only sidecar churn, for both
 * updatedAt and the working freshness gate.
 *
 *   bun packages/typescript/adapters/claude/test/test-claude-recency.ts
 */
export {};
import { chmodSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
}

const ROOT = join(tmpdir(), 'ca-claude-recency');
rmSync(ROOT, { recursive: true, force: true });
const configDir = join(ROOT, 'claude');
const projectDir = join(configDir, 'projects', '-tmp-ca-recency');
const cwd = join(ROOT, 'workspace');
const wrapperBinDir = join(ROOT, 'bin');
const wrapperConfigDir = join(ROOT, 'wrapper-claude');
const wrapperProjectDir = join(wrapperConfigDir, 'projects', '-tmp-ca-wrapper');
mkdirSync(projectDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
mkdirSync(wrapperBinDir, { recursive: true });
mkdirSync(wrapperProjectDir, { recursive: true });

const uuid = 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa';
const transcript = join(projectDir, `${uuid}.jsonl`);
const bgUuid = 'bbbbbbbb-1111-4222-8333-bbbbbbbbbbbb';
const bgTranscript = join(projectDir, `${bgUuid}.jsonl`);
const forkAUuid = 'cccccccc-1111-4222-8333-aaaaaaaaaaaa';
const forkBUuid = 'dddddddd-1111-4222-8333-aaaaaaaaaaaa';
const forkA = join(projectDir, `${forkAUuid}.jsonl`);
const forkB = join(projectDir, `${forkBUuid}.jsonl`);
const firstUserUuid = 'shared-first-user-uuid';
const wrapperUuid = 'eeeeeeee-1111-4222-8333-aaaaaaaaaaaa';
const wrapperTranscript = join(wrapperProjectDir, `${wrapperUuid}.jsonl`);
const oldTs = Date.parse('2026-07-01T10:59:00.000Z');
// REAL wall clock, not a literal: the background-pending window (30 min) and the freshness gate are
// measured against Date.now() inside the adapter — a hard-coded "now" made these checks rot within
// minutes of being written (passed for the author, failed on re-run).
const now = Date.now();
writeFileSync(
  transcript,
  [
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-07-01T10:58:00.000Z', cwd, message: { content: 'Campus simulator plan' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-07-01T10:59:00.000Z', message: { model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: 'Plan saved.' }] } }),
    JSON.stringify({ type: 'permission-mode', permissionMode: 'default' }),
    JSON.stringify({ type: 'bridge-session', bridgeSessionId: 'sidecar-touch-without-conversation' }),
  ].join('\n') + '\n',
);
utimesSync(transcript, new Date(now), new Date(now));

writeFileSync(
  bgTranscript,
  [
    JSON.stringify({ type: 'user', uuid: 'bgu1', timestamp: new Date(now - 6 * 60_000).toISOString(), cwd, message: { content: 'Spawn background worker' } }),
    JSON.stringify({ type: 'assistant', uuid: 'bga1', timestamp: new Date(now - 5 * 60_000).toISOString(), message: { model: 'claude-haiku-4-5-20251001', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Task', input: { description: 'sleep', run_in_background: true } }] } }),
    JSON.stringify({ type: 'user', uuid: 'bgu2', timestamp: new Date(now - 5 * 60_000 + 1000).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'Async agent launched successfully.' }] } }),
  ].join('\n') + '\n',
);
utimesSync(bgTranscript, new Date(now), new Date(now));

for (const file of [forkA, forkB]) {
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'mode', mode: 'build' }),
      JSON.stringify({ type: 'queue-operation', operation: 'noop' }),
      JSON.stringify({ type: 'user', uuid: firstUserUuid, timestamp: '2026-07-02T10:00:00.000Z', cwd, message: { content: 'Lineage source prompt' } }),
      JSON.stringify({ type: 'assistant', uuid: 'lineage-assistant', timestamp: '2026-07-02T10:01:00.000Z', message: { model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: 'ok' }] } }),
    ].join('\n') + '\n',
  );
}

writeFileSync(
  wrapperTranscript,
  [
    JSON.stringify({ type: 'user', uuid: 'wrapper-user', timestamp: '2026-07-04T12:00:00.000Z', cwd, message: { content: 'Wrapper prompt' } }),
    JSON.stringify({ type: 'assistant', uuid: 'wrapper-a1', timestamp: '2026-07-04T12:01:00.000Z', message: { model: 'wrapper-base-model', content: [{ type: 'text', text: 'base' }] } }),
    JSON.stringify({ type: 'assistant', uuid: 'wrapper-a2', timestamp: '2026-07-04T12:02:00.000Z', message: { model: 'wrapper-tail-model', content: [{ type: 'text', text: 'tail' }] } }),
  ].join('\n') + '\n',
);

const fakeWrapper = join(wrapperBinDir, 'claude-testwrap');
writeFileSync(
  fakeWrapper,
  `#!/usr/bin/env bash
export CLAUDE_CONFIG_DIR="${wrapperConfigDir}"
export ANTHROPIC_MODEL="wrapper-base-model"
if [ "$1" = "agents" ] && [ "$2" = "--json" ]; then
  printf '%s\n' '[]'
  exit 0
fi
exec claude "$@"
`,
);
chmodSync(fakeWrapper, 0o755);

const fakeClaude = join(ROOT, 'fake-claude');
writeFileSync(
  fakeClaude,
  `#!/usr/bin/env bash
if [ "$1" = "agents" ] && [ "$2" = "--json" ]; then
  printf '%s\n' '[{"sessionId":"${uuid}","status":"busy"}]'
  exit 0
fi
exit 0
`,
);
chmodSync(fakeClaude, 0o755);

process.env.CLAUDE_CONFIG_DIR = configDir;
process.env.COSYNCING_CLAUDE_BIN = fakeClaude;
process.env.COSYNCING_CLAUDE_WRAPPER_DIR = wrapperBinDir;

const { ClaudeAdapter } = await import('../src/index.ts');
const adapter = new ClaudeAdapter();
const rows = await adapter.discoverSessions();
const id = Buffer.from(transcript).toString('base64url');
const bgId = Buffer.from(bgTranscript).toString('base64url');
const forkAId = Buffer.from(forkA).toString('base64url');
const forkBId = Buffer.from(forkB).toString('base64url');
const wrapperId = Buffer.from(wrapperTranscript).toString('base64url');
const row = rows.find((s: any) => s.id === id);
const bgRow = rows.find((s: any) => s.id === bgId);
const forkARow = rows.find((s: any) => s.id === forkAId);
const forkBRow = rows.find((s: any) => s.id === forkBId);

check('fixture row discovered', !!row, `rows=${rows.length}`);
check('discoverSessions updatedAt uses last timestamped conversation line, not fresh mtime', !!row && Math.abs((row.updatedAt ?? 0) - oldTs) <= 1000, `updatedAt=${row?.updatedAt} expected=${oldTs}`);
check('fresh sidecar mtime does not keep raw busy row working', row?.status === 'idle', `status=${row?.status}`);
check('recent unnotified background task keeps roster row working even without agents-json busy', bgRow?.status === 'working', `status=${bgRow?.status}`);
check('fork fixtures carry the same first-user lineageId', forkARow?.lineageId === firstUserUuid && forkBRow?.lineageId === firstUserUuid, JSON.stringify([forkARow?.lineageId, forkBRow?.lineageId]));
const wrapperConn = await adapter.attach(wrapperId, 'observe') as any;
check('wrapper attach currentModel uses transcript tail model over wrapper default', wrapperConn.info.currentModel?.modelID === 'wrapper-tail-model', JSON.stringify(wrapperConn.info.currentModel));
await wrapperConn.close();

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
