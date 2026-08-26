/**
 * Claude ROSTER SUBAGENTS — depth-2 discovery of `<slug>/<uuid>/subagents/agent-*.jsonl` as
 * observe-only child rows (plan item 1).
 *
 * The generic parent/child machinery already works for codex, dsh and OpenCode: a child carries
 * `origin:'subagent'` + `parentThreadId` = the parent's PUBLISHED `nativeId`, and the client joins on
 * `(machine, tool, nativeId)`. Claude published no child row at all, so there was nothing to nest.
 *
 * What this fixture pins:
 *   1. lineage — parent nativeId (bridge id when it has one, else `claude-session:<uuid>`), child
 *      `origin`/`parentThreadId`/`nativeId`, and NO native identity invented for a childless parent.
 *   2. selection — only parent-spawned `subagents/agent-*.meta.json` with a `toolUseId` become rows;
 *      workflow-owned metas, meta-less transcripts and the nested `subagents/workflows/<run>/` agents
 *      stay out (they are summarized inside their workflow's activity card), and no subagent file is
 *      ever mistaken for a top-level session.
 *   3. containment — a child id is base64url of its own path, so `attach`'s realpath containment
 *      admits it unchanged, and a path outside every projects root is still refused.
 *   4. observe-only — a child advertises no Drive and no take-over, offers no terminal command that
 *      cannot work, and a driving attach on a child is refused before any process path.
 *   5. budget — a parent OUTSIDE the discovery cutoff contributes no child rows.
 *
 *   bun run packages/typescript/adapters/claude/test/test-claude-roster-subagents.ts   (exit 0 = pass)
 */
export {};
import { chmodSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const enc = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const dec = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');

// ── fixture store ───────────────────────────────────────────────────────────────────────────────
const ROOT = join(tmpdir(), 'ca-claude-roster-subagents');
rmSync(ROOT, { recursive: true, force: true });
const configDir = join(ROOT, 'claude');
const slugDir = join(configDir, 'projects', '-tmp-ca-subagents');
const cwd = join(ROOT, 'workspace');
const binDir = join(ROOT, 'bin'); // deliberately empty: no wrapper stores in this fixture
mkdirSync(slugDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
mkdirSync(binDir, { recursive: true });

const parentUuid = 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa'; // has children, no bridge identity
const bridgeUuid = 'bbbbbbbb-1111-4222-8333-bbbbbbbbbbbb'; // has children AND a bridge identity
const plainUuid = 'cccccccc-1111-4222-8333-cccccccccccc'; // no subagent tree at all
const coldUuid = 'dddddddd-1111-4222-8333-dddddddddddd'; // has children but sits outside the cutoff

const transcriptOf = (uuid: string): string => join(slugDir, `${uuid}.jsonl`);
const subDirOf = (uuid: string): string => join(slugDir, uuid, 'subagents');

function writeSession(uuid: string, prompt: string): void {
  writeFileSync(
    transcriptOf(uuid),
    [
      JSON.stringify({ type: 'user', uuid: `${uuid}-u1`, timestamp: '2026-08-20T10:00:00.000Z', cwd, message: { content: prompt } }),
      JSON.stringify({
        type: 'assistant',
        uuid: `${uuid}-a1`,
        timestamp: '2026-08-20T10:01:00.000Z',
        message: { model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
      }),
    ].join('\n') + '\n',
  );
}

/** One subagent pair under `<uuid>/subagents` (or a nested workflow run dir). */
function writeSubagent(dir: string, agent: string, meta: Record<string, unknown> | null, text: string): string {
  mkdirSync(dir, { recursive: true });
  if (meta) writeFileSync(join(dir, `${agent}.meta.json`), JSON.stringify(meta));
  const path = join(dir, `${agent}.jsonl`);
  writeFileSync(
    path,
    [
      JSON.stringify({ type: 'user', uuid: `${agent}-u1`, timestamp: '2026-08-20T10:00:10.000Z', cwd, message: { content: `run ${agent}` } }),
      JSON.stringify({
        type: 'assistant',
        uuid: `${agent}-a1`,
        timestamp: '2026-08-20T10:00:20.000Z',
        message: { model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
      }),
    ].join('\n') + '\n',
  );
  return path;
}

writeSession(parentUuid, 'Roster subagent parent');
writeSession(plainUuid, 'Childless session');
writeSession(coldUuid, 'Cold parent with children');
writeFileSync(
  transcriptOf(bridgeUuid),
  [
    JSON.stringify({ type: 'user', uuid: 'bridge-u1', timestamp: '2026-08-20T10:00:00.000Z', cwd, message: { content: 'Bridged parent' } }),
    JSON.stringify({ type: 'bridge-session', bridgeSessionId: 'cse_bridgefixture' }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'bridge-a1',
      timestamp: '2026-08-20T10:01:00.000Z',
      message: { model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
    }),
  ].join('\n') + '\n',
);

const alphaPath = writeSubagent(subDirOf(parentUuid), 'agent-alpha', { agentType: 'general-purpose', description: 'Audit the roster join', toolUseId: 'toolu_alpha' }, 'alpha finished');
const betaPath = writeSubagent(subDirOf(parentUuid), 'agent-beta', { agentType: 'code-reviewer', toolUseId: 'toolu_beta' }, 'beta finished');
// Workflow-owned meta (no toolUseId) — summarized inside its workflow card, never a standalone row.
const wfOwnedPath = writeSubagent(subDirOf(parentUuid), 'agent-wfowned', { agentType: 'workflow-subagent' }, 'workflow leg');
// A transcript with NO meta sidecar at all.
const noMetaPath = writeSubagent(subDirOf(parentUuid), 'agent-nometa', null, 'orphan leg');
// Depth-3: the nested live-workflow tree. Recognized by the path parser, never published as a row.
const nestedPath = writeSubagent(join(subDirOf(parentUuid), 'workflows', 'wf_run1'), 'agent-nested', { agentType: 'general-purpose', toolUseId: 'toolu_nested' }, 'nested leg');
const bridgeKidPath = writeSubagent(subDirOf(bridgeUuid), 'agent-bridgekid', { description: 'Bridge child', toolUseId: 'toolu_bk' }, 'bridge kid finished');
const coldKidPath = writeSubagent(subDirOf(coldUuid), 'agent-cold', { description: 'Cold child', toolUseId: 'toolu_cold' }, 'cold kid finished');

// Recency: everything fresh except the cold parent (and its child), which sits 3h back.
const now = Date.now();
const old = new Date(now - 3 * 60 * 60_000);
for (const p of [transcriptOf(parentUuid), transcriptOf(bridgeUuid), transcriptOf(plainUuid), alphaPath, betaPath, wfOwnedPath, noMetaPath, nestedPath, bridgeKidPath]) {
  utimesSync(p, new Date(now), new Date(now));
}
utimesSync(transcriptOf(coldUuid), old, old);
utimesSync(coldKidPath, old, old);

// A fake `claude agents --json` reporting NO live rows: every parent is idle, so the fixture is
// clock-independent (the working case is unit-checked against claudeSubagentStatus below).
const fakeClaude = join(ROOT, 'fake-claude');
writeFileSync(
  fakeClaude,
  `#!/usr/bin/env bash
if [ "$1" = "agents" ] && [ "$2" = "--json" ]; then
  printf '%s\\n' '[]'
  exit 0
fi
exit 0
`,
);
chmodSync(fakeClaude, 0o755);

process.env.CLAUDE_CONFIG_DIR = configDir;
process.env.COSYNCING_CLAUDE_BIN = fakeClaude;
process.env.COSYNCING_CLAUDE_WRAPPER_DIR = binDir;

const {
  ClaudeAdapter,
  CLAUDE_SUBAGENT_OWNED_REASON,
  claudeSessionNativeId,
  claudeSubagentNativeId,
  claudeSubagentPathInfo,
  claudeSubagentStatus,
  claudeSubagentTranscripts,
} = await import('../src/index.ts');

const adapter = new ClaudeAdapter();
const rows = (await adapter.discoverSessions()) as any[];
const byId = new Map<string, any>(rows.map((r) => [r.id, r]));
const parentRow = byId.get(enc(transcriptOf(parentUuid)));
const bridgeRow = byId.get(enc(transcriptOf(bridgeUuid)));
const plainRow = byId.get(enc(transcriptOf(plainUuid)));
const alphaRow = byId.get(enc(alphaPath));
const betaRow = byId.get(enc(betaPath));
const bridgeKidRow = byId.get(enc(bridgeKidPath));

// ── 1. lineage ──────────────────────────────────────────────────────────────────────────────────
check('parent transcript is still a normal session row', !!parentRow && parentRow.origin === undefined, `rows=${rows.length}`);
check(
  'a parent WITH children and no bridge identity publishes claude-session:<uuid>',
  parentRow?.nativeId === claudeSessionNativeId(parentUuid),
  String(parentRow?.nativeId),
);
check(
  'a parent with NO subagent tree still publishes no nativeId (none invented store-wide)',
  !!plainRow && plainRow.nativeId === undefined,
  String(plainRow?.nativeId),
);
check(
  "a parent's real bridge identity is never overwritten by the lineage fallback",
  bridgeRow?.nativeId === 'claude-bridge:bridgefixture',
  String(bridgeRow?.nativeId),
);
check('both parent-spawned subagents become rows', !!alphaRow && !!betaRow, `alpha=${!!alphaRow} beta=${!!betaRow}`);
check('child rows carry origin subagent', alphaRow?.origin === 'subagent' && betaRow?.origin === 'subagent', `${alphaRow?.origin}/${betaRow?.origin}`);
check(
  "child parentThreadId equals the parent's PUBLISHED nativeId",
  alphaRow?.parentThreadId === parentRow?.nativeId && betaRow?.parentThreadId === parentRow?.nativeId,
  `${alphaRow?.parentThreadId} vs ${parentRow?.nativeId}`,
);
check(
  'each child carries its OWN nativeId, scoped by the parent uuid (dsh regression)',
  alphaRow?.nativeId === claudeSubagentNativeId(parentUuid, 'agent-alpha') && betaRow?.nativeId === claudeSubagentNativeId(parentUuid, 'agent-beta'),
  `${alphaRow?.nativeId} / ${betaRow?.nativeId}`,
);
check(
  'child and parent native namespaces can never collide',
  alphaRow?.nativeId !== parentRow?.nativeId && !String(alphaRow?.nativeId).startsWith('claude-session:'),
  String(alphaRow?.nativeId),
);
check(
  'a bridged parent lineages its child by the bridge id, not the uuid',
  bridgeKidRow?.parentThreadId === 'claude-bridge:bridgefixture',
  String(bridgeKidRow?.parentThreadId),
);
check('child title prefers the spawn description', alphaRow?.title === 'Audit the roster join', String(alphaRow?.title));
check('child title falls back to the agent type', betaRow?.title === 'code-reviewer', String(betaRow?.title));
check('child inherits the parent workspace', alphaRow?.cwd === cwd, String(alphaRow?.cwd));
check(
  'cold roster child carries the model from its own transcript without requiring attach',
  alphaRow?.model === 'claude-haiku-4-5-20251001'
    && alphaRow?.currentModel?.providerID === 'anthropic'
    && alphaRow?.currentModel?.modelID === 'claude-haiku-4-5-20251001',
  JSON.stringify({ model: alphaRow?.model, currentModel: alphaRow?.currentModel }),
);
check('child rows are idle while the parent has no turn in flight', alphaRow?.status === 'idle', String(alphaRow?.status));

// ── 2. selection ────────────────────────────────────────────────────────────────────────────────
check('a workflow-owned meta (no toolUseId) publishes no row', !byId.has(enc(wfOwnedPath)));
check('a subagent transcript with no meta sidecar publishes no row', !byId.has(enc(noMetaPath)));
check('nested subagents/workflows/<run>/ agents publish no row', !byId.has(enc(nestedPath)));
check(
  'no subagent file is ever published as a top-level session row',
  rows.every((r) => r.origin === 'subagent' || !dec(r.id).includes(`${'/subagents/'}`)),
  rows.filter((r) => r.origin !== 'subagent' && dec(r.id).includes('/subagents/')).map((r) => dec(r.id)).join(','),
);
check(
  'claudeSubagentTranscripts returns exactly the parent-spawned pairs',
  claudeSubagentTranscripts(transcriptOf(parentUuid)).map((t) => t.agent).sort().join(',') === 'agent-alpha,agent-beta',
  claudeSubagentTranscripts(transcriptOf(parentUuid)).map((t) => t.agent).join(','),
);
check('claudeSubagentTranscripts on a childless session costs one failed readdir and returns []', claudeSubagentTranscripts(transcriptOf(plainUuid)).length === 0);

// ── 3. observe-only control ─────────────────────────────────────────────────────────────────────
check('child Drive is unavailable and unsupported', alphaRow?.control?.drive?.state === 'unavailable' && alphaRow?.control?.drive?.supported === false, JSON.stringify(alphaRow?.control?.drive));
check('child Drive names the ownership reason', alphaRow?.control?.drive?.reason === CLAUDE_SUBAGENT_OWNED_REASON, String(alphaRow?.control?.drive?.reason));
check(
  'child terminal sync is unsupported and inactive',
  alphaRow?.control?.terminalSync?.supported === false && alphaRow?.control?.terminalSync?.syncAvailable === false && alphaRow?.control?.terminalSync?.active === false,
  JSON.stringify(alphaRow?.control?.terminalSync),
);
check(
  'child offers NO terminal command (claude --resume agent-<id> is not a conversation)',
  alphaRow?.control?.terminalSync?.command === undefined && alphaRow?.control?.terminalSync?.label === undefined,
  JSON.stringify(alphaRow?.control?.terminalSync),
);
check('child attachMode is observe', alphaRow?.attachMode === 'observe', String(alphaRow?.attachMode));

// ── 4. budget: a parent outside the cutoff is never walked ──────────────────────────────────────
const windowed = (await adapter.discoverSessions({ updatedAfter: now - 60 * 60_000 })) as any[];
const windowedIds = new Set(windowed.map((r) => r.id));
check('cold parent is excluded by the cutoff', !windowedIds.has(enc(transcriptOf(coldUuid))), `rows=${windowed.length}`);
check('a parent outside the cutoff contributes NO child rows (its tree is never walked)', !windowedIds.has(enc(coldKidPath)));
check('a parent inside the cutoff still contributes its children', windowedIds.has(enc(alphaPath)) && windowedIds.has(enc(betaPath)));

// ── 5. containment + attach ─────────────────────────────────────────────────────────────────────
const childConn = (await adapter.attach(alphaRow.id, 'observe')) as any;
check('a child id survives attach realpath containment', !!childConn);
check(
  'attached child reproduces the lineage pair from its path alone',
  childConn.info.origin === 'subagent'
    && childConn.info.nativeId === claudeSubagentNativeId(parentUuid, 'agent-alpha')
    && childConn.info.parentThreadId === parentRow?.nativeId,
  JSON.stringify([childConn.info.origin, childConn.info.nativeId, childConn.info.parentThreadId]),
);
check('attached child keeps the roster title', childConn.info.title === 'Audit the roster join', String(childConn.info.title));
check(
  'attached child keeps the same model identity as its cold roster row',
  childConn.info.model === alphaRow.model
    && childConn.info.currentModel?.providerID === alphaRow.currentModel?.providerID
    && childConn.info.currentModel?.modelID === alphaRow.currentModel?.modelID,
  JSON.stringify({ roster: alphaRow.currentModel, attached: childConn.info.currentModel }),
);
check('attached child control is observe-only', childConn.info.control?.drive?.supported === false && childConn.info.control?.terminalSync?.supported === false, JSON.stringify(childConn.info.control?.drive));
const history = (await childConn.getHistory()) as any[];
check(
  'the child connection replays the CHILD transcript, not the parent',
  JSON.stringify(history).includes('alpha finished') && !JSON.stringify(history).includes('Roster subagent parent'),
  `frames=${history.length}`,
);
await childConn.close();

let resumeErr = '';
try {
  await adapter.attach(alphaRow.id, 'resume');
} catch (e) {
  resumeErr = String((e as Error).message ?? e);
}
check('a driving attach on a child is refused', resumeErr.includes('Observe-only') && resumeErr.includes(CLAUDE_SUBAGENT_OWNED_REASON), resumeErr);

let outsideErr = '';
try {
  await adapter.attach(enc('/etc/passwd'), 'observe');
} catch (e) {
  outsideErr = String((e as Error).message ?? e);
}
check('containment still refuses a path outside every projects root', outsideErr.includes('outside the known projects roots'), outsideErr);

// ── 6. path parser + status rule ────────────────────────────────────────────────────────────────
const alphaInfo = claudeSubagentPathInfo(alphaPath);
check(
  'claudeSubagentPathInfo parses a direct subagent path back to its parent',
  alphaInfo?.parentUuid === parentUuid && alphaInfo?.agent === 'agent-alpha' && alphaInfo?.parentTranscript === transcriptOf(parentUuid),
  JSON.stringify(alphaInfo),
);
const nestedInfo = claudeSubagentPathInfo(nestedPath);
check(
  'claudeSubagentPathInfo also recognizes the nested workflow form (so a crafted id lands observe-only)',
  nestedInfo?.parentUuid === parentUuid && nestedInfo?.agent === 'agent-nested' && nestedInfo?.workflowRun === 'wf_run1',
  JSON.stringify(nestedInfo),
);
check('claudeSubagentPathInfo returns undefined for a normal session transcript', claudeSubagentPathInfo(transcriptOf(parentUuid)) === undefined);
check('claudeSubagentStatus: parent working + fresh child → working', claudeSubagentStatus('working', now - 1_000, now) === 'working');
check('claudeSubagentStatus: parent working + stale child → idle', claudeSubagentStatus('working', now - 10 * 60_000, now) === 'idle');
check('claudeSubagentStatus: parent idle → idle whatever the child mtime', claudeSubagentStatus('idle', now, now) === 'idle');
check('claudeSubagentStatus: no parent evidence → idle', claudeSubagentStatus(undefined, now, now) === 'idle');

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
