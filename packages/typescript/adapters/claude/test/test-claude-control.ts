/**
 * Claude session-control-state tests (Observe+Drive vs True-Sync).
 *
 * Contract: docs/architecture/client-ui.md Verifies the Claude adapter reports explicit
 * `SessionInfo.control` and the cost-safety guards, all OFFLINE — no claude binary, NO model cost:
 *   - bridgedUuids(): Anthropic remote-control collision detection (sessions/*.json + bridgeSessionId +
 *     /proc liveness), keyed by sessionId.
 *   - claudeControl(): drive observing / driving / unavailable(collision|cwd-gone); terminalSync honest
 *     supported:false with the future --channels setup command.
 *   - resumeArgs(): never --bare, never --fork-session (issue 15a: demote, never fork).
 *   - resumeEnv(): default store scrubs ANTHROPIC_API_KEY/AUTH_TOKEN; wrappers keep them.
 *
 *   bun run packages/typescript/adapters/claude/test/test-claude-control.ts      (exit 0 = all pass)
 */
export {};
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridgedUuids, claudeControl, eligibleForChannels, resumeArgs, resumeEnv, readLatestModel, claudeModelOptions, CLAUDE_MAX_MODEL_OPTIONS, CLAUDE_PERMISSION_MODES, ClaudeAdapter, modelAlias, resolveWrapperModels, liveTerminalOwner } from '../src/index.ts';
import type { ClaudeStore } from '../src/index.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const isLinux = process.platform === 'linux';

// ── fixtures ───────────────────────────────────────────────────────────────────
const ROOT = join(tmpdir(), 'ca-claude-control');
rmSync(ROOT, { recursive: true, force: true });

const defaultDir = join(ROOT, 'default');
const wrapperDir = join(ROOT, 'wrapper');
const existingCwd = join(ROOT, 'workspace');
mkdirSync(join(defaultDir, 'sessions'), { recursive: true });
mkdirSync(existingCwd, { recursive: true });

const defaultStore: ClaudeStore = {
  configDir: defaultDir,
  projectsRoot: join(defaultDir, 'projects'),
  bin: 'claude',
  isDefault: true,
};
const wrapperStore: ClaudeStore = {
  configDir: wrapperDir,
  projectsRoot: join(wrapperDir, 'projects'),
  bin: '/home/tester/bin/claude-open',
  model: 'qwen3.6-27B-FP8',
  baseUrl: 'http://127.0.0.1:18000',
  isDefault: false,
};

const U_BRIDGED = '11111111-1111-1111-1111-111111111111';
const U_DEAD = '22222222-2222-2222-2222-222222222222';
const U_PLAIN = '33333333-3333-3333-3333-333333333333';
const U_LOCALCLI = '44444444-4444-4444-4444-444444444444';
const U_REMOTE = '55555555-5555-5555-5555-555555555555';

// A bridged pid-file whose pid is THIS live process → remote-control collision (alive).
writeFileSync(
  join(defaultDir, 'sessions', '1001.json'),
  JSON.stringify({ sessionId: U_BRIDGED, bridgeSessionId: 'session_01TEST', pid: process.pid, cwd: existingCwd }),
);
// A bridged pid-file whose pid is dead → liveness guard must DROP it (Linux only).
writeFileSync(
  join(defaultDir, 'sessions', '1002.json'),
  JSON.stringify({ sessionId: U_DEAD, bridgeSessionId: 'session_STALE', pid: 999_000_111 }),
);
// A plain (non-bridged) pid-file → never a collision.
writeFileSync(join(defaultDir, 'sessions', '1003.json'), JSON.stringify({ sessionId: U_PLAIN, pid: process.pid }));
// A LOCAL interactive CLI session that (on Claude ≥2.1.x) ALSO carries a bridgeSessionId — it is a
// normal drivable terminal session, NOT remote-controlled, so it must NOT be flagged. (Regression for
// the bug where subscription Drive showed 'unavailable' while third-party wrappers were fine.)
writeFileSync(
  join(defaultDir, 'sessions', '1004.json'),
  JSON.stringify({ sessionId: U_LOCALCLI, bridgeSessionId: 'session_01LOCAL', pid: process.pid, kind: 'interactive', entrypoint: 'cli', cwd: existingCwd }),
);
// A genuinely remote-controlled session (NOT a local cli launch) → still flagged, even alive.
writeFileSync(
  join(defaultDir, 'sessions', '1005.json'),
  JSON.stringify({ sessionId: U_REMOTE, bridgeSessionId: 'session_01REMOTE', pid: process.pid, kind: 'interactive', entrypoint: 'remote-control', cwd: existingCwd }),
);
// A malformed file → skipped without throwing.
writeFileSync(join(defaultDir, 'sessions', 'broken.json'), '{ not json');

// ── bridgedUuids ─────────────────────────────────────────────────────────────
const bridged = bridgedUuids(defaultStore);
check('bridgedUuids: live bridged session detected', bridged.has(U_BRIDGED));
check('bridgedUuids: non-bridged session NOT flagged', !bridged.has(U_PLAIN));
check('bridgedUuids: local interactive CLI session w/ bridgeSessionId NOT flagged (subscription Drive bug)', !bridged.has(U_LOCALCLI));
check('bridgedUuids: genuine remote-control entrypoint STILL flagged', bridged.has(U_REMOTE));
if (isLinux) {
  check('bridgedUuids: stale/dead bridged pid dropped (liveness guard)', !bridged.has(U_DEAD));
} else {
  check('bridgedUuids: non-Linux blocks bridged conservatively', bridged.has(U_DEAD));
}
check('bridgedUuids: missing sessions dir → empty set', bridgedUuids(wrapperStore).size === 0);

// ── liveTerminalOwner: takeover-refusal / demote trigger ─────────────────────
check('liveTerminalOwner: live pid owning uuid detected', liveTerminalOwner(defaultStore, U_PLAIN) === process.pid);
check('liveTerminalOwner: dead pid ignored', liveTerminalOwner(defaultStore, U_DEAD) === null);
check('liveTerminalOwner: missing sessions dir → null', liveTerminalOwner(wrapperStore, U_PLAIN) === null);

// ── claudeControl: drive states ────────────────────────────────────────────────
const observing = claudeControl({ store: defaultStore, uuid: U_PLAIN, cwd: existingCwd, bridged: false, channelsEligible: true });
check('drive: normal default session → observing+supported', observing.drive.state === 'observing' && observing.drive.supported === true);
// U_PLAIN has a LIVE terminal owner (pid-file 1003) → the issue-15a design (demote, never fork) must
// warn BEFORE driving that a terminal write ends the drive — the replaced willFork signal, now copy only.
check('drive: live-owned session → terminal-attached warning reason (no willFork)', /terminal is attached/i.test(observing.drive.reason || '') && /stop driving/i.test(observing.drive.reason || '') && !('willFork' in observing.drive));
const U_FREE = '77777777-7777-7777-7777-777777777777'; // no pid-file → unowned
const freeObserving = claudeControl({ store: defaultStore, uuid: U_FREE, cwd: existingCwd, bridged: false, channelsEligible: true });
check('drive: UNOWNED default session reason mentions subscription (no terminal warning)', /subscription/i.test(freeObserving.drive.reason || '') && !/terminal is attached/i.test(freeObserving.drive.reason || ''));

const wrapObserving = claudeControl({ store: wrapperStore, uuid: U_PLAIN, cwd: existingCwd, bridged: false, channelsEligible: false });
check('drive: wrapper observing reason mentions its endpoint/model', /endpoint|qwen/i.test(wrapObserving.drive.reason || ''));

const collided = claudeControl({ store: defaultStore, uuid: U_BRIDGED, cwd: existingCwd, bridged: true, channelsEligible: true });
check('drive: remote-control collision → unavailable+unsupported', collided.drive.state === 'unavailable' && collided.drive.supported === false);
check('drive: collision reason mentions Remote Control', /remote control/i.test(collided.drive.reason || ''));

const cwdGone = claudeControl({ store: defaultStore, uuid: U_PLAIN, cwd: join(ROOT, 'gone'), bridged: false, channelsEligible: true });
check('drive: vanished workspace → unavailable', cwdGone.drive.state === 'unavailable' && /workspace/i.test(cwdGone.drive.reason || ''));

const drivingNow = claudeControl({ store: defaultStore, uuid: U_PLAIN, cwd: existingCwd, bridged: false, driving: true, channelsEligible: true });
check('drive: resume attach → driving+supported', drivingNow.drive.state === 'driving' && drivingNow.drive.supported === true);
// bridged+driving: once we actually own the session the state is driving (collision is gated upstream at the disabled Drive button)
const drivingBridged = claudeControl({ store: defaultStore, uuid: U_BRIDGED, cwd: existingCwd, bridged: true, driving: true, channelsEligible: true });
check('drive: driving overrides collision once we own the session', drivingBridged.drive.state === 'driving');

// ── eligibleForChannels: first-party only — generalized across config sources (adversarially reviewed) ──
{
  // Isolate from ambient env so the eligible:true assertions are deterministic.
  const ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_API_KEY_HELPER'];
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }

  const userSettings = join(defaultDir, 'settings.json');
  rmSync(userSettings, { force: true });
  check('eligible: clean default first-party store → true', eligibleForChannels(defaultStore) === true);
  check('eligible: wrapper (custom base URL) store → false', eligibleForChannels(wrapperStore) === false);

  // cc-switch: an env block in ~/.claude/settings.json points the DEFAULT store at a third-party endpoint
  writeFileSync(userSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'tok' } }));
  check('eligible: cc-switch third-party in user settings.json → false', eligibleForChannels(defaultStore) === false);
  writeFileSync(userSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }));
  check('eligible: cc-switch official anthropic.com → true', eligibleForChannels(defaultStore) === true);
  // top-level apiKeyHelper (outside env) → API mode → ineligible
  writeFileSync(userSettings, JSON.stringify({ apiKeyHelper: '~/bin/get-key.sh' }));
  check('eligible: top-level apiKeyHelper → false', eligibleForChannels(defaultStore) === false);
  // Bedrock/Vertex flag (no base URL) → ineligible
  writeFileSync(userSettings, JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }));
  check('eligible: CLAUDE_CODE_USE_BEDROCK env flag → false', eligibleForChannels(defaultStore) === false);
  // crash-hardening: non-string base URL + malformed JSON must NOT throw
  writeFileSync(userSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 1234 } }));
  check('eligible: non-string base URL → no throw (boolean)', typeof eligibleForChannels(defaultStore) === 'boolean');
  writeFileSync(userSettings, '{ not valid json');
  check('eligible: malformed settings.json → no throw (boolean)', typeof eligibleForChannels(defaultStore) === 'boolean');
  rmSync(userSettings, { force: true });

  // CRITICAL: a project .claude/settings.json (in the session cwd) OUTRANKS user settings
  const projDir = join(ROOT, 'proj-thirdparty');
  mkdirSync(join(projDir, '.claude'), { recursive: true });
  writeFileSync(join(projDir, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://third-party.example/v1' } }));
  check('eligible: clean store + project .claude/settings.json third-party → false', eligibleForChannels(defaultStore, projDir) === false);
  check('eligible: clean store + clean project cwd → true', eligibleForChannels(defaultStore, existingCwd) === true);

  // broker-env signals on the default store (shared shell with the terminal in the common case)
  process.env.ANTHROPIC_API_KEY = 'sk-broker';
  check('eligible: broker-env ANTHROPIC_API_KEY on default store → false', eligibleForChannels(defaultStore) === false);
  delete process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_BASE_URL = 'http://example.invalid';
  check('eligible: broker base-url override → false', eligibleForChannels(defaultStore) === false);
  delete process.env.ANTHROPIC_BASE_URL;

  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

// ── claudeControl: terminalSync — deferred from packaged v1. terminalSync is unsupported; the shipped
//    Claude control contract is Observe + Take over. The answer-only source harness is not product copy.
const ts = observing.terminalSync; // eligible, not synced — but true-sync is archived
// True-sync stays archived (supported/syncAvailable/active all false); terminalSync now carries a
// GENERIC resume-in-terminal command (`claude --resume <uuid>`) so the app needs no tool-name branch.
check('sync(archived, eligible): no true-sync but a generic resume command', ts.supported === false && ts.syncAvailable === false && ts.active === false && /claude --resume /.test(ts.command || ''));
// `claude --resume` is CWD-scoped: from any other directory it fails with "No conversation found",
// so the hint must lead with `cd <workspace> &&` like codex's (issues-part2 re-flag 2026-07-12).
check('sync(archived): resume hint leads with cd <workspace> && (resume is cwd-scoped)', (ts.command || '').startsWith(`cd ${existingCwd} && claude --resume `), ts.command || '');
check('sync(v1, eligible): reason promises only Observe + Take over and does not advertise hooks',
  /Observe \+ Take over/i.test(ts.reason || '') && !/opt-in|hooks|COSYNCING_CLAUDE_HOOKS/i.test(ts.reason || ''));

const wts = wrapObserving.terminalSync; // wrapper = NOT eligible
check('sync(archived, ineligible wrapper): no true-sync but a generic resume command', wts.supported === false && wts.syncAvailable === false && wts.active === false && /claude --resume /.test(wts.command || ''));
check('sync(v1, ineligible wrapper): reason names the wrapper and promises only Observe + Take over',
  /wrapper/i.test(wts.reason || '') && /Observe \+ Take over/i.test(wts.reason || '') &&
    !/opt-in|hooks|COSYNCING_CLAUDE_HOOKS/i.test(wts.reason || ''));

// remote-controlled session → still not synced (and observed-only); reason mentions remote control
check('sync: remote-control → supported:false with reason', collided.terminalSync.supported === false && /remote control/i.test(collided.terminalSync.reason || ''));

// ── resumeArgs: cost-safety + always-in-place resume (issue 15a: demote, never fork) ──
const argsDef = resumeArgs(U_PLAIN, { model: 'opus', mode: 'acceptEdits', isDefault: true });
check('args: NEVER contains --bare (would force API billing)', !argsDef.includes('--bare'));
check('args: NEVER contains --fork-session (takeover resumes in place; a terminal write demotes)', !argsDef.includes('--fork-session'));
check('args: carries --resume <uuid>', argsDef.includes('--resume') && argsDef.includes(U_PLAIN));
check('args: default store passes --model', argsDef.includes('--model') && argsDef.includes('opus'));
check('args: passes --permission-mode', argsDef.includes('--permission-mode') && argsDef.includes('acceptEdits'));
// Without this flag headless -p SILENTLY DENIES gated tools ("This command requires approval") and
// the app never shows a permission popup — the drive control_request handler was dead code
// (issues-part2 13.1c, probed live on 2.1.207). Both resume AND fresh spawns must ask via stdio.
check('args: passes --permission-prompt-tool stdio (drive permissions ASK, never silently deny)', argsDef[argsDef.indexOf('--permission-prompt-tool') + 1] === 'stdio');
check('args(fresh): passes --permission-prompt-tool stdio too', (() => { const a = resumeArgs(U_PLAIN, { isDefault: true, fresh: true }); return a[a.indexOf('--permission-prompt-tool') + 1] === 'stdio'; })());
check('args(fresh): no --fork-session either (nothing to fork; the id is ours)', !resumeArgs(U_PLAIN, { isDefault: true, fresh: true }).includes('--fork-session'));
const argsWrap = resumeArgs(U_PLAIN, { model: 'mimo-v2.5[1m]', effort: 'xhigh', isDefault: false });
check('args: wrapper store PASSES --model (switch among its own backend models, e.g. claude-mi pro↔non-pro)', argsWrap.includes('--model') && argsWrap.includes('mimo-v2.5[1m]'));
check('args: wrapper endpoints DO honor effort → --effort passed (verified live on minimax/mimo)', argsWrap.includes('--effort') && argsWrap.includes('xhigh'));
check('args: wrapper ultracode → --settings {ultracode:true} + --effort xhigh (verified accepted on minimax/mimo)', (() => { const a = resumeArgs(U_PLAIN, { model: 'MiniMax-M3', effort: 'ultracode', isDefault: false }); return a.includes('--settings') && a.some((x) => x.includes('"ultracode":true')) && a[a.indexOf('--effort') + 1] === 'xhigh'; })());

// reasoning effort → --effort (default store only), CLAMPED per model (verified claude 2.1.181 +
// platform.claude.com effort docs: Opus low|medium|high|xhigh|max; Sonnet no xhigh; Haiku none).
const argsEffort = resumeArgs(U_PLAIN, { model: 'opus', effort: 'xhigh', isDefault: true });
check('args: default store passes --effort <level> for a supported model', argsEffort.includes('--effort') && argsEffort.indexOf('xhigh') === argsEffort.indexOf('--effort') + 1);
check('args: --effort CLAMPED — sonnet has no xhigh → flag dropped', !resumeArgs(U_PLAIN, { model: 'sonnet', effort: 'xhigh', isDefault: true }).includes('--effort'));
check('args: --effort CLAMPED — haiku has no effort → flag dropped', !resumeArgs(U_PLAIN, { model: 'haiku', effort: 'max', isDefault: true }).includes('--effort'));
check('args: sonnet still gets --effort max (a level it supports)', resumeArgs(U_PLAIN, { model: 'sonnet', effort: 'max', isDefault: true }).includes('--effort'));
check('args: wrapper store PASSES --effort too (its endpoint supports it; the model decides)', resumeArgs(U_PLAIN, { model: 'MiniMax-M3', effort: 'high', isDefault: false }).includes('--effort'));
check('args: no effort selected → NO --effort (claude uses its own default)', !resumeArgs(U_PLAIN, { model: 'opus', isDefault: true }).includes('--effort'));

// ── model + permission-mode + effort option catalogs (the app's pickers; gaps maintainer flagged) ──
// DYNAMIC discovery: the curated catalog is filtered by per-account gating, and efforts are PER-MODEL.
const models = claudeModelOptions(defaultStore); // temp configDir, no gating file → fail-open (all selectable)
const ids = models.map((m) => m.modelID);
check('models: ungated default store offers opus/sonnet/haiku + fable', ['opus', 'sonnet', 'haiku', 'fable'].every((x) => ids.includes(x)), ids.join(','));
const opus = models.find((m) => m.modelID === 'opus');
check('models: opus carries the full effort ladder (low..max incl xhigh) + default high', !!opus?.reasoningEfforts && ['low', 'medium', 'high', 'xhigh', 'max'].every((e) => opus!.reasoningEfforts!.some((r) => r.effort === e)) && opus?.defaultReasoningEffort === 'high');
check('models: alias labels stay version-neutral until a concrete id is observed', models.every((m) => !/claude-|\d/.test(m.label)), models.map((m) => m.label).join(' | '));
check(
  'models: curated aliases are unique (no duplicate entry claiming a newer version)',
  new Set(ids).size === ids.length,
  ids.join(','),
);
const sonnet = models.find((m) => m.modelID === 'sonnet');
check('models: sonnet has max but NOT xhigh (per-model effort auto-infer)', !!sonnet?.reasoningEfforts && sonnet!.reasoningEfforts!.some((r) => r.effort === 'max') && !sonnet!.reasoningEfforts!.some((r) => r.effort === 'xhigh'));
const haiku = models.find((m) => m.modelID === 'haiku');
check('models: haiku exposes NO effort levels (auto-infer)', !haiku?.reasoningEfforts || haiku!.reasoningEfforts!.length === 0);

// Per-account gating: a .claude.json with a GrowthBook block auto-excludes that model (this is how Fable
// disappears for an account without access — no hardcoding). Mirror the real cache shape exactly.
const gatedDir = join(ROOT, 'gated');
mkdirSync(gatedDir, { recursive: true });
writeFileSync(join(gatedDir, '.claude.json'), JSON.stringify({ cachedGrowthBookFeatures: { 'tengu-model-error-overrides': { 'claude-fable-5': { block: 'Claude Fable 5 is currently unavailable.' } } } }));
const gatedStore: ClaudeStore = { configDir: gatedDir, projectsRoot: join(gatedDir, 'projects'), bin: 'claude', isDefault: true };
const gatedIds = claudeModelOptions(gatedStore).map((m) => m.modelID);
check('models: gated model auto-excluded (fable blocked via tengu-model-error-overrides)', !gatedIds.includes('fable') && ['opus', 'sonnet', 'haiku'].every((x) => gatedIds.includes(x)), gatedIds.join(','));

const wrapModels = claudeModelOptions(wrapperStore);
check('models: wrapper store offers its model WITH the effort ladder incl ultracode (endpoints support it)', wrapModels.length === 1 && (wrapModels[0]?.reasoningEfforts ?? []).some((r) => r.effort === 'ultracode'));
const modeVals = CLAUDE_PERMISSION_MODES.map((m) => m.value);
check('modes: full claude set incl. auto + dontAsk (maintainer: "accept edit / auto mode")', ['default', 'acceptEdits', 'auto', 'dontAsk', 'plan', 'bypassPermissions'].every((v) => modeVals.includes(v)), modeVals.join(','));
const cats = new Set(CLAUDE_PERMISSION_MODES.map((m) => m.category));
check('modes: map onto universal categories (ask-permission/approve-for-me/full-access/custom)', cats.has('ask-permission') && cats.has('approve-for-me') && cats.has('full-access') && cats.has('custom'));

// ── gating is GENERALIZABLE (not fable-specific): any account-gated model drops; ungated ones appear ──
const mkGatedStore = (label: string, blockIds: string[]): ClaudeStore => {
  const dir = join(ROOT, 'gate-' + label);
  mkdirSync(dir, { recursive: true });
  const ov: Record<string, { block: string }> = {};
  for (const id of blockIds) ov[id] = { block: `${id} is currently unavailable.` };
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ cachedGrowthBookFeatures: { 'tengu-model-error-overrides': ov } }));
  return { configDir: dir, projectsRoot: join(dir, 'projects'), bin: 'claude', isDefault: true };
};
const gateOpusIds = claudeModelOptions(mkGatedStore('opus', ['claude-opus-4-8'])).map((m) => m.modelID);
check('gating(generic): gating OPUS drops opus, keeps the rest (proves not fable-specific)', !gateOpusIds.includes('opus') && ['sonnet', 'haiku', 'fable'].every((x) => gateOpusIds.includes(x)), gateOpusIds.join(','));
const gateMixedIds = claudeModelOptions(mkGatedStore('mixed', ['claude-Opus-4-8'])).map((m) => m.modelID);
check('gating(generic): mixed-CASE gate id still drops the model (modelAlias case-normalized)', !gateMixedIds.includes('opus'), gateMixedIds.join(','));
const gateAll = claudeModelOptions(mkGatedStore('all', ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-fable-5']));
check('gating(generic): ALL models gated → empty picker, no throw (app shows locked current model)', Array.isArray(gateAll) && gateAll.length === 0);
check('gating(generic): empty block string does NOT gate (only a real block message)', claudeModelOptions(mkGatedStore('emptyblock', [])).length === claudeModelOptions(defaultStore).length);

// modelAlias is case-insensitive + future-proof, and passes unknown ids through (wrapper/new tiers).
check('modelAlias: case-insensitive + version-agnostic', modelAlias('claude-Opus-4-8') === 'opus' && modelAlias('CLAUDE-FABLE-5') === 'fable' && modelAlias('claude-opus-5-0') === 'opus');
check('modelAlias: unknown id passes through unchanged', modelAlias('MiniMax-M3') === 'MiniMax-M3' && modelAlias(undefined) === undefined);
check('modelAlias: wrapper name CONTAINING a tier word does NOT collide (anchored to the anthropic scheme)', modelAlias('my-sonnet-fork') === 'my-sonnet-fork' && modelAlias('minimax-opus-pro') === 'minimax-opus-pro' && modelAlias('mimo-v2.5-pro[1m]') === 'mimo-v2.5-pro[1m]');

// ── ULTRACODE in the effort selector (xhigh-capable models only) ──
const opusEfforts = (models.find((m) => m.modelID === 'opus')?.reasoningEfforts ?? []).map((r) => r.effort);
const fableEfforts = (models.find((m) => m.modelID === 'fable')?.reasoningEfforts ?? []).map((r) => r.effort);
check('ultracode: opus + fable expose ultracode as the LAST effort (after max); sonnet/haiku do NOT', opusEfforts[opusEfforts.length - 1] === 'ultracode' && fableEfforts.includes('ultracode') && !(models.find((m) => m.modelID === 'sonnet')?.reasoningEfforts ?? []).some((r) => r.effort === 'ultracode'), JSON.stringify({ opus: opusEfforts }));
// Drive: ultracode is enabled via --settings (the launch flag), NOT --effort ultracode (which would be ignored).
const argsUltra = resumeArgs(U_PLAIN, { model: 'opus', effort: 'ultracode', isDefault: true });
check('ultracode(drive): opus → --settings {ultracode:true} + --effort xhigh, never "--effort ultracode"', argsUltra.includes('--settings') && argsUltra.some((a) => a.includes('"ultracode":true')) && argsUltra[argsUltra.indexOf('--effort') + 1] === 'xhigh' && !argsUltra.some((a) => a === 'ultracode'), argsUltra.join(' '));
check('ultracode(drive): sonnet rejects ultracode → NEITHER --settings NOR --effort (clamped)', !resumeArgs(U_PLAIN, { model: 'sonnet', effort: 'ultracode', isDefault: true }).includes('--settings') && !resumeArgs(U_PLAIN, { model: 'sonnet', effort: 'ultracode', isDefault: true }).includes('--effort'));
check('ultracode: modelSupportsEffort proxy via resumeArgs — opus yes, sonnet/haiku no', resumeArgs(U_PLAIN, { model: 'fable', effort: 'ultracode', isDefault: true }).includes('--settings') && !resumeArgs(U_PLAIN, { model: 'haiku', effort: 'ultracode', isDefault: true }).includes('--settings'));

// ── third-party wrapper multi-model auto-discovery (claude-mi: pro + non-pro) ──
const CLAUDE_MI = [
  'export CLAUDE_CONFIG_DIR="${HOME}/.claude-mi"',
  'export ANTHROPIC_BASE_URL="https://example/anthropic"',
  'DEFAULT_MODEL="${CLAUDE_LOCAL_MODEL:-mimo-v2.5[1m]}"',
  'OPUS_MODEL="${CLAUDE_LOCAL_OPUS_MODEL:-mimo-v2.5-pro[1m]}"',
  'export ANTHROPIC_DEFAULT_HAIKU_MODEL="$DEFAULT_MODEL"',
  'export ANTHROPIC_DEFAULT_SONNET_MODEL="$OPUS_MODEL"',
  'export ANTHROPIC_DEFAULT_OPUS_MODEL="$OPUS_MODEL"',
  'export ANTHROPIC_MODEL="$OPUS_MODEL"',
  'exec claude "$@"',
].join('\n');
const miModels = resolveWrapperModels(CLAUDE_MI);
check('wrapper(claude-mi): discovers BOTH backend models (pro + non-pro), deduped, primary first', JSON.stringify(miModels) === JSON.stringify(['mimo-v2.5-pro[1m]', 'mimo-v2.5[1m]']), JSON.stringify(miModels));
const miStore: ClaudeStore = { configDir: join(ROOT, 'mi'), projectsRoot: join(ROOT, 'mi', 'projects'), bin: 'claude-mi', model: 'mimo-v2.5-pro[1m]', models: ['mimo-v2.5-pro[1m]', 'mimo-v2.5[1m]'], baseUrl: 'x', isDefault: false };
const miOpts = claudeModelOptions(miStore);
check('wrapper(claude-mi): picker offers both models WITH effort+ultracode (switchable pro↔non-pro)', miOpts.length === 2 && miOpts.every((m) => m.providerID === 'wrapper' && (m.reasoningEfforts ?? []).some((r) => r.effort === 'ultracode')) && miOpts.map((m) => m.modelID).join() === 'mimo-v2.5-pro[1m],mimo-v2.5[1m]');
const boundedWrapperStore: ClaudeStore = {
  ...miStore,
  models: Array.from(
    { length: CLAUDE_MAX_MODEL_OPTIONS + 20 },
    (_value, index) => `wrapper-${index}`,
  ),
};
check(
  'models: wrapper catalog is explicitly bounded',
  claudeModelOptions(boundedWrapperStore).length === CLAUDE_MAX_MODEL_OPTIONS,
  String(claudeModelOptions(boundedWrapperStore).length),
);

// A brand-new (broker-created) session has no transcript yet → START via --session-id, no fork.
const argsFresh = resumeArgs(U_PLAIN, { model: 'opus', mode: 'plan', isDefault: true, fresh: true });
check('args(fresh): brand-new session STARTS via --session-id, not --resume', argsFresh.includes('--session-id') && argsFresh.includes(U_PLAIN) && !argsFresh.includes('--resume'));
check('args(fresh): NO --fork-session (nothing to fork on a new session)', !argsFresh.includes('--fork-session'));
check('args(fresh): still streams + carries model/mode', argsFresh.includes('--input-format') && argsFresh.includes('--model') && argsFresh.includes('--permission-mode'));

// ── readLatestModel: the CURRENT model = latest assistant turn, not the birth model ──────────────
// Regression for the "outdated model" bug: a session started on opus-4-6 and continued on opus-4-8 must
// report opus-4-8 (the model it runs NOW), so the model is read from the TAIL, not the head.
{
  const modelDir = join(ROOT, 'modeltest');
  mkdirSync(modelDir, { recursive: true });
  const asst = (m: string, text: string) =>
    JSON.stringify({ type: 'assistant', message: { model: m, content: [{ type: 'text', text }] } });

  // Continued session: born on opus-4-6, later turns on opus-4-8.
  const continued = join(modelDir, 'continued.jsonl');
  writeFileSync(
    continued,
    [
      JSON.stringify({ type: 'user', cwd: existingCwd, message: { content: 'start' } }),
      asst('claude-opus-4-6', 'first answer'),
      JSON.stringify({ type: 'user', message: { content: 'continue later' } }),
      asst('claude-opus-4-8', 'newer answer'),
    ].join('\n') + '\n',
  );
  check('readLatestModel: continued session reports the LATEST model (tail), not the birth model', readLatestModel(continued) === 'claude-opus-4-8', String(readLatestModel(continued)));

  // A trailing <synthetic> line (injected API-error/compaction) must NOT mask the real latest model.
  const synthTail = join(modelDir, 'synth.jsonl');
  writeFileSync(
    synthTail,
    [asst('claude-opus-4-6', 'a'), asst('claude-opus-4-8', 'b'), asst('<synthetic>', 'api error')].join('\n') + '\n',
  );
  check('readLatestModel: trailing <synthetic> is skipped → real latest model', readLatestModel(synthTail) === 'claude-opus-4-8');

  // No assistant turns yet (fresh/observe-only) → undefined so the caller falls back to the head model.
  const noAsst = join(modelDir, 'no-assistant.jsonl');
  writeFileSync(noAsst, JSON.stringify({ type: 'user', cwd: existingCwd, message: { content: 'hi' } }) + '\n');
  check('readLatestModel: no assistant turn → undefined (head-model fallback)', readLatestModel(noAsst) === undefined);

  // Window escalation: a huge final assistant line (> the 256 KB first window) is still found via the
  // larger second window — otherwise the latest model would be silently missed and the row stale.
  const bigTail = join(modelDir, 'big-tail.jsonl');
  writeFileSync(
    bigTail,
    [asst('claude-opus-4-6', 'small early turn'), asst('claude-opus-4-8', 'X'.repeat(400 * 1024))].join('\n') + '\n',
  );
  check('readLatestModel: multi-hundred-KB final turn still resolved (window escalation)', readLatestModel(bigTail) === 'claude-opus-4-8');

  // Missing file → undefined, no throw.
  check('readLatestModel: missing file → undefined (no throw)', readLatestModel(join(modelDir, 'nope.jsonl')) === undefined);
}

// ── createSession: no-prompt, zero-cost (deferred materialization) ───────────────
const adapter = new ClaudeAdapter();
check('canCreateSession: returns a boolean', typeof adapter.canCreateSession() === 'boolean');
if (adapter.canCreateSession()) {
  const created = await adapter.createSession({
    directory: existingCwd,
    title: 'Fresh',
    model: {
      providerID: 'anthropic',
      modelID: 'opus',
      reasoningEffort: 'high',
    },
  });
  check('createSession: tool=claude, idle, observe row, title kept', created.tool === 'claude' && created.status === 'idle' && created.attachMode === 'observe' && created.title === 'Fresh');
  check(
    'createSession: exact selected alias and effort are retained without resolving or spending a turn',
    created.currentModel?.providerID === 'anthropic' &&
      created.currentModel?.modelID === 'opus' &&
      created.currentModel?.reasoningEffort === 'high',
    JSON.stringify(created.currentModel),
  );
  check('createSession: drivable now (drive observing+supported)', created.control?.drive.state === 'observing' && created.control?.drive.supported === true);
  const createdPath = Buffer.from(created.id, 'base64url').toString('utf8');
  check('createSession: id encodes a <uuid>.jsonl path under a projects root', /\/projects\/[^/]+\/[0-9a-f-]{36}\.jsonl$/.test(createdPath), createdPath);
  check('createSession: NO transcript written (zero-cost; materializes on the first Drive turn)', !existsSync(createdPath));
  let threw = false;
  try { await adapter.createSession({ directory: join(ROOT, 'no-such-dir') }); } catch { threw = true; }
  check('createSession: rejects a non-existent directory', threw);

  // PERMANENT regression (issues-part2 re-flag): the deferred row has no transcript head to read cwd
  // from, and a cwd-less resume spawned `claude` in the BROKER's working directory — materializing the
  // session under the broker-cwd project instead of the requested one. attach() must recover the
  // create-time cwd so the first drive turn launches in the right workspace.
  const conn = await adapter.attach(created.id, 'resume');
  check('create→attach(resume): create-time cwd carried onto the un-materialized session (never the broker cwd)',
    conn.info.cwd === existingCwd, `cwd=${conn.info.cwd}`);
  check(
    'create→attach(resume): deferred exact alias and effort survive until the first paid turn',
    conn.info.currentModel?.providerID === 'anthropic' &&
      conn.info.currentModel?.modelID === 'opus' &&
      conn.info.currentModel?.reasoningEffort === 'high',
    JSON.stringify(conn.info.currentModel),
  );
  await conn.close();
  // Same protection when the app defaulted to home (empty directory field): a FRESH adapter (broker
  // restarted between create and attach loses the in-memory map) still recovers `~` by slug round-trip.
  const homeCreated = await new ClaudeAdapter().createSession({});
  const homeConn = await new ClaudeAdapter().attach(homeCreated.id, 'resume');
  check('create→attach(resume): home-default create recovers ~ even across an adapter restart (slug round-trip)',
    homeConn.info.cwd === (process.env.HOME ?? homeConn.info.cwd), `cwd=${homeConn.info.cwd}`);
  await homeConn.close();
} else {
  check('createSession: gated off when claude bin is unavailable (no crash)', true);
}

// ── resumeEnv: default-store billing scrub ───────────────────────────────────────
const fakeEnv = { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_AUTH_TOKEN: 'tok-test', PATH: '/usr/bin' } as NodeJS.ProcessEnv;
const envDef = resumeEnv(defaultStore, fakeEnv);
check('env: default store scrubs ANTHROPIC_API_KEY', envDef.ANTHROPIC_API_KEY === undefined);
check('env: default store scrubs ANTHROPIC_AUTH_TOKEN', envDef.ANTHROPIC_AUTH_TOKEN === undefined);
check('env: default store sets CLAUDE_CONFIG_DIR', envDef.CLAUDE_CONFIG_DIR === defaultDir);
const envWrap = resumeEnv(wrapperStore, fakeEnv);
check('env: wrapper KEEPS ANTHROPIC_API_KEY (own endpoint auth)', envWrap.ANTHROPIC_API_KEY === 'sk-test');
check('env: wrapper KEEPS ANTHROPIC_AUTH_TOKEN', envWrap.ANTHROPIC_AUTH_TOKEN === 'tok-test');
check('env: wrapper sets its own CLAUDE_CONFIG_DIR', envWrap.CLAUDE_CONFIG_DIR === wrapperDir);

rmSync(ROOT, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
